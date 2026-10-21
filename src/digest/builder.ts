/**
 * Morning digest builder — a proactive morning briefing (Stage-3
 * differentiator; Hermes has nothing like it).
 *
 * The builder composes a digest from REAL in-repo sources only:
 *  - date/time (Intl, Asia/Tehran)
 *  - "what matters to you" focus: overdue reminders, today's events, items
 *    starting soon, and items matching the owner's interest topics — ranked
 *    above everything else, capped so a busy owner reads it in seconds
 *  - today's scheduled tasks (Storage.listTasks)
 *  - pending reminders due today (Storage.listReminders)
 *  - pending curator proposals (ProposalStore.countPending)
 *  - yesterday's usage/cost (UsageTracker ledger)
 *  - web headlines (injected search function, fully defensive; when the
 *    owner has interest topics saved, the search is aimed at those topics
 *    instead of generic filler)
 *  - newest long-term memories (Storage.listMemories)
 *
 * PERSONALIZATION (read-only):
 * - Interest topics are read from the owner's `user_prefs` under the key
 *   `digest.interests` (JSON array of strings, e.g. ["AI", "meme page"]).
 *   The digest NEVER writes preferences; whatever surface lets the owner
 *   set topics is owned by another module. When no topics are saved, the
 *   digest falls back to generic behavior.
 * - Topics steer two things: (1) headline search queries ("<topic> news"
 *   instead of generic headlines), (2) a "📌 about <topic>" highlight in
 *   the focus section for tasks/memories whose text mentions a topic
 *   (case-insensitive substring match — deliberately simple, defensive).
 * - Time-awareness: the focus section puts overdue items first, then
 *   today's events, then items starting within the next 3 hours.
 * - Priority ranking: sections are gathered in priority order
 *   (date → focus → tasks → reminders → events → proposals → usage →
 *   headlines → memories) and a global item budget (MAX_DIGEST_ITEMS)
 *   trims the lowest-priority item lists first, so a packed day still fits
 *   in a quick read. Generic web headlines are the first to go.
 *
 * Every section is built inside its own try/catch: one failing source is
 * logged and skipped, and can never kill the digest.
 *
 * PHASE-8 PARAMETERS (DigestDeps.topic / anchorMs / rangeDays, all
 * optional): a one-off topic overrides the saved interests for the
 * headline search only; anchorMs + rangeDays move/widen the Tehran day
 * window the day sections (tasks, reminders, events, usage, focus) are
 * built over. With all three absent the digest is exactly the pre-Phase-8
 * morning digest — the interactive /digest path relies on that.
 *
 * Rendering (English-only UI since v1.0, Phase-2 item 3 — interactive
 * digest): section gathering is language-neutral (`buildDigestData`); text
 * rendering takes a `DigestLocale` (`renderDigestSection`,
 * `renderDigestText`) which selects fa-IR vs Latin date/number formatting
 * for the owner's Tehran briefing — all UI strings render in English via
 * the central i18n pack. The legacy API (`buildDigest`, `formatDigest`,
 * `DigestSection`) is preserved byte-for-byte on top of the
 * new core, so the scheduled 08:00 text delivery and its tests are
 * unaffected.
 *
 * SECURITY (attack-surface review):
 * - The digest aggregates the OWNER's private data (tasks, reminders,
 *   memories, usage). It must only ever be delivered to the owner's chat.
 *   The tool layer enforces this twice (ownerOnly + run()-level isOwner
 *   check); the delivery path is the scheduler's owner delivery — see
 *   docs/phase-digest.md and src/tools/digest_tool.ts. The interactive
 *   /digest command and every dgst: callback re-check the owner tier
 *   server-side (see src/bot/digest_cmd.ts).
 * - Web headlines are UNTRUSTED third-party text. They are rendered in a
 *   clearly labelled "external content" section, never presented as the
 *   owner's own data, and URLs are reduced to their hostname so a query
 *   string carrying a session id or token can never leak into the chat
 *   (the same scrub instinct as /debug's secret scrubbing).
 * - User content (task names, reminder text, memory content) is rendered as
 *   PLAIN TEXT with no parse_mode: markdown/HTML control characters cannot
 *   break the message. Whitespace is collapsed (oneLine) and each item is
 *   clipped, so hostile content cannot break the layout or fake a section.
 *   Callback data never contains user text — only server-side numeric ids,
 *   small indexes, and store-generated proposal ids.
 * - No secrets: sources here never include credentials, and the builder
 *   never logs section content at a level above a short failure note.
 */
import { Storage } from "../storage/storage";
import { UsageTracker } from "../ai/usage";
import { t } from "../i18n";
import {
  EVENT_KEY_PREFIX,
  ARCHIVE_KEY_PREFIX,
  nextOccurrence,
  type MemoryEvent,
} from "../memory/events";

/** One rendered digest block (legacy Persian API): Persian title + Persian body. */
export interface DigestSection {
  titleFa: string;
  bodyFa: string;
}

/**
 * Locale for date/number formatting in the digest (the owner's Tehran
 * briefing keeps Persian fa-IR dates and digits).
 *
 * This is deliberately NOT the i18n UI `Lang` (English-only since v1.0):
 * it selects numeral/date formatting only. All UI strings render in
 * English via t(); the "fa" locale additionally formats dates and numbers
 * with fa-IR (Persian digits, Jalali month names).
 */
export type DigestLocale = "en" | "fa";

