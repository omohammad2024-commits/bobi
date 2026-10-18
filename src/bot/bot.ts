import { Bot, Context } from "grammy";
import { buildMainMenu, replyForCallback, CALLBACKS } from "./menu";
import { shouldHandleMessage } from "./filter";
import type { ConversationEngine } from "../conversation/engine";
import { EngineError } from "../conversation/engine";
import type { AgentStep } from "../agent/transcript";
import type { ToolService } from "../tools/service";
import type { ToolActor } from "../tools/types";
import type { AuthorizationService } from "../auth/service";
import { authorizeToolUse, toToolActor } from "../auth/tool_bridge";
import { userMessageFor, isToolError } from "../tools/errors";
import type { GroupAccessService } from "../groups/service";
import type { PanelController } from "../groups/controller";
import type { AiAdminController } from "../groups/ai_controller";
import { checkGroupAccess, denialNote } from "../groups/enforcement";
import type { UserAccessService } from "../auth/user_service";
import type { UserPanelController } from "../auth/user_controller";
import { checkUserAccess, userDenialNote } from "../auth/user_enforcement";
import { USER_NOT_APPROVED, USER_REVOKED } from "../auth/user_panel";
import { extractMedia, hasMedia } from "./media";
import type { RateLimiter } from "../core/rate_limit";
import type { UsageService } from "../core/usage";

export interface BotDeps {
  engine: ConversationEngine;
  /**
   * Bot token, needed to download attachment bytes.
   *
   * Telegram reports a file's `file_path` but not its content, and the download
   * URL embeds the token. It is passed here rather than read from the
   * environment so this module never touches configuration directly.
   */
  botToken?: string;
  /** Optional until tools are wired at the call site. */
  tools?: ToolService;
  /** Central authorization; when absent, tools stay unavailable. */
  auth?: AuthorizationService;
  /** Group approval store. When absent, group messages are not gated. */
  groups?: GroupAccessService;
  /** Private-chat user approval. When absent, direct messages are not gated. */
  users?: UserAccessService;
  /** User-access panel controller; absent means no user approval UI. */
  userPanel?: UserPanelController;
  /** Owner panel controller; absent means no /admin route. */
  panel?: PanelController;
  /** AI management controller; absent means no /ai route. */
  aiAdmin?: AiAdminController;
  /** Per-user budgets. When absent, nothing is rate limited. */
  rateLimit?: RateLimiter;
  /** Usage accounting. When absent, spend is not recorded. */
  usage?: UsageService;
}

/** Shown once to a group that is not approved yet. */
const GROUP_NOT_READY =
  "این ربات در این گروه هنوز فعال نیست. مالک ربات باید ابتدا دسترسی را تأیید کند.";

/**
 * The tool-layer actor for a Telegram user, derived from the Authorization
 * Core's trusted numeric id.
 *
 * This is the only place a Telegram identity becomes tool permissions. It
 * reads `ctx.from.id` (server-validated) and applies server-side policy, so
 * message text, callback data, or a username cannot widen the grant. The model
 * chooses which tool to call; what it may call is decided here, on the server.
 */
function toolActorFor(
  tools: ToolService,
  auth: AuthorizationService | undefined,
  ctx: Context,
): ToolActor {
  if (!auth) return { permissions: [], userId: "unknown" };
  // ctx.from is absent for channel posts; treat that as no identity at all
  // rather than guessing, so such an update gets no tool access.
  const actor = ctx.from ? auth.actorFromTelegramUser(ctx.from) : undefined;
  return toToolActor(authorizeToolUse(auth, actor, tools.registry.list()));
}

/**
 * Group access gate.
 *
 * Called before anything else runs for a group update. A pending, rejected,
 * or revoked group never reaches the engine, the provider, or a tool, and the
 * decision is read from the database each time.
 */
async function gateGroup(ctx: Context, groups: GroupAccessService | undefined): Promise<boolean> {
  // No store configured: nothing to enforce. Groups simply stay ungated.
  if (!groups) return true;
  if (!ctx.chat) return true;

  const decision = checkGroupAccess(groups, {
    chatType: ctx.chat.type,
    chatId: String(ctx.chat.id),
  });
  if (decision.allowed) return true;

  console.error(`[sol] group blocked: ${denialNote({ chatType: ctx.chat.type, chatId: String(ctx.chat.id) }, decision)}`);
  try {
    await ctx.reply(GROUP_NOT_READY);
  } catch {
    // A blocked group may have removed the bot; that is not an error.
  }
  return false;
}

