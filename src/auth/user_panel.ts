/**
 * Owner panel UI for private-chat user access — text and keyboards rendered
 * from the panel string table (`../groups/panel_strings.ts`).
 *
 * Mirrors `groups/panel.ts` deliberately: the two approval workflows are the
 * same shape, so an owner who has used one already knows the other. This module
 * only renders — it performs no authorization and no state change. Every button
 * behind it is re-checked by the admin boundary when the callback arrives.
 *
 * `lang` defaults to Persian (the owner's ground truth); the English mirror
 * comes from the same table. No user-facing literal lives in this file.
 */
import { InlineKeyboard } from "grammy";
import type { UserAccessRecord } from "../storage/storage";
import { encode } from "../groups/callbacks";
import { formatNum, tr, type PanelLang } from "../groups/panel_strings";

/** Page size for the owner's user lists. */
export const USER_PAGE_SIZE = 5;

export function usersMenuKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.users.menu_pending"), encode({ kind: "users_pending", offset: 0 }))
    .row()
    .text(tr(lang, "panel.users.menu_approved"), encode({ kind: "users_approved", offset: 0 }))
    .row()
    .text(tr(lang, "panel.users.menu_revoke"), encode({ kind: "users_revoke_menu", offset: 0 }))
    .row()
    .text(tr(lang, "panel.back"), encode({ kind: "menu" }));
}

export function usersMenuText(
  pending: number,
  approved: number,
  lang: PanelLang = "fa",
): string {
  return [
    tr(lang, "panel.users.menu_title"),
    "",
    tr(lang, "panel.users.menu_about"),
    "",
    tr(lang, "panel.users.pending_n", { n: formatNum(pending, lang) }),
    tr(lang, "panel.users.approved_n", { n: formatNum(approved, lang) }),
  ].join("\n");
}

export function usersPendingText(
  items: readonly UserAccessRecord[],
  offset: number,
  total: number,
  lang: PanelLang = "fa",
): string {
  if (items.length === 0) {
    return offset > 0
      ? tr(lang, "panel.users.pending_empty_more")
      : tr(lang, "panel.users.pending_empty");
  }
  return [
    tr(lang, "panel.users.pending_title", {
      from: formatNum(offset + 1, lang),
      to: formatNum(offset + items.length, lang),
      total: formatNum(total, lang),
    }),
    "",
    ...items.map((u) => describeUser(u, lang)),
    "",
    tr(lang, "panel.pending.hint"),
  ].join("\n");
}

export function usersPendingKeyboard(
  items: readonly UserAccessRecord[],
  offset: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const u of items) {
    kb.text(tr(lang, "panel.pending.approve"), encode({ kind: "user_approve", userId: u.userId }));
    kb.text(tr(lang, "panel.pending.reject"), encode({ kind: "user_reject", userId: u.userId }));
    kb.row();
  }
  appendNav(kb, { offset, shown: items.length, list: "users_pending", lang });
  return kb;
}

export function usersApprovedText(
  items: readonly UserAccessRecord[],
  offset: number,
  total: number,
  lang: PanelLang = "fa",
): string {
  if (items.length === 0) {
    return offset > 0
      ? tr(lang, "panel.users.approved_empty_more")
      : tr(lang, "panel.users.approved_empty");
  }
  return [
    tr(lang, "panel.users.approved_title", {
      from: formatNum(offset + 1, lang),
      to: formatNum(offset + items.length, lang),
      total: formatNum(total, lang),
    }),
    "",
    ...items.map((u) => describeUser(u, lang)),
  ].join("\n");
}

export function usersRevokeText(
  items: readonly UserAccessRecord[],
  offset: number,
  total: number,
  lang: PanelLang = "fa",
): string {
  if (items.length === 0) {
    return offset > 0
      ? tr(lang, "panel.users.revoke_empty_more")
      : tr(lang, "panel.users.revoke_empty");
  }
  return [
    tr(lang, "panel.users.revoke_title", {
      from: formatNum(offset + 1, lang),
      to: formatNum(offset + items.length, lang),
      total: formatNum(total, lang),
    }),
    "",
    ...items.map((u) => describeUser(u, lang)),
  ].join("\n");
}

