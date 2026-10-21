/**
 * Hybrid FTS+vector memory ranking (Phase 5).
 *
 * What this suite pins down:
 *
 * - RRF fusion: a document matching BOTH signals outranks single-signal
 *   matches; the fusion is deterministic (key-ascending tiebreak), honors
 *   the limit, and ignores duplicate keys inside one list.
 * - recall reports "hybrid" when both signals produce candidates,
 *   "semantic" when only the vector ranking does, and "text" when the
 *   semantic index is unavailable — never an error, never user-visible.
 * - Embedding-model tracking: each vector records its model id; a row from
 *   a different model is stale (excluded from cosine ranking) even when the
 *   dimensions match; the bounded backfill re-embeds stale rows; legacy
 *   rows without a model keep the phase-4 dimension-only rule.
 * - indexState(): the owner-visible index health (fresh/stale/missing) —
 *   the Mini App's memory endpoint exposes it as `embedding` (the field
 *   the retired web dashboard had; platform Phase 10).
 * - Kill switch: BOBI_SEMANTIC_MEMORY=0 disables everything and recall
 *   degrades to text.
 *
 * No network anywhere: embedders are canned.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import {
  reciprocalRankFusion,
  reciprocalRankFusionWithScores,
  RRF_K,
  MemoryVectorStore,
  ProviderEmbedder,
  SemanticMemorySearch,
  embedTextFor,
  // Worker-2: better recall.
  normalizeMemoryText,
  expandQueryVariants,
  tokenJaccard,
  DEFAULT_MEMORY_IMPORTANCE,
  memoryImportance,
  recencyImportanceScore,
  rankByRecencyImportance,
  RECENCY_IMPORTANCE_BOOST,
  boostByRecencyImportance,
  dedupeNearIdentical,
  oneLineSummary,
  buildPrunePlan,
} from "../src/memory";
import { SqliteMemoryProvider } from "../src/memory/sqlite_provider";
import type {
  Embedder,
  Embedding,
  MemoryIndexState,
  SemanticHit,
} from "../src/memory";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";
import { createMemoryTools } from "../src/tools/memory";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";
import { createHmac } from "node:crypto";
import { handleManageApi, type ManageApiDeps } from "../src/miniapp/api_manage";

const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of ["BOBI_SEMANTIC_MEMORY", "BOBI_EMBEDDING_MODEL"] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

// ---------------------------------------------------------------------------
// Stubs (same shape as the phase-4 suite)
// ---------------------------------------------------------------------------

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

  upsert(userId: string, key: string, content: string): void {
    const now = Date.now();
    const b = this.bucket(userId);
    const prev = b.get(key);
    b.set(key, { key, content, createdAt: prev?.createdAt ?? now, updatedAt: now });
  }

  get(userId: string, key: string): StoredMemory | undefined {
    return this.bucket(userId).get(key);
  }

  list(userId: string, limit = 50): StoredMemory[] {
    return [...this.bucket(userId).values()].slice(0, limit);
  }

  delete(userId: string, key: string): boolean {
    return this.bucket(userId).delete(key);
  }

  count(userId: string): number {
    return this.bucket(userId).size;
  }
}

/** Canned embedder that also reports a model id (phase-5 aware). */
class CannedEmbedder implements Embedder {
  readonly name = "canned";
  constructor(
    private readonly table: Record<string, Embedding>,
    private readonly fallback?: Embedding,
    private readonly model = "test-model-v1",
  ) {}

  modelId(): string {
    return this.model;
  }

  available(): boolean {
    return true;
  }

  async embedTexts(texts: readonly string[]): Promise<Embedding[] | undefined> {
    return texts.map((t) => this.table[t] ?? this.fallback ?? [0]);
  }
}

/**
 * Canned embedder with the real kill-switch contract: like
 * ProviderEmbedder, BOBI_SEMANTIC_MEMORY=0 makes it unavailable and
 * embedTexts resolve to undefined.
 */
class KillSwitchCanned extends CannedEmbedder {
  override available(): boolean {
    return process.env.BOBI_SEMANTIC_MEMORY !== "0" && super.available();
  }

  override async embedTexts(
    texts: readonly string[],
  ): Promise<Embedding[] | undefined> {
    if (process.env.BOBI_SEMANTIC_MEMORY === "0") return undefined;
    return super.embedTexts(texts);
  }
}

