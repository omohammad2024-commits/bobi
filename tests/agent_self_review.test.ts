/**
 * Agent self-review tests (Phase 3, Workstream B).
 *
 * After a run that executed at least one tool, the loop makes ONE review
 * pass over the draft answer before returning it: the reviewer sees the run
 * frame (goal, plan, executed tools), a delivery checklist, and the draft,
 * and may confirm it verbatim, revise the text, or call the missing tool(s).
 *
 * Latency guard: plain chat turns (zero tools) and BOBI_AGENT_SELF_REVIEW=0
 * must pay ZERO extra provider calls.
 *
 * Env switches are read in the AgentLoop constructor, so tests that flip
 * BOBI_AGENT_SELF_REVIEW set it BEFORE constructing the loop and clean up
 * after themselves (same pattern as agent_brain.test.ts).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { AgentLoop } from "../src/agent/loop";
import type { AgentStep } from "../src/agent/transcript";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";
import { AiError } from "../src/ai/provider";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
} from "../src/ai/provider";

// ---------- helpers ----------

const FULL_ACTOR: ToolActor = {
  userId: "u1",
  permissions: [
    "tools:calculator",
    "tools:date_time",
    "tools:text_utilities",
    "tools:unit_converter",
  ],
};

/** Plays back a fixed script, recording every request (including failed ones). */
class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  private index = 0;

  constructor(private readonly script: readonly CompletionResponse[]) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const next = this.script[this.index++];
    if (!next) {
      throw new AiError("invalid_response", "script exhausted");
    }
    return next;
  }

  /** Attempts made, including a call that threw (e.g. an exhausted script). */
  get callCount(): number {
    return this.requests.length;
  }
}

const answer = (text: string): CompletionResponse => ({ text, model: "m" });

const toolTurn = (...calls: ToolCall[]): CompletionResponse => ({
  text: "",
  model: "m",
  toolCalls: calls,
});

const call = (name: string, args: unknown, id = "c1"): ToolCall => ({
  id,
  name,
  arguments: args,
});

function makeLoop(
  provider: AiProvider,
  opts: {
    tools?: ToolService;
    budgets?: Record<string, number>;
    now?: () => number;
    onStep?: (s: AgentStep) => void;
  } = {},
) {
  return new AgentLoop({
    provider,
    model: "m",
    tools: opts.tools ?? new ToolService(),
    callTimeoutMs: 5_000,
    ...(opts.budgets !== undefined ? { budgets: opts.budgets } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.onStep !== undefined ? { onStep: opts.onStep } : {}),
  });
}

function run(loop: AgentLoop, userText = "add 20 and 22") {
  return loop.run({
    messages: [{ role: "user", content: userText }],
    systemPrompt: "sys",
    actor: FULL_ACTOR,
    signal: new AbortController().signal,
  });
}

function reviewSteps(steps: readonly AgentStep[]) {
  return steps.filter(
    (s): s is Extract<AgentStep, { kind: "review" }> => s.kind === "review",
  );
}

afterEach(() => {
  delete process.env.BOBI_AGENT_SELF_REVIEW;
  delete process.env.SOL_AGENT_SELF_REVIEW;
  delete process.env.BOBI_AGENT_PLANNING;
});

// ---------- confirmed ----------

