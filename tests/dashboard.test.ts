/**
 * Web dashboard — RETIRED (platform Phase 10).
 *
 * The dashboard surface (src/http/dashboard_pages.ts, dashboard_render.ts
 * and the old dashboard.ts router) is deleted; the Mini App is the one
 * canonical web surface. docs/DASHBOARD_COVERAGE.md maps every former
 * dashboard action to its Mini App equivalent — the behaviors themselves
 * (providers, models, users, memory, schedulers, digests, benchmarks)
 * are pinned by the Mini App suites (miniapp_manage, miniapp_providers,
 * miniapp_desk, miniapp_skills, memory_hybrid).
 *
 * What remains of src/http/dashboard.ts is the old-URL handler, and this
 * suite pins exactly that contract:
 *   GET /dashboard[/]            → 301 to /miniapp/
 *   any /api/v1/dashboard[/...]  → 410 Gone (JSON, English, no data)
 *   everything else              → falls through (undefined)
 * …through the handler directly and through the real API server, with
 * BOBI_DASHBOARD unset AND set (the knob is retired: it changes nothing).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { handleDashboardRequest } from "../src/http/dashboard";
import { createApiServer, type ApiServerDeps } from "../src/http/server";
import { ConversationEngine, type ConversationInput } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import type { ToolActor } from "../src/tools/types";

const TOKEN = "dashboard-retired-token-0123456789abcdef";
const FA_RE = /[؀-ۿ]/;

const savedDashboardEnv = process.env.BOBI_DASHBOARD;
afterEach(() => {
  if (savedDashboardEnv === undefined) delete process.env.BOBI_DASHBOARD;
  else process.env.BOBI_DASHBOARD = savedDashboardEnv;
});

function req(path: string, method = "GET"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("dashboard retirement: page URLs", () => {
  test("GET /dashboard → 301 to the Mini App", () => {
    const res = handleDashboardRequest(req("/dashboard"));
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe("/miniapp/");
  });

  test("GET /dashboard/ (trailing slash) → 301 too", () => {
    const res = handleDashboardRequest(req("/dashboard/"));
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe("/miniapp/");
  });

  test("non-GET on /dashboard → 405 with an English JSON error", async () => {
    const res = handleDashboardRequest(req("/dashboard", "POST"));
    expect(res?.status).toBe(405);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(FA_RE.test(String(body["error"]))).toBe(false);
  });

  test("query strings don't break the redirect", () => {
    const res = handleDashboardRequest(req("/dashboard?next=providers"));
    expect(res?.status).toBe(301);
  });
});

describe("dashboard retirement: the old API namespace", () => {
  const GONE_PATHS = [
    "/api/v1/dashboard",
    "/api/v1/dashboard/ping",
    "/api/v1/dashboard/providers",
    "/api/v1/dashboard/models/activate",
    "/api/v1/dashboard/memory",
    "/api/v1/dashboard/users",
    "/api/v1/dashboard/benchmarks",
    "/api/v1/dashboard/benchmarks/report",
    "/api/v1/dashboard/benchmarks/trends",
    "/api/v1/dashboard/benchmarks/live/stream",
    "/api/v1/dashboard/schedulers",
    "/api/v1/dashboard/digest/config",
    "/api/v1/dashboard/group-digests",
  ];

  test("every former route answers 410 Gone with the retirement message", async () => {
    for (const path of GONE_PATHS) {
      const res = handleDashboardRequest(req(path));
      expect(res?.status).toBe(410);
      const body = (await res!.json()) as Record<string, unknown>;
      expect(String(body["error"])).toContain("retired");
      expect(String(body["error"])).toContain("/miniapp/");
      expect(FA_RE.test(String(body["error"]))).toBe(false);
      expect(res?.headers.get("content-type")).toContain("application/json");
      expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("POSTs to the namespace are 410 too (no writes possible)", () => {
    for (const path of ["/api/v1/dashboard/providers/enable", "/api/v1/dashboard/users/restrict"]) {
      const res = handleDashboardRequest(req(path, "POST"));
      expect(res?.status).toBe(410);
    }
  });

  test("410 regardless of BOBI_DASHBOARD (the knob is retired)", () => {
    delete process.env.BOBI_DASHBOARD;
    expect(handleDashboardRequest(req("/api/v1/dashboard/ping"))?.status).toBe(410);
    process.env.BOBI_DASHBOARD = "1";
    expect(handleDashboardRequest(req("/api/v1/dashboard/ping"))?.status).toBe(410);
    expect(handleDashboardRequest(req("/dashboard"))?.status).toBe(301);
  });
});

describe("dashboard retirement: fall-through", () => {
  test("non-dashboard paths are not claimed", () => {
    for (const path of [
      "/health",
      "/miniapp/",
      "/miniapp/api/providers.list",
      "/api/v1/turn",
      "/api/v1/dashboards",
      "/dashboards",
      "/dashboardx",
      "/",
    ]) {
      expect(handleDashboardRequest(req(path))).toBeUndefined();
    }
  });
});

describe("dashboard retirement: through the API server", () => {
  function makeServerDeps(): ApiServerDeps {
    const ownerActor: ToolActor = { userId: "owner-sentinel", permissions: ["*"] };
    const engine = new ConversationEngine({
      provider: new FakeProvider(),
      model: "fake-echo",
      timeoutMs: 5_000,
      maxConcurrent: 4,
    });
    return {
      storage: {} as ApiServerDeps["storage"],
      engineFactory: () => ({
        respond: (input: ConversationInput) => engine.respond(input),
      }),
      actorForOwner: () => ownerActor,
      token: TOKEN,
    };
  }

  test("/dashboard redirects and the namespace is 410 on the shared socket", async () => {
    const server = createApiServer(makeServerDeps(), { listen: false });
    const redir = await server.fetch(req("/dashboard"));
    expect(redir.status).toBe(301);
    expect(redir.headers.get("location")).toBe("/miniapp/");
    const gone = await server.fetch(req("/api/v1/dashboard/providers"));
    expect(gone.status).toBe(410);
  });

  test("/health keeps its canonical body on the same server", async () => {
    const server = createApiServer(makeServerDeps(), { listen: false });
    const health = await server.fetch(req("/health"));
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["status"]).toBe("ok");
    expect(typeof body["uptimeSeconds"]).toBe("number");
  });
});
