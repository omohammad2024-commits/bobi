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
  test("the main menu has six section buttons in three rows", () => {
    const kb = buildMainMenu();
    expect(kb.inline_keyboard.length).toBe(3);
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual([
      "💬 گفت‌وگو",
      "🛠 ابزارها",
      "⌨️ فرمان‌ها",
      "⚙️ تنظیمات",
      "ℹ️ دربارهٔ بابی",
      "❓ راهنما",
    ]);
  });

  test("the tools entry renders one line per active tool", () => {
    const svc = new ToolService();
    const names = svc.listActiveNames();
    const text = toolListText(names);
    expect(names.length).toBe(DEFAULT_NAMES.length);
    expect(text).toContain("ابزارهای فعال بابی:");
    // One numbered line per active tool, in registry order.
    for (let i = 1; i <= names.length; i++) {
      expect(text).toContain(`${i}. `);
    }
    expect(text).toContain("ماشین‌حساب"); // calculator's Persian label
    expect(text).toContain("تبدیل واحد"); // unit_converter's Persian label
    expect(text).toContain("خواندن صفحهٔ وب"); // fetch_url's Persian label
  });

  test("the tools reply is built from the registry, not a placeholder", () => {
    const svc = new ToolService();
    expect(replyForCallback(CALLBACKS.tools, svc.listActiveNames())).not.toContain(
      "در مرحلهٔ بعد",
    );
  });

  test("an empty registry renders an honest 'no active tools' message", () => {
    const text = toolListText([]);
    expect(text).toContain("هیچ ابزار فعالی وجود ندارد");
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
    expect(replyForCallback("menu:nope")).toBe("گزینهٔ نامشخص.");
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
