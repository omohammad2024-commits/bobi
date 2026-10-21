/**
 * Worker G (Agent Tools Audit) — regression tests for the v1.0 tools audit.
 *
 * What this suite pins:
 * 1. English-only, actionable errors: every tool-layer message is ASCII —
 *    no Persian, no stack traces, no leaked internals.
 * 2. The validate.ts "missing required field" message bug: it used to say
 *    the field "is not required" (wrong); now it names the missing field.
 * 3. Defensive hardening added by the audit:
 *    - calculator rejects an unknown op with a clean error instead of
 *      crashing on OPS[op] (direct-call safety).
 *    - consult_models caps consulted models at CONSULT_MODELS_MAX even for
 *      callers that bypass validation.
 *    - recall falls back to text ranking when the semantic index THROWS
 *      (the "silent fallback" contract used to assume search() never rejects).
 *    - remind_at (which absorbed note_followup in the Phase-8 merge)
 *      validates text itself and never passes storage internals through
 *      to the caller.
 *    - assertTimezoneOrThrow checks empty before Intl (the empty branch was
 *      unreachable before).
 *    - list_reminders rejects the undeclared `includeFired` field instead of
 *      silently ignoring it.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SearchError } from "../src/search/provider";
import type { AiProvider } from "../src/ai/provider";
import { Storage } from "../src/storage/storage";
import { ProposalStore } from "../src/curator/proposals";
import { ToolService } from "../src/tools/service";
import { ToolRegistry } from "../src/tools/registry";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool, ToolActor, ToolContext } from "../src/tools/types";
import { ToolError, toToolError, userMessageFor } from "../src/tools/errors";
import type { ToolErrorKind } from "../src/tools/errors";
import { validateInput } from "../src/tools/validate";
import { calculatorTool } from "../src/tools/calculator";
import { dateTimeTool } from "../src/tools/date_time";
import { textUtilitiesTool } from "../src/tools/text_utilities";
import { unitConverterTool } from "../src/tools/unit_converter";
import { createToolSearchTool } from "../src/tools/tool_search";
import { createWebSearchTool } from "../src/tools/web_search";
import {
  CONSULT_MODELS_MAX,
  createConsultModelsTool,
} from "../src/tools/consult_models";
import { createDelegateTool } from "../src/tools/delegate";
import {
  createRememberTool,
  createRecallTool,
  createForgetTool,
} from "../src/tools/memory";
import type { MemoryProvider, StoredMemory } from "../src/memory/provider";
import type { SemanticMemoryIndex } from "../src/memory/semantic";
import { createReminderTools, LIST_REMINDERS_PERMISSION, REMIND_AT_PERMISSION } from "../src/tools/reminders";
import {
  createGoalTools,
  COMPLETE_GOAL_PERMISSION,
} from "../src/tools/goals";
import {
  assertTimezoneOrThrow,
  createScheduledTaskTools,
  parseTaskAction,
  SCHEDULE_TASK_PERMISSION,
} from "../src/tools/scheduled_tasks";
import { createDigestTool } from "../src/tools/digest_tool";
import { createUsageReportTool } from "../src/tools/usage_report";
import { createImageGenTool } from "../src/tools/image_gen";
import { createVideoGenTool } from "../src/tools/video_gen";

const ARABIC = /[؀-ۿ]/;

function ctx(userId = "u1"): ToolContext {
  return {
    clock: () => new Date("2026-10-19T08:00:00Z"),
    actor: { userId, permissions: [] },
    signal: new AbortController().signal,
  };
}

function actor(userId = "u1", permissions: string[] = []): ToolActor {
  return { userId, permissions };
}

/** Run a tool body directly and capture the ToolError it throws. */
async function runError<TIn>(
  tool: Tool<TIn, unknown>,
  input: TIn,
  c: ToolContext = ctx(),
): Promise<ToolError> {
  try {
    await tool.run(input, c);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error(`expected ${tool.name} to throw`);
}

/** In-memory MemoryProvider stub. */
function memoryProvider(): MemoryProvider & { rows: Map<string, StoredMemory> } {
  const rows = new Map<string, StoredMemory>();
  return {
    rows,
    name: "stub",
    upsert: (userId, key, content) => {
      rows.set(`${userId}\n${key}`, { key, content, createdAt: Date.now(), updatedAt: Date.now() });
    },
    get: (userId, key) => rows.get(`${userId}\n${key}`),
    list: (userId) =>
      [...rows.entries()]
        .filter(([k]) => k.startsWith(`${userId}\n`))
        .map(([, v]) => v),
    delete: (userId, key) => rows.delete(`${userId}\n${key}`),
    count: (userId) =>
      [...rows.keys()].filter((k) => k.startsWith(`${userId}\n`)).length,
  };
}

// ---------- 1. English-only error catalog ----------

describe("error catalog is English-only", () => {
  const kinds: ToolErrorKind[] = [
    "invalid_input",
    "not_found",
    "disabled",
    "not_allowed",
    "timeout",
    "aborted",
    "overloaded",
    "invalid_result",
    "internal",
  ];

  test("userMessageFor has an English message for every kind", () => {
    for (const kind of kinds) {
      const msg = userMessageFor(kind);
      expect(msg.length).toBeGreaterThan(0);
      expect(ARABIC.test(msg), kind).toBe(false);
    }
  });

  test("toToolError coerces foreign throws to an English internal error", () => {
    const e = toToolError(new Error("SECRET exploded at /tmp/x"));
    expect(e.kind).toBe("internal");
    expect(e.message).not.toContain("SECRET");
    expect(ARABIC.test(e.message)).toBe(false);
  });
});

// ---------- 2. validate.ts ----------

describe("validateInput", () => {
  const spec = {
    fields: {
      name: { type: "string" as const, required: true },
      mode: { type: "enum" as const, choices: ["a", "b"] as const },
    },
  };

  test("missing required field names the field (not 'not required')", () => {
    const err = runErrorSync(() => validateInput(spec, {}));
    expect(err.message).toBe("Missing required field: name.");
  });

  test("unknown field is rejected with an English message", () => {
    const err = runErrorSync(() => validateInput(spec, { name: "x", bogus: 1 }));
    expect(err.message).toBe("Unknown field: bogus.");
  });

  test("invalid enum value lists the allowed choices", () => {
    const err = runErrorSync(() =>
      validateInput(spec, { name: "x", mode: "z" }),
    );
    expect(err.message).toBe('Invalid value for mode: expected one of "a", "b".');
  });

  test("non-object input is rejected", () => {
    const err = runErrorSync(() => validateInput(spec, "nope"));
    expect(err.message).toBe("Tool input must be an object.");
  });
});

function runErrorSync(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error("expected a throw");
}

// ---------- 3. calculator hardening ----------

describe("calculator", () => {
  test("division by zero is a clean English invalid_input", async () => {
    const err = await runError(calculatorTool, { op: "divide", a: 1, b: 0 });
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe("Division by zero is not allowed.");
  });

  test("unknown op via direct call is rejected, not a TypeError", async () => {
    const err = await runError(
      calculatorTool,
      { op: "modulo", a: 1, b: 2 } as never,
    );
    expect(err.kind).toBe("invalid_input");
    expect(err.message).toBe("Invalid operation.");
  });
});

// ---------- 4. unit_converter / date_time / text_utilities ----------

describe("small tools speak English", () => {
  test("unit_converter rejects an unknown unit", async () => {
    const err = await runError(unitConverterTool, {
      value: 1,
      from: "parsec",
      to: "m",
    });
    expect(err.message).toBe("Invalid unit.");
  });

  test("date_time rejects a bad timezone", async () => {
    const err = await runError(dateTimeTool, { timezone: "Mars/Olympus" });
    expect(err.message).toBe("Invalid timezone.");
  });

  test("text_utilities rejects whitespace-only input", async () => {
    const err = await runError(textUtilitiesTool, { text: "   \n  " });
    expect(err.message).toBe("Text is empty.");
  });
});

// ---------- 5. web_search English mapping ----------

describe("web_search", () => {
  test("a search auth failure becomes an English tool error", async () => {
    const tool = createWebSearchTool({
      resolve: () => ({
        label: "stub",
        type: "duckduckgo",
        needsCredential: false,
        needsKey: false,
        search: async () => {
          throw new SearchError("auth", "bad key");
        },
      }),
    });
    const err = await runError(tool, { query: "test query" });
    expect(err.kind).toBe("not_allowed");
    expect(err.message).toBe("The search service key was rejected.");
  });
});

// ---------- 6. consult_models model cap ----------

describe("consult_models", () => {
  function stubProvider(): AiProvider {
    return {
      complete: (async (req: { model?: string }) => ({
        text: `answer from ${req.model ?? "?"}`,
        model: req.model ?? "?",
        usage: { inputTokens: 1, outputTokens: 1 },
      })) as unknown as AiProvider["complete"],
    } as AiProvider;
  }

  test("more than 3 unique models are capped even past validation", async () => {
    const tool = createConsultModelsTool({
      resolveConsult: () => ({ provider: stubProvider(), primaryModel: "m1" }),
      listConfiguredModels: () => ["m1", "m2", "m3", "m4"],
    });
    // Direct run: bypasses the validator's maxItems cap on purpose.
    const out = await tool.run(
      { question: "q", models: ["m1", "m2", "m3", "m4"] },
      ctx(),
    );
    expect(out.modelsUsed.length).toBeLessThanOrEqual(CONSULT_MODELS_MAX);
    expect(out.answer.length).toBeGreaterThan(0);
  });
});

// ---------- 7. recall survives a throwing semantic index ----------

describe("recall semantic fallback", () => {
  test("a rejecting semantic search degrades to text ranking", async () => {
    const provider = memoryProvider();
    provider.upsert("u1", "project", "the bobi rewrite");
    const throwingSemantic: SemanticMemoryIndex = {
      search: async () => {
        throw new Error("vector store exploded");
      },
      indexMemory: () => undefined,
      removeMemory: () => undefined,
    };
    const tool = createRecallTool({ provider, semantic: throwingSemantic });
    const out = await tool.run({ query: "bobi" }, ctx());
    expect(out.searchMode).toBe("text");
    expect(out.memories.map((m) => m.key)).toEqual(["project"]);
  });

  test("remember rejects empty content in English", async () => {
    const tool = createRememberTool({ provider: memoryProvider() });
    const err = await runError(tool, { key: "k", content: "   " });
    expect(err.message).toBe("Memory text is empty.");
  });

  test("forget with an unknown identity is refused in English", async () => {
    const tool = createForgetTool({ provider: memoryProvider() });
    const err = await runError(tool, { key: "k" }, ctx("unknown"));
    expect(err.message).toBe("Identity is unknown; memory is unavailable.");
  });
});

// ---------- 8. remind_at owns its validation (Phase 8: absorbed note_followup) ----------

describe("remind_at merged follow-ups", () => {
  function service(storage: Storage) {
    return new ToolService({
      extraTools: [...createReminderTools({ storage })],
      clock: () => new Date("2026-10-19T08:00:00Z"),
    });
  }

  test("whitespace-only text is rejected in English", async () => {
    const svc = service(Storage.open(":memory:"));
    const r = await svc.runTool({
      tool: "remind_at",
      input: { text: "   ", when: "فردا ساعت ۹", followUp: true },
      actor: actor("u1", [REMIND_AT_PERMISSION]),
    });
    expect(r.status).toBe("invalid_input");
    expect(r.message).toBe("Invalid input.");
  });

  test("a throwing storage never leaks its internal message", async () => {
    const storage = Storage.open(":memory:");
    const broken = {
      ...storage,
      scheduling: {
        countPendingReminders: () => 0,
        createReminder: () => {
          throw new Error("ذخیره داخلی خراب شد");
        },
      },
    } as unknown as Storage;
    const tools = createReminderTools({ storage: broken });
    const tool = tools[0]!;
    const err = await runError(
      tool,
      { text: "call mom", when: "فردا ساعت ۹", followUp: true },
      ctx(),
    );
    expect(err.kind).toBe("internal");
    expect(err.message).toBe("Could not save the reminder.");
    expect(ARABIC.test(err.message)).toBe(false);
  });
});

// ---------- 9. scheduled_tasks ----------

describe("scheduled_tasks", () => {
  test("parseTaskAction rejects a shapeless action in English", () => {
    const err = runErrorSync(() => parseTaskAction({ type: "teleport" }));
    expect(err.message).toBe("Invalid action type; one of tool, message or agent.");
  });

  test("parseTaskAction rejects a task that would schedule tasks", () => {
    const err = runErrorSync(() =>
      parseTaskAction({ type: "tool", tool: "schedule_task", input: {} }),
    );
    expect(err.message).toBe("A scheduled task cannot create another task.");
  });

  test("assertTimezoneOrThrow: empty zone has its own message", () => {
    const err = runErrorSync(() => assertTimezoneOrThrow(""));
    expect(err.message).toBe("Timezone is empty.");
  });

  test("assertTimezoneOrThrow: unknown zone names the zone", () => {
    const err = runErrorSync(() => assertTimezoneOrThrow("Mars/Olympus"));
    expect(err.message).toBe("Invalid timezone: Mars/Olympus");
  });

  test("schedule_task names an unknown tool in English", async () => {
    const storage = Storage.open(":memory:");
    const tool = createScheduledTaskTools({
      storage,
      isOwner: () => true,
      defaultTimezone: "Asia/Tehran",
      toolExists: () => false,
    }).find((t) => (t as Tool<unknown, unknown>).name === "schedule_task")!;
    const err = await runError(
      tool as Tool<{ name: string; cron: string; action: Record<string, unknown> }, unknown>,
      {
        name: "x",
        cron: "@daily",
        action: { type: "tool", tool: "nope_tool", input: {} },
      },
      { ...ctx(), actor: actor("u1", [SCHEDULE_TASK_PERMISSION]) },
    );
    expect(err.message).toBe('No tool named "nope_tool" exists.');
  });
});

// ---------- 10. reminders: undeclared fields are rejected ----------

describe("list_reminders", () => {
  test("includeFired is rejected as an unknown field", async () => {
    const svc = new ToolService({
      extraTools: createReminderTools({ storage: Storage.open(":memory:") }),
    });
    const r = await svc.runTool({
      tool: "list_reminders",
      input: { includeFired: true },
      actor: actor("u1", [LIST_REMINDERS_PERMISSION]),
    });
    expect(r.status).toBe("invalid_input");
    expect(r.message).toBe("Invalid input.");
  });

  test("remind_at without a conversation is refused in English", async () => {
    const svc = new ToolService({
      extraTools: createReminderTools({ storage: Storage.open(":memory:") }),
      clock: () => new Date("2026-10-19T08:00:00Z"),
    });
    // No conversationId: the executor-level message is the generic English one.
    const r = await svc.execute({
      tool: "remind_at",
      input: { text: "x", dueAt: "2026-10-20T09:30:00+03:30" },
      actor: actor("u1", [REMIND_AT_PERMISSION]),
    });
    expect(r.status).toBe("not_allowed");
    expect(r.message).toBe("You are not allowed to run this tool.");
  });
});

// ---------- 11. goals ----------

describe("goals", () => {
  test("completing an unknown goal is a not_found with an English message", async () => {
    const storage = Storage.open(":memory:");
    const tool = createGoalTools({ storage, isOwner: () => true }).find(
      (t) => (t as Tool<unknown, unknown>).name === "complete_goal",
    )!;
    const err = await runError(
      tool as Tool<{ id: number }, unknown>,
      { id: 4242 },
      { ...ctx(), actor: actor("u1", [COMPLETE_GOAL_PERMISSION]) },
    );
    expect(err.kind).toBe("not_found");
    expect(err.message).toBe("No active goal found with this id.");
  });
});

// ---------- 13. executor.can() honours the enabled flag ----------

describe("executor.can()", () => {
  test("a disabled tool is not runnable, even with the permission", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "off",
      description: "d",
      enabled: false,
      permission: { requires: ["tools:off"] },
      input: { fields: {} },
      async run(): Promise<string> {
        return "x";
      },
    } as Tool<never, string>);
    const ex = new ToolExecutor({ registry: reg });
    expect(ex.can("off", actor("u1", ["tools:off"]))).toBe(false);
    // …and execute() still refuses it outright.
    const r = await ex.execute({
      tool: "off",
      input: {},
      actor: actor("u1", ["tools:off"]),
    });
    expect(r.status).toBe("disabled");
    expect(r.message).toBe("This tool is disabled.");
  });
});

