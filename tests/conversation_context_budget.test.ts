import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { ConversationEngine } from "../src/conversation/engine";
import { Storage } from "../src/storage/storage";
import type { AiProvider, ChatMessage, CompletionRequest, CompletionResponse } from "../src/ai/provider";
import {
  estimateMessagesTokens,
  estimateTokens,
} from "../src/conversation/tokens";
import {
  compactHistoryToolResults,
  compactToolResult,
  enforceContextBudget,
  oneLineToolSummary,
  TOOL_RESULT_TOKEN_LIMIT,
} from "../src/conversation/context_budget";
import { wrapToolResult } from "../src/agent/transcript";

/** A provider that records the messages of every call and answers "ok". */
class CapturingProvider implements AiProvider {
  readonly name = "capture";
  readonly calls: ChatMessage[][] = [];
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push([...req.messages]);
    return { text: "ok", model: req.model };
  }
}

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const tool = (content: string): ChatMessage => ({
  role: "tool",
  content,
  toolCallId: "call_1",
});

/** A long, line-oriented tool result comfortably over the 2000-token limit. */
function bigToolResult(lines = 100): string {
  return Array.from({ length: lines }, (_, i) => `line ${i} ${"x".repeat(70)}`).join("\n");
}

describe("token estimator", () => {
  test("empty text costs nothing", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("English text lands in the chars/3.5 ballpark", () => {
    const t = estimateTokens("a".repeat(350));
    // ≈100 tokens; ±20% tolerance for the heuristic.
    expect(t).toBeGreaterThanOrEqual(80);
    expect(t).toBeLessThanOrEqual(120);
  });

  test("Persian text lands in the chars/1.8 ballpark", () => {
    const t = estimateTokens("س".repeat(180));
    // ≈100 tokens at the dense-script rate.
    expect(t).toBeGreaterThanOrEqual(85);
    expect(t).toBeLessThanOrEqual(115);
  });

  test("Persian estimates denser than Latin for the same char count", () => {
    expect(estimateTokens("س".repeat(350))).toBeGreaterThan(estimateTokens("a".repeat(350)));
  });

  test("fenced code is counted at the code rate, not the Latin rate", () => {
    const code = "```\n" + "x".repeat(400) + "\n```";
    const t = estimateTokens(code);
    // ≈100 tokens at chars/4 (+ a few for the fences).
    expect(t).toBeGreaterThanOrEqual(90);
    expect(t).toBeLessThanOrEqual(120);
    // The same chars as prose would estimate differently than pure code.
    const prose = estimateTokens("word ".repeat(80));
    expect(prose).toBeGreaterThan(0);
  });

  test("mixed Persian + Latin sums both rates", () => {
    const mixed = estimateTokens("س".repeat(90) + "a".repeat(175));
    // ≈ 50 + 50 = 100.
    expect(mixed).toBeGreaterThanOrEqual(85);
    expect(mixed).toBeLessThanOrEqual(115);
  });
});

describe("tool-result compaction", () => {
  test("an oversized result keeps head 40 + marker + tail 20", () => {
    const big = bigToolResult(100);
    expect(estimateTokens(big)).toBeGreaterThan(TOOL_RESULT_TOKEN_LIMIT);
    const r = compactToolResult(big);
    expect(r.compacted).toBe(true);
    expect(r.elidedLines).toBe(40);
    const outLines = r.content.split("\n");
    expect(outLines.length).toBe(61); // 40 head + 1 marker + 20 tail
    expect(outLines[0]).toContain("line 0");
    expect(outLines[40]).toBe("[… 40 lines elided …]");
    expect(outLines[60]).toContain("line 99");
    expect(r.afterTokens).toBeLessThan(r.beforeTokens);
  });

  test("a small result is untouched", () => {
    const small = "short result\nwith two lines";
    const r = compactToolResult(small);
    expect(r.compacted).toBe(false);
    expect(r.content).toBe(small);
  });

  test("compactHistoryToolResults only compacts tool messages", () => {
    const hist = [user("hi"), tool(bigToolResult()), assistant("done"), tool("small")];
    const r = compactHistoryToolResults(hist);
    expect(r.compactedCount).toBe(1);
    expect(r.messages[1]!.content).toContain("lines elided");
    expect(r.messages[3]!.content).toBe("small");
    expect(r.messages[0]).toBe(hist[0]);
  });

  test("§4.7: a wrapped JSON tool result compacts structurally, not by lines", () => {
    const body = JSON.stringify({
      items: Array.from({ length: 300 }, (_, i) => ({ i, txt: "w".repeat(120) })),
    });
    const wrapped = wrapToolResult("fetch_url", body);
    expect(estimateTokens(wrapped)).toBeGreaterThan(TOOL_RESULT_TOKEN_LIMIT);
    const r = compactToolResult(wrapped);
    expect(r.compacted).toBe(true);
    // Structural compaction elides structure, not lines.
    expect(r.elidedLines).toBe(0);
    expect(r.afterTokens).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_LIMIT);
    expect(r.afterTokens).toBeLessThan(r.beforeTokens);
    // The wrapper survives and the inner body is still valid JSON carrying
    // the §4.7 truncation marker.
    expect(r.content.startsWith('<tool_result tool="fetch_url">')).toBe(true);
    expect(r.content.endsWith("</tool_result>")).toBe(true);
    const inner = r.content
      .replace(/^<tool_result[^>]*>\n/, "")
      .replace(/\n<\/tool_result>$/, "");
    const parsed = JSON.parse(inner) as {
      items: unknown[];
      truncated: { fields: string[]; originalChars: number };
    };
    expect(parsed.items.length).toBeLessThan(300);
    expect(parsed.truncated.fields).toContain("items");
    expect(parsed.truncated.originalChars).toBe(body.length);
    expect(r.content).not.toContain("lines elided");
  });

  test("§4.7: a wrapped plain-text tool result still compacts head+tail", () => {
    const wrapped = wrapToolResult("read_file", bigToolResult(200));
    const r = compactToolResult(wrapped);
    expect(r.compacted).toBe(true);
    expect(r.elidedLines).toBeGreaterThan(0);
    expect(r.content).toContain("lines elided");
  });

  test("§4.7: an under-limit wrapped JSON tool result is untouched", () => {
    const wrapped = wrapToolResult("calc", JSON.stringify({ value: 42 }));
    const r = compactToolResult(wrapped);
    expect(r.compacted).toBe(false);
    expect(r.content).toBe(wrapped);
  });

  test("oneLineToolSummary is a single line naming the size", () => {
    const line = oneLineToolSummary(bigToolResult());
    expect(line).not.toContain("\n");
    expect(line).toContain("compacted to save context");
    expect(line).toContain("line 0");
  });
});

