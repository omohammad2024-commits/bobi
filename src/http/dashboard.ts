/**
 * Phase 3, item 3 — owner-only web dashboard.
 *
 * Served by the EXISTING HTTP server (src/http/server.ts): this module only
 * exports `isDashboardEnabled()` and `handleDashboardRequest()`, which the
 * server calls before its own 404. No second listener is ever started.
 *
 * Routes (all JSON unless noted; all behind Bearer auth except the login
 * shell — see below):
 *
 *   GET  /dashboard                              login shell (no token) or SPA shell (token)
 *   GET  /api/v1/dashboard/ping                  auth probe, { ok: true }
 *   GET  /api/v1/dashboard/providers             providers + models + runtime selection
 *   POST /api/v1/dashboard/providers/enable      { id, enabled }
 *   POST /api/v1/dashboard/providers/activate    { id } — activates provider + its default model
 *   POST /api/v1/dashboard/models/enable         { id, enabled }
 *   POST /api/v1/dashboard/models/activate       { id }
 *   GET  /api/v1/dashboard/memory?q=&limit=       owner's long-term memories, READ-ONLY
 *   GET  /api/v1/dashboard/users                 users grouped by state + counts
 *   POST /api/v1/dashboard/users/restrict        { action: ban|unban|mute|unmute, userId }
 *   GET  /api/v1/dashboard/benchmarks            bench run summaries from bench/results/
 *   GET  /api/v1/dashboard/benchmarks/report?name=  the Persian .md report of one run
 *   GET  /api/v1/dashboard/benchmarks/trends?mode=&model=&task=&n=
 *     score-trend data (aggregate + per-task) from bench_runs/bench_run_scores
 *   GET  /api/v1/dashboard/schedulers            bench + morning-digest scheduler state
 *   POST /api/v1/dashboard/schedulers/bench      { enabled, cadence, cron?, mode? } — whitelist + validated custom crons
 *   POST /api/v1/dashboard/schedulers/digest     { enabled, time?, cron? } — HH:MM Tehran or validated custom cron
 *   GET  /api/v1/dashboard/digest/config         morning-digest prompt/destination view (blueprint ownership surfaced)
 *   POST /api/v1/dashboard/digest/prompt         { prompt } — edit the digest prompt through the scheduler store
 *   POST /api/v1/dashboard/digest/prompt/reset   restore the /blueprint default prompt
 *   POST /api/v1/dashboard/digest/destination     { chatId } — edit the digest delivery chat
 *   GET  /api/v1/dashboard/group-digests         groups with assistant configs + their digest task state
 *   POST /api/v1/dashboard/group-digests/set     { chatId, digestEnabled, time? } — on/off/time for a group's digest
 *
 * SECURITY MODEL (read docs/DASHBOARD.md for the full attack-surface review):
 *
 *  1. Token is the ONLY authentication, same shared secret as the API server
 *     (BOBI_API_TOKEN), compared in constant time. Every route — including
 *     the HTML shells — requires it, EXCEPT the bare login shell: a browser
 *     navigation cannot carry an Authorization header, so the credential-
 *     entry screen must be reachable without one. That shell carries zero
 *     owner data (no names, no counts, no lists).
 *  2. Owner-only by construction: there is no public surface at all, and the
 *     whole dashboard is off unless BOBI_DASHBOARD=1 (default off).
 *  3. Memory is read-only here; mutations stay in Telegram behind curator
 *     approval. Provider keys NEVER enter the browser: adding a provider or
 *     entering a key is Telegram-/ai-only; the dashboard only toggles
 *     enable/active flags and surfaces hasCredential booleans.
 *  4. No token in URLs, ever: the token travels in the Authorization header
 *     (the login shell keeps it in sessionStorage, never localStorage, and
 *     the app drops it on any 401). State-changing endpoints require POST
 *     with a JSON content-type (415 otherwise).
 *  5. Per-IP rate limiting (30/min, same budget as the API server) runs
 *     BEFORE auth, throttling token brute-forcing.
 *  6. Bench report serving is allowlisted: `name` must match a strict regex
 *     AND exist in the live directory listing; the resolved path is verified
 *     to stay under bench/results (no path traversal).
 *  7. All rendering of owner data happens client-side through escapeHtml /
 *     renderSafeMarkdown / buildLineChartSvg (src/http/dashboard_render.ts)
 *     — the server never interpolates owner data into HTML.
 *  8. Error messages are generic English strings; they never leak config,
 *     stack traces, or why auth failed.
 *  9. Scheduler mutations (phase 4) validate every value server-side: the
 *     bench cadence must be one of three whitelisted presets (custom crons —
 *     phase 5 — pass parseCron plus a minimum-interval floor: bench ≥ 1h,
 *     digest ≥ 15min), the digest time must match HH:MM, and the mode must
 *     be offline|live. Every change is written to the audit log
 *     (storage.appendAudit, best-effort). Trend data carries scores only —
 *     never prompts or raw model output.
 *  10. Digest prompt/destination edits (phase 5) write through
 *     storage.updateTask — the same store /blueprint's schedule_task tool
 *     writes — and never accept a prompt longer than the scheduler's own
 *     agent-prompt ceiling (validated with parseTaskAction). The dashboard
 *     surfaces that the row is owned by /blueprint; it edits the content,
 *     never the ownership. Prompt text is never audit-logged (only its
 *     length), and the row's name/cron/action type are never writable from
 *     these endpoints. Group-digest endpoints reuse the phase-4
 *     group_digest row helpers (ensure/cancel) over the same
 *     storage-scoped calls, with the same ordering guarantees as the
 *     /gassistant digest Telegram handler.
 *
 * Wiring note: src/index.ts is intentionally untouched, so this module reads
 * the three env vars it needs directly (mirroring src/config/config.ts):
 * BOBI_DASHBOARD (enable flag), OWNER_TELEGRAM_ID (memory scope + self-ban
 * guard), AI_KEY_MASTER_KEY (secret store for ProviderService). Services are
 * built lazily per Storage and cached in a WeakMap.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Storage, UserAccessRecord, ScheduledTaskRecord } from "../storage/storage";
import { BenchHistory } from "../bench/history";
import type { BenchLiveEvent, WorkerSnapshot } from "../bench/worker";
import { nextAfterSchedule, parseCron } from "../scheduler/cron";
import { parseTaskAction, serializeTaskAction } from "../tools/scheduled_tasks";
import {
  GROUP_DIGEST_TOOL_NAME,
  cancelGroupDigestTask,
  digestTaskName,
  ensureGroupDigestTask,
  validateDigestTime,
  type DigestTaskCalls,
} from "../groups/group_digest";
import {
  assistantConfigKey,
  getAssistantConfig,
  setAssistantConfig,
} from "../groups/assistant";
import { ProviderSecretStore } from "../ai/secret_store";
import { AdapterRegistry } from "../ai/adapter_registry";
import { ModelService, ProviderService } from "../ai/provider_service";
import { UserAccessService } from "../auth/user_service";
import { resolveMemoryProvider } from "../memory/factory";
import type { MemoryProvider } from "../memory/provider";
import {
  MemoryVectorStore,
  ProviderEmbedder,
  SemanticMemorySearch,
} from "../memory";
import type { MemoryIndexState } from "../memory";
import { renderAppPage, renderLoginPage } from "./dashboard_pages";

export interface DashboardDeps {
  storage: Storage;
  /** Trimmed BOBI_API_TOKEN, carried over from the API server deps. */
  token: string;
  /**
   * Ready BenchHistory, for tests. When absent the dashboard opens its own
   * second connection to the SQLite file (same pattern as src/index.ts) —
   * see benchHistoryFor().
   */
  benchHistory?: BenchHistory;
  /**
   * Ready SemanticMemorySearch, for tests. When absent the dashboard builds
   * one over the same SQLite file (read-only use: indexState only).
   */
  semantic?: SemanticMemorySearch;
  /**
   * Phase-5: daemon BenchWorker progress surface for the live stream
   * (`/api/v1/dashboard/benchmarks/live/stream`). Wired by the coordinator
   * (src/index.ts); tests pass a stub. Absent = the stream answers 503.
   */
  benchWorker?: BenchWorkerProgress;
}

/**
 * Phase-5: minimal live-progress surface of the daemon BenchWorker
 * (`src/bench/worker.ts`), typed structurally — the coordinator passes the
 * real worker, tests pass a stub. Mirrors the fields the SSE stream needs.
 */
export interface BenchWorkerProgress {
  snapshot(): WorkerSnapshot;
  subscribeProgress(cb: (ev: BenchLiveEvent) => void): () => void;
}

