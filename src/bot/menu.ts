import { InlineKeyboard } from "grammy";
import { t, type Lang } from "../i18n";
import { tr } from "./menu_strings";
import type { HermesCommandDef } from "./cmd_context";

/**
 * Persian labels for the main menu buttons.
 *
 * Kept as the fa ground truth: buildMainMenu() with the default language must
 * render exactly these strings (asserted in tests). Labels now live in the
 * local menu table (`menu_strings.ts`) — the sibling i18n owner folds them
 * into the central packs later.
 */
export const MAIN_MENU_LABELS = {
  chat: tr("fa", "menu.label.chat"),
  tools: tr("fa", "menu.label.tools"),
  commands: tr("fa", "menu.label.commands"),
  settings: tr("fa", "menu.label.settings"),
  about: tr("fa", "menu.label.about"),
  help: tr("fa", "menu.label.help"),
  back: tr("fa", "menu.label.back"),
} as const;

/**
 * Callback data identifiers — stable, machine-readable.
 *
 * Additive: the original three values (`menu:chat`, `menu:tools`,
 * `menu:about`) are unchanged, so any in-flight keyboards keep working.
 */
export const CALLBACKS = {
  chat: "menu:chat",
  tools: "menu:tools",
  about: "menu:about",
  commands: "menu:commands",
  settings: "menu:settings",
  help: "menu:help",
  home: "menu:home",
} as const;

/**
 * Screen texts for each menu section, in Persian.
 *
 * Kept for compatibility; replyForCallback() is the lang-aware entry point.
 */
export const MENU_REPLIES: Record<(typeof CALLBACKS)[keyof typeof CALLBACKS], string> = {
  [CALLBACKS.chat]: tr("fa", "menu.screen.chat"),
  [CALLBACKS.tools]: tr("fa", "menu.screen.tools_fallback"),
  [CALLBACKS.about]: tr("fa", "menu.screen.about"),
  [CALLBACKS.commands]: tr("fa", "menu.screen.commands"),
  [CALLBACKS.settings]: tr("fa", "menu.screen.settings"),
  [CALLBACKS.help]: tr("fa", "menu.screen.help"),
  [CALLBACKS.home]: tr("fa", "menu.start.text"),
};

/**
 * The 10 built-in commands that are NOT part of the Hermes command modules
 * but must appear in Telegram's command menu: core first (start → compress),
 * then the two owner-only entries.
 *
 * Two-tier access: start/help/commands/lang/voice are public — voice is
 * conversation, not administration. The rest are owner-only — invisible in
 * the public menu scope and refused by the tier gate when typed or forged.
 *
 * Descriptions mirror the central `help.cmd.*` pack values so the menu and
 * /help never disagree.
 */
export const BUILTIN_COMMAND_DEFS: readonly HermesCommandDef[] = [
  { command: "start", descriptionFa: "شروع و نمایش منوی اصلی", descriptionEn: "Start and show the main menu", ownerOnly: false },
  { command: "help", descriptionFa: "راهنمای دستورها", descriptionEn: "Command reference", ownerOnly: false },
  { command: "commands", descriptionFa: "مرورگر دستورها", descriptionEn: "Browse commands by category", ownerOnly: false },
  { command: "voice", descriptionFa: "انتخاب حالت پاسخ صوتی (خودکار/همیشه/هرگز)", descriptionEn: "Choose voice-reply mode (auto/always/never)", ownerOnly: false },
  { command: "reset", descriptionFa: "پاک کردن تاریخچهٔ همین گفت‌وگو", descriptionEn: "Clear this conversation's history", ownerOnly: true },
  { command: "stop", descriptionFa: "توقف پاسخ در حال اجرا", descriptionEn: "Stop the running reply", ownerOnly: true },
  { command: "lang", descriptionFa: "تغییر زبان رابط کاربری", descriptionEn: "Change the interface language", ownerOnly: false },
  { command: "personality", descriptionFa: "نمایش یا تغییر لحن پاسخ‌گویی", descriptionEn: "Show or change the reply tone", ownerOnly: true },
  { command: "compress", descriptionFa: "خلاصه‌سازی فوری گفت‌وگوهای قدیمی", descriptionEn: "Immediately summarize old conversations", ownerOnly: true },
  { command: "admin", descriptionFa: "پنل مدیریت ربات", descriptionEn: "Bot admin panel", ownerOnly: true },
  { command: "ai", descriptionFa: "مدیریت ارائه‌دهندهٔ هوش مصنوعی", descriptionEn: "Manage the AI provider", ownerOnly: true },
  { command: "digest", descriptionFa: "خلاصهٔ تعاملی امروز", descriptionEn: "Interactive daily digest", ownerOnly: true },
];

