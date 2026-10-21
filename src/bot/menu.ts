import { processEnv } from "../config/env";
import { InlineKeyboard } from "grammy";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { t, type Lang } from "../i18n";
import { tr } from "../i18n/strings/menu_strings";
import type { HermesCommandDef } from "./cmd_context";
import type { HelpGroup } from "../tools/command_help";

export type { HelpGroup };

/**
 * English labels for the main menu buttons.
 *
 * Kept as the ground truth: buildMainMenu() with the default language must
 * render exactly these strings (asserted in tests). Labels now live in the
 * menu table in the i18n system (`src/i18n/strings/menu_strings.ts`).
 */
export const MAIN_MENU_LABELS = {
  chat: tr("en", "menu.label.chat"),
  tools: tr("en", "menu.label.tools"),
  commands: tr("en", "menu.label.commands"),
  settings: tr("en", "menu.label.settings"),
  about: tr("en", "menu.label.about"),
  help: tr("en", "menu.label.help"),
  back: tr("en", "menu.label.back"),
  miniapp: tr("en", "menu.label.miniapp"),
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
  [CALLBACKS.chat]: tr("en", "menu.screen.chat"),
  [CALLBACKS.tools]: tr("en", "menu.screen.tools_fallback"),
  [CALLBACKS.about]: tr("en", "menu.screen.about"),
  [CALLBACKS.commands]: tr("en", "menu.screen.commands"),
  [CALLBACKS.settings]: tr("en", "menu.screen.settings"),
  [CALLBACKS.help]: tr("en", "menu.screen.help"),
  [CALLBACKS.home]: tr("en", "menu.start.text"),
};

/**
 * The 11 built-in commands that are NOT part of the Hermes command modules
 * but must appear in Telegram's command menu: core first (start → compress),
 * then the two owner-only entries.
 *
 * Two-tier access: start/help/commands/voice are public — voice is
 * conversation, not administration. The rest are owner-only — invisible in
 * the public menu scope and refused by the tier gate when typed or forged.
 * (/lang was removed Oct 2026: the UI is English-only.)
 *
 * Descriptions mirror the central `help.cmd.*` pack values so the menu and
 * /help never disagree. The bot's UI is English-only.
 */
export const BUILTIN_COMMAND_DEFS: readonly HermesCommandDef[] = [
  { command: "start", descriptionEn: "Start and show the main menu", ownerOnly: false },
  { command: "help", descriptionEn: "Command reference", ownerOnly: false },
  { command: "commands", descriptionEn: "Browse commands by category", ownerOnly: false },
  { command: "voice", descriptionEn: "Choose voice-reply mode (auto/always/never)", ownerOnly: false },
  { command: "reset", descriptionEn: "Clear this conversation's history", ownerOnly: true },
  { command: "stop", descriptionEn: "Stop the running reply", ownerOnly: true },
  { command: "personality", descriptionEn: "Show or change the reply tone", ownerOnly: true },
  { command: "compress", descriptionEn: "Immediately summarize old conversations", ownerOnly: true },
  { command: "admin", descriptionEn: "Bot admin panel", ownerOnly: true },
  { command: "ai", descriptionEn: "Manage the AI provider", ownerOnly: true },
  { command: "digest", descriptionEn: "Interactive daily digest", ownerOnly: true },
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
 * English display names for the built-in tools.
 *
 * Doubles as the known-tool set: a tool name not listed here is rendered
 * as-is (never as a raw "menu.tool.<name>" key). The values themselves are
 * unused — toolLabel resolves through the central `menu.tool.*` pack.
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  calculator: "Calculator",
  date_time: "Date & time",
  text_utilities: "Text utilities",
  unit_converter: "Unit converter",
  fetch_url: "Page reader",
  web_search: "Web search",
};

/** Display label for a tool: translated when known, the raw name otherwise. */
function toolLabel(name: string, lang: Lang): string {
  return name in TOOL_LABELS ? t(`menu.tool.${name}`, lang) : name;
}

/** The /start welcome screen. Shared by the /start handler and menu:home.
 *
 * Tier-aware: the owner variant adds /reset and /digest to the command
 * list; the public variant lists only commands the public can actually
 * use (two-tier invisibility — no dead commands on the welcome screen).
 */
export function startScreenText(lang: Lang = "en", isOwner: boolean = true): string {
  return tr(lang, isOwner ? "menu.start.text" : "menu.start.text_public");
}

/**
 * Public HTTPS URL of the owner Mini App, or undefined when unavailable.
 *
 * Resolution order: BOBI_MINIAPP_URL env first, then the `miniapp.url` file
 * the tunnel service writes in the bot's working directory. Fail-closed: when
 * neither exists (e.g. no public tunnel yet), the caller must not render the
 * Mini App button at all — never a dead button.
 */