/** Enable flag. Default off; "1"/"true"/"yes"/"on" (case-insensitive) turn it on. */
export function isDashboardEnabled(): boolean {
  const raw = (process.env.BOBI_DASHBOARD ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

const PAGE_PATHS = new Set(["/dashboard", "/dashboard/"]);
const API_PREFIX = "/api/v1/dashboard";

/** Same budgets as the API server (mirrored, not imported — no import cycle). */
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

const MAX_MEMORY_LIMIT = 200;
const MAX_QUERY_CHARS = 128;
const USER_LIST_CAP = 100;

// ------------------------------------------------------- phase 4: trends +
// schedulers ---------------------------------------------------------------
// The two schedulers the dashboard manages. The task NAMES mirror the
// Telegram surfaces that create them — the single source of truth for the
// names lives there; these constants are matched, never renamed:
//   - bench:  BENCH_SCHEDULE_TASK_NAME in src/bot/cmd_phase3_bench.ts
//             ("/bench schedule <cron|off>")
//   - digest: "blueprint: morning_digest" in src/bot/cmd_auto.ts
//             ("/blueprint run morning_digest")
const BENCH_TASK_NAME = "bench: scheduled run";
const DIGEST_TASK_NAME = "blueprint: morning_digest";
/** Both schedulers run in the owner's timezone. */
const SCHED_TZ = "Asia/Tehran";
/** Per-owner scheduled-task cap, mirroring src/tools/scheduled_tasks.ts. */
const MAX_TASKS_PER_OWNER = 25;

/**
 * Dashboard cadence whitelist for the bench schedule: the ONLY cron
 * expressions the web UI may install. Arbitrary crons set from Telegram keep
 * working and are shown as "custom"; picking a preset here replaces them.
 */
const BENCH_CADENCES: Readonly<Record<string, string>> = {
  daily: "0 3 * * *",
  weekly: "0 3 * * 0",
  monthly: "0 3 1 * *",
};

/** Digest default when creating from the web: 08:00 Tehran, like /blueprint. */
const DIGEST_DEFAULT_TIME = "08:00";
/** Digest prompt, mirroring the morning_digest blueprint in cmd_auto.ts. */
const DIGEST_PROMPT =
  "خلاصهٔ صبحگاهی به فارسی: مهم‌ترین کارهای امروز، یادآورهای نزدیک و هدف‌های فعال را کوتاه خلاصه کن.";

/** Bench mode/model selector values. */
const MODE_MODEL_RE = /^[A-Za-z0-9_.\-/]{1,64}$/;
/** Bench task ids, same rule as the run_bench tool input. */
const BENCH_TASK_ID_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
/** Digest time picker value: HH:MM, 24h. */
const DIGEST_TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
/** Crons of the shape the digest time picker can represent: "M H * * *". */
const DIGEST_CRON_RE = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/;

// ------------------------------------------------------ phase 5: custom ---
// crons + digest editing + group digests ------------------------------------
// Custom crons from the dashboard must parse AND stay above a minimum
// interval floor: an every-minute agent turn or benchmark would burn the
// provider quota and the scheduler loop. Presets (phase 4) are unaffected.
const MAX_CRON_LEN = 64;
/** Bench: a custom cron must not fire more often than hourly. */
const MIN_BENCH_CRON_GAP_MS = 60 * 60 * 1000;
/** Digest: a custom cron must not fire more often than every 15 minutes. */
const MIN_DIGEST_CRON_GAP_MS = 15 * 60 * 1000;
/** Digest prompt ceiling — the same bound parseTaskAction enforces on agent prompts. */
const MAX_DIGEST_PROMPT_CHARS = 4000;
/** Telegram chat id, same rule as group_digest.ts (numeric, optional minus). */
const CHAT_ID_RE = /^-?\d{1,20}$/;
/**
 * Pref-key prefix for group-assistant configs, derived from the same
 * helper the assistant module uses — single source of truth, no duplication.
 */
const GROUP_CFG_PREFIX = assistantConfigKey("");

type CustomCronValidation =
  | { ok: true; source: string }
  | { ok: false; reason: "invalid" | "too_frequent" };

/**
 * Validate a dashboard-supplied custom cron: it must parse (parseCron), and
 * its three soonest slots in the scheduler timezone must all sit at least
 * minGapMs apart — this rejects "* * * * *" style abuse that would fire an
 * agent turn or benchmark every minute. Pure; the caller maps the reason to
 * a user-facing message.
 */
function validateCustomCron(raw: unknown, minGapMs: number): CustomCronValidation {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const expr = raw.trim();
  if (expr.length === 0 || expr.length > MAX_CRON_LEN) {
    return { ok: false, reason: "invalid" };
  }
  let source: string;
  let schedule: ReturnType<typeof parseCron>;
  try {
    schedule = parseCron(expr);
    source = schedule.source;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  try {
    let from = Date.now();
    let prev: number | undefined;
    for (let i = 0; i < 3; i++) {
      const next = nextAfterSchedule(schedule, from, SCHED_TZ);
      if (prev !== undefined && next - prev < minGapMs) {
        return { ok: false, reason: "too_frequent" };
      }
      prev = next;
      from = next;
    }
  } catch {
    // A schedule that can never occur (e.g. February 30th) throws here.
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, source };
}

/** Audit events for the phase-5 digest/group-digest mutations. Best-effort, like auditScheduler. */
function auditDigest(
  storage: Storage,
  operation: "dashboard.digest.config" | "dashboard.group_digest",
  ownerId: string,
  outcome: "success" | "denied" | "error",
  detail: string,
): void {
  try {
    storage.appendAudit({ operation, outcome, actorId: ownerId, detail });
  } catch {
    // Audit failure must not block the mutation.
  }
}

const MAX_TREND_N = 100;

/**
 * BenchHistory access. Production: a second connection to the same SQLite
 * file — exactly what src/index.ts does (new BenchHistory(new
 * Database(config.dbPath))). The path mirrors src/config/config.ts (DB_PATH
 * env, default "data/bobi.db") because src/index.ts is intentionally
 * untouched by this module. Cached per Storage, like the other services.
 */
const benchHistoryCache = new WeakMap<Storage, BenchHistory>();

function benchHistoryFor(storage: Storage, override?: BenchHistory): BenchHistory {
  if (override !== undefined) return override;
  const cached = benchHistoryCache.get(storage);
  if (cached !== undefined) return cached;
  const dbPath = (process.env.DB_PATH ?? "").trim() || "data/bobi.db";
  const history = new BenchHistory(new Database(dbPath));
  benchHistoryCache.set(storage, history);
  return history;
}

/** bench/results override for tests; default is the repo's bench/results. */
function benchResultsDir(): string {
  const override = (process.env.BOBI_BENCH_RESULTS_DIR ?? "").trim();
  if (override !== "") return override;
  return resolve(import.meta.dir, "../../../bench/results");
}

/** Filenames the dashboard will ever serve from bench/results. */
const BENCH_FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}\.json$/;
/** The `name` query param (extensionless base name). */
const BENCH_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}$/;
/** Telegram numeric user id, same rule as the /ban command. */
const USER_ID_RE = /^[1-9][0-9]{0,19}$/;

interface Services {
  providers: ProviderService;
  models: ModelService;
  users: UserAccessService;
  memory: MemoryProvider | undefined;
  /**
   * Phase 5: the semantic memory index, for the owner-visible index state
   * on the memory endpoint. Read-only use here (indexState); the dashboard
   * never triggers embedding or backfill.
   */
  semantic: SemanticMemorySearch | undefined;
}

const servicesCache = new WeakMap<Storage, Services>();

function servicesFor(
  storage: Storage,
  semanticOverride?: SemanticMemorySearch,
): Services {
  const cached = servicesCache.get(storage);
  if (cached !== undefined) return cached;
  const masterKey = (process.env.AI_KEY_MASTER_KEY ?? "").trim() || undefined;
  const secrets = new ProviderSecretStore(masterKey);
  const adapters = new AdapterRegistry();
  let memory: MemoryProvider | undefined;
  try {
    memory = resolveMemoryProvider(storage);
  } catch {
    memory = undefined;
  }
  const services: Services = {
    providers: new ProviderService(storage, secrets, adapters),
    models: new ModelService(storage),
    users: new UserAccessService(storage),
    memory,
    semantic: semanticOverride ?? semanticIndexFor(storage, secrets, adapters, memory),
  };
  servicesCache.set(storage, services);
  return services;
}

const semanticCache = new WeakMap<Storage, SemanticMemorySearch | undefined>();

/**
 * Phase 5: the semantic memory index for the dashboard's memory endpoint.
 *
 * Production: a second connection to the same SQLite file (the same pattern
 * benchHistoryFor() uses and src/index.ts uses for its own vector handle).
 * Used read-only — indexState() never embeds and never writes — so the
 * dashboard cannot trigger provider calls or background backfills.
 */
function semanticIndexFor(
  storage: Storage,
  secrets: ProviderSecretStore,
  adapters: AdapterRegistry,
  memory: MemoryProvider | undefined,
): SemanticMemorySearch | undefined {
  const cached = semanticCache.get(storage);
  if (cached !== undefined) return cached;
  let built: SemanticMemorySearch | undefined;
  try {
    if (memory !== undefined) {
      const dbPath = (process.env.DB_PATH ?? "").trim() || "data/bobi.db";
      built = new SemanticMemorySearch({
        provider: memory,
        vectors: new MemoryVectorStore(new Database(dbPath)),
        embedder: new ProviderEmbedder({ storage, secrets, adapters }),
      });
    }
  } catch {
    built = undefined;
  }
  semanticCache.set(storage, built);
  return built;
}

/** The owner id, mirroring src/config/config.ts (OWNER_TELEGRAM_ID). */
function ownerId(): string | undefined {
  const raw = (process.env.OWNER_TELEGRAM_ID ?? "").trim();
  return raw !== "" ? raw : undefined;
}

// ------------------------------------------------------------ rate limit ----

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

/** Test-only hook: clears the per-IP buckets between tests. */
export function resetDashboardRateLimitsForTests(): void {
  buckets.clear();
}

function takeRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (bucket === undefined || now >= bucket.resetAt) {
    if (buckets.size > 4096) {
      for (const [key, b] of buckets) {
        if (now >= b.resetAt) buckets.delete(key);
      }
    }
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_PER_MINUTE) return false;
  bucket.count += 1;
  return true;
}

