/**
 * Custom shortcut tools — shortcut_add, shortcut_list, shortcut_delete.
 *
 * Owner-only management tools for custom commands. The owner defines e.g.
 * `/صبح` → shortcut_add({ name: "صبح", kind: "prompt", action: "…" }), and
 * from then on typing `/صبح` runs that action.
 *
 * INTENDED EXECUTION FLOW (to be wired by the coordinator in src/bot/bot.ts
 * — NOT in this file and NOT in registry.ts):
 *
 *   1. On an incoming "/name" command, bot.ts checks built-in handlers
 *      first. If none matches, it calls storage.getShortcut(name) with the
 *      name normalized the same way as here: strip leading "/", lowercase.
 *   2. No shortcut → the normal "unknown command" reply.
 *   3. Shortcut found:
 *      - kind "prompt": send `action` into the engine as a new user
 *        message (the same path as ordinary owner text), so the agent
 *        runs the prompt in full conversation context.
 *      - kind "tool": run the tool named by `action` with `toolArgs`
 *        through the Executor under the owner's actor, and deliver the
 *        result as the bot reply. A shortcut may only be triggered by the
 *        owner, so naming an owner-only tool here stays owner-only.
 *   4. Shortcuts are owner configuration: bot.ts must not leak names or
 *      prompt text in help/menus shown to non-owners.
 *
 * The registry import below is a READ-ONLY dependency: it validates that a
 * kind="tool" shortcut names a real tool. Nothing here registers anything
 * into the registry.
 */
import { ToolError } from "./errors";
import type { ToolRegistry } from "./registry";
import type { CustomShortcut, Storage } from "../storage/storage";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const SHORTCUT_ADD_PERMISSION = "tools:shortcut_add";
export const SHORTCUT_LIST_PERMISSION = "tools:shortcut_list";
export const SHORTCUT_DELETE_PERMISSION = "tools:shortcut_delete";

export interface ShortcutToolDeps {
  storage: Storage;
  /** Server-supplied owner check. The userId comes from the trusted actor. */
  isOwner: (userId: string) => boolean;
  /** Used only to validate kind="tool" targets exist. Never mutated. */
  registry: ToolRegistry;
}

/**
 * Built-in bot command names (without the slash) that a shortcut may NOT
 * shadow. Kept in sync with bot.command(...) registrations in src/bot/bot.ts.
 * Checked against the normalized (lowercase, slash-less) name.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "start",
  "help",
  "commands",
  "ai",
  "admin",
  "model",
  "digest",
  "agents",
  "moa",
  "consult",
  "goal",
  "subgoal",
  "plan",
  "review",
  "refine",
  "memory",
  "learn",
  "steer",
  "loop",
  "cron",
  "bg",
  "queue",
  "snapshot",
  "compress",
  "context",
  "insights",
  "heartbeat",
  "curator",
  "skill",
  "skills",
  "plugins",
  "blueprint",
  "bundles",
  "tools",
  "usage",
  "restart",
  "reload_mcp",
  "reload_skills",
  "voice",
  "btw",
  "pause",
  "stop",
  "sethome",
  "debug",
  "bench",
  "autoprune",
  "update",
  "reset",
  "personality",
  "suggestions",
]);

/** Letters (Persian or Latin), numbers, underscore. Unicode-aware. */
const NAME_PATTERN = /^[\p{L}\p{N}_]+$/u;

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 32;
const MAX_PROMPT_LENGTH = 4000;

/** Max shortcuts, so the table cannot grow unboundedly. */
const MAX_SHORTCUTS = 50;

/**
 * Normalize a shortcut name the way storage keys it: trim, strip any
 * leading slashes, lowercase Latin letters.
 */
export function normalizeShortcutName(raw: string): string {
  return raw.trim().replace(/^\/+/, "").toLowerCase();
}

/**
 * Validate a normalized name. Throws ToolError("invalid_input") with a
 * user-safe reason.
 */
