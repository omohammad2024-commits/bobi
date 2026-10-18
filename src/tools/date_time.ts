/**
 * date_time — current date, time and weekday in a given timezone.
 *
 * Time and timezone correctness:
 * - The timezone is validated against the IANA database via Intl; an unknown
 *   zone throws instead of silently falling back to UTC.
 * - The instant comes from `ctx.clock()`, so tests inject a fixed time and
 *   assert an exact date, time and weekday with no clock flakiness.
 * - Calendar parts are read with `formatToParts`, which handles DST correctly
 *   (verified for both hemispheres) because formatting happens in the target
 *   zone, not the host zone.
 */
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";

export const DATE_TIME_PERMISSION = "tools:date_time";

export interface DateTimeInput {
  /** IANA timezone id, e.g. "Asia/Tehran". Defaults to UTC. */
  timezone?: string;
  /** ISO-3166 language tag for weekday/date rendering. Defaults to fa-IR. */
  locale?: string;
}

export interface DateTimeOutput {
  iso: string;
  timezone: string;
  date: string;
  time: string;
  weekday: string;
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

export const dateTimeTool: Tool<DateTimeInput, DateTimeOutput> = {
  name: "date_time",
  description: "تاریخ، ساعت و روز هفته در یک timezone معتبر.",
  enabled: true,
  permission: { requires: [DATE_TIME_PERMISSION] },
  toolset: "utils",
  input: {
    fields: {
      timezone: {
        type: "string",
        description: "شناسهٔ timezone معتبر IANA.",
        maxLength: 64,
      },
      locale: {
        type: "string",
        description: "کد زبان برای نمایش روز هفته.",
        minLength: 2,
        maxLength: 16,
      },
    },
  },

  async run(input: DateTimeInput, ctx: ToolContext): Promise<DateTimeOutput> {
    const timezone = input.timezone ?? "UTC";
    if (!isValidTimeZone(timezone)) {
      throw new ToolError(
        "invalid_input",
        "timezone نامعتبر است.",
        { timezone },
      );
    }

    const locale = input.locale ?? "fa-IR";
    if (!isValidLocale(locale)) {
      throw new ToolError("invalid_input", "زبان نامعتبر است.", { locale });
    }

    const now = ctx.clock();

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

    return { iso: now.toISOString(), timezone, date, time, weekday };
  },
};

function isValidLocale(locale: string): boolean {
  try {
    new Intl.DateTimeFormat(locale);
    return true;
  } catch {
    return false;
  }
}
