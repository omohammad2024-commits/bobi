/**
 * Per-provider circuit breaker — stop hammering a service that is already
 * down.
 *
 * WHY: the gateway already fails over across providers, but when the
 * primary is sick it still gets hit on EVERY request: 429s, timeouts and
 * 5xxs burn quota, latency and the request budget while the answer was
 * never going to come. The breaker trips after N consecutive transient
 * failures and skips that provider for a cooldown, so traffic flows to the
 * healthy candidates until the service recovers.
 *
 * States: closed (normal) → open (skipped) → half-open (one probe call
 * allowed) → closed again on success, or re-opened on failure. Cooldowns
 * double per consecutive opening (30s → 60s → 120s …) and cap at 5 minutes,
 * so a provider that keeps failing stays out of the way longer while a
 * flapping one is retried quickly.
 *
 * IN-MEMORY BY DESIGN, like the gateway's credential cooldowns: a restart
 * forgets every opening, which is fail-open in the safe direction (a
 * possibly-dead provider is tried once more, not trusted forever).
 *
 * What counts as a failure is the CALLER's decision (the gateway only
 * records quota/network/timeout — transient, provider-side faults). Auth,
 * validation and configuration errors never trip a breaker: they mean the
 * config is wrong, not that the service is down.
 *
 * Rebinding note: nothing here resolves or connects; it only tracks
 * outcomes per provider id. The address validation policy in dns_guard is
 * unaffected.
 */

/** Env var that disables the circuit breaker entirely. Default: ON. */
export const CIRCUIT_BREAKER_ENV_VAR = "BOBI_CIRCUIT_BREAKER";
/** Env var overriding the consecutive-failure trip threshold. Default 3. */
export const BREAKER_THRESHOLD_ENV_VAR = "BOBI_BREAKER_THRESHOLD";
/** Env var overriding the base cooldown between openings, ms. Default 30000. */
export const BREAKER_COOLDOWN_MS_ENV_VAR = "BOBI_BREAKER_COOLDOWN_MS";

/** Cap on one cooldown, ms — 5 minutes. */
export const BREAKER_MAX_COOLDOWN_MS = 5 * 60 * 1000;

