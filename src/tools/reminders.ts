/**
 * Reminder tools — remind_at, remind_nl, list_reminders, cancel_reminder.
 *
 * The due time comes from a MODEL, which makes it untrusted in a specific way:
 * an ISO string can be in the past, absurdly far in the future, or malformed.
 * Every one of those is validated here before a row is written, because a
 * reminder scheduled in the past fires immediately and one scheduled in 2150 is
 * a silent hole in the database.
 *
 * Chat delivery targets the conversation the request came from, which the
 * caller supplies — the model does not get to name a chat id.
 */
import { ToolError } from "./errors";
import type { Storage } from "../storage/storage";
import type { ReminderRepeat } from "../storage/storage";
import type { Tool, ToolContext } from "./types";
import { TEHRAN_TZ, parsePersianDateTime } from "./persian_datetime";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const REMIND_AT_PERMISSION = "tools:remind_at";
export const REMIND_NL_PERMISSION = "tools:remind_nl";
export const LIST_REMINDERS_PERMISSION = "tools:list_reminders";
export const CANCEL_REMINDER_PERMISSION = "tools:cancel_reminder";

/** Ceilings, so one user cannot fill the table or schedule a decade ahead. */
const MAX_PENDING_PER_USER = 25;
const MIN_LEAD_MS = 5_000;
const MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_TEXT_LENGTH = 500;

const REPEATS: readonly ReminderRepeat[] = ["none", "daily", "weekly"];

export interface ReminderToolDeps {
  storage: Storage;
}

// ---------- remind_at ----------

export interface RemindAtInput {
  text: string;
  /** Absolute instant, ISO-8601 with an offset. */
  dueAt: string;
  repeat?: string;
}

export interface RemindAtOutput {
  id: number;
  dueAt: string;
  repeat: ReminderRepeat;
  /** How long until it fires, in minutes, for the model to confirm. */
  inMinutes: number;
}

export const remindAtManifest: ToolManifest = defineManifest({
  id: "remind_at",
  version: "1.0.0",
  title: "Remind At",
  description:
    "Set a reminder at a specific time. The time must be ISO-8601 with a timezone and in the future.",
  purpose: "reminder at ISO time",
  useWhen: "ISO time known",
  doNotUseWhen:
    "time given as natural Persian words — that is remind_nl; a follow-up that repeats until closed — that is note_followup",
  confusableWith: [
    { tool: "remind_nl", difference: "remind_nl parses a Persian phrase; remind_at needs an exact ISO instant" },
    { tool: "note_followup", difference: "follow-ups resurface until closed; remind_at fires once and retires" },
    { tool: "schedule_task", difference: "schedule_task runs cron actions; remind_at delivers one message once" },
  ],
  latencyTier: "instant",
  outputSummary: "The reminder's id, due time, repeat setting and minutes until it fires.",
  category: "schedule",
  costTier: "free",
});

export function createRemindAtTool(deps: ReminderToolDeps): Tool<RemindAtInput, RemindAtOutput> {
  return {
    name: "remind_at",
    manifest: remindAtManifest,
    description:
      "Set a reminder at a specific time. The time must be ISO-8601 with a timezone and in the future.",
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
          required: true,
          description: "Exact time, e.g. 2026-10-20T09:30:00+03:30.",
          minLength: 10,
          maxLength: 40,
        },
        repeat: {
          type: "enum",
          description: "Repeat: none, daily or weekly.",
          choices: [...REPEATS],
        },
      },
    },

    async run(input: RemindAtInput, ctx: ToolContext): Promise<RemindAtOutput> {
      const userId = ownerOf(ctx);
      // The destination is the conversation the run came from, supplied by
      // server code — the model never names a chat id.
      const chatId = ctx.conversationId;
      if (chatId === undefined || chatId.length === 0) {
        throw new ToolError("not_allowed", "Reminder destination is unknown.");
      }

      const text = input.text.trim();
      if (text.length === 0) {
        throw new ToolError("invalid_input", "Reminder text is empty.");
      }

      const repeat = parseRepeat(input.repeat);
      const dueAt = parseDueAt(input.dueAt, ctx.clock().getTime());

      if (deps.storage.countPendingReminders(userId) >= MAX_PENDING_PER_USER) {
        throw new ToolError(
          "invalid_input",
          "Too many active reminders; cancel some first.",
        );
      }

      const id = deps.storage.createReminder({ userId, chatId, text, dueAt, repeat });

      return {
        id,
        dueAt: new Date(dueAt).toISOString(),
        repeat,
        inMinutes: Math.round((dueAt - ctx.clock().getTime()) / 60_000),
      };
    },
  };
}

