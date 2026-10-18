/**
 * Tests for the Phase-3 benchmark commands (`src/bot/cmd_phase3_bench.ts`).
 *
 * Handlers are exercised through their exported functions with stub deps —
 * no Telegram, no network, no scheduler.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BenchHistory } from "../src/bench/history";
import {
  BENCH_SCHEDULE_TASK_NAME,
  COMMAND_DEFS,
  handleBench,
  handleBenchHistory,
  handleBenchRun,
  handleBenchSchedule,
  handleBenchStatus,
  handleBenchTrend,
  type BenchDeps,
} from "../src/bot/cmd_phase3_bench";
import type { SenderRef } from "../src/bot/cmd_auto";
import type { BenchReport } from "../bench/run";

const sender: SenderRef = { userId: "1001", telegramId: 1001, chatId: "1001" };

function cannedReport(avg: number, atIso: string): BenchReport {
  return {
    generatedAt: atIso,
    mode: "offline",
    provider: "fake (offline plumbing)",
    model: "fake",
    taskCount: 1,
    totals: {
      passed: 1,
      failed: 0,
      avgScorePct: avg,
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
  };
}

let history: BenchHistory;

beforeEach(() => {
  history = new BenchHistory(new Database(":memory:"));
});

function deps(over: Partial<BenchDeps> = {}): BenchDeps {
  return { history, ...over } as unknown as BenchDeps;
}

describe("COMMAND_DEFS", () => {
  test("bench is registered as owner-only", () => {
    expect(COMMAND_DEFS).toHaveLength(1);
    expect(COMMAND_DEFS[0]!.command).toBe("bench");
    expect(COMMAND_DEFS[0]!.ownerOnly).toBe(true);
    expect(COMMAND_DEFS[0]!.descriptionFa.length).toBeGreaterThan(0);
    expect(COMMAND_DEFS[0]!.descriptionEn.length).toBeGreaterThan(0);
  });
});

describe("handleBench dispatch", () => {
  test("non-owner gets the owner-only refusal", async () => {
    const out = await handleBench(deps(), sender, "history", false, "fa");
    expect(out).toContain("مالک");
  });

  test("empty and unknown subcommands show help", async () => {
    expect(await handleBench(deps(), sender, "", true, "fa")).toContain("/bench history");
    expect(await handleBench(deps(), sender, "wat", true, "fa")).toContain("/bench history");
  });

  test("english help", async () => {
    expect(await handleBench(deps(), sender, "help", true, "en")).toContain("/bench history");
  });
});

describe("handleBenchHistory", () => {
  test("empty history message", () => {
    expect(handleBenchHistory(history, 10, "fa")).toContain("ثبت نشده");
  });

  test("lists runs newest-first with scores", () => {
    history.recordRun(cannedReport(70, "2026-10-18T18:00:00.000Z"));
    history.recordRun(cannedReport(90, "2026-10-18T19:00:00.000Z"));
    const out = handleBenchHistory(history, 10, "fa");
    expect(out).toContain("میانگین امتیاز: 90٪");
    expect(out).toContain("میانگین امتیاز: 70٪");
    expect(out.indexOf("90٪")).toBeLessThan(out.indexOf("70٪"));
  });
});

describe("handleBenchTrend", () => {
  test("overall trend oldest-first", () => {
    history.recordRun(cannedReport(70, "2026-10-18T18:00:00.000Z"));
    history.recordRun(cannedReport(90, "2026-10-18T19:00:00.000Z"));
    const out = handleBenchTrend(history, undefined, "fa");
    expect(out).toContain("روند میانگین امتیاز");
    expect(out.indexOf("70٪")).toBeLessThan(out.indexOf("90٪"));
  });

  test("per-task trend and unknown task", () => {
    history.recordRun(cannedReport(80, "2026-10-18T19:00:00.000Z"));
    const out = handleBenchTrend(history, "calc_01", "fa");
    expect(out).toContain("calc_01");
    expect(out).toContain("100٪");
    expect(handleBenchTrend(history, "nope", "fa")).toContain("nope");
  });

  test("empty history", () => {
    expect(handleBenchTrend(history, undefined, "fa")).toContain("ثبت نشده");
  });
});

describe("handleBenchRun", () => {
  test("unwired runner explains the CLI fallback", async () => {
    const out = await handleBenchRun(deps(), sender, [], "fa");
    expect(out).toContain("bench/run.ts");
  });

  test("wired runner returns the summary", async () => {
    const d = deps({
      runBenchNow: async () => ({
        status: "ok",
        runId: 3,
        mode: "offline",
        alerted: false,
        summary: "بنچ‌مارک تمام شد (شناسهٔ ثبت: 3).",
      }),
    });
    const out = await handleBenchRun(d, sender, [], "fa");
    expect(out).toContain("شناسهٔ ثبت: 3");
  });

  test("live mode is forwarded and noted", async () => {
    let seenMode = "";
    const d = deps({
      runBenchNow: async (opts) => {
        seenMode = opts.mode;
        return { status: "ok", mode: "live", alerted: false, summary: "ok" };
      },
    });
    const out = await handleBenchRun(d, sender, ["--live"], "fa");
    expect(seenMode).toBe("live");
    expect(out).toContain("چند دقیقه");
  });

  test("bad task ids show help", async () => {
    const d = deps({ runBenchNow: async () => ({ status: "ok", mode: "offline", alerted: false, summary: "x" }) });
    expect(await handleBenchRun(d, sender, ["BAD!"], "fa")).toContain("/bench run");
  });
});

// --- schedule/status: stub tool service -------------------------------------

interface StubTask {
  id: number;
  name: string;
  cron: string;
  nextRunAt: string;
}

function stubTools(tasks: StubTask[], calls: string[]) {
  return {
    async execute(req: { tool: string; input: unknown }) {
      calls.push(req.tool);
      if (req.tool === "list_tasks") {
        return { status: "ok", data: { tasks, count: tasks.length } };
      }
      if (req.tool === "schedule_task") {
        return {
          status: "ok",
          data: { id: 7, name: BENCH_SCHEDULE_TASK_NAME, cron: "0 3 * * 0" },
        };
      }
      if (req.tool === "cancel_task") {
        return { status: "ok", data: { id: 5, cancelled: true, remaining: 0 } };
      }
      return { status: "error", message: "unknown tool" };
    },
  };
}

describe("handleBenchSchedule", () => {
  test("creates a schedule when none exists", async () => {
    const calls: string[] = [];
    const d = deps({ tools: stubTools([], calls) as never });
    const out = await handleBenchSchedule(d, sender, ["0", "3", "*", "*", "0"], "fa");
    expect(out).toContain("فعال شد");
    expect(out).toContain("0 3 * * 0");
    expect(calls).toEqual(["list_tasks", "schedule_task"]);
  });

  test("replaces the existing schedule instead of duplicating", async () => {
    const calls: string[] = [];
    const existing: StubTask[] = [
      { id: 5, name: BENCH_SCHEDULE_TASK_NAME, cron: "0 3 * * 0", nextRunAt: "2026-10-25T00:00:00.000Z" },
    ];
    const d = deps({ tools: stubTools(existing, calls) as never });
    const out = await handleBenchSchedule(d, sender, ["0", "4", "*", "*", "*"], "fa");
    expect(out).toContain("به‌روز شد");
    expect(calls).toEqual(["list_tasks", "cancel_task", "schedule_task"]);
  });

  test("off cancels the schedule; off with none says so", async () => {
    const calls: string[] = [];
    const existing: StubTask[] = [
      { id: 5, name: BENCH_SCHEDULE_TASK_NAME, cron: "0 3 * * 0", nextRunAt: "2026-10-25T00:00:00.000Z" },
    ];
    const d = deps({ tools: stubTools(existing, calls) as never });
    expect(await handleBenchSchedule(d, sender, ["off"], "fa")).toContain("خاموش شد");
    expect(calls).toEqual(["list_tasks", "cancel_task"]);

    const d2 = deps({ tools: stubTools([], []) as never });
    expect(await handleBenchSchedule(d2, sender, ["off"], "fa")).toContain("فعالی");
  });

  test("invalid cron is rejected before any tool call", async () => {
    const calls: string[] = [];
    const d = deps({ tools: stubTools([], calls) as never });
    const out = await handleBenchSchedule(d, sender, ["not-a-cron"], "fa");
    expect(out).toContain("نامعتبر");
    expect(calls).toEqual([]);
  });

  test("empty args show usage", async () => {
    const d = deps({ tools: stubTools([], []) as never });
    expect(await handleBenchSchedule(d, sender, [], "fa")).toContain("/bench schedule");
  });

  test("--live flag selects the live mode", async () => {
    const seen: unknown[] = [];
    const tools = {
      async execute(req: { tool: string; input: unknown }) {
        if (req.tool === "list_tasks") return { status: "ok", data: { tasks: [], count: 0 } };
        if (req.tool === "schedule_task") {
          seen.push(req.input);
          return { status: "ok", data: { id: 7 } };
        }
        return { status: "error", message: "?" };
      },
    };
    const d = deps({ tools: tools as never });
    await handleBenchSchedule(d, sender, ["0", "3", "*", "*", "0", "--live"], "fa");
    const action = (seen[0] as { action: { input: { mode: string } } }).action;
    expect(action.input.mode).toBe("live");
  });
});

describe("handleBenchStatus", () => {
  test("unscheduled + no runs", async () => {
    const d = deps({ tools: stubTools([], []) as never });
    const out = await handleBenchStatus(d, sender, "fa");
    expect(out).toContain("خاموش");
    expect(out).toContain("ثبت نشده");
  });

  test("scheduled + latest run", async () => {
    const existing: StubTask[] = [
      { id: 5, name: BENCH_SCHEDULE_TASK_NAME, cron: "0 3 * * 0", nextRunAt: "2026-10-25T00:00:00.000Z" },
    ];
    const d = deps({ tools: stubTools(existing, []) as never });
    history.recordRun(cannedReport(85, "2026-10-18T19:00:00.000Z"));
    const out = await handleBenchStatus(d, sender, "fa");
    expect(out).toContain("فعال");
    expect(out).toContain("0 3 * * 0");
    expect(out).toContain("85٪");
  });
});

// ---------------------------------------------------------------------------
// Phase-4: background worker surface (--bg, status worker section, cancel)
// ---------------------------------------------------------------------------

function stubWorker(
  over: Partial<{
    state: "idle" | "running";
    pending: number;
    cancel: { cancelledPending: number; abortedRunning: boolean };
  }> = {},
) {
  return {
    snapshot: () => ({
      state: over.state ?? "idle",
      current:
        (over.state ?? "idle") === "running"
          ? {
              jobId: "bench-1",
              mode: "live",
              source: "schedule",
              startedAtMs: Date.parse("2026-10-18T19:00:00.000Z"),
            }
          : undefined,
      pending: over.pending ?? 0,
    }),
    cancelAll: (_reason: string) =>
      over.cancel ?? { cancelledPending: 0, abortedRunning: false },
  };
}

describe("handleBenchRun --bg (Phase-4)", () => {
  test("--bg enqueues: runBenchNow gets background:true, reply is bilingual queued message", async () => {
    const seen: { background: boolean | undefined; mode: string }[] = [];
    const d = deps({
      runBenchNow: (async (opts: { mode: "offline" | "live"; background?: boolean }) => {
        seen.push({ background: opts.background, mode: opts.mode });
        return { status: "queued", mode: opts.mode, alerted: false, summary: "q", position: 2 };
      }) as never,
    });
    const out = await handleBenchRun(d, sender, ["--live", "--bg"], "fa");
    expect(seen).toEqual([{ background: true, mode: "live" }]);
    expect(out).toContain("صف");
    expect(out).toContain("2");
  });

  test("without --bg the call stays synchronous (background:false)", async () => {
    const seen: { background: boolean | undefined }[] = [];
    const d = deps({
      runBenchNow: (async (opts: { background?: boolean }) => {
        seen.push({ background: opts.background });
        return { status: "ok", mode: "offline", alerted: false, summary: "done" };
      }) as never,
    });
    const out = await handleBenchRun(d, sender, [], "en");
    expect(seen).toEqual([{ background: false }]);
    expect(out).toContain("done");
  });

  test("--bg reply is English when lang=en", async () => {
    const d = deps({
      runBenchNow: (async () => ({
        status: "queued",
        mode: "live",
        alerted: false,
        summary: "q",
        position: 1,
      })) as never,
    });
    expect(await handleBenchRun(d, sender, ["--bg"], "en")).toContain("queued");
  });
});

describe("handleBenchSchedule (Phase-4)", () => {
  test("--live schedule writes background:true into the stored action", async () => {
    const seen: unknown[] = [];
    const tools = {
      async execute(req: { tool: string; input: unknown }) {
        if (req.tool === "list_tasks") return { status: "ok", data: { tasks: [], count: 0 } };
        if (req.tool === "schedule_task") {
          seen.push(req.input);
          return { status: "ok", data: { id: 7 } };
        }
        return { status: "error", message: "?" };
      },
    };
    const d = deps({ tools: tools as never });
    const out = await handleBenchSchedule(d, sender, ["0", "3", "*", "*", "0", "--live"], "fa");
    const action = (seen[0] as { action: { input: Record<string, unknown> } }).action;
    expect(action.input.mode).toBe("live");
    expect(action.input.background).toBe(true);
    expect(action.input.source).toBe("schedule");
    // The reply tells the owner the run happens in the background worker.
    expect(out).toContain("پس‌زمینه");
  });

  test("offline schedule has no background flag", async () => {
    const seen: unknown[] = [];
    const tools = {
      async execute(req: { tool: string; input: unknown }) {
        if (req.tool === "list_tasks") return { status: "ok", data: { tasks: [], count: 0 } };
        if (req.tool === "schedule_task") {
          seen.push(req.input);
          return { status: "ok", data: { id: 7 } };
        }
        return { status: "error", message: "?" };
      },
    };
    const d = deps({ tools: tools as never });
    await handleBenchSchedule(d, sender, ["0", "3", "*", "*", "0"], "fa");
    const action = (seen[0] as { action: { input: Record<string, unknown> } }).action;
    expect(action.input.mode).toBe("offline");
    expect("background" in action.input).toBe(false);
  });
});

describe("handleBenchStatus worker section (Phase-4)", () => {
  test("idle worker renders the idle line", async () => {
    const d = deps({
      tools: stubTools([], []) as never,
      benchWorker: stubWorker({ state: "idle" }) as never,
    });
    const out = await handleBenchStatus(d, sender, "fa");
    expect(out).toContain("بیکار");
  });

  test("running worker renders mode + pending count", async () => {
    const d = deps({
      tools: stubTools([], []) as never,
      benchWorker: stubWorker({ state: "running", pending: 2 }) as never,
    });
    const out = await handleBenchStatus(d, sender, "fa");
    expect(out).toContain("در حال اجرا");
    expect(out).toContain("2");
  });

  test("no worker wired renders unavailable", async () => {
    const d = deps({ tools: stubTools([], []) as never });
    const out = await handleBenchStatus(d, sender, "en");
    expect(out).toContain("not active");
  });
});

describe("handleBenchCancel (Phase-4)", () => {
  test("dispatches on 'cancel' and reports counts", async () => {
    const d = deps({
      benchWorker: stubWorker({
        cancel: { cancelledPending: 2, abortedRunning: true },
      }) as never,
    });
    const out = await handleBench(d, sender, "cancel", true, "fa");
    expect(out).toContain("لغو شد");
    expect(out).toContain("2");
  });

  test("nothing to cancel says so", async () => {
    const d = deps({ benchWorker: stubWorker() as never });
    expect(await handleBench(d, sender, "cancel", true, "fa")).toContain("نیست");
  });

  test("no worker wired refuses", async () => {
    const d = deps({});
    expect(await handleBench(d, sender, "cancel", true, "en")).toContain("not active");
  });

  test("non-owner is rejected before dispatch", async () => {
    const d = deps({ benchWorker: stubWorker() as never });
    expect(await handleBench(d, sender, "cancel", false, "fa")).toContain("مالک");
  });
});

describe("help text (Phase-4)", () => {
  test("help mentions --bg and cancel in both languages", async () => {
    const d = deps({});
    expect(await handleBench(d, sender, "help", true, "fa")).toContain("/bench cancel");
    expect(await handleBench(d, sender, "", true, "en")).toContain("--bg");
  });
});
