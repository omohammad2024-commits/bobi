import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import {
  classifyAddress,
  resolveTarget,
  defaultResolver,
  type DnsResolver,
} from "../src/ai/dns_guard";
import { pinnedFetch, pinnedLookup, MAX_RESPONSE_BYTES } from "../src/ai/pinned_transport";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import { GeminiAdapter } from "../src/ai/gemini";
import { AnthropicAdapter } from "../src/ai/anthropic";
import { ProviderProbeService } from "../src/ai/provider_probe";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import { Storage } from "../src/storage/storage";
import { AiError } from "../src/ai/provider";

/** A resolver that answers from a table and records how often it was used. */
function fakeResolver(answers: readonly string[] | Error): DnsResolver & {
  calls: string[];
} {
  const calls: string[] = [];
  const fn = (hostname: string): Promise<readonly string[]> => {
    calls.push(hostname);
    if (answers instanceof Error) return Promise.reject(answers);
    return Promise.resolve(answers);
  };
  return Object.assign(fn, { calls });
}

const PUBLIC = { baseUrl: "https://api.provider.test/v1", apiKey: "k" };

// ---------- address classification ----------

describe("address classification", () => {
  test("public unicast is accepted", () => {
    expect(classifyAddress("8.8.8.8", false).allowed).toBe(true);
    expect(classifyAddress("1.1.1.1", false).allowed).toBe(true);
    expect(classifyAddress("2001:4860:4860::8888", false).allowed).toBe(true);
  });

  test("loopback and private ranges are refused for remote targets", () => {
    for (const addr of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.1",
      "::1",
      "fc00::1",
      "fd12:3456::1",
    ]) {
      expect(classifyAddress(addr, false).allowed).toBe(false);
    }
  });

  test("cloud metadata (link-local) is refused even for local targets", () => {
    // This is the case that turns a narrow local exception into SSRF.
    expect(classifyAddress("169.254.169.254", false).allowed).toBe(false);
    expect(classifyAddress("169.254.169.254", true).allowed).toBe(false);
    expect(classifyAddress("fe80::1", false).allowed).toBe(false);
    expect(classifyAddress("fe80::1", true).allowed).toBe(false);
  });

  test("special-purpose ranges are refused in both modes", () => {
    for (const addr of [
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "100.64.0.1",
      "203.0.113.10",
      "2001:db8::1",
      "64:ff9b::808:808",
      "::",
      "ff02::1",
    ]) {
      expect(classifyAddress(addr, false).allowed).toBe(false);
      expect(classifyAddress(addr, true).allowed).toBe(false);
    }
  });

  test("IPv4-mapped IPv6 is unwrapped and classified as IPv4", () => {
    expect(classifyAddress("::ffff:127.0.0.1", false).allowed).toBe(false);
    expect(classifyAddress("::ffff:169.254.169.254", false).allowed).toBe(false);
    // A mapped public address is still public.
    expect(classifyAddress("::ffff:8.8.8.8", false).allowed).toBe(true);
    // hex-encoded form of 127.0.0.1
    expect(classifyAddress("::ffff:7f00:1", false).allowed).toBe(false);
  });

  test("the local exception permits only loopback, LAN and ULA", () => {
    expect(classifyAddress("127.0.0.1", true).allowed).toBe(true);
    expect(classifyAddress("192.168.1.10", true).allowed).toBe(true);
    expect(classifyAddress("10.1.2.3", true).allowed).toBe(true);
    expect(classifyAddress("fc00::1", true).allowed).toBe(true);
    // Everything else stays closed, so the flag is not a general bypass.
    expect(classifyAddress("169.254.169.254", true).allowed).toBe(false);
    expect(classifyAddress("100.64.0.1", true).allowed).toBe(false);
    expect(classifyAddress("2001:db8::1", true).allowed).toBe(false);
    expect(classifyAddress("224.0.0.1", true).allowed).toBe(false);
  });

  test("an unparseable address is refused rather than passed through", () => {
    for (const bad of ["", "not-an-ip", "999.999.999.999", "::gg::1"]) {
      expect(classifyAddress(bad, true).allowed).toBe(false);
    }
  });
});

// ---------- DNS resolution policy ----------

