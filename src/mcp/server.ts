/**
 * MCP *server* — exposes BOBI itself as an MCP tool server over stdio, so
 * trusted local tools (Claude Code, Cursor, …) can list conversations, read
 * history, and run a turn of the agent.
 *
 * This is the mirror of `bridge.ts`: the bridge is BOBI's MCP *client* (it
 * consumes other servers' tools); this module makes BOBI a *server* others
 * can consume — the equivalent of Hermes' `hermes mcp serve`.
 *
 * Transport is stdio only: each line on stdin is one JSON-RPC 2.0 message
 * (newline-delimited, as the MCP stdio transport specifies), each response
 * is one JSON object per line on stdout. Network transports are deliberately
 * out of scope — see SECURITY below.
 *
 * SECURITY
 * --------
 * MCP clients are trusted local tools, not the open internet — but the
 * requester still cannot be handed authority by fiat:
 *
 * - `bobi_send_message` runs as the OWNER actor, built server-side from the
 *   deployer's `ownerActor` dep (see `src/mcp/serve.ts`). The request
 *   supplies the userId (which conversation space to act in) and the text;
 *   it can NEVER choose the actor's permissions. Without an `ownerActor`
 *   dep the turn runs with no tool access at all — fail closed.
 * - History and conversation reads are scoped per userId at the STORAGE
 *   layer (`Storage.listUserConversations`, `Storage.history`, and
 *   `Storage.countMessages` all filter on user_id): user A cannot read
 *   user B's conversations even by guessing a conversation id.
 * - Exposing this server over a network transport is out of scope for now.
 *   The stdio boundary is the trust boundary: anyone who can write to this
 *   process's stdin already runs as the same OS user as the bot.
 */
import type { ConversationEngine } from "../conversation/engine";
import type { Storage } from "../storage/storage";
import type { ToolActor } from "../tools/types";

/**
 * Dependencies injected by the entry point, so tests can substitute an
 * in-memory Storage and a FakeProvider-backed engine.
 */
export interface McpServerDeps {
  storage: Storage;
  /** Resolve the engine that serves one turn for this user. */
  engineFactory: (userId: string) => ConversationEngine;
  /**
   * Owner-level tool grants, built server-side (e.g. via `authorizeToolUse`
   * with the real owner identity in `src/mcp/serve.ts`).
   *
   * `bobi_send_message` always runs with THESE permissions; the MCP
   * requester may pick the userId but never the grants. Absent means no
   * tool access — fail closed.
   */
  ownerActor?: ToolActor;
}

// ---------- JSON-RPC 2.0 envelope ----------

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The server's public surface, returned by `createMcpServer`. */
export interface McpServer {
  /**
   * Handle one parsed JSON-RPC message.
   *
   * Returns the response object for requests, or undefined for
   * notifications (no response is ever sent for those).
   */
  handleMessage(message: unknown): Promise<JsonRpcResponse | undefined>;
  /**
   * Handle one raw stdio line; returns the serialized response line, or
   * undefined when nothing should be written (blank lines, notifications).
   * Never throws: a malformed line gets a JSON-RPC parse-error response.
   */
  handleLine(line: string): Promise<string | undefined>;
  /**
   * Serve stdio until stdin EOF, then resolve.
   *
   * One JSON object per line in, one JSON object per line out — the MCP
   * stdio transport framing.
   */
  serve(): Promise<void>;
}

// ---------- MCP tool catalogue ----------

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "bobi-mcp";
const SERVER_VERSION = "0.0.1";

