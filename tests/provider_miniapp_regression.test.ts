/**
 * Provider system regression tests (Worker A — Operation: Solid Foundation).
 *
 * Covers the flows the audit found bugs in, end to end through the real
 * ProviderService / ModelService / Storage with handleProviderApi:
 *
 *  1. Cloudflare `{ACCOUNT_ID}` placeholder: the backend must honor the
 *     frontend's placeholder-resolved `baseUrl` in `providers.add`
 *     (regression for the bug fixed in 3a3175f, where the raw preset
 *     template was always used instead).
 *  2. The local-target exception (`allowLocal`) must be threaded to the
 *     adapter by the health probe and by mini-app model discovery — the
 *     runtime gateway already did, but these two paths dropped it, so a
 *     local provider stayed "unreachable" right after being allowed.
 *  3. `autoSelected` reporting must reflect the selection that actually
 *     resulted — including the self-heal case where the previous selection
 *     named a provider whose credential was cleared.
 *  4. `providers.update` must refuse a duplicate label, like `providers.add`.
 *  5. The 9Router add flow requires a key and a model, and stores the
 *     `nine_router` adapter.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry, type AdapterConfig } from "../src/ai/adapter_registry";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService, type ProbeResult } from "../src/ai/health";
import {
  handleProviderApi,
  ProviderApiError,
  type ProviderApiDeps,
} from "../src/miniapp/api_providers";
import type { AIProviderAdapter } from "../src/ai/adapter";
import type { CompletionRequest, CompletionResponse } from "../src/ai/provider";

/** Adapter registry that records every create() config instead of calling a service. */
class RecordingRegistry extends AdapterRegistry {
  public calls: AdapterConfig[] = [];
  constructor(private readonly models: { id: string }[] = [{ id: "m1" }]) {
    super();
  }
  override create(_type: string, cfg: AdapterConfig): AIProviderAdapter {
    this.calls.push(cfg);
    const models = this.models;
    return {
      name: "ai",
      type: "openai_compatible",
      capabilities: { listModels: true },
      label: "recording",
      complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
        text: "ok",
        model: "m1",
      }),
      listModels: async () => models,
    };
  }
}

function makeDeps(adapters?: AdapterRegistry): {
  deps: ProviderApiDeps;
  storage: Storage;
  providerSvc: ProviderService;
  modelSvc: ModelService;
} {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("test-master-key");
  const registry = adapters ?? new AdapterRegistry();
  const providerSvc = new ProviderService(storage, secrets, registry);
  const modelSvc = new ModelService(storage);
  const health = {
    probe: async (_id: number): Promise<ProbeResult> => ({
      ok: true,
      checkedAt: Date.now(),
    }),
    probeModel: async (_id: number, _modelId: string): Promise<ProbeResult> => ({
      ok: true,
      checkedAt: Date.now(),
    }),
  };
  const deps: ProviderApiDeps = {
    storage,
    providerSvc,
    modelSvc,
    health,
    ...(adapters !== undefined ? { adapters } : {}),
  };
  return { deps, storage, providerSvc, modelSvc };
}

const CF_RESOLVED = "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1";

// ------------------------------------------------------------------ add ----

describe("providers.add placeholder handling", () => {
  test("a preset add honors the frontend's placeholder-resolved baseUrl", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "preset",
        preset: "cloudflare",
        baseUrl: CF_RESOLVED,
        key: "cf-key",
      },
      deps,
    );
    const id = res["id"] as number;
    expect(id).toBeGreaterThan(0);
    // The stored provider must use the resolved URL, not the raw template.
    const row = storage.getProvider(id);
    expect(row?.baseUrl).toBe(CF_RESOLVED);
    expect(row?.baseUrl).not.toContain("{ACCOUNT_ID}");
    // The preset's suggested model is added as the starting model.
    expect(res["modelId"]).toBeGreaterThan(0);
    const models = storage.listModels(id);
    expect(models.map((m) => m.modelId)).toContain("@cf/meta/llama-3.1-8b-instruct");
    storage.close();
  });

  test("an override that still carries the placeholder is refused", async () => {
    const { deps, storage } = makeDeps();
    const err = await handleProviderApi(
      "providers.add",
      {
        kind: "preset",
        preset: "cloudflare",
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1",
        key: "cf-key",
      },
      deps,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).status).toBe(400);
    expect(String((err as Error).message)).toContain("ACCOUNT_ID");
    expect(storage.listProviders()).toHaveLength(0);
    storage.close();
  });

  test("discoverDraft uses the resolved baseUrl for a placeholder preset", async () => {
    const recording = new RecordingRegistry([{ id: "model-a" }, { id: "model-b" }]);
    const { deps, storage } = makeDeps(recording);
    const res = await handleProviderApi(
      "models.discoverDraft",
      {
        kind: "preset",
        preset: "cloudflare",
        baseUrl: CF_RESOLVED,
        key: "cf-key",
      },
      deps,
    );
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.baseUrl).toBe(CF_RESOLVED);
    expect((res["models"] as { modelId: string }[]).map((m) => m.modelId)).toEqual([
      "model-a",
      "model-b",
    ]);
    storage.close();
  });
});

