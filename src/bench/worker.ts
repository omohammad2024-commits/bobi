/**
 * BenchWorker — daemon-side background worker for benchmark runs.
 *
 * Phase-3 scheduled benchmarks through `run_bench` hit a wall: the
 * TaskScheduler wraps every tool action in a ~30s budget, but a full LIVE
 * suite (real provider calls, 24 tasks) takes several minutes. The scheduled
 * task either timed out (marked "failed") or never ran for real.
 *
 * This module moves the heavy work OUT of the scheduler action budget:
 *
 *   scheduler tick → run_bench {mode:"live", background:true}
 *       → BenchJobQueue.enqueue (milliseconds, no LLM calls) → "queued"
 *   BenchWorker pump (every pollIntervalMs, unref'd)
 *       → takes the next job → builds the bench stack → runs the full suite
 *       → records to BenchHistory → regression alert path → owner DM
 *
 * CONCURRENCY: exactly one bench suite executes per process at a time.
 * - The worker's queue holds at most one active + MAX_PENDING queued jobs;
 *   anything beyond that is refused with a logged reason ("queue_full"),
 *   never silently dropped into corruption.
 * - A process-wide lock (tryAcquireBenchRunLock) is shared with the
 *   synchronous run_bench path: a manual /bench run while the worker is
 *   busy fails LOUDLY instead of interleaving the task-mock state that
 *   bench/run.ts keeps in module globals.
 *
 * FAIL-SAFE: every job ends in exactly one of ok / failed / cancelled /
 * skipped, and failed + cancelled runs are RECORDED in bench_runs (they are
 * excluded from the regression baseline, which only reads status='ok').
 * A crash inside runJob is caught, logged, and recorded — the pump never
 * dies, and the lock is always released.
 *
 * PHASE-5: the queue is DURABLE (src/bench/queue_store.ts). Enqueued jobs are
 * persisted before the in-memory push; start() reconciles crashed state —
 * never-started jobs are re-enqueued (original ids, exactly-once), runs that
 * died mid-flight are recorded FAILED with a clear reason and never silently
 * re-executed. Per-task progress ticks feed subscribeProgress() subscribers
 * (the dashboard's SSE live stream); /bench status renders the same
 * snapshot. See docs/PHASE5_BENCH_DURABLE.md.
 *
 * OWNER-ONLY: jobs only enter the queue through the run_bench tool, which is
 * ownerOnly + server-side isOwner-checked. The worker itself performs no
 * authorization — it trusts the queue. Results and alerts go to the owner's
 * DM only, via the same notifyOwner channel as the tool.
 *
 * COST CONTROL (attack-surface review — the worker makes outbound provider
 * calls on a schedule):
 * - one run at a time, bounded pending queue (default 2),
 * - per-run timeout (default 20 min, cooperative: checked between tasks;
 *   each turn is additionally bounded by the engine's own timeout),
 * - enqueue + schedule management are owner-only (tool permission +
 *   /bench owner tier); the public cannot schedule, queue, or cancel,
 * - no new network surface: the suite uses the owner's configured provider
 *   only (same as `bun bench/run.ts --live`), web access stays mocked,
 *   secrets are never logged (see docs/PHASE4_BENCH_WORKER.md).
 */
import type { BenchReport, BenchStack, TaskResult } from "../../bench/run";
import {
  buildOfflineStack,
  buildReport,
  runTask,
  stampName,
} from "../../bench/run";
import { loadTasks } from "../../bench/schema";
import { BenchHistory } from "./history";
import { BenchJobStore } from "./queue_store";
import type { BenchJob, BenchJobSource } from "./queue_store";

export type { BenchJob, BenchJobSource };
import {
  alertDue,
  decideAlert,
  formatRegressionAlert,
  formatRunSummary,
  formatSkipAlert,
  type BaselineOptions,
} from "./baseline";
import { tr, type WorkerLang } from "../i18n/strings/worker_strings";

// ---------------------------------------------------------------------------
// Process-wide bench execution lock
// ---------------------------------------------------------------------------

/**
 * Only one bench suite may execute in this process at a time — the worker's
 * background runs AND the synchronous run_bench path share this lock. The
 * reason is bench/run.ts's module-global task-mock state: two interleaved
 * suites would serve each other the wrong mocked web data.
 *
 * Single-process boolean is sufficient: the daemon is one Bun process, and
 * all bench execution funnels through this module or run_bench.
 */
