/**
 * Agent Brain tests: parallel execution, self-correction retries, loop
 * detection, and planning mode. Uses the ScriptedProvider pattern from
 * agent_loop.test.ts and fake tools registered via ToolService extraTools.
 *
 * Env switches are read in the AgentLoop constructor, so each test that
 * changes behaviour sets process.env BEFORE constructing the loop and cleans
 * up after itself.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { AgentLoop } from "../src/agent/loop";
import type { ToolCall } from "../src/ai/provider";
import type { CompletionResponse, AiProvider } from "../src/ai/provider";
import { AiError } from "../src/ai/provider";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolActor, ToolRunResult } from "../src/tools/types";
import { looksMultiTask, parsePlan, shouldPlan } from "../src/agent/planner";
import { isWriteLikeTool, mapBounded } from "../src/agent/parallelism";

// ---------- helpers ----------

const ACTOR: ToolActor = { userId: "u1", permissions: [] };
const SIG = new AbortController().signal;

class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: { messages: unknown[]; maxTokens?: number }[] = [];
  private index = 0;
  constructor(private readonly script: readonly CompletionResponse[]) {}
  async complete(req: {
    messages: readonly unknown[];
    model: string;
    maxTokens?: number;
  }): Promise<CompletionResponse> {
    this.requests.push({
      messages: [...req.messages],
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    });
    const next = this.script[this.index++];
    if (!next) throw new AiError("invalid_response", "script exhausted");
    return next;
  }
}

const answer = (text: string): CompletionResponse => ({ text, model: "m" });
const toolTurn = (...calls: ToolCall[]): CompletionResponse => ({ text: "", model: "m", toolCalls: calls });
const call = (name: string, args: unknown, id: string): ToolCall => ({ id, name, arguments: args });

/** Fake tool whose run is a programmable function, with timing + order trace. */
interface FakeToolOpts {
  name: string;
  description: string;
  run: (input: unknown) => Promise<string> | string;
}
function fakeTool(opts: FakeToolOpts): Tool<unknown, string> {
  return {
    name: opts.name,
    description: opts.description,
    enabled: true,
    permission: { requires: [] },
    // The tests pass small argument objects; declare the fields they use or
    // the Executor (correctly) refuses the call as invalid_input.
    input: {
      fields: {
        q: { type: "string" },
        n: { type: "integer" },
        op: { type: "string" },
        t: { type: "string" },
      },
    },
    async run(input: unknown): Promise<string> {
      return opts.run(input);
    },
  };
}

function toolsOf(...tools: Tool<unknown, unknown>[]): ToolService {
  return new ToolService({ extraTools: tools as Tool<unknown, unknown>[] });
}

function makeLoop(
  provider: ScriptedProvider,
  tools: ToolService,
  budgets?: { maxIterations?: number; maxToolCalls?: number; totalTimeoutMs?: number },
) {
  return new AgentLoop({
    provider,
    model: "m",
    tools,
    callTimeoutMs: 5_000,
    ...(budgets !== undefined ? { budgets } : {}),
  });
}

function runInput(messages: readonly { role: string; content: string }[] = [{ role: "user", content: "go" }]) {
  return {
    messages: messages as Parameters<AgentLoop["run"]>[0]["messages"],
    systemPrompt: "sys",
    actor: ACTOR,
    signal: SIG,
  };
}

function toolBodies(provider: ScriptedProvider, turn = 1): string[] {
  const req = provider.requests[turn]!;
  return req.messages
    .filter((m): m is { role: string; content: string } => (m as { role: string }).role === "tool")
    .map((m) => m.content);
}

afterEach(() => {
  delete process.env.BOBI_AGENT_PARALLEL;
  delete process.env.BOBI_AGENT_PLANNING;
  delete process.env.BOBI_AGENT_MAX_PARALLEL;
  delete process.env.BOBI_AGENT_MAX_ITERATIONS;
  delete process.env.BOBI_AGENT_MAX_TOOL_CALLS;
});

