/**
 * Panel controller — where every admin action is authorized.
 *
 * This is the hand-off point between Telegram and the security core. Nothing
 * here trusts a callback payload as proof of authority: the actor is rebuilt
 * from the trusted `ctx.from.id` and each decision goes through
 * `AdminBoundary.runAdmin`, which re-checks identity and the required
 * permission at execution time and audits the outcome.
 */
import { Context, InlineKeyboard } from "grammy";
import type { AdminBoundary } from "../auth/admin_boundary";
import type { AuthorizationService } from "../auth/service";
import type { Permission } from "../auth/roles";
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
    cost: string;
    estimated: boolean;
  };
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

export class PanelController {
  private readonly auth: AuthorizationService;
  private readonly admin: AdminBoundary;
  private readonly groups: GroupAccessService;
  private readonly notify: PanelOptions["notify"];
  private readonly statusInfo: () => { provider: string; model: string };
  private readonly usageInfo: PanelOptions["usageInfo"];

  constructor(opts: PanelOptions) {
    this.auth = opts.auth;
    this.admin = opts.admin;
    this.groups = opts.groups;
    this.notify = opts.notify;
    this.statusInfo = opts.statusInfo;
    this.usageInfo = opts.usageInfo;
  }

  /** Actor from a trusted context; undefined when identity is absent. */
  private actorFor(ctx: Context) {
    const from = ctx.from;
    if (!from) return undefined;
    return this.auth.actorFromTelegramUser(from);
  }

  /** `/admin` — open the panel for the owner only. */
  async openPanel(ctx: Context): Promise<void> {
    const actor = this.actorFor(ctx);
    // Reading the panel requires the admin-view permission at execution time.
    const result = await this.admin.runAdmin(
      { actor, operation: "panel.open", permission: PERM_VIEW },
      () => ({ text: panelMenuText(), keyboard: panelMenuKeyboard() }),
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
   * Returns true when the data belonged to the panel and was handled here, so
   * the caller can stop routing. Unknown data also returns true after a
   * generic denial — probing the callback space reveals nothing either way.
   */
  async handleCallback(ctx: Context, data: string): Promise<boolean> {
    const action = decode(data);
    if (!action) {
      // Not panel data at all: let the caller route it normally.
      return false;
    }
    await this.dispatch(ctx, action);
    return true;
  }

  private async dispatch(ctx: Context, action: PanelAction): Promise<void> {
    const actor = this.actorFor(ctx);

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
            const text = statusText({
              pending: this.groups.countPending(),
              approved: this.groups.countApproved(),
              provider: s.provider,
              model: s.model,
              ...(usage !== undefined ? { usage } : {}),
            });
            return { text, keyboard: backKeyboard() };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "pending": {
        const r = await this.admin.runAdmin(
          { actor, operation: "panel.pending", permission: PERM_REVIEW },
          () => this.pendingView(action.offset),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "approved": {
        const r = await this.admin.runAdmin(
          { actor, operation: "panel.approved", permission: PERM_REVIEW },
          () => this.approvedView(action.offset),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "revoke_menu": {
        const r = await this.admin.runAdmin(
          { actor, operation: "panel.revoke_menu", permission: PERM_REVIEW },
          () => this.revokeView(action.offset),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "approve":
        await this.decide(ctx, actor, "approve", action.chatId);
        return;

      case "reject":
        await this.decide(ctx, actor, "reject", action.chatId);
        return;

      case "revoke":
        await this.decide(ctx, actor, "revoke", action.chatId);
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
  private pendingView(offset: number): { text: string; keyboard: unknown } {
    const total = this.groups.countPending();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.groups.listPending(PAGE_SIZE, start);
    return {
      text: pendingText(items, start, total),
      keyboard: pendingKeyboard(items, start),
    };
  }

  /** The approved-groups page. */
  private approvedView(offset: number): { text: string; keyboard: unknown } {
    const total = this.groups.countApproved();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.groups.listApproved(PAGE_SIZE, start);
    return {
      text: approvedText(items, start, total),
      keyboard: approvedKeyboard(items, start),
    };
  }

  /** The same approved page, framed as a revoke picker. */
  private revokeView(offset: number): { text: string; keyboard: unknown } {
    const total = this.groups.countApproved();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.groups.listApproved(PAGE_SIZE, start);
    return {
      text: revokeText(items, start, total),
      keyboard: revokeKeyboard(items, start),
    };
  }

  /** Approve / reject / revoke behind the boundary, per target group. */
  private async decide(
    ctx: Context,
    actor: ReturnType<PanelController["actorFor"]>,
    kind: "approve" | "reject" | "revoke",
    chatId: string,
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
      await this.render(ctx, PANEL_STALE, backKeyboard());
      return;
    }

    // Re-render from the database inside the SAME authorized run, so the
    // refresh is covered by the boundary's error handling. Showing "done"
    // before the follow-up read would report a success the store may not hold.
    const done = {
      approve: "دسترسی گروه تأیید شد.",
      reject: "درخواست گروه رد شد.",
      revoke: "دسترسی گروه لغو شد.",
    }[kind];

    const refresh = await this.admin.runAdmin(
      {
        actor,
        operation: `group.${kind}.refresh`,
        // Reading a list back needs the review permission, never a wider one.
        permission: PERM_REVIEW,
        targetId: chatId,
      },
      () => (kind === "revoke" ? this.revokeView(0) : this.pendingView(0)),
    );

    if (!refresh.ok) {
      // The decision was persisted, but the refreshed view failed: report the
      // outcome the owner actually achieved without inventing list content.
      await this.render(ctx, done, backKeyboard());
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

  private async render(ctx: Context, text: string, keyboard: unknown): Promise<void> {
    await safeAnswer(ctx);
    await safeSend(ctx, text, keyboard);
  }
}

function approvalKeyboard(chatId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("تأیید", encode({ kind: "approve", chatId }))
    .text("رد", encode({ kind: "reject", chatId }));
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

/** Sanitized error note; never the message, payload, or stack trace. */
function errToLog(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}
