/**
 * Memory consolidation pass (memory-core upgrade).
 *
 * Retrieval-time helpers (hybrid.ts) already dedupe, rank by
 * recency/importance and plan summarize-then-drop prunes — but nothing ever
 * REPAIRS the store itself: near-duplicates pile up under different keys,
 * stale trivial facts keep their write-time importance forever, and
 * frequently-recalled facts are never promoted. This module is that sweep.
 * It runs on demand (and is shaped to be called from a scheduler) and every
 * write goes through the MemoryProvider interface — no SQL here.
 *
 * Scale note: the store's importance is an INTEGER 1-5 (see provider.ts),
 * not the 0-1 float of the design sketch. The rules below are the faithful
 * scale mapping of that sketch:
 *  - pinned tier = importance ≥ 4 (normalized ≥ 0.8): identity/preference/
 *    name-class facts. They NEVER decay.
 *  - decay = one importance step per run for memories untouched > 90 days,
 *    floor 1 (normalized 0.2 ≈ the sketch's 0.1 floor, quantized).
 *  - promote = a pure function of recallCount (see below), so it is
 *    idempotent by construction rather than +1 per run.
 *  - merge importance = normalized sum, capped: min(5, round(Σ imp)).
 *
 * Store notes (schema 22): the memories table now HAS recall_count /
 * last_recalled_at columns and the SQLite provider carries both on its
 * records, so promotion below is live for it (and stays dormant for
 * providers whose records omit recallCount). "Untouched" = max(updatedAt,
 * lastRecalledAt): a memory recalled yesterday is not stale even if it was
 * written a year ago. provider.upsert still bumps updatedAt, so a decayed
 * row re-arms its own 90-day staleness clock; that is the intended "one
 * decay step per run" cadence.
 *
 * Kill switch: BOBI_MEMORY_CONSOLIDATE=0 disables the pass entirely.
 */
import type { MemoryProvider, StoredMemory } from "./provider";
import {
  buildPrunePlan,
  DEDUP_JACCARD_THRESHOLD,
  memoryImportance,
  normalizeMemoryText,
  tokenJaccard,
} from "./hybrid";

/** A memory as consolidation sees it: the stored row plus recall telemetry. */
export type ConsolidationMemory = StoredMemory & {
  /** Recall count, when the backing store tracks one (schema 22 does). */
  recallCount?: number;
  /** Last recall time (unix ms), when the backing store tracks one. */
  lastRecalledAt?: number;
};

export interface ConsolidationReport {
  /** True when the kill switch short-circuited the pass. */
  disabled: boolean;
  /** Rows removed by merging near-duplicate clusters. */
  merged: number;
  /** Rows whose importance dropped one step for staleness. */
  decayed: number;
  /** Rows promoted because they are recalled often. */
  promoted: number;
  /** Rows summarize-then-dropped by the prune plan. */
  pruned: number;
}

export interface ConsolidationOptions {
  /** Fixed clock for tests; defaults to Date.now(). */
  nowMs?: number;
  /** Untouched longer than this (days) ⇒ decay-eligible. Default 90. */
  decayAfterDays?: number;
  /** How many memories to load per pass. Default 200 (the store's cap). */
  limit?: number;
  /** Run the summarize-then-drop prune after merge/decay. Default true. */
  prune?: boolean;
}

/** Importance at/above this is the pinned tier: never decays. */
export const PINNED_IMPORTANCE = 4;
/** Decay floor: nothing sinks below this. */
export const DECAY_FLOOR = 1;
/** Key prefixes consolidation never merges (episodes, superseded tombstones). */
const MERGE_EXEMPT_PREFIXES = ["episode:", "superseded:"];

export function isConsolidationEnabled(): boolean {
  return process.env.BOBI_MEMORY_CONSOLIDATE !== "0";
}

/**
 * The importance a recall count earns, as a pure function: recallCount 3-5
 * ⇒ 3, 6-8 ⇒ 4, ≥9 ⇒ 5, below 3 ⇒ no promotion (0 = "leave as is").
 * Pure ⇒ running consolidation twice promotes nothing the second time.
 */
export function promotionTarget(recallCount: number | undefined): number {
  if (recallCount === undefined || recallCount < 3) return 0;
  return Math.min(5, 2 + Math.ceil(recallCount / 3));
}

/** Normalized-sum merge importance: min(5, round(Σ imp)), at least the max. */
function mergedImportance(members: readonly ConsolidationMemory[]): number {
  const sum = members.reduce((acc, m) => acc + memoryImportance(m) / 5, 0);
  const summed = Math.round(5 * Math.min(1, sum));
  const max = Math.max(...members.map((m) => memoryImportance(m)));
  return Math.min(5, Math.max(max, summed));
}

