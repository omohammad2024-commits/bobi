/**
 * BenchHistory — persistent store for benchmark run summaries.
 *
 * Every completed benchmark run (CLI or scheduled `run_bench`) lands here:
 * the summary (mode, provider, model, totals) plus per-task scores. The CLI
 * keeps writing its JSON/Markdown file reports unchanged — this table is the
 * queryable history the owner reads with /bench history and /bench trend,
 * and what the regression baseline is computed from.
 *
 * Like the nudge tracker and the curator proposal store, this deliberately
 * does NOT go through src/storage/storage.ts (owned by another work package
 * this batch): it is benchmark bookkeeping, not core storage. Tables are
 * created lazily with CREATE TABLE IF NOT EXISTS on init, and the store works
 * with any Database handle — the bot opens a second connection to its SQLite
 * file, exactly like the proposal store.
 *
 * SECURITY / privacy:
 * - Benchmark data is owner-only: /bench is an owner-only command and
 *   run_bench is an owner-only tool, so this store is never read or written
 *   on behalf of anyone else. Results must not leak across users.
 * - Rows hold scores and totals only — never prompts, never raw model
 *   output (see baseline.ts: alert text is scores + deltas only).
 */
import type { Database } from "bun:sqlite";
import type { BenchReport } from "../../bench/run";

export interface BenchRunSummary {
  id: number;
  runStamp: string;
  tsMs: number;
  mode: string;
  provider: string;
  model: string;
  taskCount: number;
  passed: number;
  failed: number;
  avgScorePct: number;
  totalLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: string;
  /** Phase-5: optional short reason (e.g. why a run was marked failed). */
  note: string | null;
}

export interface BenchTaskScore {
  runId: number;
  taskId: string;
  titleFa: string;
  score: number;
  maxScore: number;
  passed: boolean;
}

interface BenchRunRow {
  id: number;
  run_stamp: string;
  ts_ms: number;
  mode: string;
  provider: string;
  model: string;
  task_count: number;
  passed: number;
  failed: number;
  avg_score_pct: number;
  total_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  status: string;
  note: string | null;
}

interface BenchScoreRow {
  run_id: number;
  task_id: string;
  title_fa: string;
  score: number;
  max_score: number;
  passed: number;
}

/** Cap on stored runs: one runaway schedule cannot fill the database. */
export const MAX_BENCH_RUNS = 100;

/** Default history window for list/trend views. */
export const DEFAULT_HISTORY_LIMIT = 20;

export class BenchHistory {
  private initialized = false;

  constructor(private readonly db: Database) {}

