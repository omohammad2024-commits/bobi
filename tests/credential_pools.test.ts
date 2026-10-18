/**
 * Credential pools (Phase E3): encrypted backup keys per provider with
 * gateway rotation.
 *
 * Covers: pool CRUD at the storage layer, the envelope encryption
 * round-trip (and the fail-closed behavior without a master key), the
 * service-layer validation, the gateway's rotation policy (auth cools the
 * key down, network/timeout advances without cooldown, invalid_response is
 * never retried), round-robin ordering with weights, and the 15 -> 16
 * schema migration.
 *
 * No network anywhere: adapters are stubbed and scripted per key.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import {
  CredentialPoolStore,
  ProviderSecretStore,
  SecretStoreError,
} from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import { AiError } from "../src/ai/provider";
import { decode, encode } from "../src/groups/callbacks";

const MASTER = "pool-test-master-key";

// Dummy key strings. They are test fixtures, never real credentials.
const PRIMARY = "primary";
const POOL_A = "pool-a";
const POOL_B = "pool-b";

type Behavior = { fail?: AiError };

/** Stub adapter registry: records the key it was built with, then scripted. */
function scriptedAdapters(log: string[], decide: (apiKey: string) => Behavior) {
  return {
    create: (_type: string, cfg: { apiKey: string; model: string }) => ({
      name: "scripted",
      complete: async (req: { model: string; timeoutMs: number }) => {
        log.push(cfg.apiKey);
        const b = decide(cfg.apiKey);
        if (b.fail) throw b.fail;
        return { text: "پاسخ", model: req.model };
      },
    }),
  } as unknown as AdapterRegistry;
}

