/**
 * Lifecycle hook events and their payloads.
 *
 * Hooks let the owner attach small, declarative reactions to BOBI's lifecycle:
 * a tool action that runs when the bot starts, when an agent turn begins or
 * ends, or when a tool finishes. They are the Hermes-hooks equivalent, with
 * one deliberate difference: a hook file can never execute code. A hook is
 * frontmatter data plus an optional markdown note; its action is structured
 * data validated by parseTaskAction, and only "tool" actions are accepted.
 *
 * PAYLOAD PRIVACY CONTRACT (read before adding a field):
 *
 * Payloads carry timestamps, ids, and counts only. They NEVER contain:
 *   - secrets, credentials, tokens, or API keys
 *   - message text (beyond its length)
 *   - tool inputs or tool outputs
 *
 * A payload flows through hook execution and may end up in hook-related logs,
 * so anything a hook handler could not already see on its own must not be in
 * a payload. When in doubt, emit a length or a count, never the content.
 */
import type { ToolRunStatus } from "../tools/types";

/**
 * The lifecycle events hooks can subscribe to.
 *
 * - "startup":     the bot finished booting (runs once, as the owner).
 * - "agent:start": an agent turn began (before the agent loop runs).
 * - "agent:end":   an agent turn finished or failed (after the loop).
 * - "tool:end":    one tool execution settled, ok or not.
 */
export type HookEvent = "startup" | "agent:start" | "agent:end" | "tool:end";

/** Every known event, in a stable order. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "startup",
  "agent:start",
  "agent:end",
  "tool:end",
];

/** True when the value names a real hook event. */
export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

export interface HookPayloadBase {
  event: HookEvent;
  /** ISO-8601 timestamp of the emission. */
  at: string;
}

/** Emitted once after the bot starts. Handled with the owner's actor. */
export interface StartupPayload extends HookPayloadBase {
  event: "startup";
  /** Bot username when known. Never a token. */
  botUsername?: string;
}

/** Emitted before the agent loop runs for a turn. */
export interface AgentStartPayload extends HookPayloadBase {
  event: "agent:start";
  conversationId: string;
  userId: string;
  /** Length of the user's text — never the text itself. */
  userTextLength: number;
  hasAttachments: boolean;
  model: string;
}

/** Emitted after the agent loop settles, successfully or not. */
export interface AgentEndPayload extends HookPayloadBase {
  event: "agent:end";
  conversationId: string;
  durationMs: number;
  toolCalls: number;
  /** False when the turn threw. */
  ok: boolean;
  stopReason?: string;
}

/**
 * Emitted after each tool execution settles.
 *
 * Deliberately minimal: the tool NAME, its status, and how long it took.
 * Input and output contents are never included — a hook reacting to "a tool
 * finished" does not need to see what the tool saw.
 */
export interface ToolEndPayload extends HookPayloadBase {
  event: "tool:end";
  tool: string;
  status: ToolRunStatus;
  durationMs: number;
  userId: string;
}

export type HookPayload =
  | StartupPayload
  | AgentStartPayload
  | AgentEndPayload
  | ToolEndPayload;
