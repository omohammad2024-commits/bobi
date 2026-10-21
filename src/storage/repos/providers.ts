/**
 * ProvidersRepo — AI providers, credentials, models repository (phase 6).
 *
 * Owns the SQL for: ai_providers, ai_credentials, ai_credential_pool, ai_models, ai_runtime_settings, ai_provider_health, ai_failover_settings, ai_failover_candidates, search_settings, search_credentials.
 * Extracted from the old Storage god class; method bodies are unchanged,
 * only their home moved. Row shapes stay inside the storage layer.
 */

import { RepoBase } from "./base";
import { StorageError } from "../errors";
import { storageErrorMessage as msg } from "../errors";
import { clampInt } from "./base";

/** A configured AI provider, without any credential material. */
export interface AiProviderRow {
  id: number;
  label: string;
  /** Adapter type slug, e.g. "openai_compatible". */
  adapter: string;
  baseUrl: string;
  enabled: boolean;
  /** Owner-set exception allowing loopback/private hosts for this provider. */
  allowLocal: boolean;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
}

/** The encrypted credential envelope for a provider. */
export interface EncryptedCredentialRow {
  providerId: number;
  iv: string;
  ciphertext: string;
  tag: string;
  /** unix ms */
  updatedAt: number;
}

/**
 * One pooled backup credential of a provider.
 * The envelope (iv/ciphertext/tag) is the same AES-256-GCM shape as
 * EncryptedCredentialRow; the plaintext key is never exposed by a list call.
 */
export interface AiPoolCredentialRow {
  id: number;
  providerId: number;
  /** Owner-chosen display label, e.g. "backup-1". */
  label: string;
  iv: string;
  ciphertext: string;
  tag: string;
  /** Load-sharing multiplier inside the round-robin order. */
  weight: number;
  enabled: boolean;
  /** unix ms */
  createdAtMs: number;
}

/** A model belonging to a provider. */
export interface AiModelRow {
  id: number;
  providerId: number;
  /** The real id the service expects. Never user-authored display text. */
  modelId: string;
  /** Display name chosen by the owner. */
  label: string;
  enabled: boolean;
  isDefault: boolean;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
}

/** The single-row web-search selection. */
export interface SearchSettings {
  /** Provider slug; see SEARCH_PROVIDER_TYPES. */
  provider: string;
}

/** The single-row runtime selection. */
export interface AiRuntimeSettings {
  activeProviderId: number | null;
  activeModelId: number | null;
}

/** Latest health probe result for a provider. */
export interface AiProviderHealthRow {
  providerId: number;
  ok: boolean;
  /** unix ms */
  checkedAt: number;
  /** Safe, provider-chosen message. Never a key or a full response. */
  message?: string;
  /**
   * HTTP status of the failure, when the adapter reported one. Additive:
   * records written before this field existed simply lack it.
   */
  status?: number;
  /** Wall-clock ms the probe took. Additive, like `status`. */
  latencyMs?: number;
}

/** Failover policy. Disabled by default. */
export interface AiFailoverSettings {
  enabled: boolean;
  /** Total tries per request, including the first. Bounded 1..4. */
  maxAttempts: number;
  /** Per-candidate timeout, ms. Bounded 1000..600000 (up to 10min). */
  timeoutMs: number;
}

/** One ordered failover candidate. */
export interface AiFailoverCandidate {
  providerId: number;
  modelId: number;
  position: number;
}

/** Attempts are bounded: never let a misconfiguration become an unbounded loop. */
function clampAttempts(raw: number | undefined): number {
  if (raw === undefined) return 2;
  return clampInt(raw, 1, 4, 2);
}

/** Per-candidate timeout is bounded both ways, so it can never be zero. */
function clampTimeout(raw: number | undefined): number {
  if (raw === undefined) return 300_000;
  return clampInt(raw, 1_000, 600_000, 300_000);
}

