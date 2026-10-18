/**
 * Shared HTTP-status → AiError mapping for the audio endpoints.
 *
 * The transcription (whisper-compatible) and TTS (OpenAI speech) endpoints are
 * separate from the chat adapters, but their failure vocabulary is the same:
 * the bot layer turns these categories into short Persian messages. The rule
 * is identical everywhere — a response body is never echoed into an error,
 * because a provider may echo the request (and therefore a key).
 */
import { AiError } from "./provider";

/** Map a non-2xx HTTP status onto the engine's error categories. */
export function statusToAiError(status: number): AiError {
  if (status === 401 || status === 403) {
    return new AiError("auth", "احراز هویت سرویس ناموفق بود.");
  }
  if (status === 408) {
    return new AiError("timeout", "پاسخ سرویس به‌موقع نرسید.");
  }
  if (status === 429) {
    return new AiError("quota", "محدودیت نرخ سرویس پر شده است.");
  }
  if (status >= 500) {
    return new AiError("network", "سرویس در دسترس نیست.");
  }
  if (status === 400 || status === 404 || status === 422) {
    // Request-shaped problems surface as invalid, never as the raw body.
    return new AiError("invalid_response", "درخواست به سرویس نامعتبر بود.");
  }
  return new AiError("unknown", "خطای ناشناخته سرویس.");
}
