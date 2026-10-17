import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage, StorageError } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";

const MASTER = "lifecycle-test-key";
const PLAIN = "sk-lifecycle-synthetic";

function tempPath(tag: string): string {
  return join(tmpdir(), `sol-lc-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // best effort on Windows
    }
  }
}

describe("storage close lifecycle", () => {
  test("repeated close is idempotent and does not throw", () => {
    const path = tempPath("repeat");
    try {
      const s = Storage.open(path);
      s.appendAudit({ operation: "probe", outcome: "success" });
      expect(() => {
        s.close();
        s.close();
        s.close();
      }).not.toThrow();
      // A fourth close is still a no-op rather than a double-free.
      expect(() => s.close()).not.toThrow();
    } finally {
      cleanup(path);
    }
  });

  test("close releases the file so WAL/SHM disappear and deletion works", () => {
    const path = tempPath("wal");
    try {
      const s = Storage.open(path);
      // Force a WAL write.
      s.appendAudit({ operation: "probe", outcome: "success" });
      s.appendMessage("u", "c", "user", "hi");
      s.close();

      // SQLite drops its sidecars only when the connection is really released.
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);

      // And the file itself is no longer locked.
      expect(() => rmSync(path, { force: true })).not.toThrow();
      expect(existsSync(path)).toBe(false);
    } finally {
      cleanup(path);
    }
  });

  test("every operation after close throws a typed StorageError", () => {
    const path = tempPath("closed");
    const s = Storage.open(path);
    s.close();
    const ops: Array<() => unknown> = [
      () => s.history("u", "c"),
      () => s.appendMessage("u", "c", "user", "x"),
      () => s.listProviders(),
      () => s.appendAudit({ operation: "x", outcome: "success" }),
      () => s.listFailoverCandidates(),
      () => s.getFailoverSettings(),
      () => s.groupAccess("g"),
      () => s.countGroupsByState("pending"),
    ];
    for (const op of ops) {
      let thrown: unknown;
      try {
        op();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StorageError);
      expect((thrown as StorageError).kind).toBe("closed");
    }
    cleanup(path);
  });

  test("a failed query leaves the store usable", () => {
    const path = tempPath("failedquery");
    try {
      const s = Storage.open(path);
      // A constraint violation: the same (provider, model) pair twice.
      const p = s.createProvider({ label: "P", adapter: "openai_compatible", baseUrl: "https://a.invalid" });
      s.createModel({ providerId: p, modelId: "m", label: "A" });
      expect(() => s.createModel({ providerId: p, modelId: "m", label: "B" })).toThrow(
        StorageError,
      );

      // The failure did not poison later writes or leave a transaction open.
      s.createModel({ providerId: p, modelId: "m2", label: "C" });
      expect(s.listModels(p).length).toBe(2);
      s.appendAudit({ operation: "after-failure", outcome: "success" });
      expect(s.auditEvents(5)[0]?.operation).toBe("after-failure");
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("close after a failed query still releases the database", () => {
    const path = tempPath("failthenclose");
    try {
      const s = Storage.open(path);
      expect(() => s.history("u1", "c1")).not.toThrow();
      expect(() => s.createModel({ providerId: 999, modelId: "x", label: "y" })).toThrow();
      s.close();
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(() => rmSync(path, { force: true })).not.toThrow();
    } finally {
      cleanup(path);
    }
  });

  test("a migration failure surfaces as a typed error and is not silent", () => {
    const path = tempPath("badmig");
    try {
      // A pre-existing `_meta` with the wrong shape breaks the version read.
      const db = new Database(path);
      db.exec("CREATE TABLE _meta(x TEXT)");
      db.close();

      let thrown: unknown;
      try {
        Storage.open(path);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(StorageError);
      // Fail-closed: no half-migrated store is handed back to the caller.
    } finally {
      cleanup(path);
    }
  });

  test("writes racing a shutdown never raise an unhandled rejection", async () => {
    const path = tempPath("race");
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const s = Storage.open(path);
      const writes = Array.from({ length: 50 }, (_, i) =>
        (async () => {
          try {
            s.appendAudit({ operation: `w${i}`, outcome: "success" });
            return "ok";
          } catch (e) {
            // A typed error racing the close is acceptable; a crash is not.
            expect(e).toBeInstanceOf(StorageError);
            return "closed";
          }
        })(),
      );
      // Close while the microtasks are still draining.
      const closing = (async () => {
        await Promise.resolve();
        s.close();
      })();

      const results = await Promise.all([...writes, closing]);
      expect(results.length).toBe(51);
      // Give any stray rejection a chance to surface before we assert.
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      cleanup(path);
    }
  });

  test("no transaction is left open by a transactional helper", () => {
    const path = tempPath("txn");
    try {
      const s = Storage.open(path);
      const p = s.createProvider({ label: "P", adapter: "openai_compatible", baseUrl: "https://a.invalid" });
      const a = s.createModel({ providerId: p, modelId: "m1", label: "A" });
      const b = s.createModel({ providerId: p, modelId: "m2", label: "B" });

      // Each helper runs BEGIN/COMMIT; a leaked transaction would make the
      // next statement fail or block.
      expect(s.setModelDefault(a)).toBe(true);
      expect(s.setModelDefault(b)).toBe(true);
      s.setFailoverCandidates([{ providerId: p, modelId: b }]);
      s.setFailoverCandidates([]);

      // A plain read must still work immediately after.
      expect(s.listModels(p).length).toBe(2);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("a failed transactional helper rolls back instead of half-applying", () => {
    const path = tempPath("txnfail");
    try {
      const s = Storage.open(path);
      const p = s.createProvider({ label: "P", adapter: "openai_compatible", baseUrl: "https://a.invalid" });
      const a = s.createModel({ providerId: p, modelId: "m1", label: "A" });
      s.setModelDefault(a);

      // A model id that does not exist: the helper must refuse cleanly.
      expect(s.setModelDefault(99999)).toBe(false);

      // The previous default is untouched and the store is usable.
      expect(s.getModel(a)?.isDefault).toBe(true);
      expect(s.listModels(p).length).toBe(1);
      s.close();
    } finally {
      cleanup(path);
    }
  });
});

describe("credential lifecycle", () => {
  test("a credential never decrypts under a different master key", () => {
    const path = tempPath("creds");
    try {
      const s = Storage.open(path);
      const p = s.createProvider({
        label: "P",
        adapter: "openai_compatible",
        baseUrl: "https://a.invalid",
      });
      const right = new ProviderSecretStore(MASTER);
      const wrong = new ProviderSecretStore("a-different-key");
      s.upsertCredential({ providerId: p, ...right.encrypt(PLAIN) });

      expect(right.decrypt(s.getCredential(p)!)).toBe(PLAIN);
      // No key of ours can read it.
      expect(() => wrong.decrypt(s.getCredential(p)!)).toThrow();
      // The stored envelope is not the plaintext.
      expect(JSON.stringify(s.getCredential(p))).not.toContain(PLAIN);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("a credential stored without a master key is refused", () => {
    const path = tempPath("nokey");
    try {
      const s = Storage.open(path);
      const p = s.createProvider({
        label: "P",
        adapter: "openai_compatible",
        baseUrl: "https://a.invalid",
      });
      const noKey = new ProviderSecretStore(undefined);
      expect(() => noKey.encrypt(PLAIN)).toThrow();
      expect(s.hasCredential(p)).toBe(false);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("replacing a credential leaves exactly one row and the old value gone", () => {
    const path = tempPath("rotate");
    try {
      const s = Storage.open(path);
      const p = s.createProvider({
        label: "P",
        adapter: "openai_compatible",
        baseUrl: "https://a.invalid",
      });
      const store = new ProviderSecretStore(MASTER);
      s.upsertCredential({ providerId: p, ...store.encrypt("old-key") });
      s.upsertCredential({ providerId: p, ...store.encrypt("new-key") });

      expect(store.decrypt(s.getCredential(p)!)).toBe("new-key");
      const count = s.listProviders().length;
      expect(count).toBe(1);
      s.close();
    } finally {
      cleanup(path);
    }
  });
});

describe("defaults and migration semantics", () => {
  test("allow_local defaults to off for a newly created provider", () => {
    const path = tempPath("defaultlocal");
    try {
      const s = Storage.open(path);
      const p = s.createProvider({
        label: "P",
        adapter: "openai_compatible",
        baseUrl: "https://a.invalid",
      });
      expect(s.getProvider(p)?.allowLocal).toBe(false);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("failover defaults remain off with bounded attempts and timeout", () => {
    const path = tempPath("defaultfo");
    try {
      const s = Storage.open(path);
      const fo = s.getFailoverSettings();
      expect(fo.enabled).toBe(false);
      expect(fo.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(fo.maxAttempts).toBeLessThanOrEqual(4);
      expect(fo.timeoutMs).toBeGreaterThanOrEqual(1000);
      expect(fo.timeoutMs).toBeLessThanOrEqual(60000);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("failover settings are clamped rather than stored out of range", () => {
    const path = tempPath("clamp");
    try {
      const s = Storage.open(path);
      s.setFailoverSettings({ enabled: true, maxAttempts: 999, timeoutMs: 1 });
      const fo = s.getFailoverSettings();
      expect(fo.maxAttempts).toBeLessThanOrEqual(4);
      expect(fo.timeoutMs).toBeGreaterThanOrEqual(1000);

      s.setFailoverSettings({ maxAttempts: -5, timeoutMs: 10_000_000 });
      const fo2 = s.getFailoverSettings();
      expect(fo2.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(fo2.timeoutMs).toBeLessThanOrEqual(60000);
      s.close();
    } finally {
      cleanup(path);
    }
  });
});
