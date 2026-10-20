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

/** Ceiling on a honored Retry-After delay, ms. */
export const RETRY_AFTER_MAX_MS = 30_000;

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 * Both wire forms are honored: delta-seconds (`Retry-After: 5`) and an
 * HTTP-date (`Retry-After: Tue, 20 Oct 2026 06:00:00 GMT`). The result is
 * clamped to 0–30000 — a provider asking for minutes of backoff gets its
 * floor respected only up to the cap, and a date in the past reads as 0.
 * Anything unparseable yields undefined (the caller falls back to its own
 * backoff), never a throw: a garbage header must not break a request.
 */
export function parseRetryAfterMs(
  value: string | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const clamp = (ms: number): number =>
    Math.min(RETRY_AFTER_MAX_MS, Math.max(0, Math.round(ms)));
  if (/^\d+$/.test(trimmed)) return clamp(Number(trimmed) * 1000);
  // Date.parse is lenient enough to accept things like "-5" as a date;
  // an HTTP-date always carries a weekday/month name, so require letters
  // before trusting the parse.
  if (!/[A-Za-z]/.test(trimmed)) return undefined;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return clamp(dateMs - nowMs);
  return undefined;
}

/**
 * Map an HTTP status onto the engine's error categories.
 *
 * `headers` is optional: when the caller has the response headers (the
 * pinned transport always returns them), a `Retry-After` on a 429 or 503
 * is parsed onto the error so the gateway's retry can honor it. Only
 * those two statuses carry it — a Retry-After on any other response is
 * not a backoff instruction.
 */
export function statusToAiError(
  status: number,
  headers?: Record<string, string | undefined>,
): AiError {
  const retryAfterMs =
    status === 429 || status === 503
      ? parseRetryAfterMs(headers?.["retry-after"])
      : undefined;
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
    return new AiError("quota", "Service rate limit exceeded.", status, retryAfterMs);
  }
  if (status >= 500) {
    return new AiError("network", `Service is unavailable (HTTP ${status}).`, status, retryAfterMs);
  }
  if (status === 400 || status === 404 || status === 422) {
    // Request-shaped problems surface as invalid, never as the raw body —
    // but the message still names the status, like every other branch: a
    // 404 (wrong address) and a 400 (bad request) need different fixes.
    return new AiError(
      "invalid_response",
      `The request to the service was invalid (HTTP ${status}).`,
      status,
    );
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
