/**
 * Semantic (vector-similarity) memory search (Phase 4).
 *
 * What this suite pins down:
 *
 * - The math: cosineSimilarity and rankBySimilarity are pure, deterministic,
 *   and degrade (0) on zero vectors and length mismatches instead of NaN.
 * - The vector store: lazy table creation (storage.ts untouched), Float32
 *   round-trip, user scoping, and graceful decode of a corrupt BLOB.
 * - The /embeddings wire parsing: out-of-order indexes are re-sorted,
 *   malformed entries throw AiError rather than misaligning vectors.
 * - The provider embedder: every "cannot embed" situation (kill switch, no
 *   active provider, adapter without embeddings, missing credential, a
 *   throwing adapter) resolves to undefined — never a throw, never a
 *   user-visible error.
 * - The semantic search: ranks by meaning, returns undefined when there is
 *   nothing to rank against, ignores stale-dimension rows, backfills lazily,
 *   and never leaks one user's vectors into another's search.
 * - The tools: recall reports searchMode, falls back to substring ranking
 *   when semantic is unavailable; remember indexes in the background;
 *   forget drops the vector.
 *
 * No network anywhere: the provider embedder's adapter is injected.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { AiError } from "../src/ai/provider";
import type { AIProviderAdapter, EmbedRequest, EmbedResponse } from "../src/ai/adapter";
import { parseEmbedResponse } from "../src/ai/openai_compatible";
import {
  cosineSimilarity,
  rankBySimilarity,
  MemoryVectorStore,
  encodeVector,
  decodeVector,
  ProviderEmbedder,
  SemanticMemorySearch,
  embedTextFor,
  DEFAULT_EMBEDDING_MODEL,
} from "../src/memory";
import type { Embedder, Embedding, SemanticHit, SemanticMemoryIndex } from "../src/memory";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";
import {
  createMemoryTools,
  REMEMBER_PERMISSION,
  RECALL_PERMISSION,
  FORGET_PERMISSION,
} from "../src/tools/memory";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";

const MASTER_KEY = "k".repeat(64);
const PERMS = [REMEMBER_PERMISSION, RECALL_PERMISSION, FORGET_PERMISSION];

function actor(userId: string): ToolActor {
  return { userId, permissions: PERMS };
}

/** Restore env vars this suite touches. */
const savedEnv = { ...process.env };
afterEach(() => {
  for (const k of ["BOBI_SEMANTIC_MEMORY", "BOBI_EMBEDDING_MODEL"] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** In-memory MemoryProvider, sync — the tools await either way. */
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

/** Embedder with a canned text→vector map. Unknown texts embed as `fallback`. */
class CannedEmbedder implements Embedder {
  readonly name = "canned";
  constructor(
    private readonly table: Record<string, Embedding>,
    private readonly fallback?: Embedding,
  ) {}

  available(): boolean {
    return true;
  }

  async embedTexts(texts: readonly string[]): Promise<Embedding[] | undefined> {
    return texts.map((t) => this.table[t] ?? this.fallback ?? [0]);
  }
}

/** Embedder that is always unavailable. */
class DeadEmbedder implements Embedder {
  readonly name = "dead";
  available(): boolean {
    return false;
  }
  async embedTexts(): Promise<Embedding[] | undefined> {
    return undefined;
  }
}

/** Minimal AIProviderAdapter stub for the embedder tests. */
function stubAdapter(impl: {
  embed?: (req: EmbedRequest) => Promise<EmbedResponse>;
  capabilities?: { embeddings?: boolean };
}): AIProviderAdapter {
  return {
    name: "stub",
    type: "openai_compatible",
    label: "stub",
    capabilities: { embeddings: true, ...impl.capabilities },
    complete: () => {
      throw new Error("not implemented");
    },
    ...(impl.embed !== undefined ? { embed: impl.embed } : {}),
  } as AIProviderAdapter;
}

/** Semantic index stub that records write-side calls. */
class StubSemantic implements SemanticMemoryIndex {
  indexed: Array<[string, string, string]> = [];
  removed: Array<[string, string]> = [];
  constructor(private readonly hits: SemanticHit[] | undefined) {}
  async search(): Promise<SemanticHit[] | undefined> {
    return this.hits;
  }
  indexMemory(userId: string, key: string, content: string): void {
    this.indexed.push([userId, key, content]);
  }
  removeMemory(userId: string, key: string): void {
    this.removed.push([userId, key]);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// Cosine similarity + ranking
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  test("identical vectors score 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  test("orthogonal vectors score 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  test("opposite vectors score -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  test("scale does not matter", () => {
    expect(cosineSimilarity([1, 1], [5, 5])).toBeCloseTo(1, 10);
  });

  test("zero vector degrades to 0, not NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
  });

  test("length mismatch degrades to 0, not NaN", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("rankBySimilarity", () => {
  test("best first, cut to limit", () => {
    const order = rankBySimilarity([1, 0], [[1, 0], [0, 1], [0.9, 0.1]], 2);
    expect(order).toEqual([0, 2]);
  });

  test("empty candidates", () => {
    expect(rankBySimilarity([1, 0], [], 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

describe("MemoryVectorStore", () => {
  test("creates the table lazily — storage.ts untouched", () => {
    const db = new Database(":memory:");
    const tables = () =>
      db
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((r) => r.name);
    expect(tables()).not.toContain("memory_embeddings");
    const store = new MemoryVectorStore(db);
    store.save("u1", "k", [0.5, -0.25]);
    expect(tables()).toContain("memory_embeddings");
  });

  test("save/get round-trips a vector", () => {
    const store = new MemoryVectorStore(new Database(":memory:"));
    store.save("u1", "k", [1.5, -2.25, 0]);
    const got = store.get("u1", "k");
    expect(got?.key).toBe("k");
    expect(got?.dim).toBe(3);
    expect(got?.vector[0]).toBeCloseTo(1.5, 5);
    expect(got?.vector[1]).toBeCloseTo(-2.25, 5);
    expect(got?.vector[2]).toBeCloseTo(0, 5);
  });

  test("re-save overwrites", () => {
    const store = new MemoryVectorStore(new Database(":memory:"));
    store.save("u1", "k", [1, 0]);
    store.save("u1", "k", [0, 1, 0]);
    const got = store.get("u1", "k");
    expect(got?.dim).toBe(3);
    expect(got?.vector).toEqual([0, 1, 0]);
  });

  test("listAll / count / delete", () => {
    const store = new MemoryVectorStore(new Database(":memory:"));
    store.save("u1", "a", [1, 0]);
    store.save("u1", "b", [0, 1]);
    expect(store.count("u1")).toBe(2);
    expect(store.listAll("u1").map((v) => v.key).sort()).toEqual(["a", "b"]);
    expect(store.delete("u1", "a")).toBe(true);
    expect(store.delete("u1", "a")).toBe(false);
    expect(store.count("u1")).toBe(1);
  });

  test("vectors are scoped to their owner", () => {
    const store = new MemoryVectorStore(new Database(":memory:"));
    store.save("u1", "k", [1, 0]);
    expect(store.get("u2", "k")).toBeUndefined();
    expect(store.listAll("u2")).toEqual([]);
    expect(store.count("u2")).toBe(0);
  });

  test("a corrupt BLOB degrades instead of throwing", () => {
    // 4 bytes but dim 3: the missing floats read as 0.
    expect(decodeVector(new Uint8Array([0, 0, 128, 63]), 3)).toEqual([1, 0, 0]);
    expect(encodeVector([1, 2]).length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// /embeddings wire parsing
// ---------------------------------------------------------------------------

describe("parseEmbedResponse", () => {
  test("happy path, entries re-sorted by index", () => {
    const res = parseEmbedResponse(
      {
        data: [
          { embedding: [0, 1], index: 1 },
          { embedding: [1, 0], index: 0 },
        ],
        model: "text-embedding-3-small",
      },
      2,
    );
    expect(res.embeddings).toEqual([[1, 0], [0, 1]]);
    expect(res.model).toBe("text-embedding-3-small");
  });

  test("model is optional", () => {
    const res = parseEmbedResponse({ data: [{ embedding: [1], index: 0 }] }, 1);
    expect(res.model).toBeUndefined();
  });

  test("malformed bodies throw AiError, never misalign", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["no data", {}],
      ["empty data", { data: [] }],
      ["non-record entry", { data: [42] }],
      ["non-numeric embedding", { data: [{ embedding: ["x"], index: 0 }] }],
      ["empty embedding", { data: [{ embedding: [], index: 0 }] }],
      ["NaN component", { data: [{ embedding: [NaN], index: 0 }] }],
      ["count mismatch", { data: [{ embedding: [1], index: 0 }] }],
    ];
    for (const [label, body] of bad) {
      const count = label === "count mismatch" ? 2 : 1;
      expect(() => parseEmbedResponse(body, count), label).toThrow(AiError);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider embedder
// ---------------------------------------------------------------------------

function embedderHarness() {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(MASTER_KEY);
  const adapters = new AdapterRegistry();
  return { storage, secrets, adapters };
}

/** Create an enabled openai_compatible provider with a credential, and activate it. */
function activateProvider(h: ReturnType<typeof embedderHarness>, adapter = "openai_compatible") {
  const id = h.storage.createProvider({
    label: "test",
    adapter,
    baseUrl: "https://example.com/v1",
  });
  h.storage.upsertCredential({ providerId: id, ...h.secrets.encrypt("sk-test") });
  h.storage.setRuntimeSelection({ providerId: id, modelId: 1 });
  return id;
}

describe("ProviderEmbedder", () => {
  test("kill switch: BOBI_SEMANTIC_MEMORY=0 disables everything", async () => {
    process.env.BOBI_SEMANTIC_MEMORY = "0";
    const h = embedderHarness();
    activateProvider(h);
    const e = new ProviderEmbedder(h);
    expect(e.available()).toBe(false);
    expect(await e.embedTexts(["hello"])).toBeUndefined();
  });

  test("no active provider → unavailable", async () => {
    const h = embedderHarness();
    const e = new ProviderEmbedder(h);
    expect(e.available()).toBe(false);
    expect(await e.embedTexts(["hello"])).toBeUndefined();
  });

  test("adapter without embeddings (gemini) → unavailable, no credential decrypted", async () => {
    const h = embedderHarness();
    // No credential at all: the capability check must fire first.
    const id = h.storage.createProvider({
      label: "gem",
      adapter: "gemini",
      baseUrl: "https://example.com/v1",
    });
    h.storage.setRuntimeSelection({ providerId: id, modelId: 1 });
    const e = new ProviderEmbedder(h);
    expect(await e.embedTexts(["hello"])).toBeUndefined();
  });

  test("active provider without a credential → unavailable", async () => {
    const h = embedderHarness();
    const id = h.storage.createProvider({
      label: "nocred",
      adapter: "openai_compatible",
      baseUrl: "https://example.com/v1",
    });
    h.storage.setRuntimeSelection({ providerId: id, modelId: 1 });
    const e = new ProviderEmbedder(h);
    expect(await e.embedTexts(["hello"])).toBeUndefined();
  });

  test("success path via injected adapter; model override respected", async () => {
    const h = embedderHarness();
    activateProvider(h);
    let seenModel = "";
    const e = new ProviderEmbedder({
      ...h,
      embeddingModel: "custom-embed-1",
      createAdapter: () =>
        stubAdapter({
          embed: async (req: EmbedRequest) => {
            seenModel = req.model;
            return { embeddings: req.texts.map(() => [1, 0]), model: req.model };
          },
        }),
    });
    expect(e.embeddingModel()).toBe("custom-embed-1");
    const out = await e.embedTexts(["a", "b"]);
    expect(out).toEqual([[1, 0], [1, 0]]);
    expect(seenModel).toBe("custom-embed-1");
  });

  test("env model override, then default", () => {
    const h = embedderHarness();
    expect(new ProviderEmbedder(h).embeddingModel()).toBe(DEFAULT_EMBEDDING_MODEL);
    process.env.BOBI_EMBEDDING_MODEL = "env-model";
    expect(new ProviderEmbedder(h).embeddingModel()).toBe("env-model");
  });

  test("a throwing adapter → undefined, never a throw", async () => {
    const h = embedderHarness();
    activateProvider(h);
    const e = new ProviderEmbedder({
      ...h,
      createAdapter: () =>
        stubAdapter({
          embed: async () => {
            throw new AiError("network", "down");
          },
        }),
    });
    expect(await e.embedTexts(["hello"])).toBeUndefined();
  });

  test("an adapter without an embed method → undefined", async () => {
    const h = embedderHarness();
    activateProvider(h);
    const e = new ProviderEmbedder({
      ...h,
      createAdapter: () => stubAdapter({}),
    });
    // stubAdapter with no embed impl still declares the capability; the
    // embedder checks the method itself.
    const adapter = (e as unknown as { resolveAdapter(): AIProviderAdapter | undefined }).resolveAdapter();
    expect(adapter?.embed).toBeUndefined();
    expect(await e.embedTexts(["hello"])).toBeUndefined();
  });

  test("empty batch resolves to []", async () => {
    const h = embedderHarness();
    const e = new ProviderEmbedder({ ...h, disabled: true });
    expect(await e.embedTexts([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

function searchHarness(embedder: Embedder) {
  const provider = new MapMemoryProvider();
  const vectors = new MemoryVectorStore(new Database(":memory:"));
  const search = new SemanticMemorySearch({ provider, vectors, embedder });
  return { provider, vectors, search };
}

const CAT = [1, 0];
const DOG = [0, 1];

function catDogEmbedder(): CannedEmbedder {
  return new CannedEmbedder({
    [embedTextFor("cat", "a fluffy cat")]: CAT,
    [embedTextFor("dog", "a loud dog")]: DOG,
    ["about cats"]: [0.9, 0.1],
  });
}

describe("SemanticMemorySearch", () => {
  test("ranks by meaning after backfill", async () => {
    const { provider, search } = searchHarness(catDogEmbedder());
    provider.upsert("u1", "cat", "a fluffy cat");
    provider.upsert("u1", "dog", "a loud dog");
    expect(await search.backfill("u1")).toBe(2);

    const hits = await search.search("u1", "about cats", 5);
    expect(hits).not.toBeUndefined();
    expect(hits!.map((h) => h.key)).toEqual(["cat", "dog"]);
    expect(hits![0]!.score).toBeGreaterThan(hits![1]!.score);
    // Scores ride along for the caller, but the tool strips them.
    expect(hits![0]).toHaveProperty("content", "a fluffy cat");
  });

  test("dead embedder → undefined (the tool falls back to text)", async () => {
    const { provider, search } = searchHarness(new DeadEmbedder());
    provider.upsert("u1", "cat", "a fluffy cat");
    expect(await search.search("u1", "cats", 5)).toBeUndefined();
    expect(await search.backfill("u1")).toBe(0);
  });

  test("no vectors yet → undefined, and a search kicks a background backfill", async () => {
    const { provider, vectors, search } = searchHarness(catDogEmbedder());
    provider.upsert("u1", "cat", "a fluffy cat");
    expect(await search.search("u1", "about cats", 5)).toBeUndefined();
    // The opportunistic backfill runs in the background.
    await tick();
    await tick();
    expect(vectors.count("u1")).toBe(1);
    const hits = await search.search("u1", "about cats", 5);
    expect(hits?.[0]?.key).toBe("cat");
  });

  test("stale-dimension rows are ignored; a model change reconverges", async () => {
    const { provider, vectors, search } = searchHarness(catDogEmbedder());
    provider.upsert("u1", "cat", "a fluffy cat");
    // A row from an older embedding model (dim 3 vs the live dim 2).
    vectors.save("u1", "cat", [1, 0, 0]);
    expect(await search.search("u1", "about cats", 5)).toBeUndefined();
    await tick();
    await tick();
    // The background pass re-embedded with the current dimension.
    expect(vectors.get("u1", "cat")?.dim).toBe(2);
    const hits = await search.search("u1", "about cats", 5);
    expect(hits?.[0]?.key).toBe("cat");
  });

  test("vectors never leak across users", async () => {
    const { provider, search } = searchHarness(catDogEmbedder());
    provider.upsert("u1", "cat", "a fluffy cat");
    await search.backfill("u1");
    // u2 has memories but no vectors of their own.
    provider.upsert("u2", "dog", "a loud dog");
    expect(await search.search("u2", "about cats", 5)).toBeUndefined();
  });

  test("indexMemory embeds in the background and never throws", async () => {
    const { vectors, search } = searchHarness(catDogEmbedder());
    search.indexMemory("u1", "cat", "a fluffy cat");
    await tick();
    expect(vectors.get("u1", "cat")?.vector).toEqual(CAT);

    const failing = new SemanticMemorySearch({
      provider: new MapMemoryProvider(),
      vectors: new MemoryVectorStore(new Database(":memory:")),
      embedder: {
        name: "boom",
        available: () => true,
        embedTexts: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(() => failing.indexMemory("u1", "k", "c")).not.toThrow();
    await tick();
  });

  test("removeMemory drops the vector", async () => {
    const { vectors, search } = searchHarness(catDogEmbedder());
    search.indexMemory("u1", "cat", "a fluffy cat");
    await tick();
    expect(vectors.count("u1")).toBe(1);
    search.removeMemory("u1", "cat");
    expect(vectors.count("u1")).toBe(0);
  });

  test("backfill is bounded per pass", async () => {
    const { provider, search } = searchHarness(
      new CannedEmbedder({}, [0.5, 0.5]),
    );
    for (let i = 0; i < 25; i++) provider.upsert("u1", `k${i}`, `memory ${i}`);
    const first = await search.backfill("u1");
    const second = await search.backfill("u1");
    expect(first).toBeLessThanOrEqual(20);
    expect(first + second).toBe(25);
  });

  test("embedTextFor leads with the key", () => {
    expect(embedTextFor("نام پروژه", "سول")).toBe("نام پروژه\nسول");
  });
});

// ---------------------------------------------------------------------------
// Tool wiring: recall / remember / forget
// ---------------------------------------------------------------------------

function toolService(provider: MemoryProvider, semantic?: SemanticMemoryIndex) {
  const svc = new ToolService({
    extraTools: createMemoryTools({ provider, ...(semantic ? { semantic } : {}) }),
  });
  return svc;
}

function run(svc: ToolService, tool: string, input: unknown, who = actor("u1")) {
  return svc.runTool({ tool, input, actor: who });
}

describe("memory tools with semantic search", () => {
  test("recall with a query uses semantic ranking and reports it", async () => {
    const provider = new MapMemoryProvider();
    provider.upsert("u1", "cat", "a fluffy cat");
    provider.upsert("u1", "dog", "a loud dog");
    const semantic = new StubSemantic([
      { key: "dog", content: "a loud dog", createdAt: 1, updatedAt: 1, score: 0.9 },
    ]);
    const svc = toolService(provider, semantic);
    const r = await run(svc, "recall", { query: "bark" });
    expect(r.status).toBe("ok");
    const data = r.data as { memories: Array<{ key: string }>; searchMode: string };
    expect(data.memories.map((m) => m.key)).toEqual(["dog"]);
    expect(data.searchMode).toBe("semantic");
  });

  test("recall falls back to substring ranking when semantic is unavailable", async () => {
    const provider = new MapMemoryProvider();
    provider.upsert("u1", "cat", "a fluffy cat");
    provider.upsert("u1", "dog", "a loud dog");
    const svc = toolService(provider, new StubSemantic(undefined));
    const r = await run(svc, "recall", { query: "fluffy" });
    expect(r.status).toBe("ok");
    const data = r.data as { memories: Array<{ key: string }>; searchMode: string };
    expect(data.memories.map((m) => m.key)).toEqual(["cat"]);
    expect(data.searchMode).toBe("text");
  });

  test("recall without a semantic index behaves exactly as before", async () => {
    const provider = new MapMemoryProvider();
    provider.upsert("u1", "cat", "a fluffy cat");
    const svc = toolService(provider);
    const r = await run(svc, "recall", { query: "cat" });
    expect(r.status).toBe("ok");
    const data = r.data as { memories: unknown[]; searchMode: string; total: number };
    expect(data.memories).toHaveLength(1);
    expect(data.searchMode).toBe("text");
    expect(data.total).toBe(1);
  });

  test("recall without a query stays text mode", async () => {
    const provider = new MapMemoryProvider();
    provider.upsert("u1", "cat", "a fluffy cat");
    const svc = toolService(provider, new StubSemantic([]));
    const r = await run(svc, "recall", {});
    const data = r.data as { searchMode: string };
    expect(data.searchMode).toBe("text");
  });

  test("remember triggers background indexing; forget drops the vector", async () => {
    const provider = new MapMemoryProvider();
    const semantic = new StubSemantic([]);
    const svc = toolService(provider, semantic);
    const r1 = await run(svc, "remember", { key: "cat", content: "a fluffy cat" });
    expect(r1.status).toBe("ok");
    expect(semantic.indexed).toEqual([["u1", "cat", "a fluffy cat"]]);
    const r2 = await run(svc, "forget", { key: "cat" });
    expect(r2.status).toBe("ok");
    expect(semantic.removed).toEqual([["u1", "cat"]]);
  });

  test("isolation holds: another user's semantic hits never surface", async () => {
    const provider = new MapMemoryProvider();
    provider.upsert("u1", "cat", "a fluffy cat");
    // A hostile index returning another user's memory: the tool still only
    // exposes what the index returned for THIS call, and the real
    // SemanticMemorySearch scopes by user id (tested above). Here the point
    // is the plumbing: the actor's id is what reaches the index.
    const seen: string[] = [];
    const semantic: SemanticMemoryIndex = {
      search: async (userId: string) => {
        seen.push(userId);
        return [];
      },
      indexMemory: () => undefined,
      removeMemory: () => undefined,
    };
    const svc = toolService(provider, semantic);
    await run(svc, "recall", { query: "x" }, actor("u2"));
    expect(seen).toEqual(["u2"]);
  });
});
