/**
 * Native streaming + per-request maxTokens for the Gemini and Anthropic
 * adapters (audit v2 H2 + H3).
 *
 * Hermetic: the request builders are asserted directly, and the stream
 * assemblers are fed recorded-shape SSE JSON events — no network, no
 * sockets. The assemblers are the same classes completeStream drives.
 */
import { describe, expect, test } from "bun:test";
import { buildBody as buildGeminiBody, GeminiStreamAssembler } from "../src/ai/gemini";
import { AnthropicStreamAssembler, buildBody as buildAnthropicBody } from "../src/ai/anthropic";
import { AiError, isEmptyResponseError } from "../src/ai/provider";
import type { CompletionRequest, StreamEvent } from "../src/ai/provider";

const REQ: CompletionRequest = {
  messages: [{ role: "user", content: "hi" }],
  model: "test-model",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
};

function collectPushes<T extends { push(e: Record<string, unknown>): StreamEvent[] }>(
  assembler: T,
  events: readonly Record<string, unknown>[],
): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const e of events) out.push(...assembler.push(e));
  return out;
}

// ------------------------------------------------------------- Gemini H2

describe("Gemini buildBody — maxTokens (H2)", () => {
  const target = (maxTokens?: number) => ({
    baseUrl: "https://example.test/v1beta",
    apiKey: "k",
    settings: maxTokens === undefined ? {} : { maxTokens },
  });

  test("per-request cap wins over the settings cap", () => {
    const body = buildGeminiBody(target(999), { ...REQ, maxTokens: 16 });
    const gen = body["generationConfig"] as Record<string, unknown>;
    expect(gen["maxOutputTokens"]).toBe(16);
  });

  test("settings cap is the fallback when the request sets none", () => {
    const body = buildGeminiBody(target(321), REQ);
    const gen = body["generationConfig"] as Record<string, unknown>;
    expect(gen["maxOutputTokens"]).toBe(321);
  });

  test("no cap is emitted when neither level sets one", () => {
    const body = buildGeminiBody(target(), REQ);
    const gen = body["generationConfig"] as Record<string, unknown> | undefined;
    expect(gen?.["maxOutputTokens"]).toBeUndefined();
  });

  test("the cap is truncated and clamped to 100k", () => {
    const body = buildGeminiBody(target(), { ...REQ, maxTokens: 150_000.7 });
    const gen = body["generationConfig"] as Record<string, unknown>;
    expect(gen["maxOutputTokens"]).toBe(100_000);
    const body2 = buildGeminiBody(target(), { ...REQ, maxTokens: 42.9 });
    expect((body2["generationConfig"] as Record<string, unknown>)["maxOutputTokens"]).toBe(42);
  });

  test("an invalid per-request cap falls through to the settings cap", () => {
    const body = buildGeminiBody(target(77), { ...REQ, maxTokens: 0 });
    const gen = body["generationConfig"] as Record<string, unknown>;
    expect(gen["maxOutputTokens"]).toBe(77);
  });
});

// ------------------------------------------------------------- Gemini H3

describe("GeminiStreamAssembler (H3)", () => {
  test("multi-chunk text + functionCall + usageMetadata, thought parts excluded", () => {
    const a = new GeminiStreamAssembler("requested-model");
    const events = collectPushes(a, [
      {
        modelVersion: "gemini-2.5-flash",
        candidates: [{ content: { parts: [{ text: "Hel" }] } }],
      },
      {
        candidates: [
          { content: { parts: [{ text: "lo " }, { thought: true, text: "secret reasoning" }] } },
        ],
      },
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "calculator", args: { a: 5 } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 7 },
      },
    ]);

    const deltas = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["Hel", "lo "]);
    // The thought part never surfaces as a delta.
    expect(JSON.stringify(events)).not.toContain("secret reasoning");
    const usageEvents = events.filter((e) => e.type === "usage");
    expect(usageEvents).toEqual([{ type: "usage", usage: { inputTokens: 10, outputTokens: 7 } }]);

    const end = a.finish();
    expect(end).toEqual({
      type: "end",
      text: "Hello ",
      model: "gemini-2.5-flash",
      toolCalls: [{ id: "call_0_calculator", name: "calculator", arguments: { a: 5 } }],
      usage: { inputTokens: 10, outputTokens: 7 },
    });
  });

  test("multiple function calls get positional ids like parseResponse", () => {
    const a = new GeminiStreamAssembler("m");
    collectPushes(a, [
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "first", args: {} } },
                { functionCall: { name: "second", args: { x: 1 } } },
              ],
            },
          },
        ],
      },
    ]);
    const end = a.finish();
    if (end.type !== "end") throw new Error("expected end");
    expect(end.toolCalls.map((c) => c.id)).toEqual(["call_0_first", "call_1_second"]);
    // A tool-only stream is not empty, even with no text.
    expect(end.text).toBe("");
  });

  test("a thought-only stream is the empty-response failure (reasoning detail)", () => {
    const a = new GeminiStreamAssembler("m");
    const events = collectPushes(a, [
      { candidates: [{ content: { parts: [{ thought: true, text: "thinking…" }] } }] },
    ]);
    expect(events).toEqual([]);
    let err: unknown;
    try {
      a.finish();
    } catch (e) {
      err = e;
    }
    expect(isEmptyResponseError(err)).toBe(true);
    expect((err as AiError).message).toContain("stream");
    expect((err as AiError).message).toContain("reasoning only");
  });

  test("an empty SAFETY finish is the empty-response failure naming the finish reason", () => {
    const a = new GeminiStreamAssembler("m");
    collectPushes(a, [
      { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] },
    ]);
    let err: unknown;
    try {
      a.finish();
    } catch (e) {
      err = e;
    }
    expect(isEmptyResponseError(err)).toBe(true);
    expect((err as AiError).message).toContain("SAFETY");
    expect((err as AiError).message).toContain("stream");
  });

  test("a promptFeedback block with no candidates is the empty-response failure", () => {
    const a = new GeminiStreamAssembler("m");
    collectPushes(a, [{ promptFeedback: { blockReason: "SAFETY" } }]);
    let err: unknown;
    try {
      a.finish();
    } catch (e) {
      err = e;
    }
    expect(isEmptyResponseError(err)).toBe(true);
    expect((err as AiError).message).toContain("SAFETY");
  });

  test("a completely empty stream is the empty-response failure", () => {
    const a = new GeminiStreamAssembler("m");
    expect(() => a.finish()).toThrow(AiError);
    let err: unknown;
    try {
      a.finish();
    } catch (e) {
      err = e;
    }
    expect(isEmptyResponseError(err)).toBe(true);
  });
});

