import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Storage, StorageError } from "../src/storage/storage";
import { ConversationEngine } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import { AiError } from "../src/ai/provider";

function openMemory(): Storage {
  return Storage.open(":memory:");
}

describe("storage", () => {
  test("creates schema and repeated initialization is safe", () => {
    const db = openMemory();
    expect(() => db.conversationId("u1", "c1")).not.toThrow();
    db.close();
  });

  test("stores and retrieves chronological messages with limit", () => {
    const db = openMemory();
    for (let i = 1; i <= 5; i++) db.appendMessage("u1", "c1", "user", `m${i}`);
    const rows = db.history("u1", "c1", 3);
    expect(rows.map((r) => r.content)).toEqual(["m3", "m4", "m5"]);
    db.close();
  });

  test("different users and chats are isolated", () => {
    const db = openMemory();
    db.appendMessage("u1", "c1", "user", "private");
    db.appendMessage("u2", "c1", "user", "other-user");
    db.appendMessage("u1", "c2", "user", "other-chat");
    expect(db.history("u1", "c1", 50)[0]?.content).toBe("private");
    expect(db.history("u2", "c1", 50)[0]?.content).toBe("other-user");
    expect(db.history("u1", "c2", 50)[0]?.content).toBe("other-chat");
    expect(db.history("u3", "c1", 50)).toEqual([]);
    db.close();
  });

  test("delete removes only the owned conversation", () => {
    const db = openMemory();
    db.appendMessage("u1", "c1", "user", "one");
    db.appendMessage("u2", "c1", "user", "two");
    db.deleteConversation("u1", "c1");
    expect(db.history("u1", "c1")).toEqual([]);
    expect(db.history("u2", "c1").length).toBe(1);
    db.close();
  });

  test("closed database returns an internal storage error", () => {
    const db = openMemory();
    db.close();
    expect(() => db.history("u1", "c1")).toThrow(StorageError);
  });

  test("data persists after close and reopen", () => {
    // os.tmpdir() resolves on every platform; TMPDIR is unset on Windows, so a
    // temp database must never fall back into the repository.
    const path = `${tmpdir()}/sol-storage-${Date.now()}.db`;
    const first = Storage.open(path);
    first.appendMessage("u1", "c1", "assistant", "persisted");
    first.close();
    const second = Storage.open(path);
    expect(second.history("u1", "c1")[0]?.content).toBe("persisted");
    second.deleteConversation("u1", "c1");
    second.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(path + suffix, { force: true });
      } catch {
        // Best effort; a leftover temp file must not fail the suite.
      }
    }
  });
});

describe("engine with persistent storage", () => {
  test("successful turns persist and failed response does not", async () => {
    const db = openMemory();
    const engine = new ConversationEngine({
      provider: new FakeProvider(), model: "fake", timeoutMs: 1000, maxConcurrent: 2, storage: db,
    });
    await engine.respond({ userId: "u1", conversationId: "c1", userText: "hello" });
    const rows = db.history("u1", "c1");
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[0]?.content).toBe("hello");
    db.close();
  });

  test("history sent to provider is capped", async () => {
    const db = openMemory();
    for (let i = 0; i < 10; i++) db.appendMessage("u1", "c1", "user", `old${i}`);
    let seen = 0;
    const provider = {
      name: "capture",
      async complete(req: { messages: unknown[]; model: string; timeoutMs: number; signal: AbortSignal }) {
        seen = req.messages.length;
        return { text: "ok", model: req.model };
      },
    };
    const engine = new ConversationEngine({
      provider, model: "x", timeoutMs: 1000, maxConcurrent: 1, storage: db, historyLimit: 3,
      // Compaction off: this test pins the raw window, not the summary path.
      summariseHistory: false,
    });
    await engine.respond({ userId: "u1", conversationId: "c1", userText: "new" });
    expect(seen).toBe(4); // 3 stored + new user message
    db.close();
  });

  test("overflow is compacted into a summary rather than dropped silently", async () => {
    const db = openMemory();
    for (let i = 0; i < 20; i++) db.appendMessage("u1", "c1", "user", `old${i}`);
    let captured: Array<{ role: string; content: string }> = [];
    let calls = 0;
    const provider = {
      name: "capture",
      async complete(req: {
        messages: Array<{ role: string; content: string }>;
        model: string;
        timeoutMs: number;
        signal: AbortSignal;
      }) {
        calls++;
        // The first call is the summariser; the second is the real turn.
        if (calls === 1) return { text: "خلاصه‌ای از گفت‌وگوی قبلی", model: "x" };
        captured = req.messages;
        return { text: "ok", model: req.model };
      },
    };
    const engine = new ConversationEngine({
      provider, model: "x", timeoutMs: 1000, maxConcurrent: 1, storage: db, historyLimit: 5,
    });
    await engine.respond({ userId: "u1", conversationId: "c1", userText: "new" });

    // A summarisation call happened...
    expect(calls).toBe(2);
    // ...and the turn carries a summary ahead of the recent window.
    const system = captured.filter((m) => m.role === "system");
    expect(system).toHaveLength(1);
    expect(system[0]!.content).toContain("خلاصه");

    db.close();
  });

  test("a failed summarisation still lets the turn succeed", async () => {
    const db = openMemory();
    for (let i = 0; i < 20; i++) db.appendMessage("u1", "c1", "user", `old${i}`);
    const provider = {
      name: "flaky",
      async complete(req: { messages: Array<{ role: string }>; model: string }) {
        // Housekeeping calls fail; the real turn answers.
        const isSummary = req.messages.length === 1;
        if (isSummary) throw new AiError("network", "boom");
        return { text: "پاسخ", model: req.model };
      },
    };
    const engine = new ConversationEngine({
      provider, model: "x", timeoutMs: 1000, maxConcurrent: 1, storage: db, historyLimit: 5,
    });
    // Compaction is best-effort, so the request must still complete.
    const out = await engine.respond({ userId: "u1", conversationId: "c1", userText: "new" });
    expect(out.chunks.join("")).toContain("پاسخ");
    db.close();
  });
});
