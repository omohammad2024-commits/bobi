/**
 * Connection layer upgrade: connection manager (warm-up, idle reaping,
 * per-host stats), Retry-After end-to-end (parse → AiError → gateway
 * backoff floor), background health probing with breaker recovery, and
 * failover pre-warm.
 *
 * Everything is hermetic: fake clocks, fake connectors, scripted fake
 * adapters, in-memory storage. No real network, no real DNS.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiGateway } from "../src/ai/gateway";
import {
  CircuitBreakerRegistry,
} from "../src/ai/circuit_breaker";
import { AiError } from "../src/ai/provider";
import { parseRetryAfterMs, statusToAiError } from "../src/ai/http_status";
import {
  ConnectionManager,
  connectionManager,
  sharedDnsCache,
} from "../src/ai/connection_manager";
import { clearDnsCache, resolveTarget } from "../src/ai/dns_guard";

const KEY = "connection-layer-master-key";

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

/* ------------------------- Retry-After parsing ------------------------ */

describe("Retry-After parsing", () => {
  test("delta-seconds form", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs(" 12 ")).toBe(12000);
  });

  test("HTTP-date form is measured against now", () => {
    const now = Date.UTC(2026, 9, 20, 6, 0, 0);
    const date = new Date(now + 8000).toUTCString();
    expect(parseRetryAfterMs(date, now)).toBe(8000);
    // A date in the past clamps to 0, never negative.
    const past = new Date(now - 5000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  test("garbage and absence yield undefined; huge values clamp to 30s", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon-ish")).toBeUndefined();
    expect(parseRetryAfterMs("-5")).toBeUndefined();
    expect(parseRetryAfterMs("9999")).toBe(30_000);
  });

  test("statusToAiError carries Retry-After only for 429 and 503", () => {
    const limited = statusToAiError(429, { "retry-after": "7" });
    expect(limited.kind).toBe("quota");
    expect(limited.retryAfterMs).toBe(7000);

    const unavailable = statusToAiError(503, { "retry-after": "2" });
    expect(unavailable.kind).toBe("network");
    expect(unavailable.retryAfterMs).toBe(2000);

    // Other statuses ignore the header entirely.
    expect(statusToAiError(500, { "retry-after": "7" }).retryAfterMs).toBeUndefined();
    expect(statusToAiError(401, { "retry-after": "7" }).retryAfterMs).toBeUndefined();
    // No headers → no field (backward compatible).
    expect(statusToAiError(429).retryAfterMs).toBeUndefined();
    expect(statusToAiError(429, {}).retryAfterMs).toBeUndefined();
    expect(statusToAiError(429, { "retry-after": "junk" }).retryAfterMs).toBeUndefined();
  });
});

/* --------------------- Gateway Retry-After floor ---------------------- */

type Outcome = AiError | "ok";

function scriptedAdapters(script: Map<string, Outcome[]>, log: string[]) {
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

function buildGateway(opts: {
  script: Map<string, Outcome[]>;
  preWarm?: (candidate: { providerId: number }) => void;
}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: string[] = [];
  const sleeps: number[] = [];
  const clock = fakeClock();
  const breakers = new CircuitBreakerRegistry({
    now: clock.now,
    threshold: 3,
    baseCooldownMs: 30_000,
  });
  const gateway = new AiGateway({
    storage,
    adapters: scriptedAdapters(opts.script, log),
    secrets,
    now: clock.now,
    breakers,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5, // jitter factor exactly 1.0 → backoff 400, 800
    ...(opts.preWarm !== undefined
      ? { preWarm: opts.preWarm as never }
      : {}),
  });
  return { storage, secrets, providers, models, gateway, log, sleeps, clock, breakers };
}

function seedProvider(
  h: ReturnType<typeof buildGateway>,
  tag: string,
): { providerId: number; modelId: number } {
  const p = h.providers.create({
    label: tag,
    adapter: "openai_compatible",
    baseUrl: `https://${tag}.invalid/v1`,
    apiKey: `key-${tag}`,
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

describe("gateway Retry-After backoff floor", () => {
  test("a 429 Retry-After above the jittered backoff becomes the wait", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-a", [new AiError("quota", "rate", 429, 5000), "ok"]],
      ]);
      const h = buildGateway({ script });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);

      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-a" });
      // Jittered backoff would be 400; the provider asked for 5000.
      expect(h.sleeps).toEqual([5000]);
      h.storage.close();
    });
  });

  test("a Retry-After below the jittered backoff keeps the backoff", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-a", [new AiError("network", "down", 503, 250), "ok"]],
      ]);
      const h = buildGateway({ script });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);

      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-a" });
      expect(h.sleeps).toEqual([400]);
      h.storage.close();
    });
  });

  test("no Retry-After: the pre-existing backoff is untouched", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const script = new Map<string, Outcome[]>([
        ["model-a", [new AiError("network", "down"), "ok"]],
      ]);
      const h = buildGateway({ script });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);

      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-a" });
      expect(h.sleeps).toEqual([400]);
      h.storage.close();
    });
  });
});

