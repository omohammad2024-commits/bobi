/**
 * run_bench — owner-only tool that executes the benchmark suite headlessly,
 * persists the run to the benchmark history, and raises a quality alert to
 * the owner on regression.
 *
 * This is the tool the scheduled benchmark job dispatches: the owner creates
 * one scheduled task with action {type:"tool", tool:"run_bench", input:{mode}}
 * (see /bench schedule) and the TaskScheduler runs it on cron. Default OFF —
 * nothing is scheduled unless the owner asks.
 *
 * Modes:
 * - offline (default): FakeProvider + mocked web, same plumbing the CLI uses.
 *   Fast (seconds), always allowed, and safe to run on any schedule.
 * - live: the owner's real provider. Builds the stack exactly like
 *   `bun bench/run.ts --live` (AiGateway over the config DB, :memory: state).
 *   When NO provider is configured the build THROWS (the runner's
 *   refuse-to-fake rule) — the tool catches that and SKIPS LOUDLY: the owner
 *   gets a Persian notification, nothing is recorded, and nothing is faked.
 *
 * SANDBOXED EXECUTION (attack-surface review):
 * - The benchmark stack is built ONLY by buildOfflineStack()/buildLive()
 *   from bench/run.ts. ALL tool state lives in a fresh Storage.open(":memory:")
 *   that is discarded after the run: a bench turn can never read or write
 *   the owner's real conversations, memories, reminders, or scheduled tasks.
 * - Web access is mocked: BenchToolService serves the task's canned data for
 *   web_search/fetch_url instead of the network. A scheduled run makes no
 *   network calls of its own (except the configured live provider).
 * - The bench actor's permissions come from the bench registry alone —
 *   never from the bot's live ToolService. Nothing destructive from the
 *   live registry is reachable.
 * - The provider-secret store is read-only for selection, same as the CLI.
 *
 * OWNER-ONLY (twice, like the other admin tools): the `ownerOnly` flag keeps
 * the authorization bridge from granting the permission key to anyone else,
 * and run() re-checks ownership against the server-supplied isOwner
 * predicate, so a hand-built actor cannot slip through either. Benchmark
 * results are the owner's private data — run history must not leak across
 * users, so both the tool and /bench stay owner-only.
 *
 * NOTE on live scheduled runs (Phase-4): a full 24-task live run takes
 * several minutes, longer than the scheduler's per-action budget (30s
 * default). Live runs therefore go through the daemon-side BenchWorker
 * (`src/bench/worker.ts`): the scheduled action is
 * `{type:"tool", tool:"run_bench", input:{mode:"live", background:true}}`,
 * which ENQUEUES in milliseconds (no LLM calls inside the action path) and
 * returns "queued". The worker picks the job up on its next pump, runs the
 * full suite with real provider calls, records to the history tables, and
 * drives the same regression alert path below. Offline scheduled runs stay
 * synchronous — they finish in seconds, inside the budget.
 */
import { createRequire } from "node:module";
import { ToolError } from "../tools/errors";
import { defineManifest } from "../tools/manifest";
import type { ToolManifest } from "../tools/manifest";
import type { Tool, ToolContext } from "../tools/types";
import type { BenchReport, BenchStack, TaskResult } from "../../bench/run";
import { loadTasks } from "../../bench/schema";
import { BenchHistory } from "./history";
import type { BenchJobSource, BenchJobSpec, EnqueueOutcome } from "./worker";

// ---------------------------------------------------------------------------
// Lazy module loads (platform Phase 1 cycle break).
//
// bench/run and ./worker are loaded on FIRST USE, not at module init:
// both reach src/tools/service.ts (bench/run subclasses ToolService;
// the worker builds bench stacks), and service.ts statically imports
// src/tools/plugins.ts, which catalogs this module's manifest. A static
// import of either module from here deadlocks that graph in TDZ
// (whichever of service/plugins/this module is entered first, one of
// them reads an uninitialized binding). By the time any bench code
// actually runs, boot is long finished and both modules load cleanly.
// ---------------------------------------------------------------------------
const requireModule = createRequire(import.meta.url);

