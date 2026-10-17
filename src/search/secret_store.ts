/**
 * Search credential encryption.
 *
 * A search API key is a secret exactly like an AI provider's, so it is stored
 * with the same AES-256-GCM envelope rather than being handled some second,
 * weaker way. This wraps the existing {@link ProviderSecretStore} instead of
 * reimplementing the crypto: one implementation means one place to audit, and
 * the fail-closed behaviour (no master key → no write) is inherited unchanged.
 *
 * The master key still lives in configuration, outside the database.
 */
import {
  ProviderSecretStore,
  MISSING_KEY_MESSAGE,
  SecretStoreError,
} from "../ai/secret_store";
import type { EncryptedSecret } from "../ai/secret_store";

export { MISSING_KEY_MESSAGE, SecretStoreError };
export type { EncryptedSecret };

/** Search-credential handling, backed by the shared credential vault. */
export class SearchProviderSecretStore {
  private readonly inner: ProviderSecretStore;

  constructor(masterKey: string | undefined) {
    this.inner = new ProviderSecretStore(masterKey);
  }

  /** Whether a usable master key is configured. */
  get configured(): boolean {
    return this.inner.configured;
  }

  /**
   * Encrypt a search key.
   * Throws SecretStoreError("missing_key") when no master key is set, so the
   * caller refuses to store rather than storing plaintext.
   */
  encrypt(plaintext: string): EncryptedSecret {
    return this.inner.encrypt(plaintext);
  }

  /** Decrypt a stored key, or throw when it was tampered with. */
  decrypt(stored: EncryptedSecret): string {
    return this.inner.decrypt(stored);
  }
}
