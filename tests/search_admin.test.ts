/**
 * Web-search settings through the owner panel.
 *
 * The service is only reachable behind `settings.manage`, so these tests are
 * written from the same adversarial angle as the rest of the admin suite: the
 * interesting cases are a non-owner trying to read or change the setting, and a
 * key that must never be echoed back.
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { SearchProviderSecretStore } from "../src/search/secret_store";
import { SearchSettingsService } from "../src/search/service";
import { SearchRegistry } from "../src/search/registry";
import { encode, decode } from "../src/groups/callbacks";
import { searchMenuText, searchMenuKeyboard, searchKeyFormText } from "../src/search/panel";
import type { SearchSettingsView } from "../src/search/panel";

const OWNER_ID = 111111;
const MASTER_KEY = "search-test-master-key";
const API_KEY = "tvly-synthetic-test-key";

/**
 * The master key to use, or the literal "none" for a deployment that has not
 * configured one.
 *
 * `undefined` cannot be the signal here: a default parameter would silently
 * substitute the real key for it, so the "no master key" case would never
 * actually run without one.
 */
function harness(masterKey: string | "none" = MASTER_KEY) {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER_ID));
  const admin = new AdminBoundary({ auth, audit: new AuditLogger({ storage }) });
  const secrets = new SearchProviderSecretStore(masterKey === "none" ? undefined : masterKey);
  const service = new SearchSettingsService(storage, secrets);
  const registry = new SearchRegistry(storage, secrets);
  return { storage, auth, admin, secrets, service, registry };
}

describe("search settings defaults", () => {
  test("a fresh database selects the keyless provider", () => {
    const h = harness();
    const v = h.service.view();
    expect(v.provider).toBe("duckduckgo");
    // No credential is needed, so it is usable with no configuration at all.
    expect(v.usable).toBe(true);
    expect(v.hasKey).toBe(false);
    h.storage.close();
  });

  test("the registry builds a working provider out of the box", () => {
    const h = harness();
    expect(h.registry.isConfigured()).toBe(true);
    expect(h.registry.active().type).toBe("duckduckgo");
    h.storage.close();
  });
});

describe("selecting a provider", () => {
  test("a known provider can be selected", () => {
    const h = harness();
    expect(h.service.select("tavily").ok).toBe(true);
    expect(h.service.view().provider).toBe("tavily");
    h.storage.close();
  });

  test("an unknown provider is refused", () => {
    const h = harness();
    const r = h.service.select("google");
    expect(r.ok).toBe(false);
    // The stored value is unchanged.
    expect(h.service.view().provider).toBe("duckduckgo");
    h.storage.close();
  });

  test("an injection attempt is refused", () => {
    const h = harness();
    for (const bad of ["'; DROP TABLE search_settings;--", "../etc", ""]) {
      expect(h.service.select(bad).ok).toBe(false);
    }
    expect(h.service.view().provider).toBe("duckduckgo");
    h.storage.close();
  });

  test("a keyed provider without a key reports itself unusable", () => {
    const h = harness();
    h.service.select("tavily");
    const v = h.service.view();
    expect(v.usable).toBe(false);
    expect(v.hasKey).toBe(false);
    // The registry agrees, so the tool is not offered to the model.
    expect(h.registry.isConfigured()).toBe(false);
    h.storage.close();
  });

  test("the selection survives a reopen", () => {
    // A unique path per run: a leftover file would make this assert against
    // state it did not create.
    const path = `${tmpdir()}/sol-search-settings-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`;
    const s1 = Storage.open(path);
    const sec1 = new SearchProviderSecretStore(MASTER_KEY);
    new SearchSettingsService(s1, sec1).select("tavily");
    s1.close();

    const s2 = Storage.open(path);
    const sec2 = new SearchProviderSecretStore(MASTER_KEY);
    expect(new SearchSettingsService(s2, sec2).view().provider).toBe("tavily");
    s2.close();

    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  });
});

