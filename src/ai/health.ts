/**
 * Provider health service — a connection test the owner can run from the panel.
 *
 * The probe is deliberately cheap and self-contained: it asks the service for a
 * minimal completion (or, when the adapter supports it, its model list) and
 * records only the outcome. The result message is chosen by this module, never
 * copied from a provider response, so a body that echoes the request cannot
 * leak a key into the database or a Telegram message.
 *
 * The service also hosts the opt-in BACKGROUND prober (startBackgroundProbes):
 * a periodic pass that re-probes providers whose circuit breaker is open or
 * whose last probe failed, and records recovery into the shared breaker
 * registry so a healed provider returns to rotation without waiting for a
 * user turn to discover it.
 */
import { AiError } from "./provider";
import type { AIProviderAdapter } from "./adapter";
import type { ProviderSecretStore } from "./secret_store";
import { AdapterRegistry } from "./adapter_registry";
import type { Storage } from "../storage/storage";
import type { ProviderService } from "./provider_service";
import type { CircuitStateReader, CircuitStateView } from "./circuit_breaker";
import {
  connectionManagerEnabled,
  type ConnectionStatsView,
} from "./connection_manager";

export interface ProbeResult {
  ok: boolean;
  /** Short, safe message. Never contains a key or a raw response. */
  message?: string;
  /** unix ms */
  checkedAt: number;
  /**
   * The gateway's circuit-breaker snapshot for this provider, when a
   * breaker source was injected (the constructor's trailing optional).
   * The probe never consults the breaker — its whole job is to test the
   * provider directly — this is read-only observability for the panel.
   */
  circuit?: CircuitStateView;
  /**
   * Connection-layer stats for this provider's host, when a connection
   * stats source was injected and the host has pooled-connection history.
   * Additive and sparse — absent entirely when there is nothing to report
   * (same pattern as the memory recall telemetry fields).
   */
  connection?: ConnectionStatsView;
}

/**
 * Read-only connection-stats source for the `connection` probe field.
 * The connection manager satisfies this structurally.
 */
export interface ConnectionStatsSource {
  statsForUrl(baseUrl: string, allowLocalTargets: boolean): ConnectionStatsView | undefined;
}

/**
 * A breaker the background prober may DRIVE on recovery. The registry from
 * the reliability core satisfies this; the prober never writes a second
 * breaker — on a successful recovery probe it records the success into
 * the shared registry, whose own semantics close/half-open the breaker.
 */
export interface BreakerDriver extends CircuitStateReader {
  recordSuccess(providerId: number): void;
}

/** Env var for the background probe interval, ms. Default 60000; 0 = off. */
export const HEALTH_PROBE_MS_ENV_VAR = "BOBI_HEALTH_PROBE_MS";