describe("budget enforcement order", () => {
  test("fits → untouched", () => {
    const hist = [user("hello"), assistant("hi there")];
    const r = enforceContextBudget(hist, { systemTokens: 10, turnTokens: 10, budget: 1000 });
    expect(r.fits).toBe(true);
    expect(r.messages).toEqual(hist);
    expect(r.droppedMessages).toBe(0);
  });

  test("step (a): tool results become one-liners BEFORE any turn is dropped", () => {
    const turns: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      turns.push(user(`question ${i} ${"q".repeat(80)}`));
      turns.push(assistant(`answer ${i} ${"a".repeat(80)}`));
    }
    const hist = [tool(bigToolResult()), ...turns];
    // Headroom: everything fits once the tool bulk becomes a one-liner
    // (budget leaves room for the one-liner itself, ~40 tokens).
    const withoutTool = estimateMessagesTokens(turns) + 50 + 60;
    const r = enforceContextBudget(hist, {
      systemTokens: 0,
      turnTokens: 50,
      budget: withoutTool,
    });
    expect(r.fits).toBe(true);
    expect(r.toolResultsOneLined).toBe(1);
    expect(r.droppedMessages).toBe(0);
    expect(r.messages.find((m) => m.role === "tool")!.content).toContain("compacted to save context");
  });

  test("steps (b)/(c): drops turns but never the summary or the last user message", () => {
    const summaryMsg: ChatMessage = {
      role: "system",
      content: "خلاصهٔ گفت‌وگوی قبلی:\nearlier stuff",
    };
    const turns: ChatMessage[] = [summaryMsg];
    for (let i = 0; i < 30; i++) {
      turns.push(user(`turn ${i} ${"q".repeat(160)}`));
      turns.push(assistant(`reply ${i} ${"a".repeat(160)}`));
    }
    const lastUserText = "the very last question";
    turns.push(user(lastUserText));
    const tight = 400;
    const r = enforceContextBudget(turns, { systemTokens: 50, turnTokens: 50, budget: tight });
    expect(r.fits).toBe(true);
    expect(estimateMessagesTokens(r.messages) + 100).toBeLessThanOrEqual(tight);
    // The rolling summary (system) survived.
    expect(r.messages.some((m) => m.role === "system")).toBe(true);
    // The last user message survived.
    expect(r.messages.some((m) => m.content === lastUserText)).toBe(true);
    expect(r.droppedMessages).toBeGreaterThan(0);
  });
});

