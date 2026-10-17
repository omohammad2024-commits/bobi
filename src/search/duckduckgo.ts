/**
 * DuckDuckGo search — the keyless default.
 *
 * This reads the public HTML results endpoint rather than an API, so there is
 * no account and nothing to configure. That convenience has a real cost: the
 * markup is not a published contract and may change. The response is therefore
 * parsed by an isolated pure function (`parseDuckDuckGoHtml`) tested against a
 * captured fixture, so a layout change surfaces as a failing test with a clear
 * cause rather than as silently empty results in production.
 *
 * The request goes through the same SSRF-guarded transport as everything else:
 * DNS is resolved and validated before a socket is opened.
 */
import { AiError } from "../ai/provider";
import { resolveTarget } from "../ai/dns_guard";
import { pinnedFetch } from "../ai/pinned_transport";
import { decodeEntities } from "../tools/html";
import { SearchError } from "./provider";
import type { SearchProvider, SearchRequest, SearchResult } from "./provider";

const ENDPOINT = "https://html.duckduckgo.com/html/";

export class DuckDuckGoSearch implements SearchProvider {
  readonly type = "duckduckgo" as const;
  readonly label = "DuckDuckGo";
  readonly needsKey = false;

  async search(req: SearchRequest): Promise<readonly SearchResult[]> {
    const resolved = await resolveEndpoint();

    // The endpoint is a POST form; the query travels in the body so it never
    // appears in a URL that could be logged in full.
    const body = new URLSearchParams({ q: req.query, kl: "wt-wt" }).toString();

    let res;
    try {
      res = await pinnedFetch({
        url: resolved.baseUrl,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        },
        body,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        addresses: resolved.addresses,
        allowLocalTargets: false,
      });
    } catch (err) {
      if (err instanceof AiError) throw mapTransportError(err);
      throw new SearchError("network", "ارتباط با سرویس جستجو برقرار نشد.");
    }

    if (res.status === 429 || res.status === 503) {
      throw new SearchError("rate_limited", "سرویس جستجو موقتاً محدود شده است.");
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SearchError("network", "سرویس جستجو پاسخ معتبری نداد.");
    }

    const results = parseDuckDuckGoHtml(res.body, req.limit);
    if (results.length === 0) {
      // Distinguished from "no matches": a page that parsed to nothing at all
      // most likely changed shape, and saying so is more useful than an empty
      // list that reads as "the web has no answer".
      throw new SearchError("parse", "نتیجه‌ای از صفحهٔ جستجو استخراج نشد.");
    }
    return results;
  }
}

/** Resolve the endpoint once per call, under the public-only policy. */
async function resolveEndpoint() {
  try {
    return await resolveTarget({ baseUrl: ENDPOINT, apiKey: undefined });
  } catch {
    throw new SearchError("config", "نشانی سرویس جستجو قابل استفاده نیست.");
  }
}

function mapTransportError(err: AiError): SearchError {
  switch (err.kind) {
    case "timeout":
    case "aborted":
      return new SearchError("timeout", "جستجو طول کشید و لغو شد.");
    case "invalid_response":
      return new SearchError("config", "نشانی سرویس جستجو قابل استفاده نیست.");
    default:
      return new SearchError("network", "ارتباط با سرویس جستجو برقرار نشد.");
  }
}

/**
 * Parse the results page.
 *
 * Pure and exported so it is tested against a captured fixture. The structure
 * relied on is the result block (`result__a` for the link, `result__snippet`
 * for the summary), which is the stable part of this page's markup.
 *
 * Redirect-wrapped links (`/l/?uddg=...`) are unwrapped to their real target,
 * because that is the URL a user actually wants and the one `fetch_url` can
 * follow.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Locate each result anchor, keeping its attributes so the href can be read.
  const anchor = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>/gi;
  for (const match of html.matchAll(anchor)) {
    if (results.length >= limit) break;

    const tag = match[0];
    const start = match.index + tag.length;

    const href = attrValue(tag, "href");
    if (href === undefined) continue;

    const url = unwrapRedirect(href);
    if (url === undefined || seen.has(url)) continue;

    // The anchor's text runs from just after its opening tag to `</a>`, so the
    // split must be on the tag END — splitting on the tag itself would leave
    // the attribute text in front of the title.
    const title = cleanText(stripTags(textUntilClose(html.slice(start, start + 4_000))));
    if (title.length === 0) continue;

    // The snippet follows in a sibling element within the same result block.
    const snippet = cleanText(extractSnippet(html.slice(start, start + 6_000)));

    seen.add(url);
    results.push({
      title,
      url,
      snippet: snippet.length > 0 ? snippet : title,
    });
  }

  return results;
}

/** Read an attribute from a tag's text. */
function attrValue(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag);
  return match?.[1];
}

/** Text up to the anchor's closing tag. */
function textUntilClose(block: string): string {
  const end = block.indexOf("</a>");
  return end === -1 ? block.slice(0, 2_000) : block.slice(0, end);
}

/**
 * The snippet that follows this result's anchor.
 *
 * The layout has used both an anchor and a div for this element across
 * versions, so both are accepted. The non-greedy match stops at the first
 * closing tag, which keeps one result's snippet from swallowing the next.
 */
function extractSnippet(block: string): string {
  const match =
    /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block);
  return match ? stripTags(match[1]!) : "";
}

/** Drop tags, decode entities, and collapse whitespace. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Unwrap a `/l/?uddg=<encoded>` redirect into its real target.
 *
 * A malformed href is dropped rather than passed through: a URL that cannot be
 * parsed cannot be fetched either, and handing the model one would only produce
 * a confusing failure later.
 *
 * Parsing is deliberately NOT done with `new URL(href, ENDPOINT)`. That resolves
 * anything it cannot parse as a relative reference, so `"ht tp://bad"` would
 * silently become a path on the search site itself — a plausible-looking URL
 * that is not the result the page intended.
 */
function unwrapRedirect(href: string): string | undefined {
  // A protocol-relative href is the one relative form this page really emits.
  const absolute = href.startsWith("//") ? `https:${href}` : href;

  // Anything else must already be an absolute http(s) URL.
  if (!/^https?:\/\//i.test(absolute)) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  // A redirect wrapper carries its real target in `uddg`.
  const target = parsed.searchParams.get("uddg");
  if (target === null) return parsed.toString();

  let real: URL;
  try {
    real = new URL(target);
  } catch {
    return undefined;
  }
  return real.protocol === "http:" || real.protocol === "https:" ? real.toString() : undefined;
}
