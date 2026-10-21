/**
 * Interactive digest — Telegram wiring for /digest and the dgst: callbacks
 * (Phase-2 item 3).
 *
 * - /digest (owner-only): builds the digest on demand and sends it as a
 *   rich message with tap-to-act inline buttons.
 * - dgst: callbacks: every tap re-checks the owner tier server-side
 *   (defense in depth — the router in bot.ts gates first, this module
 *   re-checks), mutates state through owner-scoped storage calls, then
 *   refreshes the message in place via editMessageText / editMessageReplyMarkup.
 *
 * Pure protocol parsing and rendering live in src/digest/interactive.ts;
 * this module is the thin Telegram glue plus the action implementations.
 *
 * SECURITY (attack-surface review):
 * - The digest aggregates the OWNER's private data. The /digest command and
 *   every dgst: tap run the tier gate (requireOwnerTier in the router) AND
 *   isOwnerCtx here — a forged callback from a non-owner is refused, never
 *   executed. All storage reads/writes are scoped to the tapper's own id.
 * - Callback payloads are server-generated (numeric row ids, small indexes,
 *   store-generated cur-* proposal ids); parseDigestCallback rejects
 *   everything else, and no user text ever enters callback data.
 * - Messages are sent as PLAIN TEXT (no parse_mode): user content rendered
 *   into the digest cannot break formatting or inject fake buttons.
 * - runTaskNow ("▶️ شروع"): the tool action runs through the tool executor
 *   with an owner actor built server-side (same authorizeToolUse path as
 *   cmd_auto's actorForTelegramUser — never from callback data); message
 *   and agent actions may ONLY deliver into the chat the tap came from,
 *   never a different chat. The task's schedule is untouched (one extra
 *   run, not a re-arm).
 * - Proposal approve/reject reuses the curator_decide TOOL (not a private
 *   copy): expiry, one-way status transitions, and apply-first-then-resolve
 *   are enforced exactly as in the tool flow.
 * - Task deletion is two-step (arm → confirm → delete), like the other
 *   destructive actions in the phase-1 UI.
 */
import { type Bot, type Context } from "grammy";
import { t, type Lang } from "../i18n";
import { gateGroup, gateUser, senderLang, type BotDeps } from "./deps";
import { isOwnerCtx, requireOwnerTier } from "./access";
import { blockquoteToEntities } from "./expandable_quote";
import {
  buildDigestData,
  type DigestDeps,
  type DigestProposalStore,
  type DigestSectionData,
  type SearchHeadlinesFn,
} from "../digest/builder";
import {
  DIGEST_CALLBACK_PREFIX,
  parseDigestCallback,
  renderInteractiveDigest,
  renderMemoryCard,
  renderProposalsView,
  type DigestDeleteConfirm,
} from "../digest/interactive";
import type { ScheduledTaskRecord, Storage } from "../storage/storage";
import { fetchWeatherLine } from "../tools/weather";
import { parseTaskAction } from "../tools/scheduled_tasks";
import { authorizeToolUse, toToolActor } from "../auth/tool_bridge";
import type { ToolActor } from "../tools/types";
import type { RegisterOpts } from "./cmd_system";

/** Everything the digest command and its callbacks need. Same shape as the palette env. */
export interface DigestEnv {
  deps: BotDeps;
  sysOpts: RegisterOpts;
}

/** Re-exported so the bot router can branch on the namespace. */
export { DIGEST_CALLBACK_PREFIX } from "../digest/interactive";

/** Minimal proposal-listing surface for the review view. */
interface ProposalLister {
  listPending(userId: string): readonly { id: string; summaryFa: string }[];
}

/** Proposals shown per review view page; the rest are summarized, not dropped silently. */
const PROPOSALS_VIEW_LIMIT = 10;

/**
 * Register the /digest command. Owner-only (two-tier model): the tier gate
 * runs after the group/user gates, same as /personality.
 */
export function registerDigestCommands(bot: Bot, env: DigestEnv): void {
  bot.command("digest", async (ctx) => {
    const lang = senderLang(ctx, env.deps.prefs);
    if (!(await gateGroup(ctx, env.deps.groups, lang))) return;
    if (!(await gateUser(ctx, env.deps))) return;
    if (!(await requireOwnerTier(ctx, env.deps, lang))) return;
    await sendInteractiveDigest(ctx, env, lang);
  });
}

/**
 * Build and send the interactive digest as a fresh message. Never throws:
 * without storage (or when the user cannot be reached) the owner gets an
 * honest note instead of a crash.
 */
