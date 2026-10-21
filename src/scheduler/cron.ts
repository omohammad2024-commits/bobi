/**
 * Cron expressions for scheduled tasks.
 *
 * A strict, dependency-free 5-field parser (minute hour day-of-month month
 * day-of-week) plus `nextAfter`, which finds the first matching instant after
 * a given time in a given IANA timezone.
 *
 * Strictness is deliberate: a cron expression comes from the owner or the
 * model, and a silently misread schedule ("0 0 30 2 *" quietly never firing)
 * is worse than a loud rejection. Anything ambiguous or out of range throws
 * CronError.
 *
 * Semantics follow the de-facto Vixie/ISC cron standard:
 *  - when BOTH day-of-month and day-of-week are restricted (not "*"), a day
 *    matches when EITHER matches;
 *  - when only one is restricted, that one decides;
 *  - day-of-week 0 and 7 are both Sunday.
 */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

/** A parsed, validated schedule. All arrays are sorted ascending, deduplicated. */
export interface CronSchedule {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  /** 0 = Sunday .. 6 = Saturday. */
  daysOfWeek: number[];
  /** True when the field was written as something other than "*". */
  domRestricted: boolean;
  dowRestricted: boolean;
  /** The normalized 5-field expression this was parsed from. */
  source: string;
}

/** Default zone when the caller does not name one. Mirrors config's fallback. */
export const DEFAULT_CRON_TIMEZONE = "Asia/Tehran";

const SHORTHANDS: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  /** Name table, or undefined when the field takes numbers only. */
  names?: Readonly<Record<string, number>>;
  /** Map a parsed number (e.g. dow 7 -> 0). */
  normalize?: (n: number) => number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day of week", min: 0, max: 7, names: DOW_NAMES, normalize: (n) => (n === 7 ? 0 : n) },
];

/**
 * Parse a cron expression into a validated schedule. Throws CronError on
 * anything invalid. Accepts the @hourly/@daily/@weekly/@monthly shorthands
 * (and @midnight as an alias of @daily); any other @-token is rejected.
 */
export function parseCron(expr: string): CronSchedule {
  const trimmed = expr.trim();
  if (trimmed.length === 0) throw new CronError("cron expression is empty");

  let source = trimmed;
  if (trimmed.startsWith("@")) {
    const expanded = SHORTHANDS[trimmed.toLowerCase()];
    if (expanded === undefined) {
      throw new CronError(`unsupported shorthand "${trimmed}"`);
    }
    source = expanded;
  }

  const parts = source.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `cron needs exactly 5 fields (minute hour day month weekday), got ${parts.length}`,
    );
  }

  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((p, i) =>
    parseField(p!, FIELDS[i]!),
  );

  return {
    minutes: minutes!,
    hours: hours!,
    daysOfMonth: daysOfMonth!,
    months: months!,
    daysOfWeek: daysOfWeek!,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
    source,
  };
}

/** True when the string parses without throwing. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first instant strictly after `fromMs` that matches the expression,
 * interpreted in `tz`.
 *
 * The search walks the calendar in the target zone (not the epoch timeline),
 * so a daily 09:00 stays at 09:00 wall time across DST transitions. A wall
 * time that does not exist (spring-forward gap) is skipped; on a fall-back
 * overlap the earlier occurrence wins.
 *
 * Throws CronError for an invalid expression, an unknown timezone, or a
 * schedule that can never occur (e.g. February 30th).
 */
export function nextAfter(expr: string, fromMs: number, tz: string = DEFAULT_CRON_TIMEZONE): number {
  assertTimezone(tz);
  const schedule = parseCron(expr);
  return nextAfterSchedule(schedule, fromMs, tz);
}