class DeadEmbedder implements Embedder {
  readonly name = "dead";
  available(): boolean {
    return false;
  }
  async embedTexts(): Promise<Embedding[] | undefined> {
    return undefined;
  }
}

function actor(userId: string): ToolActor {
  return {
    userId,
    permissions: ["tools:remember", "tools:recall", "tools:forget"],
  };
}

function harness(embedder: Embedder) {
  const provider = new MapMemoryProvider();
  const vectors = new MemoryVectorStore(new Database(":memory:"));
  const search = new SemanticMemorySearch({ provider, vectors, embedder });
  return { provider, vectors, search };
}

function service(provider: MemoryProvider, search: SemanticMemorySearch) {
  return new ToolService({
    extraTools: createMemoryTools({ provider, semantic: search }),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// RRF fusion (pure)
// ---------------------------------------------------------------------------

describe("reciprocalRankFusion", () => {
  test("a document matching both signals outranks single-signal matches", () => {
    const fused = reciprocalRankFusion(
      [
        ["both", "text-only"], // text ranking
        ["both", "vector-only"], // vector ranking
      ],
      10,
    );
    expect(fused[0]).toBe("both");
    expect(new Set(fused)).toEqual(new Set(["both", "text-only", "vector-only"]));
  });

  test("one top rank beats a deep rank in the other list", () => {
    // Exact math: 1/(60+0) > 1/(60+62).
    const deep = [...Array(62).keys()].map((i) => `x${i}`);
    const fused = reciprocalRankFusion([["top"], [...deep, "deep"]], 100);
    expect(fused[0]).toBe("top");
    expect(fused[fused.length - 1]).toBe("deep");
  });

  test("the k parameter is honored", () => {
    // k=0: scores are 1/(rank+1) — a: 1 + 1/2, b: 1/2 → a first.
    expect(reciprocalRankFusion([["a"], ["a", "b"]], 10, 0)).toEqual(["a", "b"]);
  });

  test("empty lists fuse to the other list's order", () => {
    expect(reciprocalRankFusion([[], ["a", "b"]], 10)).toEqual(["a", "b"]);
    expect(reciprocalRankFusion([["a", "b"], []], 10)).toEqual(["a", "b"]);
    expect(reciprocalRankFusion([[], []], 10)).toEqual([]);
  });

  test("ties break deterministically by key", () => {
    const once = reciprocalRankFusion([["b"], ["a"]], 10);
    const twice = reciprocalRankFusion([["b"], ["a"]], 10);
    expect(once).toEqual(twice);
    expect(once).toEqual(["a", "b"]);
  });

  test("duplicate keys inside one list count once", () => {
    const fused = reciprocalRankFusion([["a", "a", "b"], ["b"]], 10);
    // a: 1/61 (text rank 0, dup ignored); b: 1/62 + 1/61 → b first.
    expect(fused).toEqual(["b", "a"]);
  });

  test("limit is honored", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["c", "b", "a"]], 2);
    expect(fused).toHaveLength(2);
  });

  test("RRF_K is the standard 60", () => {
    expect(RRF_K).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// recall searchMode: hybrid / semantic / text
// ---------------------------------------------------------------------------

/**
 * Three memories:
 * - "cat":     key contains the query AND its vector is closest → both signals
 * - "catalog": key contains the query but its vector is far → text-leaning
 * - "dog":     no substring match for "cat"; vector is second-closest → vector-leaning
 */
function hybridHarness(embedderClass: typeof CannedEmbedder = CannedEmbedder) {
  const embedder = new embedderClass({
    [embedTextFor("cat", "a fluffy cat")]: [1, 0],
    [embedTextFor("catalog", "a book of many things")]: [0, 1],
    [embedTextFor("dog", "a loud dog")]: [0.7, 0.7],
    cat: [0.95, 0.05],
    dog: [0.6, 0.8],
  });
  const { provider, vectors, search } = harness(embedder);
  provider.upsert("u1", "cat", "a fluffy cat");
  provider.upsert("u1", "catalog", "a book of many things");
  provider.upsert("u1", "dog", "a loud dog");
  return { provider, vectors, search };
}

describe("recall hybrid ranking", () => {
  test("both signals fuse: the dual match comes first, mode is hybrid", async () => {
    const { provider, search } = hybridHarness();
    expect(await search.backfill("u1")).toBe(3);
    const svc = service(provider, search);
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "cat" },
      actor: actor("u1"),
    });
    expect(r.status).toBe("ok");
    const data = r.data as { memories: Array<{ key: string }>; searchMode: string };
    expect(data.searchMode).toBe("hybrid");
    // text order: [cat, catalog]; vector order: [cat, dog, catalog].
    // RRF: cat 1/61+1/61, catalog 1/62+1/63, dog 1/62.
    expect(data.memories.map((m) => m.key)).toEqual(["cat", "catalog", "dog"]);
  });

  test("fusion math through the tool: vector order reshapes text order", async () => {
    const { provider, search } = hybridHarness();
    expect(await search.backfill("u1")).toBe(3);
    const svc = service(provider, search);
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "dog" },
      actor: actor("u1"),
    });
    expect(r.status).toBe("ok");
    const data = r.data as { memories: Array<{ key: string }>; searchMode: string };
    expect(data.searchMode).toBe("hybrid");
    // text order: [dog]; vector order: [dog, catalog, cat].
    // RRF: dog 1/61+1/61, catalog 1/62, cat 1/63.
    expect(data.memories.map((m) => m.key)).toEqual(["dog", "catalog", "cat"]);
  });

  test("no substring match anywhere → mode is semantic", async () => {
    const embedder = new CannedEmbedder({
      [embedTextFor("cat", "a fluffy cat")]: [1, 0],
      "zzz-no-match": [0.99, 0.01],
    });
    const { provider, search } = harness(embedder);
    provider.upsert("u1", "cat", "a fluffy cat");
    expect(await search.backfill("u1")).toBe(1);
    const svc = service(provider, search);
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "zzz-no-match" },
      actor: actor("u1"),
    });
    expect(r.status).toBe("ok");
    const data = r.data as { memories: Array<{ key: string }>; searchMode: string };
    expect(data.searchMode).toBe("semantic");
    expect(data.memories.map((m) => m.key)).toEqual(["cat"]);
  });

  test("dead embedder → silent text fallback, mode is text", async () => {
    const { provider, search } = harness(new DeadEmbedder());
    provider.upsert("u1", "cat", "a fluffy cat");
    const svc = service(provider, search);
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "fluffy" },
      actor: actor("u1"),
    });
    expect(r.status).toBe("ok");
    const data = r.data as { memories: Array<{ key: string }>; searchMode: string };
    expect(data.searchMode).toBe("text");
    expect(data.memories.map((m) => m.key)).toEqual(["cat"]);
  });

  test("hybrid never leaks another user's memories", async () => {
    const { provider, search } = hybridHarness();
    expect(await search.backfill("u1")).toBe(3);
    provider.upsert("u2", "cat", "u2's cat");
    const svc = service(provider, search);
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "cat", limit: 10 },
      actor: actor("u2"),
    });
    expect(r.status).toBe("ok");
    const data = r.data as {
      memories: Array<{ key: string; content: string }>;
      searchMode: string;
    };
    // u2 has one memory and no vectors: semantic search finds nothing for
    // u2 → text fallback over u2's own single memory.
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0]!.content).toBe("u2's cat");
  });
});

