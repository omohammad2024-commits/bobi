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
// Memory-core upgrade: consolidation sweep, episodic session summaries,
// proactive recall, contradiction supersession.
export {
  consolidateMemories,
  isConsolidationEnabled,
  promotionTarget,
  PINNED_IMPORTANCE,
  DECAY_FLOOR,
} from "./consolidate";
export type {
  ConsolidationMemory,
  ConsolidationOptions,
  ConsolidationReport,
} from "./consolidate";
export {
  buildEpisodeSummary,
  episodeKey,
  isEpisodesEnabled,
  latestEpisode,
  maybeStoreEpisode,
  scanEndedConversations,
  EPISODE_IMPORTANCE,
  EPISODE_IDLE_MS,
  EPISODE_MIN_USER_TURNS,
} from "./episodes";
export type { EpisodeCheckResult, EpisodeDeps } from "./episodes";
export {
  extractQueryTopics,
  isProactiveRecallEnabled,
  recallFor,
  recallScoreFloor,
  DEFAULT_RECALL_FLOOR,
} from "./proactive_recall";
export type {
  ProactiveRecallDeps,
  ProactivelyRecalled,
} from "./proactive_recall";
export {
  applyFactCandidate,
  factKindOfKey,
  findContradictions,
  CONTRADICTION_JACCARD_MIN,
  SUPERSEDED_PREFIX,
} from "./contradictions";
export type {
  ApplyFactResult,
  SupersessionLogEntry,
  SupersessionLogger,
} from "./contradictions";
