import { Bot, InputFile, type Context } from "grammy";
import type { HermesCommandDef, HermesCommandDeps } from "./cmd_context";
import {
  commandArg,
  gateGroup,
  gateUser,
  isOwnerSender,
  senderLang,
  stopTurn,
  type UserPrefStore,
} from "./bot";
import type { Storage, StoredMessage } from "../storage/storage";
import {
  EngineError,
  splitForTelegram,
  type ConversationEngine,
  type ConversationInput,
  type ConversationOutput,
} from "../conversation/engine";
import type { Lang } from "../i18n";
import { tr } from "./cmd_session_strings";

/**
 * Phase: Hermes command parity — session commands.
 *
 * Fifteen regular-user commands for inspecting and managing the current
 * conversation: /history /save /retry /undo /title /branch /resume
 * /sessions /status /context /busy /whoami /footer /version /new.
 *
 * Conventions (same as the built-ins in bot.ts):
 * - all user-facing strings via tr() in cmd_session_strings.ts (fa default),
 *   all code comments in English,
 * - logic lives in exported handleXxx functions taking plain values; the
 *   grammy wrappers in registerSessionCommands are thin,
 * - state-changing commands run gateGroup + gateUser first (same gates as
 *   the message path); /whoami, /version and /status are read-only and stay
 *   ungated like /help.
 *
 * SECURITY notes (see also docs/phase-commands-session.md):
 * - Every storage read/write is scoped by (userId, chatId): history(), save(),
 *   undo(), branch() and sessions() can only ever touch the caller's own
 *   conversations. A userId is always String(ctx.from.id) — server-validated,
 *   never derived from message text.
 * - /undo is destructive: the count argument is REQUIRED (bare /undo only
 *   shows usage) and the reply confirms exactly what was dropped.
 * - Argument parsing caps everything: history N (1..30), undo N (1..5),
 *   title (<=120 chars), branch name (<=40, sanitised to a safe charset).
 * - Storage failures never leak internals: every catch maps to a generic
 *   Persian message; details go to the server log only.
 */

// ---- limits ----

/** Default and maximum message counts for /history. */
const HISTORY_DEFAULT_N = 10;
const HISTORY_MAX_N = 30;
/** /undo accepts 1..5 turns. */
const UNDO_MAX_TURNS = 5;
/** /title length cap (chars). */
const TITLE_MAX_LEN = 120;
/** Branch names: letters, digits, dash, underscore, at most 40 chars. */
const BRANCH_NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;
/**
 * Full-history read cap for /save, /branch, /undo and /retry.
 *
 * A safety bound so one giant conversation cannot OOM the process during a
 * rewrite or export; beyond it the command refuses honestly instead of
 * silently processing a truncated set (which for /undo would LOSE data).
 */
const MAX_FULL_READ = 5000;
/** Engine context window assumed by /context (matches engine historyLimit default). */
const ENGINE_WINDOW = 50;

// ---- per-user preference keys ----

/** Display title of one conversation. */
const titlePrefKey = (conversationId: string): string => `title:${conversationId}`;
const ACTIVE_CONV_KEY = "active_conversation";
/** Which past conversation this chat wants to continue (per chat). */
const activeConvPrefKey = (chatId: string): string => `${ACTIVE_CONV_KEY}:${chatId}`;
const BUSY_MODE_KEY = "busy_mode";
const FOOTER_MODE_KEY = "footer_mode";

// ---- narrow environments (the handleVoiceCommand pattern) ----

/** Minimal grammy context shape the handlers need; full Context satisfies it. */
export interface SessionCtx {
  chat?: { id: number | string } | undefined;
  from?: { id: number | string } | undefined;
  message?: { text?: string } | undefined;
  reply(text: string): Promise<unknown>;
  replyWithDocument?(doc: InputFile, opts?: { caption?: string }): Promise<unknown>;
}

export type StorageEnv = { storage: Storage };
export type PrefsEnv = { prefs?: UserPrefStore };
export type StoragePrefsEnv = { storage: Storage; prefs?: UserPrefStore };
export type NewEnv = { engine: Pick<ConversationEngine, "cancel" | "clearHistory"> };
export type RetryEnv = {
  engine: Pick<ConversationEngine, "respond" | "cancel">;
  storage: Storage;
};
export type UndoEnv = { engine: Pick<ConversationEngine, "cancel">; storage: Storage };
export type StatusEnv = {
  engine: Pick<ConversationEngine, "isConversationRunning">;
  storage: Storage;
  prefs?: UserPrefStore;
};

// ---- small helpers (pure, for tests) ----

function idsOf(ctx: SessionCtx): { userId: string; chatId: string } | undefined {
  if (ctx.chat === undefined || ctx.from === undefined) return undefined;
  return { userId: String(ctx.from.id), chatId: String(ctx.chat.id) };
}

