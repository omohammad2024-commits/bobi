/**
 * Anthropic gauntlet (audit v2 G2/G3, Anthropic rows) + the Wave-3 fixes:
 *
 *  - M3: the adapter implements listModels against GET {baseUrl}/models
 *    with the same x-api-key / anthropic-version headers the completion
 *    path sends, following `has_more`/`last_id` cursor pagination
 *    (`after_id`), page cap 10, repeat-cursor stop. The capability is
 *    declared on the adapter and in AdapterRegistry.describes().
 *  - M4: describes() reports listModels: true for nine_router, which
 *    maps to the OpenAI-compatible adapter that genuinely supports it
 *    (streaming likewise arrives via that class's capabilities).
 *  - M5 (Anthropic half): `stop_reason` is visible — a max_tokens
 *    finish with partial text returns the text AND exposes the
 *    truncation on the response's adapter-local `stopReason` (the
 *    shared CompletionResponse has no stop field; mirrors
 *    GeminiCompletionResponse.finishReason and the stream assembler's
 *    stopReason getter), and a thinking-only / refusal empty response
 *    is the empty-response error WITH the stop_reason in its detail.
 *  - G3: the Anthropic error envelope {type:"error", error:{type,
 *    message}} carries error.message verbatim on
 *    AiError.providerMessage through the adapter.
 *
 * Hermetic throughout: a loopback fake speaking REAL Anthropic wire
 * shapes (messages / messages SSE / models list), following the
 * loopback-double idiom of provider_error_words.test.ts. No network,
 * no real keys.
 */
import { describe, expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  AnthropicAdapter,
  AnthropicStreamAssembler,
  type AnthropicCompletionResponse,
} from "../src/ai/anthropic";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { AiError, isEmptyResponseError } from "../src/ai/provider";
import type {
  CompletionRequest,
  StreamEvent,
  ToolSpec,
} from "../src/ai/provider";

// ------------------------------------------------------------- doubles ----

interface SeenRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  json: Record<string, unknown> | undefined;
}

interface Fake {
  port: number;
  seen: SeenRequest[];
  close: () => void;
}

async function fake(
  handler: (seen: SeenRequest, res: ServerResponse) => void,
): Promise<Fake> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let json: Record<string, unknown> | undefined;
      if (raw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          json = undefined;
        }
      }
      const entry: SeenRequest = {
        method: req.method ?? "",
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        json,
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, seen, close: () => server.close() };
}

function adapterFor(port: number): AnthropicAdapter {
  return new AnthropicAdapter({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "gauntlet-key",
    allowLocalTargets: true,
  });
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    model: "claude-sonnet-4-5",
    timeoutMs: 2000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function errorOf(p: Promise<unknown>): Promise<AiError> {
  const err = await p.catch((e: unknown) => e);
  if (err instanceof AiError) return err;
  throw new Error(`expected AiError, got ${String(err)}`);
}

function json200(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

function sse200(res: ServerResponse, events: readonly Record<string, unknown>[]): void {
  const body = events
    .map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  res.writeHead(200, { "content-type": "text/event-stream" }).end(body);
}

async function collectStream(
  adapter: AnthropicAdapter,
  req: CompletionRequest,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of adapter.completeStream(req)) out.push(event);
  return out;
}

const GOLDEN_REPLY = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "Hello from Claude" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 7 },
};

// -------------------------------------------------------- golden complete ----

describe("Anthropic gauntlet — golden complete", () => {
  test("text + usage parse; request asserted (model, max_tokens from req.maxTokens, auth headers)", async () => {
    const f = await fake((_seen, res) => json200(res, GOLDEN_REPLY));
    try {
      const adapter = adapterFor(f.port);
      const res = (await adapter.complete(
        request({ maxTokens: 321 }),
      )) as AnthropicCompletionResponse;

      expect(res.text).toBe("Hello from Claude");
      expect(res.model).toBe("claude-sonnet-4-5");
      expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
      expect(res.stopReason).toBe("end_turn");
      expect(res.toolCalls).toBeUndefined();

      expect(f.seen).toHaveLength(1);
      const seen = f.seen[0]!;
      expect(seen.method).toBe("POST");
      expect(seen.pathname).toBe("/v1/messages");
      expect(seen.headers["x-api-key"]).toBe("gauntlet-key");
      expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
      const body = seen.json!;
      expect(body["model"]).toBe("claude-sonnet-4-5");
      expect(body["max_tokens"]).toBe(321);
      expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
    } finally {
      f.close();
    }
  });
});

