/**
 * build_digest — owner-only proactive Persian morning digest.
 *
 * Stage-3 differentiator: composes a morning briefing from real in-repo
 * sources (date, today's tasks, reminders due today, pending curator
 * proposals, yesterday's usage, 3 web headlines, newest memories) and returns
 * it as formatted Persian text. A scheduled_task (or the existing
 * `/blueprint run morning_digest` blueprint) calls this at 08:00 Asia/Tehran;
 * the scheduler's owner delivery carries the text to the owner's chat.
 *
 * OWNER-ONLY (twice, like usage_report): the `ownerOnly` flag keeps the
 * authorization bridge from granting the permission key to anyone else, and
 * run() re-checks ownership against a server-supplied predicate, so a
 * hand-built actor cannot slip through either. The digest aggregates the
 * owner's private data — tasks, reminders, memories, usage — so a non-owner
 * must never see it.
 *
 * The tool never names a chat: delivery is the scheduler's job, whose
 * scheduled_task creation is owner-only and whose "agent" action receives a
 * server-supplied chatId (the sender's own chat). There is no path for the
 * digest to reach anyone but the owner.
 *
 * Degrades gracefully: the builder wraps every source so one failing source
 * is logged and skipped, never failing the digest.
 *
 * PHASE-8 PARAMETERS (all optional; a bare {} call is exactly the old
 * morning digest):
 * - `topic`: headline topic for this digest only (max 80 chars). Trimmed;
 *   an explicitly empty/whitespace topic counts as ABSENT (documented
 *   choice — it is a steering hint, not data worth failing a digest over).
 *   A present topic overrides the owner's saved interests for the headline
 *   search (single "<topic> news" query, perQuery 3, in the builder).
 * - `date`: the anchor day — "YYYY-MM-DD" read as a Tehran calendar day
 *   (anchor = that day's Tehran midnight), or a full ISO instant. Anything
 *   else is invalid_input naming the expected format.
 * - `days`: range length in days starting at `date` (1..7, default 1).
 * When any parameter was given, the output echoes the effective values
 * (topic / date / days) next to `text` so the model can confirm what it
 * built; with no parameters the output is exactly { text }, as before.
 */
import { ProposalStore } from "../curator/proposals";
import { Storage } from "../storage/storage";
import type { SearchHeadlinesFn } from "../digest/builder";
import { buildDigest, DIGEST_CITY_PREF_KEY, formatDigest } from "../digest/builder";
import { fetchWeatherLine, type WeatherFetchFn } from "./weather";
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const BUILD_DIGEST_PERMISSION = "tools:build_digest";

export interface DigestToolDeps {
  storage: Storage;
  proposalStore: ProposalStore;
  /** Server-supplied owner check. The userId comes from the trusted actor. */
  isOwner: (userId: string) => boolean;
  /** Optional web-search resolver for the headlines section. Omit to skip it. */
  searchHeadlines?: SearchHeadlinesFn;
  /**
   * Injectable weather fetch for the digest weather line (tests). The
   * line itself is wired exactly like the /digest command path: only
   * when the owner's `digest.city` pref is set. Omit for the global fetch.
   */
  weatherFetchFn?: WeatherFetchFn;
  /** Injectable clock (unix ms), for deterministic tests. */
  now?: () => number;
  /** Diagnostic log for skipped/failed digest sources. */
  log?: (message: string) => void;
}

/** Optional Phase-8 inputs. Every field is optional; {} = today's digest. */
export interface DigestToolInput {
  /** Headline topic for this digest only (max 80 chars, trimmed). */
  topic?: string;
  /** Anchor day: "YYYY-MM-DD" (Tehran calendar day) or a full ISO instant. */
  date?: string;
  /** Range length in days from `date` (1..7, default 1). */
  days?: number;
}

export interface DigestToolOutput {
  /** Formatted Persian digest, capped for a Telegram message. */
  text: string;
  /** Echoed when a topic was given (the trimmed value actually used). */
  topic?: string;
  /** Echoed when a date was given (the caller's string, trimmed). */
  date?: string;
  /** Echoed when a date and/or days were given (the effective range length). */
  days?: number;
}

/** Plugin discovery manifest for `build_digest`. */
export const buildDigestManifest: ToolManifest = defineManifest({
  id: "build_digest",
  version: "1.0.0",
  title: "Build Digest",
  description: "Morning digest: today's work, reminders, usage, headlines and memories (owner only). Optional topic and date/days range focus it.",
  purpose: "topic/date-range digest",
  useWhen: "digest/topic/date asked",
  doNotUseWhen: "Group chat summary — group_digest covers group activity; this is the owner's personal morning briefing only.",
  confusableWith: [
    { tool: "group_digest", difference: "group_digest summarizes group chat activity; build_digest briefs the owner on tasks, reminders and usage." },
    { tool: "usage_report", difference: "usage_report is usage stats only; build_digest adds tasks, reminders, headlines and memories." },
  ],
  latencyTier: "seconds",
  outputSummary: "Returns the digest text; echoes topic/date/days when given.",
  category: "system",
  triggers: { keywordPatterns: ["دایجست", "خلاصه صبح", "morning digest", "daily digest"] },
  costTier: "cheap",
});

/** Iran has no DST since 2022: Tehran is a fixed UTC+3:30. */
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

const DATE_FORMAT_HINT =
  "Invalid date: expected YYYY-MM-DD (a Tehran calendar day) or a full ISO instant.";

