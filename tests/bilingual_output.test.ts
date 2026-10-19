/**
 * Bilingual agent output (Phase-2 item 4).
 *
 * The bot's UI has been bilingual (fa/en via /lang) for a while, but the
 * agent's own replies came from a system prompt that hard-coded Persian.
 * This suite proves the language pref now flows into the agent's system
 * prompt — for the right user, on every turn — and that the prompt-cache
 * discipline still holds.
 */
import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agent/prompt";
import { hashSystemPrompt, assertPromptStable } from "../src/ai/cache_policy";
import { ConversationEngine, type EngineOptions } from "../src/conversation/engine";
import { ToolService } from "../src/tools/service";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";
import {
  createDelegateTool,
  type DelegateToolDeps,
} from "../src/tools/delegate";
import type { ToolContext } from "../src/tools/types";

const NOW = new Date("2026-10-18T12:00:00Z");
const base = {
  tools: [],
  now: NOW,
  timezone: "Asia/Tehran",
} as const;

const EN_DIRECTIVE = "Reply in English";
const LANG_HEADER = "RESPONSE LANGUAGE";
/** Persian/Arabic script block — must never appear in the system prompt. */
const ARABIC_RE = /[\u0600-\u06FF]/u;

// ---------- system prompt ----------

describe("buildSystemPrompt language block", () => {
  test("is always English, with or without lang", () => {
    for (const ctx of [{ ...base }, { ...base, lang: "en" as const }]) {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).toContain(EN_DIRECTIVE);
      expect(prompt).not.toContain("Reply in Persian");
    }
  });

  test("carries no Persian script anywhere", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "en" });
    expect(ARABIC_RE.test(prompt)).toBe(false);
  });

  test("the block sits after the creator identity and before the personality skin", () => {
    const skin = "upbeat and energetic";
    const prompt = buildSystemPrompt({ ...base, lang: "en", personality: skin });
    const identityIdx = prompt.indexOf("creator and father");
    const langIdx = prompt.indexOf(LANG_HEADER);
    const personalityIdx = prompt.indexOf("Reply tone:");
    expect(identityIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeGreaterThan(-1);
    expect(personalityIdx).toBeGreaterThan(-1);
    // After CREATOR_IDENTITY, before the tone skin: tone can never weaken it.
    expect(langIdx).toBeGreaterThan(identityIdx);
    expect(langIdx).toBeLessThan(personalityIdx);
  });

  test("the block resists chat-level language override attempts", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "en" });
    // Declares itself a hard rule over tone AND chat text.
    expect(prompt).toContain("hard rule");
    // Chat asks to switch language are not instructions.
    expect(prompt).toContain("not an instruction");
    // Code/technical terms stay untranslated.
    expect(prompt).toContain("do not translate them");
  });

  test("identical inputs give byte-identical prompts (cache discipline)", () => {
    const a = buildSystemPrompt({ ...base, lang: "en" });
    const b = buildSystemPrompt({ ...base, lang: "en" });
    expect(hashSystemPrompt(a)).toBe(hashSystemPrompt(b));
    expect(() => assertPromptStable([a, b])).not.toThrow();
  });
});

// ---------- engine plumbing ----------

/** Provider that plays back fixed answers, recording every request. */
class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    return { text: "test answer", model: "m" };
  }
}

function makeEngine(
  provider: AiProvider,
  overrides: Pick<EngineOptions, "langFor"> = {},
) {
  return new ConversationEngine({
    provider,
    model: "m",
    timeoutMs: 5_000,
    maxConcurrent: 4,
    tools: new ToolService(),
    timezone: "UTC",
    summariseHistory: false,
    ...overrides,
  });
}

function systemPromptOf(provider: ScriptedProvider, requestIndex = 0): string {
  const req = provider.requests[requestIndex];
  const system = req?.messages.find((m) => m.role === "system");
  return system?.content ?? "";
}

