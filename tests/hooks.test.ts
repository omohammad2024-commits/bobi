import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHookFile, loadHooksFromDir, HookCache } from "../src/hooks/loader";
import type { HookDef } from "../src/hooks/loader";
import { HookRunner, MAX_HOOKS_PER_EVENT } from "../src/hooks/runner";
import { isHookEvent, HOOK_EVENTS } from "../src/hooks/events";
import type { HookEvent, HookPayload, ToolEndPayload } from "../src/hooks/events";
import { ToolService } from "../src/tools/service";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool, ToolActor, ToolContext } from "../src/tools/types";
import { ToolError } from "../src/tools/errors";
import { FakeProvider } from "../src/ai/fake";
import type { AiProvider } from "../src/ai/provider";
import { ConversationEngine } from "../src/conversation/engine";
import type { HookRunContext } from "../src/hooks/runner";

const hookFile = (name: string, actionJson: string, notes = "notes"): string =>
  ["---", `name: ${name}`, `action: ${actionJson}`, "---", "", notes].join("\n");

const TOOL_ACTION = `{"type": "tool", "tool": "spy_tool", "input": {}}`;

// ---------- events ----------

describe("hook events", () => {
  test("isHookEvent accepts exactly the four lifecycle events", () => {
    expect(HOOK_EVENTS).toEqual(["startup", "agent:start", "agent:end", "tool:end"]);
    for (const e of HOOK_EVENTS) expect(isHookEvent(e)).toBe(true);
    expect(isHookEvent("bogus")).toBe(false);
    expect(isHookEvent("")).toBe(false);
  });
});

// ---------- parseHookFile ----------

describe("parseHookFile", () => {
  test("parses a well-formed hook with a tool action", () => {
    const r = parseHookFile(hookFile("warmup-clock", TOOL_ACTION), "f.md", "startup");
    expect(r.skipped).toBeUndefined();
    expect(r.hook?.name).toBe("warmup-clock");
    expect(r.hook?.event).toBe("startup");
    expect(r.hook?.action).toEqual({ type: "tool", tool: "spy_tool", input: {} });
    expect(r.hook?.source).toBe("f.md");
  });

  test("accepts a multi-line JSON action", () => {
    const text = [
      "---",
      "name: multi",
      "action: {",
      '  "type": "tool",',
      '  "tool": "spy_tool",',
      '  "input": {"a": 1}',
      "}",
      "---",
      "notes",
    ].join("\n");
    const r = parseHookFile(text, "f.md", "tool:end");
    expect(r.skipped).toBeUndefined();
    expect(r.hook?.action).toEqual({ type: "tool", tool: "spy_tool", input: { a: 1 } });
  });

  test("missing name is skipped, never throws", () => {
    const r = parseHookFile(`---\naction: ${TOOL_ACTION}\n---\nnotes`, "f.md", "startup");
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("name");
  });

  test("missing action is skipped", () => {
    const r = parseHookFile("---\nname: x\n---\nbody", "f.md", "startup");
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("action");
  });

  test("non-JSON action is skipped", () => {
    const r = parseHookFile(hookFile("x", "{not json"), "f.md", "startup");
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("JSON");
  });

  test("message actions are rejected: hooks have no chat target", () => {
    const r = parseHookFile(
      hookFile("x", `{"type": "message", "chatId": "1", "text": "hi"}`),
      "f.md",
      "startup",
    );
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("message");
  });

  test("agent actions are rejected", () => {
    const r = parseHookFile(
      hookFile("x", `{"type": "agent", "chatId": "1", "prompt": "hi"}`),
      "f.md",
      "startup",
    );
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("agent");
  });

  test("schedule_task actions are rejected by parseTaskAction (no nested tasks)", () => {
    const r = parseHookFile(
      hookFile("x", `{"type": "tool", "tool": "schedule_task", "input": {}}`),
      "f.md",
      "startup",
    );
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("invalid action");
  });

  test("unknown tool names pass parse; the Executor refuses them at runtime", () => {
    const r = parseHookFile(
      hookFile("x", `{"type": "tool", "tool": "no_such_tool", "input": {}}`),
      "f.md",
      "startup",
    );
    expect(r.hook?.action.tool).toBe("no_such_tool");
  });

  test("non-kebab-case name is skipped", () => {
    const r = parseHookFile(hookFile("Bad_Name", TOOL_ACTION), "f.md", "startup");
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("kebab-case");
  });

  test("unclosed frontmatter is skipped", () => {
    const r = parseHookFile("---\nname: x\naction: {}", "f.md", "startup");
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("unclosed");
  });

  test("bad tool input shape is rejected via parseTaskAction", () => {
    const r = parseHookFile(
      hookFile("x", `{"type": "tool", "tool": "spy_tool", "input": [1]}`),
      "f.md",
      "startup",
    );
    expect(r.hook).toBeUndefined();
    expect(r.skipped).toContain("invalid action");
  });
});

