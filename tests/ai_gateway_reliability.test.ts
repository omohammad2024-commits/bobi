/**
 * Reliability core: circuit breaker + in-call retry in the gateway, plus
 * breaker awareness in the smart router and the health probe surface.
 *
 * Everything is driven through scripted fake adapters and an injected
 * clock/sleep/random, so no test waits on a real network or a real timer.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiGateway } from "../src/ai/gateway";
import { SmartRouter } from "../src/ai/smart_router";
import {
  CircuitBreakerRegistry,
  type CircuitStateReader,
} from "../src/ai/circuit_breaker";
import { AiError, type StreamEvent } from "../src/ai/provider";

const KEY = "reliability-master-key";
type Outcome = AiError | "ok";

/** Run fn with env vars set, restoring them afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/**
 * A fake adapter registry whose complete() follows a per-model outcome
 * script: call n takes outcomes[min(n, last)] — so a trailing outcome
 * repeats forever ("always fail" is a one-element script).
 */
function scriptedAdapters(
  script: Map<string, Outcome[]>,
  log: string[],
) {
  const counts = new Map<string, number>();
  return {
    create: (type: string, cfg: { model: string }) => {
      void type;
      return {
        name: "scripted",
        complete: async (req: { model: string }) => {
          log.push(cfg.model);
          const n = counts.get(cfg.model) ?? 0;
          counts.set(cfg.model, n + 1);
          const outcomes = script.get(cfg.model) ?? ["ok" as Outcome];
          const outcome = outcomes[Math.min(n, outcomes.length - 1)]!;
          if (outcome !== "ok") throw outcome;
          return { text: "answer", model: req.model };
        },
      };
    },
  } as unknown as AdapterRegistry;
}

