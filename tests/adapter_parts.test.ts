/**
 * Phase A1 — the multimodal wire matrix, pinned as the contract.
 *
 * For every adapter (anthropic, gemini, openai_compatible) × every part type
 * (text, image/png, audio/ogg, document/pdf, document/plain-text), these tests
 * build a ChatMessage with parts, run the adapter's exported message
 * serializer, and assert:
 *   (a) native serialization where the adapter supports the type,
 *   (b) a NAMED Persian text-note fallback where it does not,
 *   (c) nothing silently dropped — every attachment is either on the wire or
 *       named in the text.
 *
 * This pins current behavior as the contract. If a cell of the matrix changes
 * deliberately, the test for that cell is where the new contract is written.
 * No network is used: only the exported serializers run, over fixture data.
 */
import { describe, expect, test } from "bun:test";
import { toWireMessages } from "../src/ai/openai_compatible";
import { toWireMessage as anthropicMessage } from "../src/ai/anthropic";
import { toWireMessage as geminiMessage } from "../src/ai/gemini";
import { selectParts } from "../src/ai/parts";
import { MAX_ATTACHMENT_BYTES } from "../src/ai/provider";
import type { ChatMessage, ContentPart } from "../src/ai/provider";

/** A tiny valid PNG payload. Adapters never decode it, only carry it. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SAMPLE_TEXT = "سلام دنیا\nline two of the document";
const TEXT_B64 = Buffer.from(SAMPLE_TEXT, "utf8").toString("base64");

const imagePart: ContentPart = { type: "image", mediaType: "image/png", base64: TINY_PNG_B64 };
const audioPart: ContentPart = { type: "audio", mediaType: "audio/ogg", base64: TINY_PNG_B64 };
const pdfPart: ContentPart = {
  type: "document",
  mediaType: "application/pdf",
  base64: TINY_PNG_B64,
  name: "doc.pdf",
};
const txtPart: ContentPart = {
  type: "document",
  mediaType: "text/plain",
  base64: TEXT_B64,
  name: "notes.txt",
};

/** The adapters this matrix covers, with their exported serializers. */
const adapters = {
  openai_compatible: (m: ChatMessage): unknown => toWireMessages([m])[0]!,
  anthropic: (m: ChatMessage): unknown => anthropicMessage(m),
  gemini: (m: ChatMessage): unknown => geminiMessage(m),
} as const;

type AdapterName = keyof typeof adapters;

/** A part that carries bytes (everything but plain text). */
type AttachmentPart = Exclude<ContentPart, { type: "text" }>;

/** True when an attachment is named in the wire text (note or label). */
function isNamed(wire: unknown, part: AttachmentPart): boolean {
  const json = JSON.stringify(wire);
  if (json.includes(part.mediaType)) return true;
  return (
    part.type === "document" && part.name !== undefined && json.includes(part.name)
  );
}

/** Every cell of the matrix: the attachment must be on the wire or named. */
function assertNothingDropped(wire: unknown, part: AttachmentPart): void {
  const json = JSON.stringify(wire);
  expect(json.includes(part.base64) || isNamed(wire, part)).toBe(true);
}

describe("wire matrix: text", () => {
  test("openai_compatible: text-only is unchanged", () => {
    expect(toWireMessages([{ role: "user", content: "سلام" }])[0]).toEqual({
      role: "user",
      content: "سلام",
    });
  });

  test("anthropic: text-only is a plain string", () => {
    expect(anthropicMessage({ role: "user", content: "سلام" }).content).toBe("سلام");
  });

  test("gemini: text-only is a text part", () => {
    expect(geminiMessage({ role: "user", content: "سلام" }).parts).toEqual([
      { text: "سلام" },
    ]);
  });
});

describe("wire matrix: image/png — native on all three adapters", () => {
  const msg = (content: string): ChatMessage => ({ role: "user", content, parts: [imagePart] });

  test("openai_compatible: image_url with a data URL", () => {
    const wire = toWireMessages([msg("این چیه؟")])[0]!;
    const content = wire["content"] as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "این چیه؟" });
    expect(content[1]!["type"]).toBe("image_url");
    const url = (content[1]!["image_url"] as Record<string, unknown>)["url"] as string;
    expect(url).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
    expect(JSON.stringify(wire)).not.toContain("ارسال نشد");
  });

  test("anthropic: base64 source block", () => {
    const wire = anthropicMessage(msg("این چیه؟"));
    const blocks = wire.content as Array<Record<string, unknown>>;
    expect(blocks[1]!["type"]).toBe("image");
    expect(blocks[1]!["source"]).toEqual({
      type: "base64",
      media_type: "image/png",
      data: TINY_PNG_B64,
    });
  });

  test("gemini: inlineData", () => {
    const wire = geminiMessage(msg("این چیه؟"));
    const parts = wire.parts as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: TINY_PNG_B64 } });
  });

  test("nothing silently dropped, on any adapter", () => {
    for (const name of Object.keys(adapters) as AdapterName[]) {
      assertNothingDropped(adapters[name](msg("x")), imagePart);
    }
  });
});

