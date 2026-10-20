/**
 * Chat reliability suite — "make chat work like the probe".
 *
 * Hermetic (scripted adapters, :memory: storage, fake clocks), covering:
 *  (a) loop: stream fails pre-first-delta → ONE non-stream fallback
 *  (a2) loop: stream ends empty → ONE non-stream fallback
 *  (b) gateway: stream fails after a text delta → committed, no failover;
 *      loop: post-delta failure restarts via single-shot, never re-streams
 *  (c) adapters: empty final text + no tool calls → empty AiError;
 *      reasoning-only payloads are still empty (no chain-of-thought leaks)
 *  (d) adapters: empty text WITH tool calls stays legal
 *  (e) gateway: candidate A empties → candidate B answers; all-fail error
 *      carries "(tried N providers)" + attempts
 *  (f) per-model quarantine: 3 consecutive failures → skipped for the
 *      cooldown → recovered after expiry; a lone candidate is never
 *      skipped; duration 0 disables
 *  (g) the realistic probe stage: full tool payload + streaming detects
 *      an empty stream the ping cannot see
 *  (h) shared quarantine wiring (the index.ts pattern): a gateway built
 *      with the process-wide sharedModelQuarantine writes failure state
 *      the health service's probe results then flag as `quarantined`
 */
import { describe, expect, test } from "bun:test";
import {
  AiError,
  emptyResponseError,
  isEmptyResponseError,
} from "../src/ai/provider";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from "../src/ai/provider";
import { parseResponse as parseOpenAiResponse, OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import { parseResponse as parseAnthropicResponse } from "../src/ai/anthropic";
import { ModelQuarantineRegistry, sharedModelQuarantine } from "../src/ai/model_quarantine";
import { AiGateway } from "../src/ai/gateway";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderService, ModelService } from "../src/ai/provider_service";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ProviderHealthService } from "../src/ai/health";
import { Storage } from "../src/storage/storage";
import { AgentLoop } from "../src/agent/loop";
import { ToolService } from "../src/tools/service";
import { runWithStreamSink } from "../src/agent/stream";
import type { AgentStreamEvent } from "../src/agent/stream";
import type { ToolActor } from "../src/tools/types";
import { t } from "../src/i18n";

// ------------------------------------------------------------- env helper

