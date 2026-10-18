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

const FA_DIRECTIVE = "Reply in Persian (Farsi)";
const EN_DIRECTIVE = "Reply in English";
const LANG_HEADER = "RESPONSE LANGUAGE";

// ---------- system prompt ----------

describe("buildSystemPrompt language block", () => {
  test("defaults to Persian when lang is absent", () => {
    const prompt = buildSystemPrompt({ ...base });
    expect(prompt).toContain(FA_DIRECTIVE);
    expect(prompt).not.toContain(EN_DIRECTIVE);
  });

  test("lang=fa keeps the Persian directive", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "fa" });
    expect(prompt).toContain(FA_DIRECTIVE);
    expect(prompt).not.toContain(EN_DIRECTIVE);
  });

  test("lang=en switches to the English directive", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "en" });
    expect(prompt).toContain(EN_DIRECTIVE);
    expect(prompt).not.toContain(FA_DIRECTIVE);
  });

  test("an en prompt no longer carries the old hard-coded Persian answer rule", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "en" });
    expect(prompt).not.toContain("پاسخ‌ها را فارسی");
  });

  test("a junk lang falls back to Persian, never to a missing language", () => {
    const prompt = buildSystemPrompt({ ...base, lang: "xx" as never });
    expect(prompt).toContain(FA_DIRECTIVE);
    expect(prompt).not.toContain(EN_DIRECTIVE);
  });

  test("the block sits after the creator identity and before the personality skin", () => {
    const skin = "مثبت و پر انرژی";
    const prompt = buildSystemPrompt({ ...base, lang: "en", personality: skin });
    const identityIdx = prompt.indexOf("سازنده و پدر");
    const langIdx = prompt.indexOf(LANG_HEADER);
    const personalityIdx = prompt.indexOf("لحن پاسخ‌گویی");
    expect(identityIdx).toBeGreaterThan(-1);
    expect(langIdx).toBeGreaterThan(-1);
    expect(personalityIdx).toBeGreaterThan(-1);
    // After CREATOR_IDENTITY, before the tone skin: tone can never weaken it.
    expect(langIdx).toBeGreaterThan(identityIdx);
    expect(langIdx).toBeLessThan(personalityIdx);
  });

  test("the block resists chat-level language override attempts", () => {
    for (const lang of ["fa", "en"] as const) {
      const prompt = buildSystemPrompt({ ...base, lang });
      // Declares itself a hard rule over tone AND chat text.
      expect(prompt, lang).toContain("hard rule");
      // Says the pref is server-side and chat asks are not instructions.
      expect(prompt, lang).toContain("not an instruction");
      // Code/technical terms stay untranslated.
      expect(prompt, lang).toContain("do not translate them");
    }
  });

  test("the language switch is a legitimate cache breakpoint", () => {
    const fa = buildSystemPrompt({ ...base, lang: "fa" });
    const en = buildSystemPrompt({ ...base, lang: "en" });
    expect(hashSystemPrompt(fa)).not.toBe(hashSystemPrompt(en));
    // Same inputs → byte-identical: the discipline holds.
    const fa2 = buildSystemPrompt({ ...base, lang: "fa" });
    expect(() => assertPromptStable([fa, fa2])).not.toThrow();
    // A language switch must never serve a stale cached prompt.
    expect(() => assertPromptStable([fa, en])).toThrow();
  });
});

// ---------- engine plumbing ----------

/** Provider that plays back fixed answers, recording every request. */
class ScriptedProvider implements AiProvider {
  readonly name = "scripted";
  readonly requests: CompletionRequest[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    return { text: "پاسخ آزمایشی", model: "m" };
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
    expect(prompt).not.toContain(FA_DIRECTIVE);
  });

  test("missing lang defaults to Persian (pre-bilingual behaviour)", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider);
    await engine.respond({ conversationId: "c", userId: "u", userText: "hi" });
    const prompt = systemPromptOf(provider);
    expect(prompt).toContain(FA_DIRECTIVE);
  });

  test("langFor resolves the user's pref when the input carries no lang", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: (userId) => (userId === "en-user" ? "en" : "fa"),
    });
    await engine.respond({ conversationId: "c", userId: "en-user", userText: "hi" });
    expect(systemPromptOf(provider)).toContain(EN_DIRECTIVE);
  });

  test("explicit input.lang wins over langFor", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => "fa",
    });
    await engine.respond({
      conversationId: "c",
      userId: "u",
      userText: "hi",
      lang: "en",
    });
    expect(systemPromptOf(provider)).toContain(EN_DIRECTIVE);
  });

  test("a throwing langFor fails closed to Persian without breaking the turn", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      langFor: () => {
        throw new Error("prefs down");
      },
    });
    const out = await engine.respond({ conversationId: "c", userId: "u", userText: "hi" });
    expect(out.chunks.join("")).toContain("پاسخ آزمایشی");
    expect(systemPromptOf(provider)).toContain(FA_DIRECTIVE);
  });

  test("per-user correctness: one user's en never leaks into another's turn", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider);
    // Public user whose /lang is en.
    await engine.respond({
      conversationId: "c-en",
      userId: "public-en",
      userText: "hello",
      lang: "en",
    });
    // The owner's turn right after, Persian.
    await engine.respond({
      conversationId: "c-fa",
      userId: "owner",
      userText: "سلام",
      lang: "fa",
    });
    const enPrompt = systemPromptOf(provider, 0);
    const faPrompt = systemPromptOf(provider, 1);
    expect(enPrompt).toContain(EN_DIRECTIVE);
    expect(enPrompt).not.toContain(FA_DIRECTIVE);
    expect(faPrompt).toContain(FA_DIRECTIVE);
    expect(faPrompt).not.toContain(EN_DIRECTIVE);
  });

  test("per-user correctness via langFor: the TURN's user is resolved, never the owner", async () => {
    const provider = new ScriptedProvider();
    const engine = makeEngine(provider, {
      // Only the public user has en; everyone else (incl. the owner) is fa.
      langFor: (userId) => (userId === "public-42" ? "en" : "fa"),
    });
    await engine.respond({ conversationId: "g", userId: "public-42", userText: "hi" });
    await engine.respond({ conversationId: "o", userId: "owner-1", userText: "hi" });
    expect(systemPromptOf(provider, 0)).toContain(EN_DIRECTIVE);
    expect(systemPromptOf(provider, 1)).toContain(FA_DIRECTIVE);
    expect(systemPromptOf(provider, 1)).not.toContain(EN_DIRECTIVE);
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

describe("delegate child agent follows the delegating user's language", () => {
  test("defaults to Persian like before", async () => {
    const provider = new ScriptedProvider();
    const tool = delegateToolFor(provider);
    const res = await tool.run({ task: "summarise" }, delegateCtx("u1"));
    expect(res.ok).toBe(true);
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("in Persian");
  });

  test("an en pref gives the child an English prompt", async () => {
    const provider = new ScriptedProvider();
    const tool = delegateToolFor(provider, (userId) =>
      userId === "en-user" ? "en" : "fa",
    );
    await tool.run({ task: "summarise" }, delegateCtx("en-user"));
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("in English");
    expect(prompt).not.toContain("in Persian");
  });

  test("a throwing langFor fails closed to Persian", async () => {
    const provider = new ScriptedProvider();
    const tool = delegateToolFor(provider, () => {
      throw new Error("prefs down");
    });
    const res = await tool.run({ task: "summarise" }, delegateCtx("u1"));
    expect(res.ok).toBe(true);
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("in Persian");
  });
});
