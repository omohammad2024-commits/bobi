/**
 * Audit H4: probe health, measured latency and model quarantine must
 * actually steer SmartRouter scoring.
 *
 * Pre-change, healthBonus was +15/−50 while cost spread reaches
 * 90 × 10 = 900 points, persisted latencyMs was never read, and the
 * router never consulted the model quarantine — a free model on a
 * provider whose probe failed an hour ago beat every healthy provider.
 *
 * Policy pinned here:
 * - latest probe failed < PROVIDER_DEAD_FRESH_MS (10 min) ago: the
 *   provider is hard-excluded while any candidate is not fresh-failed;
 *   if EVERY candidate is fresh-failed the gate lifts (maybe-dead beats
 *   none).
 * - failure 10 min–24 h old: −950 points (more than the whole cost
 *   spread), so it can never win on price alone.
 * - success ≤ 24 h: +15 plus −round(min(latencyMs, 2000) / 10).
 * - a quarantined (provider, model) pair is hard-excluded under the
 *   same relaxation as the fresh gate.
 *
 * Clock note: storage.setProviderHealth stamps checkedAt with the wall
 * clock (Date.now), and the router reads Date.now too — so the health
 * tests install a fake Date.now and stamp rows at chosen instants.
 * Harness mirrors tests/smart_router.test.ts. No network.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { SmartRouter, PROVIDER_DEAD_FRESH_MS } from "../src/ai/smart_router";
import { ModelQuarantineRegistry } from "../src/ai/model_quarantine";
import { AiGateway } from "../src/ai/gateway";
import type { ChatMessage } from "../src/ai/provider";

const KEY = "smart-router-health-test-key";
const adapters = new AdapterRegistry();

/** Fixed instant every fake-clock test routes at. */
const BASE = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

const REAL_NOW = Date.now;

/** Install a fake Date.now; the caller MUST restore() (use finally). */
function installClock(start: number) {
  let now = start;
  Date.now = () => now;
  return {
    set(t: number) {
      now = t;
    },
    restore() {
      Date.now = REAL_NOW;
    },
  };
}

function msg(content: string): ChatMessage {
  return { role: "user", content };
}

function build() {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  return { storage, secrets, providers, models };
}

function seed(
  b: ReturnType<typeof build>,
  label: string,
  modelId: string,
): { providerId: number; modelDbId: number } {
  const p = b.providers.create({
    label,
    adapter: "openai_compatible",
    baseUrl: `https://${label}.invalid/v1`,
    apiKey: "key-" + label,
  });
  if (!p.ok) throw new Error(`provider failed: ${label}`);
  const m = b.models.add({ providerId: p.data, modelId, label: modelId });
  if (!m.ok) throw new Error(`model failed: ${modelId}`);
  return { providerId: p.data, modelDbId: m.data };
}

// Cost references for the scenarios below (costHint × 10 in score()):
//   "cheap-free-model"   → cost 0  ("free")  → base 1000
//   "healthy-opus-model" → cost 90 ("opus")  → base 100
//   "model-nano"         → cost 5  ("nano")  → base 950
//   "model-turbo"        → cost 20 ("turbo") → base 800
// Both adapters are openai_compatible, so the +2 streaming bonus applies
// to every candidate equally and cancels out of every comparison.

describe("H4 constants", () => {
  test("the fresh-failure window is 10 minutes", () => {
    expect(PROVIDER_DEAD_FRESH_MS).toBe(600_000);
  });
});

describe("fresh-failure hard gate", () => {
  test("(a) fresh-failed cheap provider loses to a healthy pricier one", () => {
    const clock = installClock(BASE);
    try {
      const b = build();
      const cheap = seed(b, "cheap", "cheap-free-model");
      const healthy = seed(b, "healthy", "healthy-opus-model");
      // Stamped at BASE: at route time both rows are 0 ms old.
      b.storage.setProviderHealth({ providerId: cheap.providerId, ok: false, message: "down" });
      b.storage.setProviderHealth({ providerId: healthy.providerId, ok: true, message: "ok" });
      const d = new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] });
      // Without the gate the cheap provider would score 1000 − 950 = 50
      // after the stale penalty — it is not scored at all: the gate
      // excludes it while the healthy candidate exists.
      expect(d).toBeDefined();
      expect(d!.providerId).toBe(healthy.providerId);
      expect(d!.modelId).toBe("healthy-opus-model");
      b.storage.close();
    } finally {
      clock.restore();
    }
  });

  test("(b) a fresh-failed provider that is the ONLY candidate is still routed", () => {
    const clock = installClock(BASE);
    try {
      const b = build();
      const only = seed(b, "only", "cheap-free-model");
      b.storage.setProviderHealth({ providerId: only.providerId, ok: false, message: "down" });
      const d = new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] });
      // Every candidate is fresh-failed → the gate lifts for this call.
      expect(d).toBeDefined();
      expect(d!.providerId).toBe(only.providerId);
      b.storage.close();
    } finally {
      clock.restore();
    }
  });
});