describe("wire matrix: audio/ogg — native on gemini, named note elsewhere", () => {
  const msg = (content: string): ChatMessage => ({ role: "user", content, parts: [audioPart] });

  test("gemini: audio travels as inlineData", () => {
    const wire = geminiMessage(msg(""));
    const parts = wire.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ inlineData: { mimeType: "audio/ogg", data: TINY_PNG_B64 } });
  });

  test("anthropic: audio is named in the text, not sent", () => {
    const wire = anthropicMessage(msg("بشنو"));
    const json = JSON.stringify(wire);
    expect(json).toContain("[Audio attachment: audio/ogg not sent]");
    // The bytes must not ride along in a form the service would reject.
    expect(json).not.toContain(audioPart.base64);
  });

  test("openai_compatible: audio is named in the text, not sent", () => {
    const wire = toWireMessages([msg("بشنو")])[0]!;
    const json = JSON.stringify(wire);
    expect(json).toContain("[audio attachment: audio/ogg not sent]");
    expect(json).not.toContain(audioPart.base64);
  });

  test("nothing silently dropped, on any adapter", () => {
    for (const name of Object.keys(adapters) as AdapterName[]) {
      assertNothingDropped(adapters[name](msg("x")), audioPart);
    }
  });
});

describe("wire matrix: document/pdf — native on anthropic+gemini, named note on openai", () => {
  const msg = (content: string): ChatMessage => ({ role: "user", content, parts: [pdfPart] });

  test("anthropic: document block with title", () => {
    const wire = anthropicMessage(msg("خلاصه کن"));
    const blocks = wire.content as Array<Record<string, unknown>>;
    expect(blocks[1]!["type"]).toBe("document");
    expect(blocks[1]!["source"]).toEqual({
      type: "base64",
      media_type: "application/pdf",
      data: TINY_PNG_B64,
    });
    expect(blocks[1]!["title"]).toBe("doc.pdf");
  });

  test("gemini: document travels as inlineData", () => {
    const wire = geminiMessage(msg("خلاصه کن"));
    const parts = wire.parts as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({
      inlineData: { mimeType: "application/pdf", data: TINY_PNG_B64 },
    });
  });

  test("openai_compatible: pdf is named in the text, not sent", () => {
    const wire = toWireMessages([msg("خلاصه کن")])[0]!;
    const json = JSON.stringify(wire);
    expect(json).toContain("[document attachment: application/pdf not sent]");
    expect(json).not.toContain(pdfPart.base64);
  });

  test("nothing silently dropped, on any adapter", () => {
    for (const name of Object.keys(adapters) as AdapterName[]) {
      assertNothingDropped(adapters[name](msg("x")), pdfPart);
    }
  });
});

describe("wire matrix: document/plain-text", () => {
  const msg = (content: string): ChatMessage => ({ role: "user", content, parts: [txtPart] });

  test("openai_compatible: inlined as a labeled text block", () => {
    // The Phase A1 gap-fill: a text document decodes to UTF-8 and rides as
    // plain text instead of being reported as unsent.
    const wire = toWireMessages([msg("بخون")])[0]!;
    const content = wire["content"] as Array<Record<string, unknown>>;
    const block = content.find(
      (c) => c["type"] === "text" && String(c["text"]).includes("[Text document notes.txt]:"),
    );
    expect(block).toBeDefined();
    expect(block!["text"] as string).toContain(SAMPLE_TEXT);
    const json = JSON.stringify(wire);
    expect(json).not.toContain("not supported");
    expect(json).not.toContain(TEXT_B64);
  });

  test("anthropic: named as unsupported (current contract)", () => {
    const wire = anthropicMessage(msg("بخون"));
    expect(typeof wire.content).toBe("string");
    expect(wire.content as string).toContain("[text/plain attachment not supported]");
  });

  test("gemini: named as unsupported (current contract)", () => {
    const wire = geminiMessage(msg("بخون"));
    const parts = wire.parts as Array<Record<string, unknown>>;
    expect(parts[0]!["text"] as string).toContain("[text/plain attachment not supported]");
  });

  test("nothing silently dropped, on any adapter", () => {
    for (const name of Object.keys(adapters) as AdapterName[]) {
      assertNothingDropped(adapters[name](msg("x")), txtPart);
    }
  });
});

