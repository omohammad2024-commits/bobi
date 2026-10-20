/**
 * Connection manager — the single owner of provider connection lifecycle.
 *
 * WHY THIS EXISTS: connection state used to be scattered — a keep-alive
 * agent cache inside pinned_transport, a DNS cache inside dns_guard, and
 * nothing that could warm a connection before it was needed, reap one that
 * went idle, or say how healthy a host's connections are. This module owns
 * that lifecycle in one place:
 *
 *  - The pinned `lookup` functions live here (they ARE connection
 *    establishment: they decide which validated address a socket may dial).
 *    pinned_transport re-exports them so existing imports keep working.
 *  - The DNS cache STORE lives here (`sharedDnsCache`); dns_guard keeps
 *    the resolution POLICY (classification, re-classification on hit,
 *    fail-closed rules) and delegates storage to this map.
 *  - The keep-alive agent cache lives here, keyed per host exactly as the
 *    transport used to key it, with address-rotation rules and a dedicated
 *    agent max-age (see BOBI_CONN_AGENT_MAX_AGE_MS below) that is DECOUPLED
 *    from the DNS cache TTL: address safety comes from dns_guard
 *    revalidating the address set on EVERY request plus agentFor rebuilding
 *    the agent whenever the freshly validated addressesKey differs — not
 *    from expiring the agent on the DNS TTL.
 *  - Warm-up (preconnect): resolve + open a real connection ahead of the
 *    first request, so a failover switch or a cold start does not pay the
 *    full TCP+TLS handshake on the user's latency budget.
 *  - Idle reaping: pooled agents idle past BOBI_CONN_IDLE_MS (default
 *    300000) are destroyed and rebuilt cleanly on next use. The reaper
 *    timer is unref'd — it never keeps the process alive.
 *  - Per-host stats (in-memory only): connect count, agent-reuse count,
 *    last request latency, last error kind. Surfaced through ProbeResult
 *    for the panel; never persisted, never contains addresses or keys.
 *
 * SECURITY POSTURE IS UNCHANGED: sockets are still created with a lookup
 * that returns ONLY the addresses dns_guard validated, TLS still verifies
 * the configured hostname, and warm() only accepts an already-resolved
 * target (a ResolvedTarget from dns_guard) — it never resolves or trusts
 * a hostname on its own.
 *
 * SWITCHES:
 *  - BOBI_CONN_MANAGER=0 — the manager steps aside: no warm-up, no
 *    background probes (the health service checks this switch), no
 *    failover pre-warm. The agent cache keeps its pre-manager semantics
 *    (it is the same code, now housed here). Default: ON.
 *  - BOBI_KEEPALIVE=0 — no connection pooling at all (agentFor returns
 *    undefined; the transport then passes `agent: false`). Unchanged.
 *  - BOBI_DNS_CACHE_MS — DNS TTL, read by dns_guard. It no longer bounds
 *    keep-alive agent lifetime (see BOBI_CONN_AGENT_MAX_AGE_MS).
 *  - BOBI_CONN_AGENT_MAX_AGE_MS — keep-alive agent max-age, default
 *    300000 (5 min), clamped to [30000, 3600000]. Decoupled from the DNS
 *    TTL: dns_guard revalidates addresses on every request and agentFor
 *    rebuilds on an addressesKey mismatch, so a longer-lived agent stays
 *    pinned only to freshly validated addresses.
 *  - BOBI_CONN_IDLE_MS — idle-reap threshold, default 300000.
 */
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { AiError } from "./provider";

/** Env var that disables the connection manager's active features. Default: ON. */
export const CONN_MANAGER_ENV_VAR = "BOBI_CONN_MANAGER";
/** Env var overriding the idle-reap threshold, ms. Default 300000. */
export const CONN_IDLE_MS_ENV_VAR = "BOBI_CONN_IDLE_MS";
/** Env var overriding the keep-alive agent max-age, ms. Default 300000. */
export const CONN_AGENT_MAX_AGE_MS_ENV_VAR = "BOBI_CONN_AGENT_MAX_AGE_MS";

/** Default idle threshold after which a pooled agent is reaped, ms. */
export const DEFAULT_CONN_IDLE_MS = 300_000;
/** Default max-age of a pooled keep-alive agent, ms (5 min). */
export const DEFAULT_CONN_AGENT_MAX_AGE_MS = 300_000;
/** Floor for the agent max-age, ms — avoids pathological churn. */
export const MIN_CONN_AGENT_MAX_AGE_MS = 30_000;
/** Ceiling for the agent max-age, ms (1 h). */
export const MAX_CONN_AGENT_MAX_AGE_MS = 3_600_000;

