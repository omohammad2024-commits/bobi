/**
 * Pulling attachments out of a Telegram message.
 *
 * Telegram does not inline file bytes: a photo arrives as a list of `file_id`s
 * at different resolutions and the content has to be fetched with `getFile`
 * followed by a download from the file endpoint. That is what this module does,
 * and it is the only place that knows it.
 *
 * Two things shape the design:
 *
 *  1. SIZE IS CHECKED BEFORE DOWNLOADING WHERE POSSIBLE. `file_size` is
 *     reported by Telegram, so an over-large attachment is refused without
 *     spending bandwidth on it. The check is repeated after the download too,
 *     because the reported size is not a guarantee.
 *
 *  2. A FAILURE IS DESCRIBED, NOT SWALLOWED. A user who sends a 50 MB video
 *     should be told it was too large rather than getting a reply about "the
 *     message" with no mention of the attachment. So each extraction returns
 *     what it got AND what it could not get.
 */
import type { Context } from "grammy";
import {
  base64Bytes,
  MAX_ATTACHMENT_BYTES,
  partTypeForMediaType,
} from "../ai/provider";
import type { ContentPart } from "../ai/provider";

/** Why an attachment was not attached. */
export type MediaSkipReason = "too_large" | "download_failed" | "unsupported";

export interface MediaExtraction {
  /** Attachments ready to send to the provider. */
  parts: ContentPart[];
  /** Attachments that were present but could not be used, with the reason. */
  skipped: Array<{ kind: string; reason: MediaSkipReason }>;
  /** Caption or text the message carried, if any. */
  text: string;
}

/** Largest file BOBI will download, mirroring the provider-side ceiling. */
const MAX_DOWNLOAD_BYTES = MAX_ATTACHMENT_BYTES;

/** How many attachments one message may contribute. */
const MAX_ATTACHMENTS = 4;

/**
 * Extract every usable attachment from a message.
 *
 * Never throws: a download failure is reported in `skipped`, because a user
 * whose photo failed to fetch still deserves an answer about their caption.
 */
export async function extractMedia(ctx: Context, botToken: string): Promise<MediaExtraction> {
  const message = ctx.message;
  if (message === undefined) return { parts: [], skipped: [], text: "" };

  const parts: ContentPart[] = [];
  const skipped: MediaExtraction["skipped"] = [];
  const text = message.caption ?? message.text ?? "";

  for (const candidate of candidatesIn(message)) {
    if (parts.length >= MAX_ATTACHMENTS) {
      skipped.push({ kind: candidate.kind, reason: "too_large" });
      continue;
    }

    // The size Telegram reports lets an over-large file be refused without
    // downloading it at all.
    if (candidate.declaredSize !== undefined && candidate.declaredSize > MAX_DOWNLOAD_BYTES) {
      skipped.push({ kind: candidate.kind, reason: "too_large" });
      continue;
    }

    // A type with no mapping is one the adapters cannot carry, so there is no
    // point downloading it.
    if (partTypeForMediaType(candidate.mediaType) === undefined) {
      skipped.push({ kind: candidate.kind, reason: "unsupported" });
      continue;
    }

    const data = await download(ctx, botToken, candidate.fileId);
    if (data === undefined) {
      skipped.push({ kind: candidate.kind, reason: "download_failed" });
      continue;
    }

    // Re-checked after the fact, because the declared size is a hint rather
    // than a guarantee.
    if (base64Bytes(data.base64) > MAX_DOWNLOAD_BYTES) {
      skipped.push({ kind: candidate.kind, reason: "too_large" });
      continue;
    }

    parts.push(buildPart(candidate, data.base64));
  }

  return { parts, skipped, text };
}

/** One attachment found in the message, before it is fetched. */
export interface MediaCandidate {
  kind: string;
  fileId: string;
  mediaType: string;
  /** Byte size Telegram reported, when it reported one. */
  declaredSize?: number;
  name?: string;
}

/**
 * List the attachments a message carries.
 *
 * A photo arrives as a list of sizes; the LARGEST is chosen, because a small
 * thumbnail would make the model answer about a blurry image.
 *
 * Exported so the selection rules are testable without a network.
 */
export function candidatesIn(message: NonNullable<Context["message"]>): MediaCandidate[] {
  const out: MediaCandidate[] = [];

  if (message.photo !== undefined && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1]!;
    out.push({
      kind: "photo",
      fileId: largest.file_id,
      mediaType: "image/jpeg",
      ...(largest.file_size !== undefined ? { declaredSize: largest.file_size } : {}),
    });
  }

  if (message.voice !== undefined) {
    out.push({
      kind: "voice",
      fileId: message.voice.file_id,
      mediaType: message.voice.mime_type ?? "audio/ogg",
      ...(message.voice.file_size !== undefined ? { declaredSize: message.voice.file_size } : {}),
    });
  }

  if (message.audio !== undefined) {
    out.push({
      kind: "audio",
      fileId: message.audio.file_id,
      mediaType: message.audio.mime_type ?? "audio/mpeg",
      ...(message.audio.file_size !== undefined ? { declaredSize: message.audio.file_size } : {}),
    });
  }

  if (message.document !== undefined) {
    const doc = message.document;
    out.push({
      kind: "document",
      fileId: doc.file_id,
      mediaType: doc.mime_type ?? "application/octet-stream",
      ...(doc.file_size !== undefined ? { declaredSize: doc.file_size } : {}),
      ...(doc.file_name !== undefined ? { name: doc.file_name } : {}),
    });
  }

  return out;
}

/** Build the neutral part for a fetched attachment. */
function buildPart(candidate: MediaCandidate, base64: string): ContentPart {
  const mediaType = candidate.mediaType.split(";")[0]!.trim().toLowerCase();
  const kind = partTypeForMediaType(mediaType);

  // `kind` is checked before download, so this is a narrowing aid rather than a
  // real branch; an unexpected value falls back to a document.
  if (kind === "image") return { type: "image", mediaType, base64 };
  if (kind === "audio") return { type: "audio", mediaType, base64 };
  return {
    type: "document",
    mediaType,
    base64,
    ...(candidate.name !== undefined ? { name: candidate.name } : {}),
  };
}

/** Fetch one file's bytes, base64-encoded. Returns undefined on any failure. */
async function download(
  ctx: Context,
  botToken: string,
  fileId: string,
): Promise<{ base64: string } | undefined> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (file.file_path === undefined) return undefined;
    // A path that is absolute or traverses upward is not one this bot should
    // fetch; the API never returns such a path, so its presence means the
    // response is not what it claims to be.
    if (file.file_path.startsWith("/") || file.file_path.includes("..")) return undefined;

    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) return undefined;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) return undefined;

    return { base64: buf.toString("base64") };
  } catch {
    // A network fault, a deleted file, or an expired file id all land here, and
    // all mean the same thing to the caller.
    return undefined;
  }
}

/** True when a message carries something this module can extract. */
export function hasMedia(message: NonNullable<Context["message"]>): boolean {
  return (
    message.photo !== undefined ||
    message.voice !== undefined ||
    message.audio !== undefined ||
    message.document !== undefined
  );
}
