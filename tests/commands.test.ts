import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { ConversationEngine, type CompressResult } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import {
  COMMAND_HELP,
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
  test("non-owners see exactly the public surface: start, help, commands, voice", () => {
    const entries = visibleCommandHelp(false);
    const names = entries.map((c) => c.name);
    expect(names).toEqual(["start", "help", "commands", "voice"]);
    expect(names).not.toContain("admin");
    expect(names).not.toContain("ai");
    expect(names).not.toContain("model");
    expect(names).not.toContain("history");
    expect(names).not.toContain("ban");
  });

  test("owners see everything", () => {
    const names = visibleCommandHelp(true).map((c) => c.name);
    expect(names).toContain("admin");
    expect(names).toContain("ai");
    expect(names).toContain("ban");
    expect(names).toContain("digest");
    expect(names).toContain("skill");
    expect(names).toContain("bench");
    expect(names).toContain("gassistant");
    expect(names).toHaveLength(73);
  });

  test("every entry has an English one-line description", () => {
    for (const c of visibleCommandHelp(true)) {
      expect(c.description.trim().length).toBeGreaterThan(0);
      expect(c.description).not.toContain("\n");
    }
  });

  test("formatted help lists /name — description lines", () => {
    const text = formatCommandHelp(visibleCommandHelp(false));
    expect(text).toContain("/help — Command reference");
    expect(text).not.toContain("/admin");
  });

  test("public help shows only the general group — no session/automation/owner sections", () => {
    const text = formatCommandHelp(visibleCommandHelp(false));
    expect(text).toContain("🔹 General");
    expect(text).not.toContain("🗂 Session");
    expect(text).not.toContain("⚡️ Automation");
    expect(text).not.toContain("🔒 Owner");
    expect(text).not.toContain("/history");
  });

  test("commands with examples render a one-line usage (owner help)", () => {
    const text = formatCommandHelp(visibleCommandHelp(true));
    expect(text).toContain("/history 20 — Show conversation history");
    expect(text).toContain("/undo 2 — Undo the last turns");
    const en = formatCommandHelp(visibleCommandHelp(true), "en");
    expect(en).toContain("/history 20 — Show conversation history");
  });

  test("owner help gains the owner section; sections render in a fixed order", () => {
    const text = formatCommandHelp(visibleCommandHelp(true));
    expect(text).toContain("🔒 Owner");
    expect(text).toContain("/admin — Bot admin panel");
    expect(text.indexOf("🔹 General")).toBeLessThan(text.indexOf("🗂 Session"));
    expect(text.indexOf("🗂 Session")).toBeLessThan(text.indexOf("⚡️ Automation"));
    expect(text.indexOf("⚡️ Automation")).toBeLessThan(text.indexOf("🔒 Owner"));
  });

  test("every entry has a valid group; only the public four are visible to non-owners", () => {
    for (const c of COMMAND_HELP) {
      expect(["general", "session", "automation", "owner"]).toContain(c.group);
      // Two-tier model: owner-only entries keep their display group (the
      // owner's /help stays categorized); the tier flag is what gates.
      if (!c.ownerOnly) {
        expect(["start", "help", "commands", "voice"]).toContain(c.name);
      }
    }
    expect(COMMAND_HELP.length).toBe(73);
    expect(visibleCommandHelp(false).map((c) => c.name)).toEqual([
      "start",
      "help",
      "commands",
      "voice",
    ]);
  });
});

// ---------- /reset ----------

function stubCtx(chatId: number | string, userId: number | string, text = "/reset --confirm") {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chat: { id: chatId },
      from: { id: userId },
      message: { text },
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
    expect(replies[0]).toContain("history was cleared");
    // The in-flight registration is gone, so /stop finds nothing afterwards.
    expect(stopTurn("100")).toBe(false);
  });

  test("bare /reset asks for confirmation instead of wiping", async () => {
    const cleared: unknown[] = [];
    const engine = {
      cancel: () => {},
      clearHistory: (input: unknown) => {
        cleared.push(input);
      },
    };
    const { ctx, replies } = stubCtx(100, 5, "/reset");
    await handleResetCommand(ctx, { engine });

    expect(cleared).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("--confirm");
  });

  test("a crafted --confirmx flag does not smuggle consent", async () => {
    const cleared: unknown[] = [];
    const engine = {
      cancel: () => {},
      clearHistory: (input: unknown) => {
        cleared.push(input);
      },
    };
    const { ctx, replies } = stubCtx(100, 5, "/reset --confirmx");
    await handleResetCommand(ctx, { engine });

    expect(cleared).toEqual([]);
    expect(replies[0]).toContain("--confirm");
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
  test("each seam outcome maps to its English reply", async () => {
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
  test("aborts the in-flight turn and confirms in English", async () => {
    const cancelled: string[] = [];
    const engine = { cancel: (id: string) => cancelled.push(id) };
    const controller = enterTurn("55");
    const { ctx, replies } = stubCtx(55, 7);
    await handleStopCommand(ctx, { engine });
    expect(controller.signal.aborted).toBe(true);
    expect(cancelled).toEqual(["55"]);
    expect(replies).toEqual(["Stopped ✅"]);
  });

  test("reports when nothing is running", async () => {
    const cancelled: string[] = [];
    const engine = { cancel: (id: string) => cancelled.push(id) };
    const { ctx, replies } = stubCtx(66, 7);
    await handleStopCommand(ctx, { engine });
    expect(replies).toEqual(["Nothing was running."]);
    expect(cancelled).toEqual([]);
  });
});
