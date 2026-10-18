/**
 * MCP bridge, against a real local server.
 *
 * The config tests prove what may be configured; these prove what actually
 * happens when something is. They spawn `tests/fixtures/mcp/echo_server.js` — a
 * minimal MCP stdio server implementing one `add` tool — over the real SDK
 * transport, because the interesting failures (handshake, tool discovery,
 * argument forwarding, process teardown) only exist end to end.
 *
 * Nothing here reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpManager, mcpTools } from "../src/mcp/bridge";
import { ToolService } from "../src/tools/service";
import type { McpServerConfig } from "../src/mcp/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "fixtures", "mcp", "echo_server.js");

const calc: McpServerConfig = {
  name: "calc",
  transport: "stdio",
  enabled: true,
  command: "node",
  args: [SERVER],
};

/** Build a connected manager, always closing it afterwards. */
async function withManager(
  configs: McpServerConfig[],
  fn: (m: McpManager) => Promise<void>,
): Promise<void> {
  const manager = new McpManager(configs);
  try {
    await manager.connectAll();
    await fn(manager);
  } finally {
    await manager.closeAll();
  }
}

describe("connecting", () => {
  test("a real stdio server connects and reports its tools", async () => {
    await withManager([calc], async (m) => {
      const status = m.status();
      expect(status).toHaveLength(1);
      expect(status[0]!.connected).toBe(true);
      expect(status[0]!.toolCount).toBe(1);
      expect(status[0]!.error).toBeUndefined();
      expect(m.hasTools).toBe(true);
    });
  });

  test("a disabled server is never spawned", async () => {
    await withManager([{ ...calc, enabled: false }], async (m) => {
      const status = m.status();
      expect(status[0]!.enabled).toBe(false);
      expect(status[0]!.connected).toBe(false);
      expect(m.hasTools).toBe(false);
      // No tools means nothing is offered to the model.
      expect(mcpTools(m)).toHaveLength(0);
    });
  });

  test("a server that cannot start is reported, not thrown", async () => {
    // One broken server must not stop the bot or the other servers.
    const broken: McpServerConfig = {
      name: "broken",
      transport: "stdio",
      enabled: true,
      command: "definitely-not-a-real-command-xyz",
    };
    await withManager([broken, calc], async (m) => {
      const status = m.status();
      const brokenStatus = status.find((s) => s.name === "broken")!;
      expect(brokenStatus.connected).toBe(false);
      expect(brokenStatus.error).toBeDefined();
      // The healthy server still works.
      expect(status.find((s) => s.name === "calc")!.connected).toBe(true);
    });
  });

  test("the error note is short and carries no credentials", async () => {
    const broken: McpServerConfig = {
      name: "broken",
      transport: "stdio",
      enabled: true,
      command: "nope-xyz",
    };
    await withManager([broken], async (m) => {
      const error = m.status()[0]!.error ?? "";
      expect(error.length).toBeLessThanOrEqual(200);
      expect(error).not.toContain("Bearer ");
    });
  });

  test("an unreachable http endpoint fails without hanging", async () => {
    // A dead endpoint must be reported, and the connect timeout must fire
    // rather than leaving the bot waiting forever at startup.
    const unreachable: McpServerConfig = {
      name: "remote",
      transport: "http",
      enabled: true,
      url: "http://127.0.0.1:9/mcp",
    };
    await withManager([unreachable], async (m) => {
      expect(m.status()[0]!.connected).toBe(false);
      expect(m.status()[0]!.error).toBeDefined();
    });
  }, 40_000);
});

describe("calling tools", () => {
  test("a real tool call returns the server's result", async () => {
    await withManager([calc], async (m) => {
      const out = await m.callTool("calc", "add", { a: 20, b: 22 }, new AbortController().signal);
      expect(out).toBe("sum=42");
    });
  });

  test("a tool the server never advertised is refused", async () => {
    // The model supplies the tool name, so only what the server actually
    // listed may be called.
    await withManager([calc], async (m) => {
      await expect(
        m.callTool("calc", "rm_rf", {}, new AbortController().signal),
      ).rejects.toMatchObject({ kind: "not_found" });
    });
  });

  test("a server that is not connected is refused", async () => {
    await withManager([calc], async (m) => {
      await expect(
        m.callTool("nope", "add", {}, new AbortController().signal),
      ).rejects.toMatchObject({ kind: "not_found" });
    });
  });

  test("a failed call does not break the connection", async () => {
    await withManager([calc], async (m) => {
      await expect(
        m.callTool("calc", "missing", {}, new AbortController().signal),
      ).rejects.toMatchObject({ kind: "not_found" });

      // The next real call still works.
      const out = await m.callTool("calc", "add", { a: 1, b: 2 }, new AbortController().signal);
      expect(out).toBe("sum=3");
    });
  });

  test("an already-aborted signal cancels the call", async () => {
    await withManager([calc], async (m) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        m.callTool("calc", "add", { a: 1, b: 2 }, controller.signal),
      ).rejects.toBeDefined();
    });
  });
});

