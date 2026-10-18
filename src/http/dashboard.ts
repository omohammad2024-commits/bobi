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
 *     renderSafeMarkdown (src/http/dashboard_render.ts) — the server never
 *     interpolates owner data into HTML.
 *  8. Error messages are generic Persian strings; they never leak config,
 *     stack traces, or why auth failed.
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
import type { Storage, UserAccessRecord } from "../storage/storage";
import { ProviderSecretStore } from "../ai/secret_store";
import { AdapterRegistry } from "../ai/adapter_registry";
import { ModelService, ProviderService } from "../ai/provider_service";
import { UserAccessService } from "../auth/user_service";
import { resolveMemoryProvider } from "../memory/factory";
import type { MemoryProvider } from "../memory/provider";
import { renderAppPage, renderLoginPage } from "./dashboard_pages";

export interface DashboardDeps {
  storage: Storage;
  /** Trimmed BOBI_API_TOKEN, carried over from the API server deps. */
  token: string;
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
}

const servicesCache = new WeakMap<Storage, Services>();

function servicesFor(storage: Storage): Services {
  const cached = servicesCache.get(storage);
  if (cached !== undefined) return cached;
  const masterKey = (process.env.AI_KEY_MASTER_KEY ?? "").trim() || undefined;
  const secrets = new ProviderSecretStore(masterKey);
  let memory: MemoryProvider | undefined;
  try {
    memory = resolveMemoryProvider(storage);
  } catch {
    memory = undefined;
  }
  const services: Services = {
    providers: new ProviderService(storage, secrets, new AdapterRegistry()),
    models: new ModelService(storage),
    users: new UserAccessService(storage),
    memory,
  };
  servicesCache.set(storage, services);
  return services;
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

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (header === null) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/.exec(header);
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
    return json(429, { error: "تعداد درخواست‌ها بیش از حد مجاز است. کمی صبر کنید." });
  }

  const token = deps.token.trim();
  if (token === "") {
    return isPage
      ? html(503, renderLoginPage())
      : json(503, { error: "سرویس API در دسترس نیست." });
  }

  const presented = bearerToken(req);
  const authed = presented !== undefined && safeEqual(presented, token);

  // The page shell: without a token the login screen (zero owner data);
  // with a token the SPA shell. Browsers cannot send Authorization headers
  // on navigation, so the login screen is the one deliberate exception to
  // "every route needs the token" — it is a credential-entry form, not data.
  if (isPage) {
    if (req.method !== "GET") return json(405, { error: "روش مجاز نیست." });
    return html(200, authed ? renderAppPage() : renderLoginPage());
  }

  if (!authed) {
    return json(401, { error: "احراز هویت نامعتبر است." });
  }

  const services = servicesFor(deps.storage);
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
      default:
        return json(404, { error: "یافت نشد." });
    }
  } catch {
    return json(500, { error: "خطای داخلی رخ داد." });
  }
}

function method(req: Request, want: "GET", fn: () => Promise<Response> | Response): Promise<Response> | Response {
  if (req.method !== want) return json(405, { error: "روش مجاز نیست." });
  return fn();
}

/** POST routes: enforce POST + JSON content-type (CSRF posture: no cookies exist, and simple form posts are rejected). */
async function postJson(
  req: Request,
  fn: (body: Record<string, unknown>) => Promise<Response> | Response,
): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "روش مجاز نیست." });
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return json(415, { error: "نوع محتوا باید application/json باشد." });
  }
  const raw = await readCappedBody(req);
  if (raw === undefined) return json(413, { error: "بدنه درخواست بیش از حد بزرگ است." });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "بدنه درخواست JSON معتبر نیست." });
  }
  if (typeof body !== "object" || body === null) {
    return json(400, { error: "بدنه درخواست نامعتبر است." });
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
    return json(400, { error: "ورودی نامعتبر است." });
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
  if (id === undefined) return json(400, { error: "ورودی نامعتبر است." });
  const view = services.providers.view(id);
  if (!view) return json(404, { error: "پروایدر یافت نشد." });
  if (!view.enabled) return json(400, { error: "این پروایدر غیرفعال است." });
  const enabled = services.models.enabledModels(id);
  const pick = enabled.find((m) => m.isDefault) ?? enabled[0];
  if (!pick) return json(400, { error: "این پروایدر هیچ مدل فعالی ندارد." });
  storage.setRuntimeSelection({ providerId: id, modelId: pick.id });
  return json(200, { ok: true, providerId: id, modelId: pick.id });
}

function handleModelEnable(services: Services, body: Record<string, unknown>): Response {
  const id = asId(body["id"]);
  const enabled = asBool(body["enabled"]);
  if (id === undefined || enabled === undefined) {
    return json(400, { error: "ورودی نامعتبر است." });
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
  if (id === undefined) return json(400, { error: "ورودی نامعتبر است." });
  const m = services.models.get(id);
  if (!m) return json(404, { error: "مدل یافت نشد." });
  if (!m.enabled) return json(400, { error: "این مدل غیرفعال است." });
  const provider = storage.getProvider(m.providerId);
  if (!provider || !provider.enabled) {
    return json(400, { error: "پروایدر این مدل غیرفعال است." });
  }
  storage.setRuntimeSelection({ providerId: m.providerId, modelId: id });
  return json(200, { ok: true, providerId: m.providerId, modelId: id });
}

// ------------------------------------------------------------------ memory -

async function handleMemory(url: URL, services: Services): Promise<Response> {
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "شناسهٔ مالک تنظیم نشده است." });
  }
  if (!services.memory) {
    return json(503, { error: "سرویس حافظه در دسترس نیست." });
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
  return json(200, {
    mems: mems.map((m) => ({
      key: m.key,
      content: m.content,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
    total,
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
    return json(400, { error: "عمل نامعتبر است." });
  }
  const target = body["userId"];
  if (typeof target !== "string" || !USER_ID_RE.test(target)) {
    return json(400, { error: "شناسهٔ کاربر نامعتبر است." });
  }
  const oid = ownerId();
  if (oid === undefined) {
    return json(503, { error: "شناسهٔ مالک تنظیم نشده است." });
  }
  if (target === oid) {
    return json(400, { error: "نمی‌توانید خودتان را مسدود یا نادیده بگیرید." });
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
          ? "کاربر یافت نشد."
          : r.reason === "invalid_transition"
            ? "تغییر وضعیت مجاز نیست."
            : "خطای ذخیره‌سازی.",
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
    return json(400, { error: "نام گزارش نامعتبر است." });
  }
  const dir = benchResultsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return json(404, { error: "گزارش یافت نشد." });
  }
  // Allowlist: the name must name a real run in the live listing — a regex
  // match alone is not enough, and user input is never joined into a path
  // without this check.
  if (!files.includes(`${name}.json`)) {
    return json(404, { error: "گزارش یافت نشد." });
  }
  const mdPath = resolve(dir, `${name}.md`);
  if (!mdPath.startsWith(resolve(dir) + "/")) {
    return json(400, { error: "نام گزارش نامعتبر است." });
  }
  try {
    const markdown = await readFile(mdPath, "utf8");
    return json(200, { name, markdown });
  } catch {
    return json(404, { error: "گزارش یافت نشد." });
  }
}
