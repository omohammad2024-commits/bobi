/**
 * Long-term memory.
 *
 * The security property that matters here is isolation: one user's memory must
 * never be readable or writable by another, including when a model puts a
 * different id in its arguments. Everything else is convenience around that.
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Storage } from "../src/storage/storage";
import { ToolService } from "../src/tools/service";
import {
  createForgetTool,
  createMemoryTools,
  createRecallTool,
  createRememberTool,
  FORGET_PERMISSION,
  RECALL_PERMISSION,
  REMEMBER_PERMISSION,
} from "../src/tools/memory";
import type { ToolActor } from "../src/tools/types";

const PERMS = [REMEMBER_PERMISSION, RECALL_PERMISSION, FORGET_PERMISSION];

function actor(userId: string): ToolActor {
  return { userId, permissions: PERMS };
}

function service() {
  const storage = Storage.open(":memory:");
  return { storage, svc: new ToolService({ extraTools: createMemoryTools({ storage }) }) };
}

/** Run through the Executor, which is the only production path. */
function run(svc: ToolService, tool: string, input: unknown, who = actor("u1")) {
  return svc.runTool({ tool, input, actor: who });
}

describe("memory tools registration", () => {
  test("all three register", () => {
    const { storage, svc } = service();
    for (const name of ["remember", "recall", "forget"]) {
      expect(svc.listActiveNames()).toContain(name);
    }
    storage.close();
  });

  test("each declares its own permission", () => {
    expect(createRememberTool({} as never).permission.requires).toEqual([REMEMBER_PERMISSION]);
    expect(createRecallTool({} as never).permission.requires).toEqual([RECALL_PERMISSION]);
    expect(createForgetTool({} as never).permission.requires).toEqual([FORGET_PERMISSION]);
  });
});

describe("remember", () => {
  test("stores a memory and reports the new total", async () => {
    const { storage, svc } = service();
    const r = await run(svc, "remember", { key: "نام پروژه", content: "سول" });
    expect(r.status).toBe("ok");
    expect((r.data as { replaced: boolean }).replaced).toBe(false);
    expect((r.data as { total: number }).total).toBe(1);
    expect(storage.getMemory("u1", "نام پروژه")?.content).toBe("سول");
    storage.close();
  });

  test("re-storing the same key replaces rather than duplicates", async () => {
    const { storage, svc } = service();
    await run(svc, "remember", { key: "نام", content: "اول" });
    const r = await run(svc, "remember", { key: "نام", content: "دوم" });
    expect((r.data as { replaced: boolean }).replaced).toBe(true);
    expect((r.data as { total: number }).total).toBe(1);
    expect(storage.getMemory("u1", "نام")?.content).toBe("دوم");
    storage.close();
  });

  test("whitespace in a key is collapsed, so near-duplicates merge", async () => {
    const { storage, svc } = service();
    await run(svc, "remember", { key: "نام  پروژه", content: "a" });
    const r = await run(svc, "remember", { key: "نام پروژه", content: "b" });
    expect((r.data as { replaced: boolean }).replaced).toBe(true);
    expect(storage.countMemories("u1")).toBe(1);
    storage.close();
  });

  test("Case is preserved rather than folded", async () => {
    const { storage, svc } = service();
    await run(svc, "remember", { key: "Project", content: "a" });
    await run(svc, "remember", { key: "project", content: "b" });
    // Two distinct keys, because folding would mangle a deliberate Latin label.
    expect(storage.countMemories("u1")).toBe(2);
    storage.close();
  });

  test("an empty key or content is refused", async () => {
    const { svc, storage } = service();
    expect((await run(svc, "remember", { key: "", content: "x" })).status).toBe("invalid_input");
    expect((await run(svc, "remember", { key: "  ", content: "x" })).status).toBe("invalid_input");
    expect((await run(svc, "remember", { key: "k", content: "   " })).status).toBe("invalid_input");
    storage.close();
  });

  test("an over-long key or content is refused", async () => {
    const { svc, storage } = service();
    expect(
      (await run(svc, "remember", { key: "k".repeat(200), content: "x" })).status,
    ).toBe("invalid_input");
    expect(
      (await run(svc, "remember", { key: "k", content: "x".repeat(5_000) })).status,
    ).toBe("invalid_input");
    storage.close();
  });

  test("an actor without the permission cannot store", async () => {
    const { svc, storage } = service();
    const r = await run(svc, "remember", { key: "k", content: "v" }, {
      userId: "u1",
      permissions: [],
    });
    expect(r.status).toBe("not_allowed");
    storage.close();
  });
});