describe("agent self-review — confirmed draft", () => {
  test("tool turn with a complete draft gets exactly one review call and returns the draft", async () => {
    const draft = "The sum is 42.";
    const provider = new ScriptedProvider([
      toolTurn(call("calculator", { op: "add", a: 20, b: 22 })),
      answer(draft),
      answer(draft), // the review replies with the draft EXACTLY unchanged
    ]);
    const result = await run(makeLoop(provider));

    // 1 tool turn + 1 draft turn + exactly 1 review call.
    expect(provider.callCount).toBe(3);
    expect(result.text).toBe(draft);
    expect(result.stopReason).toBe("answered");
    expect(result.toolCallsExecuted).toBe(1);
    // No plan was made on this single-turn request.
    expect(result.plan).toBeUndefined();

    const reviews = reviewSteps(result.steps);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.outcome).toBe("confirmed");
    expect(reviews[0]!.durationMs).toBeGreaterThanOrEqual(0);

    // The review request carries the draft as an assistant turn, then ONE
    // user message starting with <self_review> holding the frame + protocol,
    // and it is given the run's tool specs (so it CAN emit tool calls).
    const reviewReq = provider.requests[2]!;
    expect(reviewReq.tools?.length).toBeGreaterThan(0);
    const msgs = reviewReq.messages;
    const draftTurn = msgs[msgs.length - 2]!;
    expect(draftTurn.role).toBe("assistant");
    expect(draftTurn.content).toBe(draft);
    const reviewMsg = msgs[msgs.length - 1]!;
    expect(reviewMsg.role).toBe("user");
    expect(reviewMsg.content.startsWith("<self_review>")).toBe(true);
    expect(reviewMsg.content).toContain("add 20 and 22"); // the goal
    expect(reviewMsg.content).toContain("calculator: ok"); // executed tool + status
    expect(reviewMsg.content).toContain("made ≠ sent"); // checklist: delivered, not just made
    expect(reviewMsg.content).toContain("reply with the draft EXACTLY unchanged");
    expect(reviewMsg.content).toContain(
      "call the needed tool(s) now instead of replying with text",
    );
    expect(reviewMsg.content).toContain("reply with the corrected final answer only");
  });

  test("when a plan exists it is surfaced on the result and the review still runs once", async () => {
    const history = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "sure" },
      { role: "user", content: "1. Add 20 and 22\n2. Report the sum" },
    ] as const;
    const draft = "The sum is 42.";
    const provider = new ScriptedProvider([
      { text: '["Add 20 and 22", "Report the sum"]', model: "m" }, // plan call
      toolTurn(call("calculator", { op: "add", a: 20, b: 22 })),
      answer(draft),
      answer(draft), // review confirms
    ]);
    const result = await makeLoop(provider).run({
      messages: history as unknown as Parameters<AgentLoop["run"]>[0]["messages"],
      systemPrompt: "sys",
      actor: FULL_ACTOR,
      signal: new AbortController().signal,
    });

    // plan + tool turn + draft turn + exactly one review call.
    expect(provider.callCount).toBe(4);
    expect(result.text).toBe(draft);
    expect(result.plan).toEqual(["Add 20 and 22", "Report the sum"]);
    expect(result.steps.some((s) => s.kind === "plan" && s.completed === false)).toBe(true);
    expect(result.steps.some((s) => s.kind === "plan" && s.completed === true)).toBe(true);
    const reviews = reviewSteps(result.steps);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.outcome).toBe("confirmed");
  });
});

// ---------- review requests a missing tool ----------

describe("agent self-review — missing step fixed with tools", () => {
  test("review emits the missing tool call, it executes, and there is no second review", async () => {
    const draft = "The sum is 42.";
    const finalText = "The sum is 42, and double-checked: 84.";
    const provider = new ScriptedProvider([
      toolTurn(call("calculator", { op: "add", a: 20, b: 22 }, "c1")),
      answer(draft),
      // The review finds a missing verification step and calls the tool.
      toolTurn(call("calculator", { op: "multiply", a: 42, b: 2 }, "c2")),
      answer(finalText),
    ]);
    const result = await run(makeLoop(provider));

    // Bounded: tool turn + draft + review + final = 4 calls, no 2nd review.
    expect(provider.callCount).toBe(4);
    expect(result.text).toBe(finalText);
    expect(result.stopReason).toBe("answered");
    expect(result.toolCallsExecuted).toBe(2);

    const reviews = reviewSteps(result.steps);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.outcome).toBe("tools");

    // The review-requested tool really executed and its result reached the
    // model before the final answer.
    const finalReq = provider.requests[3]!;
    const toolMsg = finalReq.messages.filter((m) => m.role === "tool").at(-1)!;
    expect(toolMsg.toolCallId).toBe("c2");
    expect(toolMsg.content).toContain("84");
  });
});

// ---------- revised ----------

describe("agent self-review — revised draft", () => {
  test("a wrong draft with no tool needed is replaced by the corrected text", async () => {
    const provider = new ScriptedProvider([
      toolTurn(call("calculator", { op: "add", a: 20, b: 22 })),
      answer("The sum is 41."), // wrong draft
      answer("The sum is 42."), // review corrects it, no tool call
    ]);
    const result = await run(makeLoop(provider));

    expect(provider.callCount).toBe(3);
    expect(result.text).toBe("The sum is 42.");
    const reviews = reviewSteps(result.steps);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.outcome).toBe("revised");
  });
});

// ---------- latency guards ----------

