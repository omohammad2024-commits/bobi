/**
 * Worker-2: better memory — Persian normalization, query expansion,
 * recency/importance weighting, retrieval dedup, prune planning, and the
 * importance write path.
 *
 * All pure-function tests use fixed timestamps (no Date.now()), so they are
 * fully deterministic.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { SqliteMemoryProvider } from "../src/memory/sqlite_provider";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";
import { createMemoryTools } from "../src/tools/memory";
import {
  normalizeMemoryText,
  expandQueryVariants,
  tokenJaccard,
  DEFAULT_MEMORY_IMPORTANCE,
  memoryImportance,
  recencyImportanceScore,
  rankByRecencyImportance,
  RECENCY_IMPORTANCE_BOOST,
  boostByRecencyImportance,
  reciprocalRankFusionWithScores,
  dedupeNearIdentical,
  oneLineSummary,
  buildPrunePlan,
} from "../src/memory";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed "now" for deterministic tests

// ---------------------------------------------------------------------------
// Persian normalization
// ---------------------------------------------------------------------------

describe("normalizeMemoryText", () => {
  test("unifies Arabic ي/ك with Persian ی/ک", () => {
    expect(normalizeMemoryText("علي ميگويد")).toBe("علی میگوید");
  });

  test("strips tashkeel and the hamza-above", () => {
    expect(normalizeMemoryText("دربارهٔ مُهم")).toBe("درباره مهم");
  });

  test("turns half-spaces into spaces and maps digits to Latin", () => {
    expect(normalizeMemoryText("مي‌روم ساعت ۹")).toBe("می روم ساعت 9");
  });

  test("strips kashida", () => {
    expect(normalizeMemoryText("ســلام")).toBe("سلام");
  });

  test("is identity on plain ASCII", () => {
    expect(normalizeMemoryText("a fluffy cat")).toBe("a fluffy cat");
  });
});

describe("expandQueryVariants", () => {
  test("raw + normalized + spaceless variants", () => {
    expect(expandQueryVariants("می‌روم")).toEqual(["می‌روم", "می روم", "میروم"]);
  });

  test("no dupes when normalization is identity", () => {
    expect(expandQueryVariants("cat")).toEqual(["cat"]);
  });

  test("an Arabic-script query expands to the Persian form", () => {
    const v = expandQueryVariants("علي");
    expect(v).toContain("علی");
  });

  test("empty query → no variants", () => {
    expect(expandQueryVariants("   ")).toEqual([]);
  });
});

describe("tokenJaccard", () => {
  test("identical texts score 1, disjoint score 0", () => {
    expect(tokenJaccard("a b c", "a b c")).toBe(1);
    expect(tokenJaccard("a b", "c d")).toBe(0);
    expect(tokenJaccard("", "a")).toBe(0);
  });

  test("normalizes Persian before comparing", () => {
    expect(tokenJaccard("علي", "علی")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Recency + importance
// ---------------------------------------------------------------------------

describe("memoryImportance", () => {
  test("defaults to 3, clamps into 1-5", () => {
    expect(DEFAULT_MEMORY_IMPORTANCE).toBe(3);
    expect(memoryImportance({})).toBe(3);
    expect(memoryImportance({ importance: null })).toBe(3);
    expect(memoryImportance({ importance: 5 })).toBe(5);
    expect(memoryImportance({ importance: 99 })).toBe(5);
    expect(memoryImportance({ importance: 0 })).toBe(1);
    expect(memoryImportance({ importance: NaN })).toBe(3);
  });
});

describe("recencyImportanceScore", () => {
  test("importance dominates: ancient 5 beats fresh 3", () => {
    const fresh3 = recencyImportanceScore({ importance: 3, updatedAt: NOW }, NOW);
    const ancient5 = recencyImportanceScore(
      { importance: 5, updatedAt: NOW - 365 * DAY_MS },
      NOW,
    );
    expect(ancient5).toBeGreaterThan(fresh3);
  });

  test("recency breaks near-ties: fresh trivial beats ancient trivial", () => {
    const fresh = recencyImportanceScore({ importance: 1, updatedAt: NOW }, NOW);
    const old = recencyImportanceScore(
      { importance: 1, updatedAt: NOW - 365 * DAY_MS },
      NOW,
    );
    expect(fresh).toBeGreaterThan(old);
  });

  test("the recency bonus lives in (0, 1]", () => {
    const s = recencyImportanceScore({ importance: 3, updatedAt: NOW }, NOW);
    expect(s).toBeGreaterThan(3);
    expect(s).toBeLessThanOrEqual(4);
  });
});

describe("rankByRecencyImportance", () => {
  test("important first, then recent; ties break by key", () => {
    const mems = [
      { key: "old-trivial", importance: 1, updatedAt: NOW - 100_000 },
      { key: "new-trivial", importance: 1, updatedAt: NOW },
      { key: "mid", importance: 3, updatedAt: NOW - 50_000 },
      { key: "vip", importance: 5, updatedAt: NOW - 100_000 },
      { key: "b-tie", importance: 3, updatedAt: NOW - 50_000 },
      { key: "a-tie", importance: 3, updatedAt: NOW - 50_000 },
    ];
    expect(rankByRecencyImportance(mems, NOW)).toEqual([
      "vip",
      "a-tie",
      "b-tie",
      "mid",
      "new-trivial",
      "old-trivial",
    ]);
  });
});

describe("boostByRecencyImportance", () => {
  test("a fresh importance-5 memory outranks an older coincidental match one rank up", () => {
    // old: text rank 0 only (1/61); new: text rank 1 only (1/62).
    const fused = reciprocalRankFusionWithScores([["old", "new"]], 10);
    const mems = [
      { key: "old", importance: 1, updatedAt: NOW - 365 * DAY_MS },
      { key: "new", importance: 5, updatedAt: NOW },
    ];
    const boosted = boostByRecencyImportance(fused, mems, NOW);
    expect(boosted[0]!.key).toBe("new");
    expect(boosted[1]!.key).toBe("old");
  });

  test("the boost is bounded: a dual-signal match still beats a merely recent one", () => {
    // old matches text rank 0 AND semantic rank 0; new matches text rank 1.
    const fused = reciprocalRankFusionWithScores(
      [
        ["old", "new"],
        ["old"],
      ],
      10,
    );
    const mems = [
      { key: "old", importance: 1, updatedAt: NOW - 365 * DAY_MS },
      { key: "new", importance: 5, updatedAt: NOW },
    ];
    const boosted = boostByRecencyImportance(fused, mems, NOW);
    expect(boosted[0]!.key).toBe("old");
  });

  test("equal importance/recency keeps the fused order (existing tests stay green)", () => {
    const fused = reciprocalRankFusionWithScores(
      [
        ["dog"],
        ["dog", "catalog", "cat"],
      ],
      10,
    );
    const mems = ["dog", "catalog", "cat"].map((key) => ({
      key,
      importance: 3,
      updatedAt: NOW,
    }));
    expect(boostByRecencyImportance(fused, mems, NOW).map((f) => f.key)).toEqual([
      "dog",
      "catalog",
      "cat",
    ]);
  });

  test("RECENCY_IMPORTANCE_BOOST is the documented 0.05", () => {
    expect(RECENCY_IMPORTANCE_BOOST).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// Retrieval-time dedup
// ---------------------------------------------------------------------------

describe("dedupeNearIdentical", () => {
  const mem = (
    key: string,
    content: string,
    importance = 3,
    updatedAt = 1000,
  ) => ({ key, content, importance, updatedAt });

  test("exact normalized-content dupes collapse, keeping the important one", () => {
    const out = dedupeNearIdentical([
      mem("a", "دوست دارم قهوه", 3, 2000),
      mem("b", "دوست دارم قهوه", 5, 1000),
    ]);
    expect(out.map((m) => m.key)).toEqual(["b"]);
  });

  test("Arabic-script variants of the same fact collapse", () => {
    const out = dedupeNearIdentical([mem("a", "علي"), mem("b", "علی")]);
    expect(out).toHaveLength(1);
  });

  test("near-identical token sets (one token different in twenty) collapse", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
    const out = dedupeNearIdentical([
      mem("a", words.join(" ")),
      mem("b", [...words.slice(0, 19), "other"].join(" ")),
    ]);
    // 19/21 ≈ 0.905 ≥ 0.9 → dupes.
    expect(out.map((m) => m.key)).toEqual(["a"]);
  });

  test("distinct memories survive, order preserved", () => {
    const out = dedupeNearIdentical([
      mem("a", "alpha beta gamma delta"),
      mem("b", "one two three four"),
      mem("c", "something else entirely here"),
    ]);
    expect(out.map((m) => m.key)).toEqual(["a", "b", "c"]);
  });

  test("newer wins when importance ties", () => {
    const out = dedupeNearIdentical([
      mem("a", "same text", 3, 1000),
      mem("b", "same text", 3, 2000),
    ]);
    expect(out.map((m) => m.key)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// Prune planning
// ---------------------------------------------------------------------------

describe("oneLineSummary", () => {
  test("first line, whitespace-collapsed", () => {
    expect(oneLineSummary("line one\nline two")).toBe("line one");
    expect(oneLineSummary("  spaced   out  ")).toBe("spaced out");
  });

  test("long content is truncated with an ellipsis", () => {
    const s = oneLineSummary("x".repeat(200));
    expect(s.length).toBeLessThanOrEqual(140);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("buildPrunePlan", () => {
  const mem = (
    key: string,
    content: string,
    importance: number,
    ageDays: number,
  ) => ({ key, content, importance, updatedAt: NOW - ageDays * DAY_MS });

  test("old trivial memories drop; important/recent/neutral are kept", () => {
    const mems = [
      mem("old-trivial", "x", 1, 100),
      mem("old-vip", "y", 5, 100),
      mem("new-trivial", "z", 1, 10),
      mem("old-neutral", "w", 3, 100),
    ];
    const plan = buildPrunePlan(mems, NOW);
    expect(plan.drop.map((d) => d.key)).toEqual(["old-trivial"]);
    expect(plan.kept).toBe(3);
    expect(plan.drop[0]!.summary).toBe("x");
    expect(plan.drop[0]!.ageDays).toBe(100);
  });

  test("drops go worst-first and maxDrops bounds the run", () => {
    const mems = [
      mem("worst", "a", 1, 400),
      mem("bad", "b", 2, 200),
      mem("less-bad", "c", 2, 100),
    ];
    const plan = buildPrunePlan(mems, NOW, { maxDrops: 2 });
    expect(plan.drop.map((d) => d.key)).toEqual(["worst", "bad"]);
    expect(plan.kept).toBe(1);
  });

  test("options tune the policy", () => {
    const mems = [mem("m", "x", 2, 100)];
    expect(buildPrunePlan(mems, NOW).drop).toHaveLength(1);
    expect(buildPrunePlan(mems, NOW, { minAgeDays: 200 }).drop).toHaveLength(0);
    expect(
      buildPrunePlan(mems, NOW, { maxTrivialImportance: 1 }).drop,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Importance write path: remember → sqlite → recall
// ---------------------------------------------------------------------------

function actor(userId: string): ToolActor {
  return {
    userId,
    permissions: ["tools:remember", "tools:recall", "tools:forget"],
  };
}

describe("importance persistence (sqlite provider)", () => {
  test("upsert stores importance; omitted keeps the old one; default is 3", () => {
    const storage = Storage.open(":memory:");
    const provider = new SqliteMemoryProvider(storage);
    provider.upsert("u1", "a", "content a");
    expect(provider.get("u1", "a")?.importance).toBe(3);
    provider.upsert("u1", "a", "content a2", { importance: 5 });
    expect(provider.get("u1", "a")?.importance).toBe(5);
    provider.upsert("u1", "a", "content a3");
    expect(provider.get("u1", "a")?.importance).toBe(5);
    expect(provider.get("u1", "a")?.content).toBe("content a3");
    expect(provider.list("u1")[0]?.importance).toBe(5);
    storage.close();
  });

  test("pruneMemories summarizes in place: content replaced, importance reset", () => {
    const storage = Storage.open(":memory:");
    const provider = new SqliteMemoryProvider(storage);
    provider.upsert("u1", "old", "line one\nline two", { importance: 1 });
    const n = provider.pruneMemories("u1", [{ key: "old", summary: "line one" }]);
    expect(n).toBe(1);
    const row = provider.get("u1", "old")!;
    expect(row.content).toBe("line one");
    expect(row.importance).toBe(1);
    // Unknown keys are no-ops, not errors.
    expect(provider.pruneMemories("u1", [{ key: "nope", summary: "x" }])).toBe(0);
    storage.close();
  });
});

describe("remember/recall with importance", () => {
  function harness() {
    const storage = Storage.open(":memory:");
    const provider = new SqliteMemoryProvider(storage);
    const svc = new ToolService({
      extraTools: createMemoryTools({ provider }),
    });
    return { storage, svc };
  }

  test("remember accepts importance and reports it back", async () => {
    const { storage, svc } = harness();
    const r = await svc.runTool({
      tool: "remember",
      input: { key: "نام", content: "محمد", importance: 5 },
      actor: actor("u1"),
    });
    expect(r.status).toBe("ok");
    expect((r.data as { importance: number }).importance).toBe(5);
    expect(storage.getMemory("u1", "نام")?.importance).toBe(5);
    storage.close();
  });

  test("remember without importance defaults to 3", async () => {
    const { storage, svc } = harness();
    const r = await svc.runTool({
      tool: "remember",
      input: { key: "k", content: "v" },
      actor: actor("u1"),
    });
    expect((r.data as { importance: number }).importance).toBe(3);
    storage.close();
  });

  test("recall returns importance with each memory", async () => {
    const { storage, svc } = harness();
    await svc.runTool({
      tool: "remember",
      input: { key: "vip", content: "very important thing", importance: 5 },
      actor: actor("u1"),
    });
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "important" },
      actor: actor("u1"),
    });
    const data = r.data as {
      memories: Array<{ key: string; importance: number }>;
      searchMode: string;
    };
    expect(data.searchMode).toBe("text");
    expect(data.memories[0]).toMatchObject({ key: "vip", importance: 5 });
    storage.close();
  });

  test("an Arabic-script query matches Persian-script memories (query expansion)", async () => {
    const { storage, svc } = harness();
    await svc.runTool({
      tool: "remember",
      input: { key: "نام", content: "علی" },
      actor: actor("u1"),
    });
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "علي" }, // Arabic ي
      actor: actor("u1"),
    });
    const data = r.data as { memories: Array<{ key: string }> };
    expect(data.memories.map((m) => m.key)).toEqual(["نام"]);
    storage.close();
  });

  test("half-space variants match (می‌روم finds میروم)", async () => {
    const { storage, svc } = harness();
    await svc.runTool({
      tool: "remember",
      input: { key: "فعل", content: "میروم" },
      actor: actor("u1"),
    });
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "می‌روم" },
      actor: actor("u1"),
    });
    const data = r.data as { memories: Array<{ key: string }> };
    expect(data.memories.map((m) => m.key)).toEqual(["فعل"]);
    storage.close();
  });

  test("near-duplicate memories surface once at retrieval", async () => {
    const { storage, svc } = harness();
    await svc.runTool({
      tool: "remember",
      input: { key: "a", content: "دوست دارم قهوه" },
      actor: actor("u1"),
    });
    await svc.runTool({
      tool: "remember",
      input: { key: "b", content: "دوست دارم قهوه" },
      actor: actor("u1"),
    });
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "قهوه" },
      actor: actor("u1"),
    });
    const data = r.data as { memories: Array<{ key: string }>; total: number };
    expect(data.memories).toHaveLength(1);
    expect(data.total).toBe(2); // total still reports the real count
    storage.close();
  });
});
