/**
 * Pluggable memory providers (Phase D2).
 *
 * The point of this suite is swappability: the remember/recall/forget tools
 * must behave identically no matter which MemoryProvider is behind them, and
 * the SqliteMemoryProvider must be the old storage behavior moved verbatim.
 *
 * The second provider lives IN this file (MapMemoryProvider): if the tools
 * work against a Map, the abstraction is real and not just SQLite-shaped.
 */
import { describe, expect, test } from "bun:test";
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
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";
import { SqliteMemoryProvider } from "../src/memory/sqlite_provider";
import {
  getMemoryProvider,
  memoryProviderNames,
  registerMemoryProvider,
} from "../src/memory/registry";
import { DEFAULT_MEMORY_PROVIDER, resolveMemoryProvider } from "../src/memory/factory";
import type { ToolActor } from "../src/tools/types";

const PERMS = [REMEMBER_PERMISSION, RECALL_PERMISSION, FORGET_PERMISSION];

function actor(userId: string): ToolActor {
  return { userId, permissions: PERMS };
}

/** In-memory provider, purely for tests. Async, to prove the tools await. */
class MapMemoryProvider implements MemoryProvider {
  readonly name = "map";
  private data = new Map<string, Map<string, StoredMemory>>();

  private bucket(userId: string): Map<string, StoredMemory> {
    let b = this.data.get(userId);
    if (!b) {
      b = new Map();
      this.data.set(userId, b);
    }
    return b;
  }

