/**
 * Voice-message transcription — POST {baseUrl}/audio/transcriptions.
 *
 * Used when the active AI provider cannot accept raw audio natively and the
 * owner configured a whisper-compatible transcription endpoint. Every request
 * goes through the SSRF-hardened chain (`resolveTarget` + `pinnedFetch`):
 * the hostname is resolved and classified before any socket opens, the socket
 * dials only approved addresses, and redirects are never followed.
 *
 * SECURITY: the audio bytes are the user's voice. They travel only to the
 * configured transcription endpoint through the pinned transport, are never
 * written to disk, never logged, and never persisted in history — only the
 * returned transcript (plain text) continues into the turn.
 */
import { AiError } from "./provider";
import { resolveTarget } from "./dns_guard";
import { pinnedFetch } from "./pinned_transport";
import { statusToAiError } from "./http_status";

/** Connection target for the transcription endpoint. */
export interface TranscribeOptions {
  /** Service base URL, e.g. https://api.openai.com/v1. */
  baseUrl: string;
  /** API key, sent as a Bearer token when set. */
  apiKey: string | undefined;
  /** Model id, e.g. whisper-1. */
  model: string;
  /** Owner opt-in for loopback/private transcription endpoints. */
  allowLocalTargets?: boolean;
}

/**
 * Per-request deadline, in milliseconds.
 *
 * Transcription of a voice note is slower than a chat round trip; this is the
 * budget for one request, not per address attempt.
 */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** Largest single audio payload this module will send, in bytes. */
export const MAX_TRANSCRIBE_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Transcribe one audio attachment.
 *
 * @param audio     Raw audio bytes (e.g. an .ogg voice note from Telegram).
 * @param mediaType MIME type of the audio, e.g. "audio/ogg".
 * @param signal    Caller cancellation.
 * @returns The transcript text. May be an empty string for silence — the
 *          caller decides whether an empty transcript is usable.
 * @throws AiError with a categorized kind on any failure. Never the raw body.
 */
export async function transcribeAudio(
  opts: TranscribeOptions,
  audio: Buffer,
  mediaType: string,
  signal: AbortSignal,
): Promise<string> {
  if (audio.byteLength === 0) {
    throw new AiError("invalid_response", "فایل صوتی خالی است.");
  }
  if (audio.byteLength > MAX_TRANSCRIBE_AUDIO_BYTES) {
    throw new AiError("invalid_response", "فایل صوتی بیش از حد بزرگ است.");
  }

  // Lexical policy + DNS resolution + address approval, per request — the same
  // chain the chat adapters use.
  const target = await resolveTarget(
    { baseUrl: opts.baseUrl, apiKey: opts.apiKey },
    ...(opts.allowLocalTargets === true ? [{ allowLocalTargets: true }] : []),
  );

  const { body, contentType } = buildTranscriptionForm(audio, mediaType, opts.model);
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": String(body.length),
    accept: "application/json",
  };
  if (opts.apiKey !== undefined && opts.apiKey.length > 0) {
    headers["authorization"] = `Bearer ${opts.apiKey}`;
  }

  const res = await pinnedFetch({
    url: `${target.baseUrl}/audio/transcriptions`,
    method: "POST",
    headers,
    body,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    signal,
    addresses: target.addresses,
    allowLocalTargets: target.allowLocalTargets,
  }).catch((err: unknown) => {
    // pinnedFetch already throws AiError with the right category.
    if (err instanceof AiError) throw err;
    throw new AiError("network", "ارتباط با سرویس رونویسی برقرار نشد.");
  });

  if (res.status >= 300 && res.status < 400) {
    throw new AiError("invalid_response", "سرویس به آدرس دیگری ارجاع داد.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw statusToAiError(res.status);
  }

  return parseTranscriptionText(res.body);
}

/**
 * Parse the whisper-compatible JSON response into transcript text.
 *
 * Success shape: `{ "text": "..." }`. Error shapes (`{ "error": ... }`) never
 * reach here — a non-2xx status is handled above, and the body is never
 * echoed. Exported so the wire format is assertable without a network.
 */
export function parseTranscriptionText(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiError("invalid_response", "پاسخ سرویس رونویسی قابل خواندن نبود.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AiError("invalid_response", "پاسخ سرویس رونویسی قابل خواندن نبود.");
  }
  const text = (parsed as Record<string, unknown>)["text"];
  // An empty string is a legitimate transcript (silence); a missing or
  // non-string `text` means the body is not the success shape.
  if (typeof text !== "string") {
    throw new AiError("invalid_response", "پاسخ سرویس رونویسی قابل خواندن نبود.");
  }
  return text;
}

/**
 * Build the multipart/form-data body for the transcription request.
 *
 * Fields: `file` (the audio, with a filename derived from the MIME type),
 * `model`, and `response_format=json`. Exported so the exact bytes sent on the
 * wire are assertable without a network.
 */
export function buildTranscriptionForm(
  audio: Buffer,
  mediaType: string,
  model: string,
): { body: Buffer; contentType: string } {
  const boundary = `----bobi${randomHex(16)}`;
  const chunks: Buffer[] = [];

  const field = (name: string, value: string): void => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  };

  field("model", model);
  field("response_format", "json");

  const filename = `voice.${extFor(mediaType)}`;
  chunks.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mediaType}\r\n\r\n`,
      "utf8",
    ),
  );
  chunks.push(audio);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** File extension derived from the audio MIME type; sanitised, never raw input. */
function extFor(mediaType: string): string {
  const sub = mediaType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  if (sub !== undefined && /^(ogg|oga|mp3|mpeg|wav|m4a|mp4|webm|flac|aac)$/.test(sub)) {
    return sub === "mpeg" ? "mp3" : sub;
  }
  return "ogg";
}

function randomHex(bytes: number): string {
  const out: string[] = [];
  for (let i = 0; i < bytes; i++) {
    out.push(Math.floor(Math.random() * 256).toString(16).padStart(2, "0"));
  }
  return out.join("");
}
