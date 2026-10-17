/**
 * fetch_url hardening.
 *
 * The URL this tool receives comes from a MODEL, which makes it attacker-
 * controlled input. The transport it reuses is already proven by the AI
 * transport suite; these tests assert the properties that are specific to
 * fetching a page, and that the reuse actually holds:
 *
 *  - a private, loopback, or metadata address is refused before any socket
 *  - the local-target exception is NOT available to the model
 *  - a redirect to an internal address is refused, not followed
 *  - non-readable content types are refused rather than guessed at
 *
 * The tool module is read as source for the structural assertions, matching how
 * the rest of the suite pins its transport guarantees.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fetchUrlTool, FETCH_URL_PERMISSION } from "../src/tools/fetch_url";
import { ToolService } from "../src/tools/service";
import { classifyAddress } from "../src/ai/dns_guard";

const FULL_ACTOR = {
  userId: "u1",
  permissions: [FETCH_URL_PERMISSION],
};

/**
 * Run the tool through the Executor, which is the only path that exists in
 * production. Calling the body directly would skip the shared input validation
 * and prove nothing about what a model can actually reach.
 */
function run(input: unknown, actor = FULL_ACTOR) {
  const svc = new ToolService({ timeoutMs: 4_000 });
  return svc.runTool({ tool: "fetch_url", input, actor });
}

describe("fetch_url registration", () => {
  test("the tool ships enabled and declares its permission", () => {
    expect(fetchUrlTool.name).toBe("fetch_url");
    expect(fetchUrlTool.enabled).toBe(true);
    expect(fetchUrlTool.permission.requires).toEqual([FETCH_URL_PERMISSION]);
  });

  test("it is registered by the default service", () => {
    const svc = new ToolService();
    expect(svc.listActiveNames()).toContain("fetch_url");
  });

  test("the url field is required and length-bounded", () => {
    const url = fetchUrlTool.input.fields["url"]!;
    expect(url.required).toBe(true);
    expect(url.maxLength).toBeGreaterThan(0);
  });

  test("maxChars is bounded, so a caller cannot ask for an enormous extraction", () => {
    const field = fetchUrlTool.input.fields["maxChars"]!;
    expect(field.minimum).toBeGreaterThan(0);
    expect(field.maximum).toBeLessThanOrEqual(20_000);
  });
});

describe("fetch_url refuses internal targets", () => {
  test("loopback is refused", async () => {
    expect((await run({ url: "http://127.0.0.1/" })).status).toBe("invalid_input");
    expect((await run({ url: "http://localhost/admin" })).status).toBe("invalid_input");
  });

  test("the cloud metadata address is refused", async () => {
    // The single most valuable target in an SSRF attempt.
    expect((await run({ url: "http://169.254.169.254/latest/meta-data/" })).status).toBe("invalid_input");
  });

  test("private ranges are refused", async () => {
    for (const url of [
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
    ]) {
      expect((await run({ url })).status).toBe("invalid_input");
    }
  });

  test("a non-http scheme is refused before anything else", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://x"]) {
      expect((await run({ url })).status).toBe("invalid_input");
    }
  });

  test("a url with credentials is refused", async () => {
    // Credentials in a URL end up in logs and error paths.
    expect((await run({ url: "https://user:pass@example.com/" })).status).toBe("invalid_input");
  });

  test("an empty url is refused", async () => {
    // The validator rejects the empty string on minLength before any network
    // work; a whitespace-only one gets past it and is refused by the body.
    expect((await run({ url: "" })).status).toBe("invalid_input");
    expect((await run({ url: "   " })).status).toBe("invalid_input");
  });

  test("an over-long url is refused", async () => {
    expect((await run({ url: `https://e.com/${"a".repeat(3_000)}` })).status).toBe("invalid_input");
  });
});

