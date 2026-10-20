/**
 * Intent router — deterministic, LLM-free tool suggestion.
 *
 * Given the user's message and the plugin manifest catalog, it answers
 * "which tool(s) is this message almost certainly for?" in microseconds,
 * with zero model calls. The consumer (agent loop / prompt builder, see
 * INTEGRATION.md) uses the hints only as advice: to reorder the tool
 * catalog the model sees (hinted tools first) and to attach a note with
 * pre-extracted args. The full catalog is always passed — hints never
 * remove a tool from what the model sees.
 *
 * Layers, in order:
 *  1. URL detector — every http(s) URL in the text is tested against
 *     every manifest's `triggers.urlPatterns`. A match on a media
 *     platform domain or media file extension is a STRONG hint (0.95).
 *  2. Keyword detectors — every manifest's `triggers.keywordPatterns`
 *     is tested against the whole message (Persian variants included
 *     by the plugin authors). Base confidence 0.8.
 *  3. Argument pre-extraction — for the reference flows the router
 *     also pulls structured args out of the text: reminder dates via
 *     the tools' own Persian datetime parser, binary math expressions
 *     for the calculator, the audio flag for the downloader. A
 *     successfully parsed date lifts a reminder hint to 0.9.
 *
 * The router is a PURE function of (text, catalog): the catalog is a
 * parameter, never an import, so this module stays light and cannot
 * drag the agent or AI layers into a tools consumer. Kill switch:
 * BOBI_INTENT_ROUTER=0 makes detectIntents return [] — the model then
 * works from the full catalog, exactly as before this module existed.
 */
import type { ToolManifest } from "../tools/manifest";
import { parsePersianDateTime, TEHRAN_TZ } from "../tools/persian_datetime";

/** One router suggestion. Consumed as a hint, never as a command. */
export interface IntentHint {
  /** Plugin id (== the Tool's registered name). */
  toolId: string;
  /** 0..1. >= 0.9 is "strong" (see hasStrongIntent). */
  confidence: number;
  /** Best-effort structured args pulled from the text. May be partial. */
  extractedArgs: Record<string, unknown>;
  /** Why this hint fired — for logs and debugging, never user-facing. */
  reason: string;
}

export interface DetectIntentsOptions {
  /** "Now" for relative date parsing. Defaults to the real clock. */
  now?: Date;
  /** Cap on returned hints. Defaults to 3. */
  maxHints?: number;
  /** Timezone for Persian date expressions. Defaults to Asia/Tehran. */
  timezone?: string;
}

/** Convenience env check, kept here so every consumer agrees. */
export function intentRouterEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["BOBI_INTENT_ROUTER"] !== "0";
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gu;
const TRAILING_PUNCT = /[.,;:!?)\]}>»…]+$/u;

/** Social/media domains and file extensions that make a URL "strong". */
const STRONG_URL_HINT = 0.95;
const KEYWORD_HINT = 0.8;
const REMINDER_WITH_DATE = 0.9;
const MATH_EXPRESSION = 0.9;

interface MutableHint {
  toolId: string;
  confidence: number;
  extractedArgs: Record<string, unknown>;
  reason: string;
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return null; // A broken manifest pattern is validate_manifest's job; the router skips it.
  }
}

/** Extract candidate URLs from free text, trimming sentence punctuation. */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCT, "");
    if (url.length > "https://a.b".length) urls.push(url);
  }
  return urls;
}

/**
 * Detect tool intents in a user message.
 *
 * Deterministic and side-effect free. Returns hints sorted by
 * confidence (desc), capped at opts.maxHints (default 3).
 */
