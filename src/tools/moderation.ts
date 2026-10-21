/**
 * moderate_member — owner-driven moderation inside the CURRENT group.
 *
 * This is the human counterpart to the automatic moderation pipeline
 * (src/moderation): the pipeline's action set is deliberately closed
 * at warn/delete and it NEVER bans or restricts — those decisions stay
 * with the owner. This tool is how the owner makes them by asking.
 *
 * Safety shape:
 * - OWNER-ONLY, twice over: the `ownerOnly` flag withholds the
 *   permission key from non-owners, and run() re-checks the
 *   server-supplied `isOwner` predicate (the files.ts / goals.ts
 *   pattern). The owner is the only possible actor.
 * - GROUPS ONLY, CURRENT CHAT ONLY: there is deliberately NO chatId
 *   input. The chat is always ctx.conversationId, supplied by server
 *   code, and a private conversation (a positive id) — or no
 *   conversation at all — is refused. Moderation can never be aimed
 *   at a chat the owner is not currently in.
 * - NO CONTENT ECHO: a warning is a static English platform text plus
 *   an optional owner-written note. There is no input field that could
 *   carry the offending message's content, so nothing hostile can be
 *   reflected into the group through this tool.
 * - Port failures are never echoed (see telegram_actions.ts): any
 *   throw becomes one generic internal ToolError.
 */
import { ToolError } from "./errors";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import type { Tool, ToolContext } from "./types";
import { callTelegramPort, requireTelegramPort } from "./telegram_actions";
import type { TelegramActionsPort } from "./telegram_actions";

export const MODERATE_MEMBER_PERMISSION = "tools:moderate_member";

/** Longest mute: 30 days, in minutes. */
export const MAX_MUTE_MINUTES = 43200;
/** Owner note appended to a warning, character ceiling. */
export const MAX_WARN_NOTE_LENGTH = 200;

/** Static platform warning. No message content is ever interpolated. */
export const WARNING_TEXT = "⚠️ Warning from the group admin.";

export type ModerateAction = "ban" | "unban" | "mute" | "unmute" | "delete_message" | "warn";

const MODERATE_ACTIONS: readonly ModerateAction[] = [
  "ban",
  "unban",
  "mute",
  "unmute",
  "delete_message",
  "warn",
];

export interface ModerateMemberInput {
  action: ModerateAction;
  /** Telegram user id. Required for ban / unban / mute / unmute. */
  userId?: number;
  /** Message id. Required for delete_message / warn. */
  messageId?: number;
  /** Mute length in minutes (1-43200). Without it a mute is indefinite. */
  durationMinutes?: number;
  /** Extra owner-written text appended to a warning (warn only). */
  note?: string;
}

export interface ModerateMemberOutput {
  action: ModerateAction;
  chatId: string;
  userId?: number;
  messageId?: number;
}

export interface ModerationToolDeps {
  /** Lazy port getter (see telegram_actions.ts). */
  port: () => TelegramActionsPort | undefined;
  /** Server-supplied owner predicate; run() re-checks it. */
  isOwner: (userId: string) => boolean;
}

/** Plugin discovery manifest for `moderate_member`. */
export const moderateMemberManifest: ToolManifest = defineManifest({
  id: "moderate_member",
  version: "1.0.0",
  title: "Moderate Member",
  description:
    "Moderate a member of the current group chat: ban, unban, mute, unmute, delete a message, or warn by replying to a message. Groups only. Owner only.",
  purpose: "restrict group members",
  useWhen: "member breaks group rules",
  doNotUseWhen:
    "Private chats or plain Telegram actions — telegram_action sends and polls; this moderates the current group only.",
  confusableWith: [
    {
      tool: "telegram_action",
      difference:
        "telegram_action sends/reacts/polls/files; this restricts members and removes messages",
    },
  ],
  latencyTier: "seconds",
  outputSummary: "Returns the action, the group chat id, and the member or message id involved.",
  category: "system",
  costTier: "free",
});