export async function sendInteractiveDigest(
  ctx: Context,
  env: DigestEnv,
  lang: Lang = "en",
): Promise<void> {
  const resolved = resolveDigestEnv(env);
  if (resolved.storage === undefined || ctx.from === undefined) {
    await safeReply(ctx, t("digest.toast.unavailable", lang));
    return;
  }
  const data = await buildDigestData(digestDeps(resolved, String(ctx.from.id)));
  const render = renderInteractiveDigest(data, {
    locale: lang,
    canRunTask: resolved.canRunTask,
  });
  try {
    await ctx.reply(render.text, { reply_markup: render.keyboard });
  } catch {
    // The user cannot be reached; nothing more to say.
  }
}

// ---------------------------------------------------------------------------
// Callback handling
// ---------------------------------------------------------------------------

interface ResolvedDigest {
  storage?: Storage;
  proposalStore: DigestProposalStore;
  lister?: ProposalLister;
  searchHeadlines?: SearchHeadlinesFn;
  canRunTask: boolean;
  now?: () => number;
}

function resolveDigestEnv(env: DigestEnv): ResolvedDigest {
  const storage = env.deps.storage;
  const rawStore: unknown = env.sysOpts.proposalStore;
  const hasCount =
    typeof rawStore === "object" &&
    rawStore !== null &&
    typeof (rawStore as { countPending?: unknown }).countPending === "function";
  const proposalStore: DigestProposalStore = hasCount
    ? (rawStore as DigestProposalStore)
    : { countPending: () => 0 };
  const lister: ProposalLister | undefined =
    typeof rawStore === "object" &&
    rawStore !== null &&
    typeof (rawStore as { listPending?: unknown }).listPending === "function"
      ? (rawStore as ProposalLister)
      : undefined;
  return {
    ...(storage !== undefined ? { storage } : {}),
    proposalStore,
    ...(lister !== undefined ? { lister } : {}),
    ...(env.deps.digestSearchHeadlines !== undefined
      ? { searchHeadlines: env.deps.digestSearchHeadlines }
      : {}),
    canRunTask: storage !== undefined,
    ...(typeof env.sysOpts.now === "function" ? { now: env.sysOpts.now } : {}),
  };
}

/** User pref naming the owner's city for the digest weather line. */
export const DIGEST_CITY_PREF_KEY = "digest.city";

function digestDeps(resolved: ResolvedDigest, ownerId: string): DigestDeps {
  // Phase 9: the digest's weather source. The line exists only when the
  // owner has set a `digest.city` pref — no location is ever guessed, and
  // fetchWeatherLine resolves to undefined on any failure, so the digest
  // simply omits the section (byte-identical to before).
  const city =
    resolved.storage?.getUserPref(ownerId, DIGEST_CITY_PREF_KEY)?.trim() ?? "";
  return {
    storage: resolved.storage!,
    proposalStore: resolved.proposalStore,
    userId: ownerId,
    ...(resolved.now !== undefined ? { now: resolved.now } : {}),
    ...(resolved.searchHeadlines !== undefined
      ? { searchHeadlines: resolved.searchHeadlines }
      : {}),
    ...(city.length > 0
      ? {
          weatherLine: () =>
            fetchWeatherLine((url) => fetch(url), city),
        }
      : {}),
  };
}

async function safeReply(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // Unreachable user; not an error.
  }
}

/**
 * Handle one digest callback. The router answers nothing itself; this
 * answers the query (with a toast where the action has one) and either
 * edits the digest message in place or sends a follow-up. Returns true when
 * the data was digest data (valid or forged — forged data is consumed,
 * never executed).
 */
