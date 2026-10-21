/**
 * Phase-5 bench: durable queue + live progress streaming.
 *
 * - Restart recovery: never-started jobs are re-enqueued with their ORIGINAL
 *   ids (exactly-once); runs that died mid-flight are recorded FAILED with a
 *   clear reason and never silently re-executed; already-recorded rows are
 *   just dropped.
 * - Exactly-once under enqueue races: the bounded queue refuses overflow and
 *   every accepted job runs exactly once (atomic durable claim).
 * - Live progress: snapshot → per-task ticks in task order → one terminal
 *   event; a throwing subscriber never breaks the run.
 * - Cancel mid-run: durable rows are dropped, the run is recorded cancelled.
 * - Dashboard SSE stream: Bearer auth, 503 without a wired worker, snapshot
 *   first, ordered progress/terminal events.
 * - /bench status renders live progress (fa + en).
 *
 * Deterministic: :memory: SQLite, injected suite executors, no network, no
 * timers — pump()/recover() are driven directly.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BenchHistory } from "../src/bench/history";
import { BenchJobStore } from "../src/bench/queue_store";
import {
  BenchAbortError,
  BenchJobQueue,
  BenchWorker,
  type BenchLiveEvent,
  type BenchProgress,
  type EnqueueOutcome,
  type WorkerExecuteSuite,
  type WorkerSnapshot,
} from "../src/bench/worker";
import type { BenchReport, BenchStack, TaskResult } from "../bench/run";
import { handleDashboardRequest } from "../src/http/dashboard";
import { Storage } from "../src/storage/storage";
import {
  handleBenchHistory,
  handleBenchStatus,
  type BenchDeps,
  type BenchWorkerSnapshot,
} from "../src/bot/cmd_phase3_bench";
import type { SenderRef } from "../src/bot/cmd_auto";

function cannedReport(over: Partial<BenchReport> = {}): BenchReport {
  const task: TaskResult = {
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
  };
  return {
    generatedAt: "2026-10-19T01:00:00.000Z",
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
    results: [task],
    ...over,
  };
}

/** Wait until cond() is true (for racing pump() against cancel). */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

interface Harness {
  history: BenchHistory;
  store: BenchJobStore;
  notified: string[];
  events: BenchLiveEvent[];
  worker: BenchWorker;
}

function harness(
  over: Partial<ConstructorParameters<typeof BenchWorker>[0]> = {},
): Harness {
  const db = new Database(":memory:");
  const history = new BenchHistory(db);
  const store = new BenchJobStore(db);
  const notified: string[] = [];
  const events: BenchLiveEvent[] = [];
  const worker = new BenchWorker({
    history,
    jobStore: store,
    notifyOwner: async (text) => {
      notified.push(text);
    },
    executeSuite: (async () => cannedReport()) as WorkerExecuteSuite,
    log: () => undefined,
    ...over,
  });
  worker.subscribeProgress((ev) => {
    events.push(ev);
  });
  return { history, store, notified, events, worker };
}

function mustQueue(o: EnqueueOutcome): asserts o is Extract<EnqueueOutcome, { queued: true }> {
  if (!o.queued) throw new Error("expected the job to be queued");
}

// ---------------------------------------------------------------------------
// Durable queue
// ---------------------------------------------------------------------------

