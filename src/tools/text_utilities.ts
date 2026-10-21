/**
 * text_utilities — character/word statistics and simple, fixed text
 * transforms (uppercase, lowercase, title case, trim, collapse spaces,
 * remove empty lines, reverse) for a piece of text.
 *
 * Input handling:
 * - A hard cap (64 KB) is enforced by the validator before the tool runs, so
 *   oversized input never reaches this body.
 * - The text is never written to storage or logs, and never echoed in an
 *   error message. Stats return only derived counts; a transform's result
 *   leaves this tool solely as the normal tool output, so paste-once text
 *   does not persist anywhere else.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const TEXT_UTILITIES_PERMISSION = "tools:text_utilities";

/** Hard upper bound on characters accepted in one call. */
export const MAX_TEXT_LENGTH = 65_536;

/** Every action this tool can perform. "stats" is the default. */
export type TextTransformAction =
  | "uppercase"
  | "lowercase"
  | "title_case"
  | "trim"
  | "collapse_spaces"
  | "remove_empty_lines"
  | "reverse";

export type TextAction = "stats" | TextTransformAction;

export const TEXT_ACTIONS: readonly TextAction[] = [
  "stats",
  "uppercase",
  "lowercase",
  "title_case",
  "trim",
  "collapse_spaces",
  "remove_empty_lines",
  "reverse",
];

export interface TextInput {
  text: string;
  /** What to do with the text. Defaults to "stats" when omitted. */
  action?: TextAction;
}

export interface TextStatsOutput {
  characters: number;
  charactersNoSpaces: number;
  words: number;
  lines: number;
  sentences: number;
  longestWord: string | null;
}

export interface TextTransformOutput {
  action: TextTransformAction;
  result: string;
  characters: number;
}

export type TextOutput = TextStatsOutput | TextTransformOutput;

export const textUtilitiesManifest: ToolManifest = defineManifest({
  id: "text_utilities",
  version: "1.0.0",
  title: "Text Utilities",
  description:
    "Character/word counts and simple text transforms: uppercase, lowercase, title case, trim, collapse spaces, remove empty lines, reverse.",
  purpose: "text counts & transforms",
  useWhen: "counts or case/cleanup asked",
  doNotUseWhen:
    "user wants text rewritten or reworded — this only counts and applies fixed transforms; arithmetic — that is calculator",
  confusableWith: [
    { tool: "calculator", difference: "calculator does arithmetic; this counts and transforms text" },
  ],
  latencyTier: "instant",
  outputSummary: "Stats counts, or the transformed text with its character count.",
  category: "utils",
  triggers: {
    keywordPatterns: [
      "بشمار",
      "تعداد (کلمات|حروف|کاراکتر)",
      "count (the )?(words|characters|letters)",
      "uppercase",
      "lowercase",
    ],
  },
  costTier: "free",
});

export const textUtilitiesTool: Tool<TextInput, TextOutput> = {
  name: "text_utilities",
  manifest: textUtilitiesManifest,
  description:
    "Character/word counts and simple text transforms: uppercase, lowercase, title case, trim, collapse spaces, remove empty lines, reverse.",
  enabled: true,
  permission: { requires: [TEXT_UTILITIES_PERMISSION] },
  toolset: "utils",
  input: {
    fields: {
      text: {
        type: "string",
        required: true,
        description: "The text to analyse or transform.",
        minLength: 1,
        maxLength: MAX_TEXT_LENGTH,
      },
      action: {
        type: "enum",
        required: false,
        description:
          "What to do: stats (default) counts characters/words/lines; the other actions transform the text and return it.",
        choices: TEXT_ACTIONS,
      },
    },
  },

  async run(input: TextInput, _ctx: ToolContext): Promise<TextOutput> {
    const text = input.text;

    if (text.length > MAX_TEXT_LENGTH) {
      throw new ToolError(
        "invalid_input",
        "Text is too long.",
        { limit: MAX_TEXT_LENGTH },
      );
    }

    const action: TextAction = input.action ?? "stats";
    if (!TEXT_ACTIONS.includes(action)) {
      // Defence in depth: the validator rejects unknown actions first, but
      // a direct caller bypassing validation gets a clean error. The action
      // value itself is never echoed back.
      throw new ToolError("invalid_input", "Invalid action.");
    }

    if (action === "stats") {
      // Length alone is not content: whitespace-only input is rejected here
      // rather than reported as a valid zero-word analysis. This rejection
      // applies ONLY to stats — for a transform, an empty result (trimming
      // whitespace-only text down to "") is the honest answer.
      if (text.trim().length === 0) {
        throw new ToolError("invalid_input", "Text is empty.", { limit: 0 });
      }
      return statsFor(text);
    }

    const result = TRANSFORMS[action](text);
    return { action, result, characters: result.length };
  },
};

function statsFor(text: string): TextStatsOutput {
  const words = text
    .split(/\s+/u)
    .filter((w) => w.length > 0 && !isPunctuationOnly(w));

  return {
    characters: text.length,
    charactersNoSpaces: text.replace(/\s/gu, "").length,
    words: words.length,
    lines: countLines(text),
    sentences: countSentences(text),
    longestWord: longest(words),
  };
}

/**
 * The fixed transforms. Pure string → string, no logging, no storage.
 *
 * Case mappings are no-ops on scripts without case (e.g. Persian) and never
 * corrupt them: toUpperCase/toLowerCase only remap cased characters.
 * `reverse` walks code points via Array.from, so a surrogate pair (emoji)
 * is one unit and can never be split into lone surrogates; a ZWNJ is moved
 * as a whole code point, never torn into invalid text.
 */
const TRANSFORMS: Readonly<Record<TextTransformAction, (text: string) => string>> = {
  uppercase: (text) => text.toUpperCase(),
  lowercase: (text) => text.toLowerCase(),
  title_case: (text) => toTitleCase(text),
  trim: (text) => text.trim(),
  collapse_spaces: (text) => text.replace(/\s+/gu, " ").trim(),
  remove_empty_lines: (text) =>
    text
      .split(/\r\n|\r|\n/u)
      .filter((line) => line.trim().length > 0)
      .join("\n"),
  reverse: (text) => Array.from(text).reverse().join(""),
};

/** Latin letters: ASCII plus the Latin-1 / Extended ranges. */
const LATIN_WORD = /[A-Za-zÀ-ÖØ-öø-ÿĀ-ſḀ-ỿ]+/gu;

/** Title-case Latin words only; every other script passes through untouched. */
function toTitleCase(text: string): string {
  return text.replace(LATIN_WORD, (word) => {
    const chars = Array.from(word);
    const first = chars[0];
    if (first === undefined) return word;
    return first.toUpperCase() + chars.slice(1).join("").toLowerCase();
  });
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/[.!?؟…]+/u).filter((s) => s.trim().length > 0).length;
}

/** Words made only of punctuation (e.g. "—" or "…") are not real words. */
function isPunctuationOnly(word: string): boolean {
  return /^[^\p{L}\p{N}]+$/u.test(word);
}

function longest(words: readonly string[]): string | null {
  let best: string | null = null;
  for (const w of words) {
    if (best === null || w.length > best.length) best = w;
  }
  return best;
}
