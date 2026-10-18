/**
 * Deterministic follow-up intent extractor (Stage-3 differentiator).
 *
 * When the user says something like «فردا یادم بنداز قسط رو بدم», that intent
 * usually dies in chat history. This module detects it with rules — no model
 * call — and proposes a { text, dueAtMs } pair the caller can store via
 * NudgeTracker.note().
 *
 * A model-based extractor is a documented future upgrade (see
 * docs/phase-nudges.md): rules cover the common Persian phrasings cheaply and
 * deterministically; a model would add recall for paraphrases at the cost of
 * latency and nondeterminism.
 *
 * SECURITY:
 * - The extractor reads ONE message the user just sent; it never scans other
 *   users' messages or history. Wiring it per-turn keeps the blast radius at
 *   the current turn's own text.
 * - A match requires an explicit intent phrase; greetings, questions about
 *   the past («یادته؟», «یادم هست») and «فراموش کردم» are excluded by
 *   negative guards, so the bot does not invent follow-ups the user never
 *   asked for.
 */
import { DEFAULT_NUDGE_TIMEZONE, normalizeFa, parsePersianWhen } from "./time_fa";
import { MAX_NUDGE_TEXT_LENGTH } from "./tracker";

export interface ExtractedNudge {
  /** The thing to follow up on, cleaned of the trigger phrase. */
  text: string;
  /** Epoch ms when it is due. */
  dueAtMs: number;
}

/** Explicit "remind me" phrasings. Order matters: longer phrases first. */
const INTENT_PATTERNS: readonly RegExp[] = [
  /یادم بنداز/,
  /یادآوری کن/,
  /یادآور ب(ذار|زار|گذار)/,
  /پیگیری کن/,
  /یادت نره/,
  /فراموش نکن/,
  /به(م|ش) یادآوری کن/,
  /(فردا|امروز|پس ?فردا) (به(م|ش) )?بگو/,
  /بگو (فردا|پس ?فردا)/,
];

/**
 * Phrasings that LOOK like a reminder but are not a request: statements of
 * memory, questions about the past, admissions of forgetting. Any match here
 * vetoes the extraction even if an intent pattern also matched.
 */
const NEGATIVE_GUARDS: readonly RegExp[] = [
  /یادم (هست|بود|میاد)/,
  /یادته/,
  /یادم (رفت|رفته)/,
  /فراموش (کردم|شده|شد)/,
  /یادم نمیاد/,
];

/** Time expressions, stripped from the message when building the nudge text. */
const TIME_STRIP_PATTERNS: readonly RegExp[] = [
  /پس ?فردا/g,
  /فردا/g,
  /امروز/g,
  /هفته ?ی? ?(بعد|آینده)/g,
  /ماه ?ی? ?(بعد|آینده)/g,
  /ساعت [^\s]+(?::[^\s]+)?/g,
  /\d+ (روز|هفته|ماه) (دیگه|دیگر|بعد|آینده)/g,
];

/** Default due time when the user names no time: tomorrow 09:00 local. */
function defaultDueAtMs(nowMs: number, timeZone: string): number {
  return parsePersianWhen("فردا", nowMs, timeZone) ?? nowMs + 24 * 60 * 60 * 1000;
}

/**
 * Detect follow-up intent in a user message.
 *
 * Returns { text, dueAtMs } or null. `nowMs` and `timeZone` make the due-time
 * computation deterministic for tests; production passes Date.now() and the
 * configured zone.
 */
export function extractFollowup(
  message: string,
  nowMs: number,
  timeZone: string = DEFAULT_NUDGE_TIMEZONE,
): ExtractedNudge | null {
  if (typeof message !== "string") return null;
  const s = normalizeFa(message);
  if (s.length === 0 || s.length > 2000) return null;

  // Negative guards first: never invent a follow-up from a memory statement
  // or a question about the past.
  for (const guard of NEGATIVE_GUARDS) {
    if (guard.test(s)) return null;
  }

  let matchedIntent: RegExp | null = null;
  for (const pattern of INTENT_PATTERNS) {
    if (pattern.test(s)) {
      matchedIntent = pattern;
      break;
    }
  }
  if (matchedIntent === null) return null;

  const dueAtMs = parsePersianWhen(s, nowMs, timeZone) ?? defaultDueAtMs(nowMs, timeZone);

  // The nudge text is the message minus the trigger phrase and any time
  // expression — what remains is the thing to follow up on.
  let text = s;
  text = text.replace(matchedIntent, " ");
  for (const strip of TIME_STRIP_PATTERNS) {
    // Fresh regex each use: the /g flag makes .lastIndex stateful.
    text = text.replace(new RegExp(strip.source, strip.flags), " ");
  }
  text = text.replace(/\s+/g, " ").replace(/^[،.؟!:؛\-–\s]+|[،.؟!:؛\-–\s]+$/g, "").trim();

  // If stripping left nothing («فردا یادم بنداز» with no topic), keep the
  // original message so the reminder is still recognizable in context.
  if (text.length === 0) text = s;
  if (text.length > MAX_NUDGE_TEXT_LENGTH) text = text.slice(0, MAX_NUDGE_TEXT_LENGTH);

  return { text, dueAtMs };
}
