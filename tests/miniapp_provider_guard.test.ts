/**
 * Mini App provider URL guard + honest discovery errors (Phase 2, Worker B).
 *
 * Pins the Phase 1 incident at the API layer: a native Gemini base URL
 * stored under the openai_compatible type must be REFUSED at create,
 * update, and draft-discovery time with code "provider_url_mismatch" and
 * the /openai/ suggestion — while the same URL under the native gemini
 * type, the /openai/ URL under openai_compatible, and unknown custom
 * endpoints are all accepted. Also pins: native templates are creatable
 * (C2), providers.list carries baseUrl + stored probe status/latency
 * (H2), and discovery surfaces the adapter's AiError instead of a
 * generic 502 sentence (H4).
 *
 * Hermetic: real ProviderService / ModelService / Storage (in-memory),
 * stub adapter registry — no network, no real keys.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry, type AdapterConfig } from "../src/ai/adapter_registry";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import type { ProbeResult } from "../src/ai/health";
import { AiError, type CompletionRequest, type CompletionResponse } from "../src/ai/provider";
import type { AIProviderAdapter } from "../src/ai/adapter";
import {
  handleProviderApi,
  ProviderApiError,
  type ProviderApiDeps,
} from "../src/miniapp/api_providers";

const GEMINI_NATIVE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_OPENAI = "https://generativelanguage.googleapis.com/v1beta/openai/";

/** Registry that records create() types and serves a scripted listModels. */
class StubRegistry extends AdapterRegistry {
  public createdTypes: string[] = [];
  constructor(
    private readonly listModelsImpl: () => Promise<{ id: string }[]> = async () => [
      { id: "m1" },
    ],
  ) {
    super();
  }
  override create(type: string, _cfg: AdapterConfig): AIProviderAdapter {
    this.createdTypes.push(type);
    const impl = this.listModelsImpl;
    return {
      name: "stub",
      type: "openai_compatible",
      capabilities: { listModels: true },
      label: "stub",
      complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
        text: "ok",
        model: "m1",
      }),
      listModels: async () => impl(),
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

async function expectApiError(p: Promise<unknown>): Promise<ProviderApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProviderApiError) return e;
    throw e;
  }
  throw new Error("expected a ProviderApiError, but the call succeeded");
}

// ------------------------------------------------------------- the guard ----

describe("provider URL guard — incident reproduction", () => {
  test("creating openai_compatible + native Gemini URL is rejected with code + suggestion", async () => {
    const { deps, storage } = makeDeps();
    const err = await expectApiError(
      handleProviderApi(
        "providers.add",
        {
          kind: "custom",
          label: "Google Gemini",
          adapter: "openai_compatible",
          baseUrl: GEMINI_NATIVE,
          key: "test-key",
        },
        deps,
      ),
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe("provider_url_mismatch");
    expect(err.message).toContain("/openai/");
    expect(err.message).toContain(GEMINI_OPENAI);
    expect(err.suggestion).toBe(GEMINI_OPENAI);
    // Never saved: the incident combo must not reach storage.
    expect(storage.listProviders().length).toBe(0);
    storage.close();
  });

  test("the same URL with adapter gemini is accepted", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "Google Gemini",
        adapter: "gemini",
        baseUrl: GEMINI_NATIVE,
        key: "test-key",
      },
      deps,
    );
    const row = storage.getProvider(res["id"] as number);
    expect(row?.adapter).toBe("gemini");
    expect(row?.baseUrl).toBe(GEMINI_NATIVE);
    storage.close();
  });

  test("the /openai/ URL with openai_compatible is accepted", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "Gemini via OpenAI",
        adapter: "openai_compatible",
        baseUrl: GEMINI_OPENAI,
        key: "test-key",
      },
      deps,
    );
    const row = storage.getProvider(res["id"] as number);
    expect(row?.adapter).toBe("openai_compatible");
    // validateTarget normalizes the stored URL (trailing slash dropped).
    expect(row?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    storage.close();
  });

  test("an unknown custom endpoint is accepted", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "Self hosted",
        baseUrl: "https://api.example.com/v1",
        key: "test-key",
      },
      deps,
    );
    const row = storage.getProvider(res["id"] as number);
    expect(row?.adapter).toBe("openai_compatible");
    expect(row?.baseUrl).toBe("https://api.example.com/v1");
    storage.close();
  });

  test("draft discovery of the incident combo is rejected before any adapter call", async () => {
    const registry = new StubRegistry();
    const { deps, storage } = makeDeps(registry);
    const err = await expectApiError(
      handleProviderApi(
        "models.discoverDraft",
        {
          kind: "custom",
          adapter: "openai_compatible",
          baseUrl: GEMINI_NATIVE,
          key: "test-key",
        },
        deps,
      ),
    );
    expect(err.code).toBe("provider_url_mismatch");
    expect(registry.createdTypes).toEqual([]);
    storage.close();
  });
});