// ------------------------------------------------------------ allowLocal ----

describe("local-target exception threading", () => {
  test("models.discover honors the provider's allowLocal grant", async () => {
    const recording = new RecordingRegistry();
    const { deps, storage, providerSvc } = makeDeps(recording);
    const created = providerSvc.create({
      label: "Local",
      adapter: "openai_compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "k",
    });
    expect(created.ok).toBe(true);
    const id = (created as { ok: true; data: number }).data;
    providerSvc.setAllowLocal(id, true);

    const res = await handleProviderApi("models.discover", { providerId: id }, deps);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.allowLocalTargets).toBe(true);
    expect((res["models"] as unknown[])).toHaveLength(1);
    storage.close();
  });

  test("models.discover does not grant the exception when it was never set", async () => {
    const recording = new RecordingRegistry();
    const { deps, storage, providerSvc } = makeDeps(recording);
    const created = providerSvc.create({
      label: "Remote",
      adapter: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
    });
    const id = (created as { ok: true; data: number }).data;

    await handleProviderApi("models.discover", { providerId: id }, deps);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.allowLocalTargets).toBeUndefined();
    storage.close();
  });

  test("the health probe honors the provider's allowLocal grant", async () => {
    const recording = new RecordingRegistry();
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore("test-master-key");
    const providerSvc = new ProviderService(storage, secrets, new AdapterRegistry());
    const health = new ProviderHealthService(storage, providerSvc, secrets, recording);

    const mk = (label: string, allowLocal: boolean): number => {
      const created = providerSvc.create({
        label,
        adapter: "openai_compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKey: "k",
      });
      const id = (created as { ok: true; data: number }).data;
      if (allowLocal) providerSvc.setAllowLocal(id, true);
      // probe() fails fast without a model (M2); give each provider one so
      // the probe reaches adapter creation, which is what this test records.
      const modelSvc = new ModelService(storage);
      const m = modelSvc.add({ providerId: id, modelId: "m1", label: "M1" });
      if (!m.ok) throw new Error("model add failed");
      modelSvc.setDefault(m.data);
      return id;
    };

    const localId = mk("Local", true);
    const plainId = mk("Plain", false);

    const localRes = await health.probe(localId);
    expect(localRes.ok).toBe(true);
    expect(recording.calls[0]?.allowLocalTargets).toBe(true);

    await health.probe(plainId);
    expect(recording.calls[1]?.allowLocalTargets).toBeUndefined();
    storage.close();
  });
});

// ---------------------------------------------------------- auto-select ----

describe("autoSelected reporting", () => {
  async function addUsable(
    deps: ProviderApiDeps,
    label: string,
  ): Promise<{ id: number; autoSelected?: { providerId: number; modelId: number } }> {
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label,
        baseUrl: "https://api.example.com/v1",
        key: "k",
        model: "m",
      },
      deps,
    );
    const auto = res["autoSelected"] as { providerId: number; modelId: number } | undefined;
    return { id: res["id"] as number, ...(auto !== undefined ? { autoSelected: auto } : {}) };
  }

  test("a fresh add reports the new provider as auto-selected", async () => {
    const { deps, storage } = makeDeps();
    const { id, autoSelected } = await addUsable(deps, "First");
    expect(autoSelected).toBeDefined();
    const sel = autoSelected as { providerId: number; modelId: number };
    expect(sel.providerId).toBe(id);
    const settings = storage.getRuntimeSettings();
    expect(settings.activeProviderId).toBe(id);
    expect(settings.activeModelId).toBe(sel.modelId);
    storage.close();
  });

  test("adding while a valid selection exists reports nothing", async () => {
    const { deps, storage } = makeDeps();
    const first = await addUsable(deps, "First");
    expect(first.autoSelected).toBeDefined();
    const second = await addUsable(deps, "Second");
    // The existing valid selection is untouched and unreported.
    expect(second.autoSelected).toBeUndefined();
    expect(storage.getRuntimeSettings().activeProviderId).toBe(first.id);
    storage.close();
  });

  test("a self-heal after the active credential was cleared is reported", async () => {
    const { deps, storage } = makeDeps();
    const first = await addUsable(deps, "First");
    await addUsable(deps, "Second");
    // Containment: the owner clears the active provider's key.
    const cleared = await handleProviderApi(
      "providers.clearKey",
      { id: first.id, confirm: true },
      deps,
    );
    expect(cleared["ok"]).toBe(true);
    // Adding another usable provider heals the selection onto it, and the
    // response says so instead of staying silent about the switch.
    const third = await addUsable(deps, "Third");
    expect(third.autoSelected).toBeDefined();
    expect(third.autoSelected?.providerId).toBe(third.id);
    expect(storage.getRuntimeSettings().activeProviderId).toBe(third.id);
    storage.close();
  });
});

// --------------------------------------------------------------- update ----

