/**
 * Morning digest builder — a proactive Persian morning briefing (Stage-3
 * differentiator; Hermes has nothing like it).
 *
 * The builder composes a digest from REAL in-repo sources only:
 *  - Persian date/time (Intl "fa-IR", Asia/Tehran)
 *  - today's scheduled tasks (Storage.listTasks)
 *  - pending reminders due today (Storage.listReminders)
 *  - pending curator proposals (ProposalStore.countPending)
 *  - yesterday's usage/cost (UsageTracker ledger)
 *  - 3 web headlines (injected search function, fully defensive)
 *  - newest 3 long-term memories (Storage.listMemories)
 *
 * Every section is built inside its own try/catch: one failing source is
 * logged and skipped, and can never kill the digest. The formatted digest is
 * capped at MAX_DIGEST_CHARS so it always fits a Telegram message.
 *
 * SECURITY (attack-surface review):
 * - The digest aggregates the OWNER's private data (tasks, reminders,
 *   memories, usage). It must only ever be delivered to the owner's chat.
 *   The tool layer enforces this twice (ownerOnly + run()-level isOwner
 *   check); the delivery path is the scheduler's owner delivery — see
 *   docs/phase-digest.md and src/tools/digest_tool.ts.
 * - Web headlines are UNTRUSTED third-party text. They are rendered in a
 *   clearly labelled "external content" section, never presented as the
 *   owner's own data, and URLs are reduced to their hostname so a query
 *   string carrying a session id or token can never leak into the chat
 *   (the same scrub instinct as /debug's secret scrubbing).
 * - No secrets: sources here never include credentials, and the builder
 *   never logs section content at a level above a short failure note.
 */
import { ProposalStore } from "../curator/proposals";
import { Storage } from "../storage/storage";
import { UsageTracker } from "../ai/usage";

/** One rendered digest block: Persian title + Persian body. */
export interface DigestSection {
  titleFa: string;
  bodyFa: string;
}

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
  proposalStore: ProposalStore;
  /** Owner's user id (Telegram numeric id as string). All reads are scoped to it. */
  userId: string;
  /** Injectable clock, unix ms. Tests pass a fixed time. */
  now?: () => number;
  /** Optional web-search resolver. Omit it (or let it throw) to skip headlines. */
  searchHeadlines?: SearchHeadlinesFn;
  /** Diagnostic log for skipped/failed sources. Defaults to silent. */
  log?: (message: string) => void;
}

/** Hard cap on the formatted digest, sized for a Telegram message. */
export const MAX_DIGEST_CHARS = 2500;

const TEHRAN = "Asia/Tehran";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Iran has no DST since 2022: Tehran is a fixed UTC+3:30. */
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/** Persian digits for every number the owner reads. */
function faNum(n: number): string {
  return new Intl.NumberFormat("fa-IR").format(Math.round(n));
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

function faDateTime(nowMs: number): { date: string; time: string; hour: number } {
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

function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "صبح بخیر";
  if (hour >= 12 && hour < 17) return "ظهر بخیر";
  if (hour >= 17 && hour < 21) return "عصر بخیر";
  return "شب بخیر";
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

function faTimeOf(ms: number): string {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: TEHRAN,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** Format an approximate USD amount in Persian (same voice as usage_report). */
function faCost(usd: number): string {
  if (usd <= 0) return "۰ دلار";
  if (usd < 0.01) return "کمتر از ۰٫۰۱ دلار";
  const digits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  return `${usd
    .toFixed(2)
    .replace(/[0-9]/g, (d) => digits[Number(d)]!)
    .replace(".", "٫")} دلار`;
}

/**
 * Compose the digest sections.
 *
 * Order: date header (always), tasks, reminders, curator proposals, usage,
 * headlines, memories. Each section builder is guarded so a failing source
 * is skipped with a log line instead of killing the digest.
 */
export async function buildDigest(deps: DigestDeps): Promise<DigestSection[]> {
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const log = deps.log ?? (() => {});
  const sections: DigestSection[] = [];

  // --- Header: always present, never depends on storage. -------------------
  sections.push(dateSection(nowMs));

  // --- Today's scheduled tasks ----------------------------------------------
  try {
    const s = taskSection(deps, nowMs);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: tasks section skipped (${shortErr(err)})`);
  }

  // --- Pending reminders due today ------------------------------------------
  try {
    const s = reminderSection(deps, nowMs);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: reminders section skipped (${shortErr(err)})`);
  }

  // --- Pending curator proposals ---------------------------------------------
  try {
    const s = proposalSection(deps);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: proposals section skipped (${shortErr(err)})`);
  }

  // --- Yesterday's usage ------------------------------------------------------
  try {
    const s = usageSection(deps, nowMs);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: usage section skipped (${shortErr(err)})`);
  }

  // --- Web headlines (untrusted external content) -----------------------------
  try {
    const s = await headlineSection(deps, nowMs);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: headlines section skipped (${shortErr(err)})`);
  }

  // --- Memory highlights -------------------------------------------------------
  try {
    const s = memorySection(deps);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: memories section skipped (${shortErr(err)})`);
  }

  return sections;
}

/** Date header: greeting + full Persian date + Tehran time. */
function dateSection(nowMs: number): DigestSection {
  const { date, time, hour } = faDateTime(nowMs);
  return {
    titleFa: `☀️ ${greeting(hour)}!`,
    bodyFa: `امروز ${date} است — ساعت ${time} به وقت تهران.`,
  };
}

