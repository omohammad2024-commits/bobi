/**
 * Long-term memory tools — remember, recall, forget.
 *
 * The model decides what is worth keeping, which is why these are tools rather
 * than automatic behaviour: BOBI has no reliable way to know that "اسم پروژه‌م
 * سول است" matters and "سلام" does not.
 *
 * Isolation is enforced below the tools, not here: every method takes the
 * owner id and the provider scopes every query to it, so a tool call can only
 * ever touch the calling user's own memory. The actor comes from the
 * server-supplied ToolActor, so a model cannot address another user's memory
 * by putting an id in its arguments.
 *
 * The system prompt states only HOW MANY memories exist, never their contents.
 * That keeps the context small and lets the model search for what it needs
 * rather than being handed everything on every turn.
 *
 * Phase D2: the tools take a MemoryProvider instead of Storage. The provider
 * may be sync or async — every call is awaited either way — so swapping the
 * backend never changes the tools.
 */
import { ToolError } from "./errors";
import type { MemoryProvider } from "../memory/provider";
import type { Tool, ToolActor, ToolContext } from "./types";

export const REMEMBER_PERMISSION = "tools:remember";
export const RECALL_PERMISSION = "tools:recall";
export const FORGET_PERMISSION = "tools:forget";

/** Ceilings, so one call cannot fill the store or the context. */
const MAX_KEY_LENGTH = 60;
const MAX_CONTENT_LENGTH = 2_000;
const MAX_MEMORIES_PER_USER = 200;
const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_LIMIT = 20;

export interface MemoryDeps {
  provider: MemoryProvider;
}

// ---------- remember ----------

export interface RememberInput {
  key: string;
  content: string;
}

export interface RememberOutput {
  key: string;
  /** True when an existing memory was replaced rather than added. */
  replaced: boolean;
  /** Total memories the user now has. */
  total: number;
}

