/**
 * Tests for the run_bench tool (`src/bench/tool.ts`).
 *
 * Deterministic: the suite executor is injected (canned BenchReport),
 * :memory: history, no network, no provider.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ToolError } from "../src/tools/errors";
import type { ToolContext } from "../src/tools/types";
import { createRunBenchTool, RUN_BENCH_PERMISSION } from "../src/bench/tool";
import { BenchHistory } from "../src/bench/history";
import type { BenchReport, BenchStack } from "../bench/run";

const OWNER = "1001";

function ctx(userId = OWNER): ToolContext {
  return {
    clock: () => new Date("2026-10-18T19:00:00.000Z"),
    actor: { userId, permissions: [RUN_BENCH_PERMISSION] },
    signal: new AbortController().signal,
  };
}

function cannedReport(over: Partial<BenchReport> = {}): BenchReport {
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
        totalLatencyMs: 10,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
        costEstimated: true,
      },
    ],
    ...over,
  };
}

interface Harness {
  history: BenchHistory;
  notified: string[];
  log: string[];
  run: (input: Parameters<ReturnType<typeof createRunBenchTool>["run"]>[0], userId?: string) =>
    ReturnType<ReturnType<typeof createRunBenchTool>["run"]>;
}

function harness(over: Partial<Parameters<typeof createRunBenchTool>[0]> = {}): Harness {
  const history = new BenchHistory(new Database(":memory:"));
  const notified: string[] = [];
  const log: string[] = [];
  const tool = createRunBenchTool({
    isOwner: (id) => id === OWNER,
    history,
    notifyOwner: async (text) => {
      notified.push(text);
    },
    executeSuite: async () => cannedReport(),
    log: (m) => log.push(m),
    ...over,
  });
  const effHistory = over.history ?? history;
  return {
    history: effHistory,
    notified,
    log,
    run: (input, userId = OWNER) => tool.run(input, ctx(userId)),
  };
}

describe("run_bench", () => {
  test("is ownerOnly with the tools:run_bench permission", () => {
    const h = harness();
    // Re-create to inspect the definition.
    const tool = createRunBenchTool({
      isOwner: () => true,
      history: h.history,
      notifyOwner: async () => {},
    });
    expect(tool.name).toBe("run_bench");
    expect(tool.ownerOnly).toBe(true);
    expect(tool.permission.requires).toContain(RUN_BENCH_PERMISSION);
  });

  test("rejects non-owners", async () => {
    const h = harness();
    await expect(h.run({ mode: "offline" }, "999")).rejects.toBeInstanceOf(ToolError);
  });

  test("offline run records history and returns a summary", async () => {
    const h = harness();
    const out = await h.run({ mode: "offline" });
    expect(out.status).toBe("ok");
    expect(out.mode).toBe("offline");
    expect(out.runId).toBeGreaterThan(0);
    expect(out.avgScorePct).toBe(80);
    expect(out.alerted).toBe(false);
    expect(out.summary).toContain("بنچ‌مارک تمام شد");
    const runs = h.history.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.avgScorePct).toBe(80);
  });

  test("regression triggers exactly one alert inside the cooldown", async () => {
    // Seed a healthy baseline first.
    const seed = harness();
    for (let i = 0; i < 3; i++) await seed.run({ mode: "offline" });
    // Same history, now the suite regresses.
    const h = harness({
      history: seed.history,
      executeSuite: async () =>
        cannedReport({ totals: { ...cannedReport().totals, avgScorePct: 50 } }),
    });
    const first = await h.run({ mode: "offline" });
    expect(first.alerted).toBe(true);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toContain("افت کیفیت");
    // A second regressed run inside 24h: stored, but no second alert.
    const second = await h.run({ mode: "offline" });
    expect(second.status).toBe("ok");
    expect(second.alerted).toBe(false);
    expect(h.notified).toHaveLength(1);
    expect(h.history.listRuns()).toHaveLength(5);
  });

  test("live run with no provider SKIPS LOUDLY: notify, record nothing", async () => {
    const h = harness({
      buildLive: () => {
        throw new Error("ارائه‌دهندهٔ هوش مصنوعی پیکربندی نشده است.");
      },
    });
    const out = await h.run({ mode: "live" });
    expect(out.status).toBe("skipped");
    expect(out.runId).toBeUndefined();
    expect(h.history.listRuns()).toHaveLength(0);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toContain("اجرا نشد");
    expect(h.notified[0]).toContain("/ai");
  });

  test("live run with a configured provider is recorded as live", async () => {
    const h = harness({
      buildLive: () => ({ providerName: "live: x", model: "m" }) as unknown as BenchStack,
      executeSuite: async () =>
        cannedReport({ mode: "live", provider: "live: x", model: "m" }),
    });
    const out = await h.run({ mode: "live" });
    expect(out.status).toBe("ok");
    const runs = h.history.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.mode).toBe("live");
    expect(runs[0]!.model).toBe("m");
  });

  test("live without a buildLive dep is refused, not faked", async () => {
    const h = harness();
    await expect(h.run({ mode: "live" })).rejects.toBeInstanceOf(ToolError);
    expect(h.history.listRuns()).toHaveLength(0);
    expect(h.notified).toHaveLength(0);
  });

  test("invalid mode and bad task ids are rejected", async () => {
    const h = harness();
    await expect(h.run({ mode: "nope" as never })).rejects.toBeInstanceOf(ToolError);
    await expect(h.run({ tasks: ["BAD-ID!"] })).rejects.toBeInstanceOf(ToolError);
    expect(h.history.listRuns()).toHaveLength(0);
  });

  test("task subset is passed through to the executor", async () => {
    let seen: string[] | undefined;
    const h = harness({
      executeSuite: async (_stack, _runId, taskIds) => {
        seen = taskIds;
        return cannedReport();
      },
    });
    await h.run({ tasks: ["calc_01", "mem_food"] });
    expect(seen).toEqual(["calc_01", "mem_food"]);
  });

  test("a notify failure never fails the run", async () => {
    const h = harness({
      notifyOwner: async () => {
        throw new Error("telegram down");
      },
    });
    // Force an alert: seed baseline, then regress.
    for (let i = 0; i < 3; i++) await h.run({ mode: "offline" });
    const h2 = harness({
      history: h.history,
      notifyOwner: async () => {
        throw new Error("telegram down");
      },
      executeSuite: async () =>
        cannedReport({ totals: { ...cannedReport().totals, avgScorePct: 10 } }),
    });
    const out = await h2.run({ mode: "offline" });
    expect(out.status).toBe("ok");
    expect(h2.log.some((m) => m.includes("notify"))).toBe(true);
  });
});
