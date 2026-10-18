/**
 * HMAC-SHA256 signing for outbound webhook payloads.
 *
 * The signature authenticates the sender to the receiver: only someone holding
 * BOBI_WEBHOOK_SECRET can produce a valid signature, so the receiver can
 * reject forged or replayed events. Verification itself is the RECEIVER's
 * job — see the verification snippet in docs/phase-webhooks.md — and must
 * use a constant-time comparison there.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Request header carrying the hex signature. */
export const SIGNATURE_HEADER = "X-Bobi-Signature-256";

/**
 * Sign a serialized payload body.
 *
 * @param secret shared secret (BOBI_WEBHOOK_SECRET).
 * @param body   exact bytes that will be POSTed; sign the serialized form,
 *               not the object, so sender and receiver hash identical bytes.
 * @returns lowercase hex HMAC-SHA256.
 */
export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Receiver-side helper: verify a signature with a constant-time comparison.
 *
 * Exported so the reference implementation in the docs and any in-repo
 * receiver can share one correct implementation instead of each hand-rolling
 * `===` (which leaks timing information about the expected value).
 */
export function verifySignature(secret: string, body: string, received: string): boolean {
  const expected = Buffer.from(signBody(secret, body), "utf8");
  const actual = Buffer.from(received, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
