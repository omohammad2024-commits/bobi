/**
 * Webhook event envelopes.
 *
 * PRIVACY RULE (load-bearing): `data` carries operational metadata only —
 * event names, durations, token counts, tool names, statuses. It MUST NEVER
 * carry message content, tool arguments, or tool output. Webhook endpoints
 * are third-party HTTP servers; anything placed in `data` is, by definition,
 * shared with them. The builders below are the single place envelopes are
 * constructed, so the rule is enforced by construction rather than by
 * discipline at every call site.
 */

/** Event names BOBI emits to configured webhook endpoints. */
export type WebhookEventName = "agent:start" | "agent:end" | "tool:end";

/** JSON-serializable metadata. No strings from user messages or tool I/O. */
export type WebhookEventData = Record<string, string | number | boolean>;

export interface WebhookEvent {
  event: WebhookEventName;
  /** ISO-8601 timestamp of emission. */
  at: string;
  conversationId: string;
  userId: string;
  /**
   * Metadata only. See the privacy rule above: never message content, tool
   * arguments, or tool results. Lengths and counts are fine; bytes are not.
   */
  data: WebhookEventData;
}

/** Stable serialization: the same object always signs to the same bytes. */
export function serialiseEvent(event: WebhookEvent): string {
  return JSON.stringify({
    event: event.event,
    at: event.at,
    conversationId: event.conversationId,
    userId: event.userId,
    data: event.data,
  });
}

export interface AgentStartData {
  conversationId: string;
  userId: string;
  /** Model serving the turn — useful for cost dashboards, not sensitive. */
  model: string;
  hasAttachments: boolean;
  /**
   * Length of the user's text, not the text. Lets a receiver plot "long vs
   * short prompts" without ever seeing the prompt.
   */
  userTextLength: number;
  /** Emission time; defaults to now. */
  at?: string;
}

/** Fired before the agent loop starts. No user text, no attachments. */
export function agentStartEvent(d: AgentStartData): WebhookEvent {
  return {
    event: "agent:start",
    at: d.at ?? new Date().toISOString(),
    conversationId: d.conversationId,
    userId: d.userId,
    data: {
      model: d.model,
      hasAttachments: d.hasAttachments,
      userTextLength: d.userTextLength,
    },
  };
}

export interface AgentEndData {
  conversationId: string;
  userId: string;
  durationMs: number;
  toolCalls: number;
  ok: boolean;
  stopReason?: string;
  /** Aggregate token counts for the turn — billing metadata, not content. */
  inputTokens?: number;
  outputTokens?: number;
  at?: string;
}

/** Fired after the agent loop settles (or throws). No reply text. */
export function agentEndEvent(d: AgentEndData): WebhookEvent {
  const data: WebhookEventData = {
    durationMs: d.durationMs,
    toolCalls: d.toolCalls,
    ok: d.ok,
  };
  // exactOptionalPropertyTypes: omit rather than pass undefined.
  if (d.stopReason !== undefined) data.stopReason = d.stopReason;
  if (d.inputTokens !== undefined) data.inputTokens = d.inputTokens;
  if (d.outputTokens !== undefined) data.outputTokens = d.outputTokens;
  return {
    event: "agent:end",
    at: d.at ?? new Date().toISOString(),
    conversationId: d.conversationId,
    userId: d.userId,
    data,
  };
}

export interface ToolEndData {
  conversationId: string;
  userId: string;
  /** Tool name and outcome — never the arguments or the result. */
  tool: string;
  status: string;
  durationMs: number;
  at?: string;
}

/** Fired after each tool execution. Arguments and results stay in-process. */
export function toolEndEvent(d: ToolEndData): WebhookEvent {
  return {
    event: "tool:end",
    at: d.at ?? new Date().toISOString(),
    conversationId: d.conversationId,
    userId: d.userId,
    data: {
      tool: d.tool,
      status: d.status,
      durationMs: d.durationMs,
    },
  };
}
