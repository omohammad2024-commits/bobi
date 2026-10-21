/**
 * GIF / animation attachment extraction.
 *
 * A Telegram GIF arrives as an `animation` (an mp4) and Telegram mirrors the
 * same file into `document` with mime_type video/mp4. Before the fix the
 * intake had no animation branch, so the mirror hit the unsupported-type
 * skip and a lone GIF was answered with the "couldn't be used" wall. These
 * tests pin the repaired behaviour: one GIF becomes one usable part — the
 * thumbnail frame as an image, or the file itself as a video document when
 * there is no thumbnail — and never an "unsupported" skip.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { candidatesIn, extractMedia, hasMedia } from "../src/bot/media";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the Telegram file download with a few bytes. */
function stubDownload(): void {
  const stub = async (): Promise<Response> =>
    new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  globalThis.fetch = stub as unknown as typeof fetch;
}

/** A minimal message carrying whatever the case needs. */
function msg(over: Record<string, unknown>) {
  return { chat: { id: 1, type: "private" }, ...over } as never;
}

/** A ctx whose getFile resolves any id to a downloadable path. */
function ctxFor(message: unknown) {
  return {
    message,
    api: { getFile: async () => ({ file_path: "animations/file.mp4" }) },
  } as never;
}

const THUMB = { file_id: "thumb1", file_unique_id: "uthumb", width: 320, height: 240, file_size: 4096 };
const ANIM = {
  file_id: "anim1",
  file_unique_id: "uanim",
  width: 480,
  height: 360,
  duration: 3,
  mime_type: "video/mp4",
  file_size: 120_000,
};
/** The document Telegram mirrors an animation into: same unique id. */
const MIRROR_DOC = {
  file_id: "anim1",
  file_unique_id: "uanim",
  mime_type: "video/mp4",
  file_size: 120_000,
  file_name: "animation.gif.mp4",
};

describe("animation candidates", () => {
  test("an animation with a thumbnail yields exactly ONE candidate: the thumbnail as an image", () => {
    const candidates = candidatesIn(msg({ animation: { ...ANIM, thumbnail: THUMB }, document: MIRROR_DOC }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.kind).toBe("animation");
    expect(candidates[0]!.fileId).toBe("thumb1");
    expect(candidates[0]!.mediaType).toBe("image/jpeg");
  });

  test("the mirrored document is suppressed ONLY when it is the same file", () => {
    const other = { file_id: "d9", file_unique_id: "udoc9", mime_type: "application/pdf" };
    const candidates = candidatesIn(
      msg({ animation: { ...ANIM, thumbnail: THUMB }, document: other }),
    );
    expect(candidates.map((c) => c.kind)).toEqual(["animation", "document"]);
  });

  test("an animation without a thumbnail is carried as a video document, never unsupported", () => {
    const candidates = candidatesIn(msg({ animation: ANIM, document: MIRROR_DOC }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.kind).toBe("animation");
    expect(candidates[0]!.mediaType).toBe("video/mp4");
    expect(candidates[0]!.partType).toBe("document");
  });
});

describe("animation extraction", () => {
  test("GIF with thumbnail + mirrored document: one image part, nothing skipped", async () => {
    stubDownload();
    const extraction = await extractMedia(
      ctxFor(msg({ animation: { ...ANIM, thumbnail: THUMB }, document: MIRROR_DOC })),
      "TESTTOKEN",
    );
    expect(extraction.skipped).toEqual([]);
    expect(extraction.parts).toHaveLength(1);
    const part = extraction.parts[0]!;
    expect(part.type).toBe("image");
    if (part.type === "image") expect(part.mediaType).toBe("image/jpeg");
  });

  test("GIF without a thumbnail: one video document part, no unsupported skip", async () => {
    stubDownload();
    const extraction = await extractMedia(
      ctxFor(msg({ animation: ANIM, document: MIRROR_DOC })),
      "TESTTOKEN",
    );
    expect(extraction.skipped).toEqual([]);
    expect(extraction.parts).toHaveLength(1);
    const part = extraction.parts[0]!;
    expect(part.type).toBe("document");
    if (part.type === "document") expect(part.mediaType).toBe("video/mp4");
  });

  test("a lone mirrored GIF document (no animation field) is unchanged behaviour", async () => {
    // Some clients surface only the document half. That is a bare mp4
    // document, and the pre-existing unsupported rule still applies to it —
    // the fix is scoped to messages that actually carry an animation.
    const candidates = candidatesIn(msg({ document: MIRROR_DOC }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.kind).toBe("document");
  });
});

describe("regression pins", () => {
  test("a genuinely unsupported document alone still skips as unsupported", async () => {
    const extraction = await extractMedia(
      ctxFor(msg({ document: { file_id: "x", file_unique_id: "ux", mime_type: "application/x-msdownload", file_name: "setup.exe" } })),
      "TESTTOKEN",
    );
    expect(extraction.parts).toEqual([]);
    expect(extraction.skipped).toEqual([{ kind: "document", reason: "unsupported" }]);
  });

  test("hasMedia is true for an animation-only message", () => {
    expect(hasMedia(msg({ animation: ANIM }))).toBe(true);
    expect(hasMedia(msg({ animation: ANIM, document: MIRROR_DOC }))).toBe(true);
  });
});
