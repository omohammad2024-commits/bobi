/**
 * Expandable blockquote conversion (Evil-style personality).
 *
 * The agent wraps on-demand long-form content in markdown `> ` blockquotes;
 * this suite proves the converter strips the markers and builds correct
 * Telegram `expandable_blockquote` entities (UTF-16 offsets), and that text
 * without blockquotes passes through byte-identical with no entities.
 */
import { describe, expect, test } from "bun:test";
import {
  blockquoteToEntities,
  replyExpandable,
  stripBlockquoteMarkers,
} from "../src/bot/expandable_quote";

describe("blockquoteToEntities", () => {
  test("no blockquote: text unchanged, no entities", () => {
    const input = "سلام.\nHow are you?";
    const { text, entities } = blockquoteToEntities(input);
    expect(text).toBe(input);
    expect(entities).toEqual([]);
  });

  test("single block becomes one entity with stripped markers", () => {
    const { text, entities } = blockquoteToEntities(
      "Short intro.\n> line one\n> line two\nDone.",
    );
    expect(text).toBe("Short intro.\nline one\nline two\nDone.");
    expect(entities).toHaveLength(1);
    const [e] = entities;
    expect(e!.type).toBe("expandable_blockquote");
    // "Short intro.\n" is 13 UTF-16 units.
    expect(e!.offset).toBe(13);
    expect(e!.length).toBe("line one\nline two".length);
    expect(text.slice(e!.offset, e!.offset + e!.length)).toBe(
      "line one\nline two",
    );
  });

  test("multiple blocks become multiple entities", () => {
    const { text, entities } = blockquoteToEntities(
      "> first\nmiddle\n> second",
    );
    expect(text).toBe("first\nmiddle\nsecond");
    expect(entities).toHaveLength(2);
    expect(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length)).toBe("first");
    expect(text.slice(entities[1]!.offset, entities[1]!.offset + entities[1]!.length)).toBe("second");
  });

  test("offsets are UTF-16 units: emoji and Persian script", () => {
    // 🗿 is a surrogate pair (2 UTF-16 units); Persian is BMP (1 each).
    const { text, entities } = blockquoteToEntities("🗿 چیشده؟\n> سلام دنیا\n> 🗿");
    expect(entities).toHaveLength(1);
    const [e] = entities;
    const expectedOffset = "🗿 چیشده؟\n".length; // surrogate pair counts 2
    expect(e!.offset).toBe(expectedOffset);
    expect(text.slice(e!.offset, e!.offset + e!.length)).toBe("سلام دنیا\n🗿");
  });

  test("blank quote lines stay inside the block", () => {
    const { text, entities } = blockquoteToEntities("> a\n>\n> b");
    expect(text).toBe("a\n\nb");
    expect(entities).toHaveLength(1);
    expect(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length)).toBe("a\n\nb");
  });

  test("a block with no visible content produces no entity", () => {
    const { text, entities } = blockquoteToEntities("hi\n>\n> \nbye");
    expect(text).toBe("hi\n\n\nbye");
    expect(entities).toEqual([]);
  });

  test("marker without trailing space still strips", () => {
    const { text, entities } = blockquoteToEntities(">tight");
    expect(text).toBe("tight");
    expect(entities).toHaveLength(1);
  });

  test("whole message as one quote", () => {
    const { text, entities } = blockquoteToEntities("> everything\n> quoted");
    expect(text).toBe("everything\nquoted");
    expect(entities).toHaveLength(1);
    expect(entities[0]).toEqual({
      type: "expandable_blockquote",
      offset: 0,
      length: text.length,
    });
  });

  test("entities never overlap and stay in order", () => {
    const { entities } = blockquoteToEntities("> a\nx\n> b\ny\n> c");
    expect(entities).toHaveLength(3);
    for (let i = 1; i < entities.length; i++) {
      const prev = entities[i - 1]!;
      expect(entities[i]!.offset).toBeGreaterThanOrEqual(prev.offset + prev.length);
    }
  });
});

describe("stripBlockquoteMarkers", () => {
  test("removes markers for the TTS path", () => {
    expect(stripBlockquoteMarkers("> hello\nworld")).toBe("hello\nworld");
    expect(stripBlockquoteMarkers("plain")).toBe("plain");
  });
});

describe("replyExpandable", () => {
  test("plain text: single-arg reply, no entities", async () => {
    const calls: Array<{ text: string; extra?: unknown }> = [];
    await replyExpandable(
      { reply: async (text: string, extra?: unknown) => { calls.push({ text, extra }); } },
      "just a short reply",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe("just a short reply");
    expect(calls[0]!.extra).toBeUndefined();
  });

  test("quoted text: entities passed explicitly, markers stripped", async () => {
    const calls: Array<{ text: string; extra: { entities?: Array<{ type: string; offset: number; length: number }> } | undefined }> = [];
    await replyExpandable(
      { reply: async (text: string, extra?: { entities?: Array<{ type: string; offset: number; length: number }> }) => { calls.push({ text, extra }); } },
      "Intro\n> detail one\n> detail two",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe("Intro\ndetail one\ndetail two");
    const entities = calls[0]!.extra?.entities ?? [];
    expect(entities).toHaveLength(1);
    expect(entities[0]!.type).toBe("expandable_blockquote");
  });
});
