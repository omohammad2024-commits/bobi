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
  "کلید رمزنگاری اعتبارنامه‌ها تنظیم نشده است. آن را در متغیر محیطی BOBI_AI_KEY_MASTER_KEY تنظیم و دوباره تلاش کنید.";

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
      throw new SecretStoreError("invalid_key", "اعتبارنامه خالی است.");
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
      throw new SecretStoreError("decrypt_failed", "اعتبارنامه ذخیره‌شده خوانا نیست.");
    }

    let iv: Buffer;
    let tag: Buffer;
    try {
      iv = Buffer.from(stored.iv, "base64");
      tag = Buffer.from(stored.tag, "base64");
    } catch {
      throw new SecretStoreError("decrypt_failed", "اعتبارنامه ذخیره‌شده خوانا نیست.");
    }

    if (iv.length !== IV_BYTES || tag.length !== 16) {
      throw new SecretStoreError("decrypt_failed", "اعتبارنامه ذخیره‌شده نامعتبر است.");
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
      throw new SecretStoreError("decrypt_failed", "اعتبارنامه قابل رمزگشایی نبود.");
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
