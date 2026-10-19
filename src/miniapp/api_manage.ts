/**
 * Mini App backend: management APIs (owner's complete remote control).
 *
 * Mounted by the Mini App router (src/miniapp/api.ts) at POST /miniapp/api/*.
 * Every call carries `{ initData }` in the JSON body; auth runs through
 * `validateInitData` (initData HMAC validation + owner check) from
 * ./auth — a failure returns a generic 401, never a reason.
 *
 * Reuses the same underlying storage/service calls as the Telegram handlers
 * and the web dashboard (no duplicated logic, no dashboard Bearer auth).
 *
 * Conventions:
 * - list endpoints accept `{ q?, limit? }` (limit clamped 1..200);
 * - mutations return `{ ok: true, ... }` or `{ ok: false, error: "<en>" }`;
 * - destructive mutations take `{ confirm: true }`; without it the first
 *   call returns `{ needsConfirm: true }`;
 * - errors are generic English strings — never stack traces, never secrets.
 */
import { Database } from "bun:sqlite";
import { validateInitData } from "./auth";
import type { Storage, ScheduledTaskRecord } from "../storage/storage";
import { UserAccessService } from "../auth/user_service";
import { resolveMemoryProvider } from "../memory/factory";
import type { MemoryProvider, StoredMemory } from "../memory/provider";
import { EventStore } from "../memory/events";
import { ProposalStore } from "../curator/proposals";
import { kindLabelFa } from "../curator/curator";
import { createCuratorDecideTool } from "../curator/tools";
import type { ToolContext } from "../tools/types";
import {
  createPinnedSkillFetcher,
  listInstalledSkillNames,
  prepareSkillInstall,
  readInstalledSkill,
  setSkillEnabled,
  uninstallSkillFile,
  writeSkillFile,
} from "../skills/install";
import { fingerprintPublicKey, parsePublisherInput, shortKeyId } from "../skills/signing";
import { BenchHistory } from "../bench/history";
import { nextAfterSchedule, parseCron } from "../scheduler/cron";
import { parseTaskAction, serializeTaskAction } from "../tools/scheduled_tasks";
import {
  assistantConfigKey,
  getAssistantConfig,
  setAssistantConfig,
} from "../groups/assistant";
import {
  GROUP_DIGEST_TOOL_NAME,
  cancelGroupDigestTask,
  digestTaskName,
  ensureGroupDigestTask,
  validateDigestTime,
  type DigestTaskCalls,
} from "../groups/group_digest";
import { getModConfig, modConfigKey, setModConfig } from "../moderation/config";
import { buildDigest, formatDigest } from "../digest/builder";
import { UsageTracker } from "../ai/usage";

// ------------------------------------------------------------ deps ----------

/**
 * Wiring supplied by the Mini App router (src/miniapp/api.ts). Everything
 * has an env default so the router only needs to pass `storage`.
 */
export interface ManageApiDeps {
  storage: Storage;
  /** Skills directory. Default: SKILLS_DIR env or "./skills". */
  skillsDir?: string;
  /** Database file for ProposalStore / BenchHistory / alert reads. Default: DB_PATH env or "data/bobi.db". */
  dbPath?: string;
  /** Test/env overrides; default to TELEGRAM_BOT_TOKEN / OWNER_TELEGRAM_ID. */
  botToken?: string;
  ownerId?: string;
  /** Injectable stores so tests never touch the real database. */
  proposalStore?: ProposalStore;
  benchHistory?: BenchHistory;
}

// ------------------------------------------------------------ plumbing ------

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const ok = (body: Record<string, unknown> = {}): Response =>
  json(200, { ok: true, ...body });

const fail = (status: number, error: string): Response =>
  json(status, { ok: false, error });

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = asInt(v);
  if (n === undefined) return def;
  return Math.min(Math.max(n, 1), max);
}

const USER_ID_RE = /^[1-9][0-9]{0,19}$/;
const CHAT_ID_RE = /^-?\d{1,20}$/;
const DIGEST_TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const MODE_MODEL_RE = /^[A-Za-z0-9_.\-/]{1,64}$/;
const BENCH_TASK_ID_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
const SCHED_TZ = "Asia/Tehran";

/** Task names owned by the bench scheduler and the /blueprint digest. */
const BENCH_TASK_NAME = "bench: scheduled run";
const DIGEST_TASK_NAME = "blueprint: morning_digest";
/** Like /blueprint's default morning prompt (dashboard mirrors the same). */
const DIGEST_PROMPT =
  "Morning briefing: briefly summarize today's most important tasks, upcoming reminders, and active goals.";

const MIN_BENCH_CRON_GAP_MS = 60 * 60 * 1000;
const MIN_DIGEST_CRON_GAP_MS = 15 * 60 * 1000;
const MAX_CRON_LEN = 64;

const BENCH_CADENCES: Readonly<Record<string, string>> = {
  daily: "0 3 * * *",
  weekly: "0 3 * * 0",
  monthly: "0 3 1 * *",
};

// ------------------------------------------------------------ auth ----------

/** Owner id from initData, or undefined on any auth failure (reason hidden). */
function authOwner(deps: ManageApiDeps, body: Record<string, unknown>): string | undefined {
  const initData = asString(body["initData"]) ?? "";
  const botToken = (deps.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const ownerId = (deps.ownerId ?? process.env.OWNER_TELEGRAM_ID ?? "").trim();
  if (initData === "" || botToken === "" || ownerId === "") return undefined;
  const v = validateInitData(initData, botToken, ownerId);
  return v.ok ? v.userId : undefined;
}

// ------------------------------------------------------------ stores --------

function dbPathFor(deps: ManageApiDeps): string {
  return (deps.dbPath ?? process.env.DB_PATH ?? "").trim() || "data/bobi.db";
}

function proposalStoreFor(deps: ManageApiDeps): ProposalStore {
  return deps.proposalStore ?? new ProposalStore(new Database(dbPathFor(deps)));
}

function benchHistoryFor(deps: ManageApiDeps): BenchHistory {
  if (deps.benchHistory !== undefined) return deps.benchHistory;
  return new BenchHistory(new Database(dbPathFor(deps)));
}

function skillsDirFor(deps: ManageApiDeps): string {
  return (deps.skillsDir ?? process.env.SKILLS_DIR ?? "").trim() || "./skills";
}

function memoryProviderFor(storage: Storage): MemoryProvider | undefined {
  try {
    return resolveMemoryProvider(storage);
  } catch {
    return undefined;
  }
}

/** Best-effort audit; a failing audit must never block the mutation. */
function audit(
  storage: Storage,
  operation: string,
  actorId: string,
  outcome: "success" | "denied" | "error",
  detail: string,
): void {
  try {
    storage.appendAudit({ operation, outcome, actorId, detail });
  } catch {
    // ignore
  }
}

function ownerTask(storage: Storage, ownerId: string, name: string): ScheduledTaskRecord | undefined {
  return storage.listTasks(ownerId, 200).find((t) => t.name === name);
}

function nextSlotAfterNow(cron: string): number {
  return nextAfterSchedule(parseCron(cron), Date.now(), SCHED_TZ);
}

type CronValidation = { ok: true; source: string } | { ok: false; reason: "invalid" | "too_frequent" };

/** Same posture as the dashboard: parses + enforces a minimum firing gap. */
function validateCustomCron(raw: unknown, minGapMs: number): CronValidation {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const expr = raw.trim();
  if (expr.length === 0 || expr.length > MAX_CRON_LEN) return { ok: false, reason: "invalid" };
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
      if (prev !== undefined && next - prev < minGapMs) return { ok: false, reason: "too_frequent" };
      prev = next;
      from = next;
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, source };
}

