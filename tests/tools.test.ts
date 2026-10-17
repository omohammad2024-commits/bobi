import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../src/tools/registry";
import { ToolExecutor } from "../src/tools/executor";
import { ToolError } from "../src/tools/errors";
import type { Tool, ToolActor, ToolContext } from "../src/tools/types";

// ---------- helpers ----------

const op = (name: string, out: string): Tool<{ x?: number }, string> => ({
  name,
  description: `tool ${name}`,
  enabled: true,
  permission: { requires: [`tools:${name}`] },
  input: { fields: { x: { type: "number" } } },
  async run(): Promise<string> {
    await new Promise((r) => setTimeout(r, 5));
    return out;
  },
});

/** Records whether it ran, so tests can PROVE an unauthorized call never executed. */
const spy = (name: string, enabled = true) => {
  let calls = 0;
  const tool: Tool<Record<string, never>, string> = {
    name,
    description: `tool ${name}`,
    enabled,
    permission: { requires: [`tools:${name}`] },
    input: { fields: {} },
    async run(): Promise<string> {
      calls++;
      return "ran";
    },
  };
  return { tool, calls: () => calls };
};

/** A tool that hangs unless its abort signal fires. */
const hangingTool = new (class Hanging {
  readonly name = "hanging";
  readonly description = "hangs";
  readonly enabled = true;
  readonly permission = { requires: ["tools:hanging"] };
  readonly input = { fields: {} };
  async run(_i: unknown, ctx: ToolContext): Promise<string> {
    return new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => resolve("late"), { once: true });
      setTimeout(() => resolve("verylate"), 5000);
    });
  }
})() as unknown as Tool<never, string>;

const ALL: ToolActor = {
  userId: "user-1",
  permissions: ["tools:a", "tools:b", "tools:hanging"],
};

/** Actor granted a specific tool (added to the base set). */
function granted(name: string): ToolActor {
  return { userId: "user-1", permissions: [...ALL.permissions, `tools:${name}`] };
}

const NONE: ToolActor = { userId: "user-2", permissions: [] };

function setup(tools: Tool<never, string>[]): ToolExecutor {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return new ToolExecutor({ registry: reg, timeoutMs: 200 });
}

// ---------- registry ----------

describe("ToolRegistry", () => {
  test("registers, finds and lists", () => {
    const reg = new ToolRegistry();
    reg.register(op("a", "A"));
    reg.register(op("b", "B"));
    expect(reg.size).toBe(2);
    expect(reg.has("a")).toBe(true);
    expect(reg.has("zzz")).toBe(false);
    expect(reg.find("a")?.name).toBe("a");
    expect(reg.find("zzz")).toBeUndefined();
    expect(reg.listActiveNames()).toEqual(["a", "b"]);
  });

  test("rejects a duplicate tool name", () => {
    const reg = new ToolRegistry();
    reg.register(op("dup", "1"));
    expect(() => reg.register(op("dup", "2"))).toThrow(/duplicate tool name/);
    expect(reg.size).toBe(1);
    expect(reg.find("dup")?.name).toBe("dup");
  });

  test("listActiveNames excludes disabled tools", () => {
    const reg = new ToolRegistry();
    reg.register(op("on", "x"));
    reg.register({ ...op("off", "y"), enabled: false });
    expect(reg.listActiveNames()).toEqual(["on"]);
  });
});

// ---------- executor: security ----------

