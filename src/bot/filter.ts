import type { Context } from "grammy";

/**
 * Decide whether a message update should be answered.
 *
 * Rules (Privacy Mode stays ON — bot only *sees* replies-to-it and commands):
 * - private chat  → always handle
 * - group/supergroup:
 *     • a reply to a message sent by THIS bot            → handle
 *     • a bot command ("/cmd" or "/cmd@ThisBot")          → handle
 *     • anything else (plain text, media, etc.)           → ignore
 */
export function shouldHandleMessage(ctx: Context, botId: number): boolean {
  const msg = ctx.message;
  if (!msg) return false;

  if (msg.chat.type === "private") return true;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return false;

  // Reply to this bot's own message
  if (msg.reply_to_message?.from?.id === botId) return true;

  // Explicit command
  if (isCommandForMe(ctx, msg)) return true;

  return false;
}

function isCommandForMe(ctx: Context, msg: NonNullable<Context["message"]>): boolean {
  const text = msg.text ?? msg.caption;
  if (!text?.startsWith("/")) return false;

  const first = text.split(/\s/, 1)[0];
  if (!first) return false;

  // "/cmd" is for everyone; "/cmd@OtherBot" is for another bot
  const at = first.indexOf("@");
  if (at === -1) return true;

  const mentioned = first.slice(at + 1);
  const me = ctx.me?.username;
  return me !== undefined && mentioned.toLowerCase() === me.toLowerCase();
}
