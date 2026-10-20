/**
 * Hybrid FTS+vector memory ranking (Phase 5).
 *
 * When both signals exist — the deterministic substring ranking and the
 * vector-similarity ranking — they are fused with Reciprocal Rank Fusion
 * (RRF) instead of picking either/or.
 *
 * Why RRF and not a weighted score: the two signals live on incomparable
 * scales (cosine similarity in -1..1, a boolean substring match with
 * key-before-content tiers), so any weighting would need tuned constants
 * that drift with the embedding model. RRF fuses RANKINGS, not scores: each
 * list contributes 1/(k + rank), which needs no tuning, is deterministic,
 * and has the property the product wants — a memory matching BOTH signals
 * outranks a memory matching only one.
 *
 * Pure and dependency-free, so the fusion rule is unit-testable without a
 * database or an embedder.
 */

/**
 * The RRF dampening constant (Cormack et al., SIGIR 2009). The standard 60:
 * large enough that rank differences deep in a list barely matter, small
 * enough that top ranks dominate.
 */
export const RRF_K = 60;

/** One fused entry with its raw RRF score, before any adjustment. */
export interface FusedScore {
  key: string;
  score: number;
}

/**
 * Fuse ranked key lists, returning each key with its raw RRF score, best
 * first. `reciprocalRankFusion` is this with the scores dropped — the
 * ordering behavior is identical.
 */
