/**
 * Shared Telegram UX helpers for the Hermes-parity command modules
 * (`cmd_session`, `cmd_system`, `cmd_auto`).
 *
 * Three things live here:
 *
 *  1. Slow-operation feedback: `withTyping` (chat-action heartbeat while an
 *     async op runs) and `progressMessage` (one status message edited in
 *     place — the "🧠Thinking…" pattern from bot.ts, factored out).
 *  2. `TOOL_PROGRESS_LABELS`: the COMPLETE per-tool progress label table
 *     that `bot.ts`'s `progressText` should use. `bot.ts` is owned
 *     by another work package; the coordinator swaps the import in one
 *     line (see the wiring note in the final report).
 *  3. Tap-to-act inline buttons: the `sess:` / `mdl:` / `pers:` callback
 *     namespaces, their validators (same discipline as the `lang:` picker
 *     in bot.ts — unknown/forged data maps to undefined and is rejected),
 *     and the keyboard builders.
 *
 * SECURITY notes:
 * - Callback payloads are NEVER authority. Every parser below returns
 *   undefined for anything outside its namespace/shape, and the callers
 *   re-check the value against server state (the caller's own session list,
 *   the registered model catalog, the built-in skin list) before acting.
 * - A userId is always String(ctx.from.id) — server-validated, never
 *   derived from callback data or message text.
 */

import { InlineKeyboard } from "grammy";
import { splitForTelegram } from "../conversation/engine";
import { resolvePersonalityName } from "../personality/personalities";

/** UI language for the shared UX helpers. English-only since v1.0. */
export type UxLang = "en";

/**
 * Format a count: Latin digits with comma grouping.
 * The `lang` parameter is kept so existing call sites keep compiling; it no
 * longer selects anything.
 */
export function formatCount(n: number, lang: UxLang = "en"): string {
  void lang;
  if (!Number.isFinite(n)) return "0";
  const neg = n < 0 ? "-" : "";
  const grouped = Math.trunc(Math.abs(n)).toLocaleString("en-US");
  return `${neg}${grouped}`;
}

// ------------------------------------------------------------- typing ----

/** Chat actions the helpers can drive: "typing" for text work, "upload_voice" while synthesising speech. */
export type ChatAction = "typing" | "upload_voice";

/** Minimal grammy context shape the chat-action helpers need; full Context satisfies it. */
export interface ChatActionCtx {
  chat?: { id: number | string } | undefined;
  api?:
    | {
        sendChatAction(chatId: number | string, action: ChatAction): Promise<unknown>;
      }
    | undefined;
}

/** Minimal grammy context shape `withTyping` needs; full Context satisfies it. */
export interface TypingCtx {
  chat?: { id: number | string } | undefined;
  api: {
    sendChatAction(
      chatId: number | string,
      action: "typing",
    ): Promise<unknown>;
  };
}

/**
 * Telegram's typing indicator lasts ~5s; refresh faster than that.
 * (See docs/UI_AUDIT.md: the audit found NO sendChatAction anywhere —
 * /review, /plan, /moa used to sit silent for tens of seconds.)
 */
const TYPING_HEARTBEAT_MS = 4000;

/**
 * Run `fn` while sending a chat action on a heartbeat interval.
 *
 * Best-effort: a refused chat action stops the heartbeat but never fails
 * the operation; the timer is always cleared afterwards. When there is no
 * chat id or no api (non-Telegram test contexts) `fn` just runs.
 */
