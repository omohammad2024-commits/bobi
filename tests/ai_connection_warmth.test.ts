/**
 * R2: keep-alive agent lifetime is decoupled from the DNS TTL.
 *
 * Regression: agentFor used to reuse a pooled agent only while
 * `now - createdAt < agentTtl`, where agentTtl mirrored the DNS cache
 * TTL (default 60s). Human-paced chat turns are minutes apart, so nearly
 * every turn destroyed the agent and paid a fresh TCP+TLS handshake.
 * The fix gives agents a dedicated max-age (BOBI_CONN_AGENT_MAX_AGE_MS,
 * default 5 min, clamped to [30s, 1h]); address safety is unchanged
 * because dns_guard revalidates the address set on every request and
 * agentFor rebuilds whenever the validated addressesKey differs.
 *
 * Everything is hermetic: fake clock, injected seams, no real network.
 */
import { describe, expect, test } from "bun:test";
import {
  CONN_AGENT_MAX_AGE_MS_ENV_VAR,
  ConnectionManager,
  DEFAULT_CONN_AGENT_MAX_AGE_MS,
  DEFAULT_CONN_IDLE_MS,
  MAX_CONN_AGENT_MAX_AGE_MS,
  MIN_CONN_AGENT_MAX_AGE_MS,
  connAgentMaxAgeMs,
  connIdleMs,
} from "../src/ai/connection_manager";

const EXAMPLE_URL = new URL("https://api.example.com/v1");
const ADDR = ["93.184.216.34"];

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function buildManager(
  clock = fakeClock(),
  overrides: { idleMs?: number; agentMaxAgeMs?: number; dnsTtlMs?: number } = {},
) {
  const manager = new ConnectionManager({
    now: clock.now,
    idleMs: overrides.idleMs ?? 600_000,
    dnsTtlMs: () => overrides.dnsTtlMs ?? 60_000,
    agentMaxAgeMs: () => overrides.agentMaxAgeMs ?? 300_000,
    disableReaper: true,
    connector: async () => {},
  });
  return { manager, clock };
}

describe("agent warmth decoupled from DNS TTL (R2)", () => {
  test("(a) agent built at t0 is reused at t0+61s and t0+240s with DNS TTL 60s", () => {
    const { manager, clock } = buildManager(fakeClock(), { idleMs: 300_000 });
    const first = manager.agentFor(EXAMPLE_URL, ADDR, true, false);
    expect(first).toBeDefined();

    clock.advance(61_000); // past the old 60s DNS-TTL bound
    expect(manager.agentFor(EXAMPLE_URL, ADDR, true, false)).toBe(first);

    clock.advance(179_000); // t0+240s total
    expect(manager.agentFor(EXAMPLE_URL, ADDR, true, false)).toBe(first);
    expect(manager.stats()[0]!.reusedCount).toBe(2);
    manager.reset();
  });

  test("(a2) DNS TTL 0 ('resolve every request') still applies the agent max-age", () => {
    const { manager, clock } = buildManager(fakeClock(), {
      idleMs: 300_000,
      dnsTtlMs: 0,
    });
    const first = manager.agentFor(EXAMPLE_URL, ADDR, true, false);
    clock.advance(61_000);
    expect(manager.agentFor(EXAMPLE_URL, ADDR, true, false)).toBe(first);
    manager.reset();
  });

  test("(b) agent is destroyed/rebuilt after the max-age (t0+301s)", () => {
    const { manager, clock } = buildManager(fakeClock(), { idleMs: 600_000 });
    const first = manager.agentFor(EXAMPLE_URL, ADDR, true, false);

    clock.advance(299_000);
    expect(manager.agentFor(EXAMPLE_URL, ADDR, true, false)).toBe(first);

    // lastActivity was refreshed by the call above; createdAt was not,
    // so at t0+301s the max-age (not idle) forces the rebuild.
    clock.advance(2_000);
    const rebuilt = manager.agentFor(EXAMPLE_URL, ADDR, true, false);
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(first);
    expect(manager.agentCount()).toBe(1);
    manager.reset();
  });

  test("(c) a changed address set rebuilds immediately even inside the max-age", () => {
    const { manager, clock } = buildManager();
    const first = manager.agentFor(EXAMPLE_URL, ADDR, true, false);
    clock.advance(10_000); // well inside both max-age and idle window
    const rotated = manager.agentFor(EXAMPLE_URL, ["93.184.216.35"], true, false);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(first);
    expect(manager.agentCount()).toBe(1);
    manager.reset();
  });

  test("(d) idle reap still applies per connIdleMs semantics", () => {
    const { manager, clock } = buildManager(fakeClock(), { idleMs: 60_000 });
    const first = manager.agentFor(EXAMPLE_URL, ADDR, true, false);
    clock.advance(60_001);
    expect(manager.reapIdle()).toBe(1);
    expect(manager.agentCount()).toBe(0);

    const second = manager.agentFor(EXAMPLE_URL, ADDR, true, false);
    expect(second).not.toBe(first);

    // Idle expiry inside agentFor: no reap call needed.
    clock.advance(60_001);
    const third = manager.agentFor(EXAMPLE_URL, ADDR, true, false);
    expect(third).toBeDefined();
    expect(third).not.toBe(second);
    manager.reset();
  });

  test("injected agentMaxAgeMs is clamped to the floor (no pathological churn)", () => {
    const { manager, clock } = buildManager(fakeClock(), {
      idleMs: 600_000,
      agentMaxAgeMs: 1_000, // below MIN → effective 30_000
    });
    const first = manager.agentFor(EXAMPLE_URL, ADDR, true, false);
    clock.advance(20_000);
    expect(manager.agentFor(EXAMPLE_URL, ADDR, true, false)).toBe(first);
    clock.advance(11_000); // t0+31s > clamped 30s max-age
    expect(manager.agentFor(EXAMPLE_URL, ADDR, true, false)).not.toBe(first);
    manager.reset();
  });
});