let benchRunLock = false;

/** Acquire the bench execution lock. False = someone else holds it. */
export function tryAcquireBenchRunLock(): boolean {
  if (benchRunLock) return false;
  benchRunLock = true;
  return true;
}

/** Release the lock. Idempotent. */
export function releaseBenchRunLock(): void {
  benchRunLock = false;
}

/** For status reporting and tests. */
export function isBenchRunLocked(): boolean {
  return benchRunLock;
}

// ---------------------------------------------------------------------------
// Jobs + queue
// ---------------------------------------------------------------------------

/* BenchJob / BenchJobSource are defined in ./queue_store (they
 * describe the store's rows, platform Phase 5), imported at the top of
 * this module and re-exported there, so existing imports from ./worker
 * keep working. */

/** What the run_bench tool hands to the queue (the queue assigns id + time). */
export interface BenchJobSpec {
  mode: "offline" | "live";
  taskIds?: string[];
  source?: BenchJobSource;
  /**
   * Internal: crash recovery re-enqueues with the ORIGINAL durable job id so
   * the queue row (claim/finish) keeps matching the in-memory job. Minting a
   * fresh id here would orphan the row and re-run the job on the next
   * recovery — exactly-once forbids that. Never set by tool callers.
   */
  id?: string;
}

/**
 * Per-task progress of a running benchmark — what the owner dashboard's
 * live stream and `/bench status` render. `elapsedMs` is measured at emit
 * time; clients recompute it from `startedAtMs` for ticking displays.
 */
export interface BenchProgress {
  jobId: string;
  mode: "offline" | "live";
  source: BenchJobSource;
  startedAtMs: number;
  /** Tasks finished so far. */
  done: number;
  /** Tasks in this run (known once the suite lists them). */
  total: number;
  currentTaskId: string | null;
  currentTitleFa: string | null;
  elapsedMs: number;
}

/**
 * Live events the worker pushes to subscribers (the dashboard's SSE stream).
 *
 * Ordering: a "snapshot" is pushed on every state change (enqueue, job
 * start/end, cancel, recovery); "progress" events arrive in task order while
 * a run is active; exactly one "terminal" closes each run. Emission is
 * synchronous, in order — a subscriber sees p1 before p2, never the reverse.
 */
export type BenchLiveEvent =
  | { type: "progress"; progress: BenchProgress }
  | { type: "snapshot"; snapshot: WorkerSnapshot }
  | {
      type: "terminal";
      jobId: string;
      outcome: "ok" | "failed" | "cancelled" | "skipped";
      runId?: number | undefined;
    };

export type EnqueueOutcome =
  | { queued: true; jobId: string; position: number }
  | { queued: false; reason: "queue_full" };

/** Max jobs waiting behind the active one. Bounded so a hot schedule cannot grow memory. */
export const MAX_PENDING_JOBS = 2;

/** Abort reasons the suite loop understands. */
export type BenchAbortReason = "timeout" | "cancelled";

/**
 * Thrown by the suite loop when shouldAbort() reports a reason. Carries the
 * task results completed so far, so the run can still be recorded (failed).
 */
export class BenchAbortError extends Error {
  constructor(
    readonly reason: BenchAbortReason,
    readonly partial: TaskResult[],
  ) {
    super(`bench run aborted: ${reason}`);
    this.name = "BenchAbortError";
  }
}

/**
 * One-active + bounded-pending queue. All state transitions are synchronous
 * (no awaits between check and mutation), so no two callers can both think
 * they took the same job.
 */
export class BenchJobQueue {
  private active: BenchJob | null = null;
  private pending: BenchJob[] = [];
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly store: BenchJobStore | undefined;
  private seq = 0;

  constructor(
    opts: { maxPending?: number; now?: () => number; store?: BenchJobStore } = {},
  ) {
    this.maxPending = opts.maxPending ?? MAX_PENDING_JOBS;
    this.now = opts.now ?? Date.now;
    this.store = opts.store;
  }

