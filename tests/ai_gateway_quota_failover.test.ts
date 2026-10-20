/**
 * Audit C2: quota failures must ADVANCE the failover chain, never loop on
 * the same provider.
 *
 * Before the fix the semantics were inverted between the two retry layers:
 * isRetryable() returned false for quota (the chain never advanced to a
 * different provider that could fix an account-level exhaustion), while
 * in-call retry eligibility INCLUDED quota (the same exhausted provider
 * was retried in place, honoring Retry-After as a stall). Now:
 *   - quota is chain-advancing in isRetryable();
 *   - in-call retry eligibility is network/timeout ONLY
 *     (isInCallRetryEligible), decoupled from the breaker set
 *     (tripsBreaker = isTransientFailure, unchanged — quota still trips
 *     the breaker);
 *   - key rotation in send() is untouched: quota throws out of send()
 *     immediately, no key is rotated for an account-level failure.
 *
 * Harness follows tests/ai_gateway_reliability.test.ts: scripted fake
 * adapters keyed by model, in-memory storage, injected sleep that only
 * records. No network, no real timers.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import { AiError, type StreamEvent } from "../src/ai/provider";

const KEY = "gateway-quota-master-key";
type Outcome = AiError | "ok";

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

const quota402 = () => new AiError("quota", "balance exhausted", 402);
const quota429 = (retryAfterMs?: number) =>
  new AiError("quota", "rate limited", 429, retryAfterMs);
const net = () => new AiError("network", "down");

function build(opts: {
  script: Map<string, Outcome[]>;
  streamScript?: Map<string, Outcome[]>;
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
          if (outcome !== "ok") throw outcome;
          return { text: "answer", model: req.model };
        },
        completeStream: async function* (req: { model: string }) {
          streamLog.push(cfg.model);
          const outcome = pick(
            opts.streamScript ?? opts.script,
            streamCounts,
            cfg.model,
          );
          // Scripted failures throw BEFORE the first event.
          if (outcome !== "ok") throw outcome;
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
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // jitter factor exactly 1.0 → delays 400, 800
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

describe("quota advances the failover chain (C2)", () => {
  test("a quota-dead primary fails over to a healthy secondary, sent once", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [quota402()]],
          ["model-b", ["ok"]],
        ]),
      });
      twoProviders(h);
      const res = await h.gateway.complete(REQUEST);
      expect(res.model).toBe("model-b");
      expect(res.text).toBe("answer");
      // The primary was sent EXACTLY once: no same-provider quota retry.
      expect(callsFor(h.log, "model-a")).toBe(1);
      expect(callsFor(h.log, "model-b")).toBe(1);
      expect(h.sleeps).toEqual([]);
      h.storage.close();
    });
  });

  test("quota on every candidate: the final error truthfully reports 2 attempts", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [quota402()]],
          ["model-b", [quota402()]],
        ]),
      });
      twoProviders(h);
      const err = await errorOf(h.gateway.complete(REQUEST));
      expect(err.kind).toBe("quota");
      expect(err.attempts).toBe(2);
      expect(err.message).toContain("(tried 2 providers)");
      expect(callsFor(h.log, "model-a")).toBe(1);
      expect(callsFor(h.log, "model-b")).toBe(1);
      h.storage.close();
    });
  });

  test("single provider, no failover: a 402 fails after ONE send and no sleeps", async () => {
    await withRoutingOff(async () => {
      // A 402 is balance exhaustion: retrying the same account in place
      // can never refill it, so there is no in-call retry — and the
      // Retry-After riding along (only ever consumed by the in-call
      // retry delay) must not stall anything. A 429 is the opposite
      // case — rate limiting with a named wait — and keeps the bounded
      // in-call retry (tests/ai_connection_layer.test.ts pins the floor).
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", [new AiError("quota", "balance exhausted", 402, 5000)]],
        ]),
      });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);
      const err = await errorOf(h.gateway.complete(REQUEST));
      expect(err.kind).toBe("quota");
      expect(callsFor(h.log, "model-a")).toBe(1);
      expect(h.sleeps).toEqual([]);
      h.storage.close();
    });
  });

  test("single provider: a network error still retries in-call as before", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([["model-a", [net()]]]),
      });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);
      const err = await errorOf(h.gateway.complete(REQUEST));
      expect(err.kind).toBe("network");
      // 1 + GATEWAY_MAX_RETRIES (2) in-call attempts, with backoff sleeps —
      // the decoupling must not weaken the transient-pipe retry.
      expect(callsFor(h.log, "model-a")).toBe(3);
      expect(h.sleeps).toEqual([400, 800]);
      h.storage.close();
    });
  });

  test("streaming: a pre-first-event quota failure advances the chain", async () => {
    await withRoutingOff(async () => {
      const h = build({
        script: new Map<string, Outcome[]>([
          ["model-a", ["ok"]],
          ["model-b", ["ok"]],
        ]),
        streamScript: new Map<string, Outcome[]>([
          ["model-a", [quota429()]],
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
      expect(h.sleeps).toEqual([]);
      h.storage.close();
    });
  });
});
