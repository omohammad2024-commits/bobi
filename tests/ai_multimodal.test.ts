/**
 * Multimodal message contract.
 *
 * The shape is additive on purpose: `content` stays a string and attachments
 * ride alongside as `parts`. These tests pin the properties that makes true,
 * because every existing path — history, transcript, tool results — depends on
 * it and none of them were rewritten.
 */
import { describe, expect, test } from "bun:test";
import {
  base64Bytes,
  hasAttachments,
  MAX_ATTACHMENT_BYTES,
  partTypeForMediaType,
  partsOf,
} from "../src/ai/provider";
import type { ChatMessage, ContentPart } from "../src/ai/provider";

const png: ContentPart = { type: "image", mediaType: "image/png", base64: "AAAA" };
const ogg: ContentPart = { type: "audio", mediaType: "audio/ogg", base64: "BBBB" };

describe("partsOf", () => {
  test("a text-only message yields one text part", () => {
    expect(partsOf({ role: "user", content: "سلام" })).toEqual([
      { type: "text", text: "سلام" },
    ]);
  });

  test("an empty text-only message yields no parts", () => {
    expect(partsOf({ role: "user", content: "" })).toEqual([]);
  });

  test("attachments come after the text", () => {
    const message: ChatMessage = { role: "user", content: "این چیه؟", parts: [png] };
    expect(partsOf(message)).toEqual([{ type: "text", text: "این چیه؟" }, png]);
  });

  test("a caption-less attachment still yields its part", () => {
    // A photo with no caption is a real case, and the message's content is
    // empty then — the attachment must not be dropped.
    const message: ChatMessage = { role: "user", content: "", parts: [png] };
    expect(partsOf(message)).toEqual([png]);
  });

  test("multiple attachments keep their order", () => {
    const message: ChatMessage = { role: "user", content: "x", parts: [png, ogg] };
    expect(partsOf(message)).toEqual([{ type: "text", text: "x" }, png, ogg]);
  });

  test("an empty parts array is treated as text-only", () => {
    expect(partsOf({ role: "user", content: "hi", parts: [] })).toEqual([
      { type: "text", text: "hi" },
    ]);
  });
});

describe("hasAttachments", () => {
  test("true only when parts exist", () => {
    expect(hasAttachments({ role: "user", content: "x" })).toBe(false);
    expect(hasAttachments({ role: "user", content: "x", parts: [] })).toBe(false);
    expect(hasAttachments({ role: "user", content: "x", parts: [png] })).toBe(true);
  });
});

describe("media type mapping", () => {
  test("images map to image", () => {
    expect(partTypeForMediaType("image/jpeg")).toBe("image");
    expect(partTypeForMediaType("image/png")).toBe("image");
    expect(partTypeForMediaType("image/webp")).toBe("image");
  });

  test("audio maps to audio", () => {
    expect(partTypeForMediaType("audio/ogg")).toBe("audio");
    expect(partTypeForMediaType("audio/mpeg")).toBe("audio");
  });

  test("pdf maps to document", () => {
    expect(partTypeForMediaType("application/pdf")).toBe("document");
  });

  test("a charset parameter is ignored", () => {
    expect(partTypeForMediaType("image/png; charset=binary")).toBe("image");
  });

  test("case does not matter", () => {
    expect(partTypeForMediaType("IMAGE/PNG")).toBe("image");
  });

  test("unsupported types map to nothing", () => {
    // A type with no mapping is one the bot does not carry, so the caller can
    // tell the user rather than sending something the provider will reject.
    for (const type of ["video/mp4", "application/zip", "text/html", "", "nonsense"]) {
      expect(partTypeForMediaType(type)).toBeUndefined();
    }
  });
});

describe("size estimation", () => {
  test("known base64 lengths decode to the right byte count", () => {
    // "AAAA" is 3 bytes; "AAA=" is 2; "AA==" is 1.
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
  });

  test("an empty payload is zero bytes", () => {
    expect(base64Bytes("")).toBe(0);
  });

  test("a real 1x1 PNG header estimates correctly", () => {
    // The estimator is used to refuse an over-large attachment, so it has to be
    // accurate enough to trust before decoding.
    const sample = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = base64Bytes(sample);
    // This is a 70-byte PNG.
    expect(bytes).toBeGreaterThan(60);
    expect(bytes).toBeLessThan(80);
  });

  test("the attachment ceiling is a sensible size", () => {
    expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_ATTACHMENT_BYTES).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});

describe("backward compatibility", () => {
  test("a message built the old way still type-checks and reads the same", () => {
    // Nothing that existed before the change should need editing.
    const message: ChatMessage = { role: "user", content: "قدیمی" };
    expect(message.content).toBe("قدیمی");
    expect(message.parts).toBeUndefined();
    expect(partsOf(message)).toHaveLength(1);
  });

  test("tool-call fields are unaffected", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "calculator", arguments: { a: 1 } }],
    };
    expect(message.toolCalls?.[0]?.name).toBe("calculator");
    expect(partsOf(message)).toEqual([]);
  });

  test("a tool result message is unaffected", () => {
    const message: ChatMessage = {
      role: "tool",
      content: "42",
      toolCallId: "c1",
      toolName: "calculator",
    };
    expect(partsOf(message)).toEqual([{ type: "text", text: "42" }]);
  });
});
