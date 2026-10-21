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
import { InputFile } from "grammy";
import {
  base64Bytes,
  MAX_ATTACHMENT_BYTES,
  partTypeForMediaType,
} from "../ai/provider";
import type { ContentPart } from "../ai/provider";
import { fetchTelegramFileBytes } from "./telegram_file";

/** Why an attachment was not attached. */
export type MediaSkipReason = "too_large" | "too_long" | "download_failed" | "unsupported";

/** Voice notes / audio files longer than this are not transcribed or sent on. */
export const MAX_VOICE_AUDIO_SECONDS = 600;

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

    // A voice note or audio file past the duration cap is refused before any
    // download: transcribing a 40-minute memo would burn the owner's budget
    // and keep the turn hanging for minutes.
    if (
      (candidate.kind === "voice" || candidate.kind === "audio") &&
      candidate.durationSec !== undefined &&
      candidate.durationSec > MAX_VOICE_AUDIO_SECONDS
    ) {
      skipped.push({ kind: candidate.kind, reason: "too_long" });
      continue;
    }

    // The size Telegram reports lets an over-large file be refused without
    // downloading it at all.
    if (candidate.declaredSize !== undefined && candidate.declaredSize > MAX_DOWNLOAD_BYTES) {
      skipped.push({ kind: candidate.kind, reason: "too_large" });
      continue;
    }

    // A type with no mapping is one the adapters cannot carry, so there is no
    // point downloading it. A candidate carrying its own part type (the
    // thumbnail-less animation fallback) is exempt: its type was chosen by
    // the selection rules precisely because the mapping has no entry for it.
    if (candidate.partType === undefined && partTypeForMediaType(candidate.mediaType) === undefined) {
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
  /** Duration Telegram reported, in seconds, for voice/audio. */
  durationSec?: number;
  name?: string;
  /**
   * The part type to build, overriding the media-type mapping.
   *
   * Set only where the mapping has no entry for a type the pipeline must
   * still carry: an animation without a thumbnail arrives as video/mp4,
   * which `partTypeForMediaType` does not map (it is not a document type
   * in general), yet the file has to reach the provider as a document
   * part rather than be refused as "unsupported". Every other candidate
   * leaves this unset and follows the mapping.
   */
  partType?: ContentPart["type"];
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
      ...(message.voice.duration !== undefined ? { durationSec: message.voice.duration } : {}),
    });
  }

  if (message.audio !== undefined) {
    out.push({
      kind: "audio",
      fileId: message.audio.file_id,
      mediaType: message.audio.mime_type ?? "audio/mpeg",
      ...(message.audio.file_size !== undefined ? { declaredSize: message.audio.file_size } : {}),
      ...(message.audio.duration !== undefined ? { durationSec: message.audio.duration } : {}),
    });
  }

  if (message.animation !== undefined) {
    const anim = message.animation;
    if (anim.thumbnail !== undefined) {
      // A GIF is seen, not played: the model gets the thumbnail frame as an
      // image, the same treatment a photo gets. Downloading the mp4 itself
      // would buy nothing — most adapters cannot carry video at all.
      out.push({
        kind: "animation",
        fileId: anim.thumbnail.file_id,
        mediaType: "image/jpeg",
        ...(anim.thumbnail.file_size !== undefined
          ? { declaredSize: anim.thumbnail.file_size }
          : anim.file_size !== undefined
            ? { declaredSize: anim.file_size }
            : {}),
        ...(anim.file_name !== undefined ? { name: anim.file_name } : {}),
      });
    } else {
      // No thumbnail to stand in for the frame, so the file itself goes —
      // as a document part. video/mp4 has no part-type mapping (correctly:
      // a bare mp4 document is not silently a picture), but an animation is
      // visual media the user pointed at, so the candidate carries its
      // part type explicitly instead of dying as "unsupported". Adapters
      // that cannot consume video degrade through their named-note path.
      out.push({
        kind: "animation",
        fileId: anim.file_id,
        mediaType: anim.mime_type ?? "video/mp4",
        ...(anim.file_size !== undefined ? { declaredSize: anim.file_size } : {}),
        ...(anim.file_name !== undefined ? { name: anim.file_name } : {}),
        partType: "document",
      });
    }
  }

  if (message.document !== undefined) {
    const doc = message.document;
    // Telegram mirrors an animation into `document` (same file, video/mp4).
    // Emitting both would download one GIF twice and describe the mirror as
    // an unsupported document — the animation candidate above already
    // represents the file, so the mirror is suppressed.
    const isAnimationMirror =
      message.animation !== undefined &&
      doc.file_unique_id === message.animation.file_unique_id;
    if (!isAnimationMirror) {
      out.push({
        kind: "document",
        fileId: doc.file_id,
        mediaType: doc.mime_type ?? "application/octet-stream",
        ...(doc.file_size !== undefined ? { declaredSize: doc.file_size } : {}),
        ...(doc.file_name !== undefined ? { name: doc.file_name } : {}),
      });
    }
  }

  return out;
}

