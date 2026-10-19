/**
 * commands — the bot's chat-command list, from a cheap static catalog.
 *
 * WHY THIS TOOL EXISTS (bug: natural-language "send the command list" timed
 * out): the agent had no way to answer that request. No tool listed the bot's
 * commands and the prompt did not name them, so the model fumbled — probing
 * tool_search, delegating to a child agent that knew no more than it did —
 * burning provider round-trips until the run's wall-clock budget shrank the
 * per-call timeout and a slow call tripped it. This tool answers from the
 * static COMMAND_HELP catalog (the same single source the /help text and the
 * /commands palette render from), so the turn is one fast local call and one
 * answer, with no I/O and no provider loop.
 *
 * TWO-TIER ACCESS: the tool itself is NOT ownerOnly — the public may ask what
 * the bot can do. The listing is filtered per actor instead: owner-only
 * commands are withheld from non-owners by visibleCommandHelp, exactly like
 * /help and the palette. The public surface stays the four public commands;
 * nothing about owner commands leaks through the listing.
 */
import type { Tool, ToolActor, ToolContext } from "./types";
import { visibleCommandHelp } from "../bot/command_help";

/** Permission key that gates this tool. Granted like any other tool key. */
export const COMMANDS_PERMISSION = "tools:commands";

/** Name under which the tool registers. */
export const COMMANDS_TOOL_NAME = "commands";

export interface CommandsToolDeps {
  /**
   * Whether this user id is the owner. Server-side fact, resolved per call —
   * never model text. Drives the owner-only filtering of the listing.
   */
  isOwner: (userId: string) => boolean;
}

/** No input: the listing is static and per-actor, never per-request. */
export type CommandsInput = Record<string, never>;

export interface CommandsEntry {
  /** Command name without the leading slash. */
  name: string;
  /** One-line English description. */
  description: string;
  /** /help section this command is listed under. */
  group: string;
  /** Example argument, when one is genuinely useful. */
  example?: string;
}

export interface CommandsOutput {
  commands: CommandsEntry[];
}

/** Build the commands tool. Not ownerOnly: the listing filters per actor. */
export function createCommandsTool(deps: CommandsToolDeps): Tool<CommandsInput, CommandsOutput> {
  return {
    name: COMMANDS_TOOL_NAME,
    description: "Show the bot's commands.",
    enabled: true,
    permission: { requires: [COMMANDS_PERMISSION] },
    // No toolset: always visible to the model (subject to the permission
    // check), never hidden by the tool gateway's active-toolset filter.
    input: { fields: {} },

    async run(_input: CommandsInput, ctx: ToolContext): Promise<CommandsOutput> {
      // Defence in depth: the listing a non-owner sees must never name an
      // owner-only command, even if a future caller wires the deps wrongly —
      // so the filter reads the actor, not a cached flag.
      const owner = isOwnerSafe(deps, ctx.actor);
      const entries = visibleCommandHelp(owner);
      return {
        commands: entries.map((e) => ({
          name: e.name,
          description: e.description,
          group: e.group,
          // exactOptionalPropertyTypes: omit rather than pass undefined.
          ...(e.example !== undefined ? { example: e.example } : {}),
        })),
      };
    },
  };
}

/**
 * Resolve ownership without letting a throwing resolver fail the turn.
 * Fail-closed: an unresolvable actor sees the public listing only.
 */
function isOwnerSafe(deps: CommandsToolDeps, actor: ToolActor): boolean {
  try {
    return deps.isOwner(actor.userId) === true;
  } catch {
    return false;
  }
}