describe("agent self-review — no-review cases pay zero extra calls", () => {
  test("plain chat turn (no tools) is never reviewed", async () => {
    const provider = new ScriptedProvider([answer("سلام!")]);
    const result = await run(makeLoop(provider), "سلام");

    expect(provider.callCount).toBe(1);
    expect(result.text).toBe("سلام!");
    expect(reviewSteps(result.steps)).toHaveLength(0);
  });

  test("BOBI_AGENT_SELF_REVIEW=0 disables the review on tool turns", async () => {
    process.env.BOBI_AGENT_SELF_REVIEW = "0";
    const provider = new ScriptedProvider([
      toolTurn(call("calculator", { op: "add", a: 20, b: 22 })),
      answer("The sum is 42."),
    ]);
    const result = await run(makeLoop(provider));

    expect(provider.callCount).toBe(2);
    expect(result.text).toBe("The sum is 42.");
    expect(reviewSteps(result.steps)).toHaveLength(0);
  });
});

// ---------- failure fallback ----------

describe("agent self-review — review failure fallback", () => {
  test("a failing review call keeps the original draft and the run succeeds", async () => {
    const draft = "The sum is 42.";
    // Only two scripted responses: the review call hits an exhausted script
    // and throws AiError("script exhausted") — the load-bearing fallback case.
    const provider = new ScriptedProvider([
      toolTurn(call("calculator", { op: "add", a: 20, b: 22 })),
      answer(draft),
    ]);
    const result = await run(makeLoop(provider));

    expect(result.text).toBe(draft);
    expect(result.stopReason).toBe("answered");
    expect(result.toolCallsExecuted).toBe(1);
    // The review was attempted (3rd request) but NO review step was recorded
    // and the step sequence is identical to a run without review.
    expect(provider.callCount).toBe(3);
    expect(reviewSteps(result.steps)).toHaveLength(0);
    expect(result.steps.map((s) => s.kind)).toEqual(["model", "tool", "model"]);
  });
});

// ---------- latency measurement ----------

describe("agent self-review — latency", () => {
  /**
   * A provider that advances a fake clock by a fixed amount per call, so the
   * loop's injected `now` measures deterministic durations:
   * tool turn 40ms, draft turn 40ms, review call 120ms.
   */
  class TimedProvider implements AiProvider {
    readonly name = "timed";
    readonly requests: CompletionRequest[] = [];
    private index = 0;
    constructor(
      private readonly script: readonly CompletionResponse[],
      private readonly advances: readonly number[],
      private readonly advanceClock: (ms: number) => void,
    ) {}
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      this.requests.push(req);
      const next = this.script[this.index];
      const advance = this.advances[this.index] ?? 0;
      this.index++;
      if (!next) throw new AiError("invalid_response", "script exhausted");
      this.advanceClock(advance);
      return next;
    }
  }

  test("review step durationMs reflects the review call; added latency is exactly that call", async () => {
    let clock = 0;
    const now = () => clock;
    const draft = "The sum is 42.";

    // Reviewed tool turn: 40 (tool turn) + 40 (draft) + 120 (review) = 200ms.
    const reviewedProvider = new TimedProvider(
      [toolTurn(call("calculator", { op: "add", a: 20, b: 22 })), answer(draft), answer(draft)],
      [40, 40, 120],
      (ms) => {
        clock += ms;
      },
    );
    const t0 = clock;
    const reviewed = await run(makeLoop(reviewedProvider, { now }));
    const reviewedElapsed = clock - t0;
    expect(reviewedElapsed).toBe(200);
    const reviews = reviewSteps(reviewed.steps);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.outcome).toBe("confirmed");
    expect(reviews[0]!.durationMs).toBe(120);

    // Same tool turn with review disabled: 40 + 40 = 80ms.
    process.env.BOBI_AGENT_SELF_REVIEW = "0";
    const unreviewedProvider = new TimedProvider(
      [toolTurn(call("calculator", { op: "add", a: 20, b: 22 })), answer(draft)],
      [40, 40],
      (ms) => {
        clock += ms;
      },
    );
    const t1 = clock;
    await run(makeLoop(unreviewedProvider, { now }));
    const unreviewedElapsed = clock - t1;
    delete process.env.BOBI_AGENT_SELF_REVIEW;
    expect(unreviewedElapsed).toBe(80);

    // Unreviewed plain chat turn: a single 40ms call.
    const chatProvider = new TimedProvider(
      [answer("سلام!")],
      [40],
      (ms) => {
        clock += ms;
      },
    );
    const t2 = clock;
    await run(makeLoop(chatProvider, { now }), "سلام");
    const chatElapsed = clock - t2;
    expect(chatElapsed).toBe(40);

    // The review's added latency is exactly its own measured duration:
    // +120ms over the identical unreviewed tool turn, +160ms over chat.
    expect(reviewedElapsed - unreviewedElapsed).toBe(reviews[0]!.durationMs);
    expect(reviewedElapsed - chatElapsed).toBe(160);
  });
});