interface ToolDef {
  name: string;
  /** Persian — clients show this to their user. */
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = [
  {
    name: "bobi_list_conversations",
    description:
      "فهرست مکالمات یک کاربر: شناسه‌ی مکالمه، آخرین فعالیت و تعداد پیام‌ها. " +
      "فقط مکالمات همان userId برگردانده می‌شود.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "شناسه‌ی کاربر (همان user_id ذخیره‌سازی)." },
      },
      required: ["userId"],
      additionalProperties: false,
    },
  },
  {
    name: "bobi_read_history",
    description:
      "خواندن پیام‌های اخیر یک مکالمه به ترتیب زمانی (قدیمی‌ترین اول). " +
      "فقط وقتی مکالمه متعلق به همان userId باشد پیام برمی‌گردد.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "شناسه‌ی کاربر." },
        conversationId: { type: "string", description: "شناسه‌ی مکالمه (chat_id)." },
        limit: {
          type: "integer",
          description: "حداکثر تعداد پیام (پیش‌فرض ۵۰، سقف ۲۰۰).",
        },
      },
      required: ["userId", "conversationId"],
      additionalProperties: false,
    },
  },
  {
    name: "bobi_send_message",
    description:
      "ارسال یک پیام به بابی و دریافت پاسخ. یک نوبت کامل موتور مکالمه با نقش «مالک» " +
      "اجرا می‌شود؛ متن و شناسه‌ی کاربر از درخواست می‌آید ولی سطح دسترسی همیشه " +
      "همان چیزی است که سرور موقع راه‌اندازی تعیین کرده.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "شناسه‌ی کاربر." },
        conversationId: { type: "string", description: "شناسه‌ی مکالمه (chat_id)." },
        text: { type: "string", description: "متن پیام کاربر." },
      },
      required: ["userId", "conversationId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "bobi_conversation_status",
    description:
      "وضعیت یک مکالمه: در حال اجرا (running) یا بیکار (idle)، به‌همراه تعداد پیام‌های ذخیره‌شده.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "شناسه‌ی کاربر." },
        conversationId: { type: "string", description: "شناسه‌ی مکالمه (chat_id)." },
      },
      required: ["userId", "conversationId"],
      additionalProperties: false,
    },
  },
];

/** Create the MCP server. No I/O happens until `serve()` is called. */
export function createMcpServer(deps: McpServerDeps): McpServer {
  return new McpServerImpl(deps);
}

class McpServerImpl implements McpServer {
  private readonly deps: McpServerDeps;

  constructor(deps: McpServerDeps) {
    this.deps = deps;
  }

  async handleMessage(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isRecord(message) || message["jsonrpc"] !== "2.0") {
      // Not a JSON-RPC message at all (or a batch, which we do not support):
      // invalid request, no id to echo.
      return errorResponse(null, -32600, "درخواست نامعتبر است.");
    }
    if (typeof message["method"] !== "string") {
      return errorResponse(extractId(message) ?? null, -32600, "درخواست نامعتبر است.");
    }
    const id = extractId(message);

    // Notifications carry no id and get no response, per JSON-RPC 2.0.
    if (id === undefined) {
      // `notifications/initialized` is the only one the handshake needs;
      // anything else is ignored rather than answered.
      return undefined;
    }

    const method = message["method"] as string;
    const params = message["params"];
    switch (method) {
      case "initialize":
        return okResponse(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case "tools/list":
        return okResponse(id, { tools: TOOLS });
      case "tools/call":
        return await this.handleToolCall(id, params);
      case "ping":
        return okResponse(id, {});
      default:
        return errorResponse(id, -32601, `متد ناشناخته: ${method}`);
    }
  }