// ---------------------------------------------------------------------------
// Embedding-model tracking: dim mismatch + model mismatch
// ---------------------------------------------------------------------------

describe("embedding model/dimension staleness", () => {
  test("a row from a different model is stale even when dims match", async () => {
    const { provider, vectors, search } = harness(
      new CannedEmbedder({}, [0.5, 0.5]),
    );
    provider.upsert("u1", "cat", "a fluffy cat");
    // Same dim the live embedder produces (2), but another model.
    vectors.save("u1", "cat", [1, 0], "old-model");
    // The stale row must not rank: nothing usable → undefined → text fallback.
    expect(await search.search("u1", "anything", 5)).toBeUndefined();
    await tick();
    await tick();
    // The bounded backfill re-embedded it with the current model.
    const row = vectors.get("u1", "cat");
    expect(row?.model).toBe("test-model-v1");
    expect(row?.dim).toBe(2);
  });

  test("same model + same dim rows stay usable (no churn on restart)", async () => {
    const { provider, vectors, search } = harness(
      new CannedEmbedder({
        [embedTextFor("cat", "a fluffy cat")]: [1, 0],
        q: [0.9, 0.1],
      }),
    );
    provider.upsert("u1", "cat", "a fluffy cat");
    expect(await search.backfill("u1")).toBe(1);
    // A second backfill finds nothing to do — no re-embed churn.
    expect(await search.backfill("u1")).toBe(0);
    expect(vectors.get("u1", "cat")?.model).toBe("test-model-v1");
  });

  test("legacy rows without a model keep the dimension-only rule", async () => {
    const db = new Database(":memory:");
    const legacy = new MemoryVectorStore(db);
    legacy.save("u1", "cat", [1, 0]); // model defaults to ""
    expect(legacy.get("u1", "cat")?.model).toBe("");
    // And a phase-4 table (no model column at all) migrates lazily.
    const db2 = new Database(":memory:");
    db2.exec(`
      CREATE TABLE memory_embeddings (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      INSERT INTO memory_embeddings(user_id, key, dim, vec, updated_at)
      VALUES('u1', 'old', 2, zeroblob(8), 1);
    `);
    const migrated = new MemoryVectorStore(db2);
    migrated.init();
    const cols = db2
      .query<{ name: string }, []>(`PRAGMA table_info(memory_embeddings)`)
      .all()
      .map((c) => c.name);
    expect(cols).toContain("model");
    expect(migrated.get("u1", "old")?.model).toBe("");
    expect(migrated.get("u1", "old")?.dim).toBe(2);
  });

  test("backfill re-embeds model-stale rows within its bound", async () => {
    const { provider, vectors, search } = harness(
      new CannedEmbedder({}, [0.5, 0.5]),
    );
    for (let i = 0; i < 25; i++) {
      provider.upsert("u1", `k${i}`, `memory ${i}`);
      vectors.save("u1", `k${i}`, [1, 0], "old-model");
    }
    const first = await search.backfill("u1");
    expect(first).toBeLessThanOrEqual(20);
    const second = await search.backfill("u1");
    expect(first + second).toBe(25);
    expect(vectors.get("u1", "k0")?.model).toBe("test-model-v1");
  });
});

