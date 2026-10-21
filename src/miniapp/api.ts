/**
 * Mini App request router.
 *
 * Mounted inside the main HTTP server: `createMiniAppHandler(deps)` returns a
 * handler that answers only /miniapp/* paths and returns `undefined` for
 * everything else, so the main server's 404 still works.
 *
 *   GET  /miniapp/                → the frontend entry (webDir/index.html)
 *   GET  /miniapp/static/<file>   → static asset from webDir (no traversal)
 *   POST /miniapp/api/turn        → one ConversationEngine turn as the owner
 *   POST /miniapp/api/<providers.*|models.*> → provider & model management
 *
 * Every /miniapp/api/* request carries initData (JSON body field, or the
 * X-Telegram-Init-Data header) and is validated against the server-side owner
 * id. Rate limiting runs BEFORE auth, mirroring src/http/server.ts.
 *
 * Error bodies are always `{ error: "<fa string>" }` — Persian is the ground
 * truth; the frontend carries the English mirror. Nothing about which check
 * failed is ever leaked.
 */
import { join, resolve, extname } from "node:path";
import { validateInitData } from "./auth";
import {
  handleProviderApi,
  ProviderApiError,
  type ProviderApiDeps,
} from "./api_providers";
import {
  handleManageApi,
  type BenchLiveSource,
  type DeskControl,
  type SemanticIndexSource,
} from "./api_manage";
import { handleProfileApi } from "./api_profile";

/** The request body is rejected above this size (before JSON parsing). */
export const MAX_BODY_BYTES = 64 * 1024;
/** A single turn's text is rejected above this length. */
export const MAX_TEXT_CHARS = 4000;
/** Identifiers in the body are rejected above this length. */
export const MAX_ID_CHARS = 128;
/** Per-IP rate limit window budget. */
export const RATE_LIMIT_PER_MINUTE = 30;

/** Header that may carry initData when the body cannot (body preferred). */
export const INIT_DATA_HEADER = "x-telegram-init-data";

export interface MiniAppDeps extends ProviderApiDeps {
  /**
   * Builds (or returns) the engine that runs a turn. Same contract as the
   * main API server's engineFactory.
   */
  engineFactory: (opts: { conversationId: string }) => {
    respond: (a: any) => Promise<{ chunks: string[] }>;
  };
  /**
   * Server-side owner actor builder — the ONLY identity a turn runs as.
   * Same pattern as the main server: built from the validated owner id,
   * never from the request body.
   */
  actorForOwner: () => unknown;
  /** Server-side owner Telegram id. */
  ownerId: string;
  /** Live bench-worker progress for the manage API's `bench.live` action. */
  benchWorker?: BenchLiveSource;
  /** The owner's tool-desk control for `desk.list` / `desk.toggle`. */
  desk?: DeskControl;
  /** Semantic memory index for the manage API's memory `embedding` field. */
  semantic?: SemanticIndexSource;
  /** Server-side bot token, for initData HMAC. Never logged or returned. */
  botToken: string;
  /** Absolute directory of the frontend static files. */
  webDir: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createMiniAppHandler(
  deps: MiniAppDeps,
): (req: Request) => Promise<Response> | undefined {
  const root = resolve(deps.webDir);
  const rateLimit = RATE_LIMIT_PER_MINUTE;

  // Per-IP buckets. Memory-bounded: expired buckets are swept when the map
  // grows past a few thousand entries.
  const buckets = new Map<string, RateBucket>();

  return (req: Request): Promise<Response> | undefined => {
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return undefined;
    }
    if (pathname !== "/miniapp" && !pathname.startsWith("/miniapp/")) {
      return undefined;
    }
    return route(req, pathname);
  };

  async function route(req: Request, pathname: string): Promise<Response> {
    // --- static files ---
    if (pathname === "/miniapp" || pathname === "/miniapp/") {
      if (req.method !== "GET") return json(405, { error: "روش مجاز نیست." });
      return serveFile(join(root, "index.html"));
    }
    if (pathname.startsWith("/miniapp/static/")) {
      if (req.method !== "GET") return json(405, { error: "روش مجاز نیست." });
      const rel = pathname.slice("/miniapp/static/".length);
      return serveFile(secureJoin(join(root, "static"), rel));
    }
    // The frontend (index.html) references its assets with page-relative URLs
    // (styles.css, app.js, sections/*.js), which resolve to /miniapp/<file>.
    // Serve those from the web root too. /miniapp/api/* is handled below and
    // never reaches here. Static files carry no secrets; the JSON API layer
    // enforces initData + owner auth on every call.
    if (pathname.startsWith("/miniapp/") && !pathname.startsWith("/miniapp/api/")) {
      if (req.method !== "GET") return json(405, { error: "روش مجاز نیست." });
      const rel = pathname.slice("/miniapp/".length);
      if (rel === "" || rel.endsWith("/")) return json(404, { error: "یافت نشد." });
      return serveFile(secureJoin(root, rel));
    }
    // --- JSON API ---
    if (pathname.startsWith("/miniapp/api/")) {
      return handleApi(req, pathname.slice("/miniapp/api/".length));
    }
    // Unknown /miniapp/* path: a bare 404, same as the main server's.
    return json(404, { error: "یافت نشد." });
  }

