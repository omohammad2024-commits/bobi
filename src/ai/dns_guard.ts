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
 * A short-TTL in-memory cache avoids re-resolving the same name on every
 * request (DNS is a large slice of provider "ping"). Rebinding stays closed:
 * entries live at most BOBI_DNS_CACHE_MS (default 60s), failed lookups are
 * never cached, and every cached address is re-classified against the policy
 * on EVERY hit, so a cache entry can never bypass a rule it could not pass
 * when first resolved. Setting BOBI_DNS_CACHE_MS=0 restores "resolve on
 * every request" exactly.
 *
 * Storage for the cache lives in the connection manager (`sharedDnsCache`):
 * the resolution POLICY is here, the storage is shared with the rest of the
 * connection layer.
 */
import { resolve4, resolve6 } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { AiError } from "./provider";
import { validateTarget } from "./target";
import type { AdapterTarget } from "./adapter";
import { sharedDnsCache } from "./connection_manager";

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
 * Effective DNS cache TTL in milliseconds.
 *
 * Read from the environment on every call so tests (and operators) can
 * change it without a restart: BOBI_DNS_CACHE_MS unset → 60000; a value
 * that is not a finite number > 0 → 0, which disables the cache.
 */
export function dnsCacheTtlMs(): number {
  const raw = process.env.BOBI_DNS_CACHE_MS;
  if (raw === undefined) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface DnsCacheEntry {
  addresses: string[];
  baseUrl: string;
  expiresAt: number;
}

/**
 * The cache STORAGE is owned by the connection manager (`sharedDnsCache`)
 * so the connection layer has a single view of name → validated addresses.
 * Everything policy-shaped stays here: what may be stored, the bound below,
 * and re-classification of cached addresses on every hit.
 */
const dnsCache: Map<string, DnsCacheEntry> = sharedDnsCache;

/** Bounded so a long-lived process cannot accumulate entries forever. */
const DNS_CACHE_MAX_ENTRIES = 128;

/**
 * Resolver identity for cache keys. Production always uses the default
 * resolver (key suffix ""), but tests inject their own resolvers — keying
 * entries by the resolver instance keeps one test's cached answer from
 * satisfying another test's different resolver.
 */
const resolverIds = new WeakMap<DnsResolver, number>();
let nextResolverId = 1;

function dnsCacheKey(
  hostname: string,
  allowLocalTargets: boolean,
  resolver: DnsResolver | undefined,
): string {
  const base = `${hostname}|${allowLocalTargets ? "local" : "public"}`;
  if (resolver === undefined) return base;
  let id = resolverIds.get(resolver);
  if (id === undefined) {
    id = nextResolverId++;
    resolverIds.set(resolver, id);
  }
  return `${base}|r${id}`;
}

/** Test-only: drop every cached resolution (isolates tests from each other). */
export function clearDnsCache(): void {
  dnsCache.clear();
}

/**
 * Test-only: inject a cache entry. Lets tests simulate a poisoned set and
 * verify the guard re-classifies cached addresses on every hit.
 */
export function __injectDnsCacheEntry(
  hostname: string,
  allowLocalTargets: boolean,
  baseUrl: string,
  addresses: string[],
): void {
  const ttl = dnsCacheTtlMs();
  dnsCache.set(dnsCacheKey(hostname, allowLocalTargets, undefined), {
    addresses: [...addresses],
    baseUrl,
    expiresAt: Date.now() + (ttl > 0 ? ttl : 60_000),
  });
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

  // Cache hit: only for non-literal hostnames (a literal IP needs no DNS),
  // only while fresh, and only for the exact same base URL (a config change
  // must not be masked by a stale entry). Cached addresses are STILL
  // re-classified below before anything is returned.
  const ttl = dnsCacheTtlMs();
  const literal = literalAddress(hostname);
  if (ttl > 0 && literal === undefined) {
    const hit = dnsCache.get(dnsCacheKey(hostname, allowLocal, opts.resolver));
    if (hit !== undefined && hit.expiresAt > Date.now() && hit.baseUrl === baseUrl) {
      for (const address of hit.addresses) {
        if (!classifyAddress(address, allowLocal).allowed) {
          throw new AiError(
            "invalid_response",
            "The service domain resolves to an internal or private address, which is not allowed.",
          );
        }
      }
      return { baseUrl: hit.baseUrl, hostname, addresses: [...hit.addresses], allowLocalTargets: allowLocal };
    }
  }

  let addresses: readonly string[];
  if (literal !== undefined) {
    addresses = [literal];
  } else {
    const resolver = opts.resolver ?? defaultResolver;
    try {
      addresses = await resolver(hostname);
    } catch {
      // A failed lookup must never be read as "safe" or "empty is fine".
      throw new AiError("invalid_response", "Failed to resolve the service domain.");
    }
    if (addresses.length === 0) {
      throw new AiError("invalid_response", "The service domain returned no address.");
    }
  }

  for (const address of addresses) {
    // The offending address (and its range) is never put in the message: it
    // is infrastructure detail a Telegram user has no business seeing.
    if (!classifyAddress(address, allowLocal).allowed) {
      throw new AiError(
        "invalid_response",
        "The service domain resolves to an internal or private address, which is not allowed.",
      );
    }
  }

  // Store a fully-validated set. Failures above throw before this point, so
  // a poisoned or failed resolution is never cached. Literal IPs are not
  // cached: they need no DNS and their validation is already free.
  if (ttl > 0 && literal === undefined) {
    if (dnsCache.size >= DNS_CACHE_MAX_ENTRIES) {
      const oldest = dnsCache.keys().next().value;
      if (oldest !== undefined) dnsCache.delete(oldest);
    }
    dnsCache.set(dnsCacheKey(hostname, allowLocal, opts.resolver), {
      addresses: [...addresses],
      baseUrl,
      expiresAt: Date.now() + ttl,
    });
  }

  return { baseUrl, hostname, addresses, allowLocalTargets: allowLocal };
}
