/**
 * Pluggable long-term memory backends (Phase D2).
 *
 * Import from here, not the individual modules:
 *   import { resolveMemoryProvider, registerMemoryProvider } from "./memory";
 */
export type { MemoryProvider, StoredMemory } from "./provider";
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
export { reciprocalRankFusion, RRF_K } from "./hybrid";
