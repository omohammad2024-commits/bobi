import { describe, expect, test } from "bun:test";
import { ToolService } from "../src/tools/service";
import { DEFAULT_TOOLS } from "../src/tools/service";
import { toolListText, CALLBACKS, replyForCallback, buildMainMenu } from "../src/bot/menu";
import { shouldHandleMessage } from "../src/bot/filter";
import type { Tool } from "../src/tools/types";

const FULL_ACTOR = {
  userId: "user-1",
  permissions: [
    "tools:calculator",
    "tools:date_time",
    "tools:text_utilities",
    "tools:unit_converter",
    "tools:fetch_url",
  ],
};

/** Every tool the default service registers, in menu order. */
const DEFAULT_NAMES = [
  "calculator",
  "date_time",
  "text_utilities",
  "unit_converter",
  "fetch_url",
  // Phase 9: weather is a static (deps-free) plugin tool, so it is one
  // of the defaults a bare ToolService registers.
  "weather",
];

// ---------- the service ----------

describe("ToolService", () => {
  test("registers exactly the default tools", () => {
    const svc = new ToolService();
    expect(svc.registry.size).toBe(DEFAULT_NAMES.length);
    expect(svc.listActiveNames()).toEqual(DEFAULT_NAMES);
  });

  test("every default tool is enabled and describes itself", () => {
    const svc = new ToolService();
    for (const t of svc.registry.list()) {
      expect(t.enabled).toBe(true);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.permission.requires.length).toBeGreaterThan(0);
    }
  });

  test("runs a tool end-to-end through the service API", async () => {
    const svc = new ToolService();
    const r = await svc.runTool({
      tool: "calculator",
      input: { op: "add", a: 20, b: 22 },
      actor: FULL_ACTOR,
    });
    expect(r.status).toBe("ok");
    expect((r.data as { result: number }).result).toBe(42);
  });

  test("a service tool has no direct execution path that bypasses the Executor", () => {
    const svc = new ToolService();
    // Every registered tool body is only reachable via the Executor: the
    // service exposes runTool/execute/can plus listing methods and nothing that
    // hands out the tool itself.
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).sort();
    expect(own).toEqual([
      "can",
      "constructor",
      "execute",
      "listActive",
      "listActiveNames",
      "listToolsets",
      "runTool",
      "searchableTools",
      "setActiveToolsets",
      "toolSearchDeps",
      "toolSpecsFor",
      "toolsetVisible",
    ]);
  });

  test("extra tools can be added without touching the defaults", () => {
    const extra: Tool<{ q: string }, string> = {
      name: "extra_echo",
      description: "echoes",
      enabled: true,
      permission: { requires: ["tools:extra_echo"] },
      input: { fields: { q: { type: "string", required: true } } },
      async run(i): Promise<string> {
        return i.q;
      },
    };
    const svc = new ToolService({ extraTools: [extra as Tool<unknown, unknown>] });
    expect(svc.registry.size).toBe(DEFAULT_NAMES.length + 1);
    expect(svc.listActiveNames()).toContain("extra_echo");
    // The defaults are all still there.
    for (const name of DEFAULT_NAMES) expect(svc.listActiveNames()).toContain(name);
  });

  test("offDesk tools stay registered and executable but are never offered to the model", async () => {
    const offDesk: Tool<{ q: string }, string> = {
      name: "off_desk_probe",
      description: "admin-only probe",
      enabled: true,
      offDesk: true,
      permission: { requires: ["tools:off_desk_probe"] },
      input: { fields: { q: { type: "string", required: true } } },
      async run(i): Promise<string> {
        return i.q;
      },
    };
    const onDesk: Tool<{ q: string }, string> = {
      name: "on_desk_probe",
      description: "model-facing probe",
      enabled: true,
      permission: { requires: ["tools:on_desk_probe"] },
      input: { fields: { q: { type: "string", required: true } } },
      async run(i): Promise<string> {
        return i.q;
      },
    };
    const svc = new ToolService({
      extraTools: [offDesk, onDesk] as Tool<unknown, unknown>[],
    });
    const actor = {
      userId: "user-1",
      permissions: ["tools:off_desk_probe", "tools:on_desk_probe"],
    };
    // Model-facing paths exclude the offDesk tool, include the normal one.
    expect(svc.toolSpecsFor(actor).map((s) => s.name)).toContain("on_desk_probe");
    expect(svc.toolSpecsFor(actor).map((s) => s.name)).not.toContain("off_desk_probe");
    expect(svc.searchableTools(actor).map((t) => t.name)).toContain("on_desk_probe");
    expect(svc.searchableTools(actor).map((t) => t.name)).not.toContain("off_desk_probe");
    // Admin listing and the registry still see it, and the Executor still runs it.
    expect(svc.listActive().map((d) => d.name)).toContain("off_desk_probe");
    expect(svc.registry.find("off_desk_probe")).toBeDefined();
    const r = await svc.runTool({
      tool: "off_desk_probe",
      input: { q: "hi" },
      actor,
    });
    expect(r.status).toBe("ok");
    expect(r.data).toBe("hi");
  });

  test("a duplicate extra tool name is rejected", () => {
    const dup: Tool<never, string> = {
      name: "calculator",
      description: "duplicate",
      enabled: true,
      permission: { requires: [] },
      input: { fields: {} },
      async run(): Promise<string> {
        return "nope";
      },
    };
    expect(() => new ToolService({ extraTools: [dup as Tool<unknown, unknown>] })).toThrow(
      /duplicate tool name/,
    );
  });

  test("DEFAULT_TOOLS lists exactly the default tools by name", () => {
    expect(DEFAULT_TOOLS.map((t) => t.name)).toEqual(DEFAULT_NAMES);
  });
});