describe("ToolExecutor", () => {
  test("unknown tool → not_found, never runs", async () => {
    const ex = setup([op("a", "A")]);
    const r = await ex.execute({ tool: "ghost", input: {}, actor: ALL });
    expect(r.status).toBe("not_found");
    expect(r.tool).toBe("ghost");
  });

  test("missing permission → not_allowed and PROVEN not to have run", async () => {
    const s = spy("secret");
    const ex = setup([s.tool]);
    const r = await ex.execute({ tool: "secret", input: {}, actor: NONE });
    expect(r.status).toBe("not_allowed");
    expect(s.calls()).toBe(0); // proof: body never executed
  });

  test("wrong shape of permission string does not grant access", async () => {
    const s = spy("secret");
    const ex = setup([s.tool]);
    // "tools:secret" split into unrelated keys must not satisfy "tools:secret"
    const r = await ex.execute({
      tool: "secret",
      input: {},
      actor: { userId: "u", permissions: ["tools:secrets", "admin", "tools: sec".trim()] },
    });
    expect(r.status).toBe("not_allowed");
    expect(s.calls()).toBe(0);
  });

  test("disabled tool → disabled status, body never runs", async () => {
    const s = spy("offed", false);
    const ex = setup([s.tool]);
    const r = await ex.execute({ tool: "offed", input: {}, actor: granted("offed") });
    expect(r.status).toBe("disabled");
    expect(s.calls()).toBe(0);
  });

  test("permission is checked at execution time, not once at registration", async () => {
    const s = spy("late");
    const ex = setup([s.tool]);
    // Authorized now
    await ex.execute({ tool: "late", input: {}, actor: granted("late") });
    expect(s.calls()).toBe(1);
    // Revoked before the next request — the same tool, different request
    await ex.execute({
      tool: "late",
      input: {},
      actor: { userId: "user-1", permissions: [] },
    });
    expect(s.calls()).toBe(1); // still 1 — the revoked call did not run
  });

  test("an unauthorized caller cannot escalate via payload", async () => {
    const s = spy("secret");
    const ex = setup([s.tool]);
    const r = await ex.execute({
      tool: "secret",
      input: { permissions: ["tools:secret"], admin: true },
      actor: NONE,
    });
    expect(r.status).toBe("not_allowed");
    expect(s.calls()).toBe(0);
  });

  test("input payload cannot escalate: unmapped required field is rejected", async () => {
    const ex = setup([op("a", "A")]);
    const r = await ex.execute({
      tool: "a",
      input: { x: 1, grant: "tools:a" },
      actor: NONE,
    });
    expect(r.status).toBe("not_allowed");
  });

  test("can() reflects current permissions", async () => {
    const ex = setup([op("a", "A")]);
    expect(ex.can("a", ALL)).toBe(true);
    expect(ex.can("a", NONE)).toBe(false);
    expect(ex.can("ghost", ALL)).toBe(false);
  });
});

// ---------- executor: validation & input safety ----------

