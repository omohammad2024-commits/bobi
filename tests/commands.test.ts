import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { ConversationEngine, type CompressResult } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import {
  visibleCommandHelp,
  formatCommandHelp,
  handleResetCommand,
  handleCompressCommand,
  handleStopCommand,
  enterTurn,
  exitTurn,
  stopTurn,
  COMPRESS_REPLIES,
} from "../src/bot/bot";

// ---------- /help ----------

describe("/help visibility", () => {
  test("non-owners never see owner-only commands", () => {
    const entries = visibleCommandHelp(false);
    const names = entries.map((c) => c.name);
    expect(names).not.toContain("admin");
    expect(names).not.toContain("ai");
    expect(names).toContain("help");
    expect(names).toContain("reset");
    expect(names).toContain("compress");
    expect(names).toContain("stop");
    expect(names).toContain("personality");
  });

  test("owners see everything", () => {
    const names = visibleCommandHelp(true).map((c) => c.name);
    expect(names).toContain("admin");
    expect(names).toContain("ai");
  });

  test("every entry has a Persian one-line description", () => {
    for (const c of visibleCommandHelp(true)) {
      expect(c.descriptionFa.trim().length).toBeGreaterThan(0);
      expect(c.descriptionFa).not.toContain("\n");
    }
  });

  test("formatted help lists /name — description lines", () => {
    const text = formatCommandHelp(visibleCommandHelp(false));
    expect(text).toContain("/help — راهنمای دستورها");
    expect(text).not.toContain("/admin");
  });
});

// ---------- /reset ----------

function stubCtx(chatId: number | string, userId: number | string) {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chat: { id: chatId },
      from: { id: userId },
      async reply(t: string) {
        replies.push(t);
      },
    },
  };
}

describe("/reset scoping", () => {
  test("clears only the current chat, scoped by user+chat", async () => {
    const cancelled: string[] = [];
    const cleared: Array<{ conversationId: string; userId?: string }> = [];
    const engine = {
      cancel: (id: string) => {
        cancelled.push(id);
      },
      clearHistory: (input: { conversationId: string; userId?: string }) => {
        cleared.push(input);
      },
    };
    // Simulate an in-flight turn in this chat: /reset must drop it.
    enterTurn("100");
    const { ctx, replies } = stubCtx(100, 5);
    await handleResetCommand(ctx, { engine });

    expect(cancelled).toEqual(["100"]);
    // Exactly one clear, scoped to THIS user+chat — nothing broader.
    expect(cleared).toEqual([{ conversationId: "100", userId: "5" }]);
    expect(replies[0]).toContain("پاک شد");
    // The in-flight registration is gone, so /stop finds nothing afterwards.
    expect(stopTurn("100")).toBe(false);
  });

  test("engine.clearHistory against real storage deletes one chat only", () => {
    const storage = Storage.open(":memory:");
    try {
      storage.appendMessage("u1", "chatA", "user", "hello A");
      storage.appendMessage("u1", "chatB", "user", "hello B");
      const engine = new ConversationEngine({
        provider: new FakeProvider(),
        model: "fake",
        timeoutMs: 1000,
        maxConcurrent: 1,
        storage,
      });
      engine.clearHistory({ conversationId: "chatA", userId: "u1" });
      expect(storage.history("u1", "chatA", 10)).toEqual([]);
      expect(storage.history("u1", "chatB", 10).map((r) => r.content)).toEqual([
        "hello B",
      ]);
    } finally {
      storage.close();
    }
  });
});

// ---------- /compress ----------

describe("/compress", () => {
  test("each seam outcome maps to its Persian reply", async () => {
    for (const result of ["compressed", "nothing_to_compress", "failed", "unavailable"] as const) {
      const engine = {
        async compressNow(): Promise<CompressResult> {
          return result;
        },
      };
      const { ctx, replies } = stubCtx(1, 2);
      await handleCompressCommand(ctx, { engine });
      expect(replies).toEqual([COMPRESS_REPLIES[result]]);
    }
  });

  test("the reply is a confirmation, never the summary text", async () => {
    const engine = {
      async compressNow(): Promise<CompressResult> {
        return "compressed";
      },
    };
    const { ctx, replies } = stubCtx(1, 2);
    await handleCompressCommand(ctx, { engine });
    expect(replies[0]).not.toContain("خلاصهٔ گفت‌وگوی قبلی");
  });

  test("a throwing seam reports failure instead of crashing", async () => {
    const engine = {
      async compressNow(): Promise<CompressResult> {
        throw new Error("boom");
      },
    };
    const { ctx, replies } = stubCtx(1, 2);
    await handleCompressCommand(ctx, { engine });
    expect(replies).toEqual([COMPRESS_REPLIES.failed]);
  });
});

