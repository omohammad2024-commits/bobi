/**
 * Usage/cost dashboard data-layer tests.
 *
 * Covers getDailyBreakdown (per-day totals over the window), getByProvider
 * (model→provider mapping incl. the unknown bucket), and getLatencyStats
 * (currently untracked: percentiles are null with tracked=false).
 * Runs against an in-memory Storage; never touches storage.ts.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import {
  UsageTracker,
  getByProvider,
  getDailyBreakdown,
  getLatencyStats,
} from "../src/ai/usage";

const DAY_MS = 24 * 60 * 60 * 1000;

function seed(): Storage {
  const storage = Storage.open(":memory:");
  const tracker = new UsageTracker(storage);
  const p1 = storage.createProvider({ label: "Alpha", adapter: "openai", baseUrl: "https://a.example" });
  const p2 = storage.createProvider({ label: "Beta", adapter: "anthropic", baseUrl: "https://b.example" });
  storage.createModel({ providerId: p1, modelId: "gpt-4o-mini", label: "mini" });
  storage.createModel({ providerId: p2, modelId: "claude-haiku-4", label: "haiku" });

  const now = Date.now();
  const rec = (modelId: string, providerId: number, at: number, input: number, output: number) =>
    tracker.record({
      userId: "u1",
      conversationId: 1,
      providerId,
      modelId,
      usage: { inputTokens: input, outputTokens: output },
      at,
    });

  // today: 2 runs on Alpha/gpt-4o-mini, 1 run on Beta/claude-haiku-4
  rec("gpt-4o-mini", p1, now - 1000, 1000, 500);
  rec("gpt-4o-mini", p1, now - 2000, 2000, 1000);
  rec("claude-haiku-4", p2, now - 3000, 500, 250);
  // yesterday: 1 run on an unmapped model (provider deleted / unknown)
  rec("ghost-model-x", 999, now - DAY_MS - 1000, 100, 50);
  // 40 days ago: outside the 30-day window
  rec("gpt-4o-mini", p1, now - 40 * DAY_MS, 10, 5);
  return storage;
}

describe("getDailyBreakdown", () => {
  test("returns one row per day, oldest first, with today's totals", () => {
    const storage = seed();
    const rows = getDailyBreakdown(storage, 7);
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.dayStartMs).toBeGreaterThan(rows[i - 1]!.dayStartMs);
    }
    const today = rows[rows.length - 1]!;
    expect(today.runs).toBe(3);
    expect(today.inputTokens).toBe(3500);
    expect(today.outputTokens).toBe(1750);
    expect(today.estimatedUsd).toBeGreaterThan(0);
    const yesterday = rows[rows.length - 2]!;
    expect(yesterday.runs).toBe(1);
    expect(yesterday.inputTokens).toBe(100);
    // the 40-day-old row is outside a 30-day window
    const rows30 = getDailyBreakdown(storage, 30);
    const totalRuns = rows30.reduce((a, r) => a + r.runs, 0);
    expect(totalRuns).toBe(4);
  });

  test("clamps days to 1..90", () => {
    const storage = seed();
    expect(getDailyBreakdown(storage, 0).length).toBe(1);
    expect(getDailyBreakdown(storage, -5).length).toBe(1);
    expect(getDailyBreakdown(storage, 500).length).toBe(90);
    expect(getDailyBreakdown(storage, Number.NaN).length).toBe(7);
  });
});

describe("getByProvider", () => {
  test("aggregates per provider with names, most runs first", () => {
    const storage = seed();
    const rows = getByProvider(storage, 30);
    expect(rows.length).toBe(3); // Alpha, Beta, unknown bucket
    expect(rows[0]!.providerName).toBe("Alpha");
    expect(rows[0]!.runs).toBe(2);
    expect(rows[0]!.inputTokens).toBe(3000);
    expect(rows[0]!.outputTokens).toBe(1500);
    expect(rows[0]!.estimatedUsd).toBeGreaterThan(0);
    const beta = rows.find((r) => r.providerName === "Beta")!;
    expect(beta.runs).toBe(1);
    const unknown = rows.find((r) => r.providerId === 0)!;
    expect(unknown.providerName).toBe("Removed or unknown");
    expect(unknown.runs).toBe(1);
    // failure/latency data is not captured by the ledger
    for (const r of rows) {
      expect(r.successRate).toBeNull();
      expect(r.avgLatencyMs).toBeNull();
    }
  });

  test("empty window returns no rows", () => {
    const storage = Storage.open(":memory:");
    expect(getByProvider(storage, 7)).toEqual([]);
  });
});

describe("getLatencyStats", () => {
  test("reports untracked with per-model run counts and null percentiles", () => {
    const storage = seed();
    const stats = getLatencyStats(storage, 30);
    expect(stats.tracked).toBe(false);
    const byId = new Map(stats.perModel.map((m) => [m.modelId, m]));
    expect(byId.get("gpt-4o-mini")!.runs).toBe(2);
    expect(byId.get("claude-haiku-4")!.runs).toBe(1);
    for (const m of stats.perModel) {
      expect(m.p50Ms).toBeNull();
      expect(m.p95Ms).toBeNull();
      expect(m.maxMs).toBeNull();
    }
  });
});