/**
 * Public command-menu entries, in deliberate order: the built-in core
 * commands first, then the Hermes groups in module order
 * (session → system → automation), owner-only entries filtered out.
 * Pure, for tests and for the setMyCommands wiring in index.ts.
 */
export function publicMenuCommands(
  hermesDefs: readonly HermesCommandDef[],
): HermesCommandDef[] {
  return [
    ...BUILTIN_COMMAND_DEFS.filter((d) => !d.ownerOnly),
    ...hermesDefs.filter((d) => !d.ownerOnly),
  ];
}

/**
 * Owner command-menu entries: everything the public menu shows, plus the
 * owner-only builtins (admin, ai) right after the core commands, then all
 * Hermes defs. Pure, for tests and for the setMyCommands wiring in
 * index.ts.
 */
export function ownerMenuCommands(
  hermesDefs: readonly HermesCommandDef[],
): HermesCommandDef[] {
  return [...BUILTIN_COMMAND_DEFS, ...hermesDefs];
}

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

/** The /start onboarding screen. Shared by the /start handler and menu:home. */
export function startScreenText(lang: Lang = "fa"): string {
  return tr(lang, "menu.start.text");
}

/**
 * Main menu: 3 rows × 2 buttons, grouped by area
 * (chat/tools, commands/settings, about/help).
 *
 * Owner-only: the full menu. The public gets buildPublicMainMenu instead —
 * owner-only buttons are never rendered for them, not just blocked.
 */
export function buildMainMenu(lang: Lang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "menu.label.chat"), CALLBACKS.chat)
    .text(tr(lang, "menu.label.tools"), CALLBACKS.tools)
    .row()
    .text(tr(lang, "menu.label.commands"), CALLBACKS.commands)
    .text(tr(lang, "menu.label.settings"), CALLBACKS.settings)
    .row()
    .text(tr(lang, "menu.label.about"), CALLBACKS.about)
    .text(tr(lang, "menu.label.help"), CALLBACKS.help);
}

/**
 * Public main menu: a smaller, clean 2×2 menu for non-owners.
 *
 * Contains only public surface: chat, the (tier-filtered) command browser,
 * about, and help. The owner-only buttons (tools, settings) are ABSENT —
 * not hidden behind a tap, just never rendered. A forged tap on either is
 * refused by the callback router's tier gate.
 */
export function buildPublicMainMenu(lang: Lang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "menu.label.chat"), CALLBACKS.chat)
    .text(tr(lang, "menu.label.commands"), CALLBACKS.commands)
    .row()
    .text(tr(lang, "menu.label.about"), CALLBACKS.about)
    .text(tr(lang, "menu.label.help"), CALLBACKS.help);
}

/** Single «back» button — every sub-screen gets one, so there are no dead ends. */
export function buildBackKeyboard(lang: Lang = "fa"): InlineKeyboard {
  return new InlineKeyboard().text(tr(lang, "menu.label.back"), CALLBACKS.home);
}

/**
 * Keyboard for a menu callback: the full menu on the home screen, a back
 * button on every sub-screen. The home screen is tier-aware: the public
 * gets the smaller public menu, never the owner buttons.
 */