/**
 * Private-chat access gate.
 *
 * A private chat has no other gate, so this is what stands between an unknown
 * Telegram account and the owner's API budget. The owner is exempt; everyone
 * else needs an approved row.
 *
 * The first message from an unknown account is recorded as `pending` and the
 * owner is notified, so access can be granted without the user being told to
 * come back later.
 */
async function gateUser(
  ctx: Context,
  deps: BotDeps,
): Promise<boolean> {
  const { users } = deps;
  if (!users || !ctx.chat || !ctx.from) return true;

  const auth = deps.auth;
  const actor = auth ? auth.actorFromTelegramUser(ctx.from) : undefined;
  const isOwner = auth !== undefined && auth.isOwner(actor);
  const userId = String(ctx.from.id);

  const decision = checkUserAccess(users, {
    userId,
    isOwner,
    chatType: ctx.chat.type,
  });
  if (decision.allowed) return true;

  // Record the request on first contact, so the owner has something to approve.
  // An existing row (of any state) is left alone, which is what stops a
  // rejected account from re-requesting by messaging again.
  if (decision.state === "unknown") {
    const registered = users.registerUser({
      userId,
      ...(ctx.from.username !== undefined ? { username: ctx.from.username } : {}),
      ...(ctx.from.first_name !== undefined ? { firstName: ctx.from.first_name } : {}),
    });
    if (registered.created) {
      // A delivery failure must not approve anyone: the row stays pending.
      await deps.userPanel?.notifyOwnerRequest({ userId });
    }
  }

  console.error(
    `[sol] user blocked: ${userDenialNote({ userId, isOwner, chatType: ctx.chat.type }, decision)}`,
  );
  await safeReply(
    ctx,
    decision.state === "revoked" ? USER_REVOKED : USER_NOT_APPROVED,
  );
  return false;
}

/** Reply, tolerating a failure (blocked bot, deleted message). */
async function safeReply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // A user who blocked the bot cannot be told anything; that is not an error.
  }
}

/**
 * A progress message that is edited in place as the run proceeds.
 *
 * A tool-using run can take tens of seconds. Without this the user sees nothing
 * until it finishes and reasonably concludes the bot is broken. The message is
 * edited rather than re-sent so a run that calls six tools does not leave six
 * messages behind.
 *
 * Every method is best-effort: if Telegram refuses the edit, the run continues
 * and the final answer is still delivered.
 */
function createProgress(ctx: Context) {
  let messageId: number | undefined;
  let sent = false;

  return {
    /** Post the initial "working on it" message. */
    async start(): Promise<void> {
      try {
        const msg = await ctx.reply(PROGRESS_THINKING);
        messageId = msg.message_id;
        sent = true;
      } catch {
        sent = false;
      }
    },

    /** Replace the text with a new status line. */
    async update(text: string): Promise<void> {
      if (!sent || messageId === undefined) return;
      try {
        await ctx.api.editMessageText(ctx.chat!.id, messageId, text);
      } catch {
        // A rejected edit (rate limit, unchanged text) must not fail the run.
      }
    },

    /**
     * Remove the progress message once the answer is ready.
     *
     * Deleting rather than leaving it means the chat shows the answer alone —
     * the transient status has served its purpose.
     */
    async finish(): Promise<void> {
      if (!sent || messageId === undefined) return;
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, messageId);
      } catch {
        // An old message the user deleted is not an error.
      }
    },
  };
}

const PROGRESS_THINKING = "در حال فکر کردن…";

/** A short Persian label for a tool, for the progress line. */
const TOOL_PROGRESS_LABELS: Readonly<Record<string, string>> = {
  calculator: "محاسبه",
  date_time: "بررسی تاریخ",
  text_utilities: "تحلیل متن",
  unit_converter: "تبدیل واحد",
  fetch_url: "خواندن صفحه",
  web_search: "جستجوی وب",
  remember: "ذخیره در حافظه",
  recall: "جستجوی حافظه",
  forget: "پاک کردن از حافظه",
  remind_at: "تنظیم یادآور",
  list_reminders: "فهرست یادآورها",
  cancel_reminder: "لغو یادآور",
};

