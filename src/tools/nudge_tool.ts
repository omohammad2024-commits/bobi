/**
 * Nudge tools — note_followup, list_nudges, ack_nudge, snooze_nudge.
 *
 * Stage-3 differentiator: proactive smart follow-ups. While `remind_at` fires
 * a message at a fixed time and retires, a nudge is a follow-up the bot keeps
 * resurfacing (via the sweep) until the user explicitly closes it — "the bot
 * remembers what you forgot".
 *
 * The `when`/`until` parameters accept natural Persian («فردا ساعت ۹») parsed
 * deterministically by src/nudges/time_fa.ts, or an ISO-8601 instant with an
 * offset. There is no Persian NL date parser elsewhere in the codebase to
 * reuse (the model resolves relative dates itself via the date_time tool), so
 * parsing lives server-side here rather than trusting the model's math.
 *
 * SECURITY:
 * - Every tool is scoped to the server-supplied actor (ownerOf): a nudge
 *   belongs to the userId the platform authenticated, never to a name the
 *   model picks. ack/snooze filter by (id, userId) in the store, so one user
 *   can never touch another's nudge id (no IDOR).
 * - Nudge delivery (the sweep) goes only to the originating user — see
 *   src/nudges/sweep.ts. Nudges are never group-targeted.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import { MAX_NUDGE_TEXT_LENGTH, MAX_OPEN_NUDGES_PER_USER, type NudgeTracker } from "../nudges/tracker";
import { DEFAULT_NUDGE_TIMEZONE, parseDueInstant } from "../nudges/time_fa";

export const NOTE_FOLLOWUP_PERMISSION = "tools:note_followup";
export const LIST_NUDGES_PERMISSION = "tools:list_nudges";
export const ACK_NUDGE_PERMISSION = "tools:ack_nudge";
export const SNOOZE_NUDGE_PERMISSION = "tools:snooze_nudge";

export interface NudgeToolDeps {
  tracker: NudgeTracker;
  /** Zone used to resolve Persian relative times. Defaults to Asia/Tehran. */
  defaultTimezone?: string;
}

// ---------- note_followup ----------

export interface NoteFollowupInput {
  text: string;
  /**
   * When it is due: natural Persian («فردا ساعت ۹», «هفته‌ی بعد») or an
   * ISO-8601 instant with an offset (2026-10-20T09:30:00+03:30).
   */
  when: string;
}

export interface NoteFollowupOutput {
  id: number;
  dueAt: string;
  /** How long until it is due, in minutes, for the model to confirm. */
  inMinutes: number;
}

/** Plugin discovery manifest for `note_followup`. */
export const noteFollowupManifest: ToolManifest = defineManifest({
  id: "note_followup",
  version: "1.0.0",
  title: "Note Follow-up",
  description: "Record a follow-up for the bot to remind about later; reminders repeat until the user explicitly closes it. The time can be given in natural language or ISO with a timezone.",
  purpose: "nagged follow-up",
  useWhen: "must chase later",
  doNotUseWhen:
    "one-shot reminder at a fixed time — that is remind_at or remind_nl; follow-ups repeat until the user closes them",
  confusableWith: [
    { tool: "remind_at", difference: "remind_at fires once at an ISO time; a follow-up repeats until acked" },
    { tool: "remind_nl", difference: "remind_nl fires once from a Persian phrase; a follow-up keeps resurfacing" },
  ],
  latencyTier: "instant",
  outputSummary: "Returns the follow-up id, due time and minutes until due.",
  category: "schedule",
  triggers: { keywordPatterns: ["دنبال کن", "پیگیری کن", "follow up", "note (a )?follow.?up"] },
  costTier: "free",
});

