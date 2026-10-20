/**
 * Provider gauntlet — gateway correctness (Wave 3, audit v2).
 *
 * Hermetic throughout: scripted fake adapters keyed by model, in-memory
 * storage, injected recording sleeps, one loopback double for the real
 * OpenAI-compatible adapter. No network, no multi-second real sleeps.
 *
 * Coverage:
 *  - M1: a 404 invalid_response (retired/renamed model id) advances the
 *    failover chain within the same turn; 400/422 stay non-advancing;
 *    "(tried N providers)" accounting stays truthful; quarantine keeps
 *    counting 404s.
 *  - M9: providerMessage cap is 600, truncated at a word boundary, and
 *    never cut inside a URL token.
 *  - R5: a Retry-After backoff sleep aborts promptly when the caller
 *    aborts — it must not park the gateway past the loop's deadline.
 *  - G1: loop → REAL AiGateway → fake adapter, tool-calls-only answers,
 *    via (a) the non-streaming path and (b) stream-fails-then-fallback.
 *    (tests/ai_gateway_toolcalls.test.ts pins the gateway seam alone;
 *    this goes one level up and asserts the tool actually EXECUTES.)
 *  - G3 gateway-side error zoo: OpenRouter-style 402 body (failover +
 *    provider words on the final error), 429 with an HTTP-date
 *    Retry-After honored end-to-end, and HTTP 200 with an `error`
 *    object and no `choices` (current intended behavior, pinned).
 */
import { describe, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import { AiError, isEmptyResponseError } from "../src/ai/provider";
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from "../src/ai/provider";
import {
  extractProviderMessage,
  statusToAiError,
  PROVIDER_MESSAGE_LIMIT,
} from "../src/ai/http_status";
import { ModelQuarantineRegistry } from "../src/ai/model_quarantine";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import { AgentLoop } from "../src/agent/loop";
import { ToolService } from "../src/tools/service";
import { runWithStreamSink } from "../src/agent/stream";
import type { ToolActor } from "../src/tools/types";

const KEY = "gauntlet-gateway-master-key";

/** An outcome is an error to throw, "ok", a full response, or a factory. */
type Outcome = AiError | "ok" | CompletionResponse | (() => AiError);

async function withRoutingOff<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env["BOBI_SMART_ROUTING"];
  process.env["BOBI_SMART_ROUTING"] = "0";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["BOBI_SMART_ROUTING"];
    else process.env["BOBI_SMART_ROUTING"] = prev;
  }
}

const invalid = (status: number) =>
  new AiError(
    "invalid_response",
    `The request to the service was invalid (HTTP ${status}).`,
    status,
  );

function build(opts: {
  script: Map<string, Outcome[]>;
  streamScript?: Map<string, Outcome[]>;
  sleep?: (ms: number) => Promise<void>;
  quarantine?: ModelQuarantineRegistry;
}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: string[] = [];
  const streamLog: string[] = [];
  const sleeps: number[] = [];

  const pick = (
    script: Map<string, Outcome[]>,
    counts: Map<string, number>,
    model: string,
  ): Outcome => {
    const n = counts.get(model) ?? 0;
    counts.set(model, n + 1);
    const outcomes = script.get(model) ?? ["ok" as Outcome];
    return outcomes[Math.min(n, outcomes.length - 1)]!;
  };
  const counts = new Map<string, number>();
  const streamCounts = new Map<string, number>();

  const fakeAdapters = {
    create: (type: string, cfg: { model: string }) => {
      void type;
      return {
        name: "scripted",
        complete: async (req: { model: string }) => {
          log.push(cfg.model);
          const outcome = pick(opts.script, counts, cfg.model);
          if (typeof outcome === "function") throw outcome();
          if (outcome instanceof AiError) throw outcome;
          if (outcome === "ok") return { text: "answer", model: req.model };
          return outcome;
        },
        completeStream: async function* (req: { model: string }) {
          streamLog.push(cfg.model);
          const outcome = pick(
            opts.streamScript ?? opts.script,
            streamCounts,
            cfg.model,
          );
          if (typeof outcome === "function") throw outcome();
          if (outcome instanceof AiError) throw outcome;
          yield { type: "text", delta: "answer" } as StreamEvent;
          yield {
            type: "end",
            text: "answer",
            model: req.model,
            toolCalls: [],
          } as StreamEvent;
        },
      } as unknown as ReturnType<AdapterRegistry["create"]>;
    },
  } as unknown as AdapterRegistry;

  const gateway = new AiGateway({
    storage,
    adapters: fakeAdapters,
    secrets,
    sleep:
      opts.sleep ??
      (async (ms: number) => {
        sleeps.push(ms);
      }),
    random: () => 0.5, // jitter factor exactly 1.0 → backoff 400, 800
    ...(opts.quarantine !== undefined ? { quarantine: opts.quarantine } : {}),
  });
  return { storage, providers, models, gateway, log, streamLog, sleeps };
}