// --------------------------------------------------------- golden stream ----

describe("Anthropic gauntlet — golden stream", () => {
  test("message_start/deltas/message_delta assemble text + a tool_use call; stop_reason captured", async () => {
    const f = await fake((_seen, res) =>
      sse200(res, [
        {
          type: "message_start",
          message: {
            id: "msg_01",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 12, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "calculator", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{\"a\":" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "5}" },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 9 },
        },
        { type: "message_stop" },
      ]),
    );
    try {
      const adapter = adapterFor(f.port);
      const events = await collectStream(adapter, request());

      const deltas = events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta);
      expect(deltas).toEqual(["Hel", "lo"]);

      const end = events[events.length - 1]!;
      expect(end.type).toBe("end");
      if (end.type !== "end") throw new Error("expected end");
      expect(end.text).toBe("Hello");
      expect(end.model).toBe("claude-sonnet-4-5");
      expect(end.toolCalls).toEqual([
        { id: "toolu_1", name: "calculator", arguments: { a: 5 } },
      ]);
      expect(end.usage).toEqual({ inputTokens: 12, outputTokens: 9 });

      const seen = f.seen[0]!;
      expect(seen.pathname).toBe("/v1/messages");
      expect(seen.headers["x-api-key"]).toBe("gauntlet-key");
      expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
      expect(seen.json!["stream"]).toBe(true);
    } finally {
      f.close();
    }
  });

  test("assembler stopReason getter names the wire stop_reason (tool_use)", () => {
    const a = new AnthropicStreamAssembler("claude-sonnet-4-5");
    a.push({
      type: "message_start",
      message: { model: "claude-sonnet-4-5", usage: { input_tokens: 3, output_tokens: 1 } },
    });
    a.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_9", name: "ping", input: {} },
    });
    a.push({ type: "content_block_stop", index: 0 });
    a.push({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    });
    const end = a.finish();
    if (end.type !== "end") throw new Error("expected end");
    expect(a.stopReason).toBe("tool_use");
    expect(end.toolCalls).toEqual([{ id: "toolu_9", name: "ping", arguments: {} }]);
  });
});

// ----------------------------------------------------------------- tools ----

describe("Anthropic gauntlet — tools", () => {
  const TOOLS: ToolSpec[] = [
    {
      name: "calculator",
      description: "Add numbers",
      parameters: {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
      },
    },
  ];

  test("tool_use content block parses to toolCalls; tool specs emitted as input_schema", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        id: "msg_02",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [
          { type: "tool_use", id: "toolu_1", name: "calculator", input: { a: 5 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 20, output_tokens: 4 },
      }),
    );
    try {
      const adapter = adapterFor(f.port);
      const res = (await adapter.complete(
        request({ tools: TOOLS }),
      )) as AnthropicCompletionResponse;

      expect(res.text).toBe("");
      expect(res.stopReason).toBe("tool_use");
      expect(res.toolCalls).toEqual([
        { id: "toolu_1", name: "calculator", arguments: { a: 5 } },
      ]);

      const body = f.seen[0]!.json!;
      const tools = body["tools"] as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(1);
      expect(tools[0]!["name"]).toBe("calculator");
      expect(tools[0]!["description"]).toBe("Add numbers");
      expect(tools[0]!["input_schema"]).toEqual(TOOLS[0]!.parameters);
    } finally {
      f.close();
    }
  });
});

// ------------------------------------------------------- stop_reason (M5) ----

