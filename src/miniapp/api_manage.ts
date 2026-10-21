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
import { processEnv } from "../config/env";
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
import { nextSlotAfterNow, parseCron, validateCustomCron } from "../scheduler/cron";
import {
  assistantConfigKey,
  getAssistantConfig,
  setAssistantConfig,
} from "../groups/assistant";
import { getModConfig, modConfigKey, setModConfig } from "../moderation/config";
import { buildDigest, formatDigest } from "../digest/builder";
import { DigestSchedulingService } from "../digest/scheduling";
import { UsageTracker, getByProvider, getDailyBreakdown, getLatencyStats } from "../ai/usage";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkerSnapshot } from "../bench/worker";
import type { MemoryIndexState } from "../memory/semantic";
import type { ToolManifest } from "../tools/types";

// ------------------------------------------------------------ deps ----------

/**
 * Wiring supplied by the Mini App router (src/miniapp/api.ts). Everything
 * has an env default so the router only needs to pass `storage`.
 */
export interface ManageApiDeps {
  storage: Storage;
  /** Skills directory. Default: SKILLS_DIR env or "./skills". */
  skillsDir?: string;
  /** Legacy field, kept for caller compatibility; stores now share deps.storage's handle (phase 6). */
  dbPath?: string;
  /** Test/env overrides; default to TELEGRAM_BOT_TOKEN / OWNER_TELEGRAM_ID. */
  botToken?: string;
  ownerId?: string;
  /** Injectable stores so tests never touch the real database. */
  proposalStore?: ProposalStore;
  benchHistory?: BenchHistory;
  /**
   * Semantic memory index (platform Phase 10): memory.list/search add
   * its health as `embedding` — the field the retired web dashboard's
   * memory endpoint exposed. Optional; best-effort when present.
   */
  semantic?: SemanticIndexSource;
  /**
   * Live bench-worker progress source for `bench.live` (platform Phase 10 —
   * the polling replacement for the retired web dashboard's SSE stream).
   * Optional: without it the action answers 503.
   */
  benchWorker?: BenchLiveSource;
  /**
   * The owner's tool desk (platform Phase 10): the live registry view +
   * enable/disable control behind `desk.list` / `desk.toggle`. Optional:
   * without it both actions answer 503. Wired by bootstrap to the real
   * ToolRegistry; the toggle persists through the wiring, not storage here.
   */
  desk?: DeskControl;
}

/** The semantic index's owner-visible health reader. */
export interface SemanticIndexSource {
  indexState(userId: string): Promise<MemoryIndexState>;
}

/** Minimal live-progress surface of the daemon BenchWorker. */
export interface BenchLiveSource {
  snapshot(): WorkerSnapshot;
}

/** One tool as the owner's desk view shows it: the card + live state. */
export interface DeskToolView {
  name: string;
  description: string;
  /** Effective enabled state (the tool's flag AND the owner's override). */
  enabled: boolean;
  ownerOnly: boolean;
  offDesk: boolean;
  toolset?: string;
  /** The exact desk card the model sees, when the tool carries one. */
  manifest?: ToolManifest;
}

/**
 * The desk control surface the wiring supplies: reads and flips the LIVE
 * registry, so a toggle takes effect on the very next turn.
 */
export interface DeskControl {
  listTools(): DeskToolView[];
  /** Returns false for an unknown tool name (nothing changed). */
  setToolEnabled(name: string, enabled: boolean): boolean;
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
const MODE_MODEL_RE = /^[A-Za-z0-9_.\-/]{1,64}$/;
const BENCH_TASK_ID_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;
const SCHED_TZ = "Asia/Tehran";

/** Task names owned by the bench scheduler and the /blueprint digest. */
const BENCH_TASK_NAME = "bench: scheduled run";

const MIN_BENCH_CRON_GAP_MS = 60 * 60 * 1000;

const BENCH_CADENCES: Readonly<Record<string, string>> = {
  daily: "0 3 * * *",
  weekly: "0 3 * * 0",
  monthly: "0 3 1 * *",
};

// ------------------------------------------------------------ auth ----------

/** Owner id from initData, or undefined on any auth failure (reason hidden). */
function authOwner(deps: ManageApiDeps, body: Record<string, unknown>): string | undefined {
  const initData = asString(body["initData"]) ?? "";
  const botToken = (deps.botToken ?? processEnv().TELEGRAM_BOT_TOKEN ?? "").trim();
  const ownerId = (deps.ownerId ?? processEnv().OWNER_TELEGRAM_ID ?? "").trim();
  if (initData === "" || botToken === "" || ownerId === "") return undefined;
  const v = validateInitData(initData, botToken, ownerId);
  return v.ok ? v.userId : undefined;
}

// ------------------------------------------------------------ stores --------

function proposalStoreFor(deps: ManageApiDeps): ProposalStore {
  // Phase 6: satellite stores share the platform's one Database handle
  // (via deps.storage) instead of opening a parallel connection.
  return deps.proposalStore ?? new ProposalStore(deps.storage.database);
}

function benchHistoryFor(deps: ManageApiDeps): BenchHistory {
  if (deps.benchHistory !== undefined) return deps.benchHistory;
  return new BenchHistory(deps.storage.database);
}

function skillsDirFor(deps: ManageApiDeps): string {
  return (deps.skillsDir ?? processEnv().SKILLS_DIR ?? "").trim() || "./skills";
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
    storage.access.appendAudit({ operation, outcome, actorId, detail });
  } catch {
    // ignore
  }
}

