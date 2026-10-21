/**
 * Reminder tools — remind_at, list_reminders, cancel_reminder,
 * snooze_reminder.
 *
 * Phase 8 (silo merge): this family is now the ONE "remind me later"
 * surface. What used to be three parallel systems is one:
 * - `remind_nl` folded into `remind_at`: one tool takes an exact ISO
 *   instant (`dueAt`) OR a natural Persian phrase (`when`) — the phrase is
 *   parsed deterministically server-side (src/tools/persian_datetime.ts),
 *   never by trusting the model's own date math.
 * - The follow-up ("nudge") tools folded in: `followUp: true` on
 *   remind_at creates a reminder that resurfaces until the owner closes
 *   it with cancel_reminder, and snooze is a reminder feature
 *   (snooze_reminder), not a separate system.
 *
 * The due time comes from a MODEL, which makes it untrusted in a specific
 * way: an ISO string can be in the past, absurdly far in the future, or
 * malformed. Every one of those is validated here before a row is
 * written, because a reminder scheduled in the past fires immediately
 * and one scheduled in 2150 is a silent hole in the database.
 *
 * Chat delivery targets the conversation the request came from, which
 * the caller supplies — the model does not get to name a chat id. The
 * one exception is a follow-up: like the old nudge system, it is
 * delivered ONLY to the owner's own DM (chatId = userId), never into a
 * group the request happened to come from.
 */
import { ToolError } from "./errors";
import type { Storage } from "../storage/storage";
import type { ReminderRepeat } from "../storage/storage";
import type { Tool, ToolContext } from "./types";
import { TEHRAN_TZ, parsePersianDateTime } from "./persian_datetime";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const REMIND_AT_PERMISSION = "tools:remind_at";
export const LIST_REMINDERS_PERMISSION = "tools:list_reminders";
export const CANCEL_REMINDER_PERMISSION = "tools:cancel_reminder";
export const SNOOZE_REMINDER_PERMISSION = "tools:snooze_reminder";

/** Ceilings, so one user cannot fill the table or schedule a decade ahead. */
const MAX_PENDING_PER_USER = 25;
const MIN_LEAD_MS = 5_000;
const MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_TEXT_LENGTH = 500;

const REPEATS: readonly ReminderRepeat[] = ["none", "daily", "weekly"];

// ---------- shared time resolution ----------

/**
 * Resolve the model's time input to a validated epoch instant.
 *
 * Accepts exactly one form (both or neither is an error):
 * - `dueAt`: a strict ISO-8601 instant with an offset;
 * - `when`: a natural Persian phrase («فردا ساعت ۹», «۱۰ دقیقه دیگه»,
 *   «۱۵ آبان») parsed deterministically in Asia/Tehran — or, when the
 *   phrase parser cannot read it, the same strict ISO form (models
 *   sometimes put an ISO string in the natural-language field).
 *
 * Every path ends at the same validation: strictly in the future with a
 * small lead, inside a one-year horizon.
 */
function resolveDueInstant(
  args: { dueAt?: string; when?: string },
  nowMs: number,
): number {
  const hasDueAt = args.dueAt !== undefined && args.dueAt.trim().length > 0;
  const hasWhen = args.when !== undefined && args.when.trim().length > 0;
  if (hasDueAt === hasWhen) {
    throw new ToolError(
      "invalid_input",
      "Give the time in exactly one form: dueAt (ISO) or when (a time phrase).",
    );
  }
  if (hasDueAt) {
    return parseDueAt(args.dueAt as string, nowMs);
  }
  const phrase = args.when as string;
  const parsed = parsePersianDateTime(phrase, new Date(nowMs), TEHRAN_TZ);
  if (parsed !== null) {
    return parseDueAt(parsed.toISOString(), nowMs);
  }
  // Not a readable phrase — maybe it is an ISO instant after all.
  return parseDueAt(phrase, nowMs);
}

/**
 * Parse a model-supplied ISO due time.
 *
 * Requirements, each of which rejects a real failure mode:
 *  - a full ISO-8601 instant WITH an offset or Z, because a bare local time has
 *    no unambiguous meaning and would be silently read as UTC;
 *  - strictly in the future, with a small lead, because "in 3 seconds" is not a
 *    reminder and a past time fires immediately;
 *  - inside a one-year horizon, because a mistyped year is the most likely way
 *    a reminder is lost forever.
 */
function parseDueAt(raw: string, now: number): number {
  const value = raw.trim();

  // An offset (or Z) is required: without one, the string is not an instant.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    throw new ToolError(
      "invalid_input",
      "The time must include a timezone, e.g. 2026-10-20T09:30:00+03:30.",
    );
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ToolError("invalid_input", "The time could not be read.");
  }

  if (parsed - now < MIN_LEAD_MS) {
    throw new ToolError("invalid_input", "The time must be in the future.");
  }
  if (parsed - now > MAX_HORIZON_MS) {
    throw new ToolError("invalid_input", "The time cannot be more than one year ahead.");
  }

  return parsed;
}

