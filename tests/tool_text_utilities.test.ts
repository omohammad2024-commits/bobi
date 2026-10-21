/**
 * text_utilities (Phase 8, Unit C) — real transforms, not just counts.
 *
 * Pins:
 * - "stats" (the default when `action` is omitted) returns EXACTLY the
 *   pre-transform output shape, unchanged.
 * - Every transform action actually transforms: uppercase, lowercase,
 *   title_case, trim, collapse_spaces, remove_empty_lines, reverse.
 * - Persian text survives case actions unchanged and reverses by code
 *   point — an emoji (surrogate pair) and a ZWNJ sequence are never split
 *   into invalid text.
 * - Whitespace-only input is rejected ONLY for stats; whitespace-only
 *   input to trim / collapse_spaces honestly returns "".
 * - Unknown actions are rejected by validation, oversize input is still
 *   rejected, and an error never echoes the input text.
 */
import { describe, expect, test } from "bun:test";
import { ToolExecutor } from "../src/tools/executor";
import { ToolRegistry } from "../src/tools/registry";
import type { Tool, ToolActor, ToolContext, ToolRunResult } from "../src/tools/types";
import { ToolError } from "../src/tools/errors";
import {
  textUtilitiesTool,
  type TextStatsOutput,
  type TextTransformOutput,
} from "../src/tools/text_utilities";

function ctx(): ToolContext {
  return {
    clock: () => new Date(0),
    actor: { userId: "u1", permissions: [] },
    signal: new AbortController().signal,
  };
}

async function direct(input: unknown): Promise<TextStatsOutput | TextTransformOutput> {
  return textUtilitiesTool.run(input as never, ctx());
}

async function directError(input: unknown): Promise<ToolError> {
  try {
    await textUtilitiesTool.run(input as never, ctx());
  } catch (err) {
    return err as ToolError;
  }
  throw new Error("expected the tool to throw");
}

// ---------- stats: the original shape, unchanged ----------

describe("text_utilities stats", () => {
  test("default action (omitted) returns exactly the stats shape", async () => {
    const r = (await direct({ text: "Hello world. Hello BOBI!" })) as TextStatsOutput;
    expect(Object.keys(r).sort()).toEqual([
      "characters",
      "charactersNoSpaces",
      "lines",
      "longestWord",
      "sentences",
      "words",
    ]);
    expect(r.characters).toBe("Hello world. Hello BOBI!".length);
    expect(r.words).toBe(4);
    expect(r.sentences).toBe(2);
    expect(r.longestWord).toBe("world.");
  });

  test("explicit stats matches the default and counts Persian words", async () => {
    const a = await direct({ text: "سلام دنیا" });
    const b = await direct({ text: "سلام دنیا", action: "stats" });
    expect(b).toEqual(a);
    expect((b as TextStatsOutput).words).toBe(2);
    expect((b as TextStatsOutput).characters).toBe("سلام دنیا".length);
  });

  test("whitespace-only stats is still rejected", async () => {
    const err = await directError({ text: "   \n\t  " });
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe("Text is empty.");
    const errExplicit = await directError({ text: "   ", action: "stats" });
    expect(errExplicit.kind).toBe("invalid_input");
  });
});

// ---------- transforms ----------

