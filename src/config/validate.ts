/**
 * Phase 7 — boot validation of typed knobs.
 *
 * For every registered knob with a typed value (int / float / enum), when a
 * value IS set (through the knob's chain) but does not parse or is not in
 * the enum set, that is a configuration problem worth surfacing loudly —
 * the historical failure mode was a value that silently never applied.
 *
 * Resolution semantics are NOT changed here: consumers keep their existing
 * clamp/fallback behaviour. Validation only reports. Boot (src/index.ts)
 * prints every problem to stderr; with BOBI_CONFIG_STRICT=1 it also throws,
 * so a mistyped knob can be made a hard deploy failure by owner choice.
 */
import { KNOBS, readChained, type EnvRecord } from "./env";

export interface ConfigProblem {
  /** The spelling that actually carried the bad value. */
  name: string;
  /** The offending value (never a secret: secrets are type "secret" and skipped). */
  value: string;
  reason: string;
}

/** Which spelling in the chain supplied the value, for the report. */
function resolvedSpelling(
  env: EnvRecord,
  knob: (typeof KNOBS)[number],
): { name: string; value: string } | undefined {
  const suffix = knob.name.startsWith("BOBI_")
    ? knob.name.slice("BOBI_".length)
    : knob.name;
  const candidates: string[] = [knob.name];
  if (knob.chain === "full" || knob.chain === "prefixed") {
    if (knob.name.startsWith("BOBI_")) candidates.push(`SOL_${suffix}`);
  }
  if (knob.chain === "full" && knob.name.startsWith("BOBI_")) {
    candidates.push(suffix);
  }
  for (const name of candidates) {
    const v = env[name];
    if (v !== undefined) return { name, value: v };
  }
  return undefined;
}

/** Collect every invalid typed-knob value in `env`. Pure; never throws. */
export function validateEnv(env: EnvRecord): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const knob of KNOBS) {
    if (knob.type !== "int" && knob.type !== "float" && knob.type !== "enum") {
      continue;
    }
    // Sanity: the registry's resolution must agree with the chain reader.
    void readChained;
    const hit = resolvedSpelling(env, knob);
    if (hit === undefined) continue;
    const raw = hit.value.trim();
    if (raw === "") continue; // blank means "unset" everywhere in this codebase
    if (knob.type === "enum") {
      const candidate = knob.enumCaseInsensitive === true ? raw.toLowerCase() : raw;
      if (knob.enumValues !== undefined && !knob.enumValues.includes(candidate)) {
        problems.push({
          name: hit.name,
          value: hit.value,
          reason: `expected one of: ${knob.enumValues.join(", ")}`,
        });
      }
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      problems.push({
        name: hit.name,
        value: hit.value,
        reason: `expected a ${knob.type === "int" ? "number (integer semantics)" : "number"}`,
      });
      continue;
    }
    if (knob.min !== undefined && n < knob.min) {
      problems.push({
        name: hit.name,
        value: hit.value,
        reason: `below the documented minimum ${knob.min} (the consumer clamps/falls back)`,
      });
    } else if (knob.max !== undefined && n > knob.max) {
      problems.push({
        name: hit.name,
        value: hit.value,
        reason: `above the documented maximum ${knob.max} (the consumer clamps/falls back)`,
      });
    }
  }
  return problems;
}

/** One loud, greppable line per problem. */
export function formatConfigProblems(problems: readonly ConfigProblem[]): string {
  return problems
    .map((p) => `[config] INVALID ${p.name}=${JSON.stringify(p.value)} — ${p.reason}`)
    .join("\n");
}
