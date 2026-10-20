/**
 * Proactive recall (memory-core upgrade).
 *
 * Pins the behavior contract:
 *  - a Persian message about a stored fact surfaces it (normalization
 *    catches Arabic ي/ك and ZWNJ variants);
 *  - an unrelated message surfaces nothing;
 *  - the BOBI_MEMORY_RECALL_FLOOR env moves the threshold (very high ⇒ []);
 *  - BOBI_MEMORY_PROACTIVE_RECALL=0 ⇒ always [];
 *  - recency alone never qualifies a memory (relevance gate).
 */
import { describe, expect, test } from "bun:test";
import type {
  MemoryProvider,
  MemoryUpsertOptions,
  StoredMemory,
} from "../src/memory/provider";
import {
  extractQueryTopics,
  recallFor,
} from "../src/memory/proactive_recall";

const NOW = 1_800_000_000_000;

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

function seed(provider: MapProvider): void {
  provider.upsert("u", "fact:preference:abc1234", "علی کتاب علمی تخیلی دوست دارد", {
    importance: 5,
  });
  provider.upsert("u", "fact:commitment:def5678", "شنبه ساعت ده جلسه با تیم محصول", {
    importance: 4,
  });
  provider.upsert("u", "note:x", "دیروز هوا بارانی بود", { importance: 1 });
}

describe("proactive recall: topic surfacing", () => {
  test("a Persian message about a stored fact surfaces it", async () => {
    const p = new MapProvider();
    seed(p);
    const hits = await recallFor({ provider: p, nowMs: NOW }, "u", "یادته علی چه کتابی دوست داشت؟");
    const keys = hits.map((h) => h.key);
    expect(keys).toContain("fact:preference:abc1234");
    expect(hits[0]!.importance).toBe(5);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0.025);
  });

  test("Arabic-letter/ZWNJ variants of the query still match", async () => {
    const p = new MapProvider();
    seed(p);
    // «کتابي» with Arabic ي and a half-spaced «مي‌خواند»-style token
    const hits = await recallFor(
      { provider: p, nowMs: NOW },
      "u",
      "علی به چه كتابي علاقه داره؟",
    );
    expect(hits.map((h) => h.key)).toContain("fact:preference:abc1234");
  });

  test("an unrelated message surfaces nothing", async () => {
    const p = new MapProvider();
    seed(p);
    const hits = await recallFor({ provider: p, nowMs: NOW }, "u", "قیمت دلار امروز چنده؟");
    expect(hits).toEqual([]);
  });

  test("recency alone never qualifies: old relevant-ranked noise is filtered by the floor", async () => {
    const p = new MapProvider();
    seed(p);
    // "کتاب" matches only the top memory; unrelated memories rank by
    // recency only and must not surface.
    const hits = await recallFor({ provider: p, nowMs: NOW }, "u", "کتاب");
    expect(hits.every((h) => h.key === "fact:preference:abc1234")).toBe(true);
  });
});

describe("proactive recall: threshold + kill switch", () => {
  test("BOBI_MEMORY_RECALL_FLOOR raises the bar (very high ⇒ [])", async () => {
    const prev = process.env.BOBI_MEMORY_RECALL_FLOOR;
    process.env.BOBI_MEMORY_RECALL_FLOOR = "0.9";
    try {
      const p = new MapProvider();
      seed(p);
      const hits = await recallFor({ provider: p, nowMs: NOW }, "u", "یادته علی چه کتابی دوست داشت؟");
      expect(hits).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.BOBI_MEMORY_RECALL_FLOOR;
      else process.env.BOBI_MEMORY_RECALL_FLOOR = prev;
    }
  });

  test("BOBI_MEMORY_PROACTIVE_RECALL=0 ⇒ always []", async () => {
    const prev = process.env.BOBI_MEMORY_PROACTIVE_RECALL;
    process.env.BOBI_MEMORY_PROACTIVE_RECALL = "0";
    try {
      const p = new MapProvider();
      seed(p);
      const hits = await recallFor({ provider: p, nowMs: NOW }, "u", "یادته علی چه کتابی دوست داشت؟");
      expect(hits).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.BOBI_MEMORY_PROACTIVE_RECALL;
      else process.env.BOBI_MEMORY_PROACTIVE_RECALL = prev;
    }
  });

  test("extractQueryTopics drops stopwords and keeps Persian entities", () => {
    const topics = extractQueryTopics("سلام! این کتاب علمی تخیلی رو به من معرفی کن");
    expect(topics).toContain("کتاب");
    expect(topics).not.toContain("این");
    expect(topics).not.toContain("به");
    expect(topics).not.toContain("من");
  });
});
