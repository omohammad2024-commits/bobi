/**
 * Provider-backed embedder (Phase 4, semantic memory).
 *
 * Turns text into vectors using the OWNER'S configured AI provider — the
 * same provider the gateway would use for chat, resolved from the runtime
 * settings at call time. Only adapters that declare `capabilities.embeddings`
 * (today: OpenAI-compatible) can answer; everything else resolves to
 * `undefined` and the memory layer falls back to text search.
 *
 * Resolution is deliberately narrower than the gateway's: no failover, no
 * pool rotation — embeddings are a background enhancement, and burning pool
 * keys or failing over on a vector request would surprise the owner. The
 * primary credential only, decrypted per call and dropped when the call
 * settles (same rule as the gateway).
 *
 * Configuration (environment, like BOBI_MEMORY_PROVIDER):
 * - BOBI_EMBEDDING_MODEL: embedding model id the provider should use.
 *   Default "text-embedding-3-small" (OpenAI's cheap default; OpenRouter and
 *   other OpenAI-compatible services accept their own ids here).
 * - BOBI_SEMANTIC_MEMORY=0: kill switch. Embedding is skipped entirely and
 *   memory search behaves exactly as before — for the owner who does not
 *   want memory content leaving the box (see docs/PHASE4_MEMORY.md).
 *
 * SECURITY: input texts are memory content — owner data. They leave the box
 * to the owner's own configured provider on every embed call. Never log
 * texts or vectors; a failure is reported as "unavailable", never with the
 * text that failed.
 */
import type { Storage } from "../storage/storage";
import type { AdapterRegistry } from "../ai/adapter_registry";
import type { ProviderSecretStore } from "../ai/secret_store";
import type { AIProviderAdapter } from "../ai/adapter";
import type { Embedder, Embedding } from "./embeddings";

/** Default embedding model when BOBI_EMBEDDING_MODEL is unset. */
import { flagUnlessZero, processEnv } from "../config/env";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/** Hard timeout for one embedding request. Background work, not a chat turn. */
const EMBED_TIMEOUT_MS = 30_000;

/** Largest single batch: keeps one request well under provider limits. */
const MAX_BATCH = 32;

export interface ProviderEmbedderDeps {
  storage: Storage;
  secrets: ProviderSecretStore;
  adapters: AdapterRegistry;
  /** Test seam: override the model resolution without env vars. */
  embeddingModel?: string;
  /** Test seam: force-disable without env vars. */
  disabled?: boolean;
  /**
   * Test seam: build the adapter without touching the network-guarded
   * registry. Production always uses `adapters.create`.
   */
  createAdapter?: (
    type: string,
    cfg: { baseUrl: string; apiKey: string; model: string; allowLocalTargets?: boolean },
  ) => AIProviderAdapter;
}

export class ProviderEmbedder implements Embedder {
  readonly name = "provider";

  private readonly storage: Storage;
  private readonly secrets: ProviderSecretStore;
  private readonly adapters: AdapterRegistry;
  private readonly modelOverride: string | undefined;
  private readonly forceDisabled: boolean;
  private readonly createAdapter: NonNullable<ProviderEmbedderDeps["createAdapter"]>;

  constructor(deps: ProviderEmbedderDeps) {
    this.storage = deps.storage;
    this.secrets = deps.secrets;
    this.adapters = deps.adapters;
    this.modelOverride = deps.embeddingModel;
    this.forceDisabled = deps.disabled ?? false;
    this.createAdapter =
      deps.createAdapter ?? ((type, cfg) => this.adapters.create(type, cfg));
  }

  /** The embedding model id for this process. */
  embeddingModel(): string {
    if (this.modelOverride !== undefined && this.modelOverride.trim() !== "") {
      return this.modelOverride.trim();
    }
    const env = processEnv().BOBI_EMBEDDING_MODEL;
    if (env !== undefined && env.trim() !== "") return env.trim();
    return DEFAULT_EMBEDDING_MODEL;
  }

  /** Cheap pre-check: kill switch off AND an active provider exists. */
  available(): boolean {
    if (this.semanticDisabled()) return false;
    return this.activeProviderId() !== undefined;
  }

  /**
   * Phase 5: the model id current vectors are written with. The vector
   * store records it per row, so a BOBI_EMBEDDING_MODEL (or provider)
   * change marks old rows stale instead of mixing incompatible vectors
   * in cosine ranking.
   */
  modelId(): string {
    return this.embeddingModel();
  }

  async embedTexts(texts: readonly string[]): Promise<Embedding[] | undefined> {
    if (texts.length === 0) return [];
    if (this.semanticDisabled()) return undefined;

    const adapter = this.resolveAdapter();
    if (adapter === undefined) return undefined;
    if (adapter.embed === undefined) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
      const out: Embedding[] = [];
      // Batch so one giant backfill cannot build a giant request.
      for (let i = 0; i < texts.length; i += MAX_BATCH) {
        const batch = texts.slice(i, i + MAX_BATCH);
        const res = await adapter.embed({
          texts: batch,
          model: this.embeddingModel(),
          timeoutMs: EMBED_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (res.embeddings.length !== batch.length) return undefined;
        out.push(...res.embeddings);
      }
      return out;
    } catch {
      // Any failure — auth, quota, network, timeout, bad model, offline —
      // is "unavailable". The caller falls back to text search; nothing
      // here is ever user-visible.
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build the adapter for the active provider, or undefined when embedding
   * is not possible right now.
   *
   * Undefined covers: no active provider, provider disabled, adapter type
   * without embeddings (checked BEFORE constructing, so no credential is
   * decrypted for a provider that could not embed anyway), missing or
   * undecryptable credential.
   */
  private resolveAdapter(): AIProviderAdapter | undefined {
    const providerId = this.activeProviderId();
    if (providerId === undefined) return undefined;
    const provider = this.storage.providers.getProvider(providerId);
    if (!provider || !provider.enabled) return undefined;
    if (!this.adapters.describes(provider.adapter).embeddings) return undefined;

    const stored = this.storage.providers.getCredential(providerId);
    if (!stored) return undefined;
    let apiKey: string;
    try {
      apiKey = this.secrets.decrypt(stored);
    } catch {
      return undefined;
    }

    try {
      return this.createAdapter(provider.adapter, {
        baseUrl: provider.baseUrl,
        apiKey,
        model: this.embeddingModel(),
        ...(provider.allowLocal ? { allowLocalTargets: true } : {}),
      });
    } catch {
      return undefined;
    }
  }

  private activeProviderId(): number | undefined {
    const id = this.storage.providers.getRuntimeSettings().activeProviderId;
    return id ?? undefined;
  }

  private semanticDisabled(): boolean {
    if (this.forceDisabled) return true;
    return !flagUnlessZero(processEnv().BOBI_SEMANTIC_MEMORY);
  }
}