export function usersRevokeKeyboard(
  items: readonly UserAccessRecord[],
  offset: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const u of items) {
    kb.text(shortLabel(u), encode({ kind: "user_revoke", userId: u.userId }));
    kb.row();
  }
  appendNav(kb, {
    offset,
    shown: items.length,
    list: "users_revoke_menu",
    lang,
  });
  return kb;
}

export function usersApprovedKeyboard(
  items: readonly UserAccessRecord[],
  offset: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  appendNav(kb, { offset, shown: items.length, list: "users_approved", lang });
  return kb;
}

/**
 * Notification sent to the owner when an unknown account first makes contact.
 *
 * Carries only what the owner needs to decide: the numeric id (the authoritative
 * field) plus the cosmetic name and username.
 */
export function userRequestNotificationText(
  u: UserAccessRecord,
  lang: PanelLang = "fa",
): string {
  const lines = [
    tr(lang, "panel.users.notify_title"),
    "",
    tr(lang, "panel.users.notify_id", { v: u.userId }),
  ];
  if (u.firstName !== undefined && u.firstName.length > 0) {
    lines.push(tr(lang, "panel.users.notify_name", { v: u.firstName }));
  }
  if (u.username !== undefined && u.username.length > 0) {
    lines.push(tr(lang, "panel.users.notify_username", { v: u.username }));
  }
  lines.push("", tr(lang, "panel.users.notify_hint"));
  return lines.join("\n");
}

/** Approve/reject buttons for the notification. */
export function userApprovalKeyboard(userId: string, lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.pending.approve"), encode({ kind: "user_approve", userId }))
    .text(tr(lang, "panel.pending.reject"), encode({ kind: "user_reject", userId }));
}

/**
 * Message shown to a user whose access is not approved yet.
 *
 * Kept as a Persian constant for the existing bot.ts import; prefer
 * {@link userNotApproved} for language-aware rendering.
 */
export const USER_NOT_APPROVED = tr("fa", "panel.users.not_approved");

/** Message shown when access was revoked after being approved. */
export const USER_REVOKED = tr("fa", "panel.users.revoked");

/** Language-aware variants of the user-facing constants above. */
export function userNotApproved(lang: PanelLang): string {
  return tr(lang, "panel.users.not_approved");
}

export function userRevoked(lang: PanelLang): string {
  return tr(lang, "panel.users.revoked");
}

// ---- helpers ----

function describeUser(u: UserAccessRecord, lang: PanelLang): string {
  const name = u.firstName && u.firstName.length > 0 ? u.firstName : tr(lang, "panel.unnamed");
  const username = u.username && u.username.length > 0 ? ` @${u.username}` : "";
  return `• ${name}${username} (${u.userId})`;
}

function shortLabel(u: UserAccessRecord): string {
  const name = u.firstName && u.firstName.length > 0 ? u.firstName : u.userId;
  return name.length > 28 ? `${name.slice(0, 28)}…` : name;
}

/**
 * Append prev/next plus a back path.
 *
 * `offset` is the offset of the page just shown, so offsets derive from the page
 * size rather than from how many rows happened to render — a short page (rows
 * decided since it was drawn) still navigates correctly.
 */
function appendNav(
  kb: InlineKeyboard,
  o: {
    offset: number;
    shown: number;
    list: "users_pending" | "users_approved" | "users_revoke_menu";
    lang: PanelLang;
  },
): void {
  const prev = Math.max(0, o.offset - USER_PAGE_SIZE);
  // A next button only helps when the page was full, meaning more may follow.
  const hasNext = o.shown >= USER_PAGE_SIZE;
  const next = o.offset + USER_PAGE_SIZE;

  if (o.offset > 0) {
    kb.text(tr(o.lang, "panel.prev"), navData(o.list, prev));
    if (hasNext) kb.text(tr(o.lang, "panel.next"), navData(o.list, next));
    kb.row();
  } else if (hasNext) {
    kb.text(tr(o.lang, "panel.next"), navData(o.list, next));
    kb.row();
  }
  kb.text(tr(o.lang, "panel.back"), encode({ kind: "users_menu" }));
}

function navData(
  list: "users_pending" | "users_approved" | "users_revoke_menu",
  offset: number,
): string {
  switch (list) {
    case "users_pending":
      return encode({ kind: "users_pending", offset });
    case "users_approved":
      return encode({ kind: "users_approved", offset });
    case "users_revoke_menu":
      return encode({ kind: "users_revoke_menu", offset });
  }
}