type BenchRunModule = typeof import("../../bench/run");
type BenchWorkerModule = typeof import("./worker");

let benchRunModule: BenchRunModule | undefined;
let benchWorkerModule: BenchWorkerModule | undefined;

/** bench/run (stack builders, task runner, report builder), first-use load. */
function benchRun(): BenchRunModule {
  return (benchRunModule ??= requireModule("../../bench/run") as BenchRunModule);
}

/** src/bench/worker (run lock, default tasks dir), first-use load. */
function benchWorker(): BenchWorkerModule {
  return (benchWorkerModule ??= requireModule("./worker") as BenchWorkerModule);
}
import {
  compareToBaseline,
  decideAlert,
  formatRegressionAlert,
  formatRunSummary,
  formatSkipAlert,
  type BaselineOptions,
  type BaselineComparison,
} from "./baseline";

export const RUN_BENCH_PERMISSION = "tools:run_bench";

/** How many task ids one input may name (the suite has 24). */
const MAX_TASKS_PER_RUN = 32;
/** Task ids look like the YAML filenames: lowercase snake_case. */
const TASK_ID_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

export interface RunBenchInput {
  /** "offline" (default) or "live". */
  mode?: "offline" | "live";
  /** Optional subset of task ids (from bench/tasks). Defaults to the full suite. */
  tasks?: string[];
  /**
   * Run in the background via the daemon BenchWorker instead of blocking.
   *
   * - true: enqueue and return {status:"queued"} in milliseconds. Requires a
   *   wired worker (the daemon); without one the call fails loudly rather
   *   than silently running for minutes.
   * - false: run synchronously, exactly like before (the caller waits).
   * - undefined (default): enqueue automatically when mode is "live" AND a
   *   worker is wired — so a scheduled live run can never accidentally burn
   *   the scheduler's 30s action budget. Explicit false keeps the old
   *   on-demand live behaviour (the result is returned to the caller).
   */
  background?: boolean;
  /**
   * Where the request came from. The worker notifies the owner directly on a
   * failed MANUAL run, while scheduled runs use the repeated-failure alert
   * path (no per-attempt spam). Defaults to "schedule" (conservative).
   */
  source?: BenchJobSource;
}

export interface RunBenchOutput {
  status: "ok" | "skipped" | "queued";
  /** Stored history id (ok only). */
  runId?: number;
  /** Worker job id (queued only). */
  jobId?: string;
  /** 1-based place in the worker queue (queued only). */
  position?: number;
  mode: "offline" | "live";
  model?: string;
  taskCount?: number;
  passed?: number;
  failed?: number;
  avgScorePct?: number;
  /** True when a regression alert was sent to the owner. */
  alerted: boolean;
  /** skipped only: why. */
  reason?: string;
  /** Short Persian summary. */
  summary: string;
}

export interface RunBenchToolDeps {
  /**
   * Server-supplied owner check. The userId comes from the trusted actor, so
   * this predicate — not anything in the request — decides ownership.
   */
  isOwner: (userId: string) => boolean;
  /** Benchmark history (bot's second SQLite connection, like ProposalStore). */
  history: BenchHistory;
  /**
   * Proactive channel to the owner. The coordinator wires this to the same
   * delivery path as the nudge sweep (bot.api.sendMessage to the owner's DM
   * with the access re-check) — never a group, never another user.
   */
  notifyOwner: (text: string) => Promise<void>;
  /**
   * Live stack builder. Throws (Persian) when no provider is configured —
   * reuse the runner's refuse-to-fake rule. The coordinator wires
   * defaultLiveStackBuilder(config.dbPath). Omit to allow offline only.
   */
  buildLive?: () => BenchStack;
  /**
   * Background enqueue target: the daemon BenchWorker's enqueue, wired by
   * the coordinator. When present, background runs (explicit or the live
   * default) are handed to the worker; the tool itself never blocks on them.
   * Omit (tests, CLI-less builds) to allow synchronous runs only.
   */
  enqueueJob?: (spec: BenchJobSpec) => EnqueueOutcome;
  /** Task YAML dir; defaults to the repo's bench/tasks. */
  tasksDir?: string;
  /** Injectable suite executor, for deterministic tests. */
  executeSuite?: (
    stack: BenchStack,
    runId: string,
    taskIds?: string[],
  ) => Promise<BenchReport>;
  /** Baseline thresholds; see baseline.ts. */
  baseline?: BaselineOptions;
  /** Injectable clock, ms. */
  now?: () => number;
  /** Diagnostic log for notify failures etc. */
  log?: (message: string) => void;
}

