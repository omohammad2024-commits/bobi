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
import { escapeHtml, renderSafeMarkdown, buildLineChartSvg } from "../src/http/dashboard_render";
import { Database } from "bun:sqlite";
import { BenchHistory } from "../src/bench/history";
import { setAssistantConfig } from "../src/groups/assistant";
import type { BenchReport } from "../bench/run";
import { createApiServer, type ApiServerDeps } from "../src/http/server";
import { ConversationEngine } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";

const TOKEN = "dashboard-test-token-long-and-random-0123456789abcdef";
const OWNER_ID = "999001";

function deps(storage: Storage, token: string = TOKEN, benchHistory?: BenchHistory): DashboardDeps {
  return benchHistory === undefined ? { storage, token } : { storage, token, benchHistory };
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
    { path: "/api/v1/dashboard/benchmarks/trends", method: "GET" },
    { path: "/api/v1/dashboard/benchmarks/live/stream", method: "GET" },
    { path: "/api/v1/dashboard/schedulers", method: "GET" },
    {
      path: "/api/v1/dashboard/schedulers/bench",
      method: "POST",
      body: { enabled: true, cadence: "weekly" },
    },
    {
      path: "/api/v1/dashboard/schedulers/digest",
      method: "POST",
      body: { enabled: true, time: "08:00" },
    },
    { path: "/api/v1/dashboard/digest/config", method: "GET" },
    {
      path: "/api/v1/dashboard/digest/prompt",
      method: "POST",
      body: { prompt: "x" },
    },
    { path: "/api/v1/dashboard/digest/prompt/reset", method: "POST", body: {} },
    {
      path: "/api/v1/dashboard/digest/destination",
      method: "POST",
      body: { chatId: "123" },
    },
    { path: "/api/v1/dashboard/group-digests", method: "GET" },
    {
      path: "/api/v1/dashboard/group-digests/set",
      method: "POST",
      body: { chatId: "-1001", digestEnabled: false },
    },
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

  test("authed SPA shell embeds the schedulers tab and the chart builder", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(req("/dashboard", auth), deps(storage));
    expect(res!.status).toBe(200);
    const page = await res!.text();
    expect(page).toContain('data-t="schedulers"');
    expect(page).toContain("Schedulers");
    expect(page).toContain("buildLineChartSvg");
    expect(page).toContain("trendTitle");
    // Still code, not data: no scheduler state baked into the shell.
    expect(page).not.toContain("bench: scheduled run");
  });

  test("both inline scripts parse (regression: unbalanced braces killed the SPA)", async () => {
    // The app shell's T() once missed its closing brace, which made the
    // whole SPA script unparseable — the shell rendered "loading" forever.
    // new Function() compiles without running: a SyntaxError fails the test.
    const { storage } = seededStorage();
    const extractScript = (page: string): string => {
      const start = page.indexOf("<script>\n");
      const end = page.lastIndexOf("</script>");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return page.slice(start + "<script>\n".length, end);
    };
    const appRes = await handleDashboardRequest(req("/dashboard", auth), deps(storage));
    const appScript = extractScript(await appRes!.text());
    expect(() => new Function(appScript)).not.toThrow();
    // And the unauthenticated login shell too.
    const loginRes = await handleDashboardRequest(req("/dashboard", noAuth), deps(storage));
    const loginScript = extractScript(await loginRes!.text());
    expect(() => new Function(loginScript)).not.toThrow();
  });
});

// ------------------------------------------------- phase 4: trends + schedulers

/** Canned BenchReport fixture (same shape as tests/bench_history.test.ts). */
function benchFixture(over: Partial<BenchReport> = {}): BenchReport {
  return {
    generatedAt: "2026-10-18T10:00:00.000Z",
    mode: "offline",
    provider: "fake",
    model: "fake-echo",
    taskCount: 2,
    totals: {
      passed: 1,
      failed: 1,
      avgScorePct: 75,
      totalLatencyMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0,
    },
    results: [
      {
        taskId: "calc_01",
        title_fa: "جمع ساده",
        category: "calc",
        passed: true,
        score: 3,
        maxScore: 3,
        checks: [],
        turns: [],
        totalLatencyMs: 50,
        inputTokens: 5,
        outputTokens: 10,
        costUsd: 0,
        costEstimated: true,
      },
      {
        taskId: "calc_02",
        title_fa: '"><script>alert(1)</script>',
        category: "calc",
        passed: false,
        score: 1,
        maxScore: 2,
        checks: [],
        turns: [],
        totalLatencyMs: 50,
        inputTokens: 5,
        outputTokens: 10,
        costUsd: 0,
        costEstimated: true,
      },
    ],
    ...over,
  };
}

function seededBenchHistory(): BenchHistory {
  const history = new BenchHistory(new Database(":memory:"));
  const base = benchFixture();
  history.recordRun({
    ...base,
    generatedAt: "2026-10-16T10:00:00.000Z",
    totals: { ...base.totals, avgScorePct: 60 },
  });
  history.recordRun({
    ...base,
    generatedAt: "2026-10-17T10:00:00.000Z",
    totals: { ...base.totals, avgScorePct: 80 },
  });
  history.recordRun({
    ...base,
    generatedAt: "2026-10-18T10:00:00.000Z",
    mode: "live",
    model: "real-model",
    totals: { ...base.totals, avgScorePct: 90 },
  });
  return history;
}

