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
 *
 * Phase 4: recall ranks by meaning when a SemanticMemoryIndex is wired in
 * (embeddings from the owner's configured provider, cosine similarity over
 * stored vectors). When the index is absent or unavailable, recall silently
 * falls back to the original substring ranking — no error, no user-visible
 * change.
 *
 * Phase 5: when both signals exist, recall fuses the substring ranking and
 * the vector ranking with Reciprocal Rank Fusion (searchMode "hybrid")
 * instead of either/or. Stale vectors (old model/dimension) are excluded
 * from ranking and re-embedded in the background; the kill switch and the
 * silent text fallback are unchanged.
 */
import { ToolError } from "./errors";
import type { MemoryProvider } from "../memory/provider";
import type { SemanticMemoryIndex } from "../memory/semantic";
import {
  boostByRecencyImportance,
  dedupeNearIdentical,
  expandQueryVariants,
  memoryImportance,
  normalizeMemoryText,
  reciprocalRankFusionWithScores,
} from "../memory/hybrid";
import type { Tool, ToolActor, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

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
  /**
   * Phase 4: semantic (vector-similarity) search over memories. Optional —
   * when absent (or when it reports unavailability), recall degrades to the
   * original substring ranking with no error and no behavior change beyond
   * ranking.
   */
  semantic?: SemanticMemoryIndex;
}

/**
 * Schema 22: record a recall's hits as recall telemetry (recall_count /
 * last_recalled_at), so consolidation can promote what is actually used.
 * Best-effort by design: telemetry must never fail the recall itself, and
 * providers without bumpRecall (non-SQLite backends) skip silently.
 */
async function bumpRecalled(
  deps: MemoryDeps,
  userId: string,
  surfaced: readonly { key: string }[],
): Promise<void> {
  if (deps.provider.bumpRecall === undefined || surfaced.length === 0) return;
  try {
    await deps.provider.bumpRecall(
      userId,
      surfaced.map((m) => m.key),
    );
  } catch {
    // Swallowed on purpose: a telemetry write failure is not a recall failure.
  }
}

// ---------- remember ----------

export interface RememberInput {
  key: string;
  content: string;
  /**
   * Importance 1 (trivial) to 5 (critical). Defaults to 3. The user's name,
   * corrections and explicit «remember this» statements deserve 5;
   * retrieval prefers important memories.
   */
  importance?: number;
}

export interface RememberOutput {
  key: string;
  /** True when an existing memory was replaced rather than added. */
  replaced: boolean;
  /** Total memories the user now has. */
  total: number;
  /** The effective importance 1-5 stored for this memory. */
  importance: number;
}

export const rememberManifest: ToolManifest = defineManifest({
  id: "remember",
  version: "1.0.0",
  title: "Remember",
  description:
    "Store a lasting note about the user (name, preference, project). Do not use for fleeting information.",
  purpose: "lasting user note",
  useWhen: "durable fact",
  doNotUseWhen:
    "fleeting or one-off info; a dated follow-up — that is remind_at with followUp; a past-event log — that is note_event",
  confusableWith: [
    { tool: "remind_at", difference: "a follow-up reminder resurfaces until closed; memories are passive stored facts" },
    { tool: "note_event", difference: "note_event logs a past event; remember stores a standing fact" },
  ],
  latencyTier: "instant",
  outputSummary: "The stored memory's key, whether it replaced an old one, and the total count.",
  category: "memory",
  triggers: {
    keywordPatterns: [
      "یادت باشه",
      "به خاطر بسپار",
      "به حافظه بسپار",
      "remember (that|this)",
      "don't forget",
    ],
  },
  costTier: "free",
});

