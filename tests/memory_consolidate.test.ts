/**
 * Memory consolidation pass (memory-core upgrade).
 *
 * Pins the sweep's contract on a seeded store:
 *  - near-duplicate clusters merge into the earliest-created row, keeping
 *    the richer text, the summed (capped) importance and the earliest
 *    createdAt;
 *  - stale unpinned memories decay one step per run, pinned (≥4) ones
 *    never do, and the floor holds at 1;
 *  - promotion is a pure function of recallCount, so a second run is a
 *    no-op (idempotency) — as are merges and prunes;
 *  - the prune step reuses the store's summarize-then-drop policy;
 *  - BOBI_MEMORY_CONSOLIDATE=0 short-circuits everything.
 */
import { describe, expect, test } from "bun:test";
import type {
  MemoryProvider,
  MemoryPruneDrop,
  MemoryUpsertOptions,
  StoredMemory,
} from "../src/memory/provider";
import {
  consolidateMemories,
  promotionTarget,
  type ConsolidationMemory,
} from "../src/memory/consolidate";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** Map provider mirroring SqliteMemoryProvider semantics (createdAt kept). */
class SeedProvider implements MemoryProvider {
  readonly name = "seed";
  rows = new Map<string, ConsolidationMemory & { userId: string }>();
  /** Settable clock: upserts stamp updatedAt from here, like the real store. */
  now = NOW;

  seed(userId: string, m: ConsolidationMemory): void {
    this.rows.set(`${userId}${m.key}`, { ...m, userId });
  }

  upsert(userId: string, key: string, content: string, opts?: MemoryUpsertOptions): void {
    const id = `${userId}${key}`;
    const prev = this.rows.get(id);
    this.rows.set(id, {
      userId,
      key,
      content,
      createdAt: prev?.createdAt ?? this.now,
      updatedAt: this.now,
      importance: opts?.importance ?? prev?.importance ?? 3,
      ...(prev?.recallCount !== undefined ? { recallCount: prev.recallCount } : {}),
    });
  }

  get(userId: string, key: string): StoredMemory | undefined {
    return this.rows.get(`${userId}${key}`);
  }