describe("gateway failover pre-warm", () => {
  test("the next candidate is pre-warmed when a plan has one", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const warmed: number[] = [];
      const script = new Map<string, Outcome[]>([
        ["model-a", ["ok"]],
        ["model-b", ["ok"]],
      ]);
      const h = buildGateway({
        script,
        preWarm: (c) => {
          warmed.push(c.providerId);
        },
      });
      const a = seedProvider(h, "a");
      const b = seedProvider(h, "b");
      h.storage.setRuntimeSelection(a);
      h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
      h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);

      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-a" });
      expect(warmed).toEqual([b.providerId]);
      h.storage.close();
    });
  });

  test("a single-candidate plan never pre-warms", async () => {
    await withEnv({ BOBI_SMART_ROUTING: "0" }, async () => {
      const warmed: number[] = [];
      const script = new Map<string, Outcome[]>([["model-a", ["ok"]]]);
      const h = buildGateway({
        script,
        preWarm: (c) => {
          warmed.push(c.providerId);
        },
      });
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);

      await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ model: "model-a" });
      expect(warmed).toEqual([]);
      h.storage.close();
    });
  });
});

/* ------------------------- Connection manager ------------------------- */

const EXAMPLE_URL = new URL("https://api.example.com/v1");

function buildManager(clock = fakeClock()) {
  const connectorCalls: string[] = [];
  const manager = new ConnectionManager({
    now: clock.now,
    idleMs: 1000,
    dnsTtlMs: () => 60_000,
    disableReaper: true,
    connector: async ({ address }) => {
      connectorCalls.push(address);
    },
  });
  return { manager, clock, connectorCalls };
}