export async function withChatAction<T>(
  ctx: ChatActionCtx,
  action: ChatAction,
  fn: () => Promise<T>,
): Promise<T> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || ctx.api === undefined) return fn();
  let stopped = false;
  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      await ctx.api!.sendChatAction(chatId, action);
    } catch {
      // A dead chat or a refused action: stop bothering Telegram.
      stopped = true;
    }
  };
  await beat();
  const timer = setInterval(() => {
    void beat();
  }, TYPING_HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

/**
 * Run `fn` while sending `typing` chat actions on a heartbeat interval.
 *
 * Kept as the named wrapper: existing call sites (progress spinners) mean
 * "typing" specifically, while synthesis uses withChatAction(…, "upload_voice").
 */
export async function withTyping<T>(
  ctx: TypingCtx,
  fn: () => Promise<T>,
): Promise<T> {
  return withChatAction(ctx, "typing", fn);
}

// ---------------------------------------------------- progress message ----

/** Minimal grammy context shape `progressMessage` needs. */
export interface ProgressCtx {
  chat?: { id: number | string } | undefined;
  reply(text: string): Promise<{ message_id?: number } | unknown>;
  api: {
    editMessageText(
      chatId: number | string,
      messageId: number,
      text: string,
    ): Promise<unknown>;
    deleteMessage(
      chatId: number | string,
      messageId: number,
    ): Promise<unknown>;
  };
}

export interface ProgressHandle {
  /** True when the status message was actually posted. */
  readonly posted: boolean;
  /** Replace the status line in place. Best-effort: never throws. */
  update(text: string): Promise<void>;
  /**
   * Deliver the final text: edit the status message with the first chunk
   * (so /refine's "Reviewing…" becomes the answer in place), and send
   * any overflow chunks through `send`. When the status message was never
   * posted (or the edit is refused), everything goes through `send`.
   */
  deliver(
    text: string,
    send: (chunk: string) => Promise<void>,
  ): Promise<void>;
  /** Delete the status message. Best-effort: never throws. */
  finish(): Promise<void>;
}

/**
 * Post one status message ("Working…") and return a handle for in-place
 * updates — the same pattern bot.ts uses for "🧠Thinking…", factored
 * out so command modules don't each re-implement it.
 */
export async function progressMessage(
  ctx: ProgressCtx,
  initialText: string,
): Promise<ProgressHandle> {
  const chatId = ctx.chat?.id;
  let messageId: number | undefined;
  let posted = false;
  if (chatId !== undefined) {
    try {
      const msg = await ctx.reply(initialText);
      if (
        typeof msg === "object" &&
        msg !== null &&
        typeof (msg as { message_id?: unknown }).message_id === "number"
      ) {
        messageId = (msg as { message_id: number }).message_id;
        posted = true;
      }
    } catch {
      posted = false;
    }
  }

  const canEdit = (): boolean =>
    posted && chatId !== undefined && messageId !== undefined;

  return {
    get posted() {
      return posted;
    },
    async update(text: string): Promise<void> {
      if (!canEdit()) return;
      try {
        await ctx.api.editMessageText(chatId!, messageId!, text);
      } catch {
        // Rate limit, unchanged text, deleted message — the run continues.
      }
    },
    async deliver(
      text: string,
      send: (chunk: string) => Promise<void>,
    ): Promise<void> {
      const chunks = splitForTelegram(text);
      if (!canEdit() || chunks.length === 0) {
        for (const c of chunks) await send(c);
        return;
      }
      try {
        await ctx.api.editMessageText(chatId!, messageId!, chunks[0]!);
      } catch {
        // The edit was refused: fall back to plain sends, nothing is lost.
        for (const c of chunks) await send(c);
        return;
      }
      for (const c of chunks.slice(1)) await send(c);
    },
    async finish(): Promise<void> {
      if (!canEdit()) return;
      try {
        await ctx.api.deleteMessage(chatId!, messageId!);
      } catch {
        // An old message the user deleted is not an error.
      }
    },
  };
}

// ------------------------------------------------- tool progress labels ----

/**
 * COMPLETE per-tool progress labels for the engine's onProgress line.
 *
 * `bot.ts`'s local `TOOL_PROGRESS_LABELS` covered only 12 of the 30+
 * registered tools, so most steps showed a raw snake_case name. This table
 * covers every tool the registry can produce (see the coordinator's wiring
 * note: swap the bot.ts const for `toolProgressLabel` below).
 *
 * MCP tools are server-defined and dynamic — they intentionally fall back
 * to the raw name via `toolProgressLabel`.
 */
export const TOOL_PROGRESS_LABELS: Readonly<
  Record<UxLang, Readonly<Record<string, string>>>
> = {
  en: {
    calculator: "calculating",
    date_time: "checking date & time",
    text_utilities: "processing text",
    unit_converter: "converting units",
    fetch_url: "reading page",
    web_search: "searching the web",
    remember: "saving to memory",
    recall: "searching memory",
    forget: "removing from memory",
    remind_at: "setting reminder",
    list_reminders: "listing reminders",
    cancel_reminder: "cancelling reminder",
    search_history: "searching history",
    note_followup: "noting follow-up",
    list_nudges: "listing follow-ups",
    ack_nudge: "acknowledging follow-up",
    snooze_nudge: "snoozing follow-up",
    add_goal: "saving goal",
    list_goals: "listing goals",
    complete_goal: "completing goal",
    schedule_task: "scheduling task",
    list_tasks: "listing tasks",
    cancel_task: "cancelling task",
    usage_report: "building usage report",
    build_digest: "building digest",
    curate_memories: "reviewing memory",
    curator_decide: "applying curator decision",
    skills: "listing skills",
    tool_search: "searching tools",
    delegate: "delegating to agent",
    consult_models: "consulting models",
    generate_image: "generating image",
    generate_video: "generating video",
  },
};

/**
 * The progress label for a tool: the table entry, falling back to the raw
 * tool name (MCP/dynamic tools). Never throws.
 */
export function toolProgressLabel(toolName: string): string {
  return TOOL_PROGRESS_LABELS.en[toolName] ?? toolName;
}

// ------------------------------------------------ callback namespaces ----

/**
 * Tap-to-act callback namespaces. Each is a distinct prefix so the three
 * pickers can never collide with each other, with the `lang:` picker, or
 * with the `menu:*` buttons. Junk/forged data maps to undefined and is
 * rejected — exactly like `langValueForCallback` in bot.ts.
 */
export const SESSION_CALLBACK_PREFIX = "sess:";
export const MODEL_CALLBACK_PREFIX = "mdl:";
export const PERSONALITY_CALLBACK_PREFIX = "pers:";

/**
 * Conversation ids that may travel inside `sess:` callbacks: the shapes the
 * storage layer actually produces (`<chatId>` or `<chatId>:<branch>`).
 * Pure, for tests.
 */
const SESSION_ID_RE = /^[\p{L}\p{N}_:-]{1,80}$/u;

/**
 * Parse `sess:resume:<conversationId>`. Returns the id, or undefined for
 * anything else (wrong prefix, wrong verb, bad charset, too long).
 *
 * The id is NOT authority: the caller must verify it names one of the
 * caller's own conversations (see handleSessionResumeCallback).
 */
export function parseSessionResumeCallback(data: string): string | undefined {
  if (!data.startsWith(SESSION_CALLBACK_PREFIX)) return undefined;
  const rest = data.slice(SESSION_CALLBACK_PREFIX.length);
  const verbEnd = rest.indexOf(":");
  if (verbEnd === -1) return undefined;
  if (rest.slice(0, verbEnd) !== "resume") return undefined;
  const id = rest.slice(verbEnd + 1);
  if (!SESSION_ID_RE.test(id)) return undefined;
  return id;
}

/**
 * Parse `mdl:switch:<numericModelDbId>`. Returns the db id, or undefined
 * for anything else. The caller must re-validate the id against the model
 * catalog (existence + enabled) before switching.
 */
export function parseModelSwitchCallback(data: string): number | undefined {
  if (!data.startsWith(MODEL_CALLBACK_PREFIX)) return undefined;
  const rest = data.slice(MODEL_CALLBACK_PREFIX.length);
  const m = /^switch:(\d{1,12})$/.exec(rest);
  if (m === null || m[1] === undefined) return undefined;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * Parse `pers:<skinName>` into a canonical built-in skin name.
 * Returns undefined for anything that is not a built-in skin — the same
 * validation boundary `resolvePersonalityName` enforces for typed args,
 * so raw callback text can never become prompt text.
 */
export function parsePersonalityCallback(data: string): string | undefined {
  if (!data.startsWith(PERSONALITY_CALLBACK_PREFIX)) return undefined;
  const raw = data.slice(PERSONALITY_CALLBACK_PREFIX.length).trim();
  if (raw.length === 0 || raw.length > 40) return undefined;
  return resolvePersonalityName(raw);
}

/** Shorten a button label without breaking surrogate pairs. */
export function truncateLabel(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : `${chars.slice(0, n).join("")}…`;
}

export interface SessionButtonItem {
  id: string;
  title: string;
}

/**
 * Tap-to-resume keyboard for /sessions: one `▶ title` button per session.
 * The caller filters out the current session (resuming it is a no-op).
 */
export function buildSessionsKeyboard(
  items: readonly SessionButtonItem[],
  _lang: UxLang,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items) {
    kb
      .text(`▶ ${truncateLabel(item.title, 28)}`, `${SESSION_CALLBACK_PREFIX}resume:${item.id}`)
      .row();
  }
  return kb;
}

export interface ModelButtonItem {
  id: number;
  label: string;
  isActive: boolean;
}

/**
 * Quick-switch keyboard for /model: one button per model, the active one
 * marked. Disabled models are listed without a button (tapping them would
 * just bounce with "disabled" — the /model text list already explains).
 */
export function buildModelKeyboard(
  models: readonly ModelButtonItem[],
  lang: UxLang,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const mark = " ✅";
  let inRow = 0;
  for (const m of models) {
    kb.text(
      `${truncateLabel(m.label, 24)}${m.isActive ? mark : ""}`,
      `${MODEL_CALLBACK_PREFIX}switch:${m.id}`,
    );
    inRow++;
    if (inRow % 2 === 0) kb.row();
  }
  return kb;
}

export interface PersonalityButtonItem {
  name: string;
  label: string;
}

/**
 * Tap-to-pick keyboard for /personality: one button per skin, the current
 * one marked. Labels come from the caller (the personalities module) —
 * this builder never invents one.
 */
export function buildPersonalityKeyboard(
  skins: readonly PersonalityButtonItem[],
  current: string,
  lang: UxLang,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const mark = " ✅";
  for (const s of skins) {
    kb
      .text(
        `${truncateLabel(s.label, 24)}${s.name === current ? mark : ""}`,
        `${PERSONALITY_CALLBACK_PREFIX}${s.name}`,
      )
      .row();
  }
  return kb;
}
