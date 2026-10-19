/**
 * Event-based memory (Phase-3 item 1: proactive long-term memory).
 *
 * WHY THIS HOME: this is a memory *store*, not a curator concern — a
 * structured representation (dated events) over the MemoryProvider, next to
 * provider.ts / sqlite_provider.ts. The curator produces proposals; this
 * module stores facts. Using the provider (rather than a new table) is
 * deliberate:
 *  - per-user scoping comes free — the provider never reads/writes another
 *    user's rows, so an event can never leak across users;
 *  - no new DB wiring and no index.ts change: events live as memories under
 *    the reserved `event:` key prefix, visible to the same provider the
 *    digest builder reads through Storage.listMemories;
 *  - the existing `forget` memory tool already deletes by key, so event
 *    deletion needs no new surface.
 *
 * Payloads are JSON: `{ v:1, name, kind, jMonth, jDay, jYear?, labelFa,
 * note?, lastRemindedMs? }`. Keys the user owns (`event:birthday:<hash>`)
 * are inert data — the sweep renders them quoted, never interpreted.
 *
 * JALALI AWARENESS: input dates are Persian («۱۵ مرداد», «۲۰ شهریور ۱۴۰۳»)
 * and recurrence is Jalali-native: a «۱۵ مرداد» birthday is found by scanning
 * forward for the next Tehran day whose *Persian-calendar* parts are
 * (Mordad, 15) — no Gregorian drift, no hand-rolled calendar math, and
 * Esfand 30 simply never matches in a non-leap year. The scan is bounded
 * (≤ ~800 Intl calls per lookup) and deterministic.
 *
 * SECURITY:
 * - Events are keyed per (userId, key) by the provider; every method here
 *   takes userId explicitly and never invents one.
 * - Event names/notes are the user's own words but are rendered as DATA
 *   (quoted inside the message template); instructions embedded in them are
 *   never followed — see formatEventReminder and sweepEvents.
 * - markReminded is read-modify-write on the caller's own key only.
 */
import { createHash } from "node:crypto";
import type { MemoryProvider, StoredMemory } from "./provider";
import { normalizeFa } from "../nudges/time_fa";
import { t } from "../i18n";

/** Reserved memory-key prefix for structured events. The summarizer and the
 *  digest's memory-highlights section both skip these keys. */
export const EVENT_KEY_PREFIX = "event:";

/** Reserved memory-key prefix for summarizer archives. Skipped by the
 *  summarizer itself (never re-archive an archive) and by digest highlights. */
export const ARCHIVE_KEY_PREFIX = "archive:";

/** Kinds of dated events we track. */
export type EventKind = "birthday" | "anniversary" | "monthly" | "once";

/** One structured event, as stored (JSON) in the event memory's content. */
export interface MemoryEvent {
  name: string;
  kind: EventKind;
  /** Jalali month 1..12 (annual/monthly/once). */
  jMonth: number;
  /** Jalali day 1..31. */
  jDay: number;
  /** Jalali year — only for kind "once". */
  jYear?: number;
  /** Original Persian label for display, e.g. «۱۵ مرداد». */
  labelFa: string;
  note?: string;
  /** unix ms of the last proactive reminder; absent when never reminded. */
  lastRemindedMs?: number;
}

/** Input for EventStore.add. */
export interface NewEvent {
  name: string;
  kind: EventKind;
  jMonth: number;
  jDay: number;
  jYear?: number;
  labelFa: string;
  note?: string;
}

