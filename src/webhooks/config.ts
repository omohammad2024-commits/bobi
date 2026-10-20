/**
 * Outbound webhook configuration.
 *
 * Destinations are owner-configured (`.env` / process environment), the same
 * owner-only config surface as every other secret in this bot. The operator
 * is trusted to point webhooks at their own endpoints — but the config still
 * validates what it can, because a mistyped or pasted URL should never
 * silently downgrade security.
 *
 * Fail-closed rules:
 * - URL set without a secret  -> webhooks stay OFF (never unsigned sends).
 * - URL that is not http/https -> dropped.
 * - URL with embedded credentials (userinfo) -> dropped, so no credential
 *   can leak into logs or the wire via the URL itself.
 */
export interface WebhookConfig {
  /** True only when at least one valid URL and a non-empty secret exist. */
  readonly enabled: boolean;
  /** Validated destination URLs, in configuration order. */
  readonly urls: readonly string[];
  /**
   * Shared HMAC-SHA256 secret.
   *
   * Never logged and never written to files — it only feeds the signer.
   * Empty unless `enabled` is true.
   */
  readonly secret: string;
  /** Operator-facing reason webhooks are off; undefined when enabled. */
  readonly disabledReason: string | undefined;
}

/**
 * Read webhook config from the environment (an injectable record, so tests
 * never touch the real process environment).
 */
export function loadWebhookConfig(
  env: Record<string, string | undefined> = process.env,
): WebhookConfig {
  const raw = (env.BOBI_WEBHOOK_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const urls: string[] = [];
  for (const candidate of raw) {
    const validated = validateWebhookUrl(candidate);
    if (validated === undefined) {
      // Deliberately not echoing the raw value: it may contain credentials
      // or a mistyped internal host. The operator can see their own .env.
      console.warn("[webhooks] Ignored invalid URL (http/https only, no credentials).");
    } else {
      urls.push(validated);
    }
  }

  if (urls.length === 0) {
    return { enabled: false, urls: [], secret: "", disabledReason: "BOBI_WEBHOOK_URL is not set." };
  }

  const secret = (env.BOBI_WEBHOOK_SECRET ?? "").trim();
  if (secret.length === 0) {
    // Fail closed: POSTing signed-event payloads without a signature is
    // worse than silence — the receiver could not authenticate them anyway.
    console.warn(
      "[webhooks] Warning: BOBI_WEBHOOK_URL is set but BOBI_WEBHOOK_SECRET is empty; " +
        "Webhooks are disabled and no requests will be sent.",
    );
    return { enabled: false, urls: [], secret: "", disabledReason: "BOBI_WEBHOOK_URL is set without BOBI_WEBHOOK_SECRET." };
  }

  return { enabled: true, urls, secret, disabledReason: undefined };
}

/**
 * Validate one destination URL.
 *
 * SSRF note: destinations are owner-configured, so the owner could already
 * point anywhere they like — validation is about catching mistakes, not
 * about distrusting the owner. We still enforce http/https (no file:, no
 * gopher:) and refuse embedded credentials, because a pasted URL with
 * `user:pass@host` would otherwise carry a secret in cleartext on every
 * delivery and into any log that prints the destination.
 */
function validateWebhookUrl(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  return parsed.toString();
}
