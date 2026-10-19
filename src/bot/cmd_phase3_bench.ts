/**
 * Phase-3 benchmark commands: /bench.
 *
 * /bench history [n]              — recent runs (newest first)
 * /bench trend [task_id]         — avg-score trend, overall or per task
 * /bench run [--live] [--bg] [task ids] — run the suite now (--bg: background worker)
 * /bench schedule <cron|off> [--live] — schedule periodic runs (default OFF)
 * /bench status                  — schedule state + worker state + latest run
 * /bench cancel                  — cancel the running/queued background run
 *
 * Phase-4: LIVE runs execute in the daemon BenchWorker (src/bench/worker.ts),
 * outside the scheduler's 30s action budget. `/bench schedule --live` writes
 * a scheduled action with input {mode:"live", background:true}, which
 * enqueues in milliseconds; the worker runs the full suite, records history,
 * and drives the regression alert path. /bench status shows the worker
 * (idle/running/pending); /bench cancel drops the queue and aborts the
 * active run. All owner-only, bilingual.
 *
 * Conventions (per `src/bot/cmd_context.ts` and cmd_auto.ts):
 * - logic lives in exported `handleXxx(deps, …)` functions taking plain
 *   values; the grammy wrapper in `registerBenchCommands` stays thin,
 * - user-facing strings come from `./cmd_phase3_bench_strings` (Persian default),
 * - the group/user gates run before every handler, then the owner-tier gate.
 *
 * WIRING (coordinator): this module is NOT registered in src/index.ts or
 * src/bot/bot.ts. The coordinator calls `registerBenchCommands(bot, deps)`
 * from createBot and merges COMMAND_DEFS into the setMyCommands call.
 * Deps the coordinator supplies:
 *   history    — new BenchHistory(new Database(config.dbPath)) (second
 *                connection, same pattern as ProposalStore)
 *   runBenchNow — run the suite on demand. The straightforward wiring is the
 *                run_bench tool itself:
 *                  const runBenchTool = createRunBenchTool({
 *                    isOwner, history, notifyOwner,
 *                    buildLive: defaultLiveStackBuilder(config.dbPath), ...
 *                  });
 *                and
 *                  runBenchNow: (opts) => runBenchTool.run(opts, toolCtxFor(ownerId))
 *                where toolCtxFor builds a ToolContext with the owner's
 *                server-side actor. Also register runBenchTool on the
 *                ToolService so scheduled tasks can dispatch it.
 *   notifyOwner — proactive DM path: (text) => bot.api.sendMessage(ownerId, text)
 *                with the same mayDeliverTo access re-check the nudge sweep
 *                uses. Never a group, never another user.
 *
 * SECURITY MODEL:
 *  1. OWNER-ONLY, twice. requireOwnerTier rejects non-owners at the wrapper;
 *     run_bench itself is ownerOnly + isOwner-checked. History rows are the
 *     owner's private measurements — never rendered to anyone else.
 *  2. No raw model output anywhere: history/trend/alerts carry scores and
 *     totals only (see src/bench/baseline.ts).
 *  3. /bench schedule creates a scheduled task whose action runs run_bench —
 *     a sandboxed, :memory:-only suite (see src/bench/tool.ts). The cron
 *     string is validated with parseCron before the tool call; the task name
 *     is a fixed constant so exactly one bench schedule exists. Live
 *     schedules pass background:true, so the action only enqueues into the
 *     daemon worker (milliseconds, inside the scheduler's action budget).
 */
import type { Bot } from "grammy";
import { gateGroup, gateUser, senderLang } from "./bot";
import { requireOwnerTier } from "./access";
import type { HermesCommandDef, HermesCommandDeps } from "./cmd_context";
import {
  actorForTelegramUser,
  callToolAs,
  replyLong,
  senderOf,
  type SenderRef,
} from "./cmd_auto";
import { parseCron } from "../scheduler/cron";
import { BenchHistory } from "../bench/history";
import type { RunBenchOutput } from "../bench/tool";
import { tr, type BenchLang } from "./cmd_phase3_bench_strings";

// ---------------------------------------------------------------------------
// Command definitions (menu entries, merged by the coordinator)
// ---------------------------------------------------------------------------

