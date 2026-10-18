/**
 * Curator tools — `curate_memories` and `curator_decide` (Phase D4).
 *
 * Both are OWNER-ONLY: they read and (with approval) rewrite the owner's
 * long-term memory, so the decision to run them is administrative. Owner-only
 * is enforced twice, following the scheduled-tasks pattern: the `ownerOnly`
 * flag keeps the authorization bridge from granting the permission keys to
 * anyone else, and run() re-checks ownership against the server-supplied
 * isOwner predicate, so a hand-built actor cannot slip through either.
 *
 * The core safety invariant — the curator NEVER mutates memories on its own:
 * - `curate_memories` only READS memories and STORES proposals. It returns
 *   the Persian proposal list so the owner can read each exact old→new diff.
 * - `curator_decide` is the ONLY place that writes. It applies the stored
 *   proposal's action through the MemoryProvider only when
 *   decision === "approve"; "reject" just marks the row resolved. There is
 *   deliberately no other apply path in this file: applyProposalAction is
 *   module-private and the ProposalStore has no provider access.
 * - The proposal applied is the one stored in the database (fetched by id,
 *   scoped to the calling owner), never anything from the tool input —
 *   input cannot smuggle in a different action.
 * - Expired proposals (7-day TTL) resolve to "not found", so a stale
 *   approval can never fire later.
 */
import { ToolError } from "../tools/errors";
import { CuratorService, kindLabelFa } from "./curator";
import type { ProposalAction, ProposalKind } from "./curator";
import type { MemoryProvider } from "../memory/provider";
import { ProposalStore } from "./proposals";
import type { StoredProposal } from "./proposals";
import type { Tool, ToolContext } from "../tools/types";

export const CURATE_MEMORIES_PERMISSION = "tools:curate_memories";
export const CURATOR_DECIDE_PERMISSION = "tools:curator_decide";

export interface CuratorToolDeps {
  provider: MemoryProvider;
  store: ProposalStore;
  /**
   * Server-supplied owner check. The userId comes from the trusted actor, so
   * this predicate — not anything in the request — decides ownership.
   */
  isOwner: (userId: string) => boolean;
}

/** Build the service from deps, so review() is easy to unit-test alone. */
export function createCuratorService(deps: CuratorToolDeps): CuratorService {
  return new CuratorService({ provider: deps.provider });
}

// ---------- curate_memories ----------

export interface CurateMemoriesOutput {
  proposals: Array<{
    id: string;
    kind: ProposalKind;
    kindFa: string;
    memoryIds: string[];
    summaryFa: string;
  }>;
  count: number;
}

export function createCurateMemoriesTool(deps: CuratorToolDeps): Tool<Record<string, never>, CurateMemoriesOutput> {
  const service = createCuratorService(deps);
  return {
    name: "curate_memories",
    description:
      "حافظه‌های بلندمدت را بازبینی کن و پیشنهادهای بهبود (ادغام تکراری‌ها، حذف قدیمی‌ها، تقسیم شلوغ‌ها) را ذخیره کن. خودش هیچ‌چیز را تغییر نمی‌دهد؛ اعمال پیشنهادها فقط با ابزار curator_decide و تأیید مالک است (فقط مالک).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [CURATE_MEMORIES_PERMISSION] },
    toolset: "memory",
    input: { fields: {} },

    async run(_input: Record<string, never>, ctx: ToolContext): Promise<CurateMemoriesOutput> {
      const userId = ownerOf(ctx, deps);
      // Read-only scan: review() has no write path by construction.
      const proposals = await service.review(userId);
      const stored = deps.store.saveProposals(userId, proposals);
      return {
        proposals: stored.map((p) => ({
          id: p.id,
          kind: p.kind,
          kindFa: kindLabelFa(p.kind),
          memoryIds: p.memoryIds,
          summaryFa: p.summaryFa,
        })),
        count: stored.length,
      };
    },
  };
}

// ---------- curator_decide ----------

export interface CuratorDecideInput {
  proposalId: string;
  decision: "approve" | "reject";
}