  /**
   * Enqueue a job. When idle the job still goes through `pending` — the
   * worker's pump takes it on its next tick (milliseconds away). Position 1
   * means "runs next".
   *
   * Phase-5: the job is persisted to the durable queue BEFORE the in-memory
   * push, so a daemon restart resurrects it. A store failure propagates
   * LOUDLY (the run_bench action fails instead of silently losing the job).
   */
  enqueue(spec: BenchJobSpec): EnqueueOutcome {
    if (this.pending.length >= this.maxPending && this.active !== null) {
      return { queued: false, reason: "queue_full" };
    }
    // Idle worker with an empty queue: still fine to just push — pump picks
    // it up immediately. The maxPending bound only bites when something is
    // already active or waiting.
    if (this.pending.length >= this.maxPending) {
      return { queued: false, reason: "queue_full" };
    }
    this.seq += 1;
    const job: BenchJob = {
      // Recovery passes the original durable id; everyone else gets a fresh one.
      id: spec.id ?? `bench-${this.now()}-${this.seq}`,
      mode: spec.mode,
      source: spec.source ?? "schedule",
      enqueuedAtMs: this.now(),
      ...(spec.taskIds !== undefined ? { taskIds: [...spec.taskIds] } : {}),
    };
    this.store?.enqueue(job);
    this.pending.push(job);
    return {
      queued: true,
      jobId: job.id,
      position: this.pending.length + (this.active !== null ? 1 : 0),
    };
  }

  /** Take the next pending job and mark it active. Undefined when idle/empty. */
  takeNext(): BenchJob | undefined {
    if (this.active !== null) return undefined;
    const job = this.pending.shift();
    if (job === undefined) return undefined;
    this.active = job;
    return job;
  }

  /** Put a job back at the front (e.g. the run lock was contested). */
  requeueFront(job: BenchJob): void {
    if (this.active === job) this.active = null;
    this.pending.unshift(job);
  }

  /** The active job finished (any outcome): release it. */
  finishActive(): void {
    this.active = null;
  }

  /** Remove all pending jobs, returning them (for logging). */
  cancelPending(): BenchJob[] {
    const jobs = this.pending;
    this.pending = [];
    // Phase-5: drop the durable rows too — a cancelled pending job must not
    // resurrect on the next restart.
    for (const job of jobs) this.store?.finish(job.id);
    return jobs;
  }