export function detectIntents(
  text: string,
  catalog: readonly ToolManifest[],
  opts: DetectIntentsOptions = {},
): IntentHint[] {
  if (!intentRouterEnabled()) return [];
  if (typeof text !== "string" || text.trim().length === 0) return [];

  const maxHints = opts.maxHints ?? 3;
  const byId = new Map<string, MutableHint>();
  const offer = (hint: MutableHint): void => {
    const existing = byId.get(hint.toolId);
    if (existing === undefined) {
      byId.set(hint.toolId, hint);
      return;
    }
    if (hint.confidence > existing.confidence) {
      existing.confidence = hint.confidence;
      existing.reason = hint.reason;
    }
    Object.assign(existing.extractedArgs, hint.extractedArgs);
  };

  // --- Layer 1: URLs -------------------------------------------------------
  const urls = extractUrls(text);
  for (const url of urls) {
    for (const manifest of catalog) {
      const patterns = manifest.triggers?.urlPatterns;
      if (patterns === undefined) continue;
      for (const pattern of patterns) {
        const re = compile(pattern);
        if (re !== null && re.test(url)) {
          const args: Record<string, unknown> = { url };
          if (
            manifest.id === "download_media" &&
            /(?:آهنگ|موسیقی|صوتی|mp3|audio|فقط صدا)/iu.test(text)
          ) {
            args["audio_only"] = true;
          }
          offer({
            toolId: manifest.id,
            confidence: STRONG_URL_HINT,
            extractedArgs: args,
            reason: `URL matches ${manifest.id} urlPattern ${JSON.stringify(pattern)}`,
          });
          break; // one match per tool per URL is enough
        }
      }
    }
  }

  // --- Layer 2: manifest keywords ------------------------------------------
  for (const manifest of catalog) {
    const patterns = manifest.triggers?.keywordPatterns;
    if (patterns === undefined) continue;
    for (const pattern of patterns) {
      const re = compile(pattern);
      if (re !== null && re.test(text)) {
        offer({
          toolId: manifest.id,
          confidence: KEYWORD_HINT,
          extractedArgs: {},
          reason: `keyword match for ${manifest.id}: ${JSON.stringify(pattern)}`,
        });
        break;
      }
    }
  }

  // --- Layer 3: argument pre-extraction ------------------------------------
  const now = opts.now ?? new Date();

  // Reminders: a parsed Persian date/time is the strongest signal that
  // free text is a reminder. Uses the tools' own parser so the router
  // and the tool can never disagree about what "فردا ساعت ۹" means.
  const reminderManifest = catalog.find((m) => m.id === "remind_nl");
  if (reminderManifest !== undefined) {
    let due: Date | null = null;
    try {
      due = parsePersianDateTime(text, now, opts.timezone ?? TEHRAN_TZ);
    } catch {
      due = null; // an unparseable zone/input just means "no date hint"
    }
    if (due !== null) {
      const existing = byId.get("remind_nl");
      offer({
        toolId: "remind_nl",
        confidence: existing !== undefined ? REMINDER_WITH_DATE : 0.7,
        extractedArgs: {
          when: text.trim(),
          text: stripReminderTrigger(text),
          dueAt: due.toISOString(),
        },
        reason: "Persian date/time expression parsed from the message",
      });
    }
  }

  // Calculator: a bare binary expression ("حساب کن ۱۲*۸", "12 * 8 = ?").
  if (catalog.some((m) => m.id === "calculator")) {
    const math = extractBinaryExpression(text);
    if (math !== null) {
      offer({
        toolId: "calculator",
        confidence: MATH_EXPRESSION,
        extractedArgs: { op: math.op, a: math.a, b: math.b },
        reason: `binary arithmetic expression "${math.a} ${math.op} ${math.b}" in the message`,
      });
    }
  }

  const hints = [...byId.values()].sort((x, y) => y.confidence - x.confidence);
  return hints.slice(0, Math.max(0, maxHints)).map((h) => ({
    toolId: h.toolId,
    confidence: h.confidence,
    extractedArgs: h.extractedArgs,
    reason: h.reason,
  }));
}

/** True when any hint is strong enough to narrow the tool catalog. */
export function hasStrongIntent(hints: readonly IntentHint[]): boolean {
  return hints.some((h) => h.confidence >= 0.9);
}

const REMINDER_TRIGGERS: readonly RegExp[] = [
  /یادم\s*بنداز(?:\s+که)?/u,
  /یادآوری\s*کن/u,
  /یاداوری\s*کن/u,
  /\bremind me\b/iu,
  /\bset a reminder\b/iu,
];

/** The reminder body: the message minus its "remind me" trigger phrase. */
function stripReminderTrigger(text: string): string {
  let out = text;
  for (const re of REMINDER_TRIGGERS) out = out.replace(re, " ");
  return out.replace(/\s+/gu, " ").trim();
}

const OP_MAP: Readonly<Record<string, string>> = {
  "+": "add",
  "-": "subtract",
  "*": "multiply",
  x: "multiply",
  "×": "multiply",
  "/": "divide",
  "÷": "divide",
};

const BINARY_EXPR = /(-?\d+(?:[.,]\d+)?)\s*([+\-*/x×÷])\s*(-?\d+(?:[.,]\d+)?)/u;

/** Pull "a <op> b" out of free text (Persian/Arabic digits normalized). */
function extractBinaryExpression(
  text: string,
): { op: string; a: number; b: number } | null {
  const normalized = text
    .replace(/[۰-۹]/gu, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/gu, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const m = BINARY_EXPR.exec(normalized);
  if (m === null) return null;
  const a = Number((m[1] ?? "").replace(",", "."));
  const b = Number((m[3] ?? "").replace(",", "."));
  const op = OP_MAP[m[2] ?? ""];
  if (op === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { op, a, b };
}