function parseRepeat(raw: string | undefined): ReminderRepeat {
  if (raw === undefined) return "none";
  const value = raw.trim().toLowerCase();
  if (!REPEATS.includes(value as ReminderRepeat)) {
    throw new ToolError("invalid_input", "Invalid repeat value.");
  }
  return value as ReminderRepeat;
}

// ---------- remind_at ----------

export interface RemindAtInput {
  text: string;
  /** Absolute instant, ISO-8601 with an offset. Mutually exclusive with `when`. */
  dueAt?: string;
  /**
   * Natural Persian time phrase («فردا ساعت ۹»), parsed in Asia/Tehran.
   * Mutually exclusive with `dueAt`.
   */
  when?: string;
  repeat?: string;
  /**
   * True → a follow-up: resurfaces until the owner closes it
   * (cancel_reminder), delivered to the owner's DM. Never repeats on a
   * schedule.
   */
  followUp?: boolean;
}

export interface RemindAtOutput {
  id: number;
  dueAt: string;
  repeat: ReminderRepeat;
  followUp: boolean;
  /** How long until it fires, in minutes, for the model to confirm. */
  inMinutes: number;
}

export const remindAtManifest: ToolManifest = defineManifest({
  id: "remind_at",
  version: "2.0.0",
  title: "Remind At",
  description:
    "Set a reminder or follow-up. The time is either an exact ISO instant (dueAt) or a natural Persian phrase (when). With followUp it resurfaces until closed instead of firing once.",
  purpose: "reminder/follow-up",
  useWhen: "remind asked",
  doNotUseWhen:
    "recurring cron work or running actions on a schedule — that is schedule_task; a dated life event (birthday) — that is note_event",
  confusableWith: [
    { tool: "schedule_task", difference: "schedule_task runs cron actions; remind_at delivers one message, or nags as a follow-up until closed" },
    { tool: "note_event", difference: "note_event tracks a calendar date yearly/monthly; remind_at fires at one specific instant" },
  ],
  latencyTier: "instant",
  outputSummary: "The reminder's id, due time, repeat setting, follow-up flag and minutes until it fires.",
  category: "schedule",
  triggers: {
    keywordPatterns: [
      "یادم بنداز",
      "یادآوری کن",
      "یاداوری کن",
      "پیگیری کن",
      "دنبال کن",
      "remind me",
      "set a reminder",
      "follow up",
    ],
  },
  costTier: "free",
});