describe("engine.compressNow", () => {
  function openEngine(storage?: Storage) {
    return new ConversationEngine({
      provider: new FakeProvider(),
      model: "fake",
      timeoutMs: 5000,
      maxConcurrent: 1,
      ...(storage !== undefined ? { storage } : {}),
      historyLimit: 4,
    });
  }

  test("unavailable without storage", async () => {
    const engine = openEngine();
    expect(await engine.compressNow({ conversationId: "c1", userId: "u1" })).toBe(
      "unavailable",
    );
  });

  test("nothing_to_compress when the window has not overflowed", async () => {
    const storage = Storage.open(":memory:");
    try {
      storage.appendMessage("u1", "c1", "user", "hi");
      storage.appendMessage("u1", "c1", "assistant", "hello");
      const engine = openEngine(storage);
      expect(await engine.compressNow({ conversationId: "c1", userId: "u1" })).toBe(
        "nothing_to_compress",
      );
      // No summary row was created.
      expect(storage.getConversationSummary("u1", "c1")).toBeUndefined();
    } finally {
      storage.close();
    }
  });

  test("compressed folds overflow into the summary and keeps history", async () => {
    const storage = Storage.open(":memory:");
    try {
      // historyLimit 4 → 12 stored messages leave 8 in overflow (≥ 6).
      for (let i = 1; i <= 6; i++) {
        storage.appendMessage("u1", "c1", "user", `user message ${i}`);
        storage.appendMessage("u1", "c1", "assistant", `assistant message ${i}`);
      }
      const engine = openEngine(storage);
      expect(await engine.compressNow({ conversationId: "c1", userId: "u1" })).toBe(
        "compressed",
      );
      // The summary was stored with the watermark advanced past the batch.
      const stored = storage.getConversationSummary("u1", "c1");
      expect(stored).toBeDefined();
      expect(stored!.summary.length).toBeGreaterThan(0);
      expect(stored!.summarisedUntil).toBeGreaterThan(0);
      // History itself is untouched: /compress folds, it does not delete.
      expect(storage.history("u1", "c1", 100).length).toBe(12);
      // A second immediate call finds nothing new to compress.
      expect(await engine.compressNow({ conversationId: "c1", userId: "u1" })).toBe(
        "nothing_to_compress",
      );
    } finally {
      storage.close();
    }
  });
});

// ---------- /stop ----------

describe("/stop registry", () => {
  test("enterTurn/stopTurn abort a fake in-flight turn", () => {
    const controller = enterTurn("chat-9");
    expect(stopTurn("chat-9")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // A finished turn never looks in-flight.
    expect(stopTurn("chat-9")).toBe(false);
  });

  test("exitTurn removes a finished turn", () => {
    enterTurn("chat-10");
    exitTurn("chat-10");
    expect(stopTurn("chat-10")).toBe(false);
  });

  test("turns in different chats are independent", () => {
    const a = enterTurn("chatA");
    const b = enterTurn("chatB");
    expect(stopTurn("chatA")).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    exitTurn("chatB");
  });
});

describe("/stop command", () => {
  test("aborts the in-flight turn and confirms in Persian", async () => {
    const cancelled: string[] = [];
    const engine = { cancel: (id: string) => cancelled.push(id) };
    const controller = enterTurn("55");
    const { ctx, replies } = stubCtx(55, 7);
    await handleStopCommand(ctx, { engine });
    expect(controller.signal.aborted).toBe(true);
    expect(cancelled).toEqual(["55"]);
    expect(replies).toEqual(["متوقف شد ✅"]);
  });

  test("reports when nothing is running", async () => {
    const cancelled: string[] = [];
    const engine = { cancel: (id: string) => cancelled.push(id) };
    const { ctx, replies } = stubCtx(66, 7);
    await handleStopCommand(ctx, { engine });
    expect(replies).toEqual(["چیزی در حال اجرا نبود."]);
    expect(cancelled).toEqual([]);
  });
});