/** Background probe interval, ms. 0 disables; invalid → the 60s default. */
export function healthProbeIntervalMs(): number {
  const raw = process.env[HEALTH_PROBE_MS_ENV_VAR];
  if (raw === undefined) return 60_000;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

export interface ProbeOptions {
  /** Override the timeout for this probe only. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class ProviderHealthService {
  constructor(
    private readonly storage: Storage,
    private readonly providers: ProviderService,
    private readonly secrets: ProviderSecretStore,
    private readonly adapters: AdapterRegistry = new AdapterRegistry(),
    /** Overridable for tests that must not wait on a real deadline. */
    private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
    /**
     * Optional breaker-state reader (the gateway's shared registry).
     * Populates `circuit` on results for panel observability. Trailing
     * optional, so existing constructions keep working unchanged.
     */
    private readonly circuitSource?: CircuitStateReader,
    /**
     * Optional connection-stats source (the connection manager).
     * Populates `connection` on results when the provider's host has
     * pooled-connection history. Trailing optional, like circuitSource.
     */
    private readonly connections?: ConnectionStatsSource,
  ) {}

  /** Latest recorded outcome for a provider. */
  last(providerId: number): ProbeResult | undefined {
    const h = this.storage.getProviderHealth(providerId);
    if (!h) return undefined;
    return {
      ok: h.ok,
      checkedAt: h.checkedAt,
      ...(h.message !== undefined ? { message: h.message } : {}),
      ...this.circuitField(providerId),
      ...this.connectionField(providerId),
    };
  }

  /** The breaker snapshot spread, when a source was injected. */
  private circuitField(providerId: number): { circuit?: CircuitStateView } {
    if (this.circuitSource === undefined) return {};
    try {
      return { circuit: this.circuitSource.state(providerId) };
    } catch {
      return {};
    }
  }

  /** The connection-stats spread, when a source was injected and has data. */
  private connectionField(providerId: number): { connection?: ConnectionStatsView } {
    if (this.connections === undefined) return {};
    try {
      const provider = this.storage.getProvider(providerId);
      if (provider === undefined) return {};
      const view = this.connections.statsForUrl(provider.baseUrl, provider.allowLocal);
      return view !== undefined ? { connection: view } : {};
    } catch {
      return {};
    }
  }

  /**
   * Probe a provider and record the result.
   *
   * A missing credential is a configuration failure, reported as such; it is
   * never worked around by sending an unauthenticated request.
   */
  async probe(providerId: number, opts: ProbeOptions = {}): Promise<ProbeResult> {
    const provider = this.storage.getProvider(providerId);
    if (!provider) {
      return this.record(providerId, false, "Provider not found.");
    }
    if (!provider.enabled) {
      return this.record(providerId, false, "Provider is disabled.");
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.providers.credentialFor(providerId);
    } catch {
      return this.record(providerId, false, "Credential could not be decrypted.");
    }

    if (apiKey === undefined || apiKey.length === 0) {
      return this.record(providerId, false, "Credential is not set.");
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    // The adapter owns the request timeout: it aborts at its own deadline and
    // reports AiError("timeout"). A second, racing timer here would abort the
    // caller signal first, and the adapter would then report "aborted" instead
    // of a timeout — hiding a slow service behind a wrong diagnosis. So the
    // health service supplies a signal it never fires.
    const neverAborted = new AbortController().signal;

    try {
      const adapter = this.adapters.create(provider.adapter, {
        baseUrl: provider.baseUrl,
        apiKey,
        // The probe needs a model id that exists; prefer the provider's default.
        model: this.defaultModelId(providerId) ?? "probe",
        // The owner may have granted this provider the local-target exception;
        // the probe must honor the same boundary as the runtime, or a local
        // provider would always report "unreachable" right after being allowed.
        ...(provider.allowLocal ? { allowLocalTargets: true } : {}),
      });

      // Always verify with a real completion on the provider's default model.
      // listModels only checks API reachability — a provider can list models
      // fine while the specific model is rate-limited, disabled, or broken.
      // The completion test catches those cases.
      await adapter.complete({
        messages: [{ role: "user", content: "ping" }],
        model: this.defaultModelId(providerId) ?? "default",
        // A probe only needs ANY answer back; capping generation keeps it
        // fast (and cheap) instead of waiting for a full-length reply.
        maxTokens: 16,
        timeoutMs,
        signal: neverAborted,
      });

      return this.record(providerId, true, "Connection succeeded.");
    } catch (err) {
      return this.record(providerId, false, probeMessage(err));
    }
  }

  /**
   * Probe ONE specific model with a real completion, without recording
   * provider health. Used by the per-model "Test" button in the panel.
   *
   * A model test is deliberately NOT provider health: it never touches
   * storage.setProviderHealth, so testing an individual model cannot
   * overwrite the provider-level outcome. A flaky model gets reported
   * inline; the provider row keeps its own status.
   */
  async probeModel(
    providerId: number,
    modelId: string,
    opts: ProbeOptions = {},
  ): Promise<ProbeResult> {
    const provider = this.storage.getProvider(providerId);
    if (!provider) {
      return this.result(providerId, false, "Provider not found.");
    }
    if (!provider.enabled) {
      return this.result(providerId, false, "Provider is disabled.");
    }
    if (
      this.storage.listModels(providerId).every((m) => m.modelId !== modelId)
    ) {
      return this.result(providerId, false, "Model not found for this provider.");
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.providers.credentialFor(providerId);
    } catch {
      return this.result(providerId, false, "Credential could not be decrypted.");
    }

    if (apiKey === undefined || apiKey.length === 0) {
      return this.result(providerId, false, "Credential is not set.");
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    // Same reasoning as probe(): the health service supplies a signal it
    // never fires, so the adapter reports its own timeout diagnosis.
    const neverAborted = new AbortController().signal;

    try {
      const adapter = this.adapters.create(provider.adapter, {
        baseUrl: provider.baseUrl,
        apiKey,
        model: modelId,
        ...(provider.allowLocal ? { allowLocalTargets: true } : {}),
      });

      await adapter.complete({
        messages: [{ role: "user", content: "ping" }],
        model: modelId,
        // Same cap as probe(): the test needs any answer, fast.
        maxTokens: 16,
        timeoutMs,
        signal: neverAborted,
      });

      return this.result(providerId, true, "Connection succeeded.");
    } catch (err) {
      return this.result(providerId, false, probeMessage(err));
    }
  }

  /* ---------------- background health + auto-recovery ---------------- */

  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private probePassInFlight = false;

  /** True while the background prober is scheduled. */
  backgroundProbesRunning(): boolean {
    return this.probeTimer !== undefined;
  }

  /**
   * Start the periodic background prober.
   *
   * Every BOBI_HEALTH_PROBE_MS (default 60000; 0 = off) one pass probes the
   * configured providers that need attention — breaker OPEN (or half-open)
   * or last recorded probe failed — using the same cheap probe() the panel
   * runs. A pass never overlaps itself: a slow provider cannot stack
   * passes up. Recovery is driven through the SHARED breaker registry
   * passed as `driver`: a successful probe of an open/half-open provider
   * records a success there, and the registry's own semantics close the
   * breaker. A failed probe records nothing into the breaker — probe
   * failures include configuration faults (auth, missing credential) that
   * must never trip it; the gateway's real traffic keeps it honest.
   *
   * Opt-in by construction: nothing runs until start is called. Also a
   * no-op when the connection manager is disabled (BOBI_CONN_MANAGER=0)
   * or the interval is 0. The timer is unref'd.
   */
  startBackgroundProbes(driver?: BreakerDriver, opts: { intervalMs?: number } = {}): void {
    if (this.probeTimer !== undefined) return;
    if (!connectionManagerEnabled()) return;
    const intervalMs = opts.intervalMs ?? healthProbeIntervalMs();
    if (intervalMs <= 0) return;
    this.probeTimer = setInterval(() => {
      void this.runBackgroundProbePass(driver);
    }, intervalMs);
    // Probing must never keep a process (or a test run) alive.
    this.probeTimer.unref?.();
  }

  /** Stop the background prober. An in-flight pass finishes on its own. */
  stopBackgroundProbes(): void {
    if (this.probeTimer !== undefined) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  /**
   * One background probe pass. Public so tests (and a future manual
   * "recheck now" surface) can drive it without waiting on the timer.
   * Returns how many providers were probed.
   */
  async runBackgroundProbePass(driver?: BreakerDriver): Promise<number> {
    if (this.probePassInFlight) return 0;
    this.probePassInFlight = true;
    let probed = 0;
    try {
      for (const provider of this.storage.listProviders()) {
        if (!provider.enabled) continue;
        const breakerState =
          driver?.state(provider.id).state ?? this.circuitSource?.state(provider.id).state;
        const breakerNeedsRecovery = breakerState === "open" || breakerState === "half_open";
        const lastFailed = this.storage.getProviderHealth(provider.id)?.ok === false;
        if (!breakerNeedsRecovery && !lastFailed) continue;
        const res = await this.probe(provider.id);
        probed += 1;
        if (res.ok && breakerNeedsRecovery && driver !== undefined) {
          // Recovery, recorded into the shared registry — its semantics
          // close the breaker; no second breaker exists to disagree.
          driver.recordSuccess(provider.id);
        }
      }
    } catch {
      // A background pass must never throw into the timer or the caller:
      // individual probe failures are already recorded as health rows.
    } finally {
      this.probePassInFlight = false;
    }
    return probed;
  }

  /** The provider's default model id, when one is set and enabled. */
  private defaultModelId(providerId: number): string | undefined {
    const models = this.storage.listModels(providerId);
    return (models.find((m) => m.isDefault && m.enabled) ?? models.find((m) => m.enabled))?.modelId;
  }

  private record(providerId: number, ok: boolean, message: string): ProbeResult {
    const checkedAt = Date.now();
    this.storage.setProviderHealth({ providerId, ok, message });
    return { ok, message, checkedAt, ...this.circuitField(providerId), ...this.connectionField(providerId) };
  }

  /**
   * A probe outcome that is reported only to the caller. Unlike record(),
   * this deliberately skips setProviderHealth — per-model tests must not
   * overwrite the provider-level health row.
   */
  private result(providerId: number, ok: boolean, message: string): ProbeResult {
    return { ok, message, checkedAt: Date.now(), ...this.circuitField(providerId), ...this.connectionField(providerId) };
  }
}

/**
 * Map an adapter failure onto a short, safe English message.
 *
 * Messages are chosen here, never copied from a provider response. One
 * narrow exception, by design: an "unknown" AiError that carries an HTTP
 * status surfaces its own message, because that status could only have
 * been attached by the status mapper, whose templates are fixed strings
 * naming the real cause (e.g. "Unexpected provider response (HTTP 302).").
 * An unknown with no status has no such provenance and stays opaque:
 * "Probe failed."
 */
function probeMessage(err: unknown): string {
  if (err instanceof AiError) {
    if (
      err.kind === "unknown" &&
      err.status !== undefined &&
      err.message.trim().length > 0
    ) {
      return err.message;
    }
    switch (err.kind) {
      case "auth":
        return "Key or address was not accepted.";
      case "quota":
        // 402 is balance exhaustion, not a rate limit — say so (a fixed
        // string keyed by the status number; the error's own message is
        // NOT surfaced for this kind).
        return err.status === 402
          ? "Provider balance or quota is exhausted (HTTP 402)."
          : "Service rate limit is full.";
      case "timeout":
        return "No response arrived in time.";
      case "aborted":
        return "Probe was cancelled.";
      case "network":
        return "Could not connect.";
      case "invalid_response":
        return "Service response was invalid.";
      default:
        return "Probe failed.";
    }
  }
  return "Probe failed.";
}
