/**
 * read_calendar — ONE unified day-by-day agenda for the actor.
 *
 * The three things that make up a user's schedule already live in three
 * separate stores, each with its own list tool: pending reminders
 * (list_reminders), scheduled cron tasks (list_tasks) and noted life
 * events (list_events, curator). Answering "what's my week look like?"
 * used to mean the model stitching three unrelated lists together and
 * doing the day math itself. This tool does that stitching once,
 * deterministically: it reads the ACTOR's own rows from each source,
 * keeps the ones whose instant falls in [from, to), and groups them by
 * calendar day with the day's Jalali date attached.
 *
 * Per-actor by construction: every read is scoped to ctx.actor.userId
 * by the storage layer itself (reminders/tasks are keyed by owner, and
 * events live in the actor's own memory rows via EventStore over the
 * SQLite memory provider) — there is no input field that could name
 * another user, and the tool is deliberately NOT ownerOnly: any actor
 * may read their own agenda, and only their own.
 *
 * Days are Asia/Tehran calendar days: reminders are parsed in Tehran,
 * events occur at Tehran day-start, and Jalali labels come from the
 * existing Intl-based helpers (jalali_calendar.ts) — no new calendar
 * math lives here.
 *
 * Defensive reads: each source is gathered inside its own try/catch.
 * If a source's read path is unavailable for this storage shape, that
 * source is skipped silently rather than failing the whole agenda.
 */
import { ToolError } from "./errors";
import type { Storage } from "../storage/storage";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import { TEHRAN_TZ } from "./persian_datetime";
import { formatJalaliFa, jalaliPartsOf, jalaliToGregorianMs } from "./jalali_calendar";
import { EventStore, nextOccurrence } from "../memory/events";
import { SqliteMemoryProvider } from "../memory/sqlite_provider";

export const READ_CALENDAR_PERMISSION = "tools:read_calendar";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling on any agenda window, however it was requested. */
const MAX_RANGE_DAYS = 62;
const DEFAULT_DAYS = 7;
/** Read caps per source — far above the per-user creation caps. */
const MAX_ROWS = 200;
/** Bound on occurrence expansion for one recurring event. */
const MAX_OCCURRENCES_PER_EVENT = 70;

// ---------- input / output ----------

export interface ReadCalendarInput {
  /**
   * Range start: an ISO date ("2026-10-21") or datetime. The agenda
   * starts at the beginning of that Tehran calendar day. Defaults to
   * today (the clock's current Tehran day).
   */
  from?: string;
  /** Days to cover, 1–31. Default 7. Ignored when `to` is given. */
  days?: number;
  /**
   * Exclusive range end: an ISO date (that Tehran day's start) or a
   * datetime instant. When given, overrides `days`.
   */
  to?: string;
}

export type CalendarItemKind = "reminder" | "task" | "event";

export interface CalendarItem {
  kind: CalendarItemKind;
  title: string;
  /** ISO instant the item happens at. */
  at: string;
  /** Jalali date of the item's day, e.g. «۲۹ مهر ۱۴۰۵». */
  jalali: string;
  detail?: string;
}

export interface CalendarDay {
  /** Gregorian date of the day in Asia/Tehran, "YYYY-MM-DD". */
  date: string;
  /** Jalali date of the day, e.g. «۲۹ مهر ۱۴۰۵». */
  jalali: string;
  items: CalendarItem[];
}

export interface ReadCalendarOutput {
  /** ISO instant the (inclusive) range starts at. */
  from: string;
  /** ISO instant the (exclusive) range ends at. */
  to: string;
  /** Only days that have at least one item, soonest first. */
  days: CalendarDay[];
  totalItems: number;
}

// ---------- manifest ----------

export const readCalendarManifest: ToolManifest = defineManifest({
  id: "read_calendar",
  version: "1.0.0",
  title: "Read Calendar",
  description:
    "Read the user's unified agenda day by day over a date range: pending reminders, scheduled tasks' next runs and noted life events (birthdays, anniversaries, monthly commitments), grouped by day with Jalali dates.",
  purpose: "unified day-by-day agenda",
  useWhen: "agenda/what's scheduled asked",
  doNotUseWhen:
    "creating a reminder, task or event — use remind_at, schedule_task or note_event; date conversion alone — date_time",
  confusableWith: [
    { tool: "list_reminders", difference: "list_reminders shows only reminders; this is the unified day view across reminders, tasks and events" },
    { tool: "list_tasks", difference: "list_tasks shows only scheduled tasks; this is the unified day view across reminders, tasks and events" },
    { tool: "date_time", difference: "date_time computes/converts dates; this reads what's actually scheduled" },
  ],
  latencyTier: "instant",
  outputSummary: "Days in range with their Jalali date and the reminders, task runs and events on each, plus the total item count.",
  category: "schedule",
  triggers: {
    keywordPatterns: [
      "تقویم",
      "برنامه‌م چیه",
      "برنامه‌ام چیه",
      "برنامم چیه",
      "برنامه امروز",
      "برنامه این هفته",
      "agenda",
      "calendar",
      "what'?s on my (agenda|calendar|schedule)",
      "what do i have (on|coming up)",
    ],
  },
  costTier: "free",
});

