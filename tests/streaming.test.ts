/**
 * Streaming responses (Worker S) — regression suite.
 *
 * Everything here is mocked: no network, no Telegram, no real provider.
 * Covered:
 *  - the BOBI_STREAMING kill switch
 *  - the SSE event parser (chunk-split lines, heartbeats, [DONE], malformed)
 *  - the throttled StreamRenderer
 *  - the agent loop consuming a token stream (tokens, tool-call abort,
 *    pre/post-first-token failure fallbacks, kill switch, no sink)
 *  - the gateway: synthesised streams, event passthrough, usage reporting,
 *    and the no-failover-after-first-event boundary
 *  - time-to-first-token vs full-response latency on a scripted stream
 */
import { describe, expect, test, afterEach } from "bun:test";
import { SseParser } from "../src/ai/openai_compatible";
import { AiError } from "../src/ai/provider";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ToolCall,
} from "../src/ai/provider";
import {
  STREAMING_ENV_VAR,
  StreamRenderer,
  currentStreamSink,
  runWithStreamSink,
  streamingEnabled,
} from "../src/agent/stream";
import type { AgentStreamEvent } from "../src/agent/stream";
import { AgentLoop } from "../src/agent/loop";
import { ToolService } from "../src/tools/service";
import type { ToolActor } from "../src/tools/types";
import { Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";

// ---------------------------------------------------------------- helpers

const ACTOR: ToolActor = {
  userId: "u1",
  permissions: ["tools:calculator"],
};

const SIGNAL = () => new AbortController().signal;

function endEvent(text: string, toolCalls: readonly ToolCall[] = []): StreamEvent {
  return { type: "end", text, model: "m", toolCalls };
}

async function* gen(events: readonly StreamEvent[]): AsyncGenerator<StreamEvent, void, undefined> {
  for (const e of events) yield e;
}

/** Collect every event a stream yields. */
async function collect(
  stream: AsyncGenerator<StreamEvent, void, undefined>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/**
 * A provider scripted per call: each entry is a list of stream events, a raw
 * async generator, or an error the stream throws. Falls back to complete()
 * when asked.
 */
class ScriptedStreamProvider implements AiProvider {
  readonly name = "scripted-stream";
  completeCalls = 0;
  streamCalls = 0;
  constructor(
    private readonly scripts: ReadonlyArray<
      readonly StreamEvent[] | AsyncGenerator<StreamEvent, void, undefined> | Error
    >,
    private readonly fallbackText = "single-shot answer",
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls++;
    // Phase-3 self-review: confirm the draft unchanged (review protocol).
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : "";
    if (lastUserText.startsWith("<self_review>")) {
      const draftMsg = [...req.messages].reverse().find((m) => m.role === "assistant");
      const draft = typeof draftMsg?.content === "string" ? draftMsg.content : this.fallbackText;
      return { text: draft, model: "m" };
    }
    return { text: this.fallbackText, model: "m" };
  }

  completeStream(_req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const script = this.scripts[this.streamCalls++];
    if (script instanceof Error) {
      const err = script;
      return (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
        throw err;
      })();
    }
    if (script === undefined) return gen([]);
    if (typeof (script as AsyncGenerator<StreamEvent, void, undefined>)[Symbol.asyncIterator] === "function") {
      return script as AsyncGenerator<StreamEvent, void, undefined>;
    }
    return gen(script as readonly StreamEvent[]);
  }
}

function makeLoop(provider: AiProvider) {
  return new AgentLoop({
    provider,
    model: "m",
    tools: new ToolService(),
    callTimeoutMs: 5_000,
  });
}

/** Run one turn with a sink installed, collecting the loop's stream events. */
async function runWithEvents(loop: AgentLoop) {
  const events: AgentStreamEvent[] = [];
  const result = await runWithStreamSink(
    (ev) => events.push(ev),
    () =>
      loop.run({
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: "sys",
        actor: ACTOR,
        signal: SIGNAL(),
      }),
  );
  return { result, events };
}

// ------------------------------------------------------------ kill switch

describe("BOBI_STREAMING kill switch", () => {
  const OLD = process.env[STREAMING_ENV_VAR];
  afterEach(() => {
    if (OLD === undefined) delete process.env[STREAMING_ENV_VAR];
    else process.env[STREAMING_ENV_VAR] = OLD;
  });

  test("defaults to ON when unset", () => {
    delete process.env[STREAMING_ENV_VAR];
    expect(streamingEnabled()).toBe(true);
  });

  test.each(["0", "false", "no", "off", "FALSE", " No "])("disables on %p", (v) => {
    process.env[STREAMING_ENV_VAR] = v;
    expect(streamingEnabled()).toBe(false);
  });

  test.each(["1", "true", "yes", "", "anything"])("stays on for %p", (v) => {
    process.env[STREAMING_ENV_VAR] = v;
    expect(streamingEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------- SSE parser

describe("SseParser", () => {
  test("parses events split across arbitrary chunk boundaries", () => {
    const p = new SseParser();
    const body =
      `: heartbeat\n` +
      `data: {"choices":[{"delta":{"content":"Hel` +
      `lo"}}]}\n` +
      `\n` +
      `data: {"choices":[{"delta":{"content":" world"}}]}\n\n` +
      `data: [DONE]\n\n`;
    // Feed in 7-byte slices: lines and JSON payloads split mid-way.
    const events: Record<string, unknown>[] = [];
    for (let i = 0; i < body.length; i += 7) {
      events.push(...p.push(body.slice(i, i + 7)));
    }
    expect(events).toHaveLength(2);
    const first = events[0]!["choices"] as Array<{ delta: { content: string } }>;
    expect(first[0]!.delta.content).toBe("Hello");
    const second = events[1]!["choices"] as Array<{ delta: { content: string } }>;
    expect(second[0]!.delta.content).toBe(" world");
  });

  test("[DONE] ends the event flow", () => {
    const p = new SseParser();
    expect(p.push(`data: {"a":1}\n\ndata: [DONE]\n\n`)).toHaveLength(1);
    expect(p.push(`data: {"a":2}\n\n`)).toHaveLength(0);
  });

  test("malformed JSON is invalid_response, not a silent skip", () => {
    const p = new SseParser();
    expect(() => p.push(`data: {not json}\n\n`)).toThrow(AiError);
    try {
      p.push(`data: {not json}\n\n`);
    } catch (err) {
      expect((err as AiError).kind).toBe("invalid_response");
    }
  });

  test("flush() returns a trailing unterminated event", () => {
    const p = new SseParser();
    expect(p.push(`data: {"a":1}`)).toHaveLength(0);
    const flushed = p.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual({ a: 1 });
  });
});

// -------------------------------------------------------- StreamRenderer

describe("StreamRenderer", () => {
  function setup(maxPreviewChars = 100) {
    let now = 0;
    const edits: string[] = [];
    const renderer = new StreamRenderer(
      async (text) => {
        edits.push(text);
      },
      { now: () => now, minIntervalMs: 1000, maxPreviewChars },
    );
    return { renderer, edits, advance: (ms: number) => (now += ms) };
  }

  test("throttles edits to the interval and coalesces tokens", async () => {
    const { renderer, edits, advance } = setup();
    renderer.push("Hello");
    renderer.push(" ");
    renderer.push("world");
    await renderer.flush();
    expect(edits).toEqual(["Hello world"]);
    // Nothing new: no second edit.
    await renderer.flush();
    expect(edits).toHaveLength(1);
    // Interval not elapsed: no edit even with new text.
    advance(500);
    renderer.push("!");
    await renderer.flush();
    expect(edits).toHaveLength(1);
    // Interval elapsed: one edit with everything.
    advance(600);
    await renderer.flush();
    expect(edits).toEqual(["Hello world", "Hello world!"]);
  });

  test("the live preview is capped so Telegram never rejects it", async () => {
    const { renderer, edits, advance } = setup(10);
    renderer.push("Hello world, this is long");
    advance(2000);
    await renderer.flush();
    expect(edits).toEqual(["Hello worl"]);
    expect(edits[0]!.length).toBeLessThanOrEqual(10);
  });

  test("flushNow bypasses the throttle for the first token", async () => {
    const { renderer, edits } = setup();
    renderer.push("Hi");
    await renderer.flushNow();
    expect(edits).toEqual(["Hi"]);
  });

  test("suspend drops the partial text; a later push starts fresh", async () => {
    const { renderer, edits, advance } = setup();
    renderer.push("partial");
    advance(2000);
    await renderer.flush();
    expect(edits).toEqual(["partial"]);
    renderer.suspend();
    renderer.push("fresh answer");
    advance(2000);
    await renderer.flush();
    expect(edits).toEqual(["partial", "fresh answer"]);
  });

  test("stop blocks pushes and flushes", async () => {
    const { renderer, edits, advance } = setup();
    renderer.stop();
    renderer.push("nope");
    advance(5000);
    await renderer.flush();
    await renderer.flushNow();
    expect(edits).toEqual([]);
    expect(renderer.started).toBe(false);
  });

  test("started tracks whether any token arrived", () => {
    const { renderer } = setup();
    expect(renderer.started).toBe(false);
    renderer.push("");
    expect(renderer.started).toBe(false);
    renderer.push("x");
    expect(renderer.started).toBe(true);
  });
});

// ------------------------------------------------- ambient sink plumbing

describe("ambient stream sink", () => {
  test("currentStreamSink is undefined outside a scope", () => {
    expect(currentStreamSink()).toBeUndefined();
  });

  test("runWithStreamSink installs and removes the sink", async () => {
    const sink = () => undefined;
    let seenInside: unknown;
    await runWithStreamSink(sink, async () => {
      seenInside = currentStreamSink();
    });
    expect(seenInside).toBe(sink);
    expect(currentStreamSink()).toBeUndefined();
  });

  test("concurrent scopes do not see each other's sink", async () => {
    const a = () => undefined;
    const b = () => undefined;
    const seen: unknown[] = [];
    await Promise.all([
      runWithStreamSink(a, async () => {
        await Bun.sleep(10);
        seen.push(currentStreamSink());
      }),
      runWithStreamSink(b, async () => {
        seen.push(currentStreamSink());
      }),
    ]);
    // Order varies; both sinks must appear exactly once.
    expect(seen).toHaveLength(2);
    expect(seen).toContain(a);
    expect(seen).toContain(b);
  });
});

// ------------------------------------------------------- loop streaming

describe("agent loop — streaming", () => {
  const OLD = process.env[STREAMING_ENV_VAR];
  afterEach(() => {
    if (OLD === undefined) delete process.env[STREAMING_ENV_VAR];
    else process.env[STREAMING_ENV_VAR] = OLD;
  });

  test("consumes the token stream and forwards deltas in order", async () => {
    delete process.env[STREAMING_ENV_VAR];
    const provider = new ScriptedStreamProvider([
      [
        { type: "text", delta: "Hello" },
        { type: "text", delta: " " },
        { type: "text", delta: "world" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
        endEvent("Hello world"),
      ],
    ]);
    const { result, events } = await runWithEvents(makeLoop(provider));

    expect(result.text).toBe("Hello world");
    expect(result.stopReason).toBe("answered");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(provider.completeCalls).toBe(0);
    expect(provider.streamCalls).toBe(1);
    expect(events).toEqual([
      { type: "token", delta: "Hello" },
      { type: "token", delta: " " },
      { type: "token", delta: "world" },
    ]);
  });

  test("a stream that resolves into tool calls aborts the partial render and continues", async () => {
    delete process.env[STREAMING_ENV_VAR];
    const toolCall: ToolCall = { id: "c1", name: "calculator", arguments: { op: "add", a: 20, b: 22 } };
    const provider = new ScriptedStreamProvider([
      // First model call: some prose, then tool calls.
      [{ type: "text", delta: "Let me add that." }, endEvent("Let me add that.", [toolCall])],
      // Second model call: the final answer.
      [{ type: "text", delta: "42" }, endEvent("42")],
    ]);
    const { result, events } = await runWithEvents(makeLoop(provider));

    expect(result.text).toBe("42");
    expect(result.toolCallsExecuted).toBe(1);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["token", "toolcall", "token"]);
  });

  test("stream error before the first token falls back silently to single-shot", async () => {
    delete process.env[STREAMING_ENV_VAR];
    const provider = new ScriptedStreamProvider([new AiError("network", "boom")]);
    const { result, events } = await runWithEvents(makeLoop(provider));

    expect(result.text).toBe("single-shot answer");
    expect(provider.completeCalls).toBe(1);
    // Nothing was ever shown, so no UI events at all.
    expect(events).toEqual([]);
  });

  test("stream error after tokens: restart event, then the full single-shot answer", async () => {
    delete process.env[STREAMING_ENV_VAR];
    const provider = new ScriptedStreamProvider([
      (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
        yield { type: "text", delta: "partial " };
        throw new AiError("network", "dropped");
      })(),
    ]);
    const { result, events } = await runWithEvents(makeLoop(provider));

    expect(result.text).toBe("single-shot answer");
    expect(provider.completeCalls).toBe(1);
    expect(events).toEqual([{ type: "token", delta: "partial " }, { type: "restart" }]);
  });

  test("stream error after tokens with a failed fallback: error event, original error thrown", async () => {
    delete process.env[STREAMING_ENV_VAR];
    const provider = new ScriptedStreamProvider(
      [
        (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "text", delta: "partial " };
          throw new AiError("network", "dropped");
        })(),
      ],
      "unused",
    );
    // Make the single-shot fallback fail too.
    provider.complete = async () => {
      provider.completeCalls++;
      throw new AiError("network", "also down");
    };
    const events: AgentStreamEvent[] = [];
    await expect(
      runWithStreamSink(
        (ev) => events.push(ev),
        () =>
          makeLoop(provider).run({
            messages: [{ role: "user", content: "hi" }],
            systemPrompt: "sys",
            actor: ACTOR,
            signal: SIGNAL(),
          }),
      ),
    ).rejects.toThrow("dropped");
    expect(events).toEqual([
      { type: "token", delta: "partial " },
      { type: "restart" },
      { type: "error" },
    ]);
  });

  test("kill switch off: completeStream is never called", async () => {
    process.env[STREAMING_ENV_VAR] = "0";
    const provider = new ScriptedStreamProvider([[{ type: "text", delta: "x" }, endEvent("x")]]);
    const events: AgentStreamEvent[] = [];
    const result = await runWithStreamSink(
      (ev) => events.push(ev),
      () =>
        makeLoop(provider).run({
          messages: [{ role: "user", content: "hi" }],
          systemPrompt: "sys",
          actor: ACTOR,
          signal: SIGNAL(),
        }),
    );
    expect(provider.streamCalls).toBe(0);
    expect(provider.completeCalls).toBe(1);
    expect(result.text).toBe("single-shot answer");
    expect(events).toEqual([]);
  });

  test("no sink installed: the loop does not stream", async () => {
    delete process.env[STREAMING_ENV_VAR];
    const provider = new ScriptedStreamProvider([[{ type: "text", delta: "x" }, endEvent("x")]]);
    const result = await makeLoop(provider).run({
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "sys",
      actor: ACTOR,
      signal: SIGNAL(),
    });
    expect(provider.streamCalls).toBe(0);
    expect(provider.completeCalls).toBe(1);
    expect(result.text).toBe("single-shot answer");
  });

  test("a timed-out stream does not fall back (budget is spent)", async () => {
    delete process.env[STREAMING_ENV_VAR];
    const provider = new ScriptedStreamProvider([
      (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
        yield { type: "text", delta: "slow " };
        await Bun.sleep(50); // longer than the call timeout below
        yield endEvent("slow done");
      })(),
    ]);
    const loop = new AgentLoop({
      provider,
      model: "m",
      tools: new ToolService(),
      callTimeoutMs: 20,
    });
    const events: AgentStreamEvent[] = [];
    await expect(
      runWithStreamSink(
        (ev) => events.push(ev),
        () =>
          loop.run({
            messages: [{ role: "user", content: "hi" }],
            systemPrompt: "sys",
            actor: ACTOR,
            signal: SIGNAL(),
          }),
      ),
    ).rejects.toThrow();
    // The token went out, but no restart: a spent deadline never retries.
    expect(events).toEqual([{ type: "token", delta: "slow " }]);
    expect(provider.completeCalls).toBe(0);
  });
});

// ------------------------------------------------------- gateway streaming

describe("gateway — streaming", () => {
  const KEY = "streaming-test-master-key";

  function build() {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const providers = new ProviderService(storage, secrets, new AdapterRegistry());
    const models = new ModelService(storage);
    return { storage, secrets, providers, models };
  }

  function seed(tag: string, ctx: ReturnType<typeof build>) {
    const p = ctx.providers.create({
      label: tag,
      adapter: "openai_compatible",
      baseUrl: `https://${tag}.invalid/v1`,
      apiKey: "test-key-not-real",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = ctx.models.add({ providerId: p.data, modelId: `model-${tag}`, label: tag });
    if (!m.ok) throw new Error("model failed");
    ctx.models.setDefault(m.data);
    ctx.storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });
    return { providerId: p.data, modelId: m.data };
  }

  const REQ: CompletionRequest = {
    messages: [{ role: "user", content: "hi" }],
    model: "ignored",
    timeoutMs: 1000,
    signal: SIGNAL(),
  };

  test("an adapter without streaming gets a synthesised stream", async () => {
    const ctx = build();
    seed("plain", ctx);
    const created: string[] = [];
    const fakeAdapters = {
      create: () => {
        created.push("adapter");
        return {
          name: "plain",
          // No completeStream: the gateway synthesises the stream.
          complete: async (req: { model: string }) => ({
            text: "one-shot",
            model: req.model,
            usage: { inputTokens: 3, outputTokens: 7 },
          }),
        };
      },
    } as unknown as AdapterRegistry;
    const seen: { providerId: number; modelId: string }[] = [];
    const gateway = new AiGateway({
      storage: ctx.storage,
      adapters: fakeAdapters,
      secrets: ctx.secrets,
      onUsage: (info) => seen.push({ providerId: info.providerId, modelId: info.modelId }),
    });

    const events = await collect(gateway.completeStream(REQ));
    expect(created).toEqual(["adapter"]);
    expect(events).toEqual([
      { type: "text", delta: "one-shot" },
      {
        type: "end",
        text: "one-shot",
        model: "model-plain",
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 7 },
      },
    ]);
    // Usage still reaches the listener, like the non-streaming path.
    expect(seen).toEqual([{ providerId: 1, modelId: "model-plain" }]);
  });

  test("native adapter events pass through in order", async () => {
    const ctx = build();
    seed("native", ctx);
    const script: StreamEvent[] = [
      { type: "text", delta: "a" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "text", delta: "b" },
      endEvent("ab"),
    ];
    const fakeAdapters = {
      create: () => ({
        name: "native",
        complete: async () => {
          throw new Error("must not be called");
        },
        completeStream: () => gen(script),
      }),
    } as unknown as AdapterRegistry;
    const gateway = new AiGateway({ storage: ctx.storage, adapters: fakeAdapters, secrets: ctx.secrets });

    expect(await collect(gateway.completeStream(REQ))).toEqual(script);
  });

  test("no selection: AiError before any event", async () => {
    const ctx = build();
    const fakeAdapters = {
      create: () => {
        throw new Error("must not be called");
      },
    } as unknown as AdapterRegistry;
    const gateway = new AiGateway({ storage: ctx.storage, adapters: fakeAdapters, secrets: ctx.secrets });
    await expect(collect(gateway.completeStream(REQ))).rejects.toThrow(AiError);
  });

  test("auth failure before the first event surfaces without a retry", async () => {
    const ctx = build();
    seed("authfail", ctx);
    const throwing = {
      create: () => ({
        name: "authfail",
        completeStream: (): AsyncGenerator<StreamEvent, void, undefined> =>
          (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
            throw new AiError("auth", "bad key");
          })(),
      }),
    } as unknown as AdapterRegistry;
    const gateway = new AiGateway({ storage: ctx.storage, adapters: throwing, secrets: ctx.secrets });
    await expect(collect(gateway.completeStream(REQ))).rejects.toThrow("bad key");
  });

  test("mid-stream failure never fails over to another candidate", async () => {
    const ctx = build();
    const a = seed("a", ctx);
    const b = seed("b", ctx);
    // seed() leaves the LAST pair active; failover must start from A.
    ctx.storage.setRuntimeSelection({ providerId: a.providerId, modelId: a.modelId });
    ctx.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    ctx.storage.setFailoverCandidates([
      { providerId: a.providerId, modelId: a.modelId },
      { providerId: b.providerId, modelId: b.modelId },
    ]);
    const createdModels: string[] = [];
    const fakeAdapters = {
      create: (_type: string, cfg: { model: string }) => {
        createdModels.push(cfg.model);
        if (cfg.model === "model-a") {
          return {
            name: "a",
            completeStream: (): AsyncGenerator<StreamEvent, void, undefined> =>
              (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
                yield { type: "text", delta: "partial" };
                throw new AiError("network", "dropped mid-stream");
              })(),
          };
        }
        return {
          name: "b",
          completeStream: () => gen([endEvent("from b")]),
        };
      },
    } as unknown as AdapterRegistry;
    const gateway = new AiGateway({ storage: ctx.storage, adapters: fakeAdapters, secrets: ctx.secrets });

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of gateway.completeStream(REQ)) events.push(e);
      })(),
    ).rejects.toThrow("dropped mid-stream");
    // The partial event went out, then the error — candidate B was never
    // touched, so no duplicated text.
    expect(events).toEqual([{ type: "text", delta: "partial" }]);
    expect(createdModels).toEqual(["model-a"]);
  });

  test("pre-first-event network failure DOES fail over to the next candidate", async () => {
    const ctx = build();
    const a = seed("a", ctx);
    const b = seed("b", ctx);
    // seed() leaves the LAST pair active; failover must start from A.
    ctx.storage.setRuntimeSelection({ providerId: a.providerId, modelId: a.modelId });
    ctx.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
    ctx.storage.setFailoverCandidates([
      { providerId: a.providerId, modelId: a.modelId },
      { providerId: b.providerId, modelId: b.modelId },
    ]);
    const fakeAdapters = {
      create: (_type: string, cfg: { model: string }) => {
        if (cfg.model === "model-a") {
          return {
            name: "a",
            completeStream: (): AsyncGenerator<StreamEvent, void, undefined> =>
              (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
                throw new AiError("network", "a is down");
              })(),
          };
        }
        return {
          name: "b",
          completeStream: () => gen([{ type: "text", delta: "from b" }, endEvent("from b")]),
        };
      },
    } as unknown as AdapterRegistry;
    const gateway = new AiGateway({ storage: ctx.storage, adapters: fakeAdapters, secrets: ctx.secrets });

    // Nothing was shown yet, so failing over is invisible and correct.
    const events = await collect(gateway.completeStream(REQ));
    expect(events).toEqual([{ type: "text", delta: "from b" }, endEvent("from b")]);
  });
});

