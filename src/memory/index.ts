/**
 * Pluggable long-term memory backends (Phase D2).
 *
 * Import from here, not the individual modules:
 *   import { resolveMemoryProvider, registerMemoryProvider } from "./memory";
 */
export type {
  MemoryProvider,
  MemoryPruneDrop,
  MemoryUpsertOptions,
  StoredMemory,
} from "./provider";
export { SqliteMemoryProvider } from "./sqlite_provider";
export {
  registerMemoryProvider,
  getMemoryProvider,
  memoryProviderNames,
} from "./registry";
export { resolveMemoryProvider, DEFAULT_MEMORY_PROVIDER } from "./factory";
// Phase 4: semantic (vector-similarity) memory search.
export type { Embedding, Embedder } from "./embeddings";
export { cosineSimilarity, rankBySimilarity } from "./embeddings";
export { MemoryVectorStore, encodeVector, decodeVector } from "./vector_store";
export type { StoredVector } from "./vector_store";
export {
  ProviderEmbedder,
  DEFAULT_EMBEDDING_MODEL,
} from "./provider_embedder";
export {
  SemanticMemorySearch,
  embedTextFor,
} from "./semantic";
export type {
  SemanticHit,
  SemanticMemoryIndex,
  MemoryIndexState,
} from "./semantic";
// Phase 5: hybrid FTS+vector ranking (Reciprocal Rank Fusion).
export { reciprocalRankFusion, reciprocalRankFusionWithScores, RRF_K } from "./hybrid";
// Worker-2: better recall — Persian normalization, query expansion,
// recency/importance weighting, retrieval dedup, prune planning.
export {
  normalizeMemoryText,
  expandQueryVariants,
  tokenJaccard,
  DEFAULT_MEMORY_IMPORTANCE,
  memoryImportance,
  MEMORY_RECENCY_HALF_LIFE_MS,
  recencyImportanceScore,
  rankByRecencyImportance,
  RECENCY_IMPORTANCE_BOOST,
  boostByRecencyImportance,
  DEDUP_JACCARD_THRESHOLD,
  dedupeNearIdentical,
  oneLineSummary,
  buildPrunePlan,
} from "./hybrid";
export type {
  DedupMemory,
  FusedScore,
  PruneDrop,
  PrunePlan,
  PruneOptions,
} from "./hybrid";