function seedProvider(
  h: ReturnType<typeof build>,
  tag: string,
): { providerId: number; modelId: number } {
  const p = h.providers.create({
    label: tag,
    adapter: "openai_compatible",
    baseUrl: `https://${tag}.invalid/v1`,
    apiKey: `sk-${tag}`,
  });
  if (!p.ok) throw new Error("provider failed");
  const m = h.models.add({ providerId: p.data, modelId: `model-${tag}`, label: tag });
  if (!m.ok) throw new Error("model failed");
  h.models.setDefault(m.data);
  return { providerId: p.data, modelId: m.data };
}

function twoProviders(h: ReturnType<typeof build>, maxAttempts = 3): void {
  const a = seedProvider(h, "a");
  const b = seedProvider(h, "b");
  h.storage.setRuntimeSelection(a);
  h.storage.setFailoverSettings({ enabled: true, maxAttempts });
  h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);
}

const REQUEST = {
  messages: [{ role: "user" as const, content: "سلام" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

async function errorOf(p: Promise<unknown>): Promise<AiError> {
  try {
    await p;
  } catch (e) {
    return e as AiError;
  }
  throw new Error("expected the promise to reject");
}

const callsFor = (log: string[], model: string) =>
  log.filter((m) => m === model).length;

// ------------------------------------------------------------------ M1 ----

describe("M1 — a 404 advances the failover chain, a 400/422 does not", () => {
  test("primary 404 (retired model) → the secondary serves the SAME turn", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [invalid(404)]],
          ["model-b", ["ok"]],
        ]),
      });
      twoProviders(h);
      const res = await h.gateway.complete(REQUEST);
      expect(res.model).toBe("model-b");
      expect(res.text).toBe("answer");
      expect(callsFor(h.log, "model-a")).toBe(1);
      expect(callsFor(h.log, "model-b")).toBe(1);
      expect(h.sleeps).toEqual([]);
      h.storage.close();
    });
  });

  test("primary 400 → no advance: the turn fails with the primary's error", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [invalid(400)]],
          ["model-b", ["ok"]],
        ]),
      });
      twoProviders(h);
      const err = await errorOf(h.gateway.complete(REQUEST));
      expect(err.kind).toBe("invalid_response");
      expect(err.status).toBe(400);
      // One real attempt only: no "(tried N)" annotation, no annotation
      // field, and the secondary was never sent anything.
      expect(err.attempts).toBeUndefined();
      expect(err.message).not.toContain("tried");
      expect(callsFor(h.log, "model-a")).toBe(1);
      expect(callsFor(h.log, "model-b")).toBe(0);
      h.storage.close();
    });
  });

  test("primary 422 → no advance either", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [invalid(422)]],
          ["model-b", ["ok"]],
        ]),
      });
      twoProviders(h);
      const err = await errorOf(h.gateway.complete(REQUEST));
      expect(err.status).toBe(422);
      expect(callsFor(h.log, "model-b")).toBe(0);
      h.storage.close();
    });
  });

  test("404 on every candidate: the final error truthfully reports 2 attempts", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [invalid(404)]],
          ["model-b", [invalid(404)]],
        ]),
      });
      twoProviders(h);
      const err = await errorOf(h.gateway.complete(REQUEST));
      expect(err.kind).toBe("invalid_response");
      expect(err.status).toBe(404);
      expect(err.attempts).toBe(2);
      expect(err.message).toContain("(tried 2 providers)");
      h.storage.close();
    });
  });

  test("streaming: a pre-first-event 404 advances to the secondary's stream", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", ["ok"]],
          ["model-b", ["ok"]],
        ]),
        streamScript: new Map<string, Outcome[]>([
          ["model-a", [invalid(404)]],
          ["model-b", ["ok"]],
        ]),
      });
      twoProviders(h);
      const events: StreamEvent[] = [];
      for await (const ev of h.gateway.completeStream(REQUEST)) events.push(ev);
      const end = events.find((e) => e.type === "end");
      expect(end?.type).toBe("end");
      if (end?.type === "end") expect(end.model).toBe("model-b");
      expect(callsFor(h.streamLog, "model-a")).toBe(1);
      expect(callsFor(h.streamLog, "model-b")).toBe(1);
      h.storage.close();
    });
  });

  test("quarantine counting is unchanged: 3 consecutive 404 turns quarantine the model", async () => {
    await withRoutingOff(async () => {
      const quarantine = new ModelQuarantineRegistry();
      const h = build({
        script: new Map<string, Outcome[]>([["model-a", [invalid(404)]]]),
        quarantine,
      });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);
      for (let i = 0; i < 3; i++) {
        const err = await errorOf(h.gateway.complete(REQUEST));
        expect(err.status).toBe(404);
      }
      expect(quarantine.isQuarantined(a.providerId, "model-a")).toBe(true);
      expect(quarantine.state(a.providerId, "model-a").consecutiveFailures).toBe(3);
      h.storage.close();
    });
  });
});

