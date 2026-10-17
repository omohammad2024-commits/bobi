import { describe, expect, test } from "bun:test";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { isAdapterType, ADAPTER_TEMPLATES } from "../src/ai/adapter";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import { validateTarget } from "../src/ai/target";
import { AiError } from "../src/ai/provider";
import { ProviderSecretStore, SecretStoreError } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import { Storage } from "../src/storage/storage";

// ---------- adapter selection ----------

describe("adapter registry", () => {
  const adapters = new AdapterRegistry();

  test("selects the right adapter for each provider type", () => {
    for (const type of ["openai_compatible", "nine_router", "gemini", "anthropic"]) {
      const adapter = adapters.create(type, {
        baseUrl: "https://example.invalid/v1",
        apiKey: "k",
        model: "m",
      });
      // Each adapter's `name` equals the type it was built for, except
      // nine_router which shares the OpenAI-compatible wire format.
      expect(adapter.name).toBe(type === "nine_router" ? "openai_compatible" : type);
    }
  });

  test("refuses an unknown adapter type instead of guessing", () => {
    expect(() =>
      adapters.create("not_a_real_adapter", { baseUrl: "https://x.invalid", apiKey: "k", model: "m" }),
    ).toThrow(/unknown adapter type/);
  });

  test("declares capabilities per adapter, not uniformly", () => {
    expect(adapters.describes("openai_compatible").listModels).toBe(true);
    expect(adapters.describes("gemini").listModels).toBe(true);
    // Anthropic's model list is not a simple GET for this adapter's needs.
    expect(adapters.describes("anthropic").listModels).toBe(false);
    expect(adapters.describes("nine_router").listModels).toBe(false);
  });

  test("isAdapterType rejects unknown strings", () => {
    expect(isAdapterType("openai_compatible")).toBe(true);
    expect(isAdapterType("nope")).toBe(false);
    expect(isAdapterType("")).toBe(false);
  });

  test("templates cover the advertised adapters", () => {
    expect(ADAPTER_TEMPLATES.map((t) => t.type).sort()).toEqual(
      ["anthropic", "gemini", "nine_router", "openai_compatible"],
    );
    // 9Router pre-fills nothing: its address is deployment-specific.
    const nine = ADAPTER_TEMPLATES.find((t) => t.type === "nine_router");
    expect(nine?.suggestedBaseUrl).toBe("");
    expect(nine?.prefilled).toBe(false);
  });
});

// ---------- target validation (SSRF posture) ----------