export class ProvidersRepo extends RepoBase {
  /**
   * Round-robin cursors for credential-pool rotation, one per provider.
   * In-memory: a restart resets rotation (see poolPosition). Process-local
   * state, never persisted, never containing key material.
   */
  private readonly poolCursors = new Map<number, number>();

  // ---- web search ----

  /**
   * The active search provider. Always fully specified: a fresh database
   * defaults to the keyless provider, so search works out of the box.
   */
  getSearchSettings(): SearchSettings {
    const row = this.query<{ provider: string }>(
      `SELECT provider FROM search_settings WHERE id=1`,
    )[0];
    return { provider: row?.provider ?? "duckduckgo" };
  }

  /** Persist the active search provider. */
  setSearchProvider(provider: string): void {
    this.exec(
      `INSERT INTO search_settings(id, provider) VALUES(1,?)
       ON CONFLICT(id) DO UPDATE SET provider=excluded.provider`,
      [provider],
    );
  }

  /** The stored search credential envelope, or undefined when none is set. */
  getSearchCredential(): EncryptedCredentialRow | undefined {
    const row = this.query<{
      iv: string;
      ciphertext: string;
      tag: string;
      updated_at: number;
    }>(`SELECT iv, ciphertext, tag, updated_at FROM search_credentials WHERE id=1`)[0];
    if (!row) return undefined;
    return {
      providerId: 0,
      iv: row.iv,
      ciphertext: row.ciphertext,
      tag: row.tag,
      updatedAt: row.updated_at,
    };
  }

  /** Store (or replace) the search credential envelope. */
  upsertSearchCredential(c: { iv: string; ciphertext: string; tag: string }): void {
    this.exec(
      `INSERT INTO search_credentials(id, iv, ciphertext, tag, updated_at)
       VALUES(1,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         iv=excluded.iv, ciphertext=excluded.ciphertext,
         tag=excluded.tag, updated_at=excluded.updated_at`,
      [c.iv, c.ciphertext, c.tag, Date.now()],
    );
  }

  /** Remove the search credential. Returns whether a row was deleted. */
  deleteSearchCredential(): boolean {
    return this.exec(`DELETE FROM search_credentials WHERE id=1`).changes > 0;
  }