export function validateShortcutName(name: string): void {
  const length = [...name].length;
  if (length < MIN_NAME_LENGTH || length > MAX_NAME_LENGTH) {
    throw new ToolError(
      "invalid_input",
      `Shortcut name must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters.`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ToolError(
      "invalid_input",
      "Shortcut name may only contain letters (Persian or Latin), numbers and underscore.",
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new ToolError(
      "invalid_input",
      `"/${name}" is a built-in command; pick a different shortcut name.`,
    );
  }
}

/** Owner check, defence in depth alongside ownerOnly. */
function requireOwner(ctx: ToolContext, isOwner: (userId: string) => boolean): string {
  const userId = ctx.actor.userId;
  if (typeof userId !== "string" || userId.length === 0 || userId === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown.");
  }
  if (!isOwner(userId)) {
    throw new ToolError("not_allowed", "Custom shortcuts are owner only.");
  }
  return userId;
}

// ---------- shortcut_add ----------

export interface ShortcutAddInput {
  name: string;
  kind: string;
  action: string;
  toolArgs?: Record<string, unknown>;
}

export interface ShortcutAddOutput {
  name: string;
  kind: string;
  updated: boolean;
}

export const shortcutAddManifest: ToolManifest = defineManifest({
  id: "shortcut_add",
  version: "1.0.0",
  title: "Add Shortcut",
  description:
    "Define or replace a custom command shortcut, e.g. /صبح → morning digest prompt. Owner only.",
  purpose: "custom shortcut",
  useWhen: "shortcut created",
  doNotUseWhen:
    "running the shortcut — just type its /name; built-in command names are reserved and cannot be shadowed",
  confusableWith: [
    { tool: "shortcut_list", difference: "shortcut_list only shows shortcuts; this creates or replaces one" },
    { tool: "shortcut_delete", difference: "shortcut_delete removes one; this defines or updates one" },
  ],
  latencyTier: "instant",
  outputSummary: "The shortcut name, kind and whether an existing one was updated.",
  category: "system",
  triggers: {
    keywordPatterns: [
      "شورتکات بساز",
      "میانبر بساز",
      "add (a )?shortcut",
      "create (a )?shortcut",
    ],
  },
  costTier: "free",
});

function createShortcutAddTool(deps: ShortcutToolDeps): Tool<ShortcutAddInput, ShortcutAddOutput> {
  return {
    name: "shortcut_add",
    manifest: shortcutAddManifest,
    description:
      "Define or replace a custom command shortcut, e.g. /صبح → morning digest prompt. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [SHORTCUT_ADD_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        name: {
          type: "string",
          required: true,
          description: "Shortcut name without slash, e.g. صبح. Persian/Latin letters, numbers, underscore, 2-32 chars.",
          minLength: 1,
          maxLength: 40,
        },
        kind: {
          type: "enum",
          required: true,
          description: "'prompt' runs action as a prompt; 'tool' invokes the named tool.",
          choices: ["prompt", "tool"],
        },
        action: {
          type: "string",
          required: true,
          description: "The prompt text (kind=prompt) or the tool name (kind=tool).",
          minLength: 1,
          maxLength: MAX_PROMPT_LENGTH,
        },
        toolArgs: {
          type: "object",
          description: "Extra arguments passed to the tool (kind=tool only).",
        },
      },
    },

    async run(input: ShortcutAddInput, ctx: ToolContext): Promise<ShortcutAddOutput> {
      requireOwner(ctx, deps.isOwner);

      const name = normalizeShortcutName(input.name);
      validateShortcutName(name);

      const kind = input.kind;
      if (kind !== "prompt" && kind !== "tool") {
        throw new ToolError("invalid_input", "kind must be 'prompt' or 'tool'.");
      }
      const action = input.action.trim();
      if (action.length === 0) {
        throw new ToolError("invalid_input", "action is empty.");
      }
      if (kind === "prompt" && action.length > MAX_PROMPT_LENGTH) {
        throw new ToolError("invalid_input", "Prompt is too long.");
      }

      let toolArgs: Record<string, unknown> | undefined;
      if (kind === "tool") {
        // The named tool must exist in the registry — read-only lookup,
        // nothing is registered from here.
        if (!deps.registry.has(action)) {
          throw new ToolError(
            "invalid_input",
            `No tool named "${action}" exists. Use shortcut_list or /tools to see available tools.`,
          );
        }
        if (input.toolArgs !== undefined) {
          if (typeof input.toolArgs !== "object" || input.toolArgs === null || Array.isArray(input.toolArgs)) {
            throw new ToolError("invalid_input", "toolArgs must be a JSON object.");
          }
          toolArgs = input.toolArgs;
        }
      }

      if (deps.storage.listShortcuts().length >= MAX_SHORTCUTS && deps.storage.getShortcut(name) === undefined) {
        throw new ToolError("invalid_input", `Too many shortcuts (max ${MAX_SHORTCUTS}); delete some first.`);
      }

      const updated = deps.storage.getShortcut(name) !== undefined;
      deps.storage.upsertShortcut(
        toolArgs === undefined
          ? { name, kind, action }
          : { name, kind, action, toolArgs },
      );
      return { name, kind, updated };
    },
  };
}

