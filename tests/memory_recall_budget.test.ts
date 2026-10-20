/**
 * Proactive recall: turn-path semantic budget (R4 / M10).
 *
 * Pins the deadline behavior of recallFor's semantic leg:
 *  - a hanging semantic search cannot stall the turn past the budget,
 *    and the text-ranked results come back intact;
 *  - a semantic answer inside the budget still joins the fusion (a
 *    semantic-only key can surface);
 *  - a STRONG text hit (a query topic in a memory KEY) skips the
 *    semantic leg entirely; weak / no text hits still call it;
 *  - budget 0 (deps override or BOBI_MEMORY_SEMANTIC_BUDGET_MS=0) is
 *    text-only: semantic is never called;
 *  - a semantic rejection that lands AFTER the deadline is handled —
 *    no unhandled rejection, recall still returns.
 *
 * Hermetic: the semantic ranker is a hand-rolled stub/spy; no network.
 */
import { describe, expect, test } from "bun:test";
import type {
  MemoryProvider,
  MemoryUpsertOptions,
  StoredMemory,
} from "../src/memory/provider";
import {
  DEFAULT_SEMANTIC_BUDGET_MS,
  recallFor,
  semanticBudgetMsFor,
} from "../src/memory/proactive_recall";

const NOW = 1_800_000_000_000;
const BUDGET_ENV = "BOBI_MEMORY_SEMANTIC_BUDGET_MS";

class MapProvider implements MemoryProvider {
  readonly name = "map";
  rows = new Map<string, StoredMemory>();
  now = NOW;

  upsert(userId: string, key: string, content: string, opts?: MemoryUpsertOptions): void {
    const id = `${userId}${key}`;
    const prev = this.rows.get(id);
    this.rows.set(id, {
      key,
      content,
      createdAt: prev?.createdAt ?? this.now,
      updatedAt: this.now,
      importance: opts?.importance ?? prev?.importance ?? 3,
    });
  }
  get(userId: string, key: string): StoredMemory | undefined {
    return this.rows.get(`${userId}${key}`);
  }
  list(userId: string, limit = 50): StoredMemory[] {
    return [...this.rows.entries()]
      .filter(([id]) => id.startsWith(`${userId}`))
      .map(([, r]) => r)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }
  delete(userId: string, key: string): boolean {
    return this.rows.delete(`${userId}${key}`);
  }
  count(userId: string): number {
    return this.list(userId, 1000).length;
  }
}

/**
 * Weak text hit only: the query topics ("quixotic", "hobby") appear in
 * the CONTENT of note:alpha, never in any key — so the semantic leg
 * must run (no strong-hit skip).
 */
function seedWeak(provider: MapProvider): void {
  provider.upsert("u", "note:alpha", "quixotic hobby notes about chess and long walks", {
    importance: 5,
  });
  provider.upsert("u", "note:beta", "completely different subject cooking rice slowly", {
    importance: 1,
  });
}

/** Strong text hit: the query topic "quixotic" appears in a memory KEY. */
function seedStrong(provider: MapProvider): void {
  provider.upsert("u", "note:quixotic", "some stored detail about weekend trains", {
    importance: 5,
  });
  provider.upsert("u", "note:beta", "completely different subject cooking rice slowly", {
    importance: 1,
  });
}

type SemanticImpl = () => Promise<Array<{ key: string }> | undefined>;

function spySemantic(impl: SemanticImpl) {
  const calls: Array<{ userId: string; query: string; limit: number }> = [];
  const semantic = {
    search(userId: string, query: string, limit: number) {
      calls.push({ userId, query, limit });
      return impl();
    },
  };
  return { semantic, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[BUDGET_ENV];
  if (value === undefined) delete process.env[BUDGET_ENV];
  else process.env[BUDGET_ENV] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[BUDGET_ENV];
    else process.env[BUDGET_ENV] = prev;
  }
}