// ---------- tool ----------

export function createCalendarTool(deps: { storage: Storage }): Tool<ReadCalendarInput, ReadCalendarOutput> {
  return {
    name: "read_calendar",
    manifest: readCalendarManifest,
    description:
      "Read your unified agenda day by day: reminders, scheduled tasks and noted life events in one view, grouped by day with Jalali dates. Give from (ISO date/datetime, default today) and days (1-31, default 7), or an explicit to (exclusive) instead of days.",
    enabled: true,
    permission: { requires: [READ_CALENDAR_PERMISSION] },
    // NOT ownerOnly: strictly the actor's own agenda — every source is
    // read scoped to the actor's id, so there is nothing to escalate to.
    toolset: "schedule",
    input: {
      fields: {
        from: {
          type: "string",
          description: "Range start: ISO date or datetime. Defaults to today.",
          minLength: 4,
          maxLength: 64,
        },
        days: {
          type: "integer",
          description: "How many days to cover, 1-31 (default 7). Ignored when to is given.",
          minimum: 1,
          maximum: 31,
        },
        to: {
          type: "string",
          description: "Exclusive range end: ISO date or datetime. Overrides days.",
          minLength: 4,
          maxLength: 64,
        },
      },
    },

    async run(input: ReadCalendarInput, ctx: ToolContext): Promise<ReadCalendarOutput> {
      const userId = actorOf(ctx);
      const nowMs = ctx.clock().getTime();

      const fromMs = resolveFrom(input.from, nowMs);
      const toMs = resolveTo(input, fromMs);
      if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) {
        throw new ToolError(
          "invalid_input",
          `The range cannot span more than ${MAX_RANGE_DAYS} days.`,
        );
      }

      const items: Array<{ atMs: number; item: CalendarItem }> = [];
      gatherReminders(deps.storage, userId, fromMs, toMs, items);
      gatherTasks(deps.storage, userId, fromMs, toMs, items);
      await gatherEvents(deps.storage, userId, fromMs, toMs, items);

      // Group by Tehran calendar day, soonest first; items within a day
      // by instant, with a stable kind/title tiebreak.
      const byDay = new Map<string, CalendarDay>();
      items.sort(
        (a, b) =>
          a.atMs - b.atMs ||
          a.item.kind.localeCompare(b.item.kind) ||
          a.item.title.localeCompare(b.item.title),
      );
      for (const { atMs, item } of items) {
        const date = tehranDateString(atMs);
        let day = byDay.get(date);
        if (day === undefined) {
          day = { date, jalali: item.jalali, items: [] };
          byDay.set(date, day);
        }
        day.items.push(item);
      }
      const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

      return {
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        days,
        totalItems: items.length,
      };
    },
  };
}

// ---------- range resolution ----------

/**
 * Resolve `from` to the start (epoch ms) of its Tehran calendar day.
 * Undefined → the clock's current Tehran day.
 */
function resolveFrom(raw: string | undefined, nowMs: number): number {
  if (raw === undefined) return startOfTehranDay(nowMs);
  return startOfTehranDay(parseInstant(raw, "from"));
}

/**
 * Resolve the exclusive range end. `to` wins over `days`: a date-only
 * `to` means that Tehran day's start (so the named day is NOT covered);
 * a datetime `to` is the exact instant. Without `to`, the end is the
 * start of the day `days` after the range's first day.
 */
function resolveTo(input: ReadCalendarInput, fromMs: number): number {
  if (input.to !== undefined) {
    const raw = input.to;
    const toMs = isDateOnly(raw) ? startOfTehranDay(parseInstant(raw, "to")) : parseInstant(raw, "to");
    if (toMs <= fromMs) {
      throw new ToolError("invalid_input", "The range end must be after its start.");
    }
    return toMs;
  }
  const days = input.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 31) {
    throw new ToolError("invalid_input", "days must be an integer between 1 and 31.");
  }
  return dayStartAfter(fromMs, days);
}

/** Parse an ISO date/datetime, rejecting anything unreadable. */
function parseInstant(raw: string, field: "from" | "to"): number {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ToolError("invalid_input", `The ${field} date could not be read.`);
  }
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) {
    throw new ToolError("invalid_input", `The ${field} date could not be read.`);
  }
  return ms;
}

function isDateOnly(raw: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
}

// ---------- Tehran day helpers (built on jalali_calendar) ----------

/**
 * Epoch ms of 00:00 Asia/Tehran on the Tehran calendar day containing
 * `ms`, via the existing Jalali round-trip helpers.
 */
