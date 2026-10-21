/**
 * Reasoning / thinking policy.
 *
 * Centralises the opt-in reasoning knob so every adapter maps one shared tier
 * vocabulary onto its own wire shape. The knob is OFF unless the owner sets
 * it: reasoning costs extra tokens and changes latency, so it must never be
 * silently enabled by a default.
 *
 * SECURITY — a thinking block is model-generated output:
 *   - Thinking/reasoning content is untrusted data, exactly like any other
 *     completion text. It must NEVER be re-injected into a system prompt,
 *     tool definition, or tool argument as if it were an instruction.
 *   - The adapters parse only the vendor's *text* blocks out of a response;
 *     thinking blocks are ignored by construction (see each adapter's
 *     extractText), so model "thoughts" cannot flow into the next turn's
 *     trusted prompt.
 *   - The effort level is owner-controlled (environment), never user-
 *     controlled: a chat user cannot escalate reasoning cost.
 *   - Junk or unknown values resolve to "off" (fail closed), never to a
 *     stronger tier.
 */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

import { processEnv } from "../config/env";
/** Primary environment variable for the reasoning knob. */
export const REASONING_ENV_VAR = "BOBI_REASONING_EFFORT";
/** Legacy prefix accepted as a fallback, matching config.ts convention. */
const LEGACY_REASONING_ENV_VAR = "SOL_REASONING_EFFORT";

const DEFAULT_EFFORT: ReasoningEffort = "off";

/**
 * Resolve the reasoning effort from the environment.
 *
 * Accepts exactly "low" | "medium" | "high" (case-insensitive, trimmed).
 * Anything else — unset, empty, or junk — resolves to "off".
 */
export function resolveReasoningEffort(
  env: { [key: string]: string | undefined } = processEnv(),
): ReasoningEffort {
  const raw = (env[REASONING_ENV_VAR] ?? env[LEGACY_REASONING_ENV_VAR] ?? "")
    .trim()
    .toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return DEFAULT_EFFORT;
}

/**
 * Vendor-neutral reasoning parameters an adapter should apply.
 *
 * Adapters map these onto their own wire shape:
 *   - Anthropic:  `thinking: { type: "enabled", budget_tokens }`
 *   - OpenAI-compatible: `reasoning_effort: levelName`
 *   - Gemini: `generationConfig.thinkingConfig = { thinkingLevel: LEVEL }`
 */
export interface ReasoningParams {
  /** The resolved tier; "off" means reasoning stays disabled. */
  effort: ReasoningEffort;
  /** False when effort is "off". Adapters add vendor fields only when true. */
  enabled: boolean;
  /**
   * Max thinking-token budget for the tier. Always low < medium < high, and
   * always at least the Anthropic minimum (1024) so every tier is legal on
   * every budget-based wire.
   */
  budgetTokens: number;
  /**
   * Level name for vendors that take an enum instead of a token budget
   * (OpenAI-compatible `reasoning_effort`, Gemini `thinkingLevel`).
   * Undefined when effort is "off".
   */
  levelName: "low" | "medium" | "high" | undefined;
}

/**
 * Max thinking-token budget per tier. These are BOBI-side suggestions: each
 * adapter clamps them further when its vendor documents a hard floor/ceiling.
 */
export const REASONING_TIER_BUDGETS: Readonly<Record<Exclude<ReasoningEffort, "off">, number>> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

/**
 * Documented vendor bounds a tier budget is clamped into.
 *
 * Only vendors with a published, stable bound are listed; unknown vendors
 * (including arbitrary OpenAI-compatible endpoints) keep the neutral tier
 * budget untouched.
 */
const VENDOR_BUDGET_BOUNDS: Readonly<Record<string, { min: number; max: number }>> = {
  // Anthropic rejects budget_tokens below 1024, and requires
  // max_tokens > budget_tokens (the adapter enforces the latter).
  anthropic: { min: 1024, max: 64000 },
};

/**
 * Resolve the vendor-neutral reasoning parameters for one adapter.
 *
 * `providerId` selects per-vendor budget clamping where the vendor documents
 * a bound; unknown ids keep the neutral tier budget. The function never
 * invents an effort: "off" always yields `enabled: false`.
 */
export function reasoningParamsFor(providerId: string, effort: ReasoningEffort): ReasoningParams {
  if (effort === "off") {
    return { effort, enabled: false, budgetTokens: 0, levelName: undefined };
  }
  const tier = REASONING_TIER_BUDGETS[effort];
  const bounds = VENDOR_BUDGET_BOUNDS[providerId.trim().toLowerCase()];
  const budgetTokens =
    bounds === undefined ? tier : Math.min(Math.max(tier, bounds.min), bounds.max);
  return { effort, enabled: true, budgetTokens, levelName: effort };
}