// ---------- shortcut_list ----------

export interface ShortcutListOutput {
  shortcuts: Array<{
    name: string;
    kind: string;
    /** Action preview, truncated for display. */
    action: string;
    updatedAt: number;
  }>;
}

export const shortcutListManifest: ToolManifest = defineManifest({
  id: "shortcut_list",
  version: "1.0.0",
  title: "List Shortcuts",
  description: "List all custom command shortcuts. Owner only.",
  purpose: "list shortcuts",
  useWhen: "shortcuts asked",
  doNotUseWhen:
    "built-in command list — that is commands; creating a shortcut — that is shortcut_add",
  confusableWith: [
    { tool: "commands", difference: "commands lists built-in bot commands; this lists custom shortcuts" },
    { tool: "shortcut_add", difference: "shortcut_add creates one; this only lists existing shortcuts" },
  ],
  latencyTier: "instant",
  outputSummary: "All custom shortcuts with name, kind, action preview and update time.",
  category: "system",
  triggers: {
    keywordPatterns: [
      "شورتکاتهام",
      "میانبرهام",
      "list (my )?shortcuts",
      "show (my )?shortcuts",
    ],
  },
  costTier: "free",
});

function createShortcutListTool(
  deps: ShortcutToolDeps,
): Tool<Record<string, never>, ShortcutListOutput> {
  return {
    name: "shortcut_list",
    manifest: shortcutListManifest,
    description: "List all custom command shortcuts. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [SHORTCUT_LIST_PERMISSION] },
    toolset: "system",
    input: { fields: {} },

    async run(_input: Record<string, never>, ctx: ToolContext): Promise<ShortcutListOutput> {
      requireOwner(ctx, deps.isOwner);
      const shortcuts: CustomShortcut[] = deps.storage.listShortcuts();
      return {
        shortcuts: shortcuts.map((s) => ({
          name: s.name,
          kind: s.kind,
          action: s.action.length > 80 ? `${s.action.slice(0, 80)}…` : s.action,
          updatedAt: s.updatedAt,
        })),
      };
    },
  };
}

// ---------- shortcut_delete ----------

export interface ShortcutDeleteInput {
  name: string;
}

export interface ShortcutDeleteOutput {
  name: string;
  deleted: boolean;
}

export const shortcutDeleteManifest: ToolManifest = defineManifest({
  id: "shortcut_delete",
  version: "1.0.0",
  title: "Delete Shortcut",
  description: "Delete a custom command shortcut by name. Owner only.",
  purpose: "delete a shortcut",
  useWhen: "shortcut removed",
  doNotUseWhen:
    "name unknown — shortcut_list first; built-in commands cannot be deleted",
  confusableWith: [
    { tool: "shortcut_add", difference: "shortcut_add creates or replaces; this deletes by name" },
    { tool: "shortcut_list", difference: "shortcut_list shows shortcuts; this removes one" },
  ],
  latencyTier: "instant",
  outputSummary: "The shortcut name and whether it was deleted.",
  category: "system",
  triggers: {
    keywordPatterns: [
      "شورتکات.*(حذف|پاک)",
      "delete (the|my) shortcut",
      "remove (the|my) shortcut",
    ],
  },
  costTier: "free",
});

function createShortcutDeleteTool(
  deps: ShortcutToolDeps,
): Tool<ShortcutDeleteInput, ShortcutDeleteOutput> {
  return {
    name: "shortcut_delete",
    manifest: shortcutDeleteManifest,
    description: "Delete a custom command shortcut by name. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [SHORTCUT_DELETE_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        name: {
          type: "string",
          required: true,
          description: "Shortcut name without slash, e.g. صبح.",
          minLength: 1,
          maxLength: 40,
        },
      },
    },

    async run(input: ShortcutDeleteInput, ctx: ToolContext): Promise<ShortcutDeleteOutput> {
      requireOwner(ctx, deps.isOwner);
      const name = normalizeShortcutName(input.name);
      // Reuse validation so typos like "/sta rt" get a clean error rather
      // than a silent "not found". Reserved-name check is skipped on delete:
      // a built-in could never have been stored under that name.
      if (name.length === 0 || !NAME_PATTERN.test(name)) {
        throw new ToolError("invalid_input", "Shortcut name is invalid.");
      }
      const deleted = deps.storage.deleteShortcut(name);
      return { name, deleted };
    },
  };
}

export function createShortcutTools(deps: ShortcutToolDeps): readonly Tool<unknown, unknown>[] {
  return [
    createShortcutAddTool(deps),
    createShortcutListTool(deps),
    createShortcutDeleteTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}
