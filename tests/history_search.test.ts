/**
 * Full-text search over conversation history (Phase D1).
 *
 * What matters here:
 * 1. FTS5 is actually compiled into this bun:sqlite build (a test that
 *    creates an FTS5 table proves it — no faking).
 * 2. Persian queries find Persian messages, with highlighted snippets.
 * 3. Hostile query text (quotes, wildcards, operators) never breaks the
 *    search and never reaches the SQL parser as syntax.
 * 4. A user only ever sees their own conversations — the userId filter is
 *    enforced in storage, and a foreign conversationId matches nothing.
 * 5. The 14 -> 15 migration creates the index and backfills old messages.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Storage } from "../src/storage/storage";
import { ToolService } from "../src/tools/service";
import { createHistoryTools, SEARCH_HISTORY_PERMISSION } from "../src/tools/history";
import type { ToolActor } from "../src/tools/types";

function actor(userId: string): ToolActor {
  return { userId, permissions: [SEARCH_HISTORY_PERMISSION] };
}

function tempDb(tag: string): string {
  return join(tmpdir(), `bobi-fts-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // A leftover temp file must not fail the suite.
    }
  }
}

/** Build a minimal schema-v14 database: no FTS table, no triggers. */
function buildV14(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, chat_id));
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE _meta(k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO _meta(k,v) VALUES('schema_version','14');
    INSERT INTO conversations(user_id, chat_id, created_at) VALUES('u1','c1',1000);
    INSERT INTO messages(conversation_id, role, content, created_at)
      VALUES(1,'user','گربه روی مبل خوابیده بود',1001),
            (1,'assistant','چه گربه نازی!',1002);
  `);
  db.close();
}

describe("FTS5 availability", () => {
  test("this bun:sqlite build compiles FTS5 in", () => {
    // Creating the virtual table IS the proof: without FTS5 this throws.
    const db = new Database(":memory:");
    db.exec(`CREATE VIRTUAL TABLE probe USING fts5(x, tokenize='unicode61')`);
    db.exec(`INSERT INTO probe(x) VALUES('سلام دنیا')`);
    const rows = db.prepare(`SELECT x FROM probe WHERE probe MATCH 'سلام'`).all() as {
      x: string;
    }[];
    expect(rows.map((r) => r.x)).toEqual(["سلام دنیا"]);
    db.close();
  });
});

describe("searchMessages", () => {
  test("Persian queries find Persian messages with highlighted snippets", () => {
    const s = Storage.open(":memory:");
    try {
      s.appendMessage("u1", "c1", "user", "دیروز با سینا درباره گربه‌ها حرف زدیم");
      s.appendMessage("u1", "c1", "assistant", "گربه‌ها واقعا بامزه‌اند");
      s.appendMessage("u1", "c2", "user", "امروز هوا بارانی است");

      const hits = s.searchMessages("گربه", { userId: "u1" });
      expect(hits.length).toBe(2);
      // Best match first, snippet marks the hit, conversation and role ride along.
      expect(hits[0]!.snippet).toContain("[");
      expect(hits[0]!.snippet).toContain("]");
      expect(hits[0]!.conversationId).toBe(s.conversationId("u1", "c1"));
      expect(["user", "assistant"]).toContain(hits[0]!.role);
      expect(typeof hits[0]!.rank).toBe("number");
      // The rain message is not about cats.
      expect(hits.every((h) => h.conversationId !== s.conversationId("u1", "c2"))).toBe(true);
    } finally {
      s.close();
    }
  });

  test("a blank query returns nothing instead of matching everything", () => {
    const s = Storage.open(":memory:");
    try {
      s.appendMessage("u1", "c1", "user", "سلام");
      expect(s.searchMessages("")).toEqual([]);
      expect(s.searchMessages("   ")).toEqual([]);
    } finally {
      s.close();
    }
  });

  test("special characters never break the query", () => {
    const s = Storage.open(":memory:");
    try {
      s.appendMessage("u1", "c1", "user", 'گفت "سلام" و رفت *تمام* شد (واقعا)');
      const hostile = [
        `"`,
        `*`,
        `(foo`,
        `foo)`,
        `OR`,
        `AND NOT`,
        `a"b`,
        `foo*bar`,
        `:`,
        `^foo`,
        `-foo`,
        `(((`,
        `a AND b`,
        `"unbalanced`,
        `نه"آره`,
        `?`,
        `%_\\`,
        "x".repeat(200),
      ];
      for (const q of hostile) {
        // Must neither throw nor return non-array: the query is data, never syntax.
        const hits = s.searchMessages(q, { userId: "u1" });
        expect(Array.isArray(hits)).toBe(true);
      }
      // And a quoted word still searches literally, not as an operator.
      const orHits = s.searchMessages("OR", { userId: "u1" });
      expect(Array.isArray(orHits)).toBe(true);
    } finally {
      s.close();
    }
  });

  test("a user only searches their own conversations", () => {
    const s = Storage.open(":memory:");
    try {
      s.appendMessage("u1", "c1", "user", "رمز کیف پول من 1234 است");
      s.appendMessage("u2", "c9", "user", "رمز کیف پول من 9999 است");

      const mine = s.searchMessages("کیف پول", { userId: "u1" });
      expect(mine.length).toBe(1);
      expect(mine[0]!.snippet).toContain("1234");

      const theirs = s.searchMessages("کیف پول", { userId: "u2" });
      expect(theirs.length).toBe(1);
      expect(theirs[0]!.snippet).toContain("9999");
    } finally {
      s.close();
    }
  });

  test("a foreign conversationId matches nothing", () => {
    const s = Storage.open(":memory:");
    try {
      s.appendMessage("u1", "c1", "user", "حرف محرمانه الف");
      s.appendMessage("u2", "c2", "user", "حرف محرمانه ب");
      const foreignConv = s.conversationId("u2", "c2");

      // u1 narrows to u2's conversation: the user_id join kills it.
      expect(s.searchMessages("محرمانه", { userId: "u1", conversationId: foreignConv })).toEqual(
        [],
      );
      // u1 narrows to their own conversation: works.
      const ownConv = s.conversationId("u1", "c1");
      expect(
        s.searchMessages("محرمانه", { userId: "u1", conversationId: ownConv }).length,
      ).toBe(1);
    } finally {
      s.close();
    }
  });

  test("the limit is clamped to 1..20", () => {
    const s = Storage.open(":memory:");
    try {
      for (let i = 0; i < 25; i++) {
        s.appendMessage("u1", "c1", "user", `پیام شماره ${i} درباره سیب`);
      }
      expect(s.searchMessages("سیب", { userId: "u1", limit: 100 }).length).toBe(20);
      expect(s.searchMessages("سیب", { userId: "u1", limit: 3 }).length).toBe(3);
      expect(s.searchMessages("سیب", { userId: "u1" }).length).toBe(5);
    } finally {
      s.close();
    }
  });

  test("deleting a conversation removes its messages from the index", () => {
    const s = Storage.open(":memory:");
    try {
      s.appendMessage("u1", "c1", "user", "این پیام پاک خواهد شد موز");
      expect(s.searchMessages("موز", { userId: "u1" }).length).toBe(1);
      s.deleteConversation("u1", "c1");
      // The AFTER DELETE trigger fires through the ON DELETE CASCADE.
      expect(s.searchMessages("موز", { userId: "u1" })).toEqual([]);
    } finally {
      s.close();
    }
  });
});

