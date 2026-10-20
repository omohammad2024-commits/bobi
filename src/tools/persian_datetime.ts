/**
 * Persian natural-language date/time parsing for reminders.
 *
 * The user thinks in the Jalali calendar and speaks Persian: «فردا ساعت ۹»,
 * «۱۰ دقیقه دیگه», «دوشنبه ساعت ۱۰», «۱۵ آبان». This module turns those
 * expressions into absolute instants.
 *
 * Design notes:
 * - Relative expressions (فردا، X دقیقه دیگه) need no calendar conversion:
 *   they are offsets from now.
 * - Absolute Jalali dates («۱۵ آبان») are converted scan-style: the next
 *   Tehran calendar day whose Jalali month/day match, read through the Intl
 *   Persian calendar — no hand-rolled Jalali math.
 * - "now" is read in the target timezone (Asia/Tehran by default), so «ساعت
 *   ۹ صبح» means 09:00 Tehran time, and a time that already passed today
 *   rolls to tomorrow.
 *
 * Returns null when the expression cannot be understood; the caller decides
 * how to report that. An invalid `tz` throws RangeError from Intl.
 */

export const TEHRAN_TZ = "Asia/Tehran";

/** Parse a Persian time expression into an absolute instant, or null. */
export function parsePersianDateTime(
  text: string,
  now: Date,
  tz: string = TEHRAN_TZ,
): Date | null {
  if (typeof text !== "string") return null;
  const s = normalize(text);
  if (s.length === 0) return null;
  // Validate the zone up front: Intl throws RangeError on an unknown zone.
  partsFormatter(tz);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;

  // «نیم ساعت دیگه» — the common clipped half-hour.
  if (/نیم\s*ساعت\s*(دیگه|دیگر|بعد)/.test(s)) {
    return new Date(nowMs + 30 * 60_000);
  }

  // «X دقیقه/ساعت/روز/هفته/ماه دیگه»
  const unitAlt = Object.keys(REL_UNITS_MS)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const rel = s.match(new RegExp(`(${NUM_TOKEN})\\s*(${unitAlt})(\\s*ی)?\\s*(دیگه|دیگر|بعد)`));
  if (rel !== null) {
    const amountTok = rel[1];
    const unitTok = rel[2];
    const amount = amountTok === undefined ? null : parseNumToken(amountTok);
    const unitMs = unitTok === undefined ? undefined : REL_UNITS_MS[unitTok];
    if (amount === null || amount <= 0 || unitMs === undefined) return null;
    return new Date(nowMs + amount * unitMs);
  }

  // «هفته‌ی دیگه» / «ماه دیگه» — a bare unit means one of it.
  if (/هفته(\s*ی)?\s*(دیگه|دیگر)/.test(s)) return new Date(nowMs + 7 * 86_400_000);
  if (/ماه\s*(دیگه|دیگر)/.test(s)) return new Date(nowMs + 30 * 86_400_000);

  const tod = extractTimeOfDay(s);

  // Absolute Jalali date: «۱۵ آبان», «۱۵ آبان ۱۴۰۴».
  const abs = extractJalaliDate(s);
  if (abs !== null) {
    // Without an explicit time a dated reminder defaults to 09:00.
    const time: TimeOfDay = tod ?? { hour: 9, minute: 0, meridiem: undefined };
    const at = nextJalaliOccurrence(tz, nowMs, abs, time);
    return at === null ? null : new Date(at);
  }

  // Day words: «امروز»، «امشب»، «فردا»، «پس‌فردا».
  const daySpec = extractDaySpec(s);
  if (daySpec !== null) {
    if (tod === null) return null;
    // «امشب ساعت ۹» is 21:00: tonight implies evening when no meridiem
    // was named.
    if (daySpec.evening && tod.meridiem === undefined && tod.hour < 12) {
      tod.hour += 12;
    }
    const p = zonedParts(tz, nowMs);
    let at = wallClockToMs(tz, p.year, p.month, p.day + daySpec.offset, tod.hour, tod.minute);
    // A time that already passed today moves to tomorrow.
    if (daySpec.offset === 0 && at <= nowMs) {
      at = wallClockToMs(tz, p.year, p.month, p.day + 1, tod.hour, tod.minute);
    }
    return new Date(at);
  }

  // Weekday: «دوشنبه ساعت ۱۰» — the next such weekday at that time.
  const wd = extractWeekday(s);
  if (wd !== null) {
    if (tod === null) return null;
    const p = zonedParts(tz, nowMs);
    const todayWd = new Date(Date.UTC(p.year, p.month - 1, p.day, 12)).getUTCDay();
    let diff = (wd - todayWd + 7) % 7;
    let at = wallClockToMs(tz, p.year, p.month, p.day + diff, tod.hour, tod.minute);
    if (at <= nowMs) {
      diff += 7;
      at = wallClockToMs(tz, p.year, p.month, p.day + diff, tod.hour, tod.minute);
    }
    return new Date(at);
  }

  // A bare time («ساعت ۹») means today, rolling to tomorrow when passed.
  if (tod !== null) {
    const p = zonedParts(tz, nowMs);
    let at = wallClockToMs(tz, p.year, p.month, p.day, tod.hour, tod.minute);
    if (at <= nowMs) {
      at = wallClockToMs(tz, p.year, p.month, p.day + 1, tod.hour, tod.minute);
    }
    return new Date(at);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function normalizeDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}

/** Digits to Latin, ZWNJ to space, Arabic yeh/kaf to Persian, collapse space. */
function normalize(text: string): string {
  return normalizeDigits(text)
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200b\u200c]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** Persian number words. Kept out of blind replacement: «دو» sits inside «دوشنبه». */
const FA_NUM_WORDS: Readonly<Record<string, number>> = {
  "یک": 1,
  "یه": 1,
  "دو": 2,
  "سه": 3,
  "چهار": 4,
  "پنج": 5,
  "شش": 6,
  "شیش": 6,
  "هفت": 7,
  "هشت": 8,
  "نه": 9,
  "ده": 10,
  "یازده": 11,
  "دوازده": 12,
};

/** Number-word alternation, longest first so «دوازده» wins over «دو». */
const NUM_WORD_ALT = Object.keys(FA_NUM_WORDS)
  .sort((a, b) => b.length - a.length)
  .join("|");

const NUM_TOKEN = `(?:\\d+(?:\\.\\d+)?|${NUM_WORD_ALT})`;

function parseNumToken(token: string): number | null {
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  return FA_NUM_WORDS[token] ?? null;
}

// ---------------------------------------------------------------------------
// Relative durations
// ---------------------------------------------------------------------------

const REL_UNITS_MS: Readonly<Record<string, number>> = {
  "دقیقه": 60_000,
  "دقیق": 60_000,
  "ساعت": 3_600_000,
  "روز": 86_400_000,
  "هفته": 7 * 86_400_000,
  "ماه": 30 * 86_400_000,
};

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

interface TimeOfDay {
  hour: number;
  minute: number;
  /** The meridiem word as written, if any («صبح»، «شب»، …). */
  meridiem: string | undefined;
}

function applyMeridiem(hour: number, meridiem: string | undefined): number {
  switch (meridiem) {
    case "صبح":
      return hour; // «ساعت ۹ صبح» → 09:00
    case "ظهر":
      return 12; // «ساعت ۱۲ ظهر» → 12:00
    case "بعد از ظهر":
    case "بعدازظهر":
    case "عصر":
    case "شب":
      if (hour === 12) return 0; // «ساعت ۱۲ شب» → 00:00
      return hour < 12 ? hour + 12 : hour; // «ساعت ۸ شب» → 20:00
    default:
      return hour;
  }
}

function extractTimeOfDay(s: string): TimeOfDay | null {
  const withSaat = new RegExp(
    `ساعت\\s+(${NUM_TOKEN})(?::(\\d{1,2}))?\\s*(صبح|ظهر|بعد از ظهر|بعدازظهر|عصر|شب)?`,
  );
  const m = s.match(withSaat);
  if (m !== null) {
    const hourTok = m[1];
    if (hourTok === undefined) return null;
    const hourRaw = parseNumToken(hourTok);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    if (hourRaw === null || minute < 0 || minute > 59) return null;
    const hour = applyMeridiem(hourRaw, m[3]);
    if (hour < 0 || hour > 23) return null;
    return { hour, minute, meridiem: m[3] };
  }
  const colon = s.match(/(\d{1,2}):(\d{2})/);
  if (colon !== null) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, meridiem: undefined };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Day words and weekdays
// ---------------------------------------------------------------------------

interface DaySpec {
  offset: number;
  /** True for «امشب»: tonight implies evening when no meridiem is named. */
  evening: boolean;
}

function extractDaySpec(s: string): DaySpec | null {
  // «پس‌فردا» first: after normalization it reads «پس فردا» and contains «فردا».
  if (s.includes("پس فردا") || s.includes("پسفردا")) return { offset: 2, evening: false };
  if (s.includes("فردا")) return { offset: 1, evening: false };
  if (s.includes("امشب")) return { offset: 0, evening: true };
  if (s.includes("امروز")) return { offset: 0, evening: false };
  return null;
}

/** Persian weekday name → JS getUTCDay number (0 = Sunday). */
const FA_WEEKDAYS: Readonly<Record<string, number>> = {
  "شنبه": 6,
  "یکشنبه": 0,
  "دوشنبه": 1,
  "سه شنبه": 2,
  "چهارشنبه": 3,
  "پنجشنبه": 4,
  "جمعه": 5,
};

function extractWeekday(s: string): number | null {
  // Longest first: «پنجشنبه» contains «شنبه», «یکشنبه» contains «شنبه».
  const names = Object.keys(FA_WEEKDAYS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (s.includes(name)) {
      const wd = FA_WEEKDAYS[name];
      if (wd !== undefined) return wd;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Absolute Jalali dates
// ---------------------------------------------------------------------------

const FA_MONTHS: Readonly<Record<string, number>> = {
  "فروردین": 1,
  "اردیبهشت": 2,
  "خرداد": 3,
  "تیر": 4,
  "مرداد": 5,
  "شهریور": 6,
  "مهر": 7,
  "آبان": 8,
  "آذر": 9,
  "دی": 10,
  "بهمن": 11,
  "اسفند": 12,
};

interface JalaliDate {
  jm: number;
  jd: number;
  /** Null when no year was named — the next matching month/day, any year. */
  jy: number | null;
}

function extractJalaliDate(s: string): JalaliDate | null {
  const monthAlt = Object.keys(FA_MONTHS)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const m = s.match(new RegExp(`(\\d{1,2})\\s*(${monthAlt})(?:\\s*(1[34]\\d{2}))?`));
  if (m === null) return null;
  const monthTok = m[2];
  const jm = monthTok === undefined ? undefined : FA_MONTHS[monthTok];
  const jd = Number(m[1]);
  if (jm === undefined || jd < 1 || jd > 31) return null;
  return {
    jm,
    jd,
    jy: m[3] === undefined ? null : Number(m[3]),
  };
}

/**
 * Next instant (strictly after now) whose Tehran Jalali month/day match,
 * at the given wall-clock time. A named Jalali year in the past has no
 * future occurrence and returns null. Bounded scan: 380 days covers a leap
 * Esfand 30.
 */
function nextJalaliOccurrence(
  tz: string,
  nowMs: number,
  target: JalaliDate,
  time: TimeOfDay,
): number | null {
  const p = zonedParts(tz, nowMs);
  for (let i = 0; i < 380; i++) {
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const at = wallClockToMs(
      tz,
      base.getUTCFullYear(),
      base.getUTCMonth() + 1,
      base.getUTCDate(),
      time.hour,
      time.minute,
    );
    if (at <= nowMs) continue;
    const j = jalaliParts(tz, at);
    if (j.jm !== target.jm || j.jd !== target.jd) continue;
    if (target.jy !== null) {
      // Scanning forward, once the year is past the named one it never
      // comes back — a past named year has no future occurrence.
      if (j.jy > target.jy) return null;
      if (j.jy !== target.jy) continue;
    }
    return at;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timezone math: wall clock <-> instant, DST-safe via Intl
// ---------------------------------------------------------------------------

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFmtCache.get(tz);
  if (f === undefined) {
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
    partsFmtCache.set(tz, f);
  }
  return f;
}

function zonedParts(tz: string, ms: number): ZonedParts {
  const parts = partsFormatter(tz).formatToParts(new Date(ms));
  const pick = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

/** Offset of `tz` at instant `ms`, in ms (negative east of Greenwich). */
function tzOffsetMs(tz: string, ms: number): number {
  const p = zonedParts(tz, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/**
 * Interpret a wall-clock reading in `tz` as an instant.
 *
 * Two-pass correction: guess the offset from the wall reading, then re-read
 * the offset at the corrected instant, which lands exactly even on days
 * where a DST transition moves the wall clock.
 */
function wallClockToMs(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  return asUtc - tzOffsetMs(tz, asUtc - tzOffsetMs(tz, asUtc));
}

interface JalaliParts {
  jy: number;
  jm: number;
  jd: number;
}

const jalaliFmtCache = new Map<string, Intl.DateTimeFormat>();

function jalaliParts(tz: string, ms: number): JalaliParts {
  let f = jalaliFmtCache.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-u-ca-persian", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    jalaliFmtCache.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const pick = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { jy: pick("year"), jm: pick("month"), jd: pick("day") };
}
