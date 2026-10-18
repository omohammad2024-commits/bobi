/**
 * web_search — find pages matching a query.
 *
 * Unlike the pure built-in tools, this one needs configuration, so it is a
 * factory: the caller supplies a resolver that returns the active provider.
 * That keeps the tool layer free of any storage or credential knowledge.
 *
 * Results are DATA, never instructions. A snippet is attacker-controllable text
 * from an arbitrary page, so the caller wraps everything this returns as tool
 * output, which the system prompt declares to be data rather than a command.
 */
import { ToolError } from "./errors";
import { SearchError, userMessageForSearch } from "../search/provider";
import type { SearchProvider, SearchResult } from "../search/provider";
import type { Tool, ToolContext } from "./types";

export const WEB_SEARCH_PERMISSION = "tools:web_search";

/** Default and maximum hit count. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** Per-search deadline. */
const SEARCH_TIMEOUT_MS = 15_000;

export interface WebSearchInput {
  query: string;
  limit?: number;
}

export interface WebSearchOutput {
  query: string;
  /** Provider that answered, so the model can say where results came from. */
  provider: string;
  results: SearchResult[];
}

export interface WebSearchToolDeps {
  /**
   * Resolve the active provider for this call.
   *
   * Called per search, never cached, so a settings change takes effect on the
   * next search without a restart. Throws to signal a configuration failure.
   */
  resolve(): SearchProvider;
}

/**
 * Build the web_search tool.
 *
 * `enabled` is decided by the caller: a deployment with no search provider
 * configured registers this disabled, so the model is never told about a tool
 * that cannot work.
 */
export function createWebSearchTool(deps: WebSearchToolDeps): Tool<WebSearchInput, WebSearchOutput> {
  return {
    name: "web_search",
    description:
      "جستجوی وب. برای پیدا کردن اطلاعات تازه یا منابع بیرون از دانش مدل استفاده کن.",
    enabled: true,
    permission: { requires: [WEB_SEARCH_PERMISSION] },
    toolset: "web",
    input: {
      fields: {
        query: {
          type: "string",
          required: true,
          description: "عبارت جستجو.",
          minLength: 2,
          maxLength: 400,
        },
        limit: {
          type: "integer",
          description: `تعداد نتایج (۱ تا ${MAX_LIMIT}، پیش‌فرض ${DEFAULT_LIMIT}).`,
          minimum: 1,
          maximum: MAX_LIMIT,
        },
      },
    },

    async run(input: WebSearchInput, ctx: ToolContext): Promise<WebSearchOutput> {
      const query = input.query.trim();
      if (query.length === 0) {
        throw new ToolError("invalid_input", "عبارت جستجو خالی است.");
      }

      const provider = deps.resolve();
      const limit = clampLimit(input.limit);

      try {
        const results = await provider.search({
          query,
          limit,
          timeoutMs: SEARCH_TIMEOUT_MS,
          signal: ctx.signal,
        });

        if (results.length === 0) {
          // An honest empty result, distinct from a failure: the model should
          // say nothing was found rather than retry the same query.
          throw new ToolError("invalid_result", "نتیجه‌ای برای این جستجو پیدا نشد.");
        }

        // Re-checked here rather than trusted from the provider: only http(s)
        // targets are useful, since fetch_url would refuse anything else.
        //
        // The filter runs BEFORE the emptiness check, so a provider that
        // returned only unusable URLs is reported as "nothing found" rather
        // than as a successful search with an empty list — the model cannot
        // tell those apart, and would present an empty result as an answer.
        const usable = results.slice(0, limit).filter((r) => isHttpUrl(r.url));
        if (usable.length === 0) {
          throw new ToolError("invalid_result", "نتیجهٔ قابل استفاده‌ای پیدا نشد.");
        }

        return { query, provider: provider.label, results: usable };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if (err instanceof SearchError) {
          throw new ToolError(searchKindToTool(err), userMessageForSearch(err.kind));
        }
        // An unexpected throw is reported without its internals.
        throw new ToolError("internal", "جستجو ناموفق بود.");
      }
    },
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  return n > MAX_LIMIT ? MAX_LIMIT : n;
}

/** Map a search failure onto the tool layer's categories. */
function searchKindToTool(err: SearchError): "invalid_input" | "not_allowed" | "timeout" | "internal" {
  switch (err.kind) {
    case "config":
      // Not the model's fault and not retryable by it.
      return "not_allowed";
    case "auth":
      return "not_allowed";
    case "timeout":
      return "timeout";
    case "parse":
    case "network":
    case "rate_limited":
      return "internal";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