export function createModerationTool(
  deps: ModerationToolDeps,
): Tool<ModerateMemberInput, ModerateMemberOutput> {
  return {
    name: "moderate_member",
    manifest: moderateMemberManifest,
    description:
      "Moderate a member of the current group chat: ban, unban, mute, unmute, delete a message, or warn by replying to it. Only works in the current group chat. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [MODERATE_MEMBER_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        action: {
          type: "enum",
          required: true,
          description: "One of: ban, unban, mute, unmute, delete_message, warn.",
          choices: [...MODERATE_ACTIONS],
        },
        userId: {
          type: "integer",
          description: "Telegram user id of the member. Required for ban, unban, mute and unmute.",
          minimum: 1,
        },
        messageId: {
          type: "integer",
          description: "Message id. Required for delete_message and warn.",
          minimum: 1,
        },
        durationMinutes: {
          type: "integer",
          description: "Mute length in minutes, 1 to 43200 (30 days). Mute only.",
          minimum: 1,
          maximum: MAX_MUTE_MINUTES,
        },
        note: {
          type: "string",
          description: "Extra text appended to the warning. Warn only.",
          maxLength: MAX_WARN_NOTE_LENGTH,
        },
      },
    },

    async run(input: ModerateMemberInput, ctx: ToolContext): Promise<ModerateMemberOutput> {
      assertOwner(ctx, deps);
      const chatId = currentGroupChatId(ctx);
      const durationMinutes = checkedDuration(input);
      const note = checkedNote(input);

      switch (input.action) {
        case "ban": {
          const userId = requiredUserId(input);
          const port = requirePort(deps);
          await callTelegramPort(() => port.banMember(chatId, userId));
          return { action: input.action, chatId, userId };
        }
        case "unban": {
          const userId = requiredUserId(input);
          const port = requirePort(deps);
          await callTelegramPort(() => port.unbanMember(chatId, userId));
          return { action: input.action, chatId, userId };
        }
        case "mute": {
          const userId = requiredUserId(input);
          const port = requirePort(deps);
          if (durationMinutes !== undefined) {
            const untilUnixSeconds =
              Math.floor(ctx.clock().getTime() / 1000) + durationMinutes * 60;
            await callTelegramPort(() =>
              port.restrictMember(chatId, userId, false, untilUnixSeconds),
            );
          } else {
            await callTelegramPort(() => port.restrictMember(chatId, userId, false));
          }
          return { action: input.action, chatId, userId };
        }
        case "unmute": {
          const userId = requiredUserId(input);
          const port = requirePort(deps);
          await callTelegramPort(() => port.restrictMember(chatId, userId, true));
          return { action: input.action, chatId, userId };
        }
        case "delete_message": {
          const messageId = requiredMessageId(input);
          const port = requirePort(deps);
          await callTelegramPort(() => port.deleteMessage(chatId, messageId));
          return { action: input.action, chatId, messageId };
        }
        case "warn": {
          const messageId = requiredMessageId(input);
          const port = requirePort(deps);
          const warningText = note !== undefined ? `${WARNING_TEXT} ${note}` : WARNING_TEXT;
          const res = await callTelegramPort(() =>
            port.sendMessage(chatId, warningText, { replyToMessageId: messageId }),
          );
          return { action: input.action, chatId, messageId: res.messageId };
        }
        default:
          throw new ToolError(
            "invalid_input",
            "Unknown action; use ban, unban, mute, unmute, delete_message or warn.",
          );
      }
    },
  };
}

// ------------------------------------------------------------- helpers ----

/** Defence-in-depth owner check (the files.ts / goals.ts pattern). */
function assertOwner(ctx: ToolContext, deps: ModerationToolDeps): void {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "Moderation is owner only.");
  }
}

/**
 * The current chat, and proof it is a group: Telegram group and
 * supergroup ids are negative, private chat ids are positive. Derived
 * ONLY from the server-supplied conversation — this tool has no
 * chatId input by design.
 */
function currentGroupChatId(ctx: ToolContext): string {
  const chatId = ctx.conversationId;
  if (typeof chatId !== "string" || chatId.trim().length === 0) {
    throw new ToolError("invalid_input", "Moderation actions only work in group chats.");
  }
  const numeric = Number(chatId);
  if (Number.isNaN(numeric) || numeric > 0) {
    throw new ToolError("invalid_input", "Moderation actions only work in group chats.");
  }
  return chatId.trim();
}

function requirePort(deps: ModerationToolDeps): TelegramActionsPort {
  return requireTelegramPort(deps.port);
}

function requiredUserId(input: ModerateMemberInput): number {
  if (typeof input.userId !== "number" || !Number.isInteger(input.userId) || input.userId < 1) {
    throw new ToolError("invalid_input", "A user id is required for this action.");
  }
  return input.userId;
}

function requiredMessageId(input: ModerateMemberInput): number {
  if (
    typeof input.messageId !== "number" ||
    !Number.isInteger(input.messageId) ||
    input.messageId < 1
  ) {
    throw new ToolError("invalid_input", "A message id is required for this action.");
  }
  return input.messageId;
}

function checkedDuration(input: ModerateMemberInput): number | undefined {
  if (input.durationMinutes === undefined) return undefined;
  if (
    typeof input.durationMinutes !== "number" ||
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < 1 ||
    input.durationMinutes > MAX_MUTE_MINUTES
  ) {
    throw new ToolError(
      "invalid_input",
      "durationMinutes must be between 1 and 43200.",
    );
  }
  return input.durationMinutes;
}

function checkedNote(input: ModerateMemberInput): string | undefined {
  if (input.note === undefined) return undefined;
  if (typeof input.note !== "string") {
    throw new ToolError("invalid_input", "Note must be text.");
  }
  if (input.note.length > MAX_WARN_NOTE_LENGTH) {
    throw new ToolError("invalid_input", "That note is too long: the limit is 200 characters.");
  }
  const trimmed = input.note.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
