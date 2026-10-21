/**
 * Phase-3 item 2 — opt-in group assistant mode (Stage-3 differentiator).
 *
 * What this is: a per-group assistant mode, strictly opt-in and default OFF.
 * When the owner enables it for a group:
 *
 * 1. The bot stays silent on ordinary group chatter and answers ONLY when
 *    mentioned (@Bobi_Agentbot) or replied to (see shouldReplyAssistant).
 * 2. `/gsummary` gives a short deterministic summary of recent discussion
 *    (no LLM: statistics + top words — see buildSummaryText).
 * 3. `/gpoll "سوال" "گزینه۱" "گزینه۲" ...` creates a native Telegram poll.
 * 4. Phase-4: `/gassistant digest on|off|status|time HH:MM` schedules a DAILY
 *    digest of the group's discussion, delivered to the OWNER's private chat
 *    (never posted into the group). Content is the same deterministic
 *    summary (no LLM); scheduling is delegated to the coordinator's
 *    DigestSchedulePort (see group_digest.ts) so this module never touches
 *    the task table directly.
 * 5. Phase-5: `/gassistant smart on|off|status` toggles the OPT-IN LLM
 *    smart-summary layer (default OFF, requires assistant mode AND a wired
 *    AI provider). When ON, the OWNER's `/gsummary` and the scheduled
 *    digest may additionally request an LLM summary (see
 *    smart_summary.ts — injection-hardened via structural isolation).
 *    The smart section is served ONLY to the owner (their explicit group
 *    request, or the digest DM); non-owners always get the deterministic
 *    summary and never learn the layer exists.
 *
 * Trust pattern mirrors src/moderation/config.ts exactly:
 * - Owner-scoped storage: config lives in `user_prefs` under the OWNER's user
 *   id with key `gacfg:<chatId>` (not under a group id, not under the
 *   requester's id). Only the owner may write it; handlers re-check ownership
 *   server-side as defense in depth (the coordinator ALSO gates at
 *   registration — gates live outside this file).
 * - Default-off: a missing/corrupt blob reads as the disabled default.
 * - Strict validation: unknown fields rejected, numbers bounded.
 *
 * ATTACK-SURFACE REVIEW (part of the module contract):
 *
 * 1. A group member cannot enable the mode: writes go to the owner's pref
 *    row and every mutating handler re-checks `isOwner(userId)` (default:
 *    strict equality with the injected owner id — never from message text,
 *    usernames, or callback data).
 * 2. A group member cannot read owner config: no command renders config to a
 *    non-owner; /gassistant status is owner-gated, and the config is never
 *    echoed into summaries or polls.
 * 3. Group messages are UNTRUSTED input to the summarizer. There is no LLM
 *    in this module, so embedded instructions have nothing to steer — the
 *    summary is a fixed statistical template (counts, top speakers, top
 *    words). Inputs are hard-capped (MAX_MESSAGE_CHARS per message,
 *    SUMMARY_INPUT_MAX_MESSAGES per summary) so a flood cannot blow up the
 *    summary. Display names are sanitized (newlines/tabs stripped, truncated
 *    to 24 chars) so a hostile display name cannot break the message layout
 *    or impersonate a bot line. Raw message content is never quoted verbatim
 *    (only single extracted words are listed).
 * 4. No exfiltration: the history buffer is in-memory only (never persisted,
 *    cleared on restart, per-chat keyed), and summaries are returned to the
 *    caller for posting INSIDE the group — this module never sends anything
 *    to the owner or any other chat. Only the coordinator's wiring decides
 *    where replies go, and it must only reply in the source group.
 * 5. Poll text is the owner's own command argument (owner-gated), passed
 *    through to Telegram unchanged; bounds follow Telegram's limits
 *    (question ≤ 300 chars, option ≤ 100 chars, 2–10 options).
 *
 * What this file does NOT do (coordinator wires at integration):
 * - register bot commands or Telegram menu entries,
 * - touch the message:text middleware (the coordinator adds the
 *   shouldReplyAssistant + recordGroupMessage hooks there),
 * - touch src/index.ts / src/bot/bot.ts.
 */
import type { MiscRepo } from "../storage/repos/misc";
import { formatNum, formatTime } from "../i18n/strings/panel_strings";
import { tr, type AssistantLang } from "../i18n/strings/assistant_strings";
import { summarizeSmart, type SmartSummaryPort } from "./smart_summary";
import type { AssistantConfig, GroupChatMessage } from "./types";

export type { AssistantConfig, GroupChatMessage } from "./types";

// ---------------------------------------------------------------- config ----

/* AssistantConfig is defined in ./types (leaf module, platform
 * Phase 5) and re-exported above, so existing imports from
 * ./assistant keep working. */

