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

export function createSearchHistoryTool(
  deps: HistoryDeps,
): Tool<SearchHistoryInput, SearchHistoryOutput> {
  return {
    name: "search_history",
    description:
      "در تاریخچهٔ گفتگوها جستجوی تمام‌متن کن؛ برای پیدا کردن حرف‌های قبلی در هر گفتگویی. فقط گفتگوهای خودت جستجو می‌شود.",
    enabled: true,
    // NOT ownerOnly: any authorized user may search their OWN history. The
    // actor's userId scopes the query server-side (see run); the tool takes
    // no user id from its input.
    permission: { requires: [SEARCH_HISTORY_PERMISSION] },
    toolset: "memory",
    input: {
      fields: {
        query: {
          type: "string",
          required: true,
          description: "عبارت جستجو در متن پیام‌ها.",
          minLength: 1,
          maxLength: 200,
        },
        limit: {
          type: "integer",
          description: `حداکثر تعداد نتیجه (۱ تا ${MAX_SEARCH_LIMIT}).`,
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
        },
        conversationId: {
          type: "integer",
          description: "محدود کردن جستجو به یک گفتگو (فقط گفتگوهای خودت).",
          minimum: 1,
        },
      },
    },

    async run(input: SearchHistoryInput, ctx: ToolContext): Promise<SearchHistoryOutput> {
      const query = input.query.trim();
      if (query.length === 0) {
        throw new ToolError("invalid_input", "عبارت جستجو خالی است.");
      }

      // SECURITY: the owner id comes from the server-supplied actor, never
      // from tool input. storage.searchMessages joins conversations on
      // user_id, so a conversationId that is not the caller's simply matches
      // nothing.
      const userId = ownerOf(ctx.actor);
      const limit = clampLimit(input.limit);
      const hits = deps.storage.searchMessages(query, {
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
    throw new ToolError("not_allowed", "هویت مشخص نیست؛ جستجو در دسترس نیست.");
  }
  return id;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  return n > MAX_SEARCH_LIMIT ? MAX_SEARCH_LIMIT : n;
}
