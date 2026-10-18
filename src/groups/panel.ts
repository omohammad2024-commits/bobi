/**
 * Owner panel UI — Persian text and inline keyboards.
 *
 * This module only renders. It performs no authorization and no state change:
 * the buttons are convenience, and every action behind them is re-checked by
 * the admin boundary when the callback actually arrives.
 */
import { InlineKeyboard } from "grammy";
import type { GroupAccessRecord } from "../storage/storage";
import { encode } from "./callbacks";

/** Page size for the owner's lists. */
export const PAGE_SIZE = 5;

/** Generic denial, shared with the admin boundary. No internal detail. */
export const PANEL_DENIED = "این بخش فقط برای مالک ربات در دسترس است.";

/** Shown when a callback references something that no longer decides. */
export const PANEL_STALE = "این درخواست قدیمی است و دیگر اعمال نمی‌شود.";

export function panelMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("درخواست‌های دسترسی گروه", encode({ kind: "pending", offset: 0 }))
    .row()
    .text("گروه‌های تأییدشده", encode({ kind: "approved", offset: 0 }))
    .row()
    .text("لغو دسترسی گروه", encode({ kind: "revoke_menu", offset: 0 }))
    .row()
    .text("دسترسی کاربران", encode({ kind: "users_menu" }))
    .row()
    .text("مدیریت هوش مصنوعی", encode({ kind: "ai_menu" }))
    .row()
    .text("وضعیت سیستم", encode({ kind: "status" }));
}

export function panelMenuText(): string {
  return ["پنل مدیریت BOBI", "یک گزینه را انتخاب کنید:"].join("\n");
}

export function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت", encode({ kind: "menu" }));
}

/** The AI management entry, added to the root owner menu. */
export function aiMenuEntry(): { text: string; data: string } {
  return { text: "مدیریت هوش مصنوعی", data: encode({ kind: "ai_menu" }) };
}

export function pendingText(
  items: readonly GroupAccessRecord[],
  offset: number,
  total: number,
): string {
  if (items.length === 0) {
    return offset > 0 ? "درخواست دسترسی دیگری وجود ندارد." : "درخواست دسترسی گروهی وجود ندارد.";
  }
  return [
    `درخواست‌های دسترسی گروه (${offset + 1}–${offset + items.length} از ${total}):`,
    "",
    ...items.map(describeGroup),
    "",
    "تأیید یا رد هر درخواست را انتخاب کنید:",
  ].join("\n");
}

export function pendingKeyboard(items: readonly GroupAccessRecord[], offset: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const g of items) {
    kb.text("تأیید", encode({ kind: "approve", chatId: g.chatId }));
    kb.text("رد", encode({ kind: "reject", chatId: g.chatId }));
    kb.row();
  }
  appendNav(kb, {
    offset,
    shown: items.length,
    list: "pending",
  });
  return kb;
}

/**
 * Non-sensitive status: counts only. No token values, keys, or message content.
 *
 * Usage figures are today's totals across all users; the cost is labelled as an
 * estimate because the price table is indicative, not a bill.
 */
export function statusText(s: {
  pending: number;
  approved: number;
  provider: string;
  model: string;
  /** Today's totals; omitted when usage accounting is not wired. */
  usage?: {
    requests: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cost: string;
    estimated: boolean;
  };
}): string {
  const lines = [
    "وضعیت سیستم",
    `گروه‌های در انتظار تأیید: ${s.pending}`,
    `گروه‌های تأییدشده: ${s.approved}`,
    `ارائه‌دهندهٔ گفتگو: ${s.provider}`,
    `مدل: ${s.model}`,
  ];

  if (s.usage !== undefined) {
    lines.push(
      "",
      "مصرف امروز (همهٔ کاربران):",
      `درخواست‌ها: ${s.usage.requests}`,
      `فراخوانی ابزار: ${s.usage.toolCalls}`,
      `توکن ورودی: ${s.usage.inputTokens.toLocaleString("en-US")}`,
      `توکن خروجی: ${s.usage.outputTokens.toLocaleString("en-US")}`,
      `هزینهٔ تخمینی: ${s.usage.cost}${s.usage.estimated ? " (تقریبی)" : ""}`,
    );
  }

  return lines.join("\n");
}