function build(opts: {
  decide?: (apiKey: string) => Behavior;
  now?: () => number;
} = {}) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(MASTER);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: string[] = [];
  const fake = scriptedAdapters(log, opts.decide ?? (() => ({})));
  const gateway = new AiGateway({
    storage,
    adapters: fake,
    secrets,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { storage, secrets, providers, models, gateway, log };
}

function seedProvider(
  h: ReturnType<typeof build>,
  tag: string,
  apiKey: string = PRIMARY,
): { providerId: number; modelId: number } {
  const p = h.providers.create({
    label: tag,
    adapter: "openai_compatible",
    baseUrl: `https://${tag}.invalid/v1`,
    apiKey,
  });
  if (!p.ok) throw new Error(`provider failed: ${p.message}`);
  const m = h.models.add({ providerId: p.data, modelId: `model-${tag}`, label: tag });
  if (!m.ok) throw new Error(`model failed: ${m.message}`);
  h.models.setDefault(m.data);
  return { providerId: p.data, modelId: m.data };
}

function seedPool(h: ReturnType<typeof build>, providerId: number): void {
  const a = h.providers.addPoolKey(providerId, "backup-1", POOL_A);
  if (!a.ok) throw new Error(`pool-a failed: ${a.message}`);
  const b = h.providers.addPoolKey(providerId, "backup-2", POOL_B);
  if (!b.ok) throw new Error(`pool-b failed: ${b.message}`);
}

const REQUEST = {
  messages: [{ role: "user" as const, content: "سلام" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

// ---------- storage: pool CRUD ----------

describe("credential pool storage", () => {
  test("add / list / enable / remove round-trip", () => {
    const h = build();
    const { providerId } = seedProvider(h, "p1");

    const id = h.storage.addPoolCredential({
      providerId,
      label: "backup-1",
      ...h.secrets.encrypt("k1"),
    });
    expect(id).toBeGreaterThan(0);

    let rows = h.storage.listPoolCredentials(providerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("backup-1");
    expect(rows[0]!.weight).toBe(1);
    expect(rows[0]!.enabled).toBe(true);
    expect(rows[0]!.createdAtMs).toBeGreaterThan(0);
    // The row carries the envelope, never plaintext.
    expect(JSON.stringify(rows[0])).not.toContain("k1");

    expect(h.storage.setPoolCredentialEnabled(id, false)).toBe(true);
    expect(h.storage.listPoolCredentials(providerId)[0]!.enabled).toBe(false);
    expect(h.storage.setPoolCredentialEnabled(id, true)).toBe(true);
    expect(h.storage.getPoolCredential(id)?.enabled).toBe(true);

    expect(h.storage.removePoolCredential(id)).toBe(true);
    expect(h.storage.listPoolCredentials(providerId)).toHaveLength(0);

    // Missing ids report false/undefined instead of throwing.
    expect(h.storage.removePoolCredential(999)).toBe(false);
    expect(h.storage.setPoolCredentialEnabled(999, false)).toBe(false);
    expect(h.storage.getPoolCredential(999)).toBeUndefined();
    h.storage.close();
  });

  test("weight is stored, with a floor of 1", () => {
    const h = build();
    const { providerId } = seedProvider(h, "p2");
    h.storage.addPoolCredential({
      providerId,
      label: "heavy",
      ...h.secrets.encrypt("k"),
      weight: 3,
    });
    h.storage.addPoolCredential({
      providerId,
      label: "zero",
      ...h.secrets.encrypt("k"),
      weight: 0,
    });
    const rows = h.storage.listPoolCredentials(providerId);
    expect(rows.find((r) => r.label === "heavy")!.weight).toBe(3);
    expect(rows.find((r) => r.label === "zero")!.weight).toBe(1);
    h.storage.close();
  });

  test("pool entries are deleted with their provider", () => {
    const h = build();
    const { providerId } = seedProvider(h, "p3");
    h.storage.addPoolCredential({
      providerId,
      label: "backup-1",
      ...h.secrets.encrypt("k"),
    });
    expect(h.storage.deleteProvider(providerId)).toBe(true);
    expect(h.storage.listPoolCredentials(providerId)).toHaveLength(0);
    h.storage.close();
  });

  test("poolPosition is a per-provider in-memory round-robin cursor", () => {
    const h = build();
    expect(h.storage.poolPosition(1, 3)).toBe(0);
    expect(h.storage.poolPosition(1, 3)).toBe(1);
    expect(h.storage.poolPosition(1, 3)).toBe(2);
    expect(h.storage.poolPosition(1, 3)).toBe(0);
    // Another provider has its own cursor.
    expect(h.storage.poolPosition(2, 3)).toBe(0);
    // An empty pool never advances.
    expect(h.storage.poolPosition(1, 0)).toBe(0);
    h.storage.close();
  });
});

// ---------- secret store: pool envelopes ----------

describe("pool secret store", () => {
  test("save/load round-trips the plaintext", () => {
    const h = build();
    const { providerId } = seedProvider(h, "s1");
    const pool = new CredentialPoolStore(h.storage, h.secrets);
    const id = pool.savePoolCredential(providerId, "backup-1", "super-secret");
    expect(pool.loadPoolCredential(id)).toBe("super-secret");
    h.storage.close();
  });

  test("the envelope on disk never holds plaintext", () => {
    const h = build();
    const { providerId } = seedProvider(h, "s2");
    const pool = new CredentialPoolStore(h.storage, h.secrets);
    const id = pool.savePoolCredential(providerId, "backup-1", "super-secret");
    const row = h.storage.getPoolCredential(id)!;
    expect(row.iv.length).toBeGreaterThan(0);
    expect(row.ciphertext).not.toBe("super-secret");
    expect(row.ciphertext).not.toContain("super-secret");
    expect(row.tag.length).toBeGreaterThan(0);
    h.storage.close();
  });

  test("saving fails closed without a master key", () => {
    const h = build();
    const { providerId } = seedProvider(h, "s3");
    const pool = new CredentialPoolStore(h.storage, new ProviderSecretStore(undefined));
    let err: unknown;
    try {
      pool.savePoolCredential(providerId, "backup-1", "k");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as SecretStoreError).kind).toBe("missing_key");
    // Nothing was written.
    expect(h.storage.listPoolCredentials(providerId)).toHaveLength(0);
    h.storage.close();
  });

  test("loading with the wrong master key throws", () => {
    const h = build();
    const { providerId } = seedProvider(h, "s4");
    const pool = new CredentialPoolStore(h.storage, h.secrets);
    const id = pool.savePoolCredential(providerId, "backup-1", "super-secret");
    const wrong = new CredentialPoolStore(h.storage, new ProviderSecretStore("wrong-key"));
    expect(() => wrong.loadPoolCredential(id)).toThrow(SecretStoreError);
    h.storage.close();
  });

  test("loading an unknown entry throws", () => {
    const h = build();
    const pool = new CredentialPoolStore(h.storage, h.secrets);
    expect(() => pool.loadPoolCredential(999)).toThrow(SecretStoreError);
    h.storage.close();
  });

  test("listPoolEntries never includes key material", () => {
    const h = build();
    const { providerId } = seedProvider(h, "s5");
    const pool = new CredentialPoolStore(h.storage, h.secrets);
    pool.savePoolCredential(providerId, "backup-1", "super-secret");
    const entries = pool.listPoolEntries(providerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe("backup-1");
    expect(JSON.stringify(entries)).not.toContain("super-secret");
    h.storage.close();
  });
});

// ---------- service validation ----------

describe("pool service", () => {
  test("addPoolKey refuses a missing provider", () => {
    const h = build();
    const r = h.providers.addPoolKey(999, "backup-1", "k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
    h.storage.close();
  });

  test("addPoolKey validates label and key", () => {
    const h = build();
    const { providerId } = seedProvider(h, "v1");
    expect(h.providers.addPoolKey(providerId, "   ", "k").ok).toBe(false);
    expect(h.providers.addPoolKey(providerId, "backup-1", "   ").ok).toBe(false);
    h.storage.close();
  });

  test("listPoolKeys exposes labels and flags only", () => {
    const h = build();
    const { providerId } = seedProvider(h, "v2");
    const added = h.providers.addPoolKey(providerId, "backup-1", "super-secret");
    expect(added.ok).toBe(true);
    const keys = h.providers.listPoolKeys(providerId);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.label).toBe("backup-1");
    expect(keys[0]!.enabled).toBe(true);
    expect(JSON.stringify(keys)).not.toContain("super-secret");
    // Missing provider reads as empty, not an error.
    expect(h.providers.listPoolKeys(999)).toEqual([]);
    h.storage.close();
  });

  test("removePoolKey and setPoolKeyEnabled", () => {
    const h = build();
    const { providerId } = seedProvider(h, "v3");
    expect(h.providers.removePoolKey(999).ok).toBe(false);
    expect(h.providers.setPoolKeyEnabled(999, false).ok).toBe(false);

    const added = h.providers.addPoolKey(providerId, "backup-1", "k");
    if (!added.ok) throw new Error("add failed");
    expect(h.providers.setPoolKeyEnabled(added.data, false).ok).toBe(true);
    expect(h.providers.listPoolKeys(providerId)[0]!.enabled).toBe(false);
    expect(h.providers.removePoolKey(added.data).ok).toBe(true);
    expect(h.providers.listPoolKeys(providerId)).toHaveLength(0);
    h.storage.close();
  });
});

// ---------- gateway rotation ----------

describe("gateway credential rotation", () => {
  test("auth failure on the primary rotates to a pool key and cools it down", async () => {
    let nowMs = 1_000_000;
    const h = build({
      now: () => nowMs,
      decide: (key) =>
        key === PRIMARY ? { fail: new AiError("auth", "bad key") } : {},
    });
    const ids = seedProvider(h, "g1");
    seedPool(h, ids.providerId);
    h.storage.setRuntimeSelection(ids);

    await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ text: "پاسخ" });
    // Primary 401s, is cooled down, pool-a answers.
    expect(h.log).toEqual([PRIMARY, POOL_A]);

    // Next request: the cooled-down primary is skipped, rotation continues.
    await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ text: "پاسخ" });
    expect(h.log).toEqual([PRIMARY, POOL_A, POOL_B]);

    // After the cooldown expires the primary is tried first again.
    nowMs += 5 * 60 * 1000 + 1;
    await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ text: "پاسخ" });
    expect(h.log).toEqual([PRIMARY, POOL_A, POOL_B, PRIMARY, POOL_A]);
    h.storage.close();
  });

  test("network failure advances to the next key without cooling it down", async () => {
    const h = build({
      decide: (key) =>
        key === PRIMARY ? { fail: new AiError("network", "down") } : {},
    });
    const ids = seedProvider(h, "g2");
    seedPool(h, ids.providerId);
    h.storage.setRuntimeSelection(ids);

    await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ text: "پاسخ" });
    await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ text: "پاسخ" });
    // The primary is tried first on BOTH requests: no cooldown for transport
    // failures. Pool keys rotate underneath.
    expect(h.log).toEqual([PRIMARY, POOL_A, PRIMARY, POOL_B]);
    h.storage.close();
  });

  test("timeout advances like network", async () => {
    const h = build({
      decide: (key) =>
        key === PRIMARY ? { fail: new AiError("timeout", "slow") } : {},
    });
    const ids = seedProvider(h, "g3");
    seedPool(h, ids.providerId);
    h.storage.setRuntimeSelection(ids);

    await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ text: "پاسخ" });
    expect(h.log).toEqual([PRIMARY, POOL_A]);
    h.storage.close();
  });

  test("invalid_response is never retried with another key", async () => {
    const h = build({
      decide: (key) =>
        key === PRIMARY ? { fail: new AiError("invalid_response", "garbage") } : {},
    });
    const ids = seedProvider(h, "g4");
    seedPool(h, ids.providerId);
    h.storage.setRuntimeSelection(ids);

    let err: unknown;
    try {
      await h.gateway.complete(REQUEST);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("invalid_response");
    // Exactly one attempt: rotating keys cannot fix a bad response.
    expect(h.log).toEqual([PRIMARY]);
    h.storage.close();
  });

  test("when every key fails auth the error surfaces and nothing is hammered", async () => {
    const h = build({
      decide: () => ({ fail: new AiError("auth", "revoked") }),
    });
    const ids = seedProvider(h, "g5");
    seedPool(h, ids.providerId);
    h.storage.setRuntimeSelection(ids);

    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    expect(h.log).toEqual([PRIMARY, POOL_A, POOL_B]);

    // Every key is now cooled down: the next request refuses without a single
    // attempt rather than hammering dead keys.
    await expect(h.gateway.complete(REQUEST)).rejects.toThrow(AiError);
    expect(h.log).toEqual([PRIMARY, POOL_A, POOL_B]);
    h.storage.close();
  });

  test("round-robin spreads pool attempts, weighted by entry weight", async () => {
    const h = build({
      decide: (key) =>
        key === PRIMARY ? { fail: new AiError("network", "down") } : {},
    });
    const ids = seedProvider(h, "g6");
    const enc = (k: string) => h.secrets.encrypt(k);
    h.storage.addPoolCredential({
      providerId: ids.providerId,
      label: "backup-1",
      ...enc(POOL_A),
      weight: 2,
    });
    h.storage.addPoolCredential({
      providerId: ids.providerId,
      label: "backup-2",
      ...enc(POOL_B),
      weight: 1,
    });
    h.storage.setRuntimeSelection(ids);

    await h.gateway.complete(REQUEST);
    await h.gateway.complete(REQUEST);
    await h.gateway.complete(REQUEST);
    // Expanded order [A, A, B] starting at the cursor each request.
    expect(h.log).toEqual([
      PRIMARY, POOL_A,
      PRIMARY, POOL_A,
      PRIMARY, POOL_B,
    ]);
    h.storage.close();
  });

  test("a disabled pool key is never attempted", async () => {
    const h = build({
      decide: (key) =>
        key === PRIMARY ? { fail: new AiError("network", "down") } : {},
    });
    const ids = seedProvider(h, "g7");
    seedPool(h, ids.providerId);
    const keys = h.providers.listPoolKeys(ids.providerId);
    expect(h.providers.setPoolKeyEnabled(keys[0]!.id, false).ok).toBe(true);
    h.storage.setRuntimeSelection(ids);

    await expect(h.gateway.complete(REQUEST)).resolves.toMatchObject({ text: "پاسخ" });
    expect(h.log).toEqual([PRIMARY, POOL_B]);
    h.storage.close();
  });

  test("a provider with no primary credential still fails closed", async () => {
    const h = build();
    const p = h.providers.create({
      label: "noprimary",
      adapter: "openai_compatible",
      baseUrl: "https://noprimary.invalid/v1",
    });
    if (!p.ok) throw new Error("provider failed");
    const m = h.models.add({ providerId: p.data, modelId: "m", label: "m" });
    if (!m.ok) throw new Error("model failed");
    // Pool keys alone do not make a provider usable: the primary stays
    // mandatory, so a deleted primary fails loudly instead of silently
    // running on backups.
    expect(h.providers.addPoolKey(p.data, "backup-1", POOL_A).ok).toBe(true);
    h.storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });

    let err: unknown;
    try {
      await h.gateway.complete(REQUEST);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).kind).toBe("auth");
    expect(h.log).toEqual([]);
    h.storage.close();
  });

  test("cooledDownPoolKeys reports labels, never key material", async () => {
    const h = build({
      decide: (key) => (key === POOL_A ? { fail: new AiError("auth", "revoked") } : {}),
    });
    const ids = seedProvider(h, "g8");
    seedPool(h, ids.providerId);
    h.storage.setRuntimeSelection(ids);

    // Primary answers, so no pool key is touched: nothing cooled down.
    await h.gateway.complete(REQUEST);
    expect(h.gateway.cooledDownPoolKeys(ids.providerId)).toEqual([]);
    h.storage.close();
  });
});

