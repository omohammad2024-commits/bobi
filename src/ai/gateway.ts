/**
 * AI Gateway — the single route from ConversationEngine to a real service.
 *
 * The engine keeps its AiProvider contract, so nothing above this class knows
 * which service answered. What the gateway adds:
 *
 *  1. Runtime selection. It resolves the active provider and model from the
 *     database when a request starts, and that pair is fixed as a snapshot for
 *     the whole request. A settings change made while a reply is streaming
 *     cannot switch models mid-request.
 *  2. Fail-closed resolution. A missing, disabled, or credential-less
 *     selection is refused with a usable message instead of being attempted.
 *  3. No caching of secrets. The credential is decrypted per request, handed
 *     to the adapter, and dropped when the call settles.
 *  4. Optional failover, disabled by default. When the owner turns it on, a
 *     retryable failure moves through an explicitly ordered candidate list,
 *     bounded by max_attempts and a per-candidate timeout.
 *  5. Credential-pool rotation (Phase E3). Within one candidate, the request
 *     tries the primary key first, then the provider's enabled pool keys in
 *     round-robin order. An auth failure cools the failed key down for five
 *     minutes and moves to the next key; network/timeout moves on without
 *     cooldown; anything else (notably invalid_response) is never retried.
 *
 *  6. Circuit breaker (per provider, in-memory). Transient failures
 *     (quota/429, network/5xx, timeout) count toward tripping a provider's
 *     breaker; after N consecutive failures the provider is skipped for a
 *     cooldown that doubles per opening. A half-open breaker admits one
 *     probe call. If every candidate is skipped, the breaker whose cooldown
 *     expires soonest still gets one forced attempt — the gateway never
 *     hard-fails solely on breaker state. Auth/validation/abort errors never
 *     trip a breaker: they are config, not health.
 *  7. Bounded in-call retry. When no failover candidate is available (a
 *     single-candidate plan), a transient failure is retried up to 2 extra
 *     times with jittered exponential backoff, capped at 3s of added wait.
 *     A provider's `Retry-After` (429/503, carried on the AiError) replaces
 *     that cap as the backoff floor for the retry it answered.
 *     Kill switch: BOBI_GATEWAY_RETRY=0.
 *  8. Failover pre-warm. When a plan has a next candidate, an optional
 *     hook is fired (never awaited) so the connection layer can establish
 *     that candidate's connection before a failover needs it.
 *
 * `name` is "ai" so the engine's isFake check stays accurate: the gateway is a
 * real provider, unlike the offline FakeProvider used in tests.
 */
import { AiError } from "./provider";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  TokenUsage,
} from "./provider";
import type { AdapterRegistry } from "./adapter_registry";
import type { ProviderSecretStore } from "./secret_store";
import { CredentialPoolStore } from "./secret_store";
import type { Storage } from "../storage/storage";
// --- smart routing (worker-1) ---
import { SmartRouter } from "./smart_router";
// --- circuit breaker (reliability core) ---
import {
  CircuitBreakerRegistry,
  circuitBreakerEnabled,
  type CircuitStateView,
  type CircuitTransition,
} from "./circuit_breaker";

/** Env var that disables in-call retry. Default: retry is ON. */
export const GATEWAY_RETRY_ENV_VAR = "BOBI_GATEWAY_RETRY";

/** Added wait per retry: 400ms, then 800ms, ±25% jitter. */
const GATEWAY_RETRY_BASE_MS = 400;
/** Extra attempts per send() when no failover candidate is available. */
const GATEWAY_MAX_RETRIES = 2;
/** Total added retry wait is capped here — the owner's latency bar is strict. */
const GATEWAY_RETRY_BUDGET_MS = 3000;

