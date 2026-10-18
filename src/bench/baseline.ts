/**
 * Benchmark regression baseline + quality-alert formatting.
 *
 * After each run_bench run the new result is compared against a rolling
 * baseline: the mean avg-score of the last N completed runs for the same
 * (mode, model) pair. A significant drop raises a Persian alert to the
 * owner. Thresholds and the alert format are documented in
 * docs/PHASE3_BENCH.md.
 *
 * PRIVACY: alert text carries scores and deltas ONLY — never prompts, never
 * raw model output, never tool arguments. A benchmark alert is a number, not
 * a transcript.
 */
import type { BenchReport } from "../../bench/run";
import type { BenchHistory } from "./history";

export interface BaselineOptions {
  /** Runs in the rolling window (default 5). */
  windowN?: number;
  /** Minimum runs before a baseline exists (default 3). */
  minRuns?: number;
  /** Alert when newAvg < baselineAvg - this (percentage points, default 5). */
  absDropPctPts?: number;
  /** Per-task: flagged when a task drops at least this many points (default 20). */
  taskDropPctPts?: number;
  /** One alert per key per this long (ms, default 24h). */
  alertCooldownMs?: number;
  /** Injectable clock. */
  now?: () => number;
}

export const DEFAULT_BASELINE_OPTIONS: Required<BaselineOptions> = {
  windowN: 5,
  minRuns: 3,
  absDropPctPts: 5,
  taskDropPctPts: 20,
  alertCooldownMs: 24 * 60 * 60 * 1000,
  now: () => Date.now(),
};

export interface RegressionFinding {
  taskId: string;
  titleFa: string;
  prevAvgPct: number;
  nowPct: number;
  dropPctPts: number;
}

export interface BaselineComparison {
  /** True when the owner should be alerted. */
  alert: boolean;
  reason: "ok" | "insufficient_baseline" | "regression";
  baselineAvgPct: number | null;
  baselineRuns: number;
  nowAvgPct: number;
  dropPctPts: number | null;
  /** Worst per-task drops (informational; the overall drop triggers). */
  topDrops: RegressionFinding[];
}

/**
 * Compare a fresh report against the stored baseline. Pure function of
 * (history, report) — no side effects, so it is safe to call in tests and
 * in /bench trend without touching the cooldown.
 */
export function compareToBaseline(
  history: BenchHistory,
  report: BenchReport,
  opts: BaselineOptions = {},
): BaselineComparison {
  const o = { ...DEFAULT_BASELINE_OPTIONS, ...opts };
  const runs = history.baselineRuns(report.mode, report.model, o.windowN);
  const nowAvg = report.totals.avgScorePct;

  if (runs.length < o.minRuns) {
    return {
      alert: false,
      reason: "insufficient_baseline",
      baselineAvgPct: null,
      baselineRuns: runs.length,
      nowAvgPct: nowAvg,
      dropPctPts: null,
      topDrops: [],
    };
  }

  const baselineAvg = runs.reduce((a, r) => a + r.avgScorePct, 0) / runs.length;
  const drop = baselineAvg - nowAvg;

  // Per-task previous average: mean scorePct over the newest 3 runs that
  // contain this task. Tasks that never appeared before are not flagged —
  // there is nothing to regress from.
  const topDrops: RegressionFinding[] = [];
  for (const r of report.results) {
    const trend = history.taskTrend(report.mode, report.model, r.taskId, 3);
    if (trend.length === 0) continue;
    const prevAvg = trend.reduce((a, t) => a + t.scorePct, 0) / trend.length;
    const nowPct = r.maxScore === 0 ? 0 : Math.round((r.score / r.maxScore) * 1000) / 10;
    const taskDrop = prevAvg - nowPct;
    if (taskDrop >= o.taskDropPctPts) {
      topDrops.push({
        taskId: r.taskId,
        titleFa: r.title_fa,
        prevAvgPct: round1(prevAvg),
        nowPct: round1(nowPct),
        dropPctPts: round1(taskDrop),
      });
    }
  }
  topDrops.sort((a, b) => b.dropPctPts - a.dropPctPts);

  const regressed = drop >= o.absDropPctPts;
  return {
    alert: regressed,
    reason: regressed ? "regression" : "ok",
    baselineAvgPct: round1(baselineAvg),
    baselineRuns: runs.length,
    nowAvgPct: round1(nowAvg),
    dropPctPts: round1(drop),
    topDrops: topDrops.slice(0, 5),
  };
}

