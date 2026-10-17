import type { AiProvider, ChatMessage } from "../ai/provider";
import { AiError } from "../ai/provider";
import type { Storage } from "../storage/storage";
import { AgentCancelled, AgentLoop } from "../agent/loop";
import type { AgentBudgets, AgentRunInput } from "../agent/loop";
import { raceDeadline, withDeadline } from "../core/deadline";
import type { AgentRunResult, AgentStep } from "../agent/transcript";
import { buildSystemPrompt } from "../agent/prompt";
import { splitHistory, summariseHistory, summaryMessage } from "./summary";
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

/**
 * How far back a compaction reads.
 *
 * Larger than the window on purpose: the overflow is the part worth
 * summarising, so the read has to reach past the window to see it.
 */
const COMPACT_LOOKBACK = 500;

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
 * One `respond()` is now a whole agent run: the model may request tools, SOL
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
  // conversationId -> rolling summary of turns that left the window
  private readonly summaries = new Map<string, string>();
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
    if (userText.length === 0) {
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
    const tail = this.chains.get(input.conversationId) ?? Promise.resolve();
    const run = tail.then(() => this.runOnce(input, userText, controller.signal));
    this.chains.set(
      input.conversationId,
      run.catch(() => undefined),
    );
    try {
      return await run;
    } finally {
      if (this.chains.get(input.conversationId) === run) {
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
      const messages: ChatMessage[] = [...history, { role: "user", content: userText }];

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
   * History for this turn, compacted when it has outgrown the window.
   *
   * Rather than letting the oldest turns fall off the end silently, the excess
   * is folded into a running summary. Compaction is best-effort: if the
   * summariser fails the turn still proceeds with the plain window, because a
   * housekeeping problem must never fail a user's request.
   */
  private async compactedHistory(
    input: ConversationInput,
    signal: AbortSignal,
  ): Promise<ChatMessage[]> {
    const full = this.loadFullHistory(input);
    const { older, recent } = splitHistory(full, this.historyLimit);
    if (older.length === 0) {
      const previous = this.summaries.get(input.conversationId);
      return previous !== undefined ? [summaryMessage(previous), ...recent] : recent;
    }

    if (!this.summarisationEnabled) {
      return recent;
    }

    const previous = this.summaries.get(input.conversationId);
    const summary = await summariseHistory(older, previous, {
      provider: this.provider,
      model: this.model,
      signal,
    });

    if (summary === undefined) {
      // Keep any summary we already had; a failed refresh is not a reason to
      // lose what was already compacted.
      return previous !== undefined ? [summaryMessage(previous), ...recent] : recent;
    }

    this.summaries.set(input.conversationId, summary);
    return [summaryMessage(summary), ...recent];
  }

  /** The whole stored history, ignoring the window, for compaction to split. */
  private loadFullHistory(input: ConversationInput): ChatMessage[] {
    if (!this.storage) {
      return this.histories.get(input.conversationId) ?? [];
    }
    const { userId, chatId } = this.ownerOf(input);
    const rows = this.storage.history(userId, chatId, COMPACT_LOOKBACK);
    return rows.map((r) => ({ role: r.role, content: r.content }));
  }

  private commitTurn(input: ConversationInput, userText: string, reply: string): void {
    if (!this.storage) {
      const h = this.histories.get(input.conversationId) ?? [];
      h.push({ role: "user", content: userText }, { role: "assistant", content: reply });
      this.histories.set(input.conversationId, h);
      return;
    }
    const { userId, chatId } = this.ownerOf(input);
    this.storage.appendMessage(userId, chatId, "user", userText);
    this.storage.appendMessage(userId, chatId, "assistant", reply);
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

/** Counting semaphore to bound concurrent provider calls. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {
    if (max < 1) throw new Error("maxConcurrent must be >= 1");
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
