/**
 * Telegram WebApp initData validation (Mini App backend core).
 *
 * Per the Telegram docs, initData is a query-string that the client passes
 * through untouched. Validation:
 *   1. data_check_string = all `key=<value>` pairs EXCEPT `hash`, sorted
 *      alphabetically by key, joined with "\n".
 *   2. secret_key = HMAC_SHA256(key="WebAppData", msg=botToken).
 *   3. expected hash = HMAC_SHA256(key=secret_key, msg=data_check_string), hex.
 *   4. Compare with the received `hash` in constant time.
 *
 * Reasons are internal codes ("bad_hash", "stale", ...); the API layer maps
 * them to generic Persian errors. The caller must never leak which check
 * failed.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/** initData older than this is refused (a stale client or a replay). */
export const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type InitDataValidation =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: "empty" | "bad_hash" | "stale" | "no_user" | "not_owner";
    };

/**
 * Validate a Telegram WebApp initData string.
 *
 * @param initData The raw initData query string from the Mini App client.
 * @param botToken The bot token, read server-side (env/config). Never logged.
 * @param ownerId  The owner Telegram id, as a string. Only the owner may use
 *                 the Mini App.
 */
export function validateInitData(
  initData: string,
  botToken: string,
  ownerId: string,
): InitDataValidation {
  if (typeof initData !== "string" || initData.trim() === "") {
    return { ok: false, reason: "empty" };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "bad_hash" };
  }

  const receivedHash = params.get("hash") ?? "";
  if (receivedHash === "") {
    return { ok: false, reason: "bad_hash" };
  }

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key === "hash") return;
    pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken, "utf8").digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString, "utf8").digest("hex");

  if (!safeEqual(expectedHash, receivedHash)) {
    return { ok: false, reason: "bad_hash" };
  }

  // The signature is good; now the freshness and identity checks.
  const authDateSec = Number(params.get("auth_date"));
  if (!Number.isFinite(authDateSec) || authDateSec <= 0) {
    return { ok: false, reason: "stale" };
  }
  const ageMs = Date.now() - authDateSec * 1000;
  if (ageMs < 0 || ageMs > INIT_DATA_MAX_AGE_MS) {
    return { ok: false, reason: "stale" };
  }

  const userRaw = params.get("user");
  if (userRaw === null || userRaw === "") {
    return { ok: false, reason: "no_user" };
  }
  let userId: string;
  try {
    const user = JSON.parse(userRaw) as { id?: unknown };
    if (typeof user?.id !== "number" && typeof user?.id !== "string") {
      return { ok: false, reason: "no_user" };
    }
    userId = String(user.id);
  } catch {
    return { ok: false, reason: "no_user" };
  }

  if (userId !== ownerId) {
    return { ok: false, reason: "not_owner" };
  }

  return { ok: true, userId };
}

/**
 * Constant-time string comparison. Both sides are hashed first so unequal
 * input lengths do not throw and the failure timing does not leak how close
 * a guessed value is.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
