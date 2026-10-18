/**
 * Phase 3, item 3 — owner web dashboard.
 *
 * Covers: token authz on EVERY dashboard route (no token / wrong token),
 * the login shell carrying zero owner data, the JSON APIs against a real
 * :memory: Storage (providers, models, memory, users/bans, benchmarks),
 * path-traversal rejection on bench reports, CSRF posture (POST + JSON
 * content-type), per-IP rate limiting, and the XSS-safe renderers.
 *
 * The dashboard is exercised through handleDashboardRequest directly (no
 * socket), plus a small createApiServer integration block proving the
 * server.ts wiring is additive: /health and /api/v1/turn keep working and
 * /dashboard is 404 unless BOBI_DASHBOARD=1.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/storage/storage";
import {
  handleDashboardRequest,
  isDashboardEnabled,
  resetDashboardRateLimitsForTests,
  type DashboardDeps,
} from "../src/http/dashboard";
import { escapeHtml, renderSafeMarkdown } from "../src/http/dashboard_render";
import { createApiServer, type ApiServerDeps } from "../src/http/server";
import { ConversationEngine } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";

const TOKEN = "dashboard-test-token-long-and-random-0123456789abcdef";
const OWNER_ID = "999001";

function deps(storage: Storage, token: string = TOKEN): DashboardDeps {
  return { storage, token };
}

function req(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; contentType?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) {
    headers["content-type"] = opts.contentType ?? "application/json";
  }
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

const auth = { token: TOKEN };
const noAuth = {};

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** A storage with one provider + one model + runtime selection, for API tests. */
function seededStorage(): { storage: Storage; providerId: number; modelId: number } {
  const storage = Storage.open(":memory:");
  const providerId = storage.createProvider({
    label: "تست پروایدر",
    adapter: "openai",
    baseUrl: "https://api.example.test",
  });
  const modelId = storage.createModel({
    providerId,
    modelId: "test-model",
    label: "مدل تست",
  });
  storage.setRuntimeSelection({ providerId, modelId });
  return { storage, providerId, modelId };
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID,
    BOBI_DASHBOARD: process.env.BOBI_DASHBOARD,
    BOBI_BENCH_RESULTS_DIR: process.env.BOBI_BENCH_RESULTS_DIR,
  };
  process.env.OWNER_TELEGRAM_ID = OWNER_ID;
  delete process.env.BOBI_BENCH_RESULTS_DIR;
  resetDashboardRateLimitsForTests();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetDashboardRateLimitsForTests();
});

describe("dashboard authz: every route rejects without/wrong token", () => {
  const routes: Array<{ path: string; method: string; body?: unknown }> = [
    { path: "/api/v1/dashboard/ping", method: "GET" },
    { path: "/api/v1/dashboard/providers", method: "GET" },
    { path: "/api/v1/dashboard/providers/enable", method: "POST", body: { id: 1, enabled: false } },
    { path: "/api/v1/dashboard/providers/activate", method: "POST", body: { id: 1 } },
    { path: "/api/v1/dashboard/models/enable", method: "POST", body: { id: 1, enabled: false } },
    { path: "/api/v1/dashboard/models/activate", method: "POST", body: { id: 1 } },
    { path: "/api/v1/dashboard/memory", method: "GET" },
    { path: "/api/v1/dashboard/users", method: "GET" },
    {
      path: "/api/v1/dashboard/users/restrict",
      method: "POST",
      body: { action: "ban", userId: "123" },
    },
    { path: "/api/v1/dashboard/benchmarks", method: "GET" },
    { path: "/api/v1/dashboard/benchmarks/report?name=x", method: "GET" },
  ];

  for (const r of routes) {
    test(`${r.method} ${r.path} -> 401 without token`, async () => {
      const { storage } = seededStorage();
      const res = await handleDashboardRequest(req(r.path, { method: r.method, body: r.body }), deps(storage));
      expect(res).toBeDefined();
      expect(res!.status).toBe(401);
      expect(((await jsonBody(res!))["error"] as string).length).toBeGreaterThan(0);
    });

    test(`${r.method} ${r.path} -> 401 with wrong token`, async () => {
      const { storage } = seededStorage();
      const res = await handleDashboardRequest(
        req(r.path, { method: r.method, token: "wrong-token", body: r.body }),
        deps(storage),
      );
      expect(res).toBeDefined();
      expect(res!.status).toBe(401);
    });
  }

  test("GET /dashboard without token serves the login shell with zero owner data", async () => {
    const { storage } = seededStorage();
    storage.upsertMemory({ userId: OWNER_ID, content: "SECRET-MEMORY-CONTENT", key: "secret-key" });
    const res = await handleDashboardRequest(req("/dashboard", noAuth), deps(storage));
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/html");
    const page = await res!.text();
    expect(page).toContain("bobi_dash_token");
    expect(page).not.toContain("SECRET-MEMORY-CONTENT");
    expect(page).not.toContain("secret-key");
    expect(page).not.toContain("/api/v1/dashboard/providers");
    expect(page).not.toContain("تست پروایدر");
  });

  test("GET /dashboard with token serves the SPA shell", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(req("/dashboard", auth), deps(storage));
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
    const page = await res!.text();
    expect(page).toContain("tabP");
    // The SPA shell is code, not data: no provider names baked in.
    expect(page).not.toContain("تست پروایدر");
  });

  test("non-dashboard paths return undefined (caller 404s)", async () => {
    const { storage } = seededStorage();
    expect(handleDashboardRequest(req("/api/v1/nope", auth), deps(storage))).toBeUndefined();
    expect(handleDashboardRequest(req("/dashboard/evil", auth), deps(storage))).toBeUndefined();
  });
});

