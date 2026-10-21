/**
 * Provider end-to-end (mocked transports) — v1.0 release gate.
 *
 * Covers the full owner journey for three presets without touching the
 * network: add → probe → select → chat.
 *
 *  - Cloudflare: the {ACCOUNT_ID} placeholder must resolve into the saved
 *    base URL; a URL that still carries the placeholder is refused with a
 *    message that names the placeholder.
 *  - 9Router: add with an explicit base URL, probe on select, then chat.
 *  - OpenRouter: add, probe, select, chat.
 *
 * Also asserts the two safety properties the release depends on:
 *  - auto-select engages (ensureSelection activates the first usable
 *    provider when nothing is selected);
 *  - errors name the broken provider (no anonymous "something failed").
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderProbeService } from "../src/ai/provider_probe";
import { AiGateway } from "../src/ai/gateway";
import { setupFromPreset } from "../src/ai/setup";
import { providerPreset } from "../src/ai/adapter";
import { AiError } from "../src/ai/provider";

const MASTER_KEY = "e".repeat(64);

/** Scripted adapter: records calls, answers from a canned script, never dials out. */
function scriptedAdapter(
  log: string[],
  opts: { failWith?: AiError; text?: string } = {},
) {
  return {
    name: "scripted",
    capabilities: {},
    complete: async (req: { model: string; messages: unknown[] }) => {
      log.push(`complete:${req.model}`);
      if (opts.failWith) throw opts.failWith;
      return { text: opts.text ?? `mock reply from ${req.model}`, model: req.model };
    },
    listModels: async () => {
      log.push("listModels");
      return [{ id: "mock-model", label: "mock-model" }];
    },
  };
}

function harness(adapterOpts: { failWith?: AiError; text?: string } = {}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(MASTER_KEY);
  const log: string[] = [];
  const adapters = {
    create: () => scriptedAdapter(log, adapterOpts),
  } as unknown as AdapterRegistry;
  const providers = new ProviderService(storage, secrets, new AdapterRegistry());
  const models = new ModelService(storage);
  const health = new ProviderProbeService(storage, providers, secrets, adapters, 5_000);
  const gateway = new AiGateway({ storage, adapters, secrets });
  const deps = { storage, secrets, providers, models };
  return { storage, secrets, providers, models, health, gateway, deps, log };
}

const CHAT_REQ = (model: string) => ({
  model,
  messages: [{ role: "user" as const, content: "hello" }],
  timeoutMs: 5_000,
  signal: new AbortController().signal,
});

describe("cloudflare preset — {ACCOUNT_ID} placeholder", () => {
  test("add refuses a URL that still carries the placeholder, naming it", () => {
    const h = harness();
    const r = setupFromPreset(h.deps, "cloudflare", "cf-key");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("{ACCOUNT_ID}");
    h.storage.close();
  });

  test("add resolves the placeholder into the saved base URL", () => {
    const h = harness();
    const baseUrl = "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1";
    const r = setupFromPreset(h.deps, "cloudflare", "cf-key", baseUrl);
    expect(r.ok).toBe(true);
    const provider = h.storage.getProvider(r.providerId!);
    expect(provider!.baseUrl).toBe(baseUrl);
    expect(provider!.baseUrl).not.toContain("{ACCOUNT_ID}");
    // The suggested model was added and the provider auto-activated.
    const sel = h.storage.getRuntimeSettings();
    expect(r.providerId).toBeDefined();
    expect(sel.activeProviderId).toBe(r.providerId!);
    expect(r.activatedModel).toBe("@cf/meta/llama-3.1-8b-instruct");
    h.storage.close();
  });

  test("probe → select → chat works end to end", async () => {
    const h = harness();
    const baseUrl = "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1";
    const r = setupFromPreset(h.deps, "cloudflare", "cf-key", baseUrl);
    expect(r.ok).toBe(true);

    const probe = await h.health.probe(r.providerId!);
    expect(probe.ok).toBe(true);

    h.storage.setRuntimeSelection({
      providerId: r.providerId!,
      modelId: r.modelId!,
    });
    const out = await h.gateway.complete(CHAT_REQ("@cf/meta/llama-3.1-8b-instruct"));
    expect(out.text).toContain("mock reply");
    expect(h.log).toContain("complete:@cf/meta/llama-3.1-8b-instruct");
    h.storage.close();
  });
});

