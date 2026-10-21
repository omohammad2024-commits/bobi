/**
 * Bot command catalog — the single source of truth for the command list.
 *
 * Lives in the tools layer (src/tools, grammY-free by design) so the
 * agent tool layer can answer "list the commands" from the same data
 * the /help text, the /commands palette, and the access-tier tests all
 * read. One list, no drift. The bot layer re-exports it through
 * src/bot/command_help.ts (a pure shim) so existing bot-side imports
 * keep working.
 */
import { t } from "../i18n";

/** /help sections, in display order. */
export type HelpGroup = "general" | "session" | "automation" | "owner";

export interface CommandHelpEntry {
  name: string;
  /** English one-line description (mirrors the `help.cmd.<name>` pack entry). */
  description: string;
  /** Owner-only entries are hidden from everyone else. */
  ownerOnly: boolean;
  /** /help section this command is listed under. */
  group: HelpGroup;
  /** Example argument, rendered after the command. */
  example?: string;
}

/**
 * Every command the bot registers, with a one-line English description,
 * its /help section, and an example argument where one is genuinely useful.
 *
 * `description` is sourced from the central `help.cmd.<name>` pack value, so
 * the two can never drift apart.
 */
export const COMMAND_HELP: readonly CommandHelpEntry[] = [
  // ---- general ----
  // Two-tier access: the public surface is exactly start/help/commands/voice.
  // Every other command is owner-only (ownerOnly: true) — invisible to the
  // public in menus, /help and the palette, and refused by the tier gate.
  { name: "start", description: t("help.cmd.start"), ownerOnly: false, group: "general" },
  { name: "help", description: t("help.cmd.help"), ownerOnly: false, group: "general" },
  { name: "commands", description: t("help.cmd.commands"), ownerOnly: false, group: "general" },
  { name: "voice", description: t("help.cmd.voice"), ownerOnly: false, group: "general" },
  { name: "reset", description: t("help.cmd.reset"), ownerOnly: true, group: "general" },
  { name: "stop", description: t("help.cmd.stop"), ownerOnly: true, group: "general" },
  { name: "personality", description: t("help.cmd.personality"), ownerOnly: true, group: "general" },
  { name: "compress", description: t("help.cmd.compress"), ownerOnly: true, group: "general" },
  // ---- session ----
  { name: "history", description: t("help.cmd.history"), ownerOnly: true, group: "session", example: "20" },
  { name: "save", description: t("help.cmd.save"), ownerOnly: true, group: "session", example: "json" },
  { name: "retry", description: t("help.cmd.retry"), ownerOnly: true, group: "session" },
  { name: "undo", description: t("help.cmd.undo"), ownerOnly: true, group: "session", example: "2" },
  { name: "title", description: t("help.cmd.title"), ownerOnly: true, group: "session", example: "ideas" },
  { name: "branch", description: t("help.cmd.branch"), ownerOnly: true, group: "session", example: "ideas" },
  { name: "resume", description: t("help.cmd.resume"), ownerOnly: true, group: "session", example: "ideas" },
  { name: "sessions", description: t("help.cmd.sessions"), ownerOnly: true, group: "session" },
  { name: "status", description: t("help.cmd.status"), ownerOnly: true, group: "session" },
  { name: "context", description: t("help.cmd.context"), ownerOnly: true, group: "session" },
  { name: "busy", description: t("help.cmd.busy"), ownerOnly: true, group: "session", example: "queue" },
  { name: "whoami", description: t("help.cmd.whoami"), ownerOnly: true, group: "session" },
  { name: "footer", description: t("help.cmd.footer"), ownerOnly: true, group: "session", example: "on" },
  { name: "version", description: t("help.cmd.version"), ownerOnly: true, group: "session" },
  { name: "new", description: t("help.cmd.new"), ownerOnly: true, group: "session" },
  // ---- automation ----
  { name: "bg", description: t("help.cmd.bg"), ownerOnly: true, group: "automation", example: "news summary" },
  { name: "btw", description: t("help.cmd.btw"), ownerOnly: true, group: "automation", example: "what is this?" },
  { name: "queue", description: t("help.cmd.queue"), ownerOnly: true, group: "automation", example: "message text" },
  { name: "steer", description: t("help.cmd.steer"), ownerOnly: true, group: "automation", example: "keep it short" },
  { name: "agents", description: t("help.cmd.agents"), ownerOnly: true, group: "automation" },
  { name: "suggestions", description: t("help.cmd.suggestions"), ownerOnly: true, group: "automation" },
  { name: "blueprint", description: t("help.cmd.blueprint"), ownerOnly: true, group: "automation" },
  { name: "refine", description: t("help.cmd.refine"), ownerOnly: true, group: "automation" },
  { name: "review", description: t("help.cmd.review"), ownerOnly: true, group: "automation" },
  { name: "plan", description: t("help.cmd.plan"), ownerOnly: true, group: "automation", example: "summer campaign" },
  { name: "moa", description: t("help.cmd.moa"), ownerOnly: true, group: "automation", example: "which phone?" },
  { name: "memory", description: t("help.cmd.memory"), ownerOnly: true, group: "automation" },
  { name: "bundles", description: t("help.cmd.bundles"), ownerOnly: true, group: "automation" },
  { name: "digest", description: t("help.cmd.digest"), ownerOnly: true, group: "automation" },
  // ---- owner ----
  { name: "admin", description: t("help.cmd.admin"), ownerOnly: true, group: "owner" },
  { name: "ai", description: t("help.cmd.ai"), ownerOnly: true, group: "owner" },
  { name: "snapshot", description: t("help.cmd.snapshot"), ownerOnly: true, group: "owner" },
  { name: "restart", description: t("help.cmd.restart"), ownerOnly: true, group: "owner" },
  { name: "update", description: t("help.cmd.update"), ownerOnly: true, group: "owner" },
  { name: "debug", description: t("help.cmd.debug"), ownerOnly: true, group: "owner" },
  { name: "usage", description: t("help.cmd.usage"), ownerOnly: true, group: "owner" },
  { name: "insights", description: t("help.cmd.insights"), ownerOnly: true, group: "owner" },
  { name: "model", description: t("help.cmd.model"), ownerOnly: true, group: "owner" },
  { name: "reasoning", description: t("help.cmd.reasoning"), ownerOnly: true, group: "owner", example: "low" },
  { name: "autoprune", description: t("help.cmd.autoprune"), ownerOnly: true, group: "owner" },
  { name: "tools", description: t("help.cmd.tools"), ownerOnly: true, group: "owner" },
  { name: "skills", description: t("help.cmd.skills"), ownerOnly: true, group: "owner" },
  { name: "curator", description: t("help.cmd.curator"), ownerOnly: true, group: "owner" },
  { name: "plugins", description: t("help.cmd.plugins"), ownerOnly: true, group: "owner" },
  { name: "reload_mcp", description: t("help.cmd.reload_mcp"), ownerOnly: true, group: "owner" },
  { name: "reload_skills", description: t("help.cmd.reload_skills"), ownerOnly: true, group: "owner" },
  { name: "approve", description: t("help.cmd.approve"), ownerOnly: true, group: "owner" },
  { name: "deny", description: t("help.cmd.deny"), ownerOnly: true, group: "owner" },
  { name: "sethome", description: t("help.cmd.sethome"), ownerOnly: true, group: "owner" },
  { name: "pause", description: t("help.cmd.pause"), ownerOnly: true, group: "owner" },
  { name: "goal", description: t("help.cmd.goal"), ownerOnly: true, group: "owner", example: "daily exercise" },
  { name: "subgoal", description: t("help.cmd.subgoal"), ownerOnly: true, group: "owner", example: "a walk" },
  { name: "heartbeat", description: t("help.cmd.heartbeat"), ownerOnly: true, group: "owner" },
  { name: "loop", description: t("help.cmd.loop"), ownerOnly: true, group: "owner" },
  { name: "cron", description: t("help.cmd.cron"), ownerOnly: true, group: "owner" },
  { name: "learn", description: t("help.cmd.learn"), ownerOnly: true, group: "owner" },
  { name: "ban", description: t("help.cmd.ban"), ownerOnly: true, group: "owner", example: "123456" },
  { name: "unban", description: t("help.cmd.unban"), ownerOnly: true, group: "owner", example: "123456" },
  { name: "mute", description: t("help.cmd.mute"), ownerOnly: true, group: "owner", example: "123456" },
  { name: "unmute", description: t("help.cmd.unmute"), ownerOnly: true, group: "owner", example: "123456" },
  // ---- phase-3 ----
  { name: "skill", description: t("help.cmd.skill"), ownerOnly: true, group: "owner" },
  { name: "bench", description: t("help.cmd.bench"), ownerOnly: true, group: "owner" },
  { name: "gassistant", description: t("help.cmd.gassistant"), ownerOnly: true, group: "owner" },
  { name: "gsummary", description: t("help.cmd.gsummary"), ownerOnly: true, group: "owner" },
  { name: "gpoll", description: t("help.cmd.gpoll"), ownerOnly: true, group: "owner" },
];

/**
 * Commands the sender may see. Owner-only entries are hidden from
 * non-owners, so the listing never advertises what the sender cannot use.
 * Pure, for tests.
 */
export function visibleCommandHelp(isOwner: boolean): readonly CommandHelpEntry[] {
  return isOwner ? COMMAND_HELP : COMMAND_HELP.filter((c) => !c.ownerOnly);
}