/** Build the neutral part for a fetched attachment. */
function buildPart(candidate: MediaCandidate, base64: string): ContentPart {
  const mediaType = candidate.mediaType.split(";")[0]!.trim().toLowerCase();
  // An explicit part type on the candidate wins: it exists for the one type
  // the mapping deliberately does not cover (a thumbnail-less animation).
  const kind = candidate.partType ?? partTypeForMediaType(mediaType);

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
  // The shared Telegram file fetch: timeout + streaming size cap enforced
  // there, so an over-cap or hung download fails instead of buffering the
  // whole body (or hanging the turn) first.
  const bytes = await fetchTelegramFileBytes(ctx.api, botToken, fileId, {
    maxBytes: MAX_DOWNLOAD_BYTES,
  });
  return bytes === undefined ? undefined : { base64: Buffer.from(bytes).toString("base64") };
}

/** True when a message carries something this module can extract. */
export function hasMedia(message: NonNullable<Context["message"]>): boolean {
  return (
    message.photo !== undefined ||
    message.voice !== undefined ||
    message.audio !== undefined ||
    message.animation !== undefined ||
    message.document !== undefined
  );
}

/**
 * Delivering media a tool produced for the user (the reverse direction).
 *
 * `ToolRunResult.media` carries bytes the model must NOT see (a generated
 * image, synthesised speech): they travel from the tool to the user without
 * entering the prompt, the transcript, or history. These helpers turn a
 * `ContentPart` into something grammY can send.
 *
 * SECURITY: the bytes originate from server-side tool code (e.g. a provider's
 * image endpoint), not from user input or model output. Callers cap the count
 * (`MAX_MEDIA_PER_REPLY`); each tool caps its own byte size.
 */

/** Max tool-produced media items delivered per reply, on every path. */
export const MAX_MEDIA_PER_REPLY = 4;

export type MediaSendKind = "photo" | "voice" | "video" | "audio" | "document";

/** File extension derived from a media type, sanitised — never raw input. */
function extFor(mediaType: string, fallback: string): string {
  const sub = mediaType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  return sub !== undefined && /^[a-z0-9]+$/.test(sub) ? sub : fallback;
}

/**
 * Describe how to send one tool-produced part. Returns undefined for text
 * parts (there is nothing to send — the text is already the reply).
 *
 * A document part is routed by its media type: video plays inline as a
 * video, audio arrives as an audio file, everything else stays a document.
 * (Audio PARTS are synthesized speech and stay voice notes; a downloaded
 * song is a document part with an audio type and must NOT become a voice
 * note — Telegram voice requires ogg/opus.)
 */
export function describeMediaPart(
  part: ContentPart,
): { kind: MediaSendKind; file: InputFile } | undefined {
  if (part.type === "text") return undefined;
  const bytes = Buffer.from(part.base64, "base64");
  if (part.type === "image") {
    return { kind: "photo", file: new InputFile(bytes, `bobi.${extFor(part.mediaType, "png")}`) };
  }
  if (part.type === "audio") {
    return { kind: "voice", file: new InputFile(bytes, `bobi.${extFor(part.mediaType, "ogg")}`) };
  }
  const name = part.name ?? `bobi.${extFor(part.mediaType, "bin")}`;
  if (part.mediaType.startsWith("video/")) {
    return { kind: "video", file: new InputFile(bytes, name) };
  }
  if (part.mediaType.startsWith("audio/")) {
    return { kind: "audio", file: new InputFile(bytes, name) };
  }
  return { kind: "document", file: new InputFile(bytes, name) };
}

/** The send operations a surface provides for tool-produced media. */
export interface MediaSenders {
  photo(file: InputFile): Promise<unknown>;
  voice(file: InputFile): Promise<unknown>;
  video(file: InputFile): Promise<unknown>;
  audio(file: InputFile): Promise<unknown>;
  document(file: InputFile): Promise<unknown>;
}

/**
 * Deliver the media parts a run produced, on any surface (bot handler,
 * scheduled runs, …) — the delivery obligation of the media contract.
 *
 * At most MAX_MEDIA_PER_REPLY parts are sent, but EVERY part is settled via
 * `onSettled` exactly once — after its send attempt, whether the send
 * succeeded, failed, or the part was past the cap. A producer whose media
 * carries a resource behind it (a downloaded temp file) hooks its cleanup
 * there, so the resource is released on every path and can never leak just
 * because a send failed or a reply was crowded. A failed send does not stop
 * the remaining parts; the first send error is rethrown once every part has
 * been attempted and settled, preserving the caller's failure handling.
 */
export async function deliverToolMedia(
  parts: readonly ContentPart[],
  senders: MediaSenders,
  onSettled?: (part: ContentPart) => Promise<void>,
): Promise<void> {
  let firstError: unknown;
  for (const [i, part] of parts.entries()) {
    try {
      if (i < MAX_MEDIA_PER_REPLY) {
        const m = describeMediaPart(part);
        if (m !== undefined) {
          if (m.kind === "photo") await senders.photo(m.file);
          else if (m.kind === "voice") await senders.voice(m.file);
          else if (m.kind === "video") await senders.video(m.file);
          else if (m.kind === "audio") await senders.audio(m.file);
          else await senders.document(m.file);
        }
      }
    } catch (err) {
      firstError ??= err;
    } finally {
      if (onSettled !== undefined) {
        try {
          await onSettled(part);
        } catch {
          // Settlement is cleanup: it must never mask the delivery outcome.
        }
      }
    }
  }
  if (firstError !== undefined) throw firstError;
}