describe("dashboard benchmark trends API (phase 4)", () => {
  test("empty history -> null pair and empty series", async () => {
    const { storage } = seededStorage();
    const history = new BenchHistory(new Database(":memory:"));
    const res = await handleDashboardRequest(
      req("/api/v1/dashboard/benchmarks/trends", auth),
      deps(storage, TOKEN, history),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["pair"]).toBeNull();
    expect(body["runs"]).toEqual([]);
    expect(body["pairs"]).toEqual([]);
    expect(body["tasks"]).toEqual([]);
    expect(body["task"]).toBeNull();
  });

  test("default pair is the latest run; pairs and tasks are listed", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      req("/api/v1/dashboard/benchmarks/trends", auth),
      deps(storage, TOKEN, seededBenchHistory()),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["pair"]).toEqual({ mode: "live", model: "real-model" });
    const runs = body["runs"] as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!["avgScorePct"]).toBe(90);
    const pairs = body["pairs"] as Array<Record<string, unknown>>;
    expect(pairs).toHaveLength(2);
    const tasks = body["tasks"] as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t["taskId"]).sort()).toEqual(["calc_01", "calc_02"]);
  });

  test("explicit pair selects runs oldest->newest; task trend returns per-task points", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      req("/api/v1/dashboard/benchmarks/trends?mode=offline&model=fake-echo&task=calc_02", auth),
      deps(storage, TOKEN, seededBenchHistory()),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["pair"]).toEqual({ mode: "offline", model: "fake-echo" });
    const runs = body["runs"] as Array<Record<string, unknown>>;
    expect(runs.map((r) => r["avgScorePct"])).toEqual([60, 80]);
    expect((runs[0]!["tsMs"] as number) < (runs[1]!["tsMs"] as number)).toBe(true);
    const task = body["task"] as Record<string, unknown>;
    expect(task["taskId"]).toBe("calc_02");
    const points = task["points"] as Array<Record<string, unknown>>;
    expect(points).toHaveLength(2);
    expect(points[0]!["scorePct"]).toBe(50);
    // The hostile title travels as JSON data only; the chart builder escapes it.
    expect(task["titleFa"]).toContain("<script>");
    const svg = buildLineChartSvg({
      series: [
        {
          label: String(task["titleFa"]),
          color: "#ffb020",
          points: points.map((p) => ({ ts: Number(p["tsMs"]), value: Number(p["scorePct"]) })),
        },
      ],
      formatTick: (ts) => String(ts),
      emptyText: "none",
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  test("unknown pair -> empty series, not an error", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      req("/api/v1/dashboard/benchmarks/trends?mode=offline&model=nope", auth),
      deps(storage, TOKEN, seededBenchHistory()),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["runs"]).toEqual([]);
  });

  test("invalid mode/model/task values -> 400", async () => {
    const { storage } = seededStorage();
    const history = seededBenchHistory();
    for (const q of [
      "?mode=%3Cscript%3E&model=fake-echo",
      "?mode=offline&model=a%20b",
      "?mode=offline&model=fake-echo&task=CALC_01",
      "?mode=offline&model=fake-echo&task=../x",
    ]) {
      const res = await handleDashboardRequest(
        req("/api/v1/dashboard/benchmarks/trends" + q, auth),
        deps(storage, TOKEN, history),
      );
      expect(res!.status).toBe(400);
    }
  });
});

