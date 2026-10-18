/**
 * Embedding primitives for semantic memory search (Phase 4).
 *
 * The `Embedder` is the only thing that turns text into vectors. The rest of
 * the memory layer (vector store, semantic search) works purely on number
 * arrays and never touches the network, so swapping the vector source never
 * changes ranking logic.
 *
 * Unavailability is a first-class answer, not an error: `embedTexts`
 * resolves to `undefined` when there is no embedding-capable provider (no
 * provider configured, FakeProvider, Gemini/Anthropic adapters, offline,
 * bad embedding model). Every caller treats `undefined` as "fall back to
 * text search", silently — semantic ranking is an enhancement, not a
 * dependency.
 */

/** One embedding vector. Not guaranteed unit-length; compare with cosineSimilarity. */
export type Embedding = readonly number[];

/**
 * A text→vector source.
 *
 * Implementations must never throw for "cannot embed": they resolve to
 * `undefined` instead. Throwing is reserved for programming bugs (empty
 * batch is fine and yields `[]`).
 */
export interface Embedder {
  /** Stable identifier, e.g. "provider". Used in logs only. */
  readonly name: string;
  /**
   * Embed a batch of texts, in order.
   *
   * Resolves to `undefined` when embedding is unavailable right now (no
   * provider, no capability, network down, bad model). The caller falls
   * back to text search — no error, no user-visible change.
   */
  embedTexts(texts: readonly string[]): Promise<Embedding[] | undefined>;
  /** True when this embedder could plausibly answer (cheap pre-check). */
  available(): boolean;
  /**
   * Phase 5: the embedding model id new vectors are written with
   * (e.g. "text-embedding-3-small"). Optional — embedders that do not
   * report it keep the phase-4 dimension-only staleness rule. Stored
   * alongside each vector so a model change marks old rows stale instead
   * of silently mixing incompatible embeddings in cosine ranking.
   */
  modelId?(): string | undefined;
}

/**
 * Cosine similarity between two vectors.
 *
 * Returns 0 for a zero vector or a length mismatch rather than NaN, so a
 * corrupt stored vector degrades one ranking instead of poisoning it.
 * Pure and deterministic — the ranking the tests pin down.
 */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Rank candidate indexes by cosine similarity to the query vector.
 *
 * Pure helper so the ranking rule is unit-testable without a database:
 * returns candidate indexes sorted best-first, cut to `limit`.
 */
export function rankBySimilarity(
  query: Embedding,
  candidates: readonly Embedding[],
  limit: number,
): number[] {
  const scored = candidates.map((vec, index) => ({
    index,
    score: cosineSimilarity(query, vec),
  }));
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.index);
}
