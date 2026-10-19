/**
 * Connection-target validation for AI adapters.
 *
 * The base URL is owner-supplied and therefore untrusted: it can point at an
 * internal service, use a scheme the fetch stack would reject, hide a
 * credential in the userinfo, or redirect a request somewhere else entirely.
 * This module turns such a string into a validated target, or rejects it.
 *
 * SSRF posture:
 * - Only http/https are accepted.
 * - No userinfo (user:pass@host) — a credential in the URL is never allowed.
 * - Loopback and private/unicast-link-local hosts are refused unless the
 *   deployment explicitly allows local targets, which is opt-in and meant for
 *   a self-hosted service on the same machine.
 */
import { AiError } from "./provider";
import type { AdapterTarget } from "./adapter";

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** Hosts that must never be reachable from a remote-facing provider. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "127.0.0.1" ||
    h.startsWith("127.") ||
    h === "::1" ||
    h === "0.0.0.0"
  );
}

/**
 * True when the host is inside a private or link-local range:
 * 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, fc00::/7,
 * fe80::/10 and the IPv6 loopback.
 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(h)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a = 0, b = 0] = v4.slice(1).map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("fe80")) return true;
  if (h.startsWith("::")) return true;
  return false;
}

export interface ValidateTargetOptions {
  /** Explicitly allow loopback/private hosts (a self-hosted local install). */
  allowLocalTargets?: boolean;
}

/**
 * Validate a target for an outbound AI request.
 *
 * Returns the trimmed base URL and key, or throws AiError("invalid_response")
 * with a message that never includes the value itself.
 */
export function validateTarget(
  target: AdapterTarget,
  opts: ValidateTargetOptions = {},
): { baseUrl: string } {
  const raw = typeof target.baseUrl === "string" ? target.baseUrl.trim() : "";
  if (raw.length === 0) {
    throw new AiError("invalid_response", "Service address is not set.");
  }
  if (raw.length > 512) {
    throw new AiError("invalid_response", "Service address is too long.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiError("invalid_response", "Service address is invalid.");
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new AiError("invalid_response", "Service address must be http or https.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    // A credential inside the URL would appear in logs and error messages.
    throw new AiError("invalid_response", "Service address must not contain a username.");
  }
  if (url.hostname.length === 0) {
    throw new AiError("invalid_response", "Service address has no host.");
  }

  if (!opts.allowLocalTargets && isPrivateHost(url.hostname)) {
    throw new AiError(
      "invalid_response",
      "The service address is internal or private and is not accepted for remote connections.",
    );
  }

  return { baseUrl: url.toString().replace(/\/+$/, "") };
}