// ---------- parallelism ----------

describe("parallelism heuristic", () => {
  test("write-like tools are sequential, read-only ones parallel", () => {
    expect(isWriteLikeTool({ name: "remember", description: "store a fact" })).toBe(true);
    expect(isWriteLikeTool({ name: "remind_at", description: "schedule a reminder" })).toBe(true);
    expect(isWriteLikeTool({ name: "generate_image", description: "generate an image" })).toBe(true);
    expect(isWriteLikeTool({ name: "shortcut_add", description: "add a shortcut" })).toBe(true);
    expect(isWriteLikeTool({ name: "calculator", description: "calculate" })).toBe(false);
    expect(isWriteLikeTool({ name: "fetch_url", description: "fetch a page and read it" })).toBe(false);
    expect(isWriteLikeTool({ name: "web_search", description: "search the web" })).toBe(false);
    // A read tool whose description mentions a write verb leans sequential
    // (false positive is the safe direction).
    expect(isWriteLikeTool({ name: "recall", description: "fetch and read stored facts" })).toBe(false);
  });

  test("mapBounded preserves order and bounds concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await mapBounded([0, 1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : -1))).toEqual([0, 10, 20, 30, 40, 50]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2); // the bound is actually exercised
  });
});

describe("parallel tool execution in the loop", () => {
  test("independent read calls overlap; order is preserved in feedback", async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) =>
      fakeTool({
        name,
        description: `slow ${name}`,
        run: async () => {
          order.push(`start:${name}`);
          await new Promise((r) => setTimeout(r, ms));
          order.push(`end:${name}`);
          return `data-${name}`;
        },
      });
    // "add_note" is write-like (note token) → runs alone after the read batch.
    const note = fakeTool({
      name: "add_note",
      description: "save a note",
      run: async () => {
        order.push("start:add_note");
        return "saved";
      },
    });
    const allTools = toolsOf(
      slow("slow_a", 30),
      slow("slow_b", 30),
      slow("slow_c", 30),
      note as unknown as Tool<unknown, string>,
    );

    const provider = new ScriptedProvider([
      toolTurn(
        call("slow_a", {}, "c1"),
        call("slow_b", {}, "c2"),
        call("slow_c", {}, "c3"),
        call("add_note", { t: "x" }, "c4"),
      ),
      answer("done"),
    ]);
    const loop = makeLoop(provider, allTools);
    const result = await runInput_();
    const res = await loop.run(result);

    expect(res.stopReason).toBe("answered");
    expect(res.toolCallsExecuted).toBe(4);

    // The three reads overlapped (all started before any finished), and the
    // write ran after they all completed.
    expect(order.indexOf("start:slow_a")).toBeLessThan(order.indexOf("end:slow_a"));
    expect(order.indexOf("start:slow_b")).toBeLessThan(order.indexOf("end:slow_b"));
    expect(order.indexOf("start:slow_c")).toBeLessThan(order.indexOf("end:slow_c"));
    const readsDone = Math.max(
      order.indexOf("end:slow_a"),
      order.indexOf("end:slow_b"),
      order.indexOf("end:slow_c"),
    );
    expect(order.indexOf("start:add_note")).toBeGreaterThan(readsDone);

    // Feedback order matches the original call order.
    const bodies = toolBodies(provider);
    expect(bodies.length).toBe(4);
    expect(bodies[0]).toContain("data-slow_a");
    expect(bodies[1]).toContain("data-slow_b");
    expect(bodies[2]).toContain("data-slow_c");
    expect(bodies[3]).toContain("saved");
  });

  test("BOBI_AGENT_PARALLEL=0 forces sequential execution", async () => {
    process.env.BOBI_AGENT_PARALLEL = "0";
    const order: string[] = [];
    const slow = (name: string) =>
      fakeTool({
        name,
        description: `slow ${name}`,
        run: async () => {
          order.push(`start:${name}`);
          await new Promise((r) => setTimeout(r, 10));
          order.push(`end:${name}`);
          return `data-${name}`;
        },
      });
    const tools = toolsOf(slow("seq_a"), slow("seq_b"));
    const provider = new ScriptedProvider([
      toolTurn(call("seq_a", {}, "c1"), call("seq_b", {}, "c2")),
      answer("done"),
    ]);
    const res = await makeLoop(provider, tools).run(runInput_());
    expect(res.toolCallsExecuted).toBe(2);
    // Strictly sequential: b starts only after a ends.
    expect(order).toEqual(["start:seq_a", "end:seq_a", "start:seq_b", "end:seq_b"]);
  });

  function runInput_() {
    return runInput();
  }
});

