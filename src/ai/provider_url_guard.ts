/**
 * Provider type ↔ base-URL mismatch guard.
 *
 * A provider row binds an adapter TYPE (the wire format BOBI will speak)
 * to a base URL (the address it will speak it to). Nothing in the lexical
 * URL checks can tell that the two disagree — and when they do, every
 * request 404s against a route that does not exist on that host, which
 * used to surface only as a generic "Server error". The incident: a
 * native Gemini base URL stored under the openai_compatible type, so the
 * probe POSTed /v1beta/chat/completions to Google's native API.
 *
 * This module is the one shared cross-check. It is data-driven (a table
 * of known vendor hosts) and deliberately conservative: an unknown host
 * or a custom endpoint returns null, because self-hosted and proxied
 * endpoints legitimately live anywhere. Only a KNOWN vendor host paired
 * with the wrong wire format is an issue — that combination cannot work.
 *
 * Callers refuse the save with the issue's message; the suggestion, when
 * present, is the corrected base URL for the most likely intent.
 */

export interface ProviderUrlGuardIssue {
  /** Stable machine code, e.g. "gemini_native_under_openai". */
  code: string;
  /** Short, actionable, English. Names the fix, never a raw response. */
  message: string;
  /** The corrected base URL, when one is unambiguous. */
  suggestion?: string;
}

/** One known vendor API host and the adapter type that natively serves it. */
interface KnownHost {
  host: string;
  /** Human name of the vendor surface, for messages. */
  vendor: string;
  /** Adapter type whose wire format this host natively speaks. */
  nativeType: string;
  /** Human label of that native adapter, for messages. */
  nativeLabel: string;
  /** Canonical base URL of the native surface. */
  nativeBaseUrl: string;
}

const KNOWN_HOSTS: readonly KnownHost[] = [
  {
    host: "generativelanguage.googleapis.com",
    vendor: "Google Gemini",
    nativeType: "gemini",
    nativeLabel: "Google Gemini",
    nativeBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    host: "api.anthropic.com",
    vendor: "Anthropic",
    nativeType: "anthropic",
    nativeLabel: "Anthropic",
    nativeBaseUrl: "https://api.anthropic.com/v1",
  },
  {
    host: "api.openai.com",
    vendor: "OpenAI",
    nativeType: "openai_compatible",
    nativeLabel: "OpenAI-compatible",
    nativeBaseUrl: "https://api.openai.com/v1",
  },
];

/** Adapter types that speak a vendor-native (non-OpenAI) wire format. */
const NATIVE_TYPES: Readonly<Record<string, { label: string; baseUrl: string }>> = {
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  },
};

/** Google's OpenAI-compatible Gemini surface: the native path + /openai/. */
const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

/**
 * Check an adapter type against a base URL.
 *
 * Returns a ProviderUrlGuardIssue when the combination is a known-broken
 * mismatch, or null when it is fine — including every unknown host and
 * custom endpoint, which this guard never blocks.
 */
export function checkProviderUrl(
  adapterType: string,
  baseUrl: string,
): ProviderUrlGuardIssue | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // Unparseable input is the lexical validators' problem, not this
    // guard's: never block on a shape another layer already rejects.
    return null;
  }
  const host = url.hostname.toLowerCase();
  const known = KNOWN_HOSTS.find((k) => k.host === host);
  if (known === undefined) return null;
  const path = url.pathname;

  // Google Gemini: one host serves BOTH wire formats, split by path —
  // the native surface at /v1beta, the OpenAI-compatible one under
  // /v1beta/openai/. The type and the path segment must agree.
  if (known.host === "generativelanguage.googleapis.com") {
    const hasOpenAiSegment = path.includes("/openai");
    if (adapterType === "openai_compatible" && !hasOpenAiSegment) {
      return {
        code: "gemini_native_under_openai",
        message:
          "This is the native Google Gemini address, but the provider type is OpenAI-compatible — requests would 404. " +
          "Either pick the Google Gemini preset, or use the OpenAI-compatible URL.",
        suggestion: GEMINI_OPENAI_BASE_URL,
      };
    }
    if (adapterType === "gemini" && hasOpenAiSegment) {
      return {
        code: "gemini_openai_under_native",
        message:
          "This is Google's OpenAI-compatible address, but the provider type is the native Gemini adapter. " +
          "Either use the native Gemini address, or switch the type to OpenAI-compatible.",
        suggestion: known.nativeBaseUrl,
      };
    }
  }

  // Anthropic's host speaks only its native wire format; there is no
  // OpenAI-compatible surface on api.anthropic.com to fall back to.
  if (known.host === "api.anthropic.com" && adapterType === "openai_compatible") {
    return {
      code: "anthropic_native_under_openai",
      message:
        "This is the Anthropic address, but the provider type is OpenAI-compatible — Anthropic's API does not speak that format. " +
        "Pick the Anthropic (native) preset instead.",
      suggestion: known.nativeBaseUrl,
    };
  }

  // A native adapter (Gemini/Anthropic) pointed at ANOTHER vendor's known
  // host speaks the wrong wire format to the wrong service entirely.
  const native = NATIVE_TYPES[adapterType];
  if (native !== undefined && known.nativeType !== adapterType) {
    return {
      code: "native_type_wrong_host",
      message:
        `This address belongs to ${known.vendor}, but the provider type is ${native.label}. ` +
        `Use the ${native.label} address, or switch the provider type to match this URL.`,
      suggestion: native.baseUrl,
    };
  }

  return null;
}