export async function handleDigestCallback(
  ctx: Context,
  env: DigestEnv,
  data: string,
  lang: Lang = "en",
): Promise<boolean> {
  if (!data.startsWith(DIGEST_CALLBACK_PREFIX)) return false;
  const answer = (text?: string): Promise<unknown> =>
    (text === undefined
      ? ctx.answerCallbackQuery()
      : ctx.answerCallbackQuery(text)
    ).catch(() => undefined);

  const action = parseDigestCallback(data);
  if (action === undefined) {
    await answer(); // forged/malformed — safely ignored
    return true;
  }
  // Defense in depth: ownership is re-checked server-side on every tap, even
  // though the router already gated. Fail-closed without auth or sender.
  if (ctx.from === undefined || !isOwnerCtx(ctx, env.deps)) {
    await answer();
    return true;
  }
  const ownerId = String(ctx.from.id);
  const resolved = resolveDigestEnv(env);
  const storage = resolved.storage;
  if (storage === undefined) {
    await answer(t("digest.toast.unavailable", lang));
    return true;
  }

  /** Rebuild the digest and edit the message in place. */
  const refreshDigest = async (
    confirm?: DigestDeleteConfirm,
  ): Promise<void> => {
    const fresh = await buildDigestData(digestDeps(resolved, ownerId));
    const render = renderInteractiveDigest(fresh, {
      locale: lang,
      ...(confirm !== undefined ? { confirm } : {}),
      canRunTask: resolved.canRunTask,
    });
    try {
      await ctx.editMessageText(render.text, {
        reply_markup: render.keyboard,
      });
    } catch {
      // "message is not modified" (nothing changed) or the message is gone —
      // either way there is nothing useful to do.
    }
  };

  /** Swap only the keyboard (for the delete arm/cancel, where the text is unchanged). */
  const swapKeyboard = async (confirm?: DigestDeleteConfirm): Promise<void> => {
    const fresh = await buildDigestData(digestDeps(resolved, ownerId));
    const render = renderInteractiveDigest(fresh, {
      locale: lang,
      ...(confirm !== undefined ? { confirm } : {}),
      canRunTask: resolved.canRunTask,
    });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: render.keyboard });
    } catch {
      // Best effort.
    }
    await answer();
  };

  switch (action.kind) {
    case "refresh":
    case "back": {
      await refreshDigest();
      await answer(t("digest.toast.refreshed", lang));
      return true;
    }

    case "props": {
      await showProposalsView(ctx, resolved, ownerId, lang);
      await answer();
      return true;
    }

    case "task:run": {
      const task = storage.scheduling.getTask(ownerId, action.id);
      if (task === undefined) {
        await answer(t("digest.toast.unavailable", lang));
        return true;
      }
      await answer(t("digest.toast.run_started", lang));
      const outcome = await runTaskNow(ctx, env, task, ownerId, lang);
      await refreshDigest();
      await answer(outcome.toast);
      return true;
    }

    case "task:del": {
      // Arm the two-step confirm on this row; nothing is deleted yet.
      await swapKeyboard({ kind: "task", id: action.id });
      return true;
    }

    case "task:delx": {
      await swapKeyboard();
      return true;
    }

    case "task:delc": {
      storage.scheduling.deleteTask(ownerId, action.id);
      await refreshDigest();
      await answer(t("digest.toast.task_deleted", lang));
      return true;
    }

    case "rem:done": {
      storage.scheduling.cancelReminder(ownerId, action.id);
      await refreshDigest();
      await answer(t("digest.toast.reminder_done", lang));
      return true;
    }

    case "mem:show": {
      const mems = storage.memories.listMemories(ownerId, 3);
      const mem = mems[action.index];
      if (mem === undefined) {
        await answer();
        return true;
      }
      await safeReply(
        ctx,
        renderMemoryCard(
          { key: mem.key, content: mem.content, createdAt: mem.createdAt },
          lang,
        ),
      );
      await answer();
      return true;
    }

    case "prop:ok":
    case "prop:no": {
      const approved = action.kind === "prop:ok";
      const ok = await decideProposal(
        env,
        ctx.from.id,
        action.proposalId,
        approved ? "approve" : "reject",
      );
      await showProposalsView(ctx, resolved, ownerId, lang);
      await answer(
        ok
          ? approved
            ? t("digest.toast.approved", lang)
            : t("digest.toast.rejected", lang)
          : t("digest.toast.decide_failed", lang),
      );
      return true;
    }
  }
}

/** Render the proposal review view and edit the message to it. */
async function showProposalsView(
  ctx: Context,
  resolved: ResolvedDigest,
  ownerId: string,
  lang: Lang,
): Promise<void> {
  let rows: readonly { id: string; summaryFa: string }[] = [];
  try {
    rows = resolved.lister?.listPending(ownerId) ?? [];
  } catch {
    rows = [];
  }
  const shown = rows.slice(0, PROPOSALS_VIEW_LIMIT).map((r) => ({
    id: r.id,
    summary: r.summaryFa,
  }));
  let view = renderProposalsView(shown, lang);
  const hidden = rows.length - shown.length;
  if (hidden > 0) {
    view = {
      text: `${view.text}\n\n${t("digest.proposals_view.more", lang, {
        count: String(hidden),
      })}`,
      keyboard: view.keyboard,
    };
  }
  try {
    await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
  } catch {
    // Best effort.
  }
}