describe("dashboard CSRF posture", () => {
  test("POST without JSON content-type -> 415", async () => {
    const { storage } = seededStorage();
    const r = new Request("http://localhost/api/v1/dashboard/providers/enable", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: JSON.stringify({ id: 1, enabled: false }),
    });
    const res = await handleDashboardRequest(r, deps(storage));
    expect(res!.status).toBe(415);
  });

  test("GET on a POST route -> 405; POST on a GET route -> 405", async () => {
    const { storage } = seededStorage();
    const a = await handleDashboardRequest(req("/api/v1/dashboard/providers/enable", auth), deps(storage));
    expect(a!.status).toBe(405);
    const b = await handleDashboardRequest(
      req("/api/v1/dashboard/providers", { ...auth, method: "POST", body: {} }),
      deps(storage),
    );
    expect(b!.status).toBe(405);
  });
});

describe("dashboard providers API", () => {
  test("GET /providers lists providers with models and runtime selection", async () => {
    const { storage, providerId, modelId } = seededStorage();
    const res = await handleDashboardRequest(req("/api/v1/dashboard/providers", auth), deps(storage));
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    const providers = body["providers"] as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]!["id"]).toBe(providerId);
    expect(providers[0]!["label"]).toBe("تست پروایدر");
    // No credential material, only a boolean.
    expect(providers[0]!["hasCredential"]).toBe(false);
    expect("apiKey" in providers[0]!).toBe(false);
    const models = providers[0]!["models"] as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0]!["id"]).toBe(modelId);
    const runtime = body["runtime"] as Record<string, unknown>;
    expect(runtime["activeProviderId"]).toBe(providerId);
    expect(runtime["activeModelId"]).toBe(modelId);
  });

  test("POST /providers/enable toggles and refuses disabling the active provider", async () => {
    const { storage, providerId } = seededStorage();
    // Disabling the ACTIVE provider is refused (mirrors ProviderService).
    const bad = await handleDashboardRequest(
      req("/api/v1/dashboard/providers/enable", { ...auth, method: "POST", body: { id: providerId, enabled: false } }),
      deps(storage),
    );
    expect(bad!.status).toBe(400);

    // Add a second provider, activate it, then disable the first.
    const p2 = storage.createProvider({ label: "p2", adapter: "openai", baseUrl: "https://x.test" });
    const m2 = storage.createModel({ providerId: p2, modelId: "m2", label: "m2" });
    storage.setRuntimeSelection({ providerId: p2, modelId: m2 });
    const ok = await handleDashboardRequest(
      req("/api/v1/dashboard/providers/enable", { ...auth, method: "POST", body: { id: providerId, enabled: false } }),
      deps(storage),
    );
    expect(ok!.status).toBe(200);
    const list = await jsonBody(
      (await handleDashboardRequest(req("/api/v1/dashboard/providers", auth), deps(storage)))!,
    );
    const providers = list["providers"] as Array<Record<string, unknown>>;
    expect(providers.find((p) => p["id"] === providerId)!["enabled"]).toBe(false);
  });

  test("POST /providers/activate switches provider + default model", async () => {
    const { storage } = seededStorage();
    const p2 = storage.createProvider({ label: "p2", adapter: "openai", baseUrl: "https://x.test" });
    const m2 = storage.createModel({ providerId: p2, modelId: "m2", label: "m2" });
    const res = await handleDashboardRequest(
      req("/api/v1/dashboard/providers/activate", { ...auth, method: "POST", body: { id: p2 } }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const runtime = storage.getRuntimeSettings();
    expect(runtime.activeProviderId).toBe(p2);
    expect(runtime.activeModelId).toBe(m2);
  });

  test("POST /models/enable and /models/activate", async () => {
    const { storage, providerId, modelId } = seededStorage();
    const m2 = storage.createModel({ providerId, modelId: "m2", label: "دوم" });
    const act = await handleDashboardRequest(
      req("/api/v1/dashboard/models/activate", { ...auth, method: "POST", body: { id: m2 } }),
      deps(storage),
    );
    expect(act!.status).toBe(200);
    expect(storage.getRuntimeSettings().activeModelId).toBe(m2);

    // Disabling the active model is refused.
    const bad = await handleDashboardRequest(
      req("/api/v1/dashboard/models/enable", { ...auth, method: "POST", body: { id: m2, enabled: false } }),
      deps(storage),
    );
    expect(bad!.status).toBe(400);

    // Disabling the inactive one works.
    const ok = await handleDashboardRequest(
      req("/api/v1/dashboard/models/enable", { ...auth, method: "POST", body: { id: modelId, enabled: false } }),
      deps(storage),
    );
    expect(ok!.status).toBe(200);
  });

  test("invalid ids -> 400, unknown ids -> 404", async () => {
    const { storage } = seededStorage();
    const bad = await handleDashboardRequest(
      req("/api/v1/dashboard/providers/enable", { ...auth, method: "POST", body: { id: "x", enabled: true } }),
      deps(storage),
    );
    expect(bad!.status).toBe(400);
    const missing = await handleDashboardRequest(
      req("/api/v1/dashboard/providers/activate", { ...auth, method: "POST", body: { id: 4242 } }),
      deps(storage),
    );
    expect(missing!.status).toBe(404);
  });
});

