/**
 * Attachment mapping, shared by the adapters.
 *
 * Every service expresses a non-text part differently on the wire, but the
 * decision of WHICH parts to send and how to describe them is the same
 * everywhere, so it lives here rather than being repeated three times.
 *
 * What stays per-adapter is the envelope: which key holds the parts, whether a
 * text part is a sibling object or a plain string, and what an unsupported type
 * should become.
 */
import { base64Bytes, MAX_ATTACHMENT_BYTES, partTypeForMediaType } from "./provider";
import type { ChatMessage, ContentPart } from "./provider";

/** A part the adapter can send, with the size and type already checked. */
export interface SendablePart {
  type: "image" | "audio" | "document";
  /** Normalised MIME type, lowercased and without parameters. */
  mediaType: string;
  /** Base64 payload, unchanged. */
  base64: string;
  /** File name, for a document. */
  name?: string;
}

export interface PartSelection {
  /** Attachments safe to send, in order. */
  sendable: SendablePart[];
  /**
   * Attachments that were dropped, with the reason.
   *
   * Reported rather than silently discarded: a user who sent a 20 MB PDF should
   * be told it was too large, not left wondering why the bot ignored it.
   */
  dropped: Array<{ mediaType: string; reason: "too_large" | "unsupported" }>;
}

/** Ceiling on attachments per message, so one turn cannot exhaust a request. */
export const MAX_PARTS_PER_MESSAGE = 8;

/**
 * Select the parts of a message that an adapter can actually send.
 *
 * Pure and provider-agnostic, so each adapter can call it and then only worry
 * about shaping the result.
 *
 * Caps, applied in order:
 *   1. TYPE ALLOWLIST — image/*, audio/*, application/pdf (see
 *      partTypeForMediaType). Anything else is dropped as "unsupported".
 *      Note: text/* documents are NOT sendable here; an adapter that can
 *      carry them as text (openai_compatible) handles them itself, before
 *      calling this.
 *   2. PER-PART BYTE CEILING — MAX_ATTACHMENT_BYTES (5 MiB) of decoded data,
 *      estimated from the base64 length without decoding. Over it is dropped
 *      as "too_large".
 *   3. PER-MESSAGE COUNT CEILING — MAX_PARTS_PER_MESSAGE (8) non-text parts.
 *      Anything beyond the cap is reported as "too_large" (the existing
 *      contract), so the note says the attachment could not be sent rather
 *      than silently ignoring it.
 */
export function selectParts(message: ChatMessage): PartSelection {
  const sendable: SendablePart[] = [];
  const dropped: PartSelection["dropped"] = [];

  if (message.parts === undefined) return { sendable, dropped };

  for (const part of message.parts.slice(0, MAX_PARTS_PER_MESSAGE)) {
    if (part.type === "text") continue;

    const kind = partTypeForMediaType(part.mediaType);
    if (kind === undefined || kind === "text") {
      dropped.push({ mediaType: normaliseMediaType(part.mediaType), reason: "unsupported" });
      continue;
    }

    // Sized before sending, so an over-large attachment fails with a clear
    // reason here rather than as an opaque provider error mid-run.
    if (base64Bytes(part.base64) > MAX_ATTACHMENT_BYTES) {
      dropped.push({ mediaType: normaliseMediaType(part.mediaType), reason: "too_large" });
      continue;
    }

    sendable.push({
      type: kind,
      mediaType: normaliseMediaType(part.mediaType),
      base64: part.base64,
      ...(part.type === "document" && part.name !== undefined ? { name: part.name } : {}),
    });
  }

  // Anything beyond the per-message cap is reported, not ignored.
  for (const part of message.parts.slice(MAX_PARTS_PER_MESSAGE)) {
    if (part.type === "text") continue;
    dropped.push({ mediaType: normaliseMediaType(part.mediaType), reason: "too_large" });
  }

  return { sendable, dropped };
}

/**
 * The named Persian note for one dropped attachment.
 *
 * Exported so an adapter that drops a part outside selectParts (e.g. a text
 * document past the byte ceiling) can use the exact same wording — a dropped
 * attachment is always NAMED, never silently discarded.
 */
export function partDropNote(
  mediaType: string,
  reason: "too_large" | "unsupported",
): string {
  return reason === "too_large"
    ? `[پیوست ${mediaType} ارسال نشد: حجم بیش از حد مجاز]`
    : `[پیوست ${mediaType} پشتیبانی نمی‌شود]`;
}

/** The text of a message, with any attachment descriptions appended. */
export function textWithPartNotes(message: ChatMessage): string {
  const { dropped } = selectParts(message);
  if (dropped.length === 0) return message.content;

  const notes = dropped.map((d) => partDropNote(d.mediaType, d.reason));
  return [message.content, ...notes].filter((s) => s.length > 0).join("\n");
}

function normaliseMediaType(mediaType: string): string {
  return mediaType.split(";")[0]!.trim().toLowerCase();
}

/** A data URL, which is how most services accept an inline attachment. */
export function dataUrl(part: SendablePart): string {
  return `data:${part.mediaType};base64,${part.base64}`;
}

/** The first part of a given kind, if any. */
export function firstPartOfType(
  parts: readonly ContentPart[],
  type: "image" | "audio" | "document",
): ContentPart | undefined {
  return parts.find((p) => p.type === type);
}
