/**
 * Search settings service — validation and lifecycle for the search provider.
 *
 * Mirrors the shape of ProviderService: everything that reaches storage has
 * already been validated, and a credential that cannot be encrypted fails the
 * whole operation rather than being silently dropped.
 */
import type { Storage } from "../storage/storage";
import { isSearchProviderType, SEARCH_TEMPLATES } from "./provider";
import type { SearchProviderSecretStore } from "./secret_store";
import { SecretStoreError } from "./secret_store";
import type { SearchSettingsView } from "./panel";

const MAX_KEY_LENGTH = 512;

export type SearchServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; message: string };

function fail<T>(message: string, reason = "invalid"): SearchServiceResult<T> {
  return { ok: false, reason, message };
}

export class SearchSettingsService {
  constructor(
    private readonly storage: Storage,
    private readonly secrets: SearchProviderSecretStore,
  ) {}

  /** The settings as the panel shows them. Never includes the key. */
  view(): SearchSettingsView {
    const provider = this.storage.getSearchSettings().provider;
    const hasKey = this.storage.hasSearchCredential();
    const template = SEARCH_TEMPLATES.find((t) => t.type === provider);

    return {
      provider,
      hasKey,
      // A keyed provider without a stored key is unselectable in practice, so
      // the view reports that rather than claiming it works.
      usable: template !== undefined && (template.needsKey === false || hasKey),
    };
  }

  /** Whether the selected provider is usable right now. */
  isUsable(): boolean {
    return this.view().usable;
  }

  /** Persian label for the selected provider. */
  label(): string {
    const provider = this.storage.getSearchSettings().provider;
    return SEARCH_TEMPLATES.find((t) => t.type === provider)?.label ?? provider;
  }

  /**
   * Select the active provider.
   *
   * Selecting a keyed provider that has no stored key is allowed — the owner
   * may be about to add one — but the panel will report it as unusable until
   * they do, so the state is never misleading.
   */
  select(provider: string): SearchServiceResult<true> {
    if (!isSearchProviderType(provider)) {
      return fail("The selected search service is invalid.");
    }
    this.storage.setSearchProvider(provider);
    return { ok: true, data: true };
  }

  /**
   * Store (or replace) the key.
   *
   * A key that cannot be encrypted fails the whole operation, so a credential
   * is never silently dropped.
   */
  setKey(apiKey: string): SearchServiceResult<true> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) return fail("The key is empty.");
    if (trimmed.length > MAX_KEY_LENGTH) return fail("The key is too long.");

    try {
      const envelope = this.secrets.encrypt(trimmed);
      this.storage.upsertSearchCredential(envelope);
      return { ok: true, data: true };
    } catch (err) {
      if (err instanceof SecretStoreError && err.kind === "missing_key") {
        return fail(err.message, "missing_key");
      }
      return fail("Failed to store the key.");
    }
  }

  /** Remove the stored key. Returns whether one was present. */
  clearKey(): boolean {
    return this.storage.deleteSearchCredential();
  }

  /** Whether a key is stored. Never returns the key itself. */
  hasKey(): boolean {
    return this.storage.hasSearchCredential();
  }

  /** Whether the selected provider requires a key. */
  selectedNeedsKey(): boolean {
    const provider = this.storage.getSearchSettings().provider;
    return SEARCH_TEMPLATES.find((t) => t.type === provider)?.needsKey === true;
  }
}