// ------------------------------------------------------------ router --------

const PREFIX = "/miniapp/api/";

/**
 * Management API sub-router. Returns undefined for non-manage paths so the
 * caller (src/miniapp/api.ts) falls through; every other path returns a
 * Response — including auth failures.
 */
export function handleManageApi(
  path: string,
  body: Record<string, unknown>,
  deps: ManageApiDeps,
): Promise<Response> | undefined {
  if (!path.startsWith(PREFIX)) return undefined;
  const name = path.slice(PREFIX.length);
  return route(name, body, deps);
}

async function route(
  name: string,
  body: Record<string, unknown>,
  deps: ManageApiDeps,
): Promise<Response> {
  if (body === null || typeof body !== "object") {
    return fail(400, "Invalid request body.");
  }
  const ownerId = authOwner(deps, body);
  if (ownerId === undefined) {
    return fail(401, "Invalid authentication.");
  }
  const storage = deps.storage;
  try {
    switch (name) {
      // users
      case "users.list":
        return handleUsersList(storage, body);
      case "users.ban":
        return handleUserBan(storage, ownerId, body);
      case "users.unban":
        return handleUserUnban(storage, ownerId, body);
      // memory + curator + events
      case "memory.search":
        return handleMemorySearch(storage, ownerId, body);
      case "memory.list":
        return handleMemoryList(storage, ownerId, body);
      case "curator.proposals":
        return handleCuratorProposals(deps, ownerId);
      case "curator.decide":
        return handleCuratorDecide(deps, ownerId, body);
      case "events.list":
        return handleEventsList(storage, ownerId);
      // benchmarks
      case "bench.runs":
        return handleBenchRuns(deps, body);
      case "bench.trends":
        return handleBenchTrends(deps, body);
      case "bench.schedule":
        return handleBenchSchedule(storage, ownerId, body);
      case "bench.alerts":
        return handleBenchAlerts(deps);
      // schedulers + digest
      case "schedulers.list":
        return handleSchedulersList(storage, ownerId);
      case "schedulers.toggle":
        return handleSchedulersToggle(storage, ownerId, body);
      case "digest.preview":
        return handleDigestPreview(deps, ownerId);
      case "digest.config":
        return handleDigestConfig(storage, ownerId, body);
      case "groupdigests.list":
        return handleGroupDigestsList(storage, ownerId);
      case "groupdigests.set":
        return handleGroupDigestSet(storage, ownerId, body);
      // skills + trust
      case "skills.list":
        return handleSkillsList(deps, storage);
      case "skills.toggle":
        return handleSkillsToggle(deps, ownerId, body);
      case "skills.install":
        return handleSkillInstall(deps, ownerId, body);
      case "skills.uninstall":
        return handleSkillUninstall(deps, ownerId, body);
      case "trust.list":
        return handleTrustList(storage);
      case "trust.add":
        return handleTrustAdd(storage, body);
      case "trust.remove":
        return handleTrustRemove(storage, body);
      // usage
      case "usage.report":
        return handleUsageReport(storage, body);
      // reminders / tasks / goals
      case "tasks.list":
        return handleTasksList(storage, ownerId);
      case "tasks.complete":
        return handleTasksComplete(storage, ownerId, body);
      case "tasks.cancel":
        return handleTasksCancel(storage, ownerId, body);
      // groups + moderation
      case "groups.list":
        return handleGroupsList(storage, ownerId, body);
      case "groups.assistant":
        return handleGroupAssistantGet(storage, ownerId, body);
      case "groups.assistant.set":
        return handleGroupAssistantSet(storage, ownerId, body);
      case "groups.digests":
        return handleGroupDigestGet(storage, ownerId, body);
      case "groups.digests.set":
        return handleGroupDigestSet(storage, ownerId, body);
      case "moderation.get":
        return handleModerationGet(storage, ownerId, body);
      case "moderation.set":
        return handleModerationSet(storage, ownerId, body);
      default:
        return fail(404, "Not found.");
    }
  } catch {
    return fail(500, "An internal error occurred.");
  }
}

// ------------------------------------------------------------ users --------

const USER_STATES = ["pending", "approved", "rejected", "revoked"] as const;
const USER_SCAN_CAP = 200;

function handleUsersList(storage: Storage, body: Record<string, unknown>): Response {
  const limit = clampLimit(body["limit"], 50, 200);
  const q = (asString(body["q"]) ?? "").slice(0, 64).toLowerCase();
  const users: Array<Record<string, unknown>> = [];
  for (const state of USER_STATES) {
    for (const r of storage.listUsersByState(state, USER_SCAN_CAP, 0)) {
      const u: Record<string, unknown> = {
        id: r.userId,
        state,
        isBanned: state === "rejected",
      };
      if (r.username !== undefined) u["username"] = r.username;
      if (r.firstName !== undefined) u["firstName"] = r.firstName;
      // NOTE: per-user notes do not exist in storage — no `note` field.
      users.push(u);
    }
  }
  const filtered =
    q === ""
      ? users
      : users.filter((u) =>
          [u["id"], u["username"], u["firstName"]]
            .filter((v): v is string => typeof v === "string")
            .some((v) => v.toLowerCase().includes(q)),
        );
  return ok({ users: filtered.slice(0, limit), total: filtered.length });
}

function validTargetId(raw: unknown, ownerId: string): string | undefined {
  const id = asString(raw);
  if (id === undefined || !USER_ID_RE.test(id)) return undefined;
  if (id === ownerId) return undefined;
  return id;
}

function handleUserBan(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const id = validTargetId(body["id"], ownerId);
  if (id === undefined) {
    audit(storage, "miniapp.users.ban", ownerId, "denied", "bad id");
    return fail(400, "Invalid user id.");
  }
  if (asBool(body["confirm"]) !== true) {
    return json(200, { needsConfirm: true, userId: id, action: "ban" });
  }
  const r = new UserAccessService(storage).ban(id, ownerId);
  if (!r.ok) {
    audit(storage, "miniapp.users.ban", ownerId, "error", `failed id=${id}`);
    return fail(500, "An internal error occurred.");
  }
  audit(storage, "miniapp.users.ban", ownerId, "success", `id=${id} prev=${r.previous ?? "?"}`);
  return ok({ userId: id, state: "rejected" });
}