// ------------------------------------------------------------------ M9 ----

describe("M9 — providerMessage truncation: 600 cap, word boundary, URL-safe", () => {
  test("the cap is 600 and a 500-char message survives whole", () => {
    expect(PROVIDER_MESSAGE_LIMIT).toBe(600);
    const msg = "provider explains the failure in detail ".repeat(12).trim(); // 503 chars
    const out = extractProviderMessage(JSON.stringify({ error: { message: msg } }));
    expect(out).toBe(msg);
  });

  test("truncation lands on a word boundary, never mid-word", () => {
    const msg = "word ".repeat(300).trim(); // 1499 chars of 4-letter words
    const out = extractProviderMessage(msg)!;
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith("word…")).toBe(true);
  });

  test("a cut inside a URL token extends to the token's end within the slack", () => {
    const url = "https://example.com/credits"; // 27 chars
    const msg = `${"x ".repeat(290)}${url} please add funds and retry the request soon`;
    // URL spans 580..607: the 599 cut lands inside it; its end is within
    // the 40-char slack, so the message keeps the whole URL.
    const out = extractProviderMessage(msg)!;
    expect(out).toContain(url);
    expect(out.length).toBeLessThanOrEqual(600 + 40 + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  test("a cut inside a LONG URL backs off to before the token", () => {
    const url = `https://example.com/${"p".repeat(200)}`;
    const msg = `${"x ".repeat(290)}${url} tail words follow here`;
    const out = extractProviderMessage(msg)!;
    expect(out).not.toContain("https://");
    expect(out).not.toContain("example.com");
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ------------------------------------------------------------------ R5 ----

describe("R5 — the Retry-After backoff sleep respects the caller's abort", () => {
  const neverSleep = () => new Promise<void>(() => {});

  test("complete(): aborting during a 30s Retry-After wait returns promptly, no retry is sent", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [new AiError("quota", "rate limited", 429, 30_000), "ok"]],
        ]),
        sleep: neverSleep,
      });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);
      const controller = new AbortController();
      const started = Date.now();
      const pending = errorOf(
        h.gateway.complete({ ...REQUEST, signal: controller.signal }),
      );
      setTimeout(() => controller.abort(), 10);
      const err = await pending;
      expect(err.kind).toBe("aborted");
      expect(Date.now() - started).toBeLessThan(2000);
      // The retry was never sent: exactly one real attempt happened.
      expect(callsFor(h.log, "model-a")).toBe(1);
      h.storage.close();
    });
  });

  test("completeStream(): aborting during the backoff wait returns promptly", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([["model-a", ["ok"]]]),
        streamScript: new Map<string, Outcome[]>([
          ["model-a", [new AiError("quota", "rate limited", 429, 30_000), "ok"]],
        ]),
        sleep: neverSleep,
      });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);
      const controller = new AbortController();
      const started = Date.now();
      const pending = (async () => {
        for await (const _ev of h.gateway.completeStream({
          ...REQUEST,
          signal: controller.signal,
        })) {
          // No events are expected: the stream fails before the first one.
        }
      })().catch((e: unknown) => e);
      setTimeout(() => controller.abort(), 10);
      const err = (await pending) as AiError;
      expect(err).toBeInstanceOf(AiError);
      expect(err.kind).toBe("aborted");
      expect(Date.now() - started).toBeLessThan(2000);
      expect(callsFor(h.streamLog, "model-a")).toBe(1);
      h.storage.close();
    });
  });
});

