/**
 * Provider and model services — configuration validation and lifecycle.
 *
 * Everything here works on values that already passed validation, so the SQL
 * layer never sees a hostile string. Credential handling is delegated to the
 * ProviderSecretStore: this module stores an envelope and reports only whether
 * a key is set, never its contents.
 */
import { ProviderSecretStore, SecretStoreError, CredentialPoolStore } from "./secret_store";
import { AdapterRegistry } from "./adapter_registry";
import { isAdapterType } from "./adapter";
import type { Storage, AiModelRow } from "../storage/storage";

const MAX_LABEL = 64;
const MAX_MODEL_ID = 128;

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; message: string };

function fail<T>(message: string, reason = "invalid"): ServiceResult<T> {
  return { ok: false, reason, message };
}

/** A pool credential as the panel sees it. Labels only — never key material. */
export interface PoolKeyView {
  id: number;
  providerId: number;
  /** Owner-chosen display label, e.g. "backup-1". */
  label: string;
  /** Load-sharing multiplier inside the round-robin order. */
  weight: number;
  enabled: boolean;
  /** unix ms */
  createdAtMs: number;
}

/** A provider as the panel sees it. No credential material at all. */
export interface ProviderView {  id: number;
  label: string;
  adapter: string;
  adapterLabel: string;
  baseUrl: string;
  enabled: boolean;
  /** Owner-set exception allowing a loopback/private target for this provider. */
  allowLocal: boolean;
  hasCredential: boolean;
  modelCount: number;
  /** Number of pool (backup) credentials stored for this provider. */
  poolKeyCount: number;
  /** Adapter-declared ability to list models. */
  canListModels: boolean;
  /** True when this provider is the live runtime selection. */
  isActive: boolean;
  lastTestOk?: boolean;
  lastTestAt?: number;
  lastTestMessage?: string;
}

export class ProviderService {
  private readonly pool: CredentialPoolStore;

  constructor(
    private readonly storage: Storage,
    private readonly secrets: ProviderSecretStore,
    private readonly adapters: AdapterRegistry,
  ) {
    this.pool = new CredentialPoolStore(storage, secrets);
  }

  /**
   * True when this provider is the active runtime selection.
   *
   * Callers use this to refuse changes that would break a live selection:
   * editing the endpoint of the provider that is answering requests, or
   * disabling it, would leave the runtime pointing at something unusable.
   */
  isActive(id: number): boolean {
    return this.storage.getRuntimeSettings().activeProviderId === id;
  }

  /**
   * Self-healing selection: when nothing valid is currently selected (fresh
   * install, deleted/disabled provider, missing credential), automatically
   * select the first usable provider — enabled, with a stored credential and
   * at least one enabled model — and its default (or first) model.
   *
   * This is what makes "add provider → it just works" true: the add flows
   * call this after creating the provider and its models, and boot calls it
   * so a configured-but-unselected provider is picked up without a restart
   * dance. Explicit when it matters: an existing valid selection is never
   * overridden. Returns the active pair, or undefined when nothing usable
   * exists.
   */
  ensureSelection(): { providerId: number; modelId: number } | undefined {
    const settings = this.storage.getRuntimeSettings();
    if (settings.activeProviderId !== null && settings.activeModelId !== null) {
      const p = this.storage.getProvider(settings.activeProviderId);
      const m =
        settings.activeModelId !== null ? this.storage.getModel(settings.activeModelId) : undefined;
      if (
        p !== undefined &&
        p.enabled &&
        m !== undefined &&
        m.enabled &&
        m.providerId === p.id
      ) {
        try {
          if (this.storage.hasCredential(p.id)) {
            return { providerId: p.id, modelId: m.id };
          }
        } catch {
          // Fall through to auto-select below.
        }
      }
    }
    let providers: { id: number; enabled: boolean }[];
    try {
      providers = this.storage.listProviders();
    } catch {
      return undefined;
    }
    for (const p of providers) {
      if (!p.enabled) continue;
      let hasCredential = false;
      try {
        hasCredential = this.storage.hasCredential(p.id);
      } catch {
        continue;
      }
      if (!hasCredential) continue;
      let models: { id: number; enabled: boolean; isDefault: boolean }[];
      try {
        models = this.storage.listModels(p.id);
      } catch {
        continue;
      }
      const enabled = models.filter((m) => m.enabled);
      if (enabled.length === 0) continue;
      const chosen = enabled.find((m) => m.isDefault) ?? enabled[0];
      if (!chosen) continue;
      try {
        this.storage.setRuntimeSelection({ providerId: p.id, modelId: chosen.id });
      } catch {
        continue;
      }
      return { providerId: p.id, modelId: chosen.id };
    }
    return undefined;
  }

