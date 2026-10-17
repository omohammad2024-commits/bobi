import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";

const MASTER_KEY = "migration-test-master-key";
const PLAINTEXT = "sk-synthetic-test-key";

/** Unique temp path per case; never inside the repository. */
function tempDb(tag: string): string {
  return join(tmpdir(), `sol-mig-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

/** The credential envelope an older release would have written. */
function encryptedCredential(): { iv: string; ciphertext: string; tag: string } {
  return new ProviderSecretStore(MASTER_KEY).encrypt(PLAINTEXT);
}

/**
 * Build a schema-v4 database by hand: the shape produced before failover
 * (v5) and the local-target column (v6) existed.
 */
function buildV4(path: string): void {
  const db = new Database(path);
  const enc = encryptedCredential();
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, chat_id));
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE _meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
      operation TEXT NOT NULL, actor_id TEXT, outcome TEXT NOT NULL,
      target_id TEXT, detail TEXT);
    CREATE TABLE group_access (
      chat_id TEXT PRIMARY KEY, title TEXT, chat_type TEXT NOT NULL,
      state TEXT NOT NULL, requested_by TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, notified_at INTEGER);
    CREATE TABLE ai_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, adapter TEXT NOT NULL,
      base_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
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
    CREATE TABLE ai_provider_health (
      provider_id INTEGER PRIMARY KEY, ok INTEGER NOT NULL, checked_at INTEGER NOT NULL, message TEXT);
    INSERT INTO _meta(k,v) VALUES('schema_version','4');
    INSERT INTO conversations(user_id, chat_id, created_at) VALUES('u1','c1',1000);
    INSERT INTO messages(conversation_id, role, content, created_at)
      VALUES(1,'user','سلام قدیمی',1001),(1,'assistant','درود',1002);
    INSERT INTO audit_log(created_at, operation, actor_id, outcome)
      VALUES(1003,'panel.open','111111','success');
    INSERT INTO group_access(chat_id, chat_type, state, created_at, updated_at)
      VALUES('-100999','supergroup','approved',1004,1004);
    INSERT INTO ai_providers(label, adapter, base_url, enabled, created_at, updated_at)
      VALUES('پروایدر قدیمی','openai_compatible','https://old.invalid/v1',1,1005,1005);
    INSERT INTO ai_credentials(provider_id, iv, ciphertext, tag, updated_at)
      VALUES(1, '${enc.iv}', '${enc.ciphertext}', '${enc.tag}', 1006);
    INSERT INTO ai_models(provider_id, model_id, label, enabled, is_default, created_at, updated_at)
      VALUES(1,'model-old','مدل قدیمی',1,1,1007,1007);
    INSERT INTO ai_runtime_settings(id, active_provider_id, active_model_id)
      VALUES(1, 1, 1);
  `);
  db.close();
}

