/**
 * Text-to-speech — POST {baseUrl}/audio/speech (OpenAI speech shape).
 *
 * Used when a user enables voice replies with /voice. Every request goes
 * through the SSRF-hardened chain (`resolveTarget` + `pinnedFetch`): the
 * hostname is resolved and classified before any socket opens, the socket
 * dials only approved addresses, and redirects are never followed.
 *
 * SECURITY: the input text is the bot's own reply (model output), not user
 * audio — but the same rule applies: bytes travel only to the configured TTS
 * endpoint through the pinned transport, are never written to disk, never
 * logged, and never persisted. The returned audio is delivered to the user and
 * then dropped.
 */
import { AiError } from "./provider";
import { resolveTarget } from "./dns_guard";
import { pinnedFetch } from "./pinned_transport";
import { statusToAiError } from "./http_status";

/** Connection target for the TTS endpoint. */
export interface TtsOptions {
  /** Service base URL, e.g. https://api.openai.com/v1. */
  baseUrl: string;
  /** API key, sent as a Bearer token when set. */
  apiKey: string | undefined;
  /** Model id, e.g. tts-1. */
  model: string;
  /** Voice id, e.g. alloy. */
  voice: string;
  /** Owner opt-in for loopback/private TTS endpoints. */
  allowLocalTargets?: boolean;
}

/** The synthesised reply: raw audio bytes plus their media type. */
export interface SpeechResult {
  /** Audio bytes (ogg/opus when response_format is "opus"). */
  audio: Buffer;
  /** Media type of the bytes, e.g. "audio/ogg". */
  mediaType: string;
}

/**
 * Max input characters per synthesis call.
 *
 * A long reply is split by the CALLER (see `splitForSpeech`); this function
 * rejects an over-long input outright rather than silently truncating speech
 * the user would never hear.
 */
export const MAX_TTS_CHARS = 4_000;

/**
 * Per-request deadline, in milliseconds.
 *
 * Synthesising up to 4000 characters takes longer than a chat round trip; this
 * is the budget for one request, not per address attempt.
 */
export const TTS_TIMEOUT_MS = 90_000;

/** How many reply chunks become voice before the rest stays text. */
export const MAX_VOICE_CHUNKS = 2;

/** Total voice characters per reply before the rest stays text. */
export const MAX_VOICE_CHARS = 8_000;

/**
 * Synthesise one text into speech.
 *
 * Requests `response_format: "opus"` (ogg/opus), which Telegram accepts as a
 * voice message. Throws AiError with a categorized kind on any failure — never
 * the raw body.
 */
export async function synthesizeSpeech(
  opts: TtsOptions,
  text: string,
  signal: AbortSignal,
): Promise<SpeechResult> {
  if (text.length === 0) {
    throw new AiError("invalid_response", "متنی برای تبدیل به صدا داده نشد.");
  }
  if (text.length > MAX_TTS_CHARS) {
    // The caller chunks; silently cutting speech would drop words the user
    // never hears, so this is a hard rejection instead.
    throw new AiError(
      "invalid_response",
      `متن بیش از حد طولانی است (حداکثر ${MAX_TTS_CHARS} کاراکتر در هر درخواست).`,
    );
  }

  // Lexical policy + DNS resolution + address approval, per request — the same
  // chain the chat adapters use.
  const target = await resolveTarget(
    { baseUrl: opts.baseUrl, apiKey: opts.apiKey },
    ...(opts.allowLocalTargets === true ? [{ allowLocalTargets: true }] : []),
  );

  const payload = JSON.stringify({
    model: opts.model,
    input: text,
    voice: opts.voice,
    response_format: "opus",
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload, "utf8")),
    accept: "audio/*",
  };
  if (opts.apiKey !== undefined && opts.apiKey.length > 0) {
    headers["authorization"] = `Bearer ${opts.apiKey}`;
  }

  const res = await pinnedFetch({
    url: `${target.baseUrl}/audio/speech`,
    method: "POST",
    headers,
    body: payload,
    timeoutMs: TTS_TIMEOUT_MS,
    signal,
    addresses: target.addresses,
    allowLocalTargets: target.allowLocalTargets,
  }).catch((err: unknown) => {
    // pinnedFetch already throws AiError with the right category.
    if (err instanceof AiError) throw err;
    throw new AiError("network", "ارتباط با سرویس صوتی برقرار نشد.");
  });

  if (res.status >= 300 && res.status < 400) {
    throw new AiError("invalid_response", "سرویس به آدرس دیگری ارجاع داد.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw statusToAiError(res.status);
  }

  const bytes = res.rawBody;
  if (bytes.byteLength === 0) {
    throw new AiError("invalid_response", "سرویس صوتی پاسخی برنگرداند.");
  }

  // Trust the response's own content type when it names audio; otherwise the
  // requested "opus" format is ogg/opus by definition.
  const declared = res.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  const mediaType =
    declared !== undefined && declared.startsWith("audio/") ? declared : "audio/ogg";

  return { audio: bytes, mediaType };
}

/**
 * Split text into synthesis-sized pieces on character boundaries.
 *
 * Pure, so the caller-side chunking contract is assertable without a network.
 * Splits mid-word when necessary: TTS has no sentence model, and a hard cut is
 * more honest than the caller guessing at sentence ends.
 */
export function splitForSpeech(text: string, maxChars = MAX_TTS_CHARS): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    out.push(rest.slice(0, maxChars));
    rest = rest.slice(maxChars);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/**
 * Decide which reply chunks become voice and which stay text.
 *
 * Pure, so the delivery plan is assertable without a network or Telegram.
 * Caps, applied in order: at most MAX_VOICE_CHUNKS chunks and MAX_VOICE_CHARS
 * characters become voice (each split to MAX_TTS_CHARS); everything past the
 * caps stays text so no content is lost.
 */
export function planVoiceDelivery(chunks: readonly string[]): {
  voice: string[];
  text: string[];
} {
  const voice: string[] = [];
  const text: string[] = [];
  let used = 0;

  chunks.forEach((chunk, index) => {
    if (chunk.length === 0) return;
    if (index < MAX_VOICE_CHUNKS && used < MAX_VOICE_CHARS) {
      const room = MAX_VOICE_CHARS - used;
      const head = chunk.length <= room ? chunk : chunk.slice(0, room);
      used += head.length;
      voice.push(...splitForSpeech(head));
      const tail = chunk.slice(head.length);
      if (tail.length > 0) text.push(tail);
    } else {
      text.push(chunk);
    }
  });

  return { voice, text };
}
