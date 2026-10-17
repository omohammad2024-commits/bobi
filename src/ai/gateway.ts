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
 *
 * `name` is "ai" so the engine's isFake check stays accurate: the gateway is a
 * real provider, unlike the offline FakeProvider used in tests.
 */
import { AiError } from "./provider";
import type { AiProvider, CompletionRequest, CompletionResponse } from "./provider";
import type { AdapterRegistry } from "./adapter_registry";
import type { ProviderSecretStore } from "./secret_store";
import type { Storage } from "../storage/storage";

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
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
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

  constructor(opts: GatewayOptions) {
    this.storage = opts.storage;
    this.adapters = opts.adapters;
    this.secrets = opts.secrets;
    this.settings = opts.settings;
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
   * Complete a request through the active provider and model.
   *
   * @throws AiError with a user-safe message when no valid selection exists,
   * the credential is missing or undecryptable, or the adapter fails.
   */
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // Snapshot: read the selection once, at the start of the request. Every
    // candidate in this request is drawn from that one consistent snapshot, so
    // a configuration change mid-flight cannot mix two different settings.
    const plan = this.plan();

    if (plan.candidates.length === 0) {
      throw new AiError("invalid_response", "پروایدر یا مدل فعالی تنظیم نشده است.");
    }

    const maxAttempts = plan.failover.enabled ? plan.failover.maxAttempts : 1;
    let lastError: AiError | undefined;

    for (const candidate of plan.candidates) {
      // The attempt budget is per request, across all candidates, so a long
      // candidate list can never turn into an unbounded loop.
      if (usedAttempts(plan.candidates, candidate) >= maxAttempts) break;

      try {
        const res = await this.send(candidate, req, plan.timeoutMs);
        // Report the model that actually answered, as the engine expects.
        return { text: res.text, model: res.model };
      } catch (err) {
        const mapped = err instanceof AiError ? err : new AiError("unknown", "خطای ناشناخته سرویس.");
        lastError = mapped;
        // Only a retryable class advances to the next candidate. An auth,
        // validation, or configuration failure must NOT be retried through
        // another provider: it would hide the misconfiguration and could
        // duplicate a non-idempotent request that already went out.
        if (!isRetryable(mapped)) throw mapped;
      }
    }

    throw lastError ?? new AiError("unknown", "خطای ناشناخته سرویس.");
  }

  /**
   * Resolve the ordered candidate list and the failover policy, as one
   * consistent snapshot for this request.
   */
  private plan(): {
    candidates: GatewaySelection[];
    failover: { enabled: boolean; maxAttempts: number; timeoutMs: number };
    timeoutMs: number;
  } {
    const settings = this.storage.getFailoverSettings();
    const primary = this.currentSelection();
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

    return {
      candidates,
      failover: settings,
      timeoutMs: settings.timeoutMs,
    };
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
   * Send one request to one candidate.
   *
   * The credential is re-resolved and revalidated here rather than reused from
   * the plan, so a candidate whose key was removed since the plan was built is
   * refused instead of attempted.
   *
   * @throws AiError when the candidate is ineligible or the adapter fails.
   */
  private async send(
    candidate: GatewaySelection,
    req: CompletionRequest,
    timeoutMs: number,
  ): Promise<CompletionResponse> {
    const stored = this.storage.getCredential(candidate.providerId);
    if (!stored) {
      throw new AiError("auth", "اعتبارنامهٔ این پروایدر تنظیم نشده است.");
    }
    let apiKey: string;
    try {
      apiKey = this.secrets.decrypt(stored);
    } catch {
      throw new AiError("auth", "اعتبارنامهٔ این پروایدر قابل استفاده نبود.");
    }

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
      return await adapter.complete({
        ...req,
        // The stored model always wins: a request cannot name another model.
        model: candidate.modelId,
        timeoutMs,
      });
    } finally {
      // Nothing references the key after this call; it goes out of scope here.
    }
  }
}

/**
 * How many attempts precede this candidate in the plan.
 * Used to enforce the bounded attempt budget without counting again.
 */
function usedAttempts(
  candidates: readonly GatewaySelection[],
  current: GatewaySelection,
): number {
  return candidates.indexOf(current);
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