/** Same as nextAfter, for a schedule that is already parsed. */
export function nextAfterSchedule(schedule: CronSchedule, fromMs: number, tz: string): number {
  assertTimezone(tz);
  if (!Number.isFinite(fromMs)) throw new CronError("fromMs must be a finite timestamp");

  const start = zonedParts(tz, fromMs);
  const minuteSet = schedule.minutes;
  const hourSet = schedule.hours;

  // A schedule like "0 0 29 2 *" needs up to ~4 years to hit; 5 years of days
  // covers it with margin. Pure integer calendar math per day, so this loop is
  // cheap even at the bound.
  const MAX_DAYS = 366 * 5 + 31;
  const startDayMs = Date.UTC(start.year, start.month - 1, start.day);

  for (let dayOffset = 0; dayOffset <= MAX_DAYS; dayOffset++) {
    const day = new Date(startDayMs + dayOffset * 86_400_000);
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();

    if (!schedule.months.includes(mo)) continue;

    const domMatch = schedule.daysOfMonth.includes(d);
    const dowMatch = schedule.daysOfWeek.includes(day.getUTCDay());
    // Vixie semantics: when both are restricted, either may match.
    const dayMatches =
      schedule.domRestricted && schedule.dowRestricted
        ? domMatch || dowMatch
        : schedule.domRestricted
          ? domMatch
          : schedule.dowRestricted
            ? dowMatch
            : true;
    if (!dayMatches) continue;

    const hourFloor = dayOffset === 0 ? start.hour : -1;
    for (const h of hourSet) {
      if (h < hourFloor) continue;
      const minuteFloor = dayOffset === 0 && h === start.hour ? start.minute : -1;
      for (const mi of minuteSet) {
        // Strictly after fromMs: the current minute is excluded outright.
        if (mi <= minuteFloor) continue;
        const instant = zonedToUtcMs(y, mo, d, h, mi, tz);
        // null = the wall time does not exist (DST gap); skip it.
        if (instant === null) continue;
        if (instant > fromMs) return instant;
      }
    }
  }

  throw new CronError(`no occurrence of "${schedule.source}" within 5 years`);
}

// ---------- field parsing ----------

function parseField(raw: string, spec: FieldSpec): number[] {
  if (raw.length === 0) throw new CronError(`${spec.name}: empty field`);
  const values = new Set<number>();
  for (const item of raw.split(",")) {
    if (item.length === 0) throw new CronError(`${spec.name}: empty list item in "${raw}"`);
    for (const v of parseItem(item, spec, raw)) values.add(v);
  }
  if (values.size === 0) throw new CronError(`${spec.name}: no values in "${raw}"`);
  return [...values].sort((a, b) => a - b);
}

