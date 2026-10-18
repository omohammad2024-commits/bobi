import type { AiProvider, ChatMessage, ContentPart } from "../ai/provider";
import { AiError } from "../ai/provider";
import type { Storage } from "../storage/storage";
import { AgentCancelled, AgentLoop } from "../agent/loop";
import type { AgentBudgets, AgentRunInput } from "../agent/loop";
import { raceDeadline, withDeadline } from "../core/deadline";
import type { AgentRunResult, AgentStep } from "../agent/transcript";
import { buildSystemPrompt } from "../agent/prompt";
import { MIN_COMPACT_MESSAGES, summariseHistory, summaryMessage } from "./summary";
import type { ToolService } from "../tools/service";
import type { ToolActor } from "../tools/types";

/** What the agent loop and the plain path both produce. */
interface RunOutcome {
  text: string;
  model: string;
  steps: readonly AgentStep[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: number;
}

/** Telegram's hard limit for a single message. */
export const TELEGRAM_MAX_LENGTH = 4096;


export interface ConversationInput {
  /** Stable id of the conversation owner (chat or user). */
  conversationId: string;
  /** Owner id used for per-user isolation (required when storage is on). */
  userId?: string;
  /** Raw text the user sent. */
  userText: string;
  /** Optional per-request timeout override. */
  timeoutMs?: number;
  /**
   * Trusted identity the tools run as, resolved by the bot from `from.id`.
   *
   * Absent means "no tool access at all" — the run still answers from the
   * model, because the tool decision belongs to the caller's permission list,
   * not to whether the turn is allowed to happen.
   */
  actor?: ToolActor;
  /**
   * Progress sink for this specific request.
   *
   * Bound per call rather than at construction, because the sink belongs to the
   * chat that made the request and one engine serves every conversation.
   */
  onProgress?: (step: AgentStep) => void;
  /**
   * Attachments to send alongside the text.
   *
   * Absent means a text-only turn. Parts travel to the provider but are NOT
   * persisted in history: storing base64 in the messages table would bloat it
   * without bound, and a model does not need yesterday's photo replayed on
   * every later turn.
   */
  parts?: readonly ContentPart[];
}

export interface ConversationOutput {
  /** Assistant reply, split into Telegram-safe chunks. */
  chunks: string[];
  /** Model that produced it. */
  model: string;
  /** Whether the active provider is the offline fake. */
  isFake: boolean;
  /** Ordered record of the run, for logging and progress display. */
  steps: readonly AgentStep[];
  /** Whether a budget stopped the run short of a clean answer. */
  truncated: boolean;
  /** Token totals across every provider call in this run. */
  usage: { inputTokens: number; outputTokens: number };
  /** Tool executions that actually ran. */
  toolCalls: number;
}

export interface EngineOptions {
  provider: AiProvider;
  model: string;
  /** Default request timeout, ms. */
  timeoutMs: number;
  /** Max in-flight requests allowed at once. */
  maxConcurrent: number;
  /** Optional persistent store; when absent history stays in memory. */
  storage?: Storage;
  /** Max messages sent to the model (memory window). */
  historyLimit?: number;
  /**
   * Tools the agent may run. When absent the engine is a plain chat bot and
   * every run answers from the model alone.
   */
  tools?: ToolService;
  /** Agent budgets (iterations, tool calls, wall clock). */
  budgets?: Partial<AgentBudgets>;
  /** Timezone used when telling the model what "now" is. */
  timezone?: string;
  /** Owner-supplied extra system instructions. */
  extraPrompt?: string;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
  /** Progress sink, forwarded from the agent loop. */
  onStep?: (conversationId: string, step: AgentStep) => void;
  /**
   * How many memories the user has stored.
   *
   * A function rather than a number so it is read per turn — a memory the model
   * stores during a run is reflected on the next one. Omitted when memory is
   * unavailable, in which case the prompt says nothing about it.
   */
  memoryCount?: (userId: string) => number;
  /**
   * Whether to fold overflowed history into a rolling summary. Default true.
   * Disabled in tests that assert the raw window.
   */
  summariseHistory?: boolean;
  /**
   * Per-user gate consulted before each tool execution.
   *
   * Returns false to refuse this call. The engine has no opinion on why; the
   * caller decides what the budget is.
   */
  allowToolCall?: (userId: string) => boolean;
}

/** Errors the engine surfaces to the caller (already user-safe categories). */
export class EngineError extends Error {
  constructor(
    readonly kind:
      | AiError["kind"]
      | "empty_input"
      | "empty_response"
      | "overloaded"
      /** A newer message replaced this run; the caller should stay silent. */
      | "superseded",
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * Conversation engine — grammY-agnostic and unit-testable.
 *
 * One `respond()` is now a whole agent run: the model may request tools, BOBI
 * runs them through the authorized Executor, and the loop repeats until the
 * model answers or a budget is reached. History is kept in memory by default;
 * pass `storage` for persistence.
 */
export class ConversationEngine {
  private readonly provider: AiProvider;
  private readonly model: string;
  private readonly defaultTimeoutMs: number;
  private readonly semaphore: Semaphore;
  private readonly storage: Storage | undefined;
  private readonly historyLimit: number;
  private readonly tools: ToolService | undefined;
  private readonly budgets: Partial<AgentBudgets> | undefined;
  private readonly timezone: string;
  private readonly extraPrompt: string | undefined;
  private readonly now: () => Date;
  private readonly onStep: ((conversationId: string, step: AgentStep) => void) | undefined;
  private readonly memoryCount: ((userId: string) => number) | undefined;
  private readonly allowToolCall: ((userId: string) => boolean) | undefined;

  // in-memory fallback (conversationId -> turns)
  private readonly histories = new Map<string, ChatMessage[]>();
  // conversationId -> chain tail; serializes requests per conversation
  private readonly chains = new Map<string, Promise<unknown>>();
  // conversationId -> live run, so a newer message can cancel a superseded one
  private readonly running = new Map<string, AbortController>();
  private readonly summarisationEnabled: boolean;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.defaultTimeoutMs = opts.timeoutMs;
    this.semaphore = new Semaphore(opts.maxConcurrent);
    this.storage = opts.storage;
    this.historyLimit = opts.historyLimit ?? 50;
    this.tools = opts.tools;
    this.budgets = opts.budgets;
    this.timezone = opts.timezone ?? "Asia/Tehran";
    this.extraPrompt = opts.extraPrompt;
    this.now = opts.now ?? (() => new Date());
    this.onStep = opts.onStep;
    this.memoryCount = opts.memoryCount;
    this.summarisationEnabled = opts.summariseHistory !== false;
    this.allowToolCall = opts.allowToolCall;
  }

  /** Handle one user message end-to-end. Never throws raw provider errors. */
  async respond(input: ConversationInput): Promise<ConversationOutput> {
    const userText = input.userText.trim();
    const hasParts = input.parts !== undefined && input.parts.length > 0;

    // A caption-less photo is a complete turn, so emptiness is judged on the
    // message as a whole rather than on its text alone.
    if (userText.length === 0 && !hasParts) {
      throw new EngineError("empty_input", "پیام خالی است.");
    }

    // A newer message supersedes an in-flight run in the same conversation: the
    // old run is cancelled rather than queued, so a user who rephrases does not
    // wait for a slow tool to finish first. Without this, an agent run with
    // several tools would hold the conversation for tens of seconds.
    this.cancel(input.conversationId);

    const controller = new AbortController();
    this.running.set(input.conversationId, controller);

    // Serialize per conversation so history never interleaves.
    //
    // The map holds a settled-safe tail, and cleanup compares against THAT
    // value. An earlier version stored `run.catch(...)` but compared to `run`,
    // so the comparison never matched and every conversation leaked a chain
    // entry holding a closure over the request context.
    const tail = this.chains.get(input.conversationId) ?? Promise.resolve();
    const run = tail.then(() => this.runOnce(input, userText, controller.signal));
    const settled = run.catch(() => undefined);
    this.chains.set(input.conversationId, settled);

    try {
      return await run;
    } finally {
      if (this.chains.get(input.conversationId) === settled) {
        this.chains.delete(input.conversationId);
      }
      if (this.running.get(input.conversationId) === controller) {
        this.running.delete(input.conversationId);
      }
    }
  }

  /**
   * Cancel the in-flight run for a conversation, if any.
   *
   * Called automatically when a newer message arrives, and on shutdown.
   */
  cancel(conversationId: string): void {
    this.running.get(conversationId)?.abort();
  }

  /** Cancel every in-flight run — used during graceful shutdown. */
  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  private async runOnce(
    input: ConversationInput,
    userText: string,
    signal: AbortSignal,
  ): Promise<ConversationOutput> {
    return this.semaphore.use(async () => {
      const history = await this.compactedHistory(input, signal);

      // Attachments ride on the live turn only. They are deliberately excluded
      // from `commitTurn`, so history stays text and cannot grow without bound.
      const turn: ChatMessage = {
        role: "user",
        content: userText,
        ...(input.parts !== undefined && input.parts.length > 0
          ? { parts: input.parts }
          : {}),
      };
      const messages: ChatMessage[] = [...history, turn];

      const result = await this.runAgent(input, messages, userText, signal);

      // Commit only after a successful reply — never store a failed turn.
      this.commitTurn(input, userText, result.text);

      return {
        chunks: splitForTelegram(result.text),
        model: result.model,
        isFake: this.provider.name === "fake",
        steps: result.steps,
        truncated: result.stopReason === "budget_exhausted",
        usage: result.usage,
        toolCalls: result.toolCalls,
      };
    });
  }

  /**
   * Run the agent loop, or fall back to a single provider call when no tool
   * service is configured.
   */
  private async runAgent(
    input: ConversationInput,
    messages: ChatMessage[],
    userText: string,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    if (!this.tools) {
      return this.plainCall(input, messages, signal);
    }

    const actor = input.actor ?? { userId: "unknown", permissions: [] };

    const loop = new AgentLoop({
      provider: this.provider,
      model: this.model,
      tools: this.tools,
      callTimeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      ...(this.budgets !== undefined ? { budgets: this.budgets } : {}),
      now: () => this.now().getTime(),
      ...(this.onStep !== undefined || input.onProgress !== undefined
        ? {
            onStep: (step: AgentStep) => {
              this.onStep?.(input.conversationId, step);
              input.onProgress?.(step);
            },
          }
        : {}),
      ...(this.allowToolCall !== undefined
        ? { allowToolCall: this.allowToolCall }
        : {}),
    });

    // The tool list and the memory count are both per-actor, so the prompt
    // describes exactly what THIS run may do — the same set the loop passes as
    // `tools`, so the prompt can never advertise something unavailable.
    const specs = this.tools.toolSpecsFor(actor).map((s) => ({
      name: s.name,
      description: s.description,
      enabled: true,
      requires: [] as readonly string[],
    }));

    const memoryCount =
      this.memoryCount !== undefined && actor.userId !== "unknown"
        ? this.memoryCount(actor.userId)
        : undefined;

    const runInput: AgentRunInput = {
      messages,
      systemPrompt: buildSystemPrompt({
        tools: specs,
        now: this.now(),
        timezone: this.timezone,
        ...(memoryCount !== undefined ? { memoryCount } : {}),
        ...(this.extraPrompt !== undefined ? { extra: this.extraPrompt } : {}),
      }),
      actor,
      signal,
      // Tools that must act on the current chat get it from server context,
      // never from the model's arguments.
      conversationId: input.conversationId,
    };

    try {
      const result: AgentRunResult = await loop.run(runInput);
      return {
        text: result.text,
        model: result.model,
        steps: result.steps,
        stopReason: result.stopReason,
        usage: result.usage,
        toolCalls: result.toolCallsExecuted,
      };
    } catch (err) {
      if (err instanceof AgentCancelled) {
        throw new EngineError("superseded", "درخواست با پیام تازه‌تری جایگزین شد.");
      }
      throw toEngineError(err, signal.aborted);
    }
  }

  /** The no-tools path: one provider call, exactly as before. */
  private async plainCall(
    input: ConversationInput,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    const timeout = input.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = withDeadline(signal, timeout);
    let res;
    try {
      // Raced as well as signalled: a provider that never settles must not be
      // able to hold a semaphore slot for the lifetime of the process.
      res = await raceDeadline(
        this.provider.complete({
          messages,
          model: this.model,
          timeoutMs: timeout,
          signal: deadline.signal,
        }),
        deadline,
      );
    } catch (err) {
      // Distinguish the caller replacing this turn from a real deadline: a
      // superseded run must stay silent, while a genuine timeout is reported.
      if (signal.aborted) {
        throw new EngineError("superseded", "درخواست با پیام تازه‌تری جایگزین شد.");
      }
      throw toEngineError(err, deadline.signal.aborted);
    } finally {
      deadline.dispose();
    }

    const text = res.text.trim();
    if (text.length === 0) {
      throw new EngineError("empty_response", "پاسخ مدل خالی بود.");
    }
    return {
      text,
      model: res.model,
      steps: [],
      stopReason: "answered",
      // Reported by the provider when it supplies counts; zero otherwise,
      // rather than a guess.
      usage: {
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
      },
      toolCalls: 0,
    };
  }

  // ---- history backend ----

  private ownerOf(input: ConversationInput): { userId: string; chatId: string } {
    return { userId: input.userId ?? input.conversationId, chatId: input.conversationId };
  }

  private loadHistory(input: ConversationInput): ChatMessage[] {
    if (!this.storage) {
      return this.histories.get(input.conversationId) ?? [];
    }
    const { userId, chatId } = this.ownerOf(input);
    const rows = this.storage.history(userId, chatId, this.historyLimit);
    return rows.map((r) => ({ role: r.role, content: r.content }));
  }

  /**
   * History for this turn: a rolling summary plus the recent window.
   *
   * Compaction is INCREMENTAL and persisted. An earlier version re-summarised
   * the entire prior conversation on every single message once the window
   * filled, which meant a second model call per turn forever. That is a real
   * cost bug, not just wasted work: a chatty conversation would pay double.
   *
   * Now each pass reads only the messages that have overflowed since the last
   * one — tracked by a stored message-id watermark — so every message is folded
   * into the summary exactly once. The summary is stored rather than held in
   * memory, because losing it on restart would permanently drop the old turns
   * it covers.
   *
   * Compaction stays best-effort: if the summariser fails, the turn proceeds
   * with the recent window and whatever summary already exists.
   */
  private async compactedHistory(
    input: ConversationInput,
    signal: AbortSignal,
  ): Promise<ChatMessage[]> {
    const recent = this.loadHistory(input);

    // No storage means no watermark to track; the in-memory window is all
    // there is, which matches the old behaviour for the no-storage engine.
    if (!this.storage || !this.summarisationEnabled) return recent;

    const { userId, chatId } = this.ownerOf(input);
    const stored = this.storage.getConversationSummary(userId, chatId);

    // Only messages that have fallen out of the window are candidates, and only
    // those past the watermark.
    let overflow;
    try {
      overflow = this.storage.unsummarisedMessages(
        userId,
        chatId,
        stored?.summarisedUntil ?? 0,
        this.historyLimit,
      );
    } catch {
      // A failed read is not a reason to fail the turn.
      return stored !== undefined ? [summaryMessage(stored.summary), ...recent] : recent;
    }

    if (overflow.length < MIN_COMPACT_MESSAGES) {
      // Nothing new has overflowed; reuse the existing summary. This is the
      // case that used to trigger an unnecessary model call every turn.
      return stored !== undefined ? [summaryMessage(stored.summary), ...recent] : recent;
    }

    const messages: ChatMessage[] = overflow.map((r) => ({ role: r.role, content: r.content }));
    const summary = await summariseHistory(messages, stored?.summary, {
      provider: this.provider,
      model: this.model,
      signal,
    });

    if (summary === undefined) {
      // Keep what we had; a failed refresh must not discard it.
      return stored !== undefined ? [summaryMessage(stored.summary), ...recent] : recent;
    }

    // Advance the watermark only on success, so a failed pass is retried on the
    // next turn instead of silently skipping those messages.
    const lastId = overflow[overflow.length - 1]!.id;
    try {
      this.storage.setConversationSummary({
        userId,
        chatId,
        summary,
        summarisedUntil: lastId,
      });
    } catch {
      // The summary is still usable this turn even if it could not be stored.
    }

    return [summaryMessage(summary), ...recent];
  }

  /**
   * Persist a successful turn.
   *
   * Attachments are NOT stored: base64 in the messages table would grow it
   * without bound, and a later turn does not need an earlier photo replayed.
   * A caption-less attachment is recorded as a short marker so the transcript
   * still shows that a turn happened.
   */
  private commitTurn(input: ConversationInput, userText: string, reply: string): void {
    const stored = userText.length > 0 ? userText : this.describeAttachmentsOnly(input);

    if (!this.storage) {
      const h = this.histories.get(input.conversationId) ?? [];
      h.push({ role: "user", content: stored }, { role: "assistant", content: reply });
      this.histories.set(input.conversationId, h);
      return;
    }
    const { userId, chatId } = this.ownerOf(input);
    this.storage.appendMessage(userId, chatId, "user", stored);
    this.storage.appendMessage(userId, chatId, "assistant", reply);
  }

  /** Transcript marker for a turn that was attachments only. */
  private describeAttachmentsOnly(input: ConversationInput): string {
    const count = input.parts?.length ?? 0;
    return count > 0 ? `[${count} پیوست]` : "[پیام بدون متن]";
  }

  /** Read history — memory or storage depending on configuration. */
  getHistory(input: ConversationInput | string): readonly ChatMessage[] {
    if (typeof input === "string") {
      return this.histories.get(input) ?? [];
    }
    return this.loadHistory(input);
  }

  clearHistory(input: ConversationInput | string): void {
    if (typeof input === "string") {
      this.histories.delete(input);
      return;
    }
    if (this.storage) {
      const { userId, chatId } = this.ownerOf(input);
      this.storage.deleteConversation(userId, chatId);
      // The rolling summary is a separate row with no foreign key, so it must
      // be dropped explicitly. Leaving it would re-inject a summary of the
      // cleared conversation into the next one — a privacy surprise, and a
      // context contamination the user explicitly asked to be rid of.
      try {
        this.storage.clearConversationSummary(userId, chatId);
      } catch {
        // Best-effort: the messages are gone either way.
      }
    }
    this.histories.delete(input.conversationId);
  }
}

/** Split text into ≤4096-char chunks on word/line boundaries. */
export function splitForTelegram(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (cut < TELEGRAM_MAX_LENGTH / 2) cut = rest.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    if (cut < TELEGRAM_MAX_LENGTH / 2) cut = TELEGRAM_MAX_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Convert any thrown error into an EngineError with a safe kind. */
function toEngineError(err: unknown, aborted: boolean): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof AiError) return new EngineError(err.kind, err.message);
  if (aborted) return new EngineError("timeout", "درخواست لغو شد یا به timeout رسید.");
  return new EngineError("unknown", "خطای ناشناخته در پردازش درخواست.");
}

/**
 * Counting semaphore to bound concurrent provider calls.
 *
 * The slot is handed OVER, not re-fetched: a waiter is resolved only when a
 * permit is already free, and the permit transfers to it without incrementing
 * again. An earlier version had the waiter increment on wake, which let a
 * caller arriving between a release and the wakee's continuation also take the
 * slot — briefly exceeding `maxConcurrent`.
 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {
    if (max < 1) throw new Error("maxConcurrent must be >= 1");
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // Wait for a permit to be handed over. The caller that releases it has
      // already accounted for this waiter, so no increment happens here.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }

    try {
      return await fn();
    } finally {
      // Hand the permit to the next waiter, or give it back to the pool. The
      // count is not decremented first, so there is no window in which a new
      // caller can see a free slot that is already promised to a waiter.
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
