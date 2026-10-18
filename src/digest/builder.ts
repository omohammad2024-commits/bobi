/**
 * Morning digest builder — a proactive morning briefing (Stage-3
 * differentiator; Hermes has nothing like it).
 *
 * The builder composes a digest from REAL in-repo sources only:
 *  - date/time (Intl, Asia/Tehran)
 *  - today's scheduled tasks (Storage.listTasks)
 *  - pending reminders due today (Storage.listReminders)
 *  - pending curator proposals (ProposalStore.countPending)
 *  - yesterday's usage/cost (UsageTracker ledger)
 *  - 3 web headlines (injected search function, fully defensive)
 *  - newest 3 long-term memories (Storage.listMemories)
 *
 * Every section is built inside its own try/catch: one failing source is
 * logged and skipped, and can never kill the digest.
 *
 * BILINGUAL (Phase-2 item 3 — interactive digest): section gathering is
 * language-neutral (`buildDigestData`); text rendering is per-language
 * (`renderDigestSection`, `renderDigestText`) through the central i18n
 * packs, in the owner's `Lang`. The legacy Persian API (`buildDigest`,
 * `formatDigest`, `DigestSection`) is preserved byte-for-byte on top of the
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
import { t, type Lang } from "../i18n";

/** One rendered digest block (legacy Persian API): Persian title + Persian body. */
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
  /** Minimal proposal-store surface (the real ProposalStore satisfies it). */
  proposalStore: DigestProposalStore;
  /** Owner's user id (Telegram numeric id as string). All reads are scoped to it. */
  userId: string;
  /** Injectable clock, unix ms. Tests pass a fixed time. */
  now?: () => number;
  /** Optional web-search resolver. Omit it (or let it throw) to skip headlines. */
  searchHeadlines?: SearchHeadlinesFn;
  /** Diagnostic log for skipped/failed sources. Defaults to silent. */
  log?: (message: string) => void;
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
  | "tasks"
  | "reminders"
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

/** Language-neutral digest section data. Rendering is per-language. */
export type DigestSectionData =
  | { kind: "date"; nowMs: number }
  | { kind: "tasks"; items: DigestTaskItem[] }
  | { kind: "reminders"; items: DigestReminderItem[] }
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

function fmtNum(n: number, lang: Lang): string {
  return lang === "fa" ? faNum(n) : enNum(n);
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

function fmtDateTime(nowMs: number, lang: Lang): DigestDateTime {
  return lang === "fa" ? faDateTime(nowMs) : enDateTime(nowMs);
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

function fmtTimeOf(ms: number, lang: Lang): string {
  return lang === "fa" ? faTimeOf(ms) : enTimeOf(ms);
}

/** Approximate USD amount, in the owner's language (fa keeps its exact voice). */
function fmtCost(usd: number, lang: Lang): string {
  if (usd <= 0) return t("digest.cost.zero", lang);
  if (usd < 0.01) return t("digest.cost.tiny", lang);
  let amount: string;
  if (lang === "fa") {
    const digits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
    amount = usd
      .toFixed(2)
      .replace(/[0-9]/g, (d) => digits[Number(d)]!)
      .replace(".", "٫");
  } else {
    amount = usd.toFixed(2);
  }
  return t("digest.cost.value", lang, { amount });
}

// ---------------------------------------------------------------------------
// Section data gathering (language-neutral)
// ---------------------------------------------------------------------------

/**
 * Compose the digest sections as language-neutral data.
 *
 * Order: date header (always), tasks, reminders, curator proposals, usage,
 * headlines, memories. Each section builder is guarded so a failing source
 * is skipped with a log line instead of killing the digest.
 */
export async function buildDigestData(deps: DigestDeps): Promise<DigestSectionData[]> {
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const log = deps.log ?? (() => {});
  const sections: DigestSectionData[] = [];

  // --- Header: always present, never depends on storage. -------------------
  sections.push({ kind: "date", nowMs });

  // --- Today's scheduled tasks ----------------------------------------------
  try {
    sections.push(taskData(deps, nowMs));
  } catch (err) {
    log(`digest: tasks section skipped (${shortErr(err)})`);
  }

  // --- Pending reminders due today ------------------------------------------
  try {
    const s = reminderData(deps, nowMs);
    if (s) sections.push(s);
  } catch (err) {
    log(`digest: reminders section skipped (${shortErr(err)})`);
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
    const s = usageData(deps, nowMs);
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

  return sections;
}

/** Today's enabled scheduled tasks (next run inside the Tehran day). Always rendered. */
function taskData(deps: DigestDeps, nowMs: number): DigestSectionData {
  const { start, end } = tehranDayBounds(nowMs);
  const items = deps.storage
    .listTasks(deps.userId, 50)
    .filter((task) => task.enabled && task.nextRunAtMs >= start && task.nextRunAtMs < end)
    .slice(0, 5)
    .map((task) => ({ id: task.id, name: task.name, runAtMs: task.nextRunAtMs }));
  return { kind: "tasks", items };
}

/** Pending reminders due by end of today (Tehran), overdue first. Skipped when empty. */
function reminderData(deps: DigestDeps, nowMs: number): DigestSectionData | undefined {
  const { end } = tehranDayBounds(nowMs);
  const items = deps.storage
    .listReminders(deps.userId, 50)
    .filter((r) => r.dueAt <= end)
    .slice(0, 4)
    .map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt, overdue: r.dueAt < nowMs }));
  if (items.length === 0) return undefined;
  return { kind: "reminders", items };
}

