/**
 * Attachment extraction from a Telegram message.
 *
 * The selection rules are pure, so they are tested against message shapes
 * rather than by downloading anything. Two properties matter most: a photo
 * picks its LARGEST size (a thumbnail would make the model answer about a
 * blurry image), and an over-large file is refused BEFORE its bytes are
 * fetched.
 */
import { describe, expect, test } from "bun:test";
import { candidatesIn, hasMedia } from "../src/bot/media";
import { MAX_ATTACHMENT_BYTES } from "../src/ai/provider";

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