export function menuKeyboardFor(data: string, lang: Lang = "fa", isOwner: boolean = true): InlineKeyboard {
  if (data !== CALLBACKS.home) return buildBackKeyboard(lang);
  return isOwner ? buildMainMenu(lang) : buildPublicMainMenu(lang);
}

/** Callback data for the /lang language picker — stable, machine-readable. */
export const LANG_CALLBACKS = {
  fa: "lang:fa",
  en: "lang:en",
} as const;

/** Callback data for the /voice mode picker — stable, machine-readable. */
export const VOICE_CALLBACKS = {
  auto: "voice:auto",
  always: "voice:always",
  never: "voice:never",
} as const;

/**
 * Whether callback data belongs to the voice-mode picker.
 *
 * Matches by the "voice:" prefix rather than only the three known values, so
 * forged or junk picker data (e.g. "voice:maybe") routes to the voice
 * handler, which rejects it — unknown picker data is never mistaken for an
 * ordinary menu button.
 */
export function isVoiceCallback(data: string): boolean {
  return data.startsWith("voice:");
}

/**
 * Three-button voice-mode picker keyboard.
 *
 * The /voice prompt above the keyboard explains the modes; the buttons carry
 * the choice. Layout: auto and always side by side, never on its own row —
 * the destructive-ish "never" is deliberately one tap further away.
 */
export function buildVoiceKeyboard(lang: Lang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("voice.option.auto", lang), VOICE_CALLBACKS.auto)
    .text(t("voice.option.always", lang), VOICE_CALLBACKS.always)
    .row()
    .text(t("voice.option.never", lang), VOICE_CALLBACKS.never);
}

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
  [CALLBACKS.chat]: "menu.screen.chat",
  [CALLBACKS.tools]: "menu.screen.tools_fallback",
  [CALLBACKS.about]: "menu.screen.about",
  [CALLBACKS.commands]: "menu.screen.commands",
  [CALLBACKS.settings]: "menu.screen.settings",
  [CALLBACKS.help]: "menu.screen.help",
  [CALLBACKS.home]: "menu.start.text",
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
  if (key !== undefined) return tr(lang, key);
  return t("menu.reply.unknown", lang);
}

// ---------------------------------------------------------------- help ----

/** /help sections, in display order. */
export type HelpGroup = "general" | "session" | "automation" | "owner";

/** The grouped-/help title (central pack — kept stable for existing tests). */
export function helpTitle(lang: Lang = "fa"): string {
  return t("help.title", lang);
}

/** Section header for one /help group. */
export function helpGroupTitle(group: HelpGroup, lang: Lang = "fa"): string {
  return tr(lang, `menu.help.group.${group}`);
}

/**
 * One /help line. With an example argument it renders `/name example`,
 * otherwise `/name` — both followed by the one-line description.
 */
export function helpEntryLine(
  name: string,
  description: string,
  example: string | undefined,
  lang: Lang = "fa",
): string {
  if (example === undefined || example.length === 0) {
    return tr(lang, "menu.help.entry", { name, description });
  }
  return tr(lang, "menu.help.entry_example", { name, example, description });
}

/**
 * Edit a menu message in place; fall back to a fresh reply when the message
 * cannot be edited (too old, deleted, or from another chat).
 *
 * A "message is not modified" error means the screen is already showing —
 * that is silently swallowed instead of stacking a duplicate reply.
 * Pure-ish: takes a minimal ctx shape so tests can drive it with a fake.
 */
export async function editMenuMessage(
  ctx: {
    editMessageText(text: string, extra?: Record<string, unknown>): Promise<unknown>;
    reply(text: string, extra?: Record<string, unknown>): Promise<unknown>;
  },
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  const extra = { reply_markup: keyboard };
  try {
    await ctx.editMessageText(text, extra);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("message is not modified")) return;
    await ctx.reply(text, extra);
  }
}