// ------------------------------------------------------------------ auth ----

/**
 * Extracts the token from `Authorization: Bearer <token>`. The scheme match
 * is case-insensitive (RFC 6750): some HTTP clients send `bearer`.
 */
function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (header === null) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1];
}

/** Constant-time comparison (same construction as src/http/server.ts). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// ------------------------------------------------------------------ io ------

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function html(status: number, page: string): Response {
  return new Response(page, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // Clickjacking / injection posture: the pages are same-origin SPA
      // shells with inline scripts (Bearer auth cannot be sent on
      // subresource fetches, so inlining is required). The policy keeps
      // what is enforceable: no framing, no plugins/objects, no base-tag
      // hijack, and scripts/styles only from inline or self.
      "content-security-policy":
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'deny'",
    },
  });
}

async function readCappedBody(req: Request): Promise<string | undefined> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isSafeInteger(n) && n > MAX_BODY_BYTES) return undefined;
  }
  const raw = await req.text();
  return raw.length <= MAX_BODY_BYTES ? raw : undefined;
}

function asId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// ---------------------------------------------------------------- router ---

/**
 * Dashboard sub-router for the API server.
 *
 * Returns undefined when the request is not a dashboard path, so the caller
 * (src/http/server.ts) falls through to its own 404. Everything else returns
 * a Response — including auth failures, so no dashboard path ever leaks into
 * the generic 404 handler.
 */
export function handleDashboardRequest(
  req: Request,
  deps: DashboardDeps,
): Promise<Response> | undefined {
  const url = new URL(req.url);
  const path = url.pathname;
  const isPage = PAGE_PATHS.has(path);
  const isApi = path === API_PREFIX || path.startsWith(API_PREFIX + "/");
  if (!isPage && !isApi) return undefined;
  return route(req, deps, url, path, isPage);
}

async function route(
  req: Request,
  deps: DashboardDeps,
  url: URL,
  path: string,
  isPage: boolean,
): Promise<Response> {
  const ip = (req as Request & { __clientIp?: string }).__clientIp ?? "unknown";

  // Rate limit BEFORE auth, like the turn endpoint: a 429 never touches the token.
  if (!takeRateLimit(ip)) {
    return json(429, { error: "Rate limit exceeded. Please wait a moment and try again." });
  }

  const token = deps.token.trim();
  if (token === "") {
    return isPage
      ? html(503, renderLoginPage())
      : json(503, { error: "API service is unavailable." });
  }

  const presented = bearerToken(req);
  const authed = presented !== undefined && safeEqual(presented, token);

  // The page shell: without a token the login screen (zero owner data);
  // with a token the SPA shell. Browsers cannot send Authorization headers
  // on navigation, so the login screen is the one deliberate exception to
  // "every route needs the token" — it is a credential-entry form, not data.
  if (isPage) {
    if (req.method !== "GET") return json(405, { error: "Method not allowed." });
    return html(200, authed ? renderAppPage() : renderLoginPage());
  }

  if (!authed) {
    return json(401, { error: "Invalid credentials." });
  }

  const services = servicesFor(deps.storage, deps.semantic);
  const sub = path.slice(API_PREFIX.length) || "/";

  try {
    switch (sub) {
      case "/ping":
        return method(req, "GET", () => json(200, { ok: true }));
      case "/providers":
        return method(req, "GET", () => handleProviders(deps.storage, services));
      case "/providers/enable":
        return postJson(req, (body) => handleProviderEnable(services, body));
      case "/providers/activate":
        return postJson(req, (body) => handleProviderActivate(deps.storage, services, body));
      case "/models/enable":
        return postJson(req, (body) => handleModelEnable(services, body));
      case "/models/activate":
        return postJson(req, (body) => handleModelActivate(deps.storage, services, body));
      case "/memory":
        return method(req, "GET", () => handleMemory(url, services));
      case "/users":
        return method(req, "GET", () => handleUsers(deps.storage));
      case "/users/restrict":
        return postJson(req, (body) => handleRestrict(services, body));
      case "/benchmarks":
        return method(req, "GET", () => handleBenchList());
      case "/benchmarks/report":
        return method(req, "GET", () => handleBenchReport(url));
      case "/benchmarks/trends":
        return method(req, "GET", () => handleBenchTrends(url, deps));
      case "/benchmarks/live/stream":
        return method(req, "GET", () => handleBenchLiveStream(req, deps));
      case "/schedulers":
        return method(req, "GET", () => handleSchedulers(deps.storage));
      case "/schedulers/bench":
        return postJson(req, (body) => handleBenchScheduler(deps.storage, body));
      case "/schedulers/digest":
        return postJson(req, (body) => handleDigestScheduler(deps.storage, body));
      case "/digest/config":
        return method(req, "GET", () => handleDigestConfig(deps.storage));
      case "/digest/prompt":
        return postJson(req, (body) => handleDigestPrompt(deps.storage, body));
      case "/digest/prompt/reset":
        return postJson(req, () => handleDigestPromptReset(deps.storage));
      case "/digest/destination":
        return postJson(req, (body) => handleDigestDestination(deps.storage, body));
      case "/group-digests":
        return method(req, "GET", () => handleGroupDigests(deps.storage));
      case "/group-digests/set":
        return postJson(req, (body) => handleGroupDigestSet(deps.storage, body));
      default:
        return json(404, { error: "Not found." });
    }
  } catch {
    return json(500, { error: "Internal error." });
  }
}

function method(req: Request, want: "GET", fn: () => Promise<Response> | Response): Promise<Response> | Response {
  if (req.method !== want) return json(405, { error: "Method not allowed." });
  return fn();
}

/** POST routes: enforce POST + JSON content-type (CSRF posture: no cookies exist, and simple form posts are rejected). */
async function postJson(
  req: Request,
  fn: (body: Record<string, unknown>) => Promise<Response> | Response,
): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return json(415, { error: "Content-Type must be application/json." });
  }
  const raw = await readCappedBody(req);
  if (raw === undefined) return json(413, { error: "Request body too large." });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Request body is not valid JSON." });
  }
  if (typeof body !== "object" || body === null) {
    return json(400, { error: "Invalid request body." });
  }
  return fn(body as Record<string, unknown>);
}

// --------------------------------------------------------------- providers -

function handleProviders(storage: Storage, services: Services): Response {
  const providers = services.providers.listViews().map((p) => ({
    id: p.id,
    label: p.label,
    adapter: p.adapter,
    adapterLabel: p.adapterLabel,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    hasCredential: p.hasCredential,
    modelCount: p.modelCount,
    canListModels: p.canListModels,
    isActive: p.isActive,
    models: services.models.list(p.id),
  }));
  const runtime = storage.getRuntimeSettings();
  return json(200, {
    providers,
    runtime: {
      activeProviderId: runtime.activeProviderId,
      activeModelId: runtime.activeModelId,
    },
  });
}

function handleProviderEnable(services: Services, body: Record<string, unknown>): Response {
  const id = asId(body["id"]);
  const enabled = asBool(body["enabled"]);
  if (id === undefined || enabled === undefined) {
    return json(400, { error: "Invalid input." });
  }
  const r = services.providers.setEnabled(id, enabled);
  if (!r.ok) return json(400, { error: r.message });
  return json(200, { ok: true, provider: services.providers.view(id) });
}

/**
 * Activate a provider: mirrors the Telegram /ai flow's "select provider then
 * model" as one step — the provider must be enabled, and activation lands on
 * its default model (first enabled model when no default is set).
 */