describe("Anthropic gauntlet — stop_reason visibility (M5)", () => {
  test("thinking-only response (stop_reason end_turn) is the empty-response error naming the stop_reason", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        id: "msg_03",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "thinking", thinking: "let me reason…", signature: "sig" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 30 },
      }),
    );
    try {
      const err = await errorOf(adapterFor(f.port).complete(request()));
      expect(isEmptyResponseError(err)).toBe(true);
      expect(err.message).toContain("stop_reason=end_turn");
      expect(err.message).toContain("reasoning only");
    } finally {
      f.close();
    }
  });

  test("refusal stop_reason with no content names refusal in the empty-response detail", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        id: "msg_04",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: "refusal",
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    );
    try {
      const err = await errorOf(adapterFor(f.port).complete(request()));
      expect(isEmptyResponseError(err)).toBe(true);
      expect(err.message).toContain("stop_reason=refusal");
    } finally {
      f.close();
    }
  });

  test("thinking-only stream is the empty-response error naming the stop_reason", async () => {
    const f = await fake((_seen, res) =>
      sse200(res, [
        {
          type: "message_start",
          message: {
            model: "claude-sonnet-4-5",
            content: [],
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "reasoning…" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 25 },
        },
        { type: "message_stop" },
      ]),
    );
    try {
      const err = await errorOf(collectStream(adapterFor(f.port), request()));
      expect(isEmptyResponseError(err)).toBe(true);
      expect(err.message).toContain("stop_reason=end_turn");
    } finally {
      f.close();
    }
  });

  test("max_tokens finish with partial text returns the text AND exposes stopReason", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        id: "msg_05",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "partial answer that was cut" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 9, output_tokens: 300 },
      }),
    );
    try {
      const res = (await adapterFor(f.port).complete(
        request({ maxTokens: 300 }),
      )) as AnthropicCompletionResponse;
      expect(res.text).toBe("partial answer that was cut");
      // Truncation exposure: the wire stop reason on the response —
      // "max_tokens" here means the text above is NOT the whole answer.
      expect(res.stopReason).toBe("max_tokens");
    } finally {
      f.close();
    }
  });

  test("max_tokens over the stream assembler: partial text ends, stopReason getter names the truncation", () => {
    const a = new AnthropicStreamAssembler("claude-sonnet-4-5");
    a.push({
      type: "message_start",
      message: { model: "claude-sonnet-4-5", usage: { input_tokens: 9, output_tokens: 1 } },
    });
    a.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    a.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    });
    a.push({ type: "content_block_stop", index: 0 });
    a.push({
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
      usage: { output_tokens: 300 },
    });
    const end = a.finish();
    if (end.type !== "end") throw new Error("expected end");
    expect(end.text).toBe("partial");
    expect(a.stopReason).toBe("max_tokens");
  });
});

// ------------------------------------------------------- error envelope ----

describe("Anthropic gauntlet — error envelope (G3)", () => {
  test("401 {type:error, error:{type,message}} → providerMessage carries the message verbatim", async () => {
    const ANTHROPIC_MESSAGE = "invalid x-api-key";
    const f = await fake((_seen, res) =>
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: ANTHROPIC_MESSAGE },
            request_id: "req_123",
          }),
        ),
    );
    try {
      const err = await errorOf(adapterFor(f.port).complete(request()));
      expect(err.kind).toBe("auth");
      expect(err.status).toBe(401);
      expect(err.providerMessage).toBe(ANTHROPIC_MESSAGE);
    } finally {
      f.close();
    }
  });

  test("400 invalid_request_error envelope → providerMessage carries the message verbatim", async () => {
    const ANTHROPIC_MESSAGE = "messages: at least one message is required";
    const f = await fake((_seen, res) =>
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: ANTHROPIC_MESSAGE },
            request_id: "req_456",
          }),
        ),
    );
    try {
      const err = await errorOf(adapterFor(f.port).complete(request()));
      expect(err.kind).toBe("invalid_response");
      expect(err.status).toBe(400);
      expect(err.providerMessage).toBe(ANTHROPIC_MESSAGE);
    } finally {
      f.close();
    }
  });
});

// ------------------------------------------------------------- discovery ----

