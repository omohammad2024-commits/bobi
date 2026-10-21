/**
 * Worker H audit (v1.0) — HTTP server & dashboard backend regressions.
 *
 * Covers the fixes from the audit pass:
 *  - server.ts: case-insensitive Bearer scheme (RFC 6750), /health uptimeMs,
 *    English-only JSON errors, x-content-type-options: nosniff on JSON.
 *  - dashboard.ts: RETIRED in platform Phase 10 — /dashboard redirects
 *    to the Mini App, the old API namespace answers 410 (English-only).
 *
 * Everything runs through the fetch handler / handleDashboardRequest with
 * listen:false — no socket is ever bound.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Storage } from "../src/storage/storage";
import {
  createApiServer,
  type ApiServerDeps,
} from "../src/http/server";
import { handleDashboardRequest } from "../src/http/dashboard";
import { ConversationEngine, type ConversationInput } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import type { ToolActor } from "../src/tools/types";

const TOKEN = "http-audit-token-long-and-random-0123456789abcdef";
const OWNER_ID = "999002";

/** Persian/Arabic Unicode block — must not appear in any user-facing string. */
const FA_RE = /[؀-ۿ]/;

function hasFa(s: string): boolean {
  return FA_RE.test(s);
}

// ---------------------------------------------------------- server.ts ----

function makeServerDeps(overrides: Partial<ApiServerDeps> = {}): ApiServerDeps {
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
    ...overrides,
  };
}

function postTurn(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/v1/turn", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = { userId: "42", conversationId: "c1", text: "hello" };

describe("http audit: server.ts", () => {
  test("Bearer scheme match is case-insensitive (RFC 6750)", async () => {
    const server = createApiServer(makeServerDeps(), { listen: false });
    const lower = await server.fetch(
      postTurn(validBody, { authorization: `bearer ${TOKEN}` }),
    );
    expect(lower.status).toBe(200);
    const body = (await lower.json()) as Record<string, unknown>;
    expect(typeof body["reply"]).toBe("string");
  });

  test("GET /health reports ok, version and uptimeMs", async () => {
    const server = createApiServer(makeServerDeps(), { listen: false });
    const res = await server.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(typeof body["version"]).toBe("string");
    expect(typeof body["uptimeMs"]).toBe("number");
    expect(body["uptimeMs"] as number).toBeGreaterThanOrEqual(0);
  });

  test("JSON error bodies are English-only", async () => {
    const server = createApiServer(makeServerDeps(), { listen: false });

    const notFound = await server.fetch(new Request("http://localhost/nope"));
    expect(notFound.status).toBe(404);
    const b404 = (await notFound.json()) as Record<string, unknown>;
    expect(b404["error"]).toBe("Not found.");

    const unauth = await server.fetch(postTurn(validBody));
    expect(unauth.status).toBe(401);
    const b401 = (await unauth.json()) as Record<string, unknown>;
    expect(b401["error"]).toBe("Invalid credentials.");

    const badBody = await server.fetch(
      postTurn({ userId: "1", conversationId: "c1" }, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(badBody.status).toBe(400);
    const b400 = (await badBody.json()) as Record<string, unknown>;
    expect(hasFa(b400["error"] as string)).toBe(false);
    expect(b400["error"]).toBe("The text field is required.");

    const wrongMethod = await server.fetch(
      new Request("http://localhost/api/v1/turn", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(wrongMethod.status).toBe(405);
    const b405 = (await wrongMethod.json()) as Record<string, unknown>;
    expect(b405["error"]).toBe("Method not allowed.");
  });

  test("JSON responses carry x-content-type-options: nosniff", async () => {
    const server = createApiServer(makeServerDeps(), { listen: false });
    const res = await server.fetch(new Request("http://localhost/health"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const notFound = await server.fetch(new Request("http://localhost/nope"));
    expect(notFound.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// ------------------------------------------------------- dashboard.ts ----
//
// Platform Phase 10: the dashboard is retired. These tests pin the
// old-URL behavior of the small retirement handler that remains:
// /dashboard redirects to the Mini App, /api/v1/dashboard/* is 410.

function dashReq(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
}

describe("http audit: dashboard retirement (phase 10)", () => {
  test("GET /dashboard redirects to the Mini App, no auth involved", () => {
    const res = handleDashboardRequest(dashReq("/dashboard"));
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe("/miniapp/");
    const slash = handleDashboardRequest(dashReq("/dashboard/"));
    expect(slash?.status).toBe(301);
  });

  test("non-GET on /dashboard is a 405, English-only", async () => {
    const res = handleDashboardRequest(dashReq("/dashboard", { method: "POST" }));
    expect(res?.status).toBe(405);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(hasFa(String(body["error"]))).toBe(false);
  });

  test("the old API namespace answers 410 Gone — token or not, no data", async () => {
    for (const path of [
      "/api/v1/dashboard",
      "/api/v1/dashboard/ping",
      "/api/v1/dashboard/providers",
      "/api/v1/dashboard/benchmarks/live/stream",
    ]) {
      const res = handleDashboardRequest(dashReq(path, { token: TOKEN }));
      expect(res?.status).toBe(410);
      const body = (await res!.json()) as Record<string, unknown>;
      expect(typeof body["error"]).toBe("string");
      expect(hasFa(String(body["error"]))).toBe(false);
      expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const post = handleDashboardRequest(
      dashReq("/api/v1/dashboard/schedulers/bench", { method: "POST", token: TOKEN, body: {} }),
    );
    expect(post?.status).toBe(410);
  });

  test("non-dashboard paths fall through (undefined)", () => {
    expect(handleDashboardRequest(dashReq("/miniapp/"))).toBeUndefined();
    expect(handleDashboardRequest(dashReq("/health"))).toBeUndefined();
    expect(handleDashboardRequest(dashReq("/api/v1/turn"))).toBeUndefined();
    expect(handleDashboardRequest(dashReq("/dashboards"))).toBeUndefined();
  });

  test("through the API server: redirect + 410, and /health is unaffected", async () => {
    const server = createApiServer(makeServerDeps(), { listen: false });
    const redir = await server.fetch(new Request("http://localhost/dashboard"));
    expect(redir.status).toBe(301);
    expect(redir.headers.get("location")).toBe("/miniapp/");
    const gone = await server.fetch(new Request("http://localhost/api/v1/dashboard/ping"));
    expect(gone.status).toBe(410);
    const health = await server.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
  });
});
