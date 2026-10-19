/**
 * fetch_url — retrieve a web page and return it as text.
 *
 * The URL comes from the MODEL, which means it is untrusted input with full
 * attacker control. Everything that makes this safe already exists in the AI
 * transport layer and is reused rather than reimplemented:
 *
 *   - `validateTarget`   — lexical scheme/userinfo/private-host policy
 *   - `resolveTarget`    — resolves DNS and classifies EVERY address, which is
 *                          what defeats `localtest.me`-style rebinding
 *   - `pinnedFetch`      — binds the socket to a validated address, refuses
 *                          redirects, and caps the response body
 *
 * Reusing them is also why the local-target exception defaults to OFF here:
 * `resolveTarget` refuses loopback and RFC1918 unless explicitly allowed, so a
 * model cannot ask BOBI to read an internal service.
 *
 * Text extraction is delegated to `html.ts`. This module adds only what is
 * specific to fetching a page: a content-type allow-list, a redirect policy, and
 * a byte ceiling tighter than the transport's, since a page destined for a
 * model's context does not need 8 MB.
 */
import { AiError } from "../ai/provider";
import { resolveTarget } from "../ai/dns_guard";
import { pinnedFetch } from "../ai/pinned_transport";
import { ToolError } from "./errors";
import { htmlToText } from "./html";
import type { Tool, ToolContext } from "./types";

export const FETCH_URL_PERMISSION = "tools:fetch_url";

/**
 * Content types this tool will read. Anything else is refused, not guessed at.
 *
 * `application/xhtml+xml` is included because the request's `accept` header
 * advertises it: a server that honours the header would otherwise return a type
 * this tool rejects, which is a self-inflicted failure. The extractor handles it
 * as markup, the same as HTML.
 */
const READABLE_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
];

/**
 * Ceiling on the raw response body.
 *
 * Lower than the transport's 8 MB: this body is read into memory and then
 * reduced to text for a model's context, so a larger page is wasted work.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** How much text is handed to the model, after extraction. */
const MAX_TEXT_CHARS = 8_000;

/** Redirects are never followed automatically; see `fetchWithRedirects`. */
const MAX_REDIRECTS = 3;

export interface FetchUrlInput {
  url: string;
  /** Ask for raw text instead of extracted prose. */
  raw?: boolean;
  /** Override the extractor's output cap. */
  maxChars?: number;
}

export interface FetchUrlOutput {
  url: string;
  /** Final URL after redirects that were explicitly followed. */
  finalUrl: string;
  status: number;
  contentType: string;
  /** Extracted text. Truncated when the page was longer. */
  text: string;
  truncated: boolean;
}

export const fetchUrlTool: Tool<FetchUrlInput, FetchUrlOutput> = {
  name: "fetch_url",
  description:
    "Read a web page and convert it to text. Use it to read the details behind a link.",
  enabled: true,
  permission: { requires: [FETCH_URL_PERMISSION] },
  toolset: "web",
  input: {
    fields: {
      url: {
        type: "string",
        required: true,
        description: "Full page URL, with http or https.",
        minLength: 8,
        maxLength: 2_048,
      },
      raw: {
        type: "boolean",
        description: "When true, return raw text without content extraction.",
      },
      maxChars: {
        type: "integer",
        description: "Maximum characters of output text.",
        minimum: 200,
        maximum: 20_000,
      },
    },
  },

  async run(input: FetchUrlInput, ctx: ToolContext): Promise<FetchUrlOutput> {
    const url = normaliseUrl(input.url);
    const result = await fetchWithRedirects(url, ctx.signal);

    const contentType = (result.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (!isReadable(contentType)) {
      throw new ToolError(
        "invalid_input",
        `This URL's content type is not readable (${contentType || "unknown"}).`,
      );
    }

    const limit = input.maxChars ?? MAX_TEXT_CHARS;
    // A JSON or XML body is already text; running the HTML extractor over it
    // would strip the payload as if it were markup.
    const isMarkup = contentType === "text/html" || contentType === "application/xhtml+xml";
    const body = decodeBody(result.body, result.contentType ?? "");

    const text =
      input.raw === true || !isMarkup
        ? truncate(body, limit)
        : htmlToText(body, { maxChars: limit });

    if (text.trim().length === 0) {
      // An empty extraction is reported rather than returned as "": a model
      // given an empty string tends to invent what the page "said".
      throw new ToolError("invalid_result", "No text could be extracted from this page.");
    }

    return {
      url,
      finalUrl: result.finalUrl,
      status: result.status,
      contentType: contentType || "unknown",
      text,
      // Both truncation helpers mark a real cut with a trailing "…", so the
      // flag reflects an actual cut rather than text that merely reached the
      // cap exactly.
      truncated: text.endsWith("…"),
    };
  },
};

/** Reject non-http(s) and over-long URLs before any policy work. */
function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ToolError("invalid_input", "No URL was provided.");
  }
  if (trimmed.length > 2_048) {
    throw new ToolError("invalid_input", "The URL is too long.");
  }
  return trimmed;
}

