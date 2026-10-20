/**
 * Contradiction handling for extracted facts (memory-core upgrade).
 *
 * The store already handles two cases: a restated fact under the SAME
 * deterministic key replaces in place, and an explicit correction
 * («نه، اشتباه گفتی») replaces its Jaccard target (auto_extract.ts). The
 * gap: a fact re-stated with a DIFFERENT topic phrasing — «شهر محل زندگیم
 * تهرانه» today, «ساکن مشهدم» next month — lands under a different
 * topic-hash key, and both contradictory values live on at equal rank.
 *
 * This module closes the gap at write time: before a new fact is stored,
 * stored facts of the SAME kind whose content overlaps it (token Jaccard
 * ≥ 0.3 — they share the predicate — but which are not the same statement)
 * are marked SUPERSEDED, then the new fact is stored.
 *
 * Schema reality (reported, not hacked): the memories table has no
 * metadata or superseded column, and importance is an INTEGER 1-5 —
 * the design sketch's "importance 0.05 + tag" is realized as the closest
 * existing primitives: the old row is MOVED to a `superseded:<key>` key
 * (out of the `fact:` namespace, so fact lookups and merges skip it) at
 * importance 1 (the floor). Nothing is deleted — the superseded value
 * stays auditable until consolidation's prune eventually summarizes it.
 * Same-key restatements keep the existing in-place replace semantics.
 *
 * Logging: the injected logger receives subject + keys only — never a
 * memory value — matching the codebase's no-content-in-logs rule.
 */
import type { FactCandidate } from "./auto_extract";
import { normalizeMemoryText, tokenJaccard } from "./hybrid";
import type { MemoryProvider, StoredMemory } from "./provider";

/**
 * Content overlap at/above this (same kind) with a different value ⇒ the
 * stored fact is contradicted. 0.3 is deliberately looser than the
 * correction targeter (0.4): contradictions share the predicate, not the
 * value, so their token overlap is lower.
 */
export const CONTRADICTION_JACCARD_MIN = 0.3;

/** Key prefix for superseded tombstones. */
export const SUPERSEDED_PREFIX = "superseded:";

/** What the logger sees: subject identifiers only, never values. */
export interface SupersessionLogEntry {
  userId: string;
  /** The fact kind (the "predicate family"), e.g. "preference". */
  kind: string;
  supersededKey: string;
  newKey: string;
}

export type SupersessionLogger = (entry: SupersessionLogEntry) => void;

/** The fact kind encoded in a stored memory's key, if it is a fact key. */
export function factKindOfKey(key: string): string | undefined {
  if (key === "fact:name") return "name";
  const m = /^fact:([a-z]+):/.exec(key);
  return m?.[1];
}

/**
 * Stored facts contradicted by this candidate: same kind, different key,
 * content overlaps the predicate (Jaccard ≥ floor) but is not the same
 * statement after normalization.
 */
export function findContradictions(
  candidate: FactCandidate,
  existing: readonly StoredMemory[],
): StoredMemory[] {
  const candNorm = normalizeMemoryText(candidate.content);
  return existing.filter((m) => {
    if (m.key === candidate.key) return false; // same key = in-place replace
    if (m.key.startsWith(SUPERSEDED_PREFIX)) return false;
    if (factKindOfKey(m.key) !== candidate.kind) return false;
    if (normalizeMemoryText(m.content) === candNorm) return false;
    return tokenJaccard(candidate.content, m.content) >= CONTRADICTION_JACCARD_MIN;
  });
}

export interface ApplyFactResult {
  /** The candidate was stored at its key. */
  stored: boolean;
  /** Keys of the facts this store superseded. */
  superseded: string[];
}

/**
 * Store a fact candidate, superseding stored facts it contradicts.
 *
 * Corrections (candidate.isCorrection) are NOT handled here — they have
 * their own replace-target path through the curator (`findCorrectionTarget`
 * + proposal apply), and are refused loudly rather than double-applied.
 */
export async function applyFactCandidate(
  provider: MemoryProvider,
  userId: string,
  candidate: FactCandidate,
  log?: SupersessionLogger,
  nowMs: number = Date.now(),
): Promise<ApplyFactResult> {
  if (candidate.isCorrection) {
    throw new Error(
      "applyFactCandidate: corrections go through findCorrectionTarget, not supersession",
    );
  }
  const existing = await provider.list(userId, 200);
  const conflicts = findContradictions(candidate, existing);

  const superseded: string[] = [];
  for (const old of conflicts) {
    let tombKey = `${SUPERSEDED_PREFIX}${old.key}`;
    if ((await provider.get(userId, tombKey)) !== undefined) {
      tombKey = `${tombKey}:${nowMs}`;
    }
    await provider.upsert(userId, tombKey, old.content, { importance: 1 });
    await provider.delete(userId, old.key);
    superseded.push(old.key);
    log?.({
      userId,
      kind: candidate.kind,
      supersededKey: old.key,
      newKey: candidate.key,
    });
  }

  await provider.upsert(userId, candidate.key, candidate.content, {
    importance: candidate.importance,
  });
  return { stored: true, superseded };
}
