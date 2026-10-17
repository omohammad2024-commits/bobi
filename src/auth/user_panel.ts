/**
 * Owner panel UI for private-chat user access.
 *
 * Mirrors `groups/panel.ts` deliberately: the two approval workflows are the
 * same shape, so an owner who has used one already knows the other. This module
 * only renders — it performs no authorization and no state change. Every button
 * behind it is re-checked by the admin boundary when the callback arrives.
 */
import { InlineKeyboard } from "grammy";
import type { UserAccessRecord } from "../storage/storage";
import { encode } from "../groups/callbacks";

/** Page size for the owner's user lists. */
export const USER_PAGE_SIZE = 5;

export function usersMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("درخواست‌های دسترسی کاربران", encode({ kind: "users_pending", offset: 0 }))
    .row()
    .text("کاربران تأییدشده", encode({ kind: "users_approved", offset: 0 }))
    .row()
    .text("لغو دسترسی کاربر", encode({ kind: "users_revoke_menu", offset: 0 }))
    .row()
    .text("بازگشت", encode({ kind: "menu" }));
}

export function usersMenuText(pending: number, approved: number): string {
  return [
    "دسترسی کاربران",
    "",
    "هر کسی که در چت خصوصی به ربات پیام بدهد باید ابتدا تأیید شود؛",
    "تا آن زمان هیچ پاسخی از مدل نمی‌گیرد و به هیچ ابزاری دسترسی ندارد.",
    "",
    `در انتظار تأیید: ${pending}`,
    `تأییدشده: ${approved}`,
  ].join("\n");
}

export function usersPendingText(
  items: readonly UserAccessRecord[],
  offset: number,
  total: number,
): string {
  if (items.length === 0) {
    return offset > 0 ? "درخواست دیگری وجود ندارد." : "درخواست دسترسی کاربری وجود ندارد.";
  }
  return [
    `درخواست‌های دسترسی کاربران (${offset + 1}–${offset + items.length} از ${total}):`,
    "",
    ...items.map(describeUser),
    "",
    "تأیید یا رد هر درخواست را انتخاب کنید:",
  ].join("\n");
}

export function usersPendingKeyboard(
  items: readonly UserAccessRecord[],
  offset: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const u of items) {
    kb.text("تأیید", encode({ kind: "user_approve", userId: u.userId }));
    kb.text("رد", encode({ kind: "user_reject", userId: u.userId }));
    kb.row();
  }
  appendNav(kb, { offset, shown: items.length, list: "users_pending" });
  return kb;
}

export function usersApprovedText(
  items: readonly UserAccessRecord[],
  offset: number,
  total: number,
): string {
  if (items.length === 0) {
    return offset > 0 ? "کاربر تأییدشدهٔ دیگری وجود ندارد." : "هیچ کاربر تأییدشده‌ای وجود ندارد.";
  }
  return [
    `کاربران تأییدشده (${offset + 1}–${offset + items.length} از ${total}):`,
    "",
    ...items.map(describeUser),
  ].join("\n");
}

export function usersRevokeText(
  items: readonly UserAccessRecord[],
  offset: number,
  total: number,
): string {
  if (items.length === 0) {
    return offset > 0 ? "کاربر بیشتری برای لغو وجود ندارد." : "کاربری برای لغو دسترسی وجود ندارد.";
  }
  return [
    `کاربری که می‌خواهید دسترسی‌اش را لغو کنید انتخاب کنید (${offset + 1}–${offset + items.length} از ${total}):`,
    "",
    ...items.map(describeUser),
  ].join("\n");
}

export function usersRevokeKeyboard(
  items: readonly UserAccessRecord[],
  offset: number,
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
  });
  return kb;
}

export function usersApprovedKeyboard(
  items: readonly UserAccessRecord[],
  offset: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  appendNav(kb, { offset, shown: items.length, list: "users_approved" });
  return kb;
}

/**
 * Notification sent to the owner when an unknown account first makes contact.
 *
 * Carries only what the owner needs to decide: the numeric id (the authoritative
 * field) plus the cosmetic name and username.
 */
export function userRequestNotificationText(u: UserAccessRecord): string {
  const lines = [
    "یک کاربر ناشناس در چت خصوصی به ربات پیام داد و منتظر تأیید شماست.",
    "",
    `شناسهٔ کاربر: ${u.userId}`,
  ];
  if (u.firstName !== undefined && u.firstName.length > 0) {
    lines.push(`نام: ${u.firstName}`);
  }
  if (u.username !== undefined && u.username.length > 0) {
    lines.push(`نام کاربری: @${u.username}`);
  }
  lines.push("", "تا تأیید شما، این کاربر پاسخی از مدل نمی‌گیرد.");
  return lines.join("\n");
}

/** Approve/reject buttons for the notification. */
export function userApprovalKeyboard(userId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("تأیید", encode({ kind: "user_approve", userId }))
    .text("رد", encode({ kind: "user_reject", userId }));
}

/** Message shown to a user whose access is not approved yet. */
export const USER_NOT_APPROVED =
  "درخواست شما برای مالک ربات فرستاده شد. پس از تأیید می‌توانید گفت‌وگو کنید.";

/** Message shown when access was revoked after being approved. */
export const USER_REVOKED =
  "دسترسی شما به این ربات لغو شده است.";

// ---- helpers ----

function describeUser(u: UserAccessRecord): string {
  const name = u.firstName && u.firstName.length > 0 ? u.firstName : "بی‌نام";
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
  },
): void {
  const prev = Math.max(0, o.offset - USER_PAGE_SIZE);
  // A next button only helps when the page was full, meaning more may follow.
  const hasNext = o.shown >= USER_PAGE_SIZE;
  const next = o.offset + USER_PAGE_SIZE;

  if (o.offset > 0) {
    kb.text("قبلی", navData(o.list, prev));
    if (hasNext) kb.text("بعدی", navData(o.list, next));
    kb.row();
  } else if (hasNext) {
    kb.text("بعدی", navData(o.list, next));
    kb.row();
  }
  kb.text("بازگشت", encode({ kind: "users_menu" }));
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
