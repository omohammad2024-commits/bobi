/**
 * MCP bridge, against a real local server.
 *
 * The config tests prove what may be configured; these prove what actually
 * happens when something is. They spawn `tests/fixtures/mcp/echo_server.js` — a
 * minimal MCP stdio server implementing an `add` tool and a `greet` tool with
 * a nested input schema — over the real SDK transport, because the interesting
 * failures (handshake, tool discovery, argument forwarding, process teardown)
 * only exist end to end.
 *
 * Nothing here reaches the network.
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  McpManager,
  buildMcpToolName,
  buildMcpToolNames,
  createMcpTools,
  mcpToolNames,
  mcpTools,
  sanitizeRemoteToolName,
} from "../src/mcp/bridge";
import type { ConnectedServer, McpManager as McpManagerType } from "../src/mcp/bridge";
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

/** The fixture's `greet` schema, exactly as the server advertises it. */
const GREET_SCHEMA = {
  type: "object",
  properties: {
    person: {
      type: "object",
      properties: { name: { type: "string" }, title: { type: "string" } },
      required: ["name"],
    },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["person"],
};

/** The fixture's `add` schema, exactly as the server advertises it. */
const ADD_SCHEMA = {
  type: "object",
  properties: { a: { type: "number" }, b: { type: "number" } },
  required: ["a", "b"],
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
      expect(status[0]!.toolCount).toBe(2);
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

  test("a broken server yields no tools", async () => {
    const broken: McpServerConfig = {
      name: "broken",
      transport: "stdio",
      enabled: true,
      command: "definitely-not-a-real-command-xyz",
    };
    await withManager([broken], async (m) => {
      expect(mcpTools(m)).toEqual([]);
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
  test("each remote tool becomes its own BOBI tool", async () => {
    await withManager([calc], async (m) => {
      const tools = mcpTools(m);
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["mcp_calc_add", "mcp_calc_greet"]);
      expect(tools[0]!.enabled).toBe(true);
      expect(tools[1]!.enabled).toBe(true);
      // Each tool carries its own remote description, not a shared catalogue.
      expect(tools[0]!.description).toBe("Adds two numbers.");
      expect(tools[1]!.description).toBe("Greets a person.");
    });
  });

  test("every per-tool tool carries the per-server permission and the real schema", async () => {
    await withManager([calc], async (m) => {
      const tools = mcpTools(m);
      for (const tool of tools) {
        expect(tool.permission.requires).toEqual(["tools:mcp_calc"]);
      }
      // The remote schema is carried verbatim, with passthrough validation:
      // no lossy FieldSpec translation stands in front of the server.
      const greet = tools.find((t) => t.name === "mcp_calc_greet")!;
      const greetInput = greet.input as unknown as {
        fields: Record<string, unknown>;
        passthrough?: boolean;
        jsonSchema?: Record<string, unknown>;
      };
      expect(greetInput.fields).toEqual({});
      expect(greetInput.passthrough).toBe(true);
      expect(greetInput.jsonSchema).toEqual(GREET_SCHEMA);
      const add = tools.find((t) => t.name === "mcp_calc_add")!;
      const addInput = add.input as unknown as { jsonSchema?: Record<string, unknown> };
      expect(addInput.jsonSchema).toEqual(ADD_SCHEMA);
    });
  });

  test("toolSpecsFor exposes greet's real nested inputSchema as parameters", async () => {
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      const specs = svc.toolSpecsFor({
        userId: "u1",
        permissions: ["tools:mcp_calc"],
      });
      const greet = specs.find((s) => s.name === "mcp_calc_greet");
      expect(greet).toBeDefined();
      // Deep-equal: the model receives the server's schema unchanged,
      // nested object and all — not a flattened BOBI approximation.
      expect(greet!.parameters).toEqual(GREET_SCHEMA);
      const add = specs.find((s) => s.name === "mcp_calc_add");
      expect(add!.parameters).toEqual(ADD_SCHEMA);
    });
  });

  test("a server with no tools registers nothing", async () => {
    await withManager([{ ...calc, enabled: false }], async (m) => {
      expect(mcpTools(m)).toEqual([]);
    });
  });

  test("the tool runs end to end through the Executor", async () => {
    // This is the path the model actually takes: registry → executor → MCP.
    // Arguments are the remote tool's own arguments directly — no envelope.
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      const result = await svc.runTool({
        tool: "mcp_calc_add",
        input: { a: 40, b: 2 },
        actor: { userId: "u1", permissions: ["tools:mcp_calc"] },
      });
      expect(result.status).toBe("ok");
      expect((result.data as { server: string; text: string }).server).toBe("calc");
      expect((result.data as { text: string }).text).toBe("sum=42");
    });
  });

  test("executing greet through ToolService forwards nested args intact", async () => {
    // Nested object + array arguments must survive the Executor's
    // passthrough validation and reach the server unchanged.
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      const result = await svc.runTool({
        tool: "mcp_calc_greet",
        input: { person: { name: "Sara", title: "Dr" }, tags: ["a", "b"] },
        actor: { userId: "u1", permissions: ["tools:mcp_calc"] },
      });
      expect(result.status).toBe("ok");
      expect((result.data as { text: string }).text).toBe("hello Dr Sara [2 tags]");

      const noTitle = await svc.runTool({
        tool: "mcp_calc_greet",
        input: { person: { name: "Sara" }, tags: [] },
        actor: { userId: "u1", permissions: ["tools:mcp_calc"] },
      });
      expect(noTitle.status).toBe("ok");
      expect((noTitle.data as { text: string }).text).toBe("hello Sara [0 tags]");
    });
  });

  test("an actor without the MCP permission is refused", async () => {
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      const result = await svc.runTool({
        tool: "mcp_calc_add",
        input: { a: 1, b: 1 },
        actor: { userId: "u1", permissions: [] },
      });
      expect(result.status).toBe("not_allowed");
    });
  });

  test("a BOBI tool name the server does not have is reported to the model", async () => {
    await withManager([calc], async (m) => {
      const svc = new ToolService({ extraTools: mcpTools(m) });
      const result = await svc.runTool({
        tool: "mcp_calc_invented",
        input: {},
        actor: { userId: "u1", permissions: ["tools:mcp_calc"] },
      });
      // Reported as not_found so the loop can tell the model it was wrong.
      expect(result.status).toBe("not_found");
    });
  });
});