// ---------- menu ↔ registry wiring ----------

describe("menu wiring", () => {
  test("the main menu is a clean 2x2 grid", () => {
    const kb = buildMainMenu();
    expect(kb.inline_keyboard.length).toBe(2);
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual([
      "💬 Chat",
      "🛠 Tools",
      "⌨️ Commands",
      "⚙️ Settings",
    ]);
  });

  test("the tools entry renders one line per active tool", () => {
    const svc = new ToolService();
    const names = svc.listActiveNames();
    const text = toolListText(names);
    expect(names.length).toBe(DEFAULT_NAMES.length);
    expect(text).toContain("BOBI's active tools:");
    // One numbered line per active tool, in registry order.
    for (let i = 1; i <= names.length; i++) {
      expect(text).toContain(`${i}. `);
    }
    expect(text).toContain("Calculator"); // calculator's English label
    expect(text).toContain("Unit converter"); // unit_converter's English label
    expect(text).toContain("Web page reader"); // fetch_url's Persian label
  });

  test("the tools reply is built from the registry, not a placeholder", () => {
    const svc = new ToolService();
    expect(replyForCallback(CALLBACKS.tools, svc.listActiveNames())).not.toContain(
      "در مرحلهٔ بعد",
    );
  });

  test("an empty registry renders an honest 'no active tools' message", () => {
    const text = toolListText([]);
    expect(text).toContain("no active tools");
  });

  test("listing a tool does not grant permission to run it", async () => {
    const svc = new ToolService();
    // The caller is listed the tool in the menu (active) but has no grant.
    expect(svc.listActiveNames()).toContain("calculator");
    const r = await svc.runTool({
      tool: "calculator",
      input: { op: "add", a: 1, b: 1 },
      actor: { userId: "user-x", permissions: [] },
    });
    expect(r.status).toBe("not_allowed");
    // ...while the same tool runs for an authorized identity.
    const ok = await svc.runTool({
      tool: "calculator",
      input: { op: "add", a: 1, b: 1 },
      actor: FULL_ACTOR,
    });
    expect(ok.status).toBe("ok");
  });

  test("the tools menu works even with no tool service attached", () => {
    // Bot deps are optional: with no service the callback stays a placeholder.
    const text = replyForCallback(CALLBACKS.tools, undefined);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  test("chat and about entries still return their replies", () => {
    expect(replyForCallback(CALLBACKS.chat).length).toBeGreaterThan(0);
    expect(replyForCallback(CALLBACKS.about).length).toBeGreaterThan(0);
    expect(replyForCallback("menu:nope")).toBe("Unknown option.");
  });
});

// ---------- group / privacy-mode behavior is untouched ----------

describe("message routing still behaves as before", () => {
  const BOT_ID = 42;
  const ME = { id: BOT_ID, is_bot: true, first_name: "BOBI", username: "bobi_bot" } as const;

  function ctx(o: { chatType?: string; text?: string; replyFromId?: number; hasMessage?: boolean }) {
    const base: Record<string, unknown> = { me: ME };
    if (o.hasMessage !== false) {
      base.message = {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: o.chatType ?? "private" },
        ...(o.text !== undefined ? { text: o.text } : {}),
        ...(o.replyFromId !== undefined
          ? { reply_to_message: { from: { id: o.replyFromId } } }
          : {}),
      };
    }
    return base as unknown as Parameters<typeof shouldHandleMessage>[0];
  }

  test("private chat is handled", () => {
    expect(shouldHandleMessage(ctx({ chatType: "private", text: "سلام" }), BOT_ID)).toBe(true);
  });

  test("group plain text is ignored", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", text: "سلام" }), BOT_ID)).toBe(false);
    expect(shouldHandleMessage(ctx({ chatType: "supergroup", text: "hi" }), BOT_ID)).toBe(false);
  });

  test("group reply to the bot and its commands are handled", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", replyFromId: BOT_ID }), BOT_ID)).toBe(true);
    expect(shouldHandleMessage(ctx({ chatType: "group", text: "/start" }), BOT_ID)).toBe(true);
    expect(shouldHandleMessage(ctx({ chatType: "group", text: "/help@bobi_bot" }), BOT_ID)).toBe(true);
  });

  test("commands aimed at other bots are ignored", () => {
    expect(shouldHandleMessage(ctx({ chatType: "group", text: "/help@OtherBot" }), BOT_ID)).toBe(false);
    expect(shouldHandleMessage(ctx({ chatType: "group", replyFromId: 999 }), BOT_ID)).toBe(false);
  });
});
