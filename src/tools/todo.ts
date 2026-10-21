/**
 * Todo list tool — todo_list (platform Phase 9, Action Layer).
 *
 * ONE tool manages the calling user's personal checklists: `action`
 * picks add / list / complete / reopen / remove / clear_completed.
 * Lists are named (`list`, default "main") so "shopping" and
 * "watchlist" stay separate without separate tools or tables.
 *
 * Scoping is strict and actor-based, like the memory tools: every call
 * is addressed by ctx.actor.userId and the storage layer scopes every
 * query by user_id, so a user can only ever touch their own items. An
 * id that does not exist — or belongs to someone else — reports the
 * same not_found, so the tool never confirms another user's data. The
 * tool is deliberately NOT ownerOnly: lists are personal for every
 * user, not an owner feature.
 *
 * A todo is a plain checklist item, nothing more: it has no due time
 * (that is remind_at), it is not an outcome BOBI works toward (that is
 * add_goal), and it is not a fact about the user (that is remember).
 * The desk card below says exactly that, so the model stops reaching
 * for remember/forget when the user just wants a list.
 */
import { ToolError } from "./errors";
import type { Storage, TodoItemRecord } from "../storage/storage";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const TODO_LIST_PERMISSION = "tools:todo_list";

/** Ceilings, so one user cannot fill the table or the model's context. */
const MAX_TEXT_LENGTH = 500;
const MAX_LIST_NAME_LENGTH = 40;
const MAX_LIST_ITEMS = 100;
const DEFAULT_LIST = "main";

export type TodoAction = "add" | "list" | "complete" | "reopen" | "remove" | "clear_completed";

const ACTIONS: readonly TodoAction[] = [
  "add",
  "list",
  "complete",
  "reopen",
  "remove",
  "clear_completed",
];

export interface TodoToolDeps {
  storage: Storage;
}

// ---------- input / output ----------

export interface TodoListInput {
  action: TodoAction;
  /** Item text (action "add" only). */
  text?: string;
  /** Named list, e.g. "shopping" or "watchlist". Defaults to "main". */
  list?: string;
  /** Item id (actions "complete" | "reopen" | "remove"), from a list result. */
  id?: number;
  /** Action "list" only: also show completed items. Defaults to false. */
  includeDone?: boolean;
}

/** One item as the model sees it — storage row minus the owner id. */
export interface TodoItemView {
  id: number;
  text: string;
  done: boolean;
  /** unix ms — when the item was added. */
  createdAt: number;
}

export type TodoListOutput =
  | { action: "add"; list: string; item: TodoItemView }
  | { action: "list"; list: string; items: TodoItemView[]; openCount: number }
  | { action: "complete" | "reopen"; id: number; done: boolean }
  | { action: "remove"; id: number; removed: true }
  | { action: "clear_completed"; list: string; cleared: number };

function toView(r: TodoItemRecord): TodoItemView {
  return { id: r.id, text: r.text, done: r.done, createdAt: r.createdAt };
}

// ---------- manifest ----------

export const todoListManifest: ToolManifest = defineManifest({
  id: "todo_list",
  version: "1.0.0",
  title: "Todo List",
  description:
    "Manage the user's personal todo lists: add, list, complete, reopen, remove and clear completed items on named lists (default list: main). Items are strictly the calling user's own.",
  purpose: "personal todo checklist",
  useWhen: "checklist item asked",
  doNotUseWhen:
    "goals and memory are NOT lists: use add_goal for outcomes and remember for facts — never remember/forget for list items",
  confusableWith: [
    { tool: "add_goal", difference: "goals are outcomes BOBI works toward; a todo is a plain checklist item" },
    { tool: "remember", difference: "remember stores facts about the user; this is a checklist" },
  ],
  latencyTier: "instant",
  outputSummary: "The affected item or the list's items with open count, depending on the action.",
  category: "schedule",
  triggers: {
    keywordPatterns: [
      "تودو",
      "لیست خرید",
      "لیست کار(ها)?",
      "به لیستم اضافه کن",
      "\\bto-?do\\b",
      "checklist",
      "add (it |this |that )?to (my |the )?list",
    ],
  },
  costTier: "free",
});

// ---------- tool ----------

