/**
 * User access panel controller — where every user-approval action is authorized.
 *
 * Mirrors `groups/controller.ts`. Nothing here trusts a callback payload as
 * proof of authority: the actor is rebuilt from the trusted `ctx.from.id` and
 * each decision goes through `AdminBoundary.runAdmin`, which re-checks identity
 * and the required permission at execution time and audits the outcome.
 */
import type { Context } from "grammy";
import type { AdminBoundary } from "./admin_boundary";
import type { AuthorizationService } from "./service";
import type { Permission } from "./roles";
import { decode, type PanelAction } from "../groups/callbacks";
import { PANEL_DENIED, PANEL_STALE } from "../groups/panel";
import type { UserAccessService } from "./user_service";
import {
  USER_PAGE_SIZE,
  userApprovalKeyboard,
  userRequestNotificationText,
  usersApprovedKeyboard,
  usersApprovedText,
  usersMenuKeyboard,
  usersMenuText,
  usersPendingKeyboard,
  usersPendingText,
  usersRevokeKeyboard,
  usersRevokeText,
} from "./user_panel";

export interface UserPanelOptions {
  auth: AuthorizationService;
  admin: AdminBoundary;
  users: UserAccessService;
  /** Dry-run sink for owner notifications; injected so tests need no network. */
  notify: (chatId: string, text: string, keyboard: unknown) => Promise<boolean>;
}

/**
 * Permissions used by user-access actions.
 *
 * `users.manage` already exists in the role table and was previously unused;
 * this is the feature it was declared for. Reads stay behind the same
 * `users.manage` rather than a new read permission, because the list contains
 * Telegram account identifiers and has no separate audience.
 */
const PERM_MANAGE: Permission = "users.manage";

export class UserPanelController {
  private readonly auth: AuthorizationService;
  private readonly admin: AdminBoundary;
  private readonly users: UserAccessService;
  private readonly notify: UserPanelOptions["notify"];

  constructor(opts: UserPanelOptions) {
    this.auth = opts.auth;
    this.admin = opts.admin;
    this.users = opts.users;
    this.notify = opts.notify;
  }

  private actorFor(ctx: Context) {
    const from = ctx.from;
    if (!from) return undefined;
    return this.auth.actorFromTelegramUser(from);
  }

  /**
   * Any click that may be a user-access button.
   *
   * Returns true only for the actions this controller owns, so the group panel
   * and the AI panel still see their own callbacks.
   */
  async handleCallback(ctx: Context, data: string): Promise<boolean> {
    const action = decode(data);
    if (!action || !USERS_ACTION_KINDS.has(action.kind)) return false;
    await this.dispatch(ctx, action);
    return true;
  }

