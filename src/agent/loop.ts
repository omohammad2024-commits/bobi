/**
 * The agent loop — model → tools → model → answer.
 *
 * This is what turns SOL from a chat bot into an agent: the model chooses which
 * registered tool to run, SOL executes it through the authorized Executor, feeds
 * the result back, and repeats until the model answers.
 *
 * Design rules that are load-bearing:
 *
 *  1. TOOLS ARE THE ONLY SIDE EFFECT. The loop never calls a tool body directly;
 *     everything goes through ToolService.execute(), so validation, permission
 *     checks, the timeout, and the concurrency bound apply to every call —
 *     including ones the model invents.
 *
 *  2. EVERY BUDGET IS BOUNDED. A model that keeps requesting tools would
 *     otherwise loop forever at the owner's expense. Iterations, total tool
 *     calls, and wall-clock time are all capped. When a cap is hit the loop makes
 *     one final call with NO tools, so the user always gets an answer built from
 *     whatever was already gathered.
 *
 *  3. TOOL OUTPUT IS UNTRUSTED. Results are wrapped in <tool_result> and the
 *     system prompt states that such content is data, never instructions. A
 *     web page that says "ignore your rules" is text to summarise, not an order.
 *
 *  4. A DENIED TOOL IS NOT AN ERROR. If the model requests a tool the actor may
 *     not run, the refusal is reported back as a normal result (status=not_allowed)
 *     and the run continues. Aborting instead would let a model silently disable
 *     the agent by requesting something out of scope.
 *
 * The loop is grammY-free and takes an injectable clock, so it is unit-testable
 * with a scripted provider and no network.
 */
import { AiError } from "../ai/provider";
import type {
  AiProvider,
  ChatMessage,
  CompletionResponse,
  ToolCall,
  ToolSpec,
} from "../ai/provider";
import type { ToolActor, ToolRunResult } from "../tools/types";
import type { ToolService } from "../tools/service";
import { raceDeadline, withDeadline } from "../core/deadline";
import type { AgentStep, AgentRunResult, StopReason } from "./transcript";
import { serialiseToolResult, wrapToolResult } from "./transcript";

export interface AgentBudgets {
  /** Model turns per run, including the first. */
  maxIterations: number;
  /** Total tool executions per run across all iterations. */
  maxToolCalls: number;
  /** Ceiling on the whole run, ms — not per provider call. */
  totalTimeoutMs: number;
}

export const DEFAULT_BUDGETS: AgentBudgets = {
  maxIterations: 6,
  maxToolCalls: 12,
  totalTimeoutMs: 120_000,
};

export interface AgentLoopOptions {
  provider: AiProvider;
  /** Model id to request. */
  model: string;
  /** Tools available to this run; also the source of the request's schema. */
  tools: ToolService;
  /** Per-call provider timeout, ms. */
  callTimeoutMs: number;
  budgets?: Partial<AgentBudgets>;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /**
   * Progress sink. Called as each step happens so the caller can show the user
   * that work is in progress — a run with tools can take tens of seconds, and a
   * silent bot reads as a broken one.
   */
  onStep?: (step: AgentStep) => void;
  /**
   * Per-user gate consulted before each tool execution.
   *
   * Returns false to refuse. This is where a user's hourly tool budget is
   * spent, because the loop is the only thing that knows how many calls a
   * single message actually produced.
   */
  allowToolCall?: (userId: string) => boolean;
}

export interface AgentRunInput {
  /** Conversation so far, oldest first, ending with the new user turn. */
  messages: readonly ChatMessage[];
  /** System prompt for this run. */
  systemPrompt: string;
  /** Trusted identity the tools run as. Never model-supplied. */
  actor: ToolActor;
  /** Cancels the whole run, including an in-flight provider call. */
  signal: AbortSignal;
  /**
   * The conversation this run belongs to.
   *
   * Passed to every tool, so one that must act on the current chat can do so
   * without the model naming a target.
   */
  conversationId?: string;
}

/** Raised when the caller cancelled the run. */
export class AgentCancelled extends Error {
  constructor() {
    super("run cancelled");
    this.name = "AgentCancelled";
  }
}