describe("dashboard schedulers API (phase 4)", () => {
  function post(path: string, body: unknown, token: string = TOKEN): Request {
    return req(path, { method: "POST", token, body });
  }

  test("GET with no schedules -> both missing", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(req("/api/v1/dashboard/schedulers", auth), deps(storage));
    expect(res!.status).toBe(200);
    const schedulers = (await jsonBody(res!))["schedulers"] as Array<Record<string, unknown>>;
    expect(schedulers.map((s) => s["key"])).toEqual(["bench", "digest"]);
    expect(schedulers[0]!["exists"]).toBe(false);
    expect(schedulers[0]!["enabled"]).toBe(false);
    expect(schedulers[1]!["exists"]).toBe(false);
  });

  test("bench: validation rejects bad input", async () => {
    const { storage } = seededStorage();
    for (const body of [
      {},
      { enabled: "yes" },
      { enabled: true },
      { enabled: true, cadence: "hourly" },
      { enabled: true, cadence: "weekly; rm -rf" },
      { enabled: true, cadence: "weekly", mode: "turbo" },
    ]) {
      const res = await handleDashboardRequest(
        post("/api/v1/dashboard/schedulers/bench", body),
        deps(storage),
      );
      expect(res!.status).toBe(400);
      expect(((await jsonBody(res!))["error"] as string).length).toBeGreaterThan(0);
    }
  });

  test("bench: enable weekly creates the task; state round-trips through GET", async () => {
    const { storage } = seededStorage();
    const before = Date.now();
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cadence: "weekly", mode: "offline" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const created = await jsonBody(res!);
    expect(created["ok"]).toBe(true);
    expect(created["cadence"]).toBe("weekly");
    const id = Number(created["id"]);
    const task = storage.getTask(OWNER_ID, id);
    expect(task?.name).toBe("bench: scheduled run");
    expect(task?.cronExpr).toBe("0 3 * * 0");
    expect(task?.timezone).toBe("Asia/Tehran");
    expect(task?.enabled).toBe(true);
    expect(task!.nextRunAtMs).toBeGreaterThan(before);
    expect(JSON.parse(task!.actionJson)).toEqual({
      type: "tool",
      tool: "run_bench",
      input: { mode: "offline" },
    });

    const get = await handleDashboardRequest(req("/api/v1/dashboard/schedulers", auth), deps(storage));
    const bench = ((await jsonBody(get!))["schedulers"] as Array<Record<string, unknown>>)[0]!;
    expect(bench["exists"]).toBe(true);
    expect(bench["enabled"]).toBe(true);
    expect(bench["cadence"]).toBe("weekly");
    expect(bench["mode"]).toBe("offline");
    expect(bench["cron"]).toBe("0 3 * * 0");
  });

  test("bench: live mode is baked into the action; cadence updates in place", async () => {
    const { storage } = seededStorage();
    const first = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cadence: "weekly" }),
      deps(storage),
    );
    const id = Number((await jsonBody(first!))["id"]);
    const second = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cadence: "daily", mode: "live" }),
      deps(storage),
    );
    expect(second!.status).toBe(200);
    expect(Number((await jsonBody(second!))["id"])).toBe(id);
    const task = storage.getTask(OWNER_ID, id);
    expect(task?.cronExpr).toBe("0 3 * * *");
    expect(JSON.parse(task!.actionJson)).toEqual({
      type: "tool",
      tool: "run_bench",
      input: { mode: "live" },
    });
    // Exactly one bench schedule exists — updates never duplicate.
    expect(storage.listTasks(OWNER_ID, 200).filter((t) => t.name === "bench: scheduled run")).toHaveLength(1);
  });

  test("bench: disable flips the flag and keeps the row; disabling a missing schedule -> 400", async () => {
    const { storage } = seededStorage();
    const missing = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: false }),
      deps(storage),
    );
    expect(missing!.status).toBe(400);

    const created = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cadence: "monthly" }),
      deps(storage),
    );
    const id = Number((await jsonBody(created!))["id"]);
    const off = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: false }),
      deps(storage),
    );
    expect(off!.status).toBe(200);
    const task = storage.getTask(OWNER_ID, id);
    expect(task?.enabled).toBe(false);
    // Row (and its history) is kept, unlike Telegram's `schedule off`.
    expect(task?.cronExpr).toBe("0 3 1 * *");

    const get = await handleDashboardRequest(req("/api/v1/dashboard/schedulers", auth), deps(storage));
    const bench = ((await jsonBody(get!))["schedulers"] as Array<Record<string, unknown>>)[0]!;
    expect(bench["enabled"]).toBe(false);
    expect(bench["exists"]).toBe(true);
  });

  test("bench: a Telegram-set custom cron is reported as custom", async () => {
    const { storage } = seededStorage();
    storage.createTask({
      name: "bench: scheduled run",
      cronExpr: "15 4 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "tool", tool: "run_bench", input: { mode: "offline" } }),
      createdByUserId: OWNER_ID,
      nextRunAtMs: Date.now() + 3_600_000,
    });
    const res = await handleDashboardRequest(req("/api/v1/dashboard/schedulers", auth), deps(storage));
    const bench = ((await jsonBody(res!))["schedulers"] as Array<Record<string, unknown>>)[0]!;
    expect(bench["cadence"]).toBe("custom");
    expect(bench["cron"]).toBe("15 4 * * *");
  });

  test("bench: every mutation is audit-logged", async () => {
    const { storage } = seededStorage();
    await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cadence: "weekly" }),
      deps(storage),
    );
    await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cadence: "hourly" }),
      deps(storage),
    );
    const events = storage.auditEvents(50);
    const ok = events.find((e) => e.operation === "dashboard.scheduler.bench" && e.outcome === "success");
    const denied = events.find((e) => e.operation === "dashboard.scheduler.bench" && e.outcome === "denied");
    expect(ok).toBeDefined();
    expect(ok!.actorId).toBe(OWNER_ID);
    expect(denied).toBeDefined();
    // Audit detail carries no secrets — just the cadence key.
    expect(String(ok!.detail)).not.toContain(TOKEN);
  });

  test("digest: validation rejects bad time; create requires a time", async () => {
    const { storage } = seededStorage();
    for (const body of [
      { enabled: true },
      { enabled: true, time: "25:00" },
      { enabled: true, time: "8:00" },
      { enabled: true, time: "08:60" },
      { enabled: true, time: "08:00; rm" },
      { enabled: "yes" },
    ]) {
      const res = await handleDashboardRequest(
        post("/api/v1/dashboard/schedulers/digest", body),
        deps(storage),
      );
      expect(res!.status).toBe(400);
    }
  });

  test("digest: enable with time creates the blueprint-equivalent task", async () => {
    const { storage } = seededStorage();
    const before = Date.now();
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true, time: "08:30" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const created = await jsonBody(res!);
    expect(created["ok"]).toBe(true);
    expect(created["time"]).toBe("08:30");
    const id = Number(created["id"]);
    const task = storage.getTask(OWNER_ID, id);
    expect(task?.name).toBe("blueprint: morning_digest");
    expect(task?.cronExpr).toBe("30 8 * * *");
    expect(task?.timezone).toBe("Asia/Tehran");
    expect(task!.nextRunAtMs).toBeGreaterThan(before);
    const action = JSON.parse(task!.actionJson) as Record<string, unknown>;
    expect(action["type"]).toBe("agent");
    // Fresh digest delivers to the owner's DM, like /blueprint from a DM.
    expect(action["chatId"]).toBe(OWNER_ID);
    expect(typeof action["prompt"]).toBe("string");

    const get = await handleDashboardRequest(req("/api/v1/dashboard/schedulers", auth), deps(storage));
    const digest = ((await jsonBody(get!))["schedulers"] as Array<Record<string, unknown>>)[1]!;
    expect(digest["exists"]).toBe(true);
    expect(digest["enabled"]).toBe(true);
    expect(digest["time"]).toBe("08:30");
  });

  test("digest: updating the time preserves the existing action (chatId + prompt)", async () => {
    const { storage } = seededStorage();
    const id = storage.createTask({
      name: "blueprint: morning_digest",
      cronExpr: "0 8 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "agent", chatId: "custom-chat", prompt: "custom prompt" }),
      createdByUserId: OWNER_ID,
      nextRunAtMs: Date.now() + 3_600_000,
    });
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true, time: "09:15" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    expect((await jsonBody(res!))["time"]).toBe("09:15");
    const task = storage.getTask(OWNER_ID, id);
    expect(task?.cronExpr).toBe("15 9 * * *");
    const action = JSON.parse(task!.actionJson) as Record<string, unknown>;
    expect(action["chatId"]).toBe("custom-chat");
    expect(action["prompt"]).toBe("custom prompt");
  });

  test("digest: toggling on without a time keeps the current cron", async () => {
    const { storage } = seededStorage();
    const id = storage.createTask({
      name: "blueprint: morning_digest",
      cronExpr: "30 7 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "agent", chatId: OWNER_ID, prompt: "p" }),
      createdByUserId: OWNER_ID,
      nextRunAtMs: Date.now() + 3_600_000,
      enabled: false,
    });
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const task = storage.getTask(OWNER_ID, id);
    expect(task?.enabled).toBe(true);
    expect(task?.cronExpr).toBe("30 7 * * *");
  });

  test("digest: disable flips the flag; disabling a missing schedule -> 400", async () => {
    const { storage } = seededStorage();
    const missing = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: false }),
      deps(storage),
    );
    expect(missing!.status).toBe(400);

    const created = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true, time: "07:00" }),
      deps(storage),
    );
    const id = Number((await jsonBody(created!))["id"]);
    const off = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: false }),
      deps(storage),
    );
    expect(off!.status).toBe(200);
    expect(storage.getTask(OWNER_ID, id)?.enabled).toBe(false);
  });

  test("digest: mutations are audit-logged", async () => {
    const { storage } = seededStorage();
    await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true, time: "08:00" }),
      deps(storage),
    );
    const events = storage.auditEvents(50);
    const ok = events.find((e) => e.operation === "dashboard.scheduler.digest" && e.outcome === "success");
    expect(ok).toBeDefined();
    expect(ok!.actorId).toBe(OWNER_ID);
    expect(String(ok!.detail)).toContain("08:00");
  });

  test("owner id missing -> 503 (fail-closed)", async () => {
    delete process.env.OWNER_TELEGRAM_ID;
    const { storage } = seededStorage();
    const get = await handleDashboardRequest(req("/api/v1/dashboard/schedulers", auth), deps(storage));
    expect(get!.status).toBe(503);
    const postRes = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cadence: "weekly" }),
      deps(storage),
    );
    expect(postRes!.status).toBe(503);
  });

  test("POST without JSON content-type -> 415", async () => {
    const { storage } = seededStorage();
    const r = new Request("http://localhost/api/v1/dashboard/schedulers/bench", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: JSON.stringify({ enabled: true, cadence: "weekly" }),
    });
    const res = await handleDashboardRequest(r, deps(storage));
    expect(res!.status).toBe(415);
  });
});