// ---------- self-correction / retry budget ----------

describe("self-correction", () => {
  test("a failed call carries a retry hint; the retry succeeds", async () => {
    let calls = 0;
    const flaky = fakeTool({
      name: "flaky_calc",
      description: "sometimes fails",
      run: () => {
        calls++;
        if (calls === 1) throw new Error("boom"); // Executor → status=error? (see below)
        return "42";
      },
    });
    const tools = toolsOf(flaky as unknown as Tool<unknown, string>);
    const provider = new ScriptedProvider([
      toolTurn(call("flaky_calc", { op: "x" }, "c1")),
      toolTurn(call("flaky_calc", { op: "x" }, "c2")),
      answer("got 42"),
    ]);
    const res = await makeLoop(provider, tools).run(runInput());

    expect(res.toolCallsExecuted).toBe(2);
    const firstBodies = toolBodies(provider, 1);
    // The failure carries the one-line retry hint.
    expect(firstBodies[0]).toContain("status=error");
    expect(firstBodies[0]).toContain("hint:");
  });

  test("retry budget: a perpetually failing identical call is exhausted after 3 attempts", async () => {
    let calls = 0;
    const bad = fakeTool({
      name: "bad_calc",
      description: "always errors",
      run: () => {
        calls++;
        throw new Error("always fails");
      },
    });
    const tools = toolsOf(bad as unknown as Tool<unknown, string>);
    // The model keeps asking the identical call across 4 turns.
    const provider = new ScriptedProvider([
      toolTurn(call("bad_calc", { op: "x" }, "c1")),
      toolTurn(call("bad_calc", { op: "x" }, "c2")),
      toolTurn(call("bad_calc", { op: "x" }, "c3")),
      toolTurn(call("bad_calc", { op: "x" }, "c4")),
      toolTurn(call("bad_calc", { op: "x" }, "c5")),
      answer("giving up"),
    ]);
    const res = await makeLoop(provider, tools).run(runInput());

    // 1 initial + 2 retries = 3 executions, the 4th+ get the exhausted note.
    expect(calls).toBe(3);
    expect(res.toolCallsExecuted).toBe(3);
    // Requests accumulate transcript: the turn's own feedback is the LAST tool message.
    const turn4Bodies = toolBodies(provider, 4);
    expect(turn4Bodies.at(-1)).toContain("retry budget is exhausted");
    const turn5Bodies = toolBodies(provider, 5);
    expect(turn5Bodies.at(-1)).toContain("retry budget is exhausted");
  });

  test("an empty ok result carries the hint too", async () => {
    // A tool that succeeds but returns nothing is indistinguishable from a
    // miss to the model; it gets the same one-line nudge.
    const empty = fakeTool({
      name: "empty_tool",
      description: "returns nothing",
      run: () => "",
    });
    const tools = toolsOf(empty as unknown as Tool<unknown, string>);
    const provider = new ScriptedProvider([
      toolTurn(call("empty_tool", {}, "c1")),
      answer("fine"),
    ]);
    const res = await makeLoop(provider, tools).run(runInput());
    expect(res.toolCallsExecuted).toBe(1);
    expect(toolBodies(provider, 1)[0]).toContain("hint:");
  });
});