function parseItem(item: string, spec: FieldSpec, raw: string): number[] {
  const fail = (why: string): never => {
    throw new CronError(`${spec.name}: ${why} in "${raw}"`);
  };

  // base[/step]
  const slash = item.indexOf("/");
  let base = item;
  let step = 1;
  if (slash !== -1) {
    base = item.slice(0, slash);
    const stepRaw = item.slice(slash + 1);
    if (!/^\d+$/.test(stepRaw)) fail(`bad step "${stepRaw}"`);
    step = Number(stepRaw);
    if (step < 1) fail(`step must be >= 1`);
  }

  let lo: number;
  let hi: number;
  if (base === "*") {
    lo = spec.min;
    hi = spec.max;
  } else if (base.includes("-")) {
    const dash = base.indexOf("-");
    // Reject "-5", "5-", "1-2-3".
    if (dash === 0 || dash === base.length - 1 || base.indexOf("-", dash + 1) !== -1) {
      fail(`bad range "${base}"`);
    }
    lo = parseValue(base.slice(0, dash), spec, raw);
    hi = parseValue(base.slice(dash + 1), spec, raw);
    if (lo > hi) fail(`reversed range "${base}"`);
  } else {
    // A bare step ("5/15") is rejected: classic cron only steps "*" or a
    // range, and guessing the intent of "5/15" is how schedules go wrong.
    if (slash !== -1) fail(`step needs "*" or a range, got "${base}"`);
    const v = parseValue(base, spec, raw);
    return [v];
  }

  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

function parseValue(token: string, spec: FieldSpec, raw: string): number {
  const fail = (): never => {
    throw new CronError(`${spec.name}: bad value "${token}" in "${raw}"`);
  };
  let n: number;
  if (/^\d+$/.test(token)) {
    n = Number(token);
  } else if (/^[a-zA-Z]+$/.test(token) && spec.names !== undefined) {
    const named = spec.names[token.toLowerCase()];
    if (named === undefined) fail();
    n = named!;
  } else {
    fail();
  }
  if (n! < spec.min || n! > spec.max) {
    throw new CronError(
      `${spec.name}: ${token} out of range ${spec.min}-${spec.max} in "${raw}"`,
    );
  }
  return spec.normalize !== undefined ? spec.normalize(n!) : n!;
}

// ---------- timezone math ----------

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Cached formatters: one per zone, since construction is the expensive part. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

function assertTimezone(tz: string): void {
  try {
    formatterFor(tz);
  } catch {
    throw new CronError(`unknown timezone "${tz}"`);
  }
}

/** Wall-clock fields of an instant in the given zone. */
function zonedParts(tz: string, instantMs: number): ZonedParts {
  const parts = formatterFor(tz).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new CronError(`timezone "${tz}" did not yield ${type}`);
    return Number(p.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** (wall fields as UTC) - instant = the zone's UTC offset at that instant, ms. */
function offsetMs(tz: string, instantMs: number): number {
  const p = zonedParts(tz, instantMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs;
}

/**
 * Wall time -> instant, in ms. Returns null when the wall time does not exist
 * (a DST spring-forward gap), so the caller can skip it.
 */
function zonedToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number | null {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Fixed-point iteration on the offset: converges in 1-2 passes except right
  // at a transition, where the verification below settles it.
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const next = asUtc - offsetMs(tz, guess);
    if (next === guess) break;
    guess = next;
  }
  // Confirm the wall time really exists: in a gap the parts come back shifted
  // (02:30 -> 03:30), which must not be mistaken for the requested time.
  const check = zonedParts(tz, guess);
  if (
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute
  ) {
    return null;
  }
  return guess;
}

// ------------------------------------------------- shared slot helpers -----
//
// Moved here in platform Phase 10: the bench scheduler (Mini App) and the
// digest scheduling service both validate owner-supplied crons and compute
// the next slot after "now" — one implementation, in the scheduler domain
// that already owns parseCron/nextAfterSchedule.

const MAX_CUSTOM_CRON_LEN = 64;

/** The next firing slot of `cron` strictly after the current instant. */
export function nextSlotAfterNow(cron: string, tz: string = DEFAULT_CRON_TIMEZONE): number {
  return nextAfterSchedule(parseCron(cron), Date.now(), tz);
}

export type CronValidation =
  | { ok: true; source: string }
  | { ok: false; reason: "invalid" | "too_frequent" };

/**
 * Validate an owner-supplied custom cron: it must parse, and its first
 * three firings must respect a minimum gap (so a surface can refuse a
 * schedule that would fire more often than its domain allows).
 */
export function validateCustomCron(
  raw: unknown,
  minGapMs: number,
  tz: string = DEFAULT_CRON_TIMEZONE,
): CronValidation {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const expr = raw.trim();
  if (expr.length === 0 || expr.length > MAX_CUSTOM_CRON_LEN) {
    return { ok: false, reason: "invalid" };
  }
  let source: string;
  let schedule: CronSchedule;
  try {
    schedule = parseCron(expr);
    source = schedule.source;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  try {
    let from = Date.now();
    let prev: number | undefined;
    for (let i = 0; i < 3; i++) {
      const next = nextAfterSchedule(schedule, from, tz);
      if (prev !== undefined && next - prev < minGapMs) {
        return { ok: false, reason: "too_frequent" };
      }
      prev = next;
      from = next;
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, source };
}
