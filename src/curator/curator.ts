/**
 * Phase D4: memory curator — periodic self-improvement over long-term memories.
 *
 * The curator NEVER mutates memories by itself. review() is read-only: it
 * scans the user's memories through the MemoryProvider and produces
 * Proposal values (data, never instructions). Applying a proposal happens only
 * inside the `curator_decide` tool with an explicit owner "approve" decision,
 * and even there the action comes from the stored proposal row — not from the
 * tool input, and never from model output.
 *
 * Heuristics are deliberately simple, deterministic and dependency-free:
 * normalized-text similarity for duplicates, keyword contradiction hints for
 * stale entries, and segment counting for overloaded entries. A scoring model
 * would be harder to audit and would not beat this for the few dozen entries
 * a single user stores.
 */
import { createHash } from "node:crypto";
import type { MemoryProvider, StoredMemory } from "../memory/provider";
import type { NewEvent } from "../memory/events";

/**
 * Reserved action name for a future scheduler action type.
 *
 * Today the owner schedules a review pass with the EXISTING schedule_task
 * action shape: `{type:"tool", tool:"curate_memories", input:{}}` — the
 * scheduler already dispatches "tool" actions, so no scheduler change was
 * needed. This constant documents the intended short name for when (and if)
 * a dedicated scheduler action is ever added.
 */
export const CURATOR_TASK_ACTION = "curate";

/** Kinds of proposals the curator can raise. "archive" comes from the
 *  Phase-3 summarizer: old memories consolidated into an archive entry,
 *  with the originals proposed for deletion (owner-approved, never silent).
 *  "event" (Phase-5) is an auto-extracted dated-event candidate from the
 *  owner's conversations; "import" (Phase-5) is an item from an imported
 *  memory package that needs the owner's review (conflict, or reviewAll). */
export type ProposalKind = "duplicate" | "stale" | "split" | "archive" | "event" | "import";

/** What applying a proposal would do, as structured data (never code).
 *
 *  "add" (Phase-5) writes a brand-new memory from an import package;
 *  "add_event" (Phase-5) records a dated event through EventStore (which
 *  re-validates) — upsert semantics by the deterministic event key.
 */
export type ProposalAction =
  | { type: "merge"; keepKey: string; removeKeys: string[] }
  | { type: "delete"; keys: string[] }
  | { type: "update"; key: string; newContent: string }
  | { type: "split"; key: string; parts: Array<{ key: string; content: string }> }
  | { type: "add"; key: string; content: string }
  | { type: "add_event"; event: NewEvent };

/**
 * One curator proposal.
 *
 * `id` is deterministic (sha256 of kind + sorted memory keys) so a repeated
 * review of unchanged memories yields the same ids and the proposal store can
 * dedupe re-runs instead of piling up identical proposals. `summaryFa` is the
 * exact old→new diff the owner reads before deciding — approval is informed.
 */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** Memory keys this proposal touches. */
  memoryIds: string[];
  /** Persian one-liner with the exact diff, shown to the owner before approval. */
  summaryFa: string;
  suggestedAction: ProposalAction;
}

/** Persian label for a proposal kind, for owner-facing output. */
export function kindLabelFa(kind: ProposalKind): string {
  switch (kind) {
    case "duplicate":
      return "تکراری";
    case "stale":
      return "قدیمی/متناقض";
    case "split":
      return "تقسیم";
    case "archive":
      return "بایگانی";
    case "event":
      return "رویداد";
    case "import":
      return "ورودی";
  }
}

export interface CuratorDeps {
  provider: MemoryProvider;
}

/** Ceilings, so one review pass stays cheap and bounded. */
const MAX_MEMORIES_SCANNED = 200;
const DUPLICATE_SIMILARITY = 0.75;
const MAX_PROPOSALS = 10;

/** A contradiction hint: [positive phrase, negative phrase] in Persian. */
const CONTRADICTION_HINTS: ReadonlyArray<readonly [string, string]> = [
  ["دوست دارم", "دوست ندارم"],
  ["می‌خوام", "نمی‌خوام"],
  ["میخوام", "نمیخوام"],
  ["می‌خواهم", "نمی‌خواهم"],
  ["هستم", "نیستم"],
  ["است", "نیست"],
  ["می‌کنم", "نمی‌کنم"],
  ["میکنم", "نمیکنم"],
  ["دارم", "ندارم"],
  ["می‌روم", "نمی‌روم"],
  ["میرم", "نمیرم"],
  ["می‌شود", "نمی‌شود"],
  ["میشود", "نمیشود"],
];

/**
 * Tokens that make up the contradiction hints themselves ("دوست"، "دارم"،
 * "ندارم"، ...). Excluded from the shared-topic check: without this, the
 * verb stem inside the hint phrases would trivially collide across unrelated
 * topics ("قهوه دوست دارم" vs "چای دوست ندارم" is not a contradiction).
 */