/** The progress line for one step. Returns undefined for steps not shown. */
function progressText(step: AgentStep): string | undefined {
  if (step.kind !== "tool") return undefined;
  const label = TOOL_PROGRESS_LABELS[step.name] ?? step.name;
  return step.status === "ok" ? `در حال ${label}…` : `${label} انجام شد.`;
}

/**
 * Enforce the per-user message budget.
 *
 * The owner is exempt: locking the owner out of their own bot over a burst is
 * worse than the burst. A refusal says how long to wait, so it reads as a limit
 * rather than a failure.
 */
async function takeMessageBudget(ctx: Context, deps: BotDeps): Promise<boolean> {
  const { rateLimit, auth } = deps;
  if (!rateLimit || !ctx.from) return true;

  const actor = auth ? auth.actorFromTelegramUser(ctx.from) : undefined;
  if (actor !== undefined && auth?.isOwner(actor)) return true;

  const decision = rateLimit.takeMessage(String(ctx.from.id));
  if (decision.allowed) return true;

  const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
  console.error("[sol] rate limited: user message budget");
  await safeReply(ctx, `کمی سریع پیش می‌روی. حدود ${seconds} ثانیهٔ دیگر دوباره تلاش کن.`);
  return false;
}

/**
 * Run one user turn: gates, engine, delivery, accounting.
 *
 * Both the text and the media paths go through here, so there is exactly one
 * place that decides whether a message may reach the engine and one place that
 * records what it cost. Duplicating that per message type is how a gate ends up
 * missing from one of them.
 *
 * Attachments are downloaded HERE rather than by the caller, so a failed
 * download is reported to the user alongside the answer instead of being
 * swallowed.
 */
async function runTurn(
  ctx: Context,
  deps: BotDeps,
  input: { text: string },
): Promise<void> {
  const { engine } = deps;

  // Private-chat gate: an unapproved user never reaches the engine, so an
  // unknown account cannot spend the owner's API budget.
  if (!(await gateUser(ctx, deps))) return;

  // Per-user message budget. The agent makes this necessary: one message can
  // become several provider calls, so a burst of messages is no longer a burst
  // of one call each.
  if (!(await takeMessageBudget(ctx, deps))) return;

  if (!ctx.message || !ctx.from || !ctx.chat) return;
  if (!shouldHandleMessage(ctx, ctx.me.id)) return;

  const conversationId = String(ctx.chat.id);
  const userId = String(ctx.from.id);

  // Tools run as this actor, resolved from the trusted numeric id. Without a
  // tool service the turn still answers — it simply has no tools.
  const actor = deps.tools ? toolActorFor(deps.tools, deps.auth, ctx) : undefined;

  // Show that work has started; a tool-using run can take tens of seconds.
  const progress = createProgress(ctx);
  await progress.start();

  try {
    // Attachments are fetched before the gate on emptiness, so a caption-less
    // photo is still a valid turn.
    const media = hasMedia(ctx.message)
      ? await extractMedia(ctx, deps.botToken ?? "")
      : { parts: [], skipped: [], text: input.text };

    const text = input.text.trim() || media.text.trim();
    const parts = media.parts;

    // A message with nothing usable at all is answered rather than silently
    // dropped: the user sent something and deserves to know it did not arrive.
    if (text.length === 0 && parts.length === 0) {
      await progress.finish();
      await safeReply(ctx, describeNothingUsable(media.skipped));
      return;
    }

    const out = await engine.respond({
      conversationId,
      userId,
      userText: text,
      ...(actor !== undefined ? { actor } : {}),
      ...(parts.length > 0 ? { parts } : {}),
      onProgress: (step) => {
        const line = progressText(step);
        if (line !== undefined) void progress.update(line);
      },
    });

    // Remove the status line before the answer, so the chat shows only the
    // reply once it exists.
    await progress.finish();

    // An attachment that could not be used is named before the answer, so the
    // model's reply is not read as a comment on something it never received.
    const note = describeSkipped(media.skipped);
    if (note.length > 0) await ctx.reply(note);

    for (const chunk of out.chunks) {
      await ctx.reply(chunk);
    }
    // A run that hit a budget got a best-effort answer; saying so is more
    // honest than presenting it as complete.
    if (out.truncated) {
      await ctx.reply("برای این پاسخ به سقف تعداد مراحل رسیدم؛ اگر لازم است دقیق‌تر بپرس.");
    }
    // Recorded after delivery: the spend already happened, so a failed send
    // must not hide it.
    deps.usage?.record({
      userId,
      requests: 1,
      toolCalls: out.toolCalls,
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
    });
  } catch (err) {
    // Clear the status line first: leaving "thinking…" above an error message
    // would suggest the bot is still working.
    await progress.finish();
    await replyToFailure(ctx, err);
    // Technical detail stays in logs, never the secret or payload.
    console.error("[bobi] conversation error:", errToLog(err));
  }
}