function isReadable(contentType: string): boolean {
  return READABLE_TYPES.some((t) => contentType === t || contentType.startsWith(`${t}+`));
}

interface FetchResult {
  status: number;
  contentType: string | undefined;
  body: string;
  finalUrl: string;
}

/**
 * Fetch a page, following a bounded number of redirects manually.
 *
 * Redirects are followed HERE rather than by the transport, because each hop
 * must be re-validated as its own target: a public URL that redirects to
 * `http://169.254.169.254/` would otherwise be a complete SSRF bypass. The
 * transport never follows them, so a 3xx is a decision this function makes.
 */
async function fetchWithRedirects(startUrl: string, signal: AbortSignal): Promise<FetchResult> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resolved = await resolveAndAllow(current, signal);
    const res = await send(resolved.url, resolved.addresses, resolved.allowLocal, signal);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers["location"];
      if (typeof location !== "string" || location.length === 0) {
        throw new ToolError("invalid_result", "The service redirected to an invalid address.");
      }
      if (hop === MAX_REDIRECTS) {
        throw new ToolError("invalid_result", "Too many redirects.");
      }
      // Resolve relative to the current URL, as a browser would.
      current = new URL(location, current).toString();
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new ToolError("invalid_result", `The service responded with status ${res.status}.`);
    }

    return {
      status: res.status,
      contentType: res.headers["content-type"],
      body: res.body,
      finalUrl: current,
    };
  }

  // Unreachable: the loop either returns or throws on the final hop.
  throw new ToolError("invalid_result", "Fetching the page failed.");
}

/**
 * Apply the SSRF policy to one hop's URL.
 *
 * `allowLocalTargets` is deliberately not passed, so the default (public-only)
 * policy applies: a model cannot point BOBI at an internal address.
 */
async function resolveAndAllow(
  url: string,
  _signal: AbortSignal,
): Promise<{ url: string; addresses: readonly string[]; allowLocal: boolean }> {
  if (!/^https?:\/\//i.test(url)) {
    throw new ToolError("invalid_input", "The URL must start with http or https.");
  }

  try {
    const resolved = await resolveTarget({ baseUrl: url, apiKey: undefined });
    return { url: resolved.baseUrl, addresses: resolved.addresses, allowLocal: false };
  } catch (err) {
    // A guard rejection is a policy decision, not an infrastructure fault, and
    // the message deliberately does not repeat the resolved address.
    if (err instanceof AiError) {
      throw new ToolError("invalid_input", "This URL is not allowed or not reachable.");
    }
    throw new ToolError("internal", "Checking the URL failed.");
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

async function send(
  url: string,
  addresses: readonly string[],
  allowLocal: boolean,
  signal: AbortSignal,
): Promise<RawResponse> {
  try {
    const res = await pinnedFetch({
      url,
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9",
        "user-agent": "BOBI/0.0.1 (+agent)",
        "accept-language": "fa,en;q=0.8",
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal,
      addresses,
      allowLocalTargets: allowLocal,
    });

    return { status: res.status, headers: res.headers, body: capBody(res.body) };
  } catch (err) {
    if (err instanceof AiError) {
      throw new ToolError(mapAiError(err), "Fetching the page failed.");
    }
    throw new ToolError("internal", "Fetching the page failed.");
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Refuse an over-large body rather than truncating it.
 *
 * A truncated HTML document can cut mid-tag and produce misleading extracted
 * text, which is worse than an honest failure the model can report.
 */
function capBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new ToolError("invalid_result", "The page is too large.");
  }
  return body;
}

function mapAiError(err: AiError): "timeout" | "invalid_input" | "internal" {
  switch (err.kind) {
    case "timeout":
    case "aborted":
      return "timeout";
    case "invalid_response":
      return "invalid_input";
    default:
      return "internal";
  }
}

/**
 * The body as text.
 *
 * No re-decoding happens here, and that is deliberate: the transport already
 * produced a JavaScript string by decoding the bytes as UTF-8. A legacy charset
 * cannot be recovered from it — every byte ≥ 0x80 has already become U+FFFD, so
 * a "convert from windows-1256" step would re-encode those replacement
 * characters and yield mojibake, not the original text.
 *
 * A page that declares a non-UTF-8 charset therefore reads with replacement
 * characters for its non-ASCII run. Decoding it correctly would mean changing
 * the transport to hand back raw bytes, which is a larger change than this tool
 * warrants; the honest behaviour is to return what was actually received.
 *
 * `fetch_url` favours UTF-8 pages for this reason, and Persian content served
 * as UTF-8 — which is the norm — is unaffected.
 */
function decodeBody(body: string, contentType: string): string {
  void contentType;
  return body;
}

/** Cap text at `limit`, marking the cut. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const at = slice.lastIndexOf("\n");
  if (at >= limit * 0.75) return `${slice.slice(0, at).trimEnd()}…`;
  return `${slice.trimEnd()}…`;
}