function build(opts: {
  script: Map<string, Outcome[]>;
  breakers?: CircuitBreakerRegistry;
  clock?: ReturnType<typeof fakeClock>;
}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: string[] = [];
  const sleeps: number[] = [];
  const clock = opts.clock ?? fakeClock();
  const breakers =
    opts.breakers ??
    new CircuitBreakerRegistry({ now: clock.now, threshold: 3, baseCooldownMs: 30_000 });
  const gateway = new AiGateway({
    storage,
    adapters: scriptedAdapters(opts.script, log),
    secrets,
    now: clock.now,
    breakers,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // jitter factor exactly 1.0 → delays 400, 800
  });
  return { storage, secrets, providers, models, gateway, log, sleeps, clock, breakers };
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

const net = () => new AiError("network", "down");
const callsFor = (log: string[], model: string) => log.filter((m) => m === model).length;

describe("gateway circuit breaker", () => {
  test("an open breaker is skipped; failover order is preserved among the rest", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-a", [net()]],
        ["model-b", ["ok"]],
      ]);
      const h = build({ script });
      const a = seedProvider(h, "a");
      const b = seedProvider(h, "b");
      h.storage.setRuntimeSelection(a);
      h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
      h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

      // Three requests: A fails each time (breaker counts 1, 2, 3 → opens),
      // B answers each time.
      for (let i = 0; i < 3; i++) {
        await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-b" });
      }
      expect(h.gateway.circuitState(a.providerId).state).toBe("open");

      // Fourth request: A is never called; B serves directly.
      const before = h.log.length;
      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-b" });
      expect(h.log.slice(before)).toEqual(["model-b"]);
      h.storage.close();
    });
  });

  test("all breakers open: the soonest-expiring one still gets a forced attempt", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const clock = fakeClock();
      const script = new Map<string, Outcome[]>([
        ["model-a", [net()]],
        ["model-b", [net(), net(), net(), "ok"]],
      ]);
      const h = build({ script, clock });
      const a = seedProvider(h, "a");
      const b = seedProvider(h, "b");
      h.storage.setRuntimeSelection(a);
      h.storage.setFailoverSettings({ enabled: true, maxAttempts: 5 });
      h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

      // Three requests trip BOTH breakers (each provider fails once per request).
      for (let i = 0; i < 3; i++) {
        await expect(errorOf(h.gateway.complete(REQUEST))).resolves.toMatchObject({ kind: "network" });
      }
      expect(h.gateway.circuitState(a.providerId).state).toBe("open");
      expect(h.gateway.circuitState(b.providerId).state).toBe("open");

      // Fourth request at the same instant: both skipped; the forced
      // fallback attempts the soonest-expiring breaker — a tie, so plan
      // order wins and only A is called. Its failure re-opens A with a
      // doubled cooldown (60s), while B still expires at 30s.
      const before = h.log.length;
      await expect(errorOf(h.gateway.complete(REQUEST))).resolves.toMatchObject({ kind: "network" });
      expect(h.log.slice(before)).toEqual(["model-a"]);
      expect(h.gateway.circuitState(a.providerId).cooldownMs).toBe(60_000);
      expect(h.gateway.circuitState(b.providerId).cooldownMs).toBe(30_000);

      // At +30s: A still cooling down (60s), B's cooldown elapsed → B gets
      // the half-open probe, succeeds, and its breaker closes.
      clock.advance(30_000);
      const before5 = h.log.length;
      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-b" });
      expect(h.log.slice(before5)).toEqual(["model-b"]);
      expect(h.gateway.circuitState(b.providerId).state).toBe("closed");
      h.storage.close();
    });
  });

  test("auth failures never trip the breaker and never skip the provider", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-a", [new AiError("auth", "bad key")]],
        ["model-b", ["ok"]],
      ]);
      const h = build({ script });
      const a = seedProvider(h, "a");
      const b = seedProvider(h, "b");
      h.storage.setRuntimeSelection(a);
      h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
      h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

      for (let i = 0; i < 4; i++) {
        await expect(errorOf(h.gateway.complete(REQUEST))).resolves.toMatchObject({ kind: "auth" });
        // Auth failures cool the key down for 5 minutes (credential-pool
        // rotation); advance the clock so the next request reaches the
        // adapter again.
        h.clock.advance(6 * 60 * 1000);
      }
      expect(callsFor(h.log, "model-a")).toBe(4); // tried every time
      expect(callsFor(h.log, "model-b")).toBe(0); // auth never fails over
      const v = h.gateway.circuitState(a.providerId);
      expect(v.state).toBe("closed");
      expect(v.consecutiveFailures).toBe(0);
      h.storage.close();
    });
  });

  test("BOBI_CIRCUIT_BREAKER=0: the breaker never skips anyone", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0", BOBI_CIRCUIT_BREAKER: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-a", [net()]],
        ["model-b", ["ok"]],
      ]);
      const h = build({ script });
      const a = seedProvider(h, "a");
      const b = seedProvider(h, "b");
      h.storage.setRuntimeSelection(a);
      h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
      h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

      for (let i = 0; i < 4; i++) {
        await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-b" });
      }
      expect(callsFor(h.log, "model-a")).toBe(4);
      expect(h.gateway.circuitState(a.providerId).state).toBe("closed");
      h.storage.close();
    });
  });
});