function startOfTehranDay(ms: number): number {
  const p = jalaliPartsOf(ms, TEHRAN_TZ);
  const start = jalaliToGregorianMs(p.jy, p.jm, p.jd, TEHRAN_TZ);
  // The round-trip cannot fail for a date Intl itself just reported;
  // fall back to the instant rather than ever throwing from a helper.
  return start ?? ms;
}

/** Start of the Tehran day `n` days after the Tehran day starting at `dayStartMs`. */
function dayStartAfter(dayStartMs: number, n: number): number {
  // Noon of the target day is safely inside it (Tehran has no DST), so
  // its day start is exact via the same round-trip.
  return startOfTehranDay(dayStartMs + n * DAY_MS + 12 * 60 * 60 * 1000);
}

const tehranDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TEHRAN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Gregorian "YYYY-MM-DD" of the instant in Asia/Tehran. */
function tehranDateString(ms: number): string {
  return tehranDateFmt.format(new Date(ms));
}

function jalaliOf(ms: number): string {
  return formatJalaliFa(jalaliPartsOf(ms, TEHRAN_TZ));
}

// ---------- sources (each defensive: a broken/absent read path skips) ----------

function gatherReminders(
  storage: Storage,
  userId: string,
  fromMs: number,
  toMs: number,
  out: Array<{ atMs: number; item: CalendarItem }>,
): void {
  try {
    const list = storage.scheduling?.listReminders;
    if (typeof list !== "function") return;
    const rows = list.call(storage.scheduling, userId, MAX_ROWS);
    for (const r of rows) {
      // Effective due time: a snooze override wins, like list_reminders.
      const atMs = r.snoozedUntil ?? r.dueAt;
      if (atMs < fromMs || atMs >= toMs) continue;
      const detail =
        r.followup === true
          ? "follow-up"
          : r.repeat !== "none"
            ? `repeats ${r.repeat}`
            : undefined;
      out.push({
        atMs,
        item: {
          kind: "reminder",
          title: r.text,
          at: new Date(atMs).toISOString(),
          jalali: jalaliOf(atMs),
          ...(detail !== undefined ? { detail } : {}),
        },
      });
    }
  } catch {
    // Source unavailable for this storage shape — skip it, never fail
    // the whole agenda over one source.
    return;
  }
}

function gatherTasks(
  storage: Storage,
  userId: string,
  fromMs: number,
  toMs: number,
  out: Array<{ atMs: number; item: CalendarItem }>,
): void {
  try {
    const list = storage.scheduling?.listTasks;
    if (typeof list !== "function") return;
    const rows = list.call(storage.scheduling, userId, MAX_ROWS);
    for (const t of rows) {
      // A disabled task will not run; its stored nextRunAtMs is stale,
      // not a real future instant, so it does not belong on an agenda.
      if (!t.enabled) continue;
      const atMs = t.nextRunAtMs;
      if (!Number.isFinite(atMs) || atMs < fromMs || atMs >= toMs) continue;
      out.push({
        atMs,
        item: {
          kind: "task",
          title: t.name,
          at: new Date(atMs).toISOString(),
          jalali: jalaliOf(atMs),
          detail: `cron ${t.cronExpr}`,
        },
      });
    }
  } catch {
    return;
  }
}

async function gatherEvents(
  storage: Storage,
  userId: string,
  fromMs: number,
  toMs: number,
  out: Array<{ atMs: number; item: CalendarItem }>,
): Promise<void> {
  try {
    // Events live in the actor's own memory rows (EventStore is the
    // read path list_events uses); the SQLite provider scopes every
    // read to userId, so another user's events cannot appear here.
    const store = new EventStore(new SqliteMemoryProvider(storage));
    const rows = await store.list(userId);
    for (const { event } of rows) {
      // Expand occurrences inside the window: an annual/monthly event
      // can occur more than once in a long range.
      let cursor = fromMs;
      for (let i = 0; i < MAX_OCCURRENCES_PER_EVENT; i++) {
        const occ = nextOccurrence(event, cursor);
        if (occ === undefined || occ.occursAtMs >= toMs) break;
        if (occ.occursAtMs >= fromMs) {
          const atMs = occ.occursAtMs;
          out.push({
            atMs,
            item: {
              kind: "event",
              title: event.name,
              at: new Date(atMs).toISOString(),
              jalali: jalaliOf(atMs),
              ...(event.note !== undefined ? { detail: event.note } : {}),
            },
          });
        }
        cursor = occ.occursAtMs + DAY_MS;
      }
    }
  } catch {
    return;
  }
}

// ---------- helpers ----------

/**
 * The actor id for this call, taken from the server-supplied actor.
 * An unidentified actor is refused rather than sharing one agenda.
 * (Same guard as the reminder tools — the agenda is strictly personal.)
 */
function actorOf(ctx: ToolContext): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown; the calendar is unavailable.");
  }
  return id;
}