describe("engine threads the turn's language into the system prompt", () => {
  test("explicit input.lang=en answers in English", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider);
    await engine.respond({ conversationId: "c", userId: "u", userText: "hi", lang: "en" });
    const prompt = systemPromptOf(provider);
    expect(prompt).toContain(EN_DIRECTIVE);
    expect(prompt).not.toContain("Reply in Persian");
  });

  test("missing lang still answers in English", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider);
    await engine.respond({ conversationId: "c", userId: "u", userText: "hi" });
    const prompt = systemPromptOf(provider);
    expect(prompt).toContain(EN_DIRECTIVE);
  });

  test("langFor resolves the user's pref when the input carries no lang", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => "en",
    });
    await engine.respond({ conversationId: "c", userId: "en-user", userText: "hi" });
    expect(systemPromptOf(provider)).toContain(EN_DIRECTIVE);
  });

  test("explicit input.lang wins over langFor", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => "en",
    });
    await engine.respond({
      conversationId: "c",
      userId: "u",
      userText: "hi",
      lang: "en",
    });
    expect(systemPromptOf(provider)).toContain(EN_DIRECTIVE);
  });

  test("a throwing langFor fails closed to English without breaking the turn", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => {
        throw new Error("prefs down");
      },
    });
    const out = await engine.respond({ conversationId: "c", userId: "u", userText: "hi" });
    expect(out.chunks.join("")).toContain("test answer");
    expect(systemPromptOf(provider)).toContain(EN_DIRECTIVE);
  });

  test("every turn answers in English, whatever the input", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider);
    await engine.respond({
      conversationId: "c-1",
      userId: "public",
      userText: "hello",
      lang: "en",
    });
    await engine.respond({
      conversationId: "c-2",
      userId: "owner",
      userText: "hello",
    });
    for (const i of [0, 1]) {
      const prompt = systemPromptOf(provider, i);
      expect(prompt, `turn ${i}`).toContain(EN_DIRECTIVE);
      expect(prompt, `turn ${i}`).not.toContain("Reply in Persian");
    }
  });

  test("per-user correctness via langFor: the TURN's user is resolved, never the owner", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => "en",
    });
    await engine.respond({ conversationId: "g", userId: "public-42", userText: "hi" });
    await engine.respond({ conversationId: "o", userId: "owner-1", userText: "hi" });
    expect(systemPromptOf(provider, 0)).toContain(EN_DIRECTIVE);
    expect(systemPromptOf(provider, 1)).toContain(EN_DIRECTIVE);
  });
});

// ---------- delegate tool ----------

function delegateToolFor(
  provider: AiProvider,
  langFor?: DelegateToolDeps["langFor"],
): ReturnType<typeof createDelegateTool> {
  const tools = new ToolService();
  return createDelegateTool({
    tools,
    provider,
    model: "m",
    ...(langFor !== undefined ? { langFor } : {}),
  });
}

function delegateCtx(userId: string): ToolContext {
  return {
    clock: () => new Date(),
    actor: { userId, permissions: ["tools:delegate"] },
    signal: new AbortController().signal,
  };
}

describe("delegate child agent answers in English", () => {
  test("defaults to English", async () => {
    const provider = new ScriptedProvider();
    const tool = delegateToolFor(provider);
    const res = await tool.run({ task: "summarise" }, delegateCtx("u1"));
    expect(res.ok).toBe(true);
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("in English");
  });

  test("an en pref gives the child an English prompt", async () => {
    const provider = new ScriptedProvider();
    const tool = delegateToolFor(provider, () => "en");
    await tool.run({ task: "summarise" }, delegateCtx("en-user"));
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("in English");
    expect(prompt).not.toContain("in Persian");
  });

  test("a throwing langFor fails closed to English", async () => {
    const provider = new ScriptedProvider();
    const tool = delegateToolFor(provider, () => {
      throw new Error("prefs down");
    });
    const res = await tool.run({ task: "summarise" }, delegateCtx("u1"));
    expect(res.ok).toBe(true);
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("in English");
  });
});
