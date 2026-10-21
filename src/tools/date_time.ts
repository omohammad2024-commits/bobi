/**
 * date_time — date, time and weekday in a given timezone, in both the
 * Gregorian and Jalali (Persian) calendars, for "now", for an arbitrary
 * instant (`date`), and with an optional difference to another instant
 * (`compareTo`).
 *
 * Time and timezone correctness:
 * - The timezone is validated against the IANA database via Intl; an unknown
 *   zone throws instead of silently falling back to UTC.
 * - The default instant comes from `ctx.clock()`, so tests inject a fixed
 *   time and assert an exact date, time and weekday with no clock flakiness.
 * - Calendar parts are read with `formatToParts`, which handles DST correctly
 *   (verified for both hemispheres) because formatting happens in the target
 *   zone, not the host zone.
 * - Jalali parts come from ./jalali_calendar (Intl Persian calendar — no
 *   hand-rolled calendar math), always alongside the Gregorian parts.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import { formatJalaliFa, jalaliPartsOf } from "./jalali_calendar";

export const DATE_TIME_PERMISSION = "tools:date_time";

export interface DateTimeInput {
  /** IANA timezone id, e.g. "Asia/Tehran". Defaults to UTC. */
  timezone?: string;
  /** ISO-3166 language tag for weekday/date rendering. Defaults to fa-IR. */
  locale?: string;
  /**
   * Instant to report: an ISO-8601 string (with offset) or "now".
   * Defaults to "now" (ctx.clock()).
   */
  date?: string;
  /**
   * Another ISO-8601 instant to compare the reported instant against.
   * When given, the output gains a `difference` block.
   */
  compareTo?: string;
}

export interface JalaliOutput {
  year: number;
  month: number;
  day: number;
  monthName: string;
  weekday: string;
  /** e.g. «۲۸ مهر ۱۴۰۵» — Persian digits + month name. */
  formatted: string;
}

export interface DateDifference {
  /** Absolute difference, milliseconds. */
  milliseconds: number;
  /** Whole days in the absolute breakdown. */
  days: number;
  /** Remaining whole hours after `days` (0–23). */
  hours: number;
  /** Remaining whole minutes after `hours` (0–59). */
  minutes: number;
  /** Remaining whole seconds after `minutes` (0–59). */
  seconds: number;
  /** Reported instant relative to compareTo. */
  direction: "later" | "earlier" | "same";
  /** Short English string, e.g. "3 days, 4 hours later". */
  human: string;
}

export interface DateTimeOutput {
  iso: string;
  timezone: string;
  date: string;
  time: string;
  weekday: string;
  jalali: JalaliOutput;
  difference?: DateDifference;
}

/** Cache of zones already accepted by Intl, so repeat calls stay cheap. */
const knownZones = new Set<string>();

export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0) return false;
  if (knownZones.has(tz)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    knownZones.add(tz);
    return true;
  } catch {
    return false;
  }
}

export const dateTimeManifest: ToolManifest = defineManifest({
  id: "date_time",
  version: "1.1.0",
  title: "Date & Time",
  description: "Date and time in Gregorian + Jalali for now or any given instant in a valid IANA timezone, with optional difference to another instant.",
  purpose: "date/time, Gregorian + Jalali",
  useWhen: "time/date or date diff asked",
  doNotUseWhen: "Scheduling — use remind_at or schedule_task to create reminders; date_time only reports and compares dates.",
  confusableWith: [
    { tool: "remind_at", difference: "remind_at creates a future reminder; date_time only reports and compares dates/times." },
  ],
  latencyTier: "instant",
  outputSummary: "ISO instant, Gregorian + Jalali date, time, weekday, and optional difference.",
  category: "utils",
  triggers: {
    keywordPatterns: [
      "ساعت چنده",
      "الان ساعت چنده",
      "تاریخ امروز",
      "امروز چندمه",
      "امروز چندم مهر",
      "تاریخ شمسی",
      "what(?:'s| is) the time",
      "current time",
      "what day is (it|today)",
    ],
  },
  costTier: "free",
});

