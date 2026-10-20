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
import { SummarizerService } from "./summarize";
import type { SummarizerOptions } from "./summarize";
import {
  EventStore,
  eventWhen,
  nextOccurrence,
  parsePersianDate,
  type EventKind,
} from "../memory/events";
import { applyFactCandidate, factKindOfKey } from "../memory/contradictions";
import type { FactCandidate } from "../memory/auto_extract";
import type { Tool, ToolContext } from "../tools/types";

export const CURATE_MEMORIES_PERMISSION = "tools:curate_memories";
export const CURATOR_DECIDE_PERMISSION = "tools:curator_decide";
export const SUMMARIZE_MEMORIES_PERMISSION = "tools:summarize_memories";
export const NOTE_EVENT_PERMISSION = "tools:note_event";
export const LIST_EVENTS_PERMISSION = "tools:list_events";

export interface CuratorToolDeps {
  provider: MemoryProvider;
  store: ProposalStore;
  /**
   * Server-supplied owner check. The userId comes from the trusted actor, so
   * this predicate — not anything in the request — decides ownership.
   */
  isOwner: (userId: string) => boolean;
  /**
   * Injectable clock (ms) for time-dependent tools (archive keys, days-until).
   * Defaults to Date.now. Tests inject a fixed clock.
   */
  now?: () => number;
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
      'Review long-term memories and store improvement proposals (merge duplicates, remove stale entries, split overloaded ones). It changes nothing by itself; proposals are applied only via the curator_decide tool with owner approval (owner only).',
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
      'Decide on a memory-review proposal: "approve" applies the proposal to memory, "reject" just closes it. No proposal is applied without explicit approval (owner only).',
    enabled: true,
    ownerOnly: true,
    permission: { requires: [CURATOR_DECIDE_PERMISSION] },
    toolset: "memory",
    input: {
      fields: {
        proposalId: {
          type: "string",
          required: true,
          description: "Proposal id, from the curate_memories output.",
          minLength: 1,
          maxLength: 128,
        },
        decision: {
          type: "enum",
          required: true,
          description: "The owner's decision.",
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
          "No proposal found with this id; it may have already been decided or expired.",
        );
      }

      if (input.decision === "approve") {
        // Apply FIRST: if the write fails the proposal stays pending and the
        // owner can retry, rather than being marked approved with nothing done.
        //
        // Memory core: an approved NEW fact is applied through the
        // contradiction pass — a stored fact it supersedes is tombstoned
        // instead of living on next to its replacement. Corrections arrive
        // as "update" actions (in-place replace) and deliberately keep the
        // plain path: applyFactCandidate refuses them by design. If the
        // pass cannot run for this proposal, the plain apply still happens.
        const action = proposal.suggestedAction;
        const viaSupersession =
          proposal.kind === "fact" && action.type === "add"
            ? await applyFactWithSupersession(deps.provider, userId, action)
            : false;
        if (!viaSupersession) {
          await applyProposalAction(deps.provider, userId, action);
        }
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

/** Build the curator tools plus the Phase-3 memory tools. All owner-only. */
export function createCuratorTools(deps: CuratorToolDeps): readonly Tool<unknown, unknown>[] {
  return [
    createCurateMemoriesTool(deps),
    createCuratorDecideTool(deps),
    createSummarizeMemoriesTool(deps),
    createNoteEventTool(deps),
    createListEventsTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}

// ---------- summarize_memories ----------

export interface SummarizeMemoriesInput {
  olderThanDays?: number;
  maxEntries?: number;
}

export interface SummarizeMemoriesOutput {
  archived: boolean;
  archiveKey?: string;
  count?: number;
  /** Stored proposal id for the originals' deletion — decide via curator_decide. */
  proposalId?: string;
  summaryFa: string;
}

/**
 * Phase-3: opt-in periodic auto-summarization. Consolidates old memories
 * into one additive archive entry and stores a deletion proposal for the
 * originals through the EXISTING curator flow — nothing is deleted without
 * the owner's explicit curator_decide approval. Owner-only.
 */
export function createSummarizeMemoriesTool(deps: CuratorToolDeps): Tool<SummarizeMemoriesInput, SummarizeMemoriesOutput> {
  return {
    name: "summarize_memories",
    description:
      'Automatically archive old memories (owner only): summarizes not-recently-updated old memories into one "archive" entry and files deletion of the originals as a proposal — deletion only with owner approval in curator_decide. Default: older than 90 days.',
    enabled: true,
    ownerOnly: true,
    permission: { requires: [SUMMARIZE_MEMORIES_PERMISSION] },
    toolset: "memory",
    input: {
      fields: {
        olderThanDays: {
          type: "number",
          required: false,
          description: "Age threshold in days (default 90).",
          minimum: 7,
          maximum: 365,
        },
        maxEntries: {
          type: "number",
          required: false,
          description: "Max memories per run (default 20).",
          minimum: 1,
          maximum: 50,
        },
      },
    },

    async run(input: SummarizeMemoriesInput, ctx: ToolContext): Promise<SummarizeMemoriesOutput> {
      const userId = ownerOf(ctx, deps);
      const service =
        deps.now !== undefined
          ? new SummarizerService({ provider: deps.provider }, { now: deps.now })
          : new SummarizerService({ provider: deps.provider });
      const summarizeOpts: SummarizerOptions = {};
      if (input.olderThanDays !== undefined) summarizeOpts.olderThanDays = input.olderThanDays;
      if (input.maxEntries !== undefined) summarizeOpts.maxEntries = input.maxEntries;
      const report = await service.review(userId, summarizeOpts);
      if (!report.archived || report.proposal === undefined) {
        return { archived: false, summaryFa: report.reason ?? "Nothing was archived." };
      }
      // The deletion proposal goes through the standard store, so the owner
      // approves it in curator_decide like any other proposal.
      const [stored] = deps.store.saveProposals(userId, [report.proposal]);
      const out: SummarizeMemoriesOutput = {
        archived: true,
        summaryFa: report.proposal.summaryFa,
      };
      if (report.archiveKey !== undefined) out.archiveKey = report.archiveKey;
      if (report.count !== undefined) out.count = report.count;
      if (stored !== undefined) out.proposalId = stored.id;
      return out;
    },
  };
}

// ---------- note_event / list_events ----------

const EVENT_KINDS: readonly EventKind[] = ["birthday", "anniversary", "monthly", "once"];

export interface NoteEventInput {
  /** e.g. «علی» */
  name: string;
  kind: EventKind;
  /** Persian date: «۱۵ مرداد» or «۲۰ شهریور ۱۴۰۳» (year forces kind "once"). */
  date: string;
  note?: string;
}

export interface NoteEventOutput {
  key: string;
  name: string;
  kind: EventKind;
  labelFa: string;
  summaryFa: string;
}

/**
 * Phase-3: store a dated event (birthday, anniversary, monthly commitment,
 * one-off). The morning digest lists upcoming events and the event sweep
 * sends proactive reminders ahead of them. Owner-only.
 */
export function createNoteEventTool(deps: CuratorToolDeps): Tool<NoteEventInput, NoteEventOutput> {
  return {
    name: "note_event",
    description:
      "Record a dated event in memory (owner only): birthday, anniversary, monthly commitment or one-off event. Persian date like «۱۵ مرداد» or «۲۰ شهریور ۱۴۰۳»; upcoming events appear in the morning digest and are reminded ahead of time.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [NOTE_EVENT_PERMISSION] },
    toolset: "memory",
    input: {
      fields: {
        name: {
          type: "string",
          required: true,
          description: "Event name, e.g. «علی» or «قسط وام».",
          minLength: 1,
          maxLength: 120,
        },
        kind: {
          type: "enum",
          required: true,
          description: "Event type.",
          choices: ["birthday", "anniversary", "monthly", "once"] as const,
        },
        date: {
          type: "string",
          required: true,
          description: "Persian date: «۱۵ مرداد» or «۲۰ شهریور ۱۴۰۳».",
          minLength: 1,
          maxLength: 40,
        },
        note: {
          type: "string",
          required: false,
          description: "Optional note.",
          maxLength: 200,
        },
      },
    },

    async run(input: NoteEventInput, ctx: ToolContext): Promise<NoteEventOutput> {
      const userId = ownerOf(ctx, deps);
      if (!EVENT_KINDS.includes(input.kind)) {
        throw new ToolError("invalid_input", "Invalid event type.");
      }
      const parsed = parsePersianDate(input.date);
      if (parsed === null) {
        throw new ToolError(
          "invalid_input",
          "I could not parse that date; write it like «۱۵ مرداد» or «۲۰ شهریور ۱۴۰۳».",
        );
      }
      const store = new EventStore(deps.provider);
      const key = await store.add(userId, {
        name: input.name,
        // A named Jalali year is a one-off occurrence, whatever kind was passed.
        kind: parsed.jYear !== undefined ? "once" : input.kind,
        jMonth: parsed.jMonth,
        jDay: parsed.jDay,
        ...(parsed.jYear !== undefined ? { jYear: parsed.jYear } : {}),
        labelFa: parsed.labelFa,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return {
        key,
        name: input.name.trim(),
        kind: parsed.jYear !== undefined ? "once" : input.kind,
        labelFa: parsed.labelFa,
        summaryFa: `Event "${input.name.trim()}" recorded for ${parsed.labelFa}.`,
      };
    },
  };
}

export interface ListEventsOutput {
  events: Array<{
    key: string;
    name: string;
    kind: EventKind;
    labelFa: string;
    daysUntil: number | null;
    when: string | null;
  }>;
  count: number;
}

/** Phase-3: list the owner's dated events with days-until for each. Owner-only. */
export function createListEventsTool(deps: CuratorToolDeps): Tool<Record<string, never>, ListEventsOutput> {
  return {
    name: "list_events",
    description: "List recorded dated events with days until the next occurrence (owner only).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [LIST_EVENTS_PERMISSION] },
    toolset: "memory",
    input: { fields: {} },

    async run(_input: Record<string, never>, ctx: ToolContext): Promise<ListEventsOutput> {
      const userId = ownerOf(ctx, deps);
      const store = new EventStore(deps.provider);
      const nowMs = deps.now?.() ?? Date.now();
      const rows = await store.list(userId);
      const events = rows.map(({ key, event }) => {
        const occ = nextOccurrence(event, nowMs);
        return {
          key,
          name: event.name,
          kind: event.kind,
          labelFa: event.labelFa,
          daysUntil: occ?.daysUntil ?? null,
          when: occ ? eventWhen(occ.daysUntil) : null,
        };
      });
      return { events, count: events.length };
    },
  };
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
    throw new ToolError("not_allowed", "Identity not resolved.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "Memory review is owner-only.");
  }
  return id;
}

/**
 * Fact kinds the contradiction pass is safe to supersede on.
 *
 * "correction" is deliberately absent: corrections are written as "update"
 * actions (in-place replace) and applyFactCandidate refuses them loudly —
 * a correction that found no target is an ambiguous edit, not a new fact
 * that may evict a whole predicate family.
 */
const SUPERSEDABLE_FACT_KINDS: ReadonlySet<string> = new Set([
  "name",
  "preference",
  "commitment",
  "decision",
]);

/**
 * Apply an approved fact "add" through the contradiction pass
 * (applyFactCandidate), so a stored fact the new one supersedes is
 * tombstoned instead of left live alongside its replacement.
 *
 * Returns true when the pass applied the fact; false when it did not run
 * (non-fact key shape, non-supersedable kind, or an internal failure) —
 * the caller then falls back to the plain apply, so an approval is never
 * lost. The supersession log entry carries keys only, never values.
 */
async function applyFactWithSupersession(
  provider: MemoryProvider,
  userId: string,
  action: Extract<ProposalAction, { type: "add" }>,
): Promise<boolean> {
  const kind = factKindOfKey(action.key);
  if (kind === undefined || !SUPERSEDABLE_FACT_KINDS.has(kind)) return false;
  const candidate: FactCandidate = {
    kind: kind as FactCandidate["kind"],
    key: action.key,
    content: action.content,
    importance: action.importance ?? 3,
    isCorrection: false,
    source: "curator",
  };
  try {
    await applyFactCandidate(provider, userId, candidate, (entry) => {
      console.info(
        `[memory] fact superseded: kind=${entry.kind} old=${entry.supersededKey} new=${entry.newKey}`,
      );
    });
    return true;
  } catch {
    return false;
  }
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
      await provider.upsert(
        userId,
        action.key,
        action.newContent,
        action.importance !== undefined ? { importance: action.importance } : undefined,
      );
      break;
    case "split":
      await provider.delete(userId, action.key);
      for (const part of action.parts) {
        await provider.upsert(userId, part.key, part.content);
      }
      break;
    case "add":
      // Phase-5: a brand-new memory from an import package (owner reviewed).
      // Worker-2: an optional extraction-time importance rides along.
      await provider.upsert(
        userId,
        action.key,
        action.content,
        action.importance !== undefined ? { importance: action.importance } : undefined,
      );
      break;
    case "add_event": {
      // Phase-5: an auto-extracted or imported dated event (owner reviewed).
      // EventStore.add re-validates and upserts by the deterministic event
      // key, so approving the same proposal twice cannot duplicate.
      const events = new EventStore(provider);
      await events.add(userId, action.event);
      break;
    }
  }
}

/** Re-exported for tests and the phase doc; not an apply path. */
export type { StoredProposal };
