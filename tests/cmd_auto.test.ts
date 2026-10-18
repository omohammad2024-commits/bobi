/**
 * Tests for the Hermes-parity automation commands (`src/bot/cmd_auto.ts`).
 *
 * All handlers are exercised through their exported `handleXxx` functions
 * with stub engines / tool services / storage — no Telegram, no network.
 * Module-level state (bg tasks, queues, steers) is reset between tests.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolContext } from "../src/tools/types";
import type { ConversationOutput } from "../src/conversation/engine";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import type { Storage } from "../src/storage/storage";
import {
  COMMAND_DEFS,
  actorForTelegramUser,
  callToolAs,
  parseIntervalToCron,
  handleBgStart,
  handleBgList,
  handleBgCancel,
  handleBtw,
  handleQueue,
  handleSteer,
  handleAgents,
  handleGoal,
  handleSubgoal,
  handleHeartbeat,
  handleLoop,
  handleCron,
  handleSuggestions,
  handleBlueprint,
  handleRefine,
  handleReview,
  handlePlan,
  handleMoa,
  handleMemory,
  handleLearn,
  handleBundles,
  setHeartbeatInfoProvider,
  clearBgTasksForTests,
  clearQueuesForTests,
  clearSteersForTests,
  BLUEPRINTS,
  BUNDLES,
  type AutoDeps,
  type SenderRef,
  type BgDeliver,
} from "../src/bot/cmd_auto";

const OWNER_ID = 999;
const A: SenderRef = { userId: "111", telegramId: 111, chatId: "10" };
const B: SenderRef = { userId: "222", telegramId: 222, chatId: "10" };
const OWNER: SenderRef = { userId: "999", telegramId: 999, chatId: "10" };

function fakeOutput(text: string): ConversationOutput {
  return {
    chunks: [text],
    model: "fake",
    isFake: true,
    steps: [],
    truncated: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    toolCalls: 0,
    media: [],
  };
}

function stubEngine(
  overrides: Partial<AutoDeps["engine"]> = {},
): AutoDeps["engine"] {
  return {
    respond: async () => fakeOutput("پاسخ"),
    isConversationRunning: () => false,
    cancel: () => {},
    ...overrides,
  } as AutoDeps["engine"];
}

const F = {
  title: { type: "string", required: true },
  id: { type: "integer", required: true },
  status: { type: "string" },
  name: { type: "string", required: true },
  cron: { type: "string", required: true },
  timezone: { type: "string" },
  action: { type: "object", required: true },
  enabled: { type: "boolean" },
  task: { type: "string", required: true },
  question: { type: "string", required: true },
  query: { type: "string" },
  limit: { type: "integer" },
  key: { type: "string", required: true },
  text: { type: "string", required: true },
  dueAt: { type: "string", required: true },
  repeat: { type: "enum", choices: ["none", "daily", "weekly"] },
};

/** Strict input validation needs declared fields per stub tool. */
const STUB_FIELDS: Record<string, Record<string, any>> = {
  add_goal: { title: F.title },
  list_goals: { status: F.status },
  complete_goal: { id: F.id },
  schedule_task: { name: F.name, cron: F.cron, timezone: F.timezone, action: F.action, enabled: F.enabled },
  list_tasks: {},
  cancel_task: { id: F.id },
  delegate: { task: F.task },
  consult_models: { question: F.question },
  recall: { query: F.query, limit: F.limit },
  forget: { key: F.key },
  remind_at: { text: F.text, dueAt: F.dueAt, repeat: F.repeat },
  boom: {},
};

function stubTool(
  name: string,
  run: (input: any, ctx: ToolContext) => Promise<any>,
  opts: { ownerOnly?: boolean; requires?: string[]; fields?: Record<string, any> } = {},
): Tool<unknown, unknown> {
  return {
    name,
    description: `stub ${name}`,
    enabled: true,
    ...(opts.ownerOnly === true ? { ownerOnly: true as const } : {}),
    permission: { requires: opts.requires ?? [] },
    input: { fields: opts.fields ?? STUB_FIELDS[name] ?? {} },
    run,
  } as unknown as Tool<unknown, unknown>;
}



function stubStorage(rows: Array<{ role: "user" | "assistant"; content: string }> = []): Storage {
  return {
    history: (_u: string, _c: string, _l?: number) =>
      rows.map((r, i) => ({
        id: i + 1,
        conversationId: 10,
        role: r.role,
        content: r.content,
        createdAt: Date.now(),
      })),
  } as unknown as Storage;
}