/** Default tasks dir: <repo>/bench/tasks. Single source lives in worker.ts. */
export function defaultTasksDir(): string {
  return benchWorker().defaultBenchTasksDir();
}

/**
 * Coordinator wiring helper: a live-stack builder over the bot's config DB,
 * with the runner's refuse-when-unconfigured semantics.
 */
export function defaultLiveStackBuilder(dbPath: string): () => BenchStack {
  return () => benchRun().buildLiveStack(dbPath).stack;
}

async function defaultExecuteSuite(
  stack: BenchStack,
  runId: string,
  tasksDir: string,
  mode: "offline" | "live",
  taskIds?: string[],
): Promise<BenchReport> {
  let tasks = await loadTasks(tasksDir);
  if (taskIds !== undefined) {
    const want = new Set(taskIds);
    tasks = tasks.filter((t) => want.has(t.id));
  }
  const results: TaskResult[] = [];
  for (const task of tasks) {
    results.push(await benchRun().runTask(stack, task, runId));
  }
  return benchRun().buildReport(results, {
    mode,
    provider: stack.providerName,
    model: stack.model,
  });
}

export const runBenchManifest: ToolManifest = defineManifest({
  id: "run_bench",
  version: "1.0.0",
  title: "Run Benchmark",
  purpose: "benchmark suite, admin-run",
  useWhen: "admin surface only",
  doNotUseWhen:
    "Never call in chat — driven only from /bench and schedules; not for single answers or chatting.",
  confusableWith: [
    {
      tool: "usage_report",
      difference: "usage_report shows past usage stats; run_bench executes scored test tasks.",
    },
    {
      tool: "delegate",
      difference: "delegate hands one task to a sub-agent; run_bench runs the whole scored suite.",
    },
  ],
  latencyTier: "minutes",
  description:
    "Run the benchmark suite offline (fake provider) or live (owner's real provider), record the run in history and alert the owner on regression. Owner-only, admin surface only: driven from /bench and scheduled tasks, not offered to the model.",
  outputSummary: "Run status, pass/fail counts, average score and whether a regression alert fired.",
  category: "bench",
  costTier: "cheap",
});

