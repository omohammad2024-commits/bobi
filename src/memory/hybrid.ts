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
    .sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )
    .slice(0, Math.max(0, limit))
    .map(([key]) => key);
}