/** True unless BOBI_CONN_MANAGER is set to a falsy value. */
export function connectionManagerEnabled(): boolean {
  const raw = process.env[CONN_MANAGER_ENV_VAR];
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/** Idle-reap threshold, ms. Invalid or non-positive → the default. */
export function connIdleMs(): number {
  const raw = process.env[CONN_IDLE_MS_ENV_VAR];
  if (raw !== undefined) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_CONN_IDLE_MS;
}

/** Clamp an agent max-age candidate into [MIN, MAX]; invalid → default. */
function clampAgentMaxAgeMs(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONN_AGENT_MAX_AGE_MS;
  return Math.min(
    MAX_CONN_AGENT_MAX_AGE_MS,
    Math.max(MIN_CONN_AGENT_MAX_AGE_MS, Math.floor(n)),
  );
}

/**
 * Keep-alive agent max-age, ms. Invalid or non-positive → the default
 * (300000); valid values are clamped to [30000, 3600000] so a tiny env
 * value cannot cause pathological agent churn and a huge one cannot pin
 * an agent (and its sockets) effectively forever. This lifetime is
 * decoupled from the DNS TTL — see the module header.
 */
export function connAgentMaxAgeMs(): number {
  const raw = process.env[CONN_AGENT_MAX_AGE_MS_ENV_VAR];
  if (raw !== undefined) return clampAgentMaxAgeMs(Number(raw));
  return DEFAULT_CONN_AGENT_MAX_AGE_MS;
}

/** True unless BOBI_KEEPALIVE=0. Same rule the transport always applied. */
function keepAliveEnabled(): boolean {
  return process.env.BOBI_KEEPALIVE !== "0";
}

/**
 * DNS TTL read with dns_guard's exact env semantics (BOBI_DNS_CACHE_MS:
 * unset → 60000; not a finite number > 0 → 0). Retained for compatibility
 * with the ConnectionManagerOptions injection seam only — it NO LONGER
 * bounds keep-alive agent lifetime. Agent lifetime is governed by
 * connAgentMaxAgeMs(); address safety is provided by dns_guard
 * revalidating the address set on every request and by agentFor
 * rebuilding the agent whenever the validated addressesKey changes.
 */
function dnsTtlMs(): number {
  const raw = process.env.BOBI_DNS_CACHE_MS;
  if (raw === undefined) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* ------------------------------------------------------------------ */
/* Pinned lookup (moved from pinned_transport; re-exported there).     */
/* ------------------------------------------------------------------ */

/**
 * The `lookup` handed to `node:http`/`node:https`.
 *
 * Verified call shape on this runtime: `(hostname, options, callback)` with
 * `options.all === true`. The Node-compat surface also accepts the older
 * `(options, callback)` form, so both are handled. Either way the answer is
 * ONLY the validated addresses — the system resolver is never consulted for
 * this connection, which is what closes the rebinding race.
 */
export function pinnedLookup(addresses: readonly string[]): (...args: unknown[]) => void {
  const familyOf = (address: string): number => (address.includes(":") ? 6 : 4);
  const isV6 = (address: string): boolean => address.includes(":");

  return (...args: unknown[]): void => {
    const cb = args[args.length - 1];
    if (typeof cb !== "function") {
      // A signature this code does not understand must not fall back to a
      // system lookup; failing here is the fail-closed behaviour. The throw
      // propagates to the promise executor, so it becomes a rejection.
      throw new Error("unsupported lookup callback shape");
    }

    const options = args.find(
      (a): a is { all?: boolean; family?: number } => typeof a === "object" && a !== null,
    );
    const wantsAll = options?.all === true;
    // Observed on this runtime: `{family: 6, hints: 0}` with no `all` flag, in
    // which case the scalar (err, address, family) form is expected.
    const family = typeof options?.family === "number" ? options.family : 0;

    const eligible = addresses.filter((address) => {
      if (family === 4) return !isV6(address);
      if (family === 6) return isV6(address);
      return true;
    });

    if (eligible.length === 0) {
      // The caller asked for a family this resolution did not provide. Node's
      // own resolver reports an error here, and returning an address of the
      // wrong family would silently violate the request.
      (cb as Function)(new Error("no pinned address for requested family"));
      return;
    }

    if (wantsAll) {
      (cb as Function)(
        null,
        eligible.map((address) => ({ address, family: familyOf(address) })),
      );
      return;
    }
    const first = eligible[0]!;
    (cb as Function)(null, first, familyOf(first));
  };
}

/**
 * The pinned lookup, preferring the `all` form.
 *
 * This exists because of a REAL failure observed in production: a DNS answer
 * set routinely contains addresses that accept a TCP connection and then
 * never respond — Google's `generativelanguage.googleapis.com` resolved to
 * eight A records, the first of which black-holed every request while the
 * second answered fine. Handing Node a SINGLE address made the request die
 * on a timeout, even though working addresses were in the same answer set.
 *
 * Node's `net.connect` treats a list from the `all` form as a fallback
 * chain: it advances to the next address when a connection attempt fails.
 * That is exactly the behaviour needed here, and it does NOT widen the
 * security boundary — every address in the list was resolved and classified
 * by `dns_guard`, so the socket still cannot reach anything that was not
 * approved.
 *
 * The single-address form remains as the fallback for a runtime that calls
 * the lookup without `all`, since dropping it would break those runtimes.
 */
export function pinnedLookupAll(addresses: readonly string[]): (...args: unknown[]) => void {
  const scalar = pinnedLookup(addresses);

  return (...args: unknown[]): void => {
    const options = args.find(
      (a): a is { all?: boolean; family?: number } => typeof a === "object" && a !== null,
    );
    // Only the `all` shape is handled here; anything else defers to the scalar
    // implementation so both call conventions keep working.
    if (options?.all !== true) {
      scalar(...args);
      return;
    }

    const cb = args[args.length - 1];
    if (typeof cb !== "function") {
      throw new Error("unsupported lookup callback shape");
    }

    const family = typeof options.family === "number" ? options.family : 0;
    const eligible = addresses.filter((address) => {
      const isV6 = address.includes(":");
      if (family === 4) return !isV6;
      if (family === 6) return isV6;
      return true;
    });

    if (eligible.length === 0) {
      (cb as Function)(new Error("no pinned address for requested family"));
      return;
    }

    (cb as Function)(
      null,
      eligible.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
  };
}

/* ------------------------------------------------------------------ */
/* Shared DNS cache store (storage delegated by dns_guard).            */
/* ------------------------------------------------------------------ */

/**
 * One stored DNS resolution. The shape is dns_guard's cache entry exactly;
 * dns_guard owns the policy (what may be stored, re-classification on
 * every hit, eviction bound) and this module owns the storage, so the
 * connection layer has one view of name → validated addresses.
 */
export interface SharedDnsCacheEntry {
  addresses: string[];
  baseUrl: string;
  expiresAt: number;
}

/** The DNS cache store. dns_guard reads/writes through this map. */
export const sharedDnsCache = new Map<string, SharedDnsCacheEntry>();

/* ------------------------------------------------------------------ */
/* Connection manager.                                                 */
/* ------------------------------------------------------------------ */

/** Per-host connection statistics. In-memory only; no addresses, no keys. */
export interface HostConnectionStats {
  /** Host key: scheme://hostname:port|public|local. */
  host: string;
  /** Pooled agents created for this host (≈ fresh connection pools). */
  connectCount: number;
  /** Requests handed an already-pooled agent for this host. */
  reusedCount: number;
  /** Latency of the most recent completed request, ms. */
  lastLatencyMs?: number;
  /** AiError kind of the most recent failed request, if it failed. */
  lastErrorKind?: string;
  /** Unix ms of the last connection activity for this host. */
  lastActivityAt: number;
}

/** The compact per-provider connection view the health surface exposes. */
export interface ConnectionStatsView {
  /** Requests that reused a pooled connection for this provider's host. */
  reused: number;
  /** Latency of the most recent request to this host, ms. */
  lastLatencyMs?: number;
  /** "warm" while the host has a live pooled connection inside the idle window. */
  state: "warm" | "cold";
}

/** An already-resolved target, as produced by dns_guard.resolveTarget. */
export interface WarmTarget {
  baseUrl: string;
  addresses: readonly string[];
  allowLocalTargets: boolean;
}

/**
 * Opens one real connection through a pooled agent and drains the response.
 * Injected in tests; the default performs an actual pinned HTTP(S) GET.
 */
export type WarmConnector = (args: {
  url: URL;
  address: string;
  agent: HttpAgent | HttpsAgent;
  timeoutMs: number;
}) => Promise<void>;

export interface ConnectionManagerOptions {
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Idle-reap threshold override, ms. */
  idleMs?: number;
  /** Injectable kill switches, for deterministic tests. */
  enabled?: () => boolean;
  keepAliveEnabled?: () => boolean;
  /**
   * Injectable DNS TTL, retained for compatibility. It no longer bounds
   * agent lifetime (see agentMaxAgeMs); existing callers/tests may keep
   * passing it and it is simply ignored for lifetime decisions.
   */
  dnsTtlMs?: () => number;
  /** Injectable agent max-age, ms, for deterministic tests. */
  agentMaxAgeMs?: () => number;
  /** Injectable warm-up connector, for deterministic tests. */
  connector?: WarmConnector;
  /** Test-only: never start the background reaper timer. */
  disableReaper?: boolean;
}

interface HostEntry {
  agent: HttpAgent | HttpsAgent;
  createdAt: number;
  addressesKey: string;
  lastActivityAt: number;
  lastWarmAt?: number;
  connectCount: number;
  reusedCount: number;
  lastLatencyMs?: number;
  lastErrorKind?: string;
}

/** Cap so a long-lived process cannot accumulate agents forever. */
const AGENT_MAX_ENTRIES = 32;

/** Warm-up gets a short budget: it must never outwait a real request. */
const WARM_TIMEOUT_MS = 5_000;

/**
 * The default warm connector: a plain GET of the target's base URL through
 * the pooled agent, pinned to ONE validated address. Any HTTP status counts
 * as success — the point is the established connection (TCP + TLS), not
 * the response; the body is drained so the socket returns to the pool.
 */
const defaultConnector: WarmConnector = ({ url, address, agent, timeoutMs }) => {
  const secure = url.protocol === "https:";
  const requestFn = secure ? httpsRequest : httpRequest;
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  return new Promise<void>((resolve, reject) => {
    const outgoing = requestFn({
      hostname: url.hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "*/*" },
      lookup: pinnedLookup([address]),
      agent,
      servername: secure ? url.hostname : undefined,
    } as never);
    const timer = setTimeout(() => {
      outgoing.destroy();
      reject(new AiError("timeout", "Warm-up did not complete in time."));
    }, Math.max(1, timeoutMs));
    outgoing.on("error", () => {
      clearTimeout(timer);
      reject(new AiError("network", "Warm-up could not connect."));
    });
    outgoing.on("response", (res) => {
      res.on("data", () => {});
      res.on("error", () => {
        clearTimeout(timer);
        reject(new AiError("network", "Warm-up connection failed."));
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    outgoing.end();
  });
};

export class ConnectionManager {
  private readonly now: () => number;
  private readonly idleMsOverride: number | undefined;
  private readonly enabledFn: () => boolean;
  private readonly keepAliveFn: () => boolean;
  // Retained for compatibility with the dnsTtlMs injection seam; it no
  // longer bounds agent lifetime (agentMaxAgeFn does).
  private readonly dnsTtlFn: () => number;
  private readonly agentMaxAgeFn: () => number;
  private readonly connector: WarmConnector;
  private readonly entries = new Map<string, HostEntry>();
  private reaper: ReturnType<typeof setInterval> | undefined;

  constructor(opts: ConnectionManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleMsOverride = opts.idleMs;
    this.enabledFn = opts.enabled ?? connectionManagerEnabled;
    this.keepAliveFn = opts.keepAliveEnabled ?? keepAliveEnabled;
    this.dnsTtlFn = opts.dnsTtlMs ?? dnsTtlMs;
    this.agentMaxAgeFn = opts.agentMaxAgeMs ?? connAgentMaxAgeMs;
    this.connector = opts.connector ?? defaultConnector;
    if (opts.disableReaper === true) {
      // Tests drive reapIdle() directly; no timer is ever started.
      this.reaper = undefined;
      this.reaperDisabled = true;
    }
  }

  private reaperDisabled = false;

  /** Idle threshold in effect (option override wins over the env). */
  private idleMs(): number {
    return this.idleMsOverride ?? connIdleMs();
  }

  /**
   * Agent max-age in effect (option override wins over the env), clamped
   * to [MIN_CONN_AGENT_MAX_AGE_MS, MAX_CONN_AGENT_MAX_AGE_MS] with the
   * default for invalid values — the same policy connAgentMaxAgeMs()
   * applies to the env, so an injected seam cannot cause churn either.
   */
  private agentMaxAgeMs(): number {
    return clampAgentMaxAgeMs(this.agentMaxAgeFn());
  }

  /** The cache key for a host — identical to the transport's legacy key. */
  hostKey(url: URL, allowLocalTargets: boolean): string {
    const secure = url.protocol === "https:";
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    return `${secure ? "https" : "http"}://${url.hostname}:${port}|${allowLocalTargets ? "local" : "public"}`;
  }

  /**
   * The keep-alive agent for this target, or undefined when pooling is off.
   *
   * An existing agent is returned only while it is inside its max-age
   * (BOBI_CONN_AGENT_MAX_AGE_MS, default 5 min — decoupled from the DNS
   * TTL), its address set still matches the addresses THIS request was
   * validated for, and it has not been idle past the reap threshold; any
   * expiry, rotation, or idle timeout destroys it and builds a fresh
   * one. Address safety does not depend on the max-age: dns_guard
   * revalidates the address set on every request, and an addressesKey
   * mismatch rebuilds immediately even inside the max-age. This holds
   * also when the DNS TTL is 0 ("resolve every request" mode): each
   * request's fresh resolution is compared via addressesKey, so pinning
   * stays honest while the socket stays warm.
   *
   * CALLER CONTRACT (M12): `addresses` must be the FULL address set
   * dns_guard validated for this host on this request — never a single
   * fallback step's address. Keying by a per-attempt subset made every
   * address fallback destroy the pooled agent and its warm sockets; the
   * per-attempt selection itself is the caller's per-request lookup,
   * which stays pinned to the one address being attempted.
   */
  agentFor(
    url: URL,
    addresses: readonly string[],
    secure: boolean,
    allowLocalTargets: boolean,
  ): (HttpAgent | HttpsAgent) | undefined {
    if (!this.keepAliveFn()) return undefined;
    const key = this.hostKey(url, allowLocalTargets);
    // Decoupled from the DNS TTL (R2): the agent lives for its max-age.
    // When DNS caching is disabled (TTL 0, "resolve every request"), the
    // max-age still applies — addressesKey below is compared against each
    // request's fresh resolution, so a changed set rebuilds immediately.
    const agentMaxAge = this.agentMaxAgeMs();
    const addressesKey = [...addresses].sort().join(",");
    const now = this.now();

    const hit = this.entries.get(key);
    if (
      hit !== undefined &&
      hit.addressesKey === addressesKey &&
      now - hit.createdAt < agentMaxAge &&
      now - hit.lastActivityAt <= this.idleMs()
    ) {
      hit.reusedCount += 1;
      hit.lastActivityAt = now;
      return hit.agent;
    }
    if (hit !== undefined) {
      hit.agent.destroy();
      this.entries.delete(key);
    }
    if (this.entries.size >= AGENT_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.get(oldest)?.agent.destroy();
        this.entries.delete(oldest);
      }
    }

    const lookup = pinnedLookupAll(addresses);
    const agent = secure
      ? new HttpsAgent({ keepAlive: true, maxSockets: 4, lookup })
      : new HttpAgent({ keepAlive: true, maxSockets: 4, lookup });
    this.entries.set(key, {
      agent,
      createdAt: now,
      addressesKey,
      lastActivityAt: now,
      connectCount: 1,
      reusedCount: 0,
    });
    this.startReaper();
    return agent;
  }

  /**
   * Record one completed request against its host (latency, and the error
   * kind when it failed). Called by the transport for every attempt; a
   * success clears the previous error kind.
   */
  noteOutcome(
    url: URL,
    allowLocalTargets: boolean,
    outcome: { latencyMs: number; errorKind?: string },
  ): void {
    const entry = this.entries.get(this.hostKey(url, allowLocalTargets));
    if (entry === undefined) return;
    entry.lastLatencyMs = Math.max(0, Math.round(outcome.latencyMs));
    entry.lastActivityAt = this.now();
    if (outcome.errorKind !== undefined) entry.lastErrorKind = outcome.errorKind;
    else delete entry.lastErrorKind;
  }

  /**
   * Warm a resolved target: establish a real connection through the pooled
   * agent so the first actual request skips TCP+TLS setup. Best-effort by
   * contract — failures are recorded in stats and reported as `false`,
   * never thrown. No-op (false) when the manager or pooling is off.
   */
  async warm(target: WarmTarget): Promise<boolean> {
    if (!this.enabledFn() || !this.keepAliveFn()) return false;
    let url: URL;
    try {
      url = new URL(target.baseUrl);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const secure = url.protocol === "https:";
    const key = this.hostKey(url, target.allowLocalTargets);

    // ONE agent for the host, keyed by the FULL validated address set —
    // exactly the key a real request uses (M12). Building it per address
    // destroyed the previous attempt's agent (and its warm socket) on
    // every fallback step; the per-address fallback happens through the
    // connector calls below, all sharing this one agent. The connector
    // still pins each warm-up connection to a single validated address
    // via its own lookup, so the address set never widens.
    const agent = this.agentFor(url, target.addresses, secure, target.allowLocalTargets);
    if (agent === undefined) return false;
    for (const address of target.addresses) {
      const startedAt = this.now();
      try {
        await this.connector({ url, address, agent, timeoutMs: WARM_TIMEOUT_MS });
        const entry = this.entries.get(key);
        if (entry !== undefined) {
          entry.lastWarmAt = this.now();
          entry.lastActivityAt = this.now();
          entry.lastLatencyMs = Math.max(0, Math.round(this.now() - startedAt));
          delete entry.lastErrorKind;
        }
        return true;
      } catch (err) {
        const entry = this.entries.get(key);
        if (entry !== undefined) {
          entry.lastErrorKind = err instanceof AiError ? err.kind : "network";
        }
        // Try the next validated address, like the transport does.
      }
    }
    return false;
  }

  /** True when this host currently holds a live, recently-used pooled agent. */
  isWarm(url: URL, allowLocalTargets: boolean): boolean {
    const entry = this.entries.get(this.hostKey(url, allowLocalTargets));
    if (entry === undefined) return false;
    return this.now() - entry.lastActivityAt <= this.idleMs();
  }

  /** Snapshot of every host's stats (oldest first). */
  stats(): HostConnectionStats[] {
    const out: HostConnectionStats[] = [];
    for (const [host, e] of this.entries) {
      out.push({
        host,
        connectCount: e.connectCount,
        reusedCount: e.reusedCount,
        ...(e.lastLatencyMs !== undefined ? { lastLatencyMs: e.lastLatencyMs } : {}),
        ...(e.lastErrorKind !== undefined ? { lastErrorKind: e.lastErrorKind } : {}),
        lastActivityAt: e.lastActivityAt,
      });
    }
    return out;
  }

  /** The compact health-surface view for one provider base URL, when known. */
  statsForUrl(baseUrl: string, allowLocalTargets: boolean): ConnectionStatsView | undefined {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return undefined;
    }
    const entry = this.entries.get(this.hostKey(url, allowLocalTargets));
    if (entry === undefined) return undefined;
    const warm = this.now() - entry.lastActivityAt <= this.idleMs();
    return {
      reused: entry.reusedCount,
      ...(entry.lastLatencyMs !== undefined ? { lastLatencyMs: entry.lastLatencyMs } : {}),
      state: warm ? "warm" : "cold",
    };
  }

  /**
   * Destroy and drop every agent idle past the threshold. Called by the
   * background reaper and directly by tests. Returns how many were reaped.
   */
  reapIdle(): number {
    const now = this.now();
    let reaped = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastActivityAt > this.idleMs()) {
        entry.agent.destroy();
        this.entries.delete(key);
        reaped += 1;
      }
    }
    return reaped;
  }

  /** How many pooled agents currently exist. */
  agentCount(): number {
    return this.entries.size;
  }

  /** Destroy every agent and forget every host. Test/shutdown helper. */
  reset(): void {
    for (const entry of this.entries.values()) entry.agent.destroy();
    this.entries.clear();
    this.stopReaper();
  }

  /** Start the idle reaper (lazily, on first pooled agent). Unref'd. */
  private startReaper(): void {
    if (this.reaperDisabled || this.reaper !== undefined) return;
    const every = Math.min(this.idleMs(), 30_000);
    this.reaper = setInterval(() => this.reapIdle(), Math.max(1, every));
    // The reaper must never keep a process (or a test run) alive.
    this.reaper.unref?.();
  }

  private stopReaper(): void {
    if (this.reaper !== undefined) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
  }
}

/** The process-wide connection manager used by the transport and wiring. */
export const connectionManager = new ConnectionManager();