// ---------- 13. English-only sweep over tool surfaces ----------

describe("English-only tool surfaces", () => {
  function allTools(): Array<Tool<unknown, unknown>> {
    const storage = Storage.open(":memory:");
    const db = new Database(":memory:");
    const stubProvider = {
      complete: (async () => ({ text: "x" })) as unknown as AiProvider["complete"],
    } as AiProvider;
    const svc = new ToolService();
    return [
      ...svc.registry.list(),
      createToolSearchTool({ visibleTools: () => [] }),
      createWebSearchTool({
        resolve: () => ({
          label: "stub",
          type: "duckduckgo",
          needsCredential: false,
        needsKey: false,
          search: async () => [],
        }),
      }),
      createConsultModelsTool({
        resolveConsult: () => ({ provider: stubProvider, primaryModel: "m" }),
        listConfiguredModels: () => [],
      }),
      createDelegateTool({ tools: svc, provider: stubProvider, model: "m" }),
      createRememberTool({ provider: memoryProvider() }),
      createRecallTool({ provider: memoryProvider() }),
      createForgetTool({ provider: memoryProvider() }),
      ...createReminderTools({ storage }),
      ...createGoalTools({ storage, isOwner: () => true }),
      ...createScheduledTaskTools({
        storage,
        isOwner: () => true,
        defaultTimezone: "UTC",
      }),
      createDigestTool({
        storage,
        proposalStore: new ProposalStore(db),
        isOwner: () => true,
      }),
      createUsageReportTool({ storage, isOwner: () => true }),
      createImageGenTool({ baseUrl: "https://example.test/v1", model: "m" }),
      createVideoGenTool({ baseUrl: "https://example.test/v1", model: "m" }),
    ] as Array<Tool<unknown, unknown>>;
  }

  test("every tool description and field description is ASCII", () => {
    const offenders: string[] = [];
    for (const tool of allTools()) {
      if (ARABIC.test(tool.description)) offenders.push(`${tool.name}:description`);
      for (const [fname, field] of Object.entries(tool.input.fields)) {
        if (field.description !== undefined && ARABIC.test(field.description)) {
          offenders.push(`${tool.name}.${fname}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("validation errors for every tool are ASCII", () => {
    const offenders: string[] = [];
    for (const tool of allTools()) {
      try {
        // An empty object fails on the first required field, or passes when
        // the tool takes no input; either way, any message must be English.
        validateInput(tool.input, {});
      } catch (err) {
        if (err instanceof ToolError && ARABIC.test(err.message)) {
          offenders.push(`${tool.name}: ${err.message}`);
        }
      }
      try {
        validateInput(tool.input, { __nope__: 1 });
      } catch (err) {
        if (err instanceof ToolError && ARABIC.test(err.message)) {
          offenders.push(`${tool.name}: ${err.message}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