describe("recall", () => {
  test("returns stored memories", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "رنگ", content: "آبی" });
    const r = await run(svc, "recall", {});
    expect(r.status).toBe("ok");
    const data = r.data as { memories: Array<{ key: string }>; total: number };
    expect(data.total).toBe(1);
    expect(data.memories[0]!.key).toBe("رنگ");
    storage.close();
  });

  test("an empty store returns an empty list, not an error", async () => {
    const { svc, storage } = service();
    const r = await run(svc, "recall", {});
    expect(r.status).toBe("ok");
    expect((r.data as { memories: unknown[] }).memories).toEqual([]);
    storage.close();
  });

  test("a query matches the key", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "نام پروژه", content: "سول" });
    await run(svc, "remember", { key: "رنگ", content: "آبی" });
    const r = await run(svc, "recall", { query: "پروژه" });
    const data = r.data as { memories: Array<{ key: string }> };
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0]!.key).toBe("نام پروژه");
    storage.close();
  });

  test("a query matches the content too", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "یادداشت", content: "پسورد گاوصندوق" });
    const r = await run(svc, "recall", { query: "گاوصندوق" });
    const data = r.data as { memories: Array<{ key: string }> };
    expect(data.memories).toHaveLength(1);
    storage.close();
  });

  test("a key match ranks above a content match", async () => {
    const { svc, storage } = service();
    // The content match is stored first, so ordering must come from ranking.
    await run(svc, "remember", { key: "یادداشت اول", content: "دربارهٔ پروژه" });
    await run(svc, "remember", { key: "پروژه", content: "چیز دیگر" });
    const r = await run(svc, "recall", { query: "پروژه" });
    const data = r.data as { memories: Array<{ key: string }> };
    expect(data.memories[0]!.key).toBe("پروژه");
    storage.close();
  });

  test("a query matching nothing returns an empty list", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "رنگ", content: "آبی" });
    const r = await run(svc, "recall", { query: "چیزی که نیست" });
    // Not an error: "nothing matched" is a legitimate answer the model should
    // report rather than retry.
    expect(r.status).toBe("ok");
    expect((r.data as { memories: unknown[] }).memories).toEqual([]);
    storage.close();
  });

  test("the limit is honoured and defaults sensibly", async () => {
    const { svc, storage } = service();
    for (let i = 0; i < 10; i++) {
      await run(svc, "remember", { key: `k${i}`, content: `v${i}` });
    }
    const limited = await run(svc, "recall", { limit: 3 });
    expect((limited.data as { memories: unknown[] }).memories).toHaveLength(3);
    storage.close();
  });
});

describe("forget", () => {
  test("removes the named memory", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "k", content: "v" });
    const r = await run(svc, "forget", { key: "k" });
    expect((r.data as { removed: boolean }).removed).toBe(true);
    expect(storage.getMemory("u1", "k")).toBeUndefined();
    storage.close();
  });

  test("forgetting something absent reports so without failing", async () => {
    const { svc, storage } = service();
    const r = await run(svc, "forget", { key: "nothing" });
    expect(r.status).toBe("ok");
    expect((r.data as { removed: boolean }).removed).toBe(false);
    storage.close();
  });

  test("a key that normalises differently still matches", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "نام پروژه", content: "v" });
    const r = await run(svc, "forget", { key: "نام  پروژه" });
    expect((r.data as { removed: boolean }).removed).toBe(true);
    storage.close();
  });
});