export const COMMAND_DEFS: HermesCommandDef[] = [
  {
    command: "bench",
    descriptionEn: "Benchmarks and quality trends",
    ownerOnly: true,
  },
];

/** Fixed scheduled-task name: exactly one bench schedule exists per owner. */
export const BENCH_SCHEDULE_TASK_NAME = "bench: scheduled run";

const DEFAULT_HISTORY_N = 10;
const MAX_HISTORY_N = 30;
const MAX_CRON_LENGTH = 64;
const TASK_ID_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

/**
 * Minimal control surface of the daemon BenchWorker (`src/bench/worker.ts`),
 * typed structurally so this module never imports the worker — the
 * coordinator passes the real worker, tests pass a stub.
 */
export interface BenchWorkerSnapshot {
  state: "idle" | "running";
  current:
    | { jobId: string; mode: string; source: string; startedAtMs: number }
    | undefined;
  pending: number;
  /**
   * Phase-5: live per-task progress while a run is active. Undefined when
   * idle or when the executor does not report progress. Kept structural
   * (mirrors src/bench/worker.ts's WorkerSnapshot) so tests pass stubs.
   */
  progress?:
    | {
        done: number;
        total: number;
        currentTaskId: string | null;
        currentTitleFa: string | null;
        elapsedMs: number;
      }
    | undefined;
}

export interface BenchWorkerControl {
  snapshot(): BenchWorkerSnapshot;
  cancelAll(reason: string): { cancelledPending: number; abortedRunning: boolean };
}

/**
 * Deps for /bench. The full bot-command dep set (so schedule_* tool calls
 * reuse actorForTelegramUser/callToolAs and the gates see groups/users);
 * plus the benchmark history and the on-demand runner the coordinator wires.
 */
export type BenchDeps = HermesCommandDeps & {
  history: BenchHistory;
  /**
   * Run the suite now and return the run_bench output. Wired by the
   * coordinator (see module doc). Undefined = not wired in this build.
   * background:true enqueues into the worker and returns {status:"queued"}.
   */
  runBenchNow?: (opts: {
    mode: "offline" | "live";
    taskIds?: string[];
    background?: boolean;
  }) => Promise<RunBenchOutput>;
  /**
   * Daemon background worker, wired by the coordinator. Undefined = this
   * build has no worker (status shows "unavailable", cancel refuses).
   */
  benchWorker?: BenchWorkerControl;
};

// ---------------------------------------------------------------------------
// Handlers (plain values — unit-testable)
// ---------------------------------------------------------------------------

/** /bench — dispatch on the first token. */
export async function handleBench(
  deps: BenchDeps,
  sender: SenderRef,
  arg: string,
  isOwner: boolean,
  lang: BenchLang = "en",
): Promise<string> {
  if (!isOwner) return tr(lang, "cmd_phase3_bench.owner_only");
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  switch (sub) {
    case "history":
      return handleBenchHistory(deps.history, parseCount(tokens[1]), lang);
    case "trend":
      return handleBenchTrend(deps.history, tokens[1], lang);
    case "run":
      return handleBenchRun(deps, sender, tokens.slice(1), lang);
    case "schedule":
      return handleBenchSchedule(deps, sender, tokens.slice(1), lang);
    case "status":
      return handleBenchStatus(deps, sender, lang);
    case "cancel":
      return handleBenchCancel(deps, lang);
    case "":
    case "help":
      return tr(lang, "cmd_phase3_bench.help");
    default:
      return tr(lang, "cmd_phase3_bench.help");
  }
}

function parseCount(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_HISTORY_N;
  return Math.min(n, MAX_HISTORY_N);
}

function modeLabelFa(lang: BenchLang, mode: string): string {
  return tr(lang, mode === "live" ? "cmd_phase3_bench.history.mode.live" : "cmd_phase3_bench.history.mode.offline");
}

