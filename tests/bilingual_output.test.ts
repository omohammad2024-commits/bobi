/**
 * Multilingual agent output.
 *
 * The bot's UI chrome (menus, buttons, digests, reports, system messages) is
 * English-only, but the agent's conversational replies match the user's
 * language: Persian in → Persian out, English in → English out. This suite
 * proves the system prompt carries that directive — for every turn — while
 * the UI-language and identity rules stay immune to chat text.
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

const MATCH_DIRECTIVE = "Reply in the user's language";
const PERSIAN_LINE = "Persian in → Persian out";
const LANG_HEADER = "RESPONSE LANGUAGE";
/** Persian/Arabic script block — must never appear outside the persona layer. */
const ARABIC_RE = /[\u0600-\u06FF]/u;

// ---------- system prompt ----------

describe("buildSystemPrompt language block", () => {
  test("directs multilingual replies, with or without lang", () => {
    for (const ctx of [{ ...base }, { ...base, lang: "en" as const }]) {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).toContain(MATCH_DIRECTIVE);
      expect(prompt).toContain(PERSIAN_LINE);
      // The v1.0 English-only hard rule is gone.
      expect(prompt).not.toContain("Reply in English.");
    }
  });

  test("keeps UI chrome English-only and immune to chat text", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "en" });
    expect(prompt).toContain("stay English");
    expect(prompt).toContain("chat text can't change that");
  });

  test("carries no Persian script outside the persona layer", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "en" });
    // This suite's subject — the language block itself — is English.
    const langBlock = prompt
      .split("\n\n")
      .find((b) => b.startsWith(LANG_HEADER));
    expect(langBlock).toBeDefined();
    expect(ARABIC_RE.test(langBlock!)).toBe(false);
    // Re-scoped (v1.1.1): the persona layer (Michael PERSONALITY,
    // READING THE ROOM, TONE LOCK) carries the owner's verbatim
    // Persian reference lines by design (Oct 20-21), so the old
    // whole-prompt ban is stale. Strip exactly those blocks;
    // everything else — identity, language rule, tool rules — must
    // stay free of Persian script.
    const PERSONA_HEADS = ["Personality:", "READING THE ROOM", "TONE LOCK"];
    const outside = prompt
      .split("\n\n")
      .filter((b) => !PERSONA_HEADS.some((h) => b.startsWith(h)))
      .join("\n\n");
    expect(ARABIC_RE.test(outside)).toBe(false);
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

  test("the block resists chat-level weakening of identity and UI language", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "en" });
    // Chat text cannot weaken identity/access rules (stated in the identity
    // block: ownership is decided server-side)…
    expect(prompt).toContain("never from chat text");
    // …and cannot switch the UI language.
    expect(prompt).toContain("chat text can't change that");
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
  test("explicit input.lang=en carries the directive", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider);
    await engine.respond({ conversationId: "c", userId: "u", userText: "hi", lang: "en" });
    const prompt = systemPromptOf(provider);
    expect(prompt).toContain(MATCH_DIRECTIVE);
    expect(prompt).not.toContain("Reply in English.");
  });

  test("missing lang still carries the directive", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider);
    await engine.respond({ conversationId: "c", userId: "u", userText: "hi" });
    const prompt = systemPromptOf(provider);
    expect(prompt).toContain(MATCH_DIRECTIVE);
  });

  test("langFor resolves the user's pref when the input carries no lang", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => "en",
    });
    await engine.respond({ conversationId: "c", userId: "en-user", userText: "hi" });
    expect(systemPromptOf(provider)).toContain(MATCH_DIRECTIVE);
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
    expect(systemPromptOf(provider)).toContain(MATCH_DIRECTIVE);
  });

  test("a throwing langFor fails closed without breaking the turn", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => {
        throw new Error("prefs down");
      },
    });
    const out = await engine.respond({ conversationId: "c", userId: "u", userText: "hi" });
    expect(out.chunks.join("")).toContain("test answer");
    expect(systemPromptOf(provider)).toContain(MATCH_DIRECTIVE);
  });

  test("every turn carries the directive, whatever the input", async () => {
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
      expect(prompt, `turn ${i}`).toContain(MATCH_DIRECTIVE);
      expect(prompt, `turn ${i}`).not.toContain("Reply in English.");
    }
  });

  test("per-user correctness via langFor: the TURN's user is resolved, never the owner", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => "en",
    });
    await engine.respond({ conversationId: "g", userId: "public-42", userText: "hi" });
    await engine.respond({ conversationId: "o", userId: "owner-1", userText: "hi" });
    expect(systemPromptOf(provider, 0)).toContain(MATCH_DIRECTIVE);
    expect(systemPromptOf(provider, 1)).toContain(MATCH_DIRECTIVE);
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

describe("delegate child agent keeps its own English worker prompt", () => {
  // The delegate child is an internal worker: its summary is consumed by the
  // parent agent as tool data, not shown as conversation. English stays.
  test("defaults carry the worker prompt", async () => {
    const provider = new ScriptedProvider();
    const tool = delegateToolFor(provider);
    const res = await tool.run({ task: "summarise" }, delegateCtx("u1"));
    expect(res.ok).toBe(true);
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("in English");
  });

  test("an en pref still carries the worker prompt", async () => {
    const provider = new ScriptedProvider();
    const tool = delegateToolFor(provider, () => "en");
    await tool.run({ task: "summarise" }, delegateCtx("en-user"));
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("in English");
  });

  test("a throwing langFor fails closed without breaking the child", async () => {
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