export function createRunBenchTool(deps: RunBenchToolDeps): Tool<RunBenchInput, RunBenchOutput> {
  const tasksDir = deps.tasksDir ?? defaultTasksDir();
  const now = deps.now ?? Date.now;

  return {
    name: "run_bench",
    manifest: runBenchManifest,
    description:
      "اجرای بنچ‌مارک بابی (آفلاین یا زنده)، ذخیرهٔ نتیجه در تاریخچه و هشدار افت کیفیت به مالک. زمان‌بندی‌شده: آفلاین همیشه، زنده فقط وقتی ارائه‌دهنده پیکربندی شده باشد (فقط مالک).",
    enabled: true,
    ownerOnly: true,
    offDesk: true,
    permission: { requires: [RUN_BENCH_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        mode: {
          type: "enum",
          required: false,
          description: "حالت اجرا: offline (پیش‌فرض، سریع و امن) یا live (مدل واقعی مالک).",
          choices: ["offline", "live"] as const,
        },
        tasks: {
          type: "array",
          required: false,
          description: "زیرمجموعه‌ای از شناسه‌های تسک‌ها؛ خالی یعنی کل مجموعه.",
        },
        background: {
          type: "boolean",
          required: false,
          description:
            "اجرای پس‌زمینه در ورکر دیمون (بدون انتظار). برای live زمان‌بندی‌شده لازم است؛ در غیر این صورت محدودیت ۳۰ ثانیه‌ای زمان‌بند تمام می‌شود.",
        },
        source: {
          type: "enum",
          required: false,
          description: "منبع درخواست: schedule (زمان‌بندی‌شده) یا manual (دستی).",
          choices: ["schedule", "manual"] as const,
        },
      },
    },

    async run(input: RunBenchInput, ctx: ToolContext): Promise<RunBenchOutput> {
      const userId = ownerOf(ctx, deps);
      void userId;

      const mode = input.mode ?? "offline";
      if (mode !== "offline" && mode !== "live") {
        throw new ToolError("invalid_input", "حالت باید offline یا live باشد.");
      }
      const taskIds = validateTaskIds(input.tasks);
      const source: BenchJobSource = input.source ?? "schedule";

      // Background resolution: explicit flag wins; otherwise a live run with
      // a wired worker enqueues automatically, so a scheduled live action
      // written before Phase-4 (input {mode:"live"}) can never accidentally
      // burn the scheduler's 30s action budget.
      const wantBackground =
        input.background ?? (mode === "live" && deps.enqueueJob !== undefined);
      if (wantBackground) {
        return enqueueBackground(deps, mode, taskIds, source);
      }

      // Synchronous path: share the process-wide bench lock with the
      // background worker. A manual run while the worker is busy fails LOUDLY
      // instead of interleaving the task-mock state — a wrong silent score
      // is worse than a clear "busy".
      if (!benchWorker().tryAcquireBenchRunLock()) {
        throw new ToolError(
          "overloaded",
          "یک اجرای بنچ‌مارک دیگر (پس‌زمینه) در حال انجام است؛ کمی بعد تلاش کنید یا با «/bench cancel» لغوش کنید.",
        );
      }
      try {
        return await runSynchronous(deps, mode, taskIds, tasksDir, now);
      } finally {
        benchWorker().releaseBenchRunLock();
      }
    },
  };
}

/**
 * Background path: validate, then hand the job to the daemon BenchWorker.
 * Milliseconds, no LLM calls — safe inside the scheduler's action budget.
 */
function enqueueBackground(
  deps: RunBenchToolDeps,
  mode: "offline" | "live",
  taskIds: string[] | undefined,
  source: BenchJobSource,
): RunBenchOutput {
  if (deps.enqueueJob === undefined) {
    throw new ToolError(
      "not_found",
      "اجرای پس‌زمینه در این نمونه پیکربندی نشده است؛ ورکر بنچ‌مارک فعال نیست.",
    );
  }
  const spec: BenchJobSpec = {
    mode,
    source,
    ...(taskIds !== undefined ? { taskIds } : {}),
  };
  const outcome = deps.enqueueJob(spec);
  if (!outcome.queued) {
    deps.log?.(`bench enqueue refused (${outcome.reason}): mode=${mode}`);
    return {
      status: "skipped",
      mode,
      alerted: false,
      reason: outcome.reason,
      summary:
        "صف بنچ‌مارک پس‌زمینه پر است (یک اجرا در حال انجام است)؛ این نوبت رد شد و چیزی ثبت نشد.",
    };
  }
  return {
    status: "queued",
    jobId: outcome.jobId,
    position: outcome.position,
    mode,
    alerted: false,
    summary: `بنچ‌مارک در صف پس‌زمینه قرار گرفت (جایگاه ${outcome.position}). نتیجه به مالک اعلام می‌شود.`,
  };
}