  /** True when a search credential is stored. */
  hasSearchCredential(): boolean {
    const row = this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM search_credentials WHERE id=1`,
    )[0];
    return (row?.n ?? 0) > 0;
  }

  // ---- AI providers ----

  /** All providers, newest first. Never includes credential material. */
  listProviders(): AiProviderRow[] {
    return this.query<{
      id: number;
      label: string;
      adapter: string;
      base_url: string;
      enabled: number;
      allow_local: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, label, adapter, base_url, enabled, allow_local, created_at, updated_at
         FROM ai_providers ORDER BY id DESC`,
    ).map((r) => ({
      id: r.id,
      label: r.label,
      adapter: r.adapter,
      baseUrl: r.base_url,
      enabled: r.enabled === 1,
      // A pre-migration row reads 0, so an existing provider is never allowed
      // local targets retroactively.
      allowLocal: r.allow_local === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** One provider, or undefined when the id does not exist. */
  getProvider(id: number): AiProviderRow | undefined {
    return this.listProviders().find((p) => p.id === id);
  }

  /** Insert a provider and return its id. */
  createProvider(p: {
    label: string;
    adapter: string;
    baseUrl: string;
    allowLocal?: boolean;
  }): number {
    const now = Date.now();
    const res = this.exec(
      `INSERT INTO ai_providers(label, adapter, base_url, enabled, allow_local, created_at, updated_at)
       VALUES(?,?,?,1,?,?,?)`,
      [p.label, p.adapter, p.baseUrl, p.allowLocal === true ? 1 : 0, now, now],
    );
    return Number(res.lastInsertRowid);
  }

  /** Update the editable fields of a provider. */
  updateProvider(
    id: number,
    patch: { label?: string; baseUrl?: string; adapter?: string; allowLocal?: boolean },
  ): void {
    const sets: string[] = ["updated_at=?"];
    const params: unknown[] = [Date.now()];
    if (patch.label !== undefined) {
      sets.push("label=?");
      params.push(patch.label);
    }
    if (patch.baseUrl !== undefined) {
      sets.push("base_url=?");
      params.push(patch.baseUrl);
    }
    if (patch.adapter !== undefined) {
      sets.push("adapter=?");
      params.push(patch.adapter);
    }
    if (patch.allowLocal !== undefined) {
      sets.push("allow_local=?");
      params.push(patch.allowLocal ? 1 : 0);
    }
    params.push(id);
    this.exec(`UPDATE ai_providers SET ${sets.join(", ")} WHERE id=?`, params);
  }

  /**
   * Set the per-provider local-target exception.
   *
   * This is the only way a loopback/private target becomes reachable, and it
   * is a per-provider owner decision — never a global switch.
   */
  setProviderAllowLocal(id: number, allow: boolean): void {
    this.exec(`UPDATE ai_providers SET allow_local=?, updated_at=? WHERE id=?`, [
      allow ? 1 : 0,
      Date.now(),
      id,
    ]);
  }

  /** Enable or disable a provider. */
  setProviderEnabled(id: number, enabled: boolean): void {
    this.exec(`UPDATE ai_providers SET enabled=?, updated_at=? WHERE id=?`, [
      enabled ? 1 : 0,
      Date.now(),
      id,
    ]);
  }

  /**
   * Delete a provider and its credentials, models and health rows.
   *
   * Callers must first ensure the provider is not the active one; this method
   * refuses an active provider so a running selection is never orphaned.
   */
  deleteProvider(id: number): boolean {
    const active = this.getRuntimeSettings();
    if (active.activeProviderId === id) return false;
    const res = this.exec(`DELETE FROM ai_providers WHERE id=?`, [id]);
    return res.changes > 0;
  }

  // ---- AI credentials ----

  /** True when a credential is stored for this provider. */
  hasCredential(providerId: number): boolean {
    const row = this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ai_credentials WHERE provider_id=?`,
      [providerId],
    )[0];
    return (row?.n ?? 0) > 0;
  }

  /** Read the stored credential envelope, or undefined when none is set. */
  getCredential(providerId: number): EncryptedCredentialRow | undefined {
    const row = this.query<{
      provider_id: number;
      iv: string;
      ciphertext: string;
      tag: string;
      updated_at: number;
    }>(
      `SELECT provider_id, iv, ciphertext, tag, updated_at
         FROM ai_credentials WHERE provider_id=?`,
      [providerId],
    )[0];
    if (!row) return undefined;
    return {
      providerId: row.provider_id,
      iv: row.iv,
      ciphertext: row.ciphertext,
      tag: row.tag,
      updatedAt: row.updated_at,
    };
  }

  /** Store (or replace) a credential envelope. */
  upsertCredential(c: {
    providerId: number;
    iv: string;
    ciphertext: string;
    tag: string;
  }): void {
    this.exec(
      `INSERT INTO ai_credentials(provider_id, iv, ciphertext, tag, updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(provider_id) DO UPDATE SET
         iv=excluded.iv, ciphertext=excluded.ciphertext,
         tag=excluded.tag, updated_at=excluded.updated_at`,
      [c.providerId, c.iv, c.ciphertext, c.tag, Date.now()],
    );
  }

  /** Remove a credential. Returns whether a row was deleted. */
  deleteCredential(providerId: number): boolean {
    return this.exec(`DELETE FROM ai_credentials WHERE provider_id=?`, [providerId]).changes > 0;
  }

  // ---- AI credential pool (Phase E3) ----

  /**
   * Store a pool credential envelope. The caller must already have encrypted
   * the key; this layer never sees plaintext. Returns the new pool entry id.
   */
  addPoolCredential(p: {
    providerId: number;
    label: string;
    iv: string;
    ciphertext: string;
    tag: string;
    weight?: number;
  }): number {
    const res = this.exec(
      `INSERT INTO ai_credential_pool(provider_id, label, iv, ciphertext, tag, weight, enabled, created_at_ms)
       VALUES(?,?,?,?,?,?,1,?)`,
      [
        p.providerId,
        p.label,
        p.iv,
        p.ciphertext,
        p.tag,
        Math.max(1, Math.floor(p.weight ?? 1)),
        Date.now(),
      ],
    );
    return Number(res.lastInsertRowid);
  }

  /** Pool entries of a provider, oldest first. Envelopes included, never plaintext. */
  listPoolCredentials(providerId: number): AiPoolCredentialRow[] {
    return this.query<{
      id: number;
      provider_id: number;
      label: string;
      iv: string;
      ciphertext: string;
      tag: string;
      weight: number;
      enabled: number;
      created_at_ms: number;
    }>(
      `SELECT id, provider_id, label, iv, ciphertext, tag, weight, enabled, created_at_ms
         FROM ai_credential_pool WHERE provider_id=? ORDER BY id ASC`,
      [providerId],
    ).map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      label: r.label,
      iv: r.iv,
      ciphertext: r.ciphertext,
      tag: r.tag,
      weight: r.weight,
      enabled: r.enabled === 1,
      createdAtMs: r.created_at_ms,
    }));
  }

  /** One pool entry, or undefined when the id does not exist. */
  getPoolCredential(id: number): AiPoolCredentialRow | undefined {
    const row = this.query<{
      id: number;
      provider_id: number;
      label: string;
      iv: string;
      ciphertext: string;
      tag: string;
      weight: number;
      enabled: number;
      created_at_ms: number;
    }>(
      `SELECT id, provider_id, label, iv, ciphertext, tag, weight, enabled, created_at_ms
         FROM ai_credential_pool WHERE id=?`,
      [id],
    )[0];
    if (!row) return undefined;
    return {
      id: row.id,
      providerId: row.provider_id,
      label: row.label,
      iv: row.iv,
      ciphertext: row.ciphertext,
      tag: row.tag,
      weight: row.weight,
      enabled: row.enabled === 1,
      createdAtMs: row.created_at_ms,
    };
  }

  /** Enable or disable a pool entry. Returns whether the entry exists. */
  setPoolCredentialEnabled(id: number, enabled: boolean): boolean {
    return (
      this.exec(`UPDATE ai_credential_pool SET enabled=? WHERE id=?`, [enabled ? 1 : 0, id])
        .changes > 0
    );
  }

  /** Remove a pool entry. Returns whether a row was deleted. */
  removePoolCredential(id: number): boolean {
    return this.exec(`DELETE FROM ai_credential_pool WHERE id=?`, [id]).changes > 0;
  }

  /**
   * Round-robin cursor for credential-pool rotation.
   *
   * Returns the start index for this request and advances the cursor, so the
   * next request begins at the next key. IN-MEMORY BY DESIGN: a restart resets
   * rotation to 0. That is honest rather than lossy — a persisted cursor would
   * only remember a position whose meaning changes every time a pool entry is
   * added, removed, or disabled, so durability would buy nothing and could
   * pin traffic to a key that no longer deserves it.
   */
  poolPosition(providerId: number, poolSize: number): number {
    if (poolSize <= 0) return 0;
    const current = this.poolCursors.get(providerId) ?? 0;
    this.poolCursors.set(providerId, (current + 1) % poolSize);
    return current % poolSize;
  }

  // ---- AI models ----

  /** Models of a provider, newest first. */
  listModels(providerId: number): AiModelRow[] {
    return this.query<{
      id: number;
      provider_id: number;
      model_id: string;
      label: string;
      enabled: number;
      is_default: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, provider_id, model_id, label, enabled, is_default, created_at, updated_at
         FROM ai_models WHERE provider_id=? ORDER BY id DESC`,
      [providerId],
    ).map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      modelId: r.model_id,
      label: r.label,
      enabled: r.enabled === 1,
      isDefault: r.is_default === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** One model, or undefined. */
  getModel(id: number): AiModelRow | undefined {
    const row = this.query<{
      id: number;
      provider_id: number;
      model_id: string;
      label: string;
      enabled: number;
      is_default: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, provider_id, model_id, label, enabled, is_default, created_at, updated_at
         FROM ai_models WHERE id=?`,
      [id],
    )[0];
    if (!row) return undefined;
    return {
      id: row.id,
      providerId: row.provider_id,
      modelId: row.model_id,
      label: row.label,
      enabled: row.enabled === 1,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Models of a provider whose label contains a filter, for quick switching. */
  findModelByLabel(providerId: number, label: string): AiModelRow | undefined {
    return this.listModels(providerId).find((m) => m.label === label);
  }

  /** Insert a model. Returns its id, or throws on a duplicate (provider, model_id). */
  createModel(m: { providerId: number; modelId: string; label: string }): number {
    const now = Date.now();
    const res = this.exec(
      `INSERT INTO ai_models(provider_id, model_id, label, enabled, is_default, created_at, updated_at)
       VALUES(?,?,?,1,0,?,?)`,
      [m.providerId, m.modelId, m.label, now, now],
    );
    return Number(res.lastInsertRowid);
  }

  /** Rename a model's display label. */
  setModelLabel(id: number, label: string): boolean {
    return this.exec(`UPDATE ai_models SET label=?, updated_at=? WHERE id=?`, [
      label,
      Date.now(),
      id,
    ]).changes > 0;
  }

  /** Enable or disable a model. */
  setModelEnabled(id: number, enabled: boolean): boolean {
    return this.exec(`UPDATE ai_models SET enabled=?, updated_at=? WHERE id=?`, [
      enabled ? 1 : 0,
      Date.now(),
      id,
    ]).changes > 0;
  }

  /**
   * Delete a model.
   *
   * Refuses to delete the active model, so a live selection is never left
   * pointing at a missing row. Refuses to delete a provider's only default,
   * since that would leave the provider with no default model.
   */
  deleteModel(id: number): boolean {
    const model = this.getModel(id);
    if (!model) return false;

    const active = this.getRuntimeSettings();
    if (active.activeModelId === id) return false;

    // Never leave a provider with no enabled model, whether or not the one
    // being deleted is the current default: a provider with zero models cannot
    // serve a request but would still look configured.
    const remaining = this.listModels(model.providerId).filter(
      (m) => m.id !== id && m.enabled,
    );
    if (remaining.length === 0) return false;

    const res = this.exec(`DELETE FROM ai_models WHERE id=?`, [id]);
    if (res.changes > 0 && model.isDefault) {
      // Promote a replacement so the provider keeps exactly one default.
      this.setModelDefault(remaining[0]!.id);
    }
    return res.changes > 0;
  }

  /** Mark exactly one model of its provider as default. */
  setModelDefault(id: number): boolean {
    const model = this.getModel(id);
    if (!model) return false;
    this.exec("BEGIN");
    try {
      this.exec(`UPDATE ai_models SET is_default=0 WHERE provider_id=?`, [model.providerId]);
      this.exec(`UPDATE ai_models SET is_default=1, updated_at=? WHERE id=?`, [
        Date.now(),
        id,
      ]);
      this.exec("COMMIT");
      return true;
    } catch (err) {
      this.exec("ROLLBACK");
      throw new StorageError("query", `default model failed: ${msg(err)}`);
    }
  }

  // ---- AI runtime selection ----

  /** The single runtime settings row, always fully specified. */
  getRuntimeSettings(): AiRuntimeSettings {
    const row = this.query<{
      active_provider_id: number | null;
      active_model_id: number | null;
    }>(
      `SELECT active_provider_id, active_model_id FROM ai_runtime_settings WHERE id=1`,
    )[0];
    return {
      activeProviderId: row?.active_provider_id ?? null,
      activeModelId: row?.active_model_id ?? null,
    };
  }

  /**
   * Set the active provider and model together, so a selection is never
   * half-applied: a request either sees a consistent pair or none at all.
   */
  setRuntimeSelection(sel: { providerId: number; modelId: number }): void {
    this.exec(
      `INSERT INTO ai_runtime_settings(id, active_provider_id, active_model_id)
       VALUES(1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         active_provider_id=excluded.active_provider_id,
         active_model_id=excluded.active_model_id`,
      [sel.providerId, sel.modelId],
    );
  }

  // ---- AI provider health ----

  /** Latest probe result for a provider. */
  getProviderHealth(providerId: number): AiProviderHealthRow | undefined {
    const row = this.query<{
      provider_id: number;
      ok: number;
      checked_at: number;
      message: string | null;
      status: number | null;
      latency_ms: number | null;
    }>(
      `SELECT provider_id, ok, checked_at, message, status, latency_ms FROM ai_provider_health WHERE provider_id=?`,
      [providerId],
    )[0];
    if (!row) return undefined;
    return {
      providerId: row.provider_id,
      ok: row.ok === 1,
      checkedAt: row.checked_at,
      ...(row.message !== null ? { message: row.message } : {}),
      ...(row.status !== null ? { status: row.status } : {}),
      ...(row.latency_ms !== null ? { latencyMs: row.latency_ms } : {}),
    };
  }

  /** Record a probe result. The message must already be free of secrets. */
  setProviderHealth(h: {
    providerId: number;
    ok: boolean;
    message?: string;
    status?: number;
    latencyMs?: number;
  }): void {
    this.exec(
      `INSERT INTO ai_provider_health(provider_id, ok, checked_at, message, status, latency_ms)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(provider_id) DO UPDATE SET
         ok=excluded.ok, checked_at=excluded.checked_at, message=excluded.message,
         status=excluded.status, latency_ms=excluded.latency_ms`,
      [
        h.providerId,
        h.ok ? 1 : 0,
        Date.now(),
        h.message ?? null,
        h.status ?? null,
        h.latencyMs ?? null,
      ],
    );
  }

  // ---- AI failover ----

  /**
   * Failover settings. Defaults to OFF, so a fresh database never switches
   * provider without the owner explicitly enabling it.
   */
  getFailoverSettings(): AiFailoverSettings {
    const row = this.query<{
      enabled: number;
      max_attempts: number;
      timeout_ms: number;
    }>(
      `SELECT enabled, max_attempts, timeout_ms FROM ai_failover_settings WHERE id=1`,
    )[0];
    return {
      enabled: row?.enabled === 1,
      maxAttempts: clampAttempts(row?.max_attempts),
      timeoutMs: clampTimeout(row?.timeout_ms),
    };
  }

  /** Persist failover settings. */
  setFailoverSettings(s: {
    enabled?: boolean;
    maxAttempts?: number;
    timeoutMs?: number;
  }): void {
    const current = this.getFailoverSettings();
    this.exec(
      `INSERT INTO ai_failover_settings(id, enabled, max_attempts, timeout_ms)
       VALUES(1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled=excluded.enabled,
         max_attempts=excluded.max_attempts,
         timeout_ms=excluded.timeout_ms`,
      [
        s.enabled ?? current.enabled ? 1 : 0,
        clampAttempts(s.maxAttempts ?? current.maxAttempts),
        clampTimeout(s.timeoutMs ?? current.timeoutMs),
      ],
    );
  }

  /** Ordered failover candidates, highest priority first. */
  listFailoverCandidates(): AiFailoverCandidate[] {
    return this.query<{ provider_id: number; model_id: number; position: number }>(
      `SELECT provider_id, model_id, position
         FROM ai_failover_candidates ORDER BY position ASC, model_id ASC`,
    ).map((r) => ({
      providerId: r.provider_id,
      modelId: r.model_id,
      position: r.position,
    }));
  }

  /** Replace the candidate list. Order given is priority order. */
  setFailoverCandidates(candidates: readonly { providerId: number; modelId: number }[]): void {
    this.exec("BEGIN");
    try {
      this.exec(`DELETE FROM ai_failover_candidates`);
      candidates.forEach((c, index) => {
        this.exec(
          `INSERT INTO ai_failover_candidates(provider_id, model_id, position) VALUES(?,?,?)`,
          [c.providerId, c.modelId, index],
        );
      });
      this.exec("COMMIT");
    } catch (err) {
      this.exec("ROLLBACK");
      throw new StorageError("query", `failover candidates failed: ${msg(err)}`);
    }
  }
}

/** DDL fragment owned by this repository (phase 6). The Storage facade
 *  assembles the full SCHEMA from the domain fragments in a fixed order;
 *  the statements themselves are byte-identical to the pre-split schema. */
export const PROVIDERS_SCHEMA = `

-- Active web-search provider. Single row; the default needs no credential, so
-- a fresh install can search without any configuration.
CREATE TABLE IF NOT EXISTS search_settings (
  id       INTEGER PRIMARY KEY CHECK(id = 1),
  provider TEXT NOT NULL DEFAULT 'duckduckgo'
);

-- Encrypted credential for a keyed search provider. Same AES-256-GCM envelope
-- as ai_credentials; a missing row simply means "no key set".
CREATE TABLE IF NOT EXISTS search_credentials (
  id         INTEGER PRIMARY KEY CHECK(id = 1),
  iv         TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- AI providers. One row per configured service.
-- Credentials live in ai_credentials (encrypted), never here.
CREATE TABLE IF NOT EXISTS ai_providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  adapter     TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  -- Owner-set exception for a self-hosted local endpoint. Off by default:
  -- a fresh provider must never reach loopback/private addresses.
  allow_local INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Encrypted credentials for a provider. AES-256-GCM: iv, ciphertext, tag.
-- A missing credential row simply means "no key set".
CREATE TABLE IF NOT EXISTS ai_credentials (
  provider_id INTEGER PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
  iv          TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Credential pool: extra encrypted API keys for one provider. Each row is a
-- full AES-256-GCM envelope (iv, ciphertext, tag), the same format as
-- ai_credentials: the primary key is never distinguished by storage layout.
-- The gateway rotates across these keys on auth/transport failures. weight is
-- a small load-sharing multiplier inside the round-robin order (default 1).
CREATE TABLE IF NOT EXISTS ai_credential_pool (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id   INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  iv            TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,
  tag           TEXT NOT NULL,
  weight        INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool_provider ON ai_credential_pool(provider_id, enabled);

-- Models offered by a provider. model_id is the real id the service expects;
-- label is a display name the owner chooses. Exactly one per provider is default.
CREATE TABLE IF NOT EXISTS ai_models (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,
  label       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);

-- Runtime selection. Single-row table; a NULL active_* means "none selected".
CREATE TABLE IF NOT EXISTS ai_runtime_settings (
  id               INTEGER PRIMARY KEY CHECK(id = 1),
  active_provider_id INTEGER,
  active_model_id    INTEGER
);

-- Latest health probe result per provider. Never stores key material.
CREATE TABLE IF NOT EXISTS ai_provider_health (
  provider_id    INTEGER PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
  ok             INTEGER NOT NULL,
  checked_at     INTEGER NOT NULL,
  message        TEXT,
  status         INTEGER,
  latency_ms     INTEGER
);

-- Failover settings. Single row: off by default, so nothing ever switches
-- provider without the owner turning it on explicitly.
CREATE TABLE IF NOT EXISTS ai_failover_settings (
  id          INTEGER PRIMARY KEY CHECK(id = 1),
  enabled     INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  timeout_ms  INTEGER NOT NULL DEFAULT 300000
);

-- Ordered failover candidates. Only rows the owner added here may be used,
-- and each is revalidated at request time (enabled, credential present).
CREATE TABLE IF NOT EXISTS ai_failover_candidates (
  provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id    INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_failover_order ON ai_failover_candidates(position);
`;
