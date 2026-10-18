import { InlineKeyboard } from "grammy";

/** Persian labels for the main menu buttons. */
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

/** Initial placeholder replies for each menu section. */
export const MENU_REPLIES: Record<(typeof CALLBACKS)[keyof typeof CALLBACKS], string> = {
  [CALLBACKS.chat]: "گفت‌وگو: به‌زودی می‌توانی با بابی حرف بزنی.",
  [CALLBACKS.tools]: "ابزارها: فهرست ابزارها در مرحلهٔ بعد اضافه می‌شود.",
  [CALLBACKS.about]: `بابی — ربات ایجنت همه‌کاره. نسخهٔ آزمایشی.`,
};

/** Persian display names for the built-in tools. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  calculator: "ماشین‌حساب",
  date_time: "تاریخ و ساعت",
  text_utilities: "ابزار متن",
  unit_converter: "تبدیل واحد",
  fetch_url: "خواندن صفحهٔ وب",
  web_search: "جستجوی وب",
};

export function buildMainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text(MAIN_MENU_LABELS.chat, CALLBACKS.chat)
    .text(MAIN_MENU_LABELS.tools, CALLBACKS.tools)
    .text(MAIN_MENU_LABELS.about, CALLBACKS.about);
}

/**
 * Real tools menu text, built from the Registry's active tool list.
 *
 * Listing a tool here is NOT an execution grant — the Executor still checks
 * the caller's permissions at run time.
 */
export function toolListText(activeTools: readonly string[]): string {
  if (activeTools.length === 0) {
    return "ابزارها: هیچ ابزار فعالی وجود ندارد.";
  }
  const items = activeTools.map((name, i) => `${i + 1}. ${TOOL_LABELS[name] ?? name}`);
  return [
    "ابزارهای فعال بابی:",
    ...items,
    "",
    "فهرست بالا یعنی ابزارها در دسترس‌اند؛ اجرای هر کدام به مجوز شما بستگی دارد.",
  ].join("\n");
}

export function replyForCallback(
  data: string,
  activeTools?: readonly string[],
): string {
  if (data === CALLBACKS.tools && activeTools !== undefined) {
    return toolListText(activeTools);
  }
  return MENU_REPLIES[data as keyof typeof MENU_REPLIES] ?? "گزینهٔ نامشخص.";
}
