/**
 * Panel controller — where every admin action is authorized.
 *
 * This is the hand-off point between Telegram and the security core. Nothing
 * here trusts a callback payload as proof of authority: the actor is rebuilt
 * from the trusted `ctx.from.id` and each decision goes through
 * `AdminBoundary.runAdmin`, which re-checks identity and the required
 * permission at execution time and audits the outcome.
 *
 * Panel button clicks edit the panel message in place (editMessageText) instead
 * of stacking a new message per click. The /admin command itself still opens
 * with a new message.
 */
import { Context, InlineKeyboard } from "grammy";
import type { AdminBoundary } from "../auth/admin_boundary";
import type { AuthorizationService } from "../auth/service";
import type { Permission } from "../auth/roles";
import { resolveLang } from "../i18n";
import { decode, encode, type PanelAction } from "./callbacks";
import { GroupAccessService } from "./service";
import {
  PANEL_DENIED,
  PANEL_STALE,
  PAGE_SIZE,
  approvedKeyboard,
  approvedText,
  backKeyboard,
  panelMenuKeyboard,
  panelMenuText,
  pendingKeyboard,
  pendingText,
  requestNotificationText,
  revokeKeyboard,
  revokeText,
  statusText,
} from "./panel";
import { tr, type PanelLang } from "./panel_strings";

export interface PanelOptions {
  auth: AuthorizationService;
  admin: AdminBoundary;
  groups: GroupAccessService;
  /** Dry-run sink for owner notifications; injected so tests need no network. */
  notify: (chatId: string, text: string, keyboard: unknown) => Promise<boolean>;
  /** Non-secret runtime info for the status view. */
  statusInfo: () => { provider: string; model: string };
  /** Today's usage totals; omitted when accounting is not wired. */
  usageInfo?: () => {
    requests: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    estimated: boolean;
  };
  /**
   * Owner language preference reader. Panels follow the owner's /lang choice;
   * Persian when unset.
   */
  prefs?: (userId: string, key: string) => string | undefined;
}

/**
 * Permissions used by panel actions.
 *
 * `groups.manage` (a write) is deliberately separate from `groups.review`
 * (a read), so granting review rights later cannot silently grant approvals.
 */
const PERM_REVIEW: Permission = "groups.review";
const PERM_MANAGE: Permission = "groups.manage";
const PERM_VIEW: Permission = "admin.view";

/**
 * The actions this controller owns.
 *
 * Listed explicitly rather than inferred, so a new action added to the codec
 * cannot be silently claimed by the wrong panel. Every entry here has a case in
 * `dispatch`; anything else belongs to another controller and must be left for
 * it.
 */
const GROUP_ACTION_KINDS: ReadonlySet<PanelAction["kind"]> = new Set([
  "menu",
  "status",
  "pending",
  "approved",
  "revoke_menu",
  "approve",
  "reject",
  "revoke",
] as const);

export class PanelController {
  private readonly auth: AuthorizationService;
  private readonly admin: AdminBoundary;
  private readonly groups: GroupAccessService;
  private readonly notify: PanelOptions["notify"];
  private readonly statusInfo: () => { provider: string; model: string };
  private readonly usageInfo: PanelOptions["usageInfo"];
  private readonly prefs: PanelOptions["prefs"];

  constructor(opts: PanelOptions) {
    this.auth = opts.auth;
    this.admin = opts.admin;
    this.groups = opts.groups;
    this.notify = opts.notify;
    this.statusInfo = opts.statusInfo;
    this.usageInfo = opts.usageInfo;
    this.prefs = opts.prefs;
  }

  /** Actor from a trusted context; undefined when identity is absent. */
  private actorFor(ctx: Context) {
    const from = ctx.from;
    if (!from) return undefined;
    return this.auth.actorFromTelegramUser(from);
  }

  /** The owner's panel language: Persian unless they chose English. */
  private langFor(ctx: Context): PanelLang {
    const id = ctx.from?.id;
    if (id === undefined || this.prefs === undefined) return "fa";
    return resolveLang(String(id), this.prefs);
  }

  /** `/admin` — open the panel for the owner only. */
  async openPanel(ctx: Context): Promise<void> {
    const actor = this.actorFor(ctx);
    const lang = this.langFor(ctx);
    // Reading the panel requires the admin-view permission at execution time.
    const result = await this.admin.runAdmin(
      { actor, operation: "panel.open", permission: PERM_VIEW },
      () => ({ text: panelMenuText(lang), keyboard: panelMenuKeyboard(lang) }),
    );

    if (!result.ok) {
      await this.deny(ctx);
      return;
    }
    await this.render(ctx, result.data.text, result.data.keyboard);
  }

