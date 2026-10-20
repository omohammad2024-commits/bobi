/**
 * History compaction.
 *
 * The engine keeps a bounded window of recent turns. Before this existed, the
 * oldest turns simply fell out of that window and were gone — a user who
 * mentioned something fifty messages ago would find BOBI had no memory of it,
 * with nothing to indicate the loss.
 *
 * Instead, when the window is exceeded the turns that would have been dropped
 * are folded into a running summary that is carried forward as a system
 * message. The details are lost either way, but the gist survives.
 *
 * Design notes:
 * - Summarisation is best-effort. If it fails, the turn still succeeds; the
 *   engine falls back to the plain window rather than failing the request over
 *   a compaction problem.
 * - The summary is stored per conversation and rewritten, not appended to
 *   indefinitely, so it cannot grow without bound.
 * - The model call it makes is bounded by a tight timeout and a small token
 *   budget, since it is housekeeping rather than the user's actual request.
 */
import { AiError } from "../ai/provider";
import type { AiProvider, ChatMessage } from "../ai/provider";

/** How many turns must overflow before a compaction is worth doing. */
export const MIN_COMPACT_MESSAGES = 6;

/** Ceiling on the summary itself, so it cannot become the whole context. */
export const MAX_SUMMARY_CHARS = 2_000;

/** The summariser's own budget — small, because it is housekeeping. */
const SUMMARY_TIMEOUT_MS = 20_000;

export interface SummariseOptions {
  provider: AiProvider;
  model: string;
  /** Timeout for the summarisation call itself. */
  timeoutMs?: number;
  /** Injectable clock, for tests. */
  signal?: AbortSignal;
}

/**
 * Fold `older` (plus any existing summary) into one updated summary.
 *
 * Returns the new summary text, or undefined when summarisation could not be
 * done — in which case the caller keeps whatever it had.
 */
export async function summariseHistory(
  older: readonly ChatMessage[],
  previous: string | undefined,
  opts: SummariseOptions,
): Promise<string | undefined> {
  const turns = older.filter((m) => m.role === "user" || m.role === "assistant");
  if (turns.length === 0 && previous === undefined) return undefined;

  const prompt = buildSummarisePrompt(turns, previous);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? SUMMARY_TIMEOUT_MS);
  // The caller's cancellation also ends this call.
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await opts.provider.complete({
      messages: [{ role: "user", content: prompt }],
      model: opts.model,
      timeoutMs: opts.timeoutMs ?? SUMMARY_TIMEOUT_MS,
      signal: controller.signal,
    });

    const text = res.text.trim();
    if (text.length === 0) return undefined;
    return clip(text, MAX_SUMMARY_CHARS);
  } catch (err) {
    // Compaction is best-effort: a provider error here must not fail the turn.
    if (err instanceof AiError) return undefined;
    return undefined;
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The summarisation instruction.
 *
 * Deliberately terse and in the same language as the conversation, and the
 * previous summary is carried in so an already-compacted history is not lost
 * when it is compacted again.
 */
function buildSummarisePrompt(
  turns: readonly ChatMessage[],
  previous: string | undefined,
): string {
  const transcript = turns
    .map((m) => `${m.role === "user" ? "User" : "BOBI"}: ${m.content}`)
    .join("\n");

  const parts = [
    "This is part of a conversation that needs to be summarized.",
    "Write the summary in English, keep it short, and only keep things useful for continuing the conversation:",
    "names, preferences, decisions, and unfinished tasks. Drop unimportant details.",
    "Write only the summary text; no extra explanation.",
  ];

  if (previous !== undefined && previous.length > 0) {
    parts.push("", "Previous summary:", previous);
  }

  parts.push("", "Conversation:", transcript);
  return parts.join("\n");
}

/** The header marking a rolling-summary turn, used for identification. */
export const SUMMARY_MESSAGE_HEADER = "خلاصهٔ گفت‌وگوی قبلی:";

/** Encode the summary as a system turn the engine can carry forward. */
export function summaryMessage(summary: string): ChatMessage {
  return {
    role: "system",
    content: `${SUMMARY_MESSAGE_HEADER}\n${summary}`,
  };
}

/** Cut to `max` characters on a word boundary. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const at = slice.lastIndexOf(" ");
  return at > max * 0.5 ? `${slice.slice(0, at).trimEnd()}…` : `${slice.trimEnd()}…`;
}

/**
 * Split a history into the part that no longer fits and the part that does.
 *
 * Returns `older` (to be summarised) and `recent` (kept verbatim). The split
 * only happens once enough overflow has accumulated, so a conversation hovering
 * at the limit does not trigger a summarisation call on every single turn.
 */
export function splitHistory(
  history: readonly ChatMessage[],
  limit: number,
): { older: ChatMessage[]; recent: ChatMessage[] } {
  if (history.length <= limit) return { older: [], recent: [...history] };

  const overflow = history.length - limit;
  // Wait for a meaningful batch before paying for a summarisation call.
  if (overflow < MIN_COMPACT_MESSAGES) {
    // Still over the limit, but not worth compacting yet: drop the excess
    // rather than sending an over-long request.
    return { older: [], recent: history.slice(overflow) };
  }

  return {
    older: history.slice(0, overflow),
    recent: history.slice(overflow),
  };
}