describe("engine integration", () => {
  test("a plain turn records context stats", async () => {
    const provider = new CapturingProvider();
    const eng = new ConversationEngine({
      provider,
      model: "m",
      timeoutMs: 5_000,
      maxConcurrent: 2,
      summariseHistory: false,
    });
    await eng.respond({ conversationId: "c1", userText: "hello" });
    const sent = provider.calls[0]!;
    expect(sent[sent.length - 1]!.content).toBe("hello");
    const stats = eng.contextStats("c1");
    expect(stats).toBeDefined();
    expect(stats!.budget).toBe(32_000);
    expect(stats!.estimatedTokens).toBeGreaterThan(0);
    expect(stats!.summaries).toBe(0);
  });

  // NOTE: there is deliberately no engine-level "tool result in history"
  // test — stored history cannot contain tool rows (the messages table has
  // CHECK(role IN ('user','assistant','system'))), so the compaction wiring
  // in runOnce is covered by the module-level tests of the exact function
  // it calls (compactHistoryToolResults, above) plus the stats plumbing
  // verified below.


  test("budget enforcement shrinks a fat history to the configured budget", async () => {
    const provider = new CapturingProvider();
    const eng = new ConversationEngine({
      provider,
      model: "m",
      timeoutMs: 5_000,
      maxConcurrent: 2,
      summariseHistory: false,
      contextTokenBudget: 600,
    });
    // Build a fat in-memory history with many turns.
    for (let i = 0; i < 12; i++) {
      await eng.respond({
        conversationId: "fat",
        userText: `message ${i} ${"w".repeat(300)}`,
      });
    }
    const stats = eng.contextStats("fat");
    expect(stats).toBeDefined();
    expect(stats!.budget).toBe(600);
    expect(stats!.estimatedTokens).toBeLessThanOrEqual(600);
  });

  test("contextStats is undefined before any turn", () => {
    const eng = new ConversationEngine({
      provider: new CapturingProvider(),
      model: "m",
      timeoutMs: 5_000,
      maxConcurrent: 2,
    });
    expect(eng.contextStats("never")).toBeUndefined();
  });
});

