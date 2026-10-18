import { describe, expect, test } from "bun:test";
import { InputFile } from "grammy";
import { Storage } from "../src/storage/storage";
import { ConversationEngine } from "../src/conversation/engine";
import { FakeProvider } from "../src/ai/fake";
import { AiError } from "../src/ai/provider";
import type { CompletionResponse } from "../src/ai/provider";
import {
  COMMAND_DEFS,
  findLastUserIndex,
  handleBranchCommand,
  handleBusyCommand,
  handleContextCommand,
  handleFooterCommand,
  handleHistoryCommand,
  handleNewCommand,
  handleResumeCommand,
  handleRetryCommand,
  handleSaveCommand,
  handleSessionsCommand,
  handleStatusCommand,
  handleTitleCommand,
  handleUndoCommand,
  handleVersionCommand,
  handleWhoamiCommand,
  parseCount,
  splitLastTurns,
  type SessionCtx,
} from "../src/bot/cmd_session";
import { tr } from "../src/bot/cmd_session_strings";

// ---------- helpers ----------

function openStorage(): Storage {
  return Storage.open(":memory:");
}

function makeEngine(storage: Storage): ConversationEngine {
  return new ConversationEngine({
    provider: new FakeProvider(),
    model: "fake-echo",
    timeoutMs: 5_000,
    maxConcurrent: 4,
    storage,
    summariseHistory: false,
  });
}

/** Seed user/assistant pairs in order. */
function seedTurns(storage: Storage, userId: string, chatId: string, pairs: [string, string][]): void {
  for (const [u, a] of pairs) {
    storage.appendMessage(userId, chatId, "user", u);
    storage.appendMessage(userId, chatId, "assistant", a);
  }
}

function contents(storage: Storage, userId: string, chatId: string): string[] {
  return storage.history(userId, chatId, 100).map((m) => `${m.role}:${m.content}`);
}

interface CapturedDoc {
  filename: string | undefined;
  caption: string | undefined;
  body: string;
}

function makeCtx(o: { userId?: string; chatId?: string; text?: string; noDoc?: boolean } = {}): {
  ctx: SessionCtx;
  replies: string[];
  docs: CapturedDoc[];
} {
  const replies: string[] = [];
  const docs: CapturedDoc[] = [];
  const ctx: SessionCtx = {
    ...(o.chatId !== undefined ? { chat: { id: o.chatId } } : {}),
    ...(o.userId !== undefined ? { from: { id: o.userId } } : {}),
    ...(o.text !== undefined ? { message: { text: o.text } } : {}),
    reply: async (t: string) => {
      replies.push(t);
      return undefined;
    },
  };
  if (!o.noDoc) {
    ctx.replyWithDocument = async (doc: InputFile, extra?: { caption?: string }) => {
      const fileData = (doc as unknown as { fileData: unknown }).fileData;
      const body = Buffer.isBuffer(fileData) ? fileData.toString("utf-8") : String(fileData);
      docs.push({ filename: doc.filename, caption: extra?.caption, body });
      return undefined;
    };
  }
  return { ctx, replies, docs };
}

// ---------- COMMAND_DEFS ----------

describe("COMMAND_DEFS", () => {
  const expected = [
    "history", "save", "retry", "undo", "title", "branch", "resume",
    "sessions", "status", "context", "busy", "whoami", "footer", "version", "new",
  ];
  test("all fifteen session commands are defined", () => {
    expect(COMMAND_DEFS.map((d) => d.command).sort()).toEqual([...expected].sort());
  });
  test("none is owner-only and all have fa+en descriptions", () => {
    for (const d of COMMAND_DEFS) {
      expect(d.ownerOnly).toBe(false);
      expect(d.descriptionFa.length).toBeGreaterThan(0);
      expect(d.descriptionEn.length).toBeGreaterThan(0);
    }
  });
});

// ---------- tr ----------

describe("tr", () => {
  test("persian lookup with vars", () => {
    expect(tr("fa", "cmd_session.history_title", { n: 3 })).toContain("3");
  });
  test("english lookup", () => {
    expect(tr("en", "cmd_session.history_empty")).toContain("No messages");
  });
  test("unknown key falls back to the key itself, never throws", () => {
    expect(tr("fa", "cmd_session.nope")).toBe("cmd_session.nope");
  });
});

// ---------- parseCount ----------

