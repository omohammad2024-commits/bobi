/**
 * Conversation-history search tool (Phase D1).
 *
 * The model's long-term memory (remember/recall) covers facts it chose to
 * keep; this tool covers everything else that was ever said. It is the
 * "recall across sessions" half: a question answered last week is one
 * search_history call away, with the conversation id and role attached so
 * the model knows who said what, where.
 *
 * Scoping is the whole security story: the owner id comes from the
 * server-supplied ToolActor and is passed to storage.searchMessages, which
 * joins conversations on user_id. A conversationId argument can only narrow
 * within the caller's own conversations — a foreign id matches nothing, so
 * there is no path to another user's history through this tool.
 */
import { ToolError } from "./errors";
import type { Storage } from "../storage/storage";
import type { Tool, ToolActor, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const SEARCH_HISTORY_PERMISSION = "tools:search_history";

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

export interface HistoryDeps {
  storage: Storage;
}

// ---------- search_history ----------

export interface SearchHistoryInput {
  query: string;
  limit?: number;
  conversationId?: number;
}

export interface SearchHistoryOutput {
  /** Matching messages, best match first. */
  results: Array<{
    id: number;
    conversationId: number;
    role: "user" | "assistant" | "system";
    /** Snippet with the match wrapped in [ ]. */
    snippet: string;
  }>;
  total: number;
}

export const searchHistoryManifest: ToolManifest = defineManifest({
  id: "search_history",
  version: "1.0.0",
  title: "Search History",
  description:
    "Full-text search across conversation history; find earlier messages in any conversation. Only your own conversations are searched.",
  purpose: "past chat search",
  useWhen: "asked prior talk",
  doNotUseWhen: "Stored facts, not past messages — recall retrieves saved memories; this searches raw conversation history only.",
  confusableWith: [
    { tool: "recall", difference: "recall returns saved memory facts; search_history finds raw past messages with snippets." },
  ],
  latencyTier: "instant",
  outputSummary: "Matching message snippets with conversation ids, best match first.",
  category: "memory",
  triggers: {
    keywordPatterns: [
      "قبلاً گفتم",
      "قبلا گفتم",
      "تو چت قبلی",
      "تاریخچه مکالمه",
      "search (my )?(chat )?history",
      "what did (we|i) (talk|discuss) about",
    ],
  },
  costTier: "cheap",
});

export function createSearchHistoryTool(
  deps: HistoryDeps,
): Tool<SearchHistoryInput, SearchHistoryOutput> {
  return {
    name: "search_history",
    manifest: searchHistoryManifest,
    description:
      "Full-text search across conversation history; find earlier messages in any conversation. Only your own conversations are searched.",
    enabled: true,
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists). The actor's
    // userId still scopes the query server-side (see run); the tool takes no
    // user id from its input.
    permission: { requires: [SEARCH_HISTORY_PERMISSION] },
    ownerOnly: true,
    toolset: "memory",
    input: {
      fields: {
        query: {
          type: "string",
          required: true,
          description: "Search phrase in message text.",
          minLength: 1,
          maxLength: 200,
        },
        limit: {
          type: "integer",
          description: `Maximum results (1 to ${MAX_SEARCH_LIMIT}).`,
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
        },
        conversationId: {
          type: "integer",
          description: "Limit the search to one conversation (only your own).",
          minimum: 1,
        },
      },
    },

    async run(input: SearchHistoryInput, ctx: ToolContext): Promise<SearchHistoryOutput> {
      const query = input.query.trim();
      if (query.length === 0) {
        throw new ToolError("invalid_input", "Search query is empty.");
      }

      // SECURITY: the owner id comes from the server-supplied actor, never
      // from tool input. storage.searchMessages joins conversations on
      // user_id, so a conversationId that is not the caller's simply matches
      // nothing.
      const userId = ownerOf(ctx.actor);
      const limit = clampLimit(input.limit);
      const hits = deps.storage.conversations.searchMessages(query, {
        userId,
        limit,
        ...(input.conversationId !== undefined
          ? { conversationId: input.conversationId }
          : {}),
      });

      return {
        results: hits.map((h) => ({
          id: h.id,
          conversationId: h.conversationId,
          role: h.role,
          snippet: h.snippet,
        })),
        total: hits.length,
      };
    },
  };
}

/** Build the history tools. */
export function createHistoryTools(deps: HistoryDeps): readonly Tool<unknown, unknown>[] {
  return [createSearchHistoryTool(deps)] as unknown as readonly Tool<unknown, unknown>[];
}

// ---------- helpers ----------

/**
 * The owner id for this call.
 *
 * Taken from the server-supplied actor, never from tool input. An actor with no
 * usable id gets a refusal rather than a shared default, so two unidentified
 * callers can never end up searching one history space.
 */
function ownerOf(actor: ToolActor): string {
  const id = actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown; search is unavailable.");
  }
  return id;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  return n > MAX_SEARCH_LIMIT ? MAX_SEARCH_LIMIT : n;
}
