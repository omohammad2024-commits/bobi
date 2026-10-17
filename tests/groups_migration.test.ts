import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { Storage } from "../src/storage/storage";

/**
 * Migration coverage for the group-access table (schema v3).
 *
 * A version-2 database built by hand stands in for one written by an earlier
 * release, so these tests prove the upgrade preserves what was already there.
 */
function buildV2Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      chat_id     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(user_id, chat_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS _meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  INTEGER NOT NULL,
      operation   TEXT NOT NULL,
      actor_id    TEXT,
      outcome     TEXT NOT NULL,
      target_id   TEXT,
      detail      TEXT
    );
    INSERT INTO _meta(k,v) VALUES('schema_version','2');
    INSERT INTO conversations(user_id, chat_id, created_at) VALUES('u1','c1',1000);
    INSERT INTO messages(conversation_id, role, content, created_at)
      VALUES(1,'user','سلام',1001),(1,'assistant','درود',1002);
    INSERT INTO audit_log(created_at, operation, actor_id, outcome, detail)
      VALUES(1003,'settings.model','111111','success','permission=settings.manage');
  `);
  db.close();
}

function tempPath(): string {
  // os.tmpdir() resolves on every platform; TMPDIR is unset on Windows, so a
  // temp file must never fall back into the repository.
  const dir = tmpdir();
  return `${dir}/_mig-v3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function cleanup(path: string): void {
  // Windows can hold a WAL handle briefly after close, so retry once.
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = path + suffix;
    try {
      if (existsSync(file)) rmSync(file, { force: true });
    } catch {
      try {
        if (existsSync(file)) rmSync(file, { force: true });
      } catch {
        // Best effort; a leftover temp file must not fail the suite.
      }
    }
  }
}

describe("schema migration to v3", () => {
  test("existing messages survive the upgrade", () => {
    const path = tempPath();
    try {
      buildV2Database(path);
      const s = Storage.open(path);
      const history = s.history("u1", "c1");
      expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(history.map((m) => m.content)).toEqual(["سلام", "درود"]);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("existing audit records survive the upgrade", () => {
    const path = tempPath();
    try {
      buildV2Database(path);
      const s = Storage.open(path);
      const rows = s.auditEvents(10);
      expect(rows.length).toBe(1);
      expect(rows[0]?.operation).toBe("settings.model");
      expect(rows[0]?.outcome).toBe("success");
      expect(rows[0]?.actorId).toBe("111111");
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("the group_access table exists after the upgrade", () => {
    const path = tempPath();
    try {
      buildV2Database(path);
      const s = Storage.open(path);
      // Writing then reading a group proves the table was created.
      expect(s.createPendingGroup({ chatId: "-100555", chatType: "group" })).toBe("created");
      expect(s.groupAccess("-100555")?.state).toBe("pending");
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("conversations still work after the upgrade", () => {
    const path = tempPath();
    try {
      buildV2Database(path);
      const s = Storage.open(path);
      // The same conversation still resolves, and new messages append.
      s.appendMessage("u1", "c1", "user", "ادامه");
      expect(s.history("u1", "c1").length).toBe(3);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("the upgrade is idempotent", () => {
    const path = tempPath();
    try {
      buildV2Database(path);
      const first = Storage.open(path);
      first.close();
      // Reopening must not duplicate or reset anything.
      const second = Storage.open(path);
      const third = Storage.open(path);
      expect(second.history("u1", "c1").length).toBe(2);
      expect(third.history("u1", "c1").length).toBe(2);
      expect(second.auditEvents(10).length).toBe(1);
      second.close();
      third.close();
    } finally {
      cleanup(path);
    }
  });

  test("a fresh database starts at the current version", () => {
    const path = tempPath();
    try {
      const s = Storage.open(path);
      // Group writes work without any prior migration step.
      expect(s.createPendingGroup({ chatId: "-1", chatType: "group" })).toBe("created");
      s.appendAudit({ operation: "probe", outcome: "success" });
      expect(s.auditEvents(5).length).toBe(1);
      s.close();
    } finally {
      cleanup(path);
    }
  });

  test("the audit retention cap holds after the upgrade", () => {
    const path = tempPath();
    try {
      buildV2Database(path);
      const s = Storage.open(path);
      for (let i = 0; i < 60; i++) {
        s.appendAudit({ operation: `op${i}`, outcome: "success" });
      }
      const kept = s.auditEvents(10000);
      // 1 pre-existing row + 60 new ones; the cap keeps the newest.
      expect(kept.length).toBe(61);
      expect(kept[0]?.operation).toBe("op59");
      s.close();
    } finally {
      cleanup(path);
    }
  });
});