describe("parseCount", () => {
  test("accepts in-range integers", () => {
    expect(parseCount("3", 1, 30)).toBe(3);
    expect(parseCount(" 30 ", 1, 30)).toBe(30);
  });
  test("rejects junk", () => {
    expect(parseCount(undefined, 1, 30)).toBeUndefined();
    expect(parseCount("abc", 1, 30)).toBeUndefined();
    expect(parseCount("1.5", 1, 30)).toBeUndefined();
    expect(parseCount("-3", 1, 30)).toBeUndefined();
    expect(parseCount("0", 1, 30)).toBeUndefined();
    expect(parseCount("31", 1, 30)).toBeUndefined();
    expect(parseCount("3;DROP", 1, 30)).toBeUndefined();
  });
});

// ---------- splitLastTurns / findLastUserIndex ----------

describe("splitLastTurns", () => {
  const mk = (roles: ("user" | "assistant" | "system")[]) =>
    roles.map((role, i) => ({
      id: i + 1,
      conversationId: 1,
      role,
      content: `${role}${i}`,
      createdAt: i,
    }));
  test("drops exactly N turns, trailing assistant reply included", () => {
    const h = mk(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const { keep, dropped } = splitLastTurns(h, 2);
    expect(keep.map((m) => m.content)).toEqual(["user0", "assistant1"]);
    expect(dropped.map((m) => m.content)).toEqual(["user2", "assistant3", "user4", "assistant5"]);
  });
  test("fewer turns than requested drops from the first user message", () => {
    const h = mk(["system", "user", "assistant"]);
    const { keep, dropped } = splitLastTurns(h, 5);
    expect(keep.map((m) => m.content)).toEqual(["system0"]);
    expect(dropped.map((m) => m.content)).toEqual(["user1", "assistant2"]);
  });
  test("no user message drops nothing", () => {
    const h = mk(["system"]);
    const { keep, dropped } = splitLastTurns(h, 1);
    expect(keep).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });
  test("findLastUserIndex", () => {
    const h = mk(["user", "assistant", "user"]);
    expect(findLastUserIndex(h)).toBe(2);
    expect(findLastUserIndex(mk(["assistant"]))).toBe(-1);
    expect(findLastUserIndex([])).toBe(-1);
  });
});

// ---------- /history ----------

describe("/history", () => {
  test("empty conversation", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/history" });
    await handleHistoryCommand(ctx, { storage: s }, "fa");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("هنوز پیامی");
  });
  test("shows last N messages with role labels", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"], ["q2", "a2"], ["q3", "a3"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/history 4" });
    await handleHistoryCommand(ctx, { storage: s }, "fa");
    const text = replies.join("\n");
    expect(text).toContain("شما: q3");
    expect(text).toContain("بابی: a3");
    expect(text).not.toContain("q1");
    expect(text).toContain("پیام قدیمی‌تر");
  });
  test("default shows up to 10", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/history" });
    await handleHistoryCommand(ctx, { storage: s }, "fa");
    expect(replies.join("\n")).toContain("q1");
  });
  test("junk args rejected", async () => {
    const s = openStorage();
    for (const t of ["/history 0", "/history 31", "/history abc", "/history 2x"]) {
      const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: t });
      await handleHistoryCommand(ctx, { storage: s }, "fa");
      expect(replies[0]).toContain("۱ تا ۳۰");
    }
  });
  test("per-user scoping: user B cannot read user A's conversation", async () => {
    const s = openStorage();
    seedTurns(s, "uA", "c1", [["secret", "shh"]]);
    const { ctx, replies } = makeCtx({ userId: "uB", chatId: "c1", text: "/history" });
    await handleHistoryCommand(ctx, { storage: s }, "fa");
    expect(replies.join("\n")).not.toContain("secret");
    expect(replies[0]).toContain("هنوز پیامی");
  });
});

// ---------- /save ----------

