/**
 * Expandable blockquotes for agent replies.
 *
 * The agent is instructed (src/agent/prompt.ts) to wrap on-demand long-form
 * content in markdown blockquotes (`> ` at the start of every line), so the
 * chat stays clean and the detail collapses. Telegram renders collapsed
 * quotes only via the `expandable_blockquote` message entity — neither HTML
 * nor Markdown parse_mode supports it — so this module converts `> `-marked
 * blocks into a manually built entities array.
 *
 * Offsets and lengths are UTF-16 code units, which is exactly what JS
 * string indexing measures, so no surrogate-pair adjustment is needed.
 * The streamer renders previews as plain text; entities are computed on the
 * FINAL text at send/final-edit time (see replyExpandable and the streamer
 * deliver() in src/bot/bot.ts).
 */

import type { MessageEntity } from "@grammyjs/types";

/** One `> ` line, with an optional single space/tab after the marker. */
const QUOTE_LINE_RE = /^>[ \t]?/;

export interface ExpandableQuoteResult {
  /** The input text with `> ` markers stripped. */
  text: string;
  /**
   * One `expandable_blockquote` entity per contiguous quote block.
   * Empty when the input has no blockquotes — the caller then sends the
   * text untouched, preserving the existing plain-text behaviour exactly.
   */
  entities: MessageEntity[];
}

/**
 * Convert markdown blockquote blocks into Telegram expandable_blockquote
 * entities.
 *
 * Contiguous `> `-prefixed lines form one block (blank `>` lines included);
 * any non-quote line closes the block. Markers are stripped from the output
 * text and each block becomes a single entity spanning the stripped lines.
 * Blocks with no visible content produce no entity. Input without
 * blockquotes returns the text unchanged with an empty entity list.
 */
export function blockquoteToEntities(input: string): ExpandableQuoteResult {
  const entities: MessageEntity[] = [];
  const out: string[] = [];
  let blockStart: number | null = null;
  let blockEnd = 0;
  let blockHasContent = false;
  // UTF-16 offset in the joined output; newlines included.
  let pos = 0;

  const closeBlock = (): void => {
    if (blockStart !== null) {
      // blockEnd stops at the last quote line's content: the "\n"
      // separator before the closing line is NOT part of the quote.
      if (blockHasContent && blockEnd > blockStart) {
        entities.push({
          type: "expandable_blockquote",
          offset: blockStart,
          length: blockEnd - blockStart,
        });
      }
      blockStart = null;
      blockHasContent = false;
    }
  };

  const lines = input.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = QUOTE_LINE_RE.exec(line);
    const content = marker !== null ? line.slice(marker[0].length) : line;
    if (marker !== null) {
      if (blockStart === null) blockStart = pos;
      if (content.trim().length > 0) blockHasContent = true;
    } else {
      closeBlock();
    }
    out.push(content);
    pos += content.length;
    if (marker !== null) blockEnd = pos;
    if (i < lines.length - 1) {
      out.push("\n");
      pos += 1;
    }
  }
  closeBlock();

  return { text: out.join(""), entities };
}

/**
 * The minimal reply surface this module needs: grammY's ctx.reply(text,
 * extra?) and the bot's DeliverCtx.reply(text) both satisfy it (extra is
 * optional, so a reply() that ignores it still type-checks and just drops
 * the entities at runtime — which only happens in tests).
 */
export interface ReplyLike {
  reply(
    text: string,
    extra?: { entities?: MessageEntity[]; reply_parameters?: { message_id: number } },
  ): Promise<unknown>;
}

/**
 * Send text, turning any `> ` blocks into expandable quotes.
 *
 * No blockquotes → a plain ctx.reply(text), byte-identical to the old
 * behaviour. With blockquotes → the markers are stripped and the entities
 * array is passed explicitly (parse_mode is never used for this).
 */
export async function replyExpandable(
  ctx: ReplyLike,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const { text: clean, entities } = blockquoteToEntities(text);
  const extra: { entities?: MessageEntity[]; reply_parameters?: { message_id: number } } = {};
  if (entities.length > 0) extra.entities = entities;
  if (replyToMessageId !== undefined) extra.reply_parameters = { message_id: replyToMessageId };
  if (entities.length === 0 && replyToMessageId === undefined) {
    await ctx.reply(text);
  } else {
    await ctx.reply(clean, extra);
  }
}

/**
 * Strip `> ` markers without building entities — for the TTS path, so the
 * voice synthesis never reads the markers aloud.
 */
export function stripBlockquoteMarkers(text: string): string {
  return blockquoteToEntities(text).text;
}
