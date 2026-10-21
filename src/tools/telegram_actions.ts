/**
 * telegram_action — owner-driven actions inside Telegram chats.
 *
 * TRUST MODEL (read before touching this file):
 * - This is an OWNER-ONLY tool. The `ownerOnly` flag keeps the
 *   authorization bridge from granting its permission key to a
 *   non-owner, and run() re-checks the server-supplied `isOwner`
 *   predicate as defence in depth (the files.ts / goals.ts pattern).
 *   The owner is the only possible actor.
 * - The target chat defaults to the server-supplied current
 *   conversation (ctx.conversationId) — never to anything the model
 *   invents on its own. An explicit `chatId` input is still the
 *   owner's own instruction surface: because only the owner can run
 *   this tool at all, naming another chat is the owner directing the
 *   bot to act in a chat they control, not an escalation path for
 *   anyone else.
 *
 * The actual Telegram Bot API calls sit behind TelegramActionsPort.
 * This module owns validation, the files-sandbox discipline for
 * send_file, and error honesty; the composition root (bootstrap)
 * supplies a port backed by the live bot. Port failures are NEVER
 * echoed: any throw from the port becomes one generic internal
 * ToolError, because Bot API errors can carry chat ids, payloads and
 * other internals that must not reach the model or the user.
 *
 * This tool is the owner-driven counterpart to the automatic
 * moderation pipeline (src/moderation): that pipeline only ever
 * warns/deletes on its own; deliberate actions like these — and the
 * member restrictions in moderate_member — stay human decisions.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { ToolError } from "./errors";
import { ensureSandboxRoot, resolveSandboxPath } from "./sandbox";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import type { Tool, ToolContext } from "./types";

export const TELEGRAM_ACTION_PERMISSION = "tools:telegram_action";

/** Send ceiling: Telegram's file limit, bytes (the files tool's cap). */
export const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Telegram's message text ceiling, characters. */
export const MAX_MESSAGE_TEXT_LENGTH = 4096;
/** Telegram's poll question ceiling, characters. */
export const MAX_POLL_QUESTION_LENGTH = 300;
/** Telegram's poll option ceiling, characters per option. */
export const MAX_POLL_OPTION_LENGTH = 100;

/**
 * Port over the Telegram Bot API — the subset telegram_action and
 * moderate_member need. Implemented by the bot layer (grammy) in the
 * composition root; tools receive a lazy getter so a surface without
 * a bot (tests, headless runs) resolves to `undefined` and the tool
 * reports itself disabled instead of failing obscurely.
 */
export interface TelegramActionsPort {
  sendMessage(chatId: string, text: string, opts?: { replyToMessageId?: number }): Promise<{ messageId: number }>;
  setReaction(chatId: string, messageId: number, emoji: string): Promise<void>;
  forwardMessage(chatId: string, fromChatId: string, messageId: number): Promise<{ messageId: number }>;
  pinMessage(chatId: string, messageId: number): Promise<void>;
  sendPoll(chatId: string, question: string, options: readonly string[], opts?: { isAnonymous?: boolean; allowsMultipleAnswers?: boolean }): Promise<{ messageId: number }>;
  sendDocument(chatId: string, filename: string, bytes: Uint8Array, caption?: string): Promise<{ messageId: number }>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  banMember(chatId: string, userId: number): Promise<void>;
  unbanMember(chatId: string, userId: number): Promise<void>;
  restrictMember(chatId: string, userId: number, canSend: boolean, untilUnixSeconds?: number): Promise<void>;
}

export type TelegramAction =
  | "send_message"
  | "react"
  | "forward"
  | "pin"
  | "send_poll"
  | "send_file";

const TELEGRAM_ACTIONS: readonly TelegramAction[] = [
  "send_message",
  "react",
  "forward",
  "pin",
  "send_poll",
  "send_file",
];