// ------------------------------------------------------------------- C2 ----

describe("native types are creatable", () => {
  test("providers.presets returns ALL templates incl. gemini + anthropic, each with its type", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi("providers.presets", {}, deps);
    const templates = res["templates"] as Record<string, unknown>[];
    const types = templates.map((t) => t["type"]).sort();
    expect(types).toEqual([
      "anthropic",
      "gemini",
      "nine_router",
      "openai_compatible",
    ]);
    const gemini = templates.find((t) => t["type"] === "gemini");
    expect(gemini?.["adapterType"]).toBe("gemini");
    expect(gemini?.["suggestedBaseUrl"]).toBe(GEMINI_NATIVE);
    storage.close();
  });

  test("kind:template creates a provider with the template's adapter type + suggested URL", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      { kind: "template", template: "gemini", key: "test-key" },
      deps,
    );
    const row = storage.getProvider(res["id"] as number);
    expect(row?.adapter).toBe("gemini");
    expect(row?.label).toBe("Google Gemini");
    expect(row?.baseUrl).toBe(GEMINI_NATIVE);
    storage.close();
  });

  test("a preset add naming a template creates it with the template's type", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      { kind: "preset", preset: "anthropic", key: "test-key" },
      deps,
    );
    const row = storage.getProvider(res["id"] as number);
    expect(row?.adapter).toBe("anthropic");
    expect(row?.baseUrl).toBe("https://api.anthropic.com/v1");
    storage.close();
  });
});

// --------------------------------------------------------------- update ----

describe("providers.update guard + active lock (C3/L1)", () => {
  test("changing baseUrl to the incident combo is rejected; a legit change succeeds", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "Editable",
        baseUrl: "https://api.example.com/v1",
        key: "test-key",
      },
      deps,
    );
    const id = res["id"] as number;

    const err = await expectApiError(
      handleProviderApi(
        "providers.update",
        { id, baseUrl: GEMINI_NATIVE },
        deps,
      ),
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe("provider_url_mismatch");
    expect(err.suggestion).toBe(GEMINI_OPENAI);
    // Stored URL untouched.
    expect(storage.getProvider(id)?.baseUrl).toBe("https://api.example.com/v1");

    const ok = await handleProviderApi(
      "providers.update",
      { id, baseUrl: "https://api.openai.com/v1" },
      deps,
    );
    expect(ok["ok"]).toBe(true);
    expect(storage.getProvider(id)?.baseUrl).toBe("https://api.openai.com/v1");
    storage.close();
  });

  test("updating the ACTIVE provider's address surfaces the actionable service message", async () => {
    const { deps, storage, modelSvc } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "Active One",
        baseUrl: "https://api.example.com/v1",
        key: "test-key",
      },
      deps,
    );
    const id = res["id"] as number;
    const model = modelSvc.add({ providerId: id, modelId: "m1", label: "m1" });
    if (!model.ok) throw new Error("model add failed");
    storage.setRuntimeSelection({ providerId: id, modelId: model.data });

    const err = await expectApiError(
      handleProviderApi(
        "providers.update",
        { id, baseUrl: "https://api.openai.com/v1" },
        deps,
      ),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain("activate another provider first");
    storage.close();
  });
});

// ------------------------------------------------------------------- H2 ----