  async upsert(userId: string, key: string, content: string): Promise<void> {
    const now = Date.now();
    const b = this.bucket(userId);
    const prev = b.get(key);
    b.set(key, {
      key,
      content,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async get(userId: string, key: string): Promise<StoredMemory | undefined> {
    return this.bucket(userId).get(key);
  }

  async list(userId: string, limit = 50): Promise<StoredMemory[]> {
    return [...this.bucket(userId).values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1))
      .slice(0, limit);
  }

  async delete(userId: string, key: string): Promise<boolean> {
    return this.bucket(userId).delete(key);
  }

  async count(userId: string): Promise<number> {
    return this.bucket(userId).size;
  }
}

/** Run one scripted session through the tools; returns each step's data. */
async function scriptedSession(provider: MemoryProvider, who = "u1") {
  const svc = new ToolService({ extraTools: createMemoryTools({ provider }) });
  const me = actor(who);
  const run = (tool: string, input: unknown) => svc.runTool({ tool, input, actor: me });
  const out: unknown[] = [];

  out.push((await run("remember", { key: "نام پروژه", content: "سول" })).data);
  out.push((await run("remember", { key: "نام پروژه", content: "بابی" })).data);
  out.push((await run("recall", {})).data);
  out.push((await run("recall", { query: "بابی" })).data);
  out.push((await run("recall", { query: "نام پروژه" })).data);
  out.push((await run("forget", { key: "نام پروژه" })).data);
  out.push((await run("forget", { key: "نام پروژه" })).data);
  out.push((await run("recall", {})).data);
  return out;
}

describe("registry", () => {
  test("register / get / names round-trip", () => {
    const p = new MapMemoryProvider();
    registerMemoryProvider(p);
    expect(getMemoryProvider("map")).toBe(p);
    expect(memoryProviderNames()).toContain("map");
    expect(getMemoryProvider("nope")).toBeUndefined();
  });

  test("re-registering replaces the previous provider", () => {
    const first = new MapMemoryProvider();
    const second = new MapMemoryProvider();
    registerMemoryProvider(first);
    registerMemoryProvider(second);
    expect(getMemoryProvider("map")).toBe(second);
  });
});

describe("factory", () => {
  const ENV = "BOBI_MEMORY_PROVIDER";
  const saved = process.env[ENV];

  function restoreEnv() {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }

  test("unset env resolves to the sqlite provider", () => {
    delete process.env[ENV];
    try {
      const storage = Storage.open(":memory:");
      const p = resolveMemoryProvider(storage);
      expect(p).toBeInstanceOf(SqliteMemoryProvider);
      expect(p.name).toBe("sqlite");
      expect(DEFAULT_MEMORY_PROVIDER).toBe("sqlite");
      storage.close();
    } finally {
      restoreEnv();
    }
  });

  test("a registered custom provider is selected by name", () => {
    const custom = new MapMemoryProvider();
    registerMemoryProvider(custom);
    process.env[ENV] = "map";
    try {
      const storage = Storage.open(":memory:");
      expect(resolveMemoryProvider(storage)).toBe(custom);
      storage.close();
    } finally {
      restoreEnv();
    }
  });

  test("an unknown name throws instead of silently falling back", () => {
    process.env[ENV] = "definitely-not-a-provider";
    try {
      const storage = Storage.open(":memory:");
      expect(() => resolveMemoryProvider(storage)).toThrow(/not a registered memory provider/);
      storage.close();
    } finally {
      restoreEnv();
    }
  });
});

describe("provider swappability", () => {
  test("the tools behave identically on sqlite and on the map provider", async () => {
    registerMemoryProvider(new MapMemoryProvider());

    const s1 = Storage.open(":memory:");
    const sqliteOut = await scriptedSession(new SqliteMemoryProvider(s1));
    s1.close();

    const mapOut = await scriptedSession(getMemoryProvider("map")!);
    // Identical outputs step by step: replaced flags, totals, recall order,
    // forget removed flags. If the abstraction leaked, these would diverge.
    expect(mapOut).toEqual(sqliteOut);
  });

  test("the tool permission declarations are unchanged", () => {
    const p = new MapMemoryProvider();
    expect(createRememberTool({ provider: p }).permission.requires).toEqual([
      REMEMBER_PERMISSION,
    ]);
    expect(createRecallTool({ provider: p }).permission.requires).toEqual([RECALL_PERMISSION]);
    expect(createForgetTool({ provider: p }).permission.requires).toEqual([FORGET_PERMISSION]);
  });

  test("users are isolated through a custom provider", async () => {
    const svc = new ToolService({ extraTools: createMemoryTools({ provider: new MapMemoryProvider() }) });
    const r1 = await svc.runTool({
      tool: "remember",
      input: { key: "راز", content: "مال من است" },
      actor: actor("u1"),
    });
    expect(r1.status).toBe("ok");
    const r2 = await svc.runTool({ tool: "recall", input: {}, actor: actor("u2") });
    expect(r2.status).toBe("ok");
    expect((r2.data as { memories: unknown[] }).memories).toEqual([]);
  });

  test("the store cap is enforced through a custom provider", async () => {
    const provider = new MapMemoryProvider();
    // Fill to the cap directly (200 tool calls would be slow); the tool must
    // still refuse the 201st ADD while allowing a REPLACE.
    for (let i = 0; i < 200; i++) {
      await provider.upsert("u1", `k${i}`, `v${i}`);
    }
    const svc = new ToolService({ extraTools: createMemoryTools({ provider }) });
    const full = await svc.runTool({
      tool: "remember",
      input: { key: "k-new", content: "x" },
      actor: actor("u1"),
    });
    expect(full.status).toBe("invalid_input");
    const replace = await svc.runTool({
      tool: "remember",
      input: { key: "k0", content: "replaced" },
      actor: actor("u1"),
    });
    expect(replace.status).toBe("ok");
    expect((replace.data as { replaced: boolean }).replaced).toBe(true);
    expect((replace.data as { total: number }).total).toBe(200);
  });
});

describe("SqliteMemoryProvider parity with the old storage behavior", () => {
  test("upsert/get/list/delete/count match Storage method-for-method", () => {
    const storage = Storage.open(":memory:");
    try {
      const p = new SqliteMemoryProvider(storage);

      p.upsert("u1", "a", "اول");
      p.upsert("u1", "b", "دوم");
      p.upsert("u1", "a", "اول-جدید");
      p.upsert("u2", "a", "دیگری");

      // get: same row the storage layer returns (worker-2: importance included).
      expect(p.get("u1", "a")).toEqual({
        key: "a",
        content: "اول-جدید",
        createdAt: storage.getMemory("u1", "a")!.createdAt,
        updatedAt: storage.getMemory("u1", "a")!.updatedAt,
        importance: 3,
      });
      expect(p.get("u1", "missing")).toBeUndefined();
      // Another user's key with the same name is a different row.
      expect(p.get("u2", "a")?.content).toBe("دیگری");

      // list: same order (newest first), same length cap behavior.
      const viaProvider = p.list("u1");
      const viaStorage = storage.listMemories("u1");
      expect(viaProvider.map((m) => [m.key, m.content])).toEqual(
        viaStorage.map((m) => [m.key, m.content]),
      );
      expect(p.list("u1", 1).length).toBe(1);

      // count.
      expect(p.count("u1")).toBe(storage.countMemories("u1"));
      expect(p.count("u1")).toBe(2);
      expect(p.count("nobody")).toBe(0);

      // delete: true once, then false; the row is gone from storage too.
      expect(p.delete("u1", "b")).toBe(true);
      expect(p.delete("u1", "b")).toBe(false);
      expect(storage.getMemory("u1", "b")).toBeUndefined();
      expect(p.count("u1")).toBe(1);
    } finally {
      storage.close();
    }
  });
});
