/**
 * H1: the provider-level Test (ProviderProbeService.probe) is the honest
 * two-stage probe — ping + realistic turn against the provider's DEFAULT
 * model, with the combined outcome recorded as provider health. Before
 * this, probe() was ping-only, so a provider that answered a 16-token
 * postcard but returned empty on real turns still showed green.
 *
 * Also covered: probeModel still never writes provider health, and the
 * miniapp's models.setActive follow-up probe targets the ACTIVATED model
 * (probeModel), not the provider default (probe).
 *
 * Offline throughout: a scripted fake adapter stands in for the network,
 * following the harness pattern of tests/provider_model_probe.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import {
  AdapterRegistry,
  type AdapterConfig,
} from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderProbeService, type ProbeResult } from "../src/ai/provider_probe";
import { statusToAiError } from "../src/ai/http_status";
import { handleProviderApi, type ProviderApiDeps } from "../src/miniapp/api_providers";
import type { AIProviderAdapter } from "../src/ai/adapter";
import type {
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";

/**
 * Scripted fake adapters. The ping stage is the only request capped at 16
 * tokens, so complete() tells the stages apart by maxTokens: ping answers
 * (or throws pingError); the realistic stage answers realText — or an
 * EMPTY response when realEmpty is set (the APInex failure mode). With
 * useStream, the realistic stage streams instead.
 */
class ScriptedAdapters extends AdapterRegistry {
  requests: CompletionRequest[] = [];
  pingError: unknown;
  realText = "ساعت تهران الان ۱۲:۰۰ است.";
  realEmpty = false;
  useStream = false;

  override create(_type: string, _cfg: AdapterConfig): AIProviderAdapter {
    const self = this;
    const adapter: AIProviderAdapter = {
      name: "fake",
      type: "openai_compatible",
      label: "fake",
      capabilities: {},
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        self.requests.push(req);
        if (req.maxTokens === 16) {
          if (self.pingError !== undefined) throw self.pingError;
          return { text: "pong", model: req.model };
        }
        if (self.realEmpty) return { text: "", model: req.model };
        return { text: self.realText, model: req.model };
      },
    };
    if (self.useStream) {
      adapter.completeStream = async function* (req: CompletionRequest) {
        self.requests.push(req);
        yield { type: "text" as const, delta: self.realText };
        yield {
          type: "end" as const,
          text: self.realText,
          model: req.model,
          toolCalls: [],
        };
      };
    }
    return adapter;
  }
}

interface Harness {
  storage: Storage;
  providers: ProviderService;
  models: ModelService;
  health: ProviderProbeService;
  adapters: ScriptedAdapters;
}

function harness(): Harness {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("probe-two-stage-test-key");
  const adapters = new ScriptedAdapters();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const health = new ProviderProbeService(storage, providers, secrets, adapters);
  return { storage, providers, models, health, adapters };
}

