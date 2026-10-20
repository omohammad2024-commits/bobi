/**
 * Provider health service — a connection test the owner can run from the panel.
 *
 * The probe is deliberately cheap and self-contained: it asks the service for a
 * minimal completion (or, when the adapter supports it, its model list) and
 * records only the outcome. The result message is chosen by this module, never
 * copied from a provider response, so a body that echoes the request cannot
 * leak a key into the database or a Telegram message.
 */
import { AiError } from "./provider";
import type { AIProviderAdapter } from "./adapter";
import type { ProviderSecretStore } from "./secret_store";
import { AdapterRegistry } from "./adapter_registry";
import type { Storage } from "../storage/storage";
import type { ProviderService } from "./provider_service";

export interface ProbeResult {
  ok: boolean;
  /** Short, safe message. Never contains a key or a raw response. */
  message?: string;
  /** unix ms */
  checkedAt: number;
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
  ) {}

  /** Latest recorded outcome for a provider. */
  last(providerId: number): ProbeResult | undefined {
    const h = this.storage.getProviderHealth(providerId);
    if (!h) return undefined;
    return {
      ok: h.ok,
      checkedAt: h.checkedAt,
      ...(h.message !== undefined ? { message: h.message } : {}),
    };
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
      return this.result(false, "Provider not found.");
    }
    if (!provider.enabled) {
      return this.result(false, "Provider is disabled.");
    }
    if (
      this.storage.listModels(providerId).every((m) => m.modelId !== modelId)
    ) {
      return this.result(false, "Model not found for this provider.");
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.providers.credentialFor(providerId);
    } catch {
      return this.result(false, "Credential could not be decrypted.");
    }

    if (apiKey === undefined || apiKey.length === 0) {
      return this.result(false, "Credential is not set.");
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

      return this.result(true, "Connection succeeded.");
    } catch (err) {
      return this.result(false, probeMessage(err));
    }
  }

  /** The provider's default model id, when one is set and enabled. */
  private defaultModelId(providerId: number): string | undefined {
    const models = this.storage.listModels(providerId);
    return (models.find((m) => m.isDefault && m.enabled) ?? models.find((m) => m.enabled))?.modelId;
  }

  private record(providerId: number, ok: boolean, message: string): ProbeResult {
    const checkedAt = Date.now();
    this.storage.setProviderHealth({ providerId, ok, message });
    return { ok, message, checkedAt };
  }

  /**
   * A probe outcome that is reported only to the caller. Unlike record(),
   * this deliberately skips setProviderHealth — per-model tests must not
   * overwrite the provider-level health row.
   */
  private result(ok: boolean, message: string): ProbeResult {
    return { ok, message, checkedAt: Date.now() };
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
