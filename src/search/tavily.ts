/**
 * Tavily search — the keyed provider.
 *
 * Used when the owner wants results that do not depend on reading a search
 * page's markup. The key is decrypted per request and handed to this class at
 * construction; it never travels with a request object and is never logged.
 *
 * Requests go through the same SSRF-guarded transport as the AI adapters, so a
 * DNS answer is validated before any socket is opened.
 */
import { AiError } from "../ai/provider";
import { resolveTarget, type ResolvedTarget } from "../ai/dns_guard";
import { pinnedFetch } from "../ai/pinned_transport";
import { SearchError } from "./provider";
import type { SearchProvider, SearchRequest, SearchResult } from "./provider";

const BASE_URL = "https://api.tavily.com";

export class TavilySearch implements SearchProvider {
  readonly type = "tavily" as const;
  readonly label = "Tavily";
  readonly needsKey = true;

  constructor(private readonly apiKey: string | undefined) {}

  async search(req: SearchRequest): Promise<readonly SearchResult[]> {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new SearchError("auth", "کلید سرویس جستجو تنظیم نشده است.");
    }

    const resolved = await resolveEndpoint();
    const body = JSON.stringify({
      query: req.query,
      max_results: clampLimit(req.limit),
      search_depth: "basic",
      // The model only needs the summary; asking for raw page content would
      // duplicate what fetch_url does and spend context on it twice.
      include_raw_content: false,
      include_answer: false,
    });

    let res;
    try {
      res = await pinnedFetch({
        url: `${resolved.baseUrl}/search`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // This service authenticates with a bearer token.
          authorization: `Bearer ${this.apiKey}`,
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

    if (res.status === 401 || res.status === 403) {
      throw new SearchError("auth", "کلید سرویس جستجو پذیرفته نشد.");
    }
    if (res.status === 429) {
      throw new SearchError("rate_limited", "سرویس جستجو موقتاً محدود شده است.");
    }
    if (res.status < 200 || res.status >= 300) {
      throw new SearchError("network", "سرویس جستجو پاسخ معتبری نداد.");
    }

    return parseTavilyResponse(res.body);
  }
}

async function resolveEndpoint(): Promise<ResolvedTarget> {
  try {
    return await resolveTarget({ baseUrl: BASE_URL, apiKey: undefined });
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

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  return n > 10 ? 10 : n;
}

/**
 * Parse a response body into results.
 *
 * Exported so it is tested against a captured payload. Only http(s) targets are
 * kept: a provider returning something else would otherwise hand the model a
 * URL that `fetch_url` must then refuse.
 */
export function parseTavilyResponse(raw: string): SearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SearchError("parse", "پاسخ سرویس جستجو قابل خواندن نبود.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SearchError("parse", "پاسخ سرویس جستجو قابل خواندن نبود.");
  }

  const results = (parsed as Record<string, unknown>)["results"];
  if (!Array.isArray(results)) return [];

  const out: SearchResult[] = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const url = typeof e["url"] === "string" ? e["url"] : undefined;
    if (url === undefined || !isHttpUrl(url)) continue;

    const title = typeof e["title"] === "string" ? e["title"].trim() : "";
    const content = typeof e["content"] === "string" ? e["content"].trim() : "";

    out.push({
      title: title.length > 0 ? title : url,
      url,
      snippet: content.length > 0 ? content : title,
    });
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