export interface TelegramActionInput {
  action: TelegramAction;
  /** Target chat. Defaults to the current conversation. */
  chatId?: string;
  /** Message text (send_message). */
  text?: string;
  /** Target message id (react / forward / pin). */
  messageId?: number;
  /** Reaction emoji (react). */
  emoji?: string;
  /** Source chat for forward. Defaults to the target chat. */
  fromChatId?: string;
  /** Poll question (send_poll). */
  question?: string;
  /** Poll options, 2-10 (send_poll). */
  options?: string[];
  /** Poll: hide voters (send_poll). */
  anonymous?: boolean;
  /** Poll: allow several answers (send_poll). */
  multiple?: boolean;
  /** File path relative to the files sandbox root (send_file). */
  path?: string;
  /** Caption for the sent file (send_file). */
  caption?: string;
}

export interface TelegramActionOutput {
  action: TelegramAction;
  chatId: string;
  /** Present when Telegram created a message (send/forward/poll/file). */
  messageId?: number;
}

export interface TelegramActionsToolDeps {
  /**
   * Lazy port getter: called per run, so a bot that connects after
   * boot is picked up. `undefined` = this surface has no Telegram bot.
   */
  port: () => TelegramActionsPort | undefined;
  /** Root of the files sandbox send_file reads from (as for files). */
  rootDir: string;
  /** Server-supplied owner predicate; run() re-checks it (files.ts pattern). */
  isOwner: (userId: string) => boolean;
}

/** Plugin discovery manifest for `telegram_action`. */
export const telegramActionManifest: ToolManifest = defineManifest({
  id: "telegram_action",
  version: "1.0.0",
  title: "Telegram Actions",
  description:
    "Perform an action inside a Telegram chat: send a message, react to a message, forward a message, pin a message, send a poll, or send a file from the files area. Owner only.",
  purpose: "actions inside Telegram",
  useWhen: "owner asks Telegram action",
  doNotUseWhen:
    "Fetching media from a link — download_media does that; this only acts inside Telegram chats.",
  confusableWith: [
    {
      tool: "download_media",
      difference:
        "download_media fetches media from a link; this performs actions inside Telegram",
    },
    {
      tool: "files",
      difference:
        "files manages the files area; send_file here delivers one of those files into a chat",
    },
  ],
  latencyTier: "seconds",
  outputSummary:
    "Returns the action, the chat id, and the new message id when Telegram created one.",
  category: "system",
  costTier: "free",
});