describe("stale-failure penalty", () => {
  test("(c) a 2 h-old failure on the cheapest loses to a healthy expensive provider", () => {
    const clock = installClock(BASE - 2 * HOUR_MS);
    try {
      const b = build();
      const cheap = seed(b, "cheap", "cheap-free-model");
      const healthy = seed(b, "healthy", "healthy-opus-model");
      // Cheap failed 2 h before BASE (stale: past the 10 min gate,
      // inside the 24 h window). Healthy succeeded 1 min before BASE.
      b.storage.setProviderHealth({ providerId: cheap.providerId, ok: false, message: "down" });
      clock.set(BASE - 60_000);
      b.storage.setProviderHealth({ providerId: healthy.providerId, ok: true, message: "ok" });
      clock.set(BASE);
      const d = new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] });
      // Arithmetic (streaming +2 on both, cancels):
      //   cheap:   1000 − 0×10 (cost 0)  − 950 (stale penalty) = 50
      //   healthy: 1000 − 90×10 (cost 90) + 15 (success)       = 115
      // 115 > 50: the penalty exceeds the maximum cost spread
      // (90 × 10 = 900), so the known-failed provider cannot win on
      // price. Pre-change (−50) the cheap provider scored 950 and won.
      expect(d).toBeDefined();
      expect(d!.providerId).toBe(healthy.providerId);
      b.storage.close();
    } finally {
      clock.restore();
    }
  });
});

describe("latency term", () => {
  test("(d) measured latency flips the winner between two healthy providers", () => {
    const clock = installClock(BASE);
    try {
      const b = build();
      const slow = seed(b, "slowcheap", "model-nano");
      const fast = seed(b, "fastpricey", "model-turbo");
      b.storage.setProviderHealth({
        providerId: slow.providerId,
        ok: true,
        message: "ok",
        latencyMs: 2000,
      });
      b.storage.setProviderHealth({
        providerId: fast.providerId,
        ok: true,
        message: "ok",
        latencyMs: 50,
      });
      const d = new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] });
      // Arithmetic (streaming +2 on both, cancels):
      //   slow/cheap:  1000 − 5×10  = 950; bonus 15 − round(min(2000,2000)/10)
      //                = 15 − 200 = −185 → 765
      //   fast/pricier: 1000 − 20×10 = 800; bonus 15 − round(50/10)
      //                = 15 − 5 = +10 → 810
      // 810 > 765: the slightly pricier but 40× faster provider wins.
      // Without the latency term the cheaper one would win 965 vs 815.
      expect(d).toBeDefined();
      expect(d!.providerId).toBe(fast.providerId);
      expect(d!.modelId).toBe("model-turbo");
      b.storage.close();
    } finally {
      clock.restore();
    }
  });
});

describe("quarantine gate", () => {
  test("(e) a quarantined model is excluded while an alternative exists; all-quarantined still routes", () => {
    const b = build();
    const cheap = seed(b, "cheap", "cheap-free-model");
    const healthy = seed(b, "healthy", "healthy-opus-model");
    const quarantine = new ModelQuarantineRegistry();
    const router = new SmartRouter(b.storage, adapters, { quarantine });

    // Baseline: no quarantine → the cheap model wins on cost.
    expect(router.route({ messages: [msg("hi")] })?.providerId).toBe(cheap.providerId);

    // Three consecutive failures quarantine the cheap (provider, model).
    quarantine.recordFailure(cheap.providerId, "cheap-free-model");
    quarantine.recordFailure(cheap.providerId, "cheap-free-model");
    quarantine.recordFailure(cheap.providerId, "cheap-free-model");
    expect(quarantine.isQuarantined(cheap.providerId, "cheap-free-model")).toBe(true);
    expect(router.route({ messages: [msg("hi")] })?.providerId).toBe(healthy.providerId);

    // Quarantine the alternative too: EVERY candidate is quarantined,
    // so the gate lifts and cost decides again — routing never refuses
    // solely on quarantine state.
    quarantine.recordFailure(healthy.providerId, "healthy-opus-model");
    quarantine.recordFailure(healthy.providerId, "healthy-opus-model");
    quarantine.recordFailure(healthy.providerId, "healthy-opus-model");
    const d = router.route({ messages: [msg("hi")] });
    expect(d).toBeDefined();
    expect(d!.providerId).toBe(cheap.providerId);
    b.storage.close();
  });

  test("(h) the tier-floor fallback pool respects the quarantine gate", () => {
    const b = build();
    // "free-opus-model": cost 0 ("free") AND capability rank 2 ("opus").
    const strong = seed(b, "qstrong", "free-opus-model");
    // "llama-3.1-8b-instruct": cost 12 ("8b"), rank 1 — below the heavy
    // tier floor, so it can only ever win through the fallback pool.
    const light = seed(b, "light", "llama-3.1-8b-instruct");
    const quarantine = new ModelQuarantineRegistry();
    quarantine.recordFailure(strong.providerId, "free-opus-model");
    quarantine.recordFailure(strong.providerId, "free-opus-model");
    quarantine.recordFailure(strong.providerId, "free-opus-model");
    const router = new SmartRouter(b.storage, adapters, { quarantine });
    const d = router.route({ messages: [msg("lorem ipsum ".repeat(800))] });
    // score(): the strong model is quarantine-gated, the light one is
    // under the tier floor → scored pool is empty → fallback pool. The
    // fallback must apply the same gate: without it the strong model
    // would re-score 1000 − 0 = 1000 and beat the light one's 880.
    expect(d).toBeDefined();
    expect(d!.providerId).toBe(light.providerId);
    expect(d!.modelId).toBe("llama-3.1-8b-instruct");
    b.storage.close();
  });
});