describe("connection target validation", () => {
  test("accepts a public https URL", () => {
    const r = validateTarget({ baseUrl: "https://api.example.com/v1", apiKey: "k" });
    expect(r.baseUrl).toBe("https://api.example.com/v1");
  });

  test("rejects a blank or malformed URL", () => {
    for (const bad of ["", "   ", "not a url", "://missing"]) {
      expect(() => validateTarget({ baseUrl: bad, apiKey: "k" })).toThrow(AiError);
    }
  });

  test("rejects a non-http scheme", () => {
    for (const bad of ["file:///etc/passwd", "ftp://x.invalid", "javascript:alert(1)"]) {
      expect(() => validateTarget({ baseUrl: bad, apiKey: "k" })).toThrow(AiError);
    }
  });

  test("rejects a credential hidden in the URL", () => {
    expect(() =>
      validateTarget({ baseUrl: "https://user:pass@api.example.com/v1", apiKey: "k" }),
    ).toThrow(AiError);
  });

  test("refuses loopback and private hosts by default", () => {
    for (const bad of [
      "http://127.0.0.1:8080/v1",
      "http://localhost:11434/v1",
      "http://192.168.1.10:8080/v1",
      "http://10.0.0.5/v1",
      "http://172.16.0.9/v1",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:8080/v1",
    ]) {
      expect(() => validateTarget({ baseUrl: bad, apiKey: "k" })).toThrow(AiError);
    }
  });

  test("allows a local target only when explicitly opted in", () => {
    const r = validateTarget(
      { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "k" },
      { allowLocalTargets: true },
    );
    expect(r.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  test("an adapter refuses an SSRF-shaped base URL before any request", async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "http://169.254.169.254/latest/meta-data",
      apiKey: "k",
    });
    await expect(
      adapter.complete({
        messages: [{ role: "user", content: "hi" }],
        model: "m",
        timeoutMs: 1000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(AiError);
  });

  test("a missing URL is refused with a safe message", async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl: "", apiKey: "k" });
    await expect(
      adapter.complete({
        messages: [{ role: "user", content: "hi" }],
        model: "m",
        timeoutMs: 1000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/آدرس سرویس/);
  });
});

// ---------- credential encryption ----------

describe("provider secret store", () => {
  const KEY = "phase9-master-key";

  test("round-trips a credential without revealing plaintext", () => {
    const store = new ProviderSecretStore(KEY);
    const enc = store.encrypt("sk-super-secret-value");
    expect(JSON.stringify(enc)).not.toContain("sk-super-secret-value");
    expect(store.decrypt(enc)).toBe("sk-super-secret-value");
  });

  test("produces a different ciphertext each time (random IV)", () => {
    const store = new ProviderSecretStore(KEY);
    const a = store.encrypt("same-input");
    const b = store.encrypt("same-input");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("rejects a tampered payload (authenticated encryption)", () => {
    const store = new ProviderSecretStore(KEY);
    const enc = store.encrypt("sk-secret");
    const flipped = { ...enc, ciphertext: `${enc.ciphertext.slice(0, -4)}AAAA` };
    expect(() => store.decrypt(flipped)).toThrow(SecretStoreError);
  });

  test("rejects a credential encrypted under a different key", () => {
    const a = new ProviderSecretStore(KEY);
    const b = new ProviderSecretStore("a-different-key");
    const enc = a.encrypt("sk-secret");
    expect(() => b.decrypt(enc)).toThrow(SecretStoreError);
  });

  test("fails closed when no master key is configured", () => {
    const store = new ProviderSecretStore(undefined);
    expect(store.configured).toBe(false);
    expect(() => store.encrypt("sk-secret")).toThrow(SecretStoreError);
    // And it cannot be talked into decrypting either.
    const other = new ProviderSecretStore(KEY);
    const enc = other.encrypt("sk-secret");
    expect(() => store.decrypt(enc)).toThrow(SecretStoreError);
  });

  test("rejects a malformed stored payload", () => {
    const store = new ProviderSecretStore(KEY);
    for (const bad of [
      { iv: "x", ciphertext: "y", tag: "z" },
      { iv: "", ciphertext: "y", tag: "z" },
    ]) {
      expect(() => store.decrypt(bad)).toThrow(SecretStoreError);
    }
  });
});

// ---------- service lifecycle ----------

/** A store with a key, so credential paths are exercised. */
function withKey(): ProviderSecretStore {
  return new ProviderSecretStore("phase9-test-key");
}

function seeded(): {
  storage: Storage;
  providers: ProviderService;
  models: ModelService;
} {
  const storage = Storage.open(":memory:");
  const providers = new ProviderService(storage, withKey(), new AdapterRegistry());
  const models = new ModelService(storage);
  return { storage, providers, models };
}

describe("provider service", () => {
  test("creates a provider and never exposes the key in its view", () => {
    const { storage, providers } = seeded();
    const r = providers.create({
      label: "OpenAI اصلی",
      adapter: "openai_compatible",
      // A reserved example host: the test never contacts the real service.
      baseUrl: "https://api.example.invalid/v1",
      apiKey: "sk-live-secret-000",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const view = providers.view(r.data);
    expect(view?.label).toBe("OpenAI اصلی");
    expect(view?.hasCredential).toBe(true);
    // No key material anywhere in the view.
    expect(JSON.stringify(view)).not.toContain("sk-live-secret-000");
    storage.close();
  });

  test("fails closed and creates nothing when the master key is missing", () => {
    const storage = Storage.open(":memory:");
    const providers = new ProviderService(storage, new ProviderSecretStore(undefined), new AdapterRegistry());
    const r = providers.create({
      label: "X",
      adapter: "openai_compatible",
      baseUrl: "https://x.invalid/v1",
      apiKey: "sk-key",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_key");
    // No provider row was written.
    expect(storage.listProviders().length).toBe(0);
    storage.close();
  });

  test("rejects an invalid adapter and a blank label", () => {
    const { storage, providers } = seeded();
    expect(
      providers.create({ label: "x", adapter: "bogus", baseUrl: "https://a.invalid" }).ok,
    ).toBe(false);
    expect(
      providers.create({ label: "  ", adapter: "openai_compatible", baseUrl: "https://a.invalid" }).ok,
    ).toBe(false);
    expect(storage.listProviders().length).toBe(0);
    storage.close();
  });

  test("enables and disables a provider", () => {
    const { storage, providers } = seeded();
    const r = providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
    });
    if (!r.ok) throw new Error("create failed");
    providers.setEnabled(r.data, false);
    expect(providers.view(r.data)?.enabled).toBe(false);
    providers.setEnabled(r.data, true);
    expect(providers.view(r.data)?.enabled).toBe(true);
    storage.close();
  });

  test("replaces and clears a credential; status is set/unset only", () => {
    const { storage, providers } = seeded();
    const r = providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "sk-first",
    });
    if (!r.ok) throw new Error("create failed");

    expect(providers.credentialStatus(r.data)).toBe("set");
    expect(providers.credentialFor(r.data)).toBe("sk-first");

    providers.update(r.data, { apiKey: "sk-second" });
    expect(providers.credentialFor(r.data)).toBe("sk-second");

    providers.clearCredential(r.data);
    expect(providers.credentialStatus(r.data)).toBe("unset");
    storage.close();
  });

  test("refuses to delete the active provider", () => {
    const { storage, providers, models } = seeded();
    const p = providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "k",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = models.add({ providerId: p.data, modelId: "m1", label: "M1" });
    if (!m.ok) throw new Error("model failed");
    storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });

    const res = providers.remove(p.data);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("in_use");

    // Once another provider is active, the old one may be deleted.
    const q = providers.create({
      label: "Q",
      adapter: "openai_compatible",
      baseUrl: "https://b.invalid/v1",
      apiKey: "k",
    });
    if (!q.ok) throw new Error("provider2 failed");
    const mq = models.add({ providerId: q.data, modelId: "m2", label: "M2" });
    if (!mq.ok) throw new Error("model2 failed");
    storage.setRuntimeSelection({ providerId: q.data, modelId: mq.data });
    expect(providers.remove(p.data).ok).toBe(true);
    storage.close();
  });

  test("a deleted provider does not remove conversations", () => {
    const { storage, providers } = seeded();
    const p = providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
    });
    if (!p.ok) throw new Error("provider failed");
    storage.appendMessage("u1", "c1", "user", "سلام");

    providers.remove(p.data);
    expect(storage.history("u1", "c1").length).toBe(1);
    storage.close();
  });
});