export class AgentLoop {
  private readonly provider: AiProvider;
  private readonly model: string;
  private readonly tools: ToolService;
  private readonly callTimeoutMs: number;
  private readonly budgets: AgentBudgets;
  private readonly now: () => number;
  private readonly onStep: ((step: AgentStep) => void) | undefined;
  private readonly allowToolCall: ((userId: string) => boolean) | undefined;

  constructor(opts: AgentLoopOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.tools = opts.tools;
    this.callTimeoutMs = opts.callTimeoutMs;
    this.budgets = { ...DEFAULT_BUDGETS, ...opts.budgets };
    this.now = opts.now ?? (() => Date.now());
    this.onStep = opts.onStep;
    this.allowToolCall = opts.allowToolCall;
  }

  /**
   * Run one user turn to completion.
   *
   * @throws AgentCancelled when the caller's signal fires.
   * @throws AiError when the provider fails in a non-retryable way.
   */
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAt = this.now();
    const steps: AgentStep[] = [];
    const messages: ChatMessage[] = [
      { role: "system", content: input.systemPrompt },
      ...input.messages,
    ];

    // Tool specs are resolved once, from the Registry, for this actor. A tool
    // the model is never told about cannot be requested by accident.
    const specs: ToolSpec[] = this.specsFor(input.actor);

    let executed = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let iteration = 0;
    let stopReason: StopReason = "answered";