describe("buildLineChartSvg (shared browser/server code)", () => {
  const fmt = { formatTick: (ts: number) => "t" + ts, emptyText: "no data" };

  test("empty series renders the escaped empty message", () => {
    const svg = buildLineChartSvg({ series: [], ...fmt, emptyText: "داده‌ای نیست <>" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("داده‌ای نیست &lt;&gt;");
    expect(svg).not.toContain("<>");
  });

  test("labels, colors and tick strings are escaped (XSS)", () => {
    const svg = buildLineChartSvg({
      series: [
        {
          label: '"><script>alert(1)</script>',
          color: 'red" onload="alert(2)',
          points: [{ ts: 1, value: 50 }],
        },
      ],
      formatTick: () => "<b>tick</b>",
      emptyText: "none",
    });
    expect(svg).not.toContain("<script>");
    // The hostile color is attribute-escaped: quotes become &quot; so it
    // cannot break out of stroke="/fill=" — the raw payload never appears.
    expect(svg).not.toContain('onload="alert');
    expect(svg).toContain("onload=&quot;alert(2)");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&lt;b&gt;tick&lt;/b&gt;");
  });

  test("non-finite points are dropped; values clamp to the bounds", () => {
    const svg = buildLineChartSvg({
      series: [
        {
          label: "s",
          color: "#fff",
          points: [
            { ts: 1, value: NaN },
            { ts: 2, value: Infinity },
            { ts: 3, value: 150 },
            { ts: 4, value: -20 },
          ],
        },
      ],
      ...fmt,
    });
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("Infinity");
    // Only the two finite points survive as dots.
    expect(svg.match(/<circle/g)?.length).toBe(2);
  });

  test("rtl reverses the time axis", () => {
    const points = [
      { ts: 100, value: 10 },
      { ts: 200, value: 90 },
    ];
    const ltr = buildLineChartSvg({ series: [{ label: "s", color: "#fff", points }], ...fmt });
    const rtl = buildLineChartSvg({ series: [{ label: "s", color: "#fff", points }], rtl: true, ...fmt });
    const xs = (svg: string): number[] =>
      [...svg.matchAll(/<circle cx="([0-9.]+)"/g)].map((m) => Number(m[1]));
    const xl = xs(ltr);
    expect(xl[0]!).toBeLessThan(xl[1]!);
    const xr = xs(rtl);
    expect(xr[0]!).toBeGreaterThan(xr[1]!);
  });

  test("single point renders without crashing", () => {
    const svg = buildLineChartSvg({
      series: [{ label: "one", color: "#fff", points: [{ ts: 5, value: 42 }] }],
      ...fmt,
    });
    expect(svg).toContain("<circle");
    expect(svg).toContain("<path");
  });
});

describe("dashboard custom crons (phase 5)", () => {
  function post(path: string, body: unknown, token: string = TOKEN): Request {
    return req(path, { method: "POST", token, body });
  }

  test("bench: invalid custom crons are rejected", async () => {
    const { storage } = seededStorage();
    for (const cron of [
      "not a cron",
      "0 0 0 * *", // day-of-month 0 is invalid
      "61 * * * *", // minute out of range
      "0 0 30 2 *", // February 30th can never occur
      "* * * * * *", // six fields
      "x".repeat(65), // over the length cap
      "",
    ]) {
      const res = await handleDashboardRequest(
        post("/api/v1/dashboard/schedulers/bench", { enabled: true, cron }),
        deps(storage),
      );
      expect(res!.status).toBe(400);
      expect(((await jsonBody(res!))["error"] as string).length).toBeGreaterThan(0);
    }
  });

  test("bench: overly-frequent custom crons are rejected (floor: 1h)", async () => {
    const { storage } = seededStorage();
    for (const cron of ["* * * * *", "*/30 * * * *", "*/59 * * * *"]) {
      const res = await handleDashboardRequest(
        post("/api/v1/dashboard/schedulers/bench", { enabled: true, cron }),
        deps(storage),
      );
      expect(res!.status).toBe(400);
    }
    // No task row was created by the rejected attempts.
    expect(storage.listTasks(OWNER_ID, 200)).toHaveLength(0);

    // Exactly at the floor is allowed: @hourly == 60 minutes between firings.
    const ok = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cron: "@hourly" }),
      deps(storage),
    );
    expect(ok!.status).toBe(200);
  });

  test("bench: a valid custom cron installs, marked custom, and updates in place", async () => {
    const { storage } = seededStorage();
    const first = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cron: "0 4 * * 1" }),
      deps(storage),
    );
    expect(first!.status).toBe(200);
    const created = await jsonBody(first!);
    expect(created["ok"]).toBe(true);
    expect(created["custom"]).toBe(true);
    expect(created["cron"]).toBe("0 4 * * 1");
    expect(created["cadence"]).toBeUndefined();
    const id = Number(created["id"]);
    expect(storage.getTask(OWNER_ID, id)?.cronExpr).toBe("0 4 * * 1");

    const second = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cron: "0 5 * * 2", mode: "live" }),
      deps(storage),
    );
    expect(second!.status).toBe(200);
    const upd = await jsonBody(second!);
    expect(Number(upd["id"])).toBe(id);
    expect(upd["custom"]).toBe(true);
    expect(upd["mode"]).toBe("live");
    expect(storage.listTasks(OWNER_ID, 200)).toHaveLength(1);

    const get = await handleDashboardRequest(req("/api/v1/dashboard/schedulers", auth), deps(storage));
    const bench = ((await jsonBody(get!))["schedulers"] as Array<Record<string, unknown>>)[0]!;
    expect(bench["cadence"]).toBe("custom");
    expect(bench["cron"]).toBe("0 5 * * 2");
  });

  test("bench: presets keep working after the custom-cron change", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", { enabled: true, cadence: "daily" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["cadence"]).toBe("daily");
    expect(body["custom"]).toBeUndefined();
  });

  test("bench: a custom cron takes precedence over the cadence selector", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/bench", {
        enabled: true,
        cadence: "daily",
        cron: "0 6 * * 3",
      }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["custom"]).toBe(true);
    expect(body["cron"]).toBe("0 6 * * 3");
  });

  test("digest: invalid and overly-frequent custom crons are rejected (floor: 15min)", async () => {
    const { storage } = seededStorage();
    for (const cron of ["garbage", "* * * * *", "*/10 * * * *"]) {
      const res = await handleDashboardRequest(
        post("/api/v1/dashboard/schedulers/digest", { enabled: true, cron }),
        deps(storage),
      );
      expect(res!.status).toBe(400);
    }
    expect(storage.listTasks(OWNER_ID, 200)).toHaveLength(0);
  });

  test("digest: a valid custom cron installs and the view reports it as custom", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true, cron: "0 8 * * *" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["custom"]).toBe(true);
    expect(body["cron"]).toBe("0 8 * * *");
    expect(body["time"]).toBe("08:00");

    const get = await handleDashboardRequest(req("/api/v1/dashboard/schedulers", auth), deps(storage));
    const digest = ((await jsonBody(get!))["schedulers"] as Array<Record<string, unknown>>)[1]!;
    // The view maps picker-representable crons back to a time (custom:false),
    // whatever their origin — the POST receipt above is what reports custom.
    expect(digest["custom"]).toBeFalsy();
    expect(digest["cron"]).toBe("0 8 * * *");
    expect(digest["time"]).toBe("08:00");
  });

  test("digest: non-daily custom cron shows custom without a time mapping", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true, cron: "0 */2 * * *" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["custom"]).toBe(true);
    expect(body["time"]).toBeNull();
  });
});