  /**
   * Any click that may be a panel button.
   *
   * Returns true only for the actions THIS controller owns, so the other panels
   * still receive their own callbacks. Anything unrecognised is left for the
   * caller to route rather than being claimed and dropped.
   */
  async handleCallback(ctx: Context, data: string): Promise<boolean> {
    const action = decode(data);
    if (!action) {
      // Not panel data at all: let the caller route it normally.
      return false;
    }

    // Only the group actions may be claimed here.
    //
    // This guard is load-bearing. An earlier version returned true for ANY
    // decodable action, and because the router asks this controller first, an
    // `ai_menu` callback was claimed here, matched no case in dispatch, and
    // returned true — so the AI controller was never reached and EVERY button
    // in /ai silently did nothing.
    if (!GROUP_ACTION_KINDS.has(action.kind)) return false;

    await this.dispatch(ctx, action);
    return true;
  }

  private async dispatch(ctx: Context, action: PanelAction): Promise<void> {
    const actor = this.actorFor(ctx);
    const lang = this.langFor(ctx);

    switch (action.kind) {
      case "menu":
        await this.openPanel(ctx);
        return;

      case "status": {
        const r = await this.admin.runAdmin(
          { actor, operation: "panel.status", permission: PERM_VIEW },
          () => {
            const s = this.statusInfo();
            const usage = this.usageInfo?.();
            const text = statusText(
              {
                pending: this.groups.countPending(),
                approved: this.groups.countApproved(),
                provider: s.provider,
                model: s.model,
                ...(usage !== undefined ? { usage } : {}),
              },
              lang,
            );
            return { text, keyboard: backKeyboard(lang) };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "pending": {
        const r = await this.admin.runAdmin(
          { actor, operation: "panel.pending", permission: PERM_REVIEW },
          () => this.pendingView(action.offset, lang),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "approved": {
        const r = await this.admin.runAdmin(
          { actor, operation: "panel.approved", permission: PERM_REVIEW },
          () => this.approvedView(action.offset, lang),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "revoke_menu": {
        const r = await this.admin.runAdmin(
          { actor, operation: "panel.revoke_menu", permission: PERM_REVIEW },
          () => this.revokeView(action.offset, lang),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "approve":
        await this.decide(ctx, actor, "approve", action.chatId, lang);
        return;

      case "reject":
        await this.decide(ctx, actor, "reject", action.chatId, lang);
        return;

      case "revoke":
        await this.decide(ctx, actor, "revoke", action.chatId, lang);
        return;
    }
  }

  /**
   * Snap a requested page back to the last page that still holds rows.
   *
   * This is what keeps a stale offset — after the group was handled, or rows
   * disappeared — from showing an empty or misleading page.
   */
  private pageStart(offset: number, total: number): number {
    const lastPage = Math.max(0, Math.ceil(Math.max(total, 0) / PAGE_SIZE) - 1);
    return Math.min(Math.max(offset, 0), lastPage * PAGE_SIZE);
  }

  /** A non-finite or negative offset from a stale callback reads as page 1. */
  private normalizeOffset(offset: number): number {
    if (!Number.isSafeInteger(offset) || offset < 0) return 0;
    return offset;
  }

  /** The pending page, read fresh so a decision made elsewhere is reflected. */
  private pendingView(offset: number, lang: PanelLang): { text: string; keyboard: unknown } {
    const total = this.groups.countPending();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.groups.listPending(PAGE_SIZE, start);
    return {
      text: pendingText(items, start, total, lang),
      keyboard: pendingKeyboard(items, start, lang),
    };
  }

  /** The approved-groups page. */
  private approvedView(offset: number, lang: PanelLang): { text: string; keyboard: unknown } {
    const total = this.groups.countApproved();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.groups.listApproved(PAGE_SIZE, start);
    return {
      text: approvedText(items, start, total, lang),
      keyboard: approvedKeyboard(items, start, lang),
    };
  }

  /** The same approved page, framed as a revoke picker. */
  private revokeView(offset: number, lang: PanelLang): { text: string; keyboard: unknown } {
    const total = this.groups.countApproved();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.groups.listApproved(PAGE_SIZE, start);
    return {
      text: revokeText(items, start, total, lang),
      keyboard: revokeKeyboard(items, start, lang),
    };
  }

  /** Approve / reject / revoke behind the boundary, per target group. */
  private async decide(
    ctx: Context,
    actor: ReturnType<PanelController["actorFor"]>,
    kind: "approve" | "reject" | "revoke",
    chatId: string,
    lang: PanelLang,
  ): Promise<void> {
    const r = await this.admin.runAdmin(
      {
        actor,
        operation: `group.${kind}`,
        permission: PERM_MANAGE,
        // The target is audit metadata, never a claim of authority.
        targetId: chatId,
      },
      () => {
        const ownerId = String(actor?.id ?? "");
        switch (kind) {
          case "approve":
            return this.groups.approve(chatId, ownerId);
          case "reject":
            return this.groups.reject(chatId, ownerId);
          case "revoke":
            return this.groups.revoke(chatId, ownerId);
        }
      },
    );

    if (!r.ok) {
      await this.deny(ctx);
      return;
    }

    const t = r.data;
    if (!t.ok) {
      // Missing record or a state that forbids this transition (stale click).
      await this.render(ctx, PANEL_STALE, backKeyboard(lang));
      return;
    }

    // Re-render from the database inside the SAME authorized run, so the
    // refresh is covered by the boundary's error handling. Showing "done"
    // before the follow-up read would report a success the store may not hold.
    const done = tr(lang, `panel.group.decided.${kind}`);

    const refresh = await this.admin.runAdmin(
      {
        actor,
        operation: `group.${kind}.refresh`,
        // Reading a list back needs the review permission, never a wider one.
        permission: PERM_REVIEW,
        targetId: chatId,
      },
      () => (kind === "revoke" ? this.revokeView(0, lang) : this.pendingView(0, lang)),
    );

    if (!refresh.ok) {
      // The decision was persisted, but the refreshed view failed: report the
      // outcome the owner actually achieved without inventing list content.
      await this.render(ctx, done, backKeyboard(lang));
      return;
    }

    // A revoke returns to the revoke picker (the row is gone from it), while
    // approve/reject return to the pending list (the row is gone from there).
    await this.render(ctx, `${done}\n\n${refresh.data.text}`, refresh.data.keyboard);
  }

  /**
   * Notify the owner that the bot was added to a group.
   *
   * A failed delivery leaves the group `pending` and never notifies twice, so
   * a Telegram outage cannot be mistaken for an approval.
   */
  async notifyOwnerRequest(group: { chatId: string; title?: string; chatType: "group" | "supergroup" | "channel" }): Promise<boolean> {
    const row = this.groups.pendingGroup(group.chatId);
    if (!row || !this.groups.needsNotification(group.chatId)) return false;

    const seenAt = row.notifiedAt;
    const sent = await this.notify(
      row.chatId,
      requestNotificationText(row),
      approvalKeyboard(row.chatId),
    );

    if (!sent) {
      this.groups.markNotificationFailed(group.chatId);
      return false;
    }
    try {
      this.groups.markNotified(group.chatId, seenAt);
    } catch (err) {
      // The owner was told; failing to record that must not throw outward.
      console.error("[sol] notification mark failed:", errToLog(err));
    }
    return true;
  }

  /** Generic denial. Reveals nothing about configuration or internals. */
  private async deny(ctx: Context): Promise<void> {
    await safeAnswer(ctx);
    await safeSend(ctx, PANEL_DENIED);
  }

  /**
   * Render a panel view.
   *
   * Button clicks edit the panel message in place; the /admin command itself
   * arrives as a new message and is answered with a new message.
   */
  private async render(ctx: Context, text: string, keyboard: unknown): Promise<void> {
    await safeAnswer(ctx);
    await safeEditOrSend(ctx, text, keyboard);
  }
}

function approvalKeyboard(chatId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr("fa", "panel.pending.approve"), encode({ kind: "approve", chatId }))
    .text(tr("fa", "panel.pending.reject"), encode({ kind: "reject", chatId }));
}

/** Answer the callback query so Telegram stops its loading indicator. */
async function safeAnswer(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // A button that expired must not surface an error to anyone.
  }
}

/** Send a message, swallowing a Telegram failure (blocked bot, old callback). */
async function safeSend(ctx: Context, text: string, keyboard?: unknown): Promise<void> {
  try {
    if (keyboard === undefined) {
      await ctx.reply(text);
      return;
    }
    await ctx.reply(text, { reply_markup: keyboard as never });
  } catch {
    // Logged as a sanitized operational note only.
    console.error("[sol] panel: telegram send failed");
  }
}

/**
 * Edit the panel message in place when this render answers a button click;
 * otherwise send a new message.
 *
 * A failed edit (stale, deleted, or unchanged message) is swallowed without
 * falling back to a reply: stacking a new message would undo the whole point.
 */
async function safeEditOrSend(ctx: Context, text: string, keyboard?: unknown): Promise<void> {
  const qc = ctx as unknown as {
    callbackQuery?: unknown;
    editMessageText?: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
  };
  if (qc.callbackQuery !== undefined && typeof qc.editMessageText === "function") {
    try {
      await qc.editMessageText.call(
        ctx,
        text,
        keyboard !== undefined ? { reply_markup: keyboard } : undefined,
      );
      return;
    } catch {
      // Stale, deleted, or byte-identical message: leave it alone.
    }
    return;
  }
  await safeSend(ctx, text, keyboard);
}

/** Sanitized error note; never the message, payload, or stack trace. */
function errToLog(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}