/**
 * Parse a model-supplied due time.
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

// ---------- remind_nl ----------

export interface RemindNlInput {
  text: string;
  /** Persian natural-language time expression, e.g. tomorrow at 9 AM. */
  when: string;
}

/** Same confirmation shape as remind_at; a natural-language reminder never repeats. */
export type RemindNlOutput = RemindAtOutput;

export const remindNlManifest: ToolManifest = defineManifest({
  id: "remind_nl",
  version: "1.0.0",
  title: "Remind (Natural Language)",
  description:
    "Set a reminder from a Persian natural-language time expression, like tomorrow at 9 in the morning or in 10 minutes. Times are read in Asia/Tehran.",
  purpose: "reminder in Persian",
  useWhen: "time in Persian",
  doNotUseWhen:
    "exact ISO instant already computed — that is remind_at; recurring cron work — that is schedule_task",
  confusableWith: [
    { tool: "remind_at", difference: "remind_at takes ISO with offset; remind_nl parses Persian, never repeats" },
    { tool: "note_followup", difference: "follow-ups repeat until closed; remind_nl fires once" },
  ],
  latencyTier: "instant",
  outputSummary: "The reminder's id, due time, repeat setting and minutes until it fires.",
  category: "schedule",
  triggers: {
    keywordPatterns: [
      "یادم بنداز",
      "یادآوری کن",
      "یاداوری کن",
      "remind me",
      "set a reminder",
    ],
  },
  costTier: "free",
});

export function createRemindNlTool(deps: ReminderToolDeps): Tool<RemindNlInput, RemindNlOutput> {
  return {
    name: "remind_nl",
    manifest: remindNlManifest,
    description:
      "Set a reminder from a Persian natural-language time expression, like tomorrow at 9 in the morning or in 10 minutes. Times are read in Asia/Tehran.",
    enabled: true,
    permission: { requires: [REMIND_NL_PERMISSION] },
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
        when: {
          type: "string",
          required: true,
          description:
            "Persian time expression, e.g. tomorrow at 9 AM, in 10 minutes, next Monday at 10.",
          minLength: 1,
          maxLength: 120,
        },
      },
    },

    async run(input: RemindNlInput, ctx: ToolContext): Promise<RemindNlOutput> {
      const userId = ownerOf(ctx);
      // The destination is the conversation the run came from, supplied by
      // server code — the model never names a chat id.
      const chatId = deliveryChat(ctx);

      const text = cleanText(input.text);

      // The expression is model-supplied Persian, so it can be anything: an
      // unparseable expression is refused before anything is written.
      const parsed = parsePersianDateTime(input.when, ctx.clock(), TEHRAN_TZ);
      if (parsed === null) {
        throw new ToolError(
          "invalid_input",
          "The time expression was not understood. Try a form like tomorrow at 9 AM or in 10 minutes.",
        );
      }

      // The same instant validation as remind_at: strictly in the future,
      // inside the one-year horizon, and carrying an explicit zone
      // (toISOString is Zulu).
      const dueAt = parseDueAt(parsed.toISOString(), ctx.clock().getTime());

      return insertReminder(deps, {
        userId,
        chatId,
        text,
        dueAt,
        repeat: "none",
        nowMs: ctx.clock().getTime(),
      });
    },
  };
}

// ---------- list_reminders ----------

export interface ListRemindersInput {
  // No fields: the store is the scheduler's queue, so a fired reminder is not
  // retained as history. The input spec is fields:{}, and the validator
  // rejects unknown fields — this interface mirrors that.
}

export interface ListRemindersOutput {
  reminders: Array<{
    id: number;
    text: string;
    dueAt: string;
    repeat: ReminderRepeat;
  }>;
  count: number;
}