  /** Providers for the panel, newest first. */
  listViews(): ProviderView[] {    const adapters = new AdapterRegistry();
    return this.storage.listProviders().map((p) => {
      const health = this.storage.getProviderHealth(p.id);
      const info = adapters.describes(p.adapter);
      return {
        id: p.id,
        label: p.label,
        adapter: p.adapter,
        adapterLabel: info.label,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        allowLocal: p.allowLocal,
        hasCredential: this.storage.hasCredential(p.id),
        modelCount: this.storage.listModels(p.id).length,
        poolKeyCount: this.storage.listPoolCredentials(p.id).length,
        canListModels: info.listModels,
        // Marks the live selection so the panel can explain why an edit is refused.
        isActive: this.isActive(p.id),
        ...(health !== undefined ? { lastTestOk: health.ok, lastTestAt: health.checkedAt, ...(health.message !== undefined ? { lastTestMessage: health.message } : {}) } : {}),
      };
    });
  }

  /** One provider for the panel. */
  view(id: number): ProviderView | undefined {
    return this.listViews().find((p) => p.id === id);
  }

  /**
   * Create a provider, and optionally store its key.
   *
   * A key that cannot be encrypted fails the whole operation, so a provider is
   * never created pointing at a credential that was silently dropped.
   */
  create(input: {
    label: string;
    adapter: string;
    baseUrl: string;
    apiKey?: string;
    allowLocal?: boolean;
  }): ServiceResult<number> {
    const label = input.label.trim();
    if (label.length === 0) return fail("A display name is required.");
    if (label.length > MAX_LABEL) return fail("Display name is too long.");
    if (!isAdapterType(input.adapter)) return fail("Invalid connection type.");
    if (input.baseUrl.trim().length === 0) return fail("Service address is required.");

    let credential: { iv: string; ciphertext: string; tag: string } | undefined;
    if (input.apiKey !== undefined && input.apiKey.trim().length > 0) {
      try {
        credential = this.secrets.encrypt(input.apiKey.trim());
      } catch (err) {
        if (err instanceof SecretStoreError && err.kind === "missing_key") {
          return fail(err.message, "missing_key");
        }
        return fail("The provided key was not valid.");
      }
    }

    const id = this.storage.createProvider({
      label,
      adapter: input.adapter,
      baseUrl: input.baseUrl.trim(),
      ...(input.allowLocal !== undefined ? { allowLocal: input.allowLocal } : {}),
    });
    if (credential) {
      this.storage.upsertCredential({ providerId: id, ...credential });
    }
    return { ok: true, data: id };
  }