/** Gregorian calendar validity (ISO dates are Gregorian; Feb 30 never rolls over here). */
function isValidGregorianDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

/**
 * Parse the `date` input into an anchor instant (unix ms).
 *
 * - "YYYY-MM-DD" is a Tehran calendar day: the anchor is that day's
 *   Tehran midnight, so the builder's Tehran day bounds land exactly on
 *   the requested day.
 * - A full ISO instant is taken as-is.
 * Components are validated numerically because Date.parse silently rolls
 * overflows over (e.g. "2026-02-30" parses as March 2) — an overflowed
 * date is invalid_input here, never a silently different digest.
 * Throws ToolError("invalid_input") naming the expected format.
 */
function parseDigestDate(raw: unknown): number {
  if (typeof raw !== "string") {
    throw new ToolError("invalid_input", DATE_FORMAT_HINT);
  }
  const value = raw.trim();
  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!isValidGregorianDate(year, month, day)) {
      throw new ToolError("invalid_input", DATE_FORMAT_HINT, { date: value });
    }
    return Date.UTC(year, month - 1, day) - TEHRAN_OFFSET_MS;
  }
  const instant = ISO_INSTANT_RE.exec(value);
  if (instant !== null) {
    const year = Number(instant[1]);
    const month = Number(instant[2]);
    const day = Number(instant[3]);
    const hour = Number(instant[4]);
    const minute = Number(instant[5]);
    const second = instant[6] !== undefined ? Number(instant[6]) : 0;
    if (
      isValidGregorianDate(year, month, day) &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59
    ) {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  throw new ToolError("invalid_input", DATE_FORMAT_HINT, { date: value.slice(0, 64) });
}

/**
 * Normalize the `topic` input: returns the topic to use, or undefined when
 * absent. An explicitly empty/whitespace topic counts as absent (see the
 * module header for the documented choice); a non-string or over-long
 * topic is invalid_input.
 */
function normalizeTopic(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ToolError("invalid_input", "topic must be a string.");
  }
  if (raw.length > 80) {
    throw new ToolError("invalid_input", "topic must be at most 80 characters.");
  }
  const topic = raw.replace(/\s+/g, " ").trim();
  return topic.length === 0 ? undefined : topic;
}

/** Validate the `days` input (the Executor's field spec also bounds it). */
function normalizeDays(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 7) {
    throw new ToolError("invalid_input", "days must be an integer between 1 and 7.");
  }
  return raw;
}

export function createDigestTool(deps: DigestToolDeps): Tool<DigestToolInput, DigestToolOutput> {
  return {
    name: "build_digest",
    manifest: buildDigestManifest,
    description:
      "Morning digest: today's work, reminders, usage, headlines and memories (owner only). Optional topic and date/days range focus it.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [BUILD_DIGEST_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        topic: {
          type: "string",
          description: "Optional headline topic (max 80 chars); overrides saved interests.",
          maxLength: 80,
        },
        date: {
          type: "string",
          description: "Optional anchor: YYYY-MM-DD (Tehran day) or a full ISO instant.",
          maxLength: 64,
        },
        days: {
          type: "integer",
          description: "Optional range length in days from date (1-7, default 1).",
          minimum: 1,
          maximum: 7,
        },
      },
    },

    async run(input: DigestToolInput, ctx: ToolContext): Promise<DigestToolOutput> {
      const userId = ctx.actor.userId;
      if (typeof userId !== "string" || userId.length === 0 || userId === "unknown") {
        throw new ToolError("not_allowed", "Identity is unknown.");
      }
      if (!deps.isOwner(userId)) {
        throw new ToolError("not_allowed", "The morning digest is owner only.");
      }

      // Phase-8 parameters, validated here as defence in depth: the
      // Executor's field spec bounds them first, but a direct caller
      // bypassing validation gets the same invalid_input contract.
      const topic = normalizeTopic(input.topic);
      const daysGiven = normalizeDays(input.days);
      const hasDate = input.date !== undefined;
      const anchorMs = hasDate ? parseDigestDate(input.date) : undefined;
      const hasRange = hasDate || daysGiven !== undefined;
      const effectiveDays = daysGiven ?? 1;

      // Phase 9 seam, same wiring as the /digest command path: the
      // weather line exists only when the owner has set a `digest.city`
      // pref — no location is ever guessed, and fetchWeatherLine
      // resolves to undefined on any failure, so the digest simply
      // omits the section.
      const city = deps.storage.getUserPref(userId, DIGEST_CITY_PREF_KEY)?.trim() ?? "";

      const sections = await buildDigest({
        storage: deps.storage,
        proposalStore: deps.proposalStore,
        userId,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.searchHeadlines !== undefined ? { searchHeadlines: deps.searchHeadlines } : {}),
        ...(deps.log !== undefined ? { log: deps.log } : {}),
        ...(topic !== undefined ? { topic } : {}),
        ...(anchorMs !== undefined ? { anchorMs } : {}),
        ...(hasRange ? { rangeDays: effectiveDays } : {}),
        ...(city.length > 0
          ? { weatherLine: () => fetchWeatherLine(deps.weatherFetchFn, city) }
          : {}),
      });
      const out: DigestToolOutput = { text: formatDigest(sections) };
      if (topic !== undefined) out.topic = topic;
      if (hasDate) out.date = (input.date as string).trim();
      if (hasRange) out.days = effectiveDays;
      return out;
    },
  };
}