/** A short note about attachments that could not be used. */
function describeSkipped(skipped: readonly { kind: string; reason: string }[]): string {
  if (skipped.length === 0) return "";
  const lines = skipped.map((s) =>
    s.reason === "too_large"
      ? `• ${s.kind}: حجمش بیش از حد مجاز بود.`
      : s.reason === "unsupported"
        ? `• ${s.kind}: این نوع فایل پشتیبانی نمی‌شود.`
        : `• ${s.kind}: دریافت نشد.`,
  );
  return ["این پیوست‌ها استفاده نشدند:", ...lines].join("\n");
}

/** The reply when a message carried nothing that could be used. */
function describeNothingUsable(skipped: readonly { kind: string; reason: string }[]): string {
  const note = describeSkipped(skipped);
  return note.length > 0 ? note : "پیام خالی است.";
}

export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token);
  const { engine, groups, panel, aiAdmin, userPanel } = deps;

  // ---- /start — always respond, private & group ----
  // Deliberately NOT gated: a greeting in any chat is harmless and carries no
  // reasoning, tool access, or stored content. Every entry that does — the
  // tools menu button and the conversation engine — is gated separately.
  bot.command("start", async (ctx) => {
    await ctx.reply("سلام! من BOBI هستم. یک گزینه را انتخاب کن:", {
      reply_markup: buildMainMenu(),
    });
  });

  // ---- /admin — owner-only panel entry ----
  bot.command("admin", async (ctx) => {
    if (panel) await panel.openPanel(ctx);
  });

  // ---- /ai — owner-only AI management entry ----
  bot.command("ai", async (ctx) => {
    if (aiAdmin) await aiAdmin.open(ctx);
  });

  // ---- bot added to / removed from a group ----
  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember;
    if (!update) return;
    const chat = update.chat;
    // Only groups and supergroups participate in the approval workflow.
    if (chat.type !== "group" && chat.type !== "supergroup") return;

    const botId = ctx.me?.id;
    const newStatus = update.new_chat_member?.status;
    const wasMember =
      newStatus === "member" || newStatus === "administrator" || newStatus === "creator";
    const status = wasMember ? "added" : "removed";
    if (botId === undefined) return;

    if (status === "added" && panel) {
      // `from` is the person who performed the action; it is not assumed to be
      // the group's owner, and it is only recorded when genuinely present.
      const requester = update.from;
      const created = deps.groups?.registerGroup({
        chatId: String(chat.id),
        chatType: chat.type === "supergroup" ? "supergroup" : "group",
        // Omit rather than pass undefined (exactOptionalPropertyTypes).
        ...(chat.title !== undefined ? { title: chat.title } : {}),
        ...(requester ? { requestedBy: String(requester.id) } : {}),
      });
      // Only the first insert for a chat leads to a notification, so repeated
      // membership updates cannot storm the owner.
      if (created?.created) {
        const sent = await panel.notifyOwnerRequest({
          chatId: String(chat.id),
          title: chat.title,
          chatType: chat.type === "supergroup" ? "supergroup" : "group",
        });
        if (!sent) {
          // The group stays pending; a delivery failure is never an approval.
          console.error("[sol] owner notification failed for pending group");
        }
      }
    }
  });

  // ---- menu buttons ----
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // The owner panel is checked BEFORE the group gate on purpose: an owner
    // administering from any chat — including a group that is pending, revoked
    // or not yet known — must be able to fix it. Authority here comes from
    // AdminBoundary re-checking the owner per click, never from group approval,
    // so this is not a bypass of the permission model.
    if (panel) {
      const handled = await panel.handleCallback(ctx, data);
      if (handled) return;
    }
    // The AI section is its own namespace; every click re-authorizes too.
    if (aiAdmin) {
      const handled = await aiAdmin.handleCallback(ctx, data);
      if (handled) return;
    }
    // The user-access section; every click re-authorizes via users.manage.
    if (userPanel) {
      const handled = await userPanel.handleCallback(ctx, data);
      if (handled) return;
    }
    // Ordinary menu buttons DO depend on group approval, so the gate applies.
    for (const cb of Object.values(CALLBACKS)) {
      if (data !== cb) continue;
      if (!(await gateGroup(ctx, groups))) return;
      if (!(await gateUser(ctx, deps))) return;
      // The tools entry shows the real list of active tools from the Registry.
      // Visibility is not authorization — the Executor still checks per run.
      const active = cb === CALLBACKS.tools ? deps.tools?.listActiveNames() : undefined;
      await ctx.answerCallbackQuery();
      await ctx.reply(replyForCallback(cb, active), { reply_markup: buildMainMenu() });
      return;
    }

    // Unknown callback data: answered so Telegram stops its loading indicator.
    await ctx.answerCallbackQuery().catch(() => undefined);
  });

  // ---- text messages → conversation engine ----
  bot.on("message:text", async (ctx) => {
    // Group gate runs first: an unapproved group never reaches reasoning.
    if (!(await gateGroup(ctx, groups))) return;

    const text = ctx.message.text;

    // An owner mid-way through an AI form has their reply consumed here rather
    // than sent to the model. Consuming is gated on the owner's own pending
    // state, and the write itself re-authorizes inside the controller.
    //
    // This runs BEFORE the user gate on purpose: it is how the owner
    // administers, and the owner is exempt from the user gate anyway.
    if (aiAdmin && !text.startsWith("/")) {
      const consumed = await aiAdmin.handleText(ctx, text);
      if (consumed) return;
    }

    if (text.startsWith("/")) return; // unknown command — stay silent
    await runTurn(ctx, deps, { text });
  });

  // ---- media messages → conversation engine ----
  //
  // A photo, voice note, or document is an ordinary turn whose content happens
  // to be an attachment. The gates below are the same ones the text path uses,
  // applied through `runTurn` so there is one place that decides whether a
  // message may reach the engine.
  for (const kind of ["message:photo", "message:voice", "message:audio", "message:document"] as const) {
    bot.on(kind, async (ctx) => {
      if (!(await gateGroup(ctx, groups))) return;
      await runTurn(ctx, deps, { text: ctx.message.caption ?? "" });
    });
  }

  // ---- edited messages ----
  // Explicit policy: an edit never produces a fresh reply. Answering an edited
  // message would read as a duplicate answer to the same turn, so the engine is
  // not invoked for edits at all. The group gate still runs first, so an edit
  // is not a way to reach the engine from an unapproved group.
  bot.on("edited_message:text", async (ctx) => {
    if (!(await gateGroup(ctx, groups))) return;
    if (!(await gateUser(ctx, deps))) return;
    // Deliberately no engine call: edits are not re-answered.
  });

  bot.catch((err) => {
    console.error("[sol] bot error:", err.message);
  });

  return bot;
}

