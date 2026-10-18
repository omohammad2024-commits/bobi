import { InlineKeyboard } from "grammy";
import { t, type Lang } from "../i18n";

/**
 * Persian labels for the main menu buttons.
 *
 * Kept as the fa ground truth: buildMainMenu() with the default language must
 * render exactly these strings (asserted in tests).
 */
export const MAIN_MENU_LABELS = {
  chat: "گفت‌وگو",
  tools: "ابزارها",
  about: "درباره بابی",
} as const;

/** Callback data identifiers — stable, machine-readable. */
export const CALLBACKS = {
  chat: "menu:chat",
  tools: "menu:tools",
  about: "menu:about",
} as const;

/**
 * Placeholder replies for each menu section, in Persian.
 *
 * Kept for compatibility; replyForCallback() is the lang-aware entry point.
 */
export const MENU_REPLIES: Record<(typeof CALLBACKS)[keyof typeof CALLBACKS], string> = {
  [CALLBACKS.chat]: t("menu.reply.chat", "fa"),
  [CALLBACKS.tools]: t("menu.reply.tools", "fa"),
  [CALLBACKS.about]: t("menu.reply.about", "fa"),
};

/**
 * Persian display names for the built-in tools.
 *
 * Doubles as the known-tool set: a tool name not listed here is rendered
 * as-is (never as a raw "menu.tool.<name>" key).
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  calculator: "ماشین‌حساب",
  date_time: "تاریخ و ساعت",
  text_utilities: "ابزار متن",
  unit_converter: "تبدیل واحد",
  fetch_url: "خواندن صفحهٔ وب",
  web_search: "جستجوی وب",
};

/** Display label for a tool: translated when known, the raw name otherwise. */
function toolLabel(name: string, lang: Lang): string {
  return name in TOOL_LABELS ? t(`menu.tool.${name}`, lang) : name;
}

export function buildMainMenu(lang: Lang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("menu.label.chat", lang), CALLBACKS.chat)
    .text(t("menu.label.tools", lang), CALLBACKS.tools)
    .text(t("menu.label.about", lang), CALLBACKS.about);
}

/** Callback data for the /lang language picker — stable, machine-readable. */
export const LANG_CALLBACKS = {
  fa: "lang:fa",
  en: "lang:en",
} as const;

/**
 * Whether callback data belongs to the language picker.
 *
 * Matches by the "lang:" prefix rather than only the two known values, so
 * forged or junk picker data (e.g. "lang:de") routes to the lang handler,
 * which rejects it — unknown picker data is never mistaken for an ordinary
 * menu button.
 */
export function isLangCallback(data: string): boolean {
  return data.startsWith("lang:");
}

/**
 * Two-button language picker keyboard.
 *
 * Language names are the same in every UI language, so the buttons are
 * language-independent; the prompt line above the keyboard is translated.
 */
export function buildLangKeyboard(lang: Lang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("lang.label.fa", lang), LANG_CALLBACKS.fa)
    .text(t("lang.label.en", lang), LANG_CALLBACKS.en);
}

/**
 * Real tools menu text, built from the Registry's active tool list.
 *
 * Listing a tool here is NOT an execution grant — the Executor still checks
 * the caller's permissions at run time.
 */
export function toolListText(activeTools: readonly string[], lang: Lang = "fa"): string {
  if (activeTools.length === 0) {
    return t("menu.tools.empty", lang);
  }
  const items = activeTools.map((name, i) =>
    t("menu.tools.item", lang, { index: i + 1, label: toolLabel(name, lang) }),
  );
  return [
    t("menu.tools.title", lang),
    ...items,
    "",
    t("menu.tools.note", lang),
  ].join("\n");
}

const REPLY_KEYS: Readonly<Record<string, string>> = {
  [CALLBACKS.chat]: "menu.reply.chat",
  [CALLBACKS.tools]: "menu.reply.tools",
  [CALLBACKS.about]: "menu.reply.about",
};

export function replyForCallback(
  data: string,
  activeTools?: readonly string[],
  lang: Lang = "fa",
): string {
  if (data === CALLBACKS.tools && activeTools !== undefined) {
    return toolListText(activeTools, lang);
  }
  const key = REPLY_KEYS[data];
  if (key !== undefined) return t(key, lang);
  return t("menu.reply.unknown", lang);
}
