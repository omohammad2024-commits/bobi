/**
 * Cron parser and nextAfter.
 *
 * The behaviours that matter are the ones a sloppy parser gets wrong:
 *  - strict rejection of malformed input (no silent misreads)
 *  - names, lists, ranges, steps, and the shorthands
 *  - day-of-month OR day-of-week semantics
 *  - wall-time interpretation in the target timezone, including DST gaps
 *  - strictly-after semantics on exact boundaries
 */
import { describe, expect, test } from "bun:test";
import {
  CronError,
  isValidCron,
  nextAfter,
  nextAfterSchedule,
  parseCron,
} from "../src/scheduler/cron";

const iso = (ms: number): string => new Date(ms).toISOString();

/** Sunday 2026-10-18T12:00:00Z. */
const SUN = Date.parse("2026-10-18T12:00:00Z");

describe("parseCron validation", () => {
  test("parses a full expression", () => {
    const s = parseCron("*/15 9-17 * * MON-FRI");
    expect(s.minutes).toEqual([0, 15, 30, 45]);
    expect(s.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(s.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(s.dowRestricted).toBe(true);
    expect(s.domRestricted).toBe(false);
  });

  test("names are case-insensitive", () => {
    expect(parseCron("0 0 * JAN mon").months).toEqual([1]);
    expect(parseCron("0 0 * jan MON").daysOfWeek).toEqual([1]);
    expect(parseCron("0 0 * DEC SUN").months).toEqual([12]);
  });

  test("day-of-week 7 is Sunday", () => {
    expect(parseCron("0 0 * * 7").daysOfWeek).toEqual([0]);
  });

  test("shorthands expand", () => {
    expect(parseCron("@hourly").source).toBe("0 * * * *");
    expect(parseCron("@daily").source).toBe("0 0 * * *");
    expect(parseCron("@midnight").source).toBe("0 0 * * *");
    expect(parseCron("@weekly").source).toBe("0 0 * * 0");
    expect(parseCron("@monthly").source).toBe("0 0 1 * *");
    expect(parseCron("@DAILY").source).toBe("0 0 * * *");
  });

  test("lists and ranged steps", () => {
    expect(parseCron("1,15,30 * * * *").minutes).toEqual([1, 15, 30]);
    expect(parseCron("10-30/10 * * * *").minutes).toEqual([10, 20, 30]);
    expect(parseCron("5-5 * * * *").minutes).toEqual([5]);
  });

  test("isValidCron agrees with parseCron", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("@daily")).toBe(true);
    expect(isValidCron("nope")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });

  const bad = [
    "", // empty
    "* * * *", // four fields
    "* * * * * *", // six fields
    "61 * * * *", // minute out of range
    "* 24 * * *", // hour out of range
    "* * 0 * *", // day-of-month out of range
    "* * * 13 *", // month out of range
    "*/0 * * * *", // zero step
    "5-1 * * * *", // reversed range
    "1,,2 * * * *", // empty list item
    "1- * * * *", // dangling dash
    "-5 * * * *", // leading dash
    "5/15 * * * *", // bare step without * or range
    "1.5 * * * *", // decimal
    "MON-F * * * *", // unknown name
    "* * FOO * *", // unknown name in dom
    "@reboot", // unsupported shorthand
    "@yearly", // not one of the supported four
    "* * * * * # comment", // trailing garbage
  ];
  for (const expr of bad) {
    test(`rejects ${JSON.stringify(expr)}`, () => {
      expect(() => parseCron(expr)).toThrow(CronError);
      expect(isValidCron(expr)).toBe(false);
    });
  }

  test("rejects an unknown timezone in nextAfter", () => {
    expect(() => nextAfter("0 9 * * *", SUN, "Mars/Olympus")).toThrow(CronError);
  });

  test("throws for a schedule that can never occur (February 30th)", () => {
    expect(() =>
      nextAfter("0 0 30 2 *", Date.parse("2026-01-01T00:00:00Z"), "UTC"),
    ).toThrow(CronError);
  });
});

describe("nextAfter", () => {
  test("a daily 09:00 in Tehran", () => {
    // 12:00Z Sunday is 15:30 Tehran; the next 09:00 Tehran is Monday 05:30Z.
    expect(iso(nextAfter("0 9 * * *", SUN, "Asia/Tehran"))).toBe("2026-10-19T05:30:00.000Z");
  });

  test("every minute lands on the next minute", () => {
    expect(iso(nextAfter("* * * * *", SUN, "UTC"))).toBe("2026-10-18T12:01:00.000Z");
  });

  test("strictly after: exactly on the boundary goes to the next occurrence", () => {
    const noon = Date.parse("2026-10-18T12:00:00Z");
    expect(iso(nextAfter("0 12 * * *", noon, "UTC"))).toBe("2026-10-19T12:00:00.000Z");
  });

  test("next Monday at noon", () => {
    expect(iso(nextAfter("0 12 * * MON", SUN, "UTC"))).toBe("2026-10-19T12:00:00.000Z");
  });

  test("day-of-month OR day-of-week when both are restricted", () => {
    // The 19th is a Monday: the weekday side matches even though it is not the 1st.
    expect(iso(nextAfter("0 0 1 * MON", SUN, "UTC"))).toBe("2026-10-19T00:00:00.000Z");
  });

  test("only the restricted side decides when one is a star", () => {
    // dom restricted, dow not: must be the 1st, whatever the weekday.
    expect(iso(nextAfter("0 0 1 * *", SUN, "UTC"))).toBe("2026-11-01T00:00:00.000Z");
  });

  test("February 29th is found across a non-leap gap", () => {
    const from = Date.parse("2026-01-01T00:00:00Z");
    expect(iso(nextAfter("0 0 29 2 *", from, "UTC"))).toBe("2028-02-29T00:00:00.000Z");
  });

  test("the same wall time differs by timezone", () => {
    const tehran = nextAfter("0 9 * * *", SUN, "Asia/Tehran");
    const utc = nextAfter("0 9 * * *", SUN, "UTC");
    // 09:00 Tehran is 05:30Z; 09:00 UTC is 09:00Z — 3.5h apart.
    expect(tehran - utc).toBe(-3.5 * 60 * 60 * 1_000);
  });

  test("a DST spring-forward gap is skipped", () => {
    // New York springs forward on 2026-03-08: 02:30 does not exist that day.
    const from = Date.parse("2026-03-07T12:00:00-05:00");
    // Next valid 02:30 is March 9, now on EDT (UTC-4).
    expect(iso(nextAfter("30 2 * * *", from, "America/New_York"))).toBe(
      "2026-03-09T06:30:00.000Z",
    );
  });

  test("shorthand @daily fires at midnight in the given zone", () => {
    // 12:00Z is 15:30 Tehran; next Tehran midnight is 20:30Z.
    expect(iso(nextAfter("@daily", SUN, "Asia/Tehran"))).toBe("2026-10-18T20:30:00.000Z");
  });

  test("nextAfterSchedule matches nextAfter for a parsed schedule", () => {
    const schedule = parseCron("30 8 * * 1-5");
    expect(nextAfterSchedule(schedule, SUN, "UTC")).toBe(nextAfter("30 8 * * 1-5", SUN, "UTC"));
  });

  test("defaults to Asia/Tehran when no zone is given", () => {
    expect(nextAfter("0 9 * * *", SUN)).toBe(nextAfter("0 9 * * *", SUN, "Asia/Tehran"));
  });
});