// ---------- loop detection ----------

describe("loop awareness", () => {
  test("2nd identical successful call is short-circuited with a note", async () => {
    let calls = 0;
    const probe = fakeTool({
      name: "probe_tool",
      description: "probe",
      run: () => {
        calls++;
        return "result-data";
      },
    });
    const tools = toolsOf(probe as unknown as Tool<unknown, string>);
    const provider = new ScriptedProvider([
      toolTurn(call("probe_tool", { q: "a" }, "c1")),
      toolTurn(call("probe_tool", { q: "a" }, "c2")),
      answer("done"),
    ]);
    const res = await makeLoop(provider, tools).run(runInput());
    expect(calls).toBe(1); // second was cached, not executed
    expect(res.toolCallsExecuted).toBe(1);
    expect(toolBodies(provider, 2).at(-1)).toContain("repeated call");
    expect(toolBodies(provider, 2).at(-1)).toContain("result-data");
  });

  test("3rd identical successful call breaks the loop gracefully", async () => {
    let calls = 0;
    const probe = fakeTool({
      name: "probe_tool",
      description: "probe",
      run: () => {
        calls++;
        return "the-payload";
      },
    });
    const tools = toolsOf(probe as unknown as Tool<unknown, string>);
    const provider = new ScriptedProvider([
      toolTurn(call("probe_tool", { q: "a" }, "c1")),
      toolTurn(call("probe_tool", { q: "a" }, "c2")),
      toolTurn(call("probe_tool", { q: "a" }, "c3")),
      answer("never reached"),
    ]);
    const res = await makeLoop(provider, tools).run(runInput());
    expect(calls).toBe(1);
    expect(res.stopReason).toBe("loop_detected");
    expect(res.text).toContain("I ran into a loop on probe_tool");
    expect(res.text).toContain("the-payload");
  });
});

// ---------- planning mode ----------

describe("planning heuristics", () => {
  test("looksMultiTask fires on numbered steps and multiple imperatives", () => {
    expect(looksMultiTask("1. Search the web\n2. Summarize the results")).toBe(true);
    expect(looksMultiTask("Send the report. Then schedule a reminder.")).toBe(true);
    expect(looksMultiTask("بفرست گزارشو. بعد یه یادآوری بزن.")).toBe(true);
    expect(looksMultiTask("hi")).toBe(false);
    expect(looksMultiTask("what time is it?")).toBe(false);
  });

  test("shouldPlan needs multi-task structure AND history >= 3", () => {
    const multi = "1. do this\n2. do that";
    expect(shouldPlan(multi, 3)).toBe(true);
    expect(shouldPlan(multi, 2)).toBe(false);
    expect(shouldPlan("hi", 5)).toBe(false);
  });

  test("parsePlan accepts a JSON array and rejects junk", () => {
    expect(parsePlan('["Search flights", "Book the cheapest"]')).toEqual([
      "Search flights",
      "Book the cheapest",
    ]);
    expect(parsePlan('```json\n["a", "b"]\n```')).toEqual(["a", "b"]);
    expect(parsePlan("not json")).toBeNull();
    expect(parsePlan('{"a": 1}')).toBeNull();
    expect(parsePlan("[]")).toBeNull();
    // Caps at 5 steps and 12 words per step.
    const many = JSON.stringify(["s1", "s2", "s3", "s4", "s5", "s6"]);
    expect(parsePlan(many)!.length).toBe(5);
    const long = JSON.stringify(["w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14"]);
    expect(parsePlan(long)![0]!.split(" ").length).toBe(12);
  });
});