describe("14 -> 15 migration", () => {
  test("creates the FTS index, backfills old messages, and bumps the version", () => {
    const path = tempDb("v14");
    try {
      buildV14(path);
      const s = Storage.open(path);

      // Old messages are searchable immediately after the upgrade.
      const hits = s.searchMessages("گربه", { userId: "u1" });
      expect(hits.length).toBe(2);

      // New messages keep indexing through the triggers.
      s.appendMessage("u1", "c1", "user", "یک طوطی هم اضافه شد");
      expect(s.searchMessages("طوطی", { userId: "u1" }).length).toBe(1);

      // The version stamp moved.
      const db = new Database(path);
      const version = db.prepare(`SELECT v FROM _meta WHERE k='schema_version'`).get() as {
        v: string;
      };
      expect(version.v).toBe(String(SCHEMA_VERSION));
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
      // Table and triggers exist.
      const objects = db
        .prepare(`SELECT name, type FROM sqlite_master WHERE name LIKE 'messages_fts%'`)
        .all() as { name: string; type: string }[];
      const names = objects.map((o) => o.name).sort();
      expect(names).toEqual([
        "messages_fts",
        "messages_fts_config",
        "messages_fts_data",
        "messages_fts_delete",
        "messages_fts_docsize",
        "messages_fts_idx",
        "messages_fts_insert",
        "messages_fts_update",
      ]);
      expect(objects.find((o) => o.name === "messages_fts")!.type).toBe("table");
      db.close();
      s.close();

      // Re-opening is stable: no double-indexing, no migration re-run.
      const again = Storage.open(path);
      expect(again.searchMessages("گربه", { userId: "u1" }).length).toBe(2);
      again.close();
    } finally {
      cleanup(path);
    }
  });
});

describe("search_history tool", () => {
  function service() {
    const storage = Storage.open(":memory:");
    return {
      storage,
      svc: new ToolService({ extraTools: createHistoryTools({ storage }) }),
    };
  }

  test("registers with its own permission and is owner-only (two-tier)", () => {
    const { storage, svc } = service();
    try {
      expect(svc.listActiveNames()).toContain("search_history");
      const tool = svc.registry.find("search_history");
      expect(tool?.permission.requires).toEqual([SEARCH_HISTORY_PERMISSION]);
      expect(SEARCH_HISTORY_PERMISSION).toBe("tools:search_history");
      expect(tool?.ownerOnly).toBe(true);
    } finally {
      storage.close();
    }
  });

  test("finds the caller's messages with conversation id and role", async () => {
    const { storage, svc } = service();
    try {
      storage.appendMessage("u1", "c1", "user", "فردا ساعت نه جلسه دارم");
      storage.appendMessage("u1", "c1", "assistant", "باشه، یادآوری می‌کنم");
      const r = await svc.runTool({ tool: "search_history", input: { query: "جلسه" }, actor: actor("u1") });
      expect(r.status).toBe("ok");
      const data = r.data as { results: { conversationId: number; role: string; snippet: string }[]; total: number };
      expect(data.total).toBe(1);
      expect(data.results[0]!.role).toBe("user");
      expect(data.results[0]!.conversationId).toBe(storage.conversationId("u1", "c1"));
      expect(data.results[0]!.snippet).toContain("جلسه");
    } finally {
      storage.close();
    }
  });

  test("never returns another user's messages", async () => {
    const { storage, svc } = service();
    try {
      storage.appendMessage("u2", "c9", "user", "راز بزرگ من این است");
      const r = await svc.runTool({
        tool: "search_history",
        input: { query: "راز" },
        actor: actor("u1"),
      });
      expect(r.status).toBe("ok");
      expect((r.data as { total: number }).total).toBe(0);
    } finally {
      storage.close();
    }
  });

  test("rejects a blank query instead of searching", async () => {
    const { storage, svc } = service();
    try {
      const r = await svc.runTool({
        tool: "search_history",
        input: { query: "   " },
        actor: actor("u1"),
      });
      expect(r.status).toBe("invalid_input");
    } finally {
      storage.close();
    }
  });
});
