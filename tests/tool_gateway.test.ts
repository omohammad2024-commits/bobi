/**
 * Phase E4 — tool gateway: toolsets, setActiveToolsets, tool_search.
 *
 * Conventions: no network, no real storage where avoidable. Factory-built
 * tools are constructed with stub deps and never RUN here — only their
 * declared metadata (name/toolset/ownerOnly/permission) is asserted, which
 * the factories fill without touching their deps.
 */
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agent/prompt";
import type { ToolDescriptor } from "../src/tools/service";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolActor } from "../src/tools/types";

import { calculatorTool } from "../src/tools/calculator";
import { dateTimeTool } from "../src/tools/date_time";
import { textUtilitiesTool } from "../src/tools/text_utilities";
import { unitConverterTool } from "../src/tools/unit_converter";
import { fetchUrlTool } from "../src/tools/fetch_url";
import { createWebSearchTool } from "../src/tools/web_search";
import {
  createForgetTool,
  createMemoryTools,
  createRecallTool,
  createRememberTool,
} from "../src/tools/memory";
import { createHistoryTools, createSearchHistoryTool } from "../src/tools/history";
import {
  createCancelReminderTool,
  createListRemindersTool,
  createRemindAtTool,
  createReminderTools,
} from "../src/tools/reminders";
import {
  createCancelTaskTool,
  createListTasksTool,
  createScheduledTaskTools,
  createScheduleTaskTool,
} from "../src/tools/scheduled_tasks";
import {
  createAddGoalTool,
  createCompleteGoalTool,
  createGoalTools,
  createListGoalsTool,
} from "../src/tools/goals";
import { createDelegateTool } from "../src/tools/delegate";
import { createConsultModelsTool } from "../src/tools/consult_models";
import { createImageGenTool } from "../src/tools/image_gen";
import { createSkillsTool } from "../src/skills/tool";
import {
  TOOL_SEARCH_PERMISSION,
  TOOL_SEARCH_TOOL_NAME,
  createToolSearchTool,
  searchVisibleTools,
} from "../src/tools/tool_search";
import type { VisibleToolInfo } from "../src/tools/tool_search";

/** The E4 taxonomy every built-in tool must belong to (or leave undefined). */
const KNOWN_TOOLSETS = new Set([
  "utils",
  "memory",
  "schedule",
  "web",
  "media",
  "agents",
  "system",
]);

const STUB = {} as never;

// ---------- toolset assignment ----------

describe("toolset assignment", () => {
  test("utils tools", () => {
    for (const t of [
      calculatorTool,
      dateTimeTool,
      textUtilitiesTool,
      unitConverterTool,
    ]) {
      expect(t.toolset).toBe("utils");
    }
  });

  test("web tools", () => {
    expect(fetchUrlTool.toolset).toBe("web");
    expect(createWebSearchTool({ resolve: () => { throw new Error("no provider"); } }).toolset).toBe("web");
  });

  test("memory tools", () => {
    for (const t of [
      createRememberTool({ provider: STUB }),
      createRecallTool({ provider: STUB }),
      createForgetTool({ provider: STUB }),
      createSearchHistoryTool({ storage: STUB }),
    ]) {
      expect(t.toolset).toBe("memory");
    }
  });

  test("schedule tools (incl. ownerOnly ones)", () => {
    for (const t of [
      createRemindAtTool({ storage: STUB }),
      createListRemindersTool({ storage: STUB }),
      createCancelReminderTool({ storage: STUB }),
      createScheduleTaskTool({
        storage: STUB,
        isOwner: () => false,
        defaultTimezone: "Asia/Tehran",
      }),
      createListTasksTool({
        storage: STUB,
        isOwner: () => false,
        defaultTimezone: "Asia/Tehran",
      }),
      createCancelTaskTool({
        storage: STUB,
        isOwner: () => false,
        defaultTimezone: "Asia/Tehran",
      }),
      createAddGoalTool({ storage: STUB, isOwner: () => false }),
      createListGoalsTool({ storage: STUB, isOwner: () => false }),
      createCompleteGoalTool({ storage: STUB, isOwner: () => false }),
    ]) {
      expect(t.toolset).toBe("schedule");
    }
  });

  test("agents tools", () => {
    expect(
      createDelegateTool({ tools: STUB, provider: STUB, model: "m" }).toolset,
    ).toBe("agents");
    expect(
      createConsultModelsTool({
        provider: STUB,
        primaryModel: "m",
        listConfiguredModels: () => [],
      }).toolset,
    ).toBe("agents");
  });

  test("media tool", () => {
    expect(
      createImageGenTool({ baseUrl: "http://localhost/", model: "m" }).toolset,
    ).toBe("media");
  });

  test("system tools", () => {
    expect(createSkillsTool({ cache: STUB }).toolset).toBe("system");
    const search = createToolSearchTool({ visibleTools: () => [] });
    expect(search.toolset).toBe("system");
    expect(search.name).toBe(TOOL_SEARCH_TOOL_NAME);
    expect(search.ownerOnly).not.toBe(true);
    expect(search.permission.requires).toContain(TOOL_SEARCH_PERMISSION);
  });

  test("every declared toolset is in the taxonomy", () => {
    const tools = [
      calculatorTool,
      dateTimeTool,
      textUtilitiesTool,
      unitConverterTool,
      fetchUrlTool,
      createWebSearchTool({ resolve: () => { throw new Error("no provider"); } }),
      createRememberTool({ provider: STUB }),
      createRecallTool({ provider: STUB }),
      createForgetTool({ provider: STUB }),
      createSearchHistoryTool({ storage: STUB }),
      createRemindAtTool({ storage: STUB }),
      createListRemindersTool({ storage: STUB }),
      createCancelReminderTool({ storage: STUB }),
      createScheduleTaskTool({
        storage: STUB,
        isOwner: () => false,
        defaultTimezone: "Asia/Tehran",
      }),
      createAddGoalTool({ storage: STUB, isOwner: () => false }),
      createDelegateTool({ tools: STUB, provider: STUB, model: "m" }),
      createConsultModelsTool({
        provider: STUB,
        primaryModel: "m",
        listConfiguredModels: () => [],
      }),
      createImageGenTool({ baseUrl: "http://localhost/", model: "m" }),
      createSkillsTool({ cache: STUB }),
      createToolSearchTool({ visibleTools: () => [] }),
    ];
    for (const t of tools) {
      expect(t.toolset).toBeDefined();
      expect(KNOWN_TOOLSETS.has(t.toolset as string)).toBe(true);
    }
  });
});