describe("connAgentMaxAgeMs env/default reader", () => {
  test("(e) defaults, garbage, and clamping", async () => {
    await withEnv({ [CONN_AGENT_MAX_AGE_MS_ENV_VAR]: undefined }, () => {
      expect(connAgentMaxAgeMs()).toBe(300_000);
      expect(DEFAULT_CONN_AGENT_MAX_AGE_MS).toBe(300_000);
    });
    await withEnv({ [CONN_AGENT_MAX_AGE_MS_ENV_VAR]: "120000" }, () => {
      expect(connAgentMaxAgeMs()).toBe(120_000);
    });
    await withEnv({ [CONN_AGENT_MAX_AGE_MS_ENV_VAR]: "bogus" }, () => {
      expect(connAgentMaxAgeMs()).toBe(300_000);
    });
    await withEnv({ [CONN_AGENT_MAX_AGE_MS_ENV_VAR]: "0" }, () => {
      expect(connAgentMaxAgeMs()).toBe(300_000);
    });
    await withEnv({ [CONN_AGENT_MAX_AGE_MS_ENV_VAR]: "-5" }, () => {
      expect(connAgentMaxAgeMs()).toBe(300_000);
    });
    await withEnv({ [CONN_AGENT_MAX_AGE_MS_ENV_VAR]: "1000" }, () => {
      expect(connAgentMaxAgeMs()).toBe(MIN_CONN_AGENT_MAX_AGE_MS);
      expect(MIN_CONN_AGENT_MAX_AGE_MS).toBe(30_000);
    });
    await withEnv({ [CONN_AGENT_MAX_AGE_MS_ENV_VAR]: "99999999" }, () => {
      expect(connAgentMaxAgeMs()).toBe(MAX_CONN_AGENT_MAX_AGE_MS);
      expect(MAX_CONN_AGENT_MAX_AGE_MS).toBe(3_600_000);
    });
  });

  test("(e2) idle default raised to 300000 so the reaper does not kill warm agents first", async () => {
    expect(DEFAULT_CONN_IDLE_MS).toBe(300_000);
    await withEnv({ BOBI_CONN_IDLE_MS: undefined }, () => {
      expect(connIdleMs()).toBe(300_000);
    });
    // An explicit env value still wins.
    await withEnv({ BOBI_CONN_IDLE_MS: "45000" }, () => {
      expect(connIdleMs()).toBe(45_000);
    });
  });
});
