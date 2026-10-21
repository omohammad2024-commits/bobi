/**
 * Persian relative-time parser (Stage-3 differentiator: smart follow-ups).
 *
 * There was no existing Persian natural-language date parser in the codebase
 * (the model resolves "فردا" itself via the date_time tool and the prompt's
 * current-time block). The follow-up extractor (extract.ts) takes natural
 * Persian `when` values like «فردا ساعت ۹», so it needs a deterministic
 * server-side parser here — the model's math is not trusted for scheduling.
 *
 * This is deliberately rule-based, not model-based: it is testable,
 * deterministic, and cannot hallucinate a different instant than the one the
 * user wrote. A model-based extractor is documented as a future upgrade in
 * docs/phase-nudges.md.
 *
 * Supported, after digit/whitespace normalization:
 *  - day offsets: امروز (0), فردا (1), پس‌فردا (2), هفته‌ی بعد/آینده (7),
 *    ماه بعد/آینده (30), «N روز/هفته/ماه دیگه|بعد», weekday names
 *    (شنبه..جمعه → next occurrence).
 *  - times: «ساعت N» / «ساعت N:M», with Persian digit words (یک..دوازده)
 *    and optional صبح/عصر/شب hints. Bare «ساعت ۹» means 09:00.
 *  - no time given → 09:00 on the resolved day.
 *
 * All instants are resolved in the given IANA timezone (default Asia/Tehran).
 * Returns null when nothing recognizable is present, so callers can fall back
 * (e.g. to ISO parsing) or reject the input.
 */

/** Default zone for nudge times: the owner's zone. */
export const DEFAULT_NUDGE_TIMEZONE = "Asia/Tehran";

/** One-year horizon, mirroring the reminder tool's ceiling. */
const MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/** Default time of day when the user names a day but no hour. */
const DEFAULT_HOUR = 9;

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Persian/Arabic-Indic digits → ASCII, ي/ك → ی/ک, collapse whitespace. */
export function normalizeFa(s: string): string {
  let out = "";
  for (const ch of s) {
    const fa = FA_DIGITS.indexOf(ch);
    if (fa >= 0) {
      out += String(fa);
      continue;
    }
    const ar = AR_DIGITS.indexOf(ch);
    if (ar >= 0) {
      out += String(ar);
      continue;
    }
    if (ch === "ي") out += "ی";
    else if (ch === "ك") out += "ک";
    else out += ch;
  }
  return out.replace(/[\u200c\u200f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Persian number words 1..12, for «ساعت نه». */
const WORD_NUMBERS: Readonly<Record<string, number>> = {
  "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6,
  "هفت": 7, "هشت": 8, "نه": 9, "ده": 10, "یازده": 11, "دوازده": 12,
};

/** Weekday name → JS getDay (0=Sunday). شنبه is Saturday=6. */
const WEEKDAYS: Readonly<Record<string, number>> = {
  "شنبه": 6, "یکشنبه": 0, "دوشنبه": 1, "سه شنبه": 2,
  "چهارشنبه": 3, "پنجشنبه": 4, "جمعه": 5,
};

interface ParsedTime {
  hour: number;
  minute: number;
}

function parseTime(s: string): ParsedTime | null {
  // «ساعت ۹» / «ساعت ۹:۳۰»
  let m = /ساعت\s+(\d{1,2})(?::(\d{1,2}))?/.exec(s);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    // عصر/شب shifts a morning hour to the afternoon; صبح is a no-op.
    if (hour < 12 && /(عصر|بعد ?از ?ظهر|شب)/.test(s)) hour += 12;
    return { hour, minute };
  }
  // «ساعت نه» — digit words.
  m = /ساعت\s+([^\s]+)/.exec(s);
  if (m) {
    const word = m[1]!.replace(/[،.؟!]/g, "");
    const n = WORD_NUMBERS[word];
    if (n === undefined) return null;
    let hour = n;
    if (/(عصر|بعد ?از ?ظهر|شب)/.test(s)) hour += 12;
    return { hour, minute: 0 };
  }
  return null;
}

function parseDayOffset(s: string, nowMs: number, timeZone: string): number | null {
  if (/پس ?فردا/.test(s)) return 2;
  if (/فردا/.test(s)) return 1;
  if (/امروز/.test(s)) return 0;
  // «هفته‌ی بعد» normalizes to «هفته ی بعد» (ZWNJ → space), hence the ی?.
  if (/هفته ?ی? ?(بعد|آینده)/.test(s)) return 7;
  if (/ماه ?ی? ?(بعد|آینده)/.test(s)) return 30;
  const rel = /(\d+)\s*(روز|هفته|ماه)\s*(دیگه|دیگر|بعد|آینده)/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const days = unit === "هفته" ? n * 7 : unit === "ماه" ? n * 30 : n;
    return days;
  }
  // Next occurrence of a named weekday, strictly in the future.
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (s.includes(name)) {
      const today = zonedParts(nowMs, timeZone).weekday;
      let delta = (dow - today + 7) % 7;
      if (delta === 0) delta = 7; // «جمعه» on a Friday means next Friday.
      return delta;
    }
  }
  return null;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=Sunday..6=Saturday
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
  const parts = dtf.formatToParts(new Date(ms));
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    weekday: wd[pick("weekday") as keyof typeof wd] ?? 0,
  };
}

