/**
 * text_utilities — character/word statistics for a piece of text.
 *
 * Input handling:
 * - A hard cap (64 KB) is enforced by the validator before the tool runs, so
 *   oversized input never reaches this body.
 * - The text is never written to storage, logs, or an error message. Only
 *   derived counts leave this tool, so paste-once text does not persist.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const TEXT_UTILITIES_PERMISSION = "tools:text_utilities";

/** Hard upper bound on characters accepted in one call. */
export const MAX_TEXT_LENGTH = 65_536;

export interface TextInput {
  text: string;
}

export interface TextOutput {
  characters: number;
  charactersNoSpaces: number;
  words: number;
  lines: number;
  sentences: number;
  longestWord: string | null;
}

export const textUtilitiesManifest: ToolManifest = defineManifest({
  id: "text_utilities",
  version: "1.0.0",
  title: "Text Utilities",
  description: "Character/word counts and simple text statistics.",
  outputSummary: "Character, word, line, sentence and longest-word counts.",
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
  description: "Character/word counts and simple text statistics.",
  enabled: true,
  permission: { requires: [TEXT_UTILITIES_PERMISSION] },
  toolset: "utils",
  input: {
    fields: {
      text: {
        type: "string",
        required: true,
        description: "The text to analyse.",
        minLength: 1,
        maxLength: MAX_TEXT_LENGTH,
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

    // Length alone is not content: whitespace-only input is rejected here
    // rather than reported as a valid zero-word analysis.
    if (text.trim().length === 0) {
      throw new ToolError("invalid_input", "Text is empty.", { limit: 0 });
    }

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
  },
};

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
