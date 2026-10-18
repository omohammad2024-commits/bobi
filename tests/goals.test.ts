/**
 * Goal tools and their storage.
 *
 * Goals are the owner's persistent intents; the heartbeat works toward them
 * on its own. The behaviours pinned here:
 *  - CRUD is scoped to the creator: an intruder sees nothing, completes nothing
 *  - only an active goal may be completed, and only once
 *  - title length is bounded at the database, not just the tool
 *  - a schema-v13 database migrates to v14 with the new tables usable
 *  - the tools are owner-only at BOTH layers: the bridge withholds the
 *    permission keys from non-owners, and run() refuses a non-owner even when
 *    the actor was built with the keys directly
 *
 * No network; clocks come from the real clock only where the value does not
 * matter to the assertion.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Storage } from "../src/storage/storage";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolActor } from "../src/tools/types";
import {
  ADD_GOAL_PERMISSION,
  COMPLETE_GOAL_PERMISSION,
  createGoalTools,
  LIST_GOALS_PERMISSION,
} from "../src/tools/goals";
import { authorizeToolUse } from "../src/auth/tool_bridge";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";

const OWNER = "999";
const INTRUDER = "222";
const GOAL_PERMS = [ADD_GOAL_PERMISSION, LIST_GOALS_PERMISSION, COMPLETE_GOAL_PERMISSION];

function ownerActor(): ToolActor {
  return { userId: OWNER, permissions: GOAL_PERMS };
}

function service() {
  const storage = Storage.open(":memory:");
  const deps = { storage, isOwner: (id: string) => id === OWNER };
  const svc = new ToolService({ extraTools: createGoalTools(deps) });
  return { storage, svc };
}

function run(svc: ToolService, tool: string, input: unknown, actor: ToolActor) {
  return svc.execute({ tool, input, actor });
}

/** Unique temp path per case; never inside the repository. */
function tempDb(tag: string): string {
  return join(tmpdir(), `bobi-goals-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // A leftover temp file must not fail the suite.
    }
  }
}

describe("schema version", () => {
  test("is at least 14 after the goals + heartbeat migration", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
  });
});

describe("goals storage", () => {
  test("create/get/list/complete round-trips", () => {
    const s = Storage.open(":memory:");
    const id = s.createGoal({ title: "ورزش صبح", description: "هر روز ۲۰ دقیقه", createdBy: OWNER });

    const row = s.getGoal(OWNER, id)!;
    expect(row.title).toBe("ورزش صبح");
    expect(row.description).toBe("هر روز ۲۰ دقیقه");
    expect(row.status).toBe("active");
    expect(row.createdBy).toBe(OWNER);
    expect(row.doneAt).toBeUndefined();

    expect(s.listGoals(OWNER)).toHaveLength(1);
    expect(s.listGoals(OWNER, "active")).toHaveLength(1);
    expect(s.listGoals(OWNER, "done")).toHaveLength(0);
    expect(s.countGoals(OWNER)).toBe(1);

    expect(s.completeGoal(OWNER, id)).toBe(true);
    const done = s.getGoal(OWNER, id)!;
    expect(done.status).toBe("done");
    expect(typeof done.doneAt).toBe("number");
    expect(s.listGoals(OWNER, "active")).toHaveLength(0);
    expect(s.listGoals(OWNER, "done")).toHaveLength(1);

    // Completing twice does not move: the second call reports false.
    expect(s.completeGoal(OWNER, id)).toBe(false);
    s.close();
  });

  test("rows are scoped to their creator", () => {
    const s = Storage.open(":memory:");
    const id = s.createGoal({ title: "هدف من", createdBy: OWNER });

    expect(s.getGoal(INTRUDER, id)).toBeUndefined();
    expect(s.listGoals(INTRUDER)).toEqual([]);
    expect(s.countGoals(INTRUDER)).toBe(0);
    expect(s.completeGoal(INTRUDER, id)).toBe(false);
    // The owner's row is untouched.
    expect(s.getGoal(OWNER, id)?.status).toBe("active");
    s.close();
  });

  test("completing an unknown id reports false", () => {
    const s = Storage.open(":memory:");
    expect(s.completeGoal(OWNER, 12345)).toBe(false);
    s.close();
  });

  test("title length is bounded at the database", () => {
    const s = Storage.open(":memory:");
    expect(() =>
      s.createGoal({ title: "x".repeat(121), createdBy: OWNER }),
    ).toThrow();
    s.close();
  });

  test("a schema-v13 database migrates to v14 with goals and heartbeat usable", () => {
    const path = tempDb("v13");
    try {
      // Fresh open writes v14; strip the two new tables and stamp v13, which
      // is exactly the state an upgraded deployment's database is in.
      const s1 = Storage.open(path);
      s1.close();
      const db = new Database(path);
      db.exec(`DROP TABLE goals; DROP TABLE heartbeat_log;`);
      db.exec(`UPDATE _meta SET v='13' WHERE k='schema_version';`);
      db.close();

      const s = Storage.open(path);
      const id = s.createGoal({ title: "پس از مهاجرت", createdBy: OWNER });
      expect(s.getGoal(OWNER, id)?.title).toBe("پس از مهاجرت");
      const logId = s.logHeartbeat({ summary: "تست", toolCalls: 0, status: "ok" });
      expect(s.recentHeartbeats(1)[0]?.id).toBe(logId);
      s.close();
    } finally {
      cleanup(path);
    }
  });
});

describe("heartbeat_log storage", () => {
  test("appends and reads newest-first, truncating long summaries", () => {
    const s = Storage.open(":memory:");
    s.logHeartbeat({ summary: "اول", toolCalls: 1, status: "ok" });
    s.logHeartbeat({ summary: "دوم", toolCalls: 0, status: "skipped" });

    const rows = s.recentHeartbeats(5);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.summary).toBe("دوم");
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[1]!.toolCalls).toBe(1);

    // A 600-char summary is cut to 500 without splitting an emoji.
    const long = "😀".repeat(600); // 600 code points, not UTF-16 units
    const id = s.logHeartbeat({ summary: long, toolCalls: 0, status: "ok" });
    const stored = s.recentHeartbeats(1)[0]!;
    expect(stored.id).toBe(id);
    expect(Array.from(stored.summary).length).toBe(500);
    expect(stored.summary.endsWith("😀")).toBe(true);
    s.close();
  });
});

describe("goal tools", () => {
  test("add/list/complete round-trips for the owner", async () => {
    const { storage, svc } = service();
    const r1 = await run(svc, "add_goal", { title: "یادگیری زبان", description: "روزی یک درس" }, ownerActor());
    expect(r1.status).toBe("ok");
    const id = (r1.data as { id: number }).id;

    const r2 = await run(svc, "list_goals", {}, ownerActor());
    expect(r2.status).toBe("ok");
    const goals = (r2.data as { goals: { id: number; title: string }[] }).goals;
    expect(goals).toHaveLength(1);
    expect(goals[0]!.title).toBe("یادگیری زبان");

    const r3 = await run(svc, "list_goals", { status: "done" }, ownerActor());
    expect((r3.data as { count: number }).count).toBe(0);

    const r4 = await run(svc, "complete_goal", { id }, ownerActor());
    expect(r4.status).toBe("ok");
    expect((r4.data as { completed: boolean }).completed).toBe(true);
    expect((r4.data as { remaining: number }).remaining).toBe(0);

    const r5 = await run(svc, "list_goals", { status: "done" }, ownerActor());
    expect((r5.data as { count: number }).count).toBe(1);
    storage.close();
  });

  test("add_goal rejects an empty title and a bad status filter is rejected", async () => {
    const { storage, svc } = service();
    const r1 = await run(svc, "add_goal", { title: "   " }, ownerActor());
    expect(r1.status).toBe("invalid_input");

    const r2 = await run(svc, "list_goals", { status: "bogus" }, ownerActor());
    expect(r2.status).toBe("invalid_input");
    storage.close();
  });

  test("complete_goal on an unknown id is not_found", async () => {
    const { storage, svc } = service();
    const r = await run(svc, "complete_goal", { id: 4242 }, ownerActor());
    expect(r.status).toBe("not_found");
    storage.close();
  });

  test("run() refuses a non-owner even when the actor holds the keys", async () => {
    // Defence in depth: the bridge withholds keys from non-owners, but a
    // caller that builds actors directly could hold them anyway. The tools
    // check ownership themselves.
    const { storage, svc } = service();
    const intruder: ToolActor = { userId: INTRUDER, permissions: GOAL_PERMS };

    for (const [tool, input] of [
      ["add_goal", { title: "x" }],
      ["list_goals", {}],
      ["complete_goal", { id: 1 }],
    ] as const) {
      const r = await run(svc, tool, input, intruder);
      expect(r.status).toBe("not_allowed");
    }
    storage.close();
  });

  test("the bridge withholds goal permission keys from non-owners", () => {
    const goalTool = {
      name: "add_goal",
      description: "d",
      enabled: true,
      ownerOnly: true,
      permission: { requires: [ADD_GOAL_PERMISSION] },
      input: { fields: {} },
      async run() {
        return {};
      },
    } as unknown as Tool<unknown, unknown>;

    const auth = new AuthorizationService(OwnerIdentity.fromNumber(111));
    const ownerRes = authorizeToolUse(auth, { id: 111 }, [goalTool]);
    expect(ownerRes.permissions).toEqual([ADD_GOAL_PERMISSION]);
    const userRes = authorizeToolUse(auth, { id: 222 }, [goalTool]);
    expect(userRes.permissions).toEqual([]);
  });

  test("an unidentified actor is refused", async () => {
    const { storage, svc } = service();
    const r = await run(
      svc,
      "list_goals",
      {},
      { userId: "unknown", permissions: GOAL_PERMS },
    );
    expect(r.status).toBe("not_allowed");
    storage.close();
  });
});
