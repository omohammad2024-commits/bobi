/**
 * Streaming plumbing: the kill switch, the ambient token sink, and the
 * throttled Telegram renderer.
 *
 * WHY AN AMBIENT SINK: the token events flow bot → engine → loop, but the
 * engine (src/conversation/engine.ts) is owned by another work package, so
 * the sink cannot be threaded through its input contracts. Instead the bot
 * installs a sink in an AsyncLocalStorage scope around engine.respond(); the
 * loop reads it when a provider call starts. Scopes nest per async context,
 * so concurrent turns in different chats never see each other's sink. When
 * no scope is installed (delegate children, tests, other callers) the loop
 * simply does not stream to any UI.
 *
 * MARKDOWN: streamed text is ALWAYS rendered as plain text (no parse_mode),
 * and so is the final in-place edit — exactly like the bot's existing
 * deliverReply path, which sends chunks with ctx.reply() and no parse_mode.
 * A half-written `**bold` can therefore never be rejected by Telegram for
 * malformed markup, and there is no formatting behaviour change between a
 * streamed and a non-streamed turn.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Env var that disables streaming. Default: streaming is ON. */
export const STREAMING_ENV_VAR = "BOBI_STREAMING";

/**
 * Whether streaming is enabled.
 *
 * `BOBI_STREAMING=0` (also "false", "no", "off", case-insensitive) turns it
 * off; anything else — including unset — leaves it on. Both the loop (which
 * decides whether to consume the token stream) and the bot (which decides
 * whether to install a renderer) consult this, so the kill switch is
 * effective even if only one side checks it.
 */
export function streamingEnabled(): boolean {
  const raw = process.env[STREAMING_ENV_VAR];
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * Events the agent loop emits while a streamed provider call is in flight.
 *
 * - `token`: a text delta arrived; render it.
 * - `toolcall`: the stream resolved into tool calls. The partial text (if
 *   any) must be discarded and the normal tool-progress display takes over;
 *   the agentic loop continues.
 * - `restart`: the stream died mid-flight and the loop is falling back to a
 *   fresh single-shot answer. Discard the partial text; the full answer will
 *   be delivered normally when it arrives.
 * - `error`: the stream died AND the single-shot fallback failed too. Stop
 *   rendering; the turn's error path takes over.
 */
export type AgentStreamEvent =
  | { type: "token"; delta: string }
  | { type: "toolcall" }
  | { type: "restart" }
  | { type: "error" };

/** Receives AgentStreamEvents for one turn. UI-only: must never throw. */
export type StreamEventSink = (ev: AgentStreamEvent) => void;

const sinkStorage = new AsyncLocalStorage<StreamEventSink>();

/**
 * Run `fn` with `sink` installed as the ambient stream sink. The loop picks
 * it up for every provider call made inside `fn`.
 */
export function runWithStreamSink<T>(sink: StreamEventSink, fn: () => Promise<T>): Promise<T> {
  return sinkStorage.run(sink, fn);
}

/** The ambient sink for the current async context, if one was installed. */
export function currentStreamSink(): StreamEventSink | undefined {
  return sinkStorage.getStore();
}

export interface StreamRendererOptions {
  /**
   * Minimum ms between Telegram edits. Telegram rate-limits edits; ~1/sec
   * is the safe cadence.
   */
  minIntervalMs?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /**
   * Cap on the live preview length. Telegram rejects messages past 4096
   * chars; the preview stays comfortably under it. The FINAL delivery is
   * chunked separately and is not bound by this.
   */
  maxPreviewChars?: number;
}

/**
 * Accumulates streamed tokens and edits a placeholder message at a throttled
 * cadence.
 *
 * The renderer owns no Telegram types: `edit` is any best-effort
 * replace-text function (it must never throw). The caller drives the clock
 * by calling flush() on an interval; flush() is a no-op when nothing new
 * arrived or the interval has not elapsed, so a 1/sec timer yields at most
 * 1 edit/sec. flushNow() forces one immediate edit (used for the first
 * token, so time-to-first-visible-token tracks the network, not the timer).
 *
 * Lifecycle per provider call: push()* → flush()… → suspend() when the call
 * resolves into tool calls (the partial text is dropped and the tool
 * progress display takes over; a later model call pushes fresh text into the
 * same message), or stop() when the turn settles.
 */
export class StreamRenderer {
  private text = "";
  private sentText: string | undefined;
  // Negative infinity so the very first flush is never throttled away,
  // whatever the clock starts at.
  private lastEditAt = Number.NEGATIVE_INFINITY;
  private suspended = false;
  private stopped = false;
  private everStarted = false;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly maxPreviewChars: number;

  constructor(
    private readonly edit: (text: string) => Promise<void>,
    opts: StreamRendererOptions = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.maxPreviewChars = opts.maxPreviewChars ?? 4000;
  }

  /** True once at least one token was pushed this turn. */
  get started(): boolean {
    return this.everStarted;
  }

  /** The full accumulated text (since the last suspend). */
  get currentText(): string {
    return this.text;
  }

  /** Append a text delta. Ignored after stop(). Unsuspends after suspend(). */
  push(delta: string): void {
    if (this.stopped || delta.length === 0) return;
    this.suspended = false;
    this.everStarted = true;
    this.text += delta;
  }

  /**
   * Edit the placeholder when due: skipped when stopped, suspended, when
   * nothing new arrived since the last edit, or when the interval has not
   * elapsed. Never throws — an edit failure just means the next flush
   * retries with newer text.
   */
  async flush(): Promise<void> {
    if (this.stopped || this.suspended) return;
    if (this.now() - this.lastEditAt < this.minIntervalMs) return;
    const preview = this.preview();
    if (preview === this.sentText) return;
    this.sentText = preview;
    this.lastEditAt = this.now();
    try {
      await this.edit(preview);
    } catch {
      // Best-effort: the next flush retries with whatever arrived meanwhile.
      // Reset the timestamp so a refused edit does not stall the stream for
      // a whole interval.
      this.lastEditAt = 0;
    }
  }

  /**
   * Edit immediately, bypassing the throttle. For the first token only —
   * afterwards the interval takes over.
   */
  async flushNow(): Promise<void> {
    if (this.stopped || this.suspended) return;
    const preview = this.preview();
    if (preview.length === 0 || preview === this.sentText) return;
    this.sentText = preview;
    this.lastEditAt = this.now();
    try {
      await this.edit(preview);
    } catch {
      this.lastEditAt = 0;
    }
  }

  /**
   * The provider call resolved into tool calls: drop the partial text and
   * pause rendering. A later model call's push() resumes into the same
   * message with fresh text.
   */
  suspend(): void {
    this.text = "";
    this.sentText = undefined;
    this.suspended = true;
  }

  /** Terminal: no further pushes or edits. */
  stop(): void {
    this.stopped = true;
  }

  private preview(): string {
    return this.text.length > this.maxPreviewChars
      ? this.text.slice(0, this.maxPreviewChars)
      : this.text;
  }
}