  list(userId: string, limit = 50): ConsolidationMemory[] {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  delete(userId: string, key: string): boolean {
    return this.rows.delete(`${userId}${key}`);
  }

  count(userId: string): number {
    return this.list(userId, 1000).length;
  }

  pruneMemories(userId: string, drops: ReadonlyArray<MemoryPruneDrop>): number {
    let n = 0;
    for (const d of drops) {
      const id = `${userId}${d.key}`;
      const prev = this.rows.get(id);
      if (prev === undefined) continue;
      this.rows.set(id, { ...prev, content: d.summary, importance: 1, updatedAt: this.now });
      n += 1;
    }
    return n;
  }
}

function mem(
  key: string,
  content: string,
  over: Partial<ConsolidationMemory> = {},
): ConsolidationMemory {
  return {
    key,
    content,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY,
    importance: 3,
    ...over,
  };
}

describe("consolidation: merge", () => {
  test("near-duplicates merge into earliest row; richer text, summed importance, earliest createdAt", async () => {
    const p = new SeedProvider();
    const older = mem("a", "علی کتاب علمی تخیلی را خیلی زیاد دوست دارد و می خواند", {
      createdAt: NOW - 50 * DAY,
      updatedAt: NOW - 40 * DAY,
      importance: 2,
    });
    const newer = mem("b", "علی کتاب علمی تخیلی را خیلی زیاد دوست دارد می خواند", {
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW - 20 * DAY,
      importance: 3,
    });
    p.seed("u", older);
    p.seed("u", newer);
    p.seed("u", mem("c", "موضوع کاملا متفاوت درباره باغبانی شهری"));

    const r = await consolidateMemories(p, "u", { nowMs: NOW, prune: false });
    expect(r.merged).toBe(1);
    const survivor = p.get("u", "a");
    expect(survivor).toBeDefined();
    // earliest row's key survives, with the earliest createdAt untouched
    expect(survivor!.createdAt).toBe(NOW - 50 * DAY);
    // richer text = the longer (more complete) statement
    expect(survivor!.content).toBe("علی کتاب علمی تخیلی را خیلی زیاد دوست دارد و می خواند");
    // summed importance: round(5 * min(1, 2/5 + 3/5)) = 5
    expect(survivor!.importance).toBe(5);
    expect(p.get("u", "b")).toBeUndefined();
  });

  test("distinct memories are not merged", async () => {
    const p = new SeedProvider();
    p.seed("u", mem("a", "علی چای سبز دوست دارد"));
    p.seed("u", mem("b", "مریم قایقرانی در شمال را ترجیح می دهد"));
    const r = await consolidateMemories(p, "u", { nowMs: NOW, prune: false });
    expect(r.merged).toBe(0);
    expect(p.count("u")).toBe(2);
  });
});

describe("consolidation: decay + promote", () => {
  test("stale unpinned decays one step; pinned (≥4) never decays; floor is 1", async () => {
    const p = new SeedProvider();
    p.seed("u", mem("stale", "حقیقت قدیمی کم اهمیت", {
      updatedAt: NOW - 120 * DAY,
      importance: 3,
    }));
    p.seed("u", mem("pinned", "نام کاربر علی است", {
      updatedAt: NOW - 300 * DAY,
      importance: 5,
    }));
    p.seed("u", mem("fresh", "حقیقت تازه", { updatedAt: NOW - 2 * DAY, importance: 2 }));

    const r = await consolidateMemories(p, "u", { nowMs: NOW, prune: false });
    expect(r.decayed).toBe(1);
    expect(p.get("u", "stale")!.importance).toBe(2);
    expect(p.get("u", "pinned")!.importance).toBe(5);
    expect(p.get("u", "fresh")!.importance).toBe(2);
  });

  test("promotionTarget is a pure recallCount function", () => {
    expect(promotionTarget(undefined)).toBe(0);
    expect(promotionTarget(2)).toBe(0);
    expect(promotionTarget(3)).toBe(3);
    expect(promotionTarget(6)).toBe(4);
    expect(promotionTarget(9)).toBe(5);
    expect(promotionTarget(100)).toBe(5);
  });

  test("frequently recalled memory promotes; second run is a no-op (idempotent)", async () => {
    const p = new SeedProvider();
    p.seed("u", mem("hot", "حقیقت پرکاربرد", { importance: 2, recallCount: 6 }));
    const r1 = await consolidateMemories(p, "u", { nowMs: NOW, prune: false });
    expect(r1.promoted).toBe(1);
    expect(p.get("u", "hot")!.importance).toBe(4);
    const r2 = await consolidateMemories(p, "u", { nowMs: NOW, prune: false });
    expect(r2.promoted).toBe(0);
    expect(r2.merged).toBe(0);
    expect(p.get("u", "hot")!.importance).toBe(4);
  });

  test("full idempotency: second run changes nothing beyond one decay step", async () => {
    const p = new SeedProvider();
    p.seed("u", mem("a", "علی کتاب علمی تخیلی را خیلی زیاد دوست دارد و می خواند", { importance: 2 }));
    p.seed("u", mem("b", "علی کتاب علمی تخیلی را خیلی زیاد دوست دارد می خواند", { importance: 3 }));
    p.seed("u", mem("stale", "حقیقت قدیمی", {
      updatedAt: NOW - 120 * DAY,
      importance: 3,
    }));
    await consolidateMemories(p, "u", { nowMs: NOW, prune: false });
    const afterFirst = JSON.stringify(
      [...p.rows.values()].map((r) => [r.key, r.content, r.importance]).sort(),
    );
    const r2 = await consolidateMemories(p, "u", { nowMs: NOW, prune: false });
    expect(r2.merged).toBe(0);
    expect(r2.promoted).toBe(0);
    // decay re-armed by the upsert clock: the stale row now reads fresh,
    // so even decay does not fire again at the same nowMs.
    expect(r2.decayed).toBe(0);
    const afterSecond = JSON.stringify(
      [...p.rows.values()].map((r) => [r.key, r.content, r.importance]).sort(),
    );
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("consolidation: prune + kill switch", () => {
  test("old trivial memories are summarized-then-dropped via the provider", async () => {
    const p = new SeedProvider();
    p.seed("u", mem("trivia", "یه نکته بی اهمیت و خیلی طولانی که فقط خط اولش می ماند و بقیه اش حذف می شود چون قدیمی و کم ارزش است", {
      updatedAt: NOW - 200 * DAY,
      importance: 1,
    }));
    const r = await consolidateMemories(p, "u", { nowMs: NOW });
    expect(r.pruned).toBe(1);
    expect(p.get("u", "trivia")!.importance).toBe(1);
  });

  test("BOBI_MEMORY_CONSOLIDATE=0 disables the pass", async () => {
    const prev = process.env.BOBI_MEMORY_CONSOLIDATE;
    process.env.BOBI_MEMORY_CONSOLIDATE = "0";
    try {
      const p = new SeedProvider();
      p.seed("u", mem("a", "علی کتاب دوست دارد", { updatedAt: NOW - 200 * DAY }));
      const r = await consolidateMemories(p, "u", { nowMs: NOW });
      expect(r.disabled).toBe(true);
      expect(r.merged + r.decayed + r.promoted + r.pruned).toBe(0);
      expect(p.get("u", "a")!.importance).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.BOBI_MEMORY_CONSOLIDATE;
      else process.env.BOBI_MEMORY_CONSOLIDATE = prev;
    }
  });
});