  /**
   * Edit a provider's editable fields; a key is replaced only if supplied.
   *
   * Changing the endpoint or adapter type of the ACTIVE provider is refused:
   * an in-flight selection would then name a target that may not answer the
   * same wire format, and the owner would only see it as a generic failure.
   * Credentials may always be replaced, since that fixes rather than breaks
   * the active provider.
   */
  update(
    id: number,
    patch: {
      label?: string;
      baseUrl?: string;
      adapter?: string;
      apiKey?: string;
      allowLocal?: boolean;
    },
  ): ServiceResult<true> {
    const existing = this.storage.getProvider(id);
    if (!existing) return fail("Provider not found.", "not_found");

    const active = this.isActive(id);
    const changesEndpoint =
      (patch.baseUrl !== undefined && patch.baseUrl.trim() !== existing.baseUrl) ||
      (patch.adapter !== undefined && patch.adapter !== existing.adapter);

    if (active && changesEndpoint) {
      return fail(
        "This provider is active; activate another provider first to change its address or connection type.",
        "in_use",
      );
    }

    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (label.length === 0) return fail("A display name is required.");
      if (label.length > MAX_LABEL) return fail("Display name is too long.");
      this.storage.updateProvider(id, { label });
    }
    if (patch.adapter !== undefined) {
      if (!isAdapterType(patch.adapter)) return fail("Invalid connection type.");
      this.storage.updateProvider(id, { adapter: patch.adapter });
    }
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl.trim().length === 0) return fail("Service address is required.");
      this.storage.updateProvider(id, { baseUrl: patch.baseUrl.trim() });
    }
    if (patch.apiKey !== undefined && patch.apiKey.trim().length > 0) {
      try {
        const enc = this.secrets.encrypt(patch.apiKey.trim());
        this.storage.upsertCredential({ providerId: id, ...enc });
      } catch (err) {
        if (err instanceof SecretStoreError && err.kind === "missing_key") {
          return fail(err.message, "missing_key");
        }
        return fail("The provided key was not valid.");
      }
    }
    if (patch.allowLocal !== undefined) {
      this.storage.updateProvider(id, { allowLocal: patch.allowLocal });
    }
    return { ok: true, data: true };
  }

  /**
   * Turn the per-provider local-target exception on or off.
   *
   * This is the only route to a loopback/private endpoint. It is deliberately a
   * separate method rather than a flag folded into `update`, so the UI can
   * confirm it explicitly and the audit trail names the operation.
   */
  setAllowLocal(id: number, allow: boolean): ServiceResult<true> {
    if (!this.storage.getProvider(id)) return fail("Provider not found.", "not_found");
    this.storage.setProviderAllowLocal(id, allow);
    return { ok: true, data: true };
  }

  /**
   * Enable or disable a provider.
   *
   * Disabling the active provider would leave the runtime without a selection,
   * so it is refused until another provider is activated.
   */
  setEnabled(id: number, enabled: boolean): ServiceResult<true> {
    if (!this.storage.getProvider(id)) return fail("Provider not found.", "not_found");
    if (!enabled && this.isActive(id)) {
      return fail(
        "This provider is active; activate another provider first to disable it.",
        "in_use",
      );
    }
    this.storage.setProviderEnabled(id, enabled);
    return { ok: true, data: true };
  }

  /** Remove a stored credential. */
  clearCredential(id: number): ServiceResult<true> {
    if (!this.storage.getProvider(id)) return fail("Provider not found.", "not_found");
    this.storage.deleteCredential(id);
    return { ok: true, data: true };
  }

  /** Whether a credential is set. Never returns the key itself. */
  credentialStatus(id: number): "set" | "unset" | "not_found" {
    if (!this.storage.getProvider(id)) return "not_found";
    return this.storage.hasCredential(id) ? "set" : "unset";
  }

  /**
   * Add a pool (backup) credential to a provider.
   *
   * The provider must exist. The key is encrypted before it reaches storage;
   * with no master key configured the whole operation fails closed with the
   * actionable missing-key message, exactly like the primary credential.
   * Returns the pool entry id.
   */
  addPoolKey(providerId: number, label: string, apiKey: string): ServiceResult<number> {
    if (!this.storage.getProvider(providerId)) return fail("Provider not found.", "not_found");
    const cleanLabel = label.trim();
    if (cleanLabel.length === 0) return fail("A display name for the backup key is required.");
    if (cleanLabel.length > MAX_LABEL) return fail("Backup key display name is too long.");
    if (apiKey.trim().length === 0) return fail("The provided key was not valid.");
    try {
      const id = this.pool.savePoolCredential(providerId, cleanLabel, apiKey.trim());
      return { ok: true, data: id };
    } catch (err) {
      if (err instanceof SecretStoreError && err.kind === "missing_key") {
        return fail(err.message, "missing_key");
      }
      return fail("The provided key was not valid.");
    }
  }

  /**
   * Pool credentials of a provider for the panel.
   * Labels, flags, and counts only — NEVER key material.
   */
  listPoolKeys(providerId: number): PoolKeyView[] {
    if (!this.storage.getProvider(providerId)) return [];
    return this.pool.listPoolEntries(providerId);
  }

  /** Remove a pool credential. The containment path for a compromised key. */
  removePoolKey(id: number): ServiceResult<true> {
    if (!this.pool.removePoolEntry(id)) return fail("Backup key not found.", "not_found");
    return { ok: true, data: true };
  }

  /** Enable or disable a pool credential. */
  setPoolKeyEnabled(id: number, enabled: boolean): ServiceResult<true> {
    if (!this.pool.setPoolEntryEnabled(id, enabled)) {
      return fail("Backup key not found.", "not_found");
    }
    return { ok: true, data: true };
  }

  /**
   * Decrypt a credential for use in a single request.
   * Throws SecretStoreError when the key is missing or decryption fails.
   */
  credentialFor(id: number): string | undefined {
    const stored = this.storage.getCredential(id);
    if (!stored) return undefined;
    return this.secrets.decrypt(stored);
  }

  /**
   * Delete a provider.
   *
   * Refuses the active provider so a live selection is never orphaned.
   */
  remove(id: number): ServiceResult<true> {
    if (!this.storage.getProvider(id)) return fail("Provider not found.", "not_found");
    if (!this.storage.deleteProvider(id)) {
      return fail(
        "This provider is in use; switch the active provider first.",
        "in_use",
      );
    }
    return { ok: true, data: true };
  }
}

