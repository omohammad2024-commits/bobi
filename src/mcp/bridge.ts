/**
 * MCP client manager — connects configured servers and exposes their tools.
 *
 * Each MCP server brings its own tools, described by a JSON Schema the server
 * supplies. Every remote tool becomes its own BOBI tool: the model sees the
 * remote tool's real name (sanitized into a BOBI tool name), its real
 * description, and its real `inputSchema` as the tool's parameters — not a
 * generic envelope it has to guess its way through.
 *
 * Why `passthrough` instead of translating the schema: BOBI's Executor
 * normally validates input against a declarative FieldSpec, and an MCP tool's
 * schema is arbitrary JSON Schema — nested objects, arrays of objects,
 * conditionals a flat FieldSpec cannot express. Mapping every remote schema
 * into FieldSpec would be a lossy translation, and a lossy validator in front
 * of an untrusted server is worse than no validator: it would reject arguments
 * the server would have accepted, and accept shapes it never declared. So
 * each per-tool adapter declares `fields: {}`, carries the remote schema
 * verbatim in `jsonSchema` (which `toJsonSchema` hands to the model
 * unchanged), and sets `passthrough: true` so the Executor accepts any plain
 * object and forwards it as-is. The SERVER remains the authority on its own
 * arguments and validates them itself — the honest choice, because it is the
 * only party that actually knows its protocol.
 *
 * Every connection is per-owner: servers are spawned from owner-supplied config
 * and carry the bot process's authority, so nothing here accepts a server
 * definition from a model or an ordinary user.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolError } from "../tools/errors";
import type { Tool, ToolActor } from "../tools/types";
import { MAX_TOOLS_PER_SERVER } from "./types";
import type { McpServerConfig } from "./types";

/** One tool as the remote server described it. */
export interface RemoteToolInfo {
  name: string;
  description: string;
  /** The server's JSON Schema for this tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/** A connected server and the tools it reported. */
export interface ConnectedServer {
  config: McpServerConfig;
  tools: readonly RemoteToolInfo[];
}

/** What the manager knows about one server, for the owner panel. */
export interface ServerStatus {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  /** Safe, short failure note. Never a raw stderr dump or a token. */
  error?: string;
}

/** Per-call timeout for connecting and for each tool invocation. */
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;

/**
 * Ceiling on a tool result handed back to the model.
 *
 * A server can return an enormous payload; the model's context is the real
 * constraint, so the result is clipped here rather than at the prompt.
 */
const MAX_RESULT_CHARS = 8_000;

export class McpManager {
  private readonly configs: readonly McpServerConfig[];
  private readonly clients = new Map<string, Client>();
  private readonly connected = new Map<string, ConnectedServer>();
  private readonly errors = new Map<string, string>();

  constructor(configs: readonly McpServerConfig[]) {
    this.configs = configs;
  }

  /** Servers that were configured and enabled. */
  get enabledConfigs(): readonly McpServerConfig[] {
    return this.configs.filter((c) => c.enabled);
  }

  /**
   * Connect every enabled server.
   *
   * A server that fails is recorded and skipped: one broken MCP server must not
   * prevent the bot from starting or the other servers from working.
   */
  async connectAll(): Promise<void> {
    for (const config of this.enabledConfigs) {
      await this.connectOne(config);
    }
  }

  /**
   * Connect one server and list its tools.
   *
   * Failures are captured into `errors` rather than thrown, so the status view
   * can explain what went wrong without the caller having to handle each case.
   */
  async connectOne(config: McpServerConfig): Promise<boolean> {
    await this.closeOne(config.name);

    let client: Client | undefined;
    try {
      client = new Client({ name: "bobi", version: "0.1.0" }, { capabilities: {} });

      // One transport per protocol. The two classes are structurally different
      // in the SDK's typings (the HTTP one carries a mutable sessionId), so the
      // union is narrowed by using the client's own connect rather than a
      // shared variable.
      if (config.transport === "stdio") {
        await withTimeout(
          client.connect(
            new StdioClientTransport({
              command: config.command ?? "",
              ...(config.args !== undefined ? { args: config.args } : {}),
              ...(config.env !== undefined ? { env: config.env } : {}),
              ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
              // Capture stderr so a crashing server's output does not go to the
              // bot's console; it is read only for a short diagnostic.
              stderr: "pipe",
            }),
          ),
          CONNECT_TIMEOUT_MS,
        );
      } else {
        // The SDK's HTTP transport declares `sessionId?: string`, which
        // `exactOptionalPropertyTypes` rejects as a `Transport`. The runtime
        // shape satisfies the interface; only the optionality spelling differs,
        // so the assertion is narrow and documented rather than `any`.
        const transport = new StreamableHTTPClientTransport(new URL(config.url ?? ""), {
          ...(config.token !== undefined
            ? { requestInit: { headers: { authorization: `Bearer ${config.token}` } } }
            : {}),
        }) as unknown as Transport;

        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS);
      }

      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS);
      const tools = normaliseTools(listed.tools);