function handleProviderActivate(
  storage: Storage,
  services: Services,
  body: Record<string, unknown>,
): Response {
  const id = asId(body["id"]);
  if (id === undefined) return json(400, { error: "Invalid input." });
  const view = services.providers.view(id);
  if (!view) return json(404, { error: "Provider not found." });
  if (!view.enabled) return json(400, { error: "This provider is disabled." });
  const enabled = services.models.enabledModels(id);
  const pick = enabled.find((m) => m.isDefault) ?? enabled[0];
  if (!pick) return json(400, { error: "This provider has no enabled models." });
  storage.setRuntimeSelection({ providerId: id, modelId: pick.id });
  return json(200, { ok: true, providerId: id, modelId: pick.id });
}

function handleModelEnable(services: Services, body: Record<string, unknown>): Response {
  const id = asId(body["id"]);
  const enabled = asBool(body["enabled"]);
  if (id === undefined || enabled === undefined) {
    return json(400, { error: "Invalid input." });
  }
  const r = services.models.setEnabled(id, enabled);
  if (!r.ok) return json(400, { error: r.message });
  return json(200, { ok: true, model: services.models.get(id) });
}

/** Activate a model: must exist, be enabled, and belong to an enabled provider — same rule as the /model quick-switch. */
function handleModelActivate(
  storage: Storage,
  services: Services,
  body: Record<string, unknown>,
): Response {
  const id = asId(body["id"]);
  if (id === undefined) return json(400, { error: "Invalid input." });
  const m = services.models.get(id);
  if (!m) return json(404, { error: "Model not found." });
  if (!m.enabled) return json(400, { error: "This model is disabled." });
  const provider = storage.getProvider(m.providerId);
  if (!provider || !provider.enabled) {
    return json(400, { error: "This model's provider is disabled." });
  }
  storage.setRuntimeSelection({ providerId: m.providerId, modelId: id });
  return json(200, { ok: true, providerId: m.providerId, modelId: id });
}

// ------------------------------------------------------------------ memory -