describe("input validation", () => {
  test("unknown field is rejected before the tool runs", async () => {
    const s = spy("a");
    const ex = setup([s.tool]);
    const r = await ex.execute({ tool: "a", input: { bogus: 1 }, actor: ALL });
    expect(r.status).toBe("invalid_input");
    expect(s.calls()).toBe(0);
  });

  test("wrong type is rejected", async () => {
    const s = spy("a");
    const ex = setup([s.tool]);
    const r = await ex.execute({ tool: "a", input: { x: "not-a-number" }, actor: ALL });
    expect(r.status).toBe("invalid_input");
  });

  test("non-object input is rejected", async () => {
    const ex = setup([op("a", "A")]);
    for (const bad of [null, 7, "str", [1, 2], true]) {
      const r = await ex.execute({ tool: "a", input: bad, actor: ALL });
      expect(r.status).toBe("invalid_input");
    }
  });

  test("valid input runs the tool", async () => {
    const ex = setup([op("a", "A-output")]);
    const r = await ex.execute({ tool: "a", input: { x: 1 }, actor: ALL });
    expect(r.status).toBe("ok");
    expect(r.data).toBe("A-output");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------- executor: errors are safe ----------

describe("safe error handling", () => {
  const boom = new (class Boom {
    readonly name = "boom";
    readonly description = "throws";
    readonly enabled = true;
    readonly permission = { requires: ["tools:boom"] };
    readonly input = { fields: {} };
    async run(): Promise<string> {
      throw new Error("SECRET_TOKEN=abc123 at /internal/path.ts:42");
    }
  })() as unknown as Tool<never, string>;

  const undefinedOut = new (class Void {
    readonly name = "void";
    readonly description = "returns undefined";
    readonly enabled = true;
    readonly permission = { requires: ["tools:void"] };
    readonly input = { fields: {} };
    async run(): Promise<undefined> {
      return undefined;
    }
  })() as unknown as Tool<never, undefined>;

  test("raw Error from a tool does not leak its message", async () => {
    const failures: string[] = [];
    const reg = new ToolRegistry();
    reg.register(boom);
    const ex = new ToolExecutor({ registry: reg, onError: (i) => failures.push(i.kind) });

    const r = await ex.execute({ tool: "boom", input: {}, actor: granted("boom") });
    expect(r.status).toBe("error");
    // Generic message only — no secret, no path, no stack.
    expect(r.message).toBe("خطای داخلی ابزار.");
    expect(JSON.stringify(r)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(r)).not.toContain("/internal/path");
    expect(JSON.stringify(r)).not.toContain("abc123");
    // Diagnostics are reported by category, not text.
    expect(failures).toEqual(["internal"]);
  });

  test("tool returning nothing is rejected as invalid_result", async () => {
    const reg = new ToolRegistry();
    reg.register(undefinedOut);
    const ex = new ToolExecutor({ registry: reg });
    const r = await ex.execute({
      tool: "void",
      input: {},
      actor: { ...ALL, permissions: ["tools:void"] },
    });
    expect(r.status).toBe("error");
    expect(r.message).toBe("نتیجهٔ ابزار نامعتبر بود.");
  });

  test("ToolError kinds map to safe user messages", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "k",
      description: "d",
      enabled: true,
      permission: { requires: [] },
      input: { fields: {} },
      async run(): Promise<string> {
        throw new ToolError("timeout", "internal detail");
      },
    } as Tool<never, string>);
    const ex = new ToolExecutor({ registry: reg });
    const r = await ex.execute({ tool: "k", input: {}, actor: ALL });
    expect(r.status).toBe("error");
    expect(r.message).toBe("اجرای ابزار طول کشید و لغو شد.");
  });

  test("execute never throws, whatever the input", async () => {
    const ex = setup([op("a", "A")]);
    await expect(
      ex.execute({ tool: "a", input: undefined, actor: ALL }),
    ).resolves.toBeDefined();
  });
});

// ---------- executor: concurrency & timeout ----------

describe("concurrency and timeout", () => {
  test("maxConcurrent bounds in-flight executions, all still succeed", async () => {
    let inFlight = 0;
    let peak = 0;
    const reg = new ToolRegistry();
    reg.register({
      name: "counted",
      description: "d",
      enabled: true,
      permission: { requires: ["tools:counted"] },
      input: { fields: {} },
      async run(): Promise<string> {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return "ok";
      },
    } as Tool<never, string>);
    const ex = new ToolExecutor({ registry: reg, maxConcurrent: 2 });

    const actor: ToolActor = { userId: "u", permissions: ["tools:counted"] };
    await Promise.all(
      Array.from({ length: 8 }, () => ex.execute({ tool: "counted", input: {}, actor })),
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  test("maxConcurrent < 1 is rejected", () => {
    const reg = new ToolRegistry();
    expect(() => new ToolExecutor({ registry: reg, maxConcurrent: 0 })).toThrow(
      /maxConcurrent/,
    );
  });

  test("concurrent executions are all resolved (no dropped slot)", async () => {
    const ex = setup([op("a", "A")]);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => ex.execute({ tool: "a", input: {}, actor: ALL })),
    );
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  test("a tool that ignores its abort signal still cannot outlive the timeout", async () => {
    const reg = new ToolRegistry();
    reg.register(hangingTool);
    const ex = new ToolExecutor({ registry: reg, timeoutMs: 60 });

    const started = Date.now();
    const r = await ex.execute({ tool: "hanging", input: {}, actor: ALL });
    expect(r.status).toBe("error");
    expect(r.message).toBe("اجرای ابزار طول کشید و لغو شد.");
    // Returns promptly after the deadline, not after the tool's 5s expiry.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
