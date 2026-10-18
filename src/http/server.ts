/**
 * Phase E5: minimal HTTP API server (Bun.serve).
 *
 * Two endpoints:
 *   GET  /health      — unauthenticated liveness probe, { ok: true, version }.
 *   POST /api/v1/turn — Bearer-token endpoint that runs one ConversationEngine
 *                        turn and returns the reply as JSON.
 *
 * SECURITY MODEL (read this before changing anything):
 *
 *  1. Token is the ONLY authentication. The token is a shared secret read
 *     from BOBI_API_TOKEN. It must be long and random, and it is NEVER logged,
 *     returned in any response, or included in error messages.
 *  2. The turn endpoint runs as the OWNER actor, built server-side from the
 *     validated owner id (same pattern as the heartbeat's `actorForOwner` in
 *     src/index.ts). It never runs as an arbitrary requester identity, because
 *     the HTTP channel bypasses Telegram identity entirely: any userId /
 *     conversationId in the request body is data, never authority.
 *  3. Bind defaults to 127.0.0.1. Binding to 0.0.0.0 exposes the token-only
 *     endpoint to the network; only do that behind a trusted reverse proxy.
 *  4. Request size caps: the body is rejected above MAX_BODY_BYTES (64 KiB)
 *     and the `text` field above MAX_TEXT_CHARS (4000) — the agent loop must
 *     not be fed unbounded input.
 *  5. Simple per-IP rate limiting (default 30 req/min, in-memory) throttles
 *     token brute-forcing; the limiter runs BEFORE auth on the turn endpoint.
 *  6. Error messages are generic Persian strings that never leak internals
 *     (no stack traces, no config values, no reason the auth failed).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { APP_VERSION } from "../core/app";
import { handleDashboardRequest, isDashboardEnabled } from "./dashboard";
import type { ConversationEngine } from "../conversation/engine";
import type { ToolActor } from "../tools/types";
import type { Storage } from "../storage/storage";

/** Defaults read from the environment by the wiring in src/index.ts. */
export const DEFAULT_API_BIND = "127.0.0.1";
export const DEFAULT_API_PORT = 8472;

/** The request body is rejected above this size (before JSON parsing). */
export const MAX_BODY_BYTES = 64 * 1024;
/** A single turn's text is rejected above this length. */
export const MAX_TEXT_CHARS = 4000;
/** Identifiers in the body are rejected above this length. */
export const MAX_ID_CHARS = 128;
/** Per-IP rate limit window. */
export const RATE_LIMIT_PER_MINUTE = 30;

export interface ApiServerDeps {
  /** Database handle. Reserved for future endpoints; the current endpoints
   *  reach storage through the engine, so this is carried, not used. */
  storage: Storage;
  /**
   * Builds (or returns) the engine that runs a turn. Wired in src/index.ts to
   * reuse the already-built main engine; a factory (rather than the engine
   * itself) keeps the server testable and leaves room for per-conversation
   * engines later.
   */
  engineFactory: (opts: { conversationId: string }) => Pick<ConversationEngine, "respond">;
  /**
   * Server-side owner actor builder — the ONLY identity a turn runs as.
   * Same shape as the heartbeat's `actorForOwner`: derived from the validated
   * owner id, never from the request body.
   */
  actorForOwner: () => ToolActor;
  /** Shared secret for Bearer auth. Empty/whitespace means "not configured":
   *  the turn endpoint answers 503 while /health stays live. */
  token: string;
  /** Reported by /health; defaults to the app version. */
  version?: string;
  /** Per-IP request budget for the turn endpoint; default 30/min. */
  rateLimitPerMinute?: number;
  /** Sink for startup/bind logging; must never receive the token. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface CreateApiServerOptions {
  /** Set false to create the handler without binding a port (unit tests). */
  listen?: boolean;
  port?: number;
  host?: string;
}