const HINT_TOKENS: ReadonlySet<string> = new Set(
  CONTRADICTION_HINTS.flatMap(([pos, neg]) => [
    ...normalizeText(pos).split(" "),
    ...normalizeText(neg).split(" "),
  ]),
);
/** Tiny Persian stopword set, so the shared-topic check ignores filler. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "و",
  "به",
  "از",
  "در",
  "که",
  "را",
  "با",
  "برای",
  "این",
  "آن",
  "یک",
  "من",
  "تو",
  "او",
  "ما",
  "است",
  "هست",
  "تا",
  "یا",
  "هم",
  "نه",
  "بله",
  "خیلی",
  "هر",
]);

export class CuratorService {
  constructor(private readonly deps: CuratorDeps) {}

  /**
   * Read-only review pass over the user's memories.
   *
   * Only calls provider.list — there is deliberately no write path on this
   * class, so review() can never mutate a memory no matter what the
   * heuristics produce.
   */
  async review(userId: string): Promise<Proposal[]> {
    const memories = (await this.deps.provider.list(userId, MAX_MEMORIES_SCANNED)).slice();
    // Deterministic order: oldest first, so "keep the newest" is stable and
    // two runs over the same data produce proposals in the same order.
    memories.sort(
      (a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

    const proposals: Proposal[] = [];
    const claimed = new Set<string>(); // memory keys already covered by a proposal

    for (const dup of findDuplicates(memories)) {
      if (dup.memoryIds.some((k) => claimed.has(k))) continue;
      proposals.push(dup);
      dup.memoryIds.forEach((k) => claimed.add(k));
    }
    for (const stale of findStale(memories)) {
      if (stale.memoryIds.some((k) => claimed.has(k))) continue;
      proposals.push(stale);
      stale.memoryIds.forEach((k) => claimed.add(k));
    }
    for (const split of findSplits(memories)) {
      if (claimed.has(split.memoryIds[0]!)) continue;
      proposals.push(split);
      claimed.add(split.memoryIds[0]!);
    }

    return proposals.slice(0, MAX_PROPOSALS);
  }
}

// ---------- duplicate detection ----------

/**
 * Near-duplicate entries: pairwise similarity over normalized text at or
 * above DUPLICATE_SIMILARITY. Similarity is the max of token-Jaccard (order
 * insensitive) and normalized edit similarity (catches small rewrites like
 * "پروژه‌ام" vs "پروژه من"). Proposes merging into the newest entry and
 * deleting the older ones. Keys that normalize to the same string count as
 * identical regardless of similarity.
 */
function findDuplicates(memories: StoredMemory[]): Proposal[] {
  const out: Proposal[] = [];
  const norm = new Map<string, string>();
  for (const m of memories) norm.set(m.key, normalizeText(m.content));

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]!;
      const b = memories[j]!;
      const na = norm.get(a.key)!;
      const nb = norm.get(b.key)!;
      if (na.length === 0 || nb.length === 0) continue;
      if (na !== nb && textSimilarity(na, nb) < DUPLICATE_SIMILARITY) continue;

      // Keep the newest entry; deleting the older ones cannot lose
      // information the kept entry does not already carry.
      const newestFirst = [a, b].sort((x, y) => y.updatedAt - x.updatedAt || (x.key < y.key ? -1 : 1));
      const keep = newestFirst[0]!;
      const remove = newestFirst.slice(1);
      const memoryIds = [keep.key, ...remove.map((m) => m.key)];
      out.push({
        id: proposalId("duplicate", memoryIds),
        kind: "duplicate",
        memoryIds,
        summaryFa:
          `دو حافظه تقریباً یکسان‌اند: «${a.content}» و «${b.content}». ` +
          `پیشنهاد: ادغام و نگه‌داشتن «${keep.key}» با متن «${keep.content}»` +
          (remove.length > 0 ? ` و حذف «${remove.map((m) => m.key).join("، ")}»` : "") +
          `.`,
        suggestedAction: { type: "merge", keepKey: keep.key, removeKeys: remove.map((m) => m.key) },
      });
    }
  }
  return out;
}

// ---------- stale detection ----------

/**
 * Contradicted entries: one memory contains a positive phrase, another the
 * matching negative phrase from CONTRADICTION_HINTS, and both share a
 * significant topic token (so "قهوه دوست دارم" and "چای دوست ندارم" do NOT
 * collide). Proposes deleting the older entry as outdated.
 *
 * This is a keyword heuristic, not a semantic judgement — that is exactly why
 * the proposal needs explicit owner approval before anything is deleted.
 */