describe("/save", () => {
  test("markdown document by default", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const { ctx, docs } = makeCtx({ userId: "u1", chatId: "c1", text: "/save" });
    await handleSaveCommand(ctx, { storage: s }, "fa");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toMatch(/\.md$/);
    expect(docs[0]!.body).toContain("q1");
    expect(docs[0]!.body).toContain("a1");
    expect(docs[0]!.caption).toContain("بابی");
  });
  test("json with the json argument", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const { ctx, docs } = makeCtx({ userId: "u1", chatId: "c1", text: "/save json" });
    await handleSaveCommand(ctx, { storage: s }, "fa");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.filename).toMatch(/\.json$/);
    const parsed = JSON.parse(docs[0]!.body) as { role: string; content: string }[];
    expect(parsed.map((m) => m.content)).toEqual(["q1", "a1"]);
  });
  test("junk format rejected", async () => {
    const s = openStorage();
    const { ctx, replies, docs } = makeCtx({ userId: "u1", chatId: "c1", text: "/save xml" });
    await handleSaveCommand(ctx, { storage: s }, "fa");
    expect(docs).toHaveLength(0);
    expect(replies[0]).toContain("قالب نامعتبر");
  });
  test("user B cannot export user A's conversation", async () => {
    const s = openStorage();
    seedTurns(s, "uA", "c1", [["secret", "shh"]]);
    const { ctx, replies, docs } = makeCtx({ userId: "uB", chatId: "c1", text: "/save" });
    await handleSaveCommand(ctx, { storage: s }, "fa");
    expect(docs).toHaveLength(0);
    expect(replies[0]).toContain("فایلی ساخته نشد");
  });
  test("falls back to chunked text without replyWithDocument", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/save", noDoc: true });
    await handleSaveCommand(ctx, { storage: s }, "fa");
    expect(replies.join("\n")).toContain("q1");
  });
});

// ---------- /retry ----------

describe("/retry", () => {
  test("re-runs the last user text and replaces the previous answer", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "old-a1"], ["q2", "old-a2"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/retry" });
    await handleRetryCommand(ctx, { engine, storage: s }, "fa");
    // The fake provider echoes the last user text; the old answer is gone.
    const got = contents(s, "u1", "c1");
    expect(got).toHaveLength(4);
    expect(got[2]).toBe("user:q2");
    expect(got[3]).toMatch(/^assistant:.*q2/);
    expect(got).not.toContain("assistant:old-a2");
    expect(replies.join("\n")).toContain("q2");
  });
  test("no user message → honest note", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/retry" });
    await handleRetryCommand(ctx, { engine, storage: s }, "fa");
    expect(replies[0]).toContain("چیزی برای تلاش دوباره نیست");
  });
  test("engine failure keeps history and reports safely", async () => {
    const s = openStorage();
    const failing = new ConversationEngine({
      provider: {
        name: "boom",
        async complete(): Promise<CompletionResponse> {
          throw new AiError("timeout", "timed out");
        },
      },
      model: "x",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      storage: s,
      summariseHistory: false,
    });
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/retry" });
    await handleRetryCommand(ctx, { engine: failing, storage: s }, "fa");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.length).toBeGreaterThan(0);
    // The dropped tail is restored: a failed retry loses nothing.
    expect(contents(s, "u1", "c1")).toEqual(["user:q1", "assistant:a1"]);
  });
});

// ---------- /undo ----------