describe("resolveTarget", () => {
  test("a hostname resolving to loopback is rejected (localtest.me case)", async () => {
    const resolver = fakeResolver(["127.0.0.1"]);
    await expect(
      resolveTarget({ baseUrl: "https://localtest.me/v1", apiKey: "k" }, { resolver }),
    ).rejects.toThrow(AiError);
    expect(resolver.calls).toEqual(["localtest.me"]);
  });

  test("a hostname resolving to loopback in the dotted form is rejected (nip.io case)", async () => {
    const resolver = fakeResolver(["127.0.0.1"]);
    await expect(
      resolveTarget({ baseUrl: "https://127-0-0-1.nip.io/v1", apiKey: "k" }, { resolver }),
    ).rejects.toThrow(AiError);
  });

  test("a mixed public/private answer set is rejected in full", async () => {
    for (const answers of [
      ["8.8.8.8", "192.168.0.1"],
      ["192.168.0.1", "8.8.8.8"],
      ["8.8.8.8", "169.254.169.254"],
      ["2001:4860:4860::8888", "fe80::1"],
      ["8.8.8.8", "::ffff:10.0.0.1"],
    ]) {
      const resolver = fakeResolver(answers);
      await expect(
        resolveTarget({ baseUrl: "https://mixed.test/v1", apiKey: "k" }, { resolver }),
      ).rejects.toThrow(AiError);
    }
  });

  test("an all-public answer set is accepted and returned intact", async () => {
    const resolver = fakeResolver(["8.8.8.8", "2001:4860:4860::8888"]);
    const r = await resolveTarget(PUBLIC, { resolver });
    expect(r.hostname).toBe("api.provider.test");
    expect(r.addresses).toEqual(["8.8.8.8", "2001:4860:4860::8888"]);
    // The base URL is kept so Host/SNI stay on the configured name.
    expect(r.baseUrl).toBe("https://api.provider.test/v1");
  });

  test("a failing resolver fails closed instead of allowing the request", async () => {
    const resolver = fakeResolver(new Error("ENOTFOUND"));
    await expect(resolveTarget(PUBLIC, { resolver })).rejects.toThrow(AiError);
  });

  test("an empty answer set is rejected", async () => {
    const resolver = fakeResolver([]);
    await expect(resolveTarget(PUBLIC, { resolver })).rejects.toThrow(AiError);
  });

  test("a literal public IP needs no DNS at all", async () => {
    const resolver = fakeResolver(["127.0.0.1"]);
    const r = await resolveTarget({ baseUrl: "https://8.8.8.8/v1", apiKey: "k" }, { resolver });
    expect(r.addresses).toEqual(["8.8.8.8"]);
    expect(resolver.calls).toEqual([]);
  });

  test("a literal loopback host is still refused for a remote target", async () => {
    await expect(
      resolveTarget({ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "k" }, {}),
    ).rejects.toThrow(AiError);
  });

  test("revalidation happens per request when the DNS cache is disabled", async () => {
    // BOBI_DNS_CACHE_MS=0 restores the resolve-on-every-request policy:
    // a validated set is never trusted beyond the request that made it.
    const prev = process.env.BOBI_DNS_CACHE_MS;
    process.env.BOBI_DNS_CACHE_MS = "0";
    try {
      // First answer is a permitted local address; a later answer is metadata.
      const answers = [["127.0.0.1"], ["169.254.169.254"]];
      let call = 0;
      const resolver: DnsResolver = async () => answers[call++] ?? [];

      const first = await resolveTarget(
        { baseUrl: "http://rebind.test/v1", apiKey: "k" },
        { resolver, allowLocalTargets: true },
      );
      expect(first.addresses).toEqual(["127.0.0.1"]);

      // The same host, resolved again, must be re-checked and refused.
      await expect(
        resolveTarget(
          { baseUrl: "http://rebind.test/v1", apiKey: "k" },
          { resolver, allowLocalTargets: true },
        ),
      ).rejects.toThrow(AiError);
      expect(call).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.BOBI_DNS_CACHE_MS;
      else process.env.BOBI_DNS_CACHE_MS = prev;
    }
  });

  test("the default resolver queries A and AAAA, not a hosts file", () => {
    // Structural: the default must come from dns/promises resolve*, so a
    // hosts-file entry cannot silently substitute for a DNS answer. Only the
    // import statement is checked, because the module's own comments mention
    // the API it deliberately avoids.
    const src = readFileSync("src/ai/dns_guard.ts", "utf8");
    expect(src).toContain('from "node:dns/promises"');
    expect(src).not.toMatch(/from "node:dns";/);
    expect(typeof defaultResolver).toBe("function");
  });
});

