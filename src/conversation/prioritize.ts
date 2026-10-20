/**
 * Priority-aware history truncation.
 *
 * The old behaviour was naive tail-truncation: keep the last N messages,
 * drop everything older. That drops exactly the wrong things — a correction
 * the user made twenty turns ago, or the name they told the bot — while
 * keeping filler ("باشه", "ok") just because it is recent.
 *
 * `prioritizeHistory` selects which messages fit the budget instead:
 *
 * 1. ALWAYS kept while the budget allows: the rolling summary (a `system`
 *    message), user-stated facts/decisions/corrections, and the message a
 *    correction corrects.
 * 2. The last `recentMessages` messages are kept verbatim.
 * 3. Whatever budget remains is filled from the middle, highest importance
 *    first; the rest is dropped.
 *
 * Correction pairing is structural, not a scoring nicety: when the user
 * corrects the bot ("نه اشتباهه", "that's wrong"), the correction AND the
 * statement it corrects are pinned together. Truncation may drop the pair
 * together under extreme pressure, but it can never drop the correction
 * while keeping the original wrong statement — the pair shares the top
 * score, and ties break toward the newer message (the correction).
 *
 * The function is pure and unit-testable: importance scoring is injectable
 * via `importanceOf` (the memory system can supply its own scores later),
 * while correction pairing always applies on top.
 */
import type { ChatMessage } from "../ai/provider";

/** Pinned: summaries, corrections, and the statements they correct. */
export const PINNED_SCORE = 1;
/** User-stated facts, decisions, preferences. */
export const FACT_SCORE = 0.8;
/** An ordinary conversational turn. */
export const BASE_SCORE = 0.3;
/** Short acknowledgments and other filler. */
export const FILLER_SCORE = 0.1;

/** The user is correcting the bot (or someone) — Persian and English cues. */
const CORRECTION_RES: RegExp[] = [
  /اشتباه|غلط|نادرست|تصحیح|اشتباهه|غلطه/,
  /چرت|دروغ/,
  /نه\s+ببین|وایسا|صبر\s*کن/,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bnot\s+(right|correct)\b/i,
  /that's\s+not\s+(right|correct|what)/i,
  /you('re| are)\s+wrong/i,
  /\bactually\s*,?\s*no\b/i,
];

/** The user states a durable fact, decision, or preference. */
const FACT_RES: RegExp[] = [
  /اسم\s*م|یادت?\s*(باشه|نره)|تصمیم|قرار\s*شد|از\s*این\s*به\s*بعد|ترجیح|دوست\s*دارم|تولد\s*م|ساکن/,
  /\bmy\s+name\s+is\b/i,
  /\bremember\b/i,
  /\bdecided?\b/i,
  /\bdecision\b/i,
  /\bfrom\s+now\s+on\b/i,
  /\bprefer\b/i,
  /\bbirthday\s+is\b/i,
];

/** Whole-message filler: one-word acknowledgments, bare emoji, "ok". */
const FILLER_RE =
  /^(باشه|اوکی|ok+|okay|مرسی|ممنون|thanks|thx|آره|نه|hm+|hmm|👍+|🙏+|❤️+)\.?[!…]*$/i;

/** The engine's marker for an attachments-only turn. */
const ATTACHMENTS_MARKER_RE = /^\[\d+ attachment\(s\)\]$/;

/** True when the message corrects the bot (or someone). Checked first. */
export function isCorrectionMessage(content: string): boolean {
  return CORRECTION_RES.some((re) => re.test(content));
}

/** True when the message states a durable fact, decision, or preference. */
export function isFactOrDecision(content: string): boolean {
  return FACT_RES.some((re) => re.test(content));
}

/** True when the message is low-value filler. */
export function isFiller(content: string): boolean {
  const text = content.trim();
  return text.length <= 2 || FILLER_RE.test(text);
}

/**
 * Importance score for one message. Exported so tests (and a future
 * memory-backed scorer) can call or wrap it.
 *
 * Order matters: a correction that also states the corrected fact ("نه
 * اشتباهه، اسمم ساراست") scores as a correction — pinned, not merely a fact.
 */
export function defaultImportance(
  message: ChatMessage,
  _index: number,
  _history: readonly ChatMessage[],
): number {
  // The rolling summary is the compressed past; dropping it would silently
  // un-remember everything it covers.
  if (message.role === "system") return PINNED_SCORE;
  if (message.role === "tool") return BASE_SCORE;
  const text = message.content;
  if (text.trim().length === 0) return FILLER_SCORE;
  if (isCorrectionMessage(text)) return PINNED_SCORE;
  if (isFactOrDecision(text)) return FACT_SCORE;
  if (ATTACHMENTS_MARKER_RE.test(text.trim())) return BASE_SCORE;
  if (isFiller(text)) return FILLER_SCORE;
  return BASE_SCORE;
}

/** Importance score for one message; higher means "keep first". */
export type ImportanceFn = (
  message: ChatMessage,
  index: number,
  history: readonly ChatMessage[],
) => number;

export interface PrioritizeOptions {
  /** Max messages in the output. */
  budget: number;
  /**
   * How many of the most recent messages to keep verbatim. Defaults to 10
   * (≈ the last 5 turns). Counts messages, not turns.
   */
  recentMessages?: number;
  /**
   * Custom importance scorer. Correction pairing still applies on top of
   * whatever it returns — a correction and its target are always pinned.
   */
  importanceOf?: ImportanceFn;
}

/**
 * Select the `budget` most important messages from `history`, preserving
 * chronological order. Pure: the input is never mutated.
 *
 * Priority order when the budget is tight: pinned (summaries, corrections and
 * their targets) first, then the recent window, then everything else by
 * score. Inside a tier, newer messages win — which is what guarantees a
 * correction survives ahead of the statement it corrects.
 */
export function prioritizeHistory(
  history: readonly ChatMessage[],
  opts: PrioritizeOptions,
): ChatMessage[] {
  const budget = Math.max(0, Math.floor(opts.budget));
  if (history.length <= budget) return [...history];
  if (budget === 0) return [];

  const importanceOf: ImportanceFn = opts.importanceOf ?? defaultImportance;
  const scores = history.map((m, i) => importanceOf(m, i, history));

  // Pin the correction AND the statement it corrects: the pair survives or
  // falls together, never the original alone. The corrected fact usually
  // lives IN the correction itself ("نه اشتباهه، اسمم ساراست"), so the pair
  // surviving together is what keeps the truth in context. This is
  // structural — it applies on top of any custom scorer.
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "user" && isCorrectionMessage(m.content)) {
      scores[i] = Math.max(scores[i]!, PINNED_SCORE);
      if (i > 0) scores[i - 1] = Math.max(scores[i - 1]!, PINNED_SCORE);
    }
  }

  const recentCount = opts.recentMessages ?? 10;
  const recentFrom = Math.max(0, history.length - recentCount);
  const isRecent = (i: number): boolean => i >= recentFrom;
  const isPinned = (i: number): boolean => scores[i]! >= PINNED_SCORE;

  const order = history
    .map((_, i) => i)
    .sort((a, b) => {
      const tierA = isPinned(a) ? 0 : isRecent(a) ? 1 : 2;
      const tierB = isPinned(b) ? 0 : isRecent(b) ? 1 : 2;
      if (tierA !== tierB) return tierA - tierB;
      if (scores[a] !== scores[b]) return scores[b]! - scores[a]!;
      return b - a; // newer first inside a tier
    });

  const kept = order.slice(0, budget).sort((a, b) => a - b);
  return kept.map((i) => history[i]!);
}