describe("registration as SOL tools", () => {
  test("each connected server becomes one adapter tool", async () => {
    await withManager([calc], async (m) => {
      const tools = mcpTools(m);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("mcp_calc");
      expect(tools[0]!.enabled).toBe(true);
      // The tools it exposes are listed for the model.
      expect(tools[0]!.description).toContain("add");
    });
  });

  test("a server with no tools registers nothing", async () => {
    await withManager([{ ...calc, enabled: false }], async (m) => {
      expect(mcpTools(m)).toEqual([]);
    });
  });

  test("the tool runs end to end through the Executor", async () => {
    // This is the path the model actually takes: registry → executor → MCP.
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      const result = await svc.runTool({
        tool: "mcp_calc",
        input: { tool: "add", arguments: { a: 40, b: 2 } },
        actor: { userId: "u1", permissions: ["tools:mcp_calc"] },
      });
      expect(result.status).toBe("ok");
      expect((result.data as { text: string }).text).toBe("sum=42");
    });
  });

  test("an actor without the MCP permission is refused", async () => {
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      const result = await svc.runTool({
        tool: "mcp_calc",
        input: { tool: "add", arguments: { a: 1, b: 1 } },
        actor: { userId: "u1", permissions: [] },
      });
      expect(result.status).toBe("not_allowed");
    });
  });

  test("the envelope is validated before the call reaches the server", async () => {
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      // A missing `tool` field is rejected by the shared validator.
      const bad = await svc.runTool({
        tool: "mcp_calc",
        input: { arguments: { a: 1 } },
        actor: { userId: "u1", permissions: ["tools:mcp_calc"] },
      });
      expect(bad.status).toBe("invalid_input");

      // A non-object `arguments` is rejected too.
      const bad2 = await svc.runTool({
        tool: "mcp_calc",
        input: { tool: "add", arguments: "not-an-object" },
        actor: { userId: "u1", permissions: ["tools:mcp_calc"] },
      });
      expect(bad2.status).toBe("invalid_input");
    });
  });

  test("a tool name the server does not have is reported to the model", async () => {
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      const result = await svc.runTool({
        tool: "mcp_calc",
        input: { tool: "invented", arguments: {} },
        actor: { userId: "u1", permissions: ["tools:mcp_calc"] },
      });
      // Reported as not_found so the loop can tell the model it was wrong.
      expect(result.status).toBe("not_found");
    });
  });
});

describe("lifecycle", () => {
  test("closeAll is safe to call twice", async () => {
    const manager = new McpManager([calc]);
    await manager.connectAll();
    await manager.closeAll();
    await expect(manager.closeAll()).resolves.toBeUndefined();
  });

  test("closeOne leaves the other servers connected", async () => {
    const second: McpServerConfig = { ...calc, name: "calc2" };
    await withManager([calc, second], async (m) => {
      expect(m.status().filter((s) => s.connected)).toHaveLength(2);
      await m.closeOne("calc");
      const status = m.status();
      expect(status.find((s) => s.name === "calc")!.connected).toBe(false);
      expect(status.find((s) => s.name === "calc2")!.connected).toBe(true);
    });
  });

  test("reconnecting a closed server works", async () => {
    const manager = new McpManager([calc]);
    try {
      await manager.connectAll();
      await manager.closeOne("calc");
      expect(manager.status()[0]!.connected).toBe(false);

      expect(await manager.connectOne(calc)).toBe(true);
      expect(manager.status()[0]!.connected).toBe(true);
      const out = await manager.callTool("calc", "add", { a: 2, b: 3 }, new AbortController().signal);
      expect(out).toBe("sum=5");
    } finally {
      await manager.closeAll();
    }
  });
});