export const listRemindersManifest: ToolManifest = defineManifest({
  id: "list_reminders",
  version: "1.0.0",
  title: "List Reminders",
  description: "List the user's active (pending) reminders.",
  purpose: "pending reminders",
  useWhen: "reminders asked",
  doNotUseWhen:
    "open follow-ups — that is list_nudges; fired reminders are not kept, so past ones cannot be listed",
  confusableWith: [
    { tool: "list_nudges", difference: "list_nudges shows follow-ups; this shows one-shot pending reminders" },
    { tool: "list_tasks", difference: "list_tasks shows cron jobs, not plain reminders" },
  ],
  latencyTier: "instant",
  outputSummary: "The user's pending reminders with ids, text and due times.",
  category: "schedule",
  triggers: {
    keywordPatterns: [
      "یادآورهام رو نشون بده",
      "چه یادآور",
      "list (my )?reminders",
      "show (my )?reminders",
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
    description: "List the user's active (pending) reminders.",
    enabled: true,
    permission: { requires: [LIST_REMINDERS_PERMISSION] },
    // Two-tier access: owner-only (withheld from public actors by the
    // authorization bridge; the model is never told it exists).
    ownerOnly: true,
    toolset: "schedule",
    input: {
      // No `includeFired` field: the store is the scheduler's queue, so a fired
      // reminder is not retained as history. Offering the option would tell the
      // model it can retrieve something that does not exist.
      fields: {},
    },

    async run(_input: ListRemindersInput, ctx: ToolContext): Promise<ListRemindersOutput> {
      const userId = ownerOf(ctx);
      const rows = deps.storage.listReminders(userId, MAX_PENDING_PER_USER);

      return {
        reminders: rows.map((r) => ({
          id: r.id,
          text: r.text,
          dueAt: new Date(r.dueAt).toISOString(),
          repeat: r.repeat,
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
  version: "1.0.0",
  title: "Cancel Reminder",
  description: "Cancel a reminder by its id.",
  purpose: "cancel reminder",
  useWhen: "cancel asked",
  doNotUseWhen:
    "id unknown — list_reminders first; closing a follow-up — that is ack_nudge",
  confusableWith: [
    { tool: "ack_nudge", difference: "ack_nudge closes a follow-up; this cancels a one-shot reminder" },
    { tool: "cancel_task", difference: "cancel_task deletes a cron task; this cancels a plain reminder" },
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
    description: "Cancel a reminder by its id.",
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
      const cancelled = deps.storage.cancelReminder(userId, input.id);
      return {
        id: input.id,
        cancelled,
        remaining: deps.storage.countPendingReminders(userId),
      };
    },
  };
}

/** Build all reminder tools. */
export function createReminderTools(deps: ReminderToolDeps): readonly Tool<unknown, unknown>[] {
  return [
    createRemindAtTool(deps),
    createRemindNlTool(deps),
    createListRemindersTool(deps),
    createCancelReminderTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
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

/** Trimmed reminder text, refused when empty. */
function cleanText(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) {
    throw new ToolError("invalid_input", "Reminder text is empty.");
  }
  return text;
}

/**
 * Shared tail of the reminder-creation tools: the pending-count ceiling, the
 * row write, and the confirmation shape. The due instant is already
 * validated by the caller.
 */
function insertReminder(
  deps: ReminderToolDeps,
  args: {
    userId: string;
    chatId: string;
    text: string;
    dueAt: number;
    repeat: ReminderRepeat;
    nowMs: number;
  },
): RemindAtOutput {
  if (deps.storage.countPendingReminders(args.userId) >= MAX_PENDING_PER_USER) {
    throw new ToolError(
      "invalid_input",
      "Too many active reminders; cancel some first.",
    );
  }

  const id = deps.storage.createReminder({
    userId: args.userId,
    chatId: args.chatId,
    text: args.text,
    dueAt: args.dueAt,
    repeat: args.repeat,
  });

  return {
    id,
    dueAt: new Date(args.dueAt).toISOString(),
    repeat: args.repeat,
    inMinutes: Math.round((args.dueAt - args.nowMs) / 60_000),
  };
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

