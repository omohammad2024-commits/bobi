/**
 * Attachments on the wire.
 *
 * The contract tests prove a message CAN carry an attachment. These prove each
 * adapter actually sends it — a photo that is silently dropped is worse than one
 * that fails, because the model answers confidently about an image it never saw.
 */
import { describe, expect, test } from "bun:test";
import { buildRequestBody, toWireMessages } from "../src/ai/openai_compatible";
import { buildBody as buildAnthropic, toWireMessage as anthropicMessage } from "../src/ai/anthropic";
import { buildBody as buildGemini, toWireMessage as geminiMessage } from "../src/ai/gemini";
import { MAX_ATTACHMENT_BYTES } from "../src/ai/provider";
import { MAX_PARTS_PER_MESSAGE } from "../src/ai/parts";
import type { ChatMessage, CompletionRequest, ContentPart } from "../src/ai/provider";

const TARGET = { baseUrl: "https://example.test/v1", apiKey: "k", settings: {} };

/** A tiny valid base64 payload. The adapters never decode it, only measure. */
const TINY = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const image: ContentPart = { type: "image", mediaType: "image/png", base64: TINY };
const audio: ContentPart = { type: "audio", mediaType: "audio/ogg", base64: TINY };
const pdf: ContentPart = { type: "document", mediaType: "application/pdf", base64: TINY, name: "doc.pdf" };

const req = (messages: ChatMessage[]): CompletionRequest => ({
  messages,
  model: "m",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
});

/** A base64 string long enough to exceed the attachment ceiling. */
const oversized = (): string => "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1024) * 4 / 3));

describe("every attachment type reaches the provider", () => {
  test("OpenAI: an image becomes an image_url content part", () => {
    const wire = toWireMessages([{ role: "user", content: "این چیه؟", parts: [image] }])[0]!;
    const content = wire["content"] as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "این چیه؟" });
    expect(content[1]!["type"]).toBe("image_url");
    const url = (content[1]!["image_url"] as Record<string, unknown>)["url"] as string;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("Anthropic: an image becomes a base64 source block", () => {
    const wire = anthropicMessage({ role: "user", content: "این چیه؟", parts: [image] });
    const blocks = wire.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "این چیه؟" });
    expect(blocks[1]!["type"]).toBe("image");
    const source = blocks[1]!["source"] as Record<string, unknown>;
    expect(source["type"]).toBe("base64");
    expect(source["media_type"]).toBe("image/png");
    expect(source["data"]).toBe(TINY);
  });

  test("Anthropic: a PDF becomes a document block", () => {
    const wire = anthropicMessage({ role: "user", content: "خلاصه کن", parts: [pdf] });
    const blocks = wire.content as Array<Record<string, unknown>>;
    expect(blocks[1]!["type"]).toBe("document");
    const source = blocks[1]!["source"] as Record<string, unknown>;
    expect(source["media_type"]).toBe("application/pdf");
    expect(blocks[1]!["title"]).toBe("doc.pdf");
  });

  test("Gemini: an image becomes an inlineData part", () => {
    const wire = geminiMessage({ role: "user", content: "این چیه؟", parts: [image] });
    const parts = wire.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ text: "این چیه؟" });
    const inline = parts[1]!["inlineData"] as Record<string, unknown>;
    expect(inline["mimeType"]).toBe("image/png");
    expect(inline["data"]).toBe(TINY);
  });

  test("Gemini: audio becomes an inlineData part", () => {
    // This service accepts audio natively, so it travels as a part rather than
    // being described in the text.
    const wire = geminiMessage({ role: "user", content: "", parts: [audio] });
    const parts = wire.parts as Array<Record<string, unknown>>;
    const inline = parts[0]!["inlineData"] as Record<string, unknown>;
    expect(inline["mimeType"]).toBe("audio/ogg");
  });
});