// ---------------------------------------------------------------------------
// Task "run now"
// ---------------------------------------------------------------------------

/**
 * The tool-layer actor for the digest tapper, derived from the trusted
 * numeric id — the same construction as cmd_auto's actorForTelegramUser
 * (server-side policy, never callback data). What the run may do is decided
 * here; which tool runs is the task's own stored action.
 */
function digestActor(deps: BotDeps, telegramId: number): ToolActor {
  const { auth, tools } = deps;
  if (!auth) return { userId: "unknown", permissions: [] };
  const actor = auth.actorFromTelegramUser({ id: telegramId });
  const registered = tools?.registry.list() ?? [];
  return toToolActor(authorizeToolUse(auth, actor, registered));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    });
    return Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run a scheduled task's action ONCE, right now — without touching its
 * schedule (no re-arm, no claim race with the scheduler).
 *
 * Delivery is fail-closed: message/agent actions may only deliver into the
 * chat the tap came from. A task pointed at any other chat gets an honest
 * refusal instead of a cross-chat send.
 */
async function runTaskNow(
  ctx: Context,
  env: DigestEnv,
  task: ScheduledTaskRecord,
  ownerId: string,
  lang: Lang,
): Promise<{ toast: string }> {
  const failed = t("digest.toast.run_failed", lang);
  let action;
  try {
    action = parseTaskAction(JSON.parse(task.actionJson) as unknown);
  } catch {
    return { toast: failed };
  }
  const tapChatId = ctx.chat !== undefined ? String(ctx.chat.id) : "";
  try {
    switch (action.type) {
      case "tool": {
        const { tools } = env.deps;
        if (tools === undefined || ctx.from === undefined) return { toast: failed };
        const actor = digestActor(env.deps, ctx.from.id);
        const res = await withTimeout(
          tools.runTool({
            tool: action.tool,
            input: action.input,
            actor,
            timeoutMs: 60_000,
          }),
          65_000,
        );
        if (res === "timeout" || res.status !== "ok") return { toast: failed };
        return { toast: t("digest.toast.run_ok", lang) };
      }
      case "message": {
        if (tapChatId === "" || action.chatId !== tapChatId) {
          return { toast: t("digest.toast.run_chat_limited", lang) };
        }
        await ctx.api.sendMessage(action.chatId, action.text);
        return { toast: t("digest.toast.run_ok", lang) };
      }
      case "agent": {
        if (tapChatId === "" || action.chatId !== tapChatId || ctx.from === undefined) {
          return { toast: t("digest.toast.run_chat_limited", lang) };
        }
        const actor = digestActor(env.deps, ctx.from.id);
        const out = await withTimeout(
          env.deps.engine.respond({
            conversationId: action.chatId,
            userId: ownerId,
            userText: action.prompt,
            // Bilingual agent output: the run-now turn follows the tapper's
            // /lang — the digest action delivers to their chat.
            lang,
            actor,
          }),
          120_000,
        );
        if (out === "timeout") return { toast: failed };
        for (const chunk of out.chunks) {
          try {
            // Same expandable-quote contract as the chat reply paths: the
            // model may wrap detail in '> ' blocks, and the entities must
            // ride along or the markers leak into the message as raw text.
            const { text, entities } = blockquoteToEntities(chunk);
            await ctx.api.sendMessage(
              action.chatId,
              text,
              entities.length > 0 ? { entities } : undefined,
            );
          } catch {
            // One failed chunk must not fail the run.
          }
        }
        return { toast: t("digest.toast.run_ok", lang) };
      }
    }
  } catch {
    return { toast: failed };
  }
}

// ---------------------------------------------------------------------------
// Curator decisions (reuse the curator_decide tool flow)
// ---------------------------------------------------------------------------

/**
 * Decide on a curator proposal through the curator_decide TOOL — the same
 * flow the agent uses, so expiry, one-way status transitions, and
 * apply-first-then-resolve are enforced identically. The actor is built
 * server-side from the tapper's numeric id.
 */
async function decideProposal(
  env: DigestEnv,
  telegramId: number,
  proposalId: string,
  decision: "approve" | "reject",
): Promise<boolean> {
  const { tools } = env.deps;
  if (tools === undefined) return false;
  try {
    const res = await tools.runTool({
      tool: "curator_decide",
      input: { proposalId, decision },
      actor: digestActor(env.deps, telegramId),
      timeoutMs: 30_000,
    });
    return res.status === "ok";
  } catch {
    return false;
  }
}
