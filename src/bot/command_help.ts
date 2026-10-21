/**
 * Bot command catalog — pure re-export shim.
 *
 * The catalog data moved to the tools layer (src/tools/command_help.ts,
 * platform Phase 5) so the tool layer no longer imports up into the bot
 * layer. This shim keeps every existing bot-side import path working.
 */
export { COMMAND_HELP, visibleCommandHelp } from "../tools/command_help";
export type { CommandHelpEntry, HelpGroup } from "../tools/command_help";
