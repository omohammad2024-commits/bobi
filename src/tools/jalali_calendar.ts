/**
 * Jalali (Persian) calendar helpers — Intl is the source of truth.
 *
 * No hand-rolled Jalali arithmetic: month lengths, leap years (Esfand 30)
 * and the Gregorian↔Jalali mapping all come from `Intl.DateTimeFormat`
 * with the Persian calendar (`en-u-ca-persian`), following the scan-based
 * approach already used in src/memory/events.ts:
 *  - forward: format an instant in the target zone and read its Persian
 *    year/month/day parts;
 *  - inverse: anchor near the estimated Gregorian date (Jalali year +
 *    621 ≈ the Gregorian year in which that Jalali year starts, plus the
 *    well-known month offsets used ONLY as a scan anchor), then scan a
 *    bounded window of zone-midnights until Intl reports exactly the
 *    requested (jy, jm, jd). A date Intl never reports — 31 مهر, or
 *    30 اسفند in a non-leap year — simply never matches, so the scan
 *    returning nothing IS the month-length validation.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TZ = "Asia/Tehran";

/** Persian month names, index 0 = فروردین (month 1) … 11 = اسفند (month 12). */
export const JALALI_MONTH_NAMES_FA: readonly string[] = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];

export interface JalaliParts {
  jy: number;
  jm: number;
  jd: number;
  monthNameFa: string;
  weekdayFa: string;
}

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Latin digits → Persian digits («1405» → «۱۴۰۵»). */
export function toPersianDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]!);
}

/** «۲۹ مهر ۱۴۰۵» — Persian digits + month name + Persian-digit year. */
export function formatJalaliFa(parts: Pick<JalaliParts, "jy" | "jm" | "jd">): string {
  const monthName = JALALI_MONTH_NAMES_FA[parts.jm - 1] ?? "";
  return `${toPersianDigits(parts.jd)} ${monthName} ${toPersianDigits(parts.jy)}`;
}

// ---------------------------------------------------------------------------
// Formatter caches (one per timezone — repeat calls stay cheap)
// ---------------------------------------------------------------------------

const persianFmtCache = new Map<string, Intl.DateTimeFormat>();
const weekdayFmtCache = new Map<string, Intl.DateTimeFormat>();
const gregorianFmtCache = new Map<string, Intl.DateTimeFormat>();

function persianFmt(timeZone: string): Intl.DateTimeFormat {
  let fmt = persianFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-u-ca-persian", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    persianFmtCache.set(timeZone, fmt);
  }
  return fmt;
}

function weekdayFmt(timeZone: string): Intl.DateTimeFormat {
  let fmt = weekdayFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("fa-IR", { timeZone, weekday: "long" });
    weekdayFmtCache.set(timeZone, fmt);
  }
  return fmt;
}

function gregorianFmt(timeZone: string): Intl.DateTimeFormat {
  let fmt = gregorianFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    gregorianFmtCache.set(timeZone, fmt);
  }
  return fmt;
}

// ---------------------------------------------------------------------------
// Forward: instant → Jalali parts
// ---------------------------------------------------------------------------

export function jalaliPartsOf(ms: number, timeZone: string = DEFAULT_TZ): JalaliParts {
  const date = new Date(ms);
  const parts = persianFmt(timeZone).formatToParts(date);
  const pick = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const jm = pick("month");
  return {
    jy: pick("year"),
    jm,
    jd: pick("day"),
    monthNameFa: JALALI_MONTH_NAMES_FA[jm - 1] ?? "",
    weekdayFa: weekdayFmt(timeZone).format(date),
  };
}

// ---------------------------------------------------------------------------
// Zone-midnight math (Gregorian date in a zone → epoch ms of its 00:00)
// ---------------------------------------------------------------------------

/** Offset (zone wall-clock minus UTC) of `timeZone` at instant `ms`. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = gregorianFmt(timeZone).formatToParts(new Date(ms));
  const pick = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  let hour = pick("hour");
  if (hour === 24) hour = 0; // some Intl builds render midnight as 24
  const asUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    hour,
    pick("minute"),
    pick("second"),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of 00:00 in `timeZone` on the Gregorian date (gy, gm, gd). */
function gregorianMidnightMs(gy: number, gm: number, gd: number, timeZone: string): number {
  const guessUtc = Date.UTC(gy, gm - 1, gd);
  let midnight = guessUtc - zoneOffsetMs(guessUtc, timeZone);
  // Re-resolve once at the candidate: the offset may differ there (DST).
  const refined = guessUtc - zoneOffsetMs(midnight, timeZone);
  if (refined !== midnight) midnight = refined;
  return midnight;
}

// ---------------------------------------------------------------------------
// Inverse: Jalali date → epoch ms of that day's midnight in the zone
// ---------------------------------------------------------------------------

/**
 * Epoch ms at 00:00 in `timeZone` (default Asia/Tehran) on the Jalali
 * date (jy, jm, jd), or null when that date does not exist.
 *
 * Bounded scan: the anchor estimate is Nowruz of `jy` (Gregorian
 * March ~21 of jy+621) plus the nominal month offset (months 1–6 have
 * 31 days, 7–11 have 30 — used only to place the anchor, never as
 * truth). Intl decides Nowruz's exact day, so the true date is within
 * a couple of days of the anchor; scanning ±15 days is ample and the
 * match is exact, so impossible dates return null.
 */
export function jalaliToGregorianMs(
  jy: number,
  jm: number,
  jd: number,
  timeZone: string = DEFAULT_TZ,
): number | null {
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd)) return null;
  if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;

  const daysBeforeMonth = jm <= 7 ? (jm - 1) * 31 : 6 * 31 + (jm - 7) * 30;
  const anchorMs = Date.UTC(jy + 621, 2, 21) + (daysBeforeMonth + jd - 1) * DAY_MS;
  const anchor = new Date(anchorMs);

  for (let i = -15; i <= 15; i++) {
    // Gregorian date arithmetic in UTC (Date.UTC normalizes overflow),
    // then that Gregorian date's midnight in the requested zone.
    const g = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + i),
    );
    const dayMs = gregorianMidnightMs(
      g.getUTCFullYear(),
      g.getUTCMonth() + 1,
      g.getUTCDate(),
      timeZone,
    );
    const p = jalaliPartsOf(dayMs, timeZone);
    if (p.jy === jy && p.jm === jm && p.jd === jd) return dayMs;
  }
  return null;
}
