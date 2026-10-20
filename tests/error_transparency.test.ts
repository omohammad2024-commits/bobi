/**
 * Provider error transparency + latency work.
 *
 * Part 1 — errors: every HTTP status must map onto an AiError whose KIND,
 * message, and numeric STATUS name the real cause instead of collapsing
 * into "Unknown service error."; the probe and the gateway diagnostics must
 * surface that cause to the owner.
 *
 * Part 2 — latency: the DNS guard caches validated resolutions for a short
 * TTL, the pinned transport pools keep-alive sockets, and the health probe
 * caps its generation so it gets ANY answer fast.
 *
 * Everything here runs offline: loopback servers and injected resolvers.
 */
import { describe, expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { statusToAiError } from "../src/ai/http_status";
import { AiError } from "../src/ai/provider";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import {
  resolveTarget,
  clearDnsCache,
  __injectDnsCacheEntry,
  dnsCacheTtlMs,
  type DnsResolver,
} from "../src/ai/dns_guard";
import {
  pinnedFetch,
  resetKeepAliveAgents,
  keepAliveAgentCount,
} from "../src/ai/pinned_transport";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiGateway } from "../src/ai/gateway";

// ---------------------------------------------------------------------------
// Shared status mapper (unit)
// ---------------------------------------------------------------------------