export const dateTimeTool: Tool<DateTimeInput, DateTimeOutput> = {
  name: "date_time",
  manifest: dateTimeManifest,
  description: "Date and time in Gregorian + Jalali for now or any given instant in a valid IANA timezone, with optional difference to another instant.",
  enabled: true,
  permission: { requires: [DATE_TIME_PERMISSION] },
  toolset: "utils",
  input: {
    fields: {
      timezone: {
        type: "string",
        description: "A valid IANA timezone id.",
        maxLength: 64,
      },
      locale: {
        type: "string",
        description: "Language tag for rendering the weekday.",
        minLength: 2,
        maxLength: 16,
      },
      date: {
        type: "string",
        description: 'Instant to report: an ISO-8601 string with offset, or "now". Defaults to now.',
        maxLength: 64,
      },
      compareTo: {
        type: "string",
        description: "Another ISO-8601 instant to compare the reported instant against.",
        maxLength: 64,
      },
    },
  },

  async run(input: DateTimeInput, ctx: ToolContext): Promise<DateTimeOutput> {
    const timezone = input.timezone ?? "UTC";
    if (!isValidTimeZone(timezone)) {
      throw new ToolError(
        "invalid_input",
        "Invalid timezone.",
        { timezone },
      );
    }

    const locale = input.locale ?? "fa-IR";
    if (!isValidLocale(locale)) {
      throw new ToolError("invalid_input", "Invalid locale.", { locale });
    }

    const now = resolveInstant(input.date, ctx, "date");

    let compareMs: number | undefined;
    if (input.compareTo !== undefined) {
      compareMs = resolveInstant(input.compareTo, ctx, "compareTo").getTime();
    }

    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((p) => p.type === type)?.value;

    const date = `${pick("year")}-${pick("month")}-${pick("day")}`;
    const time = `${pick("hour")}:${pick("minute")}:${pick("second")}`;
    const weekday = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      weekday: "long",
    }).format(now);

    const jalaliParts = jalaliPartsOf(now.getTime(), timezone);
    const output: DateTimeOutput = {
      iso: now.toISOString(),
      timezone,
      date,
      time,
      weekday,
      jalali: {
        year: jalaliParts.jy,
        month: jalaliParts.jm,
        day: jalaliParts.jd,
        monthName: jalaliParts.monthNameFa,
        weekday: jalaliParts.weekdayFa,
        formatted: formatJalaliFa(jalaliParts),
      },
    };
    if (compareMs !== undefined) {
      output.difference = buildDifference(now.getTime(), compareMs);
    }
    return output;
  },
};

/**
 * Resolve an optional instant input: undefined/"now" → ctx.clock(),
 * otherwise a parsed ISO-8601 string. Anything unparseable (or a
 * non-string the validator let through) is an honest invalid_input.
 */
function resolveInstant(
  value: string | undefined,
  ctx: ToolContext,
  field: string,
): Date {
  if (value === undefined || value === "now") return ctx.clock();
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError("invalid_input", "Invalid date.", { [field]: value });
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ToolError("invalid_input", "Invalid date.", { [field]: value });
  }
  return new Date(ms);
}

/** Absolute breakdown of (instant − compareTo) plus its direction. */
function buildDifference(instantMs: number, compareMs: number): DateDifference {
  const signed = instantMs - compareMs;
  const milliseconds = Math.abs(signed);
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const direction: DateDifference["direction"] =
    signed > 0 ? "later" : signed < 0 ? "earlier" : "same";

  let human: string;
  if (direction === "same") {
    human = "same instant";
  } else {
    const units: Array<[number, string]> = [
      [days, "day"],
      [hours, "hour"],
      [minutes, "minute"],
      [seconds, "second"],
    ];
    const shown = units
      .filter(([n]) => n > 0)
      .slice(0, 2)
      .map(([n, label]) => `${n} ${label}${n === 1 ? "" : "s"}`);
    human = `${shown.length > 0 ? shown.join(", ") : "0 seconds"} ${direction}`;
  }
  return { milliseconds, days, hours, minutes, seconds, direction, human };
}

function isValidLocale(locale: string): boolean {
  try {
    new Intl.DateTimeFormat(locale);
    return true;
  } catch {
    return false;
  }
}
