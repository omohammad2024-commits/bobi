/**
 * One-message provider setup.
 *
 * The flow this replaces took five screens and two hand-typed forms, where a
 * mistake anywhere discarded the whole attempt. The property that matters now
 * is that ONE message leaves a provider that actually works — created,
 * credentialed, with a model, and activated.
 *
 * A provider that exists but is not active is the failure worth guarding: it
 * looks configured in the panel while refusing every request.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { ProviderService, ModelService } from "../src/ai/provider_service";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { setupFromPreset, parseSetupReply, setupPrompt } from "../src/ai/setup";
import { providerPreset, PROVIDER_PRESETS } from "../src/ai/adapter";

const MASTER_KEY = "k".repeat(64);

function harness() {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(MASTER_KEY);
  return {
    storage,
    secrets,
    providers: new ProviderService(storage, secrets, new AdapterRegistry()),
    models: new ModelService(storage),
  };
}

describe("one message, everything configured", () => {
  test("EVERY preset leaves a provider that is active and has a model", () => {
    // This is the property the whole flow exists for. A preset without a
    // suggested model would create a provider that cannot answer.
    for (const p of PROVIDER_PRESETS) {
      const h = harness();
      const key = "test-key";
      // A placeholder service needs its extra value supplied.
      const baseUrl =
        p.requiredPlaceholder !== undefined
          ? p.baseUrl.replace(`{${p.requiredPlaceholder}}`, "acct123")
          : undefined;

      const r = setupFromPreset(h, p.id, key, baseUrl);
      expect(r.ok).toBe(true);

      const sel = h.storage.getRuntimeSettings();
      expect(sel.activeProviderId).not.toBeNull();
      expect(sel.activeModelId).not.toBeNull();
      expect(r.activatedModel).toBeDefined();
      h.storage.close();
    }
  });

  test("the created provider has its credential stored", () => {
    const h = harness();
    setupFromPreset(h, "groq", "gsk_secret");
    const view = h.providers.listViews()[0]!;
    expect(view.hasCredential).toBe(true);
    expect(view.modelCount).toBe(1);
    expect(view.isActive).toBe(true);
    h.storage.close();
  });

  test("the key is stored encrypted, never in plaintext", () => {
    const h = harness();
    setupFromPreset(h, "groq", "gsk_plaintext_check");
    const stored = h.storage.getCredential(1)!;
    expect(JSON.stringify(stored)).not.toContain("gsk_plaintext_check");
    // ...and it round-trips through the vault.
    expect(h.secrets.decrypt(stored)).toBe("gsk_plaintext_check");
    h.storage.close();
  });

  test("the runtime selection is complete, not half-set", () => {
    // A half-applied selection is the worst outcome: the panel shows a provider
    // while every request fails.
    const h = harness();
    setupFromPreset(h, "deepseek", "key");
    const sel = h.storage.getRuntimeSettings();
    expect(sel.activeProviderId).toBe(1);
    expect(sel.activeModelId).not.toBeNull();
    h.storage.close();
  });

  test("with no master key the whole thing fails closed", () => {
    // Nothing may be created without a place to put the credential safely.
    const storage = Storage.open(":memory:");
    const secrets = new ProviderSecretStore(undefined);
    const r = setupFromPreset(
      {
        storage,
        secrets,
        providers: new ProviderService(storage, secrets, new AdapterRegistry()),
        models: new ModelService(storage),
      },
      "groq",
      "key",
    );
    expect(r.ok).toBe(false);
    expect(storage.listProviders()).toHaveLength(0);
    storage.close();
  });

  test("an unknown preset is refused", () => {
    const h = harness();
    const r = setupFromPreset(h, "not-a-service", "key");
    expect(r.ok).toBe(false);
    expect(h.storage.listProviders()).toHaveLength(0);
    h.storage.close();
  });

  test("an unsubstituted placeholder is refused with a clear reason", () => {
    // Saving it would create a provider pointing at a URL that cannot work.
    const h = harness();
    const r = setupFromPreset(h, "cloudflare", "key");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("ACCOUNT_ID");
    expect(h.storage.listProviders()).toHaveLength(0);
    h.storage.close();
  });

  test("substituting the placeholder produces a working URL", () => {
    const h = harness();
    const cf = providerPreset("cloudflare")!;
    const url = cf.baseUrl.replace("{ACCOUNT_ID}", "abc123");
    const r = setupFromPreset(h, "cloudflare", "key", url);
    expect(r.ok).toBe(true);
    expect(h.providers.listViews()[0]!.baseUrl).toContain("abc123");
    expect(h.providers.listViews()[0]!.baseUrl).not.toContain("{");
    h.storage.close();
  });
});

describe("parsing the one-line reply", () => {
  test("a plain key is accepted", () => {
    expect(parseSetupReply("gsk_abc123", false)).toEqual({ apiKey: "gsk_abc123" });
  });

  test("surrounding whitespace is trimmed", () => {
    expect(parseSetupReply("  gsk_abc  ", false)).toEqual({ apiKey: "gsk_abc" });
  });

  test("an empty reply is refused", () => {
    expect(parseSetupReply("", false)).toBeUndefined();
    expect(parseSetupReply("   ", false)).toBeUndefined();
  });

  test("a key containing a comma is kept whole when no extra is needed", () => {
    // Splitting a key on a comma would silently truncate it.
    expect(parseSetupReply("key,with,commas", false)).toEqual({ apiKey: "key,with,commas" });
  });

  test("key and placeholder value split on a comma", () => {
    expect(parseSetupReply("cf-key, acct123", true)).toEqual({
      apiKey: "cf-key",
      extra: "acct123",
    });
  });

  test("a missing placeholder value is refused", () => {
    expect(parseSetupReply("cf-key", true)).toBeUndefined();
  });

  test("a newline separates them too", () => {
    expect(parseSetupReply("cf-key\nacct123", true)).toEqual({
      apiKey: "cf-key",
      extra: "acct123",
    });
  });
});

describe("the prompt tells the owner exactly what to send", () => {
  test("a simple service asks for the key and nothing else", () => {
    const text = setupPrompt(providerPreset("groq")!);
    expect(text).toContain("کلید API");
    // No URL, no label, no model id to type.
    expect(text).not.toContain("نام نمایشی");
    expect(text).not.toContain("آدرس سرویس:");
  });

  test("a service needing a placeholder says so and shows the format", () => {
    const text = setupPrompt(providerPreset("cloudflare")!);
    expect(text).toContain("ACCOUNT_ID");
    expect(text).toContain("کاما");
  });

  test("the suggested model is named, so the result is not a surprise", () => {
    const text = setupPrompt(providerPreset("groq")!);
    expect(text).toContain("llama-3.3-70b-versatile");
  });
});