export function createRememberTool(deps: MemoryDeps): Tool<RememberInput, RememberOutput> {
  return {
    name: "remember",
    manifest: rememberManifest,
    description:
      "Store a lasting note about the user (name, preference, project). Do not use for fleeting information.",
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
          description: "Short unique label, e.g. \"project name\".",
          minLength: 1,
          maxLength: MAX_KEY_LENGTH,
        },
        content: {
          type: "string",
          required: true,
          description: "The text to remember.",
          minLength: 1,
          maxLength: MAX_CONTENT_LENGTH,
        },
        importance: {
          type: "integer",
          description:
            "How important this memory is, 1 (trivial) to 5 (critical). Defaults to 3. Use 5 for the user's name, corrections, and explicit «remember this» statements — recall prefers important memories.",
          minimum: 1,
          maximum: 5,
        },
      },
    },

    async run(input: RememberInput, ctx: ToolContext): Promise<RememberOutput> {
      const key = normalizeKey(input.key);
      const content = input.content.trim();
      if (content.length === 0) {
        throw new ToolError("invalid_input", "Memory text is empty.");
      }
      // Worker-2: importance is validated into 1-5 here too, so a model
      // passing 0 or 6 cannot corrupt the scale the ranker reads.
      // (The ternary narrows input.importance to number for the helper,
      // which keeps exactOptionalPropertyTypes happy.)
      const importance =
        input.importance === undefined
          ? undefined
          : memoryImportance({ importance: input.importance });

      const userId = ownerOf(ctx.actor);
      const existing = await deps.provider.get(userId, key);

      // An ADD to a full store is refused; a REPLACE is not, since it does not
      // increase the count.
      if (existing === undefined && (await deps.provider.count(userId)) >= MAX_MEMORIES_PER_USER) {
        throw new ToolError(
          "invalid_input",
          "Memory is full; forget some items first.",
        );
      }

      await deps.provider.upsert(
        userId,
        key,
        content,
        importance === undefined ? undefined : { importance },
      );

      // Phase 4: embed the new memory in the background so future recall can
      // rank by meaning. Fire-and-forget by contract — a slow or failing
      // provider can never slow down or break remember.
      deps.semantic?.indexMemory(userId, key, content);

      return {
        key,
        replaced: existing !== undefined,
        total: await deps.provider.count(userId),
        importance: importance ?? memoryImportance(existing ?? {}),
      };
    },
  };
}

// ---------- recall ----------

export interface RecallInput {
  query?: string;
  limit?: number;
}

export interface RecalledMemory {
  key: string;
  content: string;
  /** Importance 1-5, so the model can weigh what it got back. */
  importance: number;
}

export interface RecallOutput {
  /** Matching memories, best match first. */
  memories: RecalledMemory[];
  total: number;
  /**
   * How the matches were ranked.
   * - "hybrid" (phase 5 + worker-2): the vector ranking, the substring
   *   ranking AND the recency/importance ranking were fused with
   *   Reciprocal Rank Fusion — a memory matching several signals outranks
   *   one matching only one, and recent/important memories are preferred.
   * - "semantic": only the vector ranking produced candidates (no
   *   substring match), so the fusion is the semantic order.
   * - "text": the original substring rank (no query, or semantic
   *   unavailable — silent fallback, never an error).
   */
  searchMode: "semantic" | "text" | "hybrid";
}

/**
 * Phase 5: how many semantic candidates take part in RRF fusion.
 *
 * The text ranking is always complete (it is computed over the already
 * fetched list); the semantic list is capped here so one recall cannot fan
 * out to a provider.get per memory. 50 keeps the fusion exact where it
 * matters — anything past rank 50 contributes less than 1/(60+50) per list.
 */
const HYBRID_SEMANTIC_CANDIDATES = 50;