describe("attachments survive a full request build", () => {
  test("OpenAI body carries the image", () => {
    const body = buildRequestBody(TARGET, req([{ role: "user", content: "x", parts: [image] }]));
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(Array.isArray(messages[0]!["content"])).toBe(true);
  });

  test("Anthropic body carries the image", () => {
    const body = buildAnthropic(TARGET, req([{ role: "user", content: "x", parts: [image] }]));
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(Array.isArray(messages[0]!["content"])).toBe(true);
  });

  test("Gemini body carries the image", () => {
    const body = buildGemini(TARGET, req([{ role: "user", content: "x", parts: [image] }]));
    const contents = body["contents"] as Array<Record<string, unknown>>;
    const parts = contents[0]!["parts"] as unknown[];
    expect(parts.length).toBe(2);
  });

  test("a photo with no caption still sends the image", () => {
    // A caption-less photo is the common case, and losing it would leave the
    // model answering about an image it never received.
    for (const build of [
      () => toWireMessages([{ role: "user", content: "", parts: [image] }])[0]!,
      () => anthropicMessage({ role: "user", content: "", parts: [image] }) as unknown as Record<string, unknown>,
      () => geminiMessage({ role: "user", content: "", parts: [image] }) as unknown as Record<string, unknown>,
    ]) {
      expect(JSON.stringify(build())).toContain("image/png");
    }
  });
});

describe("an attachment that cannot be sent is reported, not dropped", () => {
  test("an over-large attachment is named in the text", () => {
    const huge: ContentPart = { type: "image", mediaType: "image/png", base64: oversized() };
    const wire = toWireMessages([{ role: "user", content: "ببین", parts: [huge] }])[0]!;
    // No image part is sent...
    expect(typeof wire["content"]).toBe("string");
    // ...but the model learns why, so it can tell the user.
    expect(wire["content"] as string).toContain("exceeds size limit");
  });

  test("an unsupported type is named in the text", () => {
    const video = { type: "image", mediaType: "video/mp4", base64: "AAAA" } as unknown as ContentPart;
    const wire = toWireMessages([{ role: "user", content: "ببین", parts: [video] }])[0]!;
    expect(wire["content"] as string).toContain("not supported");
  });

  test("the same holds for the other two adapters", () => {
    const huge: ContentPart = { type: "image", mediaType: "image/png", base64: oversized() };
    const message: ChatMessage = { role: "user", content: "ببین", parts: [huge] };

    const anthropic = anthropicMessage(message);
    expect(typeof anthropic.content).toBe("string");
    expect(anthropic.content as string).toContain("exceeds size limit");

    const gemini = geminiMessage(message);
    const parts = gemini.parts as Array<Record<string, unknown>>;
    expect(parts[0]!["text"] as string).toContain("exceeds size limit");
  });

  test("a mixture keeps the good attachment and reports the bad one", () => {
    const huge: ContentPart = { type: "image", mediaType: "image/png", base64: oversized() };
    const wire = toWireMessages([{ role: "user", content: "ببین", parts: [image, huge] }])[0]!;
    const content = wire["content"] as Array<Record<string, unknown>>;
    // The sendable image still goes.
    expect(content.some((c) => c["type"] === "image_url")).toBe(true);
    // And the rejected one is mentioned.
    expect(JSON.stringify(content)).toContain("exceeds size limit");
  });
});

describe("bounds", () => {
  test("more attachments than the cap are truncated and reported", () => {
    const parts: ContentPart[] = Array.from({ length: MAX_PARTS_PER_MESSAGE + 3 }, () => image);
    const wire = toWireMessages([{ role: "user", content: "x", parts }])[0]!;
    const content = wire["content"] as Array<Record<string, unknown>>;
    const images = content.filter((c) => c["type"] === "image_url");
    expect(images).toHaveLength(MAX_PARTS_PER_MESSAGE);
  });

  test("text is never lost when attachments are present", () => {
    const wire = toWireMessages([
      { role: "user", content: "متن مهم", parts: [image] },
    ])[0]!;
    expect(JSON.stringify(wire)).toContain("متن مهم");
  });

  test("a message with no attachments is byte-identical to before", () => {
    // The change is additive; a text-only turn must produce exactly the old shape.
    const wire = toWireMessages([{ role: "user", content: "سلام" }])[0]!;
    expect(wire).toEqual({ role: "user", content: "سلام" });
  });
});