export const DEFAULT_ASSISTANT_CONFIG: Readonly<AssistantConfig> = {
  enabled: false,
  replyOnlyWhenCalled: true,
  summaryMaxMessages: 30,
  pollsAllowed: true,
  digestEnabled: false,
  digestTime: "08:00",
  smartSummary: false,
};

export const SUMMARY_MAX_MESSAGES_MIN = 5;
export const SUMMARY_MAX_MESSAGES_MAX = 50;

/**
 * Storage key for a group's assistant config. The owner id is the `user_id`
 * row key; the chat id only scopes which group's policy this row holds.
 */
export function assistantConfigKey(chatId: string): string {
  return `gacfg:${chatId}`;
}

export type AssistantConfigValidation =
  | { ok: true; config: AssistantConfig }
  | { ok: false; errors: string[] };

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "enabled",
  "replyOnlyWhenCalled",
  "summaryMaxMessages",
  "pollsAllowed",
  "digestEnabled",
  "digestTime",
  "smartSummary",
]);

/** "HH:MM" 24-hour clock, e.g. "08:00", "21:30". */
const DIGEST_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= min &&
    v <= max
  );
}

export function validateAssistantConfig(
  input: unknown,
  base: AssistantConfig = { ...DEFAULT_ASSISTANT_CONFIG },
): AssistantConfigValidation {
  const errors: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["config must be an object"] };
  }
  const patch = input as Record<string, unknown>;

  for (const key of Object.keys(patch)) {
    if (!KNOWN_FIELDS.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  const next: AssistantConfig = { ...base };

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") errors.push("enabled must be boolean");
    else next.enabled = patch.enabled;
  }
  if (patch.replyOnlyWhenCalled !== undefined) {
    if (typeof patch.replyOnlyWhenCalled !== "boolean")
      errors.push("replyOnlyWhenCalled must be boolean");
    else next.replyOnlyWhenCalled = patch.replyOnlyWhenCalled;
  }
  if (patch.pollsAllowed !== undefined) {
    if (typeof patch.pollsAllowed !== "boolean")
      errors.push("pollsAllowed must be boolean");
    else next.pollsAllowed = patch.pollsAllowed;
  }
  if (patch.summaryMaxMessages !== undefined) {
    if (
      !isIntInRange(patch.summaryMaxMessages, SUMMARY_MAX_MESSAGES_MIN, SUMMARY_MAX_MESSAGES_MAX)
    ) {
      errors.push(
        `summaryMaxMessages must be an integer ${SUMMARY_MAX_MESSAGES_MIN}..${SUMMARY_MAX_MESSAGES_MAX}`,
      );
    } else {
      next.summaryMaxMessages = patch.summaryMaxMessages;
    }
  }
  if (patch.digestEnabled !== undefined) {
    if (typeof patch.digestEnabled !== "boolean")
      errors.push("digestEnabled must be boolean");
    else next.digestEnabled = patch.digestEnabled;
  }
  if (patch.digestTime !== undefined) {
    if (typeof patch.digestTime !== "string" || !DIGEST_TIME_RE.test(patch.digestTime.trim())) {
      errors.push('digestTime must be "HH:MM" 24-hour, e.g. "08:00"');
    } else {
      next.digestTime = patch.digestTime.trim();
    }
  }
  if (patch.smartSummary !== undefined) {
    if (typeof patch.smartSummary !== "boolean")
      errors.push("smartSummary must be boolean");
    else next.smartSummary = patch.smartSummary;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: next };
}

/** Minimal pref-store surface this module needs; the Misc repo satisfies it. */
export type AssistantPrefStore = Pick<MiscRepo, "getUserPref" | "setUserPref">;

/**
 * Read a group's assistant config.
 *
 * Fail-closed: missing row, unparseable JSON, or a blob that no longer
 * validates yields the default (disabled) config. Corrupt state can never
 * silently turn assistant mode on.
 */
export function getAssistantConfig(
  store: AssistantPrefStore | undefined,
  ownerId: string,
  chatId: string,
): AssistantConfig {
  if (store === undefined || ownerId.length === 0) return { ...DEFAULT_ASSISTANT_CONFIG };
  let raw: string | undefined;
  try {
    raw = store.getUserPref(ownerId, assistantConfigKey(chatId));
  } catch {
    return { ...DEFAULT_ASSISTANT_CONFIG };
  }
  if (raw === undefined) return { ...DEFAULT_ASSISTANT_CONFIG };
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = validateAssistantConfig(parsed);
    return validated.ok ? validated.config : { ...DEFAULT_ASSISTANT_CONFIG };
  } catch {
    return { ...DEFAULT_ASSISTANT_CONFIG };
  }
}

/**
 * Persist a group's assistant config (owner-only by construction: callers
 * must pass the bot owner's id and gate the call behind an owner check).
 *
 * Returns the validation result; NOTHING is written when validation fails.
 */