  async function handleApi(req: Request, action: string): Promise<Response> {
    if (req.method !== "POST") {
      return json(405, { error: "روش مجاز نیست." });
    }
    if (action === "" || action.includes("/")) {
      return json(404, { error: "درخواست نامعتبر است." });
    }

    // Rate limit BEFORE auth, like the main server: a 429 is returned without
    // ever touching initData.
    if (!takeRateLimit(clientIp(req))) {
      return json(429, { error: "تعداد درخواست‌ها بیش از حد مجاز است. کمی صبر کنید." });
    }

    const raw = await readCappedBody(req);
    if (raw === undefined) {
      return json(413, { error: "بدنه درخواست بیش از حد بزرگ است." });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "بدنه درخواست JSON معتبر نیست." });
    }
    if (typeof body !== "object" || body === null) {
      return json(400, { error: "بدنه درخواست نامعتبر است." });
    }
    const params = body as Record<string, unknown>;

    // initData: body field preferred, header accepted.
    const initData =
      typeof params["initData"] === "string"
        ? params["initData"]
        : (req.headers.get(INIT_DATA_HEADER) ?? "");

    // One generic 401 for every failure; the reason stays server-side.
    const auth = validateInitData(initData, deps.botToken, deps.ownerId);
    if (!auth.ok) {
      deps.log?.("miniapp auth failed", { reason: auth.reason });
      return json(401, { error: "احراز هویت نامعتبر است." });
    }

    try {
      if (action === "turn") {
        return json(200, await handleTurn(params));
      }
      if (action.startsWith("providers.") || action.startsWith("models.")) {
        return json(200, await handleProviderApi(action, params, deps));
      }
      // Owner-profile APIs (profile.get / profile.save). Checked BEFORE the
      // management sub-router because that one answers 404 for every action
      // it does not know instead of falling through. The sub-router
      // re-validates initData itself (defense in depth) and returns
      // undefined only for non-profile actions.
      const profileRes = await handleProfileApi(`/miniapp/api/${action}`, params, deps);
      if (profileRes !== undefined) return profileRes;
      // Management APIs (users, memory, benchmarks, schedulers, skills,
      // usage, tasks, groups). The sub-router re-validates initData itself
      // (defense in depth); it returns undefined only for unknown actions.
      const manageRes = await handleManageApi(`/miniapp/api/${action}`, params, deps);
      if (manageRes !== undefined) return manageRes;
      return json(404, { error: "درخواست نامعتبر است." });
    } catch (err) {
      if (err instanceof ProviderApiError) {
        return json(err.status, { error: err.message });
      }
      // Never leak internals (provider errors, stacks) to the caller.
      deps.log?.("miniapp api error", { action });
      return json(500, { error: "خطای داخلی رخ داد." });
    }
  }

  /**
   * The full-access primitive: one ConversationEngine turn as the OWNER
   * actor built server-side. Mirrors the main server's handleTurn exactly —
   * conversationId/text in the body select state, never authority.
   */
  async function handleTurn(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const rawConversationId = asBoundedString(params["conversationId"]);
    const conversationId =
      rawConversationId !== undefined && rawConversationId.trim() !== ""
        ? rawConversationId
        : "miniapp";
    const text = asBoundedString(params["text"], MAX_TEXT_CHARS);
    if (text === undefined || text.trim() === "") {
      throw new ProviderApiError(400, "فیلد text الزامی است.");
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw new ProviderApiError(400, `متن پیام نباید بیشتر از ${MAX_TEXT_CHARS} کاراکتر باشد.`);
    }

    try {
      const engine = deps.engineFactory({ conversationId });
      const out = await engine.respond({
        conversationId,
        userId: deps.ownerId,
        userText: text,
        actor: deps.actorForOwner(),
      });
      return { reply: out.chunks.join("\n\n") };
    } catch {
      // Never leak the provider error or stack to the caller.
      throw new ProviderApiError(500, "خطای داخلی رخ داد.");
    }
  }

  /**
   * Serve one file from the web root. Returns undefined (via the caller's
   * 404) when the path escapes the root, names a directory, or is missing.
   */
  async function serveFile(resolved: string | undefined): Promise<Response> {
    if (resolved === undefined) return json(404, { error: "یافت نشد." });
    try {
      const file = Bun.file(resolved);
      if (!(await file.exists())) return json(404, { error: "یافت نشد." });
      const type = STATIC_CONTENT_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
      return new Response(file, {
        status: 200,
        headers: {
          "content-type": type,
          "cache-control": "no-store",
        },
      });
    } catch {
      return json(404, { error: "یافت نشد." });
    }
  }

  /** Join a request path under the root, refusing path traversal. */
  function secureJoin(rootDir: string, rel: string): string | undefined {
    if (rel === "" || rel.includes("\0")) return undefined;
    const resolved = resolve(join(rootDir, rel));
    if (resolved !== rootDir && !resolved.startsWith(rootDir + "/")) {
      return undefined;
    }
    return resolved;
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

/** The caller's IP, as far as the transport layer knows. */
function clientIp(req: Request): string {
  const injected = (req as Request & { __clientIp?: unknown }).__clientIp;
  if (typeof injected === "string" && injected !== "") return injected;
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : "unknown";
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

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