export function miniAppUrl(): string | undefined {
  const fromEnv = (processEnv().BOBI_MINIAPP_URL ?? "").trim();
  if (fromEnv.startsWith("https://")) return fromEnv;
  try {
    const p = join(process.cwd(), "miniapp.url");
    if (existsSync(p)) {
      const first = (readFileSync(p, "utf8").trim().split(/\s+/)[0] ?? "").trim();
      if (first.startsWith("https://")) return first;
    }
  } catch {
    // Fail closed: no URL, no button.
  }
  return undefined;
}

/**
 * Main menu: a clean 2×2 grid, grouped by area (chat/tools, commands/settings).
 *
 * Owner-only: the full menu. The public gets buildPublicMainMenu instead —
 * owner-only buttons are never rendered for them, not just blocked.
 *
 * A third row holds the Mini App web_app button, but ONLY when a public
 * HTTPS URL is configured (miniAppUrl()). No URL → no button, never a dead
 * one. The public menu never includes it.
 */
export function buildMainMenu(lang: Lang = "en"): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(tr(lang, "menu.label.chat"), CALLBACKS.chat)
    .text(tr(lang, "menu.label.tools"), CALLBACKS.tools)
    .row()
    .text(tr(lang, "menu.label.commands"), CALLBACKS.commands)
    .text(tr(lang, "menu.label.settings"), CALLBACKS.settings);
  const miniUrl = miniAppUrl();
  if (miniUrl !== undefined) {
    kb.row().webApp(tr(lang, "menu.label.miniapp"), miniUrl);
  }
  return kb;
}

/**
 * The home menu for a tier: the full 2×2 owner menu, or the smaller public
 * menu for everyone else. Single choke point so every "back home" path
 * stays tier-correct (two-tier invisibility, not just blocking).
 */
export function homeMenuForTier(isOwner: boolean, lang: Lang = "en"): InlineKeyboard {
  return isOwner ? buildMainMenu(lang) : buildPublicMainMenu(lang);
}

/**
 * Public main menu: a smaller, clean 2×2 menu for non-owners.
 *
 * Contains only public surface: chat, the (tier-filtered) command browser,
 * about, and help. The owner-only buttons (tools, settings) are ABSENT —
 * not hidden behind a tap, just never rendered. A forged tap on either is
 * refused by the callback router's tier gate.
 */
export function buildPublicMainMenu(lang: Lang = "en"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "menu.label.chat"), CALLBACKS.chat)
    .text(tr(lang, "menu.label.commands"), CALLBACKS.commands)
    .row()
    .text(tr(lang, "menu.label.about"), CALLBACKS.about)
    .text(tr(lang, "menu.label.help"), CALLBACKS.help);
}

/** Single «back» button — every sub-screen gets one, so there are no dead ends. */
export function buildBackKeyboard(lang: Lang = "en"): InlineKeyboard {
  return new InlineKeyboard().text(tr(lang, "menu.label.back"), CALLBACKS.home);
}

/**
 * Keyboard for a menu callback: the full menu on the home screen, a back
 * button on every sub-screen. The home screen is tier-aware: the public
 * gets the smaller public menu, never the owner buttons.
 */
export function menuKeyboardFor(data: string, lang: Lang = "en", isOwner: boolean = true): InlineKeyboard {
  if (data !== CALLBACKS.home) return buildBackKeyboard(lang);
  return isOwner ? buildMainMenu(lang) : buildPublicMainMenu(lang);
}

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
export function buildVoiceKeyboard(lang: Lang = "en"): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("voice.option.auto", lang), VOICE_CALLBACKS.auto)
    .text(t("voice.option.always", lang), VOICE_CALLBACKS.always)
    .row()
    .text(t("voice.option.never", lang), VOICE_CALLBACKS.never);
}

/**
 * Real tools menu text, built from the Registry's active tool list.
 *
 * Listing a tool here is NOT an execution grant — the Executor still checks
 * the caller's permissions at run time.
 */
export function toolListText(activeTools: readonly string[], lang: Lang = "en"): string {
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
  lang: Lang = "en",
): string {
  if (data === CALLBACKS.tools && activeTools !== undefined) {
    return toolListText(activeTools, lang);
  }
  const key = REPLY_KEYS[data];
  if (key !== undefined) return tr(lang, key);
  return t("menu.reply.unknown", lang);
}

// ---------------------------------------------------------------- help ----

/* HelpGroup (the /help sections, in display order) is defined in
 * src/tools/command_help.ts and re-exported at the top of this module,
 * so existing `HelpGroup` imports from ./menu keep working. */

/** The grouped-/help title (central pack — kept stable for existing tests). */
export function helpTitle(lang: Lang = "en"): string {
  return t("help.title", lang);
}

/** Section header for one /help group. */
export function helpGroupTitle(group: HelpGroup, lang: Lang = "en"): string {
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
  lang: Lang = "en",
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