export function createTelegramActionsTool(
  deps: TelegramActionsToolDeps,
): Tool<TelegramActionInput, TelegramActionOutput> {
  return {
    name: "telegram_action",
    manifest: telegramActionManifest,
    description:
      "Perform an action inside a Telegram chat: send a message, react, forward, pin, send a poll, or send a file from the files area into a chat. Defaults to the current chat. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [TELEGRAM_ACTION_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        action: {
          type: "enum",
          required: true,
          description: "One of: send_message, react, forward, pin, send_poll, send_file.",
          choices: [...TELEGRAM_ACTIONS],
        },
        chatId: {
          type: "string",
          description: "Target chat id. Defaults to the current conversation.",
          maxLength: 64,
        },
        text: {
          type: "string",
          description: "Message text for send_message (max 4096 characters).",
          maxLength: MAX_MESSAGE_TEXT_LENGTH,
        },
        messageId: {
          type: "integer",
          description: "Message id to react to, forward, or pin.",
          minimum: 1,
        },
        emoji: {
          type: "string",
          description: "Reaction emoji for react.",
          maxLength: 16,
        },
        fromChatId: {
          type: "string",
          description: "Source chat id for forward. Defaults to the target chat.",
          maxLength: 64,
        },
        question: {
          type: "string",
          description: "Poll question for send_poll (max 300 characters).",
          maxLength: MAX_POLL_QUESTION_LENGTH,
        },
        options: {
          type: "array",
          description: "Poll options for send_poll: 2 to 10 options, each max 100 characters.",
          maxItems: 10,
          items: { type: "string", maxLength: MAX_POLL_OPTION_LENGTH },
        },
        anonymous: {
          type: "boolean",
          description: "Poll option: hide who voted.",
        },
        multiple: {
          type: "boolean",
          description: "Poll option: allow multiple answers.",
        },
        path: {
          type: "string",
          description: "File to send, relative to the files area (send_file).",
          maxLength: 1024,
        },
        caption: {
          type: "string",
          description: "Caption for the sent file (send_file).",
          maxLength: 1024,
        },
      },
    },

    async run(input: TelegramActionInput, ctx: ToolContext): Promise<TelegramActionOutput> {
      assertOwner(ctx, deps);
      const chatId = resolveChatId(input, ctx);

      switch (input.action) {
        case "send_message": {
          const text = requiredText(input);
          const port = requirePort(deps);
          const res = await callPort(() => port.sendMessage(chatId, text));
          return { action: input.action, chatId, messageId: res.messageId };
        }
        case "react": {
          const messageId = requiredMessageId(input);
          const emoji = requiredEmoji(input);
          const port = requirePort(deps);
          await callPort(() => port.setReaction(chatId, messageId, emoji));
          return { action: input.action, chatId };
        }
        case "forward": {
          const messageId = requiredMessageId(input);
          const fromChatId =
            typeof input.fromChatId === "string" && input.fromChatId.trim().length > 0
              ? input.fromChatId.trim()
              : chatId;
          const port = requirePort(deps);
          const res = await callPort(() => port.forwardMessage(chatId, fromChatId, messageId));
          return { action: input.action, chatId, messageId: res.messageId };
        }
        case "pin": {
          const messageId = requiredMessageId(input);
          const port = requirePort(deps);
          await callPort(() => port.pinMessage(chatId, messageId));
          return { action: input.action, chatId };
        }
        case "send_poll": {
          const question = requiredQuestion(input);
          const options = requiredOptions(input);
          const port = requirePort(deps);
          const res = await callPort(() =>
            port.sendPoll(chatId, question, options, {
              isAnonymous: input.anonymous === true,
              allowsMultipleAnswers: input.multiple === true,
            }),
          );
          return { action: input.action, chatId, messageId: res.messageId };
        }
        case "send_file": {
          const rawPath = requiredPath(input);
          const port = requirePort(deps);
          return sendFile(deps, port, chatId, rawPath, input.caption);
        }
        default:
          throw new ToolError(
            "invalid_input",
            "Unknown action; use send_message, react, forward, pin, send_poll or send_file.",
          );
      }
    },
  };
}

// ------------------------------------------------------------- send_file --

async function sendFile(
  deps: TelegramActionsToolDeps,
  port: TelegramActionsPort,
  chatId: string,
  rawPath: string,
  caption: string | undefined,
): Promise<TelegramActionOutput> {
  const root = await ensureSandboxRoot(deps.rootDir);
  const rel = rawPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const target = await resolveSandboxPath(root, rel, {
    mustExist: true,
    requireNonEmpty: true,
  });
  const st = await stat(target).catch(() => undefined);
  if (st === undefined) throw new ToolError("not_found", "That file doesn't exist.");
  if (st.isDirectory()) {
    throw new ToolError("invalid_input", "That path is a folder; only files can be sent.");
  }
  if (st.size > TELEGRAM_MAX_FILE_BYTES) {
    throw new ToolError(
      "invalid_input",
      "That file is larger than the 50 MB limit for sending.",
    );
  }
  const bytes = await readFile(target).catch(() => {
    throw new ToolError("internal", "The file couldn't be read.");
  });
  if (bytes.length > TELEGRAM_MAX_FILE_BYTES) {
    throw new ToolError(
      "invalid_input",
      "That file is larger than the 50 MB limit for sending.",
    );
  }
  const res = await callPort(() =>
    port.sendDocument(chatId, basename(target), new Uint8Array(bytes), caption),
  );
  return { action: "send_file", chatId, messageId: res.messageId };
}

// ------------------------------------------------------------- sandbox ----
//
// Path safety uses the shared helper (./sandbox): absolute paths refused,
// lexical `..` escapes refused before any I/O, and the deepest existing
// ancestor realpath'd and required to stay inside the root's real path
// (symlink escapes refused). Error messages never echo the resolved path.

// ------------------------------------------------------------- helpers ----