export function setAssistantConfig(
  store: AssistantPrefStore | undefined,
  ownerId: string,
  chatId: string,
  patch: unknown,
): AssistantConfigValidation {
  if (store === undefined || ownerId.length === 0) {
    return { ok: false, errors: ["storage or owner id unavailable"] };
  }
  const current = getAssistantConfig(store, ownerId, chatId);
  const validated = validateAssistantConfig(patch, current);
  if (!validated.ok) return validated;
  store.setUserPref(ownerId, assistantConfigKey(chatId), JSON.stringify(validated.config));
  return validated;
}

// ------------------------------------------------------ history buffer ----

/* GroupChatMessage is defined in ./types (leaf module, platform
 * Phase 5) and re-exported at the top of this module. */

/** A single message is never stored longer than this (chars). */
export const MAX_MESSAGE_CHARS = 2_000;
/** A summary never reads more messages than this, even if config allows more. */
export const SUMMARY_INPUT_MAX_MESSAGES = 50;

export interface GroupHistory {
  record(msg: GroupChatMessage): void;
  /** Newest-first? No — oldest→newest slice of the last n messages. */
  recent(chatId: string, n: number): GroupChatMessage[];
  count(chatId: string): number;
}

/**
 * In-memory per-group message buffer for /gsummary.
 *
 * Deliberately NOT persisted: on restart the buffer is empty until chatter
 * refills it. Group content stays in process memory only — no long-term
 * retention, no cross-group reads (keyed by chatId), and no send to anyone
 * but the source group. Command texts ("/...") are skipped — they are bot
 * control, not discussion.
 */
export function createGroupHistory(
  maxMessagesPerGroup = 100,
  maxGroups = 100,
): GroupHistory {
  const groups = new Map<string, GroupChatMessage[]>();

  function record(msg: GroupChatMessage): void {
    const text = msg.text.trim();
    if (text.length === 0) return;
    // Command invocations are not discussion; don't let "/x ..." flood the
    // summary window.
    if (text.startsWith("/")) return;
    const stored: GroupChatMessage = {
      chatId: msg.chatId,
      userId: msg.userId,
      name: msg.name,
      text: text.slice(0, MAX_MESSAGE_CHARS),
      tsMs: msg.tsMs,
    };
    let arr = groups.get(msg.chatId);
    if (arr === undefined) {
      arr = [];
      groups.set(msg.chatId, arr);
    }
    arr.push(stored);
    if (arr.length > maxMessagesPerGroup) {
      arr.splice(0, arr.length - maxMessagesPerGroup);
    }
    // Cap the number of tracked groups (Map preserves insertion order; the
    // oldest group is evicted — a quiet group forgetting its buffer is the
    // safe failure direction).
    while (groups.size > maxGroups) {
      const oldest = groups.keys().next();
      if (oldest.done) break;
      groups.delete(oldest.value);
    }
  }

  function recent(chatId: string, n: number): GroupChatMessage[] {
    const arr = groups.get(chatId);
    if (arr === undefined || n <= 0) return [];
    return arr.slice(Math.max(0, arr.length - n));
  }

  function count(chatId: string): number {
    return groups.get(chatId)?.length ?? 0;
  }

  return { record, recent, count };
}

/**
 * Record one incoming group message for future /gsummary calls.
 *
 * No-op when assistant mode is not enabled for the group. The coordinator
 * calls this from the message path for text messages in groups/supergroups.
 */
export function recordGroupMessage(
  env: Pick<GroupAssistantEnv, "storage" | "ownerId" | "history">,
  msg: GroupChatMessage,
): void {
  const cfg = getAssistantConfig(env.storage, env.ownerId, msg.chatId);
  if (!cfg.enabled) return;
  env.history.record(msg);
}

// --------------------------------------------------- mention detection ----

/**
 * Should the bot answer this group message in assistant mode?
 *
 * - Mode disabled → false (this module is inert).
 * - replyOnlyWhenCalled false → true (owner opted out of the silence rule).
 * - Otherwise true when the message is a reply to the bot, mentions
 *   the bot's @username, or calls it by name ("بابی"/"bobi"). Pure, so the
 *   whole decision matrix is assertable.
 */
