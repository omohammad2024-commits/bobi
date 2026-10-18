/**
 * Phase A1 — vision end to end.
 *
 * Simulates the real path a Telegram photo takes: a photo message (shaped the
 * way Telegram delivers it) → media.extractMedia (with the download stubbed,
 * no network) → ContentPart[] → each adapter's serializer. The image bytes
 * must survive to the wire format byte-identically — a photo that arrives
 * corrupted or truncated is worse than one that fails loudly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { extractMedia } from "../src/bot/media";
import { toWireMessages } from "../src/ai/openai_compatible";
import { toWireMessage as anthropicMessage } from "../src/ai/anthropic";
import { toWireMessage as geminiMessage } from "../src/ai/gemini";
import type { ChatMessage } from "../src/ai/provider";

/** A tiny valid PNG. The fixture bytes are the ground truth. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

/** A photo message the way Telegram delivers it: every resolution as file ids. */
const telegramPhotoMessage = {
  message_id: 42,
  date: 1_730_000_000,
  chat: { id: 7, type: "private" as const },
  photo: [
    { file_id: "thumb_id", file_size: 900, width: 90, height: 90 },
    { file_id: "mid_id", file_size: 3200, width: 320, height: 240 },
    { file_id: "full_id", file_size: 7800, width: 1280, height: 960 },
  ],
  caption: "این چیه؟",
};

const realFetch = globalThis.fetch;
let requestedUrl = "";

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub only the Telegram file endpoint; anything else would be a real fetch. */
function stubTelegramFileEndpoint(): void {
  requestedUrl = "";
  const stub = async (input: string | URL | Request): Promise<Response> => {
    requestedUrl = String(input);
    return new Response(PNG_BYTES);
  };
  globalThis.fetch = stub as typeof fetch;
}

function fakeCtx(): Context {
  return {
    message: telegramPhotoMessage,
    api: {
      getFile: async (fileId: string) => {
        // The LARGEST photo must be the one fetched — a thumbnail would make
        // the model answer about a blurry image.
        expect(fileId).toBe("full_id");
        return { file_path: "photos/file_42.jpg" };
      },
    },
  } as unknown as Context;
}

describe("telegram photo → ContentPart[]", () => {
  test("extractMedia yields one image part with intact bytes", async () => {
    stubTelegramFileEndpoint();

    const extraction = await extractMedia(fakeCtx(), "TESTTOKEN");

    expect(extraction.skipped).toEqual([]);
    expect(extraction.text).toBe("این چیه؟");
    expect(extraction.parts).toHaveLength(1);
    expect(extraction.parts[0]).toEqual({
      type: "image",
      mediaType: "image/jpeg",
      base64: PNG_B64,
    });
    expect(requestedUrl).toBe("https://api.telegram.org/file/botTESTTOKEN/photos/file_42.jpg");
  });
});

describe("ContentPart[] → wire format, byte integrity per adapter", () => {
  /** The full path, with the network stubbed: photo → parts → wire base64. */
  async function wireBase64PerAdapter(): Promise<Record<string, string>> {
    stubTelegramFileEndpoint();
    const extraction = await extractMedia(fakeCtx(), "TESTTOKEN");
    const message: ChatMessage = {
      role: "user",
      content: extraction.text,
      parts: extraction.parts,
    };

    const openaiWire = toWireMessages([message])[0]!;
    const openaiContent = openaiWire["content"] as Array<Record<string, unknown>>;
    const imageUrl = openaiContent.find((c) => c["type"] === "image_url")!;
    const openaiUrl = (imageUrl["image_url"] as Record<string, unknown>)["url"] as string;

    const anthropicBlocks = anthropicMessage(message).content as Array<Record<string, unknown>>;
    const anthropicImage = anthropicBlocks.find((b) => b["type"] === "image")!;
    const anthropicData = (anthropicImage["source"] as Record<string, unknown>)["data"] as string;

    const geminiParts = geminiMessage(message).parts as Array<Record<string, unknown>>;
    const geminiInline = geminiParts.find((p) => p["inlineData"] !== undefined)!;
    const geminiData = (geminiInline["inlineData"] as Record<string, unknown>)["data"] as string;

    return {
      openai: openaiUrl.replace(/^data:image\/jpeg;base64,/, ""),
      anthropic: anthropicData,
      gemini: geminiData,
    };
  }

  test("every adapter carries the exact photo bytes", async () => {
    const perAdapter = await wireBase64PerAdapter();
    for (const b64 of Object.values(perAdapter)) {
      // Byte-identical: decode and compare against the fixture bytes.
      expect(Buffer.from(b64, "base64").equals(PNG_BYTES)).toBe(true);
      expect(b64).toBe(PNG_B64);
    }
  });

  test("no drop-note appears for a healthy photo", async () => {
    stubTelegramFileEndpoint();
    const extraction = await extractMedia(fakeCtx(), "TESTTOKEN");
    const message: ChatMessage = {
      role: "user",
      content: extraction.text,
      parts: extraction.parts,
    };
    const wires = [
      JSON.stringify(toWireMessages([message])[0]),
      JSON.stringify(anthropicMessage(message)),
      JSON.stringify(geminiMessage(message)),
    ];
    for (const json of wires) {
      expect(json).not.toContain("ارسال نشد");
      expect(json).not.toContain("پشتیبانی نمی‌شود");
    }
  });
});
