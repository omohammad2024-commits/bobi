/**
 * Attachment extraction from a Telegram message.
 *
 * The selection rules are pure, so they are tested against message shapes
 * rather than by downloading anything. Two properties matter most: a photo
 * picks its LARGEST size (a thumbnail would make the model answer about a
 * blurry image), and an over-large file is refused BEFORE its bytes are
 * fetched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  candidatesIn,
  deliverToolMedia,
  describeMediaPart,
  extractMedia,
  hasMedia,
  MAX_MEDIA_PER_REPLY,
  MAX_VOICE_AUDIO_SECONDS,
  type MediaSenders,
} from "../src/bot/media";
import { MAX_ATTACHMENT_BYTES } from "../src/ai/provider";
import type { ContentPart } from "../src/ai/provider";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the Telegram file download with a few audio bytes. */
function stubVoiceDownload(): void {
  const stub = async (): Promise<Response> => new Response(Buffer.from([0x4f, 0x67, 0x67]));
  globalThis.fetch = stub as unknown as typeof fetch;
}

/** A minimal message carrying whatever the case needs. */
function msg(over: Record<string, unknown>) {
  return { chat: { id: 1, type: "private" }, ...over } as never;
}

describe("hasMedia", () => {
  test("detects each supported kind", () => {
    expect(hasMedia(msg({ photo: [{ file_id: "f", width: 1, height: 1 }] }))).toBe(true);
    expect(hasMedia(msg({ voice: { file_id: "f", duration: 1 } }))).toBe(true);
    expect(hasMedia(msg({ audio: { file_id: "f", duration: 1 } }))).toBe(true);
    expect(hasMedia(msg({ document: { file_id: "f" } }))).toBe(true);
  });

  test("a text-only message has none", () => {
    expect(hasMedia(msg({ text: "سلام" }))).toBe(false);
  });
});