      this.clients.set(config.name, client);
      this.connected.set(config.name, { config, tools });
      this.errors.delete(config.name);
      return true;
    } catch (err) {
      this.errors.set(config.name, safeError(err));
      // A client that connected but failed to list is still closed.
      if (client !== undefined) {
        try {
          await client.close();
        } catch {
          // Closing a half-open connection is best-effort.
        }
      }
      return false;
    }
  }

  /** Close one server, if connected. */
  async closeOne(name: string): Promise<void> {
    const client = this.clients.get(name);
    this.clients.delete(name);
    this.connected.delete(name);
    if (client !== undefined) {
      try {
        await client.close();
      } catch {
        // An already-dead transport needs no further action.
      }
    }
  }

  /** Close every connection, on shutdown. */
  async closeAll(): Promise<void> {
    for (const name of [...this.clients.keys()]) {
      await this.closeOne(name);
    }
  }

  /** Status of every configured server, for the owner panel. */
  status(): ServerStatus[] {
    return this.configs.map((config) => {
      const server = this.connected.get(config.name);
      const error = this.errors.get(config.name);
      return {
        name: config.name,
        transport: config.transport,
        enabled: config.enabled,
        connected: server !== undefined,
        toolCount: server?.tools.length ?? 0,
        ...(error !== undefined ? { error } : {}),
      };
    });
  }

  /** True when at least one server is connected and exposes a tool. */
  get hasTools(): boolean {
    for (const server of this.connected.values()) {
      if (server.tools.length > 0) return true;
    }
    return false;
  }

  /** Connected servers, for building their BOBI tool adapters. */
  connectedServers(): ConnectedServer[] {
    return [...this.connected.values()];
  }

  /**
   * Call a remote tool.
   *
   * The server name and tool name come from the model, so neither is trusted:
   * the server must be one that is actually connected, and the tool must be one
   * the server itself reported. A model cannot reach a tool that was never
   * listed, nor invent a server.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const client = this.clients.get(serverName);
    const server = this.connected.get(serverName);
    if (client === undefined || server === undefined) {
      throw new ToolError("not_found", `سرور MCP «${serverName}» متصل نیست.`);
    }

    // Only a tool the server actually advertised may be called.
    const known = server.tools.find((t) => t.name === toolName);
    if (known === undefined) {
      throw new ToolError("not_found", `ابزار «${toolName}» در این سرور وجود ندارد.`);
    }

    let result;
    try {
      result = await withTimeout(
        client.callTool({ name: toolName, arguments: args }, undefined, {
          signal,
        }),
        CALL_TIMEOUT_MS,
      );
    } catch (err) {
      if (signal.aborted) throw new ToolError("aborted", "فراخوانی ابزار لغو شد.");
      throw new ToolError("internal", "فراخوانی ابزار MCP ناموفق بود.");
    }

    const text = renderContent(result);
    if (result.isError === true) {
      // A tool-level error is reported back to the model as a result, not an
      // exception: it often means "wrong arguments", which the model can fix.
      throw new ToolError("invalid_input", text.length > 0 ? text : "سرور خطا برگرداند.");
    }
    if (text.trim().length === 0) {
      throw new ToolError("invalid_result", "سرور پاسخی برنگرداند.");
    }
    return clip(text, MAX_RESULT_CHARS);
  }
}

/**
 * Sanitize one remote tool name into the suffix of a BOBI tool name.
 *
 * Remote names are server-supplied and arbitrary ("Get Weather!", "get--weather"),
 * while BOBI tool names are lowercase snake_case the model and providers can
 * address unambiguously. Lowercase, collapse every run of characters outside
 * [a-z0-9_] into a single "_", and trim "_" from both ends; a name with nothing
 * left becomes "tool" rather than an empty suffix.
 */
export function sanitizeRemoteToolName(remoteName: string): string {
  const sanitized = remoteName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "tool";
}

/**
 * The BOBI name for one remote tool, ignoring collisions.
 *
 * The server name is already validated against a strict pattern, so it is
 * safe inside a tool name as-is; only the remote part needs sanitizing.
 */
export function buildMcpToolName(serverName: string, remoteName: string): string {
  return `mcp_${serverName}_${sanitizeRemoteToolName(remoteName)}`;
}

/**
 * Collision-aware BOBI names for a list of remote names, in listed order.
 *
 * Two different remote names can sanitize to the same suffix ("Get Weather!",
 * "get--weather" and "get_weather" all become "get_weather"). The first in
 * the server's listed order keeps the plain name; later ones get deterministic
 * suffixes _2, _3, ... so every remote tool stays individually addressable.
 * Pure: no connection needed, which is what makes the naming unit-testable.
 */
