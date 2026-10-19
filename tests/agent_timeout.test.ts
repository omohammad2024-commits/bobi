/**
 * Regression tests for the agent loop's timeout behaviour (Worker C audit).
 *
 * Two budgets bound every run, and both must hold for a slow single call:
 * - `callTimeoutMs`: per provider call,
 * - `budgets.totalTimeoutMs`: the whole run's wall clock.
 *
 * Also covered: the abort path (no hanging promises), the budget-exhausted
 * best-effort answer, and the English-only user-facing fallbacks.
 * No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { AgentCancelled, AgentLoop } from "../src/agent/loop";
import { AiError } from "../src/ai/provider";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
} from "../src/ai/provider";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";
import { t } from "../src/i18n";

const ACTOR: ToolActor = {
  userId: "u1",
  permissions: ["tools:calculator"],
};

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

/** A provider whose promise never settles — the abort/deadline must free it. */
class HangingProvider implements AiProvider {
  readonly name = "hanging";
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return new Promise<CompletionResponse>(() => {});
  }
}

/** Plays back a script, advancing a fake clock on each call. */
class ClockProvider implements AiProvider {
  readonly name = "clock";
  private index = 0;
  constructor(
    private readonly script: readonly CompletionResponse[],
    private readonly advance: (callIndex: number) => void,
  ) {}
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.advance(this.index);
    const next = this.script[this.index++];
    if (!next) throw new AiError("invalid_response", "script exhausted");
    return next;
  }
}

function baseInput(signal: AbortSignal) {
  return {
    messages: [{ role: "user", content: "hi" }] as const,
    systemPrompt: "sys",
    actor: ACTOR,
    signal,
  };
}

describe("agent loop — per-call timeout", () => {
  test("a hung provider call fails fast with AiError timeout", async () => {
    const loop = new AgentLoop({
      provider: new HangingProvider(),
      model: "m",
      tools: new ToolService(),
      callTimeoutMs: 50,
      budgets: { totalTimeoutMs: 60_000 },
    });
    const started = Date.now();
    const err = await loop.run(baseInput(new AbortController().signal)).catch((e) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("timeout");
    // Freed by the deadline race, not by the 60s total budget.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("a slow single call respects the tighter of the two budgets", async () => {
    // Per-call budget is generous (60s) but the total run budget is 150ms:
    // the call must be capped by the remaining total, not the per-call value.
    const loop = new AgentLoop({
      provider: new HangingProvider(),
      model: "m",
      tools: new ToolService(),
      callTimeoutMs: 60_000,
      budgets: { totalTimeoutMs: 150 },
    });
    const started = Date.now();
    const err = await loop.run(baseInput(new AbortController().signal)).catch((e) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("timeout");
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("agent loop — total budget exhaustion", () => {
  test("returns a best-effort answer with stopReason budget_exhausted", async () => {
    let now = 0;
    const provider = new ClockProvider(
      [
        toolTurn(call("calculator", { op: "add", a: 1, b: 2 })),
        answer("grace answer"),
      ],
      () => {
        // The first model turn consumes the whole budget.
        now = 200_000;
      },
    );
    const loop = new AgentLoop({
      provider,
      model: "m",
      tools: new ToolService(),
      callTimeoutMs: 5_000,
      budgets: { totalTimeoutMs: 120_000 },
      now: () => now,
    });
    const res = await loop.run(baseInput(new AbortController().signal));
    expect(res.stopReason).toBe("budget_exhausted");
    expect(res.text).toBe("grace answer");
  });

  test("when the grace call also fails, the English time-exhausted note is returned", async () => {
    let now = 0;
    const provider = new ClockProvider(
      [
        toolTurn(call("calculator", { op: "add", a: 1, b: 2 })),
        // No second response: the script is exhausted → the grace call throws.
      ],
      () => {
        now = 200_000;
      },
    );
    const loop = new AgentLoop({
      provider,
      model: "m",
      tools: new ToolService(),
      callTimeoutMs: 5_000,
      budgets: { totalTimeoutMs: 120_000 },
      now: () => now,
    });
    const res = await loop.run(baseInput(new AbortController().signal));
    expect(res.stopReason).toBe("budget_exhausted");
    expect(res.text).toBe(t("agent.time_exhausted"));
    expect(res.text.length).toBeGreaterThan(0);
  });

  test("an empty final answer degrades to the English empty-response note", async () => {
    let now = 0;
    const provider = new ClockProvider(
      [
        toolTurn(call("calculator", { op: "add", a: 1, b: 2 })),
        answer("   "),
      ],
      () => {
        now = 200_000;
      },
    );
    const loop = new AgentLoop({
      provider,
      model: "m",
      tools: new ToolService(),
      callTimeoutMs: 5_000,
      budgets: { totalTimeoutMs: 120_000 },
      now: () => now,
    });
    const res = await loop.run(baseInput(new AbortController().signal));
    expect(res.text).toBe(t("error.empty_response"));
  });
});

describe("agent loop — abort", () => {
  test("aborting mid-call raises AgentCancelled without hanging", async () => {
    const loop = new AgentLoop({
      provider: new HangingProvider(),
      model: "m",
      tools: new ToolService(),
      callTimeoutMs: 60_000,
      budgets: { totalTimeoutMs: 600_000 },
    });
    const controller = new AbortController();
    const run = loop.run(baseInput(controller.signal));
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(AgentCancelled);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("an already-aborted signal never starts the provider call", async () => {
    let calls = 0;
    const provider: AiProvider = {
      name: "counting",
      async complete(): Promise<CompletionResponse> {
        calls++;
        return answer("x");
      },
    };
    const loop = new AgentLoop({
      provider,
      model: "m",
      tools: new ToolService(),
      callTimeoutMs: 5_000,
    });
    const controller = new AbortController();
    controller.abort();
    const err = await loop.run(baseInput(controller.signal)).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCancelled);
    expect(calls).toBe(0);
  });
});