describe("per-user isolation", () => {
  test("one user cannot read another's memory", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "راز", content: "مال کاربر یک" }, actor("u1"));

    const r = await run(svc, "recall", {}, actor("u2"));
    expect((r.data as { memories: unknown[] }).memories).toEqual([]);
    expect((r.data as { total: number }).total).toBe(0);
    storage.close();
  });

  test("two users may use the same key without collision", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "نام", content: "اول" }, actor("u1"));
    await run(svc, "remember", { key: "نام", content: "دوم" }, actor("u2"));

    expect(storage.getMemory("u1", "نام")?.content).toBe("اول");
    expect(storage.getMemory("u2", "نام")?.content).toBe("دوم");
    storage.close();
  });

  test("overwriting as one user leaves the other's value alone", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "k", content: "u1-value" }, actor("u1"));
    await run(svc, "remember", { key: "k", content: "u2-value" }, actor("u2"));
    await run(svc, "remember", { key: "k", content: "u1-new" }, actor("u1"));

    expect(storage.getMemory("u1", "k")?.content).toBe("u1-new");
    expect(storage.getMemory("u2", "k")?.content).toBe("u2-value");
    storage.close();
  });

  test("one user cannot forget another's memory", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "k", content: "v" }, actor("u1"));

    const r = await run(svc, "forget", { key: "k" }, actor("u2"));
    expect((r.data as { removed: boolean }).removed).toBe(false);
    // The original is untouched.
    expect(storage.getMemory("u1", "k")?.content).toBe("v");
    storage.close();
  });

  test("a model cannot address another user by injecting an id", async () => {
    const { svc, storage } = service();
    await run(svc, "remember", { key: "k", content: "mine" }, actor("u1"));

    // The model tries to read as somebody else through its arguments.
    const r = await run(
      svc,
      "recall",
      { query: "k", userId: "u2", actor: { userId: "u2" } },
      actor("u1"),
    );
    // Unknown fields are rejected, and even a well-formed attempt would be
    // scoped by the actor, never by the payload.
    expect(r.status).toBe("invalid_input");
    storage.close();
  });

  test("an unidentified actor gets no memory access at all", async () => {
    const { svc, storage } = service();
    const anon: ToolActor = { userId: "unknown", permissions: PERMS };
    const r = await run(svc, "remember", { key: "k", content: "v" }, anon);
    // Refused rather than sharing one anonymous memory space.
    expect(r.status).toBe("not_allowed");
    storage.close();
  });
});

describe("memory persistence", () => {
  test("memories survive a reopen", () => {
    // A unique path per run: a leftover file would make this assert against
    // state it did not create.
    const path = `${tmpdir()}/sol-memory-persist-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`;
    const s1 = Storage.open(path);
    s1.upsertMemory({ userId: "u1", key: "k", content: "v" });
    s1.close();

    const s2 = Storage.open(path);
    expect(s2.getMemory("u1", "k")?.content).toBe("v");
    s2.close();

    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  });

  test("the count reflects only this user", () => {
    const { storage } = service();
    storage.upsertMemory({ userId: "u1", key: "a", content: "1" });
    storage.upsertMemory({ userId: "u1", key: "b", content: "2" });
    storage.upsertMemory({ userId: "u2", key: "a", content: "3" });
    expect(storage.countMemories("u1")).toBe(2);
    expect(storage.countMemories("u2")).toBe(1);
    storage.close();
  });

  test("the store is capped per user", async () => {
    const storage = Storage.open(":memory:");
    const svc = new ToolService({ extraTools: [createRememberTool({ storage }) as never] });
    // Fill to the cap, then confirm the next add is refused while a replace
    // still works.
    for (let i = 0; i < 200; i++) {
      storage.upsertMemory({ userId: "u1", key: `k${i}`, content: "v" });
    }
    const add = await run(svc, "remember", { key: "overflow", content: "v" });
    expect(add.status).toBe("invalid_input");

    const replace = await run(svc, "remember", { key: "k0", content: "updated" });
    expect(replace.status).toBe("ok");
    expect((replace.data as { replaced: boolean }).replaced).toBe(true);
    storage.close();
  });
});