/** One web headline, from the injected search function. */
export interface DigestHeadline {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Search function the caller injects. The builder calls it defensively
 * (timeout + try/catch) — a missing or failing search simply drops the
 * headlines section. Production wiring resolves the active search provider
 * from the SearchRegistry; tests pass a fake.
 */
export type SearchHeadlinesFn = (
  query: string,
  limit: number,
  signal: AbortSignal,
) => Promise<readonly DigestHeadline[]>;

export interface DigestDeps {
  storage: Storage;
  /** Minimal proposal-store surface (the real ProposalStore satisfies it). */
  proposalStore: DigestProposalStore;
  /** Owner's user id (Telegram numeric id as string). All reads are scoped to it. */
  userId: string;
  /** Injectable clock, unix ms. Tests pass a fixed time. */
  now?: () => number;
  /** Optional web-search resolver. Omit it (or let it throw) to skip headlines. */
  searchHeadlines?: SearchHeadlinesFn;
  /**
   * Optional one-line weather summary for the digest (Phase-9 seam),
   * e.g. "Tehran: 18°C, clear — today 12–21°C". When present and it
   * resolves to a non-empty line, the digest gains a short weather
   * section right after the date header. When absent, or when it
   * resolves to undefined/empty (or throws), the digest output is
   * byte-identical to a digest built without it — weather must never
   * break the digest. The coordinator wires the real implementation
   * (the weather tool's fetchWeatherLine) in bootstrap.
   */
  weatherLine?: () => Promise<string | undefined>;
  /** Diagnostic log for skipped/failed sources. Defaults to silent. */
  log?: (message: string) => void;
  /**
   * Phase-8: optional headline topic for this digest only. When set (after
   * trimming; an empty/whitespace value counts as absent), the headline
   * search is a single `"<topic> news"` query with perQuery 3, overriding
   * the saved `digest.interests` topics. When absent, interest-based (or
   * generic) headline behavior is unchanged. The topic steers ONLY the
   * headlines — focus interest matches keep using the saved interests.
   */
  topic?: string;
  /**
   * Phase-8: optional anchor instant (unix ms) for a date-shifted digest.
   * The day window (tasks / reminders / events / usage) is computed from
   * the Tehran calendar day containing this instant instead of the day
   * containing `now()`. Absent = anchored at `now()` (today), exactly as
   * before.
   */
  anchorMs?: number;
  /**
   * Phase-8: optional length (days) of the day window starting at the
   * anchor day. Normalized defensively to an integer in 1..7 (the tool
   * layer validates strictly and rejects out-of-range values before this
   * point). Absent = 1 for the window math, with two legacy quirks
   * preserved when NO window was requested at all (neither anchorMs nor
   * rangeDays set): events keep their 7-day horizon and usage keeps its
   * rolling last-24h window — see resolveDigestWindow.
   */
  rangeDays?: number;
}

/** Minimal proposal-store surface the digest needs. */
export interface DigestProposalStore {
  countPending(userId: string): number;
}

/** Hard cap on the formatted digest, sized for a Telegram message. */
export const MAX_DIGEST_CHARS = 2500;

// ---------------------------------------------------------------------------
// Language-neutral section data
// ---------------------------------------------------------------------------

export type DigestSectionKind =
  | "date"
  | "weather"
  | "focus"
  | "tasks"
  | "reminders"
  | "events"
  | "proposals"
  | "usage"
  | "headlines"
  | "memories";

/** One scheduled task due today, with its stable storage id for callbacks. */
export interface DigestTaskItem {
  id: number;
  name: string;
  runAtMs: number;
}

/** One pending reminder due today, with its stable storage id. */
export interface DigestReminderItem {
  id: number;
  text: string;
  dueAt: number;
  overdue: boolean;
}

/** One web headline (hostname only — never the full URL). */
export interface DigestHeadlineItem {
  title: string;
  host?: string;
}

/** One long-term memory (newest first). */
export interface DigestMemoryItem {
  key: string;
  content: string;
}

/** One upcoming dated event (Phase-3 proactive memory). */
export interface DigestEventItem {
  name: string;
  kindLabel: string;
  labelFa: string;
  daysUntil: number;
}

/**
 * Why a focus item made the "what matters to you" cut. Language-neutral;
 * rendering adds the words.
 */
export type DigestFocusReason =
  | { type: "overdue" }
  | { type: "soon"; atMs: number; verb: "starts at" | "due at" }
  | { type: "today" }
  | { type: "interest"; topic: string };

/** One "what matters to you" highlight. Sorted: overdue → today → soon → interest. */
export interface DigestFocusItem {
  itemKind: "task" | "reminder" | "event" | "memory";
  /** Storage id for tasks/reminders — drives the tap-to-act buttons. */
  refId?: number;
  /** Short label (rendered clipped). */
  text: string;
  reason: DigestFocusReason;
}

/** The "what matters to you" section: the personalized top of the digest. */
export interface DigestFocusSection {
  kind: "focus";
  items: DigestFocusItem[];
}

/** user_prefs key holding the owner's interest topics (JSON string array). Read-only. */
export const DIGEST_INTERESTS_PREF_KEY = "digest.interests";

/** user_prefs key naming the owner's city for the digest weather line. */
export const DIGEST_CITY_PREF_KEY = "digest.city";

/**
 * Global cap on rendered bullet items: the owner is busy, so a packed day
 * still fits a quick read. applyItemBudget trims the lowest-priority
 * sections first (headlines go first, focus last).
 */
export const MAX_DIGEST_ITEMS = 12;

/** "Coming up soon" window for focus highlights. */
export const FOCUS_SOON_MS = 3 * 60 * 60 * 1000;

/** Max highlights in the "what matters to you" section. */
export const MAX_FOCUS_ITEMS = 5;

/** Max interest topics read from the pref (keeps search fan-out bounded). */
export const MAX_INTEREST_TOPICS = 3;

/**
 * English UI strings owned by this module.
 *
 * NOTE: src/i18n/en.ts is frozen for this worker's scope (another worker
 * owns it). These stay inline until the i18n pack is reopened, then move
 * them under digest.sec.focus / digest.focus.* keys. UI stays English-only
 * per the v1.0 rule — only date/number formatting varies by DigestLocale.
 */
const FOCUS_SECTION_TITLE = "🎯 What matters to you";

/** Language-neutral digest section data. Rendering is per-language. */
export type DigestSectionData =
  | { kind: "date"; nowMs: number; rangeDays?: number }
  | { kind: "weather"; line: string }
  | DigestFocusSection
  | { kind: "tasks"; items: DigestTaskItem[] }
  | { kind: "reminders"; items: DigestReminderItem[] }
  | { kind: "events"; items: DigestEventItem[] }
  | { kind: "proposals"; count: number }
  | {
      kind: "usage";
      runs: number;
      inputTokens: number;
      outputTokens: number;
      estimatedUsd: number;
    }
  | { kind: "headlines"; items: DigestHeadlineItem[] }
  | { kind: "memories"; items: DigestMemoryItem[] };

// ---------------------------------------------------------------------------
// Formatting helpers (per language)
// ---------------------------------------------------------------------------

const TEHRAN = "Asia/Tehran";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Iran has no DST since 2022: Tehran is a fixed UTC+3:30. */
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/** Persian digits for every number the owner reads (fa); grouped Latin (en). */
function faNum(n: number): string {
  return new Intl.NumberFormat("fa-IR").format(Math.round(n));
}

function enNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function fmtNum(n: number, locale: DigestLocale): string {
  return locale === "fa" ? faNum(n) : enNum(n);
}

/** Collapse whitespace runs so external text cannot break the layout. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Truncate a string to a char budget, keeping it readable. */
function clip(value: string, max: number): string {
  const v = oneLine(value);
  if (v.length <= max) return v;
  return v.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Hostname only — never the full URL. A headline URL can carry query
 * parameters (session ids, tracking tokens); the hostname is all the digest
 * needs and it cannot leak a secret. Mirrors the /debug scrub instinct.
 */
function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.hostname;
  } catch {
    return undefined;
  }
}

