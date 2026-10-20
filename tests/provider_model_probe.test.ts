/**
 * Per-model probe (ProviderHealthService.probeModel).
 *
 * The panel's model-row "Test" button must verify ONE specific model with a
 * real completion — the one in the row, not the provider's default — and a
 * model test must never touch the provider-level health record. Everything
 * here runs offline: a recording fake adapter stands in for the network.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import {
  AdapterRegistry,
  type AdapterConfig,
} from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { AiError } from "../src/ai/provider";
import { handleProviderApi, type ProviderApiDeps } from "../src/miniapp/api_providers";
import type {
  AIProviderAdapter,
} from "../src/ai/adapter";
import type {
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";

/** Records which model id complete() was asked for, on every call. */
class RecordingAdapters extends AdapterRegistry {
  completedModels: string[] = [];
  /** When set, complete() throws this instead of answering. */
  failWith: unknown;

  override create(_type: string, _cfg: AdapterConfig): AIProviderAdapter {
    const self = this;
    return {
      name: "fake",
      type: "openai_compatible",
      label: "fake",
      capabilities: {},
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        self.completedModels.push(req.model);
        if (self.failWith !== undefined) throw self.failWith;
        return { text: "pong", model: req.model };
      },
    };
  }
}

interface Harness {
  storage: Storage;
  providers: ProviderService;
  models: ModelService;
  health: ProviderHealthService;
  adapters: RecordingAdapters;
}

function harness(): Harness {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("probe-model-test-key");
  const adapters = new RecordingAdapters();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const health = new ProviderHealthService(storage, providers, secrets, adapters);
  return { storage, providers, models, health, adapters };
}

/**
 * A provider whose DEFAULT model is "default-model", plus a second model
 * "other-model" that a per-model test can target instead.
 */
function providerWithTwoModels(
  h: Harness,
  opts: { withKey?: boolean } = {},
): { providerId: number } {
  const created = h.providers.create({
    label: "Test provider",
    adapter: "openai_compatible",
    baseUrl: "https://api.invalid.example/v1",
    ...(opts.withKey === false ? {} : { apiKey: "sk-test-credential" }),
  });
  if (!created.ok) throw new Error("provider create failed");
  const providerId = created.data;
  const def = h.models.add({
    providerId,
    modelId: "default-model",
    label: "Default model",
  });
  if (!def.ok) throw new Error("default model add failed");
  h.models.setDefault(def.data);
  const other = h.models.add({
    providerId,
    modelId: "other-model",
    label: "Other model",
  });
  if (!other.ok) throw new Error("other model add failed");
  return { providerId };
}

describe("ProviderHealthService.probeModel", () => {
  test("probes the requested model, not the provider default", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);

    const result = await h.health.probeModel(providerId, "other-model");

    expect(result.ok).toBe(true);
    // The completion must name the requested model exactly once, and never
    // fall back to the provider's default.
    expect(h.adapters.completedModels).toEqual(["other-model"]);
  });

  test("an unknown model id fails without any request", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);

    const result = await h.health.probeModel(providerId, "no-such-model");

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Model not found for this provider.");
    expect(h.adapters.completedModels).toEqual([]);
  });

  test("a missing credential fails without any request", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h, { withKey: false });

    const result = await h.health.probeModel(providerId, "other-model");

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Credential is not set.");
    expect(h.adapters.completedModels).toEqual([]);
  });

  test("a model test never writes provider health", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);

    expect(h.storage.getProviderHealth(providerId)).toBeUndefined();

    const ok = await h.health.probeModel(providerId, "other-model");
    expect(ok.ok).toBe(true);
    // Even after a successful model test, the provider-level record is
    // untouched: only probe() writes it.
    expect(h.storage.getProviderHealth(providerId)).toBeUndefined();

    // Sanity: probe() itself DOES record, so the comparison above is real.
    const providerProbe = await h.health.probe(providerId);
    expect(providerProbe.ok).toBe(true);
    expect(h.storage.getProviderHealth(providerId)).toBeDefined();
  });

  test("a failing model reports the safe mapped message", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);
    h.adapters.failWith = new AiError("quota", "internal detail must not leak");

    const result = await h.health.probeModel(providerId, "other-model");

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Service rate limit is full.");
    expect(result.message).not.toContain("internal detail");
    expect(h.storage.getProviderHealth(providerId)).toBeUndefined();
  });
});

describe("models.test endpoint", () => {
  function depsFor(h: Harness): ProviderApiDeps {
    return {
      storage: h.storage,
      providerSvc: h.providers,
      modelSvc: h.models,
      health: h.health,
    };
  }

  test("returns ok + latency for a real model test", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);

    const out = await handleProviderApi(
      "models.test",
      { providerId, modelId: "other-model" },
      depsFor(h),
    );

    expect(out["ok"]).toBe(true);
    expect(typeof out["latencyMs"]).toBe("number");
    expect(out["atMs"]).toBeGreaterThan(0);
    expect(h.adapters.completedModels).toEqual(["other-model"]);
  });

  test("an unknown model comes back ok:false with the safe message", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);

    const out = await handleProviderApi(
      "models.test",
      { providerId, modelId: "ghost" },
      depsFor(h),
    );

    expect(out["ok"]).toBe(false);
    expect(out["message"]).toBe("Model not found for this provider.");
  });

  test("missing params are rejected", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);

    await expect(
      handleProviderApi("models.test", { providerId }, depsFor(h)),
    ).rejects.toThrow("Model ID is required.");
    await expect(
      handleProviderApi("models.test", { modelId: "other-model" }, depsFor(h)),
    ).rejects.toThrow("Invalid provider ID.");
  });
});