function depsWith(overrides: Partial<AutoDeps> = {}): AutoDeps {
  return { engine: stubEngine(), storage: stubStorage(), ...overrides };
}

function authDeps(overrides: Partial<AutoDeps> = {}): AutoDeps {
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  return { engine: stubEngine(), storage: stubStorage(), auth, ...overrides };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  clearBgTasksForTests();
  clearQueuesForTests();
  clearSteersForTests();
  setHeartbeatInfoProvider(undefined);
});

// ---------------------------------------------------------------------------
// COMMAND_DEFS
// ---------------------------------------------------------------------------

describe("COMMAND_DEFS", () => {
  test("has 19 unique commands with fa+en descriptions", () => {
    expect(COMMAND_DEFS.length).toBe(19);
    const names = COMMAND_DEFS.map((d) => d.command);
    expect(new Set(names).size).toBe(names.length);
    for (const d of COMMAND_DEFS) {
      expect(d.descriptionFa.length).toBeGreaterThan(0);
      expect(d.descriptionEn.length).toBeGreaterThan(0);
    }
  });

  test("ownerOnly flags match the spec", () => {
    const byName = Object.fromEntries(COMMAND_DEFS.map((d) => [d.command, d.ownerOnly]));
    for (const c of ["goal", "subgoal", "heartbeat", "loop", "cron", "learn"]) {
      expect(byName[c]).toBe(true);
    }
    for (const c of ["bg", "btw", "queue", "steer", "agents", "suggestions", "blueprint", "refine", "review", "plan", "moa", "memory", "bundles"]) {
      expect(byName[c]).toBe(false);
    }
  });
});

