/**
 * Worker H audit (v1.0) — HTTP server & dashboard backend regressions.
 *
 * Covers the fixes from the audit pass:
 *  - server.ts: case-insensitive Bearer scheme (RFC 6750), /health uptimeMs,
 *    English-only JSON errors, x-content-type-options: nosniff on JSON.
 *  - dashboard.ts: re-enabling a bench schedule without a cadence keeps its
 *    cron (was a 400), English-only API errors, CSP on the HTML shells.
 *  - dashboard_pages.ts: the SPA and login shell are English-only
 *    (no Persian strings, lang="en", no language toggle).
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
import {
  handleDashboardRequest,
  resetDashboardRateLimitsForTests,
  type DashboardDeps,
} from "../src/http/dashboard";
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

function dashDeps(storage: Storage): DashboardDeps {
  return { storage, token: TOKEN };
}

async function dashJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

let savedOwnerId: string | undefined;

beforeEach(() => {
  savedOwnerId = process.env.OWNER_TELEGRAM_ID;
  process.env.OWNER_TELEGRAM_ID = OWNER_ID;
  resetDashboardRateLimitsForTests();
});

afterEach(() => {
  if (savedOwnerId === undefined) delete process.env.OWNER_TELEGRAM_ID;
  else process.env.OWNER_TELEGRAM_ID = savedOwnerId;
  resetDashboardRateLimitsForTests();
});

describe("http audit: dashboard.ts", () => {
  test("re-enabling a bench schedule without cadence keeps its cron", async () => {
    const storage = Storage.open(":memory:");
    const deps = dashDeps(storage);
    const auth = { token: TOKEN };

    // Create: weekly bench schedule.
    const created = await handleDashboardRequest(
      dashReq("/api/v1/dashboard/schedulers/bench", {
        method: "POST",
        ...auth,
        body: { enabled: true, cadence: "weekly" },
      }),
      deps,
    );
    expect(created!.status).toBe(200);

    const schedulersOf = async (): Promise<Array<Record<string, unknown>>> => {
      const r = await handleDashboardRequest(
        dashReq("/api/v1/dashboard/schedulers", auth),
        deps,
      );
      return ((await dashJson(r!))["schedulers"] as Array<Record<string, unknown>>);
    };
    const benchOf = async (): Promise<Record<string, unknown>> =>
      (await schedulersOf()).find((s) => s["key"] === "bench")!;

    expect((await benchOf())["cron"]).toBe("0 3 * * 0");

    // Disable it.
    const disabled = await handleDashboardRequest(
      dashReq("/api/v1/dashboard/schedulers/bench", {
        method: "POST",
        ...auth,
        body: { enabled: false },
      }),
      deps,
    );
    expect(disabled!.status).toBe(200);
    expect((await benchOf())["enabled"]).toBe(false);

    // Re-enable WITHOUT cadence/cron: must succeed (was a 400) and keep the cron.
    const reenabled = await handleDashboardRequest(
      dashReq("/api/v1/dashboard/schedulers/bench", {
        method: "POST",
        ...auth,
        body: { enabled: true },
      }),
      deps,
    );
    expect(reenabled!.status).toBe(200);
    const bench = await benchOf();
    expect(bench["enabled"]).toBe(true);
    expect(bench["cron"]).toBe("0 3 * * 0");
    expect(bench["cadence"]).toBe("weekly");
    storage.close();
  });

  test("dashboard API errors are English-only", async () => {
    const storage = Storage.open(":memory:");
    const deps = dashDeps(storage);
    const auth = { token: TOKEN };

    const unauth = await handleDashboardRequest(
      dashReq("/api/v1/dashboard/ping"),
      deps,
    );
    expect(unauth!.status).toBe(401);
    expect((await dashJson(unauth!))["error"]).toBe("Invalid credentials.");

    const unknown = await handleDashboardRequest(
      dashReq("/api/v1/dashboard/nope", auth),
      deps,
    );
    expect(unknown!.status).toBe(404);
    expect((await dashJson(unknown!))["error"]).toBe("Not found.");

    const badInput = await handleDashboardRequest(
      dashReq("/api/v1/dashboard/schedulers/bench", {
        method: "POST",
        ...auth,
        body: { enabled: "yes" },
      }),
      deps,
    );
    expect(badInput!.status).toBe(400);
    const badBody = (await dashJson(badInput!))["error"] as string;
    expect(badBody).toBe("Invalid input.");
    expect(hasFa(badBody)).toBe(false);

    const badCron = await handleDashboardRequest(
      dashReq("/api/v1/dashboard/schedulers/bench", {
        method: "POST",
        ...auth,
        body: { enabled: true, cadence: "yearly" },
      }),
      deps,
    );
    expect(badCron!.status).toBe(400);
    expect((await dashJson(badCron!))["error"]).toBe("Invalid cadence.");

    // Non-POST on the page path is still a clean 405.
    const pagePost = await handleDashboardRequest(
      dashReq("/dashboard", { method: "POST", ...auth }),
      deps,
    );
    expect(pagePost!.status).toBe(405);
    storage.close();
  });

  test("HTML shells carry CSP and nosniff headers", async () => {
    const storage = Storage.open(":memory:");
    const deps = dashDeps(storage);

    const login = await handleDashboardRequest(dashReq("/dashboard"), deps);
    expect(login!.status).toBe(200);
    const csp = login!.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'deny'");
    expect(csp).toContain("object-src 'none'");
    expect(login!.headers.get("x-content-type-options")).toBe("nosniff");

    const app = await handleDashboardRequest(
      dashReq("/dashboard", { token: TOKEN }),
      deps,
    );
    expect(app!.status).toBe(200);
    expect(app!.headers.get("content-security-policy")).toContain("frame-ancestors 'deny'");
    storage.close();
  });
});

// --------------------------------------------------- dashboard_pages.ts ----

describe("http audit: dashboard_pages.ts", () => {
  test("login shell is English-only with zero Persian strings", async () => {
    const storage = Storage.open(":memory:");
    const res = await handleDashboardRequest(dashReq("/dashboard"), dashDeps(storage));
    const page = await res!.text();
    expect(page).toContain('lang="en"');
    expect(page).not.toContain('lang="fa"');
    expect(page).toContain("Sign in");
    expect(hasFa(page)).toBe(false);
    // Still the credential-entry shell, not data.
    expect(page).toContain("bobi_dash_token");
    expect(page).not.toContain("/api/v1/dashboard/providers");
    storage.close();
  });

  test("app shell is English-only and has no language toggle", async () => {
    const storage = Storage.open(":memory:");
    const res = await handleDashboardRequest(
      dashReq("/dashboard", { token: TOKEN }),
      dashDeps(storage),
    );
    const page = await res!.text();
    expect(page).toContain('lang="en"');
    expect(hasFa(page)).toBe(false);
    expect(page).toContain("Schedulers");
    // The fa/en toggle is gone in the English-only UI.
    expect(page).not.toContain('data-action="lang"');
    expect(page).not.toContain("bobi_dash_lang");
    // The embedded SPA script still parses (regression: the STR surgery).
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(() => new Function(script as string)).not.toThrow();
    }
    storage.close();
  });
});