// ------------------------------------------------------------------ G1 ----

const ACTOR: ToolActor = { userId: "u-gauntlet", permissions: ["tools:calculator"] };

/**
 * A gateway over one fake adapter whose single-shot complete() answers
 * tool-calls-only first, then a text answer once it sees the tool
 * result; its stream always fails before the first event.
 */
function buildToolGateway() {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const state = { completeCalls: 0, streamCalls: 0, sawToolResult: false };

  const fakeAdapters = {
    create: (type: string, cfg: { model: string }) => {
      void type;
      void cfg;
      return {
        name: "tool-fake",
        complete: async (req: CompletionRequest) => {
          state.completeCalls++;
          if (req.messages.some((m) => m.role === "tool")) {
            state.sawToolResult = true;
            return { text: "حاصل ۴۲ است.", model: req.model };
          }
          return {
            text: "",
            model: req.model,
            toolCalls: [
              { id: "call-1", name: "calculator", arguments: { op: "add", a: 20, b: 22 } },
            ],
          };
        },
        completeStream: async function* (_req: CompletionRequest) {
          state.streamCalls++;
          throw new AiError("network", "stream refused");
          // eslint-disable-next-line no-unreachable
          yield { type: "text", delta: "" } as StreamEvent;
        },
      } as unknown as ReturnType<AdapterRegistry["create"]>;
    },
  } as unknown as AdapterRegistry;

  const gateway = new AiGateway({
    storage,
    adapters: fakeAdapters,
    secrets,
    sleep: async () => {},
    random: () => 0.5,
  });
  const p = providers.create({
    label: "only",
    adapter: "openai_compatible",
    baseUrl: "https://only.invalid/v1",
    apiKey: "sk-only",
  });
  if (!p.ok) throw new Error("provider failed");
  const m = models.add({ providerId: p.data, modelId: "model-only", label: "only" });
  if (!m.ok) throw new Error("model failed");
  models.setDefault(m.data);
  storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });
  return { storage, gateway, state };
}

function makeLoop(gateway: AiGateway) {
  return new AgentLoop({
    provider: gateway,
    model: "model-only",
    tools: new ToolService(),
    callTimeoutMs: 5_000,
  });
}

const LOOP_INPUT = {
  messages: [{ role: "user" as const, content: "۲۰ + ۲۲ چند میشه؟" }],
  systemPrompt: "sys",
  actor: ACTOR,
  signal: new AbortController().signal,
};