export function shouldReplyAssistant(input: {
  text: string;
  botUsername: string;
  replyToBot: boolean;
  enabled: boolean;
  replyOnlyWhenCalled: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (!input.replyOnlyWhenCalled) return true;
  if (input.replyToBot) return true;
  if (mentionsBotByName(input.text)) return true;
  return mentionsBot(input.text, input.botUsername);
}

/**
 * True when `text` contains an @username mention of the bot.
 *
 * Boundaries are letter/number/underscore-aware, so "@Bobi_Agentbot" matches
 * but "@Bobi_Agentbot_fan" or "x@Bobi_Agentbot" do not. Username matching is
 * case-insensitive (Telegram usernames are).
 */
export function mentionsBot(text: string, botUsername: string): boolean {
  const u = botUsername.replace(/^@/, "").trim();
  if (u.length === 0) return false;
  const esc = u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${esc}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

/**
 * True when `text` calls the bot by name ("بابی", "bobi", case-insensitive).
 * Catches "بابی بیا", "bobi what is...", "بابی،" — but not "بابیلون" or
 * "abobis". Used for wake-word replies in groups alongside @mentions.
 */
export function mentionsBotByName(text: string): boolean {
  return /(^|[^\p{L}\p{N}_])(بابی|bobi)(?![\p{L}\p{N}_])/iu.test(text);
}

// ---------------------------------------------------------- summary ----

/** Persian stopwords: function words that say nothing about the topic. */
const FA_STOPWORDS: ReadonlySet<string> = new Set([
  "این", "اون", "آن", "که", "و", "در", "به", "از", "با", "را", "برای",
  "یک", "یه", "هم", "می", "ها", "های", "تو", "ما", "من", "شما", "ای",
  "روی", "تا", "چون", "ولی", "اما", "اگر", "چه", "همه", "نه", "بله",
  "خیلی", "دو", "سه", "بعد", "قبل", "مثل", "بود", "هست", "نیست",
  "شده", "فقط", "حتی", "دیگر", "دیگه", "باش", "باشه", "کن", "بده",
  "بگو", "کنه", "بشه", "کنم", "کرد", "گفت", "گفتم", "می‌کنه", "چرا",
  "کجا", "کی", "چی", "چیه", "چطور", "پس", "آره", "ببین", "بیا",
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "you",
]);

const TOP_WORDS = 8;
const TOP_SPEAKERS = 5;
/** Display names are untrusted; render them on one line, truncated. */
const MAX_NAME_CHARS = 24;

/**
 * Sanitize a Telegram display name for rendering inside the summary:
 * collapse newlines/tabs (no multi-line impersonation), truncate.
 */
export function safeDisplayName(name: string, lang: AssistantLang): string {
  const clean = name
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return clean.length > 0 ? clean : tr(lang, "gassistant.name_unknown");
}

function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 2 && !FA_STOPWORDS.has(w));
}

/**
 * Build a deterministic discussion summary — NO LLM.
 *
 * Because there is no model in this path, embedded instructions inside group
 * messages cannot be followed; the output is always the fixed statistical
 * template below. Counts use locale digits via formatNum; raw message text
 * is never quoted (only single extracted topic words are listed).
 */
export function buildSummaryText(
  messages: readonly GroupChatMessage[],
  lang: AssistantLang = "fa",
): string {
  const capped = messages.slice(0, SUMMARY_INPUT_MAX_MESSAGES);
  if (capped.length === 0) return tr(lang, "gassistant.summary.empty");

  const n = capped.length;
  const speakers = new Map<string, { name: string; count: number }>();
  for (const m of capped) {
    const s = speakers.get(m.userId);
    if (s === undefined) speakers.set(m.userId, { name: m.name, count: 1 });
    else s.count += 1;
  }

  const wordCounts = new Map<string, number>();
  for (const m of capped) {
    for (const w of tokenize(m.text)) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }

  const topSpeakers = [...speakers.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SPEAKERS)
    .map((s) =>
      tr(lang, "gassistant.summary.speaker_row", {
        name: safeDisplayName(s.name, lang),
        n: formatNum(s.count, lang),
      }),
    );

  const topWords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_WORDS)
    .map(([w]) => w);

  const sep = lang === "fa" ? "، " : ", ";
  const lines: string[] = [
    tr(lang, "gassistant.summary.header"),
    tr(lang, "gassistant.summary.stats", {
      n: formatNum(n, lang),
      m: formatNum(speakers.size, lang),
      from: formatTime(capped[0]!.tsMs, lang),
      to: formatTime(capped[capped.length - 1]!.tsMs, lang),
    }),
    tr(lang, "gassistant.summary.top_speakers", { list: topSpeakers.join(sep) }),
  ];
  if (topWords.length > 0) {
    lines.push(tr(lang, "gassistant.summary.topics", { list: topWords.join(sep) }));
  }
  return lines.join("\n");
}

// --------------------------------------------------------------- polls ----

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MIN = 2;
export const POLL_OPTIONS_MAX = 10;

export interface PollSpec {
  question: string;
  options: string[];
}

export type PollParseError =
  | "usage"
  | "too_few"
  | "too_many"
  | "bad_question"
  | "bad_option";

export type PollParseResult =
  | { ok: true; spec: PollSpec }
  | { ok: false; error: PollParseError };

/**
 * Parse `/gpoll "سوال" "گزینه۱" "گزینه۲" ...`.
 *
 * Arguments must be double-quoted; anything else is a usage error. Pure, for
 * tests. Bounds follow Telegram's poll limits.
 */