describe("connection manager", () => {
  test("agentFor reuses a pooled agent and counts the reuse", () => {
    const { manager } = buildManager();
    const first = manager.agentFor(EXAMPLE_URL, ["93.184.216.34"], true, false);
    const second = manager.agentFor(EXAMPLE_URL, ["93.184.216.34"], true, false);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    const stats = manager.stats();
    expect(stats).toHaveLength(1);
    expect(stats[0]!.connectCount).toBe(1);
    expect(stats[0]!.reusedCount).toBe(1);
    manager.reset();
  });

  test("an address rotation replaces the agent", () => {
    const { manager } = buildManager();
    const first = manager.agentFor(EXAMPLE_URL, ["93.184.216.34"], true, false);
    const rotated = manager.agentFor(EXAMPLE_URL, ["93.184.216.35"], true, false);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(first);
    expect(manager.agentCount()).toBe(1);
    manager.reset();
  });

  test("warm() marks the host warm; statsForUrl reports it", async () => {
    const { manager, clock, connectorCalls } = buildManager();
    const ok = await manager.warm({
      baseUrl: "https://api.example.com/v1",
      addresses: ["93.184.216.34"],
      allowLocalTargets: false,
    });
    expect(ok).toBe(true);
    expect(connectorCalls).toEqual(["93.184.216.34"]);
    expect(manager.isWarm(EXAMPLE_URL, false)).toBe(true);
    const view = manager.statsForUrl("https://api.example.com/v1", false);
    expect(view?.state).toBe("warm");

    // Past the idle window the same entry reports cold.
    clock.advance(1001);
    expect(manager.statsForUrl("https://api.example.com/v1", false)?.state).toBe("cold");
    manager.reset();
  });

  test("warm() failure is swallowed and recorded as the last error kind", async () => {
    const clock = fakeClock();
    const manager = new ConnectionManager({
      now: clock.now,
      idleMs: 1000,
      dnsTtlMs: () => 60_000,
      disableReaper: true,
      connector: async () => {
        throw new AiError("network", "no route");
      },
    });
    const ok = await manager.warm({
      baseUrl: "https://api.example.com/v1",
      addresses: ["93.184.216.34"],
      allowLocalTargets: false,
    });
    expect(ok).toBe(false);
    expect(manager.stats()[0]?.lastErrorKind).toBe("network");
    manager.reset();
  });

  test("idle agents are reaped; agentFor rebuilds cleanly after idle", () => {
    const { manager, clock } = buildManager();
    const first = manager.agentFor(EXAMPLE_URL, ["93.184.216.34"], true, false);
    clock.advance(1001);
    expect(manager.reapIdle()).toBe(1);
    expect(manager.agentCount()).toBe(0);

    const second = manager.agentFor(EXAMPLE_URL, ["93.184.216.34"], true, false);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    // Idle expiry inside agentFor: no reap call needed.
    clock.advance(1001);
    const third = manager.agentFor(EXAMPLE_URL, ["93.184.216.34"], true, false);
    expect(third).not.toBe(second);
    manager.reset();
  });

  test("noteOutcome records latency and the last error kind", () => {
    const { manager } = buildManager();
    manager.agentFor(EXAMPLE_URL, ["93.184.216.34"], true, false);
    manager.noteOutcome(EXAMPLE_URL, false, { latencyMs: 42.4 });
    expect(manager.statsForUrl("https://api.example.com/v1", false)?.lastLatencyMs).toBe(42);
    manager.noteOutcome(EXAMPLE_URL, false, { latencyMs: 9, errorKind: "timeout" });
    expect(manager.stats()[0]?.lastErrorKind).toBe("timeout");
    // A success clears the recorded error kind.
    manager.noteOutcome(EXAMPLE_URL, false, { latencyMs: 9 });
    expect(manager.stats()[0]?.lastErrorKind).toBeUndefined();
    manager.reset();
  });

  test("pooling off: agentFor is undefined and warm() never connects", async () => {
    let connects = 0;
    const manager = new ConnectionManager({
      disableReaper: true,
      keepAliveEnabled: () => false,
      connector: async () => {
        connects += 1;
      },
    });
    expect(manager.agentFor(EXAMPLE_URL, ["93.184.216.34"], true, false)).toBeUndefined();
    await expect(
      manager.warm({
        baseUrl: "https://api.example.com/v1",
        addresses: ["93.184.216.34"],
        allowLocalTargets: false,
      }),
    ).resolves.toBe(false);
    expect(connects).toBe(0);
    manager.reset();
  });

  test("manager disabled: warm() is a no-op", async () => {
    let connects = 0;
    const manager = new ConnectionManager({
      disableReaper: true,
      enabled: () => false,
      connector: async () => {
        connects += 1;
      },
    });
    await expect(
      manager.warm({
        baseUrl: "https://api.example.com/v1",
        addresses: ["93.184.216.34"],
        allowLocalTargets: false,
      }),
    ).resolves.toBe(false);
    expect(connects).toBe(0);
  });

  test("dns_guard stores resolutions in the shared cache", async () => {
    clearDnsCache();
    const resolved = await resolveTarget(
      { baseUrl: "https://conn-layer-test.invalid/v1", apiKey: undefined },
      { resolver: async () => ["93.184.216.34"] },
    );
    expect(resolved.addresses).toEqual(["93.184.216.34"]);
    expect(sharedDnsCache.size).toBe(1);
    clearDnsCache();
    expect(sharedDnsCache.size).toBe(0);
  });

  test("the default singleton honors BOBI_CONN_MANAGER=0 for warm()", async () => {
    await withEnv({ BOBI_CONN_MANAGER: "0" }, async () => {
      await expect(
        connectionManager.warm({
          baseUrl: "https://api.example.com/v1",
          addresses: ["93.184.216.34"],
          allowLocalTargets: false,
        }),
      ).resolves.toBe(false);
    });
  });
});

/* ------------------------- Background prober -------------------------- */

function buildHealth(opts: { outcome: () => Outcome; calls: { n: number } }) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const fakeAdapters = {
    create: () => ({
      name: "fake",
      complete: async (req: { model: string }) => {
        opts.calls.n += 1;
        const outcome = opts.outcome();
        if (outcome !== "ok") throw outcome;
        return { text: "pong", model: req.model };
      },
    }),
  } as unknown as AdapterRegistry;
  const clock = fakeClock();
  const breakers = new CircuitBreakerRegistry({
    now: clock.now,
    threshold: 3,
    baseCooldownMs: 30_000,
  });
  const health = new ProviderHealthService(
    storage,
    providers,
    secrets,
    fakeAdapters,
    300,
    breakers,
  );
  const p = providers.create({
    label: "p",
    adapter: "openai_compatible",
    baseUrl: "https://p.invalid/v1",
    apiKey: "key-p",
  });
  if (!p.ok) throw new Error("provider failed");
  const m = models.add({ providerId: p.data, modelId: "model-p", label: "p" });
  if (!m.ok) throw new Error("model failed");
  models.setDefault(m.data);
  return { storage, health, breakers, providerId: p.data };
}