/** Defence-in-depth owner check (the files.ts / goals.ts pattern). */
function assertOwner(ctx: ToolContext, deps: TelegramActionsToolDeps): void {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "Telegram actions are owner only.");
  }
}

/**
 * The target chat: an explicit chatId (the owner's own instruction
 * surface — see the trust model above) or the server-supplied current
 * conversation. Neither present is a caller error, not a guess.
 */
function resolveChatId(input: TelegramActionInput, ctx: ToolContext): string {
  if (typeof input.chatId === "string" && input.chatId.trim().length > 0) {
    return input.chatId.trim();
  }
  if (typeof ctx.conversationId === "string" && ctx.conversationId.trim().length > 0) {
    return ctx.conversationId.trim();
  }
  throw new ToolError(
    "invalid_input",
    "No chat was specified and there is no current conversation.",
  );
}

/** Resolve the port, or report this surface has no Telegram bot. */
export function requireTelegramPort(
  portGetter: () => TelegramActionsPort | undefined,
): TelegramActionsPort {
  let port: TelegramActionsPort | undefined;
  try {
    port = portGetter();
  } catch {
    throw new ToolError("internal", "Telegram could not complete that action.");
  }
  if (port === undefined) {
    throw new ToolError("disabled", "Telegram actions are not available on this surface.");
  }
  return port;
}

function requirePort(deps: TelegramActionsToolDeps): TelegramActionsPort {
  return requireTelegramPort(deps.port);
}

/**
 * Run one port call with error honesty: ANY throw from Telegram becomes
 * the same generic internal error. The underlying text is never echoed —
 * it can carry chat ids, request payloads, or token-adjacent detail.
 */
export async function callTelegramPort<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new ToolError("internal", "Telegram could not complete that action.");
  }
}

function callPort<T>(fn: () => Promise<T>): Promise<T> {
  return callTelegramPort(fn);
}

function requiredText(input: TelegramActionInput): string {
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new ToolError("invalid_input", "Text is required for send_message.");
  }
  if (input.text.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new ToolError(
      "invalid_input",
      "Text is too long: the limit is 4096 characters.",
    );
  }
  return input.text;
}

function requiredMessageId(input: TelegramActionInput): number {
  if (typeof input.messageId !== "number" || !Number.isInteger(input.messageId) || input.messageId < 1) {
    throw new ToolError("invalid_input", "A message id is required for this action.");
  }
  return input.messageId;
}

function requiredEmoji(input: TelegramActionInput): string {
  if (typeof input.emoji !== "string" || input.emoji.length === 0) {
    throw new ToolError("invalid_input", "An emoji is required for react.");
  }
  if (input.emoji.length > 16) {
    throw new ToolError("invalid_input", "That emoji is too long: the limit is 16 characters.");
  }
  return input.emoji;
}

function requiredQuestion(input: TelegramActionInput): string {
  if (typeof input.question !== "string" || input.question.length === 0) {
    throw new ToolError("invalid_input", "A question is required for send_poll.");
  }
  if (input.question.length > MAX_POLL_QUESTION_LENGTH) {
    throw new ToolError(
      "invalid_input",
      "That question is too long: the limit is 300 characters.",
    );
  }
  return input.question;
}

function requiredOptions(input: TelegramActionInput): string[] {
  if (!Array.isArray(input.options)) {
    throw new ToolError("invalid_input", "Poll options are required for send_poll.");
  }
  if (input.options.length < 2 || input.options.length > 10) {
    throw new ToolError("invalid_input", "A poll needs between 2 and 10 options.");
  }
  for (const option of input.options) {
    if (typeof option !== "string" || option.length === 0) {
      throw new ToolError("invalid_input", "Every poll option must be a non-empty string.");
    }
    if (option.length > MAX_POLL_OPTION_LENGTH) {
      throw new ToolError(
        "invalid_input",
        "A poll option is too long: the limit is 100 characters.",
      );
    }
  }
  return input.options;
}

function requiredPath(input: TelegramActionInput): string {
  const p = typeof input.path === "string" ? input.path.trim() : "";
  if (p.length === 0) throw new ToolError("invalid_input", "A file path is required.");
  return p;
}