interface DigestDateTime {
  date: string;
  time: string;
  hour: number;
}

function faDateTime(nowMs: number): DigestDateTime {
  const d = new Date(nowMs);
  const date = new Intl.DateTimeFormat("fa-IR", {
    timeZone: TEHRAN,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("fa-IR", {
    timeZone: TEHRAN,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TEHRAN, hour: "numeric", hour12: false }).format(d),
  );
  return { date, time, hour };
}

function enDateTime(nowMs: number): DigestDateTime {
  const d = new Date(nowMs);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: TEHRAN,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: TEHRAN,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: TEHRAN, hour: "numeric", hour12: false }).format(d),
  );
  return { date, time, hour };
}

function fmtDateTime(nowMs: number, locale: DigestLocale): DigestDateTime {
  return locale === "fa" ? faDateTime(nowMs) : enDateTime(nowMs);
}

/** i18n key for the time-of-day greeting; same hour ranges in both languages. */
function greetingKey(hour: number): string {
  if (hour >= 5 && hour < 12) return "digest.greeting.morning";
  if (hour >= 12 && hour < 17) return "digest.greeting.afternoon";
  if (hour >= 17 && hour < 21) return "digest.greeting.evening";
  return "digest.greeting.night";
}

/** Start/end of "today" in Tehran, as unix ms. */
function tehranDayBounds(nowMs: number): { start: number; end: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TEHRAN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const start = Date.UTC(get("year"), get("month") - 1, get("day")) - TEHRAN_OFFSET_MS;
  return { start, end: start + DAY_MS };
}

// ---------------------------------------------------------------------------
// Phase-8 day window (topic / date-range parameters)
// ---------------------------------------------------------------------------

/**
 * The resolved day window a digest is built over.
 *
 * The window is the Tehran-aligned range
 * `[rangeStartMs, rangeStartMs + rangeDays * DAY_MS)`: tasks must fall
 * inside it, reminders must be due by its end, and (when a window was
 * explicitly requested) events must occur inside it, with daysUntil
 * measured from the anchor day.
 */
export interface DigestWindow {
  /** Anchor instant the window is measured from (`now()` when unshifted). */
  anchorMs: number;
  /** Window length in days, normalized to 1..7. */
  rangeDays: number;
  /** Start of the anchor's Tehran calendar day, unix ms. */
  rangeStartMs: number;
  /** Exclusive end of the window, unix ms (rangeStartMs + rangeDays days). */
  rangeEndMs: number;
  /**
   * True when the caller explicitly requested a window (anchorMs and/or
   * rangeDays present in deps). Two legacy behaviors hang off this flag so
   * the default digest stays byte-identical: with no explicit window,
   * events keep their 7-day horizon and usage keeps its rolling 24h
   * window; with one, events are bounded by the window and usage is
   * counted from the window start.
   */
  explicit: boolean;
}

/** Defensive range-length normalization for direct builder callers. */
function normalizeRangeDays(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 1;
  return Math.min(7, Math.max(1, Math.floor(raw)));
}

/**
 * Resolve the effective day window from deps. Defaults preserve the
 * pre-Phase-8 behavior exactly: anchor = now(), rangeDays = 1,
 * explicit = false.
 */