export function createTodoTool(deps: TodoToolDeps): Tool<TodoListInput, TodoListOutput> {
  return {
    name: "todo_list",
    manifest: todoListManifest,
    description:
      "Manage your personal todo lists with one action: add, list, complete, reopen, remove, or clear_completed. Lists are named (default main), e.g. shopping or watchlist.",
    enabled: true,
    permission: { requires: [TODO_LIST_PERMISSION] },
    // NOT ownerOnly, deliberately: lists are personal for every actor,
    // strictly scoped to ctx.actor.userId (see the file header).
    toolset: "schedule",
    input: {
      fields: {
        action: {
          type: "enum",
          required: true,
          description: "What to do: add, list, complete, reopen, remove, or clear_completed.",
          choices: [...ACTIONS],
        },
        text: {
          type: "string",
          description: "The item text (action add).",
          minLength: 1,
          maxLength: MAX_TEXT_LENGTH,
        },
        list: {
          type: "string",
          description: "List name, e.g. shopping or watchlist. Defaults to main.",
          minLength: 1,
          maxLength: MAX_LIST_NAME_LENGTH,
        },
        id: {
          type: "integer",
          description: "Item id (actions complete, reopen, remove), from a list result.",
          minimum: 1,
        },
        includeDone: {
          type: "boolean",
          description: "For action list: also show completed items. Defaults to false.",
        },
      },
    },

    async run(input: TodoListInput, ctx: ToolContext): Promise<TodoListOutput> {
      const userId = actorOf(ctx);
      const repo = deps.storage.todo;
      const listName = normalizeListName(input.list);
      const nowMs = ctx.clock().getTime();

      switch (input.action) {
        case "add": {
          const text = (input.text ?? "").trim();
          if (text.length === 0) {
            throw new ToolError("invalid_input", "Item text is empty.");
          }
          let item: TodoItemRecord;
          try {
            item = repo.add(userId, listName, text, nowMs);
          } catch {
            // Storage internals (SQL text, paths) never reach the model.
            throw new ToolError("internal", "Could not save the item.");
          }
          return { action: "add", list: listName, item: toView(item) };
        }

        case "list": {
          // Fetch done rows too so openCount is exact, then apply the
          // caller's filter and the output cap.
          const all = repo.list(userId, listName, true);
          const openCount = all.reduce((n, r) => n + (r.done ? 0 : 1), 0);
          const visible = (input.includeDone === true ? all : all.filter((r) => !r.done)).slice(
            0,
            MAX_LIST_ITEMS,
          );
          return { action: "list", list: listName, items: visible.map(toView), openCount };
        }

        case "complete":
        case "reopen": {
          const id = requireId(input);
          const done = input.action === "complete";
          // Scoped to the owner by the storage layer: an id belonging to
          // another user matches nothing, exactly like a missing id.
          if (!repo.setDone(userId, id, done, nowMs)) {
            throw new ToolError("not_found", "That item doesn't exist on your list.");
          }
          return { action: input.action, id, done };
        }

        case "remove": {
          const id = requireId(input);
          if (!repo.remove(userId, id)) {
            throw new ToolError("not_found", "That item doesn't exist on your list.");
          }
          return { action: "remove", id, removed: true };
        }

        case "clear_completed": {
          const cleared = repo.clearCompleted(userId, listName);
          return { action: "clear_completed", list: listName, cleared };
        }

        default:
          // Unreachable through the Executor (the enum validator rejects
          // unknown actions first); a direct caller gets the same refusal.
          throw new ToolError("invalid_input", "Unknown todo action.");
      }
    },
  };
}

// ---------- helpers ----------

/**
 * The actor id for this call, taken from the server-supplied actor,
 * never from tool input — the same rule as the memory tools. An
 * unidentified actor is refused rather than sharing one list space.
 */
function actorOf(ctx: ToolContext): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown; todo lists are unavailable.");
  }
  return id;
}

/**
 * Normalise a list name: trims and collapses whitespace, and a blank
 * name means the default list, so "shopping", " shopping " and a
 * missing list cannot split one list into near-duplicates.
 */
function normalizeListName(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_LIST;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return DEFAULT_LIST;
  if (name.length > MAX_LIST_NAME_LENGTH) {
    throw new ToolError("invalid_input", "List name is too long.");
  }
  return name;
}

/** The item id an id-addressed action needs, validated. */
function requireId(input: TodoListInput): number {
  if (input.id === undefined || !Number.isInteger(input.id) || input.id < 1) {
    throw new ToolError("invalid_input", "This action needs the item's id, from a list result.");
  }
  return input.id;
}