describe("gateway in-call retry (single provider)", () => {
  test("transient failures are retried with backoff and then succeed", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-s", [net(), new AiError("timeout", "slow"), "ok"]],
      ]);
      const h = build({ script });
      const s = seedProvider(h, "s");
      h.storage.setRuntimeSelection(s);

      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-s" });
      expect(callsFor(h.log, "model-s")).toBe(3); // 1 + 2 retries
      expect(h.sleeps).toEqual([400, 800]); // jitter 1.0 at random()=0.5
      // Success reset the breaker count the two failures had built up.
      expect(h.gateway.circuitState(s.providerId).consecutiveFailures).toBe(0);
      h.storage.close();
    });
  });

  test("retries are bounded: 1 + 2 attempts, then the error surfaces", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-s", [new AiError("timeout", "slow")]],
      ]);
      const h = build({ script });
      const s = seedProvider(h, "s");
      h.storage.setRuntimeSelection(s);

      await expect(errorOf(h.gateway.complete(REQUEST))).resolves.toMatchObject({ kind: "timeout" });
      expect(callsFor(h.log, "model-s")).toBe(3);
      expect(h.sleeps).toEqual([400, 800]);
      expect(h.sleeps.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(3000);
      h.storage.close();
    });
  });

  test("quota (429) is retried; auth/invalid_response/aborted are not", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const cases: Array<{ kind: AiError["kind"]; calls: number }> = [
        { kind: "quota", calls: 3 },
        { kind: "auth", calls: 1 },
        { kind: "invalid_response", calls: 1 },
        { kind: "aborted", calls: 1 },
      ];
      for (const c of cases) {
        const script = new Map<string, Outcome[]>([
          ["model-s", [new AiError(c.kind, "scripted")]],
        ]);
        const h = build({ script });
        const s = seedProvider(h, "s");
        h.storage.setRuntimeSelection(s);
        await expect(errorOf(h.gateway.complete(REQUEST))).resolves.toMatchObject({ kind: c.kind });
        expect(callsFor(h.log, "model-s")).toBe(c.calls);
        h.storage.close();
      }
    });
  });

  test("with failover candidates available there is no in-call retry", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-a", [net()]],
        ["model-b", ["ok"]],
      ]);
      const h = build({ script });
      const a = seedProvider(h, "a");
      const b = seedProvider(h, "b");
      h.storage.setRuntimeSelection(a);
      h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
      h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-b" });
      expect(h.log).toEqual(["model-a", "model-b"]); // A once, then failover
      expect(h.sleeps).toEqual([]);
      h.storage.close();
    });
  });

  test("BOBI_GATEWAY_RETRY=0: a single provider fails immediately", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0", BOBI_GATEWAY_RETRY: "0" }, async () => {
      const script = new Map<string, Outcome[]>([["model-s", [net()]]]);
      const h = build({ script });
      const s = seedProvider(h, "s");
      h.storage.setRuntimeSelection(s);

      await expect(errorOf(h.gateway.complete(REQUEST))).resolves.toMatchObject({ kind: "network" });
      expect(callsFor(h.log, "model-s")).toBe(1);
      expect(h.sleeps).toEqual([]);
      h.storage.close();
    });
  });

  test("streaming: a pre-first-event failure is retried; a post-event one is not", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const storage = Storage.open(":memory:");
      const secrets = new ProviderSecretStore(KEY);
      const adapters = new AdapterRegistry();
      const providers = new ProviderService(storage, secrets, adapters);
      const models = new ModelService(storage);
      const sleeps: number[] = [];
      let streamCalls = 0;
      let mode: "fail-then-ok" | "fail-after-text" = "fail-then-ok";
      const fakeAdapters = {
        create: () => ({
          name: "streamer",
          complete: async (req: { model: string }) => ({ text: "x", model: req.model }),
          completeStream: async function* (req: { model: string }) {
            streamCalls += 1;
            if (mode === "fail-then-ok" && streamCalls === 1) throw net();
            yield { type: "text", delta: "سلام" } as StreamEvent;
            if (mode === "fail-after-text") throw net();
            yield {
              type: "end",
              text: "سلام",
              model: req.model,
              toolCalls: [],
            } as StreamEvent;
          },
        }),
      } as unknown as AdapterRegistry;
      const gateway = new AiGateway({
        storage,
        adapters: fakeAdapters,
        secrets,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        random: () => 0.5,
      });
      const p = providers.create({
        label: "s",
        adapter: "openai_compatible",
        baseUrl: "https://s.invalid/v1",
        apiKey: "sk-s",
      });
      if (!p.ok) throw new Error("provider failed");
      const m = models.add({ providerId: p.data, modelId: "model-s", label: "s" });
      if (!m.ok) throw new Error("model failed");
      models.setDefault(m.data);
      storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });

      // Pre-first-event failure → retried once, stream then flows.
      const texts: string[] = [];
      for await (const ev of gateway.completeStream(REQUEST)) {
        if (ev.type === "text") texts.push(ev.delta);
      }
      expect(texts).toEqual(["سلام"]);
      expect(streamCalls).toBe(2);
      expect(sleeps).toEqual([400]);

      // Post-event failure → committed: no retry, and the breaker is not
      // given failure evidence for a provider that did answer.
      mode = "fail-after-text";
      streamCalls = 0;
      let threw: unknown;
      try {
        for await (const ev of gateway.completeStream(REQUEST)) {
          void ev;
        }
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(AiError);
      expect(streamCalls).toBe(1);
      expect(gateway.circuitState(p.data).consecutiveFailures).toBe(0);
      storage.close();
    });
  });
});

