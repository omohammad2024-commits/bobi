/**
 * The agent loop — model → tools → model → answer.
 *
 * This is what turns BOBI from a chat bot into an agent: the model chooses which
 * registered tool to run, BOBI executes it through the authorized Executor, feeds
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
  CompletionRequest,
  CompletionResponse,
  ContentPart,
  StreamEvent,
  TokenUsage,
  ToolCall,
  ToolSpec,
} from "../ai/provider";
import type { ToolActor, ToolRunResult, ToolServicePort } from "../tools/types";
import { raceDeadline, withDeadline } from "../core/deadline";
import type { Deadline } from "../core/deadline";
import { t } from "../i18n";
import type { AgentStep, AgentRunResult, StopReason } from "./transcript";
import { describeMediaForModel, serialiseToolResult, wrapToolResult } from "./transcript";
import { currentStreamSink, streamingEnabled } from "./stream";
import type { AgentStreamEvent, StreamEventSink } from "./stream";
import { maxParallel, parallelEnabled, planningEnabled, selfReviewEnabled } from "./settings";
import { isWriteLikeTool, mapBounded } from "./parallelism";
import { parsePlan, planMessages, planNote, shouldPlan, PLAN_MAX_TOKENS } from "./planner";

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

/**
 * Allowance for the final, tool-free answer when the wall clock has run out.
 *
 * Without this the "always answer" branch would hand the provider a 1ms
 * deadline and fail instead of replying.
 */
const FINAL_ANSWER_GRACE_MS = 20_000;

export interface AgentLoopOptions {
  provider: AiProvider;
  /** Model id to request. */
  model: string;
  /** Tools available to this run; also the source of the request's schema. */
  tools: ToolServicePort;
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
  /**
   * Pre-routed tool specs for this turn (intent-router wiring).
   *
   * When set, the loop offers EXACTLY these specs instead of asking the
   * ToolService itself. The caller derives them from
   * ToolService.toolSpecsFor(actor) and narrows/orders them by intent —
   * permissions are therefore already applied upstream, and the Executor
   * still enforces them per call. Absent = legacy behavior (the loop
   * resolves specs from the actor, unchanged).
   */
  toolSpecs?: readonly ToolSpec[];
}

/**
 * Per-run frame: the fixed context a run is judged against.
 *
 * `goal` is the newest user turn verbatim and `planSteps` the accepted plan
 * (when planning made one). Executed tool outcomes are NOT duplicated here —
 * they are derivable from the run's `steps` at the moment they are needed.
 * The frame lives for one run() call and feeds the self-review pass.
 */
interface RunFrame {
  goal: string;
  planSteps: readonly string[] | undefined;
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
  private readonly tools: ToolServicePort;
  private readonly callTimeoutMs: number;
  private readonly budgets: AgentBudgets;
  private readonly now: () => number;
  private readonly onStep: ((step: AgentStep) => void) | undefined;
  private readonly allowToolCall: ((userId: string) => boolean) | undefined;
  /** Parallel tool execution within a turn (BOBI_AGENT_PARALLEL=0 disables). */
  private readonly parallel: boolean;
  /** Concurrency bound for parallel execution (BOBI_AGENT_MAX_PARALLEL). */
  private readonly maxPar: number;
  /** Planning mode (BOBI_AGENT_PLANNING=0 disables). */
  private readonly planning: boolean;
  /** Self-review pass after tool turns (BOBI_AGENT_SELF_REVIEW=0 disables). */
  private readonly selfReview: boolean;