export const recallManifest: ToolManifest = defineManifest({
  id: "recall",
  version: "1.0.0",
  title: "Recall",
  description:
    "Search memories. Without a query, returns recent items.",
  purpose: "memories by query",
  useWhen: "memory asked",
  doNotUseWhen:
    "past conversation history — that is search_history; condensing/archiving all memories — that is curate_memories",
  confusableWith: [
    { tool: "search_history", difference: "search_history scans past chats; recall searches stored long-term memories" },
    { tool: "curate_memories", difference: "curate_memories reviews and archives memories; recall returns matching items" },
  ],
  latencyTier: "seconds",
  outputSummary: "Matching memories (key, content, importance), best match first.",
  category: "memory",
  triggers: {
    keywordPatterns: [
      "یادت هست",
      "یادته",
      "به یاد بیار",
      "do you remember",
      "what did i (say|tell you) about",
    ],
  },
  costTier: "free",
});

export function createRecallTool(deps: MemoryDeps): Tool<RecallInput, RecallOutput> {
  return {
    name: "recall",
    manifest: recallManifest,
    description:
      "Search memories. Without a query, returns recent items.",
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
          description: "Search phrase in memory keys and text.",
          maxLength: 200,
        },
        limit: {
          type: "integer",
          description: `Maximum results (1 to ${MAX_RECALL_LIMIT}).`,
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
      // Worker-2: near-identical memories surface once, not twice.
      const candidates = dedupeNearIdentical(all);

      const query = input.query?.trim() ?? "";
      if (query.length === 0) {
        const recent = candidates.slice(0, limit);
        await bumpRecalled(deps, userId, recent);
        return {
          memories: recent.map((m) => toRecalled(m)),
          total: all.length,
          searchMode: "text",
        };
      }

      // Phase 5: true hybrid ranking. When the semantic index can answer,
      // fuse its ranking with the deterministic substring ranking via
      // Reciprocal Rank Fusion instead of picking either/or. `undefined`
      // means "not available right now" — fall back to the original
      // substring ranking, silently. Ranking is an enhancement, never a
      // dependency.
      //
      // Worker-2: the fused RRF scores get a bounded recency/importance
      // boost, so a recent or explicitly-marked-important memory outranks
      // an older coincidental match — without overriding clear relevance.
      const semanticHits = await safeSemanticSearch(deps, userId, query);
      if (semanticHits !== undefined) {
        const textRanked = rank(candidates, query);
        const fused = reciprocalRankFusionWithScores(
          [textRanked.map((m) => m.key), semanticHits.map((h) => h.key)],
          limit,
        );
        const boosted = boostByRecencyImportance(fused, candidates, Date.now());
        const byKey = new Map(candidates.map((m) => [m.key, m]));
        const memories: RecalledMemory[] = [];
        for (const { key } of boosted) {
          const m = byKey.get(key);
          if (m !== undefined) memories.push(toRecalled(m));
        }
        // Which signals actually drove the result: both non-empty →
        // "hybrid"; semantic only → "semantic"; neither → "text" (the same
        // substring order the old fallback would have produced).
        const searchMode =
          textRanked.length > 0 && semanticHits.length > 0
            ? "hybrid"
            : semanticHits.length > 0
              ? "semantic"
              : "text";
        await bumpRecalled(deps, userId, memories);
        return { memories, total: all.length, searchMode };
      }

      const textHits = rank(candidates, query).slice(0, limit);
      await bumpRecalled(deps, userId, textHits);
      return {
        memories: textHits.map((m) => toRecalled(m)),
        total: all.length,
        searchMode: "text",
      };
    },
  };
}

/**
 * Semantic search with the documented silent fallback.
 *
 * The index contract says search() resolves to undefined "when not available
 * right now", but a failing store underneath it can still reject (search
 * joins back to the provider per hit). A throwing semantic layer must never
 * break recall: catch it and fall back to the substring ranking, silently.
 */
async function safeSemanticSearch(
  deps: MemoryDeps,
  userId: string,
  query: string,
): Promise<Array<{ key: string; content: string; score: number }> | undefined> {
  if (deps.semantic === undefined) return undefined;
  try {
    return await deps.semantic.search(userId, query, HYBRID_SEMANTIC_CANDIDATES);
  } catch {
    return undefined;
  }
}