export function circuitBreakerEnabled(): boolean {
  const raw = process.env[CIRCUIT_BREAKER_ENV_VAR];
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** Consecutive transient failures that open the breaker. Default 3, min 1. */
export function breakerThreshold(): number {
  const raw = process.env[BREAKER_THRESHOLD_ENV_VAR];
  if (raw !== undefined) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 3;
}

/** Cooldown after the first opening, ms. Default 30s; invalid → default. */
export function breakerBaseCooldownMs(): number {
  const raw = process.env[BREAKER_COOLDOWN_MS_ENV_VAR];
  if (raw !== undefined) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 30_000;
}

/** Breaker states for one provider. */
export type CircuitState = "closed" | "open" | "half_open";

/** A snapshot of one provider's breaker, safe for logs and the panel. */
export interface CircuitStateView {
  state: CircuitState;
  /** Transient failures since the last success. */
  consecutiveFailures: number;
  /** Cooldown currently in effect for this opening cycle, ms. */
  cooldownMs: number;
  /**
   * Unix ms when an open breaker becomes eligible for a half-open probe.
   * Present only while open; a closed breaker needs no cooldown.
   */
  nextRetryAt?: number;
}

/** One state change, for the transition hook. No keys, no addresses. */
export interface CircuitTransition {
  providerId: number;
  from: CircuitState;
  to: CircuitState;
  /** Unix ms of the transition. */
  at: number;
}

/** Narrow read interface, so the smart router and health service can share it. */
export interface CircuitStateReader {
  state(providerId: number): CircuitStateView;
}

interface BreakerEntry {
  state: CircuitState;
  consecutiveFailures: number;
  /** How many times in a row the breaker has opened without a success. */
  openings: number;
  cooldownMs: number;
  /** Unix ms of the most recent opening. */
  openedAt: number;
  /** True while a half-open probe call is in flight. */
  probeInFlight: boolean;
}

export interface CircuitBreakerOptions {
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  threshold?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  /** Fired on every state transition. Never throws: invoked in try/catch. */
  onTransition?: (t: CircuitTransition) => void;
}

export class CircuitBreakerRegistry implements CircuitStateReader {
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly onTransition: CircuitBreakerOptions["onTransition"];
  private readonly entries = new Map<number, BreakerEntry>();

  constructor(opts: CircuitBreakerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.threshold = opts.threshold ?? breakerThreshold();
    this.baseCooldownMs = opts.baseCooldownMs ?? breakerBaseCooldownMs();
    this.maxCooldownMs = opts.maxCooldownMs ?? BREAKER_MAX_COOLDOWN_MS;
    this.onTransition = opts.onTransition;
  }

  /**
   * Try to take a call slot for a provider.
   *
   * - closed → allowed (returned "closed").
   * - open, cooldown not elapsed → denied (undefined).
   * - open, cooldown elapsed → the breaker half-opens and exactly ONE probe
   *   call is allowed (returned "probe"). Further acquires stay denied
   *   until that probe resolves (success, failure, or explicit release).
   * - half_open → allowed only if no probe is in flight.
   */
  tryAcquire(providerId: number): "closed" | "probe" | undefined {
    const entry = this.entry(providerId);
    const now = this.now();
    if (entry.state === "closed") return "closed";
    if (entry.state === "half_open") {
      if (entry.probeInFlight) return undefined;
      entry.probeInFlight = true;
      return "probe";
    }
    // Open: the cooldown may have expired, which promotes to half-open.
    if (now - entry.openedAt >= entry.cooldownMs) {
      this.transition(entry, providerId, "half_open");
      entry.probeInFlight = true;
      return "probe";
    }
    return undefined;
  }

  /**
   * Release a half-open probe slot WITHOUT recording an outcome.
   *
   * For outcomes the breaker does not track (auth, validation, caller
   * abort): the probe is over, the service's health is unchanged, and the
   * next request may probe again. No-op in any other state.
   */
  releaseProbe(providerId: number): void {
    const entry = this.entries.get(providerId);
    if (entry !== undefined && entry.state === "half_open") {
      entry.probeInFlight = false;
    }
  }

  /**
   * Record a transient, provider-side failure (quota/429, network/5xx,
   * timeout). Increments the consecutive count; at the threshold the
   * breaker opens. A failed half-open probe re-opens with a doubled
   * cooldown. Non-tripping errors must never reach this method.
   */
  recordFailure(providerId: number): void {
    const entry = this.entry(providerId);
    entry.consecutiveFailures += 1;
    if (entry.state === "half_open") {
      this.reopen(entry, providerId);
      return;
    }
    if (entry.state === "open") {
      // A forced attempt (the all-open fallback) failed: treat it like a
      // failed probe — the service is still down, so push the cooldown out.
      this.reopen(entry, providerId);
      return;
    }
    if (entry.consecutiveFailures >= this.threshold) {
      this.reopen(entry, providerId);
    }
  }

  /**
   * Record a success. Closes the breaker and resets every counter, so a
   * provider that recovers immediately gets the full failure budget back
   * and the next opening starts at the base cooldown again.
   */
  recordSuccess(providerId: number): void {
    const entry = this.entries.get(providerId);
    if (entry === undefined) return;
    entry.consecutiveFailures = 0;
    entry.openings = 0;
    entry.cooldownMs = this.baseCooldownMs;
    entry.probeInFlight = false;
    if (entry.state !== "closed") {
      this.transition(entry, providerId, "closed");
    }
  }

  /** Read one provider's breaker snapshot. Unknown providers read as closed. */
  state(providerId: number): CircuitStateView {
    const entry = this.entries.get(providerId);
    if (entry === undefined) {
      return { state: "closed", consecutiveFailures: 0, cooldownMs: this.baseCooldownMs };
    }
    const view: CircuitStateView = {
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      cooldownMs: entry.cooldownMs,
    };
    if (entry.state === "open") {
      view.nextRetryAt = entry.openedAt + entry.cooldownMs;
    }
    return view;
  }

  /** Snapshots for every provider the registry has seen. */
  states(): Array<{ providerId: number } & CircuitStateView> {
    const out: Array<{ providerId: number } & CircuitStateView> = [];
    for (const [providerId, entry] of this.entries) {
      out.push({ providerId, ...this.viewOf(entry) });
    }
    return out;
  }

  private entry(providerId: number): BreakerEntry {
    let entry = this.entries.get(providerId);
    if (entry === undefined) {
      entry = {
        state: "closed",
        consecutiveFailures: 0,
        openings: 0,
        cooldownMs: this.baseCooldownMs,
        openedAt: 0,
        probeInFlight: false,
      };
      this.entries.set(providerId, entry);
    }
    return entry;
  }

  private viewOf(entry: BreakerEntry): CircuitStateView {
    const view: CircuitStateView = {
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      cooldownMs: entry.cooldownMs,
    };
    if (entry.state === "open") {
      view.nextRetryAt = entry.openedAt + entry.cooldownMs;
    }
    return view;
  }

  /** Open (or re-open) the breaker, doubling the cooldown per opening. */
  private reopen(entry: BreakerEntry, providerId: number): void {
    entry.openings += 1;
    entry.cooldownMs = Math.min(
      this.baseCooldownMs * 2 ** (entry.openings - 1),
      this.maxCooldownMs,
    );
    entry.openedAt = this.now();
    entry.probeInFlight = false;
    const from = entry.state;
    entry.state = "open";
    // A re-open is a meaningful change (new cooldown) even when the state
    // value was already "open" — it is what keeps a dead provider out.
    this.emit(entry, providerId, from, "open");
  }

  private transition(entry: BreakerEntry, providerId: number, to: CircuitState): void {
    const from = entry.state;
    entry.state = to;
    this.emit(entry, providerId, from, to);
  }

  private emit(
    _entry: BreakerEntry,
    providerId: number,
    from: CircuitState,
    to: CircuitState,
  ): void {
    if (this.onTransition === undefined) return;
    try {
      this.onTransition({ providerId, from, to, at: this.now() });
    } catch {
      // Diagnostics must never break a call.
    }
  }
}
