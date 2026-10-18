/**
 * Owner panel UI — inline keyboards and text, rendered from the panel string
 * table (`panel_strings.ts`).
 *
 * This module only renders. It performs no authorization and no state change:
 * the buttons are convenience, and every action behind them is re-checked by
 * the admin boundary when the callback actually arrives.
 *
 * `lang` defaults to Persian (the owner's ground truth); the English mirror
 * comes from the same table. No user-facing literal lives in this file.
 */
import { InlineKeyboard } from "grammy";
import type { GroupAccessRecord } from "../storage/storage";
import { encode } from "./callbacks";
import { formatNum, tr, type PanelLang } from "./panel_strings";
import { formatCost } from "../core/usage";

/** Page size for the owner's lists. */
export const PAGE_SIZE = 5;

/** Generic denial, shared with the admin boundary. No internal detail. */
export const PANEL_DENIED = tr("fa", "panel.denied");

/** Shown when a callback references something that no longer decides. */
export const PANEL_STALE = tr("fa", "panel.stale");

/** Denial / stale texts in the panel language (the consts stay Persian). */
export function panelDenied(lang: PanelLang): string {
  return tr(lang, "panel.denied");
}

export function panelStale(lang: PanelLang): string {
  return tr(lang, "panel.stale");
}

export function panelMenuKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.menu.groups_pending"), encode({ kind: "pending", offset: 0 }))
    .row()
    .text(tr(lang, "panel.menu.groups_approved"), encode({ kind: "approved", offset: 0 }))
    .row()
    .text(tr(lang, "panel.menu.groups_revoke"), encode({ kind: "revoke_menu", offset: 0 }))
    .row()
    .text(tr(lang, "panel.menu.users"), encode({ kind: "users_menu" }))
    .row()
    .text(tr(lang, "panel.menu.ai"), encode({ kind: "ai_menu" }))
    .row()
    .text(tr(lang, "panel.menu.status"), encode({ kind: "status" }));
}

export function panelMenuText(lang: PanelLang = "fa"): string {
  return [tr(lang, "panel.menu.title"), tr(lang, "panel.menu.hint")].join("\n");
}

export function backKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard().text(tr(lang, "panel.back"), encode({ kind: "menu" }));
}

/** The AI management entry, added to the root owner menu. */
export function aiMenuEntry(lang: PanelLang = "fa"): { text: string; data: string } {
  return { text: tr(lang, "panel.menu.ai"), data: encode({ kind: "ai_menu" }) };
}

export function pendingText(
  items: readonly GroupAccessRecord[],
  offset: number,
  total: number,
  lang: PanelLang = "fa",
): string {
  if (items.length === 0) {
    return offset > 0 ? tr(lang, "panel.pending.empty_more") : tr(lang, "panel.pending.empty");
  }
  return [
    tr(lang, "panel.pending.title", {
      from: formatNum(offset + 1, lang),
      to: formatNum(offset + items.length, lang),
      total: formatNum(total, lang),
    }),
    "",
    ...items.map((g) => describeGroup(g, lang)),
    "",
    tr(lang, "panel.pending.hint"),
  ].join("\n");
}

export function pendingKeyboard(
  items: readonly GroupAccessRecord[],
  offset: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const g of items) {
    kb.text(tr(lang, "panel.pending.approve"), encode({ kind: "approve", chatId: g.chatId }));
    kb.text(tr(lang, "panel.pending.reject"), encode({ kind: "reject", chatId: g.chatId }));
    kb.row();
  }
  appendNav(kb, {
    offset,
    shown: items.length,
    list: "pending",
    lang,
  });
  return kb;
}

/**
 * Non-sensitive status: counts only. No token values, keys, or message content.
 *
 * Usage figures are today's totals across all users; the cost is labelled as an
 * estimate because the price table is indicative, not a bill.
 */
export function statusText(
  s: {
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
      costUsd: number;
      estimated: boolean;
    };
  },
  lang: PanelLang = "fa",
): string {
  const lines = [
    tr(lang, "panel.status.title"),
    tr(lang, "panel.status.pending", { n: formatNum(s.pending, lang) }),
    tr(lang, "panel.status.approved", { n: formatNum(s.approved, lang) }),
    tr(lang, "panel.status.provider", { v: s.provider }),
    tr(lang, "panel.status.model", { v: s.model }),
  ];

  if (s.usage !== undefined) {
    lines.push(
      "",
      tr(lang, "panel.status.usage_title"),
      tr(lang, "panel.status.usage_requests", { n: formatNum(s.usage.requests, lang) }),
      tr(lang, "panel.status.usage_tools", { n: formatNum(s.usage.toolCalls, lang) }),
      tr(lang, "panel.status.usage_in", { n: formatNum(s.usage.inputTokens, lang) }),
      tr(lang, "panel.status.usage_out", { n: formatNum(s.usage.outputTokens, lang) }),
      tr(lang, "panel.status.usage_cost", {
        v: formatCost(s.usage.costUsd, lang),
        approx: s.usage.estimated ? tr(lang, "panel.status.cost_approx") : "",
      }),
    );
  }

  return lines.join("\n");
}

