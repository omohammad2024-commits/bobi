/**
 * Shared HTTP-status → AiError mapping for every provider surface.
 *
 * The chat adapters (OpenAI-compatible, Gemini, Anthropic) and the audio
 * endpoints (transcription, TTS) all speak the same failure vocabulary, so
 * the mapping lives here exactly once. The numeric HTTP status IS carried
 * on the AiError and named in the message where it disambiguates: an
 * unmapped status used to collapse into "Unknown service error.", which
 * hid real causes (e.g. 402 = balance exhausted) from the owner entirely.
 *
 * One narrow, deliberate exception to the old "never echo a body" rule:
 * when the caller hands the mapper the response body, the provider's OWN
 * error words are extracted (JSON error.message / error / message /
 * detail, else a sanitized text snippet), scrubbed, credential-redacted
 * and hard-capped, then carried on AiError.providerMessage. A provider
 * that explains itself ("API key required for remote API access") must
 * not be flattened into a bare label — but the raw body still never
 * leaves this module.
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

/** How much of a non-2xx response body is even looked at, in chars. */
export const PROVIDER_BODY_READ_LIMIT = 600;

/** Hard cap on the extracted provider message, in chars. */
export const PROVIDER_MESSAGE_LIMIT = 300;

/**
 * Append ` (HTTP <status>)` to a message — idempotently.
 *
 * The canonical appender: several surfaces used to hand-roll this and one
 * (the miniapp probe detail) appended unconditionally, so a stored probe
 * message that already ended in "(HTTP 403)" rendered as
 * "(HTTP 403). (HTTP 403)". Never append when the message already names
 * that exact status.
 */
export function withHttpStatusSuffix(message: string, status: number): string {
  if (message.includes(`(HTTP ${status})`)) return message;
  return `${message} (HTTP ${status})`;
}

/**
 * Extract the provider's own error words from a non-2xx response body.
 *
 * JSON bodies are read for `error.message` (record error), `error`
 * (string), `message`, then `detail` (string, or a FastAPI-style array of
 * `{msg}` entries joined with "; "). Anything else falls back to the body
 * itself as a plain-text snippet: HTML tags stripped, control characters
 * removed, whitespace collapsed. The result is scrubbed (see
 * sanitizeProviderText) and hard-capped; an empty or unusable body yields
 * undefined, so callers behave exactly as before.
 */
export function extractProviderMessage(
  body: string | undefined,
  secret?: string,
): string | undefined {
  if (body === undefined) return undefined;
  const bounded = body.slice(0, PROVIDER_BODY_READ_LIMIT);
  if (bounded.trim().length === 0) return undefined;

  let candidate: string | undefined;
  let parsedJson = false;
  try {
    const parsed: unknown = JSON.parse(bounded);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      parsedJson = true;
      candidate = errorStringFromRecord(parsed as Record<string, unknown>);
    }
  } catch {
    // Not JSON — the plain-text snippet below handles it.
  }
  // A body that IS JSON but names no error field has no words worth
  // quoting — never surface raw JSON punctuation as a "provider message".
  if (candidate === undefined) {
    if (parsedJson) return undefined;
    candidate = bounded;
  }

  candidate = unwrapNestedProviderText(candidate);

  const cleaned = sanitizeProviderText(candidate, secret);
  if (cleaned.length === 0) return undefined;
  return cleaned.length > PROVIDER_MESSAGE_LIMIT
    ? `${cleaned.slice(0, PROVIDER_MESSAGE_LIMIT - 1)}…`
    : cleaned;
}

/**
 * The provider's error words from one parsed JSON record: `error.message`
 * (record error), `error` (string), `message`, then `detail` (string, or a
 * FastAPI-style array of `{msg}` entries joined with "; "). Undefined when
 * the record names none of them.
 */
function errorStringFromRecord(record: Record<string, unknown>): string | undefined {
  const error = record["error"];
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>)["message"] === "string"
  ) {
    return (error as Record<string, unknown>)["message"] as string;
  }
  if (typeof record["message"] === "string") {
    return record["message"];
  }
  const detail = record["detail"];
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) =>
        typeof item === "object" && item !== null &&
        typeof (item as Record<string, unknown>)["msg"] === "string"
          ? ((item as Record<string, unknown>)["msg"] as string)
          : "",
      )
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts.join("; ");
  }
  return undefined;
}

/**
 * Unwrap a provider string that is itself a serialized error envelope.
 *
 * Some routers relay an upstream failure by embedding its raw body as a
 * string inside their own error JSON — a 9Router probe answered with an
 * error string of `[403]: {"type":"error","error":{…,"message":
 * "OpenCode's free models aren't available…"}}` — so the extracted
 * "message" was the whole nested document, relay prefix and braces
 * included. When the extracted string (after an optional `[NNN]:` relay
 * prefix) parses as JSON carrying the usual error fields, replace it
 * with the inner sentence; at most two levels, so a pathological relay
 * chain still terminates. Anything that does not parse, or parses
 * without error fields, is left exactly as extracted. Redaction and the
 * length cap still apply afterwards, in the caller.
 */
function unwrapNestedProviderText(candidate: string): string {
  let current = candidate;
  for (let level = 0; level < 2; level++) {
    const stripped = current.replace(/^\[\d{3}\]:\s*/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      break;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) break;
    const inner = errorStringFromRecord(parsed as Record<string, unknown>);
    if (inner === undefined || inner === current) break;
    current = inner;
  }
  return current;
}

/**
 * Make provider-supplied text safe to surface: remove HTML tags and
 * control characters, collapse whitespace, and redact every occurrence
 * of the exact credential used for the request (a provider may echo the
 * request — headers, URL, key and all — inside its error body). The
 * redaction only applies to plausible credential lengths: below 4 chars
 * the "secret" is a substring of ordinary words ("k" in "key") and
 * redacting it would shred the very diagnosis being surfaced.
 */
function sanitizeProviderText(text: string, secret?: string): string {
  let out = text;
  if (secret !== undefined && secret.length >= 4) {
    out = out.split(secret).join("•••");
  }
  return out
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map an HTTP status onto the engine's error categories.
 *
 * `headers` is optional: when the caller has the response headers (the
 * pinned transport always returns them), a `Retry-After` on a 429 or 503
 * is parsed onto the error so the gateway's retry can honor it. Only
 * those two statuses carry it — a Retry-After on any other response is
 * not a backoff instruction.
 *
 * `body` is optional: when the caller has the response body, the
 * provider's own error words are extracted from it (sanitized, capped,
 * credential-redacted) and attached as AiError.providerMessage.
 */
export function statusToAiError(
  status: number,
  headers?: Record<string, string | undefined>,
  body?: { body?: string | undefined; secret?: string | undefined },
): AiError {
  const mapped = mapStatusToAiError(status, headers);
  const providerMessage = extractProviderMessage(body?.body, body?.secret);
  if (providerMessage === undefined) return mapped;
  return new AiError(
    mapped.kind,
    mapped.message,
    mapped.status,
    mapped.retryAfterMs,
    mapped.emptyResponse,
    mapped.attempts,
    providerMessage,
  );
}

function mapStatusToAiError(
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