/** Today's enabled scheduled tasks (next run inside the Tehran day). Always rendered. */
function taskSection(deps: DigestDeps, nowMs: number): DigestSection {
  const { start, end } = tehranDayBounds(nowMs);
  const today = deps.storage
    .listTasks(deps.userId, 50)
    .filter((t) => t.enabled && t.nextRunAtMs >= start && t.nextRunAtMs < end)
    .slice(0, 5);

  if (today.length === 0) {
    return {
      titleFa: "✅ کارهای امروز",
      bodyFa: "امروز کار زمان‌بندی‌شده‌ای نداری؛ روز آرومی پیش روئه.",
    };
  }

  const lines = today.map((t) => `• ${clip(t.name, 60)} — ساعت ${faTimeOf(t.nextRunAtMs)}`);
  return {
    titleFa: "✅ کارهای امروز",
    bodyFa:
      today.length === 1
        ? `یک کار زمان‌بندی‌شده داری:\n${lines.join("\n")}`
        : `${faNum(today.length)} کار زمان‌بندی‌شده داری:\n${lines.join("\n")}`,
  };
}

/** Pending reminders due by end of today (Tehran), overdue first. Skipped when empty. */
function reminderSection(deps: DigestDeps, nowMs: number): DigestSection | undefined {
  const { end } = tehranDayBounds(nowMs);
  const due = deps.storage
    .listReminders(deps.userId, 50)
    .filter((r) => r.dueAt <= end)
    .slice(0, 4);
  if (due.length === 0) return undefined;

  const lines = due.map((r) => {
    const late = r.dueAt < nowMs ? " (عقب‌افتاده)" : "";
    return `• ${clip(r.text, 90)} — ${faTimeOf(r.dueAt)}${late}`;
  });
  return {
    titleFa: "⏰ یادآورها",
    bodyFa: `${faNum(due.length)} یادآور برای امروز داری:\n${lines.join("\n")}`,
  };
}

/** Pending curator proposals awaiting the owner's decision. Skipped when none. */
function proposalSection(deps: DigestDeps): DigestSection | undefined {
  const count = deps.proposalStore.countPending(deps.userId);
  if (count === 0) return undefined;
  return {
    titleFa: "🧠 پیشنهادهای حافظه",
    bodyFa:
      count === 1
        ? "یک پیشنهاد برای مرتب‌سازی حافظه‌ات منتظر تصمیم توئه."
        : `${faNum(count)} پیشنهاد برای مرتب‌سازی حافظه‌ات منتظر تصمیم توئه؛ هر وقت خواستی بررسی‌شون کن.`,
  };
}

/** Usage over the last 24h, from the ledger (metadata only, never content). */
function usageSection(deps: DigestDeps, nowMs: number): DigestSection | undefined {
  const tracker = new UsageTracker(deps.storage);
  const t = tracker.totals(deps.userId, nowMs - DAY_MS);
  if (t.runs === 0) return undefined;
  return {
    titleFa: "📊 مصرف ۲۴ ساعت اخیر",
    bodyFa:
      `• درخواست‌ها: ${faNum(t.runs)} — توکن ورودی: ${faNum(t.inputTokens)}، خروجی: ${faNum(t.outputTokens)}\n` +
      `• هزینهٔ تقریبی: ${faCost(t.estimatedUsd)} (تخمینی، نه صورتحساب)`,
  };
}

/**
 * Three web headlines.
 *
 * Fully defensive: missing resolver, timeout, empty results, and parse
 * failures all drop the section instead of failing the digest. The section
 * is explicitly labelled as EXTERNAL content so the owner never mistakes
 * third-party text for the bot's (or their own) words.
 */
async function headlineSection(
  deps: DigestDeps,
  _nowMs: number,
): Promise<DigestSection | undefined> {
  if (deps.searchHeadlines === undefined) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let hits: readonly DigestHeadline[];
  try {
    hits = await deps.searchHeadlines("سرخط خبرهای امروز", 3, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  const items = hits
    .slice(0, 3)
    .map((h) => ({ title: oneLine(h.title), host: hostOf(h.url) }))
    .filter((h) => h.title.length > 0);
  if (items.length === 0) return undefined;

  const lines = items.map(
    (h) => `• ${clip(h.title, 110)}${h.host !== undefined ? ` (${h.host})` : ""}`,
  );
  return {
    titleFa: "📰 سرخط خبرها — محتوای بیرونی",
    bodyFa: `⚠️ این‌ها از جستجوی وب آمده‌اند و حرف من نیستند:\n${lines.join("\n")}`,
  };
}

/** Newest 3 memories, as a gentle "on your mind" closer. Skipped when none. */
function memorySection(deps: DigestDeps): DigestSection | undefined {
  const mems = deps.storage.listMemories(deps.userId, 3);
  if (mems.length === 0) return undefined;
  const lines = mems.map((m) => `• ${clip(m.content, 140)}`);
  return {
    titleFa: "💭 از حافظه‌ات",
    bodyFa: `تازه‌ترین چیزهایی که سپردی به من:\n${lines.join("\n")}`,
  };
}

function shortErr(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
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
  const header = sections[0];
  const rest = sections.slice(1);
  const kept: DigestSection[] = header !== undefined ? [header] : [];
  for (const s of rest) {
    const candidate = render([...kept, s]);
    if (candidate.length > MAX_DIGEST_CHARS) break;
    kept.push(s);
  }
  let text = render(kept);
  if (text.length > MAX_DIGEST_CHARS) {
    text = text.slice(0, MAX_DIGEST_CHARS - 1) + "…";
  }
  return text;
}

function render(sections: DigestSection[]): string {
  const parts = sections.map((s) => `${s.titleFa}\n${s.bodyFa}`);
  return `${parts.join("\n\n")}\n\nروز خوبی داشته باشی ✨`;
}