describe("dashboard digest prompt & destination (phase 5)", () => {
  function post(path: string, body: unknown, token: string = TOKEN): Request {
    return req(path, { method: "POST", token, body });
  }

  const DEFAULT_PROMPT =
    "خلاصهٔ صبحگاهی به فارسی: مهم‌ترین کارهای امروز، یادآورهای نزدیک و هدف‌های فعال را کوتاه خلاصه کن.";

  async function createDigest(storage: Storage): Promise<number> {
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true, time: "08:00" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    return Number((await jsonBody(res!))["id"]);
  }

  test("config: no task -> exists:false; prompt edit without a task -> 400", async () => {
    const { storage } = seededStorage();
    const get = await handleDashboardRequest(req("/api/v1/dashboard/digest/config", auth), deps(storage));
    expect(get!.status).toBe(200);
    const cfg = await jsonBody(get!);
    expect(cfg["exists"]).toBe(false);
    expect(cfg["enabled"]).toBe(false);

    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/digest/prompt", { prompt: "hello" }),
      deps(storage),
    );
    expect(res!.status).toBe(400);
  });

  test("config: blueprint ownership is surfaced and the default prompt is shown", async () => {
    const { storage } = seededStorage();
    await createDigest(storage);
    const get = await handleDashboardRequest(req("/api/v1/dashboard/digest/config", auth), deps(storage));
    expect(get!.status).toBe(200);
    const cfg = await jsonBody(get!);
    expect(cfg["exists"]).toBe(true);
    expect(cfg["blueprint"]).toBe("morning_digest");
    expect(cfg["ownedBy"]).toBe("blueprint");
    expect(cfg["actionIsAgent"]).toBe(true);
    expect(cfg["prompt"]).toBe(DEFAULT_PROMPT);
    expect(cfg["isCustomPrompt"]).toBe(false);
    expect(cfg["chatId"]).toBe(OWNER_ID);
    expect(cfg["isDefaultDestination"]).toBe(true);
    expect(cfg["time"]).toBe("08:00");
  });

  test("prompt: edit round-trips through the same scheduler store (ownership respected)", async () => {
    const { storage } = seededStorage();
    const id = await createDigest(storage);
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/digest/prompt", { prompt: "پرامپت تستی داشبورد" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["ok"]).toBe(true);
    expect(body["isCustomPrompt"]).toBe(true);

    // The row is updated in place: name, cron and destination are untouched.
    const task = storage.getTask(OWNER_ID, id);
    expect(task?.name).toBe("blueprint: morning_digest");
    expect(task?.cronExpr).toBe("0 8 * * *");
    const action = JSON.parse(task!.actionJson) as Record<string, unknown>;
    expect(action["type"]).toBe("agent");
    expect(action["prompt"]).toBe("پرامپت تستی داشبورد");
    expect(action["chatId"]).toBe(OWNER_ID);

    const get = await handleDashboardRequest(req("/api/v1/dashboard/digest/config", auth), deps(storage));
    const cfg = await jsonBody(get!);
    expect(cfg["prompt"]).toBe("پرامپت تستی داشبورد");
    expect(cfg["isCustomPrompt"]).toBe(true);

    // A later time change (same store) preserves the custom prompt.
    const upd = await handleDashboardRequest(
      post("/api/v1/dashboard/schedulers/digest", { enabled: true, time: "09:15" }),
      deps(storage),
    );
    expect(upd!.status).toBe(200);
    const task2 = storage.getTask(OWNER_ID, id);
    expect((JSON.parse(task2!.actionJson) as Record<string, unknown>)["prompt"]).toBe(
      "پرامپت تستی داشبورد",
    );
  });

  test("prompt: validation rejects empty / too-long / non-string prompts", async () => {
    const { storage } = seededStorage();
    await createDigest(storage);
    for (const prompt of ["", "   ", "x".repeat(4001), 123, null]) {
      const res = await handleDashboardRequest(
        post("/api/v1/dashboard/digest/prompt", { prompt }),
        deps(storage),
      );
      expect(res!.status).toBe(400);
    }
  });

  test("prompt: reset restores the /blueprint default", async () => {
    const { storage } = seededStorage();
    const id = await createDigest(storage);
    await handleDashboardRequest(
      post("/api/v1/dashboard/digest/prompt", { prompt: "custom" }),
      deps(storage),
    );
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/digest/prompt/reset", {}),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    expect((await jsonBody(res!))["isCustomPrompt"]).toBe(false);
    const task = storage.getTask(OWNER_ID, id);
    expect((JSON.parse(task!.actionJson) as Record<string, unknown>)["prompt"]).toBe(DEFAULT_PROMPT);
  });

  test("destination: edit changes only the chatId; bad chatIds are rejected", async () => {
    const { storage } = seededStorage();
    const id = await createDigest(storage);
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/digest/destination", { chatId: "-100123456" }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["chatId"]).toBe("-100123456");
    expect(body["isDefaultDestination"]).toBe(false);
    const task = storage.getTask(OWNER_ID, id);
    const action = JSON.parse(task!.actionJson) as Record<string, unknown>;
    expect(action["chatId"]).toBe("-100123456");
    expect(action["prompt"]).toBe(DEFAULT_PROMPT); // prompt untouched
    expect(task?.name).toBe("blueprint: morning_digest");

    for (const chatId of ["abc", "", "12.5", "1".repeat(21), "--5"]) {
      const bad = await handleDashboardRequest(
        post("/api/v1/dashboard/digest/destination", { chatId }),
        deps(storage),
      );
      expect(bad!.status).toBe(400);
    }
  });

  test("prompt/destination: a task whose action is not agent-shaped is refused, not mangled", async () => {
    const { storage } = seededStorage();
    storage.createTask({
      name: "blueprint: morning_digest",
      cronExpr: "0 8 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({ type: "tool", tool: "run_bench", input: {} }),
      createdByUserId: OWNER_ID,
      nextRunAtMs: Date.now() + 3_600_000,
      enabled: true,
    });
    const p = await handleDashboardRequest(
      post("/api/v1/dashboard/digest/prompt", { prompt: "x" }),
      deps(storage),
    );
    expect(p!.status).toBe(400);
    const d = await handleDashboardRequest(
      post("/api/v1/dashboard/digest/destination", { chatId: "123" }),
      deps(storage),
    );
    expect(d!.status).toBe(400);
    const cfg = await jsonBody(
      (await handleDashboardRequest(req("/api/v1/dashboard/digest/config", auth), deps(storage)))!,
    );
    expect(cfg["actionIsAgent"]).toBe(false);
    expect(cfg["prompt"]).toBeNull();
  });

  test("audit: prompt/destination changes are logged without the prompt text", async () => {
    const { storage } = seededStorage();
    const id = await createDigest(storage);
    await handleDashboardRequest(
      post("/api/v1/dashboard/digest/prompt", { prompt: "پرامپت محرمانهٔ تستی" }),
      deps(storage),
    );
    await handleDashboardRequest(
      post("/api/v1/dashboard/digest/destination", { chatId: "-1009" }),
      deps(storage),
    );
    const events = storage.auditEvents(50);
    const promptEv = events.find((e) => e.operation === "dashboard.digest.config" && (e.detail ?? "").includes("prompt updated"));
    expect(promptEv).toBeDefined();
    expect(promptEv!.outcome).toBe("success");
    expect(promptEv!.actorId).toBe(OWNER_ID);
    // The prompt text itself never lands in the audit detail.
    for (const e of events) {
      expect(e.detail ?? "").not.toContain("پرامپت محرمانهٔ تستی");
    }
    const destEv = events.find((e) => (e.detail ?? "").includes("destination updated"));
    expect(destEv).toBeDefined();
    expect(destEv!.outcome).toBe("success");
    expect(Number(destEv!.detail!.match(/id=(\d+)/)?.[1])).toBe(id);
  });
});