export function approvedText(
  items: readonly GroupAccessRecord[],
  offset: number,
  total: number,
  lang: PanelLang = "fa",
): string {
  if (items.length === 0) {
    return offset > 0 ? tr(lang, "panel.approved.empty_more") : tr(lang, "panel.approved.empty");
  }
  return [
    tr(lang, "panel.approved.title", {
      from: formatNum(offset + 1, lang),
      to: formatNum(offset + items.length, lang),
      total: formatNum(total, lang),
    }),
    "",
    ...items.map((g) => describeGroup(g, lang)),
  ].join("\n");
}

export function revokeText(
  items: readonly GroupAccessRecord[],
  offset: number,
  total: number,
  lang: PanelLang = "fa",
): string {
  if (items.length === 0) {
    return offset > 0 ? tr(lang, "panel.revoke.empty_more") : tr(lang, "panel.revoke.empty");
  }
  return [
    tr(lang, "panel.revoke.title", {
      from: formatNum(offset + 1, lang),
      to: formatNum(offset + items.length, lang),
      total: formatNum(total, lang),
    }),
    "",
    ...items.map((g) => describeGroup(g, lang)),
  ].join("\n");
}

export function revokeKeyboard(
  items: readonly GroupAccessRecord[],
  offset: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const g of items) {
    kb.text(shortLabel(g), encode({ kind: "revoke", chatId: g.chatId }));
    kb.row();
  }
  appendNav(kb, {
    offset,
    shown: items.length,
    list: "revoke_menu",
    lang,
  });
  return kb;
}

export function approvedKeyboard(
  items: readonly GroupAccessRecord[],
  offset: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  appendNav(kb, { offset, shown: items.length, list: "approved", lang });
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
  o: {
    offset: number;
    shown: number;
    list: "pending" | "approved" | "revoke_menu";
    lang: PanelLang;
  },
): void {
  const prev = Math.max(0, o.offset - PAGE_SIZE);
  // A next button only helps when the page was full, meaning more may follow.
  const hasNext = o.shown >= PAGE_SIZE;
  const next = o.offset + PAGE_SIZE;

  if (o.offset > 0) {
    kb.text(tr(o.lang, "panel.prev"), navData(o.list, prev));
    if (hasNext) kb.text(tr(o.lang, "panel.next"), navData(o.list, next));
    kb.row();
  } else if (hasNext) {
    kb.text(tr(o.lang, "panel.next"), navData(o.list, next));
    kb.row();
  }
  kb.text(tr(o.lang, "panel.back"), encode({ kind: "menu" }));
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
function describeGroup(g: GroupAccessRecord, lang: PanelLang): string {
  const title = g.title && g.title.length > 0 ? g.title : tr(lang, "panel.unnamed");
  return `• ${title} (${g.chatId})`;
}

function shortLabel(g: GroupAccessRecord): string {
  const title = g.title && g.title.length > 0 ? g.title : g.chatId;
  return title.length > 28 ? `${title.slice(0, 28)}…` : title;
}

/** Notification sent to the owner when the bot is added to a group. */
export function requestNotificationText(g: GroupAccessRecord, lang: PanelLang = "fa"): string {
  const title = g.title && g.title.length > 0 ? g.title : tr(lang, "panel.unnamed");
  const requester =
    g.requestedBy !== undefined
      ? tr(lang, "panel.group.requested_by", { v: g.requestedBy })
      : tr(lang, "panel.group.requested_unknown");
  return [
    tr(lang, "panel.group.notify_title"),
    "",
    tr(lang, "panel.group.name", { v: title }),
    tr(lang, "panel.group.id", { v: g.chatId }),
    tr(lang, "panel.group.type", { v: chatTypeLabel(g.chatType, lang) }),
    requester,
  ].join("\n");
}

function chatTypeLabel(t: GroupAccessRecord["chatType"], lang: PanelLang): string {
  switch (t) {
    case "group":
      return tr(lang, "panel.chattype.group");
    case "supergroup":
      return tr(lang, "panel.chattype.supergroup");
    case "channel":
      return tr(lang, "panel.chattype.channel");
  }
}