  /** Create the tables if they do not exist. Also called lazily. */
  init(): void {
    if (this.initialized) return;
    this.db.run(`PRAGMA foreign_keys = ON;`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS bench_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_stamp TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        mode TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task_count INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        avg_score_pct REAL NOT NULL,
        total_latency_ms INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok',
        note TEXT
      )
    `);
    // Phase-5: databases created before the note column existed get it via a
    // guarded ALTER (additive; existing rows read back as NULL).
    const cols = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(bench_runs)`)
      .all()
      .map((c) => c.name);
    if (!cols.includes("note")) {
      this.db.run(`ALTER TABLE bench_runs ADD COLUMN note TEXT`);
    }
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_bench_runs_mode_model_ts
      ON bench_runs(mode, model, ts_ms)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS bench_run_scores (
        run_id INTEGER NOT NULL REFERENCES bench_runs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        title_fa TEXT NOT NULL,
        score REAL NOT NULL,
        max_score REAL NOT NULL,
        passed INTEGER NOT NULL,
        PRIMARY KEY (run_id, task_id)
      )
    `);
    // Alert dedupe/cooldown state: one row per alert key.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS bench_alerts (
        key TEXT PRIMARY KEY,
        last_sent_ms INTEGER NOT NULL
      )
    `);
    this.initialized = true;
  }

  /**
   * Persist a finished run: one summary row + one row per task score.
   * Returns the stored run id. Oldest runs beyond MAX_BENCH_RUNS are pruned
   * (their score rows cascade).
   *
   * Statuses: "ok" (a real measurement — the ONLY status the regression
   * baseline reads), "skipped" (loud skip, e.g. live with no provider),
   * "failed" (the background worker records these — provider errors,
   * timeouts, crashes, daemon restarts mid-run — so a failure is never lost),
   * "cancelled" (owner-cancelled mid-run). Non-ok rows never pollute the
   * baseline. Phase-5: an optional short `note` records WHY (e.g. the
   * crash-recovery reason); it is display-only, never read by the baseline.
   */
  recordRun(
    report: BenchReport,
    status: "ok" | "skipped" | "failed" | "cancelled" = "ok",
    note?: string,
  ): number {
    this.init();
    const stamp = report.generatedAt;
    const tsMs = Date.parse(stamp);
    const res = this.db
      .query(
        `INSERT INTO bench_runs
           (run_stamp, ts_ms, mode, provider, model, task_count, passed, failed,
            avg_score_pct, total_latency_ms, input_tokens, output_tokens, cost_usd, status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stamp,
        Number.isFinite(tsMs) ? tsMs : Date.now(),
        report.mode,
        report.provider,
        report.model,
        report.taskCount,
        report.totals.passed,
        report.totals.failed,
        report.totals.avgScorePct,
        report.totals.totalLatencyMs,
        report.totals.inputTokens,
        report.totals.outputTokens,
        report.totals.costUsd,
        status,
        note ?? null,
      );
    const runId = Number(res.lastInsertRowid);
    const insertScore = this.db.query(
      `INSERT OR REPLACE INTO bench_run_scores
         (run_id, task_id, title_fa, score, max_score, passed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of report.results) {
      insertScore.run(
        runId,
        r.taskId,
        r.title_fa,
        r.score,
        r.maxScore,
        r.passed ? 1 : 0,
      );
    }
    this.prune();
    return runId;
  }

  /** Newest runs first, capped. */
  listRuns(limit = DEFAULT_HISTORY_LIMIT): BenchRunSummary[] {
    this.init();
    const capped = Math.max(1, Math.min(limit, MAX_BENCH_RUNS));
    return this.db
      .query<BenchRunRow, [number]>(`SELECT * FROM bench_runs ORDER BY ts_ms DESC, id DESC LIMIT ?`)
      .all(capped)
      .map(toSummary);
  }

  /** One run with its per-task scores, or undefined. */
  getRun(id: number): { summary: BenchRunSummary; scores: BenchTaskScore[] } | undefined {
    this.init();
    if (!Number.isInteger(id) || id <= 0) return undefined;
    const row = this.db
      .query<BenchRunRow, [number]>(`SELECT * FROM bench_runs WHERE id = ?`)
      .get(id);
    if (row === null) return undefined;
    const scores = this.db
      .query<BenchScoreRow, [number]>(
        `SELECT * FROM bench_run_scores WHERE run_id = ? ORDER BY task_id ASC`,
      )
      .all(id)
      .map(toScore);
    return { summary: toSummary(row), scores };
  }

  /**
   * The newest `n` completed runs for one (mode, model) pair — the
   * regression baseline's input. Skipped runs are excluded: they are not
   * measurements.
   */
  baselineRuns(mode: string, model: string, n: number): BenchRunSummary[] {
    this.init();
    const capped = Math.max(1, Math.min(n, MAX_BENCH_RUNS));
    return this.db
      .query<BenchRunRow, [string, string, number]>(
        `SELECT * FROM bench_runs
         WHERE mode = ? AND model = ? AND status = 'ok'
         ORDER BY ts_ms DESC, id DESC LIMIT ?`,
      )
      .all(mode, model, capped)
      .map(toSummary);
  }

  /** Overall avg-score trend for one (mode, model): oldest → newest. */
  overallTrend(
    mode: string,
    model: string,
    n = DEFAULT_HISTORY_LIMIT,
  ): Array<{ runId: number; tsMs: number; avgScorePct: number }> {
    return this.baselineRuns(mode, model, n)
      .reverse()
      .map((r) => ({ runId: r.id, tsMs: r.tsMs, avgScorePct: r.avgScorePct }));
  }

  /** Per-task score trend for one (mode, model, task): oldest → newest. */
  taskTrend(
    mode: string,
    model: string,
    taskId: string,
    n = DEFAULT_HISTORY_LIMIT,
  ): Array<{ runId: number; tsMs: number; scorePct: number; titleFa: string }> {
    this.init();
    const capped = Math.max(1, Math.min(n, MAX_BENCH_RUNS));
    const rows = this.db
      .query<BenchScoreRow & { ts_ms: number }, [string, string, string, number]>(
        `SELECT s.*, r.ts_ms
         FROM bench_run_scores s
         JOIN bench_runs r ON r.id = s.run_id
         WHERE r.mode = ? AND r.model = ? AND r.status = 'ok' AND s.task_id = ?
         ORDER BY r.ts_ms DESC, r.id DESC LIMIT ?`,
      )
      .all(mode, model, taskId, capped);
    return rows.reverse().map((r) => ({
      runId: r.run_id,
      tsMs: r.ts_ms,
      scorePct: r.max_score === 0 ? 0 : Math.round((r.score / r.max_score) * 1000) / 10,
      titleFa: r.title_fa,
    }));
  }

  /**
   * Last time an alert with this key was sent (unix ms), or null when never.
   * Keys look like `regression:live:<model>` — scoped so one mode/model
   * pair's cooldown never suppresses another's.
   */
  lastAlertSent(key: string): number | null {
    this.init();
    const row = this.db
      .query<{ last_sent_ms: number }, [string]>(
        `SELECT last_sent_ms FROM bench_alerts WHERE key = ?`,
      )
      .get(key);
    return row === null ? null : row.last_sent_ms;
  }

  /** Record that an alert with this key was sent now. */
  markAlertSent(key: string, nowMs: number): void {
    this.init();
    this.db
      .query(
        `INSERT INTO bench_alerts(key, last_sent_ms) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET last_sent_ms = excluded.last_sent_ms`,
      )
      .run(key, Math.floor(nowMs));
  }

  /** Drop the oldest runs beyond the cap; score rows follow via FK cascade. */
  private prune(): void {
    const row = this.db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM bench_runs`)
      .get();
    const count = row?.n ?? 0;
    if (count <= MAX_BENCH_RUNS) return;
    this.db
      .query(
        `DELETE FROM bench_runs WHERE id IN (
           SELECT id FROM bench_runs ORDER BY ts_ms ASC, id ASC LIMIT ?
         )`,
      )
      .run(count - MAX_BENCH_RUNS);
  }
}

function toSummary(row: BenchRunRow): BenchRunSummary {
  return {
    id: row.id,
    runStamp: row.run_stamp,
    tsMs: row.ts_ms,
    mode: row.mode,
    provider: row.provider,
    model: row.model,
    taskCount: row.task_count,
    passed: row.passed,
    failed: row.failed,
    avgScorePct: row.avg_score_pct,
    totalLatencyMs: row.total_latency_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    status: row.status,
    note: row.note ?? null,
  };
}

function toScore(row: BenchScoreRow): BenchTaskScore {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    titleFa: row.title_fa,
    score: row.score,
    maxScore: row.max_score,
    passed: row.passed === 1,
  };
}
