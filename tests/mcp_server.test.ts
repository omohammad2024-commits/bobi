/**
 * MCP server (src/mcp/server.ts): BOBI exposed as an MCP tool server over stdio.
 *
 * Tests drive `handleMessage`/`handleLine` directly with in-memory Storage and
 * a FakeProvider-backed engine — no subprocess, no network, fully offline.
 * Covered: tool catalogue, per-user scoping (user A cannot read user B's
 * history), send_message returning the fake provider's reply (and persisting
 * the turn), status reporting, and malformed JSON-RPC / unknown-tool handling.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { ConversationEngine } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import { createMcpServer } from "../src/mcp/server";
import type { McpServer } from "../src/mcp/server";

function makeServer() {
  const storage = Storage.open(":memory:");
  const server = createMcpServer({
    storage,
    engineFactory: () =>
      new ConversationEngine({
        provider: new FakeProvider(),
        model: "fake-echo",
        timeoutMs: 5_000,
        maxConcurrent: 4,
        storage,
      }),
  });
  return { storage, server };
}

/** Seed two users with distinct conversations. */
function seed(storage: Storage): void {
  storage.appendMessage("userA", "chatA1", "user", "سلام از A");
  storage.appendMessage("userA", "chatA1", "assistant", "سلام A");
  storage.appendMessage("userA", "chatA2", "user", "مکالمه دوم A");
  storage.appendMessage("userB", "chatB1", "user", "سلام از B");
}

/** Send a JSON-RPC request object, return the response. */
async function request(
  server: McpServer,
  method: string,
  params?: unknown,
  id: string | number | null = 1,
) {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) msg["params"] = params;
  return server.handleMessage(msg);
}

/** Call one of the four tools; return the parsed text payload. */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; payload: unknown; raw: unknown }> {
  const res = await request(server, "tools/call", { name, arguments: args });
  const result = (res as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  return {
    ok: result.isError !== true,
    payload: JSON.parse(first(result.content).text),
    raw: result,
  };
}

/** Head of a non-empty array; throws if empty (test helper). */
function first<T>(arr: readonly T[]): T {
  const v = arr[0];
  if (v === undefined) throw new Error("expected non-empty array");
  return v;
}

describe("mcp server handshake", () => {
  test("initialize returns protocol version and server info", async () => {
    const { server } = makeServer();
    const res = (await request(server, "initialize", {})) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.serverInfo.name).toBe("bobi-mcp");
  });

  test("tools/list advertises the four bobi tools", async () => {
    const { server } = makeServer();
    const res = (await request(server, "tools/list")) as {
      result: { tools: { name: string }[] };
    };
    const names = res.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "bobi_conversation_status",
      "bobi_list_conversations",
      "bobi_read_history",
      "bobi_send_message",
    ]);
  });

  test("initialized notification gets no response", async () => {
    const { server } = makeServer();
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(res).toBeUndefined();
  });

  test("unknown method → -32601", async () => {
    const { server } = makeServer();
    const res = (await request(server, "tools/bogus")) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32601);
  });
});

describe("bobi_list_conversations", () => {
  test("lists the caller's conversations with last activity and counts", async () => {
    const { storage, server } = makeServer();
    seed(storage);
    const { ok, payload } = await callTool(server, "bobi_list_conversations", {
      userId: "userA",
    });
    expect(ok).toBe(true);
    const convs = (payload as { conversations: unknown[] }).conversations;
    expect(convs).toHaveLength(2);
    for (const c of convs) {
      const conv = c as { conversationId: string; lastActivity: number; messageCount: number };
      expect(typeof conv.conversationId).toBe("string");
      expect(typeof conv.lastActivity).toBe("number");
      expect(typeof conv.messageCount).toBe("number");
    }
    const ids = convs.map((c) => (c as { conversationId: string }).conversationId).sort();
    expect(ids).toEqual(["chatA1", "chatA2"]);
  });

  test("a user sees only their own conversations", async () => {
    const { storage, server } = makeServer();
    seed(storage);
    const { payload } = await callTool(server, "bobi_list_conversations", {
      userId: "userB",
    });
    const convs = (payload as { conversations: { conversationId: string }[] }).conversations;
    expect(convs).toHaveLength(1);
    expect(first(convs).conversationId).toBe("chatB1");
  });

  test("missing userId → invalid params", async () => {
    const { server } = makeServer();
    const res = (await request(server, "tools/call", {
      name: "bobi_list_conversations",
      arguments: {},
    })) as { result: { isError: boolean } };
    expect(res.result.isError).toBe(true);
  });
});