/** A model as the panel sees it. */
export interface ModelView {
  id: number;
  providerId: number;
  modelId: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
}

export class ModelService {
  constructor(private readonly storage: Storage) {}

  /** True when this model is the active runtime selection. */
  isActive(id: number): boolean {
    return this.storage.getRuntimeSettings().activeModelId === id;
  }

  /** Models of a provider, newest first. */
  list(providerId: number): ModelView[] {
    return this.storage.listModels(providerId).map((m) => ({
      id: m.id,
      providerId: m.providerId,
      modelId: m.modelId,
      label: m.label,
      enabled: m.enabled,
      isDefault: m.isDefault,
    }));
  }

  /** One model, or undefined. */
  get(id: number): ModelView | undefined {
    const m = this.storage.getModel(id);
    if (!m) return undefined;
    return {
      id: m.id,
      providerId: m.providerId,
      modelId: m.modelId,
      label: m.label,
      enabled: m.enabled,
      isDefault: m.isDefault,
    };
  }

  /**
   * Add a model.
   *
   * `modelId` and `label` are separate fields: the id is the exact string the
   * service expects, while the label is display text. A duplicate (provider,
   * model_id) is refused so the panel cannot create ambiguous entries.
   */
  add(input: { providerId: number; modelId: string; label: string }): ServiceResult<number> {
    const modelId = input.modelId.trim();
    const label = input.label.trim();
    if (modelId.length === 0) return fail("Model ID is required.");
    if (modelId.length > MAX_MODEL_ID) return fail("Model ID is too long.");
    if (label.length === 0) return fail("A display name for the model is required.");
    if (label.length > MAX_LABEL) return fail("Model display name is too long.");

    if (this.storage.listModels(input.providerId).some((m) => m.modelId === modelId)) {
      return fail("This model ID is already registered for this provider.", "duplicate");
    }
    try {
      const id = this.storage.createModel({ providerId: input.providerId, modelId, label });
      return { ok: true, data: id };
    } catch {
      return fail("Adding the model failed.");
    }
  }