// ---------- setActiveToolsets ----------

/** A core tool: no toolset declared, so always visible. */
const coreProbe: Tool<{ q?: string }, { ok: boolean }> = {
  name: "core_probe",
  description: "A core tool with no toolset.",
  enabled: true,
  permission: { requires: ["tools:core_probe"] },
  input: { fields: {} },
  async run() {
    return { ok: true };
  },
};

const ALL_PERMS = [
  "tools:calculator",
  "tools:date_time",
  "tools:text_utilities",
  "tools:unit_converter",
  "tools:fetch_url",
  "tools:core_probe",
  "tools:tool_search",
];

function fullActor(): ToolActor {
  return { userId: "u1", permissions: ALL_PERMS };
}

function gatewayService(): ToolService {
  const svc = new ToolService({
    extraTools: [coreProbe as Tool<unknown, unknown>],
  });
  svc.registry.register(
    createToolSearchTool(svc.toolSearchDeps()) as Tool<unknown, unknown>,
  );
  return svc;
}

describe("setActiveToolsets", () => {
  test("default (undefined) = no filtering, pre-E4 behaviour", () => {
    const svc = gatewayService();
    const names = svc.toolSpecsFor(fullActor()).map((s) => s.name);
    expect(names).toContain("calculator");
    expect(names).toContain("fetch_url");
    expect(names).toContain("tool_search");
    expect(names).toContain("core_probe");
  });

  test("filters to the listed toolsets; toolset-less tools stay visible", () => {
    const svc = gatewayService();
    svc.setActiveToolsets(["utils"]);
    const names = svc.toolSpecsFor(fullActor()).map((s) => s.name);
    expect(names).toContain("calculator");
    expect(names).toContain("date_time");
    expect(names).toContain("text_utilities");
    expect(names).toContain("unit_converter");
    expect(names).not.toContain("fetch_url"); // "web" toolset
    expect(names).not.toContain("tool_search"); // "system" toolset
    expect(names).toContain("core_probe"); // no toolset = always visible
  });

  test("undefined restores full visibility", () => {
    const svc = gatewayService();
    svc.setActiveToolsets(["utils"]);
    svc.setActiveToolsets(undefined);
    const names = svc.toolSpecsFor(fullActor()).map((s) => s.name);
    expect(names).toContain("fetch_url");
    expect(names).toContain("tool_search");
  });

  test("does not change what the actor may RUN — only what is listed", () => {
    const svc = gatewayService();
    svc.setActiveToolsets(["utils"]);
    // The Executor still checks permissions independently of the filter.
    expect(svc.can("fetch_url", fullActor())).toBe(true);
  });

  test("listToolsets groups declared toolsets, skips toolset-less tools", () => {
    const svc = gatewayService();
    const groups = new Map(svc.listToolsets().map((g) => [g.name, g.tools]));
    expect(groups.get("utils")).toEqual([
      "calculator",
      "date_time",
      "text_utilities",
      "unit_converter",
    ]);
    expect(groups.get("web")).toEqual(["fetch_url"]);
    expect(groups.get("system")).toEqual(["tool_search"]);
    for (const tools of groups.values()) {
      expect(tools).not.toContain("core_probe");
    }
  });
});