function ownerTask(storage: Storage, ownerId: string, name: string): ScheduledTaskRecord | undefined {
  return storage.scheduling.listTasks(ownerId, 200).find((t) => t.name === name);
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
      case "users.mute":
        return handleUserMute(storage, ownerId, body);
      case "users.unmute":
        return handleUserUnmute(storage, ownerId, body);
      // memory + curator + events
      case "memory.search":
        return handleMemorySearch(deps, ownerId, body);
      case "memory.list":
        return handleMemoryList(deps, ownerId, body);
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
      case "bench.live":
        return handleBenchLive(deps);
      case "bench.report":
        return handleBenchReport(body);
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
      case "usage.daily":
        return handleUsageDaily(storage, body);
      case "usage.byProvider":
        return handleUsageByProvider(storage, body);
      case "usage.latency":
        return handleUsageLatency(storage, body);
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
      // tool desk (owner's view of the model's desk + enable/disable)
      case "desk.list":
        return handleDeskList(deps);
      case "desk.toggle":
        return handleDeskToggle(deps, ownerId, body);
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
    for (const r of storage.access.listUsersByState(state, USER_SCAN_CAP, 0)) {
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

function handleUserMute(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const id = validTargetId(body["id"], ownerId);
  if (id === undefined) {
    audit(storage, "miniapp.users.mute", ownerId, "denied", "bad id");
    return fail(400, "Invalid user id.");
  }
  const r = new UserAccessService(storage).mute(id, ownerId);
  if (!r.ok) {
    audit(storage, "miniapp.users.mute", ownerId, "error", `failed id=${id}`);
    return fail(500, "An internal error occurred.");
  }
  audit(storage, "miniapp.users.mute", ownerId, "success", `id=${id} prev=${r.previous ?? "?"}`);
  return ok({ userId: id, state: "revoked" });
}

function handleUserUnmute(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const id = validTargetId(body["id"], ownerId);
  if (id === undefined) {
    audit(storage, "miniapp.users.unmute", ownerId, "denied", "bad id");
    return fail(400, "Invalid user id.");
  }
  const r = new UserAccessService(storage).unmute(id, ownerId);
  if (!r.ok) {
    audit(storage, "miniapp.users.unmute", ownerId, "error", `failed id=${id}`);
    return fail(500, "An internal error occurred.");
  }
  audit(storage, "miniapp.users.unmute", ownerId, "success", `id=${id} prev=${r.previous ?? "?"}`);
  return ok({ userId: id, state: "approved" });
}

// ------------------------------------------------ memory / curator / events

const MAX_MEMORY_LIST = 200;

function memoryJson(m: StoredMemory): Record<string, unknown> {
  return { key: m.key, content: m.content, createdAt: m.createdAt, updatedAt: m.updatedAt };
}

async function handleMemorySearch(deps: ManageApiDeps, ownerId: string, body: Record<string, unknown>): Promise<Response> {
  const provider = memoryProviderFor(deps.storage);
  if (provider === undefined) return fail(503, "Memory service is unavailable.");
  const limit = clampLimit(body["limit"], 50, MAX_MEMORY_LIST);
  const q = (asString(body["q"]) ?? "").slice(0, 64).toLowerCase();
  return memoryQuery(provider, ownerId, q, limit, 0, deps.semantic);
}

async function handleMemoryList(deps: ManageApiDeps, ownerId: string, body: Record<string, unknown>): Promise<Response> {
  const provider = memoryProviderFor(deps.storage);
  if (provider === undefined) return fail(503, "Memory service is unavailable.");
  const limit = clampLimit(body["limit"], 50, MAX_MEMORY_LIST);
  const offsetRaw = asInt(body["offset"]);
  const offset = offsetRaw === undefined ? 0 : Math.max(offsetRaw, 0);
  return memoryQuery(provider, ownerId, "", limit, offset, deps.semantic);
}

async function memoryQuery(
  provider: MemoryProvider,
  ownerId: string,
  q: string,
  limit: number,
  offset: number,
  semantic?: SemanticIndexSource,
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
  // Owner-visible vector-index health (counts + live model id, never
  // memory content). Best-effort: a failing index must never break the
  // listing itself. (The retired web dashboard exposed this as
  // `embedding`; platform Phase 10 keeps the field on this surface.)
  let embedding: MemoryIndexState | undefined;
  if (semantic !== undefined) {
    try {
      embedding = await semantic.indexState(ownerId);
    } catch {
      embedding = undefined;
    }
  }
  return ok({
    mems: mems.map(memoryJson),
    total,
    offset,
    limit,
    ...(embedding !== undefined ? { embedding } : {}),
  });
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
    if (existing.enabled) storage.scheduling.updateTask(ownerId, existing.id, { enabled: false });
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
      !storage.scheduling.updateTask(ownerId, existing.id, {
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

  if (storage.scheduling.countTasks(ownerId) >= MAX_TASKS_PER_OWNER) {
    audit(storage, "miniapp.bench.schedule", ownerId, "denied", "task cap");
    return fail(400, "Scheduled task limit reached.");
  }
  const id = storage.scheduling.createTask({
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
  let rows: Array<{ key: string; lastSentMs: number }> = [];
  try {
    rows = benchHistoryFor(deps).recentAlerts(20);
  } catch {
    rows = [];
  }
  return ok({
    alerts: rows.map((r) => ({ key: r.key, label: alertLabel(r.key), lastSentMs: r.lastSentMs })),
  });
}

/**
 * bench.live — the bench worker's current progress snapshot (platform
 * Phase 10). This is the polling replacement for the retired web
 * dashboard's SSE stream: the Mini App re-calls it while a run is active
 * instead of holding a stream open.
 */
function handleBenchLive(deps: ManageApiDeps): Response {
  if (deps.benchWorker === undefined) {
    return fail(503, "Live bench progress is not available.");
  }
  return ok({ snapshot: deps.benchWorker.snapshot() });
}

const BENCH_REPORT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}$/;

/** Where bench run reports live; BOBI_BENCH_RESULTS_DIR overrides (as the retired dashboard had it). */
function benchResultsDir(): string {
  const override = (processEnv().BOBI_BENCH_RESULTS_DIR ?? "").trim();
  if (override !== "") return override;
  return resolve(import.meta.dir, "../../bench/results");
}

/**
 * bench.report — the markdown report of one bench run, served with the
 * retired dashboard's allowlist discipline: the name must match a strict
 * regex AND name a real run in the live directory listing (its `.json`
 * sibling must exist), and the resolved path must stay inside the
 * results directory. User input is never joined into a path unchecked.
 */
async function handleBenchReport(body: Record<string, unknown>): Promise<Response> {
  const name = asString(body["name"]) ?? "";
  if (!BENCH_REPORT_NAME_RE.test(name)) {
    return fail(400, "Invalid report name.");
  }
  const dir = benchResultsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return fail(404, "Report not found.");
  }
  if (!files.includes(`${name}.json`)) {
    return fail(404, "Report not found.");
  }
  const mdPath = resolve(dir, `${name}.md`);
  if (!mdPath.startsWith(resolve(dir) + "/")) {
    return fail(400, "Invalid report name.");
  }
  try {
    const markdown = await readFile(mdPath, "utf8");
    return ok({ name, markdown });
  } catch {
    return fail(404, "Report not found.");
  }
}

// ------------------------------------------------------------ desk ---------

/**
 * desk.list — the owner's view of the tool desk: EVERY registered tool
 * with the exact desk card the model sees (its manifest) and its live
 * effective enabled state. Disabled tools stay listed here — this view
 * is how the owner turns them back on.
 */
function handleDeskList(deps: ManageApiDeps): Response {
  if (deps.desk === undefined) {
    return fail(503, "The tool desk is not available.");
  }
  return ok({ tools: deps.desk.listTools() });
}

/**
 * desk.toggle — enable/disable one tool, effective on the next turn and
 * persisted by the wiring. Unknown names answer 404; this handler runs
 * only after the router's initData owner check, so the desk can never be
 * toggled by anyone but the owner.
 */
function handleDeskToggle(deps: ManageApiDeps, ownerId: string, body: Record<string, unknown>): Response {
  if (deps.desk === undefined) {
    return fail(503, "The tool desk is not available.");
  }
  const name = asString(body["name"]);
  const enabled = asBool(body["enabled"]);
  if (name === undefined || name === "" || enabled === undefined) {
    return fail(400, "Invalid input.");
  }
  if (!deps.desk.setToolEnabled(name, enabled)) {
    audit(deps.storage, "miniapp.desk.toggle", ownerId, "denied", `unknown tool ${name}`);
    return fail(404, "Tool not found.");
  }
  audit(deps.storage, "miniapp.desk.toggle", ownerId, "success", `name=${name} enabled=${enabled}`);
  return ok({ name, enabled });
}

// ----------------------------------------------- schedulers + digest -------

function handleSchedulersList(storage: Storage, ownerId: string): Response {
  const schedulers = storage.scheduling.listTasks(ownerId, 200).map((t) => {
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
  const task = storage.scheduling.listTasks(ownerId, 200).find((t) => t.id === id);
  if (task === undefined) {
    return fail(404, "Scheduler not found.");
  }
  if (!storage.scheduling.updateTask(ownerId, id, { enabled })) {
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

// ----------------------------------------------- digest scheduling ---------
//
// Platform Phase 10: ALL digest scheduling lives in DigestSchedulingService
// (src/digest/scheduling.ts), exposed on the platform as
// scheduling.digests. These handlers are thin adapters: they bind the
// Mini App's audit operation names and hand the service the raw body.

function digestScheduling(storage: Storage): DigestSchedulingService {
  return new DigestSchedulingService(storage);
}

function handleDigestConfig(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Response {
  return digestScheduling(storage).morningConfig(ownerId, body, (outcome, detail) =>
    audit(storage, "miniapp.digest.config", ownerId, outcome, detail),
  );
}

// ------------------------------------------------- group digests -----------

function handleGroupDigestsList(storage: Storage, ownerId: string): Response {
  return ok({ groups: digestScheduling(storage).listGroups(ownerId) });
}

async function handleGroupDigestSet(
  storage: Storage,
  ownerId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return digestScheduling(storage).setGroup(ownerId, body, (outcome, detail) =>
    audit(storage, "miniapp.group_digest", ownerId, outcome, detail),
  );
}

// ------------------------------------------------------------ skills -------

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function skillTrusted(storage: Storage, name: string): boolean {
  const prov = storage.misc.getSkillInstallProvenance(name);
  const keyId = prov?.keyId;
  return keyId != null && storage.misc.getTrustedSkillPublisher(keyId) !== undefined;
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
  const publishers = storage.misc.listTrustedSkillPublishers().map((r) => ({
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
  const { added } = storage.misc.trustSkillPublisher({
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
  const removed = storage.misc.untrustSkillPublisher(parsed.keyId);
  if (!removed) return fail(404, "Publisher is not in the trust list.");
  return ok({ keyId: parsed.keyId, removed: true });
}

// ------------------------------------------------------------ usage --------

function usageDays(body: Record<string, unknown>): number {
  const daysRaw = asInt(body["days"]);
  return daysRaw === undefined ? 7 : Math.min(Math.max(daysRaw, 1), 90);
}

function handleUsageReport(storage: Storage, body: Record<string, unknown>): Response {
  const days = usageDays(body);
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

/** Daily token/cost breakdown for the period (owner-only). */
function handleUsageDaily(storage: Storage, body: Record<string, unknown>): Response {
  const days = usageDays(body);
  const daily = getDailyBreakdown(storage, days);
  return ok({
    days,
    daily: daily.map((d) => ({
      date: d.date,
      dayStartMs: d.dayStartMs,
      runs: d.runs,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      estimatedUsd: d.estimatedUsd,
    })),
  });
}

/** Per-provider stats for the period (owner-only). */
function handleUsageByProvider(storage: Storage, body: Record<string, unknown>): Response {
  const days = usageDays(body);
  const providers = getByProvider(storage, days);
  return ok({
    days,
    providers: providers.map((p) => ({
      providerId: p.providerId,
      providerName: p.providerName,
      runs: p.runs,
      successRate: p.successRate,
      avgLatencyMs: p.avgLatencyMs,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      estimatedUsd: p.estimatedUsd,
    })),
  });
}

/** Latency percentiles per model (owner-only). */
function handleUsageLatency(storage: Storage, body: Record<string, unknown>): Response {
  const days = usageDays(body);
  const stats = getLatencyStats(storage, days);
  return ok({
    days,
    tracked: stats.tracked,
    perModel: stats.perModel.map((m) => ({
      modelId: m.modelId,
      runs: m.runs,
      p50Ms: m.p50Ms,
      p95Ms: m.p95Ms,
      maxMs: m.maxMs,
    })),
  });
}

// ------------------------------------------------ reminders/tasks/goals ----

function handleTasksList(storage: Storage, ownerId: string): Response {
  const reminders = storage.scheduling.listReminders(ownerId, 50).map((r) => ({
    id: r.id,
    kind: "reminder",
    text: r.text,
    dueAtMs: r.dueAt,
    repeat: r.repeat,
    state: r.state,
  }));
  const tasks = storage.scheduling.listTasks(ownerId, 100).map((t) => ({
    id: t.id,
    kind: "task",
    name: t.name,
    enabled: t.enabled,
    cron: t.cronExpr,
    nextRunAtMs: t.nextRunAtMs,
  }));
  const goals = storage.scheduling.listGoals(ownerId, "active", 50).map((g) => ({
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
    if (!storage.scheduling.completeGoal(ownerId, id)) return fail(404, "Goal not found.");
    audit(storage, "miniapp.tasks.complete", ownerId, "success", `goal id=${id}`);
    return ok({ kind, id });
  }
  if (kind === "reminder") {
    // A reminder has no "done" state; the owner-facing completion is
    // dismissing it (the same transition the cancel tool performs).
    if (!storage.scheduling.cancelReminder(ownerId, id)) return fail(404, "Reminder not found.");
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
    if (!storage.scheduling.cancelReminder(ownerId, id)) return fail(404, "Reminder not found.");
    audit(storage, "miniapp.tasks.cancel", ownerId, "success", `reminder id=${id}`);
    return ok({ kind, id });
  }
  if (kind === "task") {
    const task = storage.scheduling.listTasks(ownerId, 200).find((t) => t.id === id);
    if (task === undefined) return fail(404, "Task not found.");
    if (asBool(body["confirm"]) !== true) {
      return json(200, { needsConfirm: true, kind, id, name: task.name });
    }
    if (!storage.scheduling.deleteTask(ownerId, id)) return fail(500, "An internal error occurred.");
    audit(storage, "miniapp.tasks.cancel", ownerId, "success", `task id=${id} name=${task.name}`);
    return ok({ kind, id });
  }
  // Goals have no delete in storage (completeGoal only).
  return fail(400, "Deleting goals is not supported; you can complete it.");
}

// ------------------------------------------------------------ groups -------

const GROUP_CFG_PREFIX = assistantConfigKey("");
const MOD_CFG_PREFIX = modConfigKey("");

function knownGroupChatIds(storage: Storage, ownerId: string): string[] {
  const ids = new Set<string>();
  for (const prefix of [GROUP_CFG_PREFIX, MOD_CFG_PREFIX]) {
    for (const key of storage.misc.listUserPrefKeys(ownerId, prefix)) {
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
      const assistant = getAssistantConfig(storage.misc, ownerId, chatId);
      const moderation = getModConfig(storage.misc, ownerId, chatId);
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
  const config = getAssistantConfig(storage.misc, ownerId, groupId);
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
  const res = setAssistantConfig(storage.misc, ownerId, groupId, patch);
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
  return ok(digestScheduling(storage).groupView(ownerId, groupId));
}

// --------------------------------------------------------- moderation ------

function handleModerationGet(storage: Storage, ownerId: string, body: Record<string, unknown>): Response {
  const groupId = validGroupId(body["groupId"]);
  if (groupId === undefined) return fail(400, "Invalid group id.");
  return ok({ groupId, config: getModConfig(storage.misc, ownerId, groupId) });
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
  const res = setModConfig(storage.misc, ownerId, groupId, patch);
  if (!res.ok) {
    audit(storage, "miniapp.moderation.set", ownerId, "denied", `chat=${groupId}`);
    return fail(400, "Invalid input.");
  }
  audit(storage, "miniapp.moderation.set", ownerId, "success", `chat=${groupId}`);
  return ok({ groupId, config: res.config });
}