describe("durable bench queue", () => {
  test("enqueue persists; pump claims, records, and drops the row", async () => {
    const h = harness();
    const out = h.worker.enqueue({ mode: "offline", source: "manual" });
    mustQueue(out);

    const queued = h.store.listQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.jobId).toBe(out.jobId);
    expect(queued[0]!.status).toBe("queued");

    await h.worker.pump();

    const runs = h.history.listRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("ok");
    // Terminal states leave no queue rows behind.
    expect(h.store.count()).toBe(0);

    const terminals: BenchLiveEvent[] = h.events.filter((e) => e.type === "terminal");
    expect(terminals).toHaveLength(1);
    const t = terminals[0]!;
    if (t.type !== "terminal") throw new Error("unreachable");
    expect(t.outcome).toBe("ok");
    expect(t.jobId).toBe(out.jobId);
    expect(t.runId).toBe(runs[0]!.id);
  });

  test("restart recovery: queued resume with original ids, interrupted recorded failed, recorded rows dropped", async () => {
    const db = new Database(":memory:");
    const history = new BenchHistory(db);
    const store = new BenchJobStore(db);
    const firstNotified: string[] = [];
    const w1 = new BenchWorker({
      history,
      jobStore: store,
      // A wider in-memory bound so the crash scenario can hold 3 jobs; the
      // durable rows are what recovery reads, not the bound.
      queue: new BenchJobQueue({ maxPending: 3, store }),
      notifyOwner: async (t) => {
        firstNotified.push(t);
      },
      executeSuite: (async () => cannedReport()) as WorkerExecuteSuite,
      log: () => undefined,
    });
    const o1 = w1.enqueue({ mode: "live", source: "schedule" });
    const o2 = w1.enqueue({ mode: "offline", source: "manual" });
    const o3 = w1.enqueue({ mode: "live", source: "schedule" });
    mustQueue(o1);
    mustQueue(o2);
    mustQueue(o3);

    // Crash mid-flight: two jobs claimed; one of them already recorded its
    // history row before the process died.
    expect(store.claimForRun(o1.jobId)).toBe(true);
    expect(store.claimForRun(o3.jobId)).toBe(true);
    store.markRecorded(o3.jobId, 77);

    // New process: a fresh worker over the same store.
    const notified: string[] = [];
    const events: BenchLiveEvent[] = [];
    const w2 = new BenchWorker({
      history,
      jobStore: store,
      notifyOwner: async (t) => {
        notified.push(t);
      },
      executeSuite: (async () => cannedReport()) as WorkerExecuteSuite,
      log: () => undefined,
    });
    w2.subscribeProgress((ev) => {
      events.push(ev);
    });

    const rec = await w2.recover();
    expect(rec).toEqual({ requeued: 1, interrupted: 1 });

    // The interrupted run is recorded FAILED with a clear reason…
    const runs = history.listRuns(10);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.note).toContain("ری‌استارت");
    // …the already-recorded row was dropped WITHOUT a second history row…
    expect(store.listRunning()).toHaveLength(0);
    // …the never-started job is back in memory with its ORIGINAL id…
    await w2.pump();
    const runs2 = history.listRuns(10);
    expect(runs2).toHaveLength(2);
    expect(runs2[0]!.status).toBe("ok");
    const terminals: BenchLiveEvent[] = events.filter((e) => e.type === "terminal");
    expect(terminals).toHaveLength(1);
    const term = terminals[0]!;
    if (term.type !== "terminal") throw new Error("unreachable");
    expect(term.jobId).toBe(o2.jobId);
    // …and the owner was told exactly once.
    expect(notified.filter((t) => t.includes("ری‌استارت"))).toHaveLength(1);
    // Recover is idempotent: a second call is a no-op.
    expect(await w2.recover()).toEqual({ requeued: 0, interrupted: 0 });
    expect(history.listRuns(10)).toHaveLength(2);
  });

  test("enqueue races: bounded, unique ids, each job runs exactly once", async () => {
    const db = new Database(":memory:");
    const history = new BenchHistory(db);
    const store = new BenchJobStore(db);
    const finishedIds: string[] = [];
    const worker = new BenchWorker({
      history,
      jobStore: store,
      queue: new BenchJobQueue({ maxPending: 2, store }),
      notifyOwner: async () => undefined,
      executeSuite: (async () => cannedReport()) as WorkerExecuteSuite,
      log: () => undefined,
    });
    worker.subscribeProgress((ev) => {
      if (ev.type === "terminal") finishedIds.push(ev.jobId);
    });

    const ids = new Set<string>();
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      const o = worker.enqueue({ mode: "offline", source: "schedule" });
      if (o.queued) {
        accepted += 1;
        ids.add(o.jobId);
      } else {
        refused += 1;
        expect(o.reason).toBe("queue_full");
      }
    }
    expect(accepted).toBe(2);
    expect(refused).toBe(8);
    expect(ids.size).toBe(2);
    expect(store.listQueued()).toHaveLength(2);

    await worker.pump();
    await worker.pump();
    await worker.pump(); // idle: nothing more to do
    expect(history.listRuns(10)).toHaveLength(2);
    expect(finishedIds).toHaveLength(2);
    expect(new Set(finishedIds)).toEqual(ids);
    expect(store.count()).toBe(0);
  });

  test("claimForRun is atomic: second claim fails, release reopens it", () => {
    const store = new BenchJobStore(new Database(":memory:"));
    store.enqueue({
      id: "j1",
      mode: "offline",
      source: "schedule",
      enqueuedAtMs: 1,
    });
    expect(store.claimForRun("j1")).toBe(true);
    expect(store.claimForRun("j1")).toBe(false);
    expect(store.claimForRun("nope")).toBe(false);
    store.releaseClaim("j1");
    expect(store.claimForRun("j1")).toBe(true);
    store.finish("j1");
    expect(store.count()).toBe(0);
  });

  test("cancel mid-run drops durable rows and records the run cancelled", async () => {
    let started = false;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const h = harness({
      executeSuite: (async (_stack, _runId, _taskIds, shouldAbort) => {
        started = true;
        await gate;
        const reason = shouldAbort();
        if (reason !== undefined) throw new BenchAbortError(reason, []);
        return cannedReport();
      }) as WorkerExecuteSuite,
    });
    h.worker.enqueue({ mode: "offline", source: "manual" });
    h.worker.enqueue({ mode: "offline", source: "manual" });
    const p = h.worker.pump();
    await waitFor(() => started, "job to start");
    expect(h.store.listRunning()).toHaveLength(1);

    const res = h.worker.cancelAll("test");
    expect(res).toEqual({ cancelledPending: 1, abortedRunning: true });
    // The pending row is dropped from the durable queue immediately…
    expect(h.store.listQueued()).toHaveLength(0);

    releaseGate();
    await p;
    // …and the aborted run is recorded cancelled with no row left behind.
    const runs = h.history.listRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("cancelled");
    expect(h.store.count()).toBe(0);
  });

  test("corrupt task_ids_json degrades to the full suite, never a crash", () => {
    const db = new Database(":memory:");
    const store = new BenchJobStore(db);
    store.enqueue({ id: "jx", mode: "offline", source: "schedule", enqueuedAtMs: 1 });
    db.run(`UPDATE bench_job_queue SET task_ids_json = 'not-json{{{' WHERE job_id = 'jx'`);
    const rows = store.listQueued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskIds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Live progress events
// ---------------------------------------------------------------------------

describe("live progress events", () => {
  test("snapshot → ticks in task order → one terminal; snapshot carries progress", async () => {
    const events: BenchLiveEvent[] = [];
    const worker = new BenchWorker({
      history: new BenchHistory(new Database(":memory:")),
      notifyOwner: async () => undefined,
      buildLive: () =>
        ({ providerName: "live: test", model: "m" }) as unknown as BenchStack,
      executeSuite: (async (_s, _r, _t, _a, onProgress) => {
        const titles = ["الف", "ب", "ج"];
        onProgress?.(0, 3, null, null);
        for (let i = 0; i < 3; i++) {
          onProgress?.(i, 3, `task_${i + 1}`, titles[i]!);
        }
        onProgress?.(3, 3, null, null);
        return cannedReport();
      }) as WorkerExecuteSuite,
      log: () => undefined,
    });
    worker.subscribeProgress((ev) => {
      events.push(ev);
    });
    worker.enqueue({ mode: "live", source: "schedule" });
    await worker.pump();

    const progresses: BenchProgress[] = [];
    for (const e of events) {
      if (e.type === "progress") progresses.push(e.progress);
    }
    // Ticks arrive in task order: done counts finished tasks.
    expect(progresses.map((p) => p.done)).toEqual([0, 0, 1, 2, 3]);
    expect(progresses.map((p) => p.currentTaskId)).toEqual([
      null,
      "task_1",
      "task_2",
      "task_3",
      null,
    ]);
    expect(progresses.map((p) => p.currentTitleFa)).toEqual([
      null,
      "الف",
      "ب",
      "ج",
      null,
    ]);
    for (const p of progresses) {
      expect(p.total).toBe(3);
      expect(p.mode).toBe("live");
      expect(p.source).toBe("schedule");
    }

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("snapshot"); // enqueue
    expect(types[types.length - 1]).toBe("snapshot"); // pump finally
    const firstProgress = types.indexOf("progress");
    expect(firstProgress).toBeGreaterThan(0);
    // The job-start snapshot sits between the enqueue snapshot and the ticks.
    expect(types[firstProgress - 1]).toBe("snapshot");

    const terminals: BenchLiveEvent[] = events.filter((e) => e.type === "terminal");
    expect(terminals).toHaveLength(1);
    const term = terminals[0]!;
    if (term.type !== "terminal") throw new Error("unreachable");
    expect(term.outcome).toBe("ok");
    expect(term.runId).toBeGreaterThan(0);
  });

  test("a throwing progress subscriber never breaks the run", async () => {
    const h = harness();
    const seen: BenchLiveEvent[] = [];
    h.worker.subscribeProgress(() => {
      throw new Error("listener boom");
    });
    h.worker.subscribeProgress((ev) => {
      seen.push(ev);
    });
    h.worker.enqueue({ mode: "offline", source: "manual" });
    await h.worker.pump();
    expect(h.history.listRuns(5)).toHaveLength(1);
    expect(seen.some((e) => e.type === "terminal")).toBe(true);
  });

  test("unsubscribe stops delivery", async () => {
    const h = harness();
    const seen: BenchLiveEvent[] = [];
    const off = h.worker.subscribeProgress((ev) => {
      seen.push(ev);
    });
    off();
    h.worker.enqueue({ mode: "offline", source: "manual" });
    await h.worker.pump();
    expect(seen).toHaveLength(0);
    expect(h.history.listRuns(5)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dashboard SSE stream
// ---------------------------------------------------------------------------

const STREAM_TOKEN = "phase5-stream-test-token-0123456789abcdef";

function fakeProgressWorker() {
  const listeners = new Set<(ev: BenchLiveEvent) => void>();
  let snap: WorkerSnapshot = { state: "idle", current: undefined, pending: 0 };
  return {
    setSnapshot(s: WorkerSnapshot): void {
      snap = s;
    },
    snapshot: (): WorkerSnapshot => snap,
    subscribeProgress: (cb: (ev: BenchLiveEvent) => void): (() => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit(ev: BenchLiveEvent): void {
      for (const cb of listeners) cb(ev);
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}

describe("dashboard live stream — retired (phase 10)", () => {
  // The SSE endpoint died with the dashboard; live bench progress is a
  // Mini App polling snapshot now (`bench.live`, covered in
  // tests/miniapp_desk.test.ts). The old URL must answer 410, not stream.
  test("the old stream URL answers 410 Gone", async () => {
    const res = handleDashboardRequest(
      new Request("http://localhost/api/v1/dashboard/benchmarks/live/stream", {
        headers: { authorization: `Bearer ${STREAM_TOKEN}` },
      }),
    );
    expect(res?.status).toBe(410);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(String(body["error"])).toContain("retired");
  });
});

describe("/bench status live progress", () => {
  const sender: SenderRef = { userId: "1001", telegramId: 1001, chatId: "1001" };
  const history = new BenchHistory(new Database(":memory:"));

  function deps(over: Partial<BenchDeps> = {}): BenchDeps {
    return { history, ...over } as unknown as BenchDeps;
  }

  function stubWorker(snap: BenchWorkerSnapshot) {
    return {
      snapshot: () => snap,
      cancelAll: () => ({ cancelledPending: 0, abortedRunning: false }),
    };
  }

  /** Minimal tools stub: list_tasks returns no schedules. */
  function stubTools() {
    return {
      async execute() {
        return { status: "ok", data: { tasks: [], count: 0 } };
      },
    };
  }

  test("running worker with progress renders done/total + current task", async () => {
    const d = deps({
      tools: stubTools() as never,
      benchWorker: stubWorker({
        state: "running",
        current: {
          jobId: "bench-1",
          mode: "live",
          source: "schedule",
          startedAtMs: Date.parse("2026-10-19T01:00:00.000Z"),
        },
        pending: 0,
        progress: {
          done: 7,
          total: 24,
          currentTaskId: "calc_01",
          currentTitleFa: "جمع ساده",
          elapsedMs: 65_000,
        },
      }) as never,
    });
    const out = await handleBenchStatus(d, sender, "en");
    expect(out).toContain("running");
    expect(out).toContain("Progress");
    expect(out).toContain("7 of 24");
    expect(out).toContain("جمع ساده");
    expect(out).toContain("65s elapsed");
  });

  test("running worker with progress renders in English", async () => {
    const d = deps({
      tools: stubTools() as never,
      benchWorker: stubWorker({
        state: "running",
        current: {
          jobId: "bench-1",
          mode: "offline",
          source: "manual",
          startedAtMs: Date.parse("2026-10-19T01:00:00.000Z"),
        },
        pending: 0,
        progress: {
          done: 3,
          total: 10,
          currentTaskId: null,
          currentTitleFa: null,
          elapsedMs: 5_000,
        },
      }) as never,
    });
    const out = await handleBenchStatus(d, sender, "en");
    expect(out).toContain("Progress: 3 of 10 tasks");
    expect(out).toContain("5s elapsed");
  });

  test("failed run note shows in /bench history", () => {
    history.recordRun(cannedReport(), "failed", "ری‌استارت دیمون وسط اجرا");
    const out = handleBenchHistory(history, 10, "en");
    expect(out).toContain("Note:");
  });
});
