/**
 * Tool-calling wire formats.
 *
 * Each service expresses tool use differently, and every difference here is a
 * place a real deployment would break. These tests pin the request body a
 * service receives and the parse of the response it returns, using captured
 * payload shapes rather than a live endpoint — the same approach the rest of
 * the adapter suite takes.
 *
 * The request builders and response parsers are exported for exactly this
 * reason, so the wire format is asserted without opening a socket.
 */
import { describe, expect, test } from "bun:test";
import {
  buildRequestBody as buildOpenAIBody,
  parseResponse as parseOpenAI,
  toWireMessages as openAIMessages,
} from "../src/ai/openai_compatible";
import {
  buildBody as buildAnthropicBody,
  parseResponse as parseAnthropic,
  toWireMessage as anthropicMessage,
} from "../src/ai/anthropic";
import {
  buildBody as buildGeminiBody,
  parseResponse as parseGemini,
  toWireMessage as geminiMessage,
} from "../src/ai/gemini";
import type { ChatMessage, CompletionRequest, ToolSpec } from "../src/ai/provider";

const TOOLS: ToolSpec[] = [
  {
    name: "calculator",
    description: "محاسبه",
    parameters: {
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
      additionalProperties: false,
    },
  },
];

const REQ: CompletionRequest = {
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "۲+۲؟" },
  ],
  model: "test-model",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

const TARGET = { baseUrl: "https://example.test/v1", apiKey: "k", settings: {} };

const withTools: CompletionRequest = { ...REQ, tools: TOOLS };

// ---------- OpenAI-compatible ----------

describe("OpenAI-compatible wire format", () => {
  test("tools are sent in the function envelope", () => {
    const body = buildOpenAIBody(TARGET, withTools);
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!["type"]).toBe("function");
    const fn = tools[0]!["function"] as Record<string, unknown>;
    expect(fn["name"]).toBe("calculator");
    expect(fn["description"]).toBe("محاسبه");
    expect(fn["parameters"]).toEqual(TOOLS[0]!.parameters);
  });

  test("no tools key at all when none are declared", () => {
    // The loop relies on this: an omitted `tools` is how it forces a final
    // answer instead of another tool request.
    const body = buildOpenAIBody(TARGET, REQ);
    expect("tools" in body).toBe(false);
  });

  test("an assistant tool request carries tool_calls with STRING arguments", () => {
    const wire = openAIMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "calculator", arguments: { a: 2, b: 2 } }],
      },
    ])[0]!;
    expect(wire["role"]).toBe("assistant");
    const calls = wire["tool_calls"] as Array<Record<string, unknown>>;
    const fn = calls[0]!["function"] as Record<string, unknown>;
    expect(calls[0]!["id"]).toBe("call_1");
    // This service expects a JSON string here, not an object.
    expect(typeof fn["arguments"]).toBe("string");
    expect(JSON.parse(fn["arguments"] as string)).toEqual({ a: 2, b: 2 });
  });

  test("a tool result is a tool-role turn keyed by tool_call_id", () => {
    const wire = openAIMessages([
      { role: "tool", content: "42", toolCallId: "call_1", toolName: "calculator" },
    ])[0]!;
    expect(wire["role"]).toBe("tool");
    expect(wire["tool_call_id"]).toBe("call_1");
    expect(wire["content"]).toBe("42");
  });

  test("a plain message is passed through unchanged", () => {
    const wire = openAIMessages([{ role: "user", content: "hi" }])[0]!;
    expect(wire).toEqual({ role: "user", content: "hi" });
  });

  test("tool_calls parse with string arguments decoded", () => {
    const res = parseOpenAI(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", function: { name: "calculator", arguments: '{"a":5}' } },
              ],
            },
          },
        ],
      },
      "test-model",
    );
    expect(res.toolCalls?.[0]?.name).toBe("calculator");
    expect(res.toolCalls?.[0]?.arguments).toEqual({ a: 5 });
    // Null content alongside tool calls is valid, not a response fault.
    expect(res.text).toBe("");
  });

  test("malformed argument JSON yields an empty object, not a throw", () => {
    // A truncated blob is a model mistake; letting it reach input validation
    // gives a clearer outcome than failing the whole turn.
    const res = parseOpenAI(
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c", function: { name: "calculator", arguments: "{oops" } }],
            },
          },
        ],
      },
      "m",
    );
    expect(res.toolCalls?.[0]?.arguments).toEqual({});
  });

  test("a tool call without an id still gets a stable one", () => {
    const res = parseOpenAI(
      {
        choices: [
          { message: { content: "", tool_calls: [{ function: { name: "calculator", arguments: "{}" } }] } },
        ],
      },
      "m",
    );
    expect(res.toolCalls?.[0]?.id.length).toBeGreaterThan(0);
  });

  test("usage is reported", () => {
    const res = parseOpenAI(
      { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } },
      "m",
    );
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  test("a normal text answer parses with no tool calls", () => {
    const res = parseOpenAI({ choices: [{ message: { content: "سلام" } }] }, "m");
    expect(res.text).toBe("سلام");
    expect(res.toolCalls).toBeUndefined();
  });
});

// ---------- Anthropic ----------