/** The pre-Phase-4 synchronous body, unchanged apart from living in a helper. */
async function runSynchronous(
  deps: RunBenchToolDeps,
  mode: "offline" | "live",
  taskIds: string[] | undefined,
  tasksDir: string,
  now: () => number,
): Promise<RunBenchOutput> {
  // Build the sandboxed stack. The builders throw (Persian) when a live
  // run is requested but no provider is configured — that is the loud
  // skip, not a silent fake.
  let stack: BenchStack;
  if (mode === "live") {
    if (!deps.buildLive) {
      throw new ToolError(
        "not_found",
        "اجرای زنده در این نمونه پیکربندی نشده است؛ فقط حالت آفلاین.",
      );
    }
    try {
      stack = deps.buildLive();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await safeNotify(deps, formatSkipAlert(reason));
      return {
        status: "skipped",
        mode,
        alerted: false,
        reason,
        summary: "بنچ‌مارک زنده رد شد: ارائه‌دهنده پیکربندی نشده است.",
      };
    }
  } else {
    stack = benchRun().buildOfflineStack();
  }

  const runId = benchRun().stampName();
  const executeSuite =
    deps.executeSuite ??
    ((stack: BenchStack, execRunId: string, execTaskIds?: string[]) =>
      defaultExecuteSuite(stack, execRunId, tasksDir, mode, execTaskIds));
  const report = await executeSuite(stack, runId, taskIds);
  const storedId = deps.history.recordRun(report);

  // Regression check against the rolling baseline, with cooldown+dedupe.
  let alerted = false;
  let comparison: BaselineComparison | undefined;
  try {
    const decision = decideAlert(deps.history, report, {
      ...deps.baseline,
      now,
    });
    comparison = decision.comparison;
    if (decision.fire) {
      await safeNotify(deps, formatRegressionAlert(decision.comparison, report));
      deps.history.markAlertSent(decision.key, now());
      alerted = true;
    }
  } catch (err) {
    // A baseline failure must never fail the run: the scores are stored,
    // and the owner is told the comparison did not happen.
    deps.log?.(`bench baseline failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    status: "ok",
    runId: storedId,
    mode,
    model: report.model,
    taskCount: report.taskCount,
    passed: report.totals.passed,
    failed: report.totals.failed,
    avgScorePct: report.totals.avgScorePct,
    alerted,
    summary:
      formatRunSummary(report, storedId) +
      (comparison !== undefined && comparison.reason === "insufficient_baseline"
        ? "\n(خط‌مبنا هنوز کافی نیست؛ بعد از چند اجرای دیگر هشدار افت کیفیت فعال می‌شود.)"
        : ""),
  };
}

/** Re-exported so the coordinator can compose buildLive with its own config. */
export { compareToBaseline };

function validateTaskIds(tasks: unknown): string[] | undefined {
  if (tasks === undefined) return undefined;
  if (!Array.isArray(tasks)) {
    throw new ToolError("invalid_input", "tasks باید آرایه‌ای از شناسه‌ها باشد.");
  }
  if (tasks.length > MAX_TASKS_PER_RUN) {
    throw new ToolError("invalid_input", `حداکثر ${MAX_TASKS_PER_RUN} تسک در هر اجرا.`);
  }
  const ids: string[] = [];
  for (const t of tasks) {
    if (typeof t !== "string" || !TASK_ID_RE.test(t)) {
      throw new ToolError("invalid_input", "شناسهٔ تسک نامعتبر است.");
    }
    ids.push(t);
  }
  return ids;
}

/**
 * The owner id for this call, taken from the server-supplied actor — and then
 * checked against the server-supplied owner predicate. Same double-check as
 * the scheduled-task and curator tools: the permission key alone does not
 * prove ownership.
 */
function ownerOf(ctx: ToolContext, deps: RunBenchToolDeps): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "هویت مشخص نیست.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "اجرای بنچ‌مارک فقط برای مالک است.");
  }
  return id;
}

/**
 * A notify failure must never fail the benchmark run: the run is stored, and
 * the failure is logged for diagnostics. The scheduler marks the task from
 * the tool's own return, not from the side channel.
 */
async function safeNotify(deps: RunBenchToolDeps, text: string): Promise<void> {
  try {
    await deps.notifyOwner(text);
  } catch (err) {
    deps.log?.(`bench notify failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
