/**
 * Tests for the Phase-4 benchmark background worker (`src/bench/worker.ts`)
 * and the run_bench background path (`src/bench/tool.ts`).
 *
 * Deterministic: the suite executor is injected (canned BenchReport),
 * :memory: history, no network, no provider, no timers — the pump is driven
 * directly via worker.pump().
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { ToolError } from "../src/tools/errors";
import type { ToolContext } from "../src/tools/types";
import { BenchHistory } from "../src/bench/history";
import type { BenchReport, BenchStack } from "../bench/run";
import {
  BenchAbortError,
  BenchJobQueue,
  BenchWorker,
  isBenchRunLocked,
  releaseBenchRunLock,
  tryAcquireBenchRunLock,
  type BenchJobSpec,
  type WorkerExecuteSuite,
} from "../src/bench/worker";
import { createRunBenchTool, RUN_BENCH_PERMISSION } from "../src/bench/tool";

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

interface WorkerHarness {
  history: BenchHistory;
  notified: string[];
  log: string[];
  worker: BenchWorker;
}

function workerHarness(
  over: Partial<ConstructorParameters<typeof BenchWorker>[0]> = {},
): WorkerHarness {
  const history = new BenchHistory(new Database(":memory:"));
  const notified: string[] = [];
  const log: string[] = [];
  const worker = new BenchWorker({
    history,
    notifyOwner: async (text) => {
      notified.push(text);
    },
    executeSuite: (async () => cannedReport()) as WorkerExecuteSuite,
    log: (m) => log.push(m),
    ...over,
  });
  return { history, notified, log, worker };
}

/** Wait until cond() is true (for racing pump() against cancel). */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// Process-wide lock
// ---------------------------------------------------------------------------

