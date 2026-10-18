/**
 * Prompt-caching discipline.
 *
 * Providers cache a request's prefix only when it is byte-identical to a
 * previous request's prefix. Any byte that varies turn to turn — a timestamp,
 * a random id, a reordered block — moves the cache breakpoint and the whole
 * prefix is billed as fresh input again. The contract:
 *
 *   1. The system prompt must be built DETERMINISTICALLY: same inputs,
 *      same bytes. No Date.now(), no Math.random(), no iteration-order
 *      dependence inside it.
 *   2. Only the user/history section of the request may change between turns.
 *   3. Cache breakpoints (Anthropic `cache_control`) are opt-in via
 *      BOBI_PROMPT_CACHE=1 and are placed only on the system prompt —
 *      owner-authored, trusted text — never on tool results, which can
 *      carry attacker-influenced content.
 *
 * Determinism audit of src/agent/prompt.ts (read-only; behaviour unchanged):
 *   - buildSystemPrompt is a pure function of its PromptContext: no
 *     randomness, no ambient clock, no map-order dependence. Given the same
 *     context object it returns byte-identical text.
 *   - BUT src/conversation/engine.ts rebuilds the context every turn with
 *     `now: this.now()` (a fresh Date), and the time block
 *     ("زمان فعلی: ...") embeds it. Two consecutive turns therefore differ
 *     by at least that line, breaking cache stability in production.
 *   - `memoryCount` is also re-read per turn: if the agent stores a memory
 *     mid-conversation, the prompt changes ("N مورد ذخیره‌شده").
 *   - `skillContext` is matched against the user's latest message, so it
 *     varies per turn by design.
 *   Documented, not changed: fixing it (freezing `now` per conversation, or
 *   moving the clock into a user message) is a deliberate product decision
 *     for a later phase — see docs/phase-reasoning-cache.md.
 */
import { createHash } from "node:crypto";

/** Primary environment variable enabling prompt-cache breakpoints. */
export const PROMPT_CACHE_ENV_VAR = "BOBI_PROMPT_CACHE";
/** Legacy prefix accepted as a fallback, matching config.ts convention. */
const LEGACY_PROMPT_CACHE_ENV_VAR = "SOL_PROMPT_CACHE";

/**
 * Whether prompt-cache breakpoints are enabled for this process.
 * Opt-in: anything other than an explicit "1"/"true"/"yes" means off.
 */
export function promptCacheEnabled(
  env: { [key: string]: string | undefined } = process.env,
): boolean {
  const raw = (env[PROMPT_CACHE_ENV_VAR] ?? env[LEGACY_PROMPT_CACHE_ENV_VAR] ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * sha256 hex fingerprint of a built system prompt.
 *
 * The fingerprint is what a test compares across turns: equal hashes mean
 * the provider will see the same prefix and hit the cache.
 */
export function hashSystemPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/**
 * Assert that every built prompt in the list is byte-identical.
 *
 * Used by tests: build the system prompt for several turns of a fixed
 * fixture (frozen `now`, same tools/owner config) and assert the provider
 * would see one stable prefix. Throws with the divergent hashes on failure.
 */
export function assertPromptStable(prompts: readonly string[], label = "system prompt"): void {
  if (prompts.length < 2) {
    throw new Error(`assertPromptStable needs at least two prompts to compare, got ${prompts.length}.`);
  }
  const first = prompts[0];
  if (first === undefined) throw new Error("assertPromptStable got an empty prompt list.");
  const expected = hashSystemPrompt(first);
  for (let i = 1; i < prompts.length; i++) {
    const current = prompts[i];
    if (current === undefined) continue;
    const actual = hashSystemPrompt(current);
    if (actual !== expected) {
      throw new Error(
        `CACHE-BREAK: ${label} differs between index 0 and index ${i} ` +
          `(sha256 ${expected.slice(0, 12)}… vs ${actual.slice(0, 12)}…). ` +
          `Only the user/history section may change between turns.`,
      );
    }
  }
}

/**
 * Anthropic cache breakpoint for the system prompt.
 *
 * Attached to the system content block when BOBI_PROMPT_CACHE=1. The 5-minute
 * `ephemeral` TTL is the provider default; it is left unset here so the
 * provider's default applies.
 */
export function anthropicCacheBreakpoint(): { cache_control: { type: "ephemeral" } } {
  return { cache_control: { type: "ephemeral" } };
}