  async handleLine(line: string): Promise<string | undefined> {
    if (line.trim().length === 0) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // A line that is not JSON gets a parse error — never a crash, never a
      // hang, so one garbage line cannot wedge the whole session.
      return JSON.stringify(errorResponse(null, -32700, "پیام JSON معتبر نیست."));
    }
    const response = await this.handleMessage(message);
    return response === undefined ? undefined : JSON.stringify(response);
  }

  async serve(): Promise<void> {
    process.stdin.setEncoding("utf8");
    let buffer = "";
    // `for await` over stdin ends at EOF, which resolves serve().
    for await (const chunk of process.stdin as AsyncIterable<string>) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const out = await this.handleLine(line);
        if (out !== undefined) process.stdout.write(`${out}\n`);
      }
    }
    // A client that closes stdin mid-line still gets its last message answered.
    if (buffer.trim().length > 0) {
      const out = await this.handleLine(buffer);
      if (out !== undefined) process.stdout.write(`${out}\n`);
    }
  }

  private async handleToolCall(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
    if (!isRecord(params) || typeof params["name"] !== "string") {
      return errorResponse(id, -32602, "نام ابزار مشخص نشده است.");
    }
    const name = params["name"] as string;
    const args = isRecord(params["arguments"]) ? params["arguments"] : {};

    try {
      switch (name) {
        case "bobi_list_conversations":
          return toolResult(id, await this.listConversations(args));
        case "bobi_read_history":
          return toolResult(id, await this.readHistory(args));
        case "bobi_send_message":
          return toolResult(id, await this.sendMessage(args));
        case "bobi_conversation_status":
          return toolResult(id, await this.conversationStatus(args));
        default:
          // Only the four advertised tools may be called; anything else is a
          // protocol-level invalid-params error, not a tool error.
          return errorResponse(id, -32602, `ابزار ناشناخته: ${name}`);
      }
    } catch (err) {
      // A tool that fails (bad params, engine error) reports isError: true —
      // the MCP convention — so the client can show it to its user.
      return toolError(id, err instanceof Error ? err.message : String(err));
    }
  }

  // ---------- tool implementations ----------

  private async listConversations(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const userId = requireString(args, "userId", 64);
    const summaries = this.deps.storage.listUserConversations(userId);
    return {
      conversations: summaries.map((s) => ({
        conversationId: s.conversationId,
        lastActivity: s.lastActivity,
        messageCount: s.messageCount,
      })),
    };
  }

  private async readHistory(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = requireString(args, "userId", 64);
    const conversationId = requireString(args, "conversationId", 128);
    const limit = clampInt(args["limit"], 1, 200, 50);
    // Storage.history is ownership-checked: a conversation id that belongs
    // to another user simply returns [].
    const messages = this.deps.storage.history(userId, conversationId, limit);
    return {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    };
  }

  private async sendMessage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const userId = requireString(args, "userId", 64);
    const conversationId = requireString(args, "conversationId", 128);
    const text = requireString(args, "text", 8000);

    // SECURITY: the actor is built server-side. The requester chose the
    // userId (which conversation space to act in) but can never choose the
    // permissions — those come from the deployer's ownerActor. Without it,
    // the turn runs with no tool access (fail closed), while the reply
    // itself still works.
    const actor: ToolActor = {
      userId,
      permissions: this.deps.ownerActor?.permissions ?? [],
    };
    const engine = this.deps.engineFactory(userId);
    const out = await engine.respond({
      conversationId,
      userId,
      userText: text,
      actor,
    });
    return {
      reply: out.chunks.join("\n"),
      model: out.model,
      isFake: out.isFake,
      toolCalls: out.toolCalls,
    };
  }

  private async conversationStatus(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const userId = requireString(args, "userId", 64);
    const conversationId = requireString(args, "conversationId", 128);
    const engine = this.deps.engineFactory(userId);
    return {
      // `running` reflects the engine's in-flight runs — the same map the
      // bot's cancel() consults — so a turn started from Telegram shows up
      // here too, not only MCP-initiated ones.
      status: engine.isConversationRunning(conversationId) ? "running" : "idle",
      // countMessages is ownership-checked: someone else's conversation
      // reads as zero here, never as their count.
      messageCount: this.deps.storage.countMessages(userId, conversationId),
    };
  }
}

// ---------- JSON-RPC helpers ----------

/** Extract a request id; undefined means this is a notification. */
function extractId(message: Record<string, unknown>): JsonRpcId | undefined {
  if (!("id" in message)) return undefined;
  const id = message["id"];
  if (typeof id === "string" || typeof id === "number" || id === null) return id;
  return undefined;
}

function okResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A successful tool call: one JSON text block, per the MCP content convention. */
function toolResult(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return okResponse(id, {
    content: [{ type: "text", text: safeJson(value) }],
  });
}

/** A failed tool call: reported with isError so the client can surface it. */
function toolError(id: JsonRpcId, message: string): JsonRpcResponse {
  return okResponse(id, {
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

// ---------- param validation ----------

/**
 * A required string param: present, actually a string, non-blank, bounded.
 *
 * The bound matters: userId/conversationId travel into SQL as bound
 * parameters (no injection either way), but an unbounded string is still a
 * cheap way to waste memory on every call.
 */
function requireString(
  args: Record<string, unknown>,
  name: string,
  maxLength: number,
): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`پارامتر «${name}» باید یک رشته‌ی غیرخالی باشد.`);
  }
  if (value.length > maxLength) {
    throw new Error(`پارامتر «${name}» بیش از حد طولانی است.`);
  }
  return value;
}

/** Clamp an optional integer param into [min, max], with a default. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