export function resolveDigestWindow(deps: DigestDeps, nowMs: number): DigestWindow {
  const anchorMs =
    deps.anchorMs !== undefined && Number.isFinite(deps.anchorMs) ? deps.anchorMs : nowMs;
  const rangeDays = normalizeRangeDays(deps.rangeDays);
  const { start } = tehranDayBounds(anchorMs);
  return {
    anchorMs,
    rangeDays,
    rangeStartMs: start,
    rangeEndMs: start + rangeDays * DAY_MS,
    explicit: deps.anchorMs !== undefined || deps.rangeDays !== undefined,
  };
}

function faTimeOf(ms: number): string {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: TEHRAN,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function enTimeOf(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEHRAN,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function fmtTimeOf(ms: number, locale: DigestLocale): string {
  return locale === "fa" ? faTimeOf(ms) : enTimeOf(ms);
}

/** Approximate USD amount, in the owner's language (fa keeps its exact voice). */
function fmtCost(usd: number, locale: DigestLocale): string {
  if (usd <= 0) return t("digest.cost.zero", "en");
  if (usd < 0.01) return t("digest.cost.tiny", "en");
  let amount: string;
  if (locale === "fa") {
    const digits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
    amount = usd
      .toFixed(2)
      .replace(/[0-9]/g, (d) => digits[Number(d)]!)
      .replace(".", "٫");
  } else {
    amount = usd.toFixed(2);
  }
  return t("digest.cost.value", "en", { amount });
}

// ---------------------------------------------------------------------------
// Section data gathering (language-neutral)
// ---------------------------------------------------------------------------

/**
 * Compose the digest sections as language-neutral data.
 *
 * Priority order: date header (always), the optional weather one-liner
 * (only when the weatherLine dep resolves to a line), the personalized
 * "what matters to you" focus, today's tasks, reminders, upcoming
 * events, curator proposals, usage, headlines (generic filler — first
 * to be trimmed), and
 * memories. Each section builder is guarded so a failing source is skipped
 * with a log line instead of killing the digest. After gathering,
 * applyItemBudget trims the lowest-priority item lists to MAX_DIGEST_ITEMS.
 */
export async function buildDigestData(deps: DigestDeps): Promise<DigestSectionData[]> {
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const window = resolveDigestWindow(deps, nowMs);
  const log = deps.log ?? (() => {});
  const sections: DigestSectionData[] = [];

  // --- Header: always present, never depends on storage. -------------------
  // The header reflects the anchor instant; rangeDays rides along only when
  // a window was explicitly requested, so the default section (and its
  // rendering) stays byte-identical to the pre-Phase-8 shape.
  sections.push({
    kind: "date",
    nowMs: window.anchorMs,
    ...(window.explicit ? { rangeDays: window.rangeDays } : {}),
  });

  // --- Weather one-liner (optional Phase-9 seam; never breaks the digest). --
  if (deps.weatherLine !== undefined) {
    try {
      const raw = await deps.weatherLine();
      const line = typeof raw === "string" ? oneLine(raw) : "";
      if (line.length > 0) sections.push({ kind: "weather", line: clip(line, 200) });
    } catch (err) {
      log(`digest: weather section skipped (${shortErr(err)})`);
    }
  }

  // --- "What matters to you": overdue, today, soon, interest matches. ------
  try {
    const s = focusData(deps, window);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: focus section skipped (${shortErr(err)})`);
  }

  // --- Today's scheduled tasks ----------------------------------------------
  try {
    sections.push(taskData(deps, window));
  } catch (err) {
    log(`digest: tasks section skipped (${shortErr(err)})`);
  }

  // --- Pending reminders due today ------------------------------------------
  try {
    const s = reminderData(deps, window);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: reminders section skipped (${shortErr(err)})`);
  }

  // --- Upcoming dated events (Phase-3 proactive memory) ----------------------
  try {
    const s = eventsData(deps, window);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: events section skipped (${shortErr(err)})`);
  }

  // --- Pending curator proposals ---------------------------------------------
  try {
    const s = proposalData(deps);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: proposals section skipped (${shortErr(err)})`);
  }

  // --- Yesterday's usage ------------------------------------------------------
  try {
    const s = usageData(deps, nowMs, window);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: usage section skipped (${shortErr(err)})`);
  }

  // --- Web headlines (untrusted external content) -----------------------------
  try {
    const s = await headlineData(deps);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: headlines section skipped (${shortErr(err)})`);
  }

  // --- Memory highlights -------------------------------------------------------
  try {
    const s = memoryData(deps);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: memories section skipped (${shortErr(err)})`);
  }

  return applyItemBudget(sections);
}

/**
 * Trim item lists to the global budget, lowest-priority sections first.
 *
 * Trim priority (first to lose items): headlines → memories → events →
 * reminders → tasks → focus. Focus and tasks keep at least one item when
 * they had any — focus is the personalized top, and tasks renders an empty
 * state when it genuinely has none, so trimming it to zero would lie.
 * Sections emptied by trimming are dropped, except tasks (its "nothing
 * scheduled" empty state is informative). Pure, for tests.
 */
export function applyItemBudget(
  sections: readonly DigestSectionData[],
  maxItems: number = MAX_DIGEST_ITEMS,
): DigestSectionData[] {
  const trimmed: DigestSectionData[] = sections.map(copySection);
  const TRIM_ORDER: DigestSectionKind[] = [
    "headlines",
    "memories",
    "events",
    "reminders",
    "tasks",
    "focus",
  ];
  const itemCount = (): number =>
    trimmed.reduce((n, s) => n + ("items" in s ? s.items.length : 0), 0);
  for (const kind of TRIM_ORDER) {
    for (const s of trimmed) {
      if (s.kind !== kind || !("items" in s)) continue;
      // Never trim the personalized top or the schedule below one item.
      const floor = s.kind === "focus" || s.kind === "tasks" ? 1 : 0;
      while (itemCount() > maxItems && s.items.length > floor) {
        s.items.pop();
      }
    }
  }
  return trimmed.filter((s) => {
    if (!("items" in s)) return true;
    if (s.kind === "tasks") return true; // keeps its empty state
    return s.items.length > 0;
  });
}

/** Shallow-copy a section so budget trimming never mutates the caller's data. */
function copySection(s: DigestSectionData): DigestSectionData {
  switch (s.kind) {
    case "focus":
      return { kind: "focus", items: [...s.items] };
    case "tasks":
      return { kind: "tasks", items: [...s.items] };
    case "reminders":
      return { kind: "reminders", items: [...s.items] };
    case "events":
      return { kind: "events", items: [...s.items] };
    case "headlines":
      return { kind: "headlines", items: [...s.items] };
    case "memories":
      return { kind: "memories", items: [...s.items] };
    default:
      return s;
  }
}

/**
 * Enabled scheduled tasks whose next run falls inside the day window
 * ([rangeStartMs, rangeEndMs) in Tehran bounds). With the default window
 * this is exactly "today's tasks", as before.
 */
function tasksInWindow(deps: DigestDeps, window: DigestWindow): DigestTaskItem[] {
  return deps.storage.scheduling
    .listTasks(deps.userId, 50)
    .filter(
      (task) =>
        task.enabled &&
        task.nextRunAtMs >= window.rangeStartMs &&
        task.nextRunAtMs < window.rangeEndMs,
    )
    .slice(0, 5)
    .map((task) => ({ id: task.id, name: task.name, runAtMs: task.nextRunAtMs }));
}

/** Always rendered (with an empty state when there is nothing). */
function taskData(deps: DigestDeps, window: DigestWindow): DigestSectionData {
  return { kind: "tasks", items: tasksInWindow(deps, window) };
}

/**
 * Pending reminders due by the end of the day window (Tehran), overdue
 * first. Overdue is flagged against the anchor instant (dueAt < anchorMs),
 * which is `now` for a default digest, exactly as before.
 */
function dueReminders(deps: DigestDeps, window: DigestWindow): DigestReminderItem[] {
  const items = deps.storage.scheduling
    .listReminders(deps.userId, 50)
    .filter((r) => r.dueAt <= window.rangeEndMs)
    .slice(0, 4)
    .map((r) => ({
      id: r.id,
      text: r.text,
      dueAt: r.dueAt,
      overdue: r.dueAt < window.anchorMs,
    }));
  items.sort((a, b) => Number(a.overdue) - Number(b.overdue) || a.dueAt - b.dueAt);
  return items;
}

/** Skipped when empty. */
function reminderData(deps: DigestDeps, window: DigestWindow): DigestSectionData | undefined {
  const items = dueReminders(deps, window);
  if (items.length === 0) return undefined;
  return { kind: "reminders", items };
}

/**
 * Dated events upcoming from the anchor day (Phase-3 proactive memory).
 * Raw list.
 *
 * Horizon: with no explicit window this keeps the legacy 7-day horizon
 * (daysUntil <= 7 measured from today). With an explicit window, events
 * must occur INSIDE the window: daysUntil is measured from the anchor day
 * and the last in-window day is rangeDays - 1, so the bound is
 * daysUntil > rangeDays - 1.
 */
function upcomingEvents(deps: DigestDeps, window: DigestWindow): DigestEventItem[] {
  const maxDaysUntil = window.explicit ? window.rangeDays - 1 : 7;
  const items: DigestEventItem[] = [];
  for (const m of deps.storage.memories.listMemories(deps.userId, 200)) {
    if (!m.key.startsWith(EVENT_KEY_PREFIX)) continue;
    let event: MemoryEvent;
    try {
      event = JSON.parse(m.content) as MemoryEvent;
    } catch {
      continue;
    }
    if (typeof event?.name !== "string" || typeof event?.labelFa !== "string") continue;
    const occ = nextOccurrence(event, window.anchorMs);
    if (occ === undefined || occ.daysUntil > maxDaysUntil) continue;
    items.push({
      name: oneLine(event.name).slice(0, 60),
      kindLabel: event.kind,
      labelFa: oneLine(event.labelFa).slice(0, 40),
      daysUntil: occ.daysUntil,
    });
  }
  items.sort((a, b) => a.daysUntil - b.daysUntil);
  return items.slice(0, 5);
}

/** Skipped when none.
 *
 * Events are stored as memories under the `event:` key prefix (see
 * src/memory/events.ts), so the digest reads them through the same
 * storage.listMemories call as the memory highlights — no new deps needed.
 * Malformed payloads are skipped; event content is rendered as plain text,
 * never interpreted.
 */
function eventsData(deps: DigestDeps, window: DigestWindow): DigestSectionData | undefined {
  const items = upcomingEvents(deps, window);
  if (items.length === 0) return undefined;
  return { kind: "events", items };
}

/** Pending curator proposals awaiting the owner's decision. Skipped when none. */
function proposalData(deps: DigestDeps): DigestSectionData | undefined {
  const count = deps.proposalStore.countPending(deps.userId);
  if (count === 0) return undefined;
  return { kind: "proposals", count };
}

/**
 * Usage totals, from the ledger (metadata only, never content).
 *
 * Default (no explicit window): the rolling last 24h, exactly as before.
 *
 * Explicit window: totals counted from the window start. APPROXIMATION,
 * stated honestly: UsageTracker.totals(userId, sinceMs) — like the
 * storage ledger query under it — supports only a lower bound; there is
 * no until/end parameter to bound the top of the window. A ranged digest
 * therefore reports "everything since the range start", which can
 * include usage after the range end when the anchor lies in the past. No
 * until bound is faked here; adding one would need a storage change
 * outside this unit's scope.
 */
function usageData(
  deps: DigestDeps,
  nowMs: number,
  window: DigestWindow,
): DigestSectionData | undefined {
  const tracker = new UsageTracker(deps.storage);
  const sinceMs = window.explicit ? window.rangeStartMs : nowMs - DAY_MS;
  const totals = tracker.totals(deps.userId, sinceMs);
  if (totals.runs === 0) return undefined;
  return {
    kind: "usage",
    runs: totals.runs,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    estimatedUsd: totals.estimatedUsd,
  };
}

/**
 * Web headlines, aimed at a one-off topic or the owner's interests.
 *
 * Phase-8 topic: when `deps.topic` is set (trimmed, non-empty), it wins
 * over everything else — a single `"<topic> news"` query with perQuery 3 —
 * so an explicitly requested topic is never diluted by saved interests.
 *
 * Otherwise, when interest topics exist in user_prefs
 * (`digest.interests`), each topic gets its own "<topic> news" query (up
 * to MAX_INTEREST_TOPICS) so the headlines are about what the owner cares
 * about instead of generic filler. Without topics, one generic query
 * keeps the old behavior.
 *
 * Fully defensive: missing resolver, timeout, empty results, and parse
 * failures all drop the section instead of failing the digest. The section
 * is explicitly labelled as EXTERNAL content so the owner never mistakes
 * third-party text for the bot's (or their own) words.
 */
async function headlineData(deps: DigestDeps): Promise<DigestSectionData | undefined> {
  if (deps.searchHeadlines === undefined) return undefined;
  const topic = deps.topic !== undefined ? oneLine(deps.topic).slice(0, 80) : "";
  const interests = topic.length > 0 ? [] : readInterests(deps);
  const queries =
    topic.length > 0
      ? [`${topic} news`]
      : interests.length > 0
        ? interests.map((t) => `${t} news`)
        : ["today's top headlines"];
  const perQuery = topic.length > 0 ? 3 : interests.length > 0 ? 2 : 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const seen = new Set<string>();
  const items: DigestHeadlineItem[] = [];
  let lastError: unknown;
  try {
    for (const query of queries) {
      let hits: readonly DigestHeadline[];
      try {
        hits = await deps.searchHeadlines(query, perQuery, controller.signal);
      } catch (err) {
        lastError = err;
        continue; // one bad query never kills the other topics
      }
      for (const h of hits) {
        if (items.length >= 3) break;
        const title = oneLine(h.title);
        if (title.length === 0) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const host = hostOf(h.url);
        items.push(host !== undefined ? { title, host } : { title });
      }
      if (items.length >= 3) break;
    }
  } finally {
    clearTimeout(timer);
  }
  if (items.length === 0) {
    // Nothing usable: propagate the failure so the caller logs the
    // skipped source (same contract as the old single-query path).
    if (lastError !== undefined) throw lastError;
    return undefined;
  }
  return { kind: "headlines", items };
}

/** Newest memories, excluding structured keys (they have their own sections). */
function recentMemories(deps: DigestDeps): DigestMemoryItem[] {
  return deps.storage.memories
    .listMemories(deps.userId, 10)
    .filter((m) => !m.key.startsWith(EVENT_KEY_PREFIX) && !m.key.startsWith(ARCHIVE_KEY_PREFIX))
    .slice(0, 3)
    .map((m) => ({ key: m.key, content: m.content }));
}

/** Newest 3 memories, as a gentle "on your mind" closer. Skipped when none. */
function memoryData(deps: DigestDeps): DigestSectionData | undefined {
  const items = recentMemories(deps);
  if (items.length === 0) return undefined;
  return { kind: "memories", items };
}

/**
 * Read the owner's interest topics from user_prefs (READ-ONLY — the digest
 * never writes preferences). The pref is a JSON array of strings under
 * `digest.interests`. Malformed values degrade to "no interests" so a bad
 * pref can never break the digest.
 */
function readInterests(deps: DigestDeps): string[] {
  let raw: string | undefined;
  try {
    raw = deps.storage.misc.getUserPref(deps.userId, DIGEST_INTERESTS_PREF_KEY);
  } catch {
    return [];
  }
  if (raw === undefined || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((s) => oneLine(s).slice(0, 40))
      .filter((s) => s.length >= 2)
      .slice(0, MAX_INTEREST_TOPICS);
  } catch {
    return [];
  }
}

/**
 * The "what matters to you" section — the personalized, time-aware top of
 * the digest.
 *
 * Priority order inside the section: overdue reminders first, then events
 * happening today, then tasks/reminders starting within FOCUS_SOON_MS
 * (soonest first), then items whose text mentions one of the owner's
 * interest topics. Capped at MAX_FOCUS_ITEMS; skipped (undefined) when
 * nothing qualifies, so a calm day keeps its friendly empty state.
 */
function focusData(deps: DigestDeps, window: DigestWindow): DigestSectionData | undefined {
  const interests = readInterests(deps);
  const tasks = tasksInWindow(deps, window);
  const reminders = dueReminders(deps, window);
  const events = upcomingEvents(deps, window);
  const memories = recentMemories(deps);
  // "Soon" and "today" are measured from the anchor instant, which is
  // `now` for a default digest — identical behavior, shifted on request.
  const nowMs = window.anchorMs;

  const items: DigestFocusItem[] = [];
  const usedRefs = new Set<string>();

  // 1. Overdue reminders — act now.
  for (const r of reminders) {
    if (!r.overdue) continue;
    items.push({ itemKind: "reminder", refId: r.id, text: r.text, reason: { type: "overdue" } });
    usedRefs.add(`reminder:${r.id}`);
  }

  // 2. Events happening today.
  for (const e of events) {
    if (e.daysUntil > 0) continue;
    items.push({ itemKind: "event", text: e.name, reason: { type: "today" } });
  }

  // 3. Tasks and reminders starting soon (soonest first).
  const soon: DigestFocusItem[] = [];
  for (const t of tasks) {
    if (t.runAtMs >= nowMs && t.runAtMs - nowMs <= FOCUS_SOON_MS) {
      soon.push({
        itemKind: "task",
        refId: t.id,
        text: t.name,
        reason: { type: "soon", atMs: t.runAtMs, verb: "starts at" },
      });
      usedRefs.add(`task:${t.id}`);
    }
  }
  for (const r of reminders) {
    if (!r.overdue && r.dueAt >= nowMs && r.dueAt - nowMs <= FOCUS_SOON_MS) {
      soon.push({
        itemKind: "reminder",
        refId: r.id,
        text: r.text,
        reason: { type: "soon", atMs: r.dueAt, verb: "due at" },
      });
      usedRefs.add(`reminder:${r.id}`);
    }
  }
  soon.sort((a, b) => atMsOf(a.reason) - atMsOf(b.reason));
  items.push(...soon);

  // 4. Interest matches: tasks/memories mentioning a saved topic, not
  //    already surfaced above. A deliberately simple substring match.
  for (const topic of interests) {
    if (items.length >= MAX_FOCUS_ITEMS) break;
    const needle = topic.toLowerCase();
    const candidates: Array<{ kind: "task" | "memory"; refId?: number; text: string }> = [
      ...tasks.map((t) => ({ kind: "task" as const, refId: t.id, text: t.name })),
      ...memories.map((m) => ({ kind: "memory" as const, text: m.content })),
    ];
    for (const c of candidates) {
      if (items.length >= MAX_FOCUS_ITEMS) break;
      const ref =
        c.kind === "task" ? `task:${c.refId}` : `memory:${oneLine(c.text).slice(0, 40)}`;
      if (usedRefs.has(ref)) continue;
      if (!oneLine(c.text).toLowerCase().includes(needle)) continue;
      usedRefs.add(ref);
      items.push({
        itemKind: c.kind,
        ...(c.refId !== undefined ? { refId: c.refId } : {}),
        text: c.text,
        reason: { type: "interest", topic },
      });
    }
  }

  const final = items.slice(0, MAX_FOCUS_ITEMS);
  if (final.length === 0) return undefined;
  return { kind: "focus", items: final };
}

function atMsOf(reason: DigestFocusReason): number {
  return reason.type === "soon" ? reason.atMs : 0;
}

function shortErr(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
}

// ---------------------------------------------------------------------------
// Per-language rendering
// ---------------------------------------------------------------------------

/** One line of "why this matters", in the digest locale (English UI). */
function focusReasonText(reason: DigestFocusReason, locale: DigestLocale): string {
  switch (reason.type) {
    case "overdue":
      return "⚠️ overdue";
    case "soon":
      return `⏰ ${reason.verb} ${fmtTimeOf(reason.atMs, locale)}`;
    case "today":
      return "📅 today";
    case "interest":
      return `📌 about "${reason.topic}"`;
  }
}

/** Render one section's title + body in English. Pure. */
export function renderDigestSection(
  section: DigestSectionData,
  locale: DigestLocale = "en",
): { title: string; body: string } {
  switch (section.kind) {
    case "date": {
      const { date, time, hour } = fmtDateTime(section.nowMs, locale);
      const body = t("digest.date.body", "en", { date, time });
      // Phase-8: a multi-day digest must not claim to be one day. The
      // range note is appended only when rangeDays > 1, so the default
      // header stays byte-identical. (Inline English, like the focus
      // title above: the i18n pack has no range key and is out of scope.)
      if (section.rangeDays === undefined || section.rangeDays <= 1) {
        return { title: `☀️ ${t(greetingKey(hour), "en")}!`, body };
      }
      const endMs = tehranDayBounds(section.nowMs).start + (section.rangeDays - 1) * DAY_MS;
      const endDate = fmtDateTime(endMs, locale).date;
      return {
        title: `☀️ ${t(greetingKey(hour), "en")}!`,
        body: `${body} Covering ${fmtNum(section.rangeDays, locale)} days: ${date} - ${endDate}.`,
      };
    }
    case "weather": {
      return { title: "🌤️ Weather", body: clip(section.line, 200) };
    }
    case "focus": {
      const lines = section.items.map(
        (item) => `• ${clip(item.text, 60)} — ${focusReasonText(item.reason, locale)}`,
      );
      return { title: FOCUS_SECTION_TITLE, body: lines.join("\n") };
    }
    case "tasks": {
      const title = t("digest.sec.tasks", "en");
      if (section.items.length === 0) {
        return { title, body: t("digest.tasks.empty", "en") };
      }
      const lines = section.items.map(
        (item) =>
          `• ${clip(item.name, 60)} — ${t("digest.tasks.time", "en", {
            time: fmtTimeOf(item.runAtMs, locale),
          })}`,
      );
      const head =
        section.items.length === 1
          ? t("digest.tasks.one", "en")
          : t("digest.tasks.many", "en", { count: fmtNum(section.items.length, locale) });
      return { title, body: `${head}\n${lines.join("\n")}` };
    }
    case "reminders": {
      const lines = section.items.map((item) => {
        const late = item.overdue ? t("digest.reminders.overdue", "en") : "";
        return `• ${clip(item.text, 90)} — ${fmtTimeOf(item.dueAt, locale)}${late}`;
      });
      return {
        title: t("digest.sec.reminders", "en"),
        body: `${t("digest.reminders.many", "en", {
          count: fmtNum(section.items.length, locale),
        })}\n${lines.join("\n")}`,
      };
    }
    case "events": {
      const lines = section.items.map((item) =>
        t("digest.events.line", "en", {
          kind: t(`events.kind.${item.kindLabel}`, "en"),
          name: clip(item.name, 60),
          label: item.labelFa,
          when:
            item.daysUntil <= 0
              ? t("events.when.today", "en")
              : item.daysUntil === 1
                ? t("events.when.tomorrow", "en")
                : t("events.when.days", "en", { count: fmtNum(item.daysUntil, locale) }),
        }),
      );
      const head =
        section.items.length === 1
          ? t("digest.events.one", "en")
          : t("digest.events.many", "en", { count: fmtNum(section.items.length, locale) });
      return { title: t("digest.sec.events", "en"), body: `${head}\n${lines.join("\n")}` };
    }
    case "proposals": {
      const body =
        section.count === 1
          ? t("digest.proposals.one", "en")
          : t("digest.proposals.many", "en", { count: fmtNum(section.count, locale) });
      return { title: t("digest.sec.proposals", "en"), body };
    }
    case "usage": {
      return {
        title: t("digest.sec.usage", "en"),
        body: t("digest.usage.body", "en", {
          runs: fmtNum(section.runs, locale),
          input: fmtNum(section.inputTokens, locale),
          output: fmtNum(section.outputTokens, locale),
          cost: fmtCost(section.estimatedUsd, locale),
        }),
      };
    }
    case "headlines": {
      const lines = section.items.map(
        (h) => `• ${clip(h.title, 110)}${h.host !== undefined ? ` (${h.host})` : ""}`,
      );
      return {
        title: t("digest.sec.headlines", "en"),
        body: `${t("digest.headlines.warn", "en")}\n${lines.join("\n")}`,
      };
    }
    case "memories": {
      const lines = section.items.map((m) => `• ${clip(m.content, 140)}`);
      return {
        title: t("digest.sec.memories", "en"),
        body: `${t("digest.memories.body", "en")}\n${lines.join("\n")}`,
      };
    }
  }
}

/**
 * Fit sections into the char budget: the date header always survives,
 * trailing sections are dropped first (headlines and memories are the least
 * critical). Pure, for tests and for the interactive renderer — the keyboard
 * is built from the SAME surviving list, so buttons never point at dropped
 * content.
 */
export function fitDigestSections(
  sections: readonly DigestSectionData[],
  locale: DigestLocale,
  maxChars: number,
): DigestSectionData[] {
  const kept: DigestSectionData[] = sections[0] !== undefined ? [sections[0]] : [];
  for (const s of sections.slice(1)) {
    const candidate = [...kept, s].map((d) => renderDigestSection(d, locale));
    if (joinExact(candidate, locale).length > maxChars) break;
    kept.push(s);
  }
  return kept;
}

/** Exact join of pre-rendered sections with the closer (no dropping). */
function joinExact(parts: ReadonlyArray<{ title: string; body: string }>, locale: DigestLocale): string {
  const rendered = parts.map((p) => `${p.title}\n${p.body}`);
  return `${rendered.join("\n\n")}\n\n${t("digest.closer", "en")}`;
}

/** Join pre-rendered section parts with the closer, enforcing the char cap. */
function joinDigestParts(
  parts: ReadonlyArray<{ title: string; body: string }>,
  locale: DigestLocale,
  maxChars: number,
): string {
  let text = joinExact(parts, locale);
  if (text.length > maxChars) {
    // Last resort for a pathological single section: hard cut.
    text = text.slice(0, maxChars - 1) + "…";
  }
  return text;
}

/**
 * Format section data into the final digest text, enforcing the char cap.
 * The interactive digest passes its own (larger) budget; the legacy text
 * digest keeps MAX_DIGEST_CHARS.
 */
export function renderDigestText(
  sections: readonly DigestSectionData[],
  locale: DigestLocale = "en",
  maxChars: number = MAX_DIGEST_CHARS,
): string {
  return joinDigestParts(
    fitDigestSections(sections, locale, maxChars).map((s) => renderDigestSection(s, locale)),
    locale,
    maxChars,
  );
}

// ---------------------------------------------------------------------------
// Legacy API (byte-identical shape, on top of the new core)
// ---------------------------------------------------------------------------

/** Compose the digest sections (English rendering, legacy shape). */
export async function buildDigest(deps: DigestDeps): Promise<DigestSection[]> {
  const data = await buildDigestData(deps);
  return data.map((s) => {
    const r = renderDigestSection(s, "en");
    return { titleFa: r.title, bodyFa: r.body };
  });
}

/**
 * Format sections into the final digest text, enforcing the char cap.
 *
 * Sections are appended until the budget runs out; the trailing sections are
 * dropped first (headlines and memories are the least critical), and the
 * date header always survives. A final hard cut guarantees the cap even if
 * one section is pathological.
 */
export function formatDigest(sections: DigestSection[]): string {
  return joinDigestParts(
    sections.map((s) => ({ title: s.titleFa, body: s.bodyFa })),
    "en",
    MAX_DIGEST_CHARS,
  );
}