export function reciprocalRankFusionWithScores(
  lists: ReadonlyArray<ReadonlyArray<string>>,
  limit: number,
  k: number = RRF_K,
): FusedScore[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((key, rank) => {
      // A list ranks each key once; a duplicate further down is ignored.
      if (seen.has(key)) return;
      seen.add(key);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort(
      (a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, Math.max(0, limit));
}

/**
 * Fuse ranked key lists into one ordering, best first.
 *
 * Each input list is a ranking (best first) of memory keys; a list may omit
 * keys or be empty. A key's fused score is the sum of 1/(k + rank) over the
 * lists that rank it. Ties break by key ascending, so the output is fully
 * deterministic for a given input.
 */
export function reciprocalRankFusion(
  lists: ReadonlyArray<ReadonlyArray<string>>,
  limit: number,
  k: number = RRF_K,
): string[] {
  return reciprocalRankFusionWithScores(lists, limit, k).map((e) => e.key);
}

/**
 * Maximum relative boost the recency/importance adjustment can apply.
 *
 * 0.05: under maximum contrast (fresh importance-5 vs ancient
 * importance-1) a memory can make up roughly one rank of RRF relevance —
 * recency and importance nudge the order, they never override a clearly
 * more relevant match.
 */
export const RECENCY_IMPORTANCE_BOOST = 0.05;

/**
 * Principled score adjustment (worker-2): the recency/importance weighting
 * "into the fusion".
 *
 * Each fused RRF score is multiplied by (1 + boost * n), where n is the
 * recencyImportanceScore mapped from (1, 6] into (0, 1]. The RRF scores
 * encode query relevance — the primary signal — so the adjustment only
 * reorders close calls in favor of recent or explicitly-marked-important
 * memories: a fresh importance-5 memory outranks an older coincidental
 * match one rank above it, but a memory matching both text and vector
 * signals still beats a merely-recent one. Deterministic for a fixed
 * nowMs; keys missing from `memories` keep their raw score.
 */
export function boostByRecencyImportance(
  fused: ReadonlyArray<FusedScore>,
  memories: ReadonlyArray<{
    key: string;
    importance?: number | null;
    updatedAt: number;
  }>,
  nowMs: number,
): FusedScore[] {
  const byKey = new Map(memories.map((m) => [m.key, m]));
  return fused
    .map((f) => {
      const m = byKey.get(f.key);
      const norm = m !== undefined ? (recencyImportanceScore(m, nowMs) - 1) / 5 : 0;
      return {
        key: f.key,
        score: f.score * (1 + RECENCY_IMPORTANCE_BOOST * norm),
      };
    })
    .sort(
      (a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
}

// ---------------------------------------------------------------------------
// Persian text normalization + query expansion (worker-2: better recall)
// ---------------------------------------------------------------------------

/**
 * Normalize Persian/Arabic text for memory search and dedup.
 *
 * Unifies the ي/ك variants, strips tashkeel/hamza/kashida, turns the
 * zero-width joiners into spaces, maps Persian/Arabic-Indic digits to Latin,
 * collapses whitespace and lowercases. Deterministic and dependency-free.
 */
export function normalizeMemoryText(text: string): string {
  return text
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "") // kashida U+0640
    .replace(/[ً-ٰٓ]/g, "") // tashkeel U+064B–U+0652 + superscript alef U+0670
    .replace(/ٔ/g, "") // hamza above U+0654 («دربارهٔ» → «درباره»)
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[‌‍]/g, " ") // ZWNJ U+200C / ZWJ U+200D → space
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Query expansion for recall: the raw (trimmed, lowercased) query plus its
 * normalized form plus the whitespace-free normalized form, deduplicated.
 *
 * The spaceless variant is what makes «می‌روم» match a stored «میروم» and a
 * half-spaced «می روم» match «میروم» — the single most common Persian recall
 * miss. The caller tests each variant as a substring against both the raw
 * and the normalized memory text.
 */
export function expandQueryVariants(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const out = [q];
  const norm = normalizeMemoryText(q);
  if (norm.length > 0 && norm !== q) out.push(norm);
  const nospace = norm.replace(/\s+/g, "");
  if (nospace.length > 0 && nospace !== norm) out.push(nospace);
  return out;
}

/**
 * Token-set Jaccard similarity between two texts (after Persian
 * normalization). 1 = identical token sets, 0 = disjoint or empty.
 * Deterministic; used by dedup and correction-target matching.
 */
export function tokenJaccard(a: string, b: string): number {
  const sa = new Set(normalizeMemoryText(a).split(" ").filter((t) => t.length > 0));
  const sb = new Set(normalizeMemoryText(b).split(" ").filter((t) => t.length > 0));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const t of small) if (big.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ---------------------------------------------------------------------------
// Recency + importance weighting (worker-2)
// ---------------------------------------------------------------------------

/** Importance scale is 1-5; memories written without a score get this. */
export const DEFAULT_MEMORY_IMPORTANCE = 3;

/** Clamp any stored or supplied importance into the 1-5 scale. */
export function memoryImportance(m: { importance?: number | null }): number {
  const v = m.importance;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MEMORY_IMPORTANCE;
  return Math.min(5, Math.max(1, Math.round(v)));
}

/**
 * Half-life of the recency bonus. A 30-day-old memory keeps about half of
 * its +1 bonus; a 90-day-old one keeps ~1/8.
 */
export const MEMORY_RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Deterministic retrieval score: importance (1..5, the dominant term) plus
 * a recency bonus in (0, 1] decaying exponentially with a 30-day half-life.
 *
 * Recency nudges, it never overrides: a fresh trivial memory (1 + ~1 = 2)
 * can only tie an ancient mild one (2 + ~0 = 2), and a 2-point importance
 * gap always wins regardless of age. Pure arithmetic — unit-testable with a
 * fixed nowMs.
 */
export function recencyImportanceScore(
  m: { importance?: number | null; updatedAt: number },
  nowMs: number,
): number {
  const ageMs = Math.max(0, nowMs - m.updatedAt);
  return memoryImportance(m) + Math.exp(-ageMs / MEMORY_RECENCY_HALF_LIFE_MS);
}

/**
 * Rank memory keys best-first by recency+importance. Deterministic: score
 * desc, then key asc. A standalone ranking helper (e.g. for "show me what
 * matters" views); hybrid recall instead folds the same signal into the
 * fused scores via `boostByRecencyImportance`.
 */
export function rankByRecencyImportance(
  memories: ReadonlyArray<{ key: string; importance?: number | null; updatedAt: number }>,
  nowMs: number,
): string[] {
  return [...memories]
    .map((m) => ({ key: m.key, score: recencyImportanceScore(m, nowMs) }))
    .sort(
      (a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .map((e) => e.key);
}

// ---------------------------------------------------------------------------
// Retrieval-time near-dedup (worker-2)
// ---------------------------------------------------------------------------

/** Token Jaccard at/above this ⇒ the two memories are near-identical. */
export const DEDUP_JACCARD_THRESHOLD = 0.9;

export interface DedupMemory {
  key: string;
  content: string;
  importance?: number | null;
  /** unix ms */
  updatedAt: number;
}

/**
 * Negative ⇒ a is the better survivor; positive ⇒ b is; 0 ⇒ identical.
 * Higher importance wins, then newer, then key ascending (deterministic).
 */
function compareSurvivor<T extends DedupMemory>(a: T, b: T): number {
  const imp = memoryImportance(b) - memoryImportance(a);
  if (imp !== 0) return imp;
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Drop near-identical memories at retrieval time, so the same fact
 * remembered twice surfaces once.
 *
 * Two passes: (1) exact duplicates on normalized content keep the best
 * survivor; (2) pairs with token-set Jaccard ≥ 0.9 keep the best survivor.
 * The Jaccard bound lets us skip pairs whose token counts differ by more
 * than the threshold allows — no false negatives, far fewer comparisons.
 * Order of the survivors is preserved.
 */
export function dedupeNearIdentical<T extends DedupMemory>(
  memories: readonly T[],
): T[] {
  if (memories.length < 2) return [...memories];
  const best = new Map<string, T>();
  for (const m of memories) {
    const n = normalizeMemoryText(m.content);
    const prev = best.get(n);
    if (prev === undefined || compareSurvivor(m, prev) < 0) best.set(n, m);
  }
  const uniq = [...best.values()];
  if (uniq.length < 2) return uniq;
  const tokens = uniq.map((m) =>
    new Set(normalizeMemoryText(m.content).split(" ").filter((t) => t.length > 0)),
  );
  const drop = new Set<number>();
  for (let i = 0; i < uniq.length; i++) {
    if (drop.has(i)) continue;
    for (let j = i + 1; j < uniq.length; j++) {
      if (drop.has(j)) continue;
      const ti = tokens[i]!;
      const tj = tokens[j]!;
      if (ti.size === 0 || tj.size === 0) continue;
      // Jaccard ≥ 0.9 requires the token counts to be within 0.9 of each
      // other; anything further apart cannot qualify — skip it.
      if (Math.min(ti.size, tj.size) / Math.max(ti.size, tj.size) < DEDUP_JACCARD_THRESHOLD) {
        continue;
      }
      let inter = 0;
      const [small, big] = ti.size <= tj.size ? [ti, tj] : [tj, ti];
      for (const t of small) if (big.has(t)) inter++;
      if (inter / (ti.size + tj.size - inter) >= DEDUP_JACCARD_THRESHOLD) {
        drop.add(compareSurvivor(uniq[i]!, uniq[j]!) <= 0 ? j : i);
        if (drop.has(i)) break;
      }
    }
  }
  return uniq.filter((_, i) => !drop.has(i));
}

// ---------------------------------------------------------------------------
// Forgetting policy: summarize-then-drop (worker-2)
// ---------------------------------------------------------------------------

/** One-line summary kept when a trivial memory is pruned. */
export function oneLineSummary(content: string, maxChars = 140): string {
  const first = content.split("\n")[0]!.trim().replace(/\s+/g, " ");
  if (first.length <= maxChars) return first;
  return `${first.slice(0, maxChars - 1).trimEnd()}…`;
}

export interface PruneDrop {
  key: string;
  /** The one-line summary that survives the drop. */
  summary: string;
  score: number;
  ageDays: number;
}

export interface PrunePlan {
  drop: PruneDrop[];
  kept: number;
}

export interface PruneOptions {
  /** Only memories at least this old (days) are eligible. Default 90. */
  minAgeDays?: number;
  /** Only memories at/below this importance are eligible. Default 2. */
  maxTrivialImportance?: number;
  /** Cap on drops per run, so one sweep stays bounded. Default 50. */
  maxDrops?: number;
}

/**
 * Principled forgetting, as a pure function the storage layer executes.
 *
 * Eligible for summarize-then-drop: old AND trivial (importance ≤ 2 and age
 * ≥ 90 days by default). Important memories (≥ 4) are NEVER eligible;
 * neutral (3) ones are kept — forgetting stays conservative. Candidates go
 * worst-first and the run is bounded, so a periodic sweep is cheap and
 * predictable. Deterministic for a fixed nowMs.
 */
export function buildPrunePlan(
  memories: ReadonlyArray<DedupMemory>,
  nowMs: number,
  opts: PruneOptions = {},
): PrunePlan {
  const minAgeMs = (opts.minAgeDays ?? 90) * 24 * 60 * 60 * 1000;
  const maxTrivial = opts.maxTrivialImportance ?? 2;
  const maxDrops = opts.maxDrops ?? 50;
  const eligible = memories
    .filter(
      (m) => memoryImportance(m) <= maxTrivial && nowMs - m.updatedAt >= minAgeMs,
    )
    .map((m) => ({
      key: m.key,
      summary: oneLineSummary(m.content),
      score: recencyImportanceScore(m, nowMs),
      ageDays: Math.floor((nowMs - m.updatedAt) / (24 * 60 * 60 * 1000)),
    }))
    .sort(
      (a, b) => a.score - b.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const drop = eligible.slice(0, Math.max(0, maxDrops));
  return { drop, kept: memories.length - drop.length };
}