export function buildMcpToolNames(
  serverName: string,
  remoteNames: readonly string[],
): string[] {
  const counts = new Map<string, number>();
  const used = new Set<string>();
  return remoteNames.map((remoteName) => {
    const base = sanitizeRemoteToolName(remoteName);
    let n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    let candidate = n === 1 ? base : `${base}_${n}`;
    // A suffixed candidate could itself collide with a different base that
    // was already handed out (remote names "a", "a", "a_2"): keep bumping
    // the suffix until the name is actually free.
    while (used.has(candidate)) {
      n += 1;
      counts.set(base, n);
      candidate = `${base}_${n}`;
    }
    used.add(candidate);
    return `mcp_${serverName}_${candidate}`;
  });
}

/**
 * Collision-aware BOBI names for every tool a connected server reported,
 * parallel to `server.tools` in listed order.
 */
export function mcpToolNames(server: ConnectedServer): string[] {
  return buildMcpToolNames(
    server.config.name,
    server.tools.map((t) => t.name),
  );
}

/**
 * Build one BOBI tool per remote tool on a connected server.
 *
 * A server with zero tools yields zero tools, so a dead or empty server
 * contributes nothing to the model's list — the same net effect the old
 * single disabled envelope tool had, without the envelope.
 */
export function createMcpTools(
  manager: McpManager,
  server: ConnectedServer,
): Tool<Record<string, unknown>, { server: string; text: string }>[] {
  const serverName = server.config.name;
  const names = mcpToolNames(server);

  return server.tools.map((remote, index) => {
    // The closure captures the ORIGINAL remote name, never the sanitized
    // BOBI name: routing must reach the exact tool the server advertised,
    // even when its BOBI name was sanitized or collision-suffixed.
    const originalName = remote.name;
    const description =
      remote.description.trim().length > 0
        ? remote.description
        : `MCP tool "${originalName}" on server "${serverName}".`;

    return {
      name: names[index]!,
      description,
      enabled: true,
      // The per-server grant model is unchanged: one permission key fronts
      // every tool a server exposes.
      permission: { requires: [`tools:mcp_${serverName}`] },
      input: {
        fields: {},
        // See the module header: the remote schema is carried verbatim for
        // the model, and passthrough lets the server — the authority on its
        // own arguments — validate them, instead of a lossy FieldSpec
        // translation second-guessing it here.
        passthrough: true,
        jsonSchema: remote.inputSchema,
      },

      async run(input, ctx) {
        // Passthrough validation hands the record through unchanged; it IS
        // the remote tool's argument object.
        const args: Record<string, unknown> = isRecord(input) ? input : {};
        // The manager re-checks that this tool exists on this server.
        const text = await manager.callTool(serverName, originalName, args, ctx.signal);
        return { server: serverName, text };
      },
    };
  });
}

/** BOBI tools for every connected server, for registration at startup. */
export function mcpTools(manager: McpManager): readonly Tool<unknown, unknown>[] {
  return manager
    .connectedServers()
    .flatMap(
      (server) => createMcpTools(manager, server) as unknown as Tool<unknown, unknown>[],
    );
}

// ---------- helpers ----------

/** Reduce a server's tool list to the shape the adapter needs. */
function normaliseTools(raw: readonly unknown[]): RemoteToolInfo[] {
  const out: RemoteToolInfo[] = [];
  for (const entry of raw.slice(0, MAX_TOOLS_PER_SERVER)) {
    if (!isRecord(entry)) continue;
    const name = entry["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    const description = typeof entry["description"] === "string" ? entry["description"] : "";
    const schema = isRecord(entry["inputSchema"]) ? entry["inputSchema"] : { type: "object" };
    out.push({ name, description, inputSchema: schema });
  }
  return out;
}

/** Flatten an MCP content array into text. */
function renderContent(result: unknown): string {
  if (!isRecord(result)) return "";
  const content = result["content"];
  if (!Array.isArray(content)) {
    // Some servers put a plain payload in structuredContent instead.
    const structured = result["structuredContent"];
    return structured !== undefined ? safeJson(structured) : "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = block["type"];
    if (type === "text" && typeof block["text"] === "string") {
      parts.push(block["text"]);
    } else if (type === "image" || type === "audio") {
      // Binary content is not something the text model can use; naming it is
      // more honest than dropping it silently.
      parts.push(`[${type}: ${String(block["mimeType"] ?? "unknown")}]`);
    } else if (type === "resource" && isRecord(block["resource"])) {
      const resource = block["resource"];
      if (typeof resource["text"] === "string") parts.push(resource["text"]);
    }
  }
  return parts.join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** A short, safe description of a connection failure. Never a token. */
function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // A URL carrying a token, or a stderr dump, must not reach the panel.
  return raw.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 200);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(کوتاه شد)`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Await a promise with a deadline.
 *
 * A hung MCP server would otherwise block startup or a tool call forever, and
 * the caller has no way to cancel it — the same failure the AI transport
 * already guards against.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** True when an actor may use a server's tools. Owner-granted permission only. */
export function actorMayUseServer(actor: ToolActor, serverName: string): boolean {
  return actor.permissions.includes(`tools:mcp_${serverName}`);
}