describe("no health data", () => {
  test("(g) no health rows anywhere: decisions match pre-change behavior", () => {
    const b = build();
    const cheap = seed(b, "cheap", "cheap-free-model");
    seed(b, "healthy", "healthy-opus-model");
    // No health rows, no quarantine: pure cost ordering, as before H4.
    const d = new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] });
    expect(d).toBeDefined();
    expect(d!.providerId).toBe(cheap.providerId);
    b.storage.close();

    // Deterministic tie-break is untouched: identical candidates pick
    // the lower provider id.
    const c = build();
    const first = seed(c, "a", "same-model-xyz");
    seed(c, "b", "same-model-xyz");
    const d2 = new SmartRouter(c.storage, adapters).route({ messages: [msg("hi")] });
    expect(d2).toBeDefined();
    expect(d2!.providerId).toBe(first.providerId);
    c.storage.close();
  });
});

// ---------- gateway-level wiring (f) ----------

/** Run fn with env vars set (undefined = deleted), restoring them after. */
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

/** Fake adapter registry that logs the model each call was built for. */
function recordingAdapters(log: string[]) {
  return {
    create: (_type: string, cfg: { model: string }) => ({
      name: "recorder",
      complete: async (req: { model: string }) => {
        log.push(cfg.model);
        return { text: "answer", model: req.model };
      },
    }),
  } as unknown as AdapterRegistry;
}

const GATEWAY_REQ = {
  messages: [{ role: "user" as const, content: "hi" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

describe("gateway wiring", () => {
  test("(f) complete() answers from the other provider once the cheap routed model is quarantined", async () => {
    await withEnv(
      {
        BOBI_SMART_ROUTING: undefined,
        BOBI_MODEL_QUARANTINE: undefined,
        BOBI_MODEL_QUARANTINE_MS: undefined,
      },
      async () => {
        const b = build();
        const log: string[] = [];
        const quarantine = new ModelQuarantineRegistry();
        const gateway = new AiGateway({
          storage: b.storage,
          adapters: recordingAdapters(log),
          secrets: b.secrets,
          quarantine,
        });
        const cheap = seed(b, "cheap", "cheap-free-model");
        const healthy = seed(b, "healthy", "healthy-opus-model");
        // The owner's active selection is the cheap pair.
        b.storage.setRuntimeSelection({
          providerId: cheap.providerId,
          modelId: cheap.modelDbId,
        });

        // Baseline: smart routing picks the cheap pair and it answers.
        const before = await gateway.complete(GATEWAY_REQ);
        expect(before.model).toBe("cheap-free-model");
        expect(log).toEqual(["cheap-free-model"]);

        // Quarantine the cheap (provider, model) pair via the shared
        // registry's own threshold (3 consecutive failures).
        quarantine.recordFailure(cheap.providerId, "cheap-free-model");
        quarantine.recordFailure(cheap.providerId, "cheap-free-model");
        quarantine.recordFailure(cheap.providerId, "cheap-free-model");
        expect(quarantine.isQuarantined(cheap.providerId, "cheap-free-model")).toBe(true);
        void healthy;

        // The gateway passes its quarantine registry to the router, so
        // the routed primary is now the healthy provider — the cheap
        // adapter is never even constructed for this turn. (Pre-fix the
        // router never saw the registry and the gateway's own
        // eligibleCandidates could not skip a lone routed primary.)
        log.length = 0;
        const after = await gateway.complete(GATEWAY_REQ);
        expect(after.model).toBe("healthy-opus-model");
        expect(log).toEqual(["healthy-opus-model"]);
        b.storage.close();
      },
    );
  });
});