export function createRememberTool(deps: MemoryDeps): Tool<RememberInput, RememberOutput> {
  return {
    name: "remember",
    description:
      "یک نکتهٔ پایدار دربارهٔ کاربر را برای همیشه ذخیره کن (نام، ترجیح، پروژه). برای اطلاعات زودگذر استفاده نکن.",
    enabled: true,
    permission: { requires: [REMEMBER_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "memory",
    input: {
      fields: {
        key: {
          type: "string",
          required: true,
          description: "برچسب کوتاه و یکتا، مثل «نام پروژه».",
          minLength: 1,
          maxLength: MAX_KEY_LENGTH,
        },
        content: {
          type: "string",
          required: true,
          description: "متن چیزی که باید به خاطر بماند.",
          minLength: 1,
          maxLength: MAX_CONTENT_LENGTH,
        },
      },
    },

    async run(input: RememberInput, ctx: ToolContext): Promise<RememberOutput> {
      const key = normalizeKey(input.key);
      const content = input.content.trim();
      if (content.length === 0) {
        throw new ToolError("invalid_input", "متن حافظه خالی است.");
      }

      const userId = ownerOf(ctx.actor);
      const existing = await deps.provider.get(userId, key);

      // An ADD to a full store is refused; a REPLACE is not, since it does not
      // increase the count.
      if (existing === undefined && (await deps.provider.count(userId)) >= MAX_MEMORIES_PER_USER) {
        throw new ToolError(
          "invalid_input",
          "حافظه پر است؛ ابتدا با forget چند مورد را پاک کن.",
        );
      }

      await deps.provider.upsert(userId, key, content);

      return {
        key,
        replaced: existing !== undefined,
        total: await deps.provider.count(userId),
      };
    },
  };
}

// ---------- recall ----------

export interface RecallInput {
  query?: string;
  limit?: number;
}

export interface RecallOutput {
  /** Matching memories, newest first. */
  memories: Array<{ key: string; content: string }>;
  total: number;
}

export function createRecallTool(deps: MemoryDeps): Tool<RecallInput, RecallOutput> {
  return {
    name: "recall",
    description:
      "حافظه‌ها را جستجو کن. بدون query همهٔ موارد اخیر را برمی‌گرداند.",
    enabled: true,
    permission: { requires: [RECALL_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "memory",
    input: {
      fields: {
        query: {
          type: "string",
          description: "عبارت جستجو در کلید و متن حافظه‌ها.",
          maxLength: 200,
        },
        limit: {
          type: "integer",
          description: `حداکثر تعداد نتیجه (۱ تا ${MAX_RECALL_LIMIT}).`,
          minimum: 1,
          maximum: MAX_RECALL_LIMIT,
        },
      },
    },

    async run(input: RecallInput, ctx: ToolContext): Promise<RecallOutput> {
      const userId = ownerOf(ctx.actor);
      const limit = clampLimit(input.limit);

      // Every read goes through the owner-scoped provider, so there is no path
      // that could return another user's memory.
      const all = await deps.provider.list(userId, MAX_MEMORIES_PER_USER);

      const query = input.query?.trim() ?? "";
      const matches =
        query.length === 0 ? all.slice(0, limit) : rank(all, query).slice(0, limit);

      return {
        memories: matches.map((m) => ({ key: m.key, content: m.content })),
        total: all.length,
      };
    },
  };
}

/**
 * Rank memories against a query.
 *
 * Deliberately simple and deterministic: a case-insensitive substring test over
 * the key and the content, with key matches first because the key is the
 * model's own label for the memory and is the stronger signal. A scoring model
 * would be harder to reason about and would not beat this for the handful of
 * entries a single user stores.
 */
function rank(
  memories: readonly { key: string; content: string }[],
  query: string,
): Array<{ key: string; content: string }> {
  const needle = query.toLowerCase();
  const keyHits: Array<{ key: string; content: string }> = [];
  const contentHits: Array<{ key: string; content: string }> = [];

  for (const m of memories) {
    if (m.key.toLowerCase().includes(needle)) keyHits.push(m);
    else if (m.content.toLowerCase().includes(needle)) contentHits.push(m);
  }
  return [...keyHits, ...contentHits];
}

// ---------- forget ----------

export interface ForgetInput {
  key: string;
}

export interface ForgetOutput {
  key: string;
  /** False when there was nothing under that key. */
  removed: boolean;
  total: number;
}

export function createForgetTool(deps: MemoryDeps): Tool<ForgetInput, ForgetOutput> {
  return {
    name: "forget",
    description: "یک حافظه را با کلیدش پاک کن.",
    enabled: true,
    permission: { requires: [FORGET_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "memory",
    input: {
      fields: {
        key: {
          type: "string",
          required: true,
          description: "کلید حافظه‌ای که باید پاک شود.",
          minLength: 1,
          maxLength: MAX_KEY_LENGTH,
        },
      },
    },

    async run(input: ForgetInput, ctx: ToolContext): Promise<ForgetOutput> {
      const key = normalizeKey(input.key);
      const userId = ownerOf(ctx.actor);

      const removed = await deps.provider.delete(userId, key);
      return { key, removed, total: await deps.provider.count(userId) };
    },
  };
}

/** Build all three memory tools. */
export function createMemoryTools(deps: MemoryDeps): readonly Tool<unknown, unknown>[] {
  return [
    createRememberTool(deps),
    createRecallTool(deps),
    createForgetTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}

// ---------- helpers ----------

/**
 * The owner id for this call.
 *
 * Taken from the server-supplied actor, never from tool input. An actor with no
 * usable id gets a refusal rather than a shared default, so two unidentified
 * callers can never end up sharing one memory space.
 */
function ownerOf(actor: ToolActor): string {
  const id = actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "هویت مشخص نیست؛ حافظه در دسترس نیست.");
  }
  return id;
}

/**
 * Normalise a memory key.
 *
 * Collapses internal whitespace, so "نام  پروژه" and "نام پروژه" resolve to the
 * same entry instead of silently creating two. Case is left alone: the content
 * is overwhelmingly Persian, which has no letter case, and folding it would
 * mangle a Latin key the user chose deliberately.
 */
function normalizeKey(raw: string): string {
  const key = raw.trim().replace(/\s+/g, " ");
  if (key.length === 0) {
    throw new ToolError("invalid_input", "کلید حافظه خالی است.");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new ToolError("invalid_input", "کلید حافظه خیلی طولانی است.");
  }
  return key;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECALL_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  return n > MAX_RECALL_LIMIT ? MAX_RECALL_LIMIT : n;
}