describe("Anthropic wire format", () => {
  test("tools are a flat array with input_schema, not the OpenAI envelope", () => {
    const body = buildAnthropicBody(TARGET, withTools);
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]!["name"]).toBe("calculator");
    expect(tools[0]!["input_schema"]).toEqual(TOOLS[0]!.parameters);
    expect(tools[0]!["function"]).toBeUndefined();
  });

  test("system turns become the top-level system field", () => {
    const body = buildAnthropicBody(TARGET, REQ);
    expect(body["system"]).toBe("sys");
    const messages = body["messages"] as unknown[];
    expect(messages).toHaveLength(1);
  });

  test("an assistant tool request becomes tool_use content blocks", () => {
    const wire = anthropicMessage({
      role: "assistant",
      content: "بگذار حساب کنم",
      toolCalls: [{ id: "tu_1", name: "calculator", arguments: { a: 2 } }],
    });
    const blocks = wire.content as Array<Record<string, unknown>>;
    expect(blocks[0]!["type"]).toBe("text");
    expect(blocks[1]!["type"]).toBe("tool_use");
    expect(blocks[1]!["id"]).toBe("tu_1");
    // This service takes `input` as an object, not a string.
    expect(blocks[1]!["input"]).toEqual({ a: 2 });
  });

  test("a tool result is a USER turn carrying a tool_result block", () => {
    // There is no "tool" role in this protocol; sending one would be rejected.
    const wire = anthropicMessage({
      role: "tool",
      content: "42",
      toolCallId: "tu_1",
      toolName: "calculator",
    });
    expect(wire.role).toBe("user");
    const blocks = wire.content as Array<Record<string, unknown>>;
    expect(blocks[0]!["type"]).toBe("tool_result");
    expect(blocks[0]!["tool_use_id"]).toBe("tu_1");
  });

  test("tool_use blocks parse with object input", () => {
    const res = parseAnthropic(
      {
        content: [
          { type: "text", text: "بگذار ببینم" },
          { type: "tool_use", id: "tu_1", name: "calculator", input: { a: 5 } },
        ],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
      "m",
    );
    expect(res.text).toBe("بگذار ببینم");
    expect(res.toolCalls?.[0]?.arguments).toEqual({ a: 5 });
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  test("a text-only answer parses normally", () => {
    const res = parseAnthropic({ content: [{ type: "text", text: "خب" }] }, "m");
    expect(res.text).toBe("خب");
    expect(res.toolCalls).toBeUndefined();
  });
});

// ---------- Gemini ----------

describe("Gemini wire format", () => {
  test("tools nest under functionDeclarations", () => {
    const body = buildGeminiBody(TARGET, withTools);
    const tools = body["tools"] as Array<Record<string, unknown>>;
    const decls = tools[0]!["functionDeclarations"] as Array<Record<string, unknown>>;
    expect(decls[0]!["name"]).toBe("calculator");
    expect(decls[0]!["parameters"]).toEqual(TOOLS[0]!.parameters);
  });

  test("an assistant tool request becomes a model turn with functionCall parts", () => {
    const wire = geminiMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "g1", name: "calculator", arguments: { a: 2 } }],
    });
    expect(wire.role).toBe("model");
    const fc = (wire.parts[0] as Record<string, unknown>)["functionCall"] as Record<string, unknown>;
    expect(fc["name"]).toBe("calculator");
    expect(fc["args"]).toEqual({ a: 2 });
  });

  test("a tool result is a user turn with functionResponse keyed by NAME", () => {
    // This service correlates by function name, not by an id.
    const wire = geminiMessage({
      role: "tool",
      content: "42",
      toolCallId: "g1",
      toolName: "calculator",
    });
    expect(wire.role).toBe("user");
    const fr = (wire.parts[0] as Record<string, unknown>)["functionResponse"] as Record<string, unknown>;
    expect(fr["name"]).toBe("calculator");
  });

  test("functionCall parts parse, with a synthesised id", () => {
    const res = parseGemini(
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: "calculator", args: { a: 5 } } }] } },
        ],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 },
      },
      "m",
    );
    expect(res.toolCalls?.[0]?.name).toBe("calculator");
    // No id is supplied by this service, so one is synthesised; the loop only
    // needs it unique within the turn.
    expect(res.toolCalls?.[0]?.id.length).toBeGreaterThan(0);
    expect(res.usage).toEqual({ inputTokens: 6, outputTokens: 2 });
  });

  test("a text-only answer parses normally", () => {
    const res = parseGemini({ candidates: [{ content: { parts: [{ text: "سلام" }] } }] }, "m");
    expect(res.text).toBe("سلام");
    expect(res.toolCalls).toBeUndefined();
  });
});

// ---------- cross-adapter contract ----------

describe("neutral message round trip", () => {
  const conv: ChatMessage[] = [
    { role: "user", content: "سؤال" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "x", name: "calculator", arguments: { a: 1 } }],
    },
    { role: "tool", content: "1", toolCallId: "x", toolName: "calculator" },
  ];

  test("every adapter maps a full tool conversation without dropping a turn", () => {
    // One assistant request and one tool result must survive in each format,
    // otherwise the model would see an unanswered tool call.
    const openai = openAIMessages(conv);
    expect(openai).toHaveLength(3);

    const anthropic = buildAnthropicBody(TARGET, { ...REQ, messages: conv });
    expect((anthropic["messages"] as unknown[]).length).toBe(3);

    const gemini = buildGeminiBody(TARGET, { ...REQ, messages: conv });
    expect((gemini["contents"] as unknown[]).length).toBe(3);
  });

  test("no adapter ever puts a raw tool result in a plain string field", () => {
    // Each format needs its own correlation field (tool_call_id / tool_use_id /
    // functionResponse), so a naive `{role, content}` mapping would be wrong.
    const openai = openAIMessages(conv)[2]!;
    expect(openai["tool_call_id"]).toBe("x");

    const anthropic = anthropicMessage(conv[2]!);
    expect(((anthropic.content as Array<Record<string, unknown>>)[0]!)["tool_use_id"]).toBe("x");

    const gemini = geminiMessage(conv[2]!);
    expect(
      ((gemini.parts[0] as Record<string, unknown>)["functionResponse"] as Record<string, unknown>)[
        "name"
      ],
    ).toBe("calculator");
  });
});