describe("bobi_read_history", () => {
  test("returns recent messages in chronological order", async () => {
    const { storage, server } = makeServer();
    seed(storage);
    const { ok, payload } = await callTool(server, "bobi_read_history", {
      userId: "userA",
      conversationId: "chatA1",
      limit: 10,
    });
    expect(ok).toBe(true);
    const messages = (payload as { messages: { role: string; content: string }[] }).messages;
    expect(messages).toHaveLength(2);
    expect(first(messages).role).toBe("user");
    expect(first(messages).content).toBe("سلام از A");
    expect(messages[1]?.role).toBe("assistant");
  });

  test("user A cannot read user B's history — returns empty, not an error leak", async () => {
    const { storage, server } = makeServer();
    seed(storage);
    const { ok, payload } = await callTool(server, "bobi_read_history", {
      userId: "userA",
      conversationId: "chatB1",
      limit: 10,
    });
    expect(ok).toBe(true);
    const messages = (payload as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(0);
  });

  test("limit is clamped to the ceiling", async () => {
    const { storage, server } = makeServer();
    seed(storage);
    for (let i = 0; i < 10; i++) {
      storage.appendMessage("userA", "chatA1", "user", `پیام ${i}`);
    }
    const { payload } = await callTool(server, "bobi_read_history", {
      userId: "userA",
      conversationId: "chatA1",
      limit: 5,
    });
    const messages = (payload as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(5);
  });
});

describe("bobi_send_message", () => {
  test("runs one engine turn and returns the fake provider's reply", async () => {
    const { storage, server } = makeServer();
    seed(storage);
    const { ok, payload } = await callTool(server, "bobi_send_message", {
      userId: "userA",
      conversationId: "chatA1",
      text: "سلام بابی",
    });
    expect(ok).toBe(true);
    const result = payload as { reply: string; isFake: boolean };
    expect(result.reply).toContain("آزمایشی بابی");
    expect(result.reply).toContain("سلام بابی");
    expect(result.isFake).toBe(true);
  });

  test("the turn is persisted to storage history", async () => {
    const { storage, server } = makeServer();
    const before = storage.history("userA", "chatA1").length;
    await callTool(server, "bobi_send_message", {
      userId: "userA",
      conversationId: "chatA1",
      text: "یک پیام تازه",
    });
    const after = storage.history("userA", "chatA1");
    // One user message plus one assistant reply were committed.
    expect(after.length).toBe(before + 2);
    const lastUser = after[after.length - 2];
    const lastAssistant = after[after.length - 1];
    expect(lastUser?.role).toBe("user");
    expect(lastUser?.content).toBe("یک پیام تازه");
    expect(lastAssistant?.role).toBe("assistant");
  });

  test("empty text is rejected as a tool error, not a crash", async () => {
    const { server } = makeServer();
    const res = (await request(server, "tools/call", {
      name: "bobi_send_message",
      arguments: { userId: "userA", conversationId: "chatA1", text: "   " },
    })) as { result: { isError: boolean } };
    expect(res.result.isError).toBe(true);
  });
});

describe("bobi_conversation_status", () => {
  test("idle conversation reports its message count", async () => {
    const { storage, server } = makeServer();
    seed(storage);
    const { ok, payload } = await callTool(server, "bobi_conversation_status", {
      userId: "userA",
      conversationId: "chatA1",
    });
    expect(ok).toBe(true);
    const status = payload as { status: string; messageCount: number };
    expect(status.status).toBe("idle");
    expect(status.messageCount).toBe(2);
  });

  test("another user's conversation reads as zero — never their count", async () => {
    const { storage, server } = makeServer();
    seed(storage);
    const { payload } = await callTool(server, "bobi_conversation_status", {
      userId: "userA",
      conversationId: "chatB1",
    });
    const status = payload as { status: string; messageCount: number };
    expect(status.status).toBe("idle");
    expect(status.messageCount).toBe(0);
  });
});

describe("malformed input and unknown tools", () => {
  test("non-JSON line → parse error with null id", async () => {
    const { server } = makeServer();
    const out = await server.handleLine("this is not json{{{");
    expect(out).toBeDefined();
    const parsed = JSON.parse(out as string) as {
      jsonrpc: string;
      id: null;
      error: { code: number };
    };
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(-32700);
  });

  test("non-JSON-RPC object → invalid request", async () => {
    const { server } = makeServer();
    const res = (await server.handleMessage({ hello: "world" })) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32600);
  });

  test("blank lines produce no output", async () => {
    const { server } = makeServer();
    expect(await server.handleLine("")).toBeUndefined();
    expect(await server.handleLine("   ")).toBeUndefined();
  });

  test("unknown tool → -32602 invalid params", async () => {
    const { server } = makeServer();
    const res = (await request(server, "tools/call", {
      name: "bobi_delete_everything",
      arguments: {},
    })) as { error: { code: number; message: string } };
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("bobi_delete_everything");
  });

  test("tools/call without a name → -32602", async () => {
    const { server } = makeServer();
    const res = (await request(server, "tools/call", { arguments: {} })) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32602);
  });
});

describe("storage listing behind the server", () => {
  test("listUserConversations orders by newest activity first", async () => {
    const storage = Storage.open(":memory:");
    storage.appendMessage("u", "old", "user", "قدیمی");
    await new Promise((r) => setTimeout(r, 5));
    storage.appendMessage("u", "new", "user", "جدید");
    const list = storage.listUserConversations("u");
    expect(list.map((c) => c.conversationId)).toEqual(["new", "old"]);
    const newest = first(list);
    const older = list[1];
    expect(newest.lastActivity).toBeGreaterThanOrEqual(older?.lastActivity ?? 0);
    expect(newest.messageCount).toBe(1);
  });

  test("countMessages is ownership-checked", async () => {
    const storage = Storage.open(":memory:");
    storage.appendMessage("u1", "c", "user", "hi");
    expect(storage.countMessages("u1", "c")).toBe(1);
    expect(storage.countMessages("u2", "c")).toBe(0);
    expect(storage.countMessages("u1", "missing")).toBe(0);
  });
});