describe("providers.list card data", () => {
  test("items include baseUrl; lastProbe surfaces message, status and real latencyMs", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "Listed",
        baseUrl: "https://api.example.com/v1",
        key: "test-key",
      },
      deps,
    );
    const id = res["id"] as number;
    storage.setProviderHealth({
      providerId: id,
      ok: false,
      message: "The request to the service was invalid (HTTP 404).",
      status: 404,
      latencyMs: 812,
    });

    const list = await handleProviderApi("providers.list", {}, deps);
    const items = list["providers"] as Record<string, any>[];
    const item = items.find((p) => p["id"] === id);
    expect(item?.["baseUrl"]).toBe("https://api.example.com/v1");
    expect(item?.["lastProbe"]).toEqual({
      ok: false,
      atMs: expect.any(Number),
      latencyMs: 812,
      message: "The request to the service was invalid (HTTP 404).",
      status: 404,
    });
    storage.close();
  });

  test("breaker/quarantine surface from health.last() when the source is injected", async () => {
    const { deps, storage } = makeDeps();
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "Unreliable",
        baseUrl: "https://api.example.com/v1",
        key: "test-key",
      },
      deps,
    );
    const id = res["id"] as number;
    deps.health.last = (providerId: number): ProbeResult | undefined =>
      providerId === id
        ? {
            ok: false,
            checkedAt: Date.now(),
            circuit: {
              state: "open",
              consecutiveFailures: 4,
              cooldownMs: 60_000,
              nextRetryAt: 1_760_000_000_000,
            },
            quarantined: true,
          }
        : undefined;

    const list = await handleProviderApi("providers.list", {}, deps);
    const items = list["providers"] as Record<string, any>[];
    const item = items.find((p) => p["id"] === id);
    expect(item?.["breaker"]).toEqual({
      state: "open",
      open: true,
      consecutiveFailures: 4,
      nextRetryAt: 1_760_000_000_000,
    });
    expect(item?.["breakerOpen"]).toBe(true);
    expect(item?.["quarantined"]).toBe(true);
    storage.close();
  });
});

// ------------------------------------------------------------------- H4 ----

describe("honest discovery errors", () => {
  const authRegistry = () =>
    new StubRegistry(async () => {
      throw new AiError("auth", "Key or address was not accepted.", 401);
    });

  test("draft discovery surfaces the adapter's 401 instead of the generic sentence", async () => {
    const registry = authRegistry();
    const { deps, storage } = makeDeps(registry);
    const err = await expectApiError(
      handleProviderApi(
        "models.discoverDraft",
        { kind: "custom", baseUrl: "https://api.example.com/v1", key: "bad-key" },
        deps,
      ),
    );
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("Model discovery failed; check the key or address.");
    storage.close();
  });

  test("saved-provider discovery surfaces the adapter's 401 too", async () => {
    const registry = authRegistry();
    const { deps, storage } = makeDeps(registry);
    const res = await handleProviderApi(
      "providers.add",
      {
        kind: "custom",
        label: "Discoverable",
        baseUrl: "https://api.example.com/v1",
        key: "bad-key",
      },
      deps,
    );
    const err = await expectApiError(
      handleProviderApi(
        "models.discover",
        { providerId: res["id"] as number },
        deps,
      ),
    );
    expect(err.message).toContain("401");
    expect(err.message).not.toContain(
      "Model discovery failed; check the connection or address.",
    );
    storage.close();
  });

  test("draft discovery builds the adapter for the REQUESTED type (gemini)", async () => {
    const registry = new StubRegistry(async () => [{ id: "gemini-2.5-flash" }]);
    const { deps, storage } = makeDeps(registry);
    const res = await handleProviderApi(
      "models.discoverDraft",
      {
        kind: "custom",
        adapter: "gemini",
        baseUrl: GEMINI_NATIVE,
        key: "test-key",
      },
      deps,
    );
    expect(registry.createdTypes).toEqual(["gemini"]);
    const models = res["models"] as Record<string, unknown>[];
    expect(models.map((m) => m["modelId"])).toEqual(["gemini-2.5-flash"]);
    storage.close();
  });
});