/** /bench history [n] */
export function handleBenchHistory(
  history: BenchHistory,
  n: number,
  lang: BenchLang = "en",
): string {
  const runs = history.listRuns(n);
  if (runs.length === 0) return tr(lang, "cmd_phase3_bench.no_history");
  const L: string[] = [tr(lang, "cmd_phase3_bench.history.title", { n: runs.length })];
  for (const r of runs) {
    L.push(
      tr(lang, "cmd_phase3_bench.history.item", {
        id: r.id,
        date: tehranShort(r.runStamp),
        mode: modeLabelFa(lang, r.mode),
        model: r.model,
        avg: r.avgScorePct,
        passed: r.passed,
        tasks: r.taskCount,
      }),
    );
    // Phase-5: show the failure reason when one was recorded (e.g. crash recovery).
    if (r.note !== null && r.note !== "") {
      L.push(tr(lang, "cmd_phase3_bench.history.note", { note: r.note }));
    }
  }
  return L.join("\n\n");
}

/** /bench trend [task_id] — overall avg trend, or one task's trend. */
export function handleBenchTrend(
  history: BenchHistory,
  taskId: string | undefined,
  lang: BenchLang = "en",
): string {
  const latest = history.listRuns(1)[0];
  if (!latest) return tr(lang, "cmd_phase3_bench.no_history");
  const { mode, model } = latest;

  if (taskId !== undefined && taskId.length > 0) {
    const clean = taskId.trim().toLowerCase();
    if (!TASK_ID_RE.test(clean)) return tr(lang, "cmd_phase3_bench.trend.no_task", { task: taskId });
    const trend = history.taskTrend(mode, model, clean, 10);
    if (trend.length === 0) return tr(lang, "cmd_phase3_bench.trend.no_task", { task: clean });
    const title = trend[trend.length - 1]!.titleFa;
    const L: string[] = [tr(lang, "cmd_phase3_bench.trend.task.title", { task: clean, title })];
    for (const t of trend) {
      L.push(tr(lang, "cmd_phase3_bench.trend.task.line", { id: t.runId, pct: t.scorePct }));
    }
    return L.join("\n");
  }

  const trend = history.overallTrend(mode, model, 10);
  const L: string[] = [
    tr(lang, "cmd_phase3_bench.trend.title", {
      mode: modeLabelFa(lang, mode),
      model,
    }),
  ];
  for (const t of trend) {
    L.push(tr(lang, "cmd_phase3_bench.trend.line", { id: t.runId, avg: t.avgScorePct }));
  }
  return L.join("\n");
}

/** /bench run [--live] [--bg] [task ids...] */
export async function handleBenchRun(
  deps: BenchDeps,
  sender: SenderRef,
  tokens: string[],
  lang: BenchLang = "en",
): Promise<string> {
  void sender;
  const mode: "offline" | "live" = tokens.includes("--live") ? "live" : "offline";
  const background = tokens.includes("--bg");
  const taskIds = tokens
    .filter((t) => t !== "--live" && t !== "--bg")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  for (const id of taskIds) {
    if (!TASK_ID_RE.test(id)) return tr(lang, "cmd_phase3_bench.help");
  }
  if (!deps.runBenchNow) {
    return tr(lang, "cmd_phase3_bench.run.unavailable", {
      live: mode === "live" ? " --live" : "",
    });
  }
  const out = await deps.runBenchNow({
    mode,
    background,
    ...(taskIds.length > 0 ? { taskIds } : {}),
  });
  if (out.status === "queued") {
    return tr(lang, "cmd_phase3_bench.run.queued", { position: out.position ?? "?" });
  }
  const prefix =
    tr(lang, "cmd_phase3_bench.run.started", {
      mode: tr(lang, `cmd_phase3_bench.schedule.mode.${mode}`),
    }) + (mode === "live" ? "\n" + tr(lang, "cmd_phase3_bench.run.live_note") : "");
  return `${prefix}\n\n${out.summary}`;
}

interface ScheduleTaskRow {
  id: number;
  name: string;
  cron: string;
  nextRunAt: string;
}

async function findBenchTask(deps: BenchDeps, sender: SenderRef): Promise<ScheduleTaskRow | undefined> {
  const actor = actorForTelegramUser(deps, sender.telegramId);
  const res = await callToolAs(deps, "list_tasks", {}, actor);
  if (!res.ok) return undefined;
  const data = res.data as { tasks?: ScheduleTaskRow[] };
  return data.tasks?.find((t) => t.name === BENCH_SCHEDULE_TASK_NAME);
}

