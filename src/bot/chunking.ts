/**
 * Telegram surface chunking: the bot's reply splitter, delegating to the
 * platform core splitter (src/core/chunking.ts) at Telegram's message limit.
 */
import { splitTextIntoChunks } from "../core/chunking";

/** Telegram's hard limit for a single message. */
export const TELEGRAM_MAX_LENGTH = 4096;

/** Split text into ≤4096-char chunks on word/line boundaries. */
export function splitForTelegram(text: string): string[] {
  return splitTextIntoChunks(text, TELEGRAM_MAX_LENGTH);
}