export function createRemindAtTool(deps: ReminderToolDeps): Tool<RemindAtInput, RemindAtOutput> {
  return {
    name: "remind_at",
    manifest: remindAtManifest,
    description:
      "Set a reminder at a specific time: give dueAt (ISO-8601 with timezone) or when (a Persian time phrase like tomorrow at 9 AM). With followUp=true it becomes a follow-up that resurfaces until you close it.",
    enabled: true,
    permission: { requires: [REMIND_AT_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: {
      fields: {
        text: {
          type: "string",
          required: true,
          description: "The text to be reminded of.",
          minLength: 1,
          maxLength: MAX_TEXT_LENGTH,
        },
        dueAt: {
          type: "string",
          description: "Exact time, e.g. 2026-10-20T09:30:00+03:30. Use either this or when, not both.",
          minLength: 10,
          maxLength: 40,
        },
        when: {
          type: "string",
          description:
            "Persian time phrase, e.g. tomorrow at 9 AM, in 10 minutes, next Monday at 10. Use either this or dueAt, not both.",
          minLength: 1,
          maxLength: 120,
        },
        repeat: {
          type: "enum",
          description: "Repeat: none, daily or weekly. Not available for follow-ups.",
          choices: [...REPEATS],
        },
        followUp: {
          type: "boolean",
          description:
            "Make it a follow-up: it resurfaces until closed with cancel_reminder, and is delivered to your DM.",
        },
      },
    },

    async run(input: RemindAtInput, ctx: ToolContext): Promise<RemindAtOutput> {
      const userId = ownerOf(ctx);
      const followUp = input.followUp === true;
      const repeat = parseRepeat(input.repeat);
      if (followUp && repeat !== "none") {
        throw new ToolError(
          "invalid_input",
          "A follow-up cannot repeat on a schedule; it resurfaces until you close it.",
        );
      }

      // The destination is the conversation the run came from, supplied by
      // server code — the model never names a chat id. A follow-up is the
      // exception: it always goes to the owner's own DM, never a group.
      const chatId = followUp ? userId : deliveryChat(ctx);

      const text = input.text.trim();
      if (text.length === 0) {
        throw new ToolError("invalid_input", "Reminder text is empty.");
      }

      const nowMs = ctx.clock().getTime();
      const dueAt = resolveDueInstant(input, nowMs);

      if (deps.storage.scheduling.countPendingReminders(userId) >= MAX_PENDING_PER_USER) {
        throw new ToolError(
          "invalid_input",
          "Too many active reminders; cancel some first.",
        );
      }

      let id: number;
      try {
        id = deps.storage.scheduling.createReminder({
          userId,
          chatId,
          text,
          dueAt,
          repeat,
          followup: followUp,
        });
      } catch {
        // Storage internals (SQL text, paths) never reach the model.
        throw new ToolError("internal", "Could not save the reminder.");
      }

      return {
        id,
        dueAt: new Date(dueAt).toISOString(),
        repeat,
        followUp,
        inMinutes: Math.round((dueAt - nowMs) / 60_000),
      };
    },
  };
}

// ---------- list_reminders ----------

export interface ListRemindersInput {
  // No fields: the store is the scheduler's queue, so a fired one-shot
  // reminder is not retained as history. The input spec is fields:{}, and
  // the validator rejects unknown fields — this interface mirrors that.
  // (A follow-up stays listed until closed: it remains pending.)
}

export interface ListRemindersOutput {
  reminders: Array<{
    id: number;
    text: string;
    dueAt: string;
    repeat: ReminderRepeat;
    followUp: boolean;
    /** Snooze override in force, ISO; null when not snoozed. */
    snoozedUntil: string | null;
  }>;
  count: number;
}

export const listRemindersManifest: ToolManifest = defineManifest({
  id: "list_reminders",
  version: "2.0.0",
  title: "List Reminders",
  description: "List the user's active (pending) reminders and open follow-ups.",
  purpose: "pending reminders",
  useWhen: "reminders asked",
  doNotUseWhen:
    "fired one-shot reminders are not kept, so past ones cannot be listed; scheduled cron tasks — that is list_tasks",
  confusableWith: [
    { tool: "list_tasks", difference: "list_tasks shows cron jobs, not plain reminders or follow-ups" },
    { tool: "list_events", difference: "list_events shows dated life events; this shows timed reminders and follow-ups" },
  ],
  latencyTier: "instant",
  outputSummary: "The user's pending reminders and follow-ups with ids, text, due times and snooze state.",
  category: "schedule",
  triggers: {
    keywordPatterns: [
      "یادآورهام رو نشون بده",
      "چه یادآور",
      "پیگیریهام",
      "list (my )?reminders",
      "show (my )?reminders",
      "list (my )?(nudges|follow.?ups)",
    ],
  },
  costTier: "free",
});

export function createListRemindersTool(
  deps: ReminderToolDeps,
): Tool<ListRemindersInput, ListRemindersOutput> {
  return {
    name: "list_reminders",
    manifest: listRemindersManifest,
    description: "List the user's active (pending) reminders and open follow-ups.",
    enabled: true,
    permission: { requires: [LIST_REMINDERS_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: {
      fields: {},
    },

    async run(_input: ListRemindersInput, ctx: ToolContext): Promise<ListRemindersOutput> {
      const userId = ownerOf(ctx);
      const rows = deps.storage.scheduling.listReminders(userId, MAX_PENDING_PER_USER);

      return {
        reminders: rows.map((r) => ({
          id: r.id,
          text: r.text,
          dueAt: new Date(r.snoozedUntil ?? r.dueAt).toISOString(),
          repeat: r.repeat,
          followUp: r.followup,
          snoozedUntil:
            r.snoozedUntil === undefined ? null : new Date(r.snoozedUntil).toISOString(),
        })),
        count: rows.length,
      };
    },
  };
}

// ---------- cancel_reminder ----------

export interface CancelReminderInput {
  id: number;
}

export interface CancelReminderOutput {
  id: number;
  /** False when there was no pending reminder with that id for this user. */
  cancelled: boolean;
  remaining: number;
}

export const cancelReminderManifest: ToolManifest = defineManifest({
  id: "cancel_reminder",
  version: "2.0.0",
  title: "Cancel Reminder",
  description: "Cancel a reminder by its id; for a follow-up this is how it is closed (done).",
  purpose: "cancel reminder",
  useWhen: "cancel asked",
  doNotUseWhen:
    "id unknown — list_reminders first; only postponing it — that is snooze_reminder",
  confusableWith: [
    { tool: "snooze_reminder", difference: "snooze only moves the due time; cancel removes the reminder or closes the follow-up for good" },
    { tool: "cancel_task", difference: "cancel_task deletes a cron task; this cancels a plain reminder or follow-up" },
  ],
  latencyTier: "instant",
  outputSummary: "Whether the reminder was cancelled and how many remain.",
  category: "schedule",
  triggers: {
    keywordPatterns: [
      "یادآور.*(لغو|کنسل|حذف)",
      "cancel (the|my) reminder",
    ],
  },
  costTier: "free",
});

export function createCancelReminderTool(
  deps: ReminderToolDeps,
): Tool<CancelReminderInput, CancelReminderOutput> {
  return {
    name: "cancel_reminder",
    manifest: cancelReminderManifest,
    description: "Cancel a reminder by its id. For a follow-up, this closes it (done).",
    enabled: true,
    permission: { requires: [CANCEL_REMINDER_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "Reminder id, from the reminder list.",
          minimum: 1,
        },
      },
    },

    async run(input: CancelReminderInput, ctx: ToolContext): Promise<CancelReminderOutput> {
      const userId = ownerOf(ctx);
      // Scoped to the owner by the storage layer, so an id belonging to another
      // user cannot be cancelled here even if the model guesses it.
      const cancelled = deps.storage.scheduling.cancelReminder(userId, input.id);
      return {
        id: input.id,
        cancelled,
        remaining: deps.storage.scheduling.countPendingReminders(userId),
      };
    },
  };
}

// ---------- snooze_reminder ----------

export interface SnoozeReminderInput {
  id: number;
  /** New due time: a Persian phrase («فردا ساعت ۹») or ISO-8601 with offset. */
  until: string;
}

export interface SnoozeReminderOutput {
  id: number;
  /** False when there was no pending reminder with that id for this user. */
  snoozed: boolean;
  snoozedUntil: string | null;
}

export const snoozeReminderManifest: ToolManifest = defineManifest({
  id: "snooze_reminder",
  version: "1.0.0",
  title: "Snooze Reminder",
  description: "Postpone a reminder or follow-up to a later time (a Persian phrase or an ISO instant).",
  purpose: "postpone reminder",
  useWhen: "delay asked",
  doNotUseWhen:
    "the reminder is finished — that is cancel_reminder; creating a new reminder — that is remind_at",
  confusableWith: [
    { tool: "cancel_reminder", difference: "cancel removes it for good; snooze only moves its due time" },
    { tool: "remind_at", difference: "remind_at creates a reminder; snooze moves an existing one" },
  ],
  latencyTier: "instant",
  outputSummary: "Whether it was snoozed, the reminder id, and the new due time.",
  category: "schedule",
  costTier: "free",
});

export function createSnoozeReminderTool(
  deps: ReminderToolDeps,
): Tool<SnoozeReminderInput, SnoozeReminderOutput> {
  return {
    name: "snooze_reminder",
    manifest: snoozeReminderManifest,
    description: "Postpone a reminder or follow-up to another time.",
    enabled: true,
    permission: { requires: [SNOOZE_REMINDER_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "Reminder id, from the reminder list.",
          minimum: 1,
        },
        until: {
          type: "string",
          required: true,
          description: "New time: a Persian phrase or ISO with a timezone.",
          minLength: 1,
          maxLength: 120,
        },
      },
    },

    async run(input: SnoozeReminderInput, ctx: ToolContext): Promise<SnoozeReminderOutput> {
      const userId = ownerOf(ctx);
      const nowMs = ctx.clock().getTime();
      // The snooze target resolves exactly like a reminder's `when`.
      const untilMs = resolveDueInstant({ when: input.until }, nowMs);
      const snoozed = deps.storage.scheduling.snoozeReminder(userId, input.id, untilMs, nowMs);
      return {
        id: input.id,
        snoozed,
        snoozedUntil: snoozed ? new Date(untilMs).toISOString() : null,
      };
    },
  };
}

/** Build all reminder tools (the unified Phase-8 family). */
export function createReminderTools(deps: ReminderToolDeps): readonly Tool<unknown, unknown>[] {
  return [
    createRemindAtTool(deps),
    createListRemindersTool(deps),
    createCancelReminderTool(deps),
    createSnoozeReminderTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}

export interface ReminderToolDeps {
  storage: Storage;
}

// ---------- helpers ----------

/**
 * The delivery chat for this call, taken from the server-supplied
 * conversation — the model never names a chat id.
 */
function deliveryChat(ctx: ToolContext): string {
  const chatId = ctx.conversationId;
  if (chatId === undefined || chatId.length === 0) {
    throw new ToolError("not_allowed", "Reminder destination is unknown.");
  }
  return chatId;
}

/**
 * The owner id for this call, taken from the server-supplied actor.
 *
 * An unidentified actor is refused rather than sharing one reminder queue.
 */
function ownerOf(ctx: ToolContext): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown; reminders are unavailable.");
  }
  return id;
}
