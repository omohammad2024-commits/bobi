/**
 * Per-model quarantine — stop routing turns to a model that keeps failing.
 *
 * WHY: the circuit breaker is per PROVIDER, but providers are healthy far
 * more often than individual MODELS on them are: a free gateway lists
 * dozens of models, and one can be silently empty, rate-limited by name,
 * or pulled upstream while its siblings answer fine. Without a per-model
 * memory the failover chain re-tries that same broken model on every
 * single turn, burning the attempt budget before reaching a healthy one.
 *
 * Semantics: after FAILURE_THRESHOLD (3) CONSECUTIVE failures of one
 * (provider, model) pair, the gateway skips that model for
 * BOBI_MODEL_QUARANTINE_MS (default 300000). Any success resets the
 * counter immediately. A quarantined model is never skipped when it is
 * the only configured candidate — a slim chance beats a guaranteed
 * "no provider" failure — and the quarantine expires on its own, which is
 * also how a healed model returns: no probe needs to clear it.
 *
 * What counts as a failure is the GATEWAY's decision (it records
 * candidate outcomes: everything except aborts and auth faults — auth is
 * a configuration error the owner must see, never a model behaviour to
 * route around). This registry is deliberately separate from the circuit
 * breaker: the breaker tracks PROVIDER health, this tracks MODEL
 * behaviour on otherwise-healthy providers. The two never share counters.
 *
 * IN-MEMORY BY DESIGN, like the breaker and the credential cooldowns: a
 * restart forgets every quarantine, which is fail-open in the safe
 * direction (a possibly-dead model is tried once more, not banned
 * forever). No timers are needed: quarantine is a timestamp comparison,
 * so there is nothing to unref — the registry starts no background work.
 */

/** Env var that disables model quarantine entirely. Default: ON. */
import { flagUnlessOff, processEnv, readNamed } from "../config/env";
export const MODEL_QUARANTINE_ENV_VAR = "BOBI_MODEL_QUARANTINE";
/** Env var for the quarantine duration, ms. Default 300000; 0 = off. */
export const MODEL_QUARANTINE_MS_ENV_VAR = "BOBI_MODEL_QUARANTINE_MS";

/** Consecutive failures of one (provider, model) that trigger quarantine. */
export const MODEL_QUARANTINE_FAILURE_THRESHOLD = 3;

/** Default quarantine duration, ms — five minutes. */
export const MODEL_QUARANTINE_DEFAULT_MS = 300_000;

export function modelQuarantineEnabled(): boolean {
  return flagUnlessOff(readNamed(processEnv(), MODEL_QUARANTINE_ENV_VAR));
}

/** Quarantine duration, ms. 0 disables (also via the kill switch above). */
export function modelQuarantineMs(): number {
  const raw = readNamed(processEnv(), MODEL_QUARANTINE_MS_ENV_VAR);
  if (raw !== undefined) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return MODEL_QUARANTINE_DEFAULT_MS;
}

/** A snapshot of one model's quarantine state, safe for logs and panels. */
export interface ModelQuarantineView {
  quarantined: boolean;
  /** Failures since the last success for this (provider, model). */
  consecutiveFailures: number;
  /** Unix ms when the quarantine lifts. Present only while quarantined. */
  until?: number;
}

interface QuarantineEntry {
  consecutiveFailures: number;
  /** Unix ms until which the model is skipped. 0 = not quarantined. */
  until: number;
}

export interface ModelQuarantineOptions {
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Quarantine duration, ms. Default: modelQuarantineMs(). */
  durationMs?: number;
  /** Consecutive failures that trigger quarantine. Default 3. */
  threshold?: number;
}

export class ModelQuarantineRegistry {
  private readonly now: () => number;
  private readonly durationMs: number;
  private readonly threshold: number;
  private readonly entries = new Map<string, QuarantineEntry>();

  constructor(opts: ModelQuarantineOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.durationMs = opts.durationMs ?? modelQuarantineMs();
    this.threshold = Math.max(1, opts.threshold ?? MODEL_QUARANTINE_FAILURE_THRESHOLD);
  }

  private static key(providerId: number, modelId: string): string {
    return `${providerId}:${modelId}`;
  }

  /**
   * Record one failed attempt of this model. At the consecutive-failure
   * threshold the model is quarantined for the configured duration; a
   * failure recorded while already quarantined (a forced "only candidate"
   * attempt) extends the quarantine from now.
   */
  recordFailure(providerId: number, modelId: string): void {
    if (this.durationMs <= 0) return;
    const key = ModelQuarantineRegistry.key(providerId, modelId);
    const entry = this.entries.get(key) ?? { consecutiveFailures: 0, until: 0 };
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= this.threshold) {
      entry.until = this.now() + this.durationMs;
    }
    this.entries.set(key, entry);
  }

  /** Record a success: the model answered, so every counter resets. */
  recordSuccess(providerId: number, modelId: string): void {
    this.entries.delete(ModelQuarantineRegistry.key(providerId, modelId));
  }

  /** True while this model is inside its quarantine window. */
  isQuarantined(providerId: number, modelId: string): boolean {
    if (this.durationMs <= 0) return false;
    const entry = this.entries.get(ModelQuarantineRegistry.key(providerId, modelId));
    return entry !== undefined && entry.until > this.now();
  }

  /** Read one model's quarantine snapshot. Unknown models read as clean. */
  state(providerId: number, modelId: string): ModelQuarantineView {
    const entry = this.entries.get(ModelQuarantineRegistry.key(providerId, modelId));
    if (entry === undefined) return { quarantined: false, consecutiveFailures: 0 };
    const quarantined = entry.until > this.now();
    return {
      quarantined,
      consecutiveFailures: entry.consecutiveFailures,
      ...(quarantined ? { until: entry.until } : {}),
    };
  }
}

/**
 * The process-wide registry instance. The health service reads
 * `quarantined` from it for the panel; a host wires it into the gateway
 * (AiGateway accepts it via its `quarantine` option, exactly like the
 * shared circuit-breaker registry) so the state the gateway acts on is
 * the state the panel shows. Tests construct their own registry and
 * inject it, never touching this one.
 */
export const sharedModelQuarantine = new ModelQuarantineRegistry();