// ---------- loadHooksFromDir + HookCache ----------

describe("loadHooksFromDir", () => {
  let dir: string;
  const warnings: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hooks-"));
    warnings.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = () => ({ warn: (m: string) => warnings.push(m) });

  test("loads hooks from <event>/ subdirectories, sorted", () => {
    mkdirSync(join(dir, "startup"), { recursive: true });
    mkdirSync(join(dir, "tool:end"), { recursive: true });
    writeFileSync(join(dir, "startup", "b.md"), hookFile("b-hook", TOOL_ACTION));
    writeFileSync(join(dir, "startup", "a.md"), hookFile("a-hook", TOOL_ACTION));
    writeFileSync(join(dir, "tool:end", "z.md"), hookFile("z-hook", TOOL_ACTION));
    const hooks = loadHooksFromDir(dir, opts());
    expect(hooks.map((h) => `${h.event}/${h.name}`)).toEqual([
      "startup/a-hook",
      "startup/b-hook",
      "tool:end/z-hook",
    ]);
    expect(hooks[0]!.source).toContain("a.md");
  });

  test("unknown event directories are skipped with a warning, never fatal", () => {
    mkdirSync(join(dir, "explode"), { recursive: true });
    writeFileSync(join(dir, "explode", "x.md"), hookFile("x", TOOL_ACTION));
    const hooks = loadHooksFromDir(dir, opts());
    expect(hooks).toEqual([]);
    expect(warnings.some((w) => w.includes("unknown hook event"))).toBe(true);
  });

  test("missing root directory is not an error", () => {
    expect(loadHooksFromDir(join(dir, "nope"), opts())).toEqual([]);
  });

  test("hidden files and non-md files are ignored", () => {
    mkdirSync(join(dir, "startup"), { recursive: true });
    writeFileSync(join(dir, "startup", ".hidden.md"), hookFile("hidden", TOOL_ACTION));
    writeFileSync(join(dir, "startup", "notes.txt"), hookFile("txt", TOOL_ACTION));
    expect(loadHooksFromDir(dir, opts())).toEqual([]);
  });
});

describe("HookCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hookcache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reloads when an event subdirectory mtime changes", () => {
    mkdirSync(join(dir, "startup"), { recursive: true });
    const cache = new HookCache(dir, { warn: () => {} });
    writeFileSync(join(dir, "startup", "one.md"), hookFile("one", TOOL_ACTION));
    expect(cache.hooks().map((h) => h.name)).toEqual(["one"]);

    writeFileSync(join(dir, "startup", "two.md"), hookFile("two", TOOL_ACTION));
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, "startup"), future, future);
    expect(cache.hooks().map((h) => h.name)).toEqual(["one", "two"]);
  });

  test("missing root caches empty", () => {
    const cache = new HookCache(join(dir, "nope"));
    expect(cache.hooks()).toEqual([]);
  });
});

// ---------- HookRunner ----------

/** A tool that records the actor it ran as; optionally throws. */
function makeSpyTool(seen: ToolActor[], opts: { throws?: boolean } = {}): Tool<unknown, unknown> {
  return {
    name: "spy_tool",
    description: "test spy",
    enabled: true,
    permission: { requires: [] },
    input: { fields: {} },
    async run(_input: unknown, ctx: ToolContext): Promise<unknown> {
      seen.push(ctx.actor);
      if (opts.throws === true) throw new ToolError("internal", "boom");
      return { ok: true };
    },
  } as unknown as Tool<unknown, unknown>;
}

const hookDef = (name: string, event: HookEvent, tool = "spy_tool"): HookDef => ({
  name,
  event,
  action: { type: "tool", tool, input: {} },
  source: `${name}.md`,
});