/** Reply, tolerating delivery failure (blocked bot, deleted message). */
async function safeReply(
  ctx: { reply(text: string): Promise<unknown> },
  text: string,
): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // Best effort: the user cannot be reached.
  }
}

/** Reply long text in Telegram-safe chunks (<=4096 chars each). */
async function replyChunked(ctx: SessionCtx, text: string): Promise<void> {
  for (const chunk of splitForTelegram(text)) {
    await safeReply(ctx, chunk);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Parse a bounded integer argument; undefined on any junk. Pure. */
export function parseCount(
  raw: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < min || n > max) return undefined;
  return n;
}

/** Raw command argument (text after "/cmd" or "/cmd@bot"), or undefined. */
function rawArg(ctx: SessionCtx): string | undefined {
  if (ctx.message?.text === undefined) return undefined;
  return commandArg(ctx.message.text);
}

function roleLabel(role: StoredMessage["role"], lang: Lang): string {
  return tr(lang, `cmd_session.role_${role}`);
}

function formatFaDate(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "fa" ? "fa-IR" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tehran",
  }).format(ms);
}

function formatFaTime(ms: number): string {
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tehran",
  }).format(ms);
}

/**
 * Start of today in Asia/Tehran, as unix ms.
 *
 * The usage ledger stores at_ms; "today" is the user's calendar day. Iran
 * has no DST since 2022, so +03:30 is fixed.
 */
function startOfTodayTehran(): number {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // "YYYY-MM-DD"
  return Date.parse(`${day}T00:00:00+03:30`);
}

/**
 * Read the whole conversation (most-recent-first cap applied by storage).
 * Refuses beyond MAX_FULL_READ rather than silently truncating — a partial
 * read fed into /undo's rewrite would lose the older messages.
 */
function readAllHistory(
  storage: Storage,
  userId: string,
  chatId: string,
): StoredMessage[] {
  const total = storage.countMessages(userId, chatId);
  if (total > MAX_FULL_READ) {
    throw new Error("conversation too large");
  }
  if (total <= 0) return [];
  return storage.history(userId, chatId, total);
}

function isTooLarge(err: unknown): boolean {
  return err instanceof Error && err.message === "conversation too large";
}

/**
 * Split history into (keep, dropped) where dropped holds the last `turns`
 * user turns. A turn is a user message plus everything after it up to (but
 * not including) the next user message, so a trailing assistant reply is
 * dropped together with its question. Pure, for tests.
 */
export function splitLastTurns(
  history: StoredMessage[],
  turns: number,
): { keep: StoredMessage[]; dropped: StoredMessage[] } {
  let seen = 0;
  let cut = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") {
      seen++;
      if (seen === turns) {
        cut = i;
        break;
      }
    }
  }
  if (seen < turns) {
    // Fewer user turns than requested: drop from the first user message,
    // keeping any leading system messages. No user message at all: drop nothing.
    const firstUser = history.findIndex((m) => m.role === "user");
    cut = firstUser === -1 ? history.length : firstUser;
  }
  return { keep: history.slice(0, cut), dropped: history.slice(cut) };
}

/** Index of the last user message, or -1. Pure, for tests. */
export function findLastUserIndex(history: StoredMessage[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") return i;
  }
  return -1;
}

/**
 * Rewrite a conversation, keeping only `keep` (chronological).
 *
 * Implemented as delete + re-append because Storage exposes no
 * delete-by-message-id; ids are renumbered. The rolling-summary watermark
 * is remapped to the new ids so the summary keeps pointing at the same
 * content; when the watermark pointed at a dropped message (or there was no
 * summary row) the summary is cleared instead of silently mis-pointed —
 * it described content that no longer exists.
 *
 * SECURITY: (userId, chatId) scoping comes from the callers; this helper
 * never invents an identity.
 */
function rewriteConversation(
  storage: Storage,
  userId: string,
  chatId: string,
  keep: readonly StoredMessage[],
): void {
  const summary = storage.getConversationSummary(userId, chatId);
  storage.deleteConversation(userId, chatId);
  const newIds: number[] = [];
  for (const m of keep) {
    newIds.push(storage.appendMessage(userId, chatId, m.role, m.content));
  }
  if (summary !== undefined) {
    const idx = keep.findIndex((m) => m.id === summary.summarisedUntil);
    if (idx >= 0 && newIds[idx] !== undefined) {
      storage.setConversationSummary({
        userId,
        chatId,
        summary: summary.summary,
        summarisedUntil: newIds[idx]!,
      });
    } else {
      storage.clearConversationSummary(userId, chatId);
    }
  }
}

/** Safe read of one pref; undefined on storage failure (callers degrade). */
function readPref(prefs: UserPrefStore | undefined, userId: string, key: string): string | undefined {
  if (prefs === undefined) return undefined;
  try {
    return prefs.getUserPref(userId, key);
  } catch {
    return undefined;
  }
}