  /** Rename a model's display label. */
  rename(id: number, label: string): ServiceResult<true> {
    const trimmed = label.trim();
    if (trimmed.length === 0) return fail("A display name for the model is required.");
    if (trimmed.length > MAX_LABEL) return fail("Model display name is too long.");
    if (!this.storage.setModelLabel(id, trimmed)) return fail("Model not found.", "not_found");
    return { ok: true, data: true };
  }

  /**
   * Enable or disable a model.
   *
   * Disabling the active model would leave the runtime without a selection,
   * so it is refused until another model is activated.
   */
  setEnabled(id: number, enabled: boolean): ServiceResult<true> {
    if (!this.storage.getModel(id)) return fail("Model not found.", "not_found");
    if (!enabled && this.isActive(id)) {
      return fail(
        "This model is active; activate another model first to disable it.",
        "in_use",
      );
    }
    if (!this.storage.setModelEnabled(id, enabled)) {
      return fail("Model not found.", "not_found");
    }
    return { ok: true, data: true };
  }

  /** Delete a model, naming the exact reason when it is refused. */
  remove(id: number): ServiceResult<true> {
    const model = this.storage.getModel(id);
    if (!model) return fail("Model not found.", "not_found");

    // The two refusals are distinct, and an owner needs to know which applies.
    if (this.isActive(id)) {
      return fail(
        "This model is active; activate another model first to delete it.",
        "in_use",
      );
    }
    const others = this.storage.listModels(model.providerId).filter((m) => m.id !== id && m.enabled);
    if (others.length === 0) {
      return fail(
        "This is the provider’s only enabled model; add or enable another model first.",
        "last_enabled",
      );
    }

    if (!this.storage.deleteModel(id)) return fail("Deleting the model failed.");
    return { ok: true, data: true };
  }

  /** Mark a model as its provider's default. */
  setDefault(id: number): ServiceResult<true> {
    if (!this.storage.setModelDefault(id)) return fail("Model not found.", "not_found");
    return { ok: true, data: true };
  }

  /**
   * Repair a stale default after discovery.
   *
   * When the provider's effective default — the flagged default if it is
   * enabled, else the first enabled model (the same pick the health
   * probe makes) — is not among the model ids a discovery just returned,
   * point the default at the first discovered id that is actually stored
   * and enabled, and report true. This is the `aqa` repair: a bulk
   * import had left a Gemini provider defaulted onto a non-chat model
   * that discovery no longer returns, and every probe/chat kept hitting
   * the model that can only 404. A no-op when the current default is
   * discoverable, when nothing is stored, or when no discovered model
   * is stored yet (a following import creates the rows; the caller's
   * next discovery repairs then).
   */
  resetDefaultToFirstOf(
    providerId: number,
    discoveredModelIds: readonly string[],
  ): boolean {
    const rows = this.storage.listModels(providerId);
    if (rows.length === 0 || discoveredModelIds.length === 0) return false;
    const allowed = new Set(discoveredModelIds);
    const current =
      rows.find((m) => m.isDefault && m.enabled) ?? rows.find((m) => m.enabled);
    if (current !== undefined && allowed.has(current.modelId)) return false;
    for (const id of discoveredModelIds) {
      const row = rows.find((m) => m.modelId === id && m.enabled);
      if (row !== undefined) return this.storage.setModelDefault(row.id);
    }
    return false;
  }

  /** Enabled models of a provider, for the quick-switch picker. */
  enabledModels(providerId: number): ModelView[] {
    return this.list(providerId).filter((m) => m.enabled);
  }

  /** A model row, used by the gateway. */
  row(id: number): AiModelRow | undefined {
    return this.storage.getModel(id);
  }
}