function handleUserUnban(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const id = validTargetId(body["id"], ownerId);
  if (id === undefined) {
    audit(storage, "miniapp.users.unban", ownerId, "denied", "bad id");
    return fail(400, "Invalid user id.");
  }
  const r = new UserAccessService(storage).unban(id, ownerId);
  if (!r.ok) {
    audit(storage, "miniapp.users.unban", ownerId, "error", `failed id=${id}`);
    return fail(500, "An internal error occurred.");
  }
  audit(storage, "miniapp.users.unban", ownerId, "success", `id=${id} prev=${r.previous ?? "?"}`);
  return ok({ userId: id, state: "approved" });
}

// ------------------------------------------------ memory / curator / events

const MAX_MEMORY_LIST = 200;

function memoryJson(m: StoredMemory): Record<string, unknown> {
  return { key: m.key, content: m.content, createdAt: m.createdAt, updatedAt: m.updatedAt };
}

async function handleMemorySearch(storage: Storage, ownerId: string, body: Record<string, unknown>): Promise<Response> {
  const provider = memoryProviderFor(storage);
  if (provider === undefined) return fail(503, "Memory service is unavailable.");
  const limit = clampLimit(body["limit"], 50, MAX_MEMORY_LIST);
  const q = (asString(body["q"]) ?? "").slice(0, 64).toLowerCase();
  return memoryQuery(provider, ownerId, q, limit, 0);
}

async function handleMemoryList(storage: Storage, ownerId: string, body: Record<string, unknown>): Promise<Response> {
  const provider = memoryProviderFor(storage);
  if (provider === undefined) return fail(503, "Memory service is unavailable.");
  const limit = clampLimit(body["limit"], 50, MAX_MEMORY_LIST);
  const offsetRaw = asInt(body["offset"]);
  const offset = offsetRaw === undefined ? 0 : Math.max(offsetRaw, 0);
  return memoryQuery(provider, ownerId, "", limit, offset);
}

async function memoryQuery(
  provider: MemoryProvider,
  ownerId: string,
  q: string,
  limit: number,
  offset: number,
): Promise<Response> {
  const all = await provider.list(ownerId, MAX_MEMORY_LIST);
  const total = await provider.count(ownerId);
  const mems = (
    q === ""
      ? all
      : all.filter(
          (m) => m.key.toLowerCase().includes(q) || m.content.toLowerCase().includes(q),
        )
  ).slice(offset, offset + limit);
  return ok({ mems: mems.map(memoryJson), total, offset, limit });
}

function handleCuratorProposals(deps: ManageApiDeps, ownerId: string): Response {
  const proposals = proposalStoreFor(deps).listPending(ownerId);
  return ok({
    proposals: proposals.map((p) => ({
      id: p.id,
      kind: p.kind,
      kindFa: kindLabelFa(p.kind),
      memoryIds: p.memoryIds,
      summaryFa: p.summaryFa,
      createdAt: p.createdAt,
    })),
    count: proposals.length,
  });
}

function ownerToolCtx(userId: string): ToolContext {
  return {
    clock: () => new Date(),
    actor: { userId, permissions: [] },
    signal: new AbortController().signal,
  };
}

async function handleCuratorDecide(
  deps: ManageApiDeps,
  ownerId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const id = asString(body["id"]);
  const approve = asBool(body["approve"]);
  if (id === undefined || id.trim() === "" || approve === undefined) {
    return fail(400, "Invalid input.");
  }
  const provider = memoryProviderFor(deps.storage);
  if (provider === undefined) return fail(503, "Memory service is unavailable.");
  const store = proposalStoreFor(deps);
  const tool = createCuratorDecideTool({
    provider,
    store,
    isOwner: (uid) => uid === ownerId,
  });
  try {
    const out = await tool.run(
      { proposalId: id.trim(), decision: approve ? "approve" : "reject" },
      ownerToolCtx(ownerId),
    );
    audit(deps.storage, "miniapp.curator.decide", ownerId, "success", `id=${out.proposalId} d=${out.decision}`);
    return ok({ proposalId: out.proposalId, decision: out.decision, applied: out.applied, summaryFa: out.summaryFa });
  } catch (err) {
    // ToolError messages are user-facing Persian; anything else stays generic.
    const msg = err instanceof Error && /[\u0600-\u06FF]/.test(err.message)
      ? err.message
      : "An internal error occurred.";
    audit(deps.storage, "miniapp.curator.decide", ownerId, "error", `id=${id.trim()}`);
    return fail(err instanceof Error && /[\u0600-\u06FF]/.test(err.message) ? 400 : 500, msg);
  }
}

async function handleEventsList(storage: Storage, ownerId: string): Promise<Response> {
  const provider = memoryProviderFor(storage);
  if (provider === undefined) return fail(503, "Memory service is unavailable.");
  const store = new EventStore(provider);
  const upcoming = await store.upcoming(ownerId, Date.now());
  return ok({
    events: upcoming.map(({ key, event, daysUntil }) => ({
      key,
      name: event.name,
      kind: event.kind,
      labelFa: event.labelFa,
      daysUntil,
      ...(event.note !== undefined ? { note: event.note } : {}),
    })),
    count: upcoming.length,
  });
}

// ------------------------------------------------------------ bench --------

function handleBenchRuns(deps: ManageApiDeps, body: Record<string, unknown>): Response {
  const limit = clampLimit(body["limit"], 20, 50);
  const history = benchHistoryFor(deps);
  const runs = history.listRuns(limit);
  return ok({
    runs: runs.map((r) => ({
      id: r.id,
      runStamp: r.runStamp,
      tsMs: r.tsMs,
      mode: r.mode,
      provider: r.provider,
      model: r.model,
      taskCount: r.taskCount,
      passed: r.passed,
      failed: r.failed,
      avgScorePct: r.avgScorePct,
      totalLatencyMs: r.totalLatencyMs,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      status: r.status,
      ...(r.note !== null ? { note: r.note } : {}),
    })),
  });
}

const MAX_TREND_N = 50;

function handleBenchTrends(deps: ManageApiDeps, body: Record<string, unknown>): Response {
  const history = benchHistoryFor(deps);
  const n = clampLimit(body["n"], 20, MAX_TREND_N);
  const mode = asString(body["mode"]) ?? "";
  const model = asString(body["model"]) ?? "";
  const task = asString(body["task"]) ?? "";
  if (
    (mode !== "" && !MODE_MODEL_RE.test(mode)) ||
    (model !== "" && !MODE_MODEL_RE.test(model)) ||
    (task !== "" && !BENCH_TASK_ID_RE.test(task))
  ) {
    return fail(400, "Invalid input.");
  }

  let pair: { mode: string; model: string } | null = null;
  if (mode !== "" && model !== "") {
    pair = { mode, model };
  } else {
    const latest = history.listRuns(1)[0];
    if (latest !== undefined) pair = { mode: latest.mode, model: latest.model };
  }

  const pairCounts = new Map<string, { mode: string; model: string; runs: number }>();
  for (const r of history.listRuns(MAX_TREND_N)) {
    const key = `${r.mode} ${r.model}`;
    const entry = pairCounts.get(key);
    if (entry !== undefined) entry.runs += 1;
    else pairCounts.set(key, { mode: r.mode, model: r.model, runs: 1 });
  }
  const pairs = [...pairCounts.values()];

  if (pair === null) {
    return ok({ pair: null, runs: [], pairs, tasks: [], task: null });
  }

  const runs = history
    .overallTrend(pair.mode, pair.model, n)
    .map((p) => ({ runId: p.runId, tsMs: p.tsMs, avgScorePct: p.avgScorePct }));

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
        .taskTrend(pair.mode, pair.model, task, n)
        .map((p) => ({ runId: p.runId, tsMs: p.tsMs, scorePct: p.scorePct })),
    };
  }

  return ok({ pair, runs, pairs, tasks, task: taskOut });
}

