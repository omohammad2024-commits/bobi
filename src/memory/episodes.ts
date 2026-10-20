/**
 * Episodic session summaries (memory-core upgrade).
 *
 * Long-term memory held facts, but nothing remembered that a CONVERSATION
 * happened — what was discussed, what got decided, what was left hanging.
 * This module closes that gap: when a conversation goes quiet (no messages
 * for 30 minutes) after a real exchange (≥ 6 user turns), a short episode
 * summary is stored as a memory under an `episode:` key, and
 * `latestEpisode()` hands the newest one back so a future conversation can
 * open with "last time we talked about…".
 *
 * The summary is built deterministically from the transcript (first topic,
 * extracted facts/decisions, the still-open last user turn) — the same
 * rule-based style as fact extraction — and the summarizer is injectable,
 * so an LLM summarizer can replace it later without touching the trigger
 * or storage logic.
 *
 * Storage-taxonomy note: the memories table has no kind column; kind is a
 * KEY prefix everywhere else too (`fact:name`, `event:…`), so episodes are
 * `episode:<chatId>:<lastActivityMs>`. The trailing timestamp makes the
 * write naturally idempotent: re-scanning the same ended conversation
 * targets the same key. Episode importance is 3 — the neutral tier, the
 * 1-5 mapping of the design sketch's 0.5.
 *
 * Wiring note: nothing here is called by the engine yet. A scheduler sweep
 * (or the follow-up wiring) calls `scanEndedConversations`; prompt assembly
 * calls `latestEpisode` at conversation start.
 *
 * Kill switch: BOBI_MEMORY_EPISODES=0.
 */
import type { StoredMessage } from "../storage/storage";
import type { ConversationReader } from "./auto_extract";
import { extractFactCandidates } from "./auto_extract";
import { oneLineSummary } from "./hybrid";
import type { MemoryProvider, StoredMemory } from "./provider";

/** Importance for episode memories: neutral tier (0.5 on a 0-1 sketch). */
export const EPISODE_IMPORTANCE = 3;
/** Default quiet period after which a conversation counts as ended. */
export const EPISODE_IDLE_MS = 30 * 60 * 1000;
/** Default minimum user turns for an episode to be worth storing. */
export const EPISODE_MIN_USER_TURNS = 6;

export function isEpisodesEnabled(): boolean {
  return process.env.BOBI_MEMORY_EPISODES !== "0";
}

/** Deterministic key for one ended conversation snapshot. */
export function episodeKey(chatId: string, lastActivityMs: number): string {
  return `episode:${chatId}:${lastActivityMs}`;
}

export interface EpisodeDeps {
  conversations: ConversationReader;
  provider: MemoryProvider;
  /**
   * Optional replacement summarizer (e.g. an LLM). Receives the full
   * transcript slice; must return the 2-3 line summary text.
   */
  summarize?: (
    messages: readonly StoredMessage[],
  ) => string | Promise<string>;
  nowMs?: number;
  /** Quiet period before a conversation counts as ended. Default 30 min. */
  idleMs?: number;
  /** Minimum user turns. Default 6. */
  minUserTurns?: number;
}

export interface EpisodeCheckResult {
  stored: boolean;
  /** The episode key, when one was (or already had been) stored. */
  key?: string;
  /** Why nothing was stored, when stored is false. */
  reason?: "disabled" | "too-few-turns" | "still-active" | "already-stored" | "empty";
}

/**
 * Build the default 2-3 line episode summary from a transcript.
 *
 * Line 1: what was discussed (the opening user turn).
 * Line 2: decisions/commitments the fact extractor finds, if any.
 * Line 3: the open thread — the final user turn, when the conversation
 * ended on one (i.e. the user spoke last and may expect a follow-up).
 */
export function buildEpisodeSummary(messages: readonly StoredMessage[]): string {
  const userMsgs = messages.filter((m) => m.role === "user" && m.content.trim().length > 0);
  if (userMsgs.length === 0) return "";
  const lines: string[] = [];
  lines.push(`موضوع: ${oneLineSummary(userMsgs[0]!.content)}`);

  const facts = extractFactCandidates(userMsgs.map((m) => m.content)).filter(
    (c) => c.kind === "decision" || c.kind === "commitment" || c.kind === "correction",
  );
  if (facts.length > 0) {
    lines.push(`نکته‌ها: ${facts.map((f) => oneLineSummary(f.content, 100)).join("؛ ")}`);
  }

  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === "user" && messages.length > 1) {
    lines.push(`باز: ${oneLineSummary(last.content)}`);
  }
  return lines.slice(0, 3).join("\n");
}

/**
 * Check ONE conversation against the end-of-session trigger and store its
 * episode when it qualifies. Safe to call repeatedly (idempotent key).
 */
export async function maybeStoreEpisode(
  deps: EpisodeDeps,
  userId: string,
  chatId: string,
): Promise<EpisodeCheckResult> {
  if (!isEpisodesEnabled()) return { stored: false, reason: "disabled" };
  const nowMs = deps.nowMs ?? Date.now();
  const idleMs = deps.idleMs ?? EPISODE_IDLE_MS;
  const minTurns = deps.minUserTurns ?? EPISODE_MIN_USER_TURNS;

  const messages = deps.conversations.history(userId, chatId, 200);
  if (messages.length === 0) return { stored: false, reason: "empty" };

  const lastActivity = Math.max(...messages.map((m) => m.createdAt));
  if (nowMs - lastActivity < idleMs) return { stored: false, reason: "still-active" };

  const userTurns = messages.filter((m) => m.role === "user").length;
  if (userTurns < minTurns) return { stored: false, reason: "too-few-turns" };

  const key = episodeKey(chatId, lastActivity);
  const existing = await deps.provider.get(userId, key);
  if (existing !== undefined) return { stored: false, key, reason: "already-stored" };

  const summary =
    deps.summarize !== undefined
      ? await deps.summarize(messages)
      : buildEpisodeSummary(messages);
  if (summary.trim().length === 0) return { stored: false, reason: "empty" };

  await deps.provider.upsert(userId, key, summary, { importance: EPISODE_IMPORTANCE });
  return { stored: true, key };
}

/**
 * Sweep all of a user's conversations and store episodes for the ones
 * that have ended. This is the scheduler entry point.
 */
export async function scanEndedConversations(
  deps: EpisodeDeps,
  userId: string,
  maxConversations = 20,
): Promise<{ checked: number; stored: number }> {
  if (!isEpisodesEnabled()) return { checked: 0, stored: 0 };
  const convs = deps.conversations.listUserConversations(userId).slice(0, maxConversations);
  let stored = 0;
  for (const conv of convs) {
    const r = await maybeStoreEpisode(deps, userId, conv.conversationId);
    if (r.stored) stored += 1;
  }
  return { checked: convs.length, stored };
}

/**
 * The newest episode stored for a user, if any — the conversation-start
 * recall hook for prompt assembly (wiring is a follow-up; see header).
 */
export async function latestEpisode(
  provider: MemoryProvider,
  userId: string,
): Promise<StoredMemory | undefined> {
  const all = await provider.list(userId, 200);
  // provider.list is newest-first, so the first episode key wins.
  return all.find((m) => m.key.startsWith("episode:"));
}
