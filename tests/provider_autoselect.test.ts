import { describe, expect, test } from "bun:test";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import { Storage } from "../src/storage/storage";

function withKey(): ProviderSecretStore {
  return new ProviderSecretStore("autoselect-test-key");
}

function seeded() {
  const storage = Storage.open(":memory:");
  const providers = new ProviderService(storage, withKey(), new AdapterRegistry());
  const models = new ModelService(storage);
  return { storage, providers, models };
}

function addProviderWithModel(
  providers: ProviderService,
  models: ModelService,
  label: string,
): { providerId: number; modelId: number } {
  const created = providers.create({
    label,
    adapter: "openai_compatible",
    baseUrl: "https://api.example.invalid/v1",
    apiKey: "sk-test",
  });
  if (!created.ok) throw new Error("create failed: " + created.message);
  const added = models.add({ providerId: created.data, modelId: "test-model", label: "Test" });
  if (!added.ok) throw new Error("model add failed");
  return { providerId: created.data, modelId: added.data };
}

describe("provider auto-selection", () => {
  test("ensureSelection activates the first usable provider when none is selected", () => {
    const { storage, providers, models } = seeded();
    const { providerId, modelId } = addProviderWithModel(providers, models, "P1");
    expect(storage.getRuntimeSettings().activeProviderId).toBeNull();
    const sel = providers.ensureSelection();
    expect(sel).toEqual({ providerId, modelId });
    expect(storage.getRuntimeSettings().activeProviderId).toBe(providerId);
    storage.close();
  });

  test("ensureSelection never overrides an existing valid selection", () => {
    const { storage, providers, models } = seeded();
    const first = addProviderWithModel(providers, models, "P1");
    const second = addProviderWithModel(providers, models, "P2");
    storage.setRuntimeSelection({ providerId: first.providerId, modelId: first.modelId });
    const sel = providers.ensureSelection();
    expect(sel).toEqual({ providerId: first.providerId, modelId: first.modelId });
    expect(second.providerId).not.toBe(first.providerId);
    storage.close();
  });

  test("ensureSelection skips providers without credentials", () => {
    const { storage, providers, models } = seeded();
    // Provider without a key.
    const created = providers.create({
      label: "NoKey",
      adapter: "openai_compatible",
      baseUrl: "https://api.example.invalid/v1",
    });
    if (!created.ok) throw new Error("create failed");
    models.add({ providerId: created.data, modelId: "m", label: "M" });
    // Provider with a key.
    const good = addProviderWithModel(providers, models, "Good");
    const sel = providers.ensureSelection();
    expect(sel?.providerId).toBe(good.providerId);
    storage.close();
  });

  test("ensureSelection returns undefined when nothing usable exists", () => {
    const { storage, providers } = seeded();
    expect(providers.ensureSelection()).toBeUndefined();
    storage.close();
  });
});

describe("selection problem diagnostics", () => {
  function gatewayFor(storage: Storage): AiGateway {
    return new AiGateway({
      storage,
      adapters: new AdapterRegistry(),
      secrets: withKey(),
    });
  }

  test("says plainly when nothing was ever selected", () => {
    const { storage } = seeded();
    const msg = gatewayFor(storage).describeSelectionProblem();
    expect(msg).toContain("هیچ پروایدر");
    storage.close();
  });

  test("names the provider whose credential was deleted", () => {
    const { storage, providers, models } = seeded();
    const { providerId, modelId } = addProviderWithModel(providers, models, "9Router");
    storage.setRuntimeSelection({ providerId, modelId });
    providers.clearCredential(providerId);
    const msg = gatewayFor(storage).describeSelectionProblem();
    expect(msg).toContain("9Router");
    expect(msg).toContain("اعتبارنامه");
    storage.close();
  });

  test("names the provider that was disabled", () => {
    const { storage, providers, models } = seeded();
    const { providerId, modelId } = addProviderWithModel(providers, models, "DeepSeek");
    storage.setRuntimeSelection({ providerId, modelId });
    // Bypass the service guard (it refuses to disable the active provider) to
    // simulate a selection that went stale out-of-band.
    storage.setProviderEnabled(providerId, false);
    const msg = gatewayFor(storage).describeSelectionProblem();
    expect(msg).toContain("DeepSeek");
    expect(msg).toContain("غیرفعال");
    storage.close();
  });
});
