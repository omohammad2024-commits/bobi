/**
 * Scheduled tasks (cron): storage, scheduler, and tools.
 *
 * The behaviours that matter are the ones a naive scheduler gets wrong:
 *  - a task due while the process was down runs once on catch-up (<=1h)
 *  - a task far overdue is skipped to its next future slot, not replayed
 *  - two passes never both run the same task (atomic claim)
 *  - re-arming uses the SCHEDULED slot, so series do not drift
 *  - tool actions run with the CREATOR's actor, never ambient authority
 *  - only the owner can create/list/cancel tasks, at every layer
 *  - a corrupt action row fails visibly but never wedges the schedule
 *  - everything survives a storage reopen (schema v13)
 *
 * Clocks are injected everywhere; no test depends on wall time.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Storage } from "../src/storage/storage";
import type { ScheduledTaskRecord } from "../src/storage/storage";
import { TaskScheduler } from "../src/scheduler/scheduler";
import type { TaskAgentRun } from "../src/scheduler/scheduler";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolActor } from "../src/tools/types";
import {
  CANCEL_TASK_PERMISSION,
  createScheduledTaskTools,
  LIST_TASKS_PERMISSION,
  parseTaskAction,
  SCHEDULE_TASK_PERMISSION,
} from "../src/tools/scheduled_tasks";
import { authorizeToolUse } from "../src/auth/tool_bridge";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";

/** Fixed clock base: 2026-10-18T12:00:00Z (a Sunday). */
const BASE = Date.parse("2026-10-18T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const OWNER = "999";
const OWNER_PERMS = [SCHEDULE_TASK_PERMISSION, LIST_TASKS_PERMISSION, CANCEL_TASK_PERMISSION];

const toolAction = (tool = "test_echo") =>
  JSON.stringify({ type: "tool", tool, input: { text: "hi" } });
const messageAction = () => JSON.stringify({ type: "message", chatId: "c1", text: "سلام" });

// ---------- storage ----------

describe("scheduled_tasks storage", () => {
  test("create/get/list/update/delete are owner-scoped", () => {
    const s = Storage.open(":memory:");
    const id = s.createTask({
      name: "صبح",
      cronExpr: "0 7 * * *",
      timezone: "UTC",
      actionJson: messageAction(),
      createdByUserId: OWNER,
      nextRunAtMs: BASE + HOUR,
    });

    const row = s.getTask(OWNER, id)!;
    expect(row.name).toBe("صبح");
    expect(row.enabled).toBe(true);
    expect(row.runCount).toBe(0);
    expect(row.lastRunAtMs).toBeUndefined();

    // Another owner sees nothing.
    expect(s.getTask("intruder", id)).toBeUndefined();
    expect(s.listTasks("intruder")).toEqual([]);
    expect(s.deleteTask("intruder", id)).toBe(false);
    expect(s.updateTask("intruder", id, { name: "x" })).toBe(false);

    expect(s.listTasks(OWNER)).toHaveLength(1);
    expect(s.countTasks(OWNER)).toBe(1);
    expect(s.updateTask(OWNER, id, { name: "عصر", enabled: false })).toBe(true);
    const updated = s.getTask(OWNER, id)!;
    expect(updated.name).toBe("عصر");
    expect(updated.enabled).toBe(false);

    expect(s.deleteTask(OWNER, id)).toBe(true);
    expect(s.getTask(OWNER, id)).toBeUndefined();
    expect(s.countTasks(OWNER)).toBe(0);
    s.close();
  });

  test("dueTasks returns only enabled, due rows in time order", () => {
    const s = Storage.open(":memory:");
    s.createTask({ ...taskInput(), name: "later", nextRunAtMs: BASE + 10 * MIN });
    s.createTask({ ...taskInput(), name: "earlier", nextRunAtMs: BASE - 5 * MIN });
    s.createTask({ ...taskInput(), name: "disabled", enabled: false, nextRunAtMs: BASE - MIN });
    s.createTask({ ...taskInput(), name: "future", nextRunAtMs: BASE + HOUR });

    const due = s.dueTasks(BASE, 50);
    expect(due.map((t) => t.name)).toEqual(["earlier"]);
    s.close();
  });

  test("claimTask is atomic: the second claim loses", () => {
    const s = Storage.open(":memory:");
    const id = s.createTask({ ...taskInput(), nextRunAtMs: BASE });
    // The claim re-arms the row in the same write, so the winner is whoever
    // matches the old slot: the second claim finds the new slot instead.
    expect(s.claimTask(id, BASE, BASE + MIN)).toBe(true);
    expect(s.getTask(OWNER, id)!.nextRunAtMs).toBe(BASE + MIN);
    expect(s.claimTask(id, BASE, BASE + MIN)).toBe(false);
    // A stale expected value also loses.
    expect(s.claimTask(id, BASE, BASE + 2 * MIN)).toBe(false);
    // ...but the current slot can be claimed again.
    expect(s.claimTask(id, BASE + MIN, BASE + 2 * MIN)).toBe(true);
    s.close();
  });

  test("markTaskRun records the run outcome", () => {
    const s = Storage.open(":memory:");
    const id = s.createTask({ ...taskInput(), nextRunAtMs: BASE });
    expect(s.markTaskRun(id, { ranAtMs: BASE + 1000, status: "ok" })).toBe(true);
    const row = s.getTask(OWNER, id)!;
    expect(row.lastRunAtMs).toBe(BASE + 1000);
    expect(row.lastStatus).toBe("ok");
    expect(row.runCount).toBe(1);
    // The next slot is the claim's business, not the mark's.
    expect(row.nextRunAtMs).toBe(BASE);
    s.close();
  });

  test("tasks and schema version survive a storage reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "bobi-tasks-"));
    const path = join(dir, "t.db");
    try {
      const s1 = Storage.open(path);
      const id = s1.createTask({ ...taskInput(), name: "ماندگار", nextRunAtMs: BASE + MIN });
      s1.close();

      const s2 = Storage.open(path);
      const row = s2.getTask(OWNER, id)!;
      expect(row.name).toBe("ماندگار");
      expect(row.nextRunAtMs).toBe(BASE + MIN);
      expect(row.cronExpr).toBe("* * * * *");
      s2.close();

      // The migrated version marker is really the current version.
      const db = new Database(path, { readonly: true });
      const meta = db.prepare(`SELECT v FROM _meta WHERE k='schema_version'`).get() as
        | { v: string }
        | undefined;
      expect(meta?.v).toBe(String(SCHEMA_VERSION));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a v12 database migrates to v13 with the new table", () => {
    const dir = mkdtempSync(join(tmpdir(), "bobi-tasks-"));
    const path = join(dir, "t.db");
    try {
      const s1 = Storage.open(path);
      // Simulate a database left at v12 without the new table.
      const db = new Database(path);
      db.exec(`UPDATE _meta SET v='12' WHERE k='schema_version'`);
      db.exec(`DROP TABLE scheduled_tasks`);
      db.close();
      s1.close();

      const s2 = Storage.open(path);
      const id = s2.createTask({ ...taskInput() });
      expect(s2.getTask(OWNER, id)!.name).toBe("t");
      s2.close();

      const check = new Database(path, { readonly: true });
      const meta = check.prepare(`SELECT v FROM _meta WHERE k='schema_version'`).get() as
        | { v: string }
        | undefined;
      expect(meta?.v).toBe(String(SCHEMA_VERSION));
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function taskInput(): {
  name: string;
  cronExpr: string;
  timezone: string;
  actionJson: string;
  createdByUserId: string;
  nextRunAtMs: number;
  enabled?: boolean;
} {
  return {
    name: "t",
    cronExpr: "* * * * *",
    timezone: "UTC",
    actionJson: toolAction(),
    createdByUserId: OWNER,
    nextRunAtMs: BASE + MIN,
  };
}

// ---------- scheduler ----------

interface TaskHarness {
  storage: Storage;
  scheduler: TaskScheduler;
  toolCalls: Array<{ input: unknown; actorUserId: string }>;
  sent: Array<{ chatId: string; text: string }>;
  agentCalls: Array<{ chatId: string; prompt: string }>;
  errors: string[];
  now: () => number;
  advance: (ms: number) => void;
  setAgentResult: (ok: boolean) => void;
}

function taskHarness(startAt = BASE, withAgent = false): TaskHarness {
  const storage = Storage.open(":memory:");
  let clock = startAt;
  const toolCalls: TaskHarness["toolCalls"] = [];
  const sent: TaskHarness["sent"] = [];
  const agentCalls: TaskHarness["agentCalls"] = [];
  const errors: string[] = [];
  let agentResult = true;

  const echoTool: Tool<{ text: string }, { echo: string }> = {
    name: "test_echo",
    description: "test echo",
    enabled: true,
    permission: { requires: ["tools:test_echo"] },
    input: { fields: { text: { type: "string", required: true } } },
    async run(input, ctx) {
      toolCalls.push({ input, actorUserId: ctx.actor.userId });
      return { echo: input.text };
    },
  };
  const svc = new ToolService({
    extraTools: [echoTool] as unknown as readonly Tool<unknown, unknown>[],
  });

  const scheduler = new TaskScheduler({
    storage,
    tools: svc,
    intervalMs: 1_000,
    now: () => clock,
    sendMessage: async (d) => {
      sent.push({ chatId: d.chatId, text: d.text });
      return true;
    },
    ...(withAgent
      ? {
          runAgent: async (r: TaskAgentRun) => {
            agentCalls.push({ chatId: r.chatId, prompt: r.prompt });
            return agentResult;
          },
        }
      : {}),
    // The creator's live permissions, as the wiring would resolve them.
    actorForUser: (userId) => ({ userId, permissions: ["tools:test_echo"] }),
    onError: (m) => errors.push(m),
  });

  return {
    storage,
    scheduler,
    toolCalls,
    sent,
    agentCalls,
    errors,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    setAgentResult: (ok: boolean) => {
      agentResult = ok;
    },
  };
}

function insertTask(
  h: TaskHarness,
  over: Partial<Parameters<Storage["createTask"]>[0]> = {},
): number {
  return h.storage.createTask({
    name: "t",
    cronExpr: "* * * * *",
    timezone: "UTC",
    actionJson: toolAction(),
    createdByUserId: OWNER,
    nextRunAtMs: BASE + MIN,
    ...over,
  });
}

describe("TaskScheduler execution", () => {
  test("a due tool action runs with the creator's actor, then re-arms", async () => {
    const h = taskHarness();
    const id = insertTask(h);

    h.advance(MIN);
    const r = await h.scheduler.tick();
    expect(r.executed).toBe(1);
    expect(r.failed).toBe(0);

    // The tool ran as the task's creator — creator authority, not ambient.
    expect(h.toolCalls).toHaveLength(1);
    expect(h.toolCalls[0]!.actorUserId).toBe(OWNER);
    expect(h.toolCalls[0]!.input).toEqual({ text: "hi" });

    // Re-armed from the SCHEDULED slot: slot was BASE+MIN, next is BASE+2MIN.
    const row = h.storage.getTask(OWNER, id)!;
    expect(row.nextRunAtMs).toBe(BASE + 2 * MIN);
    expect(row.lastStatus).toBe("ok");
    expect(row.runCount).toBe(1);

    h.storage.close();
  });

  test("a message action goes through the injected sender", async () => {
    const h = taskHarness();
    insertTask(h, { actionJson: messageAction() });

    h.advance(MIN);
    const r = await h.scheduler.tick();
    expect(r.executed).toBe(1);
    expect(h.sent).toEqual([{ chatId: "c1", text: "سلام" }]);
    h.storage.close();
  });

  test("an agent action without a runner fails with a clear reason", async () => {
    const h = taskHarness(BASE, false);
    const id = insertTask(h, {
      actionJson: JSON.stringify({ type: "agent", chatId: "c1", prompt: "خلاصه بگو" }),
    });

    h.advance(MIN);
    const r = await h.scheduler.tick();
    expect(r.executed).toBe(0);
    expect(r.failed).toBe(1);
    expect(h.errors.some((e) => e.includes("no agent runner configured"))).toBe(true);

    // Marked failed AND re-armed: the schedule is not wedged.
    const row = h.storage.getTask(OWNER, id)!;
    expect(row.lastStatus).toBe("failed");
    expect(row.nextRunAtMs).toBe(BASE + 2 * MIN);
    h.storage.close();
  });

  test("an agent action with a runner executes", async () => {
    const h = taskHarness(BASE, true);
    insertTask(h, {
      actionJson: JSON.stringify({ type: "agent", chatId: "c9", prompt: "خبر امروز" }),
    });

    h.advance(MIN);
    expect((await h.scheduler.tick()).executed).toBe(1);
    expect(h.agentCalls).toEqual([{ chatId: "c9", prompt: "خبر امروز" }]);
    h.storage.close();
  });

  test("a tool action for an unknown tool fails and re-arms", async () => {
    const h = taskHarness();
    const id = insertTask(h, { actionJson: toolAction("no_such_tool") });

    h.advance(MIN);
    const r = await h.scheduler.tick();
    expect(r.failed).toBe(1);
    expect(h.toolCalls).toHaveLength(0);
    const row = h.storage.getTask(OWNER, id)!;
    expect(row.lastStatus).toBe("failed");
    expect(row.nextRunAtMs).toBe(BASE + 2 * MIN);
    h.storage.close();
  });

  test("a corrupt action row fails visibly but never wedges the schedule", async () => {
    const h = taskHarness();
    const id = insertTask(h, { actionJson: "{corrupt" });

    h.advance(MIN);
    expect((await h.scheduler.tick()).failed).toBe(1);
    const row = h.storage.getTask(OWNER, id)!;
    expect(row.lastStatus).toBe("failed");
    // Re-armed to a future slot, so the next tick is quiet.
    expect(row.nextRunAtMs).toBeGreaterThan(h.now());
    expect((await h.scheduler.tick()).failed).toBe(0);
    h.storage.close();
  });

  test("a disabled task never runs", async () => {
    const h = taskHarness();
    insertTask(h, { enabled: false, nextRunAtMs: BASE - MIN });

    h.advance(2 * MIN);
    const r = await h.scheduler.tick();
    expect(r).toEqual({ executed: 0, failed: 0, skipped: 0 });
    expect(h.toolCalls).toHaveLength(0);
    h.storage.close();
  });

  test("overlapping ticks do not double-run", async () => {
    const h = taskHarness();
    insertTask(h);

    h.advance(MIN);
    const [a, b] = await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
    expect(a.executed + b.executed).toBe(1);
    expect(h.toolCalls).toHaveLength(1);
    h.storage.close();
  });

  test("start is idempotent and stop is safe when not started", () => {
    const h = taskHarness();
    expect(h.scheduler.isRunning).toBe(false);
    h.scheduler.stop();
    h.scheduler.start();
    expect(h.scheduler.isRunning).toBe(true);
    h.scheduler.start();
    h.scheduler.stop();
    expect(h.scheduler.isRunning).toBe(false);
    h.storage.close();
  });
});

describe("TaskScheduler catch-up", () => {
  test("a task overdue within the window runs once, then re-arms", async () => {
    const h = taskHarness();
    const id = insertTask(h, { nextRunAtMs: BASE });

    // 30 minutes late: inside the 1h window.
    h.advance(30 * MIN);
    const r = await h.scheduler.tick();
    expect(r.executed).toBe(1);
    expect(h.toolCalls).toHaveLength(1);

    // Re-armed past now: the missed slot is not replayed again.
    const row = h.storage.getTask(OWNER, id)!;
    expect(row.nextRunAtMs).toBe(BASE + 31 * MIN);
    expect(row.lastStatus).toBe("ok");
    expect((await h.scheduler.tick()).executed).toBe(0);
    h.storage.close();
  });

  test("a task overdue beyond the window is skipped to its next slot", async () => {
    const h = taskHarness();
    const id = insertTask(h, { nextRunAtMs: BASE });

    // 2 hours late: outside the window.
    h.advance(2 * HOUR);
    const r = await h.scheduler.tick();
    expect(r.executed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(h.toolCalls).toHaveLength(0);

    const row = h.storage.getTask(OWNER, id)!;
    expect(row.lastStatus).toBe("skipped");
    expect(row.nextRunAtMs).toBeGreaterThan(h.now());
    // The next slot is the next minute boundary, not "now".
    expect(row.nextRunAtMs).toBe(BASE + 121 * MIN);
    h.storage.close();
  });

  test("lateness is bounded by the configured window", async () => {
    const storage = Storage.open(":memory:");
    let clock = BASE;
    const svc = new ToolService();
    const scheduler = new TaskScheduler({
      storage,
      tools: svc,
      intervalMs: 1_000,
      now: () => clock,
      maxLatenessMs: MIN,
      sendMessage: async () => true,
      actorForUser: (userId) => ({ userId, permissions: [] }),
    });
    storage.createTask({
      name: "t",
      cronExpr: "* * * * *",
      timezone: "UTC",
      actionJson: messageAction(),
      createdByUserId: OWNER,
      nextRunAtMs: BASE,
    });

    // Two minutes late with a one-minute tolerance: skipped, not run.
    clock = BASE + 2 * MIN;
    const r = await scheduler.tick();
    expect(r.skipped).toBe(1);
    expect(r.executed).toBe(0);
    storage.close();
  });
});

// ---------- tools ----------

function toolServiceHarness() {
  const storage = Storage.open(":memory:");
  const svc = new ToolService({
    extraTools: createScheduledTaskTools({
      storage,
      isOwner: (id) => id === OWNER,
      defaultTimezone: "UTC",
      toolExists: (name) => name === "test_echo",
      now: () => BASE,
    }),
    clock: () => new Date(BASE),
  });
  return { storage, svc };
}

function runTool(svc: ToolService, tool: string, input: unknown, actor: ToolActor) {
  return svc.execute({ tool, input, actor });
}

const ownerActor = (): ToolActor => ({ userId: OWNER, permissions: OWNER_PERMS });
// Holds the permission keys (as if the bridge had granted them) but is not
// the owner: the run()-level check must still refuse.
const intruderActor = (): ToolActor => ({ userId: "123", permissions: OWNER_PERMS });

const scheduleInput = (over: Record<string, unknown> = {}) => ({
  name: "یادآور صبح",
  cron: "0 7 * * *",
  action: { type: "message", chatId: "c1", text: "صبح بخیر" },
  ...over,
});

describe("schedule_task tool", () => {
  test("the owner creates a task; the cron is normalized and the next run is future", async () => {
    const { storage, svc } = toolServiceHarness();
    const r = await runTool(svc, "schedule_task", scheduleInput({ cron: "@daily" }), ownerActor());
    expect(r.status).toBe("ok");
    const data = r.data as { id: number; cron: string; timezone: string; nextRunAt: string };
    expect(data.cron).toBe("0 0 * * *");
    expect(data.timezone).toBe("UTC");
    expect(Date.parse(data.nextRunAt)).toBeGreaterThan(BASE);

    const row = storage.getTask(OWNER, data.id)!;
    expect(row.timezone).toBe("UTC");
    expect(parseTaskAction(JSON.parse(row.actionJson) as unknown)).toEqual({
      type: "message",
      chatId: "c1",
      text: "صبح بخیر",
    });
    storage.close();
  });

  test("a non-owner is refused even when holding the permission key", async () => {
    const { storage, svc } = toolServiceHarness();
    for (const tool of ["schedule_task", "list_tasks", "cancel_task"]) {
      const r = await runTool(
        svc,
        tool,
        tool === "schedule_task" ? scheduleInput() : tool === "cancel_task" ? { id: 1 } : {},
        intruderActor(),
      );
      expect(r.status).toBe("not_allowed");
    }
    storage.close();
  });

  test("an unknown actor identity is refused", async () => {
    const { storage, svc } = toolServiceHarness();
    const r = await runTool(svc, "schedule_task", scheduleInput(), {
      userId: "unknown",
      permissions: OWNER_PERMS,
    });
    expect(r.status).toBe("not_allowed");
    storage.close();
  });

  test("rejects a bad cron expression", async () => {
    const { storage, svc } = toolServiceHarness();
    const r = await runTool(svc, "schedule_task", scheduleInput({ cron: "61 * * * *" }), ownerActor());
    expect(r.status).toBe("invalid_input");
    storage.close();
  });

  test("rejects an unknown timezone", async () => {
    const { storage, svc } = toolServiceHarness();
    const r = await runTool(
      svc,
      "schedule_task",
      scheduleInput({ timezone: "Mars/Olympus" }),
      ownerActor(),
    );
    expect(r.status).toBe("invalid_input");
    storage.close();
  });

  test("rejects malformed actions", async () => {
    const { storage, svc } = toolServiceHarness();
    const badActions: unknown[] = [
      { type: "explode" },
      "just a string",
      { type: "tool" }, // missing tool name
      { type: "tool", tool: "Nope!", input: {} }, // bad name shape
      { type: "tool", tool: "missing_tool", input: {} }, // not registered
      { type: "tool", tool: "schedule_task", input: {} }, // tasks may not spawn tasks
      { type: "message", chatId: "c1" }, // missing text
      { type: "message", chatId: "c1", text: "" }, // empty text
      { type: "message", chatId: "c1", text: "x".repeat(2001) }, // too long
      { type: "agent", chatId: "c1" }, // missing prompt
    ];
    for (const action of badActions) {
      const r = await runTool(svc, "schedule_task", scheduleInput({ action }), ownerActor());
      expect(r.status).toBe("invalid_input");
    }
    expect(storage.countTasks(OWNER)).toBe(0);
    storage.close();
  });

  test("rejects an empty name", async () => {
    const { storage, svc } = toolServiceHarness();
    const r = await runTool(svc, "schedule_task", scheduleInput({ name: "   " }), ownerActor());
    expect(r.status).toBe("invalid_input");
    storage.close();
  });

  test("the per-owner cap is enforced", async () => {
    const { storage, svc } = toolServiceHarness();
    for (let i = 0; i < 25; i++) {
      const r = await runTool(
        svc,
        "schedule_task",
        scheduleInput({ name: `t${i}` }),
        ownerActor(),
      );
      expect(r.status).toBe("ok");
    }
    const r = await runTool(svc, "schedule_task", scheduleInput({ name: "t25" }), ownerActor());
    expect(r.status).toBe("invalid_input");
    storage.close();
  });
});

describe("list_tasks and cancel_task tools", () => {
  test("list shows the owner's tasks soonest-first", async () => {
    const { storage, svc } = toolServiceHarness();
    await runTool(svc, "schedule_task", scheduleInput({ name: "اول", cron: "0 7 * * *" }), ownerActor());
    await runTool(svc, "schedule_task", scheduleInput({ name: "دوم", cron: "0 8 * * *" }), ownerActor());

    const r = await runTool(svc, "list_tasks", {}, ownerActor());
    expect(r.status).toBe("ok");
    const data = r.data as { tasks: Array<{ name: string }>; count: number };
    expect(data.count).toBe(2);
    expect(data.tasks.map((t) => t.name)).toEqual(["اول", "دوم"]);
    storage.close();
  });

  test("cancel_task deletes the owner's task", async () => {
    const { storage, svc } = toolServiceHarness();
    const created = (await runTool(svc, "schedule_task", scheduleInput(), ownerActor())).data as {
      id: number;
    };
    const r = await runTool(svc, "cancel_task", { id: created.id }, ownerActor());
    expect(r.status).toBe("ok");
    expect((r.data as { cancelled: boolean }).cancelled).toBe(true);
    expect((r.data as { remaining: number }).remaining).toBe(0);

    // Cancelling twice is a no-op.
    const r2 = await runTool(svc, "cancel_task", { id: created.id }, ownerActor());
    expect((r2.data as { cancelled: boolean }).cancelled).toBe(false);
    storage.close();
  });

  test("one owner cannot cancel another's task", async () => {
    const { storage, svc } = toolServiceHarness();
    const id = storage.createTask({
      name: "t",
      cronExpr: "* * * * *",
      timezone: "UTC",
      actionJson: messageAction(),
      createdByUserId: "someone-else",
      nextRunAtMs: BASE + MIN,
    });
    const r = await runTool(svc, "cancel_task", { id }, ownerActor());
    expect((r.data as { cancelled: boolean }).cancelled).toBe(false);
    expect(storage.getTask("someone-else", id)).toBeDefined();
    storage.close();
  });
});

describe("owner-only bridging", () => {
  const fakeOwnerOnly = {
    name: "t1",
    description: "d",
    enabled: true,
    ownerOnly: true,
    permission: { requires: ["tools:t1"] },
    input: { fields: {} },
    async run() {
      return "x";
    },
  } as unknown as Tool<unknown, unknown>;

  test("the bridge withholds ownerOnly keys from non-owners", () => {
    const auth = new AuthorizationService(OwnerIdentity.fromNumber(111));
    const ownerRes = authorizeToolUse(auth, { id: 111 }, [fakeOwnerOnly]);
    expect(ownerRes.permissions).toEqual(["tools:t1"]);
    const userRes = authorizeToolUse(auth, { id: 222 }, [fakeOwnerOnly]);
    expect(userRes.permissions).toEqual([]);
  });
});

describe("parseTaskAction", () => {
  test("accepts each valid shape", () => {
    expect(parseTaskAction({ type: "tool", tool: "a_b", input: { x: 1 } })).toEqual({
      type: "tool",
      tool: "a_b",
      input: { x: 1 },
    });
    expect(parseTaskAction({ type: "message", chatId: "c1", text: "hi" })).toEqual({
      type: "message",
      chatId: "c1",
      text: "hi",
    });
    expect(parseTaskAction({ type: "agent", chatId: "c1", prompt: "p" })).toEqual({
      type: "agent",
      chatId: "c1",
      prompt: "p",
    });
  });
});