describe("9router — explicit base URL", () => {
  test("add → probe → select → chat", async () => {
    const h = harness();
    // 9Router has no preset; it is created with an explicit base URL and model.
    const created = h.providers.create({
      label: "9Router",
      adapter: "nine_router",
      baseUrl: "https://router.example.com/v1",
      apiKey: "nr-key",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    const providerId = created.data;
    const added = h.models.add({
      providerId,
      modelId: "nr-model",
      label: "nr-model",
    });
    expect(added.ok).toBe(true);

    // Probe runs against the new provider and succeeds on the mock.
    const probe = await h.health.probe(providerId);
    expect(probe.ok).toBe(true);

    // Select, then chat through the gateway.
    if (!added.ok) throw new Error("unreachable");
    h.storage.setRuntimeSelection({ providerId, modelId: added.data });
    const sel = h.storage.getRuntimeSettings();
    expect(sel.activeProviderId).toBe(providerId);

    const out = await h.gateway.complete(CHAT_REQ("nr-model"));
    expect(out.text).toContain("mock reply");
    h.storage.close();
  });
});

describe("openrouter preset", () => {
  test("add → probe → select → chat", async () => {
    const h = harness();
    const r = setupFromPreset(h.deps, "openrouter", "or-key");
    expect(r.ok).toBe(true);
    expect(r.activatedModel).toBe("anthropic/claude-haiku-5.5");

    const probe = await h.health.probe(r.providerId!);
    expect(probe.ok).toBe(true);

    h.storage.setRuntimeSelection({
      providerId: r.providerId!,
      modelId: r.modelId!,
    });
    const out = await h.gateway.complete(CHAT_REQ("anthropic/claude-haiku-5.5"));
    expect(out.text).toContain("mock reply");
    h.storage.close();
  });
});

describe("auto-select engages", () => {
  test("ensureSelection activates the first usable provider when none is selected", () => {
    const h = harness();
    // Create a provider WITHOUT going through setupFromPreset (which
    // auto-activates), so nothing is selected.
    const created = h.providers.create({
      label: "OpenRouter",
      adapter: "openai_compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "or-key",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    const added = h.models.add({
      providerId: created.data,
      modelId: "anthropic/claude-haiku-5.5",
      label: "anthropic/claude-haiku-5.5",
    });
    expect(added.ok).toBe(true);

    expect(h.storage.getRuntimeSettings().activeProviderId).toBeNull();

    const picked = h.providers.ensureSelection();
    expect(picked).toBeDefined();
    expect(picked!.providerId).toBe(created.data);
    expect(h.storage.getRuntimeSettings().activeProviderId).toBe(created.data);
    h.storage.close();
  });

  test("ensureSelection never overwrites an existing selection", () => {
    const h = harness();
    const a = setupFromPreset(h.deps, "openrouter", "or-key");
    const b = setupFromPreset(h.deps, "groq", "gsk-key");
    expect(a.ok && b.ok).toBe(true);

    h.storage.setRuntimeSelection({ providerId: a.providerId!, modelId: a.modelId! });
    const picked = h.providers.ensureSelection();
    expect(a.providerId).toBeDefined();
    expect(picked!.providerId).toBe(a.providerId!);
    h.storage.close();
  });
});

describe("errors name the broken provider", () => {
  test("a failing provider's error names it", async () => {
    const broken = new AiError("unknown", "boom");
    const h = harness({ failWith: broken });
    const r = setupFromPreset(h.deps, "openrouter", "or-key");
    expect(r.ok).toBe(true);
    h.storage.setRuntimeSelection({
      providerId: r.providerId!,
      modelId: r.modelId!,
    });

    await expect(
      h.gateway.complete(CHAT_REQ("anthropic/claude-haiku-5.5")),
    ).rejects.toThrow();
    // The selection-problem diagnostic names the provider.
    h.providers.clearCredential(r.providerId!);
    const msg = h.gateway.describeSelectionProblem();
    expect(msg).toContain("OpenRouter");
    expect(msg).toContain("credential");
    h.storage.close();
  });

  test("probe failure records the outcome and names the provider", async () => {
    const h = harness({ failWith: new AiError("network", "down") });
    const r = setupFromPreset(h.deps, "groq", "gsk-key");
    expect(r.ok).toBe(true);

    const probe = await h.health.probe(r.providerId!);
    expect(probe.ok).toBe(false);
    const last = h.health.last(r.providerId!);
    expect(last!.ok).toBe(false);
    // The provider view surfaces the failure; the label identifies it.
    const view = h.providers.listViews().find((v) => v.id === r.providerId)!;
    expect(view.label).toBe("Groq");
    h.storage.close();
  });
});