/** User-safe error text for a failed engine run. */
function engineFailureText(err: unknown, lang: Lang): string {
  // EngineError messages are already Persian, user-safe categories.
  if (err instanceof EngineError) return err.message;
  return tr(lang, "cmd_session.retry_failed");
}

// --------------------------------------------------------------- /history ----

/**
 * /history [N]: show the last N messages of this conversation
 * (default 10, cap 30). Read-only, but gated by the caller — history is
 * private to the (userId, chatId) pair.
 */
export async function handleHistoryCommand(
  ctx: SessionCtx,
  env: StorageEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  const raw = rawArg(ctx);
  let n = HISTORY_DEFAULT_N;
  if (raw !== undefined) {
    const parsed = parseCount(raw, 1, HISTORY_MAX_N);
    if (parsed === undefined) {
      await safeReply(ctx, tr(lang, "cmd_session.history_bad_arg"));
      return;
    }
    n = parsed;
  }
  let messages: StoredMessage[];
  let total = 0;
  try {
    total = env.storage.countMessages(ids.userId, ids.chatId);
    messages = env.storage.history(ids.userId, ids.chatId, n);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  if (messages.length === 0) {
    await safeReply(ctx, tr(lang, "cmd_session.history_empty"));
    return;
  }
  const lines = messages.map(
    (m) => `${roleLabel(m.role, lang)}: ${truncate(m.content, 500)}`,
  );
  let text =
    tr(lang, "cmd_session.history_title", { n: messages.length }) +
    "\n\n" +
    lines.join("\n\n");
  if (total > messages.length) {
    text += "\n\n" + tr(lang, "cmd_session.history_more", { n: total - messages.length });
  }
  await replyChunked(ctx, text);
}

// ------------------------------------------------------------------ /save ----

function renderMarkdownExport(messages: readonly StoredMessage[], lang: Lang): string {
  const date = new Date().toISOString().slice(0, 10);
  const parts = [`# ${tr(lang, "cmd_session.save_caption", { date })}`, ""];
  for (const m of messages) {
    parts.push(`## ${roleLabel(m.role, lang)} — ${formatFaTime(m.createdAt)}`, "", m.content, "");
  }
  return parts.join("\n");
}

function renderJsonExport(messages: readonly StoredMessage[]): string {
  return JSON.stringify(
    messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    null,
    2,
  );
}

/**
 * /save [json]: send this conversation as a document (.md by default,
 * .json with the "json" argument). Per-user scoped like /history.
 */
export async function handleSaveCommand(
  ctx: SessionCtx,
  env: StorageEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  const raw = rawArg(ctx)?.toLowerCase();
  let format: "md" | "json" = "md";
  if (raw !== undefined) {
    if (raw === "json") {
      format = "json";
    } else {
      await safeReply(ctx, tr(lang, "cmd_session.save_bad_arg"));
      return;
    }
  }
  let messages: StoredMessage[];
  try {
    messages = readAllHistory(env.storage, ids.userId, ids.chatId);
  } catch (err) {
    await safeReply(
      ctx,
      isTooLarge(err)
        ? tr(lang, "cmd_session.save_too_large")
        : tr(lang, "cmd_session.storage_error"),
    );
    return;
  }
  if (messages.length === 0) {
    await safeReply(ctx, tr(lang, "cmd_session.save_empty"));
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const filename = format === "md" ? `bobi-chat-${date}.md` : `bobi-chat-${date}.json`;
  const body = format === "md" ? renderMarkdownExport(messages, lang) : renderJsonExport(messages);
  if (ctx.replyWithDocument === undefined) {
    // Non-Telegram test contexts: fall back to chunked text.
    await replyChunked(ctx, body);
    return;
  }
  try {
    await ctx.replyWithDocument(new InputFile(Buffer.from(body, "utf-8"), filename), {
      caption: tr(lang, "cmd_session.save_caption", { date }),
    });
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
  }
}

// ----------------------------------------------------------------- /retry ----

/**
 * /retry: re-run the last user message through the engine.
 *
 * Regenerate semantics: the last user message AND its previous answer are
 * dropped first, then the text is fed to engine.respond() — which commits
 * the user message and the fresh answer itself. The engine therefore sees
 * exactly the state the message was first processed in, and the history
 * never gains a duplicated user message.
 *
 * If the run fails, the dropped tail (user message + old answer) is
 * re-appended, so a failed retry never eats the user's message.
 */
export async function handleRetryCommand(
  ctx: SessionCtx,
  env: RetryEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  let all: StoredMessage[];
  try {
    all = readAllHistory(env.storage, ids.userId, ids.chatId);
  } catch (err) {
    await safeReply(
      ctx,
      isTooLarge(err)
        ? tr(lang, "cmd_session.save_too_large")
        : tr(lang, "cmd_session.storage_error"),
    );
    return;
  }
  const idx = findLastUserIndex(all);
  if (idx === -1) {
    await safeReply(ctx, tr(lang, "cmd_session.retry_none"));
    return;
  }
  const lastUser = all[idx]!;
  const droppedTail = all.slice(idx);
  // Cancel any in-flight turn first: a racing run must not commit its answer
  // into the history we are about to rewrite (same pattern as /reset).
  env.engine.cancel(ids.chatId);
  try {
    rewriteConversation(env.storage, ids.userId, ids.chatId, all.slice(0, idx));
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  const input: ConversationInput = {
    conversationId: ids.chatId,
    userId: ids.userId,
    userText: lastUser.content,
  };
  let out: ConversationOutput;
  try {
    out = await env.engine.respond(input);
  } catch (err) {
    // Restore the pre-retry state; a failure must not lose the message.
    // The summary watermark still points at the kept prefix, whose new ids
    // did not change, so no remap is needed.
    try {
      for (const m of droppedTail) {
        env.storage.appendMessage(ids.userId, ids.chatId, m.role, m.content);
      }
    } catch {
      // Best effort: the failure reply below is the essential part.
    }
    await safeReply(ctx, engineFailureText(err, lang));
    return;
  }
  for (const chunk of out.chunks) {
    await safeReply(ctx, chunk);
  }
}

// ------------------------------------------------------------------ /undo ----

/**
 * /undo <N>: drop the last N user turns (1..5) so the user can resend.
 *
 * The count argument is REQUIRED — a bare /undo only shows usage. This is
 * deliberate: the operation is destructive and must never fire on an
 * accidental tap. The reply confirms how many turns were dropped and previews
 * the dropped user texts.
 */
export async function handleUndoCommand(
  ctx: SessionCtx,
  env: UndoEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  const raw = rawArg(ctx);
  if (raw === undefined) {
    await safeReply(ctx, tr(lang, "cmd_session.undo_usage"));
    return;
  }
  const n = parseCount(raw, 1, UNDO_MAX_TURNS);
  if (n === undefined) {
    await safeReply(ctx, tr(lang, "cmd_session.undo_bad_arg"));
    return;
  }
  let all: StoredMessage[];
  try {
    all = readAllHistory(env.storage, ids.userId, ids.chatId);
  } catch (err) {
    await safeReply(
      ctx,
      isTooLarge(err)
        ? tr(lang, "cmd_session.save_too_large")
        : tr(lang, "cmd_session.storage_error"),
    );
    return;
  }
  const { keep, dropped } = splitLastTurns(all, n);
  if (dropped.length === 0) {
    await safeReply(ctx, tr(lang, "cmd_session.undo_nothing"));
    return;
  }
  env.engine.cancel(ids.chatId);
  try {
    rewriteConversation(env.storage, ids.userId, ids.chatId, keep);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  const droppedUsers = dropped.filter((m) => m.role === "user");
  const preview =
    droppedUsers.length > 0
      ? droppedUsers.map((m) => `• ${truncate(m.content, 80)}`).join("\n")
      : "• …";
  await safeReply(
    ctx,
    tr(lang, "cmd_session.undo_done", { n: droppedUsers.length, preview }),
  );
}

// ----------------------------------------------------------------- /title ----

/**
 * /title [<text>]: show or set this conversation's display title.
 * Stored per user in user_prefs as `title:<conversationId>`; capped at
 * 120 chars. Titles are display-only — never interpreted as commands.
 */
export async function handleTitleCommand(
  ctx: SessionCtx,
  env: PrefsEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  if (env.prefs === undefined) {
    await safeReply(ctx, tr(lang, "cmd_session.prefs_unavailable"));
    return;
  }
  const raw = rawArg(ctx)?.trim();
  const key = titlePrefKey(ids.chatId);
  if (raw === undefined || raw.length === 0) {
    let current: string | undefined;
    try {
      current = env.prefs.getUserPref(ids.userId, key);
    } catch {
      await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
      return;
    }
    await safeReply(
      ctx,
      current !== undefined && current.length > 0
        ? tr(lang, "cmd_session.title_current", { title: current })
        : tr(lang, "cmd_session.title_none"),
    );
    return;
  }
  if (raw.length > TITLE_MAX_LEN) {
    await safeReply(ctx, tr(lang, "cmd_session.title_too_long"));
    return;
  }
  try {
    env.prefs.setUserPref(ids.userId, key, raw);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.prefs_save_failed"));
    return;
  }
  await safeReply(ctx, tr(lang, "cmd_session.title_set", { title: raw }));
}

// ---------------------------------------------------------------- /branch ----

/**
 * /branch <name>: copy the current history into a new named thread whose
 * conversation id is `<chatId>:<name>`. Only the caller's own messages are
 * copied (storage is (userId, chatId)-scoped throughout). The rolling
 * summary is NOT copied — its watermark references the old message ids —
 * and the reply says so honestly.
 */
export async function handleBranchCommand(
  ctx: SessionCtx,
  env: StoragePrefsEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  const raw = rawArg(ctx)?.trim();
  if (!raw) {
    await safeReply(ctx, tr(lang, "cmd_session.branch_usage"));
    return;
  }
  if (!BRANCH_NAME_RE.test(raw)) {
    await safeReply(ctx, tr(lang, "cmd_session.branch_bad_name"));
    return;
  }
  const newChatId = `${ids.chatId}:${raw}`;
  let all: StoredMessage[];
  try {
    all = readAllHistory(env.storage, ids.userId, ids.chatId);
  } catch (err) {
    await safeReply(
      ctx,
      isTooLarge(err)
        ? tr(lang, "cmd_session.save_too_large")
        : tr(lang, "cmd_session.storage_error"),
    );
    return;
  }
  if (all.length === 0) {
    await safeReply(ctx, tr(lang, "cmd_session.branch_empty"));
    return;
  }
  try {
    for (const m of all) {
      env.storage.appendMessage(ids.userId, newChatId, m.role, m.content);
    }
    // Give the branch a readable name in /sessions.
    try {
      env.prefs?.setUserPref(ids.userId, titlePrefKey(newChatId), raw);
    } catch {
      // Cosmetic only; the branch itself is already copied.
    }
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  await safeReply(ctx, tr(lang, "cmd_session.branch_done", { id: newChatId, n: all.length }));
}

// ---------------------------------------------------------------- /resume ----

/**
 * /resume <name-or-id>: "switch" this chat to a previous conversation.
 *
 * LIMITATION (honest): the message handler in bot.ts resolves the
 * conversation as String(ctx.chat.id) and does NOT read user_prefs, and this
 * module may not modify it. So a true switch is impossible from here: the
 * handler stores the choice as the `active_conversation:<chatId>` pref (for
 * the coordinator to wire later) and shows the target's recent history, with
 * an explicit note that new messages still continue the current chat's
 * thread until the handler honors the pref.
 */
export async function handleResumeCommand(
  ctx: SessionCtx,
  env: StoragePrefsEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  const raw = rawArg(ctx)?.trim();
  if (!raw) {
    await safeReply(ctx, tr(lang, "cmd_session.resume_usage"));
    return;
  }
  let sessions;
  try {
    sessions = env.storage.listUserConversations(ids.userId);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  const titles = new Map<string, string>();
  for (const s of sessions) {
    const t = readPref(env.prefs, ids.userId, titlePrefKey(s.conversationId));
    if (t !== undefined && t.length > 0) titles.set(s.conversationId, t);
  }
  const needle = raw.toLowerCase();
  const match = sessions.find(
    (s) =>
      s.conversationId === raw ||
      s.conversationId.toLowerCase().endsWith(`:${needle}`) ||
      titles.get(s.conversationId)?.toLowerCase() === needle,
  );
  if (!match) {
    await safeReply(ctx, tr(lang, "cmd_session.resume_not_found"));
    return;
  }
  if (env.prefs === undefined) {
    await safeReply(ctx, tr(lang, "cmd_session.prefs_unavailable"));
    return;
  }
  try {
    env.prefs.setUserPref(ids.userId, activeConvPrefKey(ids.chatId), match.conversationId);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.prefs_save_failed"));
    return;
  }
  let messages: StoredMessage[];
  try {
    messages = env.storage.history(ids.userId, match.conversationId, HISTORY_DEFAULT_N);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  const displayName = titles.get(match.conversationId) ?? match.conversationId;
  let text = tr(lang, "cmd_session.resume_title", { name: displayName, n: messages.length });
  if (messages.length === 0) {
    text += "\n" + tr(lang, "cmd_session.resume_empty");
  } else {
    text +=
      "\n\n" +
      messages
        .map((m) => `${roleLabel(m.role, lang)}: ${truncate(m.content, 300)}`)
        .join("\n\n");
  }
  text += "\n\n" + tr(lang, "cmd_session.resume_limitation");
  await replyChunked(ctx, text);
}

// --------------------------------------------------------------- /sessions ----

/**
 * /sessions: list the caller's past conversations (their own only —
 * listUserConversations filters by user_id), newest activity first.
 */
export async function handleSessionsCommand(
  ctx: SessionCtx,
  env: StoragePrefsEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  let sessions;
  try {
    sessions = env.storage.listUserConversations(ids.userId);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  if (sessions.length === 0) {
    await safeReply(ctx, tr(lang, "cmd_session.sessions_empty"));
    return;
  }
  const shown = sessions.slice(0, 10);
  const lines = shown.map((s) => {
    const title =
      readPref(env.prefs, ids.userId, titlePrefKey(s.conversationId)) ?? s.conversationId;
    const current =
      s.conversationId === ids.chatId ? tr(lang, "cmd_session.sessions_current_mark") : "";
    return tr(lang, "cmd_session.sessions_item", {
      title,
      n: s.messageCount,
      date: formatFaDate(s.lastActivity, lang),
      current,
    });
  });
  let text = tr(lang, "cmd_session.sessions_title") + "\n" + lines.join("\n");
  if (sessions.length > shown.length) {
    text += "\n" + tr(lang, "cmd_session.sessions_more", { n: sessions.length - shown.length });
  }
  await replyChunked(ctx, text);
}

// ---------------------------------------------------------------- /status ----

/**
 * /status: one card — session id, title, model in use, stored message count,
 * whether a turn is running, and today's token usage from the usage ledger.
 * Read-only; ungated like /help.
 *
 * NOTE: ConversationEngine does not expose its configured model string, so
 * "model in use" is inferred from today's usage ledger (most-used model).
 * The coordinator should add an engine.activeModel accessor for precision.
 */
export async function handleStatusCommand(
  ctx: SessionCtx,
  env: StatusEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  let messageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let runs = 0;
  let topModel: string | undefined;
  try {
    messageCount = env.storage.countMessages(ids.userId, ids.chatId);
    const since = startOfTodayTehran();
    const totals = env.storage.usageTotals(ids.userId, since);
    inputTokens = totals.inputTokens;
    outputTokens = totals.outputTokens;
    runs = totals.runs;
    topModel = env.storage.usageByModel(ids.userId, since)[0]?.modelId;
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  const title =
    readPref(env.prefs, ids.userId, titlePrefKey(ids.chatId)) ??
    tr(lang, "cmd_session.status_title_none");
  const running = env.engine.isConversationRunning(ids.chatId);
  const lines = [
    tr(lang, "cmd_session.status_title"),
    tr(lang, "cmd_session.status_session", { id: ids.chatId }),
    tr(lang, "cmd_session.status_title_line", { title }),
    tr(lang, "cmd_session.status_model", {
      model: topModel ?? tr(lang, "cmd_session.status_model_unknown"),
    }),
    tr(lang, "cmd_session.status_messages", { n: messageCount }),
    tr(lang, running ? "cmd_session.status_running_yes" : "cmd_session.status_running_no"),
    tr(lang, "cmd_session.status_tokens", {
      in: inputTokens.toLocaleString("en-US"),
      out: outputTokens.toLocaleString("en-US"),
    }),
    tr(lang, "cmd_session.status_requests", { n: runs }),
  ];
  await safeReply(ctx, lines.join("\n"));
}

// --------------------------------------------------------------- /context ----

/**
 * /context: context-window gauge — stored message count, rough token
 * estimate over the engine's window, and the rolling-summary state.
 * The estimate is explicitly labelled rough (chars ÷ 4).
 */
export async function handleContextCommand(
  ctx: SessionCtx,
  env: StorageEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  let total = 0;
  let window_: StoredMessage[];
  let summary;
  try {
    total = env.storage.countMessages(ids.userId, ids.chatId);
    window_ = env.storage.history(ids.userId, ids.chatId, ENGINE_WINDOW);
    summary = env.storage.getConversationSummary(ids.userId, ids.chatId);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.storage_error"));
    return;
  }
  const chars = window_.reduce((acc, m) => acc + m.content.length, 0);
  const estTokens = Math.ceil(chars / 4);
  const lines = [
    tr(lang, "cmd_session.context_title"),
    tr(lang, "cmd_session.context_messages", { n: total }),
    tr(lang, "cmd_session.context_tokens", { n: estTokens.toLocaleString("en-US") }),
    tr(lang, "cmd_session.context_window", { n: ENGINE_WINDOW }),
    tr(
      lang,
      summary !== undefined
        ? "cmd_session.context_summary_yes"
        : "cmd_session.context_summary_no",
      { id: summary?.summarisedUntil ?? 0 },
    ),
    tr(lang, "cmd_session.context_note"),
  ];
  await safeReply(ctx, lines.join("\n"));
}

// ------------------------------------------------------------------ /busy ----

const BUSY_MODES = ["queue", "interrupt", "ignore"] as const;
type BusyMode = (typeof BUSY_MODES)[number];

function parseBusyMode(raw: string): BusyMode | undefined {
  const t = raw.trim().toLowerCase();
  return (BUSY_MODES as readonly string[]).includes(t) ? (t as BusyMode) : undefined;
}

/**
 * /busy [queue|interrupt|ignore]: per-user busy behavior preference.
 *
 * DECLARED ONLY: the engine does not honor busy_mode yet; this records the
 * user's choice for future engine work. The reply says so explicitly.
 */
export async function handleBusyCommand(
  ctx: SessionCtx,
  env: PrefsEnv,
  lang: Lang = "fa",
): Promise<void> {
  if (ctx.from === undefined) return;
  const userId = String(ctx.from.id);
  if (env.prefs === undefined) {
    await safeReply(ctx, tr(lang, "cmd_session.prefs_unavailable"));
    return;
  }
  const raw = rawArg(ctx);
  const show = (mode: BusyMode): Promise<void> =>
    safeReply(
      ctx,
      tr(lang, "cmd_session.busy_current", {
        mode: tr(lang, `cmd_session.busy_mode_${mode}`),
      }) +
        "\n" +
        tr(lang, "cmd_session.busy_note"),
    );
  if (raw === undefined) {
    const current = readPref(env.prefs, userId, BUSY_MODE_KEY);
    const mode: BusyMode =
      current !== undefined && parseBusyMode(current) !== undefined
        ? (current as BusyMode)
        : "queue";
    await show(mode);
    return;
  }
  const mode = parseBusyMode(raw);
  if (mode === undefined) {
    await safeReply(ctx, tr(lang, "cmd_session.busy_bad_arg"));
    return;
  }
  try {
    env.prefs.setUserPref(userId, BUSY_MODE_KEY, mode);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.prefs_save_failed"));
    return;
  }
  await safeReply(
    ctx,
    tr(lang, "cmd_session.busy_set", {
      mode: tr(lang, `cmd_session.busy_mode_${mode}`),
    }) +
      "\n" +
      tr(lang, "cmd_session.busy_note"),
  );
}

// ---------------------------------------------------------------- /whoami ----

/**
 * /whoami: the sender's role (owner vs approved user) and the command
 * groups they may use. Read-only; ungated like /help. The owner bit comes
 * from the caller (isOwnerSender), proven from the trusted numeric id.
 */
export async function handleWhoamiCommand(
  ctx: { from?: { id: number | string } | undefined; reply(text: string): Promise<unknown> },
  isOwner: boolean,
  lang: Lang = "fa",
): Promise<void> {
  if (ctx.from === undefined) return;
  const lines = [
    tr(lang, isOwner ? "cmd_session.whoami_owner" : "cmd_session.whoami_user"),
    "",
    tr(lang, "cmd_session.whoami_groups_user"),
  ];
  if (isOwner) {
    lines.push("", tr(lang, "cmd_session.whoami_groups_owner"));
  }
  await safeReply(ctx, lines.join("\n"));
}

// ---------------------------------------------------------------- /footer ----

/**
 * /footer [on|off]: per-user preference toggling a small model/latency
 * footer on replies.
 *
 * DECLARED ONLY: the reply formatter does not honor footer_mode yet; this
 * records the user's choice for future formatter work. The reply says so
 * explicitly.
 */
export async function handleFooterCommand(
  ctx: SessionCtx,
  env: PrefsEnv,
  lang: Lang = "fa",
): Promise<void> {
  if (ctx.from === undefined) return;
  const userId = String(ctx.from.id);
  if (env.prefs === undefined) {
    await safeReply(ctx, tr(lang, "cmd_session.prefs_unavailable"));
    return;
  }
  const raw = rawArg(ctx)?.trim().toLowerCase();
  const show = (on: boolean): Promise<void> =>
    safeReply(
      ctx,
      tr(lang, on ? "cmd_session.footer_current_on" : "cmd_session.footer_current_off") +
        "\n" +
        tr(lang, "cmd_session.footer_note"),
    );
  if (raw === undefined) {
    await show(readPref(env.prefs, userId, FOOTER_MODE_KEY) === "1");
    return;
  }
  let next: "1" | "0" | undefined;
  if (raw === "on" || raw === "1" || raw === "روشن") next = "1";
  else if (raw === "off" || raw === "0" || raw === "خاموش") next = "0";
  if (next === undefined) {
    await safeReply(ctx, tr(lang, "cmd_session.footer_bad_arg"));
    return;
  }
  try {
    env.prefs.setUserPref(userId, FOOTER_MODE_KEY, next);
  } catch {
    await safeReply(ctx, tr(lang, "cmd_session.prefs_save_failed"));
    return;
  }
  await safeReply(
    ctx,
    tr(lang, next === "1" ? "cmd_session.footer_set_on" : "cmd_session.footer_set_off") +
      "\n" +
      tr(lang, "cmd_session.footer_note"),
  );
}

// --------------------------------------------------------------- /version ----

/** /version: the bot version from deps (fallback "dev"). Read-only; ungated. */
export async function handleVersionCommand(
  ctx: { reply(text: string): Promise<unknown> },
  deps: { version?: string },
  lang: Lang = "fa",
): Promise<void> {
  await safeReply(ctx, tr(lang, "cmd_session.version", { version: deps.version ?? "dev" }));
}

// ------------------------------------------------------------------- /new ----

/**
 * /new: start a fresh session — the /reset pattern exactly (cancel the
 * in-flight turn, stop the bot-layer turn registry, clear messages AND the
 * rolling summary via engine.clearHistory), scoped to this chat only.
 */
export async function handleNewCommand(
  ctx: SessionCtx,
  env: NewEnv,
  lang: Lang = "fa",
): Promise<void> {
  const ids = idsOf(ctx);
  if (!ids) return;
  env.engine.cancel(ids.chatId);
  stopTurn(ids.chatId);
  env.engine.clearHistory({ conversationId: ids.chatId, userId: ids.userId });
  await safeReply(ctx, tr(lang, "cmd_session.new_done"));
}

// ---------------------------------------------------------- command defs ----

/** Menu entries for setMyCommands; merged by createBot. None are owner-only. */
export const COMMAND_DEFS: HermesCommandDef[] = [
  { command: "history", descriptionFa: "نمایش تاریخچهٔ گفت‌وگو", descriptionEn: "Show conversation history", ownerOnly: false },
  { command: "save", descriptionFa: "ذخیرهٔ گفت‌وگو به‌صورت فایل", descriptionEn: "Export the conversation to a file", ownerOnly: false },
  { command: "retry", descriptionFa: "تلاش دوبارهٔ آخرین پیام", descriptionEn: "Retry the last message", ownerOnly: false },
  { command: "undo", descriptionFa: "بازگشت و بازنویسی", descriptionEn: "Undo the last turns", ownerOnly: false },
  { command: "title", descriptionFa: "تنظیم عنوان گفت‌وگو", descriptionEn: "Set the conversation title", ownerOnly: false },
  { command: "branch", descriptionFa: "شاخه‌سازی گفت‌وگو", descriptionEn: "Branch the conversation", ownerOnly: false },
  { command: "resume", descriptionFa: "ازسرگیری نشست", descriptionEn: "Resume a past session", ownerOnly: false },
  { command: "sessions", descriptionFa: "نشست‌های قبلی", descriptionEn: "List past sessions", ownerOnly: false },
  { command: "status", descriptionFa: "وضعیت", descriptionEn: "Session status", ownerOnly: false },
  { command: "context", descriptionFa: "وضعیت حافظهٔ زمینه", descriptionEn: "Context window status", ownerOnly: false },
  { command: "busy", descriptionFa: "رفتار هنگام مشغولی", descriptionEn: "Busy-behavior preference", ownerOnly: false },
  { command: "whoami", descriptionFa: "نقش من", descriptionEn: "Show my role", ownerOnly: false },
  { command: "footer", descriptionFa: "پانویس فنی", descriptionEn: "Technical footer preference", ownerOnly: false },
  { command: "version", descriptionFa: "نسخهٔ بابی", descriptionEn: "Show the BOBI version", ownerOnly: false },
  { command: "new", descriptionFa: "شروع نشست تازه", descriptionEn: "Start a fresh session", ownerOnly: false },
];

// ------------------------------------------------------------- registration ----

/**
 * Register the fifteen session commands on the bot.
 *
 * Gating mirrors createBot in bot.ts: every state-changing command runs
 * gateGroup + gateUser first. /whoami, /version and /status are read-only
 * and stay ungated, exactly like /help.
 */
export function registerSessionCommands(bot: Bot, deps: HermesCommandDeps): void {
  const gated = (name: string, run: (ctx: Context, lang: Lang) => Promise<void>): void => {
    bot.command(name, async (ctx) => {
      const lang = senderLang(ctx, deps.prefs);
      if (!(await gateGroup(ctx, deps.groups, lang))) return;
      if (!(await gateUser(ctx, deps))) return;
      await run(ctx, lang);
    });
  };
  const open = (name: string, run: (ctx: Context, lang: Lang) => Promise<void>): void => {
    bot.command(name, async (ctx) => {
      await run(ctx, senderLang(ctx, deps.prefs));
    });
  };

  gated("history", (ctx, lang) => handleHistoryCommand(ctx, deps, lang));
  gated("save", (ctx, lang) => handleSaveCommand(ctx, deps, lang));
  gated("retry", (ctx, lang) => handleRetryCommand(ctx, deps, lang));
  gated("undo", (ctx, lang) => handleUndoCommand(ctx, deps, lang));
  gated("title", (ctx, lang) => handleTitleCommand(ctx, deps, lang));
  gated("branch", (ctx, lang) => handleBranchCommand(ctx, deps, lang));
  gated("resume", (ctx, lang) => handleResumeCommand(ctx, deps, lang));
  gated("sessions", (ctx, lang) => handleSessionsCommand(ctx, deps, lang));
  gated("context", (ctx, lang) => handleContextCommand(ctx, deps, lang));
  gated("busy", (ctx, lang) => handleBusyCommand(ctx, deps, lang));
  gated("footer", (ctx, lang) => handleFooterCommand(ctx, deps, lang));
  gated("new", (ctx, lang) => handleNewCommand(ctx, deps, lang));

  open("whoami", (ctx, lang) => handleWhoamiCommand(ctx, isOwnerSender(ctx, deps), lang));
  open("version", (ctx, lang) => handleVersionCommand(ctx, deps, lang));
  open("status", (ctx, lang) => handleStatusCommand(ctx, deps, lang));
}