export function parsePollArgs(fullText: string): PollParseResult {
  const firstSpace = fullText.indexOf(" ");
  const argText = firstSpace === -1 ? "" : fullText.slice(firstSpace + 1);
  const quoted: string[] = [];
  const re = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argText)) !== null) {
    quoted.push(m[1]!.trim());
  }
  if (quoted.length === 0) return { ok: false, error: "usage" };
  const [question, ...options] = quoted;
  if (question === undefined || question.length === 0 || question.length > POLL_QUESTION_MAX) {
    return { ok: false, error: "bad_question" };
  }
  if (options.length < POLL_OPTIONS_MIN) return { ok: false, error: "too_few" };
  if (options.length > POLL_OPTIONS_MAX) return { ok: false, error: "too_many" };
  for (const opt of options) {
    if (opt.length === 0 || opt.length > POLL_OPTION_MAX) {
      return { ok: false, error: "bad_option" };
    }
  }
  return { ok: true, spec: { question, options } };
}

// ----------------------------------------------------------- handlers ----

/** Owner check, injected. Defaults to strict id equality — never from text. */
export type OwnerCheck = (userId: string) => boolean;

export interface GroupAssistantEnv {
  /** Pref store (Storage satisfies this). Absent → config reads fail closed. */
  storage?: AssistantPrefStore;
  /** Bot owner's numeric Telegram id, as a string. */
  ownerId: string;
  /** Defaults to `(userId) => userId === ownerId`. */
  isOwner?: OwnerCheck;
  /** Bot's @username WITHOUT the leading @, e.g. "Bobi_Agentbot". */
  botUsername: string;
  /** The message buffer /gsummary reads from. */
  history: GroupHistory;
  /**
   * Phase-4: scheduled-digest task management, wired by the coordinator.
   * Absent → digest subcommands report that scheduling is unavailable
   * (config still readable/writable; the task row is simply not managed).
   */
  digest?: DigestSchedulePort;
  /**
   * Phase-5: LLM smart-summary port, wired by the coordinator to the AI
   * gateway (only when a real provider is configured). Absent → the smart
   * layer degrades to the deterministic summary with a small note.
   */
  smart?: SmartSummaryPort | undefined;
}

/**
 * The narrowest surface the assistant handlers need from the coordinator's
 * scheduled-task layer (Phase-4 group digests). The coordinator implements
 * it with the real schedule_task/list_tasks/cancel_task tools and the
 * owner's actor; tests inject fakes.
 */
export interface DigestSchedulePort {
  /**
   * Create (replacing any existing one) the daily digest task for a group.
   * Returns the new task id, or undefined when creation failed (the handler
   * then reports a generic failure, not raw tool text).
   */
  ensureDigestTask(chatId: string, timeHHMM: string): Promise<number | undefined>;
  /** Cancel the digest task for a group, if one exists. Never throws. */
  cancelDigestTask(chatId: string): Promise<void>;
}

/** Minimal context shape the handlers need (the handleVoiceCommand pattern). */
export interface GroupAssistantCtx {
  from?: { id: number | string } | undefined;
  chat?: { id: number | string; type: string } | undefined;
  message?: { text?: string } | undefined;
  reply(text: string): Promise<unknown>;
  replyWithPoll?(
    question: string,
    options: string[],
    extra?: { is_anonymous?: boolean },
  ): Promise<unknown>;
}

function ownerOf(env: GroupAssistantEnv): OwnerCheck {
  return env.isOwner ?? ((userId: string) => userId === env.ownerId);
}

function isGroupChat(ctx: GroupAssistantCtx): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

/** Parse "/gassistant on" / "off" / "status" (or "/gassistant@bot on"). */
export function parseAssistantArg(fullText: string): "on" | "off" | "status" | undefined {
  const parts = fullText.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const arg = parts[1]!.toLowerCase();
  return arg === "on" || arg === "off" || arg === "status" ? arg : undefined;
}

export function assistantStatusText(
  cfg: AssistantConfig,
  lang: AssistantLang = "fa",
): string {
  const base = tr(lang, "gassistant.status", {
    state: tr(lang, cfg.enabled ? "gassistant.state_on" : "gassistant.state_off"),
    silent: tr(lang, cfg.replyOnlyWhenCalled ? "gassistant.value_on" : "gassistant.value_off"),
    n: formatNum(cfg.summaryMaxMessages, lang),
    polls: tr(lang, cfg.pollsAllowed ? "gassistant.value_on" : "gassistant.value_off"),
  });
  const digest = tr(lang, "gassistant.digest.status_line", {
    digest: tr(
      lang,
      cfg.digestEnabled ? "gassistant.digest.status_on" : "gassistant.digest.status_off",
      { time: cfg.digestTime },
    ),
  });
  const smart = tr(lang, "gassistant.smart.status_line", {
    smart: tr(lang, cfg.smartSummary ? "gassistant.value_on" : "gassistant.value_off"),
  });
  return `${base}\n${digest}\n${smart}`;
}