describe("actorForTelegramUser", () => {
  test("fail-closed without auth: unknown identity, no permissions", () => {
    const actor = actorForTelegramUser(depsWith(), 111);
    expect(actor.userId).toBe("unknown");
    expect(actor.permissions).toEqual([]);
  });

  test("derives the actor from the trusted numeric id", () => {
    const deps = authDeps();
    expect(actorForTelegramUser(deps, 111).userId).toBe("111");
    expect(actorForTelegramUser(deps, 222).userId).toBe("222");
  });

  test("withholds owner-only permission keys from non-owners", () => {
    const tools = new ToolService({
      extraTools: [stubTool("schedule_task", async () => ({}), { ownerOnly: true, requires: ["tools:schedule_task"] })],
    });
    const deps = authDeps({ tools });
    const ownerActor = actorForTelegramUser(deps, OWNER_ID);
    const userActor = actorForTelegramUser(deps, 111);
    expect(tools.can("schedule_task", ownerActor)).toBe(true);
    expect(tools.can("schedule_task", userActor)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /bg
// ---------------------------------------------------------------------------

describe("/bg", () => {
  test("queues a task and lists it for the same user", async () => {
    const delivered: string[] = [];
    const deliver: BgDeliver = async (_c, t) => {
      delivered.push(t);
    };
    const reply = await handleBgStart(depsWith(), A, "سلام دنیا", deliver);
    expect(reply).toContain("bg-1");
    expect(handleBgList(depsWith(), A)).toContain("bg-1");
    await tick();
    expect(delivered.length).toBe(1);
    expect(delivered[0]).toContain("پاسخ");
  });

  test("per-user isolation: B cannot see A's tasks", async () => {
    const deps = depsWith();
    await handleBgStart(deps, A, "کار آ", async () => {});
    expect(handleBgList(deps, B)).toContain("نداری");
    expect(handleBgList(deps, A)).toContain("bg-1");
  });

  test("caps at 3 concurrent tasks per user", async () => {
    // Never-resolving engine keeps all three "running".
    const deps = depsWith({ engine: stubEngine({ respond: () => new Promise(() => {}) }) });
    const noop: BgDeliver = async () => {};
    await handleBgStart(deps, A, "یک", noop);
    await handleBgStart(deps, A, "دو", noop);
    await handleBgStart(deps, A, "سه", noop);
    const fourth = await handleBgStart(deps, A, "چهار", noop);
    expect(fourth).toContain("۳ کار");
    // B still has room: the cap is per user.
    const bFirst = await handleBgStart(deps, B, "کار ب", noop);
    expect(bFirst).toContain("bg-");
  });

  test("cancel suppresses the later delivery", async () => {
    let resolveTurn!: (o: ConversationOutput) => void;
    const deps = depsWith({
      engine: stubEngine({ respond: () => new Promise<ConversationOutput>((r) => { resolveTurn = r; }) }),
    });
    const delivered: string[] = [];
    await handleBgStart(deps, A, "دیر", async (_c, t) => { delivered.push(t); });
    expect(handleBgCancel(deps, A, "bg-1")).toContain("لغو شد");
    resolveTurn(fakeOutput("دیر رسید"));
    await tick();
    expect(delivered).toEqual([]);
    expect(handleBgList(deps, A)).toContain("لغو شد");
  });

  test("cancel of an unknown id reports not_found", () => {
    expect(handleBgCancel(depsWith(), A, "bg-999")).toContain("پیدا نشد");
    expect(handleBgCancel(depsWith(), A, "")).toContain("/bg cancel");
  });

  test("junk args rejected: empty and over-long prompts", async () => {
    const deps = depsWith();
    const noop: BgDeliver = async () => {};
    expect(await handleBgStart(deps, A, "   ", noop)).toContain("خالی");
    expect(await handleBgStart(deps, A, "x".repeat(2001), noop)).toContain("۲۰۰۰");
  });

  test("failed engine turn delivers a failure note", async () => {
    const deps = depsWith({
      engine: stubEngine({ respond: async () => { throw new Error("boom"); } }),
    });
    const delivered: string[] = [];
    await handleBgStart(deps, A, "خراب", async (_c, t) => { delivered.push(t); });
    await tick();
    expect(delivered.length).toBe(1);
    expect(delivered[0]).toContain("ناموفق");
  });
});

// ---------------------------------------------------------------------------
// /btw
// ---------------------------------------------------------------------------

describe("/btw", () => {
  test("answers in a separate throwaway conversation", async () => {
    let seenId = "";
    const deps = depsWith({
      engine: stubEngine({
        respond: async (input) => {
          seenId = input.conversationId;
          return fakeOutput("جواب جانبی");
        },
      }),
    });
    const reply = await handleBtw(deps, A, "سؤال؟");
    expect(reply).toContain("جواب جانبی");
    expect(seenId).toMatch(/^btw:111:\d+$/);
    expect(reply).toContain(seenId);
  });

  test("empty question rejected", async () => {
    expect(await handleBtw(depsWith(), A, "  ")).toContain("خالی");
  });
});

// ---------------------------------------------------------------------------
// /queue
// ---------------------------------------------------------------------------

describe("/queue", () => {
  test("add / list / clear round-trip (clear is two-step)", () => {
    const deps = depsWith();
    expect(handleQueue(deps, A, "اولین کار")).toContain("مورد 1");
    expect(handleQueue(deps, A, "دومین کار")).toContain("مورد 2");
    const list = handleQueue(deps, A, "list");
    expect(list).toContain("اولین کار");
    expect(list).toContain("دومین کار");
    // Bare "clear" only shows the confirm prompt — the queue survives.
    const confirm = handleQueue(deps, A, "clear");
    expect(confirm).toContain("2 مورد");
    expect(confirm).toContain("/queue clear --confirm");
    expect(handleQueue(deps, A, "list")).toContain("اولین کار");
    // Confirmed: actually cleared.
    expect(handleQueue(deps, A, "clear --confirm")).toContain("2 مورد حذف شد");
    expect(handleQueue(deps, A, "list")).toContain("خالی");
  });

  test("queues are per user+chat", () => {
    const deps = depsWith();
    handleQueue(deps, A, "کار آ");
    expect(handleQueue(deps, B, "list")).toContain("خالی");
  });

  test("junk: empty shows help, over-long rejected, cap at 10", () => {
    const deps = depsWith();
    expect(handleQueue(deps, A, "")).toContain("/queue");
    expect(handleQueue(deps, A, "x".repeat(2001))).toContain("۲۰۰۰");
    for (let i = 0; i < 10; i++) handleQueue(deps, A, `کار ${i}`);
    expect(handleQueue(deps, A, "کار یازدهم")).toContain("پر است");
  });
});

// ---------------------------------------------------------------------------
// /steer
// ---------------------------------------------------------------------------

describe("/steer", () => {
  test("stores a pending steer when a turn is running", async () => {
    const deps = depsWith({ engine: stubEngine({ isConversationRunning: () => true }) });
    const reply = await handleSteer(deps, A, "خلاصه‌تر جواب بده");
    expect(reply).toContain("ثبت شد");
    expect(handleAgents(deps, A)).toContain("راهنمای در انتظار");
  });

  test("runs immediately when nothing is running", async () => {
    let seenText = "";
    const deps = depsWith({
      engine: stubEngine({
        respond: async (input) => {
          seenText = input.userText;
          return fakeOutput("چشم");
        },
      }),
    });
    const reply = await handleSteer(deps, A, "خلاصه‌تر جواب بده");
    expect(reply).toContain("چشم");
    expect(seenText).toContain("خلاصه‌تر");
  });

  test("empty guidance shows help", async () => {
    expect(await handleSteer(depsWith(), A, " ")).toContain("/steer");
  });
});

// ---------------------------------------------------------------------------
// /agents
// ---------------------------------------------------------------------------

describe("/agents", () => {
  test("lists bg tasks, running turn, and delegate availability", async () => {
    const tools = new ToolService({ extraTools: [stubTool("delegate", async () => ({ ok: true, summary: "s" }))] });
    const deps = depsWith({
      tools,
      engine: stubEngine({ isConversationRunning: () => true }),
    });
    await handleBgStart(deps, A, "کار", async () => {});
    const out = handleAgents(deps, A);
    expect(out).toContain("bg-1");
    expect(out).toContain("در حال اجراست");
    expect(out).toContain("delegate");
  });

  test("empty when nothing is active", () => {
    expect(handleAgents(depsWith(), A)).toContain("فعالی نیست");
  });
});

// ---------------------------------------------------------------------------
// /goal
// ---------------------------------------------------------------------------

function goalTools() {
  const calls: Array<{ tool: string; input: any }> = [];
  const tools = new ToolService({
    extraTools: [
      stubTool("add_goal", async (input) => {
        calls.push({ tool: "add_goal", input });
        return { id: 7, title: (input as any).title, status: "active" };
      }),
      stubTool("list_goals", async (input) => {
        calls.push({ tool: "list_goals", input });
        return { goals: [{ id: 7, title: "ورزش", description: "", status: "active" }], count: 1 };
      }),
      stubTool("complete_goal", async (input) => {
        calls.push({ tool: "complete_goal", input });
        return { id: (input as any).id, completed: true, remaining: 0 };
      }),
    ],
  });
  return { tools, calls };
}

describe("/goal", () => {
  test("non-owner is rejected", async () => {
    const { tools } = goalTools();
    const out = await handleGoal(authDeps({ tools }), A, false, "set ورزش");
    expect(out).toContain("مالک");
  });

  test("set / show / clear via the goal tools", async () => {
    const { tools, calls } = goalTools();
    const deps = authDeps({ tools });
    const setOut = await handleGoal(deps, OWNER, true, "set ورزش روزانه");
    expect(setOut).toContain("ورزش روزانه");
    expect(setOut).toContain("7");
    expect(calls[0]!.tool).toBe("add_goal");

    const showOut = await handleGoal(deps, OWNER, true, "show");
    expect(showOut).toContain("#7");

    // Bare "clear" only asks for confirmation — nothing is completed.
    const confirmOut = await handleGoal(deps, OWNER, true, "clear");
    expect(confirmOut).toContain("/goal clear --confirm");
    expect(confirmOut).toContain("ورزش");
    expect(calls.some((c) => c.tool === "complete_goal")).toBe(false);

    const clearOut = await handleGoal(deps, OWNER, true, "clear --confirm");
    expect(clearOut).toContain("1 هدف");
    expect(calls.some((c) => c.tool === "complete_goal")).toBe(true);
  });

  test("junk subcommand shows help", async () => {
    const { tools } = goalTools();
    expect(await handleGoal(authDeps({ tools }), OWNER, true, "frobnicate")).toContain("/goal");
  });
});

// ---------------------------------------------------------------------------
// /subgoal
// ---------------------------------------------------------------------------

function subgoalTools() {
  const created: Array<{ title: string }> = [];
  const completed: number[] = [];
  const tools = new ToolService({
    extraTools: [
      stubTool("add_goal", async (input) => {
        created.push({ title: (input as any).title });
        return { id: 10 + created.length, title: (input as any).title, status: "active" };
      }),
      stubTool("list_goals", async () => ({
        goals: [
          { id: 7, title: "ورزش", description: "", status: "active" },
          ...created.map((c, i) => ({ id: 11 + i, title: c.title, description: "", status: "active" as const })),
        ],
        count: 1 + created.length,
      })),
      stubTool("complete_goal", async (input) => {
        completed.push((input as any).id);
        return { id: (input as any).id, completed: true, remaining: 0 };
      }),
    ],
  });
  return { tools, created, completed };
}

describe("/subgoal", () => {
  test("non-owner is rejected", async () => {
    const { tools } = subgoalTools();
    expect(await handleSubgoal(authDeps({ tools }), A, false, "list")).toContain("مالک");
  });

  test("add uses the ↳ <parent title> naming convention", async () => {
    const { tools, created } = subgoalTools();
    const deps = authDeps({ tools });
    const out = await handleSubgoal(deps, OWNER, true, "add 7 دویدن صبح");
    expect(out).toContain("زیرهدف");
    expect(created[0]!.title.startsWith("↳ ورزش")).toBe(true);
  });

  test("list filters subgoals; clear needs --confirm, then completes them", async () => {
    const { tools, completed } = subgoalTools();
    const deps = authDeps({ tools });
    await handleSubgoal(deps, OWNER, true, "add 7 دویدن صبح");
    const list = await handleSubgoal(deps, OWNER, true, "list");
    expect(list).toContain("↳ ورزش");
    expect(list).not.toMatch(/(^|\n)#7 /);
    // Bare "clear 7" only shows the scope + preview; nothing is completed.
    const confirm = await handleSubgoal(deps, OWNER, true, "clear 7");
    expect(confirm).toContain("/subgoal clear 7 --confirm");
    expect(completed).toEqual([]);
    const clear = await handleSubgoal(deps, OWNER, true, "clear 7 --confirm");
    expect(clear).toContain("1 زیرهدف");
    expect(completed).toEqual([11]);
  });

  test("clear without a parent id names the ALL-goals scope in its confirm", async () => {
    const { tools } = subgoalTools();
    const deps = authDeps({ tools });
    await handleSubgoal(deps, OWNER, true, "add 7 دویدن صبح");
    const confirm = await handleSubgoal(deps, OWNER, true, "clear");
    expect(confirm).toContain("/subgoal clear --confirm");
    expect(confirm).toContain("همهٔ اهداف");
  });

  test("missing parent reports parent_missing", async () => {
    const { tools } = subgoalTools();
    const out = await handleSubgoal(authDeps({ tools }), OWNER, true, "add 42 چیزی");
    expect(out).toContain("42");
  });
});

// ---------------------------------------------------------------------------
// /heartbeat, /loop, /cron
// ---------------------------------------------------------------------------

function taskTools() {
  const calls: Array<{ tool: string; input: any }> = [];
  const tools = new ToolService({
    extraTools: [
      stubTool(
        "schedule_task",
        async (input) => {
          calls.push({ tool: "schedule_task", input });
          return { id: 3, name: (input as any).name, cron: (input as any).cron, timezone: "Asia/Tehran", nextRunAt: "2026-10-19T00:00:00.000Z", enabled: true };
        },
        { ownerOnly: true, requires: ["tools:schedule_task"] },
      ),
      stubTool(
        "list_tasks",
        async () => ({ tasks: [], count: 0 }),
        { ownerOnly: true, requires: ["tools:list_tasks"] },
      ),
      stubTool(
        "cancel_task",
        async (input) => {
          calls.push({ tool: "cancel_task", input });
          const id = (input as any).id;
          return { id, cancelled: id === 3, remaining: 0 };
        },
        { ownerOnly: true, requires: ["tools:cancel_task"] },
      ),
    ],
  });
  return { tools, calls };
}

describe("/heartbeat", () => {
  test("non-owner is rejected", async () => {
    const { tools } = taskTools();
    expect(await handleHeartbeat(authDeps({ tools }), A, false, "status")).toContain("مالک");
  });

  test("status reports the provider state honestly", async () => {
    const { tools } = taskTools();
    const deps = authDeps({ tools });
    setHeartbeatInfoProvider(() => ({ enabled: true, interval: "30m" }));
    const out = await handleHeartbeat(deps, OWNER, true, "status");
    expect(out).toContain("فعال");
    expect(out).toContain("30m");
  });

  test("status without a provider says it is unknown", async () => {
    const { tools } = taskTools();
    const out = await handleHeartbeat(authDeps({ tools }), OWNER, true, "status");
    expect(out).toContain("مشخص نیست");
  });

  test("every with a bad interval is rejected", async () => {
    const { tools } = taskTools();
    const out = await handleHeartbeat(authDeps({ tools }), OWNER, true, "every someday سلام");
    expect(out).toContain("نامعتبر");
  });

  test("every creates an agent-action scheduled task", async () => {
    const { tools, calls } = taskTools();
    const out = await handleHeartbeat(authDeps({ tools }), OWNER, true, "every 30m وضعیت را چک کن");
    expect(out).toContain("ساخته شد");
    const created = calls.find((c) => c.tool === "schedule_task")!;
    expect(created.input.cron).toBe("*/30 * * * *");
    expect(created.input.name.startsWith("heartbeat:")).toBe(true);
    expect(created.input.action.type).toBe("agent");
    expect(created.input.action.chatId).toBe("10");
  });
});

describe("/loop", () => {
  test("every maps to schedule_task; stop maps to cancel_task", async () => {
    const { tools, calls } = taskTools();
    const deps = authDeps({ tools });
    const created = await handleLoop(deps, OWNER, true, "every 2h قیمت را چک کن");
    expect(created).toContain("ساخته شد");
    expect(calls.find((c) => c.tool === "schedule_task")!.input.cron).toBe("0 */2 * * *");
    const stopped = await handleLoop(deps, OWNER, true, "stop 3");
    expect(stopped).toContain("متوقف شد");
    const missing = await handleLoop(deps, OWNER, true, "stop 99");
    expect(missing).toContain("پیدا نشد");
    expect(await handleLoop(deps, OWNER, true, "stop x")).toContain("نامعتبر");
  });

  test("non-owner is rejected", async () => {
    const { tools } = taskTools();
    expect(await handleLoop(authDeps({ tools }), A, false, "every 1h x")).toContain("مالک");
  });
});

describe("/cron", () => {
  test("list shows tasks; add parses cron expressions", async () => {
    const { tools, calls } = taskTools();
    const deps = authDeps({ tools });
    expect(await handleCron(deps, OWNER, true, "list")).toContain("نیست");
    const added = await handleCron(deps, OWNER, true, "add 0 9 * * * صبح بخیر");
    expect(added).toContain("ساخته شد");
    const created = calls.find((c) => c.tool === "schedule_task")!;
    expect(created.input.cron).toBe("0 9 * * *");
    expect(created.input.action).toEqual({ type: "message", chatId: "10", text: "صبح بخیر" });
    const addedAt = await handleCron(deps, OWNER, true, "add @daily گزارش روزانه");
    expect(addedAt).toContain("ساخته شد");
    expect(calls[calls.length - 1]!.input.cron).toBe("@daily");
  });

  test("junk add shows help", async () => {
    const { tools } = taskTools();
    expect(await handleCron(authDeps({ tools }), OWNER, true, "add 0 9")).toContain("/cron");
    expect(await handleCron(authDeps({ tools }), A, false, "list")).toContain("مالک");
  });
});

describe("parseIntervalToCron", () => {
  test("parses m/h/d shorthands and rejects junk", () => {
    expect(parseIntervalToCron("30m")).toBe("*/30 * * * *");
    expect(parseIntervalToCron("2h")).toBe("0 */2 * * *");
    expect(parseIntervalToCron("1d")).toBe("0 0 */1 * *");
    expect(parseIntervalToCron("0m")).toBeUndefined();
    expect(parseIntervalToCron("99h")).toBeUndefined();
    expect(parseIntervalToCron("someday")).toBeUndefined();
    expect(parseIntervalToCron("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /suggestions
// ---------------------------------------------------------------------------

describe("/suggestions", () => {
  test("detects reminder-like signals in recent messages", () => {
    const deps = depsWith({
      storage: stubStorage([{ role: "user", content: "یادم بنداز هر روز آب بخورم" }]),
    });
    const out = handleSuggestions(deps, A, false);
    expect(out).toContain("/loop");
  });

  test("detects shared links and suggests the research bundle", () => {
    const deps = depsWith({
      storage: stubStorage([{ role: "user", content: "این لینک را ببین https://example.com" }]),
    });
    expect(handleSuggestions(deps, A, false)).toContain("research");
  });

  test("no signal, no suggestions", () => {
    const deps = depsWith({ storage: stubStorage([{ role: "user", content: "سلام چطوری" }]) });
    expect(handleSuggestions(deps, A, false)).toContain("سیگنال");
  });
});

// ---------------------------------------------------------------------------
// /blueprint
// ---------------------------------------------------------------------------

describe("/blueprint", () => {
  test("list shows the three built-in blueprints", async () => {
    const out = await handleBlueprint(depsWith(), A, "list");
    for (const b of BLUEPRINTS) expect(out).toContain(b.name);
    expect(BLUEPRINTS.length).toBe(3);
  });

  test("unknown blueprint names the available ones", async () => {
    const out = await handleBlueprint(depsWith(), A, "run nope");
    expect(out).toContain("morning_digest");
  });

  test("non-owner running morning_digest gets a clear denial", async () => {
    const { tools } = taskTools();
    const out = await handleBlueprint(authDeps({ tools }), A, "run morning_digest");
    expect(out).toContain("فقط مالک");
  });

  test("owner running morning_digest creates the scheduled task", async () => {
    const { tools, calls } = taskTools();
    const out = await handleBlueprint(authDeps({ tools }), OWNER, "run morning_digest");
    expect(out).toContain("ساخته شد");
    expect(calls.find((c) => c.tool === "schedule_task")!.input.cron).toBe("0 8 * * *");
  });

  test("reminder creates a one-shot remind_at with the server-side chat", async () => {
    let seenCtx: ToolContext | undefined;
    let seenInput: any;
    const tools = new ToolService({
      extraTools: [
        stubTool("remind_at", async (input, ctx) => {
          seenInput = input;
          seenCtx = ctx;
          return { id: 1, dueAt: (input as any).dueAt, repeat: "none", inMinutes: 30 };
        }),
      ],
    });
    const out = await handleBlueprint(authDeps({ tools }), A, "run reminder 30 آب خوردن");
    expect(out).toContain("30 دقیقه");
    expect(seenInput.text).toBe("آب خوردن");
    // The destination chat comes from server context, never user text.
    expect(seenCtx!.conversationId).toBe("10");
  });

  test("reminder junk args rejected", async () => {
    const { tools } = taskTools();
    expect(await handleBlueprint(authDeps({ tools }), A, "run reminder")).toContain("نامعتبر");
    expect(await handleBlueprint(authDeps({ tools }), A, "run reminder abc متن")).toContain("نامعتبر");
  });
});

// ---------------------------------------------------------------------------
// /refine, /review, /plan, /moa
// ---------------------------------------------------------------------------

describe("/refine", () => {
  test("no history reports honestly", async () => {
    expect(await handleRefine(depsWith({ storage: stubStorage([]) }), A)).toContain("تاریخچه‌ای");
  });

  test("passes recent history as read-only context with a remember directive", async () => {
    let seenText = "";
    const deps = depsWith({
      storage: stubStorage([
        { role: "user", content: "اسم پروژه‌م سول است" },
        { role: "assistant", content: "باشه" },
      ]),
      engine: stubEngine({
        respond: async (input) => {
          seenText = input.userText;
          return fakeOutput("دو درس ذخیره شد");
        },
      }),
    });
    const out = await handleRefine(deps, A);
    expect(out).toContain("دو درس");
    expect(seenText).toContain("remember");
    expect(seenText).toContain("اسم پروژه‌م سول است");
  });
});

describe("/review", () => {
  test("delegates with a review directive and returns the summary", async () => {
    let seenTask = "";
    const tools = new ToolService({
      extraTools: [
        stubTool("delegate", async (input) => {
          seenTask = (input as any).task;
          return { ok: true, summary: "نقاط قوت: ..." };
        }),
      ],
    });
    const out = await handleReview(authDeps({ tools }), A, "کد من");
    expect(out).toContain("نقاط قوت");
    expect(seenTask).toContain("کد من");
  });

  test("empty topic rejected", async () => {
    expect(await handleReview(depsWith(), A, "  ")).toContain("/review");
  });
});

describe("/plan", () => {
  test("asks for a numbered plan with a no-tools directive", async () => {
    let seenText = "";
    const deps = depsWith({
      engine: stubEngine({
        respond: async (input) => {
          seenText = input.userText;
          return fakeOutput("۱. ...");
        },
      }),
    });
    const out = await handlePlan(deps, A, "یادگیری شنا");
    expect(out).toContain("۱.");
    expect(seenText).toContain("هیچ ابزاری");
    expect(seenText).toContain("یادگیری شنا");
  });

  test("empty goal rejected", async () => {
    expect(await handlePlan(depsWith(), A, "")).toContain("/plan");
  });
});

describe("/moa", () => {
  test("returns the synthesized answer and models used", async () => {
    const tools = new ToolService({
      extraTools: [
        stubTool("consult_models", async (input) => ({
          ok: true,
          modelsUsed: ["m1", "m2"],
          answer: "پاسخ ترکیبی",
        })),
      ],
    });
    const out = await handleMoa(authDeps({ tools }), A, "بهترین زبان؟");
    expect(out).toContain("پاسخ ترکیبی");
    expect(out).toContain("m1");
  });

  test("empty question rejected", async () => {
    expect(await handleMoa(depsWith(), A, " ")).toContain("/moa");
  });
});

// ---------------------------------------------------------------------------
// /memory
// ---------------------------------------------------------------------------

function memoryTools(seenActors: string[]) {
  const store = new Map<string, string>([["نام پروژه", "سول"]]);
  const tools = new ToolService({
    extraTools: [
      stubTool("recall", async (input, ctx) => {
        seenActors.push(ctx.actor.userId);
        const q = ((input as any).query ?? "").trim();
        const all = [...store.entries()].map(([key, content]) => ({ key, content }));
        const memories = q ? all.filter((m) => m.key.includes(q) || m.content.includes(q)) : all;
        return { memories: memories.slice(0, (input as any).limit ?? 5), total: all.length };
      }),
      stubTool("forget", async (input, ctx) => {
        seenActors.push(ctx.actor.userId);
        const removed = store.delete((input as any).key);
        return { key: (input as any).key, removed, total: store.size };
      }),
    ],
  });
  return tools;
}

describe("/memory", () => {
  test("list / search / del round-trip", async () => {
    const tools = memoryTools([]);
    const deps = authDeps({ tools });
    expect(await handleMemory(deps, A, "list")).toContain("نام پروژه");
    expect(await handleMemory(deps, A, "search سول")).toContain("نام پروژه");
    expect(await handleMemory(deps, A, "search بی‌ربط")).toContain("ذخیره نشده");
    expect(await handleMemory(deps, A, "del نام پروژه")).toContain("پاک شد");
    expect(await handleMemory(deps, A, "del نام پروژه")).toContain("پیدا نشد");
  });

  test("calls run as the caller's own actor (per-user scoping)", async () => {
    const seenActors: string[] = [];
    const deps = authDeps({ tools: memoryTools(seenActors) });
    await handleMemory(deps, A, "list");
    await handleMemory(deps, B, "list");
    expect(seenActors).toEqual(["111", "222"]);
  });

  test("junk shows help", async () => {
    const deps = authDeps({ tools: memoryTools([]) });
    expect(await handleMemory(deps, A, "")).toContain("/memory");
  });
});

// ---------------------------------------------------------------------------
// /learn
// ---------------------------------------------------------------------------

describe("/learn", () => {
  test("non-owner is rejected", async () => {
    const res = await handleLearn(authDeps(), A, false, "x | y");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("مالک");
  });

  test("path traversal names are rejected", async () => {
    const deps = authDeps();
    for (const bad of ["../evil", "a/b", "..", "my skill", ""]) {
      const res = await handleLearn(deps, OWNER, true, `${bad} | توضیح`);
      expect(res.ok).toBe(false);
    }
  });

  test("valid name returns a draft document payload", async () => {
    let seenText = "";
    const deps = authDeps({
      engine: stubEngine({
        respond: async (input) => {
          seenText = input.userText;
          return fakeOutput('---\nname: my-skill\ndescription: ...\n---\n\nبدنه');
        },
      }),
    });
    const res = await handleLearn(deps, OWNER, true, "my-skill | یک مهارت آزمایشی");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fileName).toBe("my-skill.md");
      expect(res.markdown).toContain("my-skill");
    }
    expect(seenText).toContain("my-skill");
  });
});

// ---------------------------------------------------------------------------
// /bundles
// ---------------------------------------------------------------------------

describe("/bundles", () => {
  test("list shows suggested bundles", () => {
    const out = handleBundles(depsWith(), A, "list");
    for (const b of BUNDLES) expect(out).toContain(b.name);
    expect(BUNDLES.length).toBeGreaterThan(0);
  });

  test("use stores the bundle in user prefs (advisory)", () => {
    const saved = new Map<string, string>();
    const deps = depsWith({
      prefs: {
        getUserPref: (u, k) => saved.get(`${u}:${k}`),
        setUserPref: (u, k, v) => { saved.set(`${u}:${k}`, v); },
      },
    });
    const out = handleBundles(deps, A, "use research");
    expect(out).toContain("research");
    expect(saved.get("111:active_bundle")).toBe("research");
  });

  test("unknown bundle names the available ones; missing prefs is honest", () => {
    expect(handleBundles(depsWith(), A, "use nope")).toContain("research");
    expect(handleBundles(depsWith(), A, "use research")).toContain("در دسترس نیست");
  });
});

// ---------------------------------------------------------------------------
// callToolAs
// ---------------------------------------------------------------------------

describe("callToolAs", () => {
  test("reports missing tool service instead of throwing", async () => {
    const actor = actorForTelegramUser(depsWith(), 111);
    const out = await callToolAs(depsWith(), "recall", {}, actor);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("ابزارها");
  });

  test("surfaces tool failures as messages", async () => {
    const tools = new ToolService({
      extraTools: [stubTool("boom", async () => { throw new Error("nope"); })],
    });
    const actor = actorForTelegramUser(authDeps({ tools }), 111);
    const out = await callToolAs(authDeps({ tools }), "boom", {}, actor);
    expect(out.ok).toBe(false);
  });
});
