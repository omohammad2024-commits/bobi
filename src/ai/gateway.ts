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
  }

  /**
   * Report a non-AiError that is about to be mapped to AiError("unknown").
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
      throw new AiError("invalid_response", "No active provider or model is set.");
    }

    const maxAttempts = plan.failover.enabled ? plan.failover.maxAttempts : 1;
    let lastError: AiError | undefined;

    for (const candidate of plan.candidates) {
      // The attempt budget is per request, across all candidates, so a long
      // candidate list can never turn into an unbounded loop.
      if (usedAttempts(plan.candidates, candidate) >= maxAttempts) break;

      try {
        const res = await this.send(candidate, req, this.attemptTimeout(req, plan));
        // Report the model that actually answered, as the engine expects.
        return { text: res.text, model: res.model };
      } catch (err) {
        const mapped =
          err instanceof AiError
            ? err
            : (this.reportUnknown(err, "gateway"), new AiError("unknown", "Unknown service error."));
        lastError = mapped;
        // Only a retryable class advances to the next candidate. An auth,
        // validation, or configuration failure must NOT be retried through
        // another provider: it would hide the misconfiguration and could
        // duplicate a non-idempotent request that already went out.
        if (!isRetryable(mapped)) throw mapped;
      }
    }

    throw lastError ?? new AiError("unknown", "Unknown service error.");
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
    const plan = this.plan();

    if (plan.candidates.length === 0) {
      throw new AiError("invalid_response", "No active provider or model is set.");
    }

    const maxAttempts = plan.failover.enabled ? plan.failover.maxAttempts : 1;
    let lastError: AiError | undefined;

    for (const candidate of plan.candidates) {
      if (usedAttempts(plan.candidates, candidate) >= maxAttempts) break;

      let yielded = false;
      try {
        for await (const ev of this.sendStream(candidate, req, this.attemptTimeout(req, plan))) {
          yielded = true;
          yield ev;
        }
        return;
      } catch (err) {
        const mapped =
          err instanceof AiError
            ? err
            : (this.reportUnknown(err, "gateway"), new AiError("unknown", "Unknown service error."));
        lastError = mapped;
        // Committed: the consumer already saw events, so failing over to
        // another candidate would DUPLICATE text the user already read.
        // The partial stream is the caller's to handle.
        if (yielded) throw mapped;
        // Same rule as complete(): only a retryable class advances.
        if (!isRetryable(mapped)) throw mapped;
      }
    }

    throw lastError ?? new AiError("unknown", "Unknown service error.");
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
    const res = await this.send(candidate, req, req.timeoutMs);
    return { text: res.text, model: res.model };
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
        const mapped =
          err instanceof AiError
            ? err
            : (this.reportUnknown(err, "gateway"), new AiError("unknown", "Unknown service error."));
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
        const mapped =
          err instanceof AiError
            ? err
            : (this.reportUnknown(err, "gateway"), new AiError("unknown", "Unknown service error."));
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