describe("/undo", () => {
  test("bare /undo requires the count arg and deletes nothing", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/undo" });
    await handleUndoCommand(ctx, { engine, storage: s }, "fa");
    expect(replies[0]).toContain("/undo 2");
    expect(contents(s, "u1", "c1")).toHaveLength(2);
  });
  test("drops exactly N turns and confirms what was dropped", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "a1"], ["q2", "a2"], ["q3", "a3"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/undo 2" });
    await handleUndoCommand(ctx, { engine, storage: s }, "fa");
    expect(contents(s, "u1", "c1")).toEqual(["user:q1", "assistant:a1"]);
    expect(replies[0]).toContain("2");
    expect(replies[0]).toContain("q2");
    expect(replies[0]).toContain("q3");
  });
  test("junk counts rejected", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    for (const t of ["/undo 0", "/undo 6", "/undo abc", "/undo -1"]) {
      const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: t });
      await handleUndoCommand(ctx, { engine, storage: s }, "fa");
      expect(replies[0]).toContain("۱ تا ۵");
    }
    expect(contents(s, "u1", "c1")).toHaveLength(2);
  });
  test("more turns than exist drops everything user-sent", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/undo 5" });
    await handleUndoCommand(ctx, { engine, storage: s }, "fa");
    expect(contents(s, "u1", "c1")).toHaveLength(0);
    expect(replies[0]).toContain("1");
  });
  test("empty conversation → nothing to drop", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/undo 1" });
    await handleUndoCommand(ctx, { engine, storage: s }, "fa");
    expect(replies[0]).toContain("پیامی برای حذف وجود ندارد");
  });
  test("rolling-summary watermark is remapped to the renumbered ids", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "a1"], ["q2", "a2"]]);
    const before = s.history("u1", "c1", 10);
    const a1 = before.find((m) => m.content === "a1")!;
    s.setConversationSummary({ userId: "u1", chatId: "c1", summary: "old stuff", summarisedUntil: a1.id });
    const { ctx } = makeCtx({ userId: "u1", chatId: "c1", text: "/undo 1" });
    await handleUndoCommand(ctx, { engine, storage: s }, "fa");
    const summary = s.getConversationSummary("u1", "c1");
    expect(summary).toBeDefined();
    const after = s.history("u1", "c1", 10);
    const newA1 = after.find((m) => m.content === "a1")!;
    expect(summary!.summarisedUntil).toBe(newA1.id);
    expect(summary!.summary).toBe("old stuff");
  });
  test("summary is cleared when its watermark pointed at a dropped message", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "a1"], ["q2", "a2"]]);
    const before = s.history("u1", "c1", 10);
    const a2 = before.find((m) => m.content === "a2")!;
    s.setConversationSummary({ userId: "u1", chatId: "c1", summary: "covers a2", summarisedUntil: a2.id });
    const { ctx } = makeCtx({ userId: "u1", chatId: "c1", text: "/undo 1" });
    await handleUndoCommand(ctx, { engine, storage: s }, "fa");
    expect(s.getConversationSummary("u1", "c1")).toBeUndefined();
  });
});

// ---------- /title ----------

describe("/title", () => {
  test("round-trip via prefs", async () => {
    const s = openStorage();
    const env = { prefs: s };
    const set = makeCtx({ userId: "u1", chatId: "c1", text: "/title جلسهٔ طراحی" });
    await handleTitleCommand(set.ctx, env, "fa");
    expect(set.replies[0]).toContain("جلسهٔ طراحی");
    const show = makeCtx({ userId: "u1", chatId: "c1", text: "/title" });
    await handleTitleCommand(show.ctx, env, "fa");
    expect(show.replies[0]).toContain("جلسهٔ طراحی");
  });
  test("bare /title with no title set", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/title" });
    await handleTitleCommand(ctx, { prefs: s }, "fa");
    expect(replies[0]).toContain("عنوانی");
  });
  test("title longer than 120 chars is rejected", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: `/title ${"x".repeat(121)}` });
    await handleTitleCommand(ctx, { prefs: s }, "fa");
    expect(replies[0]).toContain("۱۲۰");
  });
  test("titles are per conversation", async () => {
    const s = openStorage();
    const env = { prefs: s };
    await handleTitleCommand(makeCtx({ userId: "u1", chatId: "c1", text: "/title one" }).ctx, env, "fa");
    const show = makeCtx({ userId: "u1", chatId: "c2", text: "/title" });
    await handleTitleCommand(show.ctx, env, "fa");
    expect(show.replies[0]).toContain("عنوانی");
  });
  test("missing pref store → honest message", async () => {
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/title x" });
    await handleTitleCommand(ctx, {}, "fa");
    expect(replies[0]).toContain("در دسترس نیست");
  });
});

// ---------- /branch ----------

describe("/branch", () => {
  test("copies the caller's history into <chatId>:<name>", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"], ["q2", "a2"]]);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/branch ideas" });
    await handleBranchCommand(ctx, { storage: s, prefs: s }, "fa");
    expect(replies[0]).toContain("c1:ideas");
    expect(contents(s, "u1", "c1:ideas")).toEqual(["user:q1", "assistant:a1", "user:q2", "assistant:a2"]);
    // Original untouched.
    expect(contents(s, "u1", "c1")).toHaveLength(4);
  });
  test("branch is invisible to another user", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const { ctx } = makeCtx({ userId: "u1", chatId: "c1", text: "/branch ideas" });
    await handleBranchCommand(ctx, { storage: s, prefs: s }, "fa");
    expect(s.history("uB", "c1:ideas", 10)).toHaveLength(0);
  });
  test("junk names rejected, usage shown without arg", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    for (const t of ["/branch", "/branch a b c d e f", "/branch x".replace("x", "y".repeat(41)), "/branch bad/name"]) {
      const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: t });
      await handleBranchCommand(ctx, { storage: s, prefs: s }, "fa");
      expect(replies[0]!.length).toBeGreaterThan(0);
    }
    expect(s.listUserConversations("u1")).toHaveLength(1);
  });
  test("empty conversation → nothing to branch", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/branch ideas" });
    await handleBranchCommand(ctx, { storage: s, prefs: s }, "fa");
    expect(replies[0]).toContain("پیامی ندارد");
  });
});