/**
 * Parse "/gassistant smart on|off|status" (or with @bot suffix).
 * Returns undefined when this is not a smart subcommand at all.
 */
export function parseSmartArg(
  fullText: string,
): { kind: "on" | "off" | "status" } | { kind: "bad" } | undefined {
  const parts = fullText.trim().split(/\s+/);
  if (parts.length < 2 || parts[1]!.toLowerCase() !== "smart") return undefined;
  const sub = (parts[2] ?? "").toLowerCase();
  if (sub === "on" || sub === "off" || sub === "status") return { kind: sub };
  return { kind: "bad" };
}

/**
 * Parse "/gassistant digest on|off|status|time HH:MM" (or with @bot suffix).
 * Returns undefined when this is not a digest subcommand at all.
 */
export function parseDigestArg(
  fullText: string,
): { kind: "on" | "off" | "status" } | { kind: "time"; time: string } | { kind: "bad" } | undefined {
  const parts = fullText.trim().split(/\s+/);
  if (parts.length < 2 || parts[1]!.toLowerCase() !== "digest") return undefined;
  const sub = (parts[2] ?? "").toLowerCase();
  if (sub === "on" || sub === "off" || sub === "status") return { kind: sub };
  if (sub === "time") {
    const time = (parts[3] ?? "").trim();
    return { kind: "time", time };
  }
  return { kind: "bad" };
}

/**
 * /gassistant on|off|status — OWNER ONLY (re-checked here; the coordinator
 * also gates at registration).
 *
 * Must be issued in the group whose mode is toggled (the config key needs
 * the chat id).
 */
export async function handleGassistantCommand(
  ctx: GroupAssistantCtx,
  env: GroupAssistantEnv,
  lang: AssistantLang = "fa",
): Promise<void> {
  if (ctx.from === undefined) return;
  if (!ownerOf(env)(String(ctx.from.id))) {
    // Deliberately terse: a non-owner learns nothing about the mode.
    await safeReply(ctx, tr(lang, "gassistant.denied"));
    return;
  }
  if (!isGroupChat(ctx)) {
    await safeReply(ctx, tr(lang, "gassistant.private"));
    return;
  }
  const arg = parseAssistantArg(ctx.message?.text ?? "");
  if (arg === undefined) {
    // Maybe a digest subcommand: /gassistant digest on|off|status|time HH:MM.
    const digestArg = parseDigestArg(ctx.message?.text ?? "");
    if (digestArg !== undefined) {
      await handleGassistantDigest(ctx, env, String(ctx.chat!.id), digestArg, lang);
      return;
    }
    // Maybe a smart subcommand: /gassistant smart on|off|status.
    const smartArg = parseSmartArg(ctx.message?.text ?? "");
    if (smartArg !== undefined) {
      await handleGassistantSmart(ctx, env, String(ctx.chat!.id), smartArg, lang);
      return;
    }
    await safeReply(ctx, tr(lang, "gassistant.bad_arg"));
    return;
  }
  const chatId = String(ctx.chat!.id);
  if (arg === "status") {
    await safeReply(ctx, assistantStatusText(getAssistantConfig(env.storage, env.ownerId, chatId), lang));
    return;
  }
  const result = setAssistantConfig(env.storage, env.ownerId, chatId, {
    enabled: arg === "on",
  });
  if (!result.ok) {
    await safeReply(ctx, tr(lang, "gassistant.bad_arg"));
    return;
  }
  await safeReply(
    ctx,
    tr(lang, arg === "on" ? "gassistant.enabled" : "gassistant.disabled"),
  );
}

type DigestArg =
  | { kind: "on" | "off" | "status" }
  | { kind: "time"; time: string }
  | { kind: "bad" };

/**
 * /gassistant digest on|off|status|time HH:MM — OWNER ONLY (the caller
 * handleGassistantCommand already gated ownership and group context).
 *
 * Manages the Phase-4 daily digest: a scheduled task that sends the
 * deterministic discussion summary to the OWNER's private chat. The group
 * itself stays silent.
 */