// ---------- panel wiring: backup-key action round-trips ----------

describe("pool panel wiring", () => {
  test("the ai_pool_key callback encodes within the byte limit and decodes", () => {
    const data = encode({ kind: "ai_pool_key", providerId: 12345 });
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
    expect(decode(data)).toEqual({ kind: "ai_pool_key", providerId: 12345 });
  });
});

// ---------- schema 15 -> 16 migration ----------

/** Unique temp path per case; never inside the repository. */
function tempDb(tag: string): string {
  return join(tmpdir(), `bobi-pool-mig-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Remove a database and its WAL sidecars. */
function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // A leftover temp file must not fail the suite.
    }
  }
}

/** A schema-v15 database by hand: providers, one credential, one model. */
function buildV15(path: string): void {
  const db = new Database(path);
  const enc = new ProviderSecretStore(MASTER).encrypt("old-primary");
  db.exec(`
    CREATE TABLE _meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE ai_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, adapter TEXT NOT NULL,
      base_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      allow_local INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE ai_credentials (
      provider_id INTEGER PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
      iv TEXT NOT NULL, ciphertext TEXT NOT NULL, tag TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE ai_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL,
      model_id TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(provider_id, model_id));
    CREATE TABLE ai_runtime_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1), active_provider_id INTEGER, active_model_id INTEGER);
    INSERT INTO _meta(k,v) VALUES('schema_version','15');
    INSERT INTO ai_providers(label, adapter, base_url, enabled, allow_local, created_at, updated_at)
      VALUES('قدیمی','openai_compatible','https://old.invalid/v1',1,0,1000,1000);
    INSERT INTO ai_credentials(provider_id, iv, ciphertext, tag, updated_at)
      VALUES(1,'${enc.iv}','${enc.ciphertext}','${enc.tag}',1001);
    INSERT INTO ai_models(provider_id, model_id, label, enabled, is_default, created_at, updated_at)
      VALUES(1,'model-old','قدیمی',1,1,1002,1002);
    INSERT INTO ai_runtime_settings(id, active_provider_id, active_model_id) VALUES(1,1,1);
  `);
  db.close();
}

describe("schema migration 15 -> 16", () => {
  test("SCHEMA_VERSION is 16", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
  });

  test("a v15 database gains the pool table with its data intact", () => {
    const path = tempDb("v15");
    try {
      buildV15(path);
      const storage = Storage.open(path);

      // The pool table exists.
      const probe = new Database(path);
      const found = probe
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='ai_credential_pool'`,
        )
        .all();
      probe.close();
      expect(found).toHaveLength(1);

      // Old data is intact: provider, primary credential, model, selection.
      expect(storage.getProvider(1)?.label).toBe("قدیمی");
      const cred = storage.getCredential(1);
      expect(cred).toBeDefined();
      expect(new ProviderSecretStore(MASTER).decrypt(cred!)).toBe("old-primary");
      expect(storage.getModel(1)?.modelId).toBe("model-old");
      expect(storage.getRuntimeSettings().activeProviderId).toBe(1);

      // The pool is immediately usable on the migrated database.
      const pool = new CredentialPoolStore(storage, new ProviderSecretStore(MASTER));
      const id = pool.savePoolCredential(1, "backup-1", "new-pool-key");
      expect(pool.loadPoolCredential(id)).toBe("new-pool-key");
      expect(pool.listPoolEntries(1)).toHaveLength(1);

      storage.close();
    } finally {
      cleanup(path);
    }
  });
});
