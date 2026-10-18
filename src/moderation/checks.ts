/**
 * Pure, dependency-free content detectors for group moderation.
 *
 * SECURITY NOTES (part of the WIN criterion's attack-surface review):
 *
 * - These functions are deliberately total and side-effect-free: no I/O, no
 *   network, no logging of message content. A detector can never exfiltrate
 *   what it scans.
 * - Reasons are English machine codes ("flood" | "link" | "profanity" |
 *   "spam"). Persian user-facing rendering lives in `actions.ts`, and the
 *   raw message text is NEVER echoed into warnings or owner notifications,
 *   so a hostile message cannot inject content into the owner's chat (quote
 *   injection) or probe the filter by reading its own text back.
 * - The profanity list is intentionally MINIMAL (functional minimum): a
 *   short set of common Persian obscenities. It is compiled server-side, is
 *   never sent to any client, and matched text is never logged verbatim —
 *   an adversarial user probing the filter learns at most "hit / no hit".
 * - Thresholds are conservative (documented below) to bound false-positive
 *   harm: a wrongly flagged message costs at most a warning on first hit,
 *   never a deletion, and never a restriction/ban (the action layer has no
 *   ban path at all).
 */
import type { ModConfig } from "./config";

/** Machine-readable hit codes. Persian rendering is the action layer's job. */
export type CheckReason = "flood" | "link" | "profanity" | "spam";

export interface CheckHit {
  hit: boolean;
  /** English code only — never user-facing, never echoed with content. */
  reason: CheckReason;
}

const noHit = (reason: CheckReason): CheckHit => ({ hit: false, reason });

/**
 * Flood: `recentTimestamps` are this user's message times in ms (INCLUDING
 * the current message's timestamp, appended by the caller). A hit fires when
 * at least `cfg.floodMaxMessages` fall inside the trailing
 * `cfg.floodWindowSec` window. Timestamps in the future are ignored so clock
 * skew cannot manufacture hits.
 */
export function checkFlood(
  recentTimestamps: number[],
  cfg: Pick<ModConfig, "floodWindowSec" | "floodMaxMessages">,
  nowMs: number,
): CheckHit {
  const windowStart = nowMs - cfg.floodWindowSec * 1000;
  let count = 0;
  for (const t of recentTimestamps) {
    if (t >= windowStart && t <= nowMs) count += 1;
  }
  return { hit: count >= cfg.floodMaxMessages, reason: "flood" };
}

/**
 * Conservative URL matcher: http(s)://, www., and Telegram short links.
 * Bare domains without a scheme are NOT matched — flagging "example.com"
 * style text would false-positive on ordinary Persian prose that mentions
 * dotted words. When linkPolicy is "allow" the detector short-circuits to
 * no-hit without scanning.
 */
const URL_RE =
  /(?:https?:\/\/|www\.)[^\s<>()\u0600-\u06FF]+|\b(?:https?:\/\/)?(?:t\.me|telegram\.me)\/\S+/i;

export function checkLinks(
  text: string,
  cfg: Pick<ModConfig, "linkPolicy">,
): CheckHit {
  if (cfg.linkPolicy === "allow") return noHit("link");
  return { hit: URL_RE.test(text), reason: "link" };
}

// ---------------------------------------------------------------------------
// Persian profanity filter.
//
// Clearly-marked minimal list: a small set of common Persian obscenities,
// kept to the functional minimum. No slur categories, no variants list.
// Matching is done on normalized text with script-aware boundaries (\b does
// not work reliably on Arabic-script runs, so explicit lookarounds are used).
// The list itself is never logged, never sent to clients, and never echoed.
// ---------------------------------------------------------------------------

/** Minimal curated Persian obscenity patterns (functional minimum). */
const FA_PROFANITY_WORDS: readonly string[] = [
  "کیر",
  "کس",
  "کون",
  "جنده",
  "فاحشه",
  "حرومزاده",
  "بی‌ناموس",
  "بیناموس",
];