describe("storing a key", () => {
  test("a key is stored and reported as set", () => {
    const h = harness();
    h.service.select("tavily");
    expect(h.service.setKey(API_KEY).ok).toBe(true);
    expect(h.service.hasKey()).toBe(true);
    expect(h.service.view().usable).toBe(true);
    h.storage.close();
  });

  test("the key is never stored in plaintext", () => {
    const h = harness();
    h.service.setKey(API_KEY);
    const stored = h.storage.getSearchCredential()!;
    // The envelope holds three base64 fields, none of which is the key.
    expect(stored.ciphertext).not.toContain(API_KEY);
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
    h.storage.close();
  });

  test("the stored key round-trips through decryption", () => {
    const h = harness();
    h.service.setKey(API_KEY);
    const stored = h.storage.getSearchCredential()!;
    expect(h.secrets.decrypt(stored)).toBe(API_KEY);
    h.storage.close();
  });

  test("a wrong master key cannot decrypt the stored key", () => {
    const h = harness();
    h.service.setKey(API_KEY);
    const stored = h.storage.getSearchCredential()!;
    const other = new SearchProviderSecretStore("a-completely-different-master-key");
    expect(() => other.decrypt(stored)).toThrow();
    h.storage.close();
  });

  test("a tampered envelope is rejected rather than returning garbage", () => {
    const h = harness();
    h.service.setKey(API_KEY);
    const stored = h.storage.getSearchCredential()!;
    const tampered = { ...stored, ciphertext: Buffer.from("evil").toString("base64") };
    expect(() => h.secrets.decrypt(tampered)).toThrow();
    h.storage.close();
  });

  test("with no master key the write FAILS CLOSED", () => {
    const h = harness("none");
    const r = h.service.setKey(API_KEY);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("missing_key");
    // Nothing was stored, so no key sits in plaintext.
    expect(h.storage.hasSearchCredential()).toBe(false);
    h.storage.close();
  });

  test("an empty key is refused", () => {
    const h = harness();
    expect(h.service.setKey("").ok).toBe(false);
    expect(h.service.setKey("   ").ok).toBe(false);
    expect(h.storage.hasSearchCredential()).toBe(false);
    h.storage.close();
  });

  test("an over-long key is refused", () => {
    const h = harness();
    expect(h.service.setKey("k".repeat(1_000)).ok).toBe(false);
    h.storage.close();
  });

  test("a key can be replaced and cleared", () => {
    const h = harness();
    h.service.setKey("first-key");
    h.service.setKey("second-key");
    expect(h.secrets.decrypt(h.storage.getSearchCredential()!)).toBe("second-key");

    expect(h.service.clearKey()).toBe(true);
    expect(h.service.hasKey()).toBe(false);
    // Clearing twice reports that nothing was there.
    expect(h.service.clearKey()).toBe(false);
    h.storage.close();
  });

  test("selecting a keyed provider then adding a key makes it usable", () => {
    const h = harness();
    h.service.select("tavily");
    expect(h.registry.isConfigured()).toBe(false);
    h.service.setKey(API_KEY);
    expect(h.registry.isConfigured()).toBe(true);
    expect(h.registry.active().type).toBe("tavily");
    h.storage.close();
  });
});

describe("panel rendering", () => {
  const base: SearchSettingsView = { provider: "duckduckgo", hasKey: false, usable: true };

  test("the keyless state says no key is needed", () => {
    const text = searchMenuText(base);
    expect(text).toContain("DuckDuckGo");
    expect(text).toContain("لازم نیست");
    expect(text).toContain("آمادهٔ استفاده");
  });

  test("a keyed provider without a key is reported as unusable", () => {
    const text = searchMenuText({ provider: "tavily", hasKey: false, usable: false });
    expect(text).toContain("تنظیم نشده");
    expect(text).toContain("نشان داده نمی‌شود");
  });

  test("the active provider is marked in the keyboard", () => {
    const kb = searchMenuKeyboard("tavily", true);
    const labels = kb.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l.startsWith("✅"))).toBe(true);
    // The marked one is the active provider, not the first entry.
    expect(labels.some((l) => l.startsWith("✅ Tavily"))).toBe(true);
  });

  test("key buttons only appear for a provider that uses one", () => {
    // Asserted on the callback data rather than the label text: the keyless
    // provider's own name contains the word "کلید", so a label match would
    // report a button that is not there.
    const kinds = (kb: ReturnType<typeof searchMenuKeyboard>) =>
      kb.inline_keyboard
        .flat()
        .map((b) => (b as { callback_data?: string }).callback_data)
        .filter((d): d is string => d !== undefined)
        .map((d) => decode(d)?.kind);

    const keyless = kinds(searchMenuKeyboard("duckduckgo", false));
    expect(keyless).not.toContain("search_set_key_form");
    expect(keyless).not.toContain("search_clear_key");

    const keyedNoKey = kinds(searchMenuKeyboard("tavily", false));
    expect(keyedNoKey).toContain("search_set_key_form");
    // "remove" is only offered when a key exists.
    expect(keyedNoKey).not.toContain("search_clear_key");

    const keyedWithKey = kinds(searchMenuKeyboard("tavily", true));
    expect(keyedWithKey).toContain("search_clear_key");
  });

  test("the key form never claims to show the key", () => {
    const text = searchKeyFormText();
    expect(text).toContain("رمزنگاری");
    expect(text.toLowerCase()).not.toContain("نمایش داده می‌شود");
  });

  test("every button encodes within the callback byte limit", () => {
    for (const kb of [searchMenuKeyboard("duckduckgo", false), searchMenuKeyboard("tavily", true)]) {
      for (const b of kb.inline_keyboard.flat()) {
        const data = (b as { callback_data?: string }).callback_data;
        expect(data).toBeDefined();
        expect(new TextEncoder().encode(data!).length).toBeLessThanOrEqual(64);
        expect(decode(data!)).toBeDefined();
      }
    }
  });
});

