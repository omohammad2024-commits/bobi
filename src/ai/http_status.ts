/**
 * Shared HTTP-status → AiError mapping for every provider surface.
 *
 * The chat adapters (OpenAI-compatible, Gemini, Anthropic) and the audio
 * endpoints (transcription, TTS) all speak the same failure vocabulary, so
 * the mapping lives here exactly once. The rule is identical everywhere —
 * a response body is never echoed into an error, because a provider may
 * echo the request (and therefore a key) — but the numeric HTTP status IS
 * carried on the AiError and named in the message where it disambiguates:
 * an unmapped status used to collapse into "Unknown service error.", which
 * hid real causes (e.g. 402 = balance exhausted) from the owner entirely.
 */
import { AiError } from "./provider";

/** Map an HTTP status onto the engine's error categories. */
export function statusToAiError(status: number): AiError {
  if (status === 401 || status === 403) {
    return new AiError("auth", "Service authentication failed.", status);
  }
  if (status === 408) {
    return new AiError("timeout", "The service did not respond in time.", status);
  }
  // 402 is "your money/quota ran out", not a rate limit: it maps to quota
  // (another key or a failover candidate can fix it) but the message names
  // the balance, so the owner is not left guessing.
  if (status === 402) {
    return new AiError("quota", "Provider balance or quota is exhausted (HTTP 402).", status);
  }
  if (status === 429) {
    return new AiError("quota", "Service rate limit exceeded.", status);
  }
  if (status >= 500) {
    return new AiError("network", `Service is unavailable (HTTP ${status}).`, status);
  }
  if (status === 400 || status === 404 || status === 422) {
    // Request-shaped problems surface as invalid, never as the raw body.
    return new AiError("invalid_response", "The request to the service was invalid.", status);
  }
  if (status >= 400 && status < 500) {
    // Any other client error is still request-shaped: the provider refused
    // this request, and retrying it unchanged elsewhere does not help.
    return new AiError("invalid_response", `Provider rejected the request (HTTP ${status}).`, status);
  }
  // Anything else (1xx/3xx reaching here, or a non-standard code) is truly
  // unexpected — but the message still names the status.
  return new AiError("unknown", `Unexpected provider response (HTTP ${status}).`, status);
}
