/**
 * Phase 5, item 1 — ed25519 signing for skill packages (`.bobiskill`).
 *
 * Pure crypto helpers, no I/O, no Telegram. The signing key itself lives in
 * the owner's database (`skill_signing_key` table, see `src/storage/`); this
 * module only ever sees key material passed in by the caller and never
 * persists, logs, or transmits it.
 *
 * Design notes (see docs/PHASE5_SKILL_SIGNING.md for the full trust model):
 * - ed25519 (RFC 8032) via node:crypto. Signatures are deterministic and
 *   non-malleable: for a fixed key and message there is exactly one valid
 *   signature, so a "bad signature" can only mean tampering or a wrong key.
 * - The signed bytes are the canonical package payload — the exact same
 *   string the SHA-256 checksum covers — so one signature authenticates the
 *   whole envelope (skill bytes, version, description, metadata).
 * - `keyId` (the publisher identity) is the SHA-256 fingerprint of the raw
 *   32-byte public key. Verification binds the claimed `keyId` to the
 *   envelope's public key, so an attacker cannot transplant a valid
 *   signature under a different publisher id.
 * - Verification NEVER throws: malformed input is simply "invalid".
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

/**
 * Minimal JWK shape for ed25519 keys. (The repo's TS lib does not export
 * node:crypto's JsonWebKey type, so we carry just the fields we use.)
 */
interface Ed25519Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  d?: string;
}

/** Signature algorithm tag written into package envelopes. */
export const SIGNATURE_ALG = "ed25519";

/** Raw ed25519 public keys are always 32 bytes; signatures 64 bytes. */
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

export class SigningError extends Error {
  constructor(
    readonly kind: "bad_private_key" | "bad_public_key" | "bad_signature",
    message: string,
  ) {
    super(message);
    this.name = "SigningError";
  }
}

/** Freshly generated keypair. The private JWK is the secret; handle with care. */
export interface GeneratedSigningKeypair {
  /** SHA-256 hex of the raw 32-byte public key — the stable publisher id. */
  keyId: string;
  /** Raw 32-byte public key, base64. Safe to share. */
  publicKeyB64: string;
  /** Private key as a JWK JSON string (`{kty:"OKP",crv:"Ed25519",x,d}`). */
  privateKeyJwk: string;
}

function rawPublicKeyBytes(publicKeyB64: string): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(publicKeyB64, "base64");
  } catch {
    throw new SigningError("bad_public_key", "public key is not valid base64");
  }
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new SigningError(
      "bad_public_key",
      `public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes`,
    );
  }
  return raw;
}

/**
 * The publisher id for a raw public key: SHA-256 over the 32 bytes, hex.
 * Stable across instances — this is what `/skill trust` stores.
 */
export function fingerprintPublicKey(publicKeyB64: string): string {
  return createHash("sha256").update(rawPublicKeyBytes(publicKeyB64)).digest("hex");
}

/** Generate a fresh ed25519 keypair for package signing. */
export function generateSigningKeypair(): GeneratedSigningKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as unknown as Ed25519Jwk;
  const privJwk = privateKey.export({ format: "jwk" }) as unknown as Ed25519Jwk;
  if (typeof pubJwk.x !== "string" || typeof privJwk.d !== "string") {
    throw new SigningError("bad_public_key", "key generation produced an unusable key");
  }
  const raw = Buffer.from(pubJwk.x, "base64url");
  const publicKeyB64 = raw.toString("base64");
  return {
    keyId: fingerprintPublicKey(publicKeyB64),
    publicKeyB64,
    privateKeyJwk: JSON.stringify(privJwk),
  };
}

function privateKeyObject(privateKeyJwk: string) {
  let jwk: Ed25519Jwk;
  try {
    jwk = JSON.parse(privateKeyJwk) as unknown as Ed25519Jwk;
  } catch {
    throw new SigningError("bad_private_key", "private key is not valid JSON");
  }
  try {
    return createPrivateKey({ key: jwk, format: "jwk" });
  } catch {
    throw new SigningError("bad_private_key", "private key JWK is unusable");
  }
}

/**
 * Sign the canonical package bytes. Returns the signature as base64.
 * Throws SigningError when the private key is unusable — the caller maps
 * this to a user-facing message (never the key material).
 */
export function signCanonicalPayload(canonicalText: string, privateKeyJwk: string): string {
  const key = privateKeyObject(privateKeyJwk);
  const sig = sign(null, Buffer.from(canonicalText, "utf8"), key);
  return sig.toString("base64");
}

/**
 * Verify a signature over the canonical package bytes. Returns false for
 * ANY malformed input (bad base64, wrong lengths, wrong key) instead of
 * throwing, so the import path can treat it as a plain rejection.
 */
export function verifyCanonicalSignature(
  canonicalText: string,
  publicKeyB64: string,
  sigB64: string,
): boolean {
  let raw: Buffer;
  let sig: Buffer;
  try {
    raw = rawPublicKeyBytes(publicKeyB64);
    sig = Buffer.from(sigB64, "base64");
  } catch {
    return false;
  }
  if (sig.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    const pubJwk: Ed25519Jwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: raw.toString("base64url"),
    };
    const pub = createPublicKey({ key: pubJwk, format: "jwk" });
    return verify(null, Buffer.from(canonicalText, "utf8"), pub, sig);
  } catch {
    return false;
  }
}

export type PublisherInput =
  | { kind: "key_id" }
  | { kind: "public_key"; publicKeyB64: string }
  | { kind: "invalid" };

/**
 * Parse what the owner passes to `/skill trust`: either a 64-hex key
 * fingerprint (key id) or a base64 raw public key. Anything else is invalid.
 * The returned publicKeyB64 is normalized to canonical base64.
 */
export function parsePublisherInput(input: string): PublisherInput {
  const clean = input.trim().replace(/\s+/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return { kind: "key_id" };
  // Strict base64 shape first: Buffer.from(x, "base64") is lenient and would
  // otherwise accept garbage that happens to decode to 32 bytes.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    const raw = Buffer.from(clean, "base64");
    if (raw.length === ED25519_PUBLIC_KEY_BYTES) {
      return { kind: "public_key", publicKeyB64: raw.toString("base64") };
    }
  }
  return { kind: "invalid" };
}

/** Short display form of a key id for cards (first 12 hex chars). */
export function shortKeyId(keyId: string): string {
  return keyId.length > 12 ? `${keyId.slice(0, 12)}…` : keyId;
}