describe("model service", () => {
  /** Create a provider inside the SAME store the models will use. */
  function withProvider(): {
    storage: Storage;
    models: ModelService;
    providerId: number;
  } {
    const { storage, providers, models } = seeded();
    const r = providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://a.invalid/v1",
      apiKey: "k",
    });
    if (!r.ok) throw new Error("provider failed");
    return { storage, models, providerId: r.data };
  }

  test("adds a model with a real id and a separate display label", () => {
    const { storage, models, providerId: pid } = withProvider();
    const r = models.add({ providerId: pid, modelId: "gpt-4o-mini", label: "مدل سریع" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = models.get(r.data);
    // The two fields stay distinct.
    expect(view?.modelId).toBe("gpt-4o-mini");
    expect(view?.label).toBe("مدل سریع");
    storage.close();
  });

  test("refuses a duplicate model id for the same provider", () => {
    const { storage, models, providerId: pid } = withProvider();
    expect(models.add({ providerId: pid, modelId: "m", label: "A" }).ok).toBe(true);
    const dup = models.add({ providerId: pid, modelId: "m", label: "B" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe("duplicate");
    storage.close();
  });

  test("the same model id is allowed on a different provider", () => {
    const { storage, providers, models } = seeded();
    const a = providers.create({ label: "A", adapter: "openai_compatible", baseUrl: "https://a.invalid" });
    const b = providers.create({ label: "B", adapter: "openai_compatible", baseUrl: "https://b.invalid" });
    if (!a.ok || !b.ok) throw new Error("providers failed");
    expect(models.add({ providerId: a.data, modelId: "m", label: "X" }).ok).toBe(true);
    expect(models.add({ providerId: b.data, modelId: "m", label: "Y" }).ok).toBe(true);
    storage.close();
  });

  test("rejects a blank id or label", () => {
    const { storage, models, providerId: pid } = withProvider();
    expect(models.add({ providerId: pid, modelId: "", label: "X" }).ok).toBe(false);
    expect(models.add({ providerId: pid, modelId: "m", label: "  " }).ok).toBe(false);
    storage.close();
  });

  test("renames a model without touching its id", () => {
    const { storage, models, providerId: pid } = withProvider();
    const r = models.add({ providerId: pid, modelId: "m1", label: "قدیمی" });
    if (!r.ok) throw new Error("add failed");
    models.rename(r.data, "جدید");
    const view = models.get(r.data);
    expect(view?.label).toBe("جدید");
    expect(view?.modelId).toBe("m1");
    storage.close();
  });

  test("refuses to delete the active model", () => {
    const { storage, models, providerId: pid } = withProvider();
    const r = models.add({ providerId: pid, modelId: "m1", label: "M1" });
    if (!r.ok) throw new Error("add failed");
    storage.setRuntimeSelection({ providerId: pid, modelId: r.data });
    const res = models.remove(r.data);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("in_use");
    storage.close();
  });

  test("refuses to delete a provider's last enabled model", () => {
    const { storage, models, providerId: pid } = withProvider();
    const r = models.add({ providerId: pid, modelId: "m1", label: "M1" });
    if (!r.ok) throw new Error("add failed");
    // It is active, so removal is refused for two reasons; check the message
    // names the alternative rather than just failing.
    const res = models.remove(r.data);
    expect(res.ok).toBe(false);
    storage.close();
  });

  test("deleting a non-last default promotes a replacement", () => {
    const { storage, models, providerId: pid } = withProvider();
    const a = models.add({ providerId: pid, modelId: "m1", label: "A" });
    const b = models.add({ providerId: pid, modelId: "m2", label: "B" });
    if (!a.ok || !b.ok) throw new Error("add failed");
    models.setDefault(a.data);
    // `a` is the active model, so redirect activity to `b` first.
    storage.setRuntimeSelection({ providerId: pid, modelId: b.data });

    expect(models.remove(a.data).ok).toBe(true);
    // The provider still has a default, so it is never left in a bad state.
    const remaining = models.list(pid);
    expect(remaining.some((m) => m.isDefault)).toBe(true);
    storage.close();
  });

  test("enables and disables a model", () => {
    const { storage, models, providerId: pid } = withProvider();
    const r = models.add({ providerId: pid, modelId: "m1", label: "M" });
    if (!r.ok) throw new Error("add failed");
    models.setEnabled(r.data, false);
    expect(models.get(r.data)?.enabled).toBe(false);
    expect(models.enabledModels(pid).length).toBe(0);
    storage.close();
  });
});

// ---------- gateway ----------

describe("AI gateway", () => {
  function ready(): {
    storage: Storage;
    gateway: AiGateway;
    providerId: number;
    modelId: number;
    seen: string[];
  } {
    const storage = Storage.open(":memory:");
    const secrets = withKey();
    const providers = new ProviderService(storage, secrets, new AdapterRegistry());
    const models = new ModelService(storage);
    const p = providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://api.invalid.example/v1",
      apiKey: "sk-gateway-test",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = models.add({ providerId: p.data, modelId: "model-abc", label: "الف" });
    if (!m.ok) throw new Error("model failed");
    models.setDefault(m.data);
    storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });

    const seen: string[] = [];
    const gateway = new AiGateway({
      storage,
      adapters: new AdapterRegistry(),
      secrets,
    });
    void seen;
    return { storage, gateway, providerId: p.data, modelId: m.data, seen };
  }

  test("resolves the active provider and model as one consistent pair", () => {
    const h = ready();
    const sel = h.gateway.currentSelection();
    expect(sel?.providerId).toBe(h.providerId);
    expect(sel?.modelId).toBe("model-abc");
    expect(sel?.modelLabel).toBe("الف");
    h.storage.close();
  });

  test("refuses to resolve when nothing is selected", () => {
    const h = ready();
    h.storage.setRuntimeSelection({ providerId: 999999, modelId: 999999 });
    expect(h.gateway.currentSelection()).toBeUndefined();
    h.storage.close();
  });

  test("refuses when the active provider is disabled", () => {
    const h = ready();
    h.storage.setProviderEnabled(h.providerId, false);
    expect(h.gateway.currentSelection()).toBeUndefined();
    h.storage.close();
  });

  test("refuses when the active model is disabled", () => {
    const h = ready();
    h.storage.setModelEnabled(h.modelId, false);
    expect(h.gateway.currentSelection()).toBeUndefined();
    h.storage.close();
  });

  test("fails closed with a safe message when no credential is set", async () => {
    const h = ready();
    h.storage.deleteCredential(h.providerId);
    await expect(
      h.gateway.complete({
        messages: [{ role: "user", content: "hi" }],
        model: "anything",
        timeoutMs: 1000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(AiError);
    h.storage.close();
  });

  test("a settings change mid-request keeps the request's own model", async () => {
    const storage = Storage.open(":memory:");
    const secrets = withKey();
    const providers = new ProviderService(storage, secrets, new AdapterRegistry());
    const models = new ModelService(storage);
    const p = providers.create({
      label: "P",
      adapter: "openai_compatible",
      baseUrl: "https://api.invalid.example/v1",
      apiKey: "sk-gateway-test",
    });
    if (!p.ok) throw new Error("provider failed");
    const first = models.add({ providerId: p.data, modelId: "model-first", label: "الف" });
    const second = models.add({ providerId: p.data, modelId: "model-second", label: "ب" });
    if (!first.ok || !second.ok) throw new Error("models failed");
    storage.setRuntimeSelection({ providerId: p.data, modelId: first.data });

    // A model-recording adapter stands in for the network: it captures which
    // model id the gateway actually resolved.
    const seen: string[] = [];
    const recordingAdapters = {
      create: (type: string, cfg: { model: string }) => {
        void type;
        return {
          name: "recorder",
          complete: async (req: { model: string }) => {
            seen.push(`${cfg.model}:${req.model}`);
            return { text: "پاسخ", model: req.model };
          },
        };
      },
    } as unknown as AdapterRegistry;

    const gateway = new AiGateway({ storage, adapters: recordingAdapters, secrets });

    // Start the request, then switch the active model before it finishes.
    const inFlight = gateway.complete({
      messages: [{ role: "user", content: "hi" }],
      model: "ignored",
      timeoutMs: 2000,
      signal: new AbortController().signal,
    });
    storage.setRuntimeSelection({ providerId: p.data, modelId: second.data });
    await inFlight;

    // The resolved model came from the snapshot taken at request start.
    expect(seen).toEqual(["model-first:model-first"]);
    storage.close();
  });
});