describe("text_utilities transforms", () => {
  test("uppercase transforms Latin and leaves Persian unchanged", async () => {
    const r = (await direct({
      text: "hello World سلام دنیا",
      action: "uppercase",
    })) as TextTransformOutput;
    expect(r.action).toBe("uppercase");
    expect(r.result).toBe("HELLO WORLD سلام دنیا");
    expect(r.characters).toBe(r.result.length);
    expect(Object.keys(r).sort()).toEqual(["action", "characters", "result"]);
  });

  test("uppercase on Persian-only text is an unchanged no-op, not corruption", async () => {
    const r = (await direct({ text: "سلام دنیا", action: "uppercase" })) as TextTransformOutput;
    expect(r.result).toBe("سلام دنیا");
  });

  test("lowercase transforms Latin and leaves Persian unchanged", async () => {
    const r = (await direct({
      text: "HELLO World سلام",
      action: "lowercase",
    })) as TextTransformOutput;
    expect(r.result).toBe("hello world سلام");
    expect(r.characters).toBe(r.result.length);
  });

  test("title_case capitalizes Latin words and leaves Persian untouched", async () => {
    const r = (await direct({
      text: "hELLO wORLD from bobi",
      action: "title_case",
    })) as TextTransformOutput;
    expect(r.result).toBe("Hello World From Bobi");

    const mixed = (await direct({
      text: "سلام hello دنیا WORLD",
      action: "title_case",
    })) as TextTransformOutput;
    expect(mixed.result).toBe("سلام Hello دنیا World");
  });

  test("trim removes surrounding whitespace", async () => {
    const r = (await direct({ text: "  hello  \n", action: "trim" })) as TextTransformOutput;
    expect(r.result).toBe("hello");
    expect(r.characters).toBe(5);
  });

  test("whitespace-only trim returns an empty result, not an error", async () => {
    const r = (await direct({ text: "   \n\t  ", action: "trim" })) as TextTransformOutput;
    expect(r.result).toBe("");
    expect(r.characters).toBe(0);
  });

  test("collapse_spaces squeezes every whitespace run to one space", async () => {
    const r = (await direct({
      text: "  a  b\n\n c\t\td  ",
      action: "collapse_spaces",
    })) as TextTransformOutput;
    expect(r.result).toBe("a b c d");
  });

  test("whitespace-only collapse_spaces returns an empty result", async () => {
    const r = (await direct({
      text: "  \n \t ",
      action: "collapse_spaces",
    })) as TextTransformOutput;
    expect(r.result).toBe("");
    expect(r.characters).toBe(0);
  });

  test("remove_empty_lines drops blank and whitespace-only lines, keeps the rest verbatim", async () => {
    const r = (await direct({
      text: "first\n\n\nsecond\n   \n third \n",
      action: "remove_empty_lines",
    })) as TextTransformOutput;
    expect(r.result).toBe("first\nsecond\n third ");
  });

  test("reverse reverses plain text", async () => {
    const r = (await direct({ text: "abc def", action: "reverse" })) as TextTransformOutput;
    expect(r.result).toBe("fed cba");
  });

  test("reverse moves by code points: an emoji survives intact", async () => {
    const r = (await direct({ text: "سلام😀", action: "reverse" })) as TextTransformOutput;
    expect(r.result).toBe("😀مالس");
    // The emoji is still ONE code point and the string is well-formed
    // (no lone surrogates were produced by splitting the pair).
    expect(Array.from(r.result)[0]).toBe("😀");
    expect(Array.from(r.result)).toHaveLength(5);
    expect(r.result.isWellFormed()).toBe(true);
  });

  test("reverse keeps a ZWNJ sequence valid (Persian می‌شود)", async () => {
    const input = "می\u200Cشود"; // می + ZWNJ + شود
    const r = (await direct({ text: input, action: "reverse" })) as TextTransformOutput;
    expect(r.result).toBe("دوش\u200Cیم");
    expect(Array.from(r.result)).toHaveLength(6);
    expect(r.result.isWellFormed()).toBe(true);
  });
});

// ---------- validation & limits (through the executor) ----------

describe("text_utilities validation", () => {
  // A registry holding ONLY this tool: the validation path under test is
  // the executor's, and this suite must not depend on the whole catalog.
  function makeExecutor(): ToolExecutor {
    const reg = new ToolRegistry();
    reg.register(textUtilitiesTool as unknown as Tool<Record<string, unknown>, unknown>);
    return new ToolExecutor({ registry: reg, timeoutMs: 2000 });
  }
  const actor: ToolActor = { userId: "user-1", permissions: ["tools:text_utilities"] };

  async function runViaExecutor(input: unknown): Promise<ToolRunResult> {
    return makeExecutor().execute({ tool: "text_utilities", input, actor });
  }

  test("unknown action is rejected by validation", async () => {
    const r = await runViaExecutor({ text: "hello", action: "shout" });
    expect(r.status).toBe("invalid_input");
  });

  test("unknown action is also rejected for a direct caller", async () => {
    const err = await directError({ text: "hello", action: "shout" });
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe("Invalid action.");
    // The error never echoes the input text.
    expect(err.message).not.toContain("hello");
  });

  test("transforms run through the executor", async () => {
    const r = await runViaExecutor({ text: "make me loud", action: "uppercase" });
    expect(r.status).toBe("ok");
    expect((r.data as TextTransformOutput).result).toBe("MAKE ME LOUD");
  });

  test("oversize input is still rejected, for stats and transforms alike", async () => {
    const big = "a".repeat(65_536 + 1);
    const stats = await runViaExecutor({ text: big });
    expect(stats.status).toBe("invalid_input");
    const upper = await runViaExecutor({ text: big, action: "uppercase" });
    expect(upper.status).toBe("invalid_input");

    const err = await directError({ text: big, action: "reverse" });
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe("Text is too long.");
  });

  test("text at exactly the cap still transforms", async () => {
    const atCap = "a".repeat(65_536);
    const r = await runViaExecutor({ text: atCap, action: "uppercase" });
    expect(r.status).toBe("ok");
    expect((r.data as TextTransformOutput).characters).toBe(65_536);
  });
});
