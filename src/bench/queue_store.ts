/**
 * BenchJobStore — durable bench job queue (Phase-5).
 *
 * Phase-4 left the worker's queue IN-MEMORY: a daemon restart dropped queued
 * jobs (the next cron re-enqueued, so nothing was lost — but a restart in the
 * middle of a run left no trace at all). This store persists the queue in the
 * same lazy-table style as BenchHistory: its own `Database` handle, CREATE
 * TABLE IF NOT EXISTS on init, no touch to src/storage/storage.ts (owned by
 * another work package).
 *
 * Row lifecycle:
 *   enqueue (status='queued') → claimForRun (atomic, status='running')
 *     → markRecorded (crash-dedupe: the bench_runs id once recorded)
 *     → finish (DELETE — terminal states live in bench_runs, not here)
 *
 * Crash recovery (BenchWorker.recover):
 * - 'queued' rows never started → re-enqueued with their ORIGINAL job ids
 *   (INSERT OR IGNORE keeps the row; the in-memory queue must not mint a new
 *   id or the row would go stale and the job would run twice on the next
 *   recovery — exactly-once forbids that).
 * - 'running' rows died with the previous daemon. If recorded_run_id is set
 *   the run is already in bench_runs and the row is just dropped; otherwise
 *   the worker records a FAILED run with a clear reason. A crashed run is
 *   NEVER silently re-executed: provider calls may already have happened.
 *
 * SECURITY / privacy: queue rows are owner-only bookkeeping (mode, source,
 * task ids) — they enter the store only through the owner-only run_bench
 * tool / worker path, same as the bench history tables.
 */
import type { Database } from "bun:sqlite";

/*
 * BenchJob / BenchJobSource are defined HERE (platform Phase 5): they
 * describe this store's rows. They used to live in worker.ts while this
 * module imported them back from it — a cycle (worker.ts imports the
 * BenchJobStore value from here). worker.ts now imports the types from
 * here and re-exports them, so existing imports from ./worker keep
 * working.
 */

/** Where a job came from. Manual jobs get a direct failure DM; scheduled jobs use the repeated-failure alert path. */
export type BenchJobSource = "schedule" | "manual";

export interface BenchJob {
  id: string;
  mode: "offline" | "live";
  taskIds?: string[];
  source: BenchJobSource;
  enqueuedAtMs: number;
}

export type StoredBenchJobStatus = "queued" | "running";

export interface StoredBenchJob {
  jobId: string;
  mode: "offline" | "live";
  source: BenchJobSource;
  taskIds: string[] | undefined;
  enqueuedAtMs: number;
  status: StoredBenchJobStatus;
  /** bench_runs id once the run was recorded; null until then (crash-dedupe). */
  recordedRunId: number | null;
}

interface BenchJobRow {
  seq: number;
  job_id: string;
  mode: string;
  source: string;
  task_ids_json: string | null;
  enqueued_at_ms: number;
  status: string;
  recorded_run_id: number | null;
}

/** Task ids look like the YAML filenames: lowercase snake_case. */
const TASK_ID_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

export class BenchJobStore {
  private initialized = false;

  constructor(private readonly db: Database) {}

  /** Create the table if it does not exist. Also called lazily. */
  init(): void {
    if (this.initialized) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS bench_job_queue (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL,
        source TEXT NOT NULL,
        task_ids_json TEXT,
        enqueued_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        recorded_run_id INTEGER
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_bench_job_queue_status_seq
      ON bench_job_queue(status, seq)
    `);
    this.initialized = true;
  }

  /**
   * Persist a newly enqueued job. INSERT OR IGNORE: crash recovery
   * re-enqueues the same job id, and the row must survive that (no duplicate).
   * Synchronous — the run_bench tool's enqueue path stays in the millisecond
   * range, inside the scheduler's action budget.
   */
  enqueue(job: BenchJob): void {
    this.init();
    this.db
      .query(
        `INSERT OR IGNORE INTO bench_job_queue
           (job_id, mode, source, task_ids_json, enqueued_at_ms, status)
         VALUES (?, ?, ?, ?, ?, 'queued')`,
      )
      .run(
        job.id,
        job.mode,
        job.source,
        job.taskIds !== undefined ? JSON.stringify(job.taskIds) : null,
        job.enqueuedAtMs,
      );
  }

  /** Queued jobs, oldest first (enqueue order). */
  listQueued(): StoredBenchJob[] {
    this.init();
    return this.db
      .query<BenchJobRow, []>(
        `SELECT * FROM bench_job_queue WHERE status = 'queued' ORDER BY seq ASC`,
      )
      .all()
      .map(toStored);
  }

  /** Jobs stuck in 'running' — died with the previous daemon. Oldest first. */
  listRunning(): StoredBenchJob[] {
    this.init();
    return this.db
      .query<BenchJobRow, []>(
        `SELECT * FROM bench_job_queue WHERE status = 'running' ORDER BY seq ASC`,
      )
      .all()
      .map(toStored);
  }

  /**
   * Atomically move a row queued → running. True when THIS caller won the
   * claim; false when the row is in any other state (already claimed,
   * finished, or never existed) — the single atomic UPDATE is what keeps
   * exactly-once across a restart.
   */
  claimForRun(jobId: string): boolean {
    this.init();
    const res = this.db
      .query(
        `UPDATE bench_job_queue SET status = 'running'
         WHERE job_id = ? AND status = 'queued'`,
      )
      .run(jobId);
    return res.changes === 1;
  }

  /**
   * Release a claim (the run-lock contention path): running → queued, so a
   * requeued job is not mistaken for a crashed one on the next recovery.
   */
  releaseClaim(jobId: string): void {
    this.init();
    this.db
      .query(
        `UPDATE bench_job_queue SET status = 'queued'
         WHERE job_id = ? AND status = 'running'`,
      )
      .run(jobId);
  }

  /** Remember the bench_runs id once the run is recorded (crash-dedupe). */
  markRecorded(jobId: string, runId: number): void {
    this.init();
    this.db
      .query(`UPDATE bench_job_queue SET recorded_run_id = ? WHERE job_id = ?`)
      .run(runId, jobId);
  }

  /** Terminal state: drop the row. The run itself lives in bench_runs. */
  finish(jobId: string): void {
    this.init();
    this.db.query(`DELETE FROM bench_job_queue WHERE job_id = ?`).run(jobId);
  }

  /** Total rows (queued + running), for diagnostics and tests. */
  count(): number {
    this.init();
    const row = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM bench_job_queue`).get();
    return row?.n ?? 0;
  }
}

function toStored(row: BenchJobRow): StoredBenchJob {
  return {
    jobId: row.job_id,
    mode: row.mode === "live" ? "live" : "offline",
    source: row.source === "manual" ? "manual" : "schedule",
    taskIds: parseTaskIds(row.task_ids_json),
    enqueuedAtMs: row.enqueued_at_ms,
    status: row.status === "running" ? "running" : "queued",
    recordedRunId: row.recorded_run_id,
  };
}

/** Defensive parse: a corrupt task_ids_json degrades to "full suite", never a crash. */
function parseTaskIds(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return undefined;
    if (!v.every((t) => typeof t === "string" && TASK_ID_RE.test(t))) return undefined;
    return v as string[];
  } catch {
    return undefined;
  }
}