/**
 * /bench schedule <cron|off> [--live]
 *
 * Creates (or replaces) exactly one scheduled task named
 * BENCH_SCHEDULE_TASK_NAME whose action is {type:"tool", tool:"run_bench"}.
 * Default state is OFF: nothing is scheduled until the owner runs this.
 */
export async function handleBenchSchedule(
  deps: BenchDeps,
  sender: SenderRef,
  tokens: string[],
  lang: BenchLang = "en",
): Promise<string> {
  if (!deps.tools) return tr(lang, "cmd_phase3_bench.need_tools");
  const mode: "offline" | "live" = tokens.includes("--live") ? "live" : "offline";
  const rest = tokens.filter((t) => t !== "--live");
  const sub = (rest[0] ?? "").toLowerCase();
  const actor = actorForTelegramUser(deps, sender.telegramId);

  if (sub === "off") {
    const existing = await findBenchTask(deps, sender);
    if (!existing) return tr(lang, "cmd_phase3_bench.schedule.none");
    const res = await callToolAs(deps, "cancel_task", { id: existing.id }, actor);
    if (!res.ok) return res.message ?? tr(lang, "cmd_phase3_bench.tool_failed");
    return tr(lang, "cmd_phase3_bench.schedule.off");
  }

  const cron = rest.join(" ").trim();
  if (cron.length === 0 || cron.length > MAX_CRON_LENGTH) {
    return tr(lang, "cmd_phase3_bench.schedule.usage");
  }
  try {
    parseCron(cron);
  } catch {
    return tr(lang, "cmd_phase3_bench.schedule.bad_cron");
  }

  // Replace, don't duplicate: at most one bench schedule per owner.
  const existing = await findBenchTask(deps, sender);
  if (existing) {
    const cancel = await callToolAs(deps, "cancel_task", { id: existing.id }, actor);
    if (!cancel.ok) return cancel.message ?? tr(lang, "cmd_phase3_bench.tool_failed");
  }

  const created = await callToolAs(
    deps,
    "schedule_task",
    {
      name: BENCH_SCHEDULE_TASK_NAME,
      cron,
      timezone: "Asia/Tehran",
      // Phase-4: live runs go through the daemon BenchWorker (background
      // enqueue, milliseconds inside the scheduler's action budget). The
      // tool ALSO auto-enqueues live when a worker is wired, but the flag
      // makes the intent explicit in the stored action.
      action: {
        type: "tool",
        tool: "run_bench",
        input: {
          mode,
          ...(mode === "live" ? { background: true, source: "schedule" } : {}),
        },
      },
    },
    actor,
  );
  if (!created.ok) return created.message ?? tr(lang, "cmd_phase3_bench.tool_failed");
  const id = (created.data as { id?: number })?.id ?? "?";
  const modeLabel = tr(lang, `cmd_phase3_bench.schedule.mode.${mode}`);
  const base = tr(
    lang,
    existing ? "cmd_phase3_bench.schedule.updated" : "cmd_phase3_bench.schedule.created",
    { cron, mode: modeLabel, id },
  );
  return mode === "live"
    ? `${base}\n${tr(lang, "cmd_phase3_bench.schedule.live_worker_note")}`
    : base;
}

/** /bench status — schedule state + latest run. */
export async function handleBenchStatus(
  deps: BenchDeps,
  sender: SenderRef,
  lang: BenchLang = "en",
): Promise<string> {
  const L: string[] = [];

  const existing = await findBenchTask(deps, sender);
  if (existing) {
    L.push(
      tr(lang, "cmd_phase3_bench.status.scheduled", {
        cron: existing.cron,
        mode: benchTaskMode(deps, sender, existing.id, lang),
        next: tehranShort(existing.nextRunAt),
      }),
    );
  } else {
    L.push(tr(lang, "cmd_phase3_bench.status.unscheduled"));
  }

  const latest = deps.history.listRuns(1)[0];
  if (latest) {
    L.push(
      tr(lang, "cmd_phase3_bench.status.last", {
        id: latest.id,
        date: tehranShort(latest.runStamp),
        avg: latest.avgScorePct,
        passed: latest.passed,
        tasks: latest.taskCount,
      }),
    );
  } else {
    L.push(tr(lang, "cmd_phase3_bench.status.no_last"));
  }

  // Phase-4: daemon worker state (idle / running / queued).
  L.push(workerStatusLine(deps.benchWorker, lang));
  return L.join("\n");
}

