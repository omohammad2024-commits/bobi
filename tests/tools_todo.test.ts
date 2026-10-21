/**
 * Todo lists — TodoRepo storage + the todo_list tool (Phase 9, Action Layer).
 *
 * Behaviours pinned here:
 *  - schema v24: a fresh DB has todo_items (with its index) and stamps 24;
 *    a v23-stamped DB gains the table on open, because migrate() re-runs
 *    the whole SCHEMA script (all CREATE TABLE IF NOT EXISTS) on a bump
 *  - repo CRUD round-trips, ordered by created_at,id, done filtering works
 *  - named lists are isolated from each other ("main" vs "shopping")
 *  - EVERYTHING is scoped by user_id: user B cannot see, complete, reopen,
 *    remove, or clear user A's items, at the repo level AND the tool level
 *  - the tool is one action-dispatched surface, NOT ownerOnly, and reports
 *    a missing/not-owned id honestly as not_found with the pinned message
 *
 * No network; the clock is a fixed injected Date where it matters.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Storage } from "../src/storage/storage";
import { ToolError } from "../src/tools/errors";
import { ToolService } from "../src/tools/service";
import type { ToolActor, ToolContext } from "../src/tools/types";
import { validateManifest } from "../src/tools/validate_manifest";
import {
  TODO_LIST_PERMISSION,
  createTodoTool,
  todoListManifest,
  type TodoListInput,
  type TodoListOutput,
} from "../src/tools/todo";

const ALICE = "111";
const BOB = "222";
const NOW = 1_761_000_000_000;

/** Unique temp path per case; never inside the repository. */
function tempDb(tag: string): string {
  return join(tmpdir(), `bobi-todo-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function ctx(userId: string, nowMs = NOW): ToolContext {
  return {
    clock: () => new Date(nowMs),
    actor: { userId, permissions: [TODO_LIST_PERMISSION] },
    signal: new AbortController().signal,
  };
}

/** Narrow a union output to the "list" variant or fail the test loudly. */
function asList(out: TodoListOutput): Extract<TodoListOutput, { action: "list" }> {
  if (out.action !== "list") throw new Error(`expected list output, got ${out.action}`);
  return out;
}

/** Narrow a union output to the "add" variant or fail the test loudly. */
function asAdd(out: TodoListOutput): Extract<TodoListOutput, { action: "add" }> {
  if (out.action !== "add") throw new Error(`expected add output, got ${out.action}`);
  return out;
}

// ---------------------------------------------------------------------------
// Schema v24
// ---------------------------------------------------------------------------

describe("schema v24 (todo_items)", () => {
  test("SCHEMA_VERSION is 24", () => {
    expect(SCHEMA_VERSION).toBe(24);
  });

  test("a fresh DB has todo_items + its index and stamps version 24", () => {
    const path = tempDb("fresh");
    try {
      Storage.open(path).close();
      const raw = new Database(path, { readonly: true });
      const version = raw
        .query<{ v: string }, []>(`SELECT v FROM _meta WHERE k='schema_version'`)
        .get();
      expect(version?.v).toBe("24");
      const tables = raw
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='todo_items'`,
        )
        .all();
      expect(tables.length).toBe(1);
      const indexes = raw
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='todo_items'`,
        )
        .all()
        .map((r) => r.name);
      expect(indexes).toContain("idx_todo_items_user_list");
      const cols = raw
        .query<{ name: string }, []>(`PRAGMA table_info(todo_items)`)
        .all()
        .map((r) => r.name);
      expect(cols).toEqual(["id", "user_id", "list_name", "text", "done", "created_at", "done_at"]);
      raw.close();
    } finally {
      cleanup(path);
    }
  });

  test("a v23-stamped DB gains todo_items on open (migrate re-runs SCHEMA)", () => {
    const path = tempDb("v23");
    try {
      const db = new Database(path);
      db.exec(`
        CREATE TABLE _meta(k TEXT PRIMARY KEY, v TEXT);
        INSERT INTO _meta(k,v) VALUES('schema_version','23');
      `);
      db.close();

      const s = Storage.open(path);
      const item = s.todo.add(ALICE, "main", "از نسخه ۲۳ اومدم", NOW);
      expect(s.todo.list(ALICE, "main", false).map((r) => r.id)).toEqual([item.id]);
      s.close();

      const raw = new Database(path, { readonly: true });
      const version = raw
        .query<{ v: string }, []>(`SELECT v FROM _meta WHERE k='schema_version'`)
        .get();
      expect(version?.v).toBe("24");
      raw.close();
    } finally {
      cleanup(path);
    }
  });
});

// ---------------------------------------------------------------------------
// TodoRepo
// ---------------------------------------------------------------------------

describe("TodoRepo", () => {
  test("add/list round-trips in creation order, done filtered unless asked", () => {
    const s = Storage.open(":memory:");
    const a = s.todo.add(ALICE, "main", "شیر بخر", NOW);
    const b = s.todo.add(ALICE, "main", "نان بخر", NOW); // same ms: id breaks the tie
    const c = s.todo.add(ALICE, "main", "پنیر بخر", NOW + 1_000);

    expect(a).toEqual({
      id: a.id,
      userId: ALICE,
      listName: "main",
      text: "شیر بخر",
      done: false,
      createdAt: NOW,
    });
    expect(s.todo.list(ALICE, "main", false).map((r) => r.id)).toEqual([a.id, b.id, c.id]);

    expect(s.todo.setDone(ALICE, b.id, true, NOW + 2_000)).toBe(true);
    expect(s.todo.list(ALICE, "main", false).map((r) => r.id)).toEqual([a.id, c.id]);
    const all = s.todo.list(ALICE, "main", true);
    expect(all.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    expect(all[1]!.done).toBe(true);
    expect(all[1]!.doneAt).toBe(NOW + 2_000);
    s.close();
  });

  test("reopen clears done and done_at", () => {
    const s = Storage.open(":memory:");
    const a = s.todo.add(ALICE, "main", "x", NOW);
    expect(s.todo.setDone(ALICE, a.id, true, NOW + 10)).toBe(true);
    expect(s.todo.setDone(ALICE, a.id, false, NOW + 20)).toBe(true);
    const row = s.todo.list(ALICE, "main", true)[0]!;
    expect(row.done).toBe(false);
    expect(row.doneAt).toBeUndefined();
    s.close();
  });

  test("named lists are isolated from each other", () => {
    const s = Storage.open(":memory:");
    s.todo.add(ALICE, "main", "کار خونه", NOW);
    s.todo.add(ALICE, "shopping", "شیر", NOW);
    s.todo.add(ALICE, "shopping", "نان", NOW);
    expect(s.todo.list(ALICE, "main", true).map((r) => r.text)).toEqual(["کار خونه"]);
    expect(s.todo.list(ALICE, "shopping", true).map((r) => r.text)).toEqual(["شیر", "نان"]);
    expect(s.todo.list(ALICE, "watchlist", true)).toEqual([]);
    s.close();
  });

  test("remove and clearCompleted report honest counts", () => {
    const s = Storage.open(":memory:");
    const a = s.todo.add(ALICE, "main", "a", NOW);
    const b = s.todo.add(ALICE, "main", "b", NOW);
    const c = s.todo.add(ALICE, "shopping", "c", NOW);
    s.todo.setDone(ALICE, a.id, true, NOW);
    s.todo.setDone(ALICE, c.id, true, NOW);

    expect(s.todo.clearCompleted(ALICE, "main")).toBe(1);
    expect(s.todo.clearCompleted(ALICE, "main")).toBe(0); // nothing left to clear
    expect(s.todo.list(ALICE, "main", true).map((r) => r.id)).toEqual([b.id]);
    // The other list's completed item was NOT cleared.
    expect(s.todo.list(ALICE, "shopping", true).map((r) => r.id)).toEqual([c.id]);

    expect(s.todo.remove(ALICE, b.id)).toBe(true);
    expect(s.todo.remove(ALICE, b.id)).toBe(false); // already gone
    expect(s.todo.remove(ALICE, 999_999)).toBe(false); // never existed
    s.close();
  });

  test("per-user isolation: B cannot see or touch A's items", () => {
    const s = Storage.open(":memory:");
    const a = s.todo.add(ALICE, "main", "مال آلیس", NOW);
    s.todo.add(BOB, "main", "مال باب", NOW);

    expect(s.todo.list(BOB, "main", true).map((r) => r.text)).toEqual(["مال باب"]);
    expect(s.todo.setDone(BOB, a.id, true, NOW)).toBe(false);
    expect(s.todo.remove(BOB, a.id)).toBe(false);
    expect(s.todo.setDone(BOB, a.id, false, NOW)).toBe(false);
    expect(s.todo.clearCompleted(BOB, "main")).toBe(0);
    // A's row is untouched.
    const rows = s.todo.list(ALICE, "main", true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.done).toBe(false);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// todo_list tool
// ---------------------------------------------------------------------------

describe("todo_list tool", () => {
  test("manifest is a valid desk card and the tool is not ownerOnly", () => {
    expect(validateManifest(todoListManifest)).toEqual([]);
    const storage = Storage.open(":memory:");
    const tool = createTodoTool({ storage });
    expect(tool.name).toBe("todo_list");
    expect(tool.permission.requires).toEqual([TODO_LIST_PERMISSION]);
    expect(tool.ownerOnly).toBeUndefined();
    expect(tool.manifest).toBe(todoListManifest);
    storage.close();
  });

  test("add → list → complete → reopen → remove, on the default list", async () => {
    const storage = Storage.open(":memory:");
    const tool = createTodoTool({ storage });
    const me = ctx(ALICE);

    const added = asAdd(await tool.run({ action: "add", text: "شیر بخر" }, me));
    expect(added.list).toBe("main");
    expect(added.item).toEqual({ id: added.item.id, text: "شیر بخر", done: false, createdAt: NOW });

    const open = asList(await tool.run({ action: "list" }, me));
    expect(open.items.map((i) => i.id)).toEqual([added.item.id]);
    expect(open.openCount).toBe(1);

    const completed = await tool.run({ action: "complete", id: added.item.id }, me);
    expect(completed).toEqual({ action: "complete", id: added.item.id, done: true });

    // Default list hides done items; includeDone shows them; openCount stays exact.
    expect(asList(await tool.run({ action: "list" }, me)).items).toEqual([]);
    const withDone = asList(await tool.run({ action: "list", includeDone: true }, me));
    expect(withDone.items).toHaveLength(1);
    expect(withDone.items[0]!.done).toBe(true);
    expect(withDone.openCount).toBe(0);

    const reopened = await tool.run({ action: "reopen", id: added.item.id }, me);
    expect(reopened).toEqual({ action: "reopen", id: added.item.id, done: false });
    expect(asList(await tool.run({ action: "list" }, me)).openCount).toBe(1);

    const removed = await tool.run({ action: "remove", id: added.item.id }, me);
    expect(removed).toEqual({ action: "remove", id: added.item.id, removed: true });
    expect(asList(await tool.run({ action: "list", includeDone: true }, me)).items).toEqual([]);
    storage.close();
  });

  test("named lists stay separate through the tool; clear_completed is per-list", async () => {
    const storage = Storage.open(":memory:");
    const tool = createTodoTool({ storage });
    const me = ctx(ALICE);

    await tool.run({ action: "add", text: "شیر", list: "shopping" }, me);
    const eggs = asAdd(await tool.run({ action: "add", text: "تخم‌مرغ", list: "shopping" }, me));
    await tool.run({ action: "add", text: "فیلم ببین", list: "watchlist" }, me);
    await tool.run({ action: "complete", id: eggs.item.id, list: "shopping" }, me);

    const shopping = asList(await tool.run({ action: "list", list: "shopping" }, me));
    expect(shopping.list).toBe("shopping");
    expect(shopping.items.map((i) => i.text)).toEqual(["شیر"]);
    expect(shopping.openCount).toBe(1);
    expect(asList(await tool.run({ action: "list" }, me)).items).toEqual([]);

    const cleared = await tool.run({ action: "clear_completed", list: "shopping" }, me);
    expect(cleared).toEqual({ action: "clear_completed", list: "shopping", cleared: 1 });
    const shoppingAll = asList(
      await tool.run({ action: "list", list: "shopping", includeDone: true }, me),
    );
    expect(shoppingAll.items.map((i) => i.text)).toEqual(["شیر"]);
    storage.close();
  });

  test("user B cannot see, complete, or remove user A's item (not_found, no leak)", async () => {
    const storage = Storage.open(":memory:");
    const tool = createTodoTool({ storage });
    const added = asAdd(await tool.run({ action: "add", text: "محرمانه" }, ctx(ALICE)));
    const bob = ctx(BOB);

    expect(asList(await tool.run({ action: "list", includeDone: true }, bob)).items).toEqual([]);

    for (const input of [
      { action: "complete", id: added.item.id },
      { action: "reopen", id: added.item.id },
      { action: "remove", id: added.item.id },
    ] as TodoListInput[]) {
      await expect(tool.run(input, bob)).rejects.toMatchObject({
        kind: "not_found",
        message: "That item doesn't exist on your list.",
      });
    }
    // A's item is untouched by all of B's attempts.
    const mine = asList(await tool.run({ action: "list" }, ctx(ALICE)));
    expect(mine.items.map((i) => i.text)).toEqual(["محرمانه"]);
    expect(mine.items[0]!.done).toBe(false);
    storage.close();
  });

  test("a nonexistent id reports not_found honestly", async () => {
    const storage = Storage.open(":memory:");
    const tool = createTodoTool({ storage });
    const me = ctx(ALICE);
    await expect(tool.run({ action: "complete", id: 424_242 }, me)).rejects.toBeInstanceOf(
      ToolError,
    );
    await expect(tool.run({ action: "remove", id: 424_242 }, me)).rejects.toMatchObject({
      kind: "not_found",
      message: "That item doesn't exist on your list.",
    });
    storage.close();
  });

  test("bad input is refused: empty text, missing id, unknown actor", async () => {
    const storage = Storage.open(":memory:");
    const tool = createTodoTool({ storage });
    const me = ctx(ALICE);
    await expect(tool.run({ action: "add", text: "   " }, me)).rejects.toMatchObject({
      kind: "invalid_input",
    });
    await expect(tool.run({ action: "add" }, me)).rejects.toMatchObject({
      kind: "invalid_input",
    });
    await expect(tool.run({ action: "complete" }, me)).rejects.toMatchObject({
      kind: "invalid_input",
    });
    await expect(tool.run({ action: "list" }, ctx("unknown"))).rejects.toMatchObject({
      kind: "not_allowed",
    });
    storage.close();
  });

  test("through the Executor: permission is required and the happy path is ok", async () => {
    const storage = Storage.open(":memory:");
    const svc = new ToolService({ extraTools: [createTodoTool({ storage })] });
    const withPerm: ToolActor = { userId: ALICE, permissions: [TODO_LIST_PERMISSION] };
    const noPerm: ToolActor = { userId: ALICE, permissions: [] };

    const denied = await svc.execute({
      tool: "todo_list",
      input: { action: "add", text: "x" },
      actor: noPerm,
    });
    expect(denied.status).toBe("not_allowed");

    const ok = await svc.execute({
      tool: "todo_list",
      input: { action: "add", text: "از اگزکیوتور" },
      actor: withPerm,
    });
    expect(ok.status).toBe("ok");
    expect(asAdd(ok.data as TodoListOutput).item.text).toBe("از اگزکیوتور");

    // The Executor's validator enforces the field ceilings before run().
    const tooLong = await svc.execute({
      tool: "todo_list",
      input: { action: "add", text: "x".repeat(501) },
      actor: withPerm,
    });
    expect(tooLong.status).toBe("invalid_input");
    storage.close();
  });
});
