/**
 * Phase E5: minimal HTTP API server.
 *
 * Covers the contract: unauthenticated /health, token-gated /api/v1/turn,
 * Persian validation errors, request size caps, and per-IP rate limiting.
 * Everything runs through the fetch handler with listen:false, so no socket
 * is ever bound in the test suite.
 */
import { describe, expect, test } from "bun:test";
import {
  createApiServer,
  MAX_TEXT_CHARS,
  type ApiServerDeps,
} from "../src/http/server";
import { ConversationEngine, type ConversationInput } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import type { ToolActor } from "../src/tools/types";

const TOKEN = "test-token-that-is-long-and-random-enough-0123456789";

function makeDeps(overrides: Partial<ApiServerDeps> = {}): {
  deps: ApiServerDeps;
  captured: { input?: ConversationInput };
  ownerActor: ToolActor;
} {
  const captured: { input?: ConversationInput } = {};
  // The server-side owner actor: the sentinel userId lets the test prove the
  // turn ran as the owner actor, not as an identity from the request body.
  const ownerActor: ToolActor = { userId: "owner-sentinel", permissions: ["*"] };
  const engine = new ConversationEngine({
    provider: new FakeProvider(),
    model: "fake-echo",
    timeoutMs: 5_000,
    maxConcurrent: 4,
  });
  const deps: ApiServerDeps = {
    storage: {} as ApiServerDeps["storage"],
    engineFactory: () => ({
      respond: (input: ConversationInput) => {
        captured.input = input;
        return engine.respond(input);
      },
    }),
    actorForOwner: () => ownerActor,
    token: TOKEN,
    ...overrides,
  };
  return { deps, captured, ownerActor };
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

const validBody = { userId: "42", conversationId: "c1", text: "سلام" };
const auth = (token = TOKEN): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

describe("http api server (listen:false)", () => {
  test("GET /health is unauthenticated and reports ok + version", async () => {
    const { deps } = makeDeps();
    const server = createApiServer(deps, { listen: false });
    expect(server.listening).toBe(false);
    // No Authorization header at all: health must still answer.
    const res = await server.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(typeof body["version"]).toBe("string");
  });

  test("non-GET /health is rejected", async () => {
    const { deps } = makeDeps();
    const server = createApiServer(deps, { listen: false });
    const res = await server.fetch(
      new Request("http://localhost/health", { method: "POST" }),
    );
    expect(res.status).toBe(405);
  });

  test("turn endpoint without a configured token answers 503 (Persian)", async () => {
    const { deps } = makeDeps({ token: "" });
    const server = createApiServer(deps, { listen: false });
    const res = await server.fetch(postTurn(validBody, auth()));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
    expect((body["error"] as string).length).toBeGreaterThan(0);
  });

  test("wrong token and missing header both answer 401 (no enumeration)", async () => {
    const { deps } = makeDeps();
    const server = createApiServer(deps, { listen: false });

    const wrong = await server.fetch(postTurn(validBody, auth("wrong-token")));
    expect(wrong.status).toBe(401);
    const wrongBody = (await wrong.json()) as Record<string, unknown>;

    const missing = await server.fetch(postTurn(validBody));
    expect(missing.status).toBe(401);
    const missingBody = (await missing.json()) as Record<string, unknown>;

    // Same message either way: the caller cannot tell the cases apart.
    expect(wrongBody["error"]).toBe(missingBody["error"]);
  });

  test("correct token runs a turn via FakeProvider and returns the reply", async () => {
    const { deps, captured, ownerActor } = makeDeps();
    const server = createApiServer(deps, { listen: false });
    const res = await server.fetch(postTurn(validBody, auth()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["reply"]).toBe("string");
    expect(body["reply"] as string).toContain("BOBI test mode");
  });

  test("turn runs as the server-side owner actor, never the requester", async () => {
    const { deps, captured, ownerActor } = makeDeps();
    const server = createApiServer(deps, { listen: false });
    // An attacker-controlled userId in the body: it selects state, not authority.
    const res = await server.fetch(
      postTurn({ userId: "attacker-id", conversationId: "c9", text: "سلام" }, auth()),
    );
    expect(res.status).toBe(200);
    expect(captured.input).toBeDefined();
    expect(captured.input!.actor).toBe(ownerActor);
    expect(captured.input!.userId).toBe("attacker-id");
  });

  test("oversized text is rejected with 400", async () => {
    const { deps } = makeDeps();
    const server = createApiServer(deps, { listen: false });
    const res = await server.fetch(
      postTurn({ ...validBody, text: "x".repeat(MAX_TEXT_CHARS + 1) }, auth()),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });

  test("invalid JSON and missing fields are rejected with 400", async () => {
    const { deps } = makeDeps();
    const server = createApiServer(deps, { listen: false });

    const badJson = await server.fetch(postTurn("{not json", auth()));
    expect(badJson.status).toBe(400);

    const missingText = await server.fetch(
      postTurn({ userId: "1", conversationId: "c1" }, auth()),
    );
    expect(missingText.status).toBe(400);

    const emptyText = await server.fetch(
      postTurn({ userId: "1", conversationId: "c1", text: "   " }, auth()),
    );
    expect(emptyText.status).toBe(400);
  });

  test("unknown routes answer 404", async () => {
    const { deps } = makeDeps();
    const server = createApiServer(deps, { listen: false });
    const res = await server.fetch(
      new Request("http://localhost/nope", { headers: auth() }),
    );
    expect(res.status).toBe(404);
  });

  test("per-IP rate limit trips with 429 after the budget is spent", async () => {
    const { deps } = makeDeps({ rateLimitPerMinute: 2 });
    const server = createApiServer(deps, { listen: false });

    const first = await server.fetch(postTurn(validBody, auth()));
    expect(first.status).toBe(200);
    const second = await server.fetch(postTurn(validBody, auth()));
    expect(second.status).toBe(200);
    const third = await server.fetch(postTurn(validBody, auth()));
    expect(third.status).toBe(429);
    const body = (await third.json()) as Record<string, unknown>;
    expect(typeof body["error"]).toBe("string");
  });

  test("GET on the turn endpoint is rejected with 405", async () => {
    const { deps } = makeDeps();
    const server = createApiServer(deps, { listen: false });
    const res = await server.fetch(
      new Request("http://localhost/api/v1/turn", { headers: auth() }),
    );
    expect(res.status).toBe(405);
  });
});