/** /bench cancel — drop the worker queue and abort the active run (owner-only). */
export async function handleBenchCancel(
  deps: BenchDeps,
  lang: BenchLang = "en",
): Promise<string> {
  const worker = deps.benchWorker;
  if (!worker) return tr(lang, "cmd_phase3_bench.cancel.unavailable");
  const res = worker.cancelAll("owner /bench cancel");
  if (res.cancelledPending === 0 && !res.abortedRunning) {
    return tr(lang, "cmd_phase3_bench.cancel.nothing");
  }
  return tr(lang, "cmd_phase3_bench.cancel.done", {
    pending: res.cancelledPending,
    running: res.abortedRunning ? 1 : 0,
  });
}

function workerStatusLine(
  worker: BenchWorkerControl | undefined,
  lang: BenchLang,
): string {
  if (!worker) return tr(lang, "cmd_phase3_bench.status.worker.unavailable");
  const snap = worker.snapshot();
  const L: string[] = [];
  if (snap.state === "running" && snap.current !== undefined) {
    L.push(
      tr(lang, "cmd_phase3_bench.status.worker.running", {
        mode: tr(
          lang,
          snap.current.mode === "live"
            ? "cmd_phase3_bench.schedule.mode.live"
            : "cmd_phase3_bench.schedule.mode.offline",
        ),
        started: tehranShort(new Date(snap.current.startedAtMs).toISOString()),
      }),
    );
  } else {
    L.push(tr(lang, "cmd_phase3_bench.status.worker.idle"));
  }
  // Phase-5: live per-task progress of the running benchmark.
  if (snap.state === "running" && snap.progress !== undefined) {
    const p = snap.progress;
    L.push(
      tr(lang, "cmd_phase3_bench.status.worker.progress", {
        done: p.done,
        total: p.total,
        task: p.currentTitleFa ?? p.currentTaskId ?? "…",
        elapsed: Math.max(0, Math.round(p.elapsedMs / 1000)),
      }),
    );
  }
  if (snap.pending > 0) {
    L.push(tr(lang, "cmd_phase3_bench.status.worker.pending", { n: snap.pending }));
  }
  return L.join(" ");
}

// ---------------------------------------------------------------------------
// grammy wrapper (thin; NOT registered here — the coordinator wires it)
// ---------------------------------------------------------------------------

export function registerBenchCommands(bot: Bot, deps: BenchDeps): void {
  bot.command("bench", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs) as BenchLang;
    if (!(await gateGroup(ctx, deps.groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    if (!(await requireOwnerTier(ctx, deps, lang))) return;
    const sender = senderOf(ctx);
    if (!sender) return;
    const text = ctx.message?.text ?? "";
    const arg = text.replace(/^\/bench(@\w+)?\s*/, "");
    try {
      await replyLong(
        ctx,
        await handleBench(deps, sender, arg, true, lang),
      );
    } catch (err) {
      await replyLong(
        ctx,
        tr(lang, "cmd_phase3_bench.tool_failed") +
          ` (${err instanceof Error ? err.name : "error"})`,
      );
    }
  });
}

/**
 * Read the run_bench mode back from the stored scheduled-task action.
 * Defensive: any parse failure falls back to "offline" (the tool default).
 */
function benchTaskMode(
  deps: BenchDeps,
  sender: SenderRef,
  taskId: number,
  lang: BenchLang,
): string {
  try {
    const rows = deps.storage?.listTasks(sender.userId, 25) ?? [];
    const row = rows.find((r) => r.id === taskId);
    const action = JSON.parse(row?.actionJson ?? "null") as {
      type?: string;
      tool?: string;
      input?: { mode?: string };
    } | null;
    const mode = action?.type === "tool" && action.tool === "run_bench" ? action.input?.mode : undefined;
    return tr(lang, `cmd_phase3_bench.schedule.mode.${mode === "live" ? "live" : "offline"}`);
  } catch {
    return tr(lang, "cmd_phase3_bench.schedule.mode.offline");
  }
}

function tehranShort(iso: string): string {
  try {
    // English-only UI: en-GB date parts, still anchored to Asia/Tehran.
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tehran",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