describe("naming", () => {
  test("sanitize collapses unsafe runs, lowercases and trims", () => {
    expect(sanitizeRemoteToolName("Get Weather!")).toBe("get_weather");
    expect(sanitizeRemoteToolName("get--weather")).toBe("get_weather");
    expect(sanitizeRemoteToolName("get_weather")).toBe("get_weather");
    expect(sanitizeRemoteToolName("  Spaces  And--Dashes  ")).toBe("spaces_and_dashes");
    expect(sanitizeRemoteToolName("!!!")).toBe("tool");
    expect(sanitizeRemoteToolName("")).toBe("tool");
    expect(buildMcpToolName("calc", "Add")).toBe("mcp_calc_add");
  });

  test("collisions after sanitization get deterministic suffixes in listed order", () => {
    expect(buildMcpToolNames("svc", ["Get Weather!", "get--weather", "get_weather"])).toEqual([
      "mcp_svc_get_weather",
      "mcp_svc_get_weather_2",
      "mcp_svc_get_weather_3",
    ]);
    // The same resolution through the server-shaped helper, no connection.
    const server: ConnectedServer = {
      config: { name: "svc", transport: "stdio", enabled: true },
      tools: [
        { name: "Get Weather!", description: "", inputSchema: { type: "object" } },
        { name: "get--weather", description: "", inputSchema: { type: "object" } },
        { name: "get_weather", description: "", inputSchema: { type: "object" } },
      ],
    };
    expect(mcpToolNames(server)).toEqual([
      "mcp_svc_get_weather",
      "mcp_svc_get_weather_2",
      "mcp_svc_get_weather_3",
    ]);
  });
});

describe("stub-manager routing", () => {
  test("run() routes to the ORIGINAL remote name when the BOBI name was sanitized", async () => {
    const calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
    const server: ConnectedServer = {
      config: { name: "weather", transport: "stdio", enabled: true },
      tools: [
        {
          name: "Get Weather!",
          description: "Fetches the weather.",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    };
    const fakeManager = {
      callTool: async (
        serverName: string,
        tool: string,
        args: Record<string, unknown>,
        _signal: AbortSignal,
      ) => {
        calls.push({ server: serverName, tool, args });
        return "sunny";
      },
      connectedServers: () => [server],
    };

    const tools = createMcpTools(fakeManager as unknown as McpManagerType, server);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("mcp_weather_get_weather");
    expect(tools[0]!.permission.requires).toEqual(["tools:mcp_weather"]);

    const out = await tools[0]!.run(
      { city: "Tehran" },
      {
        clock: () => new Date(),
        actor: { userId: "u1", permissions: ["tools:mcp_weather"] },
        signal: new AbortController().signal,
      },
    );
    expect(out).toEqual({ server: "weather", text: "sunny" });
    // The server must be called with its own spelling, not BOBI's.
    expect(calls).toEqual([
      { server: "weather", tool: "Get Weather!", args: { city: "Tehran" } },
    ]);
  });

  test("collision-suffixed tools each route to their own original name", async () => {
    const calls: string[] = [];
    const server: ConnectedServer = {
      config: { name: "svc", transport: "stdio", enabled: true },
      tools: [
        { name: "Get Weather!", description: "one", inputSchema: { type: "object" } },
        { name: "get--weather", description: "two", inputSchema: { type: "object" } },
      ],
    };
    const fakeManager = {
      callTool: async (_server: string, tool: string) => {
        calls.push(tool);
        return `via ${tool}`;
      },
      connectedServers: () => [server],
    };
    const tools = createMcpTools(fakeManager as unknown as McpManagerType, server);
    expect(tools.map((t) => t.name)).toEqual(["mcp_svc_get_weather", "mcp_svc_get_weather_2"]);
    const ctx = {
      clock: () => new Date(),
      actor: { userId: "u1", permissions: ["tools:mcp_svc"] },
      signal: new AbortController().signal,
    };
    await tools[1]!.run({}, ctx);
    await tools[0]!.run({}, ctx);
    expect(calls).toEqual(["get--weather", "Get Weather!"]);
  });

  test("an empty remote description gets a generated line naming server and tool", () => {
    const server: ConnectedServer = {
      config: { name: "svc", transport: "stdio", enabled: true },
      tools: [{ name: "mystery", description: "", inputSchema: { type: "object" } }],
    };
    const fakeManager = {
      callTool: async () => "x",
      connectedServers: () => [server],
    };
    const tools = createMcpTools(fakeManager as unknown as McpManagerType, server);
    expect(tools[0]!.description).toContain("svc");
    expect(tools[0]!.description).toContain("mystery");
  });

  test("a connected server with zero tools yields zero tools", () => {
    const server: ConnectedServer = {
      config: { name: "empty", transport: "stdio", enabled: true },
      tools: [],
    };
    const fakeManager = {
      callTool: async () => "x",
      connectedServers: () => [server],
    };
    expect(createMcpTools(fakeManager as unknown as McpManagerType, server)).toEqual([]);
    expect(
      mcpTools({
        connectedServers: () => [server],
      } as unknown as McpManagerType),
    ).toEqual([]);
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
