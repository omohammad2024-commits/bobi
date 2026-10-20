/**
 * Probe failure messages keep the HTTP status (H1) and a model-less
 * provider fails fast without a completion call (M2).
 *
 * Before H1, probeMessage() collapsed failures by AiError kind alone, so
 * the incident's Google 404 surfaced as a bare "Service response was
 * invalid." — indistinguishable from a 400. Before M2, probe() sent a
 * completion against an invented model id ("default") for providers with
 * no models, misdiagnosing a config gap as a connection failure.
 *
 * Offline throughout: a recording fake adapter stands in for the network,
 * following the pattern of tests/provider_model_probe.test.ts.
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
import { statusToAiError } from "../src/ai/http_status";
import type { AIProviderAdapter } from "../src/ai/adapter";
import type {
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";

/** Records complete() calls; throws `failWith` (or per-call via failOnCall). */
class RecordingAdapters extends AdapterRegistry {
  completedModels: string[] = [];
  failWith: unknown;
  /** 1-based call number from which complete() starts throwing failWith. */
  failFromCall = 1;

  override create(_type: string, _cfg: AdapterConfig): AIProviderAdapter {
    const self = this;
    return {
      name: "fake",
      type: "openai_compatible",
      label: "fake",
      capabilities: {},
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        self.completedModels.push(req.model);
        if (self.failWith !== undefined && self.completedModels.length >= self.failFromCall) {
          throw self.failWith;
        }
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
  const secrets = new ProviderSecretStore("probe-message-test-key");
  const adapters = new RecordingAdapters();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const health = new ProviderHealthService(storage, providers, secrets, adapters);
  return { storage, providers, models, health, adapters };
}

function makeProvider(h: Harness, opts: { withModel?: boolean } = {}): number {
  const created = h.providers.create({
    label: "Test provider",
    adapter: "openai_compatible",
    baseUrl: "https://api.invalid.example/v1",
    apiKey: "sk-test-credential",
  });
  if (!created.ok) throw new Error("provider create failed");
  if (opts.withModel !== false) {
    const m = h.models.add({
      providerId: created.data,
      modelId: "m1",
      label: "M1",
    });
    if (!m.ok) throw new Error("model add failed");
    h.models.setDefault(m.data);
  }
  return created.data;
}

describe("probe failure messages preserve the HTTP status", () => {
  test("probe() on a 404 names the status and persists status + latency", async () => {
    const h = harness();
    const providerId = makeProvider(h);
    h.adapters.failWith = statusToAiError(404);

    const result = await h.health.probe(providerId);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("404");
    expect(result.message).toBe("Service response was invalid (HTTP 404).");
    expect(result.status).toBe(404);
    // The stored health record carries the same detail (M3 fields).
    const stored = h.storage.getProviderHealth(providerId);
    expect(stored?.status).toBe(404);
    expect(typeof stored?.latencyMs).toBe("number");
    expect(h.health.last(providerId)?.status).toBe(404);
    h.storage.close();
  });

  test("probe() on a 500 names the status too", async () => {
    const h = harness();
    const providerId = makeProvider(h);
    h.adapters.failWith = statusToAiError(500);

    const result = await h.health.probe(providerId);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("(HTTP 500)");
    h.storage.close();
  });

  test("probeModel() ping stage failure names the status", async () => {
    const h = harness();
    const providerId = makeProvider(h);
    h.adapters.failWith = statusToAiError(404);

    const result = await h.health.probeModel(providerId, "m1");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("404");
    expect(result.ping?.ok).toBe(false);
    expect(result.ping?.error).toContain("404");
    h.storage.close();
  });

  test("probeModel() realistic stage failure names the status", async () => {
    const h = harness();
    const providerId = makeProvider(h);
    // Ping (call 1) succeeds; the realistic turn (call 2) gets the 404.
    h.adapters.failWith = statusToAiError(404);
    h.adapters.failFromCall = 2;

    const result = await h.health.probeModel(providerId, "m1");

    expect(result.ok).toBe(false);
    expect(result.ping?.ok).toBe(true);
    expect(result.real?.ok).toBe(false);
    expect(result.real?.error).toContain("404");
    expect(result.message).toContain("404");
    h.storage.close();
  });

  test("statusToAiError names the status for the 400/404/422 class", () => {
    for (const status of [400, 404, 422]) {
      const err = statusToAiError(status);
      expect(err.kind).toBe("invalid_response");
      expect(err.message).toBe(
        `The request to the service was invalid (HTTP ${status}).`,
      );
    }
  });
});

describe("probe() with no model configured", () => {
  test("fails fast with the no-model message and sends no completion", async () => {
    const h = harness();
    const providerId = makeProvider(h, { withModel: false });

    const result = await h.health.probe(providerId);

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "No model configured — discover or add a model first, then test.",
    );
    // The whole point: no completion was attempted against an invented id.
    expect(h.adapters.completedModels).toEqual([]);
    // Still recorded as provider health, so the row explains itself.
    expect(h.storage.getProviderHealth(providerId)?.message).toBe(result.message);
    h.storage.close();
  });
});