describe("semantic budget: deadline", () => {
  test("(a) hanging semantic search resolves within ~budget, text results intact", async () => {
    const p = new MapProvider();
    seedWeak(p);
    const { semantic, calls } = spySemantic(() => new Promise(() => {}));
    const started = Date.now();
    const hits = await recallFor(
      { provider: p, nowMs: NOW, semantic, semanticBudgetMs: 30 },
      "u",
      "quixotic hobby",
    );
    const elapsed = Date.now() - started;
    expect(calls).toHaveLength(1);
    expect(elapsed).toBeLessThan(1000);
    expect(hits.map((h) => h.key)).toContain("note:alpha");
  });

  test("(b) semantic answering inside the budget contributes a semantic-only key", async () => {
    const p = new MapProvider();
    seedWeak(p);
    p.upsert("u", "note:zebra", "striped animal facts from the savanna region", {
      importance: 5,
    });
    const { semantic, calls } = spySemantic(async () => [{ key: "note:zebra" }]);
    const hits = await recallFor(
      { provider: p, nowMs: NOW, semantic, semanticBudgetMs: 1000 },
      "u",
      "quixotic hobby",
    );
    expect(calls).toHaveLength(1);
    const keys = hits.map((h) => h.key);
    // The text-ranked hit AND the key only the semantic list supplied.
    expect(keys).toContain("note:alpha");
    expect(keys).toContain("note:zebra");
  });

  test("(e) semantic rejecting after the deadline: no unhandled rejection, recall returns", async () => {
    const p = new MapProvider();
    seedWeak(p);
    const { semantic } = spySemantic(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("embed exploded late")), 60);
        }),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const hits = await recallFor(
        { provider: p, nowMs: NOW, semantic, semanticBudgetMs: 30 },
        "u",
        "quixotic hobby",
      );
      expect(hits.map((h) => h.key)).toContain("note:alpha");
      // Let the late rejection land; it must be silently handled.
      await sleep(150);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("semantic rejecting inside the budget degrades to text-only, never throws", async () => {
    const p = new MapProvider();
    seedWeak(p);
    const { semantic } = spySemantic(async () => {
      throw new Error("embed down");
    });
    const hits = await recallFor(
      { provider: p, nowMs: NOW, semantic, semanticBudgetMs: 1000 },
      "u",
      "quixotic hobby",
    );
    expect(hits.map((h) => h.key)).toContain("note:alpha");
  });
});

describe("semantic budget: strong-text skip", () => {
  test("(c) strong text hit (topic in a memory key) → semantic NOT called", async () => {
    const p = new MapProvider();
    seedStrong(p);
    const { semantic, calls } = spySemantic(async () => [{ key: "note:beta" }]);
    const hits = await recallFor(
      { provider: p, nowMs: NOW, semantic, semanticBudgetMs: 1000 },
      "u",
      "quixotic",
    );
    expect(calls).toHaveLength(0);
    expect(hits.map((h) => h.key)).toContain("note:quixotic");
  });

  test("(c) weak text hit (content only) → semantic IS called", async () => {
    const p = new MapProvider();
    seedWeak(p);
    const { semantic, calls } = spySemantic(async () => undefined);
    const hits = await recallFor(
      { provider: p, nowMs: NOW, semantic, semanticBudgetMs: 1000 },
      "u",
      "quixotic hobby",
    );
    expect(calls).toHaveLength(1);
    expect(hits.map((h) => h.key)).toContain("note:alpha");
  });

  test("(c) no text hits at all → semantic IS called", async () => {
    const p = new MapProvider();
    seedWeak(p);
    const { semantic, calls } = spySemantic(async () => undefined);
    const hits = await recallFor(
      { provider: p, nowMs: NOW, semantic, semanticBudgetMs: 1000 },
      "u",
      "unmatched zeppelin voyage",
    );
    expect(calls).toHaveLength(1);
    expect(hits).toEqual([]);
  });
});

describe("semantic budget: zero budget and resolution", () => {
  test("(d) semanticBudgetMs 0 → text-only, semantic not called", async () => {
    const p = new MapProvider();
    seedWeak(p);
    const { semantic, calls } = spySemantic(async () => [{ key: "note:beta" }]);
    const hits = await recallFor(
      { provider: p, nowMs: NOW, semantic, semanticBudgetMs: 0 },
      "u",
      "quixotic hobby",
    );
    expect(calls).toHaveLength(0);
    expect(hits.map((h) => h.key)).toContain("note:alpha");
  });

  test("(d) BOBI_MEMORY_SEMANTIC_BUDGET_MS=0 → text-only, semantic not called", async () => {
    await withEnv("0", async () => {
      const p = new MapProvider();
      seedWeak(p);
      const { semantic, calls } = spySemantic(async () => [{ key: "note:beta" }]);
      const hits = await recallFor(
        { provider: p, nowMs: NOW, semantic },
        "u",
        "quixotic hobby",
      );
      expect(calls).toHaveLength(0);
      expect(hits.map((h) => h.key)).toContain("note:alpha");
    });
  });

  test("budget resolution: default, env, deps override, invalid → default", async () => {
    await withEnv(undefined, () => {
      expect(semanticBudgetMsFor({})).toBe(DEFAULT_SEMANTIC_BUDGET_MS);
      expect(DEFAULT_SEMANTIC_BUDGET_MS).toBe(2000);
    });
    await withEnv("250", () => {
      expect(semanticBudgetMsFor({})).toBe(250);
      // The deps override wins over the env.
      expect(semanticBudgetMsFor({ semanticBudgetMs: 30 })).toBe(30);
      expect(semanticBudgetMsFor({ semanticBudgetMs: 0 })).toBe(0);
    });
    await withEnv("bogus", () => {
      expect(semanticBudgetMsFor({})).toBe(DEFAULT_SEMANTIC_BUDGET_MS);
    });
    await withEnv("-5", () => {
      expect(semanticBudgetMsFor({})).toBe(DEFAULT_SEMANTIC_BUDGET_MS);
    });
    await withEnv("250", () => {
      expect(semanticBudgetMsFor({ semanticBudgetMs: -1 })).toBe(
        DEFAULT_SEMANTIC_BUDGET_MS,
      );
    });
  });
});