// ---------- tool_search ranking ----------

function visible(
  overrides: Partial<VisibleToolInfo> & { name: string },
): VisibleToolInfo {
  return {
    description: "",
    fields: [],
    ...overrides,
  };
}

describe("searchVisibleTools ranking", () => {
  const tools: VisibleToolInfo[] = [
    visible({
      name: "remind_at",
      description: "یک یادآور در زمان مشخص تنظیم کن.",
      toolset: "schedule",
      fields: [{ name: "text", type: "string", required: true }],
    }),
    visible({
      name: "schedule_task",
      description: "وظیفه زمان‌بندی‌شده.",
      toolset: "schedule",
    }),
    visible({ name: "calculator", description: "محاسبه ریاضی.", toolset: "utils" }),
  ];

  test("a name hit outranks a description hit", () => {
    const hits = searchVisibleTools(tools, "remind");
    expect(hits[0]?.name).toBe("remind_at");
  });

  test("toolset is a ranking signal below name", () => {
    const hits = searchVisibleTools(tools, "schedule");
    // schedule_task: name hit (100) + toolset hit (40); remind_at: toolset hit (40) only
    expect(hits.map((h) => h.name)).toEqual(["schedule_task", "remind_at"]);
  });

  test("ties break deterministically by name", () => {
    const twins: VisibleToolInfo[] = [
      visible({ name: "zeta_tool", description: "shared token" }),
      visible({ name: "alpha_tool", description: "shared token" }),
    ];
    const hits = searchVisibleTools(twins, "token");
    expect(hits.map((h) => h.name)).toEqual(["alpha_tool", "zeta_tool"]);
  });

  test("limit caps the results", () => {
    const hits = searchVisibleTools(tools, "schedule", 1);
    expect(hits).toHaveLength(1);
  });

  test("empty or unmatched queries return nothing", () => {
    expect(searchVisibleTools(tools, "")).toEqual([]);
    expect(searchVisibleTools(tools, "   ")).toEqual([]);
    expect(searchVisibleTools(tools, "definitelynotatool")).toEqual([]);
  });

  test("hits carry name, description, toolset and input fields", () => {
    const hits = searchVisibleTools(tools, "remind");
    expect(hits[0]).toEqual({
      name: "remind_at",
      description: "یک یادآور در زمان مشخص تنظیم کن.",
      toolset: "schedule",
      inputFields: [{ name: "text", type: "string", required: true }],
    });
  });

  test("toolset is omitted (not undefined) when the tool has none", () => {
    const hits = searchVisibleTools(
      [visible({ name: "core_x", description: "core x" })],
      "core",
    );
    expect(hits[0]).toEqual({
      name: "core_x",
      description: "core x",
      inputFields: [],
    });
    expect("toolset" in (hits[0] as object)).toBe(false);
  });
});

// ---------- actor-scoped invisibility of ownerOnly tools ----------

const OWNER_ONLY_PERMS = [
  "tools:schedule_task",
  "tools:list_tasks",
  "tools:cancel_task",
  "tools:add_goal",
  "tools:list_goals",
  "tools:complete_goal",
];

function scheduleService(): ToolService {
  const svc = new ToolService({
    extraTools: [
      ...createScheduledTaskTools({
        storage: STUB,
        isOwner: () => true,
        defaultTimezone: "Asia/Tehran",
      }),
      ...createGoalTools({ storage: STUB, isOwner: () => true }),
      ...createReminderTools({ storage: STUB }),
    ] as Tool<unknown, unknown>[],
  });
  // Same wiring as src/index.ts: the viewer is the actor-filtered service
  // view, never the raw registry.
  svc.registry.register(
    createToolSearchTool(svc.toolSearchDeps()) as Tool<unknown, unknown>,
  );
  return svc;
}

