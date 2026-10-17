/**
 * Search provider registry — settings to a live provider.
 *
 * The single place that knows which class implements which provider type, so
 * adding one never touches the tool layer. An unknown or unconfigured type is
 * reported as a configuration failure rather than silently falling back to a
 * different service: searching somewhere the owner did not choose would be a
 * surprising use of their query text.
 */
import type { SearchProviderSecretStore } from "./secret_store";
import type { SearchSettings, Storage } from "../storage/storage";
import { DuckDuckGoSearch } from "./duckduckgo";
import { TavilySearch } from "./tavily";
import { isSearchProviderType, SearchError } from "./provider";
import type { SearchProvider } from "./provider";

export class SearchRegistry {
  constructor(
    private readonly storage: Storage,
    private readonly secrets: SearchProviderSecretStore,
  ) {}

  /**
   * The active provider, or a configuration failure.
   *
   * The credential is decrypted here, per call, and handed only to the provider
   * instance — it is never cached on the registry.
   */
  active(): SearchProvider {
    const settings = this.storage.getSearchSettings();
    return this.build(settings);
  }

  /** Whether a usable provider is configured, without building one. */
  isConfigured(): boolean {
    try {
      const settings = this.storage.getSearchSettings();
      return isSearchProviderType(settings.provider) &&
        (settings.provider === "duckduckgo" || this.hasKey());
    } catch {
      return false;
    }
  }

  /** Build a specific provider type, for a panel test action. */
  build(settings: SearchSettings): SearchProvider {
    if (!isSearchProviderType(settings.provider)) {
      throw new SearchError("config", "سرویس جستجو انتخاب نشده است.");
    }

    switch (settings.provider) {
      case "duckduckgo":
        // No credential needed; nothing to look up.
        return new DuckDuckGoSearch();
      case "tavily":
        return new TavilySearch(this.decryptedKey());
    }
  }

  /** The stored key, decrypted, or undefined when unset or unreadable. */
  private decryptedKey(): string | undefined {
    const stored = this.storage.getSearchCredential();
    if (!stored) return undefined;
    try {
      return this.secrets.decrypt(stored);
    } catch {
      // A key that cannot be decrypted is treated as absent, so the provider
      // reports an auth failure rather than crashing the tool.
      return undefined;
    }
  }

  private hasKey(): boolean {
    return this.decryptedKey() !== undefined;
  }
}
