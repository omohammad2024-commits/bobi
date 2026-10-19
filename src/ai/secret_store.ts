/**
 * Provider credential store — AES-256-GCM at rest.
 *
 * API keys are never written to SQLite as plaintext. Each credential is stored
 * as three columns (iv, ciphertext, auth tag), and only this module can turn
 * one back into a key.
 *
 * The master key comes from configuration and lives outside the database. If it
 * is not configured, every write FAILS CLOSED: no credential is stored, and the
 * caller sees an actionable message rather than a silent fallback to plaintext.
 *
 * Plaintext is never logged, never returned by a list call, and only ever
 * handed to an adapter for the duration of a single request.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";
import type { Storage } from "../storage/storage";

/** Serialized ciphertext, safe to keep in a TEXT column. */
export interface EncryptedSecret {
  /** 12-byte IV, base64. */
  iv: string;
  /** Ciphertext, base64. Never the plaintext. */
  ciphertext: string;
  /** 16-byte auth tag, base64. Guards against tampering. */
  tag: string;
}

/** Shown when the master key is absent; safe to display. */
export const MISSING_KEY_MESSAGE =
  "The credential encryption key is not set. Set it in the BOBI_AI_KEY_MASTER_KEY environment variable and try again.";

export class SecretStoreError extends Error {
  constructor(
    readonly kind: "missing_key" | "invalid_key" | "decrypt_failed",
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

const IV_BYTES = 12;
const KEY_BYTES = 32; // AES-256

export class ProviderSecretStore {
  private readonly key: Buffer | undefined;

  constructor(masterKey: string | undefined) {
    this.key = masterKey !== undefined ? parseKey(masterKey) : undefined;
  }

  /** Whether a usable master key is configured. */
  get configured(): boolean {
    return this.key !== undefined;
  }

  /**
   * Encrypt a credential.
   * Throws SecretStoreError("missing_key") when no key is configured, so the
   * caller can refuse to store rather than store plaintext.
   */
  encrypt(plaintext: string): EncryptedSecret {
    if (this.key === undefined) {
      throw new SecretStoreError("missing_key", MISSING_KEY_MESSAGE);
    }
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw new SecretStoreError("invalid_key", "Credential is empty.");
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv) as CipherGCM;
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    return {
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  /**
   * Decrypt a stored credential.
   * Throws when the payload was tampered with or the key does not match, rather
   * than returning a partial or empty value.
   */
  decrypt(stored: EncryptedSecret): string {
    if (this.key === undefined) {
      throw new SecretStoreError("missing_key", MISSING_KEY_MESSAGE);
    }
    if (
      typeof stored.iv !== "string" ||
      typeof stored.ciphertext !== "string" ||
      typeof stored.tag !== "string"
    ) {
      throw new SecretStoreError("decrypt_failed", "Stored credential is unreadable.");
    }

    let iv: Buffer;
    let tag: Buffer;
    try {
      iv = Buffer.from(stored.iv, "base64");
      tag = Buffer.from(stored.tag, "base64");
    } catch {
      throw new SecretStoreError("decrypt_failed", "Stored credential is unreadable.");
    }

    if (iv.length !== IV_BYTES || tag.length !== 16) {
      throw new SecretStoreError("decrypt_failed", "Stored credential is invalid.");
    }

    const decipher = createDecipheriv("aes-256-gcm", this.key, iv) as DecipherGCM;
    decipher.setAuthTag(tag);
    try {
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "base64")),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    } catch {
      // GCM verification failed: the payload was altered or the key is wrong.
      throw new SecretStoreError("decrypt_failed", "Credential could not be decrypted.");
    }
  }
}

/**
 * Accept a hex (64 chars) or base64 key, or derive a 256-bit key from a
 * passphrase via SHA-256. A short passphrase still yields a full-strength key,
 * so the strength of the key stays a function of its length.
 */
function parseKey(masterKey: string): Buffer {
  const trimmed = masterKey.trim();
  if (trimmed.length === 0) {
    throw new SecretStoreError("invalid_key", MISSING_KEY_MESSAGE);
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length === KEY_BYTES) {
    return b64;
  }

  // Passphrase: derive a 256-bit key so any usable secret can be configured.
  return createHash("sha256").update(trimmed, "utf8").digest();
}

/**
 * A pool credential as every list call sees it.
 * Deliberately carries NO key material: labels, flags, and timestamps only.
 */
export interface PoolEntryView {
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

/**
 * Pool credential store — extra encrypted API keys per provider (Phase E3).
 *
 * The same AES-256-GCM envelope as the primary credential is reused, and the
 * master-key FAIL-CLOSED behavior covers pools too: with no master key,
 * saving a pool credential throws instead of writing anything.
 *
 * Pool rows are envelopes on disk. Plaintext appears only as a return value
 * of load() / decryptEnabled(), handed straight to an adapter for one
 * request, and is never logged or returned by a list call.
 */
export class CredentialPoolStore {
  constructor(
    private readonly storage: Storage,
    private readonly secrets: ProviderSecretStore,
  ) {}

  /**
   * Encrypt and store a pool credential.
   * Throws SecretStoreError("missing_key") when no master key is configured —
   * the key is never stored, in any form, rather than stored plaintext.
   * Returns the pool entry id.
   */
  savePoolCredential(providerId: number, label: string, apiKey: string): number {
    const enc = this.secrets.encrypt(apiKey);
    return this.storage.addPoolCredential({ providerId, label, ...enc });
  }

  /**
   * Decrypt one pool entry for the duration of a single request.
   * Throws SecretStoreError when the entry does not exist or decryption fails.
   */
  loadPoolCredential(id: number): string {
    const row = this.storage.getPoolCredential(id);
    if (!row) {
      throw new SecretStoreError("decrypt_failed", "Backup key not found.");
    }
    return this.secrets.decrypt(row);
  }

  /**
   * Enabled pool entries with their decrypted keys, for one request's
   * rotation. Entries that fail to decrypt are skipped — a corrupt envelope
   * is unusable, not a reason to fail the whole request.
   */
  decryptEnabledPool(
    providerId: number,
  ): { entryId: number; label: string; weight: number; apiKey: string }[] {
    const out: { entryId: number; label: string; weight: number; apiKey: string }[] = [];
    for (const row of this.storage.listPoolCredentials(providerId)) {
      if (!row.enabled) continue;
      try {
        out.push({
          entryId: row.id,
          label: row.label,
          weight: row.weight,
          apiKey: this.secrets.decrypt(row),
        });
      } catch {
        // Skip the unusable entry; its envelope stays for the owner to fix or remove.
      }
    }
    return out;
  }

  /** Pool entries for display. NEVER includes key material. */
  listPoolEntries(providerId: number): PoolEntryView[] {
    return this.storage.listPoolCredentials(providerId).map((r) => ({
      id: r.id,
      providerId: r.providerId,
      label: r.label,
      weight: r.weight,
      enabled: r.enabled,
      createdAtMs: r.createdAtMs,
    }));
  }

  /** Enable or disable a pool entry. Returns whether the entry exists. */
  setPoolEntryEnabled(id: number, enabled: boolean): boolean {
    return this.storage.setPoolCredentialEnabled(id, enabled);
  }

  /**
   * Remove a pool entry — the containment path for a compromised key.
   * Returns whether a row was deleted.
   */
  removePoolEntry(id: number): boolean {
    return this.storage.removePoolCredential(id);
  }
}