describe("photo selection", () => {
  test("the LARGEST size is chosen, not the first", () => {
    // Telegram lists sizes smallest first. Picking the first would send a
    // thumbnail, and the model would answer about a blurry image.
    const candidates = candidatesIn(
      msg({
        photo: [
          { file_id: "small", width: 90, height: 90, file_size: 1_000 },
          { file_id: "medium", width: 320, height: 320, file_size: 20_000 },
          { file_id: "large", width: 1280, height: 1280, file_size: 300_000 },
        ],
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.fileId).toBe("large");
    expect(candidates[0]!.mediaType).toBe("image/jpeg");
    expect(candidates[0]!.declaredSize).toBe(300_000);
  });

  test("a single size is used as-is", () => {
    const candidates = candidatesIn(msg({ photo: [{ file_id: "only", file_size: 5_000 }] }));
    expect(candidates[0]!.fileId).toBe("only");
  });

  test("an absent size is tolerated", () => {
    // Not every message reports file_size, and its absence must not throw.
    const candidates = candidatesIn(msg({ photo: [{ file_id: "f" }] }));
    expect(candidates[0]!.declaredSize).toBeUndefined();
  });
});

describe("voice and audio", () => {
  test("a voice note uses its reported mime type", () => {
    const candidates = candidatesIn(
      msg({ voice: { file_id: "v", mime_type: "audio/ogg", file_size: 1_000 } }),
    );
    expect(candidates[0]!.mediaType).toBe("audio/ogg");
    expect(candidates[0]!.kind).toBe("voice");
  });

  test("a voice note with no mime type falls back to ogg", () => {
    // Telegram's voice notes are ogg/opus; the default keeps a usable type
    // rather than an empty one the mapping would reject.
    const candidates = candidatesIn(msg({ voice: { file_id: "v" } }));
    expect(candidates[0]!.mediaType).toBe("audio/ogg");
  });

  test("an audio file is distinct from a voice note", () => {
    const candidates = candidatesIn(msg({ audio: { file_id: "a", mime_type: "audio/mpeg" } }));
    expect(candidates[0]!.kind).toBe("audio");
  });

  test("a voice note carries its duration for the transcription cap", () => {
    const candidates = candidatesIn(msg({ voice: { file_id: "v", duration: 42 } }));
    expect(candidates[0]!.durationSec).toBe(42);
  });

  test("a voice note past the duration cap is skipped before any download", async () => {
    const ctx = {
      message: msg({ voice: { file_id: "v", duration: MAX_VOICE_AUDIO_SECONDS + 1 } }),
      api: {
        getFile: async () => {
          throw new Error("must not download an over-long voice note");
        },
      },
    } as never;
    const extraction = await extractMedia(ctx, "TESTTOKEN");
    expect(extraction.parts).toEqual([]);
    expect(extraction.skipped).toEqual([{ kind: "voice", reason: "too_long" }]);
  });

  test("a voice note within the duration cap is not skipped for length", async () => {
    const ctx = {
      message: msg({ voice: { file_id: "v", duration: MAX_VOICE_AUDIO_SECONDS } }),
      api: {
        getFile: async () => ({ file_path: "voice/file.ogg" }),
      },
    } as never;
    stubVoiceDownload();
    const extraction = await extractMedia(ctx, "TESTTOKEN");
    expect(extraction.skipped).toEqual([]);
    expect(extraction.parts).toHaveLength(1);
  });
});

describe("documents", () => {
  test("a pdf is carried with its file name", () => {
    const candidates = candidatesIn(
      msg({ document: { file_id: "d", mime_type: "application/pdf", file_name: "گزارش.pdf" } }),
    );
    expect(candidates[0]!.mediaType).toBe("application/pdf");
    expect(candidates[0]!.name).toBe("گزارش.pdf");
  });

  test("a document with no mime type is marked unsupported downstream", () => {
    // The default keeps the candidate list faithful; the type check happens
    // later, where an unsupported type is reported to the user.
    const candidates = candidatesIn(msg({ document: { file_id: "d" } }));
    expect(candidates[0]!.mediaType).toBe("application/octet-stream");
  });
});

describe("multiple attachments", () => {
  test("a photo with a caption also yields the photo", () => {
    const candidates = candidatesIn(msg({ photo: [{ file_id: "p" }], caption: "این چیه؟" }));
    expect(candidates).toHaveLength(1);
  });

  test("a document plus a photo yields both", () => {
    const candidates = candidatesIn(
      msg({ photo: [{ file_id: "p" }], document: { file_id: "d", mime_type: "application/pdf" } }),
    );
    expect(candidates.map((c) => c.kind)).toEqual(["photo", "document"]);
  });

  test("an empty photo array contributes nothing", () => {
    expect(candidatesIn(msg({ photo: [] }))).toHaveLength(0);
  });

  test("a message with nothing yields nothing", () => {
    expect(candidatesIn(msg({ text: "hi" }))).toHaveLength(0);
  });
});

describe("describeMediaPart — tool-produced media routing", () => {
  const b64 = Buffer.from("fake-bytes").toString("base64");

  test("a downloaded video (document part, video type) sends as a video", () => {
    const part: ContentPart = {
      type: "document",
      mediaType: "video/mp4",
      base64: b64,
      name: "Clip.mp4",
    };
    const m = describeMediaPart(part);
    expect(m?.kind).toBe("video");
    expect(m?.file.filename).toBe("Clip.mp4");
  });

  test("a downloaded song (document part, audio type) sends as audio, not a voice note", () => {
    const part: ContentPart = {
      type: "document",
      mediaType: "audio/mpeg",
      base64: b64,
      name: "Song.mp3",
    };
    expect(describeMediaPart(part)?.kind).toBe("audio");
  });

  test("a plain document part stays a document", () => {
    const part: ContentPart = {
      type: "document",
      mediaType: "application/pdf",
      base64: b64,
      name: "report.pdf",
    };
    expect(describeMediaPart(part)?.kind).toBe("document");
  });

  test("synthesized speech (audio part) stays a voice note; images stay photos", () => {
    expect(
      describeMediaPart({ type: "audio", mediaType: "audio/ogg", base64: b64 })?.kind,
    ).toBe("voice");
    expect(
      describeMediaPart({ type: "image", mediaType: "image/png", base64: b64 })?.kind,
    ).toBe("photo");
  });

  test("a text part has nothing to send", () => {
    expect(describeMediaPart({ type: "text", text: "hi" })).toBeUndefined();
  });
});

describe("deliverToolMedia — the delivery contract", () => {
  const b64 = Buffer.from("fake-bytes").toString("base64");
  const videoPart: ContentPart = {
    type: "document",
    mediaType: "video/mp4",
    base64: b64,
    name: "Clip.mp4",
  };
  const photoPart: ContentPart = { type: "image", mediaType: "image/png", base64: b64 };

  function recordingSenders(log: string[], failOn?: string): MediaSenders {
    const make = (kind: string) => async () => {
      log.push(kind);
      if (failOn === kind) throw new Error(`send ${kind} failed`);
    };
    return {
      photo: make("photo"),
      voice: make("voice"),
      video: make("video"),
      audio: make("audio"),
      document: make("document"),
    };
  }

  test("routes each part to its sender and settles every part", async () => {
    const sent: string[] = [];
    const settled: ContentPart[] = [];
    await deliverToolMedia([videoPart, photoPart], recordingSenders(sent), async (p) => {
      settled.push(p);
    });
    expect(sent).toEqual(["video", "photo"]);
    expect(settled).toEqual([videoPart, photoPart]);
  });

  test("a failed send still settles its part, later parts still go out, and the error surfaces", async () => {
    const sent: string[] = [];
    const settled: ContentPart[] = [];
    await expect(
      deliverToolMedia([videoPart, photoPart], recordingSenders(sent, "video"), async (p) => {
        settled.push(p);
      }),
    ).rejects.toThrow("send video failed");
    expect(sent).toEqual(["video", "photo"]);
    expect(settled).toEqual([videoPart, photoPart]);
  });

  test("parts past the per-reply cap are not sent but are still settled", async () => {
    const sent: string[] = [];
    const settled: ContentPart[] = [];
    const parts = Array.from({ length: MAX_MEDIA_PER_REPLY + 2 }, () => photoPart);
    await deliverToolMedia(parts, recordingSenders(sent), async (p) => {
      settled.push(p);
    });
    expect(sent).toHaveLength(MAX_MEDIA_PER_REPLY);
    expect(settled).toHaveLength(MAX_MEDIA_PER_REPLY + 2);
  });
});

describe("size ceiling", () => {
  test("the ceiling is the provider-side one", () => {
    // The two must agree: the bot refuses what the provider would reject, so
    // the user hears about it now rather than after a failed run.
    expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(0);
  });

  test("a large declared size is visible to the caller for refusal", () => {
    const candidates = candidatesIn(
      msg({ document: { file_id: "big", mime_type: "application/pdf", file_size: 50_000_000 } }),
    );
    // Extraction reports the size; the decision to skip happens before the
    // download, so no bytes are fetched for a file that cannot be used.
    expect(candidates[0]!.declaredSize).toBe(50_000_000);
    expect(candidates[0]!.declaredSize!).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
  });
});