  get activeJob(): BenchJob | undefined {
    return this.active ?? undefined;
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * Per-task progress tick an executor calls between tasks. `done` counts
 * finished tasks; `taskId`/`titleFa` name the task about to run (null once
 * the suite is complete).
 */
export type WorkerProgressTick = (
  done: number,
  total: number,
  taskId: string | null,
  titleFa: string | null,
) => void;

/**
 * What a suite executor receives; must throw BenchAbortError when
 * shouldAbort() reports a reason. The optional onProgress tick feeds the
 * live progress stream — executors that ignore it simply report no progress
 * (backwards compatible: fewer parameters still satisfy this type).
 */
export type WorkerExecuteSuite = (
  stack: BenchStack,
  runId: string,
  taskIds: string[] | undefined,
  shouldAbort: () => BenchAbortReason | undefined,
  onProgress?: WorkerProgressTick,
) => Promise<BenchReport>;

export interface BenchWorkerDeps {
  queue?: BenchJobQueue;
  history: BenchHistory;
  /**
   * Phase-5: durable queue store. When present, enqueued jobs are persisted
   * (survive daemon restarts) and start() reconciles crashed runs. Omit for
   * the pre-Phase-5 in-memory behaviour (tests, CLI-less builds).
   */
  jobStore?: BenchJobStore;
  /** Owner DM channel (same lazy wiring as the run_bench tool). Never throws the run. */
  notifyOwner: (text: string) => Promise<void>;
  /** Live stack builder; throws (Persian) when no provider is configured. Omit for offline-only. */
  buildLive?: () => BenchStack;
  /** Task YAML dir; defaults to the repo's bench/tasks. */
  tasksDir?: string;
  /** Injectable suite executor, for deterministic tests. */
  executeSuite?: WorkerExecuteSuite;
  /** Baseline thresholds for the regression alert path. */
  baseline?: BaselineOptions;
  /** Injectable clock, ms. */
  now?: () => number;
  /** Owner's UI language for worker DMs. */
  lang?: WorkerLang;
  /** Per-run budget, ms (cooperative — checked between tasks). Default 20 min. */
  runTimeoutMs?: number;
  /** Pump interval, ms. Default 2s. */
  pollIntervalMs?: number;
  /** Consecutive failures before the owner is alerted. Default 3. */
  failureAlertThreshold?: number;
  /** Cooldown for the repeated-failure alert. Default 24h. */
  failureAlertCooldownMs?: number;
  /** Diagnostic log (secret-free). */
  log?: (message: string) => void;
}

export interface WorkerSnapshot {
  state: "idle" | "running";
  current:
    | { jobId: string; mode: "offline" | "live"; source: BenchJobSource; startedAtMs: number }
    | undefined;
  pending: number;
  /**
   * Phase-5: live per-task progress while a run is active. Undefined when
   * idle, or when the executor does not report progress.
   */
  progress?: BenchProgress | undefined;
}

export interface WorkerCancelResult {
  cancelledPending: number;
  abortedRunning: boolean;
}

const DEFAULT_RUN_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Cooldown for the "live skipped: no provider" DM so a daily schedule does not nag daily. */
const SKIP_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SKIP_ALERT_KEY = "bench-worker-skip:live";
const FAILURE_ALERT_KEY = "bench-worker-failures";

export function defaultWorkerTasksDir(): string {
  // Keep beside the tool's default: <repo>/bench/tasks.
  return new URL("../../bench/tasks", import.meta.url).pathname;
}

export class BenchWorker {
  private readonly queue: BenchJobQueue;
  private readonly history: BenchHistory;
  private readonly jobStore: BenchJobStore | undefined;
  private readonly notifyOwner: (text: string) => Promise<void>;
  private readonly buildLive: (() => BenchStack) | undefined;
  private readonly tasksDir: string;
  /** Injectable suite executor (tests). When absent, the default task loop runs, bound to the job's mode. */
  private readonly executeSuiteOverride: WorkerExecuteSuite | undefined;
  private readonly baseline: BaselineOptions | undefined;
  private readonly now: () => number;
  private readonly lang: WorkerLang;
  private readonly runTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly failureAlertThreshold: number;
  private readonly failureAlertCooldownMs: number;
  private readonly log: ((message: string) => void) | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Set while a job's runJob is in flight — the reentrancy guard. */
  private active: { job: BenchJob; startedAtMs: number } | undefined;
  /** Abort flag for the active run; checked by the suite loop between tasks. */
  private abortReason: BenchAbortReason | undefined;
  /** Consecutive failed runs (reset on ok). Drives the repeated-failure alert. */
  private consecutiveFailures = 0;
  /** Last failure's short reason, for the alert text. */
  private lastFailureReason = "";
  /** Latest progress tick of the active run (Phase-5 live stream). */
  private progress: BenchProgress | undefined;
  /** Live-stream subscribers (Phase-5). A throwing listener never breaks the worker. */
  private readonly listeners = new Set<(ev: BenchLiveEvent) => void>();
  /** Crash recovery runs once per process. */
  private recovered = false;

  constructor(deps: BenchWorkerDeps) {
    this.queue =
      deps.queue ??
      new BenchJobQueue({
        ...(deps.jobStore !== undefined ? { store: deps.jobStore } : {}),
      });
    this.history = deps.history;
    this.jobStore = deps.jobStore;
    this.notifyOwner = deps.notifyOwner;
    this.buildLive = deps.buildLive;
    this.tasksDir = deps.tasksDir ?? defaultWorkerTasksDir();
    this.executeSuiteOverride = deps.executeSuite;
    this.baseline = deps.baseline;
    this.now = deps.now ?? Date.now;
    this.lang = deps.lang ?? "fa";
    this.runTimeoutMs = deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.failureAlertThreshold = deps.failureAlertThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.failureAlertCooldownMs = deps.failureAlertCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.log = deps.log;
  }

  /**
   * Subscribe to live worker events (Phase-5: the dashboard's SSE stream).
   * Returns an unsubscribe function. Emission is synchronous and ordered;
   * the subscriber is responsible for its own errors only — a throw is
   * caught and logged, never propagated into the run.
   */
  subscribeProgress(cb: (ev: BenchLiveEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Push one live event to every subscriber, in subscription order. */
  private emit(ev: BenchLiveEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch (err) {
        this.diag(`progress listener failed: ${msg(err)}`);
      }
    }
  }

  /**
   * Crash recovery for the durable queue (Phase-5). Runs once per process:
   * queued jobs that never started are re-enqueued; runs that died mid-flight
   * are recorded as FAILED with a clear reason — never silently re-executed.
   * Public so tests can drive it without timers; start() calls it first.
   */
  async recover(): Promise<{ requeued: number; interrupted: number }> {
    if (this.recovered) return { requeued: 0, interrupted: 0 };
    this.recovered = true;
    const store = this.jobStore;
    if (store === undefined) return { requeued: 0, interrupted: 0 };

    let requeued = 0;
    let interrupted = 0;

    for (const row of store.listRunning()) {
      if (row.recordedRunId !== null) {
        // The run was recorded before the crash — the queue row is just
        // debris. Dropping it (no second history row, no alert).
        this.diag(
          `recover: job ${row.jobId} already recorded as run #${row.recordedRunId}; dropping queue row`,
        );
        store.finish(row.jobId);
        continue;
      }
      const reason = tr(this.lang, "bench.worker.reason.interrupted");
      const report = buildReport([], {
        mode: row.mode,
        provider: "bench-worker",
        model: "interrupted",
      });
      const runId = this.history.recordRun(report, "failed", reason);
      this.consecutiveFailures += 1;
      this.lastFailureReason = reason;
      store.finish(row.jobId);
      interrupted += 1;
      this.diag(`recover: job ${row.jobId} died mid-run; recorded as failed run #${runId}`);
    }

    for (const row of store.listQueued()) {
      const outcome = this.queue.enqueue({
        // The ORIGINAL id: the durable row must keep matching the in-memory
        // job (claim/finish), or the next recovery would run it twice.
        id: row.jobId,
        mode: row.mode,
        source: row.source,
        ...(row.taskIds !== undefined ? { taskIds: row.taskIds } : {}),
      });
      if (outcome.queued) {
        requeued += 1;
        this.diag(`recover: re-enqueued job ${row.jobId}`);
      } else {
        // Unreachable under the enqueue guard (the fresh queue is empty),
        // but if it ever happens the row stays durable for the next
        // recovery — a job is never dropped here.
        this.diag(`recover: re-enqueue refused (${outcome.reason}) for ${row.jobId}; row kept`);
      }
    }

    if (interrupted > 0) {
      await this.safeNotify(
        tr(this.lang, "bench.worker.recovered", { n: interrupted, m: requeued }),
      );
      await this.maybeAlertRepeatedFailures();
    }
    this.emit({ type: "snapshot", snapshot: this.snapshot() });
    return { requeued, interrupted };
  }

  /**
   * Start the pump loop. Idempotent. The timer is unref'd: it never keeps the
   * process alive. Phase-5: reconciles the durable queue first (recover()).
   */
  start(): void {
    if (this.timer !== undefined) return;
    void this.recover().catch((err) => this.diag(`recover failed: ${msg(err)}`));
    this.timer = setInterval(() => {
      void this.pump().catch((err) => this.diag(`pump failed: ${msg(err)}`));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the pump and cooperatively abort the active run. Safe when idle. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.active !== undefined) {
      this.abortReason = "cancelled";
      this.diag(`worker stopped; aborting active job ${this.active.job.id}`);
    }
  }

  /** Enqueue a job (what the run_bench tool calls). */
  enqueue(spec: BenchJobSpec): EnqueueOutcome {
    const outcome = this.queue.enqueue(spec);
    if (!outcome.queued) {
      this.diag(`enqueue refused (${outcome.reason}): mode=${spec.mode} source=${spec.source ?? "schedule"}`);
    } else {
      this.emit({ type: "snapshot", snapshot: this.snapshot() });
    }
    return outcome;
  }

  /**
   * One pump iteration: start the next pending job when idle. Public so
   * tests can drive it deterministically without timers.
   */
  async pump(): Promise<void> {
    if (this.active !== undefined) return;
    const job = this.queue.takeNext();
    if (job === undefined) return;
    // Durable claim: exactly one worker — even across a restart — may run
    // this row. The single atomic UPDATE is the cross-restart exactly-once.
    // False = the row is in a foreign state; the in-memory exactly-once
    // still holds, so the job runs — but it is said out loud.
    const claimed = this.jobStore?.claimForRun(job.id) ?? true;
    if (!claimed) {
      this.diag(`job ${job.id} claim refused (foreign row state); running from memory anyway`);
    }
    this.active = { job, startedAtMs: this.now() };
    this.abortReason = undefined;
    this.emit({ type: "snapshot", snapshot: this.snapshot() });
    try {
      await this.runJob(job);
    } catch (err) {
      // Fail-safe: the pump NEVER dies. The lock release + active cleanup
      // below run regardless; the failure itself is logged.
      // NOTE: the queue row deliberately stays 'running' here — the next
      // process start's recover() records it as an interrupted failure.
      // Deleting it now would silently lose the run.
      this.diag(`runJob crashed for ${job.id}: ${msg(err)}`);
    } finally {
      releaseBenchRunLock();
      this.queue.finishActive();
      this.active = undefined;
      this.abortReason = undefined;
      this.progress = undefined;
      this.emit({ type: "snapshot", snapshot: this.snapshot() });
    }
  }

  /** Owner control: drop pending jobs and cooperatively abort the active run. */
  cancelAll(reason: string): WorkerCancelResult {
    const cancelled = this.queue.cancelPending();
    let abortedRunning = false;
    if (this.active !== undefined) {
      this.abortReason = "cancelled";
      abortedRunning = true;
    }
    this.diag(
      `cancelAll (${reason}): cancelledPending=${cancelled.length} abortedRunning=${abortedRunning}`,
    );
    this.emit({ type: "snapshot", snapshot: this.snapshot() });
    return { cancelledPending: cancelled.length, abortedRunning };
  }

  /** Owner control: what /bench status renders (Phase-5: includes live progress). */
  snapshot(): WorkerSnapshot {
    const active = this.active;
    return {
      state: active === undefined ? "idle" : "running",
      current:
        active === undefined
          ? undefined
          : {
              jobId: active.job.id,
              mode: active.job.mode,
              source: active.job.source,
              startedAtMs: active.startedAtMs,
            },
      pending: this.queue.pendingCount,
      progress: this.progress,
    };
  }

  // ------------------------------------------------------------------
  // One job, start to finish. Every outcome is recorded; nothing throws out.
  // ------------------------------------------------------------------

  /**
   * Record one progress tick for the active run and push it to the live
   * stream (Phase-5). Synchronous and ordered — subscribers see ticks in
   * task order.
   */
  private reportProgress(
    job: BenchJob,
    done: number,
    total: number,
    taskId: string | null,
    titleFa: string | null,
  ): void {
    const startedAtMs = this.active?.startedAtMs ?? this.now();
    const progress: BenchProgress = {
      jobId: job.id,
      mode: job.mode,
      source: job.source,
      startedAtMs,
      done,
      total,
      currentTaskId: taskId,
      currentTitleFa: titleFa,
      elapsedMs: Math.max(0, this.now() - startedAtMs),
    };
    this.progress = progress;
    this.emit({ type: "progress", progress });
  }

  private async runJob(job: BenchJob): Promise<void> {
    // The process-wide lock: a synchronous run_bench may hold it (it only
    // takes seconds). Contested → put the job back and retry next pump.
    // Synchronous with no awaits before this point, so no race.
    if (!tryAcquireBenchRunLock()) {
      // Phase-5: release the durable claim too — the row goes back to
      // 'queued', so a later crash does not mistake it for an interrupted run.
      this.jobStore?.releaseClaim(job.id);
      this.queue.requeueFront(job);
      this.active = undefined;
      this.diag(`run lock contested; requeued ${job.id}`);
      return;
    }

    const startedAt = this.now();
    this.diag(`starting job ${job.id} mode=${job.mode} source=${job.source}`);

    // Per-run timeout: cooperative — the suite loop checks shouldAbort()
    // between tasks. Each turn is additionally bounded by the engine's own
    // timeout (30s offline / 120s live per turn), so a stuck provider call
    // cannot hang the worker forever.
    const timeout = setTimeout(() => {
      if (this.abortReason === undefined) {
        this.abortReason = "timeout";
        this.diag(`job ${job.id} timed out after ${this.runTimeoutMs}ms`);
      }
    }, this.runTimeoutMs);
    timeout.unref?.();

    try {
      // Build the sandboxed stack (:memory: state, mocked web — same
      // builders the CLI and the run_bench tool use).
      let stack: BenchStack;
      if (job.mode === "live") {
        if (this.buildLive === undefined) {
          await this.handleSkip(job, "اجرای زنده در این نمونه پیکربندی نشده است.");
          return;
        }
        try {
          stack = this.buildLive();
        } catch (err) {
          // Refuse-to-fake: loud skip, cooldown-guarded DM, no history row
          // (a skip is not a measurement), does not feed the failure counter.
          await this.handleSkip(job, msg(err));
          return;
        }
      } else {
        stack = buildOfflineStack();
      }

      const runId = stampName(new Date(startedAt));
      const executeSuite =
        this.executeSuiteOverride ?? defaultWorkerExecuteSuite(this.tasksDir, job.mode);
      // Phase-5: the executor's per-task ticks feed the live progress stream.
      const onTick: WorkerProgressTick = (done, total, taskId, titleFa) =>
        this.reportProgress(job, done, total, taskId, titleFa);
      let report: BenchReport;
      try {
        report = await executeSuite(stack, runId, job.taskIds, () => this.abortReason, onTick);
      } catch (err) {
        await this.handleSuiteFailure(job, stack, runId, err);
        return;
      }

      // Success: record, run the existing regression alert path, DM the owner.
      const storedId = this.history.recordRun(report, "ok");
      // Phase-5: crash-dedupe BEFORE the row is dropped — a crash between the
      // record and the delete must not produce a second history row.
      this.jobStore?.markRecorded(job.id, storedId);
      this.jobStore?.finish(job.id);
      this.emit({ type: "terminal", jobId: job.id, outcome: "ok", runId: storedId });
      this.consecutiveFailures = 0;
      this.lastFailureReason = "";
      await this.maybeAlertRegression(report);
      await this.safeNotify(
        tr(this.lang, "bench.worker.done", {
          mode: this.modeLabel(job.mode),
          avg: report.totals.avgScorePct,
          passed: report.totals.passed,
          tasks: report.taskCount,
          id: storedId,
        }),
      );
      this.diag(`job ${job.id} ok: run #${storedId} avg=${report.totals.avgScorePct}%`);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** The suite threw (or the abort flag fired): record a FAILED run, maybe alert. */
  private async handleSuiteFailure(
    job: BenchJob,
    stack: BenchStack | undefined,
    runId: string,
    err: unknown,
  ): Promise<void> {
    const abortReason = this.abortReason;
    const isCancel = err instanceof BenchAbortError ? err.reason === "cancelled" : abortReason === "cancelled";
    const partial = err instanceof BenchAbortError ? err.partial : [];
    const reasonText =
      err instanceof BenchAbortError
        ? err.reason === "timeout"
          ? tr(this.lang, "bench.worker.reason.timeout")
          : tr(this.lang, "bench.worker.reason.cancelled")
        : truncate(msg(err), 300);

    const report = buildReport(partial, {
      mode: job.mode,
      provider: stack?.providerName ?? "unknown",
      model: stack?.model ?? "unknown",
    });
    const storedId = this.history.recordRun(report, isCancel ? "cancelled" : "failed");
    // Phase-5: crash-dedupe + durable finish + terminal event (see runJob).
    this.jobStore?.markRecorded(job.id, storedId);
    this.jobStore?.finish(job.id);
    this.emit({
      type: "terminal",
      jobId: job.id,
      outcome: isCancel ? "cancelled" : "failed",
      runId: storedId,
    });
    this.diag(
      `job ${job.id} ${isCancel ? "cancelled" : "failed"}: run #${storedId} reason=${reasonText}`,
    );

    if (isCancel) {
      // Owner-initiated: the /bench cancel reply is the feedback. Not a
      // failure, not a DM.
      return;
    }

    this.consecutiveFailures += 1;
    this.lastFailureReason = reasonText;

    // Manual jobs get a direct failure DM (the owner asked for this run);
    // scheduled jobs use the repeated-failure alert path (no per-attempt spam).
    if (job.source === "manual") {
      await this.safeNotify(
        tr(this.lang, "bench.worker.failed", {
          mode: this.modeLabel(job.mode),
          reason: reasonText,
        }),
      );
    }
    await this.maybeAlertRepeatedFailures();
  }

  /** Live requested but no provider configured: loud skip, cooldown-guarded. */
  private async handleSkip(job: BenchJob, reason: string): Promise<void> {
    this.diag(`job ${job.id} skipped: ${truncate(reason, 160)}`);
    // Phase-5: a skip is not a measurement — no history row — but the
    // durable queue row must still be dropped + the terminal event emitted.
    this.jobStore?.finish(job.id);
    this.emit({ type: "terminal", jobId: job.id, outcome: "skipped" });
    const now = this.now();
    if (alertDue(this.history, SKIP_ALERT_KEY, now, SKIP_ALERT_COOLDOWN_MS)) {
      await this.safeNotify(formatSkipAlert(reason));
      this.history.markAlertSent(SKIP_ALERT_KEY, now);
    }
  }

  /** The existing regression alert path (baseline.ts): compare + 24h cooldown. */
  private async maybeAlertRegression(report: BenchReport): Promise<void> {
    try {
      const decision = decideAlert(this.history, report, {
        ...this.baseline,
        now: this.now,
      });
      if (decision.fire) {
        await this.safeNotify(formatRegressionAlert(decision.comparison, report));
        this.history.markAlertSent(decision.key, this.now());
      }
    } catch (err) {
      // A baseline failure must never fail the run: scores are stored.
      this.diag(`baseline failed: ${msg(err)}`);
    }
  }

  /**
   * Repeated-failure alert: fires once the consecutive-failure threshold is
   * reached, then at most once per cooldown — never per attempt.
   */
  private async maybeAlertRepeatedFailures(): Promise<void> {
    if (this.consecutiveFailures < this.failureAlertThreshold) return;
    const now = this.now();
    if (!alertDue(this.history, FAILURE_ALERT_KEY, now, this.failureAlertCooldownMs)) return;
    await this.safeNotify(
      tr(this.lang, "bench.worker.failed_alert", {
        n: this.consecutiveFailures,
        reason: truncate(this.lastFailureReason, 200),
      }),
    );
    this.history.markAlertSent(FAILURE_ALERT_KEY, now);
  }

  /** A notify failure must never fail the run — log and move on. */
  private async safeNotify(text: string): Promise<void> {
    try {
      await this.notifyOwner(text);
    } catch (err) {
      this.diag(`notify failed: ${msg(err)}`);
    }
  }

  private modeLabel(mode: "offline" | "live"): string {
    return tr(this.lang, mode === "live" ? "bench.worker.mode.live" : "bench.worker.mode.offline");
  }

  private diag(message: string): void {
    this.log?.(`[bench-worker] ${message}`);
  }
}

/**
 * Default suite executor: the same task loop the run_bench tool uses
 * (loadTasks → runTask per task → buildReport), plus a between-task abort
 * check so timeouts and owner cancels stop the run at the next task boundary.
 */
function defaultWorkerExecuteSuite(tasksDir: string, mode: "offline" | "live"): WorkerExecuteSuite {
  return async (stack, runId, taskIds, shouldAbort, onProgress) => {
    let tasks = await loadTasks(tasksDir);
    if (taskIds !== undefined) {
      const want = new Set(taskIds);
      tasks = tasks.filter((t) => want.has(t.id));
    }
    // Phase-5: per-task progress ticks for the live stream (done counts
    // finished tasks; the tick before each task names the task about to run).
    onProgress?.(0, tasks.length, null, null);
    const results: TaskResult[] = [];
    for (const task of tasks) {
      const reason = shouldAbort();
      if (reason !== undefined) throw new BenchAbortError(reason, results);
      onProgress?.(results.length, tasks.length, task.id, task.title_fa);
      results.push(await runTask(stack, task, runId));
    }
    onProgress?.(results.length, tasks.length, null, null);
    return buildReport(results, {
      mode,
      provider: stack.providerName,
      model: stack.model,
    });
  };
}

/** Default tasks dir, relative to this file: <repo>/bench/tasks. Re-exported for the run_bench tool. */
export { defaultWorkerTasksDir as defaultBenchTasksDir };

function msg(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