export interface CuratorDecideOutput {
  proposalId: string;
  decision: "approve" | "reject";
  /** True only when the suggested action was applied to memory. */
  applied: boolean;
  /** The exact diff the owner approved (or rejected). */
  summaryFa: string;
}

export function createCuratorDecideTool(deps: CuratorToolDeps): Tool<CuratorDecideInput, CuratorDecideOutput> {
  return {
    name: "curator_decide",
    description:
      "دربارهٔ یک پیشنهاد بازبینی حافظه تصمیم بگیر: «approve» یعنی اعمال پیشنهاد روی حافظه، «reject» یعنی فقط بستن پیشنهاد. بدون تأیید صریح، هیچ پیشنهادی اعمال نمی‌شود (فقط مالک).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [CURATOR_DECIDE_PERMISSION] },
    toolset: "memory",
    input: {
      fields: {
        proposalId: {
          type: "string",
          required: true,
          description: "شناسهٔ پیشنهاد، از خروجی curate_memories.",
          minLength: 1,
          maxLength: 128,
        },
        decision: {
          type: "enum",
          required: true,
          description: "تصمیم مالک.",
          choices: ["approve", "reject"] as const,
        },
      },
    },

    async run(input: CuratorDecideInput, ctx: ToolContext): Promise<CuratorDecideOutput> {
      const userId = ownerOf(ctx, deps);

      // The actionable proposal comes from the store, scoped to this owner —
      // never from tool input, so input cannot inject a different action.
      const proposal = deps.store.getPending(userId, input.proposalId.trim());
      if (!proposal) {
        throw new ToolError(
          "not_found",
          "پیشنهادی با این شناسه یافت نشد؛ شاید قبلاً تصمیم گرفته شده یا منقضی شده است.",
        );
      }

      if (input.decision === "approve") {
        // Apply FIRST: if the write fails the proposal stays pending and the
        // owner can retry, rather than being marked approved with nothing done.
        await applyProposalAction(deps.provider, userId, proposal.suggestedAction);
      }
      deps.store.resolveProposal(userId, proposal.id, input.decision);

      return {
        proposalId: proposal.id,
        decision: input.decision,
        applied: input.decision === "approve",
        summaryFa: proposal.summaryFa,
      };
    },
  };
}

/** Build both curator tools. */
export function createCuratorTools(deps: CuratorToolDeps): readonly Tool<unknown, unknown>[] {
  return [
    createCurateMemoriesTool(deps),
    createCuratorDecideTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}

// ---------- helpers ----------

/**
 * The owner id for this call, taken from the server-supplied actor — and then
 * checked against the server-supplied owner predicate. Same double-check as
 * the scheduled-task tools: the permission key alone does not prove ownership.
 */
function ownerOf(ctx: ToolContext, deps: CuratorToolDeps): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "هویت مشخص نیست.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "بازبینی حافظه فقط برای مالک است.");
  }
  return id;
}

/**
 * Execute a stored proposal's action through the MemoryProvider.
 *
 * Module-private on purpose: the ONLY caller is curator_decide's run() on the
 * "approve" branch, which is the property the safety tests pin down. The
 * store cannot call this (it has no provider), and tool input cannot reach it
 * (the action comes from the stored row).
 */
async function applyProposalAction(
  provider: MemoryProvider,
  userId: string,
  action: ProposalAction,
): Promise<void> {
  switch (action.type) {
    case "merge":
      // Keep the chosen entry untouched; delete the merged-away keys.
      for (const key of action.removeKeys) {
        if (key !== action.keepKey) await provider.delete(userId, key);
      }
      break;
    case "delete":
      for (const key of action.keys) await provider.delete(userId, key);
      break;
    case "update":
      await provider.upsert(userId, action.key, action.newContent);
      break;
    case "split":
      await provider.delete(userId, action.key);
      for (const part of action.parts) {
        await provider.upsert(userId, part.key, part.content);
      }
      break;
  }
}

/** Re-exported for tests and the phase doc; not an apply path. */
export type { StoredProposal };
