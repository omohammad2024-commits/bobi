/**
 * Proactive recall (memory-core upgrade).
 *
 * The `recall` tool is reactive: the model searches when it decides to.
 * This module flips the default — on every incoming message, surface the
 * memories the message is *about*, so the engine can prepend them before
 * the turn runs. That is: "relevant memories surface automatically", not
 * "only when asked".
 *
 * The helper does not reinvent ranking. It reuses the exact machinery the
 * recall tool uses:
 *  - Persian normalization + query expansion (hybrid.ts),
 *  - retrieval near-dedup (hybrid.ts),
 *  - Reciprocal Rank Fusion of the text ranking, an optional semantic
 *    ranking and the recency/importance ranking, with the bounded
 *    recency/importance boost (hybrid.ts),
 * and adds the one thing the tool lacks: QUERY CONSTRUCTION from the
 * message itself — entity/topic extraction (stopword-filtered tokens) — plus
 * a conservative score floor so only genuinely relevant memories surface.
 *
 * Floor semantics: RRF scores are tiny (~1/61 for a rank-1 hit on one
 * list). The default floor (0.025) plus the hard requirement that a memory
 * appear in a RELEVANCE list (text or semantic — never recency alone) means
 * a memory surfaces only when the message actually matches it.
 *
 * Kill switch: BOBI_MEMORY_PROACTIVE_RECALL=0 ⇒ always [].
 */
import type { MemoryProvider, StoredMemory } from "./provider";
import {
  boostByRecencyImportance,
  dedupeNearIdentical,
  expandQueryVariants,
  memoryImportance,
  normalizeMemoryText,
  rankByRecencyImportance,
  reciprocalRankFusionWithScores,
  recencyImportanceScore,
} from "./hybrid";

/** Env-tunable conservative floor on the boosted fused score. */
export const DEFAULT_RECALL_FLOOR = 0.025;

export function isProactiveRecallEnabled(): boolean {
  return process.env.BOBI_MEMORY_PROACTIVE_RECALL !== "0";
}

export function recallScoreFloor(): number {
  const raw = process.env.BOBI_MEMORY_RECALL_FLOOR;
  const v = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(v) && v >= 0) return v;
  return DEFAULT_RECALL_FLOOR;
}

export interface ProactiveRecallDeps {
  provider: MemoryProvider;
  /**
   * Optional semantic ranker with the same contract as
   * SemanticMemorySearch.search(userId, query, limit): ranked keys, or
   * undefined when the index cannot answer right now.
   */
  semantic?: {
    search(
      userId: string,
      query: string,
      limit: number,
    ): Promise<Array<{ key: string }> | undefined>;
  };
  nowMs?: number;
  /** Max memories returned. Default 5. */
  limit?: number;
}

export interface ProactivelyRecalled {
  key: string;
  content: string;
  importance: number;
  /** The boosted fused score (0..~0.05), for transparency/logging. */
  score: number;
}

/**
 * Persian + English function-ish words that are never entities.
 * Not exhaustive — entities are a recall nudge, not a parser contract.
 */
const STOPWORDS = new Set([
  "است", "هست", "نیست", "شد", "بود", "باش", "باشه", "کن", "کنه", "کنم",
  "را", "رو", "به", "از", "در", "که", "این", "آن", "با", "من", "تو", "ما",
  "چه", "چرا", "چطور", "چگونه", "می", "ها", "های", "ام", "ای", "ایم", "اند",
  "یه", "یک", "و", "یا", "بر", "هر", "اگر", "اگه", "ولی", "هم", "تا", "برای",
  "روی", "بین", "پس", "چون", "نه", "بله", "سلام", "مرسی", "لطفا",
  "the", "a", "an", "of", "to", "in", "is", "are", "was", "were", "be",
  "what", "how", "why", "when", "who", "and", "or", "but", "if", "then",
  "for", "with", "my", "your", "me", "you", "i", "it", "this", "that",
]);

/**
 * Candidate topics from a message: normalized tokens of length ≥ 3 that
 * are not stopwords, plus the full message's query variants (which catch
 * half-space/orthographic variants of every phrase).
 */
export function extractQueryTopics(message: string): string[] {
  const norm = normalizeMemoryText(message);
  const entities = norm
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const out = [...new Set([...entities, ...expandQueryVariants(message)])];
  return out.filter((t) => t.length > 0);
}

/**
 * Score and rank memories against the extracted topics. Key hits rank
 * above content hits (the key is the topic), then by hit count, then by
 * recency/importance.
 */
function rankByTopics(
  memories: readonly StoredMemory[],
  topics: readonly string[],
  nowMs: number,
): string[] {
  return [...memories]
    .map((m) => {
      const keyNorm = normalizeMemoryText(m.key);
      const contentNorm = normalizeMemoryText(m.content);
      let keyHits = 0;
      let hits = 0;
      for (const t of topics) {
        if (keyNorm.includes(t)) keyHits += 1;
        else if (contentNorm.includes(t)) hits += 1;
      }
      return { m, keyHits, hits };
    })
    .filter((e) => e.keyHits + e.hits > 0)
    .sort(
      (a, b) =>
        b.keyHits - a.keyHits ||
        b.hits - a.hits ||
        recencyImportanceScore(b.m, nowMs) - recencyImportanceScore(a.m, nowMs) ||
        (a.m.key < b.m.key ? -1 : 1),
    )
    .map((e) => e.m.key);
}

/**
 * The memories the incoming message is about, best first, each above the
 * score floor and confirmed by a relevance signal.
 */
export async function recallFor(
  deps: ProactiveRecallDeps,
  userId: string,
  message: string,
): Promise<ProactivelyRecalled[]> {
  if (!isProactiveRecallEnabled()) return [];
  if (message.trim().length === 0) return [];

  const nowMs = deps.nowMs ?? Date.now();
  const limit = Math.min(10, Math.max(1, deps.limit ?? 5));
  const floor = recallScoreFloor();

  const raw = (await deps.provider.list(userId, 200)) as StoredMemory[];
  if (raw.length === 0) return [];
  const memories = dedupeNearIdentical(raw);
  const byKey = new Map(memories.map((m) => [m.key, m]));

  const topics = extractQueryTopics(message);
  if (topics.length === 0) return [];
  const textRanked = rankByTopics(memories, topics, nowMs);
  if (textRanked.length === 0 && deps.semantic === undefined) return [];

  const lists: string[][] = [textRanked];
  if (deps.semantic !== undefined) {
    try {
      const hits = await deps.semantic.search(userId, message, 50);
      if (hits !== undefined && hits.length > 0) lists.push(hits.map((h) => h.key));
    } catch {
      // Semantic failure must never break proactive recall; the text
      // ranking carries it. (Same degradation philosophy as the recall tool.)
    }
  }
  lists.push(rankByRecencyImportance(memories, nowMs));

  // Relevance gate: a memory that matches only the recency list is
  // topical noise. It must be in the text or semantic ranking.
  const relevant = new Set(lists.slice(0, -1).flat());
  const fused = reciprocalRankFusionWithScores(lists, limit * 4);
  const boosted = boostByRecencyImportance(fused, memories, nowMs);

  const out: ProactivelyRecalled[] = [];
  for (const { key, score } of boosted) {
    if (out.length >= limit) break;
    if (!relevant.has(key) || score < floor) continue;
    const m = byKey.get(key);
    if (m === undefined) continue;
    out.push({
      key: m.key,
      content: m.content,
      importance: memoryImportance(m),
      score,
    });
  }
  return out;
}
