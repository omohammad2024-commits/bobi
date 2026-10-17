/**
 * Owner identity — the single source of truth for who owns SOL.
 *
 * The owner is a Telegram NUMERIC USER ID supplied by configuration. It is
 * never inferred from anything a person or a model can type:
 * usernames, display names, message text, callback data, and AI output are
 * all explicitly NOT acceptable sources of owner identity.
 *
 * Telegram user IDs are positive integers in the range 1 .. 2^53-1, so every
 * other shape (decimal, negative, zero, empty, non-numeric, exponential,
 * whitespace-padded, hex, leading "+") is rejected here rather than being
 * coerced into some surprising number.
 */

/** Safely-representable Telegram user id upper bound. */
export const MAX_TELEGRAM_ID = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

export type OwnerIdParse =
  | { ok: true; ownerId: number }
  | { ok: false; reason: OwnerIdRejection };

export type OwnerIdRejection =
  | "missing"
  | "empty"
  | "not_numeric"
  | "decimal"
  | "negative"
  | "zero"
  | "too_large";

/**
 * Strictly parse an owner id from a raw string.
 *
 * Deliberately does NOT use Number()/parseInt() coercion: those accept "12px"
 * as 12 and "0x10" as 16. Instead the exact character set is checked first.
 */
export function parseOwnerId(raw: string | undefined): OwnerIdParse {
  if (raw === undefined) return { ok: false, reason: "missing" };

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };

  // Digits only — no sign, no dot, no exponent, no separators, no hex.
  if (!/^[0-9]+$/.test(trimmed)) {
    const looksDecimal = /^[+-]?\d*\.\d*$/.test(trimmed);
    return { ok: false, reason: looksDecimal ? "decimal" : "not_numeric" };
  }

  // Reject leading zeros that are not the single digit "0".
  if (trimmed.length > 1 && trimmed.startsWith("0")) {
    return { ok: false, reason: "not_numeric" };
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: "too_large" };
  if (value < 0) return { ok: false, reason: "negative" };
  if (value === 0) return { ok: false, reason: "zero" };

  return { ok: true, ownerId: value };
}

/**
 * Owner identity for the running process.
 *
 * Built once at startup from configuration. If no valid owner id was
 * configured, the owner is absent and administrative capabilities are simply
 * unavailable — the program never falls back to some insecure default such as
 * "the first person who messages the bot".
 */
export class OwnerIdentity {
  private readonly id: number | undefined;

  private constructor(id: number | undefined) {
    this.id = id;
  }

  /** Build from a raw env value; an invalid value yields "no owner". */
  static fromRawValue(raw: string | undefined): OwnerIdentity {
    const parsed = parseOwnerId(raw);
    return new OwnerIdentity(parsed.ok ? parsed.ownerId : undefined);
  }

  /** Build from an already-validated numeric id. */
  static fromNumber(id: number): OwnerIdentity {
    const parsed = parseOwnerId(String(id));
    return new OwnerIdentity(parsed.ok ? parsed.ownerId : undefined);
  }

  static none(): OwnerIdentity {
    return new OwnerIdentity(undefined);
  }

  /** Whether an owner was configured. */
  get configured(): boolean {
    return this.id !== undefined;
  }

  /**
   * The owner id, or undefined when unconfigured.
   * Never returns a caller-supplied value — only what config provided.
   */
  get ownerId(): number | undefined {
    return this.id;
  }

  /** True only for the configured numeric owner id. */
  isOwner(candidate: number | undefined): boolean {
    if (this.id === undefined || candidate === undefined) return false;
    if (!Number.isSafeInteger(candidate)) return false;
    return candidate === this.id;
  }

  /**
   * Owner check that accepts any untrusted value.
   *
   * Non-numeric candidates — strings such as a username, a token, callback
   * data, or model-generated text — always fail, even when the string merely
   * *spells out* the owner id.
   */
  isOwnerValue(candidate: unknown): boolean {
    if (typeof candidate !== "number") return false;
    return this.isOwner(candidate);
  }
}