describe("statusToAiError", () => {
  test("402 maps to quota and names the balance exhaustion", () => {
    const err = statusToAiError(402);
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe("quota");
    expect(err.status).toBe(402);
    expect(err.message).toBe("Provider balance or quota is exhausted (HTTP 402).");
  });

  test("other 4xx map to invalid_response and name the status", () => {
    for (const status of [405, 409, 418, 451]) {
      const err = statusToAiError(status);
      expect(err.kind).toBe("invalid_response");
      expect(err.status).toBe(status);
      expect(err.message).toContain(`HTTP ${status}`);
    }
  });

  test("5xx maps to network and names the status", () => {
    const err = statusToAiError(503);
    expect(err.kind).toBe("network");
    expect(err.status).toBe(503);
    expect(err.message).toContain("HTTP 503");
  });

  test("unmapped statuses stay unknown but name the status", () => {
    const err = statusToAiError(302);
    expect(err.kind).toBe("unknown");
    expect(err.status).toBe(302);
    expect(err.message).toContain("HTTP 302");
  });

  test("established mappings are unchanged", () => {
    expect(statusToAiError(401).kind).toBe("auth");
    expect(statusToAiError(403).kind).toBe("auth");
    expect(statusToAiError(408).kind).toBe("timeout");
    expect(statusToAiError(429).kind).toBe("quota");
    expect(statusToAiError(400).kind).toBe("invalid_response");
    expect(statusToAiError(404).kind).toBe("invalid_response");
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter path over a loopback double
// ---------------------------------------------------------------------------

async function loopback(
  handler: (body: string, res: ServerResponse) => void,
) {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => handler(body, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

function adapterFor(port: number) {
  return new OpenAICompatibleAdapter({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "probe-key",
    allowLocalTargets: true,
  });
}

const COMPLETE_REQ = {
  messages: [{ role: "user" as const, content: "ping" }],
  model: "probe-model",
  timeoutMs: 5000,
  signal: new AbortController().signal,
};

describe("openai adapter status path", () => {
  test("a 402 becomes quota with the status attached", async () => {
    const d = await loopback((_body, res) => res.writeHead(402).end());
    try {
      const err = await adapterFor(d.port).complete(COMPLETE_REQ).catch((e) => e);
      expect(err).toBeInstanceOf(AiError);
      expect(err.kind).toBe("quota");
      expect(err.status).toBe(402);
      expect(err.message).toBe("Provider balance or quota is exhausted (HTTP 402).");
    } finally {
      d.server.close();
    }
  });

  test("an unmapped 4xx (405) becomes invalid_response WITH its status named", async () => {
    const d = await loopback((_body, res) => res.writeHead(405).end());
    try {
      const err = await adapterFor(d.port).complete(COMPLETE_REQ).catch((e) => e);
      expect(err).toBeInstanceOf(AiError);
      expect(err.kind).toBe("invalid_response");
      expect(err.status).toBe(405);
      expect(err.message).toBe("Provider rejected the request (HTTP 405).");
    } finally {
      d.server.close();
    }
  });

  test("probe completions ask for max_tokens 16 through the wire", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const d = await loopback((body, res) => {
      const parsed = body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {};
      seenBodies.push(parsed);
      if (parsed["stream"] === true) {
        // H1: the provider probe is two-stage — after the ping, the
        // realistic stage streams. Answer in SSE so the stage can pass.
        res.writeHead(200, { "content-type": "text/event-stream" }).end(
          'data: {"choices":[{"delta":{"content":"pong"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
        );
        return;
      }
      res.writeHead(200).end(
        JSON.stringify({ choices: [{ message: { content: "pong" } }], model: "probe-model" }),
      );
    });
    try {
      const storage = Storage.open(":memory:");
      const secrets = new ProviderSecretStore("probe-maxtokens-key");
      const adapters = new AdapterRegistry();
      const providers = new ProviderService(storage, secrets, adapters);
      const models = new ModelService(storage);
      const created = providers.create({
        label: "maxtokens",
        adapter: "openai_compatible",
        baseUrl: `http://127.0.0.1:${d.port}/v1`,
        apiKey: "<redacted>",
        allowLocal: true,
      });
      if (!created.ok) throw new Error("provider create failed");
      const added = models.add({ providerId: created.data, modelId: "probe-model", label: "p" });
      if (!added.ok) throw new Error("model add failed");
      const health = new ProviderHealthService(storage, providers, secrets, adapters, 5000);

      const result = await health.probe(created.data);
      expect(result.ok).toBe(true);
      // Stage (a), the ping, is the request this test exists to pin: a
      // 16-token cap, so the probe gets ANY answer fast (H2 made the cap
      // real on every wire). Stage (b) then streams with its own 300 cap.
      expect(seenBodies[0]?.["max_tokens"]).toBe(16);
      const streamBody = seenBodies.find((b) => b["stream"] === true);
      expect(streamBody?.["max_tokens"]).toBe(300);
      storage.close();
    } finally {
      d.server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// probeMessage: unknown/quota surfaces the real message
// ---------------------------------------------------------------------------

describe("probe surfaces the real cause", () => {
  /** A health service whose adapter always throws the given error. */
  function failingHealth(failWith: unknown) {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore("probe-cause-key");
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const created = providers.create({
      label: "cause",
      adapter: "openai_compatible",
      baseUrl: "https://api.invalid.example/v1",
      apiKey: "<redacted>",
    });
    if (!created.ok) throw new Error("provider create failed");
    const added = models.add({ providerId: created.data, modelId: "m1", label: "m1" });
    if (!added.ok) throw new Error("model add failed");
    const failing = {
      create: () =>
        ({
          name: "failing",
          type: "openai_compatible",
          label: "failing",
          capabilities: {},
          complete: async () => {
            throw failWith;
          },
        }) as never,
    } as unknown as AdapterRegistry;
    const health = new ProviderHealthService(storage, providers, secrets, failing, 5000);
    return { health, providerId: created.data, storage };
  }

  test("an unknown AiError reaches the panel with its status-bearing message", async () => {
    const { health, providerId, storage } = failingHealth(
      new AiError("unknown", "Unexpected provider response (HTTP 418).", 418),
    );
    const result = await health.probe(providerId);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Unexpected provider response (HTTP 418).");
    storage.close();
  });

  test("a 402 surfaces as balance exhaustion, never as bare Probe failed", async () => {
    const { health, providerId, storage } = failingHealth(
      statusToAiError(402),
    );
    const result = await health.probe(providerId);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Provider balance or quota is exhausted (HTTP 402).");
    storage.close();
  });
});

// ---------------------------------------------------------------------------
// Gateway diagnostics: unknown AiErrors are reported exactly once
// ---------------------------------------------------------------------------

function failingGateway(failWith: unknown) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("gateway-unknown-key");
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const reported: unknown[] = [];
  const fakeAdapters = {
    create: () =>
      ({
        name: "failing",
        type: "openai_compatible",
        label: "failing",
        capabilities: {},
        complete: async () => {
          throw failWith;
        },
      }) as never,
  } as unknown as AdapterRegistry;
  const gateway = new AiGateway({
    storage,
    adapters: fakeAdapters,
    secrets,
    onUnknownError: (err, where) => {
      reported.push({ err, where });
    },
  });
  const p = providers.create({
    label: "gw",
    adapter: "openai_compatible",
    baseUrl: "https://gw.invalid/v1",
    apiKey: "<redacted>",
  });
  if (!p.ok) throw new Error("provider create failed");
  const m = models.add({ providerId: p.data, modelId: "gw-model", label: "gw" });
  if (!m.ok) throw new Error("model add failed");
  storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });
  return { gateway, reported, storage };
}

const GATEWAY_REQ = {
  messages: [{ role: "user" as const, content: "hi" }],
  model: "gw-model",
  timeoutMs: 5000,
  signal: new AbortController().signal,
};

describe("gateway unknown-error diagnostics", () => {
  test("an adapter-thrown AiError unknown is reported exactly once", async () => {
    const { gateway, reported, storage } = failingGateway(
      new AiError("unknown", "Unexpected provider response (HTTP 418).", 418),
    );
    const err = await gateway.complete(GATEWAY_REQ).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe("unknown");
    expect(err.status).toBe(418);
    // Exactly one report — the catch site must not double-report, and the
    // final `lastError ??` throw must not report again.
    expect(reported.length).toBe(1);
    const entry = reported[0] as { err: AiError; where: string };
    expect(entry.err.status).toBe(418);
    storage.close();
  });

  test("a non-AiError is still reported exactly once", async () => {
    const { gateway, reported, storage } = failingGateway(new TypeError("boom"));
    await expect(gateway.complete(GATEWAY_REQ)).rejects.toThrow(AiError);
    expect(reported.length).toBe(1);
    storage.close();
  });
});

// ---------------------------------------------------------------------------
// DNS cache
// ---------------------------------------------------------------------------

function fakeResolver(answers: readonly string[]): DnsResolver & { calls: number } {
  const fn = ((_hostname: string): Promise<readonly string[]> => {
    fn.calls++;
    return Promise.resolve(answers);
  }) as DnsResolver & { calls: number };
  fn.calls = 0;
  return fn;
}

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe("dns cache", () => {
  test("dnsCacheTtlMs honors the env, defaulting to 60s", () => {
    withEnv("BOBI_DNS_CACHE_MS", undefined, () => expect(dnsCacheTtlMs()).toBe(60_000));
    withEnv("BOBI_DNS_CACHE_MS", "5000", () => expect(dnsCacheTtlMs()).toBe(5000));
    withEnv("BOBI_DNS_CACHE_MS", "0", () => expect(dnsCacheTtlMs()).toBe(0));
    withEnv("BOBI_DNS_CACHE_MS", "bogus", () => expect(dnsCacheTtlMs()).toBe(0));
  });

  test("a second lookup inside the TTL does not call the resolver", async () => {
    clearDnsCache();
    const prev = process.env.BOBI_DNS_CACHE_MS;
    process.env.BOBI_DNS_CACHE_MS = "60000";
    try {
      const resolver = fakeResolver(["8.8.8.8"]);
      const target = { baseUrl: "https://cache.test/v1", apiKey: "k" };
      const first = await resolveTarget(target, { resolver });
      const second = await resolveTarget(target, { resolver });
      expect(resolver.calls).toBe(1);
      expect(second.addresses).toEqual(first.addresses);
      expect(second.addresses).not.toBe(first.addresses); // copies, not aliases
    } finally {
      if (prev === undefined) delete process.env.BOBI_DNS_CACHE_MS;
      else process.env.BOBI_DNS_CACHE_MS = prev;
      clearDnsCache();
    }
  });

  test("BOBI_DNS_CACHE_MS=0 disables the cache", async () => {
    clearDnsCache();
    const prev = process.env.BOBI_DNS_CACHE_MS;
    process.env.BOBI_DNS_CACHE_MS = "0";
    try {
      const resolver = fakeResolver(["1.1.1.1"]);
      const target = { baseUrl: "https://nocache.test/v1", apiKey: "k" };
      await resolveTarget(target, { resolver });
      await resolveTarget(target, { resolver });
      expect(resolver.calls).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.BOBI_DNS_CACHE_MS;
      else process.env.BOBI_DNS_CACHE_MS = prev;
      clearDnsCache();
    }
  });

  test("a poisoned cached set is still rejected on hit", async () => {
    clearDnsCache();
    const prev = process.env.BOBI_DNS_CACHE_MS;
    process.env.BOBI_DNS_CACHE_MS = "60000";
    try {
      // Simulate a set that was valid when cached but is hostile now: the
      // guard must re-classify on every hit and refuse it.
      __injectDnsCacheEntry("poison.test", false, "https://poison.test/v1", ["10.9.8.7"]);
      await expect(
        resolveTarget({ baseUrl: "https://poison.test/v1", apiKey: "k" }),
      ).rejects.toThrow(AiError);
    } finally {
      if (prev === undefined) delete process.env.BOBI_DNS_CACHE_MS;
      else process.env.BOBI_DNS_CACHE_MS = prev;
      clearDnsCache();
    }
  });

  test("failed lookups are never cached", async () => {
    clearDnsCache();
    const prev = process.env.BOBI_DNS_CACHE_MS;
    process.env.BOBI_DNS_CACHE_MS = "60000";
    try {
      const failing: DnsResolver & { calls: number } = Object.assign(
        async (): Promise<readonly string[]> => {
          failing.calls++;
          throw new Error("dns down");
        },
        { calls: 0 },
      );
      const target = { baseUrl: "https://down.test/v1", apiKey: "k" };
      await expect(resolveTarget(target, { resolver: failing })).rejects.toThrow(AiError);
      await expect(resolveTarget(target, { resolver: failing })).rejects.toThrow(AiError);
      expect(failing.calls).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.BOBI_DNS_CACHE_MS;
      else process.env.BOBI_DNS_CACHE_MS = prev;
      clearDnsCache();
    }
  });
});

// ---------------------------------------------------------------------------
// Keep-alive pooling
// ---------------------------------------------------------------------------

describe("keep-alive pooling", () => {
  test("two requests to one host share a single connection", async () => {
    let connections = 0;
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    server.on("connection", () => connections++);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      resetKeepAliveAgents();
      const prev = process.env.BOBI_KEEPALIVE;
      delete process.env.BOBI_KEEPALIVE;
      try {
        const base = {
          method: "GET",
          headers: {},
          timeoutMs: 5000,
          signal: new AbortController().signal,
          addresses: ["127.0.0.1"] as const,
          allowLocalTargets: true,
        };
        await pinnedFetch({ ...base, url: `http://127.0.0.1:${port}/a` });
        await pinnedFetch({ ...base, url: `http://127.0.0.1:${port}/b` });
        expect(connections).toBe(1);
        expect(keepAliveAgentCount()).toBe(1);
      } finally {
        if (prev === undefined) delete process.env.BOBI_KEEPALIVE;
        else process.env.BOBI_KEEPALIVE = prev;
      }
      resetKeepAliveAgents();
    } finally {
      server.close();
    }
  });

  test("BOBI_KEEPALIVE=0 restores one connection per request", async () => {
    let connections = 0;
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    server.on("connection", () => connections++);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      resetKeepAliveAgents();
      const prev = process.env.BOBI_KEEPALIVE;
      process.env.BOBI_KEEPALIVE = "0";
      try {
        const base = {
          method: "GET",
          headers: {},
          timeoutMs: 5000,
          signal: new AbortController().signal,
          addresses: ["127.0.0.1"] as const,
          allowLocalTargets: true,
        };
        await pinnedFetch({ ...base, url: `http://127.0.0.1:${port}/a` });
        await pinnedFetch({ ...base, url: `http://127.0.0.1:${port}/b` });
        expect(connections).toBe(2);
        expect(keepAliveAgentCount()).toBe(0);
      } finally {
        if (prev === undefined) delete process.env.BOBI_KEEPALIVE;
        else process.env.BOBI_KEEPALIVE = prev;
      }
      resetKeepAliveAgents();
    } finally {
      server.close();
    }
  });
});