describe("smart router respects open breakers", () => {
  test("an open provider is excluded; a cooldown-expired one stays selectable alone", async () => {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const cheap = providers.create({
      label: "cheap",
      adapter: "openai_compatible",
      baseUrl: "https://cheap.invalid/v1",
      apiKey: "sk-cheap",
    });
    const pricey = providers.create({
      label: "pricey",
      adapter: "openai_compatible",
      baseUrl: "https://pricey.invalid/v1",
      apiKey: "sk-pricey",
    });
    if (!cheap.ok || !pricey.ok) throw new Error("seed failed");
    const cm = models.add({ providerId: cheap.data, modelId: "cheap-nano", label: "cheap" });
    const pm = models.add({ providerId: pricey.data, modelId: "model-pricey", label: "pricey" });
    if (!cm.ok || !pm.ok) throw new Error("seed failed");

    const req = { messages: [{ role: "user" as const, content: "hi" }] };

    // No circuit state: the cheap model wins on cost.
    const plain = new SmartRouter(storage, adapters);
    expect(plain.route(req)?.providerId).toBe(cheap.data);

    // Trip cheap's breaker (real clock, 60s cooldown): router excludes it.
    const registry = new CircuitBreakerRegistry({ threshold: 3, baseCooldownMs: 60_000 });
    registry.recordFailure(cheap.data);
    registry.recordFailure(cheap.data);
    registry.recordFailure(cheap.data);
    const aware = new SmartRouter(storage, adapters, { circuit: registry });
    expect(aware.route(req)?.providerId).toBe(pricey.data);

    // Cooldown elapsed → cheap ranks as half-open: still loses to the
    // healthy pricey one, but is picked when it is the only candidate.
    const shortRegistry = new CircuitBreakerRegistry({ threshold: 1, baseCooldownMs: 1 });
    shortRegistry.recordFailure(cheap.data);
    await new Promise((r) => setTimeout(r, 5));
    const expired = new SmartRouter(storage, adapters, { circuit: shortRegistry });
    expect(expired.route(req)?.providerId).toBe(pricey.data);
    storage.setProviderEnabled(pricey.data, false);
    expect(expired.route(req)?.providerId).toBe(cheap.data);
    storage.close();
  });
});

describe("health probe surface", () => {
  test("results carry circuit state when a breaker source is injected", async () => {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const okAdapters = {
      create: () => ({
        name: "ok",
        complete: async (req: { model: string }) => ({ text: "pong", model: req.model }),
      }),
    } as unknown as AdapterRegistry;
    const source: CircuitStateReader = {
      state: () => ({
        state: "open",
        consecutiveFailures: 3,
        cooldownMs: 30_000,
        nextRetryAt: 42,
      }),
    };
    const p = providers.create({
      label: "p",
      adapter: "openai_compatible",
      baseUrl: "https://p.invalid/v1",
      apiKey: "sk-p",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = models.add({ providerId: p.data, modelId: "model-p", label: "p" });
    if (!m.ok) throw new Error("model failed");
    models.setDefault(m.data);

    const withCircuit = new ProviderHealthService(
      storage, providers, secrets, okAdapters, 300, source,
    );
    const probed = await withCircuit.probe(p.data);
    expect(probed.ok).toBe(true);
    expect(probed.circuit?.state).toBe("open");
    expect(withCircuit.last(p.data)?.circuit?.state).toBe("open");
    const modelTest = await withCircuit.probeModel(p.data, "model-p");
    expect(modelTest.circuit?.state).toBe("open");

    const without = new ProviderHealthService(storage, providers, secrets, okAdapters, 300);
    const plain = await without.probe(p.data);
    expect(plain.circuit).toBeUndefined();
    storage.close();
  });
});