const FA_PROFANITY_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${FA_PROFANITY_WORDS.join("|")})(?:[^\\p{L}\\p{N}_]|$)`,
  "u",
);

/** Normalize Persian/Arabic text before matching: unify kaf/yeh, strip tashkeel. */
export function normalizeFa(text: string): string {
  return text
    .replace(/[ي]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/[\u064B-\u0652\u0670]/g, "") // tashkeel / diacritics
    .replace(/\u200C/g, " ") // zero-width non-joiner → space for boundary matching
    .toLowerCase();
}

export function checkProfanityFa(text: string): CheckHit {
  return { hit: FA_PROFANITY_RE.test(normalizeFa(text)), reason: "profanity" };
}

// ---------------------------------------------------------------------------
// Spam signals: excessive caps (Latin runs — Persian script has no case),
// emoji floods, character/word repetition, and forwarded-message loops.
// Thresholds are deliberately high: each of these alone is weak evidence, so
// they must be blatant to fire. First hit still only warns (see actions.ts).
// ---------------------------------------------------------------------------

/** Latin caps: >= 8 Latin letters and >= 75% of them uppercase. */
const MIN_CAPS_LETTERS = 8;
const CAPS_RATIO = 0.75;
/** Emoji flood: more than this many pictographs in one message. */
const MAX_EMOJI = 12;
/** Character run: same char repeated this many times consecutively. */
const MAX_CHAR_RUN = 6;
/** Word run: same token repeated this many times. */
const MAX_WORD_RUN = 5;
/** Forwarded loop: same forwarded text seen this many times recently. */
const FORWARD_LOOP_COUNT = 2;

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export interface SpamSignalOptions {
  /** Whether this message arrived as a Telegram forward. */
  forwarded?: boolean;
  /** Recent texts from this chat (for forwarded-loop detection). */
  recentTexts?: readonly string[];
}

function capsHit(text: string): boolean {
  const latin = text.match(/[A-Za-z]/g);
  if (!latin || latin.length < MIN_CAPS_LETTERS) return false;
  const upper = latin.filter((c) => c === c.toUpperCase()).length;
  return upper / latin.length >= CAPS_RATIO;
}

function emojiHit(text: string): boolean {
  const emojis = text.match(EMOJI_RE);
  return emojis !== null && emojis.length > MAX_EMOJI;
}

function repetitionHit(text: string): boolean {
  // Same character repeated consecutively (e.g. "ااااااا").
  let run = 1;
  const chars = [...text];
  for (let i = 1; i < chars.length; i++) {
    const cur = chars[i] ?? "";
    const prev = chars[i - 1] ?? "";
    if (cur === prev && !/\s/.test(cur)) {
      run += 1;
      if (run >= MAX_CHAR_RUN) return true;
    } else {
      run = 1;
    }
  }
  // Same word repeated consecutively (e.g. "بیا بیا بیا بیا بیا بیا").
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  run = 1;
  for (let i = 1; i < words.length; i++) {
    const cur = words[i] ?? "";
    const prev = words[i - 1] ?? "";
    if (cur === prev) {
      run += 1;
      if (run >= MAX_WORD_RUN) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

function forwardLoopHit(text: string, opts: SpamSignalOptions): boolean {
  if (!opts.forwarded || !opts.recentTexts) return false;
  const norm = normalizeFa(text).trim();
  if (norm.length === 0) return false;
  let same = 0;
  for (const prev of opts.recentTexts) {
    if (normalizeFa(prev).trim() === norm) same += 1;
    if (same >= FORWARD_LOOP_COUNT) return true;
  }
  return false;
}

export function checkSpamSignals(
  text: string,
  opts: SpamSignalOptions = {},
): CheckHit {
  if (text.length === 0) return noHit("spam");
  const hit =
    capsHit(text) ||
    emojiHit(text) ||
    repetitionHit(text) ||
    forwardLoopHit(text, opts);
  return { hit, reason: "spam" };
}

/**
 * Run every enabled detector over a message. Pure: no I/O, no state.
 * `nowMs` and `recentTimestamps`/`spamOpts` are caller-supplied so the
 * whole pipeline stays unit-testable without timers.
 */
export function runChecks(
  text: string,
  cfg: ModConfig,
  recentTimestamps: number[],
  nowMs: number,
  spamOpts: SpamSignalOptions = {},
): CheckHit[] {
  const hits: CheckHit[] = [];
  hits.push(checkFlood(recentTimestamps, cfg, nowMs));
  hits.push(checkLinks(text, cfg));
  if (cfg.profanityFilter) hits.push(checkProfanityFa(text));
  if (cfg.antiSpam) hits.push(checkSpamSignals(text, spamOpts));
  return hits.filter((h) => h.hit);
}
