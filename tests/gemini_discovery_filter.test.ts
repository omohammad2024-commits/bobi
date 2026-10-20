/**
 * Gemini discovery filter + stale-default repair (the `aqa` incident).
 *
 * The owner added a native Gemini provider correctly — Google
 * authenticated fine — but discovery imported EVERY model Google lists
 * (aqa, embedding, imagen, …) and the provider's default landed on
 * `aqa`, a non-chat model whose generateContent call 404s. Two fixes:
 *
 *  1. The Gemini adapter's listModels only returns models whose
 *     supportedGenerationMethods include generateContent (entries with
 *     no methods field at all are kept — absence of metadata is not
 *     incapability). Every discovery surface rides the adapter, so the
 *     filter applies everywhere at once.
 *
 *  2. After a Gemini discovery, a stored default that discovery no
 *     longer returns is repaired onto the first discovered chat model
 *     (ModelService.resetDefaultToFirstOf), so an already-broken
 *     provider heals on its next Discover instead of probing `aqa`
 *     forever. Other adapters are never second-guessed.
 *
 * Hermetic: loopback double for the wire, in-memory storage + a stub
 * registry for the API layer. No network, no real keys.
 */
import { describe, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { GeminiAdapter } from "../src/ai/gemini";
import { Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry, type AdapterConfig } from "../src/ai/adapter_registry";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import type { ProbeResult } from "../src/ai/health";
import type { CompletionRequest, CompletionResponse } from "../src/ai/provider";
import type { AIProviderAdapter } from "../src/ai/adapter";
import { handleProviderApi, type ProviderApiDeps } from "../src/miniapp/api_providers";

const GEMINI_NATIVE = "https://generativelanguage.googleapis.com/v1beta";

// ------------------------------------------------------------- doubles ----

interface Double {
  port: number;
  close: () => void;
}

async function double(payload: unknown): Promise<Double> {
  const server: Server = createServer((_req, res: ServerResponse) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(payload)),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, close: () => server.close() };
}

/** Google's ListModels shape for the incident mix of model kinds. */
const LIST_MODELS_PAYLOAD = {
  models: [
    {
      name: "models/aqa",
      displayName: "AQA",
      supportedGenerationMethods: [],
    },
    {
      name: "models/embedding-001",
      displayName: "Embedding 001",
      supportedGenerationMethods: ["embedContent", "countTextTokens"],
    },
    {
      name: "models/imagen-4.0-generate-001",
      displayName: "Imagen 4",
      supportedGenerationMethods: ["predict"],
    },
    {
      name: "models/gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
    },
    {
      // No methods field at all — kept (liberal for compatible endpoints).
      name: "models/gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
    },
    {
      name: "models/gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      supportedGenerationMethods: ["countTokens", "generateContent"],
    },
  ],
};

// ------------------------------------------------------- adapter filter ----

describe("Gemini listModels filters to generateContent models", () => {
  test("aqa/embedding/imagen are excluded; chat + no-field models are imported", async () => {
    const d = await double(LIST_MODELS_PAYLOAD);
    try {
      const adapter = new GeminiAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1beta`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const models = await adapter.listModels({
        target: { baseUrl: `http://127.0.0.1:${d.port}/v1beta`, apiKey: "k" },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(models.map((m) => m.id)).toEqual([
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-2.5-pro",
      ]);
      // The default pick (first discovered) is a chat model, never `aqa`.
      expect(models[0]!.id).toBe("gemini-2.5-flash");
    } finally {
      d.close();
    }
  });
});

// --------------------------------------------------- default repair unit ----

function serviceHarness(): {
  storage: Storage;
  providers: ProviderService;
  models: ModelService;
  close: () => void;
} {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("gemini-discovery-test-key");
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  return { storage, providers, models, close: () => storage.close() };
}

function addModel(
  models: ModelService,
  providerId: number,
  modelId: string,
): number {
  const r = models.add({ providerId, modelId, label: modelId });
  if (!r.ok) throw new Error(`model add failed for ${modelId}`);
  return r.data;
}