describe("bench run lock", () => {
  test("only one holder at a time; release is idempotent", () => {
    expect(tryAcquireBenchRunLock()).toBe(true);
    try {
      expect(isBenchRunLocked()).toBe(true);
      expect(tryAcquireBenchRunLock()).toBe(false);
    } finally {
      releaseBenchRunLock();
    }
    expect(isBenchRunLocked()).toBe(false);
    // Idempotent: releasing a free lock does not break the next acquire.
    releaseBenchRunLock();
    expect(tryAcquireBenchRunLock()).toBe(true);
    releaseBenchRunLock();
  });
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

describe("BenchJobQueue", () => {
  test("enqueue → takeNext → finishActive cycle", () => {
    const q = new BenchJobQueue();
    const o1 = q.enqueue({ mode: "live", source: "schedule" });
    expect(o1.queued).toBe(true);
    if (!o1.queued) throw new Error("unreachable");
    expect(o1.position).toBe(1);

    const job = q.takeNext();
    expect(job?.id).toBe(o1.jobId);
    expect(job?.mode).toBe("live");
    // While active, a second take gets nothing.
    expect(q.takeNext()).toBeUndefined();
    q.finishActive();
    expect(q.takeNext()).toBeUndefined();
  });

  test("positions count the active job + pending jobs", () => {
    const q = new BenchJobQueue();
    q.enqueue({ mode: "live" });
    q.takeNext(); // now active
    const o2 = q.enqueue({ mode: "live" });
    const o3 = q.enqueue({ mode: "live" });
    expect(o2.queued && o2.position).toBe(2);
    expect(o3.queued && o3.position).toBe(3);
  });

  test("queue_full beyond the pending bound, with a logged reason", () => {
    const q = new BenchJobQueue({ maxPending: 1 });
    q.enqueue({ mode: "live" });
    q.takeNext(); // active
    expect(q.enqueue({ mode: "live" }).queued).toBe(true); // 1 pending: ok
    const refused = q.enqueue({ mode: "live" });
    expect(refused).toEqual({ queued: false, reason: "queue_full" });
  });

  test("requeueFront puts the job back at the head", () => {
    const q = new BenchJobQueue();
    const o1 = q.enqueue({ mode: "live" });
    if (!o1.queued) throw new Error("unreachable");
    const job = q.takeNext()!;
    const o2 = q.enqueue({ mode: "offline" });
    if (!o2.queued) throw new Error("unreachable");
    q.requeueFront(job);
    expect(q.takeNext()?.id).toBe(o1.jobId);
    q.finishActive();
    expect(q.takeNext()?.id).toBe(o2.jobId);
  });

  test("cancelPending drops the queue and reports the jobs", () => {
    const q = new BenchJobQueue();
    q.enqueue({ mode: "live" });
    q.enqueue({ mode: "offline" });
    const dropped = q.cancelPending();
    expect(dropped).toHaveLength(2);
    expect(q.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Worker: happy path + alert paths
// ---------------------------------------------------------------------------

describe("BenchWorker", () => {
  test("pump runs an enqueued job, records it, and DMs the owner", async () => {
    const h = workerHarness();
    const out = h.worker.enqueue({ mode: "offline", source: "manual" });
    expect(out.queued).toBe(true);

    await h.worker.pump();

    const runs = h.history.listRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.mode).toBe("offline");
    expect(runs[0]!.status).toBe("ok");
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toContain("تمام شد");
    expect(h.worker.snapshot().state).toBe("idle");
  });

  test("live job with no provider: loud skip, cooldown-guarded, no failure count", async () => {
    const h = workerHarness({
      buildLive: () => {
        throw new Error("ارائه‌دهنده پیکربندی نشده است.");
      },
    });
    h.worker.enqueue({ mode: "live", source: "schedule" });
    await h.worker.pump();
    h.worker.enqueue({ mode: "live", source: "schedule" });
    await h.worker.pump();

    // Nothing recorded (a skip is not a measurement)…
    expect(h.history.listRuns(5)).toHaveLength(0);
    // …and the owner was told exactly once (24h cooldown), not per attempt.
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toContain("رد شد");
  });

  test("suite throw → failed run is RECORDED, not lost", async () => {
    const h = workerHarness({
      buildLive: () =>
        ({ providerName: "live: test", model: "m" }) as unknown as BenchStack,
      executeSuite: (async () => {
        throw new Error("provider exploded");
      }) as WorkerExecuteSuite,
    });
    h.worker.enqueue({ mode: "live", source: "schedule" });
    await h.worker.pump();

    const runs = h.history.listRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.mode).toBe("live");
    // First failure: no owner DM yet (threshold is 3).
    expect(h.notified).toHaveLength(0);
  });

  test("repeated failures: one alert at the threshold, then cooldown (no per-attempt spam)", async () => {
    const h = workerHarness({
      buildLive: () =>
        ({ providerName: "live: test", model: "m" }) as unknown as BenchStack,
      executeSuite: (async () => {
        throw new Error("boom");
      }) as WorkerExecuteSuite,
      failureAlertThreshold: 3,
    });
    for (let i = 0; i < 4; i++) {
      h.worker.enqueue({ mode: "live", source: "schedule" });
      await h.worker.pump();
    }
    expect(h.history.listRuns(10)).toHaveLength(4);
    const alerts = h.notified.filter((t) => t.includes("پیاپی"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("3");
  });

  test("a success resets the consecutive-failure counter", async () => {
    let fail = true;
    const h = workerHarness({
      executeSuite: (async () => {
        if (fail) throw new Error("boom");
        return cannedReport();
      }) as WorkerExecuteSuite,
      failureAlertThreshold: 3,
    });
    // fail, fail, ok, fail, fail, fail → exactly one alert (after the reset).
    for (const f of [true, true, false, true, true, true]) {
      fail = f;
      h.worker.enqueue({ mode: "offline", source: "schedule" });
      await h.worker.pump();
    }
    const alerts = h.notified.filter((t) => t.includes("پیاپی"));
    expect(alerts).toHaveLength(1);
    expect(h.history.listRuns(10)).toHaveLength(6);
  });

  test("manual job failure → direct owner DM (scheduled jobs use the alert path)", async () => {
    const h = workerHarness({
      executeSuite: (async () => {
        throw new Error("boom");
      }) as WorkerExecuteSuite,
      failureAlertThreshold: 99,
    });
    h.worker.enqueue({ mode: "offline", source: "manual" });
    await h.worker.pump();
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toContain("ناموفق بود");
  });

  test("regression alert path fires on a worker-run drop (existing baseline)", async () => {
    const history = new BenchHistory(new Database(":memory:"));
    // Seed: 3 ok live runs at 90% for model "m1".
    for (let i = 0; i < 3; i++) {
      history.recordRun(
        cannedReport({
          mode: "live",
          model: "m1",
          totals: { ...cannedReport().totals, avgScorePct: 90 },
        }),
      );
    }
    const notified: string[] = [];
    const worker = new BenchWorker({
      history,
      notifyOwner: async (t) => {
        notified.push(t);
      },
      buildLive: () =>
        ({ providerName: "live: test", model: "m1" }) as unknown as BenchStack,
      executeSuite: (async () =>
        cannedReport({
          mode: "live",
          model: "m1",
          totals: { ...cannedReport().totals, avgScorePct: 70 },
        })) as WorkerExecuteSuite,
    });
    worker.enqueue({ mode: "live", source: "schedule" });
    await worker.pump();
    // One completion DM + one regression alert via the existing baseline path.
    expect(notified.filter((t) => t.includes("افت کیفیت"))).toHaveLength(1);
  });

  test("timeout aborts the run and records it failed", async () => {
    const h = workerHarness({
      executeSuite: (async (_stack, _runId, _taskIds, shouldAbort) => {
        await new Promise<void>((resolve) => {
          const t = setInterval(() => {
            if (shouldAbort() !== undefined) {
              clearInterval(t);
              resolve();
            }
          }, 5);
        });
        throw new BenchAbortError("timeout", []);
      }) as WorkerExecuteSuite,
      runTimeoutMs: 40,
    });
    h.worker.enqueue({ mode: "offline", source: "manual" });
    await h.worker.pump();
    const runs = h.history.listRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
  });

  test("cancelAll aborts the active run → recorded as cancelled, no failure count", async () => {
    let started = false;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const h = workerHarness({
      executeSuite: (async (_stack, _runId, _taskIds, shouldAbort) => {
        started = true;
        await gate;
        const reason = shouldAbort();
        if (reason !== undefined) throw new BenchAbortError(reason, []);
        return cannedReport();
      }) as WorkerExecuteSuite,
    });
    h.worker.enqueue({ mode: "offline", source: "manual" });
    const p = h.worker.pump();
    await waitFor(() => started, "job to start");
    const res = h.worker.cancelAll("test");
    expect(res).toEqual({ cancelledPending: 0, abortedRunning: true });
    releaseGate();
    await p;

    const runs = h.history.listRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("cancelled");
    // Owner-initiated cancel: no DM, no failure alert.
    expect(h.notified).toHaveLength(0);
  });

  test("cancelAll drops pending jobs without running them", async () => {
    const h = workerHarness();
    h.worker.enqueue({ mode: "offline", source: "manual" });
    h.worker.enqueue({ mode: "offline", source: "manual" });
    const res = h.worker.cancelAll("test");
    expect(res).toEqual({ cancelledPending: 2, abortedRunning: false });
    await h.worker.pump();
    expect(h.history.listRuns(5)).toHaveLength(0);
    expect(h.worker.snapshot()).toEqual({ state: "idle", current: undefined, pending: 0 });
  });

  test("a crashing runJob never kills the pump; the lock is released", async () => {
    const h = workerHarness({
      executeSuite: (async () => {
        throw new Error("first");
      }) as WorkerExecuteSuite,
    });
    h.worker.enqueue({ mode: "offline", source: "schedule" });
    await h.worker.pump();
    expect(isBenchRunLocked()).toBe(false);
    // Pump again with a working suite: the worker is still alive.
    const h2 = workerHarness();
    h2.worker.enqueue({ mode: "offline", source: "manual" });
    await h2.worker.pump();
    expect(h2.history.listRuns(5)).toHaveLength(1);
  });

  test("snapshot reports running state with job info", async () => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const h = workerHarness({
      executeSuite: (async () => {
        await gate;
        return cannedReport();
      }) as WorkerExecuteSuite,
    });
    h.worker.enqueue({ mode: "live", source: "schedule" });
    const p = h.worker.pump();
    await waitFor(() => h.worker.snapshot().state === "running", "running state");
    const snap = h.worker.snapshot();
    expect(snap.state).toBe("running");
    expect(snap.current?.mode).toBe("live");
    releaseGate();
    await p;
    expect(h.worker.snapshot().state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// run_bench background path
// ---------------------------------------------------------------------------

describe("run_bench background", () => {
  function toolHarness(withWorker: boolean) {
    const history = new BenchHistory(new Database(":memory:"));
    const notified: string[] = [];
    const log: string[] = [];
    const worker = new BenchWorker({
      history,
      notifyOwner: async (t) => {
        notified.push(t);
      },
      executeSuite: (async () => cannedReport()) as WorkerExecuteSuite,
      log: (m) => log.push(m),
    });
    const tool = createRunBenchTool({
      isOwner: (id) => id === OWNER,
      history,
      notifyOwner: async (t) => {
        notified.push(t);
      },
      executeSuite: async () => cannedReport(),
      ...(withWorker ? { enqueueJob: (spec: BenchJobSpec) => worker.enqueue(spec) } : {}),
      log: (m) => log.push(m),
    });
    return { tool, worker, history, notified, log };
  }

  test("background:true enqueues in milliseconds — no suite run, no notify", async () => {
    const { tool } = toolHarness(true);
    const out = await tool.run({ mode: "live", background: true }, ctx());
    expect(out.status).toBe("queued");
    expect(out.jobId).toMatch(/^bench-/);
    expect(out.position).toBe(1);
    expect(out.alerted).toBe(false);
  });

  test("live without a flag auto-enqueues when a worker is wired (never burns the 30s budget)", async () => {
    const { tool } = toolHarness(true);
    const out = await tool.run({ mode: "live" }, ctx());
    expect(out.status).toBe("queued");
  });

  test("background:false keeps the synchronous live path (loud when unwired)", async () => {
    const { tool } = toolHarness(true);
    // No buildLive wired → the pre-existing hard error, exactly like before.
    await expect(
      tool.run({ mode: "live", background: false, source: "manual" }, ctx()),
    ).rejects.toBeInstanceOf(ToolError);
  });

  test("offline stays synchronous even with a worker wired", async () => {
    const { tool, history } = toolHarness(true);
    const out = await tool.run({ mode: "offline" }, ctx());
    expect(out.status).toBe("ok");
    expect(history.listRuns(5)).toHaveLength(1);
  });

  test("background:true without a wired worker fails loudly, not silently", async () => {
    const { tool } = toolHarness(false);
    await expect(tool.run({ mode: "live", background: true }, ctx())).rejects.toBeInstanceOf(
      ToolError,
    );
  });

  test("queue_full → skipped with a reason (scheduler sees ok, not failed)", async () => {
    const { tool, worker } = toolHarness(true);
    // Fill the pending bound (default 2) with nothing active.
    expect(worker.enqueue({ mode: "live" }).queued).toBe(true);
    expect(worker.enqueue({ mode: "live" }).queued).toBe(true);
    const out = await tool.run({ mode: "live", background: true }, ctx());
    expect(out.status).toBe("skipped");
    expect(out.reason).toBe("queue_full");
    worker.cancelAll("test");
  });

  test("synchronous run while the worker holds the lock fails LOUDLY (no silent mock interleave)", async () => {
    const { tool } = toolHarness(true);
    expect(tryAcquireBenchRunLock()).toBe(true);
    try {
      const err = await tool
        .run({ mode: "offline" }, ctx())
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).kind).toBe("overloaded");
    } finally {
      releaseBenchRunLock();
    }
  });

  test("non-owner cannot enqueue", async () => {
    const { tool } = toolHarness(true);
    await expect(
      tool.run({ mode: "live", background: true }, ctx("9999")),
    ).rejects.toBeInstanceOf(ToolError);
  });
});
