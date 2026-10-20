/**
 * Search provider contract.
 *
 * Search is a *tool* concern (the model calls `web_search`), but the backing
 * service is configuration, so it lives beside the AI adapters rather than in
 * the tool layer. Two kinds are supported:
 *
 *  - `duckduckgo` — no credential, works out of the box. It reads a public
 *    HTML endpoint, which is a deployment property rather than an API contract,
 *    so a break shows up as a clear parse failure rather than silent nonsense.
 *  - `tavily` — a real API with a key, encrypted at rest like any other
 *    credential, for when the owner wants a dependable source.
 *
 * Credentials are never part of this interface: an implementation receives what
 * it needs at construction, and the key never travels with a request.
 */

/** One search hit. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchRequest {
  query: string;
  /** Maximum hits to return. Implementations may return fewer. */
  limit: number;
  timeoutMs: number;
  signal: AbortSignal;
}

/** Raised for a search failure whose message is safe to show a user. */
export class SearchError extends Error {
  constructor(
    readonly kind: "config" | "auth" | "network" | "timeout" | "parse" | "rate_limited",
    message: string,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

export interface SearchProvider {
  /** Stable slug, matching the stored setting. */
  readonly type: SearchProviderType;
  /** Persian label for the owner panel. */
  readonly label: string;
  /** True when this provider needs a stored credential. */
  readonly needsKey: boolean;
  search(req: SearchRequest): Promise<readonly SearchResult[]>;
}

export const SEARCH_PROVIDER_TYPES = ["duckduckgo", "tavily"] as const;
export type SearchProviderType = (typeof SEARCH_PROVIDER_TYPES)[number];

export function isSearchProviderType(value: string): value is SearchProviderType {
  return (SEARCH_PROVIDER_TYPES as readonly string[]).includes(value);
}

/** Templates offered in the owner panel. */
export interface SearchTemplate {
  type: SearchProviderType;
  label: string;
  needsKey: boolean;
  notes: string;
}

export const SEARCH_TEMPLATES: readonly SearchTemplate[] = [
  {
    type: "duckduckgo",
    label: "DuckDuckGo (no key)",
    needsKey: false,
    notes: "No account needed; reads the public results page.",
  },
  {
    type: "tavily",
    label: "Tavily (API key)",
    needsKey: true,
    notes: "Requires an API key; more stable results, suited for serious use.",
  },
] as const;

/** Short, user-safe Persian message per failure kind. */
export function userMessageForSearch(kind: SearchError["kind"]): string {
  switch (kind) {
    case "config":
      return "Search is not configured.";
    case "auth":
      return "The search service key was rejected.";
    case "network":
      return "Could not reach the search service.";
    case "timeout":
      return "Search timed out and was cancelled.";
    case "rate_limited":
      return "Search service is temporarily rate-limited; try again in a bit.";
    case "parse":
      return "The search result could not be parsed.";
  }
}