function benchSchedulerView(
  storage: Storage,
  ownerId: string,
): Record<string, unknown> {
  const task = ownerTask(storage, ownerId, BENCH_TASK_NAME);
  if (task === undefined) {
    return { key: "bench", exists: false, enabled: false };
  }
  const view: Record<string, unknown> = {
    key: "bench",
    exists: true,
    enabled: task.enabled,
    cron: task.cronExpr,
    timezone: task.timezone,
    nextRunAtMs: task.nextRunAtMs,
  };
  if (task.lastRunAtMs !== undefined) view["lastRunAtMs"] = task.lastRunAtMs;
  if (task.lastStatus !== undefined) view["lastStatus"] = task.lastStatus;
  return view;
}

/**
 * bench.schedule — get when called without `enabled`; set with
 * `{ enabled, cron? | cadence? }`. A non-empty cron takes precedence over
 * the cadence preset; both are strictly validated (parse + ≥1h gap).
 */
function handleBenchSchedule(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  const enabled = asBool(body["enabled"]);
  if (enabled === undefined) {
    return ok({ schedule: benchSchedulerView(storage, ownerId) });
  }
  const existing = ownerTask(storage, ownerId, BENCH_TASK_NAME);

  if (!enabled) {
    if (existing === undefined) {
      audit(storage, "miniapp.bench.schedule", ownerId, "denied", "disable missing");
      return fail(400, "No benchmark schedule.");
    }
    if (existing.enabled) storage.updateTask(ownerId, existing.id, { enabled: false });
    audit(storage, "miniapp.bench.schedule", ownerId, "success", `disabled id=${existing.id}`);
    return ok({ id: existing.id, enabled: false });
  }

  const customCronRaw = body["cron"];
  let cron: string;
  let cadence: string | undefined;
  if (typeof customCronRaw === "string" && customCronRaw.trim() !== "") {
    const v = validateCustomCron(customCronRaw, MIN_BENCH_CRON_GAP_MS);
    if (!v.ok) {
      audit(storage, "miniapp.bench.schedule", ownerId, "denied", `bad cron (${v.reason})`);
      return fail(
        400,
        v.reason === "too_frequent"
          ? "Schedule too frequent; benchmark at most hourly."
          : "Invalid cron expression.",
      );
    }
    cron = v.source;
  } else {
    cadence = typeof body["cadence"] === "string" ? body["cadence"] : "";
    const preset = BENCH_CADENCES[cadence];
    if (preset === undefined) {
      audit(storage, "miniapp.bench.schedule", ownerId, "denied", `bad cadence=${cadence.slice(0, 32)}`);
      return fail(400, "Invalid time range.");
    }
    cron = preset;
  }

  let source: string;
  let slot: number;
  try {
    source = parseCron(cron).source;
    slot = nextSlotAfterNow(cron);
  } catch {
    audit(storage, "miniapp.bench.schedule", ownerId, "denied", "bad cron");
    return fail(400, "Invalid cron expression.");
  }

  const MAX_TASKS_PER_OWNER = 200;
  if (existing !== undefined) {
    if (
      !storage.updateTask(ownerId, existing.id, {
        cronExpr: source,
        enabled: true,
        nextRunAtMs: slot,
      })
    ) {
      audit(storage, "miniapp.bench.schedule", ownerId, "error", `update failed id=${existing.id}`);
      return fail(500, "An internal error occurred.");
    }
    audit(storage, "miniapp.bench.schedule", ownerId, "success", `updated id=${existing.id} cron=${source}`);
    return ok({ id: existing.id, enabled: true, cron: source, ...(cadence !== undefined ? { cadence } : {}) });
  }

  if (storage.countTasks(ownerId) >= MAX_TASKS_PER_OWNER) {
    audit(storage, "miniapp.bench.schedule", ownerId, "denied", "task cap");
    return fail(400, "Scheduled task limit reached.");
  }
  const id = storage.createTask({
    name: BENCH_TASK_NAME,
    cronExpr: source,
    timezone: SCHED_TZ,
    actionJson: JSON.stringify({ type: "tool", tool: "run_bench", input: { mode: "offline" } }),
    createdByUserId: ownerId,
    nextRunAtMs: slot,
    enabled: true,
  });
  audit(storage, "miniapp.bench.schedule", ownerId, "success", `created id=${id} cron=${source}`);
  return ok({ id, enabled: true, cron: source, ...(cadence !== undefined ? { cadence } : {}) });
}

function alertLabel(key: string): string {
  if (key === "bench-worker-failures") return "Consecutive benchmark run failures";
  if (key === "bench-worker-skip:live") return "Live benchmark run skipped";
  if (key.startsWith("regression:")) return `Quality regression warning (${key.slice("regression:".length)})`;
  return key;
}

/**
 * bench.alerts — recent quality alerts. The bench history keeps only the
 * dedupe state (key → last_sent_ms); there is no stored alert body, so this
 * surfaces the alert keys with friendly labels and timestamps.
 */
function handleBenchAlerts(deps: ManageApiDeps): Response {
  let rows: Array<{ key: string; last_sent_ms: number }> = [];
  try {
    const db = new Database(dbPathFor(deps), { readonly: true });
    try {
      rows = db
        .query<{ key: string; last_sent_ms: number }, []>(
          `SELECT key, last_sent_ms FROM bench_alerts ORDER BY last_sent_ms DESC LIMIT 20`,
        )
        .all();
    } finally {
      db.close();
    }
  } catch {
    rows = [];
  }
  return ok({
    alerts: rows.map((r) => ({ key: r.key, label: alertLabel(r.key), lastSentMs: r.last_sent_ms })),
  });
}

// ----------------------------------------------- schedulers + digest -------

function handleSchedulersList(storage: Storage, ownerId: string): Response {
  const schedulers = storage.listTasks(ownerId, 200).map((t) => {
    const s: Record<string, unknown> = {
      id: t.id,
      name: t.name,
      enabled: t.enabled,
      cron: t.cronExpr,
      timezone: t.timezone,
      nextRunAtMs: t.nextRunAtMs,
      runCount: t.runCount,
    };
    if (t.lastRunAtMs !== undefined) s["lastRunAtMs"] = t.lastRunAtMs;
    if (t.lastStatus !== undefined) s["lastStatus"] = t.lastStatus;
    return s;
  });
  return ok({ schedulers });
}