/** Pending curator proposals awaiting the owner's decision. Skipped when none. */
function proposalData(deps: DigestDeps): DigestSectionData | undefined {
  const count = deps.proposalStore.countPending(deps.userId);
  if (count === 0) return undefined;
  return { kind: "proposals", count };
}

/** Usage over the last 24h, from the ledger (metadata only, never content). */
function usageData(deps: DigestDeps, nowMs: number): DigestSectionData | undefined {
  const tracker = new UsageTracker(deps.storage);
  const totals = tracker.totals(deps.userId, nowMs - DAY_MS);
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
 * Three web headlines.
 *
 * Fully defensive: missing resolver, timeout, empty results, and parse
 * failures all drop the section instead of failing the digest. The section
 * is explicitly labelled as EXTERNAL content so the owner never mistakes
 * third-party text for the bot's (or their own) words.
 */
async function headlineData(deps: DigestDeps): Promise<DigestSectionData | undefined> {
  if (deps.searchHeadlines === undefined) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let hits: readonly DigestHeadline[];
  try {
    hits = await deps.searchHeadlines("سرخط خبرهای امروز", 3, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  const items: DigestHeadlineItem[] = [];
  for (const h of hits.slice(0, 3)) {
    const title = oneLine(h.title);
    if (title.length === 0) continue;
    const host = hostOf(h.url);
    items.push(host !== undefined ? { title, host } : { title });
  }
  if (items.length === 0) return undefined;
  return { kind: "headlines", items };
}

/** Newest 3 memories, as a gentle "on your mind" closer. Skipped when none. */
function memoryData(deps: DigestDeps): DigestSectionData | undefined {
  const items = deps.storage
    .listMemories(deps.userId, 3)
    .map((m) => ({ key: m.key, content: m.content }));
  if (items.length === 0) return undefined;
  return { kind: "memories", items };
}

function shortErr(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
}

// ---------------------------------------------------------------------------
// Per-language rendering
// ---------------------------------------------------------------------------

/** Render one section's title + body in the owner's language. Pure. */
export function renderDigestSection(
  section: DigestSectionData,
  lang: Lang = "fa",
): { title: string; body: string } {
  switch (section.kind) {
    case "date": {
      const { date, time, hour } = fmtDateTime(section.nowMs, lang);
      return {
        title: `☀️ ${t(greetingKey(hour), lang)}!`,
        body: t("digest.date.body", lang, { date, time }),
      };
    }
    case "tasks": {
      const title = t("digest.sec.tasks", lang);
      if (section.items.length === 0) {
        return { title, body: t("digest.tasks.empty", lang) };
      }
      const lines = section.items.map(
        (item) =>
          `• ${clip(item.name, 60)} — ${t("digest.tasks.time", lang, {
            time: fmtTimeOf(item.runAtMs, lang),
          })}`,
      );
      const head =
        section.items.length === 1
          ? t("digest.tasks.one", lang)
          : t("digest.tasks.many", lang, { count: fmtNum(section.items.length, lang) });
      return { title, body: `${head}\n${lines.join("\n")}` };
    }
    case "reminders": {
      const lines = section.items.map((item) => {
        const late = item.overdue ? t("digest.reminders.overdue", lang) : "";
        return `• ${clip(item.text, 90)} — ${fmtTimeOf(item.dueAt, lang)}${late}`;
      });
      return {
        title: t("digest.sec.reminders", lang),
        body: `${t("digest.reminders.many", lang, {
          count: fmtNum(section.items.length, lang),
        })}\n${lines.join("\n")}`,
      };
    }
    case "proposals": {
      const body =
        section.count === 1
          ? t("digest.proposals.one", lang)
          : t("digest.proposals.many", lang, { count: fmtNum(section.count, lang) });
      return { title: t("digest.sec.proposals", lang), body };
    }
    case "usage": {
      return {
        title: t("digest.sec.usage", lang),
        body: t("digest.usage.body", lang, {
          runs: fmtNum(section.runs, lang),
          input: fmtNum(section.inputTokens, lang),
          output: fmtNum(section.outputTokens, lang),
          cost: fmtCost(section.estimatedUsd, lang),
        }),
      };
    }
    case "headlines": {
      const lines = section.items.map(
        (h) => `• ${clip(h.title, 110)}${h.host !== undefined ? ` (${h.host})` : ""}`,
      );
      return {
        title: t("digest.sec.headlines", lang),
        body: `${t("digest.headlines.warn", lang)}\n${lines.join("\n")}`,
      };
    }
    case "memories": {
      const lines = section.items.map((m) => `• ${clip(m.content, 140)}`);
      return {
        title: t("digest.sec.memories", lang),
        body: `${t("digest.memories.body", lang)}\n${lines.join("\n")}`,
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
  lang: Lang,
  maxChars: number,
): DigestSectionData[] {
  const kept: DigestSectionData[] = sections[0] !== undefined ? [sections[0]] : [];
  for (const s of sections.slice(1)) {
    const candidate = [...kept, s].map((d) => renderDigestSection(d, lang));
    if (joinExact(candidate, lang).length > maxChars) break;
    kept.push(s);
  }
  return kept;
}

/** Exact join of pre-rendered sections with the closer (no dropping). */
function joinExact(parts: ReadonlyArray<{ title: string; body: string }>, lang: Lang): string {
  const rendered = parts.map((p) => `${p.title}\n${p.body}`);
  return `${rendered.join("\n\n")}\n\n${t("digest.closer", lang)}`;
}

/** Join pre-rendered section parts with the closer, enforcing the char cap. */
function joinDigestParts(
  parts: ReadonlyArray<{ title: string; body: string }>,
  lang: Lang,
  maxChars: number,
): string {
  let text = joinExact(parts, lang);
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
  lang: Lang = "fa",
  maxChars: number = MAX_DIGEST_CHARS,
): string {
  return joinDigestParts(
    fitDigestSections(sections, lang, maxChars).map((s) => renderDigestSection(s, lang)),
    lang,
    maxChars,
  );
}

// ---------------------------------------------------------------------------
// Legacy Persian API (byte-identical, on top of the new core)
// ---------------------------------------------------------------------------

/** Compose the digest sections (Persian rendering, legacy shape). */
export async function buildDigest(deps: DigestDeps): Promise<DigestSection[]> {
  const data = await buildDigestData(deps);
  return data.map((s) => {
    const r = renderDigestSection(s, "fa");
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
    "fa",
    MAX_DIGEST_CHARS,
  );
}
