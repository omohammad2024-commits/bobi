/**
 * DNS-aware target validation — the layer that defeats DNS rebinding.
 *
 * `validateTarget` only inspects the hostname as written, so a name such as
 * `localtest.me` or `127-0-0-1.nip.io` passes it while resolving to loopback.
 * This module resolves the name first and classifies EVERY returned address
 * (A and AAAA) against the SSRF policy before any connection is made.
 *
 * Rules that make this effective rather than decorative:
 *  - A mixed public/private answer set is rejected: one bad address is enough.
 *  - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is unmapped and classified as IPv4.
 *  - Empty or failed resolution fails closed.
 *  - The validated addresses are handed to {@link PinnedRequestOptions}, which
 *    binds the socket to exactly them. Resolving here and then passing the
 *    hostname to an ordinary `fetch()` would leave the rebinding race open,
 *    so that composition is explicitly not used anywhere in this codebase.
 *
 * No cache is kept: the policy is "resolve on every request", which is why a
 * previous validation is never trusted indefinitely.
 */
import { resolve4, resolve6 } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { AiError } from "./provider";
import { validateTarget } from "./target";
import type { AdapterTarget } from "./adapter";

/** A resolver returns raw A/AAAA answers. Injected in tests. */
export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * What the narrow local exception permits.
 *
 * Only a same-machine or LAN deployment is in scope: loopback plus RFC1918
 * private plus IPv6 unique-local. Link-local (which is where cloud metadata
 * lives at 169.254.169.254), multicast, unspecified, broadcast, CGNAT,
 * reserved and the IPv6 transition ranges are refused even here — that is the
 * distinction that stops the exception from becoming a general SSRF bypass.
 */
const LOCAL_RANGES: ReadonlySet<string> = new Set([
  "loopback",
  "private",
  "uniqueLocal",
  // Always in scope: a public endpoint is fine whether or not local is allowed.
  "unicast",
]);

/** Public-only policy: a globally routable unicast address and nothing else. */
const PUBLIC_RANGES: ReadonlySet<string> = new Set(["unicast"]);

export interface ResolveTargetOptions {
  /** Owner opt-in for a self-hosted local/LAN endpoint. Off by default. */
  allowLocalTargets?: boolean;
  /** Injectable resolver so tests never touch real DNS. */
  resolver?: DnsResolver;
}

/** A target whose addresses have been resolved and approved. */
export interface ResolvedTarget {
  /** Normalized base URL, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** Original hostname — used for SNI and the Host header. */
  hostname: string;
  /** The validated addresses; the connection may only go to these. */
  addresses: readonly string[];
  /**
   * The policy these addresses were validated under.
   *
   * Carried so the transport can re-apply the same rule at connect time
   * instead of trusting a caller to repeat the flag correctly.
   */
  allowLocalTargets: boolean;
}

/**
 * Classify one IP address without consulting DNS.
 *
 * Exported for tests, which assert the range decisions directly.
 */
export function classifyAddress(
  address: string,
  allowLocalTargets: boolean,
): { allowed: boolean; range: string } {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address.trim());
  } catch {
    return { allowed: false, range: "unparseable" };
  }

  // An IPv4 address written as IPv6 is classified as its IPv4 form, so
  // `::ffff:169.254.169.254` cannot smuggle metadata access past the guard.
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      const v4 = v6.toIPv4Address();
      const range = v4.range();
      return { allowed: (allowLocalTargets ? LOCAL_RANGES : PUBLIC_RANGES).has(range), range };
    }
  }

  const range = parsed.range();
  return { allowed: (allowLocalTargets ? LOCAL_RANGES : PUBLIC_RANGES).has(range), range };
}

/**
 * The default resolver: query A and AAAA directly.
 *
 * `dns.resolve*` is used rather than `dns.lookup` so the answer comes from DNS
 * itself and cannot be silently replaced by a hosts-file entry.
 */
export const defaultResolver: DnsResolver = async (hostname) => {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const a of r.value) addresses.push(a);
    }
  }
  // Both families failing is not "no addresses", it is a lookup failure.
  if (addresses.length === 0 && results.every((r) => r.status === "rejected")) {
    const reason = (results[0] as PromiseRejectedResult).reason;
    throw new Error(typeof reason === "string" ? reason : (reason as Error)?.message ?? "dns failed");
  }
  return addresses;
};

/** True when the hostname is already a literal IP address. */
function literalAddress(hostname: string): string | undefined {
  const clean = hostname.replace(/^\[|\]$/g, "");
  try {
    ipaddr.parse(clean);
    return clean;
  } catch {
    return undefined;
  }
}

/**
 * Validate a target lexically, resolve it, and approve every address.
 *
 * @throws AiError("invalid_response") when the URL is malformed, the host is
 * forbidden, DNS returns nothing, or any address in the answer set is
 * forbidden. The thrown message never contains the resolved address.
 */
export async function resolveTarget(
  target: AdapterTarget,
  opts: ResolveTargetOptions = {},
): Promise<ResolvedTarget> {
  // Lexical policy first: scheme, userinfo, length, and the literal-IP check.
  const { baseUrl } = validateTarget(target, opts);
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const allowLocal = opts.allowLocalTargets === true;

  let addresses: readonly string[];
  const literal = literalAddress(hostname);
  if (literal !== undefined) {
    addresses = [literal];
  } else {
    const resolver = opts.resolver ?? defaultResolver;
    try {
      addresses = await resolver(hostname);
    } catch {
      // A failed lookup must never be read as "safe" or "empty is fine".
      throw new AiError("invalid_response", "resolve دامنهٔ سرویس ناموفق بود.");
    }
    if (addresses.length === 0) {
      throw new AiError("invalid_response", "دامنهٔ سرویس آدرسی برنگرداند.");
    }
  }

  for (const address of addresses) {
    // The offending address (and its range) is never put in the message: it
    // is infrastructure detail a Telegram user has no business seeing.
    if (!classifyAddress(address, allowLocal).allowed) {
      throw new AiError(
        "invalid_response",
        "دامنهٔ سرویس به آدرس داخلی یا خصوصی اشاره می‌کند و پذیرفته نیست.",
      );
    }
  }

  return { baseUrl, hostname, addresses, allowLocalTargets: allowLocal };
}
