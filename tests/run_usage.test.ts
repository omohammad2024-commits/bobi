import { describe, expect, test } from "bun:test";
import { ConversationEngine } from "../src/conversation/engine";
import type { RunUsageInfo } from "../src/conversation/engine";
import type { AiProvider, CompletionResponse } from "../src/ai/provider";

/**
 * The engine's onRunUsage observer: fired once per settled turn with the
 * run's token totals, and never allowed to break the turn.
 */

const usageProvider: AiProvider = {
  name: "usage-fake",
  async complete(): Promise<CompletionResponse> {
    return {
      text: "done",
      model: "fake-model",
      usage: { inputTokens: 11, outputTokens: 22 },
    };
  },
};

function makeEngine(onRunUsage?: (info: RunUsageInfo) => void) {
  return new ConversationEngine({
    provider: usageProvider,
    model: "fake-model",
    timeoutMs: 5_000,
    maxConcurrent: 4,
    ...(onRunUsage !== undefined ? { onRunUsage } : {}),
  });
}

describe("engine onRunUsage", () => {
  test("fires once per settled turn with token totals", async () => {
    const seen: RunUsageInfo[] = [];
    const eng = makeEngine((info) => seen.push(info));
    await eng.respond({ conversationId: "c9", userText: "hi", actor: { userId: "u7", permissions: [] } });
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      userId: "u7",
      conversationId: "c9",
      model: "fake-model",
      inputTokens: 11,
      outputTokens: 22,
    });
  });

  test("absent observer changes nothing", async () => {
    const eng = makeEngine();
    const out = await eng.respond({ conversationId: "c1", userText: "hi" });
    expect(out.chunks.join("")).toBe("done");
  });

  test("a throwing observer never breaks the turn", async () => {
    const eng = makeEngine(() => {
      throw new Error("observer blew up");
    });
    const out = await eng.respond({ conversationId: "c1", userText: "hi" });
    expect(out.chunks.join("")).toBe("done");
  });

  test("failed turns do not emit usage", async () => {
    const seen: RunUsageInfo[] = [];
    const failing: AiProvider = {
      name: "failing",
      async complete(): Promise<CompletionResponse> {
        throw new Error("boom");
      },
    };
    const eng = new ConversationEngine({
      provider: failing,
      model: "x",
      timeoutMs: 5_000,
      maxConcurrent: 4,
      onRunUsage: (info) => seen.push(info),
    });
    await expect(eng.respond({ conversationId: "c1", userText: "hi" })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
