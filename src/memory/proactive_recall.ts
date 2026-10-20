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
 *
 * Turn-path deadline (R4): the semantic leg is an embedding round-trip to
 * a live provider (its own ceiling is 30 s in ProviderEmbedder). It must
 * never stall the chat turn, so recallFor races it against a budget
 * (default 2 s, see semanticBudgetMsFor). On timeout the turn proceeds
 * with the text + recency lists exactly as if semantic had returned
 * undefined. A timed-out embed may still settle in the background,
 * bounded by the embedder's own ceiling — the turn no longer waits for
 * it. When the text ranking already has a strong hit (a query topic in
 * a memory KEY), the semantic leg is skipped entirely.
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

/** Default deadline for the turn-path semantic leg, in milliseconds. */
export const DEFAULT_SEMANTIC_BUDGET_MS = 2000;

/**
 * Resolve the semantic-leg budget: the deps override wins; otherwise
 * BOBI_MEMORY_SEMANTIC_BUDGET_MS; otherwise the default. Invalid values
 * (non-numeric, negative, empty) fall back to the default. 0 means the
 * semantic leg is skipped entirely (text-only recall).
 */
export function semanticBudgetMsFor(
  deps: Pick<ProactiveRecallDeps, "semanticBudgetMs">,
): number {
  if (deps.semanticBudgetMs !== undefined) {
    return Number.isFinite(deps.semanticBudgetMs) && deps.semanticBudgetMs >= 0
      ? deps.semanticBudgetMs
      : DEFAULT_SEMANTIC_BUDGET_MS;
  }
  const raw = process.env.BOBI_MEMORY_SEMANTIC_BUDGET_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return DEFAULT_SEMANTIC_BUDGET_MS;
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
  /**
   * Deadline for the semantic leg, in ms (test seam, mirroring nowMs /
   * limit). When absent, BOBI_MEMORY_SEMANTIC_BUDGET_MS applies, then
   * DEFAULT_SEMANTIC_BUDGET_MS. 0 skips the semantic leg entirely.
   */
  semanticBudgetMs?: number;
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

interface TopicRankEntry {
  key: string;
  /** How many query topics appear in the memory's KEY (strongest signal). */
  keyHits: number;
  /** How many query topics appear only in the memory's content. */
  hits: number;
}

/**
 * Scored variant of rankByTopics: same ranking, but each entry keeps its
 * hit counts so callers (the strong-hit decision in recallFor) can see
 * WHY a memory ranked where it did.
 */
function rankByTopicsScored(
  memories: readonly StoredMemory[],
  topics: readonly string[],
  nowMs: number,
): TopicRankEntry[] {
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
    .map((e) => ({ key: e.m.key, keyHits: e.keyHits, hits: e.hits }));
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
  return rankByTopicsScored(memories, topics, nowMs).map((e) => e.key);
}

type SemanticRanker = NonNullable<ProactiveRecallDeps["semantic"]>;

/**
 * Run the semantic leg under its deadline. The search promise is wrapped
 * so it can NEVER reject (errors resolve to undefined, exactly the
 * degradation the un-raced code had), and the race subscribes to it —
 * so if the deadline wins, a later rejection is still handled and never
 * surfaces as an unhandled rejection. The underlying embed may keep
 * running in the background after a timeout, bounded by the embedder's
 * own ceiling; the turn simply no longer waits for it.
 */
async function searchSemanticWithinBudget(
  semantic: SemanticRanker,
  userId: string,
  message: string,
  budgetMs: number,
): Promise<Array<{ key: string }> | undefined> {
  const guarded: Promise<Array<{ key: string }> | undefined> = (async () => {
    try {
      return await semantic.search(userId, message, 50);
    } catch {
      return undefined;
    }
  })();
  // Belt-and-braces: an explicit catch on the raced promise, so it can
  // never become an unhandled rejection even if the wrapper above changes.
  void guarded.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const textScored = rankByTopicsScored(memories, topics, nowMs);
  const textRanked = textScored.map((e) => e.key);
  if (textRanked.length === 0 && deps.semantic === undefined) return [];

  const lists: string[][] = [textRanked];
  if (deps.semantic !== undefined) {
    // Strong-text skip: the ranking sorts key hits first, so a top entry
    // with keyHits >= 1 means a query topic appears in a memory KEY —
    // the strongest topical signal this ranker has. The semantic leg
    // cannot improve on that enough to justify its round-trip.
    const strongTextHit = textScored.length > 0 && textScored[0]!.keyHits >= 1;
    const budgetMs = semanticBudgetMsFor(deps);
    if (!strongTextHit && budgetMs > 0) {
      // Deadline-bounded: on timeout this resolves undefined and recall
      // proceeds with the text + recency lists, exactly as if semantic
      // had returned undefined. Semantic failure likewise resolves
      // undefined inside the helper and never breaks proactive recall.
      const hits = await searchSemanticWithinBudget(
        deps.semantic,
        userId,
        message,
        budgetMs,
      );
      if (hits !== undefined && hits.length > 0) lists.push(hits.map((h) => h.key));
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