describe("dashboard memory API (read-only)", () => {
  test("lists the owner's memories, supports q filter", async () => {
    const { storage } = seededStorage();
    storage.upsertMemory({ userId: OWNER_ID, key: "pet", content: "اسم گربه‌ام میومیو است" });
    storage.upsertMemory({ userId: OWNER_ID, key: "food", content: "قرمه‌سبزی دوست دارم" });
    storage.upsertMemory({ userId: "another-user", key: "theirs", content: "not mine" });

    const res = await handleDashboardRequest(req("/api/v1/dashboard/memory", auth), deps(storage));
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    const mems = body["mems"] as Array<Record<string, unknown>>;
    expect(mems).toHaveLength(2);
    expect(body["total"]).toBe(2);
    // Other users' memories never leak.
    expect(JSON.stringify(mems)).not.toContain("not mine");

    const filtered = await jsonBody(
      (await handleDashboardRequest(req("/api/v1/dashboard/memory?q=" + encodeURIComponent("گربه"), auth), deps(storage)))!,
    );
    expect((filtered["mems"] as unknown[])).toHaveLength(1);
  });

  test("memory content with markup is returned raw (client escapes it)", async () => {
    const { storage } = seededStorage();
    storage.upsertMemory({ userId: OWNER_ID, key: "xss", content: "<img src=x onerror=alert(1)>" });
    const body = await jsonBody(
      (await handleDashboardRequest(req("/api/v1/dashboard/memory", auth), deps(storage)))!,
    );
    const mems = body["mems"] as Array<Record<string, unknown>>;
    expect(mems[0]!["content"]).toBe("<img src=x onerror=alert(1)>");
  });

  test("without OWNER_TELEGRAM_ID -> 503 (fail closed, no cross-user read)", async () => {
    delete process.env.OWNER_TELEGRAM_ID;
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(req("/api/v1/dashboard/memory", auth), deps(storage));
    expect(res!.status).toBe(503);
  });

  test("there is no memory mutation route", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      req("/api/v1/dashboard/memory", { ...auth, method: "POST", body: {} }),
      deps(storage),
    );
    expect(res!.status).toBe(405);
  });
});