  constructor(opts: AgentLoopOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.tools = opts.tools;
    this.callTimeoutMs = opts.callTimeoutMs;
    // Caller budgets win as-is. BOBI_AGENT_MAX_ITERATIONS /
    // BOBI_AGENT_MAX_TOOL_CALLS are already honoured upstream: config.ts
    // reads them via envVar() and index.ts passes them in as these budgets.
    // Re-applying the environment HERE would clobber deliberate per-caller
    // budgets (delegate 3/5, heartbeat) whenever the process env sets them.
    this.budgets = { ...DEFAULT_BUDGETS, ...opts.budgets };
    this.now = opts.now ?? (() => Date.now());
    this.onStep = opts.onStep;
    this.allowToolCall = opts.allowToolCall;
    this.parallel = parallelEnabled();
    this.maxPar = maxParallel();
    this.planning = planningEnabled();
    this.selfReview = selfReviewEnabled();
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

    // Tool specs are resolved once for this actor. A tool the model is
    // never told about cannot be requested by accident. Caller-routed
    // specs (intent router) win when supplied; otherwise the Registry
    // path, exactly as before.
    const specs: ToolSpec[] =
      input.toolSpecs !== undefined ? [...input.toolSpecs] : this.specsFor(input.actor);
    const specByName = new Map(specs.map((s) => [s.name, s]));

    let executed = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let iteration = 0;
    let stopReason: StopReason = "answered";
    // User-facing media from tools, in call order. Kept out of `messages` and
    // the transcript: it is delivered, not reasoned over.
    const media: ContentPart[] = [];

    // Planning mode: a multi-task request gets one cheap planner call before
    // the first iteration, and the plan rides along as a system note. The
    // planning call is advisory — its failure is never surfaced.
    const plan = await this.maybePlan(input, startedAt);
    const planSteps = plan?.steps;
    if (planSteps !== undefined && plan !== undefined) {
      usage = addUsage(usage, {
        text: "",
        model: this.model,
        usage: { inputTokens: plan.usage.inputTokens, outputTokens: plan.usage.outputTokens },
      });
      steps.push({ kind: "plan", steps: planSteps, completed: false });
      this.emit({ kind: "plan", steps: planSteps, completed: false });
      messages[0] = {
        role: "system",
        content: `${typeof messages[0]?.content === "string" ? messages[0]?.content : ""}\n\n${planNote(planSteps)}`,
      };
    }

    // Per-run frame: what this run is for. Carried through the run and used
    // by the self-review pass; `plan` is also surfaced on the run result.
    const frame: RunFrame = { goal: lastUserText(input.messages), planSteps };
    // Self-review runs at most once per run — the answer after a review
    // (or after tools a review requested) is final.
    let reviewed = false;

    // Per-run loop awareness: identical tool calls (same name + arguments)
    // are remembered so a stuck model is short-circuited, not billed.
    const seen = new Map<string, CallRecord>();

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
        //
        // When the WALL CLOCK is what ran out, this call gets its own small
        // allowance rather than the remaining budget — which is zero, and would
        // produce a 1ms deadline that aborts before the provider can answer.
        // The user asked a question; failing with a timeout instead of a
        // best-effort reply is the one outcome this branch exists to avoid.
        const graceMs = outOfTime ? FINAL_ANSWER_GRACE_MS : 0;

        try {
          const final = await this.call(input, messages, [], startedAt, graceMs);
          usage = addUsage(usage, final);
          messages.push({ role: "assistant", content: final.text });

          return {
            text: nonEmpty(final.text),
            model: final.model,
            stopReason: "budget_exhausted",
            steps,
            toolCallsExecuted: executed,
            media,
            usage,
            ...(frame.planSteps !== undefined ? { plan: frame.planSteps } : {}),
          };
        } catch (err) {
          // The grace call failed too. Return what was gathered rather than
          // surfacing a provider error for a run that did real work.
          if (outOfTime && !input.signal.aborted) {
            return {
              text: t("agent.time_exhausted"),
              model: this.model,
              stopReason: "budget_exhausted",
              steps,
              toolCallsExecuted: executed,
              media,
              usage,
              ...(frame.planSteps !== undefined ? { plan: frame.planSteps } : {}),
            };
          }
          throw err;
        }
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

      // No tool request → this is the answer — unless self-review applies.
      if (calls.length === 0) {
        const draft = response.text;

        // SELF-REVIEW: one extra pass over a tool-backed draft before it is
        // returned. Gated hard so simple turns pay nothing: review needs the
        // kill switch on, at least one executed tool this run, no earlier
        // review this run, and iteration budget left for a possible fix-up
        // turn. Plain chat (zero tools), the budget-exhausted grace call and
        // loop-detected breaks never reach this branch, so they are never
        // reviewed.
        if (
          this.selfReview &&
          !reviewed &&
          executed > 0 &&
          iteration < this.budgets.maxIterations
        ) {
          try {
            const reviewMessages: ChatMessage[] = [
              ...messages,
              { role: "assistant", content: draft },
              { role: "user", content: reviewPrompt(frame, steps, draft) },
            ];
            const reviewStartedAt = this.now();
            // Via singleCall (never the streaming path) with the run's specs,
            // so the review CAN emit tool calls to fix a missing step without
            // review tokens leaking into the user's rendered message.
            const reviewResponse = await this.singleCall(input, reviewMessages, specs, startedAt, 0);
            const durationMs = Math.max(0, this.now() - reviewStartedAt);
            usage = addUsage(usage, reviewResponse);
            const reviewCalls = reviewResponse.toolCalls ?? [];

            if (reviewCalls.length > 0) {
              // A step is missing or wrong: run the requested tools through
              // the exact main-flow machinery, then let the loop produce the
              // final answer. That answer is NOT reviewed again.
              const reviewStep: AgentStep = { kind: "review", durationMs, outcome: "tools" };
              steps.push(reviewStep);
              this.emit(reviewStep);
              reviewed = true;
              messages.push({
                role: "assistant",
                content: reviewResponse.text,
                toolCalls: reviewCalls,
              });
              const outcome = await this.processCalls(reviewCalls, input, {
                messages,
                steps,
                media,
                seen,
                executed,
                usage,
                model: this.model,
                specByName,
              });
              executed = outcome.executed;
              if (outcome.breakResult !== undefined) {
                return frame.planSteps !== undefined
                  ? { ...outcome.breakResult, plan: frame.planSteps }
                  : outcome.breakResult;
              }
              continue;
            }

            // Text-only review: the text IS the final answer — the draft
            // unchanged ("confirmed") or a corrected version ("revised").
            const reviewStep: AgentStep = {
              kind: "review",
              durationMs,
              outcome: reviewResponse.text === draft ? "confirmed" : "revised",
            };
            steps.push(reviewStep);
            this.emit(reviewStep);
            if (planSteps !== undefined) {
              steps.push({ kind: "plan", steps: planSteps, completed: true });
              this.emit({ kind: "plan", steps: planSteps, completed: true });
            }
            messages.push({ role: "assistant", content: reviewResponse.text });
            return {
              text: nonEmpty(reviewResponse.text),
              model: reviewResponse.model,
              stopReason: "answered",
              steps,
              toolCallsExecuted: executed,
              media,
              usage,
              ...(frame.planSteps !== undefined ? { plan: frame.planSteps } : {}),
            };
          } catch (err) {
            // Cancellation still cancels the run. ANY other review failure
            // is silent: the original draft is returned below with no review
            // step recorded, exactly as if review never ran. This fallback
            // is load-bearing — a provider that cannot serve the extra call
            // must not break a run that already produced an answer.
            if (err instanceof AgentCancelled || input.signal.aborted) {
              throw new AgentCancelled();
            }
          }
        }

        if (planSteps !== undefined) {
          steps.push({ kind: "plan", steps: planSteps, completed: true });
          this.emit({ kind: "plan", steps: planSteps, completed: true });
        }
        messages.push({ role: "assistant", content: response.text });
        return {
          text: nonEmpty(response.text),
          model: response.model,
          stopReason: "answered",
          steps,
          toolCallsExecuted: executed,
          media,
          usage,
          ...(frame.planSteps !== undefined ? { plan: frame.planSteps } : {}),
        };
      }

      // The assistant turn that asked for tools is recorded verbatim, so the
      // provider sees its own request echoed in the correct wire shape.
      messages.push({
        role: "assistant",
        content: response.text,
        toolCalls: calls,
      });

      // Execute the turn's tool calls: independent read-only calls run in
      // parallel (bounded), write-like calls run alone in order, identical
      // repeats are short-circuited from the per-run cache, and failures
      // carry a retry hint. Results are fed back in the original call order.
      const outcome = await this.processCalls(calls, input, {
        messages,
        steps,
        media,
        seen,
        executed,
        usage,
        model: this.model,
        specByName,
      });
      executed = outcome.executed;
      if (outcome.breakResult !== undefined) {
        return frame.planSteps !== undefined
          ? { ...outcome.breakResult, plan: frame.planSteps }
          : outcome.breakResult;
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
   * Plan a multi-task request, when planning applies.
   *
   * One low-budget, tool-free, NON-streamed call (singleCall never touches the
   * stream sink, so plan tokens cannot leak into the user's rendered message).
   * Every failure mode — provider error, unparseable reply, disabled switch,
   * trivial request — returns undefined and the run proceeds unplanned.
   */
  private async maybePlan(
    input: AgentRunInput,
    startedAt: number,
  ): Promise<{ steps: string[]; usage: { inputTokens: number; outputTokens: number } } | undefined> {
    if (!this.planning) return undefined;
    const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
    const text = lastUser !== undefined && typeof lastUser.content === "string" ? lastUser.content : "";
    const historyLen = Math.max(0, input.messages.length - 1);
    if (text.length === 0 || !shouldPlan(text, historyLen)) return undefined;
    try {
      const res = await this.singleCall(
        input,
        planMessages(text),
        [],
        startedAt,
        0,
        PLAN_MAX_TOKENS,
      );
      const steps = parsePlan(res.text);
      if (steps === null) return undefined;
      return {
        steps,
        usage: {
          inputTokens: res.usage?.inputTokens ?? 0,
          outputTokens: res.usage?.outputTokens ?? 0,
        },
      };
    } catch (err) {
      // Cancellation is not a planning failure; it ends the run.
      if (input.signal.aborted) throw new AgentCancelled();
      return undefined;
    }
  }

  /**
   * Execute one model turn's tool calls and feed every result back in the
   * original call order.
   *
   * Per call, exactly one of these happens:
   *  - EXECUTE — gated by the run budget and the per-user budget, then run:
   *    read-only calls in parallel batches (bounded by BOBI_AGENT_MAX_PARALLEL),
   *    write-like calls one at a time behind a barrier.
   *  - CACHED — the identical call already succeeded earlier this run; its
   *    earlier result is returned with a note instead of re-executing.
   *  - EXHAUSTED — the identical call already failed MAX_ATTEMPTS_PER_CALL
   *    times; it is not executed again.
   *  - PIGGYBACK — an identical call in the SAME turn is already queued; this
   *    one reuses that execution's feedback.
   *
   * A third identical request for an already-succeeded call breaks the whole
   * run (stopReason "loop_detected") — the model is stuck, and further turns
   * would only bill the owner.
   */
  private async processCalls(
    calls: readonly ToolCall[],
    input: AgentRunInput,
    ctx: {
      messages: ChatMessage[];
      steps: AgentStep[];
      media: ContentPart[];
      seen: Map<string, CallRecord>;
      executed: number;
      usage: { inputTokens: number; outputTokens: number };
      model: string;
      specByName: Map<string, ToolSpec>;
    },
  ): Promise<{ executed: number; breakResult?: AgentRunResult }> {
    interface ExecuteEntry {
      kind: "execute";
      call: ToolCall;
      rec: CallRecord;
      body?: string;
      result?: ToolRunResult;
    }
    type Entry =
      | ExecuteEntry
      | { kind: "cached" | "exhausted"; call: ToolCall; rec: CallRecord }
      | { kind: "piggyback"; call: ToolCall; rec: CallRecord; source: ExecuteEntry };

    // --- Decision pass (synchronous, original order) ------------------------
    const entries: Entry[] = [];
    const turnExec = new Map<string, ExecuteEntry>();
    let breakCall: { call: ToolCall; rec: CallRecord } | undefined;

    for (const call of calls) {
      const fp = callFingerprint(call);
      let rec = ctx.seen.get(fp);
      if (rec === undefined) {
        rec = { reqCount: 0, execCount: 0, lastResult: undefined };
        ctx.seen.set(fp, rec);
      }
      rec.reqCount++;

      if (rec.lastResult !== undefined) {
        if (isRetryableFailure(rec.lastResult)) {
          if (rec.execCount < MAX_ATTEMPTS_PER_CALL) {
            const e: ExecuteEntry = { kind: "execute", call, rec };
            entries.push(e);
            turnExec.set(fp, e);
          } else {
            entries.push({ kind: "exhausted", call, rec });
          }
        } else if (rec.reqCount >= 3) {
          breakCall = { call, rec };
          break;
        } else {
          entries.push({ kind: "cached", call, rec });
        }
        continue;
      }

      const source = turnExec.get(fp);
      if (source !== undefined) {
        entries.push({ kind: "piggyback", call, rec, source });
        continue;
      }
      const e: ExecuteEntry = { kind: "execute", call, rec };
      entries.push(e);
      turnExec.set(fp, e);
    }

    if (breakCall !== undefined) {
      return {
        executed: ctx.executed,
        breakResult: this.loopBreakResult(breakCall.call, breakCall.rec, ctx, ctx.executed),
      };
    }

    // --- Budget gating (original order, before anything runs) ----------------
    let planned = ctx.executed;
    for (const e of entries) {
      if (e.kind !== "execute") continue;
      // Per-run budget: a turn that asks for more tools than remain is
      // truncated rather than allowed to overflow.
      if (planned >= this.budgets.maxToolCalls) {
        e.body = "status=error: tool call budget exhausted.";
        continue;
      }
      // The per-user budget is checked before the tool runs, so the model
      // cannot spend it by requesting tools in bulk.
      if (this.allowToolCall !== undefined && !this.allowToolCall(input.actor.userId)) {
        e.body = "status=not_allowed: daily tool usage budget exhausted.";
        continue;
      }
      planned++;
    }

    // --- Execution: parallel batches for read-only, barriers for writes -----
    let executedNow = ctx.executed;
    const settle = (e: ExecuteEntry, settled: PromiseSettledResult<ToolRunResult>): void => {
      const result: ToolRunResult =
        settled.status === "fulfilled"
          ? settled.value
          : {
              tool: e.call.name,
              status: "error",
              message: "tool execution failed unexpectedly",
              durationMs: 0,
            };
      e.result = result;
      e.rec.execCount++;
      e.rec.lastResult = result;
      executedNow++;
      let body = serialiseToolResult(result) + mediaNote(result);
      if (isRetryableFailure(result)) {
        body += `\n${e.rec.execCount < MAX_ATTEMPTS_PER_CALL ? RETRY_HINT : LAST_RETRY_HINT}`;
      }
      e.body = body;
    };

    const runnable = entries.filter(
      (e): e is ExecuteEntry => e.kind === "execute" && e.body === undefined,
    );
    let i = 0;
    while (i < runnable.length) {
      this.throwIfCancelled(input.signal);
      const first = runnable[i]!;
      if (this.parallel && this.isParallelEligible(first.call, ctx.specByName)) {
        const batch: ExecuteEntry[] = [];
        while (
          i < runnable.length &&
          this.parallel &&
          this.isParallelEligible(runnable[i]!.call, ctx.specByName)
        ) {
          batch.push(runnable[i]!);
          i++;
        }
        const settled = await mapBounded(batch, this.maxPar, (e) =>
          this.executeOne(e.call, input),
        );
        batch.forEach((e, idx) => settle(e, settled[idx]!));
      } else {
        settle(first, { status: "fulfilled", value: await this.executeOne(first.call, input) });
        i++;
      }
    }

    // --- Feedback assembly (original call order, always) ---------------------
    for (const e of entries) {
      let body: string;
      if (e.kind === "execute") {
        body = e.body ?? "status=error: tool call budget exhausted.";
        if (e.result !== undefined) {
          const result = e.result;
          // Media a tool produced for the user is collected for delivery. It
          // never enters `messages`: the model already described what it made
          // in `data`, and replaying base64 would bloat every later turn.
          if (result.media !== undefined) ctx.media.push(...result.media);
          ctx.steps.push({
            kind: "tool",
            name: e.call.name,
            status: result.status,
            durationMs: result.durationMs,
          });
          this.emit({
            kind: "tool",
            name: e.call.name,
            status: result.status,
            durationMs: result.durationMs,
          });
        }
      } else if (e.kind === "cached") {
        body = `${serialiseToolResult(e.rec.lastResult!)}${mediaNote(e.rec.lastResult!)}\n(note: repeated call — returning the earlier result instead of running it again.)`;
      } else if (e.kind === "exhausted") {
        body =
          "status=error: this exact call has already been attempted 3 times this run " +
          "and its retry budget is exhausted. Do not call it again unchanged — " +
          "change the parameters or answer from what you have.";
      } else if (e.kind === "piggyback") {
        // Piggyback: reuse the source execution's feedback verbatim; when it
        // succeeded, say so, so the model does not think it ran twice.
        const srcBody = e.source.body ?? "status=error: duplicate call in the same turn.";
        body =
          e.source.result !== undefined && !isRetryableFailure(e.source.result)
            ? `${srcBody}\n(note: repeated call — returning the earlier result instead of running it again.)`
            : srcBody;
      } else {
        body = "status=error: tool call was not processed.";
      }
      ctx.messages.push({
        role: "tool",
        toolCallId: e.call.id,
        toolName: e.call.name,
        content: wrapToolResult(e.call.name, body),
      });
    }

    // A duplicate answered from this turn's own execution can still be the
    // third identical request overall — the loop break applies then too.
    for (const e of entries) {
      if (
        e.kind === "piggyback" &&
        e.rec.reqCount >= 3 &&
        e.rec.lastResult !== undefined &&
        !isRetryableFailure(e.rec.lastResult)
      ) {
        return {
          executed: executedNow,
          breakResult: this.loopBreakResult(e.call, e.rec, ctx, executedNow),
        };
      }
    }

    return { executed: executedNow };
  }

  /** runTool, hardened: an Executor rejection becomes an error result. */
  private async executeOne(call: ToolCall, input: AgentRunInput): Promise<ToolRunResult> {
    try {
      return await this.runTool(call, input);
    } catch {
      // A crashed tool must not kill a run that already gathered answers.
      // Cancellation still surfaces: the next checkpoint throws AgentCancelled.
      return {
        tool: call.name,
        status: "error",
        message: "tool execution failed unexpectedly",
        durationMs: 0,
      };
    }
  }

  /** True when this call may overlap with neighbouring read-only calls. */
  private isParallelEligible(call: ToolCall, specByName: Map<string, ToolSpec>): boolean {
    const spec = specByName.get(call.name);
    return spec !== undefined && !isWriteLikeTool(spec);
  }

  /** The graceful result returned when loop detection breaks a run. */
  private loopBreakResult(
    call: ToolCall,
    rec: CallRecord,
    ctx: {
      steps: AgentStep[];
      media: ContentPart[];
      usage: { inputTokens: number; outputTokens: number };
      model: string;
    },
    executed: number,
  ): AgentRunResult {
    let text = `I ran into a loop on ${call.name}; here's what I have so far.`;
    const last = rec.lastResult;
    if (last !== undefined && last.status === "ok") {
      const data = serialiseToolResult(last);
      text += `\n\nLast result from ${call.name}: ${data.length > 500 ? `${data.slice(0, 500)}…` : data}`;
    }
    return {
      text,
      model: ctx.model,
      stopReason: "loop_detected",
      steps: ctx.steps,
      toolCallsExecuted: executed,
      media: ctx.media,
      usage: ctx.usage,
    };
  }

  /**
   * One provider call, bounded by whichever is sooner: the per-call timeout, or
   * the run's remaining wall-clock budget.
   *
   * When streaming is enabled (kill switch BOBI_STREAMING), a stream sink is
   * installed for this turn, and the provider streams, the call consumes the
   * token stream and forwards it to the sink as AgentStreamEvents so the bot
   * can render the answer progressively. Everything else — budgets, the
   * tool loop, the final tool-free call — is unchanged.
   */
  private async call(
    input: AgentRunInput,
    messages: ChatMessage[],
    tools: readonly ToolSpec[],
    startedAt: number,
    graceMs = 0,
  ): Promise<CompletionResponse> {
    const remaining = this.budgets.totalTimeoutMs - (this.now() - startedAt);
    const allowance = remaining > 0 ? remaining : graceMs;
    const timeoutMs = Math.max(1, Math.min(this.callTimeoutMs, allowance));

    // The caller's signal only covers cancellation, so the deadline is armed
    // here too — a provider that ignores `timeoutMs` cannot hang the run. The
    // race matters as much as the abort: a promise that never settles would
    // otherwise hold this semaphore slot forever.
    //
    // Note: withDeadline's `expired` only rejects when the TIMER fires, never
    // when the caller aborts. A provider that also ignores the abort signal
    // would therefore hang the race below forever, so the caller's abort is
    // raced explicitly as well.
    const deadline = withDeadline(input.signal, timeoutMs);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AgentCancelled());
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // Streaming needs three things: the kill switch on, a sink installed
      // for this turn (the bot installs one around engine.respond(); nothing
      // else does), and a provider that actually streams. Otherwise the
      // single-shot path below runs exactly as before.
      const sink = currentStreamSink();
      const stream =
        sink !== undefined && streamingEnabled() && this.provider.completeStream !== undefined
          ? this.provider.completeStream.bind(this.provider)
          : undefined;
      const work =
        stream !== undefined
          ? this.callStream(input, messages, tools, startedAt, graceMs, timeoutMs, deadline, sink!, stream)
          : raceDeadline(
              this.provider.complete({
                messages,
                model: this.model,
                timeoutMs,
                signal: deadline.signal,
                ...(tools.length > 0 ? { tools } : {}),
              }),
              deadline,
            );
      return await Promise.race([work, aborted]);
    } catch (err) {
      // The caller's own cancellation is not a provider failure; report it as
      // such so it is not surfaced to the user as an error.
      if (input.signal.aborted) throw new AgentCancelled();
      if (deadline.timedOut()) throw new AiError("timeout", "Provider response timed out.");
      throw err;
    } finally {
      if (onAbort !== undefined) input.signal.removeEventListener("abort", onAbort);
      deadline.dispose();
    }
  }

  /**
   * One provider call via the token stream.
   *
   * Token deltas are forwarded to the sink as they arrive; the terminal event
   * carries the authoritative text, tool calls, and usage. Failures follow
   * the StreamEvent contract (see ai/provider.ts):
   *
   * - Error BEFORE the first text delta: nothing was shown, so a single-shot
   *   retry is invisible to the user.
   * - A stream that ENDS EMPTY (no text, no tool calls): the same single-shot
   *   retry — an empty end is a provider failure, not an answer.
   *   Both retries are ONE per call and both are disabled by
   *   BOBI_STREAM_FALLBACK=0.
   * - Error AFTER text was shown: tell the sink (`restart`), make ONE
   *   single-shot attempt for the full answer, and on its failure tell the
   *   sink (`error`) and rethrow the ORIGINAL stream error.
   * - A stream that resolves into tool calls: tell the sink (`toolcall`) so
   *   the partial render is aborted cleanly, then continue the agentic loop.
   *
   * A spent deadline or a caller abort never falls back: there is no budget
   * left to spend, or nobody left to show the answer to.
   */
  private async callStream(
    input: AgentRunInput,
    messages: ChatMessage[],
    tools: readonly ToolSpec[],
    startedAt: number,
    graceMs: number,
    timeoutMs: number,
    deadline: Deadline,
    sink: StreamEventSink,
    stream: (req: CompletionRequest) => AsyncGenerator<StreamEvent, void, undefined>,
  ): Promise<CompletionResponse> {
    const emit = (ev: AgentStreamEvent): void => {
      // A sink whose turn was aborted gets nothing: UI events for a dead
      // turn would touch a message the turn no longer owns.
      if (input.signal.aborted) return;
      try {
        sink(ev);
      } catch {
        // The sink is UI-only; it must never break the turn.
      }
    };

    let text = "";
    let toolCalls: readonly ToolCall[] = [];
    let usage: TokenUsage | undefined;
    let model = this.model;
    let sawText = false;

    const consume = (async (): Promise<void> => {
      const events = stream({
        messages,
        model: this.model,
        timeoutMs,
        signal: deadline.signal,
        ...(tools.length > 0 ? { tools } : {}),
      });
      for await (const ev of events) {
        if (input.signal.aborted) throw new AgentCancelled();
        if (ev.type === "text") {
          if (ev.delta.length === 0) continue;
          text += ev.delta;
          sawText = true;
          emit({ type: "token", delta: ev.delta });
        } else if (ev.type === "usage") {
          usage = ev.usage;
        } else {
          // The terminal event: its text is authoritative (it equals the
          // concatenation of the deltas, but the adapter owns that truth),
          // and its tool calls decide whether the loop continues.
          text = ev.text;
          toolCalls = ev.toolCalls;
          model = ev.model;
          if (ev.usage !== undefined) usage = ev.usage;
        }
      }
    })();

    try {
      // The deadline is raced as well as aborted into the signal: a provider
      // that ignores the abort cannot hang the run (the same guarantee
      // raceDeadline gives the single-shot path). The no-op catch keeps a
      // late rejection from surfacing as unhandled after the caller moved on.
      await raceDeadline(consume, deadline);
    } catch (err) {
      if (input.signal.aborted) throw new AgentCancelled();
      if (deadline.timedOut()) throw err;
      if (!sawText) {
        if (!streamFallbackEnabled()) throw err;
        logStreamFallback("stream failed before the first token");
        return await raceDeadline(
          this.singleCall(input, messages, tools, startedAt, graceMs),
          deadline,
        );
      }
      emit({ type: "restart" });
      try {
        return await raceDeadline(
          this.singleCall(input, messages, tools, startedAt, graceMs),
          deadline,
        );
      } catch {
        emit({ type: "error" });
        throw err;
      }
    }

    // A stream that ENDS EMPTY — no text and no tool calls — is a silent
    // provider failure, not an answer: free gateways close SSE streams
    // without emitting a single token. Adapters raise this themselves
    // now, but a provider that still resolves empty gets exactly ONE
    // non-streaming retry here (same single-shot rail as the pre-token
    // failure above) before the empty result can dead-end the turn.
    if (text.trim().length === 0 && toolCalls.length === 0 && streamFallbackEnabled()) {
      logStreamFallback("stream ended empty");
      return await raceDeadline(
        this.singleCall(input, messages, tools, startedAt, graceMs),
        deadline,
      );
    }

    if (toolCalls.length > 0) emit({ type: "toolcall" });
    return {
      text,
      model,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /**
   * One single-shot provider call with a freshly computed budget.
   *
   * Used for the non-streaming path and as the streaming fallback. The
   * budget is recomputed from `startedAt` (rather than reusing the outer
   * call's) because a failed stream may already have spent most of it.
   */
  private async singleCall(
    input: AgentRunInput,
    messages: ChatMessage[],
    tools: readonly ToolSpec[],
    startedAt: number,
    graceMs: number,
    maxTokens?: number,
  ): Promise<CompletionResponse> {
    const remaining = this.budgets.totalTimeoutMs - (this.now() - startedAt);
    const allowance = remaining > 0 ? remaining : graceMs;
    const timeoutMs = Math.max(1, Math.min(this.callTimeoutMs, allowance));
    const deadline = withDeadline(input.signal, timeoutMs);
    try {
      return await raceDeadline(
        this.provider.complete({
          messages,
          model: this.model,
          timeoutMs,
          signal: deadline.signal,
          ...(tools.length > 0 ? { tools } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        }),
        deadline,
      );
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

/**
 * Executions allowed for one distinct tool call (same name + arguments):
 * the initial attempt plus two retries. A failed call past this budget is
 * reported as exhausted instead of being executed again.
 */
const MAX_ATTEMPTS_PER_CALL = 3;

/** Per-run record for one distinct tool call, for loop awareness. */
interface CallRecord {
  /** Times the model requested this exact call. */
  reqCount: number;
  /** Times it was actually executed. */
  execCount: number;
  /** Most recent execution outcome, for cached feedback. */
  lastResult: ToolRunResult | undefined;
}

/** Appended to a failed/empty tool result while retries remain. */
const RETRY_HINT =
  "hint: this call failed or returned nothing — double-check the parameters, then retry once if you still need it.";

/** Appended when a failed/empty result has used up its retries. */
const LAST_RETRY_HINT =
  "hint: this call failed or returned nothing — it has used its retries; answer from what you have instead of calling it again unchanged.";

/** Identity of a tool call for loop awareness: name + canonical arguments. */
function callFingerprint(call: ToolCall): string {
  return `${call.name}:${stableStringify(normaliseArguments(call.arguments))}`;
}

/** JSON with sorted object keys, so argument key order cannot forge a new call. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/**
 * True when a result invites a corrected retry: a hard error, a fixable
 * input problem, a miss, or an ok that carried nothing. A denial or a
 * disabled tool is NOT retryable — repeating those cannot change the answer.
 */
function isRetryableFailure(result: ToolRunResult): boolean {
  if (result.status === "error" || result.status === "invalid_input" || result.status === "not_found") {
    return true;
  }
  if (result.status === "ok") return isEmptyData(result.data);
  return false;
}

/**
 * The §4.7 media-feedback line for one execution's canonical feedback body:
 * when a tool produced media for the user, the model is told WHAT was
 * delivered (platform-generated description handles, never the bytes) on
 * exactly one line. Built only from the execution's own result — in
 * settle() for a fresh execution and in the cached branch from the recorded
 * result — so piggyback replays (which reuse the source body verbatim) and
 * cached replays each carry the line exactly once, never duplicated.
 */
function mediaNote(result: ToolRunResult): string {
  if (result.media === undefined || result.media.length === 0) return "";
  const handles = result.media.map(describeMediaForModel).join("; ");
  return `\n[media delivered to the user: ${handles}]`;
}

/** True when an ok result carried no usable payload. */
function isEmptyData(data: unknown): boolean {
  if (data === undefined || data === null || data === "") return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") return Object.keys(data).length === 0;
  return false;
}

/** The newest user turn's text, or "" when there is none / it is not text. */
function lastUserText(messages: readonly ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last !== undefined && typeof last.content === "string" ? last.content : "";
}

/**
 * The self-review prompt: one user message carrying the run frame (goal,
 * plan steps, executed tools with statuses — the last derived from `steps`),
 * a short delivery checklist, the draft, and the review protocol.
 */
function reviewPrompt(frame: RunFrame, steps: readonly AgentStep[], draft: string): string {
  const planLines =
    frame.planSteps !== undefined && frame.planSteps.length > 0
      ? frame.planSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "(no plan)";
  const toolLines = steps
    .filter((s): s is Extract<AgentStep, { kind: "tool" }> => s.kind === "tool")
    .map((s) => `- ${s.name}: ${s.status}`)
    .join("\n");
  return [
    "<self_review>",
    `Goal: ${frame.goal}`,
    "Plan steps:",
    planLines,
    "Executed tools:",
    toolLines.length > 0 ? toolLines : "(none)",
    "Checklist:",
    "- Is the asked-for thing actually done?",
    "- Was the output actually delivered — made ≠ sent?",
    "- Are numbers, units and results sane?",
    "- Any failed step → fix it now or the final answer must say plainly what did not happen.",
    "If the draft is complete and correct, reply with the draft EXACTLY unchanged. " +
      "If a step is missing or wrong, call the needed tool(s) now instead of replying with text. " +
      "If the draft is wrong but no tool is needed, reply with the corrected final answer only.",
    "Draft:",
    draft,
    "</self_review>",
  ].join("\n");
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
  return trimmed.length > 0 ? trimmed : t("error.empty_response");
}

import { flagUnlessOff, processEnv, readNamed } from "../config/env";
/** Env var that disables the stream→single-shot fallback. Default: ON. */
export const STREAM_FALLBACK_ENV_VAR = "BOBI_STREAM_FALLBACK";

/**
 * Whether a failed or empty stream may fall back to one non-streaming
 * complete() of the same request. `BOBI_STREAM_FALLBACK=0` (also "false",
 * "no", "off") restores the pre-fallback behaviour: stream failures and
 * empty stream ends surface exactly as the provider produced them.
 */
export function streamFallbackEnabled(): boolean {
  return flagUnlessOff(readNamed(processEnv(), STREAM_FALLBACK_ENV_VAR));
}

/** One-line diagnostics for a stream fallback: reason only, never content. */
function logStreamFallback(reason: string): void {
  console.info(`[stream-fallback] ${reason}; retrying non-streaming`);
}

/** True when the error means the provider could not be reached at all. */
export function isTransportFailure(err: unknown): boolean {
  return err instanceof AiError && (err.kind === "network" || err.kind === "timeout");
}