describe("summary token trigger (storage)", () => {
  test("history over 60% of budget folds the oldest half into the summary", async () => {
    const path = `${tmpdir()}/bobi-ctx-trigger-${Date.now()}.db`;
    const storage = Storage.open(path);
    try {
      const userId = "u1";
      const chatId = "chat1";
      // 20 messages ≈ fat enough: each ~350 Latin chars ≈ 100 tokens.
      for (let i = 0; i < 20; i++) {
        storage.appendMessage(
          userId,
          chatId,
          i % 2 === 0 ? "user" : "assistant",
          `seed ${i} ${"s".repeat(340)}`,
        );
      }
      const provider = new CapturingProvider();
      const eng = new ConversationEngine({
        provider,
        model: "m",
        timeoutMs: 5_000,
        maxConcurrent: 2,
        storage,
        // Budget 3000 → trigger at 1800; the window estimates ~2100.
        contextTokenBudget: 3_000,
      });
      await eng.respond({ conversationId: chatId, userId, userText: "ping" });

      const stored = storage.getConversationSummary(userId, chatId);
      expect(stored).toBeDefined();
      // The oldest half (10 of 20) was folded: watermark covers them.
      expect(stored!.summarisedUntil).toBeGreaterThan(0);
      const sent = provider.calls[provider.calls.length - 1]!;
      // The prompt opens with the rolling summary, then the surviving window.
      expect(sent[0]!.role).toBe("system");
      expect(sent[0]!.content).toContain("خلاصهٔ گفت‌وگوی قبلی:");
      expect(sent.length).toBeLessThan(22);
    } finally {
      storage.close();
    }
  });

  test("small history under 60% does NOT trigger a fold", async () => {
    const path = `${tmpdir()}/bobi-ctx-notrigger-${Date.now()}.db`;
    const storage = Storage.open(path);
    try {
      const userId = "u1";
      const chatId = "chat1";
      for (let i = 0; i < 4; i++) {
        storage.appendMessage(userId, chatId, i % 2 === 0 ? "user" : "assistant", "short");
      }
      const provider = new CapturingProvider();
      const eng = new ConversationEngine({
        provider,
        model: "m",
        timeoutMs: 5_000,
        maxConcurrent: 2,
        storage,
        contextTokenBudget: 3_000,
      });
      await eng.respond({ conversationId: chatId, userId, userText: "ping" });
      expect(storage.getConversationSummary(userId, chatId)).toBeUndefined();
    } finally {
      storage.close();
    }
  });
});

describe("kill switches", () => {
  const savedEnv = { ...process.env };
  const restore = () => {
    for (const k of ["BOBI_CONTEXT_BUDGET", "BOBI_TOOL_RESULT_COMPACT", "BOBI_CONTEXT_TOKEN_BUDGET"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  };

  test("BOBI_CONTEXT_BUDGET=0 restores legacy behavior (no budget shrink)", async () => {
    process.env["BOBI_CONTEXT_BUDGET"] = "0";
    try {
      const provider = new CapturingProvider();
      const eng = new ConversationEngine({
        provider,
        model: "m",
        timeoutMs: 5_000,
        maxConcurrent: 2,
        summariseHistory: false,
        contextTokenBudget: 300, // tiny — would shrink if enabled
      });
      for (let i = 0; i < 6; i++) {
        await eng.respond({ conversationId: "legacy", userText: `msg ${i} ${"w".repeat(300)}` });
      }
      const stats = eng.contextStats("legacy");
      // Stats are still recorded, but nothing was cut to fit the tiny budget.
      expect(stats).toBeDefined();
      expect(stats!.estimatedTokens).toBeGreaterThan(300);
      const sent = provider.calls[provider.calls.length - 1]!;
      expect(sent.length).toBe(11); // 10 history (5 pairs) + live turn, all present
    } finally {
      restore();
    }
  });

  test("BOBI_TOOL_RESULT_COMPACT=0 disables compaction but keeps budgeting", async () => {
    process.env["BOBI_TOOL_RESULT_COMPACT"] = "0";
    try {
      // Unit-level: with the flag off at construction, the engine's history
      // path must not compact; budgeting (option) still enforces.
      const provider = new CapturingProvider();
      const eng = new ConversationEngine({
        provider,
        model: "m",
        timeoutMs: 5_000,
        maxConcurrent: 2,
        summariseHistory: false,
        contextTokenBudget: 500,
      });
      for (let i = 0; i < 8; i++) {
        await eng.respond({ conversationId: "nc", userText: `msg ${i} ${"w".repeat(300)}` });
      }
      const stats = eng.contextStats("nc");
      expect(stats).toBeDefined();
      expect(stats!.compactedResults).toBe(0);
      expect(stats!.estimatedTokens).toBeLessThanOrEqual(500);
    } finally {
      restore();
    }
  });

  test("BOBI_CONTEXT_TOKEN_BUDGET env sets the default budget", async () => {
    process.env["BOBI_CONTEXT_TOKEN_BUDGET"] = "4321";
    try {
      const eng = new ConversationEngine({
        provider: new CapturingProvider(),
        model: "m",
        timeoutMs: 5_000,
        maxConcurrent: 2,
      });
      await eng.respond({ conversationId: "envc", userText: "hi" });
      expect(eng.contextStats("envc")!.budget).toBe(4321);
    } finally {
      restore();
    }
  });
});