describe("fetch_url never opts into local targets", () => {
  test("the local-target exception is hardcoded off, never derived from input", () => {
    // A model must not be able to reach a loopback/LAN service. The resolver
    // must return a literal `false` rather than something a caller could
    // influence — so the assertion is on the value, not on a variable name.
    //
    // Comments are stripped first: the module's own doc block discusses this
    // flag, and matching against prose would test the comment, not the code.
    const code = readFileSync("src/tools/fetch_url.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/allowLocalTargets\s*:\s*true/);
    // The resolver's own return value is the literal false.
    expect(code).toMatch(/allowLocal:\s*false/);
    // The tool never has an input field that could turn it on.
    expect(code).not.toMatch(/allowLocal\s*\?\s*true/);
  });

  test("the tool reuses the guarded transport rather than a plain fetch", () => {
    const src = readFileSync("src/tools/fetch_url.ts", "utf8");
    expect(src).toContain('from "../ai/dns_guard"');
    expect(src).toContain('from "../ai/pinned_transport"');
    // A plain fetch would bypass DNS pinning entirely.
    expect(src).not.toMatch(/\bawait fetch\(/);
  });
});

describe("fetch_url redirect policy", () => {
  test("redirects are followed manually and bounded", () => {
    const src = readFileSync("src/tools/fetch_url.ts", "utf8");
    // Each hop must be re-validated: a public URL that redirects to an internal
    // address is otherwise a complete SSRF bypass.
    expect(src).toContain("MAX_REDIRECTS");
    expect(src).toContain("resolveAndAllow");
  });

  test("the transport itself never follows a redirect", () => {
    const src = readFileSync("src/ai/pinned_transport.ts", "utf8");
    expect(src).not.toContain("redirect: \"follow\"");
  });
});

describe("fetch_url content policy", () => {
  test("the readable types are a small explicit allow-list", () => {
    const src = readFileSync("src/tools/fetch_url.ts", "utf8");
    expect(src).toContain("READABLE_TYPES");
    // Binary types must not be on the list.
    for (const bad of ["image/png", "application/pdf", "video/mp4"]) {
      expect(src).not.toContain(`"${bad}"`);
    }
  });

  test("the body ceiling is below the transport's", () => {
    // A page destined for a model's context does not need 8 MB, and an
    // over-large body is refused rather than silently truncated.
    const src = readFileSync("src/tools/fetch_url.ts", "utf8");
    const match = /MAX_BODY_BYTES\s*=\s*([0-9_]+)\s*\*\s*([0-9_]+)\s*\*\s*([0-9_]+)/.exec(src);
    expect(match).not.toBeNull();
    const num = (s: string) => Number(s.replace(/_/g, ""));
    const bytes = num(match![1]!) * num(match![2]!) * num(match![3]!);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("the guard the tool relies on", () => {
  test("classifyAddress refuses metadata even under the local exception", () => {
    // This is the property that makes reusing the guard worthwhile: the local
    // opt-in covers loopback and RFC1918 only, never the metadata endpoint.
    expect(classifyAddress("169.254.169.254", false).allowed).toBe(false);
    expect(classifyAddress("169.254.169.254", true).allowed).toBe(false);
    expect(classifyAddress("127.0.0.1", false).allowed).toBe(false);
    expect(classifyAddress("127.0.0.1", true).allowed).toBe(true);
    // A public address is fine either way.
    expect(classifyAddress("93.184.216.34", false).allowed).toBe(true);
  });

  test("an IPv4-mapped metadata address is still refused", () => {
    expect(classifyAddress("::ffff:169.254.169.254", true).allowed).toBe(false);
  });
});

describe("fetch_url argument validation", () => {
  test("unknown fields are rejected by the shared validator", async () => {
    // The Executor validates before the body runs, so an injected field never
    // reaches the tool at all.
    expect((await run({ url: "https://example.com/", nonsense: 1 })).status).toBe("invalid_input");
  });

  test("a non-string url is rejected", async () => {
    expect((await run({ url: 42 })).status).toBe("invalid_input");
  });

  test("an out-of-range maxChars is rejected", async () => {
    expect((await run({ url: "https://example.com/", maxChars: 999_999 })).status).toBe(
      "invalid_input",
    );
  });

  test("an actor without the permission is refused before validation", async () => {
    const r = await run({ url: "https://example.com/" }, { userId: "u2", permissions: [] });
    expect(r.status).toBe("not_allowed");
  });
});