async function handleGassistantDigest(
  ctx: GroupAssistantCtx,
  env: GroupAssistantEnv,
  chatId: string,
  darg: DigestArg,
  lang: AssistantLang = "fa",
): Promise<void> {
  const cfg = getAssistantConfig(env.storage, env.ownerId, chatId);

  if (darg.kind === "bad") {
    await safeReply(ctx, tr(lang, "gassistant.digest.usage"));
    return;
  }

  if (darg.kind === "status") {
    await safeReply(
      ctx,
      tr(lang, "gassistant.digest.status_line", {
        digest: digestStateText(cfg, lang),
      }),
    );
    return;
  }

  if (darg.kind === "off") {
    const res = setAssistantConfig(env.storage, env.ownerId, chatId, {
      digestEnabled: false,
    });
    if (!res.ok) {
      await safeReply(ctx, tr(lang, "gassistant.bad_arg"));
      return;
    }
    try {
      await env.digest?.cancelDigestTask(chatId);
    } catch {
      // Best effort: the config is already off, so a stale task row only
      // no-ops at run time (the tool re-reads the config before sending).
    }
    await safeReply(ctx, tr(lang, "gassistant.digest.off"));
    return;
  }

  if (darg.kind === "time") {
    const time = darg.time.trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      await safeReply(ctx, tr(lang, "gassistant.digest.bad_time"));
      return;
    }
    const res = setAssistantConfig(env.storage, env.ownerId, chatId, {
      digestTime: time,
    });
    if (!res.ok) {
      await safeReply(ctx, tr(lang, "gassistant.bad_arg"));
      return;
    }
    if (res.config.digestEnabled) {
      if (env.digest === undefined) {
        await safeReply(ctx, tr(lang, "gassistant.digest.unavailable"));
        return;
      }
      const id = await env.digest.ensureDigestTask(chatId, time).catch(() => undefined);
      if (id === undefined) {
        await safeReply(ctx, tr(lang, "gassistant.digest.schedule_failed"));
        return;
      }
    }
    await safeReply(ctx, tr(lang, "gassistant.digest.time_set", { time }));
    return;
  }

  // darg.kind === "on"
  if (!cfg.enabled) {
    // The digest is a feature OF the assistant mode; without the mode there
    // is no history buffer to summarize.
    await safeReply(ctx, tr(lang, "gassistant.digest.need_mode"));
    return;
  }
  if (env.digest === undefined) {
    await safeReply(ctx, tr(lang, "gassistant.digest.unavailable"));
    return;
  }
  // Create the task BEFORE flipping the config: if scheduling fails, the
  // config must not claim a digest that will never fire.
  const id = await env.digest.ensureDigestTask(chatId, cfg.digestTime).catch(() => undefined);
  if (id === undefined) {
    await safeReply(ctx, tr(lang, "gassistant.digest.schedule_failed"));
    return;
  }
  const res = setAssistantConfig(env.storage, env.ownerId, chatId, {
    digestEnabled: true,
  });
  if (!res.ok) {
    // Config write failed after scheduling — cancel the task so the two
    // stay consistent (the tool would no-op anyway, reading the config).
    await env.digest.cancelDigestTask(chatId).catch(() => undefined);
    await safeReply(ctx, tr(lang, "gassistant.bad_arg"));
    return;
  }
  await safeReply(
    ctx,
    tr(lang, "gassistant.digest.on", { time: res.config.digestTime }),
  );
}

/** "on at 08:00" / "off" line for the digest state, both languages. */
function digestStateText(
  cfg: AssistantConfig,
  lang: AssistantLang,
): string {
  return tr(
    lang,
    cfg.digestEnabled ? "gassistant.digest.status_on" : "gassistant.digest.status_off",
    { time: cfg.digestTime },
  );
}

type SmartArg = { kind: "on" | "off" | "status" } | { kind: "bad" };

/**
 * /gassistant smart on|off|status — OWNER ONLY (the caller
 * handleGassistantCommand already gated ownership and group context).
 *
 * Toggles the Phase-5 opt-in LLM summary layer: when ON, the OWNER's
 * /gsummary and the scheduled digest may additionally request an LLM
 * summary (injection-hardened; see smart_summary.ts). The layer is never
 * shown to non-owners — their /gsummary stays deterministic.
 */
async function handleGassistantSmart(
  ctx: GroupAssistantCtx,
  env: GroupAssistantEnv,
  chatId: string,
  sarg: SmartArg,
  lang: AssistantLang = "fa",
): Promise<void> {
  if (sarg.kind === "bad") {
    await safeReply(ctx, tr(lang, "gassistant.smart.usage"));
    return;
  }

  if (sarg.kind === "status") {
    const cfg = getAssistantConfig(env.storage, env.ownerId, chatId);
    await safeReply(
      ctx,
      tr(lang, "gassistant.smart.status_line", {
        smart: tr(lang, cfg.smartSummary ? "gassistant.value_on" : "gassistant.value_off"),
      }),
    );
    return;
  }

  if (sarg.kind === "off") {
    const res = setAssistantConfig(env.storage, env.ownerId, chatId, {
      smartSummary: false,
    });
    if (!res.ok) {
      await safeReply(ctx, tr(lang, "gassistant.bad_arg"));
      return;
    }
    await safeReply(ctx, tr(lang, "gassistant.smart.off"));
    return;
  }

  // sarg.kind === "on"
  const cfg = getAssistantConfig(env.storage, env.ownerId, chatId);
  if (!cfg.enabled) {
    // The smart layer summarizes the history buffer; without assistant
    // mode there is no buffer to read.
    await safeReply(ctx, tr(lang, "gassistant.smart.need_mode"));
    return;
  }
  if (env.smart === undefined) {
    // Honest at enable time: without a wired provider the flag would only
    // ever degrade to the deterministic summary.
    await safeReply(ctx, tr(lang, "gassistant.smart.unavailable"));
    return;
  }
  const res = setAssistantConfig(env.storage, env.ownerId, chatId, {
    smartSummary: true,
  });
  if (!res.ok) {
    await safeReply(ctx, tr(lang, "gassistant.bad_arg"));
    return;
  }
  await safeReply(ctx, tr(lang, "gassistant.smart.on"));
}