/** Run `fn` with env overrides, restoring the previous values after. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ------------------------------------------------------- loop fake provider

type LoopMode = "throw-pre-delta" | "empty-end" | "throw-after-delta";

class LoopFakeProvider {
  readonly name = "loop-fake";
  completeCalls = 0;
  streamCalls = 0;
  constructor(
    private readonly mode: LoopMode,
    private readonly fallbackText: string | null,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls++;
    if (this.fallbackText === null) {
      throw new AiError("network", "single-shot is down too");
    }
    return { text: this.fallbackText, model: req.model };
  }

  completeStream(req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.streamCalls++;
    const mode = this.mode;
    return (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      if (mode === "throw-pre-delta") {
        throw new AiError("network", "stream refused");
      }
      if (mode === "empty-end") {
        yield { type: "end", text: "", model: req.model, toolCalls: [] };
        return;
      }
      yield { type: "text", delta: "partial " };
      throw new AiError("network", "stream dropped mid-answer");
    })();
  }
}

const ACTOR: ToolActor = { userId: "u-test", permissions: [] };

async function runLoopOnce(provider: LoopFakeProvider) {
  const loop = new AgentLoop({
    provider: provider as never,
    model: "m",
    tools: new ToolService(),
    callTimeoutMs: 5_000,
  });
  const events: AgentStreamEvent[] = [];
  const result = await runWithStreamSink(
    (ev) => events.push(ev),
    () =>
      loop.run({
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: "sys",
        actor: ACTOR,
        signal: new AbortController().signal,
      }),
  );
  return { result, events };
}

describe("agent loop — stream fallback (chat reliability)", () => {
  test("(a) stream fails before the first delta → exactly one non-stream fallback", async () => {
    await withEnv({ BOBI_STREAMING: undefined, BOBI_STREAM_FALLBACK: undefined }, async () => {
      const provider = new LoopFakeProvider("throw-pre-delta", "recovered answer");
      const { result, events } = await runLoopOnce(provider);
      expect(result.text).toBe("recovered answer");
      expect(provider.streamCalls).toBe(1);
      expect(provider.completeCalls).toBe(1); // exactly ONE fallback
      expect(events).toEqual([]); // nothing was ever shown to the user
    });
  });

  test("(a2) stream ends empty → exactly one non-stream fallback", async () => {
    await withEnv({ BOBI_STREAMING: undefined, BOBI_STREAM_FALLBACK: undefined }, async () => {
      const provider = new LoopFakeProvider("empty-end", "recovered answer");
      const { result } = await runLoopOnce(provider);
      expect(result.text).toBe("recovered answer");
      expect(provider.streamCalls).toBe(1);
      expect(provider.completeCalls).toBe(1);
    });
  });

  test("(b) stream fails after a delta → restart + single-shot, never a re-stream", async () => {
    await withEnv({ BOBI_STREAMING: undefined, BOBI_STREAM_FALLBACK: undefined }, async () => {
      const provider = new LoopFakeProvider("throw-after-delta", "full answer");
      const { result, events } = await runLoopOnce(provider);
      expect(result.text).toBe("full answer");
      expect(provider.streamCalls).toBe(1); // committed semantics unchanged
      expect(provider.completeCalls).toBe(1);
      expect(events).toEqual([
        { type: "token", delta: "partial " },
        { type: "restart" },
      ]);
    });
  });

  test("BOBI_STREAM_FALLBACK=0 disables the fallback (empty end surfaces)", async () => {
    await withEnv({ BOBI_STREAMING: undefined, BOBI_STREAM_FALLBACK: "0" }, async () => {
      const provider = new LoopFakeProvider("empty-end", "recovered answer");
      const { result } = await runLoopOnce(provider);
      expect(provider.completeCalls).toBe(0);
      // The loop's own last-resort guard answers with the fixed sentence.
      expect(result.text).toBe(t("error.empty_response"));
    });
  });
});

// ------------------------------------------------------- adapter empties

describe("adapters — empty response is a failure, not a silent success", () => {
  test("(c) OpenAI-compatible: empty content, no tool calls → empty AiError", () => {
    let caught: unknown;
    try {
      parseOpenAiResponse(
        { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] },
        "m",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiError);
    const e = caught as AiError;
    expect(e.kind).toBe("invalid_response");
    expect(isEmptyResponseError(e)).toBe(true);
    expect(e.message).toContain("Provider returned an empty response");
    expect(e.message).toContain("finish_reason=stop");
  });

  test("(c) reasoning-only payload is still empty, and the reasoning never leaks", () => {
    let caught: unknown;
    try {
      parseOpenAiResponse(
        {
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "secret chain of thought",
              },
              finish_reason: "stop",
            },
          ],
        },
        "m",
      );
    } catch (err) {
      caught = err;
    }
    expect(isEmptyResponseError(caught)).toBe(true);
    const e = caught as AiError;
    expect(e.message).toContain("reasoning only");
    expect(e.message).not.toContain("secret chain of thought");
  });

  test("(d) empty text WITH tool calls stays legal", () => {
    const res = parseOpenAiResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "1", type: "function", function: { name: "f", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "m",
    );
    expect(res.text).toBe("");
    expect(res.toolCalls).toHaveLength(1);
  });

  test("(c) Anthropic: thinking-only payload is empty; tool_use stays legal", () => {
    let caught: unknown;
    try {
      parseAnthropicResponse(
        { content: [{ type: "thinking", thinking: "hidden" }], model: "x" },
        "x",
      );
    } catch (err) {
      caught = err;
    }
    expect(isEmptyResponseError(caught)).toBe(true);
    expect((caught as AiError).message).toContain("reasoning only");
    expect((caught as AiError).message).not.toContain("hidden");

    const ok = parseAnthropicResponse(
      {
        content: [
          { type: "tool_use", id: "t1", name: "f", input: {} },
        ],
        model: "x",
      },
      "x",
    );
    expect(ok.toolCalls).toHaveLength(1);
  });

  test("(c) the real adapter raises empty on an empty SSE stream (loopback)", async () => {
    const sse =
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    });
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: ["k"].join(""),
        allowLocalTargets: true,
      });
      let caught: unknown;
      try {
        for await (const ev of adapter.completeStream({
          messages: [{ role: "user", content: "hi" }],
          model: "m",
          timeoutMs: 5_000,
          signal: new AbortController().signal,
        })) {
          void ev;
        }
      } catch (err) {
        caught = err;
      }
      expect(isEmptyResponseError(caught)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

// ------------------------------------------------------- gateway harness

type Outcome =
  | { kind: "text"; text: string }
  | { kind: "error"; error: AiError };

type StreamOutcome =
  | { kind: "text"; text: string }
  | { kind: "throwAfterText"; text: string; error: AiError }
  | { kind: "usageThenThrow"; error: AiError };

interface GwHarness {
  storage: Storage;
  gateway: AiGateway;
  health: ProviderHealthService;
  calls: string[];
  seed: (tag: string) => { providerId: number; modelRowId: number };
  activate: (ids: { providerId: number; modelRowId: number }) => void;
  enableFailover: (candidate: { providerId: number; modelRowId: number }) => void;
}

function gwHarness(
  behaviors: Map<string, (n: number) => Outcome>,
  streamBehaviors: Map<string, (n: number) => StreamOutcome>,
  gatewayOpts: Record<string, unknown> = {},
): GwHarness {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("chat-reliability-test-key");
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const streamCounts = new Map<string, number>();
  const next = (map: Map<string, number>, model: string) => {
    const n = (map.get(model) ?? 0) + 1;
    map.set(model, n);
    return n;
  };
  const adapters = {
    create: (_type: string, cfg: { model: string }) => ({
      name: "scripted",
      complete: async (req: CompletionRequest): Promise<CompletionResponse> => {
        calls.push(cfg.model);
        const o = behaviors.get(cfg.model)!(next(counts, cfg.model));
        if (o.kind === "error") throw o.error;
        return { text: o.text, model: req.model };
      },
      completeStream: (req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> => {
        calls.push(`stream:${cfg.model}`);
        const o = streamBehaviors.get(cfg.model)!(next(streamCounts, cfg.model));
        return (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          if (o.kind === "text") {
            if (o.text) yield { type: "text", delta: o.text };
            yield { type: "end", text: o.text, model: req.model, toolCalls: [] };
            return;
          }
          if (o.kind === "throwAfterText") {
            yield { type: "text", delta: o.text };
            throw o.error;
          }
          yield { type: "usage", usage: { inputTokens: 3, outputTokens: 0 } };
          throw o.error;
        })();
      },
    }),
  } as unknown as AdapterRegistry;
  const gateway = new AiGateway({
    storage,
    adapters,
    secrets,
    sleep: async () => {},
    random: () => 0,
    ...gatewayOpts,
  } as never);
  const providers = new ProviderService(storage, secrets, new AdapterRegistry());
  const models = new ModelService(storage);
  const health = new ProviderHealthService(storage, providers, secrets, adapters, 1_000);
  const seed = (tag: string) => {
    const p = providers.create({
      label: tag,
      adapter: "openai_compatible",
      baseUrl: `https://${tag}.invalid/v1`,
      apiKey: "k",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = models.add({ providerId: p.data, modelId: `model-${tag}`, label: tag });
    if (!m.ok) throw new Error("model failed");
    models.setDefault(m.data);
    return { providerId: p.data, modelRowId: m.data };
  };
  return {
    storage,
    gateway,
    health,
    calls,
    seed,
    activate: (ids) =>
      storage.setRuntimeSelection({ providerId: ids.providerId, modelId: ids.modelRowId }),
    enableFailover: (candidate) => {
      storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
      storage.setFailoverCandidates([
        { providerId: candidate.providerId, modelId: candidate.modelRowId },
      ]);
    },
  };
}

const GW_REQUEST = {
  messages: [{ role: "user" as const, content: "سلام" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

async function drain(stream: AsyncGenerator<StreamEvent, void, undefined>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("gateway — empty failover + attempt transparency", () => {
  test("(e) candidate A empties → candidate B answers", async () => {
    const h = gwHarness(
      new Map<string, (n: number) => Outcome>([
        ["model-a", () => ({ kind: "error", error: emptyResponseError() })],
        ["model-b", () => ({ kind: "text", text: "from B" })],
      ]),
      new Map(),
    );
    const a = h.seed("a");
    const b = h.seed("b");
    h.activate(a);
    h.enableFailover(b);
    const res = await h.gateway.complete(GW_REQUEST);
    expect(res.text).toBe("from B");
    expect(h.calls).toEqual(["model-a", "model-b"]);
    h.storage.close();
  });

  test("(e) streamed: usage-then-empty on A still fails over to B", async () => {
    const h = gwHarness(
      new Map(),
      new Map<string, (n: number) => StreamOutcome>([
        ["model-a", () => ({ kind: "usageThenThrow", error: emptyResponseError("stream") })],
        ["model-b", () => ({ kind: "text", text: "B streamed" })],
      ]),
    );
    const a = h.seed("a");
    const b = h.seed("b");
    h.activate(a);
    h.enableFailover(b);
    const events = await drain(h.gateway.completeStream(GW_REQUEST));
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => (e.type === "text" ? e.delta : ""))
      .join("");
    expect(text).toBe("B streamed");
    expect(h.calls).toEqual(["stream:model-a", "stream:model-b"]);
    h.storage.close();
  });

  test("(b) streamed: failure AFTER a text delta is committed — B is never tried", async () => {
    const h = gwHarness(
      new Map(),
      new Map<string, (n: number) => StreamOutcome>([
        [
          "model-a",
          () => ({
            kind: "throwAfterText",
            text: "partial",
            error: new AiError("network", "dropped"),
          }),
        ],
        ["model-b", () => ({ kind: "text", text: "B streamed" })],
      ]),
    );
    const a = h.seed("a");
    const b = h.seed("b");
    h.activate(a);
    h.enableFailover(b);
    let caught: unknown;
    try {
      await drain(h.gateway.completeStream(GW_REQUEST));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiError);
    expect((caught as AiError).message).toBe("dropped");
    expect(h.calls).toEqual(["stream:model-a"]);
    h.storage.close();
  });

  test("(e) all candidates fail → the error names how many were tried", async () => {
    const h = gwHarness(
      new Map<string, (n: number) => Outcome>([
        ["model-a", () => ({ kind: "error", error: emptyResponseError() })],
        ["model-b", () => ({ kind: "error", error: new AiError("network", "down") })],
      ]),
      new Map(),
    );
    const a = h.seed("a");
    const b = h.seed("b");
    h.activate(a);
    h.enableFailover(b);
    let caught: unknown;
    try {
      await h.gateway.complete(GW_REQUEST);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiError);
    const e = caught as AiError;
    expect(e.message).toContain("(tried 2 providers)");
    expect(e.attempts).toBe(2);
    h.storage.close();
  });
});

// ------------------------------------------------------- quarantine

describe("per-model quarantine", () => {
  test("registry: threshold, reset on success, duration 0 disables", () => {
    let clock = 1_000;
    const reg = new ModelQuarantineRegistry({ now: () => clock, durationMs: 60_000 });
    reg.recordFailure(1, "m");
    reg.recordFailure(1, "m");
    expect(reg.isQuarantined(1, "m")).toBe(false);
    reg.recordFailure(1, "m");
    expect(reg.isQuarantined(1, "m")).toBe(true);
    expect(reg.state(1, "m").consecutiveFailures).toBe(3);
    clock += 61_000;
    expect(reg.isQuarantined(1, "m")).toBe(false);
    reg.recordSuccess(1, "m");
    expect(reg.state(1, "m").consecutiveFailures).toBe(0);

    const off = new ModelQuarantineRegistry({ durationMs: 0 });
    for (let i = 0; i < 5; i++) off.recordFailure(1, "m");
    expect(off.isQuarantined(1, "m")).toBe(false);
  });

  test("(f) gateway skips a 3×-failing model, recovers after cooldown, never skips a lone candidate", async () => {
    // Breakers OFF so the only skip mechanism under test is quarantine.
    // Smart routing OFF for the same reason: since H4 the ROUTER also
    // honors quarantine when picking the primary, which would mask the
    // gateway-level eligibleCandidates behavior isolated here (the
    // router's gate has its own suite: smart_router_health.test.ts).
    await withEnv({ BOBI_CIRCUIT_BREAKER: "0", BOBI_SMART_ROUTING: "0" }, async () => {
      let clock = 10_000;
      const registry = new ModelQuarantineRegistry({
        now: () => clock,
        durationMs: 60_000,
      });
      const h = gwHarness(
        new Map<string, (n: number) => Outcome>([
          ["model-a", () => ({ kind: "error", error: new AiError("network", "a down") })],
          ["model-b", () => ({ kind: "text", text: "from B" })],
          ["model-c", () => ({ kind: "error", error: new AiError("network", "c down") })],
        ]),
        new Map(),
        { quarantine: registry },
      );
      const a = h.seed("a");
      const b = h.seed("b");
      h.activate(a);
      h.enableFailover(b);

      // Three turns: A fails each time, B answers each time.
      for (let i = 0; i < 3; i++) {
        const res = await h.gateway.complete(GW_REQUEST);
        expect(res.text).toBe("from B");
      }
      expect(registry.isQuarantined(a.providerId, "model-a")).toBe(true);

      // Fourth turn: A is skipped entirely — only B is called.
      h.calls.length = 0;
      const res4 = await h.gateway.complete(GW_REQUEST);
      expect(res4.text).toBe("from B");
      expect(h.calls).toEqual(["model-b"]);

      // After the cooldown the model is tried again (and fails → B).
      clock += 61_000;
      h.calls.length = 0;
      const res5 = await h.gateway.complete(GW_REQUEST);
      expect(res5.text).toBe("from B");
      expect(h.calls).toEqual(["model-a", "model-b"]);

      // A lone candidate is NEVER skipped, however often it failed.
      const c = h.seed("c");
      h.activate(c);
      h.storage.setFailoverSettings({ enabled: false, maxAttempts: 1 });
      h.storage.setFailoverCandidates([]);
      for (let i = 0; i < 3; i++) {
        await expect(h.gateway.complete(GW_REQUEST)).rejects.toBeInstanceOf(AiError);
      }
      expect(registry.isQuarantined(c.providerId, "model-c")).toBe(true);
      const before = h.calls.filter((x) => x === "model-c").length;
      await expect(h.gateway.complete(GW_REQUEST)).rejects.toBeInstanceOf(AiError);
      // Still attempted (the in-call retry multiplies the sends — what
      // matters is that the count GREW: quarantine never skipped it).
      expect(h.calls.filter((x) => x === "model-c").length).toBeGreaterThan(before);
      h.storage.close();
    });
  });
});

// ------------------------------------------------------- realistic probe

interface CapturedReq {
  req?: CompletionRequest;
}

function probeHarness(adapterImpl: unknown, captured: CapturedReq) {
  void captured;
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("chat-reliability-test-key");
  const adapters = { create: () => adapterImpl } as unknown as AdapterRegistry;
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const health = new ProviderHealthService(storage, providers, secrets, adapters, 1_000);
  const p = providers.create({
    label: "p",
    adapter: "openai_compatible",
    baseUrl: "https://p.invalid/v1",
    apiKey: "k",
  });
  if (!p.ok) throw new Error("provider failed");
  return { storage, health, providerId: p.data, models };
}

describe("probeModel — the honest two-stage test", () => {
  test("(g) realistic stage sends tools + streaming and reports the answer", async () => {
    const captured: CapturedReq = {};
    const adapter = {
      name: "fake",
      complete: async (req: CompletionRequest): Promise<CompletionResponse> => ({
        text: "pong",
        model: req.model,
      }),
      completeStream: (req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> => {
        captured.req = req;
        return (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "text", delta: "ساعت الان ۱۲ ظهره." };
          yield { type: "end", text: "ساعت الان ۱۲ ظهره.", model: req.model, toolCalls: [] };
        })();
      },
    };
    const h = probeHarness(adapter, captured);
    const m = h.models.add({ providerId: h.providerId, modelId: "good-model", label: "g" });
    if (!m.ok) throw new Error("model failed");

    const result = await h.health.probeModel(h.providerId, "good-model");
    expect(result.ok).toBe(true);
    expect(result.ping?.ok).toBe(true);
    expect(result.real?.ok).toBe(true);
    expect(result.real?.textPreview).toContain("ساعت");
    // The realistic request really is a real turn's shape:
    expect(captured.req?.maxTokens).toBe(300);
    expect(captured.req?.messages[0]?.role).toBe("system");
    expect((captured.req?.tools ?? []).length).toBeGreaterThan(0);
    h.storage.close();
  });

  test("(g) an empty stream passes the ping but fails the realistic stage", async () => {
    const adapter = {
      name: "fake",
      complete: async (req: CompletionRequest): Promise<CompletionResponse> => ({
        text: "pong",
        model: req.model,
      }),
      completeStream: (req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> =>
        (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "end", text: "", model: req.model, toolCalls: [] };
        })(),
    };
    const h = probeHarness(adapter, {});
    const m = h.models.add({ providerId: h.providerId, modelId: "empty-model", label: "e" });
    if (!m.ok) throw new Error("model failed");

    const result = await h.health.probeModel(h.providerId, "empty-model");
    expect(result.ok).toBe(false);
    expect(result.ping?.ok).toBe(true);
    expect(result.real?.ok).toBe(false);
    expect(result.real?.detail).toBe("empty response");
    expect(result.message).toContain("empty response");
    h.storage.close();
  });

  test("(g) a failed ping skips the realistic stage entirely", async () => {
    let streams = 0;
    const adapter = {
      name: "fake",
      complete: async (): Promise<CompletionResponse> => {
        throw new AiError("quota", "rate limited");
      },
      completeStream: (): AsyncGenerator<StreamEvent, void, undefined> => {
        streams++;
        return (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
          yield { type: "end", text: "x", model: "m", toolCalls: [] };
        })();
      },
    };
    const h = probeHarness(adapter, {});
    const m = h.models.add({ providerId: h.providerId, modelId: "quota-model", label: "q" });
    if (!m.ok) throw new Error("model failed");

    const result = await h.health.probeModel(h.providerId, "quota-model");
    expect(result.ok).toBe(false);
    expect(result.ping?.ok).toBe(false);
    expect(result.real).toBeUndefined();
    expect(streams).toBe(0);
    h.storage.close();
  });

  test("quarantined models are flagged on the probe result", async () => {
    const adapter = {
      name: "fake",
      complete: async (req: CompletionRequest): Promise<CompletionResponse> => ({
        text: "pong",
        model: req.model,
      }),
    };
    const h = probeHarness(adapter, {});
    const m = h.models.add({ providerId: h.providerId, modelId: "quar-model", label: "qm" });
    if (!m.ok) throw new Error("model failed");
    // Drive the SHARED registry (the one health reads) to quarantine.
    for (let i = 0; i < 3; i++) {
      sharedModelQuarantine.recordFailure(h.providerId, "quar-model");
    }
    const result = await h.health.probeModel(h.providerId, "quar-model");
    expect(result.quarantined).toBe(true);
    sharedModelQuarantine.recordSuccess(h.providerId, "quar-model");
    h.storage.close();
  });
});

// ------------------------------------------------- shared quarantine wiring

describe("shared quarantine wiring (index.ts pattern)", () => {
  test("(h) gateway failures on the SHARED registry surface on the probe flag", async () => {
    // Breakers OFF so quarantine is the only state under test.
    await withEnv({ BOBI_CIRCUIT_BREAKER: "0" }, async () => {
      const h = gwHarness(
        new Map<string, (n: number) => Outcome>([
          ["model-a", () => ({ kind: "error", error: new AiError("network", "a down") })],
          ["model-b", () => ({ kind: "text", text: "from B" })],
        ]),
        new Map(),
        // Exactly what index.ts passes: the process-wide shared registry,
        // so gateway writes and health reads share ONE instance.
        { quarantine: sharedModelQuarantine },
      );
      const a = h.seed("a");
      const b = h.seed("b");
      h.activate(a);
      h.enableFailover(b);
      try {
        // Three turns: A fails each time (recorded into the shared
        // registry by the gateway), B answers each time.
        for (let i = 0; i < 3; i++) {
          const res = await h.gateway.complete(GW_REQUEST);
          expect(res.text).toBe("from B");
        }
        expect(sharedModelQuarantine.isQuarantined(a.providerId, "model-a")).toBe(true);

        // The health service reads that same registry: the probe result
        // for the model carries the sparse quarantined flag.
        const result = await h.health.probeModel(a.providerId, "model-a");
        expect(result.quarantined).toBe(true);
      } finally {
        // The shared registry is process-wide: reset this key so later
        // suites never observe this test's state.
        sharedModelQuarantine.recordSuccess(a.providerId, "model-a");
        h.storage.close();
      }
    });
  });
});