// ---------- /resume ----------

describe("/resume", () => {
  test("bare and unknown → usage / not-found", async () => {
    const s = openStorage();
    const env = { storage: s, prefs: s };
    const bare = makeCtx({ userId: "u1", chatId: "c1", text: "/resume" });
    await handleResumeCommand(bare.ctx, env, "fa");
    expect(bare.replies[0]).toContain("/sessions");
    const unknown = makeCtx({ userId: "u1", chatId: "c1", text: "/resume nope" });
    await handleResumeCommand(unknown.ctx, env, "fa");
    expect(unknown.replies[0]).toContain("پیدا نشد");
  });
  test("matches by branch suffix, stores the pref, shows history + limitation", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    seedTurns(s, "u1", "c1:ideas", [["bq", "ba"]]);
    const env = { storage: s, prefs: s };
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/resume ideas" });
    await handleResumeCommand(ctx, env, "fa");
    expect(s.getUserPref("u1", "active_conversation:c1")).toBe("c1:ideas");
    const text = replies.join("\n");
    expect(text).toContain("bq");
    expect(text).toContain("هندلر پیام");
  });
  test("matches by exact id", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "other", [["oq", "oa"]]);
    const env = { storage: s, prefs: s };
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/resume other" });
    await handleResumeCommand(ctx, env, "fa");
    expect(s.getUserPref("u1", "active_conversation:c1")).toBe("other");
    expect(replies.join("\n")).toContain("oq");
  });
});

// ---------- /sessions ----------

describe("/sessions", () => {
  test("empty → honest note", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/sessions" });
    await handleSessionsCommand(ctx, { storage: s, prefs: s }, "fa");
    expect(replies[0]).toContain("نشست دیگری");
  });
  test("lists own sessions with titles and the current mark", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    seedTurns(s, "u1", "c2", [["q2", "a2"]]);
    s.setUserPref("u1", "title:c2", "طراحی");
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/sessions" });
    await handleSessionsCommand(ctx, { storage: s, prefs: s }, "fa");
    const text = replies.join("\n");
    expect(text).toContain("طراحی");
    expect(text).toContain("فعلی");
    expect(text).not.toContain("secret");
  });
  test("another user's sessions never leak in", async () => {
    const s = openStorage();
    seedTurns(s, "uA", "c9", [["secret", "shh"]]);
    const { ctx, replies } = makeCtx({ userId: "uB", chatId: "c1", text: "/sessions" });
    await handleSessionsCommand(ctx, { storage: s, prefs: s }, "fa");
    expect(replies.join("\n")).not.toContain("c9");
  });
});

// ---------- /status ----------

describe("/status", () => {
  test("one card with session, model, counts and today's tokens", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const convId = s.conversationId("u1", "c1");
    const now = Date.now();
    s.recordUsage({ userId: "u1", conversationId: convId, providerId: 1, modelId: "m1", inputTokens: 100, outputTokens: 50, atMs: now });
    s.recordUsage({ userId: "u1", conversationId: convId, providerId: 1, modelId: "m1", inputTokens: 200, outputTokens: 25, atMs: now - 2 * 86400000 });
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/status" });
    await handleStatusCommand(ctx, { engine, storage: s, prefs: s }, "fa");
    const text = replies.join("\n");
    expect(text).toContain("c1");
    expect(text).toContain("m1");
    expect(text).toContain("2"); // message count
    expect(text).toContain("100"); // today's input only
    expect(text).not.toContain("200");
    expect(text).toContain("خیر"); // not running
  });
  test("unknown model when no usage yet", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/status" });
    await handleStatusCommand(ctx, { engine, storage: s }, "fa");
    expect(replies.join("\n")).toContain("نامشخص");
  });
});

// ---------- /context ----------

