/**
 * Phase-4 item 4 — scheduled group digests.
 *
 * Covers:
 *  - config: digestEnabled/digestTime defaults, validation, lazy migration of
 *    pre-Phase-4 blobs (no digest fields → defaults, still valid),
 *  - digestTimeToCron / validateDigestTime / digestTaskName,
 *  - parseDigestArg,
 *  - /gassistant digest on|off|status|time: owner gates, group gates, port
 *    calls, failure paths, and the /gassistant status digest line,
 *  - group_digest tool: owner-only, deterministic content, delivery to the
 *    owner's channel only (never the group), no-op when disabled,
 *  - ensure/cancelGroupDigestTask row logic (replace-don't-duplicate),
 *  - end-to-end: real Storage + ToolService + TaskScheduler — a due digest
 *    task runs the tool and DMs the owner the deterministic summary.
 *
 * No network, no Telegram. Clocks are injected.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { TaskScheduler } from "../src/scheduler/scheduler";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolActor, ToolContext } from "../src/tools/types";
import { ToolError } from "../src/tools/errors";
import { createScheduledTaskTools } from "../src/tools/scheduled_tasks";
import {
  DEFAULT_ASSISTANT_CONFIG,
  assistantStatusText,
  createGroupHistory,
  getAssistantConfig,
  handleGassistantCommand,
  parseDigestArg,
  setAssistantConfig,
  validateAssistantConfig,
  type AssistantConfig,
  type DigestSchedulePort,
  type GroupAssistantCtx,
  type GroupAssistantEnv,
  type GroupChatMessage,
} from "../src/groups/assistant";
import {
  GROUP_DIGEST_PERMISSION,
  GROUP_DIGEST_TOOL_NAME,
  cancelGroupDigestTask,
  createGroupDigestTool,
  digestTaskName,
  digestTimeToCron,
  ensureGroupDigestTask,
  validateDigestTime,
  type DigestTaskCalls,
} from "../src/groups/group_digest";

// ---------------------------------------------------------------- fakes ----

const OWNER = "111";
const MEMBER = "222";
const GROUP = "-1001";

function fakeStore() {
  const map = new Map<string, string>();
  return {
    getUserPref(userId: string, key: string): string | undefined {
      return map.get(`${userId}:${key}`);
    },
    setUserPref(userId: string, key: string, value: string): void {
      map.set(`${userId}:${key}`, value);
    },
  };
}

function fakePort(over: Partial<DigestSchedulePort> = {}): DigestSchedulePort & {
  ensured: Array<{ chatId: string; time: string }>;
  cancelled: string[];
} {
  const ensured: Array<{ chatId: string; time: string }> = [];
  const cancelled: string[] = [];
  return {
    ensured,
    cancelled,
    ensureDigestTask: async (chatId: string, time: string) => {
      ensured.push({ chatId, time });
      return 42;
    },
    cancelDigestTask: async (chatId: string) => {
      cancelled.push(chatId);
    },
    ...over,
  };
}

function env(over: Partial<GroupAssistantEnv> = {}): GroupAssistantEnv {
  return {
    storage: fakeStore(),
    ownerId: OWNER,
    botUsername: "Bobi_Agentbot",
    history: createGroupHistory(),
    digest: fakePort(),
    ...over,
  };
}

function fakeCtx(over: Partial<GroupAssistantCtx> = {}): {
  ctx: GroupAssistantCtx;
  replies: string[];
} {
  const replies: string[] = [];
  const ctx: GroupAssistantCtx = {
    from: { id: MEMBER },
    chat: { id: GROUP, type: "supergroup" },
    message: { text: "" },
    reply: async (text: string) => {
      replies.push(text);
    },
    ...over,
  };
  return { ctx, replies };
}

function ownerCtx(e: GroupAssistantEnv, text: string) {
  return fakeCtx({ from: { id: OWNER }, message: { text } });
}

function enabledCfg(over: Partial<AssistantConfig> = {}): AssistantConfig {
  return { ...DEFAULT_ASSISTANT_CONFIG, enabled: true, ...over };
}

function msg(over: Partial<GroupChatMessage> = {}): GroupChatMessage {
  return {
    chatId: GROUP,
    userId: MEMBER,
    name: "علی",
    text: "سلام چطورین امروز هوا خوبه",
    tsMs: 1_700_000_000_000,
    ...over,
  };
}

function toolCtx(userId: string, permissions: string[]): ToolContext {
  const actor: ToolActor = { userId, permissions };
  return { clock: () => new Date(), actor, signal: AbortSignal.timeout(5000) };
}

// ------------------------------------------------------------ config ----

describe("digest config", () => {
  test("defaults are digest-off at 08:00", () => {
    expect(DEFAULT_ASSISTANT_CONFIG.digestEnabled).toBe(false);
    expect(DEFAULT_ASSISTANT_CONFIG.digestTime).toBe("08:00");
  });

  test("digest fields validate strictly", () => {
    const ok = validateAssistantConfig({ digestEnabled: true, digestTime: "21:30" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.config.digestEnabled).toBe(true);
      expect(ok.config.digestTime).toBe("21:30");
    }
    expect(validateAssistantConfig({ digestEnabled: "yes" }).ok).toBe(false);
    expect(validateAssistantConfig({ digestTime: "25:00" }).ok).toBe(false);
    expect(validateAssistantConfig({ digestTime: "8:00" }).ok).toBe(false);
    expect(validateAssistantConfig({ digestTime: "08-00" }).ok).toBe(false);
    expect(validateAssistantConfig({ digestTime: 800 }).ok).toBe(false);
    expect(validateAssistantConfig({ digestTime: "24:00" }).ok).toBe(false);
    expect(validateAssistantConfig({ digestTime: "23:59" }).ok).toBe(true);
    expect(validateAssistantConfig({ digestTime: "00:00" }).ok).toBe(true);
  });

  test("pre-Phase-4 blobs migrate lazily: still valid, digest defaults apply", () => {
    // A blob written before digest fields existed has no digest keys.
    const legacy = JSON.stringify({
      enabled: true,
      replyOnlyWhenCalled: true,
      summaryMaxMessages: 30,
      pollsAllowed: true,
    });
    const store = fakeStore();
    store.setUserPref(OWNER, `gacfg:${GROUP}`, legacy);
    const cfg = getAssistantConfig(store, OWNER, GROUP);
    expect(cfg.enabled).toBe(true);
    expect(cfg.digestEnabled).toBe(false);
    expect(cfg.digestTime).toBe("08:00");
  });

  test("set/get round-trips digest settings", () => {
    const store = fakeStore();
    const r = setAssistantConfig(store, OWNER, GROUP, {
      enabled: true,
      digestEnabled: true,
      digestTime: "09:30",
    });
    expect(r.ok).toBe(true);
    expect(getAssistantConfig(store, OWNER, GROUP)).toEqual(
      enabledCfg({ digestEnabled: true, digestTime: "09:30" }),
    );
  });
});

// ---------------------------------------------------------- time/cron ----

describe("digest time helpers", () => {
  test("validateDigestTime accepts HH:MM 24-hour only", () => {
    expect(validateDigestTime("08:00")).toEqual({ ok: true, time: "08:00" });
    expect(validateDigestTime(" 21:30 ")).toEqual({ ok: true, time: "21:30" });
    expect(validateDigestTime("8:00").ok).toBe(false);
    expect(validateDigestTime("24:00").ok).toBe(false);
    expect(validateDigestTime("08:60").ok).toBe(false);
    expect(validateDigestTime("").ok).toBe(false);
    expect(validateDigestTime(undefined).ok).toBe(false);
    expect(validateDigestTime(800).ok).toBe(false);
  });

  test("digestTimeToCron builds a daily cron at the right minute/hour", () => {
    expect(digestTimeToCron("08:00")).toBe("0 8 * * *");
    expect(digestTimeToCron("21:30")).toBe("30 21 * * *");
    expect(digestTimeToCron("00:05")).toBe("5 0 * * *");
    expect(() => digestTimeToCron("bogus")).toThrow();
  });

  test("digestTaskName is deterministic per group", () => {
    expect(digestTaskName("-1001")).toBe("group_digest:-1001");
    expect(digestTaskName("-1001")).not.toBe(digestTaskName("-1002"));
  });
});

// ---------------------------------------------------------- arg parse ----

describe("parseDigestArg", () => {
  test("parses the four subcommands", () => {
    expect(parseDigestArg("/gassistant digest on")).toEqual({ kind: "on" });
    expect(parseDigestArg("/gassistant digest off")).toEqual({ kind: "off" });
    expect(parseDigestArg("/gassistant digest status")).toEqual({ kind: "status" });
    expect(parseDigestArg("/gassistant digest time 21:30")).toEqual({
      kind: "time",
      time: "21:30",
    });
  });

  test("bad subcommand and non-digest commands", () => {
    expect(parseDigestArg("/gassistant digest frobnicate")).toEqual({ kind: "bad" });
    expect(parseDigestArg("/gassistant digest")).toEqual({ kind: "bad" });
    expect(parseDigestArg("/gassistant on")).toBeUndefined();
    expect(parseDigestArg("/gassistant status")).toBeUndefined();
    expect(parseDigestArg("/gsummary")).toBeUndefined();
  });
});

// ------------------------------------------------------ command flows ----

describe("/gassistant digest commands", () => {
  test("owner enables digest: config set, task scheduled, group stays silent", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, { enabled: true });
    const port = e.digest as ReturnType<typeof fakePort>;
    const { ctx, replies } = ownerCtx(e, "/gassistant digest on");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("خلاصهٔ روزانه");
    expect(replies[0]).toContain("08:00");
    const cfg = getAssistantConfig(e.storage, OWNER, GROUP);
    expect(cfg.digestEnabled).toBe(true);
    expect(port.ensured).toEqual([{ chatId: GROUP, time: "08:00" }]);
    expect(port.cancelled).toEqual([]);
  });

  test("digest on requires assistant mode first", async () => {
    const e = env();
    const port = e.digest as ReturnType<typeof fakePort>;
    const { ctx, replies } = ownerCtx(e, "/gassistant digest on");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("/gassistant on");
    expect(port.ensured).toEqual([]);
    expect(getAssistantConfig(e.storage, OWNER, GROUP).digestEnabled).toBe(false);
  });

  test("time change re-schedules at the new time", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, {
      enabled: true,
      digestEnabled: true,
      digestTime: "08:00",
    });
    const port = e.digest as ReturnType<typeof fakePort>;
    const { ctx, replies } = ownerCtx(e, "/gassistant digest time 21:30");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("21:30");
    expect(port.ensured).toEqual([{ chatId: GROUP, time: "21:30" }]);
    expect(getAssistantConfig(e.storage, OWNER, GROUP).digestTime).toBe("21:30");
  });

  test("time change while digest off only stores the time", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, { enabled: true });
    const port = e.digest as ReturnType<typeof fakePort>;
    const { ctx, replies } = ownerCtx(e, "/gassistant digest time 07:15");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("07:15");
    expect(port.ensured).toEqual([]);
    expect(getAssistantConfig(e.storage, OWNER, GROUP).digestTime).toBe("07:15");
  });

  test("bad time is rejected with usage, config untouched", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, { enabled: true });
    for (const t of ["25:00", "8:00", "abc", ""]) {
      const { ctx, replies } = ownerCtx(e, `/gassistant digest time ${t}`.trim());
      await handleGassistantCommand(ctx, e, "en");
      expect(replies[0]).toContain("HH:MM");
    }
    expect(getAssistantConfig(e.storage, OWNER, GROUP).digestTime).toBe("08:00");
  });

  test("digest off clears config and cancels the task", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, {
      enabled: true,
      digestEnabled: true,
    });
    const port = e.digest as ReturnType<typeof fakePort>;
    const { ctx, replies } = ownerCtx(e, "/gassistant digest off");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("غیرفعال شد");
    expect(getAssistantConfig(e.storage, OWNER, GROUP).digestEnabled).toBe(false);
    expect(port.cancelled).toEqual([GROUP]);
  });

  test("digest status shows state in both languages", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, {
      enabled: true,
      digestEnabled: true,
      digestTime: "09:45",
    });
    const { ctx, replies } = ownerCtx(e, "/gassistant digest status");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("09:45");

    const { ctx: ctxEn, replies: repliesEn } = ownerCtx(e, "/gassistant digest status");
    await handleGassistantCommand(ctxEn, e, "en");
    expect(repliesEn[0]).toContain("09:45");
    expect(repliesEn[0]).toContain("Daily digest");
  });

  test("/gassistant status now includes the digest line", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, {
      enabled: true,
      digestEnabled: true,
      digestTime: "08:00",
    });
    const { ctx, replies } = ownerCtx(e, "/gassistant status");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("خلاصهٔ روزانه");
    expect(replies[0]).not.toContain(OWNER);
    expect(replies[0]).not.toContain(GROUP);
    // ...and the pure renderer agrees in both languages.
    for (const lang of ["fa", "en"] as const) {
      const text = assistantStatusText(
        enabledCfg({ digestEnabled: true, digestTime: "08:00" }),
        lang,
      );
      expect(text).toContain("08:00");
      expect(text).not.toContain(OWNER);
      expect(text).not.toContain(GROUP);
    }
  });

  test("schedule failure is reported generically, config stays off", async () => {
    const e = env({
      digest: fakePort({
        ensureDigestTask: async () => undefined,
      }),
    });
    setAssistantConfig(e.storage, OWNER, GROUP, { enabled: true });
    const { ctx, replies } = ownerCtx(e, "/gassistant digest on");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("ناموفق");
    expect(getAssistantConfig(e.storage, OWNER, GROUP).digestEnabled).toBe(false);
  });

  test("missing schedule port reports unavailability", async () => {
    const e = env();
    delete e.digest; // simulate missing schedule port
    setAssistantConfig(e.storage, OWNER, GROUP, { enabled: true });
    const { ctx, replies } = ownerCtx(e, "/gassistant digest on");
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("فعال نیست");
    expect(getAssistantConfig(e.storage, OWNER, GROUP).digestEnabled).toBe(false);
  });

  test("non-owner is denied and learns nothing", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, { enabled: true });
    const port = e.digest as ReturnType<typeof fakePort>;
    const { ctx, replies } = fakeCtx({
      message: { text: "/gassistant digest on" },
    });
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("مالک");
    expect(port.ensured).toEqual([]);
  });

  test("private chat is refused", async () => {
    const e = env();
    const { ctx, replies } = fakeCtx({
      from: { id: OWNER },
      chat: { id: OWNER, type: "private" },
      message: { text: "/gassistant digest on" },
    });
    await handleGassistantCommand(ctx, e, "fa");
    expect(replies[0]).toContain("گروه");
  });

  test("digest bad subcommand shows digest usage", async () => {
    const e = env();
    setAssistantConfig(e.storage, OWNER, GROUP, { enabled: true });
    const { ctx, replies } = ownerCtx(e, "/gassistant digest frobnicate");
    await handleGassistantCommand(ctx, e, "en");
    expect(replies[0]).toContain("Usage:");
    expect(replies[0]).toContain("digest");
  });
});

// ------------------------------------------------------- digest tool ----

function digestToolDeps(over: Partial<Parameters<typeof createGroupDigestTool>[0]> = {}) {
  const sent: string[] = [];
  const history = createGroupHistory();
  return {
    deps: {
      storage: fakeStore(),
      ownerId: OWNER,
      isOwner: (id: string) => id === OWNER,
      history,
      notifyOwner: async (text: string) => {
        sent.push(text);
      },
      ownerLang: () => "fa" as const,
      ...over,
    },
    sent,
    history,
  };
}

describe("group_digest tool", () => {
  test("owner run delivers the deterministic summary to the owner channel", async () => {
    const { deps, sent, history } = digestToolDeps();
    const store = deps.storage as ReturnType<typeof fakeStore>;
    setAssistantConfig(store, OWNER, GROUP, {
      enabled: true,
      digestEnabled: true,
      digestTime: "08:00",
    });
    history.record(msg({ text: "امروز هوا خیلی خوبه بریم بیرون" }));
    history.record(msg({ text: "هوا عالیه موافقم", userId: "333", name: "سارا" }));
    const tool = createGroupDigestTool(deps);
    const out = await tool.run(
      { chatId: GROUP },
      toolCtx(OWNER, [GROUP_DIGEST_PERMISSION]),
    );
    expect(out.delivered).toBe(true);
    expect(out.messages).toBe(2);
    expect(sent).toHaveLength(1);
    // Delivered to the owner channel only: one notify call, and the text is
    // the deterministic statistical summary (same shape as /gsummary).
    expect(sent[0]).toContain("خلاصهٔ روزانهٔ گروه");
    expect(sent[0]).toContain(GROUP);
    expect(sent[0]).toContain("خلاصهٔ گفت‌وگو");
    expect(sent[0]).toContain("سارا");
  });

  test("no-op when digest (or mode) is off: nothing is sent", async () => {
    const { deps, sent, history } = digestToolDeps();
    const store = deps.storage as ReturnType<typeof fakeStore>;
    setAssistantConfig(store, OWNER, GROUP, { enabled: true, digestEnabled: false });
    history.record(msg());
    const tool = createGroupDigestTool(deps);
    const out = await tool.run(
      { chatId: GROUP },
      toolCtx(OWNER, [GROUP_DIGEST_PERMISSION]),
    );
    expect(out.delivered).toBe(false);
    expect(out.messages).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("empty buffer still notifies (same text as /gsummary empty)", async () => {
    const { deps, sent } = digestToolDeps();
    const store = deps.storage as ReturnType<typeof fakeStore>;
    setAssistantConfig(store, OWNER, GROUP, { enabled: true, digestEnabled: true });
    const tool = createGroupDigestTool(deps);
    const out = await tool.run(
      { chatId: GROUP },
      toolCtx(OWNER, [GROUP_DIGEST_PERMISSION]),
    );
    expect(out.delivered).toBe(true);
    expect(out.messages).toBe(0);
    expect(sent[0]).toContain("پیام کافی");
  });

  test("non-owner actor is refused", async () => {
    const { deps } = digestToolDeps();
    const tool = createGroupDigestTool(deps);
    await expect(
      tool.run({ chatId: GROUP }, toolCtx(MEMBER, [GROUP_DIGEST_PERMISSION])),
    ).rejects.toBeInstanceOf(ToolError);
  });

  test("malformed chatId is rejected", async () => {
    const { deps } = digestToolDeps();
    const tool = createGroupDigestTool(deps);
    for (const bad of ["", "abc", "12; DROP", "-".repeat(30)]) {
      await expect(
        tool.run({ chatId: bad }, toolCtx(OWNER, [GROUP_DIGEST_PERMISSION])),
      ).rejects.toBeInstanceOf(ToolError);
    }
  });

  test("notify failure does not fail the run", async () => {
    const { deps, history } = digestToolDeps({
      notifyOwner: async () => {
        throw new Error("telegram down");
      },
    });
    const store = deps.storage as ReturnType<typeof fakeStore>;
    setAssistantConfig(store, OWNER, GROUP, { enabled: true, digestEnabled: true });
    history.record(msg());
    const tool = createGroupDigestTool(deps);
    const out = await tool.run(
      { chatId: GROUP },
      toolCtx(OWNER, [GROUP_DIGEST_PERMISSION]),
    );
    expect(out.delivered).toBe(true);
  });

  test("tool is named and permissioned for the schedule toolset", () => {
    const { deps } = digestToolDeps();
    const tool = createGroupDigestTool(deps);
    expect(tool.name).toBe(GROUP_DIGEST_TOOL_NAME);
    expect(tool.ownerOnly).toBe(true);
    expect(tool.permission).toEqual({ requires: [GROUP_DIGEST_PERMISSION] });
  });
});

// ------------------------------------------------- task row management ----

function fakeCalls(): DigestTaskCalls & {
  rows: Array<{ id: number; name: string }>;
  created: Array<{ name: string; cron: string; timezone: string; chatId: string }>;
  cancelled: number[];
} {
  const rows: Array<{ id: number; name: string }> = [];
  const created: Array<{ name: string; cron: string; timezone: string; chatId: string }> = [];
  const cancelled: number[] = [];
  let nextId = 1;
  return {
    rows,
    created,
    cancelled,
    list: async () => [...rows],
    create: async (args) => {
      created.push(args);
      const id = nextId++;
      rows.push({ id, name: args.name });
      return id;
    },
    cancel: async (id: number) => {
      cancelled.push(id);
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

describe("digest task row logic", () => {
  test("ensure creates one task at the right cron and timezone", async () => {
    const calls = fakeCalls();
    const id = await ensureGroupDigestTask(calls, GROUP, "21:30");
    expect(typeof id).toBe("number");
    expect(calls.created).toEqual([
      {
        name: digestTaskName(GROUP),
        cron: "30 21 * * *",
        timezone: "Asia/Tehran",
        chatId: GROUP,
      },
    ]);
  });

  test("ensure replaces the old task instead of duplicating", async () => {
    const calls = fakeCalls();
    const first = await ensureGroupDigestTask(calls, GROUP, "08:00");
    const second = await ensureGroupDigestTask(calls, GROUP, "21:30");
    expect(second).not.toBe(first);
    expect(calls.cancelled).toEqual([first]);
    // Exactly one digest row survives.
    expect(calls.rows.filter((r) => r.name === digestTaskName(GROUP))).toHaveLength(1);
  });

  test("cancel removes the task; missing task is a no-op", async () => {
    const calls = fakeCalls();
    await cancelGroupDigestTask(calls, GROUP); // no task yet — fine
    expect(calls.cancelled).toEqual([]);
    const id = await ensureGroupDigestTask(calls, GROUP, "08:00");
    await cancelGroupDigestTask(calls, GROUP);
    expect(calls.cancelled).toEqual([id]);
    expect(calls.rows).toHaveLength(0);
  });

  test("a failing cancel does not block ensure", async () => {
    const calls = fakeCalls();
    const id = await ensureGroupDigestTask(calls, GROUP, "08:00");
    const failing: DigestTaskCalls = {
      ...calls,
      cancel: async () => {
        throw new Error("gone");
      },
    };
    const second = await ensureGroupDigestTask(failing, GROUP, "09:00");
    expect(typeof second).toBe("number");
    expect(second).not.toBe(id);
  });
});

// ------------------------------------------------ scheduler integration ----

describe("scheduler integration: due digest task DMs the owner", () => {
  test("tick runs group_digest and the owner gets the deterministic summary", async () => {
    const storage = Storage.open(":memory:");
    let clock = Date.parse("2026-10-19T04:30:00Z"); // 08:00 Asia/Tehran
    const sent: string[] = [];
    const history = createGroupHistory();
    const store = fakeStore();
    setAssistantConfig(store, OWNER, GROUP, {
      enabled: true,
      digestEnabled: true,
      digestTime: "08:00",
    });
    history.record(msg({ text: "بحث امروز دربارهٔ برنامهٔ هفته است" }));
    history.record(msg({ text: "برنامهٔ هفته را نهایی کنیم", userId: "333", name: "سارا" }));

    const digestTool = createGroupDigestTool({
      storage: store,
      ownerId: OWNER,
      isOwner: (id) => id === OWNER,
      history,
      notifyOwner: async (text) => {
        sent.push(text);
      },
      ownerLang: () => "fa" as const,
    });
    const scheduleTools = createScheduledTaskTools({
      storage,
      isOwner: (id) => id === OWNER,
      defaultTimezone: "Asia/Tehran",
      toolExists: (name) => name === GROUP_DIGEST_TOOL_NAME,
    });
    const svc = new ToolService({
      extraTools: [
        digestTool,
        ...scheduleTools,
      ] as unknown as readonly Tool<unknown, unknown>[],
    });
    const scheduler = new TaskScheduler({
      storage,
      tools: svc,
      intervalMs: 1_000,
      now: () => clock,
      sendMessage: async () => true,
      actorForUser: (userId): ToolActor => ({
        userId,
        permissions: [GROUP_DIGEST_PERMISSION, "tools:schedule_task"],
      }),
      onError: () => undefined,
    });

    // Create the digest task exactly like the /gassistant digest port does.
    const created = await svc.runTool({
      tool: "schedule_task",
      input: {
        name: digestTaskName(GROUP),
        cron: digestTimeToCron("08:00"),
        timezone: "Asia/Tehran",
        action: { type: "tool", tool: GROUP_DIGEST_TOOL_NAME, input: { chatId: GROUP } },
      },
      actor: { userId: OWNER, permissions: ["tools:schedule_task"] },
      timeoutMs: 5_000,
    });
    expect(created.status).toBe("ok");

    // Jump to just past the 08:00 Tehran slot; the tick delivers once.
    clock = Date.parse("2026-10-19T04:31:00Z");
    const summary = await scheduler.tick();
    expect(summary.executed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("خلاصهٔ روزانهٔ گروه");
    expect(sent[0]).toContain("خلاصهٔ گفت‌وگو");
    expect(sent[0]).toContain("سارا");
    // The task re-armed for tomorrow, not duplicated.
    expect(storage.listTasks(OWNER)).toHaveLength(1);

    // Second tick at the same clock: nothing due, nothing re-sent.
    const again = await scheduler.tick();
    expect(again.executed).toBe(0);
    expect(sent).toHaveLength(1);

    scheduler.stop();
    storage.close();
  });

  test("digest task no-ops silently when the mode was turned off afterwards", async () => {
    const storage = Storage.open(":memory:");
    let clock = Date.parse("2026-10-19T04:30:00Z");
    const sent: string[] = [];
    const history = createGroupHistory();
    const store = fakeStore();
    // Mode off, digest on (e.g. owner disabled the mode after scheduling).
    setAssistantConfig(store, OWNER, GROUP, { enabled: false, digestEnabled: true });

    const digestTool = createGroupDigestTool({
      storage: store,
      ownerId: OWNER,
      isOwner: (id) => id === OWNER,
      history,
      notifyOwner: async (text) => {
        sent.push(text);
      },
      ownerLang: () => "fa" as const,
    });
    const svc = new ToolService({
      extraTools: [digestTool] as unknown as readonly Tool<unknown, unknown>[],
    });
    const scheduler = new TaskScheduler({
      storage,
      tools: svc,
      intervalMs: 1_000,
      now: () => clock,
      sendMessage: async () => true,
      actorForUser: (userId): ToolActor => ({ userId, permissions: [GROUP_DIGEST_PERMISSION] }),
      onError: () => undefined,
    });

    storage.createTask({
      name: digestTaskName(GROUP),
      cronExpr: "0 8 * * *",
      timezone: "Asia/Tehran",
      actionJson: JSON.stringify({
        type: "tool",
        tool: GROUP_DIGEST_TOOL_NAME,
        input: { chatId: GROUP },
      }),
      createdByUserId: OWNER,
      nextRunAtMs: Date.parse("2026-10-19T04:30:00Z"),
    });

    clock = Date.parse("2026-10-19T04:31:00Z");
    const summary = await scheduler.tick();
    expect(summary.executed).toBe(1); // the tool ran…
    expect(sent).toHaveLength(0); // …but delivered nothing.
    scheduler.stop();
    storage.close();
  });
});