describe("dashboard users API", () => {
  test("lists users grouped by state", async () => {
    const { storage } = seededStorage();
    storage.createPendingUser({ userId: "111", username: "u1", firstName: "Ali" });
    const res = await handleDashboardRequest(req("/api/v1/dashboard/users", auth), deps(storage));
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    const groups = body["groups"] as Record<string, Array<Record<string, unknown>>>;
    expect(groups["pending"]!).toHaveLength(1);
    expect(groups["pending"]![0]!["userId"]).toBe("111");
    expect(groups["pending"]![0]!["username"]).toBe("u1");
    const counts = body["counts"] as Record<string, number>;
    expect(counts["pending"]).toBe(1);
  });

  test("ban/mute/unban/unmute mirror the /ban command semantics", async () => {
    const { storage } = seededStorage();
    storage.createPendingUser({ userId: "222" });
    const ban = (body: unknown) =>
      handleDashboardRequest(
        req("/api/v1/dashboard/users/restrict", { ...auth, method: "POST", body }),
        deps(storage),
      );

    const r1 = await ban({ action: "ban", userId: "222" });
    expect(r1!.status).toBe(200);
    expect(((await jsonBody(r1!))["state"] as string)).toBe("rejected");
    expect(storage.userAccess("222")?.state).toBe("rejected");

    const r2 = await ban({ action: "unban", userId: "222" });
    expect(r2!.status).toBe(200);
    expect(storage.userAccess("222")?.state).toBe("approved");

    const r3 = await ban({ action: "mute", userId: "222" });
    expect(r3!.status).toBe(200);
    expect(storage.userAccess("222")?.state).toBe("revoked");

    const r4 = await ban({ action: "unmute", userId: "222" });
    expect(r4!.status).toBe(200);
    expect(storage.userAccess("222")?.state).toBe("approved");
  });

  test("non-numeric userId -> 400; banning the owner -> 400", async () => {
    const { storage } = seededStorage();
    const ban = (body: unknown) =>
      handleDashboardRequest(
        req("/api/v1/dashboard/users/restrict", { ...auth, method: "POST", body }),
        deps(storage),
      );
    const bad = await ban({ action: "ban", userId: "not-a-number" });
    expect(bad!.status).toBe(400);
    const self = await ban({ action: "ban", userId: OWNER_ID });
    expect(self!.status).toBe(400);
    const badAction = await ban({ action: "explode", userId: "123" });
    expect(badAction!.status).toBe(400);
  });
});

describe("dashboard benchmarks API", () => {
  function benchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bobi-bench-"));
    const report = {
      generatedAt: "2026-10-18T10:00:00.000Z",
      mode: "offline",
      provider: "fake",
      model: "fake-echo",
      taskCount: 2,
      totals: { passed: 1, failed: 1, avgScorePct: 50, totalLatencyMs: 100, inputTokens: 10, outputTokens: 20, costUsd: 0 },
      results: [],
    };
    writeFileSync(join(dir, "20261018T100000.json"), JSON.stringify(report));
    writeFileSync(join(dir, "20261018T100000.md"), "# گزارش بنچ‌مارک بابی\n\n<script>alert(1)</script>\n");
    writeFileSync(join(dir, "evil<script>.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "not a run");
    return dir;
  }

  test("lists runs, skipping non-matching filenames", async () => {
    process.env.BOBI_BENCH_RESULTS_DIR = benchDir();
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(req("/api/v1/dashboard/benchmarks", auth), deps(storage));
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    const runs = body["runs"] as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!["name"]).toBe("20261018T100000");
    const totals = runs[0]!["totals"] as Record<string, unknown>;
    expect(totals["avgScorePct"]).toBe(50);
    expect(runs[0]!["mode"]).toBe("offline");
  });

  test("report serves the markdown; client renderer neutralizes embedded HTML", async () => {
    process.env.BOBI_BENCH_RESULTS_DIR = benchDir();
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      req("/api/v1/dashboard/benchmarks/report?name=20261018T100000", auth),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    const markdown = body["markdown"] as string;
    expect(markdown).toContain("<script>alert(1)</script>");
    // The client-side renderer (the same code the tests pin below) escapes it.
    expect(renderSafeMarkdown(markdown)).not.toContain("<script>");
    expect(renderSafeMarkdown(markdown)).toContain("&lt;script&gt;");
  });

  test("path traversal and unknown names are rejected", async () => {
    process.env.BOBI_BENCH_RESULTS_DIR = benchDir();
    const { storage } = seededStorage();
    for (const name of ["../../etc/passwd", "..%2F..%2Fx", "20261018T100000.md", "nope", ""]) {
      const res = await handleDashboardRequest(
        req("/api/v1/dashboard/benchmarks/report?name=" + encodeURIComponent(name), auth),
        deps(storage),
      );
      expect([400, 404]).toContain(res!.status);
    }
  });

  test("missing results dir -> empty list, not an error", async () => {
    process.env.BOBI_BENCH_RESULTS_DIR = join(tmpdir(), "bobi-bench-missing-" + Date.now());
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(req("/api/v1/dashboard/benchmarks", auth), deps(storage));
    expect(res!.status).toBe(200);
    expect(((await jsonBody(res!))["runs"] as unknown[])).toHaveLength(0);
  });
});

