/**
 * Tokenizer-free token estimation for context budgeting.
 *
 * Calling a real tokenizer per turn would add latency and a dependency; for
 * budgeting we only need a conservative ballpark, not an exact count. The
 * estimator is deliberately pessimistic on the side that matters (it slightly
 * OVER-counts), because under-counting blows the context window and
 * over-counting only triggers an earlier compaction.
 *
 * Heuristics (validated against tiktoken-style tokenizers in tests):
 * - Latin/script-neutral text: ~3.5 characters per token.
 * - Persian/Arabic-script text (denser per character): ~1.8 per token.
 * - Fenced code blocks (```...```): ~4 characters per token — code is
 *   unusually compact per character, so it is counted separately.
 * - A fixed per-message overhead (~4 tokens) for role framing.
 *
 * Exported pure functions; the engine calls them before every provider call.
 */
import type { ChatMessage } from "../ai/provider";

/** Persian/Arabic-script Unicode ranges (dense per character). */
const DENSE_SCRIPT_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

/** A fenced code block: opening fence, anything, closing fence or end. */
const CODE_FENCE_RE = /```[\s\S]*?(?:```|$)/g;

/** Fixed overhead per message for role framing and separators. */
export const PER_MESSAGE_TOKEN_OVERHEAD = 4;

/**
 * Estimate the token count of one text blob.
 *
 * Code fences are stripped and counted at the code rate; Persian/Arabic
 * characters in the remainder are counted at the dense rate, everything else
 * at the Latin rate. Empty text estimates to zero.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let codeChars = 0;
  const rest = text.replace(CODE_FENCE_RE, (block) => {
    codeChars += block.length;
    return " ";
  });

  let dense = 0;
  const plain = rest.replace(DENSE_SCRIPT_RE, () => {
    dense++;
    return "";
  });

  return Math.ceil(codeChars / 4 + dense / 1.8 + plain.length / 3.5);
}

/**
 * Estimate one message, including framing overhead and the declared tool
 * calls of an assistant turn (the call payloads are all sent to the model).
 * Attachments (`parts`) are not estimated — they ride the live turn only and
 * never enter the budgeted history.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = PER_MESSAGE_TOKEN_OVERHEAD + estimateTokens(message.content);
  const calls = message.toolCalls;
  if (calls !== undefined) {
    for (const call of calls) {
      const args =
        typeof call.arguments === "string"
          ? call.arguments
          : (JSON.stringify(call.arguments) ?? "");
      tokens += estimateTokens(call.name) + estimateTokens(args);
    }
  }
  return tokens;
}

/** Estimate a whole message list. Pure; never mutates. */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}
