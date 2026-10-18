/**
 * Tests for the benchmark history store (`src/bench/history.ts`).
 *
 * Deterministic: :memory: SQLite, canned BenchReport fixtures, no network.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BenchHistory, MAX_BENCH_RUNS } from "../src/bench/history";
import type { BenchReport } from "../bench/run";

function fixture(over: Partial<BenchReport> = {}): BenchReport {
  return {
    generatedAt: "2026-10-18T19:00:00.000Z",
    mode: "offline",
    provider: "fake (offline plumbing)",
    model: "fake",
    taskCount: 2,
    totals: {
      passed: 2,
      failed: 0,
      avgScorePct: 80,
      totalLatencyMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0,
    },
    results: [
      {
        taskId: "calc_01",
        title_fa: "جمع ساده",
        category: "calc",
        passed: true,
        score: 3,
        maxScore: 3,
        checks: [],
        turns: [],
        totalLatencyMs: 50,
        inputTokens: 5,
        outputTokens: 10,
        costUsd: 0,
        costEstimated: true,
      },
      {
        taskId: "calc_02",
        title_fa: "ضرب",
        category: "calc",
        passed: false,
        score: 1,
        maxScore: 2,
        checks: [],
        turns: [],
        totalLatencyMs: 50,
        inputTokens: 5,
        outputTokens: 10,
        costUsd: 0,
        costEstimated: true,
      },
    ],
    ...over,
  };
}

let db: Database;
let history: BenchHistory;

beforeEach(() => {
  db = new Database(":memory:");
  history = new BenchHistory(db);
});

describe("recordRun / listRuns / getRun", () => {
  test("records a run and lists it newest-first", () => {
    const id1 = history.recordRun(fixture());
    const id2 = history.recordRun(
      fixture({ generatedAt: "2026-10-18T20:00:00.000Z" }),
    );
    expect(id2).toBeGreaterThan(id1);
    const runs = history.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]!.id).toBe(id2);
    expect(runs[0]!.avgScorePct).toBe(80);
    expect(runs[0]!.taskCount).toBe(2);
    expect(runs[0]!.status).toBe("ok");
  });

  test("getRun returns the summary and per-task scores", () => {
    const id = history.recordRun(fixture());
    const got = history.getRun(id);
    expect(got).toBeDefined();
    expect(got!.summary.id).toBe(id);
    expect(got!.summary.model).toBe("fake");
    expect(got!.scores).toHaveLength(2);
    expect(got!.scores[0]!.taskId).toBe("calc_01");
    expect(got!.scores[0]!.passed).toBe(true);
    expect(got!.scores[1]!.passed).toBe(false);
  });

  test("getRun returns undefined for unknown ids", () => {
    expect(history.getRun(999)).toBeUndefined();
    expect(history.getRun(-1)).toBeUndefined();
  });

  test("skipped runs are recorded with status skipped", () => {
    const id = history.recordRun(fixture(), "skipped");
    expect(history.getRun(id)!.summary.status).toBe("skipped");
  });

  test("prunes beyond MAX_BENCH_RUNS, oldest first", () => {
    for (let i = 0; i < MAX_BENCH_RUNS + 5; i++) {
      history.recordRun(
        fixture({
          generatedAt: new Date(Date.UTC(2026, 9, 18, 0, i)).toISOString(),
        }),
      );
    }
    const runs = history.listRuns(MAX_BENCH_RUNS + 5);
    expect(runs).toHaveLength(MAX_BENCH_RUNS);
    // Newest kept: the last inserted (i = MAX+4). Oldest kept: i = 5 —
    // the first five (i = 0..4) were pruned.
    expect(runs[0]!.runStamp).toBe(
      new Date(Date.UTC(2026, 9, 18, 0, MAX_BENCH_RUNS + 4)).toISOString(),
    );
    expect(runs[runs.length - 1]!.runStamp).toBe(
      new Date(Date.UTC(2026, 9, 18, 0, 5)).toISOString(),
    );
  });
});

describe("baselineRuns / trends", () => {
  test("baselineRuns returns newest N for one (mode, model), skipping skips", () => {
    history.recordRun(fixture({ mode: "live", model: "m1" }));
    history.recordRun(fixture({ mode: "live", model: "m1" }), "skipped");
    history.recordRun(fixture({ mode: "live", model: "m2" }));
    history.recordRun(fixture({ mode: "offline", model: "fake" }));
    const base = history.baselineRuns("live", "m1", 5);
    expect(base).toHaveLength(1);
    expect(base[0]!.model).toBe("m1");
  });

  test("overallTrend is oldest-first", () => {
    history.recordRun(
      fixture({ generatedAt: "2026-10-18T18:00:00.000Z", totals: { ...fixture().totals, avgScorePct: 70 } }),
    );
    history.recordRun(
      fixture({ generatedAt: "2026-10-18T19:00:00.000Z", totals: { ...fixture().totals, avgScorePct: 90 } }),
    );
    const trend = history.overallTrend("offline", "fake", 5);
    expect(trend.map((t) => t.avgScorePct)).toEqual([70, 90]);
  });

  test("taskTrend computes per-task percentages oldest-first", () => {
    history.recordRun(fixture({ generatedAt: "2026-10-18T18:00:00.000Z" }));
    const r2 = fixture({ generatedAt: "2026-10-18T19:00:00.000Z" });
    r2.results[0] = { ...r2.results[0]!, score: 0, passed: false };
    history.recordRun(r2);
    const trend = history.taskTrend("offline", "fake", "calc_01", 5);
    expect(trend.map((t) => t.scorePct)).toEqual([100, 0]);
    expect(history.taskTrend("offline", "fake", "nope", 5)).toHaveLength(0);
  });
});

describe("alert cooldown state", () => {
  test("lastAlertSent is null until marked", () => {
    expect(history.lastAlertSent("regression:live:m")).toBeNull();
    history.markAlertSent("regression:live:m", 12345);
    expect(history.lastAlertSent("regression:live:m")).toBe(12345);
    // Another key is unaffected.
    expect(history.lastAlertSent("regression:live:other")).toBeNull();
  });
});