export function gatewayRetryEnabled(): boolean {
  const raw = process.env[GATEWAY_RETRY_ENV_VAR];
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * Jittered exponential backoff: base * 2^retryIndex, ±25%.
 * random() is injected so tests stay deterministic.
 */
function backoffDelayMs(retryIndex: number, random: () => number): number {
  const base = GATEWAY_RETRY_BASE_MS * 2 ** retryIndex;
  const jitter = 0.75 + random() * 0.5;
  return Math.round(base * jitter);
}

/**
 * The delay before the next retry of one candidate.
 *
 * When the provider sent `Retry-After` (parsed onto the AiError by the
 * status mapper for 429/503), that value is the FLOOR: retrying earlier
 * than the provider asked just earns another rejection. The wait budget
 * widens to fit the floor — the provider's explicit ask outranks the
 * gateway's own 3s cap — but the floor itself is already clamped to 30s
 * by the parser, so one retry can never stall a turn indefinitely.
 */
function retryDelayMs(
  err: AiError,
  retryIndex: number,
  random: () => number,
): { delay: number; budget: number } {
  const floor = err.retryAfterMs ?? 0;
  return {
    delay: Math.max(backoffDelayMs(retryIndex, random), floor),
    budget: Math.max(GATEWAY_RETRY_BUDGET_MS, floor),
  };
}

/**
 * Failures the circuit breaker counts: transient, provider-side faults the
 * provider itself (not the config) is responsible for. 429 quota, network
 * and timeout failures mean the service is down or saturated; auth,
 * validation, abort and unknown failures mean something else — the breaker
 * must not punish the provider for those. This is also the retry-eligibility
 * set for in-call retry.
 */
function isTransientFailure(err: AiError): boolean {
  switch (err.kind) {
    case "quota":
    case "network":
    case "timeout":
      return true;
    case "auth":
    case "invalid_response":
    case "aborted":
    case "unknown":
      return false;
  }
}

/** Alias that reads better at the retry call sites. */
const isRetryEligible = isTransientFailure;

/** Alias that reads better at the breaker call sites. */
const tripsBreaker = isTransientFailure;

/**
 * What the usage listener receives for one attempt that returned usage.
 *
 * Token counts only — never prompts, completions, or key material. The
 * listener does not learn which user or conversation the attempt belonged to;
 * binding usage to a turn is the caller's job (UsageTracker.record takes the
 * full run record).
 */
export interface UsageAttemptInfo {
  providerId: number;
  modelId: string;
  usage: TokenUsage;
}

export interface GatewayOptions {
  storage: Storage;
  adapters: AdapterRegistry;
  secrets: ProviderSecretStore;
  /** Optional owner-tunable settings applied to every request. */
  settings?: {
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
  };
  /**
   * Optional usage listener, fired for every attempt whose response carries
   * usage (token counts only — see UsageAttemptInfo). Invoked inside
   * try/catch, so a throwing listener can never break a turn.
   */
  onUsage?: (info: UsageAttemptInfo) => void;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /**
   * Optional diagnostic hook, fired when a non-AiError is mapped to
   * AiError("unknown"). The original error is passed so the real cause
   * (which the user-safe "unknown" category hides) reaches the logs.
   * Never throws: invoked inside try/catch.
   */
  onUnknownError?: (err: unknown, where: string) => void;
  /**
   * Shared circuit-breaker registry. The gateway creates its own when this
   * is omitted; pass one in to share breaker state with other readers (the
   * health service's probe surface, the panel). When a registry is
   * supplied, `onCircuitTransition` is ignored — the registry's owner
   * configures its transition hook.
   */
  breakers?: CircuitBreakerRegistry;
  /**
   * Optional transition hook for the gateway's own registry. Default:
   * logged at info level (provider id + states only, never key material).
   * Never throws: the registry invokes it inside try/catch.
   */
  onCircuitTransition?: (t: CircuitTransition) => void;
  /** Injectable backoff sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for backoff jitter, for deterministic tests. */
  random?: () => number;
  /**
   * Connection pre-warm hook (connection layer). Fired synchronously —
   * and never awaited — with the SECOND candidate whenever a request plan
   * has more than one, so a failover switch does not pay the full
   * TCP+TLS handshake on the user's turn. The hook owns its own async
   * work and error swallowing; the gateway also invokes it in try/catch.
   */
  preWarm?: (candidate: GatewaySelection) => void;
}

/** The provider/model pair a request actually used. Never includes a key. */
export interface GatewayAttempt {
  providerId: number;
  providerLabel: string;
  adapterType: string;
  modelId: string;
  modelLabel: string;
}

/** A resolved, self-consistent provider+model pair for one request. */
export interface GatewaySelection {
  providerId: number;
  providerLabel: string;
  adapterType: string;
  baseUrl: string;
  modelId: string;
  modelLabel: string;
  /** Owner exception allowing a loopback/private base URL for this provider. */
  allowLocal: boolean;
}

export class AiGateway implements AiProvider {
  readonly name = "ai";

  private readonly storage: Storage;
  private readonly adapters: AdapterRegistry;
  private readonly secrets: ProviderSecretStore;
  private readonly settings: GatewayOptions["settings"];
  private readonly now: () => number;
  private readonly pool: CredentialPoolStore;
  /**
   * Usage listener, if the host configured one. Every invocation is wrapped
   * in try/catch, so a throwing listener can never break a turn.
   */
  private readonly onUsage: GatewayOptions["onUsage"];
  private readonly onUnknownError: GatewayOptions["onUnknownError"];

  /** Per-provider circuit breakers (reliability core). */
  private readonly breakers: CircuitBreakerRegistry;
  /** Kill switch BOBI_CIRCUIT_BREAKER=0: breakers are never consulted. */
  private readonly breakersOn: boolean;
  /** Kill switch BOBI_GATEWAY_RETRY=0: no in-call retry. */
  private readonly retryOn: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  /** Optional connection pre-warm hook for the next failover candidate. */
  private readonly preWarm: GatewayOptions["preWarm"];

  /**
   * Cooldowns for keys that failed with auth, keyed by "p:<providerId>" for
   * the primary credential and "pool:<entryId>" for pool keys, mapping to the
   * unix-ms time when the key becomes usable again. IN-MEMORY BY DESIGN: a
   * restart forgets every cooldown, which is fail-open in the safe direction
   * (a possibly-dead key is retried once, not trusted forever). It never
   * holds key material — ids only.
   */
  private readonly cooldowns = new Map<string, number>();

  /**
   * How long an auth-failed key stays out of rotation.
   *
   * Five minutes: long enough to stop hammering a revoked key (and to stop
   * burning the request budget on a key that cannot succeed), short enough
   * that an owner who just fixed the key on the service side is not locked
   * out for long. Disable/remove the entry for an immediate effect.
   */
  private static readonly CREDENTIAL_COOLDOWN_MS = 5 * 60 * 1000;

  constructor(opts: GatewayOptions) {
    this.storage = opts.storage;
    this.adapters = opts.adapters;
    this.secrets = opts.secrets;
    this.settings = opts.settings;
    this.now = opts.now ?? Date.now;
    this.pool = new CredentialPoolStore(opts.storage, opts.secrets);
    this.onUsage = opts.onUsage;
    this.onUnknownError = opts.onUnknownError;
    this.breakersOn = circuitBreakerEnabled();
    this.retryOn = gatewayRetryEnabled();
    this.sleep =
      opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.preWarm = opts.preWarm;
    this.breakers =
      opts.breakers ??
      new CircuitBreakerRegistry({
        now: this.now,
        onTransition:
          opts.onCircuitTransition ??
          ((t: CircuitTransition) => {
            // Info level: provider ids and state names only — no key
            // material, no addresses, no request content.
            console.info(
              `[circuit-breaker] provider ${t.providerId}: ${t.from} -> ${t.to}`,
            );
          }),
      });
  }

  /**
   * Report an error that surfaces to the caller as AiError("unknown").
   * The user-safe category hides the real cause; this hook lets it reach
   * the logs. Never throws.
   */
  private reportUnknown(err: unknown, where: string): void {
    try {
      this.onUnknownError?.(err, where);
    } catch {
      // Diagnostics must never break a turn.
    }
  }

  /**
   * Error instances already sent to the diagnostic hook. The call chain
   * (complete → send → attempt) catches and re-maps the SAME instance at
   * several layers; without this, one failure would be logged once per
   * layer instead of once per failure.
   */
  private readonly reportedUnknowns = new WeakSet<object>();

  /**
   * Map a caught error onto the AiError the caller will see, reporting the
   * opaque cases through reportUnknown exactly once per error instance.
   *
   * An adapter can throw an AiError("unknown") directly (e.g. an HTTP status
   * with no cleaner category); those carry their cause in the status/message
   * and are reported too — previously only non-AiError exceptions reached
   * the diagnostic hook, so status-derived unknowns vanished from the logs.
   */
  private mapError(err: unknown, where: string): AiError {
    if (err instanceof AiError) {
      if (err.kind === "unknown" && !this.reportedUnknowns.has(err)) {
        this.reportedUnknowns.add(err);
        this.reportUnknown(err, where);
      }
      return err;
    }
    this.reportUnknown(err, where);
    const mapped = new AiError("unknown", "Unknown service error.");
    // The mapped replacement is what outer layers will catch; mark it so
    // they do not report the same failure again.
    this.reportedUnknowns.add(mapped);
    return mapped;
  }

  /**
   * The current selection, resolved fresh from the database.
   * Returns undefined when nothing valid is selected.
   */
  currentSelection(): GatewaySelection | undefined {
    const settings = this.storage.getRuntimeSettings();
    if (settings.activeProviderId === null || settings.activeModelId === null) return undefined;

    const provider = this.storage.getProvider(settings.activeProviderId);
    if (!provider || !provider.enabled) return undefined;

    const model = this.storage.getModel(settings.activeModelId);
    if (!model || !model.enabled || model.providerId !== provider.id) return undefined;

    return {
      providerId: provider.id,
      providerLabel: provider.label,
      adapterType: provider.adapter,
      baseUrl: provider.baseUrl,
      modelId: model.modelId,
      modelLabel: model.label,
      allowLocal: provider.allowLocal,
    };
  }

  /**
   * Why there is no valid selection right now, for user-facing diagnostics.
   * Used by the FakeProvider fallback so the owner sees WHICH provider broke
   * and how to fix it instead of a generic "not configured".
   */
  describeSelectionProblem(): string {
    let settings: { activeProviderId: number | null; activeModelId: number | null };
    try {
      settings = this.storage.getRuntimeSettings();
    } catch {
      return "Could not read settings.";
    }
    if (settings.activeProviderId === null || settings.activeModelId === null) {
      return "No provider and model selected yet. Add and activate a provider from /ai or the mini app.";
    }
    let provider;
    try {
      provider = this.storage.getProvider(settings.activeProviderId);
    } catch {
      return "Could not read the provider.";
    }
    if (provider === undefined) {
      return "The selected provider was deleted. Pick another provider from /ai.";
    }
    if (!provider.enabled) {
      return `Provider "${provider.label}" is disabled. Enable it or pick another provider from /ai.`;
    }
    let hasCredential = false;
    try {
      hasCredential = this.storage.hasCredential(provider.id);
    } catch {
      // Treat as missing below.
    }
    if (!hasCredential) {
      return `The credential for provider "${provider.label}" was removed. Enter the key again or pick another provider from /ai.`;
    }
    let model;
    try {
      model = this.storage.getModel(settings.activeModelId);
    } catch {
      return "Could not read the model.";
    }
    if (model === undefined || model.providerId !== provider.id) {
      return `The selected model for "${provider.label}" no longer exists. Pick a model from /ai.`;
    }
    if (!model.enabled) {
      return `Model "${model.label}" is disabled. Enable it or pick another model.`;
    }
    return "Configuration is incomplete. Check the status from /ai.";
  }

  /**
   * Whether the active provider accepts raw audio ContentParts natively.
   *
   * Phase B2 seam: the bot layer asks this before deciding whether a voice
   * message must be transcribed first. The capability is read from the
   * registry's static description (no adapter is constructed, so no
   * credential is decrypted for a mere capability check). No valid selection
   * or an unknown adapter type reads as false — fail-closed toward the
   * transcription path when transcription is configured; when it is not,
   * the audio parts simply keep the adapter's existing named-note behaviour.
   */
  supportsAudioInput(): boolean {
    const sel = this.currentSelection();
    if (!sel) return false;
    return this.adapters.describes(sel.adapterType).audioInput;
  }

  /**
   * Phase B5 seam: the bot layer asks this before deciding whether document
   * parts must be extracted locally first. Read from the registry's static
   * description (no adapter constructed, no credential decrypted). No valid
   * selection or an unknown adapter type reads as false — fail-closed toward
   * local extraction; a provider that natively supports documents simply
   * receives the parts untouched.
   */
  supportsDocumentInput(): boolean {
    const sel = this.currentSelection();
    if (!sel) return false;
    return this.adapters.describes(sel.adapterType).documentInput;
  }

  /** Circuit-breaker snapshot for one provider (observability surface). */
  circuitState(providerId: number): CircuitStateView {
    return this.breakers.state(providerId);
  }

  /** Circuit-breaker snapshots for every provider seen this process. */
  circuitStates(): Array<{ providerId: number } & CircuitStateView> {
    return this.breakers.states();
  }

  /**
   * Complete a request through the active provider and model.
   *
   * @throws AiError with a user-safe message when no valid selection exists,
   * the credential is missing or undecryptable, or the adapter fails.
   */
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // Snapshot: read the selection once, at the start of the request. Every
    // candidate in this request is drawn from that one consistent snapshot, so
    // a configuration change mid-flight cannot mix two different settings.
    // --- smart routing (worker-1): the request is passed so the router can
    // classify it; with routing off or <2 providers the plan is unchanged.
    const plan = this.plan(req);

    if (plan.candidates.length === 0) {
      throw new AiError("invalid_response", "No active provider or model is set.");
    }

    const maxAttempts = plan.failover.enabled ? plan.failover.maxAttempts : 1;
    const timeoutMs = this.attemptTimeout(req, plan);
    // In-call retry is for the single-provider shape: with failover
    // candidates available, the candidate loop IS the redundancy mechanism,
    // and per-provider repeats would only multiply latency.
    const allowRetry = plan.candidates.length === 1;
    let lastError: AiError | undefined;
    let attemptsMade = 0;

    for (const candidate of plan.candidates) {
      // The attempt budget counts real sends, not list positions, so a
      // breaker-skipped candidate never consumes an attempt — failover order
      // is preserved among the candidates that are actually tried.
      if (attemptsMade >= maxAttempts) break;

      const result = await this.runCandidate(candidate, req, timeoutMs, { allowRetry });
      if (result.kind === "skipped") continue;
      attemptsMade += 1;
      if (result.kind === "success") {
        // Report the model that actually answered, as the engine expects.
        return { text: result.res.text, model: result.res.model };
      }
      lastError = result.error;
      // Only a retryable class advances to the next candidate. An auth,
      // validation, or configuration failure must NOT be retried through
      // another provider: it would hide the misconfiguration and could
      // duplicate a non-idempotent request that already went out.
      if (!isRetryable(result.error)) throw result.error;
    }

    // Every candidate was skipped by its circuit breaker: never hard-fail
    // on breaker state alone. The breaker whose cooldown expires soonest
    // gets one forced attempt — if the service recovered early the user
    // still gets an answer, and the outcome re-arms the breaker honestly.
    if (attemptsMade === 0 && maxAttempts >= 1) {
      const soonest = this.soonestToRetry(plan.candidates);
      const result = await this.runCandidate(soonest, req, timeoutMs, {
        allowRetry: false,
        force: true,
      });
      if (result.kind === "success") {
        return { text: result.res.text, model: result.res.model };
      }
      if (result.kind === "error") throw result.error;
    }

    throw lastError ?? new AiError("unknown", "Unknown service error.");
  }

  /**
   * Run one candidate under its circuit breaker, with the bounded in-call
   * retry for the single-provider shape.
   *
   * Breaker bookkeeping is per real send(): a success closes the breaker; a
   * transient failure (quota/network/timeout) counts toward tripping it;
   * any other error leaves the breaker untouched (a half-open probe slot
   * held by such an error is released unrecorded, so the next request may
   * probe again). `force` bypasses the breaker CHECK (the all-open
   * fallback) but still records the outcome: a failed forced attempt
   * re-opens with a doubled cooldown, a successful one closes the breaker.
   */
  private async runCandidate(
    candidate: GatewaySelection,
    req: CompletionRequest,
    timeoutMs: number,
    opts: { allowRetry: boolean; force?: boolean },
  ): Promise<
    | { kind: "success"; res: CompletionResponse }
    | { kind: "error"; error: AiError }
    | { kind: "skipped" }
  > {
    let probe = false;
    if (this.breakersOn && opts.force !== true) {
      const slot = this.breakers.tryAcquire(candidate.providerId);
      if (slot === undefined) return { kind: "skipped" };
      probe = slot === "probe";
    }

    let retriesUsed = 0;
    let waitedMs = 0;
    for (;;) {
      try {
        const res = await this.send(candidate, req, timeoutMs);
        if (this.breakersOn) this.breakers.recordSuccess(candidate.providerId);
        return { kind: "success", res };
      } catch (err) {
        const mapped = this.mapError(err, "gateway");
        if (this.breakersOn) {
          if (tripsBreaker(mapped)) {
            this.breakers.recordFailure(candidate.providerId);
          } else if (probe) {
            this.breakers.releaseProbe(candidate.providerId);
          }
        }
        const canRetry =
          opts.allowRetry &&
          this.retryOn &&
          retriesUsed < GATEWAY_MAX_RETRIES &&
          isRetryEligible(mapped);
        if (!canRetry) return { kind: "error", error: mapped };
        const { delay, budget } = retryDelayMs(mapped, retriesUsed, this.random);
        // The total added wait is capped: a retry whose backoff would blow
        // the budget is not taken. Failing fast beats a slow maybe.
        if (waitedMs + delay > budget) {
          return { kind: "error", error: mapped };
        }
        await this.sleep(delay);
        waitedMs += delay;
        retriesUsed += 1;
        if (req.signal.aborted) {
          return { kind: "error", error: new AiError("aborted", "Request was cancelled.") };
        }
      }
    }
  }

  /** The candidate whose open breaker expires soonest (ties: plan order). */
  private soonestToRetry(
    candidates: readonly GatewaySelection[],
  ): GatewaySelection {
    let best = candidates[0]!;
    let bestAt =
      this.breakers.state(best.providerId).nextRetryAt ?? Number.POSITIVE_INFINITY;
    for (const c of candidates.slice(1)) {
      const at =
        this.breakers.state(c.providerId).nextRetryAt ?? Number.POSITIVE_INFINITY;
      if (at < bestAt) {
        best = c;
        bestAt = at;
      }
    }
    return best;
  }

  /**
   * Stream a request through the active provider and model.
   *
   * The selection snapshot, failover, and credential-pool rotation follow the
   * same rules as complete(), with one streaming-specific boundary: rotation
   * and failover only happen BEFORE the first event is yielded. Once the
   * caller has seen a `text` event, the stream is committed to that
   * key/candidate — a later failure propagates as-is so the caller can
   * handle the partial stream (the loop falls back to a fresh single-shot
   * answer). Retrying another key mid-stream would duplicate text the user
   * already saw.
   *
   * An adapter without its own streaming gets a synthesised stream: the
   * gateway runs its single-shot complete() and emits one `text` event plus
   * the terminal `end`, so callers stream uniformly regardless of adapter.
   *
   * @throws AiError with a user-safe message, same categories as complete().
   */
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> {
    // Same snapshot discipline as complete(): the selection is fixed once,
    // up front, so a settings change mid-stream cannot mix configurations.
    // --- smart routing (worker-1): same routing hook as complete().
    const plan = this.plan(req);

    if (plan.candidates.length === 0) {
      throw new AiError("invalid_response", "No active provider or model is set.");
    }

    const maxAttempts = plan.failover.enabled ? plan.failover.maxAttempts : 1;
    const timeoutMs = this.attemptTimeout(req, plan);
    // Same single-provider retry rule as complete().
    const allowRetry = plan.candidates.length === 1;
    let lastError: AiError | undefined;
    let attemptsMade = 0;

    for (const candidate of plan.candidates) {
      // Same budget discipline as complete(): breaker skips are free, real
      // candidate attempts are what the budget counts.
      if (attemptsMade >= maxAttempts) break;

      const outcome = yield* this.runCandidateStream(candidate, req, timeoutMs, {
        allowRetry,
      });
      if (outcome.kind === "skipped") continue;
      attemptsMade += 1;
      if (outcome.kind === "success") return;
      // Committed: the consumer already saw events, so failing over to
      // another candidate would DUPLICATE text the user already read.
      // The partial stream is the caller's to handle.
      if (outcome.kind === "committed") throw outcome.error;
      lastError = outcome.error;
      // Same rule as complete(): only a retryable class advances.
      if (!isRetryable(outcome.error)) throw outcome.error;
    }

    // All candidates breaker-skipped: same forced soonest-expiry attempt
    // as complete() — breaker state alone never hard-fails a request.
    if (attemptsMade === 0 && maxAttempts >= 1) {
      const soonest = this.soonestToRetry(plan.candidates);
      const outcome = yield* this.runCandidateStream(soonest, req, timeoutMs, {
        allowRetry: false,
        force: true,
      });
      if (outcome.kind === "success") return;
      if (outcome.kind === "error" || outcome.kind === "committed") {
        throw outcome.error;
      }
    }

    throw lastError ?? new AiError("unknown", "Unknown service error.");
  }

  /**
   * Stream one candidate under its circuit breaker, with the bounded
   * in-call retry for the single-provider shape.
   *
   * The retry only re-runs a stream that failed BEFORE its first event —
   * retrying after partial text would duplicate what the user already
   * saw. A failure after the first event is reported as "committed" and
   * is NOT breaker evidence either: the provider answered, then the pipe
   * broke mid-answer; the pre-existing failover rule (propagate as-is)
   * is unchanged.
   */
  private async *runCandidateStream(
    candidate: GatewaySelection,
    req: CompletionRequest,
    timeoutMs: number,
    opts: { allowRetry: boolean; force?: boolean },
  ): AsyncGenerator<
    StreamEvent,
    | { kind: "success" }
    | { kind: "skipped" }
    | { kind: "error"; error: AiError }
    | { kind: "committed"; error: AiError },
    undefined
  > {
    let probe = false;
    if (this.breakersOn && opts.force !== true) {
      const slot = this.breakers.tryAcquire(candidate.providerId);
      if (slot === undefined) return { kind: "skipped" };
      probe = slot === "probe";
    }

    let retriesUsed = 0;
    let waitedMs = 0;
    for (;;) {
      let yielded = false;
      try {
        for await (const ev of this.sendStream(candidate, req, timeoutMs)) {
          yielded = true;
          yield ev;
        }
        if (this.breakersOn) this.breakers.recordSuccess(candidate.providerId);
        return { kind: "success" };
      } catch (err) {
        const mapped = this.mapError(err, "gateway");
        if (yielded) return { kind: "committed", error: mapped };
        if (this.breakersOn) {
          if (tripsBreaker(mapped)) {
            this.breakers.recordFailure(candidate.providerId);
          } else if (probe) {
            this.breakers.releaseProbe(candidate.providerId);
          }
        }
        const canRetry =
          opts.allowRetry &&
          this.retryOn &&
          retriesUsed < GATEWAY_MAX_RETRIES &&
          isRetryEligible(mapped);
        if (!canRetry) return { kind: "error", error: mapped };
        const { delay, budget } = retryDelayMs(mapped, retriesUsed, this.random);
        if (waitedMs + delay > budget) {
          return { kind: "error", error: mapped };
        }
        await this.sleep(delay);
        waitedMs += delay;
        retriesUsed += 1;
        if (req.signal.aborted) {
          return { kind: "error", error: new AiError("aborted", "Request was cancelled.") };
        }
      }
    }
  }

  /**
   * Complete a request against a SPECIFIC configured model, for server-side
   * orchestration (mixture-of-agents).
   *
   * Unlike complete() — where the stored model always wins, a deliberate
   * prompt-injection defense for the main agent loop — this honors req.model,
   * but ONLY when it resolves to an enabled provider+model pair in storage.
   * Callers must additionally validate the name against their own allowlist
   * (consult_models does); the main loop must keep using complete().
   * Credential handling is identical to send(): decrypted per request, never
   * retained.
   *
   * @throws AiError when the model is unknown, disabled, or its provider fails.
   */
  async completeForModel(req: CompletionRequest): Promise<CompletionResponse> {
    const candidate = this.resolveByModelId(req.model);
    if (!candidate) {
      throw new AiError("invalid_response", "This model is not configured or is disabled.");
    }
    // An explicit model request is the caller's demand for THIS provider:
    // the breaker never vetoes it, but outcomes are recorded so the
    // breaker's picture of provider health stays honest.
    try {
      const res = await this.send(candidate, req, req.timeoutMs);
      if (this.breakersOn) this.breakers.recordSuccess(candidate.providerId);
      return { text: res.text, model: res.model };
    } catch (err) {
      const mapped = this.mapError(err, "gateway");
      if (this.breakersOn && tripsBreaker(mapped)) {
        this.breakers.recordFailure(candidate.providerId);
      }
      throw mapped;
    }
  }

  /**
   * Per-attempt timeout for one candidate.
   *
   * The caller's per-request budget always wins when it is tighter: the agent
   * loop shrinks it as the run's wall clock burns down, and the adapter must
   * not outwait the loop — a socket held past the loop's deadline is wasted
   * work behind a confusing double timeout. The failover per-candidate
   * timeout still caps each attempt, so a hanging candidate yields to the
   * next one on time.
   */
  private attemptTimeout(
    req: CompletionRequest,
    plan: { timeoutMs: number },
  ): number {
    return Math.max(1, Math.min(req.timeoutMs, plan.timeoutMs));
  }

  /**
   * Find an enabled provider+model pair by the service's model id string.
   * First match wins; model ids are owner-configured, so collisions are the
   * owner's to avoid.
   */
  private resolveByModelId(modelId: string): GatewaySelection | undefined {
    for (const provider of this.storage.listProviders()) {
      if (!provider.enabled) continue;
      const model = this.storage
        .listModels(provider.id)
        .find((m) => m.enabled && m.modelId === modelId);
      if (model !== undefined) return this.resolve(provider.id, model.id);
    }
    return undefined;
  }

  /**
   * Resolve the ordered candidate list and the failover policy, as one
   * consistent snapshot for this request.
   *
   * --- smart routing (worker-1) ---
   * When routing is enabled and the owner has 2+ eligible providers, the
   * FIRST candidate comes from the SmartRouter (cheapest/fastest pair that
   * satisfies the request's task tier) instead of the active selection.
   * Otherwise the existing behavior is exactly preserved.
   */
  private plan(req?: CompletionRequest): {
    candidates: GatewaySelection[];
    failover: { enabled: boolean; maxAttempts: number; timeoutMs: number };
    timeoutMs: number;
  } {
    const settings = this.storage.getFailoverSettings();
    const primary = this.routedPrimary(req) ?? this.currentSelection();
    const candidates: GatewaySelection[] = [];

    // The active selection is always first when it is valid.
    if (primary) candidates.push(primary);

    if (settings.enabled) {
      // Candidates are the owner's explicit list, in their order.
      for (const c of this.storage.listFailoverCandidates()) {
        const resolved = this.resolve(c.providerId, c.modelId);
        // Skip duplicates of the primary and anything no longer eligible.
        if (!resolved) continue;
        if (candidates.some((x) => x.providerId === resolved.providerId && x.modelId === resolved.modelId)) {
          continue;
        }
        candidates.push(resolved);
      }
    }

    // Connection pre-warm: with a real choice of candidates, the NEXT one
    // gets its connection established in the background so a failover does
    // not pay full connect latency mid-turn. Fire-and-forget — never
    // awaited on the request path, and a warming failure is silent (the
    // failover attempt itself will surface any real problem).
    if (this.preWarm !== undefined && candidates.length > 1) {
      try {
        this.preWarm(candidates[1]!);
      } catch {
        // Warming must never break planning.
      }
    }

    return {
      candidates,
      failover: settings,
      timeoutMs: settings.timeoutMs,
    };
  }

  /**
   * --- smart routing (worker-1) ---
   *
   * Pick the primary candidate via the SmartRouter when routing applies:
   * enabled (BOBI_SMART_ROUTING is not 0/false/no/off) AND the owner has
   * 2+ eligible providers (enabled, with credential, with an enabled model).
   * Returns undefined when routing does not apply, so the caller falls back
   * to currentSelection() with byte-for-byte identical behavior.
   *
   * The decision is logged at debug level: provider/model labels and the
   * routing reason only — never prompts, keys, or user content. Any failure
   * inside the router falls back to the active selection; routing must never
   * break a request.
   */
  private routedPrimary(req: CompletionRequest | undefined): GatewaySelection | undefined {
    if (req === undefined) return undefined;
    try {
      const router = new SmartRouter(
        this.storage,
        this.adapters,
        // --- reliability core: the router hard-excludes open breakers and
        // penalizes half-open ones when scoring. With the feature off the
        // router sees no circuit state and scores exactly as before.
        this.breakersOn ? { circuit: this.breakers } : {},
      );
      if (!router.shouldRoute()) return undefined;
      // The owner's active selection is the tie-break preference: the router
      // deviates from it only when another candidate scores strictly better.
      const active = this.currentSelection();
      const decision = router.route(
        req,
        active !== undefined
          ? { prefer: { providerId: active.providerId, modelId: active.modelId } }
          : undefined,
      );
      if (!decision) return undefined;
      const provider = this.storage.getProvider(decision.providerId);
      if (!provider || !provider.enabled) return undefined;
      const model = this.storage
        .listModels(provider.id)
        .find((m) => m.enabled && m.modelId === decision.modelId);
      if (!model) return undefined;
      console.debug(
        `[smart-routing] ${decision.providerLabel}/${decision.modelLabel} — ${decision.reason}`,
      );
      return this.resolve(provider.id, model.id);
    } catch {
      // Routing must never break a request: fall back to the active
      // selection with the exact pre-routing behavior.
      return undefined;
    }
  }

  /** Resolve a specific provider+model pair, or undefined if ineligible. */
  private resolve(providerId: number, modelId: number): GatewaySelection | undefined {
    const provider = this.storage.getProvider(providerId);
    if (!provider || !provider.enabled) return undefined;
    const model = this.storage.getModel(modelId);
    if (!model || !model.enabled || model.providerId !== provider.id) return undefined;
    return {
      providerId: provider.id,
      providerLabel: provider.label,
      adapterType: provider.adapter,
      baseUrl: provider.baseUrl,
      modelId: model.modelId,
      modelLabel: model.label,
      allowLocal: provider.allowLocal,
    };
  }

  /**
   * Send one request to one candidate, rotating across its credentials.
   *
   * ROTATION POLICY (Phase E3):
   *
   * The attempt list is [primary credential, ...enabled pool credentials in
   * round-robin order]. Keys are tried in order until one answers.
   *
   *   - auth failure: THIS key is dead (revoked, rotated, or wrong on the
   *     service side), not the service. Mark it cooled-down for
   *     CREDENTIAL_COOLDOWN_MS and try the next key. The other keys are not
   *     punished for one key's failure.
   *   - network / timeout: the pipe is broken, the key is innocent. Advance
   *     to the next key WITHOUT a cooldown, so the key is tried again on the
   *     next request. The outer complete() loop may additionally fail over
   *     to another provider candidate on these classes.
   *   - invalid_response and everything else (quota, aborted, unknown):
   *     NEVER retried with another key. The response was already received
   *     (invalid_response) or the failure is not key-specific (quota is
   *     account-level, aborted is caller-cancelled). Rotating keys here
   *     would burn quota hiding a problem no key can fix, so the error is
   *     thrown immediately.
   *
   * Rotation is per-request and the primary key keeps its slot first: the
   * pool is a backup rail, not a replacement for the primary. A missing or
   * undecryptable primary fails closed exactly like before pools existed.
   *
   * Key material is decrypted per request, handed to the adapter, and dropped
   * when the call settles. Cooldowns and the round-robin cursor hold entry
   * ids and timestamps only — never keys.
   *
   * @throws AiError when no credential is usable or every key failed.
   */
  private async send(
    candidate: GatewaySelection,
    req: CompletionRequest,
    timeoutMs: number,
  ): Promise<CompletionResponse> {
    const attempts = this.keyAttempts(candidate.providerId);

    let lastError: AiError | undefined;
    for (const key of attempts) {
      try {
        return await this.attempt(candidate, req, timeoutMs, key.apiKey);
      } catch (err) {
        const mapped = this.mapError(err, "gateway");
        lastError = mapped;
        if (mapped.kind === "auth") {
          this.coolDown(key.id);
          continue;
        }
        if (mapped.kind === "network" || mapped.kind === "timeout") {
          // No cooldown: the key is fine, the transport failed. The next
          // request will try this key again.
          continue;
        }
        // invalid_response, quota, aborted, unknown: another key cannot fix
        // these, so they are never rotated through.
        throw mapped;
      }
    }

    throw lastError ?? new AiError("unknown", "Unknown service error.");
  }

  /**
   * Stream one request to one candidate, rotating across its credentials.
   *
   * Rotation follows send()'s policy, but ONLY before the first event: an
   * auth failure on a key that has not produced anything cools that key down
   * and tries the next; network/timeout advances without a cooldown. The
   * moment one event is yielded the stream is committed — a later error is
   * rethrown immediately with no rotation and no failover, because the
   * caller already showed partial text.
   */
  private async *sendStream(
    candidate: GatewaySelection,
    req: CompletionRequest,
    timeoutMs: number,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const attempts = this.keyAttempts(candidate.providerId);

    let lastError: AiError | undefined;
    for (const key of attempts) {
      let yielded = false;
      try {
        for await (const ev of this.attemptStream(candidate, req, timeoutMs, key.apiKey)) {
          yielded = true;
          yield ev;
        }
        return;
      } catch (err) {
        const mapped = this.mapError(err, "gateway");
        lastError = mapped;
        // Committed: the consumer already saw events, so no key rotation and
        // no failover — the partial stream is the caller's to handle.
        if (yielded) throw mapped;
        if (mapped.kind === "auth") {
          this.coolDown(key.id);
          continue;
        }
        if (mapped.kind === "network" || mapped.kind === "timeout") {
          continue;
        }
        throw mapped;
      }
    }

    throw lastError ?? new AiError("unknown", "Unknown service error.");
  }

  /**
   * One streaming attempt with one decrypted key against one candidate.
   *
   * Adapters with native streaming are consumed event by event; usage events
   * are reported to the usage listener exactly like attempt() reports them.
   * Adapters WITHOUT streaming get a synthesised stream from their
   * single-shot complete(), so every path through the gateway speaks the
   * StreamEvent contract.
   */
  private async *attemptStream(
    candidate: GatewaySelection,
    req: CompletionRequest,
    timeoutMs: number,
    apiKey: string,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const adapter = this.adapters.create(candidate.adapterType, {
      baseUrl: candidate.baseUrl,
      apiKey,
      model: candidate.modelId,
      ...(candidate.allowLocal !== undefined ? { allowLocalTargets: candidate.allowLocal } : {}),
      ...(this.settings !== undefined ? { settings: this.settings } : {}),
    });

    const request = {
      ...req,
      // The stored model always wins: a request cannot name another model.
      model: candidate.modelId,
      timeoutMs,
    };

    if (typeof adapter.completeStream !== "function") {
      // No native streaming: one shot, then a synthesised two-event stream.
      // The text goes out as a single delta so downstream throttling still
      // applies uniformly.
      const res = await adapter.complete(request);
      this.reportUsage(candidate, res.usage);
      if (res.text.length > 0) yield { type: "text", delta: res.text };
      yield {
        type: "end",
        text: res.text,
        model: res.model,
        toolCalls: res.toolCalls ?? [],
        ...(res.usage !== undefined ? { usage: res.usage } : {}),
      };
      return;
    }

    let sawEnd = false;
    for await (const ev of adapter.completeStream(request)) {
      if (ev.type === "usage") this.reportUsage(candidate, ev.usage);
      if (ev.type === "end") {
        sawEnd = true;
        if (ev.usage !== undefined) this.reportUsage(candidate, ev.usage);
      }
      yield ev;
    }
    if (!sawEnd) {
      // An adapter that ends its generator without the terminal event is
      // breaking the contract; synthesise it rather than hanging the caller
      // on a stream that never terminates.
      yield { type: "end", text: "", model: candidate.modelId, toolCalls: [] };
    }
  }

  /**
   * Report one attempt's token counts to the usage listener. Never throws:
   * usage is an observer, never load-bearing (same rule as attempt()).
   */
  private reportUsage(candidate: GatewaySelection, usage: TokenUsage | undefined): void {
    if (usage === undefined || this.onUsage === undefined) return;
    try {
      this.onUsage({
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        usage,
      });
    } catch {
      // Swallowed by design: accounting must not fail the user's request.
    }
  }

  /**
   * The ordered key attempts for one candidate: the primary credential
   * first, then the provider's enabled, non-cooled-down pool keys starting
   * at the round-robin cursor. Each entry's weight multiplies its slots in
   * the rotation order, so a weight-2 key is visited twice per cycle.
   *
   * Throws AiError("auth") when nothing is usable: no primary credential
   * (fail-closed, as before), or every key currently cooled down.
   */
  private keyAttempts(providerId: number): { id: string; apiKey: string }[] {
    const now = this.now();
    const live = (id: string): boolean => (this.cooldowns.get(id) ?? 0) <= now;
    const out: { id: string; apiKey: string }[] = [];

    const stored = this.storage.getCredential(providerId);
    if (!stored) {
      throw new AiError("auth", "This provider has no credential set.");
    }
    let primaryKey: string;
    try {
      primaryKey = this.secrets.decrypt(stored);
    } catch {
      throw new AiError("auth", "This provider’s credential could not be used.");
    }
    const primaryId = `p:${providerId}`;
    if (live(primaryId)) out.push({ id: primaryId, apiKey: primaryKey });

    const eligible = this.pool
      .decryptEnabledPool(providerId)
      .filter((e) => live(`pool:${e.entryId}`));
    const expanded: { id: string; apiKey: string }[] = [];
    for (const e of eligible) {
      const slots = Math.max(1, Math.floor(e.weight));
      for (let i = 0; i < slots; i++) {
        expanded.push({ id: `pool:${e.entryId}`, apiKey: e.apiKey });
      }
    }
    if (expanded.length > 0) {
      const start = this.storage.poolPosition(providerId, expanded.length);
      for (let i = 0; i < expanded.length; i++) {
        out.push(expanded[(start + i) % expanded.length]!);
      }
    }

    if (out.length === 0) {
      // Every key is cooled down after an auth failure; hammering any of
      // them would only burn the attempt budget on certain failure.
      throw new AiError(
        "auth",
        "All keys for this provider are temporarily set aside; try again shortly.",
      );
    }
    return out;
  }

  /** Mark a key cooled-down after an auth failure. Holds an id, never key material. */
  private coolDown(keyId: string): void {
    this.cooldowns.set(keyId, this.now() + AiGateway.CREDENTIAL_COOLDOWN_MS);
  }

  /**
   * Labels of pool keys currently cooled down for a provider, after an auth
   * failure. For the panel's provider screen (labels only, never key
   * material). In-memory: a restart clears it.
   *
   * A cooled-down key is deliberately NOT written into the provider's stored
   * health row: that row records the owner's manual connection probe, and one
   * dead key is not a dead provider (the others may be serving fine).
   */
  cooledDownPoolKeys(providerId: number): string[] {
    const now = this.now();
    return this.pool
      .listPoolEntries(providerId)
      .filter((e) => (this.cooldowns.get(`pool:${e.id}`) ?? 0) > now)
      .map((e) => e.label);
  }

  /**
   * One attempt with one decrypted key against one candidate.
   *
   * The credential is re-resolved and revalidated here rather than reused from
   * the plan, so a candidate whose key was removed since the plan was built is
   * refused instead of attempted.
   *
   * @throws AiError when the candidate is ineligible or the adapter fails.
   */
  private async attempt(
    candidate: GatewaySelection,
    req: CompletionRequest,
    timeoutMs: number,
    apiKey: string,
  ): Promise<CompletionResponse> {
    const adapter = this.adapters.create(candidate.adapterType, {
      baseUrl: candidate.baseUrl,
      apiKey,
      model: candidate.modelId,
      // Per-provider owner exception; undefined (the default) means local
      // targets stay refused.
      ...(candidate.allowLocal !== undefined ? { allowLocalTargets: candidate.allowLocal } : {}),
      ...(this.settings !== undefined ? { settings: this.settings } : {}),
    });

    try {
      const res = await adapter.complete({
        ...req,
        // The stored model always wins: a request cannot name another model.
        model: candidate.modelId,
        timeoutMs,
      });
      this.reportUsage(candidate, res.usage);
      return res;
    } finally {
      // Nothing references the key after this call; it goes out of scope here.
    }
  }
}

/**
 * Failures worth trying another provider for.
 *
 * A non-retryable class is one that another provider cannot fix:
 *   - auth / credential problems (the key or endpoint is wrong)
 *   - validation (the request itself was rejected)
 *   - configuration (the model or provider is not usable)
 *   - aborted (the caller cancelled; there is nothing to retry)
 *
 * Retrying an auth failure against a different service would spend that
 * service's quota to paper over a local misconfiguration, and would also risk
 * duplicating a request the first provider may already have acted on.
 */
function isRetryable(err: AiError): boolean {
  switch (err.kind) {
    case "network":
    case "timeout":
      return true;
    case "auth":
    case "quota":
    case "invalid_response":
    case "aborted":
    case "unknown":
      return false;
  }
}