// ---------------------------------------------------------------------------
// indexState(): owner-visible index health
// ---------------------------------------------------------------------------

describe("SemanticMemorySearch.indexState", () => {
  test("reports fresh/stale/missing against the live model", async () => {
    const { provider, vectors, search } = harness(
      new CannedEmbedder({}, [0.5, 0.5]),
    );
    provider.upsert("u1", "fresh", "has a current vector");
    provider.upsert("u1", "stale", "vector from an old model");
    provider.upsert("u1", "missing", "no vector at all");
    vectors.save("u1", "fresh", [1, 0], "test-model-v1");
    vectors.save("u1", "stale", [1, 0], "old-model");
    // No embed has happened yet in this process: dim is unknown (0), so
    // the model check alone separates fresh from stale.
    const state: MemoryIndexState = await search.indexState("u1");
    expect(state.enabled).toBe(true);
    expect(state.model).toBe("test-model-v1");
    expect(state.dim).toBe(0);
    expect(state.fresh).toBe(1);
    expect(state.stale).toBe(1);
    expect(state.missing).toBe(1);
    expect(state.total).toBe(3);
  });

  test("dim becomes known after the first search; stale rows reconverge", async () => {
    const { provider, vectors, search } = harness(
      new CannedEmbedder({ q: [0.9, 0.1] }, [0.5, 0.5]),
    );
    provider.upsert("u1", "a", "memory a");
    provider.upsert("u1", "b", "memory b");
    vectors.save("u1", "a", [1, 0, 0], "test-model-v1"); // dim 3 vs live dim 2
    vectors.save("u1", "b", [1, 0], "test-model-v1");
    // A search learns the live dim (2): "b" still ranks, "a" is excluded —
    // a stale row never poisons the ranking, it just sits out.
    expect((await search.search("u1", "q", 5))?.map((h) => h.key)).toEqual([
      "b",
    ]);
    // The search noticed the gap and kicked a background backfill; wait
    // for it to reconverge (bounded polling, not a fixed sleep).
    for (let i = 0; i < 100 && vectors.get("u1", "a")?.dim !== 2; i++) {
      await tick();
    }
    const state = await search.indexState("u1");
    expect(state.dim).toBe(2);
    expect(state.fresh).toBe(2);
    expect(state.stale).toBe(0);
    expect(state.missing).toBe(0);
    expect(state.total).toBe(2);
  });

  test("kill switch → enabled false, never throws, no embedding", async () => {
    process.env.BOBI_SEMANTIC_MEMORY = "0";
    const { provider, search } = harness(new KillSwitchCanned({}));
    provider.upsert("u1", "a", "memory a");
    const state = await search.indexState("u1");
    expect(state.enabled).toBe(false);
    expect(state.model).toBe("");
    expect(state.total).toBe(1);
    expect(state.missing).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Kill switch end-to-end: recall degrades to text
// ---------------------------------------------------------------------------

describe("kill switch", () => {
  test("BOBI_SEMANTIC_MEMORY=0 → recall is text mode even with vectors", async () => {
    const { provider, search } = hybridHarness(KillSwitchCanned);
    expect(await search.backfill("u1")).toBe(3);
    process.env.BOBI_SEMANTIC_MEMORY = "0";
    const svc = service(provider, search);
    const r = await svc.runTool({
      tool: "recall",
      input: { query: "cat" },
      actor: actor("u1"),
    });
    expect(r.status).toBe("ok");
    const data = r.data as { memories: Array<{ key: string }>; searchMode: string };
    expect(data.searchMode).toBe("text");
    expect(data.memories.map((m) => m.key)).toEqual(["cat", "catalog"]);
  });

  test("ProviderEmbedder reports unavailable under the kill switch", async () => {
    process.env.BOBI_SEMANTIC_MEMORY = "0";
    const storage = Storage.open(":memory:");
    const e = new ProviderEmbedder({
      storage,
      secrets: new ProviderSecretStore(undefined),
      adapters: new AdapterRegistry(),
    });
    expect(e.available()).toBe(false);
    expect(await e.embedTexts(["x"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dashboard: the memory endpoint exposes the index state (owner-visible)
// ---------------------------------------------------------------------------

const TOKEN = "test-token";
const OWNER_ID = "12345";

// ------------------------------------------------------ miniapp memory ---
//
// Platform Phase 10: the dashboard memory endpoint is retired; the Mini
// App's memory.list carries the same `embedding` index-health field.

const MINIAPP_BOT_TOKEN = "test-bot-token-123456";

function makeInitData(userId: number): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAE-test");
  params.set("user", JSON.stringify({ id: userId, first_name: "Owner" }));
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(MINIAPP_BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

async function memoryList(
  deps: ManageApiDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handleManageApi(
    "/miniapp/api/memory.list",
    { initData: makeInitData(Number(OWNER_ID)) },
    { ...deps, ownerId: OWNER_ID, botToken: MINIAPP_BOT_TOKEN },
  );
  return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
}

describe("miniapp memory endpoint — embedding state (phase 5, moved in phase 10)", () => {
  test("includes the embedding index state, read-only", async () => {
    const storage = Storage.open(":memory:");
    storage.upsertMemory({ userId: OWNER_ID, key: "cat", content: "a fluffy cat" });
    const provider = new MapMemoryProvider();
    provider.upsert(OWNER_ID, "cat", "a fluffy cat");
    const vectors = new MemoryVectorStore(new Database(":memory:"));
    const search = new SemanticMemorySearch({
      provider,
      vectors,
      embedder: new CannedEmbedder({}),
    });
    const { status, body } = await memoryList({ storage, semantic: search });
    expect(status).toBe(200);
    expect(body["total"]).toBe(1);
    const embedding = body["embedding"] as Record<string, unknown>;
    expect(embedding["enabled"]).toBe(true);
    expect(embedding["model"]).toBe("test-model-v1");
    expect(embedding["total"]).toBe(1);
    expect(embedding["missing"]).toBe(1);
    // No memory content inside the embedding block.
    expect(JSON.stringify(embedding)).not.toContain("fluffy");
    storage.close();
  });

  test("memory listing still works when the semantic index throws", async () => {
    const storage = Storage.open(":memory:");
    storage.upsertMemory({ userId: OWNER_ID, key: "cat", content: "a fluffy cat" });
    const broken = {
      indexState: async () => {
        throw new Error("boom");
      },
    } as unknown as SemanticMemorySearch;
    const { status, body } = await memoryList({ storage, semantic: broken });
    expect(status).toBe(200);
    expect(body["total"]).toBe(1);
    expect(body["embedding"]).toBeUndefined();
    storage.close();
  });
});