// ---------------------------------------------------------- Anthropic H2

describe("Anthropic buildBody — maxTokens (H2)", () => {
  const target = (maxTokens?: number) => ({
    baseUrl: "https://example.test/v1",
    apiKey: "k",
    settings: maxTokens === undefined ? {} : { maxTokens },
  });

  test("per-request cap wins over the settings cap", () => {
    const body = buildAnthropicBody(target(999), { ...REQ, maxTokens: 16 });
    expect(body["max_tokens"]).toBe(16);
  });

  test("settings cap is the fallback when the request sets none", () => {
    const body = buildAnthropicBody(target(321), REQ);
    expect(body["max_tokens"]).toBe(321);
  });

  test("the required default 1024 applies when neither level sets a cap", () => {
    const body = buildAnthropicBody(target(), REQ);
    expect(body["max_tokens"]).toBe(1024);
  });

  test("the cap is truncated and clamped to 100k", () => {
    expect(buildAnthropicBody(target(), { ...REQ, maxTokens: 150_000.7 })["max_tokens"]).toBe(100_000);
    expect(buildAnthropicBody(target(), { ...REQ, maxTokens: 42.9 })["max_tokens"]).toBe(42);
  });
});

// ---------------------------------------------------------- Anthropic H3

describe("AnthropicStreamAssembler (H3)", () => {
  test("text deltas + fragmented tool_use + stop_reason + usage assembly", () => {
    const a = new AnthropicStreamAssembler("requested-model");
    const events = collectPushes(a, [
      {
        type: "message_start",
        message: { id: "msg_1", model: "claude-test-1", usage: { input_tokens: 25, output_tokens: 1 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "add that." } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "calculator", input: {} },
      },
      // The tool input arrives as three partial-JSON fragments.
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: " 5, " } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"b": 2}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ]);

    const deltas = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
    expect(deltas).toEqual(["Let me ", "add that."]);
    // Exactly one usage event: the assembled counts at message_delta.
    expect(events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 25, outputTokens: 42 } },
    ]);
    expect(a.stopReason).toBe("tool_use");

    const end = a.finish();
    expect(end).toEqual({
      type: "end",
      text: "Let me add that.",
      model: "claude-test-1",
      toolCalls: [{ id: "tu_1", name: "calculator", arguments: { a: 5, b: 2 } }],
      usage: { inputTokens: 25, outputTokens: 42 },
    });
  });

  test("a malformed accumulated tool input yields {} instead of throwing", () => {
    const a = new AnthropicStreamAssembler("m");
    collectPushes(a, [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_9", name: "calc", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{oops" } },
      { type: "content_block_stop", index: 0 },
    ]);
    const end = a.finish();
    if (end.type !== "end") throw new Error("expected end");
    expect(end.toolCalls).toEqual([{ id: "tu_9", name: "calc", arguments: {} }]);
  });

  test("a thinking-only stream is the empty-response failure", () => {
    const a = new AnthropicStreamAssembler("m");
    const events = collectPushes(a, [
      { type: "message_start", message: { model: "m", usage: { input_tokens: 9 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ]);
    // Thinking is never surfaced as a text delta.
    expect(events.filter((e) => e.type === "text")).toEqual([]);
    let err: unknown;
    try {
      a.finish();
    } catch (e) {
      err = e;
    }
    expect(isEmptyResponseError(err)).toBe(true);
    expect((err as AiError).message).toContain("stream");
    expect((err as AiError).message).toContain("end_turn");
    expect((err as AiError).message).toContain("reasoning only");
  });

  test("a completely empty stream is the empty-response failure", () => {
    const a = new AnthropicStreamAssembler("m");
    let err: unknown;
    try {
      a.finish();
    } catch (e) {
      err = e;
    }
    expect(isEmptyResponseError(err)).toBe(true);
    expect((err as AiError).message).toContain("stream");
  });

  const errorCases: ReadonlyArray<readonly [string, AiError["kind"]]> = [
    ["authentication_error", "auth"],
    ["rate_limit_error", "quota"],
    ["overloaded_error", "network"],
    ["invalid_request_error", "invalid_response"],
    ["api_error", "invalid_response"],
  ];
  test.each(errorCases)("error event %s maps to kind %s and carries the provider's words", (errorType, kind) => {
    const a = new AnthropicStreamAssembler("m");
    let err: unknown;
    try {
      a.push({ type: "error", error: { type: errorType, message: `provider said: ${errorType}` } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe(kind);
    expect((err as AiError).providerMessage).toBe(`provider said: ${errorType}`);
  });
});