const startupPayload = (extra: Record<string, unknown> = {}): HookPayload => ({
  event: "startup",
  at: new Date().toISOString(),
  ...extra,
});

describe("HookRunner", () => {
  test("runs hook tool actions with the triggering turn's actor (same-actor, no escalation)", async () => {
    const seen: ToolActor[] = [];
    const svc = new ToolService({ extraTools: [makeSpyTool(seen)] });
    const runner = new HookRunner({
      extraHooks: [hookDef("h", "agent:start")],
      warn: () => {},
    });
    const turnActor: ToolActor = { userId: "user-2", permissions: [] };
    await runner.runHooks(
      "agent:start",
      { event: "agent:start", at: new Date().toISOString(), conversationId: "c", userId: "user-2", userTextLength: 5, hasAttachments: false, model: "m" },
      { tools: svc, actor: turnActor },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(turnActor);
    expect(seen[0]!.userId).toBe("user-2");
  });

  test("startup runs with the explicitly-passed owner actor", async () => {
    const seen: ToolActor[] = [];
    const svc = new ToolService({ extraTools: [makeSpyTool(seen)] });
    const runner = new HookRunner({ extraHooks: [hookDef("h", "startup")], warn: () => {} });
    const owner: ToolActor = { userId: "owner-1", permissions: ["tools:spy_tool"] };
    await runner.runHooks("startup", startupPayload(), { tools: svc, actor: owner });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.userId).toBe("owner-1");
  });

  test("one failing hook does not stop the others, and runHooks never throws", async () => {
    const seen: ToolActor[] = [];
    const svc = new ToolService({ extraTools: [makeSpyTool(seen, { throws: true })] });
    const warnings: string[] = [];
    const runner = new HookRunner({
      extraHooks: [
        hookDef("a-fails", "tool:end"),
        // Unknown tool: the Executor refuses it with not_found; still isolated.
        hookDef("b-unknown-tool", "tool:end", "no_such_tool"),
      ],
      warn: (m) => warnings.push(m),
    });
    const payload: HookPayload = {
      event: "tool:end",
      at: new Date().toISOString(),
      tool: "calculator",
      status: "ok",
      durationMs: 3,
      userId: "u",
    };
    await runner.runHooks("tool:end", payload, {
      tools: svc,
      actor: { userId: "u", permissions: [] },
    });
    expect(seen).toHaveLength(1); // the throwing hook ran
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("a rejecting execute() is isolated too", async () => {
    const warnings: string[] = [];
    const runner = new HookRunner({
      extraHooks: [hookDef("a", "startup"), hookDef("b", "startup")],
      warn: (m) => warnings.push(m),
    });
    let calls = 0;
    const badTools = {
      execute: async () => {
        calls++;
        throw new Error("executor exploded");
      },
    } as unknown as ToolService;
    await runner.runHooks("startup", startupPayload(), {
      tools: badTools,
      actor: { userId: "u", permissions: [] },
    });
    expect(calls).toBe(2);
    expect(warnings.some((w) => w.includes("threw"))).toBe(true);
  });

  test(`at most ${MAX_HOOKS_PER_EVENT} hooks run per event`, async () => {
    const seen: ToolActor[] = [];
    const svc = new ToolService({ extraTools: [makeSpyTool(seen)] });
    const warnings: string[] = [];
    const hooks = Array.from({ length: 7 }, (_, i) => hookDef(`h${i}`, "agent:end"));
    const runner = new HookRunner({ extraHooks: hooks, warn: (m) => warnings.push(m) });
    await runner.runHooks(
      "agent:end",
      {
        event: "agent:end",
        at: new Date().toISOString(),
        conversationId: "c",
        durationMs: 1,
        toolCalls: 0,
        ok: true,
      },
      { tools: svc, actor: { userId: "u", permissions: [] } },
    );
    expect(seen).toHaveLength(MAX_HOOKS_PER_EVENT);
    expect(warnings.some((w) => w.includes("too many hooks"))).toBe(true);
  });

  test("hook-triggered executions do not emit tool:end (no re-entrant storms)", async () => {
    const seen: ToolActor[] = [];
    const emissions: ToolEndPayload[] = [];
    const svc = new ToolService({
      extraTools: [makeSpyTool(seen)],
      onToolEnd: (payload) => emissions.push(payload),
    });
    const runner = new HookRunner({ extraHooks: [hookDef("h", "startup")], warn: () => {} });
    await runner.runHooks("startup", startupPayload(), {
      tools: svc,
      actor: { userId: "u", permissions: [] },
    });
    expect(seen).toHaveLength(1); // the hook's tool ran
    expect(emissions).toHaveLength(0); // ...but emitted nothing

    // A direct execution still emits.
    await svc.execute({ tool: "spy_tool", input: {}, actor: { userId: "u", permissions: [] } });
    expect(emissions).toHaveLength(1);
    expect(emissions[0]!.tool).toBe("spy_tool");
  });

  test("without a tool service, hooks are skipped with a warning, never throw", async () => {
    const warnings: string[] = [];
    const runner = new HookRunner({
      extraHooks: [hookDef("h", "startup")],
      warn: (m) => warnings.push(m),
    });
    await runner.runHooks("startup", startupPayload(), {
      actor: { userId: "u", permissions: [] },
    });
    expect(warnings.some((w) => w.includes("no tool service"))).toBe(true);
  });

  test("duplicate (event, name) keeps the first source", async () => {
    const seen: ToolActor[] = [];
    const svc = new ToolService({ extraTools: [makeSpyTool(seen)] });
    const warnings: string[] = [];
    const runner = new HookRunner({
      extraHooks: [hookDef("dup", "startup"), { ...hookDef("dup", "startup"), source: "other.md" }],
      warn: (m) => warnings.push(m),
    });
    expect(runner.defsFor("startup")).toHaveLength(1);
    expect(warnings.some((w) => w.includes("duplicate hook"))).toBe(true);
    await runner.runHooks("startup", startupPayload(), {
      tools: svc,
      actor: { userId: "u", permissions: [] },
    });
    expect(seen).toHaveLength(1);
  });

  test("payload/event mismatch is refused with a warning", async () => {
    const warnings: string[] = [];
    const runner = new HookRunner({
      extraHooks: [hookDef("h", "startup")],
      warn: (m) => warnings.push(m),
    });
    const svc = new ToolService({ extraTools: [makeSpyTool([])] });
    await runner.runHooks("agent:start", startupPayload(), {
      tools: svc,
      actor: { userId: "u", permissions: [] },
    });
    expect(warnings.some((w) => w.includes("mismatch"))).toBe(true);
  });
});

// ---------- tool:end emission from the Executor ----------

describe("tool:end emission", () => {
  test("every execution emits a secret-free payload; never input/output contents", async () => {
    const emissions: Array<{ payload: ToolEndPayload; actor: ToolActor }> = [];
    const svc = new ToolService({
      onToolEnd: (payload, actor) => emissions.push({ payload, actor }),
    });
    const actor: ToolActor = {
      userId: "user-1",
      permissions: ["tools:calculator"],
    };
    const result = await svc.runTool({
      tool: "calculator",
      input: { op: "add", a: 424242, b: 111 },
      actor,
    });
    expect(result.status).toBe("ok");
    expect(emissions).toHaveLength(1);
    const { payload, actor: emittedActor } = emissions[0]!;
    expect(payload.event).toBe("tool:end");
    expect(payload.tool).toBe("calculator");
    expect(payload.status).toBe("ok");
    expect(payload.userId).toBe("user-1");
    expect(typeof payload.durationMs).toBe("number");
    expect(typeof payload.at).toBe("string");
    // Privacy: the payload carries no input/output contents, only metadata.
    expect(Object.keys(payload).sort()).toEqual(
      ["at", "durationMs", "event", "status", "tool", "userId"].sort(),
    );
    expect(JSON.stringify(payload)).not.toContain("424242");
    // The same actor the tool ran as is handed to the observer.
    expect(emittedActor).toBe(actor);
  });

  test("failed executions emit too (status reflects the failure)", async () => {
    const emissions: ToolEndPayload[] = [];
    const svc = new ToolService({ onToolEnd: (p) => emissions.push(p) });
    const r = await svc.runTool({
      tool: "no_such_tool",
      input: {},
      actor: { userId: "u", permissions: [] },
    });
    expect(r.status).toBe("not_found");
    expect(emissions).toHaveLength(1);
    expect(emissions[0]!.status).toBe("not_found");
  });

  test("a throwing onToolEnd observer never breaks the tool call", async () => {
    const svc = new ToolService({
      onToolEnd: () => {
        throw new Error("observer boom");
      },
    });
    const r = await svc.runTool({
      tool: "calculator",
      input: { op: "add", a: 1, b: 2 },
      actor: { userId: "u", permissions: ["tools:calculator"] },
    });
    expect(r.status).toBe("ok");
  });

  test("ToolExecutor without onToolEnd behaves exactly as before", async () => {
    const svc = new ToolService();
    const r = await svc.runTool({
      tool: "calculator",
      input: { op: "add", a: 1, b: 2 },
      actor: { userId: "u", permissions: ["tools:calculator"] },
    });
    expect(r.status).toBe("ok");
    expect((r.data as { result: number }).result).toBe(3);
  });
});

// ---------- agent:start / agent:end emission from the engine ----------

describe("engine hook emission", () => {
  const makeEngine = (
    hooks: {
      runHooks: (event: HookEvent, payload: HookPayload, ctx: HookRunContext) => Promise<void>;
    },
    provider: AiProvider = new FakeProvider(),
  ) =>
    new ConversationEngine({
      provider,
      model: "fake-echo",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      summariseHistory: false,
      hooks,
    });

  test("agent:start and agent:end fire around a turn with secret-free payloads", async () => {
    const calls: Array<{ event: HookEvent; payload: HookPayload; actor: ToolActor }> = [];
    const engine = makeEngine({
      runHooks: async (event, payload, ctx) => {
        calls.push({ event, payload, actor: (ctx as { actor: ToolActor }).actor });
      },
    });
    const userText = "سلام دنیا"; // must never appear in a payload
    const out = await engine.respond({
      conversationId: "c1",
      userText,
      actor: { userId: "user-9", permissions: [] },
    });
    expect(out.chunks.length).toBe(1);
    expect(calls.map((c) => c.event)).toEqual(["agent:start", "agent:end"]);

    const start = calls[0]!.payload;
    expect(start.event).toBe("agent:start");
    if (start.event === "agent:start") {
      expect(start.conversationId).toBe("c1");
      expect(start.userId).toBe("user-9");
      expect(start.userTextLength).toBe(userText.length);
      expect(start.hasAttachments).toBe(false);
    }
    const end = calls[1]!.payload;
    expect(end.event).toBe("agent:end");
    if (end.event === "agent:end") {
      expect(end.ok).toBe(true);
      expect(typeof end.durationMs).toBe("number");
    }
    // Privacy: message text appears in no payload, only its length.
    for (const c of calls) {
      expect(JSON.stringify(c.payload)).not.toContain(userText);
      expect(c.actor.userId).toBe("user-9");
    }
  });

  test("agent:end reports ok:false when the turn fails after agent:start", async () => {
    const calls: HookPayload[] = [];
    // A provider that fails mid-turn: agent:start fires, then the turn throws.
    const failing: AiProvider = {
      name: "failing",
      complete: async () => {
        throw new Error("provider down");
      },
    };
    const engine = makeEngine(
      {
        runHooks: async (_event, payload) => {
          calls.push(payload);
        },
      },
      failing,
    );
    await expect(engine.respond({ conversationId: "c1", userText: "سلام" })).rejects.toThrow();
    expect(calls.map((p) => p.event)).toEqual(["agent:start", "agent:end"]);
    const end = calls[1]!;
    expect(end.event).toBe("agent:end");
    if (end.event === "agent:end") expect(end.ok).toBe(false);
  });

  test("a throwing hook runner never breaks the turn", async () => {
    const engine = makeEngine({
      runHooks: async () => {
        throw new Error("hooks exploded");
      },
    });
    const out = await engine.respond({ conversationId: "c1", userText: "سلام" });
    expect(out.chunks.length).toBe(1);
  });

  test("no hooks configured: engine behaves exactly as before", async () => {
    const engine = new ConversationEngine({
      provider: new FakeProvider(),
      model: "fake-echo",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      summariseHistory: false,
    });
    const out = await engine.respond({ conversationId: "c1", userText: "سلام" });
    expect(out.chunks[0]).toContain("آزمایشی بابی");
  });
});
