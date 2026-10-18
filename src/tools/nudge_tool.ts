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
import { MAX_NUDGE_TEXT_LENGTH, type NudgeTracker } from "../nudges/tracker";
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

export function createNoteFollowupTool(deps: NudgeToolDeps): Tool<NoteFollowupInput, NoteFollowupOutput> {
  const timeZone = deps.defaultTimezone ?? DEFAULT_NUDGE_TIMEZONE;
  return {
    name: "note_followup",
    description:
      "یک پیگیری ثبت کن تا بات بعداً خودش یادآوری‌اش کند؛ تا وقتی کاربر صراحتاً نبنددش، یادآوری تکرار می‌شود. زمان را می‌توان به فارسی طبیعی («فردا ساعت ۹») یا ISO با منطقهٔ زمانی داد.",
    enabled: true,
    permission: { requires: [NOTE_FOLLOWUP_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        text: {
          type: "string",
          required: true,
          description: "چه چیزی باید پیگیری شود.",
          minLength: 1,
          maxLength: MAX_NUDGE_TEXT_LENGTH,
        },
        when: {
          type: "string",
          required: true,
          description: "زمان پیگیری: فارسی طبیعی مثل «فردا ساعت ۹» یا ISO مثل 2026-10-20T09:30:00+03:30.",
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
          "زمان قابل فهم نبود؛ مثلاً «فردا ساعت ۹» یا یک زمان ISO با منطقهٔ زمانی بده.",
        );
      }
      let id: number;
      try {
        id = deps.tracker.note(userId, input.text, dueAtMs, "tool");
      } catch (err) {
        // Cap/validation failures from the store become model-readable errors.
        throw new ToolError("invalid_input", err instanceof Error ? err.message : "ثبت پیگیری ناموفق بود.");
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

export function createListNudgesTool(deps: NudgeToolDeps): Tool<Record<string, never>, ListNudgesOutput> {
  return {
    name: "list_nudges",
    description: "پیگیری‌های باز (بسته‌نشده) کاربر را فهرست کن.",
    enabled: true,
    permission: { requires: [LIST_NUDGES_PERMISSION] },
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

export function createAckNudgeTool(deps: NudgeToolDeps): Tool<AckNudgeInput, AckNudgeOutput> {
  return {
    name: "ack_nudge",
    description: "یک پیگیری را با شناسه‌اش ببند (انجام شد).",
    enabled: true,
    permission: { requires: [ACK_NUDGE_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "شناسهٔ پیگیری، از فهرست پیگیری‌ها.",
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

export function createSnoozeNudgeTool(deps: NudgeToolDeps): Tool<SnoozeNudgeInput, SnoozeNudgeOutput> {
  const timeZone = deps.defaultTimezone ?? DEFAULT_NUDGE_TIMEZONE;
  return {
    name: "snooze_nudge",
    description: "یک پیگیری را به زمان دیگری موکول کن.",
    enabled: true,
    permission: { requires: [SNOOZE_NUDGE_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "شناسهٔ پیگیری، از فهرست پیگیری‌ها.",
          minimum: 1,
        },
        until: {
          type: "string",
          required: true,
          description: "زمان جدید: فارسی طبیعی مثل «فردا ساعت ۹» یا ISO با منطقهٔ زمانی.",
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
          "زمان قابل فهم نبود؛ مثلاً «فردا ساعت ۹» یا یک زمان ISO با منطقهٔ زمانی بده.",
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
    throw new ToolError("not_allowed", "هویت مشخص نیست؛ پیگیری در دسترس نیست.");
  }
  return id;
}