export interface ApiServer {
  /** The request handler; also what Bun.serve calls when listening. */
  fetch: (req: Request) => Promise<Response> | Response;
  /** Close the listener; a no-op when created with listen: false. */
  stop: () => void;
  /** Whether a real socket was bound. */
  readonly listening: boolean;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

export function createApiServer(
  deps: ApiServerDeps,
  opts: CreateApiServerOptions = {},
): ApiServer {
  const token = deps.token.trim();
  const version = deps.version ?? APP_VERSION;
  const rateLimit = deps.rateLimitPerMinute ?? RATE_LIMIT_PER_MINUTE;
  const listen = opts.listen !== false;
  const host = opts.host ?? DEFAULT_API_BIND;
  const port = opts.port ?? DEFAULT_API_PORT;

  // Per-IP buckets. Memory-bounded: when the map grows past a few thousand
  // entries, expired buckets are swept before a new one is added.
  const buckets = new Map<string, RateBucket>();

  const fetch = (req: Request): Promise<Response> | Response => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/health" || path === "/health/") {
      return handleHealth(req, version);
    }
    if (path === "/api/v1/turn") {
      return handleTurn(req, { ip: clientIp(req) });
    }
    // Phase 3, item 3: owner-only web dashboard. Opt-in via BOBI_DASHBOARD=1;
    // the sub-router returns undefined for non-dashboard paths so the 404
    // below still answers everything else. No second listener: the dashboard
    // shares this server's socket, token, and rate-limit posture.
    if (isDashboardEnabled()) {
      const dashboardRes = handleDashboardRequest(req, {
        storage: deps.storage,
        token,
      });
      if (dashboardRes !== undefined) return dashboardRes;
    }
    // Unknown routes get a bare 404 with no hint about what does exist.
    return json(404, { error: "یافت نشد." });
  };

  if (!listen) {
    return { fetch, stop: () => undefined, listening: false };
  }

  // Bun.serve is synchronous; a bind failure throws here and the caller in
  // src/index.ts catches it, so the API can never take the bot down.
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (req, srv) => {
      const withIp = new Request(req);
      (withIp as Request & { __clientIp?: string }).__clientIp =
        srv.requestIP(withIp)?.address ?? "unknown";
      return fetch(withIp);
    },
  });
  deps.log?.("api server listening", { host, port: server.port });

  return {
    fetch,
    stop: () => server.stop(),
    listening: true,
  };

  /** Best-effort client address. Bun.serve stashes it on the request; in
   *  listen:false mode (tests) it is always "unknown" — still a single
   *  consistent bucket for the rate-limit test. */
  function clientIp(req: Request): string {
    return (req as Request & { __clientIp?: string }).__clientIp ?? "unknown";
  }

  function handleHealth(req: Request, ver: string): Response {
    // /health is intentionally unauthenticated: it answers only "alive", the
    // same minimal promise as the platform health probe in src/core/health.ts.
    if (req.method !== "GET") {
      return json(405, { error: "روش مجاز نیست." });
    }
    return json(200, { ok: true, version: ver });
  }

  async function handleTurn(
    req: Request,
    ctx: { ip: string },
  ): Promise<Response> {
    if (req.method !== "POST") {
      return json(405, { error: "روش مجاز نیست." });
    }

    // Rate limit BEFORE auth: a 429 is returned without ever touching the
    // token, which throttles brute-forcing as well as accidental floods.
    if (!takeRateLimit(ctx.ip)) {
      return json(429, { error: "تعداد درخواست‌ها بیش از حد مجاز است. کمی صبر کنید." });
    }

    if (token === "") {
      // Missing token config is an operator problem, not a client one: 503
      // says "this endpoint is not available", never why.
      return json(503, { error: "سرویس API در دسترس نیست." });
    }

    // Constant-time comparison so the failure timing does not leak how close
    // a guessed token is. Both sides are hashed first so unequal lengths do
    // not throw. Missing and wrong tokens are indistinguishable (one generic
    // 401, no user enumeration possible — there is no user here anyway).
    const presented = bearerToken(req);
    if (presented === undefined || !safeEqual(presented, token)) {
      return json(401, { error: "احراز هویت نامعتبر است." });
    }

    const raw = await readCappedBody(req);
    if (raw === undefined) {
      return json(413, { error: "بدنه درخواست بیش از حد بزرگ است." });
    }
    const parsed = parseTurnBody(raw);
    if (!parsed.ok) {
      return json(400, { error: parsed.error });
    }

    // SECURITY: the turn runs as the OWNER actor built server-side. The
    // userId/conversationId in the body select state, never authority — the
    // HTTP channel bypasses Telegram identity, so promoting the body to an
    // actor would let any token holder act as any user.
    try {
      const engine = deps.engineFactory({ conversationId: parsed.body.conversationId });
      const out = await engine.respond({
        conversationId: parsed.body.conversationId,
        userId: parsed.body.userId,
        userText: parsed.body.text,
        actor: deps.actorForOwner(),
      });
      return json(200, { reply: out.chunks.join("\n\n") });
    } catch {
      // Never leak the provider error or stack to the API caller.
      return json(500, { error: "خطای داخلی رخ داد." });
    }
  }

  /** Token-bucket: true when the request may proceed. */
  function takeRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const bucket = buckets.get(ip);
    if (bucket === undefined || now >= bucket.resetAt) {
      if (buckets.size > 4096) {
        for (const [key, b] of buckets) {
          if (now >= b.resetAt) buckets.delete(key);
        }
      }
      buckets.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= rateLimit) return false;
    bucket.count += 1;
    return true;
  }
}

interface TurnBody {
  userId: string;
  conversationId: string;
  text: string;
}

type ParseResult = { ok: true; body: TurnBody } | { ok: false; error: string };

function parseTurnBody(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "بدنه درخواست JSON معتبر نیست." };
  }
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "بدنه درخواست نامعتبر است." };
  }
  const v = value as Record<string, unknown>;
  const userId = asBoundedString(v["userId"]);
  const conversationId = asBoundedString(v["conversationId"]);
  const text = asBoundedString(v["text"], MAX_TEXT_CHARS);
  if (userId === undefined || userId.trim() === "") {
    return { ok: false, error: "فیلد userId الزامی است." };
  }
  if (conversationId === undefined || conversationId.trim() === "") {
    return { ok: false, error: "فیلد conversationId الزامی است." };
  }
  if (text === undefined || text.trim() === "") {
    return { ok: false, error: "فیلد text الزامی است." };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return { ok: false, error: `متن پیام نباید بیشتر از ${MAX_TEXT_CHARS} کاراکتر باشد.` };
  }
  return { ok: true, body: { userId, conversationId, text } };
}

/** A string field, bounded in length; undefined when not a string. */
function asBoundedString(value: unknown, max = MAX_ID_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= max ? value : undefined;
}

/** Reads the body but gives up above MAX_BODY_BYTES to bound allocation. */
async function readCappedBody(req: Request): Promise<string | undefined> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isSafeInteger(n) && n > MAX_BODY_BYTES) return undefined;
  }
  const raw = await req.text();
  return raw.length <= MAX_BODY_BYTES ? raw : undefined;
}

/** Extracts the token from `Authorization: Bearer <token>`. */
function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (header === null) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/.exec(header);
  return m?.[1];
}

/**
 * Constant-time string comparison. Hashing both sides first keeps
 * timingSafeEqual happy with unequal input lengths and avoids leaking how
 * many characters of a guessed token are correct.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