/** The richer text of a cluster: longest normalized content; ties → newest. */
function richerText(members: readonly ConsolidationMemory[]): string {
  return [...members].sort((a, b) => {
    const la = normalizeMemoryText(a.content).length;
    const lb = normalizeMemoryText(b.content).length;
    if (la !== lb) return lb - la;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  })[0]!.content;
}

/** Union-find clusters of near-identical contents (Jaccard ≥ threshold). */
function clusterNearDuplicates(
  memories: readonly ConsolidationMemory[],
): ConsolidationMemory[][] {
  const eligible = memories.filter(
    (m) => !MERGE_EXEMPT_PREFIXES.some((p) => m.key.startsWith(p)),
  );
  const parent = eligible.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    return r;
  };
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (find(i) === find(j)) continue;
      if (tokenJaccard(eligible[i]!.content, eligible[j]!.content) >= DEDUP_JACCARD_THRESHOLD) {
        parent[find(j)] = find(i);
      }
    }
  }
  const groups = new Map<number, ConsolidationMemory[]>();
  eligible.forEach((m, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(m);
    else groups.set(root, [m]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * Run one consolidation pass over one user's memories.
 *
 * Order matters: merge first (so decay/prune judge the surviving rows),
 * then promote, then decay, then the existing summarize-then-drop prune.
 * Merging into the EARLIEST-created row's key preserves the earliest
 * createdAt for free — the store's upsert never rewrites created_at.
 */
export async function consolidateMemories(
  provider: MemoryProvider,
  userId: string,
  opts: ConsolidationOptions = {},
): Promise<ConsolidationReport> {
  const report: ConsolidationReport = {
    disabled: false,
    merged: 0,
    decayed: 0,
    promoted: 0,
    pruned: 0,
  };
  if (!isConsolidationEnabled()) return { ...report, disabled: true };

  const nowMs = opts.nowMs ?? Date.now();
  const decayAfterMs = (opts.decayAfterDays ?? 90) * 24 * 60 * 60 * 1000;
  const all = (await provider.list(userId, opts.limit ?? 200)) as ConsolidationMemory[];
  if (all.length === 0) return report;

  // ---- merge near-duplicates -------------------------------------------
  const gone = new Set<string>();
  for (const cluster of clusterNearDuplicates(all)) {
    const target = [...cluster].sort(
      (a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : 1),
    )[0]!;
    await provider.upsert(userId, target.key, richerText(cluster), {
      importance: mergedImportance(cluster),
    });
    for (const m of cluster) {
      if (m.key === target.key) continue;
      if (await provider.delete(userId, m.key)) {
        gone.add(m.key);
        report.merged += 1;
      }
    }
  }
  const survivors = all.filter((m) => !gone.has(m.key));

  // ---- promote frequently-recalled --------------------------------------
  const promotedKeys = new Set<string>();
  for (const m of survivors) {
    const target = promotionTarget(m.recallCount);
    if (target > memoryImportance(m)) {
      await provider.upsert(userId, m.key, m.content, { importance: target });
      promotedKeys.add(m.key);
      report.promoted += 1;
    }
  }

  // ---- decay stale, unpinned --------------------------------------------
  const decayedKeys = new Set<string>();
  for (const m of survivors) {
    if (promotedKeys.has(m.key)) continue;
    const imp = memoryImportance(m);
    if (imp >= PINNED_IMPORTANCE) continue; // pinned tier never decays
    // "Untouched" counts recalls as touches (schema 22 telemetry): a memory
    // the assistant keeps surfacing is in use, however old its last edit is.
    const lastTouched = Math.max(m.updatedAt, m.lastRecalledAt ?? 0);
    if (nowMs - lastTouched <= decayAfterMs) continue; // still fresh
    const next = Math.max(DECAY_FLOOR, imp - 1);
    if (next < imp) {
      await provider.upsert(userId, m.key, m.content, { importance: next });
      decayedKeys.add(m.key);
      report.decayed += 1;
    }
  }

  // ---- prune (existing summarize-then-drop policy) -----------------------
  if ((opts.prune ?? true) && provider.pruneMemories !== undefined) {
    const remaining = survivors.map((m) =>
      decayedKeys.has(m.key)
        ? { ...m, importance: Math.max(DECAY_FLOOR, memoryImportance(m) - 1) }
        : m,
    );
    const plan = buildPrunePlan(remaining, nowMs);
    if (plan.drop.length > 0) {
      report.pruned = await provider.pruneMemories(
        userId,
        plan.drop.map((d) => ({ key: d.key, summary: d.summary })),
      );
    }
  }

  return report;
}