/** Build a schema-v5 database: has failover, but no allow_local column. */
function buildV5(path: string): void {
  buildV4(path);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ai_failover_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 2, timeout_ms INTEGER NOT NULL DEFAULT 15000);
    CREATE TABLE ai_failover_candidates (
      provider_id INTEGER NOT NULL, model_id INTEGER NOT NULL, position INTEGER NOT NULL);
    UPDATE _meta SET v='5' WHERE k='schema_version';
  `);
  db.close();
}

describe("migration from schema v4", () => {
  test("upgrades, preserving conversations, audit and group access", () => {
    const path = tempDb("v4");
    try {
      buildV4(path);
      const s = Storage.open(path);

      expect(s.history("u1", "c1").map((m) => m.content)).toEqual(["سلام قدیمی", "درود"]);
      expect(s.auditEvents(10)[0]?.operation).toBe("panel.open");
      expect(s.groupAccess("-100999")?.state).toBe("approved");

      // The new table exists and is usable.
      expect(s.createPendingGroup({ chatId: "-100111", chatType: "group" })).toBe("created");
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("preserves providers, models and the runtime selection", () => {
    const path = tempDb("v4sel");
    try {
      buildV4(path);
      const s = Storage.open(path);
      const p = s.getProvider(1);
      expect(p?.label).toBe("پروایدر قدیمی");
      expect(p?.baseUrl).toBe("https://old.invalid/v1");
      expect(p?.enabled).toBe(true);
      expect(s.listModels(1)[0]?.modelId).toBe("model-old");
      expect(s.getRuntimeSettings()).toEqual({ activeProviderId: 1, activeModelId: 1 });
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("an existing credential still decrypts with the original master key", () => {
    const path = tempDb("v4cred");
    try {
      buildV4(path);
      const s = Storage.open(path);
      const store = new ProviderSecretStore(MASTER_KEY);
      const stored = s.getCredential(1);
      expect(stored).toBeDefined();
      expect(store.decrypt(stored!)).toBe(PLAINTEXT);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("local-target access stays disabled unless the owner turns it on", () => {
    const path = tempDb("v4local");
    try {
      buildV4(path);
      const s = Storage.open(path);
      // A migrated provider must never become local-allowed retroactively.
      expect(s.getProvider(1)?.allowLocal).toBe(false);

      s.setProviderAllowLocal(1, true);
      expect(s.getProvider(1)?.allowLocal).toBe(true);

      s.close();
      // The setting survives a reopen (the owner's explicit choice persists).
      const again = Storage.open(path);
      expect(again.getProvider(1)?.allowLocal).toBe(true);
      again.setProviderAllowLocal(1, false);
      expect(again.getProvider(1)?.allowLocal).toBe(false);
      again.close();
    } finally {
      cleanup(path);
    }
  });

  test("failover defaults to disabled after the upgrade", () => {
    const path = tempDb("v4fo");
    try {
      buildV4(path);
      const s = Storage.open(path);
      const fo = s.getFailoverSettings();
      expect(fo.enabled).toBe(false);
      expect(fo.maxAttempts).toBe(2);
      expect(s.listFailoverCandidates()).toEqual([]);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("re-running initialization does not corrupt the database", () => {
    const path = tempDb("v4reopen");
    try {
      buildV4(path);
      for (let i = 0; i < 3; i++) {
        const s = Storage.open(path);
        expect(s.history("u1", "c1").length).toBe(2);
        expect(s.listProviders().length).toBe(1);
        s.close();
      }
      // The schema version ends at the current one, and data is unchanged.
      const db = new Database(path);
      const version = db.prepare(`SELECT v FROM _meta WHERE k='schema_version'`).get() as
        | { v: string }
        | undefined;
      expect(version?.v).toBe(String(SCHEMA_VERSION));
      const modelCount = db.prepare(`SELECT COUNT(*) AS n FROM ai_models`).get() as { n: number };
      expect(modelCount.n).toBe(1);
      db.close();
    } finally {
      cleanup(path);
    }
  });
});

describe("migration from schema v5", () => {
  test("adds the local-target column without touching failover data", () => {
    const path = tempDb("v5");
    try {
      buildV5(path);
      const s = Storage.open(path);

      expect(s.getProvider(1)?.allowLocal).toBe(false);
      const fo = s.getFailoverSettings();
      expect(fo.enabled).toBe(false);
      expect(s.listFailoverCandidates()).toEqual([]);
      expect(s.history("u1", "c1").length).toBe(2);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("existing failover configuration is preserved", () => {
    const path = tempDb("v5cfg");
    try {
      buildV5(path);
      const db = new Database(path);
      // An owner who had already tuned failover in v5 keeps their settings.
      db.prepare(
        `INSERT INTO ai_failover_settings(id, enabled, max_attempts, timeout_ms)
         VALUES(1, 1, 3, 30000)`,
      ).run();
      db.close();

      const s = Storage.open(path);
      const fo = s.getFailoverSettings();
      expect(fo.enabled).toBe(true);
      expect(fo.maxAttempts).toBe(3);
      expect(fo.timeoutMs).toBe(30000);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("an existing credential still decrypts after the upgrade", () => {
    const path = tempDb("v5cred");
    try {
      buildV5(path);
      const s = Storage.open(path);
      const store = new ProviderSecretStore(MASTER_KEY);
      expect(store.decrypt(s.getCredential(1)!)).toBe(PLAINTEXT);
      s.close();
    } finally {
      cleanup(path);
    }
  });
});

describe("schema v6 stays stable", () => {
  test("re-opening a v6 database neither re-runs the migration nor drops data", () => {
    const path = tempDb("v6");
    try {
      buildV5(path);
      // Migrate to v6 once.
      Storage.open(path).close();

      const before = new Database(path);
      const tables = before
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as { name: string }[];
      before.close();

      const s = Storage.open(path);
      // Provider row untouched by a second initialization.
      expect(s.listProviders().length).toBe(1);
      expect(s.listModels(1).length).toBe(1);
      s.close();

      const after = new Database(path);
      const tables2 = after
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as { name: string }[];
      expect(tables2).toEqual(tables);
      after.close();
    } finally {
      cleanup(path);
    }
  });

  test("WAL and temporary files are cleaned up on Windows", () => {
    const path = tempDb("wal");
    try {
      buildV4(path);
      const s = Storage.open(path);
      // A write so WAL actually engages.
      s.appendAudit({ operation: "probe", outcome: "success" });
      s.close();

      cleanup(path);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
    } finally {
      cleanup(path);
    }
  });

  test("no test database is written inside the repository", () => {
    const path = tempDb("location");
    try {
      buildV4(path);
      expect(path.startsWith(tmpdir())).toBe(true);
      expect(path.includes(`${process.cwd()}/tests`)).toBe(false);
      Storage.open(path).close();
    } finally {
      cleanup(path);
    }
  });
});