/** An event with its next occurrence resolved. */
export interface UpcomingEvent {
  key: string;
  event: MemoryEvent;
  /** unix ms of the next occurrence (start of the Tehran day). */
  occursAtMs: number;
  /** Whole days from now until the occurrence (0 = today). */
  daysUntil: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TEHRAN_TZ = "Asia/Tehran";
/** Iran has no DST since 2022: Tehran is a fixed UTC+3:30. */
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;
/** Default proactive window: remind up to 7 days ahead. */
export const DEFAULT_EVENT_HORIZON_DAYS = 7;
/** After a reminder fires, don't resend for the same event within 30 days. */
export const DEFAULT_EVENT_REMIND_COOLDOWN_MS = 30 * DAY_MS;
/** Max events scanned per user per pass. */
const MAX_EVENTS_SCANNED = 200;

// ---------------------------------------------------------------------------
// Persian month names
// ---------------------------------------------------------------------------

/** Persian month name → Jalali month number. After normalizeFa (ZWNJ → space). */
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

// ---------------------------------------------------------------------------
// Jalali-aware date math (scan-based, no hand-rolled calendar)
// ---------------------------------------------------------------------------

interface PersianParts {
  jy: number;
  jm: number;
  jd: number;
}

const persianFmt = new Intl.DateTimeFormat("en-u-ca-persian", {
  timeZone: TEHRAN_TZ,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

function persianParts(ms: number): PersianParts {
  const parts = persianFmt.formatToParts(new Date(ms));
  const pick = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { jy: pick("year"), jm: pick("month"), jd: pick("day") };
}

/** Start (unix ms) of the Tehran calendar day containing `ms`. */
function startOfTehranDay(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TEHRAN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day")) - TEHRAN_OFFSET_MS;
}

/**
 * Next Tehran day (as unix ms of day start) whose Persian parts equal
 * (jm, jd), strictly from today onward. Returns daysUntil as well.
 * Bounded scan: ≤ 420 days, which covers leap-year Esfand 30.
 */
function nextAnnualOccurrence(
  jm: number,
  jd: number,
  nowMs: number,
): { occursAtMs: number; daysUntil: number } | undefined {
  const start = startOfTehranDay(nowMs);
  for (let i = 0; i < 420; i++) {
    const dayMs = start + i * DAY_MS;
    const p = persianParts(dayMs);
    if (p.jm === jm && p.jd === jd) return { occursAtMs: dayMs, daysUntil: i };
  }
  return undefined;
}

/**
 * Next Tehran day whose Persian day-of-month equals jd (any month/year).
 * Bounded: ≤ 65 days.
 */
function nextMonthlyOccurrence(
  jd: number,
  nowMs: number,
): { occursAtMs: number; daysUntil: number } | undefined {
  const start = startOfTehranDay(nowMs);
  for (let i = 0; i < 65; i++) {
    const dayMs = start + i * DAY_MS;
    if (persianParts(dayMs).jd === jd) return { occursAtMs: dayMs, daysUntil: i };
  }
  return undefined;
}

/**
 * The single occurrence of a Jalali (jy, jm, jd) date, when it is in the
 * future. Anchors the scan near the Jalali year so the scan stays bounded.
 */
function nextOnceOccurrence(
  jy: number,
  jm: number,
  jd: number,
  nowMs: number,
): { occursAtMs: number; daysUntil: number } | undefined {
  const nowJy = persianParts(nowMs).jy;
  const anchor = nowMs + (jy - nowJy) * 365 * DAY_MS;
  const lo = anchor - 400 * DAY_MS;
  for (let i = 0; i < 800; i++) {
    const dayMs = startOfTehranDay(lo) + i * DAY_MS;
    const p = persianParts(dayMs);
    if (p.jy === jy && p.jm === jm && p.jd === jd && dayMs + DAY_MS > nowMs) {
      const daysUntil = Math.max(0, Math.round((dayMs - startOfTehranDay(nowMs)) / DAY_MS));
      return { occursAtMs: dayMs, daysUntil };
    }
  }
  return undefined;
}

/** Next occurrence of an event, or undefined when it cannot be resolved. */
export function nextOccurrence(
  event: MemoryEvent,
  nowMs: number,
): { occursAtMs: number; daysUntil: number } | undefined {
  switch (event.kind) {
    case "birthday":
    case "anniversary":
      return nextAnnualOccurrence(event.jMonth, event.jDay, nowMs);
    case "monthly":
      return nextMonthlyOccurrence(event.jDay, nowMs);
    case "once":
      return event.jYear === undefined
        ? undefined
        : nextOnceOccurrence(event.jYear, event.jMonth, event.jDay, nowMs);
  }
}

// ---------------------------------------------------------------------------
// Event store (provider-backed)
// ---------------------------------------------------------------------------

/** Deterministic key: kind + hash of the normalized name. Same name+kind
 *  overwrites (upsert semantics, like memories); different names hash
 *  differently, so one user's events never collide. */
export function eventKeyFor(name: string, kind: EventKind): string {
  const norm = normalizeFa(name).replace(/\s+/g, " ").trim();
  const hash = createHash("sha256").update(`${kind}:${norm}`).digest("hex").slice(0, 10);
  return `${EVENT_KEY_PREFIX}${kind}:${hash}`;
}

/**
 * Parse a stored event payload. Exported for the auto-extraction sweep
 * (which skips candidates already stored verbatim) and the memory
 * export/import flow (which re-validates event rows). Malformed rows
 * return undefined — never throw.
 */
export function parseEventPayload(content: string): MemoryEvent | undefined {
  try {
    const v = JSON.parse(content) as Partial<MemoryEvent>;
    if (
      typeof v !== "object" || v === null ||
      typeof v.name !== "string" || v.name.length === 0 ||
      (v.kind !== "birthday" && v.kind !== "anniversary" && v.kind !== "monthly" && v.kind !== "once") ||
      !Number.isInteger(v.jMonth) || (v.jMonth as number) < 1 || (v.jMonth as number) > 12 ||
      !Number.isInteger(v.jDay) || (v.jDay as number) < 1 || (v.jDay as number) > 31 ||
      typeof v.labelFa !== "string"
    ) {
      return undefined;
    }
    const jMonth = v.jMonth as number;
    const jDay = v.jDay as number;
    const event: MemoryEvent = {
      name: v.name,
      kind: v.kind,
      jMonth,
      jDay,
      labelFa: v.labelFa,
    };
    if (v.jYear !== undefined && Number.isInteger(v.jYear)) event.jYear = v.jYear;
    if (typeof v.note === "string" && v.note.length > 0) event.note = v.note.slice(0, 200);
    if (typeof v.lastRemindedMs === "number" && Number.isFinite(v.lastRemindedMs)) {
      event.lastRemindedMs = v.lastRemindedMs;
    }
    return event;
  } catch {
    return undefined; // Malformed JSON under our prefix: skip, never throw.
  }
}

export interface EventStoreOptions {
  /** Injectable clock, ms. */
  now?: () => number;
}

export class EventStore {
  private readonly now: () => number;

  constructor(
    private readonly provider: MemoryProvider,
    opts: EventStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Store an event. Returns the memory key. Throws on invalid input. */
  async add(userId: string, input: NewEvent): Promise<string> {
    const name = input.name.trim();
    if (name.length === 0) throw new Error("نام رویداد خالی است.");
    if (name.length > 120) throw new Error("نام رویداد بیش از حد طولانی است.");
    if (!Number.isInteger(input.jMonth) || input.jMonth < 1 || input.jMonth > 12) {
      throw new Error("ماه جلالی نامعتبر است.");
    }
    if (!Number.isInteger(input.jDay) || input.jDay < 1 || input.jDay > 31) {
      throw new Error("روز جلالی نامعتبر است.");
    }
    if (input.kind === "once" && !Number.isInteger(input.jYear)) {
      throw new Error("رویداد یک‌باره به سال جلالی نیاز دارد.");
    }
    const event: MemoryEvent = {
      name,
      kind: input.kind,
      jMonth: input.jMonth,
      jDay: input.jDay,
      labelFa: input.labelFa,
    };
    if (input.jYear !== undefined) event.jYear = input.jYear;
    if (input.note !== undefined && input.note.trim().length > 0) {
      event.note = input.note.trim().slice(0, 200);
    }
    const key = eventKeyFor(name, input.kind);
    await this.provider.upsert(userId, key, JSON.stringify(event));
    return key;
  }

  /** All of the user's events, oldest first. Malformed rows are skipped. */
  async list(userId: string): Promise<Array<{ key: string; event: MemoryEvent }>> {
    const rows: StoredMemory[] = await this.provider.list(userId, MAX_EVENTS_SCANNED);
    const out: Array<{ key: string; event: MemoryEvent }> = [];
    for (const row of rows) {
      if (!row.key.startsWith(EVENT_KEY_PREFIX)) continue;
      const event = parseEventPayload(row.content);
      if (event === undefined) continue;
      out.push({ key: row.key, event });
    }
    out.sort((a, b) => a.event.jMonth - b.event.jMonth || a.event.jDay - b.event.jDay);
    return out;
  }

  /** Events whose next occurrence is within `withinDays` days, soonest first. */
  async upcoming(
    userId: string,
    nowMs: number,
    withinDays: number = DEFAULT_EVENT_HORIZON_DAYS,
  ): Promise<UpcomingEvent[]> {
    const out: UpcomingEvent[] = [];
    for (const { key, event } of await this.list(userId)) {
      const occ = nextOccurrence(event, nowMs);
      if (occ === undefined || occ.daysUntil > withinDays) continue;
      out.push({ key, event, occursAtMs: occ.occursAtMs, daysUntil: occ.daysUntil });
    }
    out.sort((a, b) => a.daysUntil - b.daysUntil || (a.key < b.key ? -1 : 1));
    return out;
  }

  /**
   * Record that a proactive reminder was delivered for this event
   * (read-modify-write on the caller's own key only). The sweep uses this
   * so the same event is not re-delivered on every pass.
   */
  async markReminded(userId: string, key: string, atMs?: number): Promise<boolean> {
    if (!key.startsWith(EVENT_KEY_PREFIX)) return false;
    const row = await this.provider.get(userId, key);
    if (row === undefined) return false;
    const event = parseEventPayload(row.content);
    if (event === undefined) return false;
    event.lastRemindedMs = atMs ?? this.now();
    await this.provider.upsert(userId, key, JSON.stringify(event));
    return true;
  }

  /** Delete one of the user's events. True when a row actually went. */
  async delete(userId: string, key: string): Promise<boolean> {
    if (!key.startsWith(EVENT_KEY_PREFIX)) return false;
    return (await this.provider.delete(userId, key)) === true;
  }
}

// ---------------------------------------------------------------------------
// Persian event extraction (per-turn, deterministic, rule-based)
// ---------------------------------------------------------------------------

/** One dated event mentioned in a user message. */
export interface EventCandidate {
  kind: EventKind;
  name: string;
  jMonth: number;
  jDay: number;
  /** Present when the message named a Jalali year → kind becomes "once". */
  jYear?: number;
  /** Original Persian date label for display. */
  labelFa: string;
}

/** «۱۵ مرداد» / «۱۵ مرداد ۱۴۰۴» — after normalizeFa. */
const DATE_RE = "(\\d{1,2})\\s+(فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)(?:\\s+(1[34]\\d{2}))?";

const BIRTHDAY_RE = new RegExp(`تولد\\s+([^\\s،.؟!؛:\\n]{1,24}(?:\\s+[^\\s،.؟!؛:\\n]{1,24}){0,2})\\s+${DATE_RE}`);
const BIRTHDAY_SELF_RE = new RegExp(`تولدم\\s+${DATE_RE}`);
const ANNIVERSARY_RE = new RegExp(`سالگرد\\s+([^\\s،.؟!؛:\\n]{1,24}(?:\\s+[^\\s،.؟!؛:\\n]{1,24}){0,2})\\s+${DATE_RE}`);
/** «هر ماه ۵ام قسط وام» / «ماهانه ۱۰ام اجاره» — monthly recurring commitment. */
const MONTHLY_RE = /(?:هر ماه|ماهانه)\s+(?:روز\s*)?(\d{1,2})(?:\s*(?:ام|م))?\s+([^\n،.؟!؛:]{2,40})/;

function toCandidate(
  kind: EventKind,
  name: string,
  day: string,
  monthName: string,
  year: string | undefined,
): EventCandidate | undefined {
  const jDay = Number(day);
  const jMonth = FA_MONTHS[monthName];
  if (jMonth === undefined || jDay < 1 || jDay > 31) return undefined;
  const cleanName = name.replace(/\s+/g, " ").trim();
  if (cleanName.length === 0) return undefined;
  const digits = "۰۱۲۳۴۵۶۷۸۹";
  const faDigits = (n: string): string => n.replace(/[0-9]/g, (d) => digits[Number(d)]!);
  const faDay = faDigits(String(jDay));
  const labelFa = year !== undefined ? `${faDay} ${monthName} ${faDigits(year)}` : `${faDay} ${monthName}`;
  const candidate: EventCandidate = {
    kind: year !== undefined ? "once" : kind,
    name: cleanName,
    jMonth,
    jDay,
    labelFa,
  };
  if (year !== undefined) candidate.jYear = Number(year);
  return candidate;
}

/**
 * Detect dated-event mentions in ONE user message (the current turn only —
 * never scans other users' messages or history).
 *
 * A match requires an explicit event phrase AND a Persian date; questions
 * about the past («تولد کیه؟») and memory statements («یادمه تولد علی…»)
 * have no date and never match. Returns candidates in match order.
 */
export function extractEvents(
  message: string,
  _nowMs?: number,
  _timeZone?: string,
): EventCandidate[] {
  if (typeof message !== "string") return [];
  const s = normalizeFa(message);
  if (s.length === 0 || s.length > 2000) return [];
  const out: EventCandidate[] = [];

  const self = BIRTHDAY_SELF_RE.exec(s);
  if (self) {
    const c = toCandidate("birthday", "خودم", self[1]!, self[2]!, self[3]);
    if (c) out.push(c);
  }
  const pairs: Array<[RegExp, EventKind]> = [
    [BIRTHDAY_RE, "birthday"],
    [ANNIVERSARY_RE, "anniversary"],
  ];
  for (const [re, kind] of pairs) {
    const mm = re.exec(s);
    if (mm) {
      const c = toCandidate(kind, mm[1]!, mm[2]!, mm[3]!, mm[4]);
      if (c) out.push(c);
    }
  }
  const monthly = MONTHLY_RE.exec(s);
  if (monthly) {
    const c = toCandidate("monthly", monthly[2]!.trim(), monthly[1]!, "فروردین", undefined);
    // Monthly anchors to a day-of-month; the month label is not meaningful,
    // so rebuild the display label as «هر ماه، روز N».
    if (c) {
      const digits = "۰۱۲۳۴۵۶۷۸۹";
      const faDay = monthly[1]!.replace(/[0-9]/g, (d) => digits[Number(d)]!);
      out.push({ ...c, jMonth: 1, labelFa: `هر ماه، روز ${faDay}` });
    }
  }
  return out;
}

/**
 * Parse a standalone Persian date («۱۵ مرداد», «۲۰ شهریور ۱۴۰۳») into
 * Jalali parts. Used by the note_event tool's `date` field. Returns null
 * when the text names no recognizable Persian date.
 */
export function parsePersianDate(
  raw: string,
): { jMonth: number; jDay: number; jYear?: number; labelFa: string } | null {
  if (typeof raw !== "string") return null;
  const s = normalizeFa(raw);
  const re = new RegExp(`^\\s*${DATE_RE}\\s*$`);
  const m = re.exec(s);
  if (!m) return null;
  const jDay = Number(m[1]);
  const jMonth = FA_MONTHS[m[2]!];
  if (jMonth === undefined || jDay < 1 || jDay > 31) return null;
  const digits = "۰۱۲۳۴۵۶۷۸۹";
  const faDigits = (n: string): string => n.replace(/[0-9]/g, (d) => digits[Number(d)]!);
  const faDay = faDigits(m[1]!);
  const labelFa = m[3] !== undefined ? `${faDay} ${m[2]} ${faDigits(m[3])}` : `${faDay} ${m[2]}`;
  const out: { jMonth: number; jDay: number; jYear?: number; labelFa: string } = {
    jMonth,
    jDay,
    labelFa,
  };
  if (m[3] !== undefined) out.jYear = Number(m[3]);
  return out;
}

// ---------------------------------------------------------------------------
// Proactive reminders ahead of events
// ---------------------------------------------------------------------------

/**
 * English "in N days" phrasing for an upcoming event (English-only UI
 * since v1.0; the event's own label stays in the owner's Persian).
 */
export function eventWhen(daysUntil: number): string {
  if (daysUntil <= 0) return t("events.when.today", "en");
  if (daysUntil === 1) return t("events.when.tomorrow", "en");
  return t("events.when.days", "en", { count: String(daysUntil) });
}

export function eventKindLabel(kind: EventKind): string {
  return t(`events.kind.${kind}`, "en");
}

/**
 * Render a proactive event reminder. The event name/note are rendered as
 * DATA inside the template — never interpreted — so prompt-injection-shaped
 * event text («ignore instructions…») is just a quoted string.
 */
export function formatEventReminder(event: MemoryEvent, daysUntil: number): string {
  return t("events.remind.body", "en", {
    when: eventWhen(daysUntil),
    kind: eventKindLabel(event.kind),
    name: event.name.replace(/\s+/g, " ").trim(),
    label: event.labelFa,
  });
}

/** One proactive event reminder ready for delivery. The caller routes
 *  `message` to `userId` — never a group, never another DM. */
export interface EventDelivery {
  userId: string;
  eventKey: string;
  message: string;
}

export interface SweepEventsOptions {
  /** Remind for events this far ahead. Defaults to 7 days. */
  horizonDays?: number;
  /** Don't re-remind the same event within this window. Defaults to 30 days. */
  remindCooldownMs?: number;
}

/**
 * Proactive event sweep: for one user's upcoming events, build reminder
 * messages and mark each reminded event so it is not re-delivered on the
 * next pass. Annual events recur next year; the cooldown keeps this year's
 * window to one reminder per event.
 *
 * The sweep NEVER sends anything — delivery stays with the caller, which
 * re-checks access at delivery time.
 */
export async function sweepEvents(
  store: EventStore,
  userId: string,
  nowMs: number,
  opts: SweepEventsOptions = {},
): Promise<EventDelivery[]> {
  const horizonDays = opts.horizonDays ?? DEFAULT_EVENT_HORIZON_DAYS;
  const cooldownMs = opts.remindCooldownMs ?? DEFAULT_EVENT_REMIND_COOLDOWN_MS;
  const out: EventDelivery[] = [];
  let upcoming: UpcomingEvent[];
  try {
    upcoming = await store.upcoming(userId, nowMs, horizonDays);
  } catch {
    return out; // A broken store must not kill the caller.
  }
  for (const u of upcoming) {
    try {
      const last = u.event.lastRemindedMs;
      if (last !== undefined && nowMs - last < cooldownMs) continue;
      // Mark BEFORE building the message: a failed mark skips the event and
      // the next sweep retries it, instead of the user getting a message the
      // store does not know about.
      const marked = await store.markReminded(userId, u.key, nowMs);
      if (!marked) continue;
      out.push({
        userId,
        eventKey: u.key,
        message: formatEventReminder(u.event, u.daysUntil),
      });
    } catch {
      // A poisoned row must not kill the whole sweep.
      continue;
    }
  }
  return out;
}