function handleSchedulersToggle(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  const id = asInt(body["id"]);
  const enabled = asBool(body["enabled"]);
  if (id === undefined || id < 1 || enabled === undefined) {
    return fail(400, "Invalid input.");
  }
  const task = storage.listTasks(ownerId, 200).find((t) => t.id === id);
  if (task === undefined) {
    return fail(404, "Scheduler not found.");
  }
  if (!storage.updateTask(ownerId, id, { enabled })) {
    audit(storage, "miniapp.schedulers.toggle", ownerId, "error", `toggle failed id=${id}`);
    return fail(500, "An internal error occurred.");
  }
  audit(storage, "miniapp.schedulers.toggle", ownerId, "success", `id=${id} enabled=${enabled}`);
  return ok({ id, enabled });
}

async function handleDigestPreview(deps: ManageApiDeps, ownerId: string): Promise<Response> {
  try {
    const sections = await buildDigest({
      storage: deps.storage,
      proposalStore: proposalStoreFor(deps),
      userId: ownerId,
      log: () => {},
    });
    return ok({ text: formatDigest(sections) });
  } catch {
    return fail(500, "An internal error occurred.");
  }
}

function digestTimeOf(cron: string): string | null {
  const m = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/u.exec(cron);
  if (m === null) return null;
  return `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
}

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
    // not JSON or wrong shape
  }
  return null;
}

function handleDigestConfig(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  const hasPrompt = body["prompt"] !== undefined;
  const hasChatId = body["chatId"] !== undefined;
  const hasEnabled = body["enabled"] !== undefined;
  const hasTime = body["time"] !== undefined || body["cron"] !== undefined;
  if (!hasPrompt && !hasChatId && !hasEnabled && !hasTime) {
    return digestConfigGet(storage, ownerId);
  }
  return digestConfigSet(storage, ownerId, body, { hasPrompt, hasChatId, hasEnabled, hasTime });
}

/**
 * GET view: the row is OWNED by Telegram's /blueprint (fixed task name);
 * the Mini App surfaces that ownership and edits only the row's content
 * through the same storage store /blueprint writes.
 */
function digestConfigGet(storage: Storage, ownerId: string): Response {
  const task = ownerTask(storage, ownerId, DIGEST_TASK_NAME);
  if (task === undefined) {
    return ok({ exists: false, enabled: false, blueprint: "morning_digest", ownedBy: "blueprint" });
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
    defaultChatId: ownerId,
    isDefaultDestination: action !== null && action.chatId === ownerId,
  };
  if (task.lastRunAtMs !== undefined) out["lastRunAtMs"] = task.lastRunAtMs;
  if (task.lastStatus !== undefined) out["lastStatus"] = task.lastStatus;
  return ok(out);
}

function digestConfigSet(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
  which: { hasPrompt: boolean; hasChatId: boolean; hasEnabled: boolean; hasTime: boolean },
): Response {
  const task = ownerTask(storage, ownerId, DIGEST_TASK_NAME);
  if (task === undefined) {
    audit(storage, "miniapp.digest.config", ownerId, "denied", "no digest task");
    return fail(400, "No scheduled morning digest.");
  }
  const out: Record<string, unknown> = { id: task.id };

  if (which.hasEnabled || which.hasTime) {
    const r = setDigestScheduler(storage, ownerId, task, body);
    if (r instanceof Response) return r;
    Object.assign(out, r);
  }

  if (which.hasPrompt || which.hasChatId) {
    const action = readDigestAgentAction(task);
    if (action === null) {
      audit(storage, "miniapp.digest.config", ownerId, "denied", "non-agent action");
      return fail(400, "This task has no agent action; check via Telegram.");
    }
    let prompt = action.prompt;
    let chatId = action.chatId;
    if (which.hasPrompt) {
      const p = body["prompt"];
      if (typeof p !== "string" || p.trim().length === 0 || p.length > 4000) {
        audit(storage, "miniapp.digest.config", ownerId, "denied", "bad prompt");
        return fail(400, "Prompt must be 1–4000 characters.");
      }
      prompt = p;
    }
    if (which.hasChatId) {
      const c = body["chatId"];
      if (typeof c !== "string" || !CHAT_ID_RE.test(c.trim())) {
        audit(storage, "miniapp.digest.config", ownerId, "denied", "bad chatId");
        return fail(400, "Invalid chat id.");
      }
      chatId = c.trim();
    }
    let actionJson: string;
    try {
      actionJson = serializeTaskAction(parseTaskAction({ type: "agent", chatId, prompt }));
    } catch {
      audit(storage, "miniapp.digest.config", ownerId, "denied", "action validation failed");
      return fail(400, "Invalid input.");
    }
    if (!storage.updateTask(ownerId, task.id, { actionJson })) {
      audit(storage, "miniapp.digest.config", ownerId, "error", `update failed id=${task.id}`);
      return fail(500, "An internal error occurred.");
    }
    audit(storage, "miniapp.digest.config", ownerId, "success", `content updated id=${task.id}`);
    out["prompt"] = prompt;
    out["chatId"] = chatId;
    out["isCustomPrompt"] = prompt !== DIGEST_PROMPT;
    out["isDefaultDestination"] = chatId === ownerId;
  }

  return ok(out);
}

/** Digest on/off/time: mirrors the dashboard's digest scheduler semantics. */
function setDigestScheduler(
  storage: Storage,
  ownerId: string,
  task: ScheduledTaskRecord,
  body: Record<string, unknown>,
): Record<string, unknown> | Response {
  const enabled = asBool(body["enabled"]);
  if (enabled === false) {
    if (task.enabled) storage.updateTask(ownerId, task.id, { enabled: false });
    audit(storage, "miniapp.digest.config", ownerId, "success", `disabled id=${task.id}`);
    return { enabled: false };
  }

  const customCronRaw = body["cron"];
  const hasCustomCron = typeof customCronRaw === "string" && customCronRaw.trim() !== "";
  let cron: string;
  let custom = false;
  if (hasCustomCron) {
    const v = validateCustomCron(customCronRaw, MIN_DIGEST_CRON_GAP_MS);
    if (!v.ok) {
      audit(storage, "miniapp.digest.config", ownerId, "denied", `bad cron (${v.reason})`);
      return fail(
        400,
        v.reason === "too_frequent"
          ? "Schedule too frequent; digest at most every 15 minutes."
          : "Invalid cron expression.",
      );
    }
    cron = v.source;
    custom = true;
  } else {
    const timeRaw = body["time"];
    const timeValid =
      typeof timeRaw === "string" && DIGEST_TIME_RE.test(timeRaw) ? timeRaw : undefined;
    if (timeRaw !== undefined && timeValid === undefined) {
      audit(storage, "miniapp.digest.config", ownerId, "denied", "bad time");
      return fail(400, "Invalid time (HH:MM format).");
    }
    cron =
      timeValid === undefined
        ? task.cronExpr
        : `${Number(timeValid.slice(3, 5))} ${Number(timeValid.slice(0, 2))} * * *`;
  }

  let source: string;
  let slot: number;
  try {
    source = parseCron(cron).source;
    slot = nextSlotAfterNow(cron);
  } catch {
    audit(storage, "miniapp.digest.config", ownerId, "denied", "bad cron");
    return fail(400, "Invalid cron expression.");
  }
  if (!storage.updateTask(ownerId, task.id, { cronExpr: source, enabled: true, nextRunAtMs: slot })) {
    audit(storage, "miniapp.digest.config", ownerId, "error", `update failed id=${task.id}`);
    return fail(500, "An internal error occurred.");
  }
  const timeOut = digestTimeOf(source);
  audit(storage, "miniapp.digest.config", ownerId, "success", `updated id=${task.id} cron=${source}`);
  return { enabled: true, time: timeOut, ...(custom ? { custom: true, cron: source } : {}) };
}

// ------------------------------------------------- group digests -----------

function digestTaskCalls(storage: Storage, ownerId: string): DigestTaskCalls {
  return {
    list: async () =>
      storage.listTasks(ownerId, 200).map((t) => ({ id: t.id, name: t.name })),
    create: async (args) => {
      if (storage.countTasks(ownerId) >= 200) {
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

const GROUP_CFG_PREFIX = assistantConfigKey("");
const MOD_CFG_PREFIX = modConfigKey("");

function groupDigestView(
  storage: Storage,
  ownerId: string,
  chatId: string,
): Record<string, unknown> {
  const cfg = getAssistantConfig(storage, ownerId, chatId);
  const tasks = storage.listTasks(ownerId, 200);
  const task = tasks.find((t) => t.name === digestTaskName(chatId));
  const taskOut: Record<string, unknown> = { exists: task !== undefined, enabled: false };
  if (task !== undefined) {
    taskOut["enabled"] = task.enabled;
    taskOut["cron"] = task.cronExpr;
    taskOut["nextRunAtMs"] = task.nextRunAtMs;
    if (task.lastRunAtMs !== undefined) taskOut["lastRunAtMs"] = task.lastRunAtMs;
    if (task.lastStatus !== undefined) taskOut["lastStatus"] = task.lastStatus;
  }
  return {
    chatId,
    assistantEnabled: cfg.enabled,
    digestEnabled: cfg.digestEnabled,
    digestTime: cfg.digestTime,
    task: taskOut,
  };
}

function handleGroupDigestsList(storage: Storage, ownerId: string): Response {
  const groups: Array<Record<string, unknown>> = [];
  for (const key of storage.listUserPrefKeys(ownerId, GROUP_CFG_PREFIX)) {
    const chatId = key.slice(GROUP_CFG_PREFIX.length);
    if (!CHAT_ID_RE.test(chatId)) continue;
    groups.push(groupDigestView(storage, ownerId, chatId));
  }
  return ok({ groups });
}

async function handleGroupDigestSet(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const chatRaw = body["chatId"];
  if (typeof chatRaw !== "string" || !CHAT_ID_RE.test(chatRaw.trim())) {
    audit(storage, "miniapp.group_digest", ownerId, "denied", "bad chatId");
    return fail(400, "Invalid group id.");
  }
  const chatId = chatRaw.trim();
  const enabled = asBool(body["digestEnabled"]);
  if (enabled === undefined) {
    audit(storage, "miniapp.group_digest", ownerId, "denied", "bad digestEnabled");
    return fail(400, "Invalid input.");
  }
  const timeRaw = body["time"];
  const time = timeRaw === undefined ? undefined : validateDigestTime(timeRaw);
  if (time !== undefined && !time.ok) {
    audit(storage, "miniapp.group_digest", ownerId, "denied", "bad time");
    return fail(400, "Invalid time (HH:MM format).");
  }
  const cfg = getAssistantConfig(storage, ownerId, chatId);
  const calls = digestTaskCalls(storage, ownerId);

  if (!enabled) {
    const res = setAssistantConfig(storage, ownerId, chatId, { digestEnabled: false });
    if (!res.ok) {
      audit(storage, "miniapp.group_digest", ownerId, "error", `off config failed chat=${chatId}`);
      return fail(400, "Invalid input.");
    }
    await cancelGroupDigestTask(calls, chatId);
    audit(storage, "miniapp.group_digest", ownerId, "success", `off chat=${chatId}`);
    return ok({ chatId, digestEnabled: false });
  }

  if (!cfg.enabled) {
    audit(storage, "miniapp.group_digest", ownerId, "denied", `on without mode chat=${chatId}`);
    return fail(400, "Enable group assistant mode first.");
  }
  let finalTime = cfg.digestTime;
  if (time !== undefined) {
    const res = setAssistantConfig(storage, ownerId, chatId, { digestTime: time.time });
    if (!res.ok) {
      audit(storage, "miniapp.group_digest", ownerId, "error", `time config failed chat=${chatId}`);
      return fail(400, "Invalid input.");
    }
    finalTime = res.config.digestTime;
  }
  // Create the task BEFORE flipping the config: a failed schedule must not
  // leave the config claiming a digest that will never fire.
  let id: number | undefined;
  try {
    id = await ensureGroupDigestTask(calls, chatId, finalTime);
  } catch {
    id = undefined;
  }
  if (id === undefined) {
    audit(storage, "miniapp.group_digest", ownerId, "error", `schedule failed chat=${chatId}`);
    return fail(500, "Failed to create the schedule.");
  }
  if (!cfg.digestEnabled) {
    const res = setAssistantConfig(storage, ownerId, chatId, { digestEnabled: true });
    if (!res.ok) {
      await cancelGroupDigestTask(calls, chatId);
      audit(storage, "miniapp.group_digest", ownerId, "error", `on config failed chat=${chatId}`);
      return fail(500, "An internal error occurred.");
    }
  }
  audit(storage, "miniapp.group_digest", ownerId, "success", `on chat=${chatId} time=${finalTime} id=${id}`);
  return ok({ chatId, digestEnabled: true, time: finalTime, taskId: id });
}

// ------------------------------------------------------------ skills -------

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function skillTrusted(storage: Storage, name: string): boolean {
  const prov = storage.getSkillInstallProvenance(name);
  const keyId = prov?.keyId;
  return keyId != null && storage.getTrustedSkillPublisher(keyId) !== undefined;
}

function handleSkillsList(deps: ManageApiDeps, storage: Storage): Response {
  const dir = skillsDirFor(deps);
  const skills = listInstalledSkillNames(dir).map((s) => {
    const read = readInstalledSkill(dir, s.name);
    const out: Record<string, unknown> = {
      name: s.name,
      enabled: s.enabled,
      trusted: skillTrusted(storage, s.name),
    };
    if (read?.skill.version !== undefined) out["version"] = read.skill.version;
    return out;
  });
  return ok({ skills });
}

function validSkillName(raw: unknown): string | undefined {
  const name = asString(raw);
  if (name === undefined || !SKILL_NAME_RE.test(name)) return undefined;
  return name;
}

function handleSkillsToggle(deps: ManageApiDeps, ownerId: string, body: Record<string, unknown>): Response {
  const name = validSkillName(body["name"]);
  const enabled = asBool(body["enabled"]);
  if (name === undefined || enabled === undefined) {
    return fail(400, "Invalid input.");
  }
  const status = setSkillEnabled(skillsDirFor(deps), name, enabled);
  if (status === "missing") return fail(404, "Skill not found.");
  audit(deps.storage, "miniapp.skills.toggle", ownerId, "success", `name=${name} enabled=${enabled}`);
  return ok({ name, enabled: status === "enabled" });
}

function installErrorFa(kind: string): string {
  switch (kind) {
    case "too_large":
      return "Skill file is too large.";
    case "parse":
      return "Skill file is invalid (format or metadata).";
    case "collision":
      return "A skill with this name already exists.";
    case "limit":
      return "Skill limit reached.";
    default:
      return "Skill installation failed.";
  }
}

/**
 * skills.install — `{ source }` where source is raw markdown text or an
 * http(s) URL. Runs the phase-3 install pipeline (prepareSkillInstall) and
 * returns the review card data WITHOUT writing anything. With
 * `{ confirm: true }` the file is written DISABLED (like the chat flow's
 * disabled-by-default install) after re-validating.
 */
async function handleSkillInstall(deps: ManageApiDeps, ownerId: string, body: Record<string, unknown>): Promise<Response> {
  const sourceRaw = asString(body["source"]);
  if (sourceRaw === undefined || sourceRaw.trim() === "") {
    return fail(400, "Specify the skill source (text or URL).");
  }
  const source = sourceRaw.trim();
  const dir = skillsDirFor(deps);

  let text: string;
  let sourceLabel: string;
  if (/^https?:\/\//i.test(source)) {
    sourceLabel = source;
    try {
      const res = await createPinnedSkillFetcher()(source);
      text = res.text;
    } catch {
      return fail(400, "Failed to fetch the skill from the URL.");
    }
  } else {
    text = source;
    sourceLabel = "text";
  }

  const plan = prepareSkillInstall({ text, source: sourceLabel, dir });
  if (!plan.ok) {
    return fail(400, installErrorFa(plan.error.kind));
  }
  const v = plan.validated;
  const review: Record<string, unknown> = {
    name: v.skill.name,
    source: sourceLabel,
    sizeBytes: v.sizeBytes,
    replace: v.replace,
    warnings: v.warnings.map((w) => ({ kind: w.kind, detail: w.detail, snippet: w.snippet })),
  };
  if (v.skill.version !== undefined) review["version"] = v.skill.version;
  if (v.skill.description !== undefined) review["description"] = v.skill.description;

  if (asBool(body["confirm"]) !== true) {
    return json(200, { ok: true, review, needsConfirm: true });
  }
  // Re-run with replace confirmed when it collides (same as the chat flow).
  const finalPlan = v.replace
    ? prepareSkillInstall({ text, source: sourceLabel, dir, allowReplace: true })
    : plan;
  if (!finalPlan.ok) return fail(400, installErrorFa(finalPlan.error.kind));
  try {
    writeSkillFile(dir, finalPlan.validated);
  } catch {
    return fail(500, "An internal error occurred.");
  }
  audit(deps.storage, "miniapp.skills.install", ownerId, "success", `name=${finalPlan.validated.skill.name}`);
  return ok({ installed: true, name: finalPlan.validated.skill.name, enabled: false });
}

function handleSkillUninstall(deps: ManageApiDeps, ownerId: string, body: Record<string, unknown>): Response {
  const name = validSkillName(body["name"]);
  if (name === undefined) return fail(400, "Invalid input.");
  if (asBool(body["confirm"]) !== true) {
    return json(200, { needsConfirm: true, name });
  }
  const removed = uninstallSkillFile(skillsDirFor(deps), name);
  if (!removed) return fail(404, "Skill not found.");
  audit(deps.storage, "miniapp.skills.uninstall", ownerId, "success", `name=${name}`);
  return ok({ name, removed: true });
}

// ------------------------------------------------------------ trust --------

function handleTrustList(storage: Storage): Response {
  const publishers = storage.listTrustedSkillPublishers().map((r) => ({
    keyId: r.keyId,
    shortKeyId: shortKeyId(r.keyId),
    label: r.label,
    addedAtMs: r.addedAtMs,
  }));
  return ok({ publishers });
}

function parsePublisher(raw: unknown): { keyId: string; publicKeyB64: string } | undefined {
  const input = asString(raw);
  if (input === undefined || input.trim() === "") return undefined;
  const parsed = parsePublisherInput(input);
  if (parsed.kind === "invalid") return undefined;
  if (parsed.kind === "key_id") {
    const keyId = input.trim().replace(/\s+/g, "").toLowerCase();
    return { keyId, publicKeyB64: "" };
  }
  const keyId = fingerprintPublicKey(parsed.publicKeyB64);
  return { keyId, publicKeyB64: parsed.publicKeyB64 };
}

function handleTrustAdd(storage: Storage, body: Record<string, unknown>): Response {
  const parsed = parsePublisher(body["publisher"]);
  if (parsed === undefined) {
    return fail(400, "Invalid publisher id (64-char fingerprint or public key).");
  }
  const labelRaw = asString(body["label"]);
  const label = labelRaw !== undefined && labelRaw.trim() !== "" ? labelRaw.trim().slice(0, 64) : shortKeyId(parsed.keyId);
  const { added } = storage.trustSkillPublisher({
    keyId: parsed.keyId,
    label,
    publicKey: parsed.publicKeyB64,
  });
  return ok({ keyId: parsed.keyId, label, added });
}

function handleTrustRemove(storage: Storage, body: Record<string, unknown>): Response {
  const parsed = parsePublisher(body["publisher"]);
  if (parsed === undefined) {
    return fail(400, "Invalid publisher id.");
  }
  if (asBool(body["confirm"]) !== true) {
    return json(200, { needsConfirm: true, keyId: parsed.keyId });
  }
  const removed = storage.untrustSkillPublisher(parsed.keyId);
  if (!removed) return fail(404, "Publisher is not in the trust list.");
  return ok({ keyId: parsed.keyId, removed: true });
}

// ------------------------------------------------------------ usage --------

function handleUsageReport(storage: Storage, body: Record<string, unknown>): Response {
  const daysRaw = asInt(body["days"]);
  const days = daysRaw === undefined ? 7 : Math.min(Math.max(daysRaw, 1), 90);
  const tracker = new UsageTracker(storage);
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const totals = tracker.totalsAll(sinceMs);
  const byModel = tracker.byModelAll(sinceMs).slice(0, 10);
  return ok({
    days,
    runs: totals.runs,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    estimatedUsd: totals.estimatedUsd,
    byModel: byModel.map((m) => ({
      modelId: m.modelId,
      runs: m.runs,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      estimatedUsd: m.estimatedUsd,
    })),
  });
}

// ------------------------------------------------ reminders/tasks/goals ----

function handleTasksList(storage: Storage, ownerId: string): Response {
  const reminders = storage.listReminders(ownerId, 50).map((r) => ({
    id: r.id,
    kind: "reminder",
    text: r.text,
    dueAtMs: r.dueAt,
    repeat: r.repeat,
    state: r.state,
  }));
  const tasks = storage.listTasks(ownerId, 100).map((t) => ({
    id: t.id,
    kind: "task",
    name: t.name,
    enabled: t.enabled,
    cron: t.cronExpr,
    nextRunAtMs: t.nextRunAtMs,
  }));
  const goals = storage.listGoals(ownerId, "active", 50).map((g) => ({
    id: g.id,
    kind: "goal",
    title: g.title,
    status: g.status,
    ...(g.description !== undefined ? { description: g.description } : {}),
  }));
  return ok({ reminders, tasks, goals });
}

const TASK_KINDS = ["reminder", "task", "goal"] as const;

function handleTasksComplete(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  const kind = asString(body["kind"]);
  const id = asInt(body["id"]);
  if (kind === undefined || !TASK_KINDS.includes(kind as (typeof TASK_KINDS)[number]) || id === undefined || id < 1) {
    return fail(400, "Invalid input.");
  }
  if (kind === "goal") {
    if (!storage.completeGoal(ownerId, id)) return fail(404, "Goal not found.");
    audit(storage, "miniapp.tasks.complete", ownerId, "success", `goal id=${id}`);
    return ok({ kind, id });
  }
  if (kind === "reminder") {
    // A reminder has no "done" state; the owner-facing completion is
    // dismissing it (the same transition the cancel tool performs).
    if (!storage.cancelReminder(ownerId, id)) return fail(404, "Reminder not found.");
    audit(storage, "miniapp.tasks.complete", ownerId, "success", `reminder id=${id}`);
    return ok({ kind, id });
  }
  return fail(400, "This operation is not supported for scheduled tasks.");
}

function handleTasksCancel(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  const kind = asString(body["kind"]);
  const id = asInt(body["id"]);
  if (kind === undefined || !TASK_KINDS.includes(kind as (typeof TASK_KINDS)[number]) || id === undefined || id < 1) {
    return fail(400, "Invalid input.");
  }
  if (kind === "reminder") {
    if (!storage.cancelReminder(ownerId, id)) return fail(404, "Reminder not found.");
    audit(storage, "miniapp.tasks.cancel", ownerId, "success", `reminder id=${id}`);
    return ok({ kind, id });
  }
  if (kind === "task") {
    const task = storage.listTasks(ownerId, 200).find((t) => t.id === id);
    if (task === undefined) return fail(404, "Task not found.");
    if (asBool(body["confirm"]) !== true) {
      return json(200, { needsConfirm: true, kind, id, name: task.name });
    }
    if (!storage.deleteTask(ownerId, id)) return fail(500, "An internal error occurred.");
    audit(storage, "miniapp.tasks.cancel", ownerId, "success", `task id=${id} name=${task.name}`);
    return ok({ kind, id });
  }
  // Goals have no delete in storage (completeGoal only).
  return fail(400, "Deleting goals is not supported; you can complete it.");
}

// ------------------------------------------------------------ groups -------

function knownGroupChatIds(storage: Storage, ownerId: string): string[] {
  const ids = new Set<string>();
  for (const prefix of [GROUP_CFG_PREFIX, MOD_CFG_PREFIX]) {
    for (const key of storage.listUserPrefKeys(ownerId, prefix)) {
      const chatId = key.slice(prefix.length);
      if (CHAT_ID_RE.test(chatId)) ids.add(chatId);
    }
  }
  return [...ids];
}

function handleGroupsList(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const limit = clampLimit(body["limit"], 50, 200);
  const q = (asString(body["q"]) ?? "").toLowerCase();
  const groups = knownGroupChatIds(storage, ownerId)
    .filter((id) => q === "" || id.includes(q))
    .slice(0, limit)
    .map((chatId) => {
      const assistant = getAssistantConfig(storage, ownerId, chatId);
      const moderation = getModConfig(storage, ownerId, chatId);
      return {
        chatId,
        assistantEnabled: assistant.enabled,
        digestEnabled: assistant.digestEnabled,
        moderationEnabled: moderation.enabled,
      };
    });
  return ok({ groups });
}

function validGroupId(raw: unknown): string | undefined {
  const id = asString(raw);
  if (id === undefined || !CHAT_ID_RE.test(id.trim())) return undefined;
  return id.trim();
}

function handleGroupAssistantGet(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const groupId = validGroupId(body["groupId"]);
  if (groupId === undefined) return fail(400, "Invalid group id.");
  const config = getAssistantConfig(storage, ownerId, groupId);
  return ok({ groupId, config });
}

/**
 * groups.assistant.set — `{ groupId, enabled, smart? }`. `smart` maps to
 * the `smartSummary` opt-in (the LLM summary layer, off by default).
 */
function handleGroupAssistantSet(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  const groupId = validGroupId(body["groupId"]);
  const enabled = asBool(body["enabled"]);
  if (groupId === undefined || enabled === undefined) {
    return fail(400, "Invalid input.");
  }
  const patch: Record<string, unknown> = { enabled };
  const smart = asBool(body["smart"]);
  if (smart !== undefined) patch["smartSummary"] = smart;
  const res = setAssistantConfig(storage, ownerId, groupId, patch);
  if (!res.ok) {
    audit(storage, "miniapp.groups.assistant", ownerId, "denied", `chat=${groupId} ${res.errors[0] ?? ""}`);
    return fail(400, "Invalid input.");
  }
  audit(storage, "miniapp.groups.assistant", ownerId, "success", `chat=${groupId} enabled=${enabled}`);
  return ok({ groupId, config: res.config });
}

function handleGroupDigestGet(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const groupId = validGroupId(body["groupId"]);
  if (groupId === undefined) return fail(400, "Invalid group id.");
  return ok(groupDigestView(storage, ownerId, groupId));
}

// --------------------------------------------------------- moderation ------

function handleModerationGet(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const groupId = validGroupId(body["groupId"]);
  if (groupId === undefined) return fail(400, "Invalid group id.");
  return ok({ groupId, config: getModConfig(storage, ownerId, groupId) });
}

/**
 * moderation.set — `{ groupId, ...patch }`. Only the fields the moderation
 * service supports are accepted (validateModConfig rejects unknown fields);
 * numeric fields are integer-bounded by the validator.
 */
function handleModerationSet(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  const groupId = validGroupId(body["groupId"]);
  if (groupId === undefined) return fail(400, "Invalid group id.");
  const patch: Record<string, unknown> = {};
  for (const key of ["enabled", "antiSpam", "linkPolicy", "profanityFilter", "floodWindowSec", "floodMaxMessages"]) {
    const v = body[key];
    if (v !== undefined) patch[key] = v;
  }
  if (Object.keys(patch).length === 0) {
    return fail(400, "No fields specified to change.");
  }
  const res = setModConfig(storage, ownerId, groupId, patch);
  if (!res.ok) {
    audit(storage, "miniapp.moderation.set", ownerId, "denied", `chat=${groupId}`);
    return fail(400, "Invalid input.");
  }
  audit(storage, "miniapp.moderation.set", ownerId, "success", `chat=${groupId}`);
  return ok({ groupId, config: res.config });
}