describe("providers.update", () => {
  test("renaming onto another provider's label is refused", async () => {
    const { deps, storage } = makeDeps();
    const add = (label: string) =>
      handleProviderApi(
        "providers.add",
        { kind: "custom", label, baseUrl: "https://api.example.com/v1" },
        deps,
      );
    const a = (await add("Alpha"))["id"] as number;
    await add("Beta");
    const err = await handleProviderApi(
      "providers.update",
      { id: a, label: "beta" },
      deps,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).status).toBe(400);
    expect(storage.getProvider(a)?.label).toBe("Alpha");
    storage.close();
  });

  test("renaming to its own label (case-insensitive) is allowed", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      { kind: "custom", label: "Alpha", baseUrl: "https://api.example.com/v1" },
      deps,
    );
    const id = res["id"] as number;
    const ok = await handleProviderApi("providers.update", { id, label: "ALPHA" }, deps);
    expect(ok["ok"]).toBe(true);
    expect(storage.getProvider(id)?.label).toBe("ALPHA");
    storage.close();
  });
});

// ------------------------------------------------------------- 9router ----

describe("9Router add flow", () => {
  test("a key and a model are both required", async () => {
    const { deps, storage } = makeDeps();
    for (const body of [
      { kind: "nine_router", label: "R", baseUrl: "https://router.example.com/v1" },
      {
        kind: "nine_router",
        label: "R",
        baseUrl: "https://router.example.com/v1",
        model: "m",
      },
    ]) {
      const err = await handleProviderApi("providers.add", body, deps).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderApiError);
      expect((err as ProviderApiError).status).toBe(400);
    }
    expect(storage.listProviders()).toHaveLength(0);
    storage.close();
  });

  test("a complete 9Router add stores the nine_router adapter and its model", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "nine_router",
        label: "R",
        baseUrl: "https://router.example.com/v1",
        key: "rk",
        model: "router-model",
      },
      deps,
    );
    const id = res["id"] as number;
    const row = storage.getProvider(id);
    expect(row?.adapter).toBe("nine_router");
    expect(storage.listModels(id).map((m) => m.modelId)).toContain("router-model");
    // The provider is usable, so the fresh add auto-selects it.
    expect((res["autoSelected"] as { providerId: number }).providerId).toBe(id);
    storage.close();
  });
});

// ------------------------------------------------- key / active lifecycle ----

describe("key and activation lifecycle", () => {
  test("setKey then clearKey is two-step and never leaks the key", async () => {
    const { deps } = makeDeps();
    const added = await handleProviderApi(
      "providers.add",
      { kind: "custom", label: "K", baseUrl: "https://api.example.com/v1" },
      deps,
    );
    const id = added["id"] as number;

    const set = await handleProviderApi("providers.setKey", { id, key: "sk-live" }, deps);
    expect(set["keyPresent"]).toBe(true);
    expect(JSON.stringify(set)).not.toContain("sk-live");

    const listed = (await handleProviderApi("providers.list", {}, deps))["providers"] as {
      id: number;
      keyPresent: boolean;
      keyHint: string | null;
    }[];
    const view = listed.find((p) => p.id === id);
    expect(view?.keyPresent).toBe(true);
    expect(view?.keyHint).toBe("••••live");
    expect(JSON.stringify(listed)).not.toContain("sk-live");

    // Clearing is two-step.
    const first = await handleProviderApi("providers.clearKey", { id }, deps);
    expect(first["needsConfirm"]).toBe(true);
    const done = await handleProviderApi("providers.clearKey", { id, confirm: true }, deps);
    expect(done["keyPresent"]).toBe(false);
  });

  test("setActive refuses a provider without a credential and probes on success", async () => {
    const { deps } = makeDeps();
    const added = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "N",
        baseUrl: "https://api.example.com/v1",
        key: "k",
        model: "m",
      },
      deps,
    );
    const id = added["id"] as number;
    await handleProviderApi("providers.clearKey", { id, confirm: true }, deps);

    const err = await handleProviderApi("providers.setActive", { id }, deps).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderApiError);
    expect((err as ProviderApiError).status).toBe(400);

    await handleProviderApi("providers.setKey", { id, key: "k2" }, deps);
    const ok = await handleProviderApi("providers.setActive", { id }, deps);
    expect(ok["ok"]).toBe(true);
    expect(ok["providerId"]).toBe(id);
    // Probe-on-select ran and reported inline.
    expect((ok["probe"] as { ok: boolean }).ok).toBe(true);
  });

  test("disabling or deleting the active provider is refused", async () => {
    const { deps } = makeDeps();
    const added = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "A",
        baseUrl: "https://api.example.com/v1",
        key: "k",
        model: "m",
      },
      deps,
    );
    const id = added["id"] as number;
    expect((added["autoSelected"] as { providerId: number }).providerId).toBe(id);

    for (const action of ["providers.toggle", "providers.delete"] as const) {
      const params =
        action === "providers.toggle"
          ? { id, enabled: false }
          : { id, confirm: true };
      const err = await handleProviderApi(action, params, deps).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProviderApiError);
      expect((err as ProviderApiError).status).toBe(400);
    }
  });
});