async function handleMemory(url: URL, services: Services): Promise<Response> {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  if (!services.memory) {
    return json(503, { error: "Memory service is unavailable." });
  }
  const limitParam = url.searchParams.get("limit");
  const rawLimit = limitParam === null || limitParam.trim() === "" ? NaN : Number(limitParam);
  const limit = Number.isSafeInteger(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_MEMORY_LIMIT)
    : 50;
  const q = (url.searchParams.get("q") ?? "").slice(0, MAX_QUERY_CHARS).toLowerCase();

  // Read-only: the provider's list is the only read path, scoped to the
  // owner id server-side — exactly like the remember/recall tools.
  const all = await services.memory.list(oid, MAX_MEMORY_LIMIT);
  const total = await services.memory.count(oid);
  const mems = (q === ""
    ? all
    : all.filter(
        (m) => m.key.toLowerCase().includes(q) || m.content.toLowerCase().includes(q),
      )
  ).slice(0, limit);
  // Phase 5: owner-visible vector-index health (counts + live model id, no
  // memory content). Best-effort: a failure here must never break the
  // memory listing itself.
  let embedding: MemoryIndexState | undefined;
  try {
    embedding = (await services.semantic?.indexState(oid)) ?? undefined;
  } catch {
    embedding = undefined;
  }
  return json(200, {
    mems: mems.map((m) => ({
      key: m.key,
      content: m.content,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
    total,
    ...(embedding !== undefined ? { embedding } : {}),
  });
}

// ------------------------------------------------------------------- users -

const USER_STATES = ["pending", "approved", "rejected", "revoked"] as const;

function toUserJson(r: UserAccessRecord): Record<string, unknown> {
  const o: Record<string, unknown> = {
    userId: r.userId,
    state: r.state,
    requestedAt: r.requestedAt,
    updatedAt: r.updatedAt,
  };
  if (r.username !== undefined) o["username"] = r.username;
  if (r.firstName !== undefined) o["firstName"] = r.firstName;
  return o;
}

function handleUsers(storage: Storage): Response {
  const groups: Record<string, Array<Record<string, unknown>>> = {};
  const counts: Record<string, number> = {};
  for (const state of USER_STATES) {
    const rows = storage.listUsersByState(state, USER_LIST_CAP, 0);
    groups[state] = rows.map(toUserJson);
    counts[state] = storage.countUsersByState(state);
  }
  return json(200, { groups, counts });
}

type RestrictAction = "ban" | "unban" | "mute" | "unmute";

/**
 * Ban/unban/mute/unmute — the exact semantics of the Telegram /ban, /unban,
 * /mute, /unmute commands (see handleUserRestrict in src/bot/cmd_system.ts):
 * numeric-only target, and the owner can never restrict themselves.
 */
function handleRestrict(services: Services, body: Record<string, unknown>): Response {
  const action = body["action"];
  if (action !== "ban" && action !== "unban" && action !== "mute" && action !== "unmute") {
    return json(400, { error: "Invalid action." });
  }
  const target = body["userId"];
  if (typeof target !== "string" || !USER_ID_RE.test(target)) {
    return json(400, { error: "Invalid user id." });
  }
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  if (target === oid) {
    return json(400, { error: "You cannot restrict yourself." });
  }
  const act = action as RestrictAction;
  const r =
    act === "ban"
      ? services.users.ban(target, oid)
      : act === "unban"
        ? services.users.unban(target, oid)
        : act === "mute"
          ? services.users.mute(target, oid)
          : services.users.unmute(target, oid);
  if (!r.ok) {
    return json(400, {
      error:
        r.reason === "not_found"
          ? "User not found."
          : r.reason === "invalid_transition"
            ? "State change not allowed."
            : "Storage error.",
    });
  }
  const state = act === "ban" ? "rejected" : act === "mute" ? "revoked" : "approved";
  return json(200, { ok: true, userId: target, state });
}

// -------------------------------------------------------------- benchmarks -

interface BenchSummary {
  name: string;
  generatedAt?: string;
  mode?: string;
  provider?: string;
  model?: string;
  taskCount?: number;
  totals?: {
    passed?: number;
    failed?: number;
    avgScorePct?: number;
    totalLatencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  parseError?: boolean;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function summarizeRun(name: string, raw: string): BenchSummary {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const totals = v["totals"];
    const t = typeof totals === "object" && totals !== null ? (totals as Record<string, unknown>) : {};
    const summary: BenchSummary = { name };
    const generatedAt = asString(v["generatedAt"]);
    const mode = asString(v["mode"]);
    const provider = asString(v["provider"]);
    const model = asString(v["model"]);
    const taskCount = asNumber(v["taskCount"]);
    if (generatedAt !== undefined) summary.generatedAt = generatedAt;
    if (mode !== undefined) summary.mode = mode;
    if (provider !== undefined) summary.provider = provider;
    if (model !== undefined) summary.model = model;
    if (taskCount !== undefined) summary.taskCount = taskCount;
    const totalsOut: NonNullable<BenchSummary["totals"]> = {};
    const passed = asNumber(t["passed"]);
    const failed = asNumber(t["failed"]);
    const avgScorePct = asNumber(t["avgScorePct"]);
    const totalLatencyMs = asNumber(t["totalLatencyMs"]);
    const inputTokens = asNumber(t["inputTokens"]);
    const outputTokens = asNumber(t["outputTokens"]);
    const costUsd = asNumber(t["costUsd"]);
    if (passed !== undefined) totalsOut.passed = passed;
    if (failed !== undefined) totalsOut.failed = failed;
    if (avgScorePct !== undefined) totalsOut.avgScorePct = avgScorePct;
    if (totalLatencyMs !== undefined) totalsOut.totalLatencyMs = totalLatencyMs;
    if (inputTokens !== undefined) totalsOut.inputTokens = inputTokens;
    if (outputTokens !== undefined) totalsOut.outputTokens = outputTokens;
    if (costUsd !== undefined) totalsOut.costUsd = costUsd;
    summary.totals = totalsOut;
    return summary;
  } catch {
    return { name, parseError: true };
  }
}

async function handleBenchList(): Promise<Response> {
  const dir = benchResultsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return json(200, { runs: [] });
  }
  const runs: BenchSummary[] = [];
  for (const f of files) {
    if (!BENCH_FILE_RE.test(f)) continue;
    try {
      const raw = await readFile(join(dir, f), "utf8");
      runs.push(summarizeRun(f.slice(0, -".json".length), raw));
    } catch {
      runs.push({ name: f.slice(0, -".json".length), parseError: true });
    }
  }
  runs.sort((a, b) => (a.name < b.name ? 1 : -1));
  return json(200, { runs });
}

async function handleBenchReport(url: URL): Promise<Response> {
  const name = url.searchParams.get("name") ?? "";
  if (!BENCH_NAME_RE.test(name)) {
    return json(400, { error: "Invalid report name." });
  }
  const dir = benchResultsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return json(404, { error: "Report not found." });
  }
  // Allowlist: the name must name a real run in the live listing — a regex
  // match alone is not enough, and user input is never joined into a path
  // without this check.
  if (!files.includes(`${name}.json`)) {
    return json(404, { error: "Report not found." });
  }
  const mdPath = resolve(dir, `${name}.md`);
  if (!mdPath.startsWith(resolve(dir) + "/")) {
    return json(400, { error: "Invalid report name." });
  }
  try {
    const markdown = await readFile(mdPath, "utf8");
    return json(200, { name, markdown });
  } catch {
    return json(404, { error: "Report not found." });
  }
}

// ------------------------------------------------- phase 4: trend charts --

/**
 * GET /api/v1/dashboard/benchmarks/trends?mode=&model=&task=&n=
 *
 * Score-trend data for the dashboard's SVG chart, read from the bench
 * history tables (bench_runs / bench_run_scores) — the same data /bench
 * trend prints as text.
 *
 * Response: the selected (mode, model) pair (default: the latest run's),
 * its aggregate avg-score series (oldest → newest), the distinct pairs and
 * the pair's task list for the UI selectors, and — when ?task= names a task —
 * that task's per-task series.
 *
 * PRIVACY: rows carry scores and totals only — never prompts, never raw
 * model output (same rule as the bench alert text). mode/model/task are
 * strict-regex validated; n is clamped.
 */
function handleBenchTrends(url: URL, deps: DashboardDeps): Response {
  const history = benchHistoryFor(deps.storage, deps.benchHistory);

  const nParam = url.searchParams.get("n");
  const nRaw = nParam === null || nParam.trim() === "" ? NaN : Number(nParam);
  const limit = Number.isSafeInteger(nRaw)
    ? Math.min(Math.max(nRaw, 1), MAX_TREND_N)
    : 20;

  const mode = url.searchParams.get("mode") ?? "";
  const model = url.searchParams.get("model") ?? "";
  const task = url.searchParams.get("task") ?? "";
  if (
    (mode !== "" && !MODE_MODEL_RE.test(mode)) ||
    (model !== "" && !MODE_MODEL_RE.test(model)) ||
    (task !== "" && !BENCH_TASK_ID_RE.test(task))
  ) {
    return json(400, { error: "Invalid input." });
  }

  let pair: { mode: string; model: string } | null = null;
  if (mode !== "" && model !== "") {
    pair = { mode, model };
  } else {
    const latest = history.listRuns(1)[0];
    if (latest !== undefined) pair = { mode: latest.mode, model: latest.model };
  }

  // Distinct (mode, model) pairs for the UI selector, from the newest runs.
  const pairCounts = new Map<string, { mode: string; model: string; runs: number }>();
  for (const r of history.listRuns(MAX_TREND_N)) {
    const key = `${r.mode} ${r.model}`;
    const entry = pairCounts.get(key);
    if (entry !== undefined) entry.runs += 1;
    else pairCounts.set(key, { mode: r.mode, model: r.model, runs: 1 });
  }
  const pairs = [...pairCounts.values()];

  if (pair === null) {
    return json(200, { pair: null, runs: [], pairs, tasks: [], task: null });
  }

  const runs = history
    .overallTrend(pair.mode, pair.model, limit)
    .map((p) => ({ runId: p.runId, tsMs: p.tsMs, avgScorePct: p.avgScorePct }));

  // Task list for the selector: the scores of the pair's newest run.
  const newest = history.baselineRuns(pair.mode, pair.model, 1)[0];
  const tasks =
    newest === undefined
      ? []
      : (history.getRun(newest.id)?.scores ?? []).map((s) => ({
          taskId: s.taskId,
          titleFa: s.titleFa,
        }));

  let taskOut: Record<string, unknown> | null = null;
  if (task !== "") {
    const titleFa = tasks.find((t) => t.taskId === task)?.titleFa;
    taskOut = {
      taskId: task,
      ...(titleFa !== undefined ? { titleFa } : {}),
      points: history
        .taskTrend(pair.mode, pair.model, task, limit)
        .map((p) => ({ runId: p.runId, tsMs: p.tsMs, scorePct: p.scorePct })),
    };
  }

  return json(200, { pair, runs, pairs, tasks, task: taskOut });
}

// ------------------------------------------- phase 4: scheduler management -

function findOwnerTask(
  storage: Storage,
  ownerId: string,
  name: string,
): ScheduledTaskRecord | undefined {
  return storage.listTasks(ownerId, 200).find((t) => t.name === name);
}

/** Which dashboard cadence preset a cron matches, or "custom" (e.g. set from Telegram). */
function cadenceOf(cron: string): string {
  for (const [key, value] of Object.entries(BENCH_CADENCES)) {
    if (value === cron) return key;
  }
  return "custom";
}

/** "HH:MM" for digest crons of the shape "M H * * *", else null (custom). */
function digestTimeOf(cron: string): string | null {
  const m = DIGEST_CRON_RE.exec(cron);
  if (m === null) return null;
  return `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
}

/**
 * The run_bench mode baked into a bench schedule's action. Defensive: any
 * unexpected shape falls back to null (unknown), mirroring benchTaskMode in
 * src/bot/cmd_phase3_bench.ts.
 */
function benchModeOf(task: ScheduledTaskRecord): "offline" | "live" | null {
  try {
    const a = JSON.parse(task.actionJson) as {
      type?: unknown;
      tool?: unknown;
      input?: unknown;
    };
    if (a !== null && typeof a === "object" && a.type === "tool" && a.tool === "run_bench") {
      const input = a.input as Record<string, unknown> | undefined;
      return input?.mode === "live" ? "live" : "offline";
    }
  } catch {
    // fall through to null
  }
  return null;
}

function benchSchedulerView(
  storage: Storage,
  ownerId: string,
): Record<string, unknown> {
  const task = findOwnerTask(storage, ownerId, BENCH_TASK_NAME);
  if (task === undefined) {
    return { key: "bench", exists: false, enabled: false };
  }
  const view: Record<string, unknown> = {
    key: "bench",
    exists: true,
    enabled: task.enabled,
    cron: task.cronExpr,
    cadence: cadenceOf(task.cronExpr),
    timezone: task.timezone,
    nextRunAtMs: task.nextRunAtMs,
  };
  const mode = benchModeOf(task);
  if (mode !== null) view["mode"] = mode;
  if (task.lastRunAtMs !== undefined) view["lastRunAtMs"] = task.lastRunAtMs;
  if (task.lastStatus !== undefined) view["lastStatus"] = task.lastStatus;
  return view;
}

function digestSchedulerView(
  storage: Storage,
  ownerId: string,
): Record<string, unknown> {
  const task = findOwnerTask(storage, ownerId, DIGEST_TASK_NAME);
  if (task === undefined) {
    return { key: "digest", exists: false, enabled: false };
  }
  const view: Record<string, unknown> = {
    key: "digest",
    exists: true,
    enabled: task.enabled,
    cron: task.cronExpr,
    timezone: task.timezone,
    nextRunAtMs: task.nextRunAtMs,
  };
  const time = digestTimeOf(task.cronExpr);
  if (time !== null) view["time"] = time;
  else view["custom"] = true;
  if (task.lastRunAtMs !== undefined) view["lastRunAtMs"] = task.lastRunAtMs;
  if (task.lastStatus !== undefined) view["lastStatus"] = task.lastStatus;
  return view;
}

function handleSchedulers(storage: Storage): Response {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  return json(200, {
    schedulers: [benchSchedulerView(storage, oid), digestSchedulerView(storage, oid)],
  });
}

/**
 * Append a scheduler-mutation audit event. Best-effort: a failing audit must
 * never block the mutation itself (same rule as cmd_system.ts).
 */
function auditScheduler(
  storage: Storage,
  which: "bench" | "digest",
  ownerId: string,
  outcome: "success" | "denied" | "error",
  detail: string,
): void {
  try {
    storage.appendAudit({
      operation: `dashboard.scheduler.${which}`,
      outcome,
      actorId: ownerId,
      detail,
    });
  } catch {
    // Audit failure must not block the mutation.
  }
}

/**
 * Parse a cron and compute its next slot after now, in the scheduler
 * timezone. Throws CronError on an invalid expression.
 */
function nextSlotAfterNow(cron: string): number {
  return nextAfterSchedule(parseCron(cron), Date.now(), SCHED_TZ);
}

/**
 * POST /api/v1/dashboard/schedulers/bench
 * Body: { enabled: boolean, cadence?: "daily"|"weekly"|"monthly",
 *         mode?: "offline"|"live" }
 *
 * The web equivalent of `/bench schedule <cron|off>`: on/off plus cadence
 * from a strict whitelist (arbitrary crons stay Telegram-only). Enabling
 * with a cadence creates the single "bench: scheduled run" task or updates
 * it in place; disabling flips the enabled flag (the row — and its history
 * — is kept, unlike Telegram's `schedule off` which deletes it).
 * Enabling an existing task WITHOUT a cadence/cron simply re-enables it on
 * its current cron (the digest endpoint already behaves this way).
 * Every change is audit-logged.
 */
function handleBenchScheduler(storage: Storage, body: Record<string, unknown>): Response {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  const enabled = asBool(body["enabled"]);
  if (enabled === undefined) {
    auditScheduler(storage, "bench", oid, "denied", "bad enabled");
    return json(400, { error: "Invalid input." });
  }
  const existing = findOwnerTask(storage, oid, BENCH_TASK_NAME);

  if (!enabled) {
    if (existing === undefined) {
      auditScheduler(storage, "bench", oid, "denied", "disable missing");
      return json(400, { error: "No scheduled benchmark exists." });
    }
    if (!existing.enabled) {
      return json(200, { ok: true, id: existing.id, enabled: false });
    }
    storage.updateTask(oid, existing.id, { enabled: false });
    auditScheduler(storage, "bench", oid, "success", `disabled id=${existing.id}`);
    return json(200, { ok: true, id: existing.id, enabled: false });
  }

  // Phase 5: a custom cron is allowed alongside the presets — strictly
  // validated (parses + ≥1h between the soonest firings). A non-empty cron
  // takes precedence over the cadence selector.
  const customCronRaw = body["cron"];
  let cron: string;
  let cadence: string | undefined;
  let custom = false;
  if (typeof customCronRaw === "string" && customCronRaw.trim() !== "") {
    const v = validateCustomCron(customCronRaw, MIN_BENCH_CRON_GAP_MS);
    if (!v.ok) {
      auditScheduler(storage, "bench", oid, "denied", `bad cron (${v.reason})`);
      return json(400, {
        error:
          v.reason === "too_frequent"
            ? "Schedule too frequent: benchmarks may run at most once per hour."
            : "Invalid cron expression.",
      });
    }
    cron = v.source;
    custom = true;
  } else {
    cadence = typeof body["cadence"] === "string" ? body["cadence"] : "";
    const preset = BENCH_CADENCES[cadence];
    if (preset !== undefined) {
      cron = preset;
    } else if (cadence === "" && existing !== undefined) {
      // Re-enabling an existing schedule without touching the cadence
      // selector: keep its current cron instead of rejecting the toggle.
      cron = existing.cronExpr;
      cadence = cadenceOf(existing.cronExpr);
      custom = cadence === "custom";
    } else {
      auditScheduler(storage, "bench", oid, "denied", `bad cadence=${cadence.slice(0, 32)}`);
      return json(400, { error: "Invalid cadence." });
    }
  }
  const modeRaw = body["mode"];
  const mode = modeRaw === undefined ? undefined : String(modeRaw);
  if (mode !== undefined && mode !== "offline" && mode !== "live") {
    auditScheduler(storage, "bench", oid, "denied", "bad mode");
    return json(400, { error: "Invalid mode." });
  }

  let source: string;
  let slot: number;
  try {
    source = parseCron(cron).source;
    slot = nextSlotAfterNow(cron);
  } catch {
    auditScheduler(storage, "bench", oid, "denied", "bad cron");
    return json(400, { error: "Invalid cron expression." });
  }

  if (existing !== undefined) {
    const patch: {
      cronExpr: string;
      enabled: boolean;
      nextRunAtMs: number;
      actionJson?: string;
    } = { cronExpr: source, enabled: true, nextRunAtMs: slot };
    if (mode !== undefined) {
      patch.actionJson = JSON.stringify({
        type: "tool",
        tool: "run_bench",
        input: { mode },
      });
    }
    if (!storage.updateTask(oid, existing.id, patch)) {
      auditScheduler(storage, "bench", oid, "error", `update failed id=${existing.id}`);
      return json(500, { error: "Internal error." });
    }
    const schedDesc = custom ? `cron=${source}` : `cadence=${cadence}`;
    auditScheduler(
      storage,
      "bench",
      oid,
      "success",
      `updated id=${existing.id} ${schedDesc}${mode !== undefined ? ` mode=${mode}` : ""}`,
    );
    return json(200, {
      ok: true,
      id: existing.id,
      enabled: true,
      ...(custom ? { custom: true, cron: source } : { cadence }),
      ...(mode !== undefined ? { mode } : {}),
    });
  }

  if (storage.countTasks(oid) >= MAX_TASKS_PER_OWNER) {
    auditScheduler(storage, "bench", oid, "denied", "task cap");
    return json(400, { error: "Scheduled task limit reached." });
  }
  const id = storage.createTask({
    name: BENCH_TASK_NAME,
    cronExpr: source,
    timezone: SCHED_TZ,
    actionJson: JSON.stringify({
      type: "tool",
      tool: "run_bench",
      input: { mode: mode ?? "offline" },
    }),
    createdByUserId: oid,
    nextRunAtMs: slot,
    enabled: true,
  });
  auditScheduler(
    storage,
    "bench",
    oid,
    "success",
    `created id=${id} ${custom ? `cron=${source}` : `cadence=${cadence}`} mode=${mode ?? "offline"}`,
  );
  return json(200, {
    ok: true,
    id,
    enabled: true,
    ...(custom ? { custom: true, cron: source } : { cadence }),
    mode: mode ?? "offline",
  });
}

/**
 * POST /api/v1/dashboard/schedulers/digest
 * Body: { enabled: boolean, time?: "HH:MM" }
 *
 * The web equivalent of `/blueprint run morning_digest`: on/off plus the
 * Tehran delivery time. The time picker maps to "M H * * *"; crons of any
 * other shape (set from Telegram) are shown as custom and left alone until
 * the owner picks a time here.
 *
 * Updates never touch the action: the chatId and prompt the owner set (via
 * /blueprint) are preserved. A fresh task mirrors the blueprint — an agent
 * action delivering to the owner's DM (chatId = OWNER_TELEGRAM_ID, the same
 * chat /blueprint uses when run from a DM).
 * Every change is audit-logged.
 */
function handleDigestScheduler(storage: Storage, body: Record<string, unknown>): Response {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  const enabled = asBool(body["enabled"]);
  if (enabled === undefined) {
    auditScheduler(storage, "digest", oid, "denied", "bad enabled");
    return json(400, { error: "Invalid input." });
  }
  const existing = findOwnerTask(storage, oid, DIGEST_TASK_NAME);

  if (!enabled) {
    if (existing === undefined) {
      auditScheduler(storage, "digest", oid, "denied", "disable missing");
      return json(400, { error: "No scheduled morning digest exists." });
    }
    if (!existing.enabled) {
      return json(200, { ok: true, id: existing.id, enabled: false });
    }
    storage.updateTask(oid, existing.id, { enabled: false });
    auditScheduler(storage, "digest", oid, "success", `disabled id=${existing.id}`);
    return json(200, { ok: true, id: existing.id, enabled: false });
  }

  // Phase 5: a custom cron is allowed alongside the time picker — strictly
  // validated (parses + ≥15min between the soonest firings). A non-empty
  // cron takes precedence over the time picker.
  const customCronRaw = body["cron"];
  const hasCustomCron = typeof customCronRaw === "string" && customCronRaw.trim() !== "";
  let cron: string;
  let custom = false;
  if (hasCustomCron) {
    const v = validateCustomCron(customCronRaw, MIN_DIGEST_CRON_GAP_MS);
    if (!v.ok) {
      auditScheduler(storage, "digest", oid, "denied", `bad cron (${v.reason})`);
      return json(400, {
        error:
          v.reason === "too_frequent"
            ? "Schedule too frequent: digests may run at most every 15 minutes."
            : "Invalid cron expression.",
      });
    }
    cron = v.source;
    custom = true;
  } else {
    const timeRaw = body["time"];
    const timeValid =
      typeof timeRaw === "string" && DIGEST_TIME_RE.test(timeRaw) ? timeRaw : undefined;
    if (timeRaw !== undefined && timeValid === undefined) {
      auditScheduler(storage, "digest", oid, "denied", "bad time");
      return json(400, { error: "Invalid time (expected HH:MM)." });
    }
    if (timeValid === undefined && existing === undefined) {
      auditScheduler(storage, "digest", oid, "denied", "missing time on create");
      return json(400, { error: "Specify the delivery time (HH:MM)." });
    }

    // Keep the existing cron when only toggling on; otherwise build "M H * * *".
    cron =
      timeValid === undefined
        ? existing!.cronExpr
        : `${Number(timeValid.slice(3, 5))} ${Number(timeValid.slice(0, 2))} * * *`;
  }
  let source: string;
  let slot: number;
  try {
    source = parseCron(cron).source;
    slot = nextSlotAfterNow(cron);
  } catch {
    auditScheduler(storage, "digest", oid, "denied", "bad cron");
    return json(400, { error: "Invalid cron expression." });
  }
  const timeOut = digestTimeOf(source);
  const timeDesc = custom ? `cron=${source}` : `time=${timeOut ?? DIGEST_DEFAULT_TIME}`;

  if (existing !== undefined) {
    if (
      !storage.updateTask(oid, existing.id, {
        cronExpr: source,
        enabled: true,
        nextRunAtMs: slot,
      })
    ) {
      auditScheduler(storage, "digest", oid, "error", `update failed id=${existing.id}`);
      return json(500, { error: "Internal error." });
    }
    auditScheduler(
      storage,
      "digest",
      oid,
      "success",
      `updated id=${existing.id} ${timeDesc}`,
    );
    return json(200, {
      ok: true,
      id: existing.id,
      enabled: true,
      time: timeOut,
      ...(custom ? { custom: true, cron: source } : {}),
    });
  }

  if (storage.countTasks(oid) >= MAX_TASKS_PER_OWNER) {
    auditScheduler(storage, "digest", oid, "denied", "task cap");
    return json(400, { error: "Scheduled task limit reached." });
  }
  const id = storage.createTask({
    name: DIGEST_TASK_NAME,
    cronExpr: source,
    timezone: SCHED_TZ,
    actionJson: JSON.stringify({ type: "agent", chatId: oid, prompt: DIGEST_PROMPT }),
    createdByUserId: oid,
    nextRunAtMs: slot,
    enabled: true,
  });
  auditScheduler(storage, "digest", oid, "success", `created id=${id} ${timeDesc}`);
  return json(200, {
    ok: true,
    id,
    enabled: true,
    time: timeOut,
    ...(custom ? { custom: true, cron: source } : {}),
  });
}

// --------------------------------- phase 5: digest prompt & destination ----

/**
 * Read the digest task's agent action. Null when the row's action is not the
 * blueprint's { type:"agent", chatId, prompt } shape — the prompt/destination
 * editors only touch agent actions, never tool/message actions someone may
 * have installed by hand.
 */
function readDigestAgentAction(
  task: ScheduledTaskRecord,
): { chatId: string; prompt: string } | null {
  try {
    const a = JSON.parse(task.actionJson) as Record<string, unknown>;
    if (
      a !== null &&
      typeof a === "object" &&
      a["type"] === "agent" &&
      typeof a["chatId"] === "string" &&
      typeof a["prompt"] === "string"
    ) {
      return { chatId: a["chatId"], prompt: a["prompt"] };
    }
  } catch {
    // Not JSON or wrong shape — handled as null below.
  }
  return null;
}

/**
 * GET /api/v1/dashboard/digest/config
 *
 * The morning-digest row with its prompt and delivery destination. The
 * fixed task name means this row is OWNED by Telegram's /blueprint (the
 * dashboard surfaces that: `ownedBy: "blueprint"`); the dashboard only
 * edits the row's content through the same storage store /blueprint writes.
 */
function handleDigestConfig(storage: Storage): Response {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  const task = findOwnerTask(storage, oid, DIGEST_TASK_NAME);
  if (task === undefined) {
    return json(200, { exists: false, enabled: false, blueprint: "morning_digest" });
  }
  const action = readDigestAgentAction(task);
  const time = digestTimeOf(task.cronExpr);
  const out: Record<string, unknown> = {
    exists: true,
    enabled: task.enabled,
    blueprint: "morning_digest",
    ownedBy: "blueprint",
    cron: task.cronExpr,
    time,
    custom: time === null,
    timezone: task.timezone,
    nextRunAtMs: task.nextRunAtMs,
    actionIsAgent: action !== null,
    prompt: action?.prompt ?? null,
    defaultPrompt: DIGEST_PROMPT,
    isCustomPrompt: action !== null && action.prompt !== DIGEST_PROMPT,
    chatId: action?.chatId ?? null,
    defaultChatId: oid,
    isDefaultDestination: action !== null && action.chatId === oid,
  };
  if (task.lastRunAtMs !== undefined) out["lastRunAtMs"] = task.lastRunAtMs;
  if (task.lastStatus !== undefined) out["lastStatus"] = task.lastStatus;
  return json(200, out);
}

/**
 * Write a new prompt into the digest task's agent action, through
 * parseTaskAction/serializeTaskAction — the same validation the
 * schedule_task tool applies. The prompt text itself is never audit-logged
 * (it may carry owner context); only its length is.
 */
function writeDigestPrompt(
  storage: Storage,
  oid: string,
  task: ScheduledTaskRecord,
  action: { chatId: string; prompt: string },
  prompt: string,
): Response {
  let actionJson: string;
  try {
    actionJson = serializeTaskAction(
      parseTaskAction({ type: "agent", chatId: action.chatId, prompt }),
    );
  } catch {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "prompt validation failed");
    return json(400, { error: "Invalid prompt." });
  }
  if (!storage.updateTask(oid, task.id, { actionJson })) {
    auditDigest(storage, "dashboard.digest.config", oid, "error", `prompt update failed id=${task.id}`);
    return json(500, { error: "Internal error." });
  }
  auditDigest(
    storage,
    "dashboard.digest.config",
    oid,
    "success",
    `prompt updated id=${task.id} len=${prompt.length} custom=${prompt !== DIGEST_PROMPT}`,
  );
  return json(200, { ok: true, id: task.id, isCustomPrompt: prompt !== DIGEST_PROMPT });
}

/** POST /api/v1/dashboard/digest/prompt — { prompt }. */
function handleDigestPrompt(storage: Storage, body: Record<string, unknown>): Response {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  const prompt = body["prompt"];
  if (
    typeof prompt !== "string" ||
    prompt.trim().length === 0 ||
    prompt.length > MAX_DIGEST_PROMPT_CHARS
  ) {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "bad prompt");
    return json(400, { error: "Prompt must be between 1 and 4000 characters." });
  }
  const task = findOwnerTask(storage, oid, DIGEST_TASK_NAME);
  if (task === undefined) {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "prompt without task");
    return json(400, { error: "No scheduled morning digest exists." });
  }
  const action = readDigestAgentAction(task);
  if (action === null) {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "prompt on non-agent action");
    return json(400, { error: "This task has no agent action; check it from Telegram." });
  }
  return writeDigestPrompt(storage, oid, task, action, prompt);
}

/** POST /api/v1/dashboard/digest/prompt/reset — restore the /blueprint default prompt. */
function handleDigestPromptReset(storage: Storage): Response {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  const task = findOwnerTask(storage, oid, DIGEST_TASK_NAME);
  if (task === undefined) {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "reset without task");
    return json(400, { error: "No scheduled morning digest exists." });
  }
  const action = readDigestAgentAction(task);
  if (action === null) {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "reset on non-agent action");
    return json(400, { error: "This task has no agent action; check it from Telegram." });
  }
  if (action.prompt === DIGEST_PROMPT) {
    return json(200, { ok: true, id: task.id, isCustomPrompt: false });
  }
  return writeDigestPrompt(storage, oid, task, action, DIGEST_PROMPT);
}

/** POST /api/v1/dashboard/digest/destination — { chatId }. */
function handleDigestDestination(storage: Storage, body: Record<string, unknown>): Response {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  const chatRaw = body["chatId"];
  if (typeof chatRaw !== "string" || !CHAT_ID_RE.test(chatRaw.trim())) {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "bad chatId");
    return json(400, { error: "Invalid chat id." });
  }
  const chatId = chatRaw.trim();
  const task = findOwnerTask(storage, oid, DIGEST_TASK_NAME);
  if (task === undefined) {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "destination without task");
    return json(400, { error: "No scheduled morning digest exists." });
  }
  const action = readDigestAgentAction(task);
  if (action === null) {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "destination on non-agent action");
    return json(400, { error: "This task has no agent action; check it from Telegram." });
  }
  let actionJson: string;
  try {
    actionJson = serializeTaskAction(
      parseTaskAction({ type: "agent", chatId, prompt: action.prompt }),
    );
  } catch {
    auditDigest(storage, "dashboard.digest.config", oid, "denied", "destination validation failed");
    return json(400, { error: "Invalid chat id." });
  }
  if (!storage.updateTask(oid, task.id, { actionJson })) {
    auditDigest(storage, "dashboard.digest.config", oid, "error", `destination update failed id=${task.id}`);
    return json(500, { error: "Internal error." });
  }
  auditDigest(
    storage,
    "dashboard.digest.config",
    oid,
    "success",
    `destination updated id=${task.id} chatId=${chatId} default=${chatId === oid}`,
  );
  return json(200, { ok: true, id: task.id, chatId, isDefaultDestination: chatId === oid });
}

// --------------------------------------- phase 5: group-digest management -

/**
 * DigestTaskCalls over the owner's storage rows — the dashboard equivalent
 * of the coordinator's DigestSchedulePort in src/index.ts. Same row shape
 * (name/cron/timezone/action), same per-owner task cap; the digest tool
 * re-reads the config at run time, so a config-off with a stale row still
 * no-ops (same fail-closed as Telegram).
 */
function digestTaskCalls(storage: Storage, ownerId: string): DigestTaskCalls {
  return {
    list: async () =>
      storage.listTasks(ownerId, 200).map((t) => ({ id: t.id, name: t.name })),
    create: async (args) => {
      if (storage.countTasks(ownerId) >= MAX_TASKS_PER_OWNER) {
        throw new Error("per-owner task cap reached");
      }
      return storage.createTask({
        name: args.name,
        cronExpr: args.cron,
        timezone: args.timezone,
        actionJson: JSON.stringify({
          type: "tool",
          tool: GROUP_DIGEST_TOOL_NAME,
          input: { chatId: args.chatId },
        }),
        createdByUserId: ownerId,
        nextRunAtMs: nextSlotAfterNow(args.cron),
        enabled: true,
      });
    },
    cancel: async (id) => {
      storage.deleteTask(ownerId, id);
    },
  };
}

/**
 * GET /api/v1/dashboard/group-digests
 *
 * Every group with an assistant config (the `gacfg:` pref rows the
 * /gassistant handlers read), each with its digest switch, time, and the
 * state of its digest task row. Chat ids stay Latin so they can be copied
 * verbatim; display names are never stored for groups, so none are shown.
 */
function handleGroupDigests(storage: Storage): Response {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  const tasks = storage.listTasks(oid, 200);
  const groups: Array<Record<string, unknown>> = [];
  for (const key of storage.listUserPrefKeys(oid, GROUP_CFG_PREFIX)) {
    const chatId = key.slice(GROUP_CFG_PREFIX.length);
    if (!CHAT_ID_RE.test(chatId)) continue; // defensive: keys are owner-written
    const cfg = getAssistantConfig(storage, oid, chatId);
    const task = tasks.find((t) => t.name === digestTaskName(chatId));
    const taskOut: Record<string, unknown> = { exists: task !== undefined, enabled: false };
    if (task !== undefined) {
      taskOut["enabled"] = task.enabled;
      taskOut["cron"] = task.cronExpr;
      taskOut["nextRunAtMs"] = task.nextRunAtMs;
      if (task.lastRunAtMs !== undefined) taskOut["lastRunAtMs"] = task.lastRunAtMs;
      if (task.lastStatus !== undefined) taskOut["lastStatus"] = task.lastStatus;
    }
    groups.push({
      chatId,
      mode: cfg.enabled,
      digestEnabled: cfg.digestEnabled,
      digestTime: cfg.digestTime,
      task: taskOut,
    });
  }
  return json(200, { groups });
}

/**
 * POST /api/v1/dashboard/group-digests/set — { chatId, digestEnabled, time? }.
 *
 * The web equivalent of `/gassistant digest on|off|time HH:MM`, with the
 * same semantics: the task is created BEFORE the config flips on (a failed
 * schedule never leaves the config claiming a digest), and the digest
 * requires the assistant mode (Telegram's `need_mode` rule). The delivery
 * target is fixed server-side to the owner's DM — only the group whose
 * history is read is configurable.
 */
async function handleGroupDigestSet(
  storage: Storage,
  body: Record<string, unknown>,
): Promise<Response> {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "Owner id is not configured." });
  }
  const chatRaw = body["chatId"];
  if (typeof chatRaw !== "string" || !CHAT_ID_RE.test(chatRaw.trim())) {
    auditDigest(storage, "dashboard.group_digest", oid, "denied", "bad chatId");
    return json(400, { error: "Invalid group id." });
  }
  const chatId = chatRaw.trim();
  const enabled = asBool(body["digestEnabled"]);
  if (enabled === undefined) {
    auditDigest(storage, "dashboard.group_digest", oid, "denied", "bad digestEnabled");
    return json(400, { error: "Invalid input." });
  }
  const timeRaw = body["time"];
  const time =
    timeRaw === undefined ? undefined : validateDigestTime(timeRaw);
  if (time !== undefined && !time.ok) {
    auditDigest(storage, "dashboard.group_digest", oid, "denied", "bad time");
    return json(400, { error: "Invalid time (expected HH:MM)." });
  }
  const cfg = getAssistantConfig(storage, oid, chatId);
  const calls = digestTaskCalls(storage, oid);

  if (!enabled) {
    const res = setAssistantConfig(storage, oid, chatId, { digestEnabled: false });
    if (!res.ok) {
      auditDigest(storage, "dashboard.group_digest", oid, "error", `off config failed chat=${chatId}`);
      return json(400, { error: "Invalid input." });
    }
    await cancelGroupDigestTask(calls, chatId);
    auditDigest(storage, "dashboard.group_digest", oid, "success", `off chat=${chatId}`);
    return json(200, { ok: true, chatId, digestEnabled: false });
  }

  if (!cfg.enabled) {
    auditDigest(storage, "dashboard.group_digest", oid, "denied", `on without mode chat=${chatId}`);
    return json(400, {
      error: "Enable group assistant mode from Telegram first (/gassistant on in the group).",
    });
  }
  let finalTime = cfg.digestTime;
  if (time !== undefined) {
    const res = setAssistantConfig(storage, oid, chatId, { digestTime: time.time });
    if (!res.ok) {
      auditDigest(storage, "dashboard.group_digest", oid, "error", `time config failed chat=${chatId}`);
      return json(400, { error: "Invalid input." });
    }
    finalTime = res.config.digestTime;
  }
  // Create the task BEFORE flipping the config: if scheduling fails, the
  // config must not claim a digest that will never fire.
  let id: number | undefined;
  try {
    id = await ensureGroupDigestTask(calls, chatId, finalTime);
  } catch {
    id = undefined;
  }
  if (id === undefined) {
    auditDigest(storage, "dashboard.group_digest", oid, "error", `schedule failed chat=${chatId}`);
    return json(500, { error: "Failed to create the schedule." });
  }
  if (!cfg.digestEnabled) {
    const res = setAssistantConfig(storage, oid, chatId, { digestEnabled: true });
    if (!res.ok) {
      // Config write failed after scheduling — cancel the task so the two
      // stay consistent (the tool would no-op anyway, reading the config).
      await cancelGroupDigestTask(calls, chatId);
      auditDigest(storage, "dashboard.group_digest", oid, "error", `on config failed chat=${chatId}`);
      return json(500, { error: "Internal error." });
    }
  }
  auditDigest(
    storage,
    "dashboard.group_digest",
    oid,
    "success",
    `on chat=${chatId} time=${finalTime} id=${id}`,
  );
  return json(200, { ok: true, chatId, digestEnabled: true, time: finalTime, taskId: id });
}

// ------------------------------------------- phase 5: live progress stream --

/**
 * GET /api/v1/dashboard/benchmarks/live/stream — Server-Sent Events stream
 * of benchmark worker progress (Phase-5).
 *
 * Same auth + rate-limit posture as every other dashboard API (the Bearer
 * check in route() runs before this function). Events:
 *   event: snapshot  — full worker snapshot (idle/running/queued + progress)
 *   event: progress  — per-task progress while a run is active
 *   event: terminal  — a run ended: { jobId, outcome, runId? }
 * plus `: ping` comments every 15s so idle connections stay alive.
 *
 * No new listener: this is a streaming response on the existing Bun.serve
 * socket (the dashboard shares the API server). The worker guards every
 * subscriber — a slow or throwing client never breaks a run.
 *
 * Payloads carry scores/progress only — never prompts, never raw model
 * output (same rule as the bench history APIs).
 */
export function handleBenchLiveStream(req: Request, deps: DashboardDeps): Response {
  const worker = deps.benchWorker;
  if (worker === undefined) {
    return json(503, { error: "Benchmark live streaming is not enabled on this instance." });
  }
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe?.();
  };
  const stream = new ReadableStream<string>({
    start(controller) {
      const send = (event: string, data: unknown): void => {
        if (cleaned) return;
        try {
          controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          cleanup();
        }
      };
      // The connecting client gets the current state first — no waiting for
      // the next task to complete.
      send("snapshot", worker.snapshot());
      unsubscribe = worker.subscribeProgress((ev) => {
        if (ev.type === "progress") {
          send("progress", ev.progress);
        } else if (ev.type === "terminal") {
          send("terminal", {
            jobId: ev.jobId,
            outcome: ev.outcome,
            ...(ev.runId !== undefined ? { runId: ev.runId } : {}),
          });
        } else {
          send("snapshot", ev.snapshot);
        }
      });
      heartbeat = setInterval(() => {
        if (cleaned) return;
        try {
          controller.enqueue(": ping\n\n");
        } catch {
          cleanup();
        }
      }, 15_000);
      heartbeat.unref?.();
      // Bun aborts the request signal when the client disconnects.
      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