describe("/context", () => {
  test("gauge with counts, estimate and summary state", async () => {
    const s = openStorage();
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const before = s.history("u1", "c1", 10);
    s.setConversationSummary({ userId: "u1", chatId: "c1", summary: "s", summarisedUntil: before[0]!.id });
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/context" });
    await handleContextCommand(ctx, { storage: s }, "fa");
    const text = replies.join("\n");
    expect(text).toContain("پیام‌ها: 2");
    expect(text).toContain("خلاصه‌سازی: فعال");
    expect(text).toContain("تقریبی");
  });
  test("no summary yet", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/context" });
    await handleContextCommand(ctx, { storage: s }, "fa");
    expect(replies.join("\n")).toContain("خلاصه‌ای ساخته نشده");
  });
});

// ---------- /busy ----------

describe("/busy", () => {
  test("bare shows the default queue mode", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/busy" });
    await handleBusyCommand(ctx, { prefs: s }, "fa");
    expect(replies[0]).toContain("صف");
  });
  test("set and show round-trip", async () => {
    const s = openStorage();
    const env = { prefs: s };
    await handleBusyCommand(makeCtx({ userId: "u1", chatId: "c1", text: "/busy interrupt" }).ctx, env, "fa");
    const show = makeCtx({ userId: "u1", chatId: "c1", text: "/busy" });
    await handleBusyCommand(show.ctx, env, "fa");
    expect(show.replies[0]).toContain("قطع پاسخ فعلی");
  });
  test("junk rejected", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/busy explode" });
    await handleBusyCommand(ctx, { prefs: s }, "fa");
    expect(replies[0]).toContain("queue");
  });
});

// ---------- /whoami ----------

describe("/whoami", () => {
  test("owner sees owner role and owner commands", async () => {
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/whoami" });
    await handleWhoamiCommand(ctx, true, "fa");
    const text = replies.join("\n");
    expect(text).toContain("مالک");
    expect(text).toContain("/admin");
  });
  test("regular user sees user role without owner commands", async () => {
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/whoami" });
    await handleWhoamiCommand(ctx, false, "fa");
    const text = replies.join("\n");
    expect(text).toContain("کاربر تأییدشده");
    expect(text).not.toContain("/admin");
    expect(text).toContain("/history");
  });
});

// ---------- /footer ----------

describe("/footer", () => {
  test("toggle round-trip with declared-only note", async () => {
    const s = openStorage();
    const env = { prefs: s };
    const show0 = makeCtx({ userId: "u1", chatId: "c1", text: "/footer" });
    await handleFooterCommand(show0.ctx, env, "fa");
    expect(show0.replies[0]).toContain("خاموش");
    await handleFooterCommand(makeCtx({ userId: "u1", chatId: "c1", text: "/footer on" }).ctx, env, "fa");
    const show1 = makeCtx({ userId: "u1", chatId: "c1", text: "/footer" });
    await handleFooterCommand(show1.ctx, env, "fa");
    expect(show1.replies[0]).toContain("روشن");
    expect(show1.replies[0]).toContain("اعلامی");
  });
  test("junk rejected", async () => {
    const s = openStorage();
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/footer maybe" });
    await handleFooterCommand(ctx, { prefs: s }, "fa");
    expect(replies[0]).toContain("/footer on");
  });
});

// ---------- /version ----------

describe("/version", () => {
  test("version from deps, dev fallback", async () => {
    const a = makeCtx({});
    await handleVersionCommand(a.ctx, { version: "9.9.9" }, "fa");
    expect(a.replies[0]).toContain("9.9.9");
    const b = makeCtx({});
    await handleVersionCommand(b.ctx, {}, "fa");
    expect(b.replies[0]).toContain("dev");
  });
});

// ---------- /new ----------

describe("/new", () => {
  test("clears messages and the rolling summary like /reset", async () => {
    const s = openStorage();
    const engine = makeEngine(s);
    seedTurns(s, "u1", "c1", [["q1", "a1"]]);
    const before = s.history("u1", "c1", 10);
    s.setConversationSummary({ userId: "u1", chatId: "c1", summary: "s", summarisedUntil: before[0]!.id });
    const { ctx, replies } = makeCtx({ userId: "u1", chatId: "c1", text: "/new" });
    await handleNewCommand(ctx, { engine }, "fa");
    expect(contents(s, "u1", "c1")).toHaveLength(0);
    expect(s.getConversationSummary("u1", "c1")).toBeUndefined();
    expect(replies[0]).toContain("نشست تازه");
  });
});
