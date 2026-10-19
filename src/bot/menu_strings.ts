import type { Lang } from "../i18n";

/**
 * Phase: menu/help UI redesign — start screen, menu screens, grouped /help.
 *
 * All user-facing strings for `menu.ts` and the /start + /help handlers,
 * English-only (owner direction, Oct 2026: the bot's chrome is English-only;
 * the agent's conversation stays multilingual). The coordinator folds these
 * keys into `src/i18n/en.ts` later (never touch those files from here);
 * until then this module is the single source of truth. Every key uses the
 * `menu.*` prefix so the fold-in cannot collide with other tables.
 *
 * Copy rules: clean, minimal, short command lists with em-dash
 * descriptions, emoji section headers (👋 📌 👥), one emoji per line at
 * most. Never dump all 60+ commands on a screen — 5-6 essentials max.
 *
 * Template vars are `{name}` placeholders, substituted by `tr()`.
 */

type Vars = Record<string, string | number>;

/**
 * The single English table. `tr()` keeps its `(lang, key, vars)` signature
 * for compatibility with every caller (the language argument is now
 * ignored — the UI is English-only).
 */
const STRINGS: Record<string, string> = {
  // ---- /start + home screen ----
  // Reference aesthetic: short greeting, 1-2 line description, essential
  // commands only, emoji section headers, groups line. Two variants:
  // the public one lists only commands the public can actually use;
  // the owner variant adds /reset and /digest.
  "menu.start.text_public":
    "👋 Welcome to BOBI!\n" +
    "\n" +
    "I'm your personal AI agent — just send me a message and I'll reply.\n" +
    "\n" +
    "📌 Main commands:\n" +
    "/help — Show all commands\n" +
    "/commands — Browse commands by category\n" +
    "/voice — Voice replies (auto / always / never)\n" +
    "\n" +
    "👥 In groups: mention me, or reply to one of my messages.",

  "menu.start.text":
    "👋 Welcome to BOBI!\n" +
    "\n" +
    "I'm your personal AI agent — just send me a message and I'll reply.\n" +
    "\n" +
    "📌 Main commands:\n" +
    "/help — Show all commands\n" +
    "/commands — Browse commands by category\n" +
    "/voice — Voice replies (auto / always / never)\n" +
    "/reset — Clear this conversation\n" +
    "/digest — Your interactive daily digest\n" +
    "\n" +
    "👥 In groups: mention me, or reply to one of my messages.",

  // ---- menu screens ----
  "menu.screen.chat":
    "💬 Chat\n" +
    "\n" +
    "Just type — right here. Questions, ideas, tasks, anything on your mind.\n" +
    "No commands to memorize.",

  "menu.screen.tools_fallback":
    "🛠 Tools\n" + "\n" + "The tool service is unavailable — I can't list the active tools right now.",

  "menu.screen.commands":
    "⌨️ Commands\n" +
    "\n" +
    "Browse every command by category with /commands,\n" +
    "or see the full reference with /help.",

  "menu.screen.settings":
    "⚙️ Settings\n" +
    "\n" +
    "/voice — voice replies (auto / always / never)\n" +
    "/personality — my reply tone\n" +
    "/footer — technical footer on replies\n" +
    "/busy — what I do while busy\n" +
    "\n" +
    "These settings are saved just for you.",

  "menu.screen.about":
    "🤖 BOBI — your personal AI agent.\n" +
    "\n" +
    "Chat here, set reminders, schedule tasks,\n" +
    "manage memory and tools.\n" +
    "\n" +
    "❓ Help: /help",

  "menu.screen.help":
    "❓ Quick help\n" +
    "\n" +
    "💬 Just type — I answer\n" +
    "⌨️ /commands — browse every command\n" +
    "🎙 /voice — voice replies (auto / always / never)\n" +
    "\n" +
    "📖 Full reference: /help",

  // ---- menu button labels ----
  "menu.label.chat": "💬 Chat",
  "menu.label.tools": "🛠 Tools",
  "menu.label.commands": "⌨️ Commands",
  "menu.label.settings": "⚙️ Settings",
  "menu.label.about": "ℹ️ About BOBI",
  "menu.label.help": "❓ Help",
  "menu.label.back": "◀️ Back",
  "menu.label.miniapp": "🛠️ Manage (Mini App)",

  // ---- grouped /help ----
  "menu.help.group.general": "🔹 General",
  "menu.help.group.session": "🗂 Session",
  "menu.help.group.automation": "⚡️ Automation",
  "menu.help.group.owner": "🔒 Owner",
  "menu.help.entry": "/{name} — {description}",
  "menu.help.entry_example": "/{name} {example} — {description}",
};

/**
 * Look up a `menu.*` key and substitute `{vars}`.
 * Unknown keys fall back to the key itself — never throws, so a missing
 * key can never break a handler. The `lang` argument is accepted for
 * signature compatibility and ignored: the UI is English-only.
 */
export function tr(
  _lang: "en" | "fa", // accepted for compatibility; always renders English
  key: string,
  vars?: Vars,
): string {
  let s = STRINGS[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