/**
 * /gsummary — summarize recent group discussion.
 *
 * Visible to anyone IN the group once the mode is enabled (that is the
 * point of the feature), but the mode itself is owner-gated and a disabled
 * group gets only the terse "not enabled" line. The summary is posted in the
 * same group — never DM'd anywhere.
 *
 * Phase-5 routing rule: the LLM smart section is served ONLY on an explicit
 * OWNER request in the group. Non-owner callers get exactly the deterministic
 * summary — the smart layer is invisible to them, not just blocked.
 */
export async function handleGsummaryCommand(
  ctx: GroupAssistantCtx,
  env: GroupAssistantEnv,
  lang: AssistantLang = "fa",
): Promise<void> {
  if (!isGroupChat(ctx)) {
    await safeReply(ctx, tr(lang, "gassistant.private"));
    return;
  }
  const chatId = String(ctx.chat!.id);
  const cfg = getAssistantConfig(env.storage, env.ownerId, chatId);
  if (!cfg.enabled) {
    await safeReply(ctx, tr(lang, "gassistant.off"));
    return;
  }
  const messages = env.history.recent(chatId, cfg.summaryMaxMessages);
  const deterministic = buildSummaryText(messages, lang);
  if (!cfg.smartSummary) {
    await safeReply(ctx, deterministic);
    return;
  }
  // Smart layer is ON: serve the LLM section only to the OWNER's explicit
  // request in the group. Everyone else gets the deterministic text — the
  // smart layer is invisible to them, not just blocked.
  const requester = ctx.from?.id;
  if (requester === undefined || !ownerOf(env)(String(requester))) {
    await safeReply(ctx, deterministic);
    return;
  }
  const result = await summarizeSmart({
    messages,
    lang,
    cfg,
    port: env.smart,
    fallbackText: deterministic,
  });
  await safeReply(ctx, result.text);
}

/**
 * /gpoll "سوال" "گزینه۱" "گزینه۲" ... — OWNER ONLY (re-checked here; the
 * coordinator also gates at registration).
 *
 * Sends a native Telegram poll into the group. The argument is the owner's
 * own command text (owner-gated), passed through unchanged within Telegram's
 * bounds.
 */
export async function handleGpollCommand(
  ctx: GroupAssistantCtx,
  env: GroupAssistantEnv,
  lang: AssistantLang = "fa",
): Promise<void> {
  if (ctx.from === undefined) return;
  if (!ownerOf(env)(String(ctx.from.id))) {
    await safeReply(ctx, tr(lang, "gassistant.denied"));
    return;
  }
  if (!isGroupChat(ctx)) {
    await safeReply(ctx, tr(lang, "gassistant.private"));
    return;
  }
  const chatId = String(ctx.chat!.id);
  const cfg = getAssistantConfig(env.storage, env.ownerId, chatId);
  if (!cfg.enabled) {
    await safeReply(ctx, tr(lang, "gassistant.off"));
    return;
  }
  if (!cfg.pollsAllowed) {
    await safeReply(ctx, tr(lang, "gassistant.polls_disabled"));
    return;
  }
  const parsed = parsePollArgs(ctx.message?.text ?? "");
  if (!parsed.ok) {
    const key =
      parsed.error === "usage"
        ? "gassistant.poll.usage"
        : parsed.error === "too_few"
          ? "gassistant.poll.too_few"
          : parsed.error === "too_many"
            ? "gassistant.poll.too_many"
            : parsed.error === "bad_question"
              ? "gassistant.poll.bad_question"
              : "gassistant.poll.bad_option";
    await safeReply(ctx, tr(lang, key));
    return;
  }
  if (ctx.replyWithPoll === undefined) {
    await safeReply(ctx, tr(lang, "gassistant.poll.unsupported"));
    return;
  }
  try {
    await ctx.replyWithPoll(parsed.spec.question, parsed.spec.options, {
      is_anonymous: false,
    });
  } catch {
    // Best effort: a Telegram failure is reported generically, not with raw
    // error text.
    await safeReply(ctx, tr(lang, "gassistant.poll.unsupported"));
  }
}

/** Reply, tolerating a failure (blocked bot, deleted message). */
async function safeReply(
  ctx: { reply(text: string): Promise<unknown> },
  text: string,
): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // A user who blocked the bot cannot be told anything; that is not an error.
  }
}