  private async dispatch(ctx: Context, action: PanelAction): Promise<void> {
    const actor = this.actorFor(ctx);

    switch (action.kind) {
      case "users_menu": {
        const r = await this.admin.runAdmin(
          { actor, operation: "users.menu", permission: PERM_MANAGE },
          () => ({
            text: usersMenuText(this.users.countPending(), this.users.countApproved()),
            keyboard: usersMenuKeyboard(),
          }),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "users_pending": {
        const r = await this.admin.runAdmin(
          { actor, operation: "users.pending", permission: PERM_MANAGE },
          () => this.pendingView(action.offset),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "users_approved": {
        const r = await this.admin.runAdmin(
          { actor, operation: "users.approved", permission: PERM_MANAGE },
          () => this.approvedView(action.offset),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "users_revoke_menu": {
        const r = await this.admin.runAdmin(
          { actor, operation: "users.revoke_menu", permission: PERM_MANAGE },
          () => this.revokeView(action.offset),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "user_approve":
        await this.decide(ctx, actor, "approve", action.userId);
        return;

      case "user_reject":
        await this.decide(ctx, actor, "reject", action.userId);
        return;

      case "user_revoke":
        await this.decide(ctx, actor, "revoke", action.userId);
        return;

      default:
        return;
    }
  }

  /**
   * Snap a requested page back to the last page that still holds rows, so a
   * stale offset after a decision never shows an empty or misleading page.
   */
  private pageStart(offset: number, total: number): number {
    const lastPage = Math.max(0, Math.ceil(Math.max(total, 0) / USER_PAGE_SIZE) - 1);
    return Math.min(Math.max(offset, 0), lastPage * USER_PAGE_SIZE);
  }

  private normalizeOffset(offset: number): number {
    if (!Number.isSafeInteger(offset) || offset < 0) return 0;
    return offset;
  }

  private pendingView(offset: number): { text: string; keyboard: unknown } {
    const total = this.users.countPending();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.users.listPending(USER_PAGE_SIZE, start);
    return { text: usersPendingText(items, start, total), keyboard: usersPendingKeyboard(items, start) };
  }

  private approvedView(offset: number): { text: string; keyboard: unknown } {
    const total = this.users.countApproved();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.users.listApproved(USER_PAGE_SIZE, start);
    return {
      text: usersApprovedText(items, start, total),
      keyboard: usersApprovedKeyboard(items, start),
    };
  }

  private revokeView(offset: number): { text: string; keyboard: unknown } {
    const total = this.users.countApproved();
    const start = this.pageStart(this.normalizeOffset(offset), total);
    const items = this.users.listApproved(USER_PAGE_SIZE, start);
    return { text: usersRevokeText(items, start, total), keyboard: usersRevokeKeyboard(items, start) };
  }

  /** Approve / reject / revoke behind the boundary, per target user. */
  private async decide(
    ctx: Context,
    actor: ReturnType<UserPanelController["actorFor"]>,
    kind: "approve" | "reject" | "revoke",
    userId: string,
  ): Promise<void> {
    const r = await this.admin.runAdmin(
      {
        actor,
        operation: `user.${kind}`,
        permission: PERM_MANAGE,
        // The target is audit metadata, never a claim of authority.
        targetId: userId,
      },
      () => {
        const ownerId = String(actor?.id ?? "");
        switch (kind) {
          case "approve":
            return this.users.approve(userId, ownerId);
          case "reject":
            return this.users.reject(userId, ownerId);
          case "revoke":
            return this.users.revoke(userId, ownerId);
        }
      },
    );

    if (!r.ok) {
      await this.deny(ctx);
      return;
    }

    if (!r.data.ok) {
      // Missing record or a state that forbids this transition (stale click).
      await this.render(ctx, PANEL_STALE, usersMenuKeyboard());
      return;
    }

    const done = {
      approve: "دسترسی کاربر تأیید شد.",
      reject: "درخواست کاربر رد شد.",
      revoke: "دسترسی کاربر لغو شد.",
    }[kind];

    // Re-render from the database inside the SAME authorized run, so the
    // refresh is covered by the boundary's error handling. Showing "done"
    // before the follow-up read would report a success the store may not hold.
    const refresh = await this.admin.runAdmin(
      { actor, operation: `user.${kind}.refresh`, permission: PERM_MANAGE, targetId: userId },
      () => (kind === "revoke" ? this.revokeView(0) : this.pendingView(0)),
    );

    if (!refresh.ok) {
      // The decision was persisted, but the refreshed view failed: report the
      // outcome the owner actually achieved without inventing list content.
      await this.render(ctx, done, usersMenuKeyboard());
      return;
    }

    await this.render(ctx, `${done}\n\n${refresh.data.text}`, refresh.data.keyboard);
  }

  /**
   * Tell the owner that an unknown account made contact.
   *
   * A failed delivery leaves the user `pending` and never notifies twice, so a
   * Telegram outage cannot be mistaken for an approval.
   */
  async notifyOwnerRequest(user: { userId: string }): Promise<boolean> {
    const row = this.users.pendingUser(user.userId);
    if (!row || !this.users.needsNotification(user.userId)) return false;

    const ownerId = this.auth.identity.ownerId;
    if (ownerId === undefined) return false;

    const seenAt = row.notifiedAt;
    const sent = await this.notify(
      String(ownerId),
      userRequestNotificationText(row),
      userApprovalKeyboard(row.userId),
    );

    if (!sent) return false;
    try {
      this.users.markNotified(user.userId, seenAt);
    } catch {
      // The owner was told; failing to record that must not throw outward.
    }
    return true;
  }

  private async deny(ctx: Context): Promise<void> {
    await safeAnswer(ctx);
    await safeSend(ctx, PANEL_DENIED);
  }

  private async render(ctx: Context, text: string, keyboard: unknown): Promise<void> {
    await safeAnswer(ctx);
    await safeSend(ctx, text, keyboard);
  }
}

/** The action kinds this controller owns. */
const USERS_ACTION_KINDS: ReadonlySet<PanelAction["kind"]> = new Set([
  "users_menu",
  "users_pending",
  "users_approved",
  "users_revoke_menu",
  "user_approve",
  "user_reject",
  "user_revoke",
] as const);

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
    await ctx.reply(text, keyboard !== undefined ? { reply_markup: keyboard as never } : {});
  } catch {
    // Delivery is best-effort; the state change already happened.
  }
}