describe("background health prober", () => {
  test("a recovered provider's breaker is closed via the shared registry", async () => {
    let failing = true;
    const calls = { n: 0 };
    const h = buildHealth({
      outcome: () => (failing ? new AiError("network", "down") : "ok"),
      calls,
    });
    // Trip the breaker the way gateway traffic would.
    h.breakers.recordFailure(h.providerId);
    h.breakers.recordFailure(h.providerId);
    h.breakers.recordFailure(h.providerId);
    expect(h.breakers.state(h.providerId).state).toBe("open");

    // Still down: the pass probes it, records nothing into the breaker.
    await expect(h.health.runBackgroundProbePass(h.breakers)).resolves.toBe(1);
    expect(h.breakers.state(h.providerId).state).toBe("open");
    expect(h.health.last(h.providerId)?.ok).toBe(false);

    // Healed: the next pass probes, and recovery closes the breaker.
    failing = false;
    await expect(h.health.runBackgroundProbePass(h.breakers)).resolves.toBe(1);
    expect(h.breakers.state(h.providerId).state).toBe("closed");
    expect(h.health.last(h.providerId)?.ok).toBe(true);

    // Healthy + closed: nothing left to probe.
    await expect(h.health.runBackgroundProbePass(h.breakers)).resolves.toBe(0);
    h.storage.close();
  });

  test("a pass never overlaps itself", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls = { n: 0 };
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(KEY);
    const adapters = new AdapterRegistry();
    const providers = new ProviderService(storage, secrets, adapters);
    const models = new ModelService(storage);
    const gated = {
      create: () => ({
        name: "gated",
        complete: async (req: { model: string }) => {
          calls.n += 1;
          await gate;
          return { text: "pong", model: req.model };
        },
      }),
    } as unknown as AdapterRegistry;
    const breakers = new CircuitBreakerRegistry({ threshold: 3, baseCooldownMs: 30_000 });
    const health = new ProviderHealthService(storage, providers, secrets, gated, 300, breakers);
    const p = providers.create({
      label: "p",
      adapter: "openai_compatible",
      baseUrl: "https://p.invalid/v1",
      apiKey: "key-p",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = models.add({ providerId: p.data, modelId: "model-p", label: "p" });
    if (!m.ok) throw new Error("model failed");
    models.setDefault(m.data);
    breakers.recordFailure(p.data);
    breakers.recordFailure(p.data);
    breakers.recordFailure(p.data);

    const first = health.runBackgroundProbePass(breakers);
    // The second pass sees the in-flight one and does nothing.
    await expect(health.runBackgroundProbePass(breakers)).resolves.toBe(0);
    release();
    await expect(first).resolves.toBe(1);
    expect(calls.n).toBe(1);
    storage.close();
  });

  test("start/stop: passes run on the timer and stop with stop()", async () => {
    const calls = { n: 0 };
    const h = buildHealth({ outcome: () => new AiError("network", "down"), calls });
    h.breakers.recordFailure(h.providerId);
    h.breakers.recordFailure(h.providerId);
    h.breakers.recordFailure(h.providerId);

    h.health.startBackgroundProbes(h.breakers, { intervalMs: 5 });
    expect(h.health.backgroundProbesRunning()).toBe(true);
    const deadline = Date.now() + 2000;
    while (calls.n === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(calls.n).toBeGreaterThan(0);

    h.health.stopBackgroundProbes();
    expect(h.health.backgroundProbesRunning()).toBe(false);
    const after = calls.n;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.n).toBe(after);
    h.storage.close();
  });

  test("kill switches: BOBI_CONN_MANAGER=0 and BOBI_HEALTH_PROBE_MS=0 keep it off", async () => {
    const calls = { n: 0 };
    const h = buildHealth({ outcome: () => "ok", calls });
    await withEnv({ BOBI_CONN_MANAGER: "0" }, async () => {
      h.health.startBackgroundProbes(h.breakers, { intervalMs: 5 });
      expect(h.health.backgroundProbesRunning()).toBe(false);
    });
    await withEnv({ BOBI_HEALTH_PROBE_MS: "0" }, async () => {
      h.health.startBackgroundProbes(h.breakers);
      expect(h.health.backgroundProbesRunning()).toBe(false);
    });
    h.storage.close();
  });
});

/* --------------------- Health connection field ------------------------ */

describe("health probe connection field", () => {
  test("results carry connection stats when a source is injected", async () => {
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
    const connections = {
      statsForUrl: () => ({ reused: 3, lastLatencyMs: 12, state: "warm" as const }),
    };
    const p = providers.create({
      label: "p",
      adapter: "openai_compatible",
      baseUrl: "https://p.invalid/v1",
      apiKey: "key-p",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = models.add({ providerId: p.data, modelId: "model-p", label: "p" });
    if (!m.ok) throw new Error("model failed");
    models.setDefault(m.data);

    const withConn = new ProviderHealthService(
      storage, providers, secrets, okAdapters, 300, undefined, connections,
    );
    const probed = await withConn.probe(p.data);
    expect(probed.connection).toEqual({ reused: 3, lastLatencyMs: 12, state: "warm" });
    expect(withConn.last(p.data)?.connection?.state).toBe("warm");

    const without = new ProviderHealthService(storage, providers, secrets, okAdapters, 300);
    const plain = await without.probe(p.data);
    expect(plain.connection).toBeUndefined();
    storage.close();
  });
});