// --------------------------------------------------------------- latency

describe("streaming latency — time to first token", () => {
  test("first token arrives well before the full response", async () => {
    const provider = new ScriptedStreamProvider([
      (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
        await Bun.sleep(30);
        yield { type: "text", delta: "Hello" };
        await Bun.sleep(120);
        yield { type: "text", delta: " world" };
        await Bun.sleep(120);
        yield endEvent("Hello world");
      })(),
    ]);
    const firstTokenAt: number[] = [];
    let endedAt = 0;
    const t0 = Date.now();
    await runWithStreamSink(
      (ev) => {
        if (ev.type === "token" && firstTokenAt.length === 0) firstTokenAt.push(Date.now() - t0);
      },
      () =>
        makeLoop(provider).run({
          messages: [{ role: "user", content: "hi" }],
          systemPrompt: "sys",
          actor: ACTOR,
          signal: SIGNAL(),
        }),
    ).then(() => {
      endedAt = Date.now() - t0;
    });

    const ttft = firstTokenAt[0]!;
    // The first token must arrive well before the whole stream finished:
    // that gap is the perceived-latency win over dump-at-once delivery.
    expect(ttft).toBeLessThan(endedAt - 100);
    expect(ttft).toBeGreaterThanOrEqual(20);
    console.log(`[streaming] first visible text after ${ttft} ms; full answer after ${endedAt} ms`);
  });
});