export function createNoteFollowupTool(deps: NudgeToolDeps): Tool<NoteFollowupInput, NoteFollowupOutput> {
  const timeZone = deps.defaultTimezone ?? DEFAULT_NUDGE_TIMEZONE;
  return {
    name: "note_followup",
    manifest: noteFollowupManifest,
    description:
      "Record a follow-up for the bot to remind about later; reminders repeat until the user explicitly closes it. The time can be given in natural language or ISO with a timezone.",
    enabled: true,
    permission: { requires: [NOTE_FOLLOWUP_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: {
      fields: {
        text: {
          type: "string",
          required: true,
          description: "What should be followed up.",
          minLength: 1,
          maxLength: MAX_NUDGE_TEXT_LENGTH,
        },
        when: {
          type: "string",
          required: true,
          description: "Follow-up time: natural language or ISO like 2026-10-20T09:30:00+03:30.",
          minLength: 1,
          maxLength: 80,
        },
      },
    },

    async run(input: NoteFollowupInput, ctx: ToolContext): Promise<NoteFollowupOutput> {
      const userId = ownerOf(ctx);
      const nowMs = ctx.clock().getTime();
      const dueAtMs = parseDueInstant(input.when, nowMs, timeZone);
      if (dueAtMs === null) {
        throw new ToolError(
          "invalid_input",
          "The time could not be understood; give a natural phrase or an ISO time with a timezone.",
        );
      }
      const text = input.text.trim();
      if (text.length === 0) {
        throw new ToolError("invalid_input", "Follow-up text is empty.");
      }
      if (deps.tracker.countOpen(userId) >= MAX_OPEN_NUDGES_PER_USER) {
        throw new ToolError(
          "invalid_input",
          "Too many open follow-ups; close or snooze some first.",
        );
      }
      let id: number;
      try {
        id = deps.tracker.note(userId, text, dueAtMs, "tool");
      } catch {
        // The tracker's own messages are internal; the caller gets a fixed,
        // English, actionable error instead.
        throw new ToolError("internal", "Could not record the follow-up.");
      }
      return {
        id,
        dueAt: new Date(dueAtMs).toISOString(),
        inMinutes: Math.round((dueAtMs - nowMs) / 60_000),
      };
    },
  };
}

// ---------- list_nudges ----------

export interface ListNudgesOutput {
  nudges: Array<{
    id: number;
    text: string;
    dueAt: string;
    snoozedUntil: string | null;
    status: string;
  }>;
  count: number;
}

/** Plugin discovery manifest for `list_nudges`. */
export const listNudgesManifest: ToolManifest = defineManifest({
  id: "list_nudges",
  version: "1.0.0",
  title: "List Nudges",
  description: "List the user's open (not closed) follow-ups.",
  purpose: "open follow-ups",
  useWhen: "follow-ups asked",
  doNotUseWhen:
    "pending one-shot reminders — that is list_reminders; scheduled cron tasks — that is list_tasks",
  confusableWith: [
    { tool: "list_reminders", difference: "list_reminders shows one-shot reminders; this shows open follow-ups" },
    { tool: "list_tasks", difference: "list_tasks shows cron jobs; this shows follow-ups awaiting closure" },
  ],
  latencyTier: "instant",
  outputSummary: "Returns the user's open follow-ups with id, text, due and snooze times.",
  category: "schedule",
  triggers: { keywordPatterns: ["پیگیریهام", "list (my )?(nudges|follow.?ups)"] },
  costTier: "free",
});

export function createListNudgesTool(deps: NudgeToolDeps): Tool<Record<string, never>, ListNudgesOutput> {
  return {
    name: "list_nudges",
    manifest: listNudgesManifest,
    description: "List the user's open (not closed) follow-ups.",
    enabled: true,
    permission: { requires: [LIST_NUDGES_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: { fields: {} },

    async run(_input: Record<string, never>, ctx: ToolContext): Promise<ListNudgesOutput> {
      const userId = ownerOf(ctx);
      const rows = deps.tracker.list(userId);
      return {
        nudges: rows.map((r) => ({
          id: r.id,
          text: r.text,
          dueAt: new Date(r.dueAtMs).toISOString(),
          snoozedUntil: r.snoozeUntilMs === null ? null : new Date(r.snoozeUntilMs).toISOString(),
          status: r.status,
        })),
        count: rows.length,
      };
    },
  };
}

// ---------- ack_nudge ----------

export interface AckNudgeInput {
  id: number;
}

export interface AckNudgeOutput {
  id: number;
  /** False when there was no open nudge with that id for this user. */
  acked: boolean;
  remaining: number;
}

/** Plugin discovery manifest for `ack_nudge`. */
export const ackNudgeManifest: ToolManifest = defineManifest({
  id: "ack_nudge",
  version: "1.0.0",
  title: "Acknowledge Nudge",
  description: "Close a follow-up by its id (done).",
  purpose: "close a follow-up",
  useWhen: "follow-up done",
  doNotUseWhen:
    "only postponing it — that is snooze_nudge; closing a reminder — that is cancel_reminder",
  confusableWith: [
    { tool: "snooze_nudge", difference: "snooze postpones a follow-up; ack closes it for good" },
    { tool: "cancel_reminder", difference: "cancel_reminder deletes a one-shot reminder; ack closes a follow-up" },
  ],
  latencyTier: "instant",
  outputSummary: "Returns the acked flag, nudge id, and count of remaining open nudges.",
  category: "schedule",
  costTier: "free",
});

export function createAckNudgeTool(deps: NudgeToolDeps): Tool<AckNudgeInput, AckNudgeOutput> {
  return {
    name: "ack_nudge",
    manifest: ackNudgeManifest,
    description: "Close a follow-up by its id (done).",
    enabled: true,
    permission: { requires: [ACK_NUDGE_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "Follow-up id, from the follow-up list.",
          minimum: 1,
        },
      },
    },

    async run(input: AckNudgeInput, ctx: ToolContext): Promise<AckNudgeOutput> {
      const userId = ownerOf(ctx);
      // Scoped to the owner in the store: another user's id is a no-op.
      const acked = deps.tracker.ack(input.id, userId);
      return { id: input.id, acked, remaining: deps.tracker.countOpen(userId) };
    },
  };
}

// ---------- snooze_nudge ----------

export interface SnoozeNudgeInput {
  id: number;
  /** New due time: natural Persian («فردا ساعت ۹») or ISO-8601 with offset. */
  until: string;
}

export interface SnoozeNudgeOutput {
  id: number;
  /** False when there was no open nudge with that id for this user. */
  snoozed: boolean;
  snoozedUntil: string | null;
}

/** Plugin discovery manifest for `snooze_nudge`. */
export const snoozeNudgeManifest: ToolManifest = defineManifest({
  id: "snooze_nudge",
  version: "1.0.0",
  title: "Snooze Nudge",
  description: "Postpone a follow-up to another time.",
  purpose: "postpone follow-up",
  useWhen: "delay asked",
  doNotUseWhen:
    "follow-up is finished — that is ack_nudge; rescheduling a reminder — cancel and recreate it instead",
  confusableWith: [
    { tool: "ack_nudge", difference: "ack closes the follow-up; snooze only moves its due time" },
    { tool: "note_followup", difference: "note_followup creates a follow-up; snooze moves an existing one" },
  ],
  latencyTier: "instant",
  outputSummary: "Returns the snoozed flag, nudge id, and the new snoozed-until time.",
  category: "schedule",
  costTier: "free",
});

export function createSnoozeNudgeTool(deps: NudgeToolDeps): Tool<SnoozeNudgeInput, SnoozeNudgeOutput> {
  const timeZone = deps.defaultTimezone ?? DEFAULT_NUDGE_TIMEZONE;
  return {
    name: "snooze_nudge",
    manifest: snoozeNudgeManifest,
    description: "Postpone a follow-up to another time.",
    enabled: true,
    permission: { requires: [SNOOZE_NUDGE_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "Follow-up id, from the follow-up list.",
          minimum: 1,
        },
        until: {
          type: "string",
          required: true,
          description: "New time: natural language or ISO with a timezone.",
          minLength: 1,
          maxLength: 80,
        },
      },
    },

    async run(input: SnoozeNudgeInput, ctx: ToolContext): Promise<SnoozeNudgeOutput> {
      const userId = ownerOf(ctx);
      const nowMs = ctx.clock().getTime();
      const untilMs = parseDueInstant(input.until, nowMs, timeZone);
      if (untilMs === null) {
        throw new ToolError(
          "invalid_input",
          "The time could not be understood; give a natural phrase or an ISO time with a timezone.",
        );
      }
      const snoozed = deps.tracker.snooze(input.id, userId, untilMs);
      return {
        id: input.id,
        snoozed,
        snoozedUntil: snoozed ? new Date(untilMs).toISOString() : null,
      };
    },
  };
}

/** Build all four nudge tools. */
export function createNudgeTools(deps: NudgeToolDeps): readonly Tool<unknown, unknown>[] {
  return [
    createNoteFollowupTool(deps),
    createListNudgesTool(deps),
    createAckNudgeTool(deps),
    createSnoozeNudgeTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}

// ---------- helpers ----------

/**
 * The owner id for this call, taken from the server-supplied actor.
 * An unidentified actor is refused rather than sharing one nudge store.
 */
function ownerOf(ctx: ToolContext): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown; follow-ups are unavailable.");
  }
  return id;
}