function findStale(memories: StoredMemory[]): Proposal[] {
  const out: Proposal[] = [];
  const norm = new Map<string, string>();
  const tokens = new Map<string, Set<string>>();
  for (const m of memories) {
    const n = normalizeText(m.content);
    norm.set(m.key, n);
    tokens.set(m.key, new Set(n.split(" ").filter((t) => t.length > 0)));
  }

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const a = memories[i]!;
      const b = memories[j]!;
      const na = norm.get(a.key)!;
      const nb = norm.get(b.key)!;
      if (!shareTopic(tokens.get(a.key)!, tokens.get(b.key)!)) continue;

      for (const [pos, neg] of CONTRADICTION_HINTS) {
        const aPos = na.includes(pos);
        const bNeg = nb.includes(neg);
        const aNeg = na.includes(neg);
        const bPos = nb.includes(pos);
        const contradicted = (aPos && bNeg) || (aNeg && bPos);
        if (!contradicted) continue;

        // The newer entry wins; the older one is treated as outdated.
        const [older, newer] =
          a.updatedAt <= b.updatedAt ? [a, b] : [b, a];
        out.push({
          id: proposalId("stale", [a.key, b.key]),
          kind: "stale",
          memoryIds: [older.key, newer.key],
          summaryFa:
            `دو حافظه با هم در تضادند: «${older.content}» (قدیمی‌تر) در برابر «${newer.content}» (جدیدتر). ` +
            `پیشنهاد: حذف «${older.key}» چون به‌نظر می‌رسد منسوخ شده است.`,
          suggestedAction: { type: "delete", keys: [older.key] },
        });
        break; // one proposal per pair, whatever the hint was
      }
    }
  }
  return out;
}

/**
 * True when both memories share at least one significant topic token:
 * length ≥ 3, not a stopword, and not part of a contradiction hint phrase
 * (those are the signal, not the topic).
 */
function shareTopic(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) {
    if (t.length >= 3 && !STOPWORDS.has(t) && !HINT_TOKENS.has(t) && b.has(t)) return true;
  }
  return false;
}

// ---------- split detection ----------

/**
 * Overloaded entries: content with several distinct segments (split on
 * newlines/semicolons) that is long enough to deserve its own keys. Proposes
 * replacing the entry with one key per segment.
 */
function findSplits(memories: StoredMemory[]): Proposal[] {
  const out: Proposal[] = [];
  for (const m of memories) {
    const parts = m.content
      .split(/[\n؛;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length < 3 || m.content.length < 200) continue;

    const newParts = parts.map((content, idx) => ({ key: `${m.key}-${idx + 1}`, content }));
    out.push({
      id: proposalId("split", [m.key]),
      kind: "split",
      memoryIds: [m.key],
      summaryFa:
        `حافظهٔ «${m.key}» چند موضوع جدا را در یک متن جمع کرده است (${parts.length} بخش). ` +
        `پیشنهاد: تقسیم به ${newParts.map((p) => `«${p.key}»`).join("، ")} و حذف متن اصلی.`,
      suggestedAction: { type: "split", key: m.key, parts: newParts },
    });
  }
  return out;
}

// ---------- text helpers ----------

/**
 * Normalize text for similarity: fold case, strip punctuation, collapse
 * whitespace. Deterministic and dependency-free.
 */
export function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity of token sets — deterministic, order-insensitive. */
export function jaccard(a: string, b: string): number {
  const sa = new Set(a.split(" ").filter((t) => t.length > 0));
  const sb = new Set(b.split(" ").filter((t) => t.length > 0));
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Combined text similarity in [0,1]: token-Jaccard, refined by normalized
 * edit similarity where it is cheap and useful. Deterministic and
 * dependency-free.
 *
 * The O(n*m) edit matrix runs only for short strings (≤60 chars, where the
 * matrix is trivial) or for longer pairs whose Jaccard is already in the
 * "maybe" band — this bounds the cost of a review pass over many memories.
 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const j = jaccard(a, b);
  if (j >= DUPLICATE_SIMILARITY) return j;
  const longest = Math.max(a.length, b.length);
  const worthRefining = longest <= 60 || j >= MAYBE_BAND;
  return worthRefining ? Math.max(j, editSimilarity(a, b)) : j;
}

/** Jaccard floor below which the edit-similarity tiebreak is not attempted. */
const MAYBE_BAND = 0.4;

/**
 * Normalized Levenshtein similarity in [0,1].
 *
 * Bounded: pairs that cannot reach the duplicate threshold are skipped
 * without computing the matrix (edit distance is at least the length
 * difference), and very long strings fall back to token-Jaccard only — a
 * full matrix over two 2000-char memories would be wasteful.
 */
export function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  if (longest > 500) return 0;
  // similarity >= 0.75 needs distance <= longest/4; distance >= length gap.
  if (Math.abs(a.length - b.length) > longest / 4) return 0;
  return 1 - levenshtein(a, b) / longest;
}

/** Iterative Levenshtein distance, O(min(m,n)) space. */
function levenshtein(a: string, b: string): number {
  // Iterate over the shorter string in the inner loop.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let prev = Array.from({ length: short.length + 1 }, (_, i) => i);
  for (let i = 1; i <= long.length; i++) {
    const cur = new Array<number>(short.length + 1);
    cur[0] = i;
    for (let j = 1; j <= short.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (long[i - 1] === short[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[short.length]!;
}

/** Deterministic proposal id: sha256(kind + sorted keys), hex, 16 chars. */
export function proposalId(kind: ProposalKind, memoryKeys: string[]): string {
  const sorted = [...memoryKeys].sort().join("|");
  const hash = createHash("sha256").update(`${kind}:${sorted}`).digest("hex").slice(0, 16);
  return `cur-${hash}`;
}