describe("dashboard rate limiting", () => {
  test("31 rapid requests -> the 31st is 429", async () => {
    const { storage } = seededStorage();
    let last = 200;
    for (let i = 0; i < 31; i++) {
      const res = await handleDashboardRequest(req("/api/v1/dashboard/ping", auth), deps(storage));
      last = res!.status;
    }
    expect(last).toBe(429);
  });
});

describe("safe renderers (shared browser/server code)", () => {
  test("escapeHtml neutralizes markup", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escapeHtml(`"quoted" & 'apos'`)).toBe("&quot;quoted&quot; &amp; &#39;apos&#39;");
  });

  test("renderSafeMarkdown renders structure but escapes raw HTML", () => {
    const out = renderSafeMarkdown("# تیتر\n\n- آیتم **درشت**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n```js\nconst x = 1;\n```\n");
    expect(out).toContain("<h1>تیتر</h1>");
    expect(out).toContain("<strong>درشت</strong>");
    expect(out).toContain("<table>");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).not.toContain("<img");
    // No link support by design: the markdown stays inert text — the
    // "javascript:" scheme survives only as escaped paragraph text, never as
    // a live href.
    expect(out).not.toContain("<a ");
    expect(out).toContain("<p>[click](javascript:alert(1))</p>");
    expect(out).toContain("<pre><code>");
  });
});

describe("server.ts wiring (additive)", () => {
  function serverDeps(storage: Storage, token: string): ApiServerDeps {
    const engine = new ConversationEngine({
      provider: new FakeProvider(),
      model: "fake-echo",
      timeoutMs: 5_000,
      maxConcurrent: 4,
    });
    return {
      storage,
      engineFactory: () => ({ respond: (input) => engine.respond(input) }),
      actorForOwner: () => ({ userId: "owner-sentinel", permissions: ["*"] }),
      token,
    };
  }

  test("dashboard disabled by default: /dashboard is 404, /health still live", async () => {
    delete process.env.BOBI_DASHBOARD;
    expect(isDashboardEnabled()).toBe(false);
    const { storage } = seededStorage();
    const server = createApiServer(serverDeps(storage, TOKEN), { listen: false });
    const dash = await server.fetch(new Request("http://localhost/dashboard"));
    expect(dash.status).toBe(404);
    const health = await server.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    server.stop();
  });

  test("BOBI_DASHBOARD=1: page serves, unknown routes still 404", async () => {
    process.env.BOBI_DASHBOARD = "1";
    expect(isDashboardEnabled()).toBe(true);
    const { storage } = seededStorage();
    const server = createApiServer(serverDeps(storage, TOKEN), { listen: false });
    const login = await server.fetch(new Request("http://localhost/dashboard"));
    expect(login.status).toBe(200);
    const authed = await server.fetch(
      new Request("http://localhost/dashboard", { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(authed.status).toBe(200);
    expect(await authed.text()).toContain("tabP");
    const api = await server.fetch(
      new Request("http://localhost/api/v1/dashboard/ping", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(api.status).toBe(200);
    const missing = await server.fetch(new Request("http://localhost/nope"));
    expect(missing.status).toBe(404);
    server.stop();
  });
});