describe("Anthropic gauntlet — discovery (M3) + registry (M4)", () => {
  const modelEntry = (id: string, displayName: string) => ({
    id,
    type: "model",
    display_name: displayName,
    created_at: "2025-01-01T00:00:00Z",
  });

  test("two pages via has_more/last_id → all ids + labels; second page fetched with after_id; auth headers sent", async () => {
    const f = await fake((seen, res) => {
      if (seen.query.get("after_id") === "claude-haiku-4-5") {
        json200(res, {
          data: [modelEntry("claude-opus-4-1", "Claude Opus 4.1")],
          has_more: false,
          first_id: "claude-opus-4-1",
          last_id: "claude-opus-4-1",
        });
        return;
      }
      json200(res, {
        data: [
          modelEntry("claude-sonnet-4-5", "Claude Sonnet 4.5"),
          modelEntry("claude-haiku-4-5", "Claude Haiku 4.5"),
        ],
        has_more: true,
        first_id: "claude-sonnet-4-5",
        last_id: "claude-haiku-4-5",
      });
    });
    try {
      // Through the registry-created adapter, the way both discovery
      // surfaces obtain it.
      const registry = new AdapterRegistry();
      const adapter = registry.create("anthropic", {
        baseUrl: `http://127.0.0.1:${f.port}/v1`,
        apiKey: "gauntlet-key",
        model: "claude-sonnet-4-5",
        allowLocalTargets: true,
      });
      if (adapter.listModels === undefined) throw new Error("adapter declares no listModels");
      const models = await adapter.listModels({
        target: { baseUrl: `http://127.0.0.1:${f.port}/v1`, apiKey: "gauntlet-key" },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(models).toEqual([
        { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
        { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
      ]);

      expect(f.seen).toHaveLength(2);
      expect(f.seen[0]!.method).toBe("GET");
      expect(f.seen[0]!.pathname).toBe("/v1/models");
      expect(f.seen[0]!.query.get("after_id")).toBeNull();
      expect(f.seen[0]!.headers["x-api-key"]).toBe("gauntlet-key");
      expect(f.seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
      expect(f.seen[1]!.pathname).toBe("/v1/models");
      expect(f.seen[1]!.query.get("after_id")).toBe("claude-haiku-4-5");
    } finally {
      f.close();
    }
  });

  test("a repeating last_id cursor does not spin: discovery stops instead of re-fetching forever", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        data: [modelEntry("claude-sonnet-4-5", "Claude Sonnet 4.5")],
        has_more: true,
        first_id: "claude-sonnet-4-5",
        last_id: "claude-sonnet-4-5",
      }),
    );
    try {
      const adapter = adapterFor(f.port);
      const models = await adapter.listModels({
        target: { baseUrl: `http://127.0.0.1:${f.port}/v1`, apiKey: "gauntlet-key" },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4-5"]);
      // Page 1 (fresh cursor) + page 2 (same cursor again → stop).
      expect(f.seen).toHaveLength(2);
    } finally {
      f.close();
    }
  });

  test("an endless stream of fresh cursors is stopped by the 10-page cap", async () => {
    const f = await fake((seen, res) => {
      const after = seen.query.get("after_id");
      const n = after === null ? 0 : Number(after.replace("cursor-", ""));
      json200(res, {
        data: [modelEntry(`claude-page-${n}`, `Page ${n}`)],
        has_more: true,
        first_id: `claude-page-${n}`,
        last_id: `cursor-${n + 1}`,
      });
    });
    try {
      const adapter = adapterFor(f.port);
      const models = await adapter.listModels({
        target: { baseUrl: `http://127.0.0.1:${f.port}/v1`, apiKey: "gauntlet-key" },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(f.seen).toHaveLength(10);
      expect(models).toHaveLength(10);
      expect(f.seen[1]!.query.get("after_id")).toBe("cursor-1");
    } finally {
      f.close();
    }
  });

  test("registry describes() reports listModels true for anthropic AND nine_router", () => {
    const registry = new AdapterRegistry();
    expect(registry.describes("anthropic").listModels).toBe(true);
    expect(registry.describes("nine_router").listModels).toBe(true);
    expect(registry.describes("openai_compatible").listModels).toBe(true);
    expect(registry.describes("gemini").listModels).toBe(true);
  });

  test("adapter-level capabilities: anthropic declares listModels; nine_router inherits the OpenAI adapter's (incl. streaming)", () => {
    const registry = new AdapterRegistry();
    const anthropic = registry.create("anthropic", {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k",
      model: "m",
    });
    expect(anthropic.capabilities.listModels).toBe(true);
    expect(anthropic.capabilities.streaming).toBe(true);

    const nine = registry.create("nine_router", {
      baseUrl: "https://router.invalid/v1",
      apiKey: "k",
      model: "m",
    });
    expect(nine.capabilities.listModels).toBe(true);
    expect(nine.capabilities.streaming).toBe(true);
    expect(nine.listModels).toBeDefined();
  });
});