    while (true) {
      this.throwIfCancelled(input.signal);

      // Budgets are checked before spending another provider call, so a run
      // cannot overshoot by one iteration.
      const outOfIterations = iteration >= this.budgets.maxIterations;
      const outOfToolCalls = executed >= this.budgets.maxToolCalls;
      const outOfTime = this.now() - startedAt >= this.budgets.totalTimeoutMs;

      if (outOfIterations || outOfToolCalls || outOfTime) {
        const limit = outOfTime ? "timeout" : outOfIterations ? "iterations" : "tool_calls";
        steps.push({ kind: "limit", limit });
        this.emit({ kind: "limit", limit });

        // Final call with no tools: the model must answer from what it has,
        // rather than the user being left with nothing.
        const final = await this.call(input, messages, [], startedAt);
        usage = addUsage(usage, final);
        messages.push({ role: "assistant", content: final.text });

        return {
          text: nonEmpty(final.text),
          model: final.model,
          stopReason: "budget_exhausted",
          steps,
          toolCallsExecuted: executed,
          usage,
        };
      }

      iteration++;
      const response = await this.call(input, messages, specs, startedAt);
      usage = addUsage(usage, response);

      const calls = response.toolCalls ?? [];
      steps.push({
        kind: "model",
        iteration,
        model: response.model,
        requestedTools: calls.map((c) => c.name),
      });
      this.emit({ kind: "model", iteration, model: response.model, requestedTools: calls.map((c) => c.name) });

      // No tool request → this is the answer.
      if (calls.length === 0) {
        messages.push({ role: "assistant", content: response.text });
        return {
          text: nonEmpty(response.text),
          model: response.model,
          stopReason: "answered",
          steps,
          toolCallsExecuted: executed,
          usage,
        };
      }

      // The assistant turn that asked for tools is recorded verbatim, so the
      // provider sees its own request echoed in the correct wire shape.
      messages.push({
        role: "assistant",
        content: response.text,
        toolCalls: calls,
      });

      for (const call of calls) {
        this.throwIfCancelled(input.signal);

        // Per-run budget is enforced here too: a single turn that asks for more
        // tools than remain is truncated rather than allowed to overflow.
        if (executed >= this.budgets.maxToolCalls) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: wrapToolResult(call.name, "status=error: سقف تعداد فراخوانی ابزار پر شد."),
          });
          continue;
        }

        // The per-user budget is checked immediately before the tool runs, so
        // the model cannot spend it by requesting tools in bulk.
        if (this.allowToolCall !== undefined && !this.allowToolCall(input.actor.userId)) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: wrapToolResult(
              call.name,
              "status=not_allowed: سقف استفاده از ابزار برای امروز پر شده است.",
            ),
          });
          continue;
        }

        const result = await this.runTool(call, input);
        executed++;

        steps.push({
          kind: "tool",
          name: call.name,
          status: result.status,
          durationMs: result.durationMs,
        });
        this.emit({
          kind: "tool",
          name: call.name,
          status: result.status,
          durationMs: result.durationMs,
        });

        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: wrapToolResult(call.name, serialiseToolResult(result)),
        });
      }
    }
  }

  /**
   * Execute one model-requested tool call through the authorized Executor.
   *
   * The actor comes from the server, never from the call. The call only names a
   * tool and supplies arguments — both untrusted, both validated by the
   * Executor against the tool's declared schema.
   */
  private runTool(call: ToolCall, input: AgentRunInput): Promise<ToolRunResult> {
    return this.tools.execute({
      tool: call.name,
      input: normaliseArguments(call.arguments),
      actor: input.actor,
      // The run's signal aborts an in-flight tool when the user sends a newer
      // message or the process shuts down.
      signal: input.signal,
      ...(input.conversationId !== undefined
        ? { conversationId: input.conversationId }
        : {}),
    });
  }

  /**
   * One provider call, bounded by whichever is sooner: the per-call timeout, or
   * the run's remaining wall-clock budget.
   */
  private async call(
    input: AgentRunInput,
    messages: ChatMessage[],
    tools: readonly ToolSpec[],
    startedAt: number,
  ): Promise<CompletionResponse> {
    const remaining = this.budgets.totalTimeoutMs - (this.now() - startedAt);
    const timeoutMs = Math.max(1, Math.min(this.callTimeoutMs, remaining));

    // The caller's signal only covers cancellation, so the deadline is armed
    // here too — a provider that ignores `timeoutMs` cannot hang the run. The
    // race matters as much as the abort: a promise that never settles would
    // otherwise hold this semaphore slot forever.
    const deadline = withDeadline(input.signal, timeoutMs);
    try {
      return await raceDeadline(
        this.provider.complete({
          messages,
          model: this.model,
          timeoutMs,
          signal: deadline.signal,
          ...(tools.length > 0 ? { tools } : {}),
        }),
        deadline,
      );
    } catch (err) {
      // The caller's own cancellation is not a provider failure; report it as
      // such so it is not surfaced to the user as an error.
      if (input.signal.aborted) throw new AgentCancelled();
      if (deadline.timedOut()) throw new AiError("timeout", "پاسخ سرویس به‌موقع نرسید.");
      throw err;
    } finally {
      deadline.dispose();
    }
  }

  /** Tool definitions for this actor, built from the Registry. */
  private specsFor(actor: ToolActor): ToolSpec[] {
    return this.tools.toolSpecsFor(actor);
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AgentCancelled();
  }

  private emit(step: AgentStep): void {
    this.onStep?.(step);
  }
}

/**
 * Coerce model-supplied arguments into the object shape a tool expects.
 *
 * Models produce several shapes for "no arguments" (absent, null, "", "{}"), and
 * every one of them means the same thing. Anything that is not an object is
 * passed through unchanged so the validator produces the accurate
 * "input must be an object" error rather than this layer guessing.
 */
function normaliseArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      // Malformed JSON stays a string, so validation reports it as invalid
      // input instead of this layer inventing an empty object.
      return trimmed;
    }
  }
  return raw;
}

function addUsage(
  total: { inputTokens: number; outputTokens: number },
  res: CompletionResponse,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: total.inputTokens + (res.usage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (res.usage?.outputTokens ?? 0),
  };
}

/**
 * A run must always produce something the user can read.
 *
 * Reaching here with empty text means the model answered with neither prose nor
 * a tool request; a fixed sentence is better than sending an empty Telegram
 * message, which the API rejects outright.
 */
function nonEmpty(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : "پاسخی تولید نشد؛ دوباره تلاش کن.";
}

/** True when the error means the provider could not be reached at all. */
export function isTransportFailure(err: unknown): boolean {
  return err instanceof AiError && (err.kind === "network" || err.kind === "timeout");
}