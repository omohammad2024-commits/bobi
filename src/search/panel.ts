/**
 * Web-search settings UI for the `/ai` panel.
 *
 * Rendering only: no authorization and no state change. Every button here is
 * re-checked by AdminBoundary when the callback arrives.
 *
 * A credential is shown ONLY as set/unset. No key ever reaches this module's
 * output.
 */
import { InlineKeyboard } from "grammy";
import { encode } from "../groups/callbacks";
import { SEARCH_TEMPLATES } from "./provider";
import type { SearchProviderType } from "./provider";

export interface SearchSettingsView {
  /** The provider slug currently selected. */
  provider: string;
  /** Whether a credential is stored for it. */
  hasKey: boolean;
  /** Whether the selected provider is usable right now. */
  usable: boolean;
}

export function searchMenuText(v: SearchSettingsView): string {
  const selected = SEARCH_TEMPLATES.find((t) => t.type === v.provider);
  const lines = [
    "جستجوی وب",
    "",
    "ابزار web_search به مدل اجازه می‌دهد اطلاعات تازه را از وب بخواند.",
    "",
    `سرویس فعال: ${selected?.label ?? v.provider}`,
  ];

  if (selected?.needsKey === true) {
    lines.push(`کلید: ${v.hasKey ? "تنظیم شده" : "تنظیم نشده"}`);
  } else {
    lines.push("کلید: لازم نیست");
  }

  lines.push(
    "",
    v.usable
      ? "وضعیت: آمادهٔ استفاده. ابزار در اختیار مدل است."
      : "وضعیت: قابل استفاده نیست؛ تا تنظیم نشدن، ابزار به مدل نشان داده نمی‌شود.",
  );

  return lines.join("\n");
}

export function searchMenuKeyboard(current: string, hasKey: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const t of SEARCH_TEMPLATES) {
    // The active provider is marked, so the owner can see the current choice
    // without reading the text above.
    const mark = t.type === current ? "✅ " : "";
    kb.text(`${mark}${t.label}`, encode({ kind: "search_pick", provider: t.type })).row();
  }

  // The key buttons only make sense for a provider that uses one.
  const selected = SEARCH_TEMPLATES.find((t) => t.type === current);
  if (selected?.needsKey === true) {
    kb.text(
      hasKey ? "تغییر کلید" : "تنظیم کلید",
      encode({ kind: "search_set_key_form" }),
    ).row();
    if (hasKey) {
      kb.text("حذف کلید", encode({ kind: "search_clear_key" })).row();
    }
  }

  kb.text("بازگشت", encode({ kind: "ai_menu" }));
  return kb;
}

/** The form prompt shown when the owner is about to type a key. */
export function searchKeyFormText(): string {
  return [
    "کلید سرویس جستجو را در پیام بعدی بفرست.",
    "",
    "کلید رمزنگاری‌شده ذخیره می‌شود و هرگز نمایش داده نمی‌شود.",
    "برای لغو، /ai را بفرست.",
  ].join("\n");
}

/** Confirmation after a key was stored. Never echoes the key. */
export function searchKeySavedText(providerLabel: string): string {
  return `کلید ${providerLabel} ذخیره شد.\n\nوضعیت: تنظیم شده`;
}

/** Confirmation after a key was removed. */
export function searchKeyClearedText(providerLabel: string): string {
  return `کلید ${providerLabel} حذف شد.`;
}

/** Shown when a key is requested through a provider that does not use one. */
export function searchNoKeyNeededText(providerLabel: string): string {
  return `${providerLabel} به کلید نیازی ندارد.`;
}

/** A back path to the search section from a sub-view. */
export function backToSearchKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت", encode({ kind: "search_menu" }));
}
