/**
 * Tests for the regression baseline (`src/bench/baseline.ts`).
 *
 * Deterministic: :memory: SQLite, canned reports, no network, no model.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BenchHistory } from "../src/bench/history";
import {
  alertDue,
  alertKeyFor,
  compareToBaseline,
  decideAlert,
  formatRegressionAlert,
  formatSkipAlert,
  recordAlertSent,
} from "../src/bench/baseline";
import type { BenchReport, TaskResult } from "../bench/run";

function taskResult(over: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: "calc_01",
    title_fa: "جمع ساده",
    category: "calc",
    passed: true,
    score: 3,
    maxScore: 3,
    checks: [],
    turns: [],
    totalLatencyMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    costEstimated: true,
    ...over,
  };
}

function report(over: Partial<BenchReport> = {}): BenchReport {
  return {
    generatedAt: "2026-10-18T19:00:00.000Z",
    mode: "offline",
    provider: "fake (offline plumbing)",
    model: "fake",
    taskCount: 1,
    totals: {
      passed: 1,
      failed: 0,
      avgScorePct: 80,
      totalLatencyMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    },
    results: [taskResult()],
    ...over,
  };
}

/** Seed `n` runs at the given avg scores (newest last), same mode/model. */
function seed(history: BenchHistory, avgs: number[], mode = "offline", model = "fake"): void {
  avgs.forEach((avg, i) => {
    const r = report({
      mode: mode as "offline" | "live",
      model,
      generatedAt: new Date(Date.UTC(2026, 9, 10 + i)).toISOString(),
      totals: { ...report().totals, avgScorePct: avg },
    });
    history.recordRun(r);
  });
}

let history: BenchHistory;

beforeEach(() => {
  history = new BenchHistory(new Database(":memory:"));
});

describe("compareToBaseline", () => {
  test("insufficient baseline: no alert with fewer than minRuns", () => {
    seed(history, [80, 82]);
    const cmp = compareToBaseline(history, report());
    expect(cmp.reason).toBe("insufficient_baseline");
    expect(cmp.alert).toBe(false);
    expect(cmp.baselineRuns).toBe(2);
  });

  test("stable scores: no alert", () => {
    seed(history, [80, 81, 79, 82, 80]);
    const cmp = compareToBaseline(history, report());
    expect(cmp.reason).toBe("ok");
    expect(cmp.alert).toBe(false);
    expect(cmp.baselineAvgPct).toBeCloseTo(80.4, 1);
  });

  test("drop of >= 5 points: alert with delta", () => {
    seed(history, [80, 81, 79, 82, 80]);
    const cmp = compareToBaseline(
      history,
      report({ totals: { ...report().totals, avgScorePct: 70 } }),
    );
    expect(cmp.reason).toBe("regression");
    expect(cmp.alert).toBe(true);
    expect(cmp.dropPctPts).toBeCloseTo(10.4, 1);
  });

  test("small drop below threshold: no alert", () => {
    seed(history, [80, 80, 80]);
    const cmp = compareToBaseline(
      history,
      report({ totals: { ...report().totals, avgScorePct: 77 } }),
    );
    expect(cmp.alert).toBe(false);
    expect(cmp.reason).toBe("ok");
  });

  test("baseline is scoped to (mode, model)", () => {
    seed(history, [40, 42, 41], "live", "m-real");
    // An offline run at 80 must not compare against the live 40s baseline.
    const cmp = compareToBaseline(history, report({ mode: "offline", model: "fake" }));
    expect(cmp.reason).toBe("insufficient_baseline");
  });

  test("per-task drops are listed when >= 20 points", () => {
    // Seed: calc_01 at 100% in the last 3 runs.
    for (let i = 0; i < 3; i++) {
      history.recordRun(
        report({ generatedAt: new Date(Date.UTC(2026, 9, 10 + i)).toISOString() }),
      );
    }
    // New run: calc_01 drops to 0%, overall still barely below threshold —
    // craft overall avg so the OVERALL drop does not trigger but the task
    // finding is still recorded. (overall 80 -> 78: drop 2 < 5)
    const r = report({
      totals: { ...report().totals, avgScorePct: 78 },
      results: [taskResult({ score: 0, maxScore: 3, passed: false })],
    });
    const cmp = compareToBaseline(history, r);
    expect(cmp.topDrops).toHaveLength(1);
    expect(cmp.topDrops[0]!.taskId).toBe("calc_01");
    expect(cmp.topDrops[0]!.dropPctPts).toBe(100);
  });
});

describe("decideAlert + cooldown", () => {
  test("fires once per cooldown window", () => {
    seed(history, [80, 80, 80]);
    const bad = report({ totals: { ...report().totals, avgScorePct: 60 } });
    const nowMs = 1_000_000;
    const first = decideAlert(history, bad, { now: () => nowMs });
    expect(first.fire).toBe(true);
    recordAlertSent(history, first.key, nowMs);
    const second = decideAlert(history, bad, { now: () => nowMs + 60_000 });
    expect(second.fire).toBe(false);
    // After the cooldown it fires again.
    const third = decideAlert(history, bad, {
      now: () => nowMs + 25 * 60 * 60 * 1000,
    });
    expect(third.fire).toBe(true);
  });

  test("cooldown is scoped per (mode, model) key", () => {
    seed(history, [80, 80, 80], "live", "m1");
    const badLive = report({
      mode: "live",
      model: "m1",
      totals: { ...report().totals, avgScorePct: 60 },
    });
    const key = alertKeyFor(badLive);
    expect(key).toBe("regression:live:m1");
    recordAlertSent(history, key, 1_000_000);
    expect(alertDue(history, key, 2_000_000, 24 * 60 * 60 * 1000)).toBe(false);
    expect(alertDue(history, "regression:live:m2", 2_000_000, 24 * 60 * 60 * 1000)).toBe(true);
  });
});

describe("alert formatting", () => {
  test("regression alert has scores/deltas but no raw model output", () => {
    seed(history, [80, 80, 80]);
    const bad = report({
      totals: { ...report().totals, avgScorePct: 60 },
      results: [
        taskResult({
          taskId: "mem_birthday",
          title_fa: "تولد",
          score: 0,
          maxScore: 4,
          passed: false,
          turns: [
            {
              toolCalls: [{ name: "memorize", args: { secret: "PWNED" } }],
              finalText: "this is raw model output, must not appear",
              latencyMs: 1,
              ttfbMs: null,
              inputTokens: 1,
              outputTokens: 1,
            },
          ],
        }),
      ],
    });
    const cmp = compareToBaseline(history, bad);
    const text = formatRegressionAlert(cmp, bad);
    expect(text).toContain("افت");
    expect(text).toContain("60");
    expect(text).not.toContain("this is raw model output");
    expect(text).not.toContain("PWNED");
    expect(text).not.toContain("memorize");
  });

  test("skip alert names the reason and the /ai fix", () => {
    const text = formatSkipAlert("ارائه‌دهنده پیکربندی نشده است.");
    expect(text).toContain("ارائه‌دهنده پیکربندی نشده است.");
    expect(text).toContain("/ai");
  });
});
