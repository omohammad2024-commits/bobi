/**
 * Audit H6: plan() must read stored probe health.
 *
 * The background prober diligently records probe failures into storage
 * (storage.setProviderHealth), but plan() never read them — a provider
 * known-dead minutes ago still led every turn until real traffic tripped
 * its breaker. Now plan() stable-partitions the candidate list:
 * candidates whose provider's stored health row is ok === false AND
 * fresh (younger than PROVIDER_HEALTH_FRESH_MS by the gateway's injected
 * clock) move after all others, relative order preserved.
 *
 * Probe-dead is a demotion, not a skip — the candidate is still tried if
 * the chain reaches it. Guards: fewer than 2 candidates, or EVERY
 * candidate fresh-failed, leaves the order byte-identical to before.
 *
 * Note on clocks: setProviderHealth stamps checkedAt with the wall
 * clock, so freshness is steered through the GATEWAY's injected clock —
 * the stale case injects a clock 11 minutes ahead of wall time.
 *
 * Harness follows tests/ai_gateway_reliability.test.ts (scripted fake
 * adapters, in-memory storage). No network.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway, PROVIDER_HEALTH_FRESH_MS } from "../src/ai/gateway";
import { AiError } from "../src/ai/provider";

const KEY = "gateway-health-plan-master-key";

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

function build(opts: { now?: () => number; failModels?: Set<string> } = {}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: string[] = [];

  const fakeAdapters = {
    create: (type: string, cfg: { model: string }) => {
      void type;
      return {
        name: "fake",
        complete: async (req: { model: string }) => {
          log.push(cfg.model);
          if (opts.failModels?.has(cfg.model)) throw new AiError("network", "down");
          return { text: `answer-${cfg.model}`, model: req.model };
        },
      } as unknown as ReturnType<AdapterRegistry["create"]>;
    },
  } as unknown as AdapterRegistry;

  const gateway = new AiGateway({
    storage,
    adapters: fakeAdapters,
    secrets,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { storage, providers, models, gateway, log };
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

function twoProviders(h: ReturnType<typeof build>): {
  a: { providerId: number; modelId: number };
  b: { providerId: number; modelId: number };
} {
  const a = seedProvider(h, "a");
  const b = seedProvider(h, "b");
  h.storage.setRuntimeSelection(a);
  h.storage.setFailoverSettings({ enabled: true, maxAttempts: 3 });
  h.storage.setFailoverCandidates([{ providerId: b.providerId, modelId: b.modelId }]);
  return { a, b };
}

const REQUEST = {
  messages: [{ role: "user" as const, content: "سلام" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

describe("plan() demotes fresh probe failures (H6)", () => {
  test("the freshness window is exported as 10 minutes", () => {
    expect(PROVIDER_HEALTH_FRESH_MS).toBe(600_000);
  });

  test("(a) fresh-failed primary is demoted: the healthy candidate answers first", async () => {
    await withRoutingOff(async () => {
      const h = build();
      const { a } = twoProviders(h);
      h.storage.setProviderHealth({ providerId: a.providerId, ok: false, message: "down" });
      const res = await h.gateway.complete(REQUEST);
      expect(res.model).toBe("model-b");
      // B was attempted FIRST and answered; A was never contacted.
      expect(h.log).toEqual(["model-b"]);
      h.storage.close();
    });
  });

  test("(a2) a demoted candidate is still tried when the chain reaches it", async () => {
    await withRoutingOff(async () => {
      const h = build({ failModels: new Set(["model-b"]) });
      const { a } = twoProviders(h);
      h.storage.setProviderHealth({ providerId: a.providerId, ok: false, message: "down" });
      const res = await h.gateway.complete(REQUEST);
      // Demotion, not a skip: B leads, fails, and A still serves the turn.
      expect(res.model).toBe("model-a");
      expect(h.log).toEqual(["model-b", "model-a"]);
      h.storage.close();
    });
  });

  test("(b) fresh-failed primary with no other candidate is still attempted", async () => {
    await withRoutingOff(async () => {
      const h = build();
      const a = seedProvider(h, "a");
      h.storage.setRuntimeSelection(a);
      h.storage.setProviderHealth({ providerId: a.providerId, ok: false, message: "down" });
      const res = await h.gateway.complete(REQUEST);
      expect(res.model).toBe("model-a");
      expect(h.log).toEqual(["model-a"]);
      h.storage.close();
    });
  });

  test("(c) a failure row 11 minutes old is stale: original order kept", async () => {
    await withRoutingOff(async () => {
      // The row is stamped with wall-clock now; the gateway's injected
      // clock runs PROVIDER_HEALTH_FRESH_MS + 1 minute ahead of it, so
      // the row's age at plan time is ~11 minutes — past the window.
      const h = build({ now: () => Date.now() + PROVIDER_HEALTH_FRESH_MS + 60_000 });
      const { a } = twoProviders(h);
      h.storage.setProviderHealth({ providerId: a.providerId, ok: false, message: "down" });
      const res = await h.gateway.complete(REQUEST);
      expect(res.model).toBe("model-a");
      expect(h.log).toEqual(["model-a"]);
      h.storage.close();
    });
  });

  test("(d) every candidate fresh-failed: original order kept", async () => {
    await withRoutingOff(async () => {
      const h = build();
      const { a, b } = twoProviders(h);
      h.storage.setProviderHealth({ providerId: a.providerId, ok: false, message: "down" });
      h.storage.setProviderHealth({ providerId: b.providerId, ok: false, message: "down" });
      const res = await h.gateway.complete(REQUEST);
      expect(res.model).toBe("model-a");
      expect(h.log).toEqual(["model-a"]);
      h.storage.close();
    });
  });

  test("(e) a success row — or no row at all — keeps the original order", async () => {
    await withRoutingOff(async () => {
      // Success row on the primary.
      const h1 = build();
      const p1 = twoProviders(h1);
      h1.storage.setProviderHealth({ providerId: p1.a.providerId, ok: true, message: "ok" });
      const r1 = await h1.gateway.complete(REQUEST);
      expect(r1.model).toBe("model-a");
      expect(h1.log).toEqual(["model-a"]);
      h1.storage.close();

      // No health rows anywhere.
      const h2 = build();
      twoProviders(h2);
      const r2 = await h2.gateway.complete(REQUEST);
      expect(r2.model).toBe("model-a");
      expect(h2.log).toEqual(["model-a"]);
      h2.storage.close();
    });
  });
});