describe("planning mode in the loop", () => {
  const history = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hey" },
    { role: "user", content: "ok" },
    { role: "assistant", content: "sure" },
    { role: "user", content: "1. Search the web for X\n2. Summarize what you find" },
  ];

  test("multi-step request triggers a plan call before the first iteration", async () => {
    const provider = new ScriptedProvider([
      { text: '["Search the web for X", "Summarize findings"]', model: "m" },
      answer("summary"),
    ]);
    const res = await makeLoop(provider, toolsOf()).run(runInput(history));

    // The plan call is tool-free and has the small token cap.
    const planReq = provider.requests[0]!;
    expect(planReq.maxTokens).toBe(128);
    expect(res.stopReason).toBe("answered");
    const steps = res.steps;
    const planStart = steps.find((s) => s.kind === "plan" && s.completed === false);
    const planDone = steps.find((s) => s.kind === "plan" && s.completed === true);
    expect(planStart).toBeDefined();
    expect(planDone).toBeDefined();
    // The plan rides in the system message of the real call.
    const realReq = provider.requests[1]!;
    const sys = realReq.messages[0] as { content: string };
    expect(sys.content).toContain("<plan>");
    expect(sys.content).toContain("Search the web for X");
  });

  test("'hi' skips planning even with history", async () => {
    const provider = new ScriptedProvider([answer("hey there")]);
    const res = await makeLoop(provider, toolsOf()).run(
      runInput([...history.slice(0, 4), { role: "user", content: "hi" }]),
    );
    expect(provider.requests.length).toBe(1);
    expect(res.steps.some((s) => s.kind === "plan")).toBe(false);
  });

  test("BOBI_AGENT_PLANNING=0 disables planning for multi-step requests", async () => {
    process.env.BOBI_AGENT_PLANNING = "0";
    const provider = new ScriptedProvider([answer("summary")]);
    const res = await makeLoop(provider, toolsOf()).run(runInput(history));
    expect(provider.requests.length).toBe(1);
    expect(res.steps.some((s) => s.kind === "plan")).toBe(false);
  });

  test("an unparsable plan answer proceeds without planning", async () => {
    const provider = new ScriptedProvider([
      { text: "Sure, here is my plan: first I will…", model: "m" },
      answer("summary"),
    ]);
    const res = await makeLoop(provider, toolsOf()).run(runInput(history));
    expect(res.stopReason).toBe("answered");
    expect(res.steps.some((s) => s.kind === "plan")).toBe(false);
  });
});

// ---------- budget plumbing ----------

describe("budget plumbing", () => {
  test("caller budgets are honoured exactly (env is handled upstream in config)", async () => {
    // BOBI_AGENT_MAX_TOOL_CALLS is read by src/config/config.ts via envVar()
    // and wired into engine budgets by src/index.ts — the loop must not
    // double-apply it, so an explicit caller budget always wins here.
    const probe = fakeTool({ name: "probe_tool", description: "probe", run: () => "x" });
    const tools = toolsOf(probe as unknown as Tool<unknown, string>);
    const provider = new ScriptedProvider([
      toolTurn(
        call("probe_tool", { n: 1 }, "c1"),
        call("probe_tool", { n: 2 }, "c2"),
        call("probe_tool", { n: 3 }, "c3"),
      ),
      answer("partial"),
    ]);
    const res = await makeLoop(provider, tools, { maxToolCalls: 2 }).run(runInput());
    expect(res.toolCallsExecuted).toBe(2);
    const bodies = toolBodies(provider, 1);
    expect(bodies[2]).toContain("budget exhausted");
  });

  test("config reads BOBI_AGENT_MAX_TOOL_CALLS through the envVar pattern", async () => {
    const { loadConfig } = await import("../src/config/config");
    delete process.env.BOBI_AGENT_MAX_TOOL_CALLS;
    expect(loadConfig().agentMaxToolCalls).toBe(12);
    process.env.BOBI_AGENT_MAX_TOOL_CALLS = "7";
    expect(loadConfig().agentMaxToolCalls).toBe(7);
    delete process.env.BOBI_AGENT_MAX_TOOL_CALLS;
  });
});
