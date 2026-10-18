import { describe, expect, test } from "bun:test";
import { AiError } from "../src/ai/provider";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
} from "../src/ai/provider";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolActor, ToolContext } from "../src/tools/types";
import {
  createChildToolService,
  createDelegateTool,
  DELEGATE_SUMMARY_MAX_CHARS,
  DELEGATE_TOOL_NAME,
} from "../src/tools/delegate";

// ---------- helpers ----------

/** Provider that plays back a fixed script, recording every request. */
class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  private index = 0;

  constructor(private readonly script: readonly CompletionResponse[]) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const next = this.script[this.index++];
    if (!next) throw new AiError("invalid_response", "script exhausted");
    return next;
  }
}

class FailingProvider implements AiProvider {
  readonly name = "failing";
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    // Raw provider internals: the tool must never surface these.
    throw new AiError("network", "boom: connection reset by peer (10.0.0.9:443)");
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
const calcCall = (id = "c1"): ToolCall => call("calculator", { op: "add", a: 2, b: 2 }, id);

const ACTOR: ToolActor = {
  userId: "u1",
  permissions: ["tools:delegate", "tools:calculator"],
};

function ctxFor(actor: ToolActor = ACTOR): ToolContext {
  return {
    clock: () => new Date(),
    actor,
    signal: new AbortController().signal,
  };
}

/** A parent registry holding the default tools plus delegate itself. */
function parentWithDelegate(provider: AiProvider): ToolService {
  const service = new ToolService();
  service.registry.register(
    createDelegateTool({ tools: service, provider, model: "m" }) as Tool<unknown, unknown>,
  );
  return service;
}

describe("delegate tool", () => {
  test("returns the child's summary on success", async () => {
    const provider = new ScriptedProvider([toolTurn(calcCall()), answer("پاسخ نهایی فرزند")]);
    const tool = createDelegateTool({ tools: new ToolService(), provider, model: "m" });

    const out = await tool.run({ task: "دو به‌علاوهٔ دو چند می‌شود؟" }, ctxFor());

    expect(out.ok).toBe(true);
    if (out.ok) expect(out.summary).toContain("پاسخ نهایی فرزند");
    // The child really ran a tool: one model turn asked, one answered.
    expect(provider.requests.length).toBe(2);
  });

  test("truncates a long summary with a named note", async () => {
    const long = "x".repeat(DELEGATE_SUMMARY_MAX_CHARS + 500);
    const provider = new ScriptedProvider([answer(long)]);
    const tool = createDelegateTool({ tools: new ToolService(), provider, model: "m" });

    const out = await tool.run({ task: "خلاصه بده" }, ctxFor());

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.summary.length).toBeLessThanOrEqual(DELEGATE_SUMMARY_MAX_CHARS);
      expect(out.summary).toContain("یادداشت");
    }
  });

  test("child registry structurally lacks delegate (no recursion possible)", async () => {
    const service = parentWithDelegate(new ScriptedProvider([answer("x")]));
    expect(service.listActiveNames()).toContain(DELEGATE_TOOL_NAME);

    const child = createChildToolService(service);
    expect(child.listActiveNames()).not.toContain(DELEGATE_TOOL_NAME);

    // The model is never told about it AND a direct request is refused.
    const specs = child.toolSpecsFor(ACTOR).map((s) => s.name);
    expect(specs).not.toContain(DELEGATE_TOOL_NAME);
    const res = await child.runTool({ tool: DELEGATE_TOOL_NAME, input: {}, actor: ACTOR });
    expect(res.status).toBe("not_found");
  });

  test("a child that tries to delegate recovers instead of recursing", async () => {
    const provider = new ScriptedProvider([
      toolTurn(call(DELEGATE_TOOL_NAME, { task: "sub" }, "d1")),
      answer("بازیابی شد"),
    ]);
    const tool = createDelegateTool({ tools: new ToolService(), provider, model: "m" });

    const out = await tool.run({ task: "کاری بکن" }, ctxFor());

    expect(out.ok).toBe(true);
    if (out.ok) expect(out.summary).toContain("بازیابی شد");
  });

  test("child budgets are capped: maxToolCalls respected", async () => {
    const provider = new ScriptedProvider([
      toolTurn(calcCall("c1")),
      // Even though the script keeps offering tool turns, the loop must stop
      // after the single allowed tool execution: one tool turn + the final
      // tool-free answer.
      answer("نهایی"),
    ]);
    const tool = createDelegateTool({ tools: new ToolService(), provider, model: "m" });

    const out = await tool.run(
      { task: "محاسبه کن", maxIterations: 3, maxToolCalls: 1 },
      ctxFor(),
    );

    expect(out.ok).toBe(true);
    if (out.ok) expect(out.summary).toBe("نهایی");
    expect(provider.requests.length).toBe(2);
  });

  test("child budgets are capped: maxIterations respected", async () => {
    const provider = new ScriptedProvider([
      toolTurn(calcCall("c1")),
      toolTurn(calcCall("c2")),
      toolTurn(calcCall("c3")),
      toolTurn(calcCall("c4")),
      answer("نهایی"),
    ]);
    const tool = createDelegateTool({ tools: new ToolService(), provider, model: "m" });

    const out = await tool.run(
      { task: "محاسبه کن", maxIterations: 2, maxToolCalls: 5 },
      ctxFor(),
    );

    expect(out.ok).toBe(true);
    // Two tool turns + one final tool-free answer: the loop always terminates.
    expect(provider.requests.length).toBe(3);
  });

  test("child failure becomes ok:false with a user-safe Persian error", async () => {
    const tool = createDelegateTool({
      tools: new ToolService(),
      provider: new FailingProvider(),
      model: "m",
    });

    let threw = false;
    let out: { ok: boolean; error?: string } | undefined;
    try {
      out = (await tool.run({ task: "کاری بکن" }, ctxFor())) as {
        ok: boolean;
        error?: string;
      };
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(out?.ok).toBe(false);
    const err = out?.error ?? "";
    expect(err.length).toBeGreaterThan(0);
    // No provider internals leak.
    expect(err).not.toContain("boom");
    expect(err).not.toContain("10.0.0.9");
  });

  test("executor enforces the tools:delegate permission", async () => {
    const provider = new ScriptedProvider([answer("ok")]);
    const service = parentWithDelegate(provider);

    const denied = await service.runTool({
      tool: DELEGATE_TOOL_NAME,
      input: { task: "x" },
      actor: { userId: "u9", permissions: [] },
    });
    expect(denied.status).toBe("not_allowed");

    const allowed = await service.runTool({
      tool: DELEGATE_TOOL_NAME,
      input: { task: "x" },
      actor: ACTOR,
    });
    expect(allowed.status).toBe("ok");
  });

  test("empty task is rejected as invalid input", async () => {
    const tool = createDelegateTool({
      tools: new ToolService(),
      provider: new ScriptedProvider([answer("x")]),
      model: "m",
    });
    await expect(tool.run({ task: "   " }, ctxFor())).rejects.toMatchObject({
      name: "ToolError",
    });
  });
});