function ownerActor(): ToolActor {
  return {
    userId: "owner",
    permissions: [
      ...OWNER_ONLY_PERMS,
      "tools:remind_at",
      "tools:list_reminders",
      "tools:cancel_reminder",
      "tools:tool_search",
    ],
  };
}

function nonOwnerActor(): ToolActor {
  // Simulates the authorization bridge: it withholds the ownerOnly tools'
  // permission keys from non-owners, so `can()` fails for them and they
  // vanish from toolSpecsFor AND searchableTools alike.
  return {
    userId: "user",
    permissions: [
      "tools:remind_at",
      "tools:list_reminders",
      "tools:cancel_reminder",
      "tools:tool_search",
    ],
  };
}

async function searchAs(
  svc: ToolService,
  actor: ToolActor,
  query: string,
): Promise<string[]> {
  const r = await svc.runTool({ tool: "tool_search", input: { query }, actor });
  expect(r.status).toBe("ok");
  const data = r.data as { results: Array<{ name: string }> };
  return data.results.map((hit) => hit.name);
}

describe("tool_search actor scoping", () => {
  test("non-owner cannot discover ownerOnly tools by name", async () => {
    const svc = scheduleService();
    const names = await searchAs(svc, nonOwnerActor(), "schedule");
    expect(names).not.toContain("schedule_task");
    expect(names).not.toContain("list_tasks");
    expect(names).not.toContain("cancel_task");
    // sanity: a permitted tool in the same toolset is still found
    const remind = await searchAs(svc, nonOwnerActor(), "remind");
    expect(remind).toContain("remind_at");
  });

  test("non-owner cannot discover ownerOnly tools by description either", async () => {
    const svc = scheduleService();
    // «کرون» appears only in the schedule_task description (ownerOnly).
    const names = await searchAs(svc, nonOwnerActor(), "کرون");
    expect(names).not.toContain("schedule_task");
  });

  test("owner sees the ownerOnly tools through the same search", async () => {
    const svc = scheduleService();
    const names = await searchAs(svc, ownerActor(), "schedule");
    expect(names).toContain("schedule_task");
    const goals = await searchAs(svc, ownerActor(), "goal");
    expect(goals).toEqual(
      expect.arrayContaining(["add_goal", "list_goals", "complete_goal"]),
    );
  });

  test("tool_search itself requires its permission key", async () => {
    const svc = scheduleService();
    const r = await svc.runTool({
      tool: "tool_search",
      input: { query: "remind" },
      actor: { userId: "nobody", permissions: [] },
    });
    expect(r.status).toBe("not_allowed");
  });

  test("input bounds are validated before execution", async () => {
    const svc = scheduleService();
    const actor = ownerActor();
    const empty = await svc.runTool({
      tool: "tool_search",
      input: { query: "" },
      actor,
    });
    expect(empty.status).toBe("invalid_input");
    const tooLong = await svc.runTool({
      tool: "tool_search",
      input: { query: "x".repeat(201) },
      actor,
    });
    expect(tooLong.status).toBe("invalid_input");
    const badLimit = await svc.runTool({
      tool: "tool_search",
      input: { query: "remind", limit: 11 },
      actor,
    });
    expect(badLimit.status).toBe("invalid_input");
  });

  test("active toolsets also constrain what search can reveal", async () => {
    const svc = scheduleService();
    svc.setActiveToolsets(["utils"]);
    const names = await searchAs(svc, ownerActor(), "remind");
    // remind_at is "schedule": hidden by the gateway filter even for the owner.
    expect(names).not.toContain("remind_at");
  });
});

// ---------- prompt discovery line ----------

function descriptors(count: number): ToolDescriptor[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}`,
    description: `tool ${i}`,
    enabled: true,
    requires: [],
  }));
}

const promptCtx = (tools: ToolDescriptor[]) => ({
  tools,
  now: new Date("2026-10-18T12:00:00Z"),
  timezone: "Asia/Tehran",
});

describe("tool_search prompt hint", () => {
  test("appears when more than 20 tools are visible", () => {
    const prompt = buildSystemPrompt(promptCtx(descriptors(21)));
    expect(prompt).toContain("tool_search");
  });

  test("absent at exactly 20 tools", () => {
    const prompt = buildSystemPrompt(promptCtx(descriptors(20)));
    expect(prompt).not.toContain("tool_search");
  });

  test("absent with no tools", () => {
    const prompt = buildSystemPrompt(promptCtx([]));
    expect(prompt).not.toContain("tool_search");
  });
});