/** Short Persian message per error kind; technical detail stays in logs. */
function userFacingMessage(err: unknown): string {
  if (err instanceof EngineError) {
    switch (err.kind) {
      case "empty_input": return "پیام خالی است.";
      case "empty_response": return "پاسخی دریافت نشد؛ دوباره تلاش کن.";
      case "auth": return "سرویس در دسترس نیست (احراز هویت).";
      case "quota": return "سقف استفاده پر شده؛ کمی بعد تلاش کن.";
      case "network": return "خطای شبکه؛ دوباره تلاش کن.";
      case "timeout":
      case "aborted": return "پاسخ خیلی طول کشید؛ لغو شد.";
      case "overloaded": return "سیستم شلوغ است؛ لحظه‌ای بعد تلاش کن.";
      // A newer message replaced this run: the user already moved on, so
      // replying about the abandoned one would be noise.
      case "superseded": return "";
      default: return "خطای موقت؛ دوباره تلاش کن.";
    }
  }
  if (isToolError(err)) return userMessageFor(err.kind);
  return "خطای غیرمنتظره.";
}

/**
 * Reply to a failed turn, unless the failure was supersession.
 *
 * Returns false when nothing was sent, so the caller can skip logging a turn
 * that produced no visible outcome.
 */
async function replyToFailure(ctx: Context, err: unknown): Promise<boolean> {
  const message = userFacingMessage(err);
  if (message.length === 0) return false;
  try {
    await ctx.reply(message);
    return true;
  } catch {
    return false;
  }
}

function errToLog(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