describe("G1 — loop → real gateway → fake adapter: tool-only answers execute", () => {
  test("(a) non-streaming: a tool-calls-only reply runs the tool, then answers", async () => {
    await withRoutingOff(async () => {
      const h = buildToolGateway();
      const result = await makeLoop(h.gateway).run(LOOP_INPUT);
      expect(result.text).toBe("حاصل ۴۲ است.");
      expect(result.toolCallsExecuted).toBe(1);
      expect(h.state.completeCalls).toBe(2);
      expect(h.state.streamCalls).toBe(0); // no sink → single-shot only
      expect(h.state.sawToolResult).toBe(true);
      h.storage.close();
    });
  });

  test("(b) stream fails → single-shot fallback still carries the tool calls", async () => {
    await withRoutingOff(async () => {
      const h = buildToolGateway();
      const result = await runWithStreamSink(
        () => {},
        () => makeLoop(h.gateway).run(LOOP_INPUT),
      );
      expect(result.text).toBe("حاصل ۴۲ است.");
      expect(result.toolCallsExecuted).toBe(1);
      expect(h.state.streamCalls).toBeGreaterThan(0);
      // Both loop turns fell back to complete(): the tool turn and the
      // final answer — and the tool calls survived BOTH crossings.
      expect(h.state.completeCalls).toBe(2);
      expect(h.state.sawToolResult).toBe(true);
      h.storage.close();
    });
  });
});

// ------------------------------------------------------------------ G3 ----

const OPENROUTER_402_MESSAGE =
  "Insufficient credits. This account never purchased credits. Make sure your key is on the correct account or org, or add a credit card and purchase credits at https://openrouter.ai/settings/credits and then update the rate limiting for your keys.";
const OPENROUTER_402_BODY = JSON.stringify({
  error: { message: OPENROUTER_402_MESSAGE, code: 402 },
});
const openRouter402 = () =>
  statusToAiError(402, undefined, { body: OPENROUTER_402_BODY });

describe("G3 — gateway error zoo", () => {
  test("(i) OpenRouter-style 402 on the primary fails over to the healthy secondary", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [openRouter402]],
          ["model-b", ["ok"]],
        ]),
      });
      twoProviders(h);
      const res = await h.gateway.complete(REQUEST);
      expect(res.model).toBe("model-b");
      expect(callsFor(h.log, "model-a")).toBe(1);
      expect(h.sleeps).toEqual([]);
      h.storage.close();
    });
  });

  test("(i) when every candidate 402s, the final error quotes the provider's words", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [openRouter402]],
          ["model-b", [openRouter402]],
        ]),
      });
      twoProviders(h);
      const err = await errorOf(h.gateway.complete(REQUEST));
      expect(err.kind).toBe("quota");
      expect(err.attempts).toBe(2);
      expect(err.message).toContain("(tried 2 providers)");
      expect(err.providerMessage).toBe(OPENROUTER_402_MESSAGE);
      h.storage.close();
    });
  });

  test("(ii) a 429 with an HTTP-date Retry-After is honored end-to-end", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          [
            "model-a",
            [
              () =>
                statusToAiError(429, {
                  "retry-after": new Date(Date.now() + 5000).toUTCString(),
                }),
              "ok",
            ],
          ],
        ]),
      });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);
      const res = await h.gateway.complete(REQUEST);
      expect(res.text).toBe("answer");
      expect(callsFor(h.log, "model-a")).toBe(2);
      // Exactly one in-call retry, and its wait is the provider's ~5s
      // floor — NOT the gateway's own 400ms backoff. (HTTP-date has 1s
      // resolution, hence the window.)
      expect(h.sleeps.length).toBe(1);
      expect(h.sleeps[0]!).toBeGreaterThan(2500);
      expect(h.sleeps[0]!).toBeLessThanOrEqual(5200);
      h.storage.close();
    });
  });

  test("(iii) HTTP 200 with an error object and no choices → invalid_response, pinned", async () => {
    const server: Server = createServer((_req, res: ServerResponse) => {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"error":{"message":"model overloaded, try later"}}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const err = await errorOf(
        adapter.complete({
          messages: [{ role: "user", content: "ping" }],
          model: "test-model",
          timeoutMs: 2000,
          signal: new AbortController().signal,
        }),
      );
      // Current intended behavior: a 200 payload with no choices is a
      // response-shape fault — invalid_response "Service response was
      // empty." — and NOT the empty-response marker (no failover
      // semantics attach beyond the kind's own rules).
      expect(err.kind).toBe("invalid_response");
      expect(err.message).toBe("Service response was empty.");
      expect(isEmptyResponseError(err)).toBe(false);
    } finally {
      server.close();
    }
  });
});