describe("dashboard group digests (phase 5)", () => {
  function post(path: string, body: unknown, token: string = TOKEN): Request {
    return req(path, { method: "POST", token, body });
  }

  function seedGroup(storage: Storage, chatId: string, patch: Record<string, unknown>): void {
    const res = setAssistantConfig(storage, OWNER_ID, chatId, patch);
    expect(res.ok).toBe(true);
  }

  test("list: empty when no group configs exist", async () => {
    const { storage } = seededStorage();
    const res = await handleDashboardRequest(req("/api/v1/dashboard/group-digests", auth), deps(storage));
    expect(res!.status).toBe(200);
    expect((await jsonBody(res!))["groups"]).toEqual([]);
  });

  test("list: groups with assistant configs are listed with digest + task state", async () => {
    const { storage } = seededStorage();
    seedGroup(storage, "-1001", { enabled: true, digestTime: "07:30" });
    seedGroup(storage, "-1002", { enabled: false });
    const res = await handleDashboardRequest(req("/api/v1/dashboard/group-digests", auth), deps(storage));
    expect(res!.status).toBe(200);
    const groups = (await jsonBody(res!))["groups"] as Array<Record<string, unknown>>;
    expect(groups.map((g) => g["chatId"])).toEqual(["-1001", "-1002"]);
    expect(groups[0]!["mode"]).toBe(true);
    expect(groups[0]!["digestEnabled"]).toBe(false);
    expect(groups[0]!["digestTime"]).toBe("07:30");
    expect((groups[0]!["task"] as Record<string, unknown>)["exists"]).toBe(false);
    expect(groups[1]!["mode"]).toBe(false);
  });

  test("set: enabling without assistant mode is refused (need_mode), no task created", async () => {
    const { storage } = seededStorage();
    seedGroup(storage, "-1001", { enabled: false });
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/group-digests/set", { chatId: "-1001", digestEnabled: true }),
      deps(storage),
    );
    expect(res!.status).toBe(400);
    expect(storage.listTasks(OWNER_ID, 200)).toHaveLength(0);
  });

  test("set: enable creates the digest task row and flips the config", async () => {
    const { storage } = seededStorage();
    seedGroup(storage, "-1001", { enabled: true, digestTime: "07:30" });
    const res = await handleDashboardRequest(
      post("/api/v1/dashboard/group-digests/set", { chatId: "-1001", digestEnabled: true }),
      deps(storage),
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(body["ok"]).toBe(true);
    expect(body["time"]).toBe("07:30");
    const rows = storage.listTasks(OWNER_ID, 200).filter((t) => t.name === "group_digest:-1001");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cronExpr).toBe("30 7 * * *");
    expect(rows[0]!.timezone).toBe("Asia/Tehran");
    const action = JSON.parse(rows[0]!.actionJson) as Record<string, unknown>;
    expect(action["type"]).toBe("tool");
    expect(action["tool"]).toBe("group_digest");
    expect((action["input"] as Record<string, unknown>)["chatId"]).toBe("-1001");

    const list = await handleDashboardRequest(req("/api/v1/dashboard/group-digests", auth), deps(storage));
    const groups = (await jsonBody(list!))["groups"] as Array<Record<string, unknown>>;
    expect(groups[0]!["digestEnabled"]).toBe(true);
    expect((groups[0]!["task"] as Record<string, unknown>)["exists"]).toBe(true);
    expect((groups[0]!["task"] as Record<string, unknown>)["enabled"]).toBe(true);
  });

  test("set: time change re-schedules in place (exactly one row); disable cancels the row", async () => {
    const { storage } = seededStorage();
    seedGroup(storage, "-1001", { enabled: true });
    await handleDashboardRequest(
      post("/api/v1/dashboard/group-digests/set", { chatId: "-1001", digestEnabled: true }),
      deps(storage),
    );
    const changed = await handleDashboardRequest(
      post("/api/v1/dashboard/group-digests/set", {
        chatId: "-1001",
        digestEnabled: true,
        time: "09:45",
      }),
      deps(storage),
    );
    expect(changed!.status).toBe(200);
    expect((await jsonBody(changed!))["time"]).toBe("09:45");
    const rows = storage.listTasks(OWNER_ID, 200).filter((t) => t.name === "group_digest:-1001");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cronExpr).toBe("45 9 * * *");

    const off = await handleDashboardRequest(
      post("/api/v1/dashboard/group-digests/set", { chatId: "-1001", digestEnabled: false }),
      deps(storage),
    );
    expect(off!.status).toBe(200);
    expect(storage.listTasks(OWNER_ID, 200).filter((t) => t.name === "group_digest:-1001")).toHaveLength(0);
    const list = await handleDashboardRequest(req("/api/v1/dashboard/group-digests", auth), deps(storage));
    const groups = (await jsonBody(list!))["groups"] as Array<Record<string, unknown>>;
    expect(groups[0]!["digestEnabled"]).toBe(false);
  });

  test("set: validation rejects bad chatId / time / missing flag", async () => {
    const { storage } = seededStorage();
    seedGroup(storage, "-1001", { enabled: true });
    for (const body of [
      { chatId: "abc", digestEnabled: true },
      { chatId: "", digestEnabled: false },
      { chatId: "-1001", digestEnabled: "yes" },
      { chatId: "-1001" },
      { chatId: "-1001", digestEnabled: true, time: "25:00" },
      { chatId: "-1001", digestEnabled: true, time: "8:00" },
    ]) {
      const res = await handleDashboardRequest(
        post("/api/v1/dashboard/group-digests/set", body),
        deps(storage),
      );
      expect(res!.status).toBe(400);
    }
  });

  test("set: audit entries record every change", async () => {
    const { storage } = seededStorage();
    seedGroup(storage, "-1001", { enabled: true });
    await handleDashboardRequest(
      post("/api/v1/dashboard/group-digests/set", { chatId: "-1001", digestEnabled: true }),
      deps(storage),
    );
    await handleDashboardRequest(
      post("/api/v1/dashboard/group-digests/set", { chatId: "-1001", digestEnabled: false }),
      deps(storage),
    );
    const events = storage.auditEvents(50).filter((e) => e.operation === "dashboard.group_digest");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.outcome).toBe("success");
    expect(events[0]!.actorId).toBe(OWNER_ID);
    expect(events[0]!.detail).toContain("-1001");
  });

  test("storage.listUserPrefKeys is prefix-scoped to the owner", async () => {
    const { storage } = seededStorage();
    seedGroup(storage, "-1001", { enabled: true });
    seedGroup(storage, "-1002", { enabled: true });
    storage.setUserPref(OWNER_ID, "voice_mode", "1");
    storage.setUserPref("other-user", "gacfg:-9999", "{}");
    expect(storage.listUserPrefKeys(OWNER_ID, "gacfg:")).toEqual(["gacfg:-1001", "gacfg:-1002"]);
    expect(storage.listUserPrefKeys(OWNER_ID, "gacfg:-1001")).toEqual(["gacfg:-1001"]);
  });
});