describe("search callback codec", () => {
  test("every search action round-trips", () => {
    const actions = [
      { kind: "search_menu" },
      { kind: "search_pick", provider: "duckduckgo" },
      { kind: "search_pick", provider: "tavily" },
      { kind: "search_set_key_form" },
      { kind: "search_clear_key" },
    ] as const;
    for (const a of actions) {
      const data = encode(a as never);
      expect(decode(data)).toEqual(a);
    }
  });

  test("an unknown provider slug never decodes", () => {
    expect(decode("adm:sep:google")).toBeUndefined();
    expect(decode("adm:sep:")).toBeUndefined();
    expect(decode("adm:sep:tavily:extra")).toBeUndefined();
  });

  test("search actions do not collide with ai or fo actions", () => {
    expect(decode(encode({ kind: "search_menu" }))?.kind).toBe("search_menu");
    expect(decode(encode({ kind: "ai_menu" }))?.kind).toBe("ai_menu");
    expect(decode(encode({ kind: "fo_menu" }))?.kind).toBe("fo_menu");
  });
});

describe("the search section is owner-only", () => {
  test("a non-owner cannot read the settings", async () => {
    const h = harness();
    const actor = h.auth.actorFrom({ id: 999999 });

    // The boundary is what enforces this, so assert on it directly.
    const r = await h.admin.runAdmin(
      { actor, operation: "search.menu", permission: "admin.view" },
      () => "should not run",
    );
    expect(r.ok).toBe(false);
    h.storage.close();
  });

  test("a non-owner cannot change the setting", async () => {
    const h = harness();
    const actor = h.auth.actorFrom({ id: 999999 });

    const r = await h.admin.runAdmin(
      { actor, operation: "search.pick", permission: "settings.manage" },
      () => h.service.select("tavily"),
    );
    expect(r.ok).toBe(false);
    // The handler never ran, so nothing changed.
    expect(h.service.view().provider).toBe("duckduckgo");
    h.storage.close();
  });

  test("a non-owner cannot store a key", async () => {
    const h = harness();
    const actor = h.auth.actorFrom({ id: 999999 });

    const r = await h.admin.runAdmin(
      { actor, operation: "search.set_key", permission: "settings.manage" },
      () => h.service.setKey(API_KEY),
    );
    expect(r.ok).toBe(false);
    expect(h.storage.hasSearchCredential()).toBe(false);
    h.storage.close();
  });

  test("an update with no identity cannot act", async () => {
    const h = harness();
    const r = await h.admin.runAdmin(
      { actor: undefined, operation: "search.pick", permission: "settings.manage" },
      () => h.service.select("tavily"),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("no_identity");
    h.storage.close();
  });

  test("the owner may read and change it", async () => {
    const h = harness();
    const actor = h.auth.actorFrom({ id: OWNER_ID });

    const read = await h.admin.runAdmin(
      { actor, operation: "search.menu", permission: "admin.view" },
      () => h.service.view(),
    );
    expect(read.ok).toBe(true);

    const write = await h.admin.runAdmin(
      { actor, operation: "search.pick", permission: "settings.manage" },
      () => h.service.select("tavily"),
    );
    expect(write.ok).toBe(true);
    expect(h.service.view().provider).toBe("tavily");
    h.storage.close();
  });

  test("denied attempts are audited", async () => {
    const h = harness();
    await h.admin.runAdmin(
      { actor: h.auth.actorFrom({ id: 999999 }), operation: "search.pick", permission: "settings.manage" },
      () => h.service.select("tavily"),
    );
    const events = h.storage.auditEvents(20);
    expect(events.some((e) => e.operation === "search.pick" && e.outcome === "denied")).toBe(true);
    h.storage.close();
  });

  test("the audit trail never contains the key", async () => {
    const h = harness();
    await h.admin.runAdmin(
      { actor: h.auth.actorFrom({ id: OWNER_ID }), operation: "search.set_key", permission: "settings.manage" },
      () => h.service.setKey(API_KEY),
    );
    const dump = JSON.stringify(h.storage.auditEvents(50));
    expect(dump).not.toContain(API_KEY);
    h.storage.close();
  });
});