describe("ModelService.resetDefaultToFirstOf", () => {
  test("a junk default moves to the first discovered chat model, once", () => {
    const h = serviceHarness();
    try {
      const created = h.providers.create({
        label: "Google Gemini",
        adapter: "gemini",
        baseUrl: GEMINI_NATIVE,
        apiKey: "test-key",
      });
      if (!created.ok) throw new Error("provider create failed");
      const pid = created.data;
      const aqa = addModel(h.models, pid, "aqa");
      addModel(h.models, pid, "embedding-001");
      addModel(h.models, pid, "gemini-2.5-flash");
      h.models.setDefault(aqa);

      const moved = h.models.resetDefaultToFirstOf(pid, [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
      ]);
      expect(moved).toBe(true);
      expect(h.models.list(pid).find((m) => m.isDefault)?.modelId).toBe(
        "gemini-2.5-flash",
      );
      // Idempotent: the default is discoverable now, nothing moves.
      expect(
        h.models.resetDefaultToFirstOf(pid, ["gemini-2.5-flash"]),
      ).toBe(false);
    } finally {
      h.close();
    }
  });

  test("no discovered model stored yet → no move (import comes first)", () => {
    const h = serviceHarness();
    try {
      const created = h.providers.create({
        label: "Google Gemini",
        adapter: "gemini",
        baseUrl: GEMINI_NATIVE,
        apiKey: "test-key",
      });
      if (!created.ok) throw new Error("provider create failed");
      const pid = created.data;
      const aqa = addModel(h.models, pid, "aqa");
      h.models.setDefault(aqa);
      expect(h.models.resetDefaultToFirstOf(pid, ["gemini-2.5-pro"])).toBe(false);
      expect(h.models.list(pid).find((m) => m.isDefault)?.modelId).toBe("aqa");
    } finally {
      h.close();
    }
  });

  test("a discoverable default is never touched", () => {
    const h = serviceHarness();
    try {
      const created = h.providers.create({
        label: "Google Gemini",
        adapter: "gemini",
        baseUrl: GEMINI_NATIVE,
        apiKey: "test-key",
      });
      if (!created.ok) throw new Error("provider create failed");
      const pid = created.data;
      addModel(h.models, pid, "gemini-2.5-flash");
      const pro = addModel(h.models, pid, "gemini-2.5-pro");
      h.models.setDefault(pro);
      expect(
        h.models.resetDefaultToFirstOf(pid, ["gemini-2.5-flash", "gemini-2.5-pro"]),
      ).toBe(false);
      expect(h.models.list(pid).find((m) => m.isDefault)?.modelId).toBe(
        "gemini-2.5-pro",
      );
    } finally {
      h.close();
    }
  });
});

// -------------------------------------------- miniapp discovery surface ----

/** Registry serving a scripted (already adapter-filtered) model list. */
class StubRegistry extends AdapterRegistry {
  constructor(
    private readonly listModelsImpl: () => Promise<{ id: string }[]> = async () => [
      { id: "gemini-2.5-flash" },
      { id: "gemini-2.5-pro" },
    ],
  ) {
    super();
  }
  override create(_type: string, _cfg: AdapterConfig): AIProviderAdapter {
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

function makeDeps(adapters: AdapterRegistry): {
  deps: ProviderApiDeps;
  storage: Storage;
  providerSvc: ProviderService;
  modelSvc: ModelService;
} {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("test-master-key");
  const providerSvc = new ProviderService(storage, secrets, adapters);
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
  const deps: ProviderApiDeps = { storage, providerSvc, modelSvc, health, adapters };
  return { deps, storage, providerSvc, modelSvc };
}

describe("miniapp models.discover repairs a stale Gemini default", () => {
  test("gemini provider defaulted on aqa heals to the first discovered chat model", async () => {
    const registry = new StubRegistry();
    const { deps, storage, providerSvc, modelSvc } = makeDeps(registry);
    try {
      const created = providerSvc.create({
        label: "Google Gemini",
        adapter: "gemini",
        baseUrl: GEMINI_NATIVE,
        apiKey: "test-key",
      });
      if (!created.ok) throw new Error("provider create failed");
      const pid = created.data;
      const aqa = addModel(modelSvc, pid, "aqa");
      addModel(modelSvc, pid, "gemini-2.5-flash");
      modelSvc.setDefault(aqa);

      const res = await handleProviderApi(
        "models.discover",
        { providerId: pid },
        deps,
      );
      expect(res["defaultReset"]).toBe(true);
      expect(
        (res["models"] as { modelId: string }[]).map((m) => m.modelId),
      ).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
      expect(modelSvc.list(pid).find((m) => m.isDefault)?.modelId).toBe(
        "gemini-2.5-flash",
      );
    } finally {
      storage.close();
    }
  });

  test("other adapters keep a non-discovered default untouched", async () => {
    const registry = new StubRegistry(async () => [{ id: "m1" }]);
    const { deps, storage, providerSvc, modelSvc } = makeDeps(registry);
    try {
      const created = providerSvc.create({
        label: "Custom",
        adapter: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
      });
      if (!created.ok) throw new Error("provider create failed");
      const pid = created.data;
      const zzz = addModel(modelSvc, pid, "zzz-local-only");
      addModel(modelSvc, pid, "m1");
      modelSvc.setDefault(zzz);

      const res = await handleProviderApi(
        "models.discover",
        { providerId: pid },
        deps,
      );
      expect(res["defaultReset"]).toBeUndefined();
      expect(modelSvc.list(pid).find((m) => m.isDefault)?.modelId).toBe(
        "zzz-local-only",
      );
    } finally {
      storage.close();
    }
  });
});
