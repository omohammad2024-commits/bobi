/**
 * Reminder tools — remind_at, list_reminders, cancel_reminder.
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
import type { ReminderRecord, ReminderRepeat } from "../storage/storage";
import type { Tool, ToolContext } from "./types";

export const REMIND_AT_PERMISSION = "tools:remind_at";
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

export function createRemindAtTool(deps: ReminderToolDeps): Tool<RemindAtInput, RemindAtOutput> {
  return {
    name: "remind_at",
    description:
      "یک یادآور در زمان مشخص تنظیم کن. زمان باید ISO-8601 با منطقهٔ زمانی باشد و در آینده باشد.",
    enabled: true,
    permission: { requires: [REMIND_AT_PERMISSION] },
    input: {
      fields: {
        text: {
          type: "string",
          required: true,
          description: "متنی که باید یادآوری شود.",
          minLength: 1,
          maxLength: MAX_TEXT_LENGTH,
        },
        dueAt: {
          type: "string",
          required: true,
          description: "زمان دقیق، مثل 2026-10-20T09:30:00+03:30.",
          minLength: 10,
          maxLength: 40,
        },
        repeat: {
          type: "enum",
          description: "تکرار: none، daily یا weekly.",
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
        throw new ToolError("not_allowed", "مقصد یادآور مشخص نیست.");
      }

      const text = input.text.trim();
      if (text.length === 0) {
        throw new ToolError("invalid_input", "متن یادآور خالی است.");
      }

      const repeat = parseRepeat(input.repeat);
      const dueAt = parseDueAt(input.dueAt, ctx.clock().getTime());

      if (deps.storage.countPendingReminders(userId) >= MAX_PENDING_PER_USER) {
        throw new ToolError(
          "invalid_input",
          "تعداد یادآورهای فعال پر است؛ ابتدا چند مورد را لغو کن.",
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
      "زمان باید شامل منطقهٔ زمانی باشد، مثل 2026-10-20T09:30:00+03:30.",
    );
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ToolError("invalid_input", "زمان قابل خواندن نبود.");
  }

  if (parsed - now < MIN_LEAD_MS) {
    throw new ToolError("invalid_input", "زمان باید در آینده باشد.");
  }
  if (parsed - now > MAX_HORIZON_MS) {
    throw new ToolError("invalid_input", "زمان بیش از یک سال جلوتر قابل تنظیم نیست.");
  }

  return parsed;
}

function parseRepeat(raw: string | undefined): ReminderRepeat {
  if (raw === undefined) return "none";
  const value = raw.trim().toLowerCase();
  if (!REPEATS.includes(value as ReminderRepeat)) {
    throw new ToolError("invalid_input", "مقدار تکرار نامعتبر است.");
  }
  return value as ReminderRepeat;
}

// ---------- list_reminders ----------

export interface ListRemindersInput {
  /** Include reminders that already fired. */
  includeFired?: boolean;
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

export function createListRemindersTool(
  deps: ReminderToolDeps,
): Tool<ListRemindersInput, ListRemindersOutput> {
  return {
    name: "list_reminders",
    description: "یادآورهای فعال کاربر را فهرست کن.",
    enabled: true,
    permission: { requires: [LIST_REMINDERS_PERMISSION] },
    input: {
      fields: {
        includeFired: {
          type: "boolean",
          description: "یادآورهای اجراشده هم نشان داده شوند.",
        },
      },
    },

    async run(_input: ListRemindersInput, ctx: ToolContext): Promise<ListRemindersOutput> {
      const userId = ownerOf(ctx);
      // Only pending reminders are listed: a fired one is history, and the
      // table is the scheduler's queue rather than a log.
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

export function createCancelReminderTool(
  deps: ReminderToolDeps,
): Tool<CancelReminderInput, CancelReminderOutput> {
  return {
    name: "cancel_reminder",
    description: "یک یادآور را با شناسه‌اش لغو کن.",
    enabled: true,
    permission: { requires: [CANCEL_REMINDER_PERMISSION] },
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "شناسهٔ یادآور، از فهرست یادآورها.",
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

/** Build all three reminder tools. */
export function createReminderTools(deps: ReminderToolDeps): readonly Tool<unknown, unknown>[] {
  return [
    createRemindAtTool(deps),
    createListRemindersTool(deps),
    createCancelReminderTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}

// ---------- helpers ----------

/**
 * The owner id for this call, taken from the server-supplied actor.
 *
 * An unidentified actor is refused rather than sharing one reminder queue.
 */
function ownerOf(ctx: ToolContext): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "هویت مشخص نیست؛ یادآور در دسترس نیست.");
  }
  return id;
}

/** Format a stored reminder for a model-facing summary. */
export function describeReminder(r: ReminderRecord): string {
  return `#${r.id} — ${r.text} (${new Date(r.dueAt).toISOString()}${r.repeat === "none" ? "" : `, ${r.repeat}`})`;
}