/**
 * Cooldown key for this report. Scoped to (mode, model) so one pair's alert
 * never suppresses another's.
 */
export function alertKeyFor(report: BenchReport): string {
  return `regression:${report.mode}:${report.model}`;
}

/** Should the alert fire now, given the cooldown state? */
export function alertDue(
  history: BenchHistory,
  key: string,
  nowMs: number,
  cooldownMs: number,
): boolean {
  const last = history.lastAlertSent(key);
  return last === null || nowMs - last >= cooldownMs;
}

/** Mark the alert as sent (call after a successful notify). */
export function recordAlertSent(history: BenchHistory, key: string, nowMs: number): void {
  history.markAlertSent(key, nowMs);
}

/** One decision point the run_bench tool uses: compare + cooldown + mark. */
export function decideAlert(
  history: BenchHistory,
  report: BenchReport,
  opts: BaselineOptions = {},
): { comparison: BaselineComparison; key: string; fire: boolean } {
  const o = { ...DEFAULT_BASELINE_OPTIONS, ...opts };
  const comparison = compareToBaseline(history, report, o);
  const key = alertKeyFor(report);
  const fire =
    comparison.alert && alertDue(history, key, o.now(), o.alertCooldownMs);
  return { comparison, key, fire };
}

// ---------- Persian alert / status text ----------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function tehranDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      timeZone: "Asia/Tehran",
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function modeLabelFa(mode: string): string {
  return mode === "live" ? "زنده (مدل واقعی)" : "آفلاین (plumbing)";
}

/**
 * The regression alert. Scores and deltas only — deliberately no task
 * prompts, no tool arguments, no raw model output.
 */
export function formatRegressionAlert(
  comparison: BaselineComparison,
  report: BenchReport,
): string {
  const L: string[] = [];
  L.push("⚠️ هشدار افت کیفیت بنچ‌مارک");
  L.push(`حالت: ${modeLabelFa(report.mode)} — مدل: ${report.model}`);
  L.push(`میانگین امتیاز این اجرا: ${comparison.nowAvgPct}٪`);
  L.push(
    `میانگین ${comparison.baselineRuns} اجرای اخیر: ${comparison.baselineAvgPct}٪ — افت ${comparison.dropPctPts} واحد.`,
  );
  if (comparison.topDrops.length > 0) {
    L.push("بیشترین افت‌ها:");
    for (const d of comparison.topDrops.slice(0, 5)) {
      L.push(`• ${d.taskId}: ${d.prevAvgPct}٪ ← ${d.nowPct}٪ (افت ${d.dropPctPts})`);
    }
  }
  L.push(`زمان اجرا: ${tehranDate(report.generatedAt)}`);
  L.push("جزئیات کامل: /bench history");
  return L.join("\n");
}

/**
 * The loud skip: a scheduled LIVE run with no configured provider must tell
 * the owner plainly instead of silently faking a run.
 */
export function formatSkipAlert(reason: string): string {
  return (
    "⚠️ بنچ‌مارک زنده اجرا نشد و رد شد.\n" +
    `دلیل: ${reason}\n` +
    "هیچ امتیازی ثبت نشد — با دستور /ai یک ارائه‌دهنده و مدل انتخاب کنید، بعد زمان‌بندی را دوباره فعال کنید."
  );
}

/** Short one-liner the run_bench tool returns to its caller. */
export function formatRunSummary(report: BenchReport, storedId: number): string {
  return (
    `بنچ‌مارک تمام شد (شناسهٔ ثبت: ${storedId}). حالت: ${modeLabelFa(report.mode)} — مدل: ${report.model}\n` +
    `موفق: ${report.totals.passed} از ${report.taskCount} — میانگین امتیاز: ${report.totals.avgScorePct}٪`
  );
}