/** Offset of the zone at an instant, ms to add to UTC to get local time. */
function tzOffsetMs(timeZone: string, ms: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(ms));
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";
  const asUtc = Date.UTC(
    Number(pick("year")),
    Number(pick("month")) - 1,
    Number(pick("day")),
    Number(pick("hour")) % 24,
    Number(pick("minute")),
    Number(pick("second")),
  );
  return asUtc - ms;
}

/** Convert a wall-clock time in the zone to an epoch instant. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // One refinement pass is enough: offsets only change by ≤1h at DST edges,
  // and Iran has no DST.
  return guess - tzOffsetMs(timeZone, guess);
}

/**
 * Parse a Persian relative time into an epoch instant, or null.
 *
 * Requires at least a day expression or a time expression; pure noise returns
 * null. The result is always strictly after `nowMs` — a time today that has
 * already passed rolls to the next day — and inside the one-year horizon.
 */
export function parsePersianWhen(
  raw: string,
  nowMs: number,
  timeZone: string = DEFAULT_NUDGE_TIMEZONE,
): number | null {
  const s = normalizeFa(raw);
  if (s.length === 0) return null;

  const dayOffset = parseDayOffset(s, nowMs, timeZone);
  const time = parseTime(s);
  if (dayOffset === null && time === null) return null;

  const parts = zonedParts(nowMs, timeZone);
  // «امروز» with no hour at 15:30 resolves to 09:00 today — already past, so
  // it rolls to tomorrow 09:00 rather than being born overdue.
  const effectiveDayOffset =
    dayOffset === 0 && time === null
      ? 1
      : (dayOffset ?? 0);
  let target = zonedTimeToUtc(
    parts.year,
    parts.month,
    parts.day + effectiveDayOffset,
    time?.hour ?? DEFAULT_HOUR,
    time?.minute ?? 0,
    timeZone,
  );

  // A bare «ساعت ۹» naming a time that already passed today means tomorrow —
  // otherwise the nudge would be born overdue and fire on the next sweep.
  if (dayOffset === null && target <= nowMs) {
    target = zonedTimeToUtc(
      parts.year,
      parts.month,
      parts.day + 1,
      time?.hour ?? DEFAULT_HOUR,
      time?.minute ?? 0,
      timeZone,
    );
  }

  if (target <= nowMs) return null;
  if (target - nowMs > MAX_HORIZON_MS) return null;
  return target;
}

/**
 * Parse a `when` value that may be Persian natural language OR an ISO-8601
 * instant with an offset. Persian is tried first; ISO keeps the reminder
 * tool's contract (offset required, future, ≤1 year).
 */
export function parseDueInstant(
  raw: string,
  nowMs: number,
  timeZone: string = DEFAULT_NUDGE_TIMEZONE,
): number | null {
  const fa = parsePersianWhen(raw, nowMs, timeZone);
  if (fa !== null) return fa;

  const value = raw.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= nowMs) return null;
  if (parsed - nowMs > MAX_HORIZON_MS) return null;
  return parsed;
}