/** A provider whose DEFAULT model is "default-model", plus "other-model". */
function providerWithTwoModels(h: Harness): { providerId: number } {
  const created = h.providers.create({
    label: "Test provider",
    adapter: "openai_compatible",
    baseUrl: "https://api.invalid.example/v1",
    apiKey: "sk-test-credential",
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

describe("probe() runs the honest two-stage test (H1)", () => {
  test("(a) ping answers but the realistic stage is EMPTY → probe fails and records it", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);
    h.adapters.realEmpty = true;

    const result = await h.health.probe(providerId);

    expect(result.ok).toBe(false);
    // Both stages ran, both against the provider's DEFAULT model.
    expect(h.adapters.requests.map((r) => r.model)).toEqual([
      "default-model",
      "default-model",
    ]);
    expect(result.ping?.ok).toBe(true);
    expect(result.real?.ok).toBe(false);
    // The message names the real-stage failure, not a generic failure.
    expect(result.message).toContain("empty response");
    expect(result.real?.error).toContain("empty response");
    // The combined outcome is what provider health records.
    const stored = h.storage.getProviderHealth(providerId);
    expect(stored?.ok).toBe(false);
    expect(stored?.message).toBe(result.message);
    h.storage.close();
  });

  test("(b) healthy adapter → probe ok with both stages ok and latency recorded", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);
    h.adapters.useStream = true;

    const result = await h.health.probe(providerId);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Connection succeeded.");
    expect(result.ping?.ok).toBe(true);
    expect(result.real?.ok).toBe(true);
    expect(result.real?.detail).toBe("stream");
    expect(typeof result.latencyMs).toBe("number");
    const stored = h.storage.getProviderHealth(providerId);
    expect(stored?.ok).toBe(true);
    expect(typeof stored?.latencyMs).toBe("number");
    h.storage.close();
  });

  test("(c) ping-stage failure → realistic stage NOT attempted, status recorded", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);
    h.adapters.pingError = statusToAiError(404);

    const result = await h.health.probe(providerId);

    expect(result.ok).toBe(false);
    // Exactly one request: a provider that cannot answer the postcard is
    // not billed for the full simulation.
    expect(h.adapters.requests.length).toBe(1);
    expect(result.ping?.ok).toBe(false);
    expect(result.real).toBeUndefined();
    // The failing stage's HTTP status is threaded to the top level and
    // into the stored health row, as probe() has always recorded it.
    expect(result.status).toBe(404);
    expect(result.message).toBe("Service response was invalid (HTTP 404).");
    const stored = h.storage.getProviderHealth(providerId);
    expect(stored?.ok).toBe(false);
    expect(stored?.status).toBe(404);
    h.storage.close();
  });

  test("(d) probeModel still does NOT write provider health", async () => {
    const h = harness();
    const { providerId } = providerWithTwoModels(h);

    const result = await h.health.probeModel(providerId, "other-model");

    expect(result.ok).toBe(true);
    expect(result.ping?.ok).toBe(true);
    expect(result.real?.ok).toBe(true);
    expect(h.storage.getProviderHealth(providerId)).toBeUndefined();
    h.storage.close();
  });
});

describe("models.setActive probes the activated model (H1)", () => {
  test("(e) the follow-up probe is probeModel(providerId, activated modelId), never probe()", async () => {
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore("probe-two-stage-test-key");
    const adapters = new AdapterRegistry();
    const providerSvc = new ProviderService(storage, secrets, adapters);
    const modelSvc = new ModelService(storage);
    const calls: { method: string; args: unknown[] }[] = [];
    const health = {
      probe: async (providerId: number): Promise<ProbeResult> => {
        calls.push({ method: "probe", args: [providerId] });
        return { ok: true, checkedAt: Date.now(), message: "provider ok" };
      },
      probeModel: async (
        providerId: number,
        modelId: string,
      ): Promise<ProbeResult> => {
        calls.push({ method: "probeModel", args: [providerId, modelId] });
        return {
          ok: true,
          checkedAt: Date.now(),
          message: `model ${modelId} ok`,
        };
      },
    };
    const deps: ProviderApiDeps = { storage, providerSvc, modelSvc, health };

    const created = providerSvc.create({
      label: "Test provider",
      adapter: "openai_compatible",
      baseUrl: "https://api.invalid.example/v1",
      apiKey: "sk-test-credential",
    });
    if (!created.ok) throw new Error("provider create failed");
    const providerId = created.data;
    const def = modelSvc.add({
      providerId,
      modelId: "default-model",
      label: "Default model",
    });
    if (!def.ok) throw new Error("default model add failed");
    modelSvc.setDefault(def.data);
    const other = modelSvc.add({
      providerId,
      modelId: "other-model",
      label: "Other model",
    });
    if (!other.ok) throw new Error("other model add failed");

    const out = await handleProviderApi(
      "models.setActive",
      { id: other.data },
      deps,
    );

    expect(out["ok"]).toBe(true);
    // Exactly one probe, aimed at the ACTIVATED model — the provider's
    // default ("default-model") is never what gets vouched for here.
    expect(calls).toEqual([
      { method: "probeModel", args: [providerId, "other-model"] },
    ]);
    const probe = out["probe"] as Record<string, unknown>;
    expect(probe["ok"]).toBe(true);
    expect(probe["message"]).toBe("model other-model ok");
    storage.close();
  });
});
