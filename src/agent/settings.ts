/**
 * Agent-brain runtime switches, read from the environment per AgentLoop
 * construction (the engine builds a fresh loop per run, so a changed variable
 * takes effect on the next message — no restart semantics to reason about).
 *
 * Names follow the project's envVar() pattern: BOBI_ wins, the pre-rename
 * SOL_ prefix is the fallback, the bare name last. Phase 7: the chain itself
 * is implemented once in src/config/env.ts; this module only adds the
 * agent-specific parsing (clamps, flag idiom) on top of it.
 * Values are clamped to sane ranges; nonsense falls back to the default
 * rather than breaking a run.
 */
import { processEnv, readChained } from "../config/env";

type Env = Readonly<Record<string, string | undefined>>;

/** Read one value with the BOBI_ → SOL_ → bare fallback chain. */
export function agentEnv(suffix: string, env: Env = processEnv()): string | undefined {
  return readChained(env, suffix, "full");
}

/** A boolean switch: default on, only explicit false-y strings disable. */
function envFlag(suffix: string, env: Env): boolean {
  const raw = agentEnv(suffix, env);
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** An integer clamped into [min, max]; unparseable falls back. */
function envInt(suffix: string, env: Env, min: number, max: number, fallback: number): number {
  const raw = agentEnv(suffix, env);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parallel tool execution within one model turn. Kill switch: BOBI_AGENT_PARALLEL=0. */
export function parallelEnabled(env: Env = processEnv()): boolean {
  return envFlag("AGENT_PARALLEL", env);
}

/** Concurrency bound for parallel tool execution. Env: BOBI_AGENT_MAX_PARALLEL (default 4). */
export function maxParallel(env: Env = processEnv()): number {
  return envInt("AGENT_MAX_PARALLEL", env, 1, 8, 4);
}

/** Planning mode before the first iteration. Kill switch: BOBI_AGENT_PLANNING=0. */
export function planningEnabled(env: Env = processEnv()): boolean {
  return envFlag("AGENT_PLANNING", env);
}

/** Self-review pass after tool turns. Kill switch: BOBI_AGENT_SELF_REVIEW=0. */
export function selfReviewEnabled(env: Env = processEnv()): boolean {
  return envFlag("AGENT_SELF_REVIEW", env);
}

/**
 * NOTE — no budget overrides live here on purpose: BOBI_AGENT_MAX_ITERATIONS
 * and BOBI_AGENT_MAX_TOOL_CALLS are already read by src/config/config.ts via
 * its envVar() helper and wired into the engine's AgentLoop budgets by
 * src/index.ts. Duplicating them in the loop would double-apply the
 * environment over deliberate per-caller budgets (delegate, heartbeat).
 */