// ---------- pinned transport ----------

describe("pinned transport", () => {
  /** A local HTTP server that reports the request it received. */
  async function localServer(): Promise<{
    url: string;
    port: number;
    hits: string[];
    hosts: string[];
    close: () => void;
  }> {
    const hits: string[] = [];
    const hosts: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      hosts.push(req.headers.host ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      hits,
      hosts,
      close: () => server.close(),
    };
  }

  test("a hostname that does not resolve still reaches the validated address", async () => {
    const s = await localServer();
    try {
      // The name is a reserved TLD that never resolves in public DNS.
      const resolved = await resolveTarget(
        { baseUrl: `http://never-resolves.invalid:${s.port}`, apiKey: "k" },
        { resolver: fakeResolver(["127.0.0.1"]), allowLocalTargets: true },
      );
      const res = await pinnedFetch({
        url: `${resolved.baseUrl}/probe`,
        method: "GET",
        headers: { accept: "application/json" },
        timeoutMs: 3000,
        signal: new AbortController().signal,
        addresses: resolved.addresses,
        // The policy the addresses were validated under travels with them.
        allowLocalTargets: resolved.allowLocalTargets,
      });
      expect(res.status).toBe(200);
      expect(s.hits).toEqual(["/probe"]);
      // Host stays the configured hostname, not the pinned IP.
      expect(s.hosts[0]).toBe(`never-resolves.invalid:${s.port}`);
    } finally {
      s.close();
    }
  });

  test("the connection is bound to the validated address, not a fresh lookup", async () => {
    const s = await localServer();
    try {
      // Validation answers with an address that would be forbidden later; the
      // socket must use the address from THIS resolution, not re-query.
      const resolver = fakeResolver(["127.0.0.1"]);
      const resolved = await resolveTarget(
        { baseUrl: `http://pinned-only.invalid:${s.port}`, apiKey: "k" },
        { resolver, allowLocalTargets: true },
      );
      const res = await pinnedFetch({
        url: `${resolved.baseUrl}/x`,
        method: "GET",
        headers: {},
        timeoutMs: 3000,
        signal: new AbortController().signal,
        addresses: resolved.addresses,
        // The policy the addresses were validated under travels with them.
        allowLocalTargets: resolved.allowLocalTargets,
      });
      expect(res.status).toBe(200);
      expect(s.hits).toEqual(["/x"]);
      // One resolution per request: no second lookup at connect time.
      expect(resolver.calls).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  test("an empty address set is refused instead of falling back to DNS", async () => {
    await expect(
      pinnedFetch({
        url: "http://api.provider.test/x",
        method: "GET",
        headers: {},
        timeoutMs: 1000,
        signal: new AbortController().signal,
        addresses: [],
      }),
    ).rejects.toThrow(AiError);
  });

  test("a caller cancellation rejects as aborted", async () => {
    const controller = new AbortController();
    const p = pinnedFetch({
      url: "http://8.8.8.8:9/x",
      method: "GET",
      headers: {},
      timeoutMs: 5000,
      signal: controller.signal,
      addresses: ["8.8.8.8"],
    });
    controller.abort();
    await expect(p).rejects.toThrow(/cancelled/i);
  });

  test("a deadline rejects as timeout", async () => {
    await expect(
      pinnedFetch({
        url: "http://8.8.8.8:9/x",
        method: "GET",
        headers: {},
        timeoutMs: 50,
        signal: new AbortController().signal,
        addresses: ["8.8.8.8"],
      }),
    ).rejects.toThrow(AiError);
  });
});

// ---------- TLS ----------

describe("TLS policy", () => {
  test("a self-signed certificate is rejected: verification is enabled", async () => {
    // Local double only. No CA is configured, so the handshake must fail.
    const cert = readFileSync("./tests/fixtures/tls/self-signed-cert.pem");
    const key = readFileSync("./tests/fixtures/tls/self-signed-key.pem");
    const server = createTlsServer({ key, cert }, (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      await expect(
        pinnedFetch({
          url: `https://localhost:${port}/`,
          method: "GET",
          headers: {},
          timeoutMs: 3000,
          signal: new AbortController().signal,
          addresses: ["127.0.0.1"],
        }),
      ).rejects.toThrow(AiError);
    } finally {
      server.close();
    }
  });

  test("the transport never disables certificate verification", () => {
    const src = readFileSync("src/ai/pinned_transport.ts", "utf8");
    expect(src).not.toContain("rejectUnauthorized: false");
    expect(src).not.toContain("rejectUnauthorized:false");
    // SNI/identity stay on the original hostname.
    expect(src).toContain("servername: secure ? url.hostname");
  });
});

// ---------- every adapter is protected ----------

describe("adapters use the protected transport", () => {
  test("no adapter still calls plain fetch", () => {
    for (const file of ["openai_compatible", "gemini", "anthropic"]) {
      const src = readFileSync(`src/ai/${file}.ts`, "utf8");
      expect(src).toContain('from "./dns_guard"');
      expect(src).toContain('from "./pinned_transport"');
      // The exact pattern this hotfix removed.
      expect(src).not.toMatch(/\bawait fetch\(/);
      expect(src).not.toContain('redirect: "follow"');
    }
  });

  test("the OpenAI-compatible adapter applies the target policy", async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
    });
    const err = await adapter
      .complete({
        messages: [{ role: "user", content: "hi" }],
        model: "m",
        timeoutMs: 300,
        signal: new AbortController().signal,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("invalid_response");
  });

  test("the Gemini adapter applies the target policy", async () => {
    const adapter = new GeminiAdapter({
      baseUrl: "http://169.254.169.254/v1",
      apiKey: "k",
    });
    const err = await adapter
      .complete({
        messages: [{ role: "user", content: "hi" }],
        model: "m",
        timeoutMs: 300,
        signal: new AbortController().signal,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("invalid_response");
  });

  test("the Anthropic adapter applies the target policy", async () => {
    const adapter = new AnthropicAdapter({
      baseUrl: "http://10.0.0.9/v1",
      apiKey: "k",
    });
    const err = await adapter
      .complete({
        messages: [{ role: "user", content: "hi" }],
        model: "m",
        timeoutMs: 300,
        signal: new AbortController().signal,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("invalid_response");
  });

  test("the local exception lets an adapter reach a self-hosted endpoint", async () => {
    const hits: string[] = [];
    const server = createServer((_req, res) => {
      hits.push("x");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "m" }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const allowed = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const res = await allowed.complete({
        messages: [{ role: "user", content: "hi" }],
        model: "m",
        timeoutMs: 3000,
        signal: new AbortController().signal,
      });
      expect(res.text).toBe("ok");
      expect(hits).toHaveLength(1);

      // The very same endpoint without the owner flag is refused.
      const refused = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "k",
      });
      await expect(
        refused.complete({
          messages: [{ role: "user", content: "hi" }],
          model: "m",
          timeoutMs: 300,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(AiError);
      // Only the allowed request reached the server.
      expect(hits).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});

// ---------- health checks and failover ----------

describe("health checks and failover use the same policy", () => {
  function storageWithProvider(baseUrl: string): {
    storage: Storage;
    providers: ProviderService;
    providerId: number;
    modelId: number;
  } {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore("phase12-key");
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const p = providers.create({ label: "P", adapter: "openai_compatible", baseUrl, apiKey: "k" });
    if (!p.ok) throw new Error("provider");
    const m = models.add({ providerId: p.data, modelId: "m1", label: "M1" });
    if (!m.ok) throw new Error("model");
    models.setDefault(m.data);
    storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });
    return { storage, providers, providerId: p.data, modelId: m.data };
  }

  test("a health probe refuses a forbidden target before sending anything", async () => {
    const { storage, providers, providerId } = storageWithProvider(
      "http://169.254.169.254/latest",
    );
    const health = new ProviderProbeService(
      storage,
      providers,
      new ProviderSecretStore("phase12-key"),
      new AdapterRegistry(),
      500,
    );
    const probe = await health.probe(providerId);
    expect(probe.ok).toBe(false);
    // The target policy refused it before any connection was attempted, so the
    // outcome is a response/target fault, never a transport success.
    expect(probe.message).toBe("Service response was invalid.");
    // The blocked address itself is not echoed back.
    expect(probe.message).not.toContain("169.254.169.254");
    storage.close();
  });

  test("a health probe on a local endpoint without the owner flag is refused", async () => {
    const hits: string[] = [];
    const server = createServer((_req, res) => {
      hits.push("hit");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const { storage, providers, providerId } = storageWithProvider(
        `http://127.0.0.1:${port}/v1`,
      );
      const health = new ProviderProbeService(
        storage,
        providers,
        new ProviderSecretStore("phase12-key"),
        new AdapterRegistry(),
        500,
      );
      const probe = await health.probe(providerId);
      expect(probe.ok).toBe(false);
      // Nothing was sent to the local double.
      expect(hits).toHaveLength(0);
      storage.close();
    } finally {
      server.close();
    }
  });

  test("a gateway request to a forbidden target fails closed without a retry storm", async () => {
    const { storage, providers } = storageWithProvider("http://169.254.169.254/latest");
    const secrets = new ProviderSecretStore("phase12-key");
    const adapters = new AdapterRegistry();
    // Failover on, but the primary itself is forbidden: auth/validation class
    // failures must not be retried through other providers.
    storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    const models = new ModelService(storage);
    const other = providers.create({
      label: "backup",
      adapter: "openai_compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
    });
    if (!other.ok) throw new Error("backup");
    const otherModel = models.add({ providerId: other.data, modelId: "m2", label: "B" });
    if (!otherModel.ok) throw new Error("model");
    storage.setFailoverCandidates([{ providerId: other.data, modelId: otherModel.data }]);

    const gateway = new AiGateway({ storage, adapters, secrets });
    const err = await gateway
      .complete({
        messages: [{ role: "user", content: "hi" }],
        model: "ignored",
        timeoutMs: 300,
        signal: new AbortController().signal,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiError);
    // A validation failure is non-retryable by design.
    expect((err as AiError).kind).toBe("invalid_response");
    storage.close();
  });
});

// ---------- transport hardening (post-hotfix audit) ----------

describe("lookup callback semantics", () => {
  test("an all-true request is filtered by the requested family", () => {
    const lookup = pinnedLookup(["8.8.8.8", "2001:4860:4860::8888"]);
    const v4: unknown[] = [];
    const v6: unknown[] = [];
    lookup("host", { all: true, family: 4 }, (_e: unknown, list: unknown) => v4.push(list));
    lookup("host", { all: true, family: 6 }, (_e: unknown, list: unknown) => v6.push(list));
    expect(v4[0]).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(v6[0]).toEqual([{ address: "2001:4860:4860::8888", family: 6 }]);
  });

  test("the scalar form selects an address of the requested family", () => {
    const lookup = pinnedLookup(["8.8.8.8", "2001:4860:4860::8888"]);
    const got: unknown[] = [];
    lookup("host", { family: 6, hints: 0 }, (_e: unknown, address: unknown, family: unknown) =>
      got.push([address, family]),
    );
    expect(got[0]).toEqual(["2001:4860:4860::8888", 6]);
  });

  test("a family with no validated answer fails instead of switching family", () => {
    const lookup = pinnedLookup(["8.8.8.8"]);
    const errs: unknown[] = [];
    lookup("host", { family: 6, hints: 0 }, (err: unknown) => errs.push(err));
    expect(errs[0]).toBeInstanceOf(Error);
  });

  test("an unrecognised callback shape throws rather than falling back to DNS", () => {
    const lookup = pinnedLookup(["8.8.8.8"]);
    expect(() => lookup("host", { all: true })).toThrow();
  });
});

describe("transport response handling", () => {
  test("an oversized response is refused instead of buffered", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Stream past the cap without ending the response in one shot.
      let written = 0;
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const pump = (): void => {
        while (written <= MAX_RESPONSE_BYTES + chunk.length) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const err = await pinnedFetch({
        url: `http://127.0.0.1:${port}/big`,
        method: "GET",
        headers: {},
        timeoutMs: 8000,
        signal: new AbortController().signal,
        addresses: ["127.0.0.1"],
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).kind).toBe("invalid_response");
      expect((err as AiError).message).not.toContain("127.0.0.1");
    } finally {
      server.close();
    }
  });

  test("a non-http scheme is refused before any socket is opened", async () => {
    await expect(
      pinnedFetch({
        url: "ftp://api.provider.test/x",
        method: "GET",
        headers: {},
        timeoutMs: 500,
        signal: new AbortController().signal,
        addresses: ["8.8.8.8"],
      }),
    ).rejects.toThrow(AiError);
  });
});
