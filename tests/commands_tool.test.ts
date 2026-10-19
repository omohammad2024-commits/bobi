import { describe, expect, test } from "bun:test";
import {
  createCommandsTool,
  COMMANDS_TOOL_NAME,
  COMMANDS_PERMISSION,
} from "../src/tools/commands";
import { searchVisibleTools, type VisibleToolInfo } from "../src/tools/tool_search";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolActor } from "../src/tools/types";
import { COMMAND_HELP, visibleCommandHelp } from "../src/bot/command_help";
import {
  COMMAND_HELP as BOT_COMMAND_HELP,
  visibleCommandHelp as botVisibleCommandHelp,
} from "../src/bot/bot";

const OWNER: ToolActor = { userId: "1", permissions: [COMMANDS_PERMISSION] };
const STRANGER: ToolActor = { userId: "999", permissions: [COMMANDS_PERMISSION] };

const tool = () =>
  createCommandsTool({ isOwner: (userId) => userId === "1" }) as Tool<unknown, unknown>;

describe("commands tool", () => {
  test("the owner sees every command", async () => {
    const svc = new ToolService({ extraTools: [tool()] });
    const res = await svc.execute({ tool: COMMANDS_TOOL_NAME, input: {}, actor: OWNER });
    expect(res.status).toBe("ok");
    const data = res.data as { commands: Array<{ name: string }> };
    expect(data.commands.length).toBe(COMMAND_HELP.length);
    expect(data.commands.length).toBeGreaterThan(60);
    // Spot-check entries carry the fields the model needs to present them.
    const first = (res.data as any).commands[0];
    expect(typeof first.name).toBe("string");
    expect(typeof first.description).toBe("string");
    expect(typeof first.group).toBe("string");
  });

  test("a non-owner sees only the public commands — owner-only never leaks", async () => {
    const svc = new ToolService({ extraTools: [tool()] });
    const res = await svc.execute({ tool: COMMANDS_TOOL_NAME, input: {}, actor: STRANGER });
    expect(res.status).toBe("ok");
    const names = (res.data as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
    expect(names.sort()).toEqual(["commands", "help", "start", "voice"]);
    const ownerOnlyNames = COMMAND_HELP.filter((c) => c.ownerOnly).map((c) => c.name);
    expect(ownerOnlyNames.length).toBeGreaterThan(0);
    for (const n of ownerOnlyNames) expect(names).not.toContain(n);
  });

  test("a throwing isOwner resolver fails closed to the public listing", async () => {
    const bad = createCommandsTool({
      isOwner: () => {
        throw new Error("db down");
      },
    }) as Tool<unknown, unknown>;
    const svc = new ToolService({ extraTools: [bad] });
    const res = await svc.execute({ tool: COMMANDS_TOOL_NAME, input: {}, actor: OWNER });
    expect(res.status).toBe("ok");
    const names = (res.data as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
    expect(names.sort()).toEqual(["commands", "help", "start", "voice"]);
  });

  test("the tool needs no input and performs no I/O", async () => {
    const t = createCommandsTool({ isOwner: () => true });
    expect(t.input).toEqual({ fields: {} });
    const started = Date.now();
    const out = await t.run({}, { actor: OWNER } as any);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.commands.length).toBe(COMMAND_HELP.length);
  });

  test("tool_search finds it first for a command-list query", () => {
    const t = createCommandsTool({ isOwner: () => true });
    const visible: VisibleToolInfo[] = [
      { name: t.name, description: t.description, fields: [] },
      { name: "web_search", description: "Search the web for current information.", fields: [] },
      { name: "scheduled_tasks", description: "Manage scheduled tasks.", fields: [] },
    ];
    for (const q of ["commands", "command list", "list commands"]) {
      const hits = searchVisibleTools(visible, q, 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.name).toBe(COMMANDS_TOOL_NAME);
    }
  });

  test("the extraction did not fork the catalog: bot.ts re-exports the same data", () => {
    expect(BOT_COMMAND_HELP).toEqual(COMMAND_HELP);
    expect(botVisibleCommandHelp(true)).toEqual(visibleCommandHelp(true));
    expect(botVisibleCommandHelp(false)).toEqual(visibleCommandHelp(false));
  });
});