export function approvedText(
  items: readonly GroupAccessRecord[],
  offset: number,
  total: number,
): string {
  if (items.length === 0) {
    return offset > 0 ? "گروه تأییدشدهٔ دیگری وجود ندارد." : "هیچ گروه تأییدشده‌ای وجود ندارد.";
  }
  return [
    `گروه‌های تأییدشده (${offset + 1}–${offset + items.length} از ${total}):`,
    "",
    ...items.map(describeGroup),
  ].join("\n");
}

export function revokeText(
  items: readonly GroupAccessRecord[],
  offset: number,
  total: number,
): string {
  if (items.length === 0) {
    return offset > 0 ? "گروه بیشتری برای لغو دسترسی وجود ندارد." : "گروهی برای لغو دسترسی وجود ندارد.";
  }
  return [
    `گروهی که می‌خواهید دسترسی آن را لغو کنید انتخاب کنید (${offset + 1}–${offset + items.length} از ${total}):`,
    "",
    ...items.map(describeGroup),
  ].join("\n");
}

export function revokeKeyboard(items: readonly GroupAccessRecord[], offset: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const g of items) {
    kb.text(shortLabel(g), encode({ kind: "revoke", chatId: g.chatId }));
    kb.row();
  }
  appendNav(kb, {
    offset,
    shown: items.length,
    list: "revoke_menu",
    itemRows: items.length,
  });
  return kb;
}

export function approvedKeyboard(items: readonly GroupAccessRecord[], offset: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  appendNav(kb, { offset, shown: items.length, list: "approved" });
  return kb;
}

/**
 * Append prev/next plus a back button, and always keep a usable back path.
 *
 * `offset` is the offset of the page just shown, so the offsets are derived
 * from the page size rather than from how many rows happened to render — a
 * short page (rows revoked since it was drawn) still navigates correctly.
 */
function appendNav(
  kb: InlineKeyboard,
  o: { offset: number; shown: number; list: "pending" | "approved" | "revoke_menu"; itemRows?: number },
): void {
  const prev = Math.max(0, o.offset - PAGE_SIZE);
  // A next button only helps when the page was full, meaning more may follow.
  const hasNext = o.shown >= PAGE_SIZE;
  const next = o.offset + PAGE_SIZE;

  if (o.offset > 0) {
    kb.text("قبلی", navData(o.list, prev));
    if (hasNext) kb.text("بعدی", navData(o.list, next));
    kb.row();
  } else if (hasNext) {
    kb.text("بعدی", navData(o.list, next));
    kb.row();
  }
  kb.text("بازگشت", encode({ kind: "menu" }));
}

/** Callback data for a list's page; offset 0 uses the short form. */
function navData(list: "pending" | "approved" | "revoke_menu", offset: number): string {
  switch (list) {
    case "pending":
      return encode({ kind: "pending", offset });
    case "approved":
      return encode({ kind: "approved", offset });
    case "revoke_menu":
      return encode({ kind: "revoke_menu", offset });
  }
}

/** One-line group summary: id, type and title only. */
function describeGroup(g: GroupAccessRecord): string {
  const title = g.title && g.title.length > 0 ? g.title : "بی‌نام";
  return `• ${title} (${g.chatId})`;
}

function shortLabel(g: GroupAccessRecord): string {
  const title = g.title && g.title.length > 0 ? g.title : g.chatId;
  return title.length > 28 ? `${title.slice(0, 28)}…` : title;
}

/** Notification sent to the owner when the bot is added to a group. */
export function requestNotificationText(g: GroupAccessRecord): string {
  const title = g.title && g.title.length > 0 ? g.title : "بی‌نام";
  const requester =
    g.requestedBy !== undefined ? `درخواست‌کننده: ${g.requestedBy}` : "درخواست‌کننده: نامشخص";
  return [
    "ربات به گروهی اضافه شد و منتظر تأیید شما است.",
    "",
    `نام گروه: ${title}`,
    `شناسهٔ گروه: ${g.chatId}`,
    `نوع: ${chatTypeLabel(g.chatType)}`,
    requester,
  ].join("\n");
}

function chatTypeLabel(t: GroupAccessRecord["chatType"]): string {
  switch (t) {
    case "group":
      return "گروه";
    case "supergroup":
      return "سوپرگروه";
    case "channel":
      return "کانال";
  }
}