/**
 * Rank memories against a query.
 *
 * Deliberately simple and deterministic: a case-insensitive substring test over
 * the key and the content, with key matches first because the key is the
 * model's own label for the memory and is the stronger signal. A scoring model
 * would be harder to reason about and would not beat this for the handful of
 * entries a single user stores.
 *
 * Worker-2: the query is expanded (Persian normalization — ي/ك variants,
 * diacritics, half-spaces — plus a whitespace-free form) and each variant is
 * tested against the normalized key/content, so «مي‌روم» finds a stored
 * «میروم». Key tier still outranks content tier, as before.
 */
function rank<T extends { key: string; content: string }>(
  memories: readonly T[],
  query: string,
): T[] {
  const variants = expandQueryVariants(query);
  const keyHits: T[] = [];
  const contentHits: T[] = [];

  for (const m of memories) {
    const keyNorm = normalizeMemoryText(m.key);
    const contentNorm = normalizeMemoryText(m.content);
    const keyFlat = keyNorm.replace(/\s+/g, "");
    const contentFlat = contentNorm.replace(/\s+/g, "");
    const keyHit = variants.some(
      (v) => keyNorm.includes(v) || keyFlat.includes(v),
    );
    if (keyHit) {
      keyHits.push(m);
      continue;
    }
    if (
      variants.some((v) => contentNorm.includes(v) || contentFlat.includes(v))
    ) {
      contentHits.push(m);
    }
  }
  return [...keyHits, ...contentHits];
}

/** Shape one stored memory for the recall response (importance included). */
function toRecalled(m: {
  key: string;
  content: string;
  importance?: number | null;
}): RecalledMemory {
  return { key: m.key, content: m.content, importance: memoryImportance(m) };
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

export const forgetManifest: ToolManifest = defineManifest({
  id: "forget",
  version: "1.0.0",
  title: "Forget",
  description: "Delete a memory by its key.",
  purpose: "delete a memory",
  useWhen: "forget asked",
  doNotUseWhen:
    "memory key unknown — recall first to find it; bulk cleanup of memories is not done here",
  confusableWith: [
    { tool: "recall", difference: "recall only reads memories; forget deletes one by its key" },
    { tool: "curate_memories", difference: "curate_memories bulk-cleans memory; forget removes exactly one key" },
  ],
  latencyTier: "instant",
  outputSummary: "Whether a memory was removed and the remaining total.",
  category: "memory",
  triggers: {
    keywordPatterns: [
      "فراموش کن",
      "از حافظه پاک کن",
      "forget (that|this|about)",
    ],
  },
  costTier: "free",
});

export function createForgetTool(deps: MemoryDeps): Tool<ForgetInput, ForgetOutput> {
  return {
    name: "forget",
    manifest: forgetManifest,
    description: "Delete a memory by its key.",
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
          description: "Key of the memory to delete.",
          minLength: 1,
          maxLength: MAX_KEY_LENGTH,
        },
      },
    },

    async run(input: ForgetInput, ctx: ToolContext): Promise<ForgetOutput> {
      const key = normalizeKey(input.key);
      const userId = ownerOf(ctx.actor);

      const removed = await deps.provider.delete(userId, key);
      // Phase 4: drop the vector too, so a forgotten memory can never rank
      // in a future semantic search. Best-effort: search() joins back to the
      // provider, so a leftover row could never surface anyway.
      deps.semantic?.removeMemory(userId, key);
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
    throw new ToolError("not_allowed", "Identity is unknown; memory is unavailable.");
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
    throw new ToolError("invalid_input", "Memory key is empty.");
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new ToolError("invalid_input", "Memory key is too long.");
  }
  return key;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_RECALL_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  return n > MAX_RECALL_LIMIT ? MAX_RECALL_LIMIT : n;
}
