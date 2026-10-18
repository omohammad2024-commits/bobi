/**
 * Reasoning policy + prompt-caching discipline.
 *
 * Contracts pinned here:
 *   - resolveReasoningEffort parses BOBI_REASONING_EFFORT; junk resolves to "off".
 *   - Tier budgets are sane and strictly ordered low < medium < high.
 *   - Adapter wire bodies gain thinking/reasoning fields ONLY when the knob
 *     is explicitly enabled; the default request JSON is byte-identical to
 *     the pre-change wire format (snapshotted below).
 *   - The Anthropic cache breakpoint appears ONLY with BOBI_PROMPT_CACHE=1.
 *   - The system prompt is byte-stable across turns of a fixed fixture
 *     (frozen `now`); a changing clock provably breaks it.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  resolveReasoningEffort,
  reasoningParamsFor,
  REASONING_TIER_BUDGETS,
} from "../src/ai/reasoning";
import {
  hashSystemPrompt,
  assertPromptStable,
  promptCacheEnabled,
} from "../src/ai/cache_policy";
import { buildBody as buildAnthropic } from "../src/ai/anthropic";
import { buildBody as buildGemini } from "../src/ai/gemini";
import { buildRequestBody as buildOpenAI } from "../src/ai/openai_compatible";
import { buildSystemPrompt } from "../src/agent/prompt";
import type { CompletionRequest } from "../src/ai/provider";

const ENV_KEYS = [
  "BOBI_REASONING_EFFORT",
  "BOBI_PROMPT_CACHE",
  "SOL_REASONING_EFFORT",
  "SOL_PROMPT_CACHE",
];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = SAVED_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function clearReasoningEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function minimalRequest(): CompletionRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "x" }],
    timeoutMs: 1000,
    signal: new AbortController().signal,
  };
}

const TARGET = { baseUrl: "https://example.invalid", apiKey: "k" };

describe("resolveReasoningEffort", () => {
  test("unset resolves to off", () => {
    clearReasoningEnv();
    expect(resolveReasoningEffort()).toBe("off");
  });

  test("valid tiers parse", () => {
    clearReasoningEnv();
    for (const tier of ["low", "medium", "high"] as const) {
      process.env.BOBI_REASONING_EFFORT = tier;
      expect(resolveReasoningEffort()).toBe(tier);
    }
  });

  test("trims and lowercases", () => {
    clearReasoningEnv();
    process.env.BOBI_REASONING_EFFORT = "  HIGH ";
    expect(resolveReasoningEffort()).toBe("high");
  });

  test("junk resolves to off (fail closed)", () => {
    clearReasoningEnv();
    for (const junk of ["turbo", "10", "ultra", "on", "", "medium-high"]) {
      process.env.BOBI_REASONING_EFFORT = junk;
      expect(resolveReasoningEffort()).toBe("off");
    }
  });

  test("legacy SOL_ prefix is a fallback; BOBI_ wins", () => {
    clearReasoningEnv();
    process.env.SOL_REASONING_EFFORT = "medium";
    expect(resolveReasoningEffort()).toBe("medium");
    process.env.BOBI_REASONING_EFFORT = "low";
    expect(resolveReasoningEffort()).toBe("low");
  });
});

describe("reasoningParamsFor", () => {
  test("tier budgets are sane and strictly ordered", () => {
    const { low, medium, high } = REASONING_TIER_BUDGETS;
    expect(low).toBeGreaterThanOrEqual(1024); // Anthropic minimum
    expect(medium).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(medium);
  });

  test("off yields disabled params", () => {
    for (const provider of ["anthropic", "gemini", "openai_compatible", "whatever"]) {
      const p = reasoningParamsFor(provider, "off");
      expect(p.enabled).toBe(false);
      expect(p.budgetTokens).toBe(0);
      expect(p.levelName).toBeUndefined();
    }
  });

  test("enabled tiers carry a budget and a level name", () => {
    const p = reasoningParamsFor("openai_compatible", "medium");
    expect(p.enabled).toBe(true);
    expect(p.budgetTokens).toBe(REASONING_TIER_BUDGETS.medium);
    expect(p.levelName).toBe("medium");
  });

  test("anthropic budget never drops below the vendor floor", () => {
    const p = reasoningParamsFor("anthropic", "low");
    expect(p.budgetTokens).toBeGreaterThanOrEqual(1024);
  });
});

describe("default request wire format is unchanged", () => {
  test("anthropic default body snapshot", () => {
    clearReasoningEnv();
    const json = JSON.stringify(buildAnthropic(TARGET, minimalRequest()));
    expect(json).toBe(
      '{"model":"test-model","max_tokens":1024,"messages":[{"role":"user","content":"x"}]}',
    );
    expect(json).not.toContain("thinking");
    expect(json).not.toContain("cache_control");
  });

  test("gemini default body snapshot", () => {
    clearReasoningEnv();
    const json = JSON.stringify(buildGemini(TARGET, minimalRequest()));
    expect(json).toBe('{"contents":[{"role":"user","parts":[{"text":"x"}]}]}');
    expect(json).not.toContain("thinkingConfig");
  });

  test("openai-compatible default body snapshot", () => {
    clearReasoningEnv();
    const json = JSON.stringify(buildOpenAI(TARGET, minimalRequest()));
    expect(json).toBe('{"model":"test-model","messages":[{"role":"user","content":"x"}]}');
    expect(json).not.toContain("reasoning_effort");
  });
});

describe("thinking params are added only when enabled", () => {
  test("anthropic: thinking block with budget, temperature forced to 1", () => {
    clearReasoningEnv();
    process.env.BOBI_REASONING_EFFORT = "high";
    const body = buildAnthropic(TARGET, minimalRequest()) as Record<string, unknown>;
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 16384 });
    // Vendor rule: thinking requires temperature 1.
    expect(body["temperature"]).toBe(1);
    // max_tokens must exceed the budget: default 1024 is raised.
    expect(body["max_tokens"]).toBe(16384 + 1024);
  });

  test("anthropic: low tier keeps a sane budget", () => {
    clearReasoningEnv();
    process.env.BOBI_REASONING_EFFORT = "low";
    const body = buildAnthropic(TARGET, minimalRequest()) as Record<string, unknown>;
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  test("openai-compatible: reasoning_effort level only when enabled", () => {
    clearReasoningEnv();
    process.env.BOBI_REASONING_EFFORT = "medium";
    const body = buildOpenAI(TARGET, minimalRequest()) as Record<string, unknown>;
    expect(body["reasoning_effort"]).toBe("medium");
  });

  test("gemini: thinkingConfig with level only when enabled", () => {
    clearReasoningEnv();
    process.env.BOBI_REASONING_EFFORT = "medium";
    const body = buildGemini(TARGET, minimalRequest()) as Record<string, unknown>;
    expect(body["thinkingConfig"]).toEqual({ thinkingLevel: "MEDIUM" });
  });

  test("junk effort value leaves every wire untouched", () => {
    clearReasoningEnv();
    process.env.BOBI_REASONING_EFFORT = "turbo";
    const a = buildAnthropic(TARGET, minimalRequest()) as Record<string, unknown>;
    const g = buildGemini(TARGET, minimalRequest()) as Record<string, unknown>;
    const o = buildOpenAI(TARGET, minimalRequest()) as Record<string, unknown>;
    expect("thinking" in a).toBe(false);
    expect("thinkingConfig" in g).toBe(false);
    expect("reasoning_effort" in o).toBe(false);
  });
});

describe("prompt cache breakpoints", () => {
  const sysTarget = { ...TARGET, settings: { systemPrompt: "sys" } };

  test("promptCacheEnabled parsing", () => {
    clearReasoningEnv();
    expect(promptCacheEnabled()).toBe(false);
    for (const on of ["1", "true", "yes", " TRUE "]) {
      process.env.BOBI_PROMPT_CACHE = on;
      expect(promptCacheEnabled()).toBe(true);
    }
    for (const off of ["0", "false", "no", "2", ""]) {
      process.env.BOBI_PROMPT_CACHE = off;
      expect(promptCacheEnabled()).toBe(false);
    }
  });

  test("anthropic: system stays a plain string by default", () => {
    clearReasoningEnv();
    const body = buildAnthropic(sysTarget, minimalRequest()) as Record<string, unknown>;
    expect(body["system"]).toBe("sys");
  });

  test("anthropic: cache_control breakpoint only with BOBI_PROMPT_CACHE=1", () => {
    clearReasoningEnv();
    process.env.BOBI_PROMPT_CACHE = "1";
    const body = buildAnthropic(sysTarget, minimalRequest()) as Record<string, unknown>;
    expect(body["system"]).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("gemini/openai expose no breakpoint field (documented: implicit caching)", () => {
    clearReasoningEnv();
    process.env.BOBI_PROMPT_CACHE = "1";
    const g = JSON.stringify(buildGemini(TARGET, minimalRequest()));
    const o = JSON.stringify(buildOpenAI(TARGET, minimalRequest()));
    expect(g).not.toContain("cache_control");
    expect(o).not.toContain("cache_control");
  });
});

describe("system prompt stability", () => {
  // Fixed conversation fixture: frozen clock, same tools, same owner config.
  // The user/history section is NOT part of the system prompt — it travels in
  // the request's messages — so two turns share the same fixture here.
  const fixture = {
    tools: [{ name: "ping", description: "test tool", enabled: true, requires: [] }],
    now: new Date("2026-10-18T12:00:00.000Z"),
    timezone: "Asia/Tehran",
  } as const;

  test("byte-identical across turns with a frozen clock", () => {
    const turn1 = buildSystemPrompt({ ...fixture });
    const turn2 = buildSystemPrompt({ ...fixture });
    expect(turn1).toBe(turn2);
    expect(hashSystemPrompt(turn1)).toBe(hashSystemPrompt(turn2));
    expect(() => assertPromptStable([turn1, turn2])).not.toThrow();
  });

  test("hashSystemPrompt is a stable 64-char hex fingerprint", () => {
    const h1 = hashSystemPrompt("abc");
    const h2 = hashSystemPrompt("abc");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSystemPrompt("abd")).not.toBe(h1);
  });

  test("a moving clock provably breaks the prefix (engine.ts passes a fresh now per turn)", () => {
    const a = buildSystemPrompt({ ...fixture, now: new Date("2026-10-18T12:00:00.000Z") });
    const b = buildSystemPrompt({ ...fixture, now: new Date("2026-10-18T12:00:01.000Z") });
    expect(a).not.toBe(b);
    expect(() => assertPromptStable([a, b])).toThrow(/CACHE-BREAK/);
  });

  test("assertPromptStable rejects divergent and degenerate input", () => {
    expect(() => assertPromptStable(["a", "b"])).toThrow(/CACHE-BREAK/);
    expect(() => assertPromptStable(["only-one"])).toThrow(/at least two/);
  });
});