describe("openai_compatible text-document inline rules", () => {
  const textDoc = (mediaType: string, text: string, name?: string): ContentPart => ({
    type: "document",
    mediaType,
    base64: Buffer.from(text, "utf8").toString("base64"),
    ...(name !== undefined ? { name } : {}),
  });

  const wireOf = (part: ContentPart, content = "x"): Array<Record<string, unknown>> =>
    toWireMessages([{ role: "user", content, parts: [part] }])[0]!["content"] as Array<
      Record<string, unknown>
    >;

  test("text/markdown and text/csv inline too", () => {
    for (const mediaType of ["text/markdown", "text/csv"]) {
      const json = JSON.stringify(wireOf(textDoc(mediaType, "# hi", "f.md")));
      expect(json).toContain("[Text document f.md]:");
      expect(json).toContain("# hi");
    }
  });

  test("a missing filename falls back to the media type in the label", () => {
    const json = JSON.stringify(wireOf(textDoc("text/plain", "hello")));
    expect(json).toContain("[Text document text/plain]:");
  });

  test("a long document is truncated at ~50KB with a named note", () => {
    // The marker sits past the ~50KB cap, so it must not survive truncation.
    const body = "A".repeat(60 * 1024) + "TAIL-MARKER-XYZ" + "B".repeat(30 * 1024);
    const content = wireOf(textDoc("text/plain", body, "big.txt"));
    const json = JSON.stringify(content);
    expect(json).toContain("[Text document big.txt]:");
    // The head survives...
    expect(json).toContain("A".repeat(100));
    // ...the tail past the cap does not...
    expect(json).not.toContain("TAIL-MARKER-XYZ");
    // ...and the cut is named.
    expect(json).toContain("[rest of text omitted due to size]");
  });

  test("a text document past the attachment ceiling is named too large, not decoded", () => {
    const huge: ContentPart = {
      type: "document",
      mediaType: "text/plain",
      base64: "A".repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 1024) * 4) / 3)),
      name: "huge.txt",
    };
    const wire = toWireMessages([{ role: "user", content: "x", parts: [huge] }])[0]!;
    const json = JSON.stringify(wire);
    expect(json).toContain("[text/plain attachment not sent: exceeds size limit]");
    expect(json).not.toContain("[سند متنی");
  });

  test("a text document and an image coexist in one message", () => {
    const wire = toWireMessages([
      { role: "user", content: "هر دو", parts: [txtPart, imagePart] },
    ])[0]!;
    const content = wire["content"] as Array<Record<string, unknown>>;
    expect(content.some((c) => c["type"] === "image_url")).toBe(true);
    expect(
      content.some(
        (c) => c["type"] === "text" && String(c["text"]).includes("[Text document notes.txt]:"),
      ),
    ).toBe(true);
    expect(JSON.stringify(content)).toContain("هر دو");
  });

  test("binary documents still get the not-sent note", () => {
    const json = JSON.stringify(
      wireOf({
        type: "document",
        mediaType: "application/pdf",
        base64: TINY_PNG_B64,
        name: "doc.pdf",
      }),
    );
    expect(json).toContain("[document attachment: application/pdf not sent]");
    expect(json).not.toContain("[سند متنی");
  });
});

describe("selectParts caps and drop reasons", () => {
  /** A base64 string long enough to exceed the attachment ceiling. */
  const oversized = (): string =>
    "A".repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 1024) * 4) / 3));

  test("an oversize part is dropped with reason too_large", () => {
    const huge: ContentPart = { type: "image", mediaType: "image/png", base64: oversized() };
    const sel = selectParts({ role: "user", content: "x", parts: [huge] });
    expect(sel.sendable).toEqual([]);
    expect(sel.dropped).toEqual([{ mediaType: "image/png", reason: "too_large" }]);
  });

  test("parts past the per-message count cap are reported too_large", () => {
    // Current contract: count overflow uses the "too_large" reason, so the
    // note still says the attachment could not be sent rather than vanishing.
    const parts: ContentPart[] = Array.from({ length: 9 }, () => imagePart);
    const sel = selectParts({ role: "user", content: "x", parts });
    expect(sel.sendable).toHaveLength(8);
    expect(sel.dropped).toEqual([{ mediaType: "image/png", reason: "too_large" }]);
  });

  test("an unmapped type is dropped with reason unsupported", () => {
    const video = {
      type: "image",
      mediaType: "video/mp4",
      base64: "AAAA",
    } as unknown as ContentPart;
    const sel = selectParts({ role: "user", content: "x", parts: [video] });
    expect(sel.sendable).toEqual([]);
    expect(sel.dropped).toEqual([{ mediaType: "video/mp4", reason: "unsupported" }]);
  });

  test("text/* documents are not sendable via selection (inline is per-adapter)", () => {
    // Pinning that the openai_compatible text inline happens in the adapter,
    // not here: selection still drops text documents as unsupported, so the
    // other adapters keep their named-note behavior.
    const sel = selectParts({ role: "user", content: "x", parts: [txtPart] });
    expect(sel.sendable).toEqual([]);
    expect(sel.dropped).toEqual([{ mediaType: "text/plain", reason: "unsupported" }]);
  });

  test("text parts inside parts are skipped by selection", () => {
    const sel = selectParts({
      role: "user",
      content: "x",
      parts: [{ type: "text", text: "hi" }, imagePart],
    });
    expect(sel.sendable).toHaveLength(1);
    expect(sel.dropped).toEqual([]);
  });
});
