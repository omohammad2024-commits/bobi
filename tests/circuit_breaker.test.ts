import { describe, expect, test } from "bun:test";
import {
  CircuitBreakerRegistry,
  breakerBaseCooldownMs,
  breakerThreshold,
  circuitBreakerEnabled,
} from "../src/ai/circuit_breaker";

/** Deterministic clock. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const P = 7;

describe("breaker state machine", () => {
  test("starts closed and allows calls", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({ now: c.now });
    expect(b.state(P).state).toBe("closed");
    expect(b.tryAcquire(P)).toBe("closed");
  });

  test("failures below the threshold keep it closed; success resets", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({ now: c.now, threshold: 3 });
    b.recordFailure(P);
    b.recordFailure(P);
    expect(b.state(P).state).toBe("closed");
    b.recordSuccess(P);
    b.recordFailure(P);
    b.recordFailure(P);
    // Success reset the count, so two more failures do not trip it.
    expect(b.state(P).state).toBe("closed");
    expect(b.state(P).consecutiveFailures).toBe(2);
  });

  test("trips at the threshold and denies during cooldown", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({ now: c.now, threshold: 3, baseCooldownMs: 30_000 });
    b.recordFailure(P);
    b.recordFailure(P);
    b.recordFailure(P);
    const v = b.state(P);
    expect(v.state).toBe("open");
    expect(v.consecutiveFailures).toBe(3);
    expect(v.nextRetryAt).toBe(c.now() + 30_000);
    expect(b.tryAcquire(P)).toBeUndefined();
  });

  test("half-open allows exactly one probe call", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({ now: c.now, threshold: 2, baseCooldownMs: 30_000 });
    b.recordFailure(P);
    b.recordFailure(P);
    c.advance(30_000);
    expect(b.state(P).state).toBe("open"); // lazy: becomes half-open on acquire
    expect(b.tryAcquire(P)).toBe("probe");
    expect(b.tryAcquire(P)).toBeUndefined(); // one probe only
  });

  test("a successful probe closes the breaker and resets the cooldown", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({ now: c.now, threshold: 2, baseCooldownMs: 30_000 });
    b.recordFailure(P);
    b.recordFailure(P);
    c.advance(30_000);
    expect(b.tryAcquire(P)).toBe("probe");
    b.recordSuccess(P);
    expect(b.state(P).state).toBe("closed");
    expect(b.state(P).consecutiveFailures).toBe(0);
    // Next opening starts at the BASE cooldown again, not doubled.
    b.recordFailure(P);
    b.recordFailure(P);
    expect(b.state(P).nextRetryAt).toBe(c.now() + 30_000);
  });

  test("a failed probe re-opens with a doubled cooldown", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({ now: c.now, threshold: 2, baseCooldownMs: 30_000 });
    b.recordFailure(P);
    b.recordFailure(P);
    c.advance(30_000);
    b.tryAcquire(P);
    b.recordFailure(P); // probe failed
    const v = b.state(P);
    expect(v.state).toBe("open");
    expect(v.cooldownMs).toBe(60_000);
    c.advance(30_000);
    expect(b.tryAcquire(P)).toBeUndefined(); // 30s not enough now
    c.advance(30_000);
    expect(b.tryAcquire(P)).toBe("probe"); // 60s elapsed
  });

  test("cooldown doubles per opening and caps at the maximum", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({
      now: c.now,
      threshold: 1,
      baseCooldownMs: 100_000,
      maxCooldownMs: 300_000,
    });
    b.recordFailure(P); // opening 1 → 100s
    expect(b.state(P).cooldownMs).toBe(100_000);
    c.advance(100_000);
    b.tryAcquire(P);
    b.recordFailure(P); // opening 2 → 200s
    expect(b.state(P).cooldownMs).toBe(200_000);
    c.advance(200_000);
    b.tryAcquire(P);
    b.recordFailure(P); // opening 3 → would be 400s, capped at 300s
    expect(b.state(P).cooldownMs).toBe(300_000);
  });

  test("releaseProbe frees the slot without recording an outcome", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({ now: c.now, threshold: 1, baseCooldownMs: 30_000 });
    b.recordFailure(P);
    c.advance(30_000);
    expect(b.tryAcquire(P)).toBe("probe");
    b.releaseProbe(P);
    expect(b.tryAcquire(P)).toBe("probe"); // slot free again
    expect(b.state(P).consecutiveFailures).toBe(1); // nothing recorded
  });

  test("onTransition fires with the right sequence", () => {
    const c = fakeClock();
    const seen: string[] = [];
    const b = new CircuitBreakerRegistry({
      now: c.now,
      threshold: 1,
      baseCooldownMs: 30_000,
      onTransition: (t) => seen.push(`${t.from}->${t.to}@${t.providerId}`),
    });
    b.recordFailure(P);
    c.advance(30_000);
    b.tryAcquire(P);
    b.recordSuccess(P);
    expect(seen).toEqual([
      `closed->open@${P}`,
      `open->half_open@${P}`,
      `half_open->closed@${P}`,
    ]);
  });

  test("a throwing onTransition never breaks the breaker", () => {
    const c = fakeClock();
    const b = new CircuitBreakerRegistry({
      now: c.now,
      threshold: 1,
      onTransition: () => { throw new Error("boom"); },
    });
    b.recordFailure(P);
    expect(b.state(P).state).toBe("open");
  });
});

describe("env configuration", () => {
  function withEnv(key: string, value: string | undefined, fn: () => void) {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }

  test("BOBI_CIRCUIT_BREAKER=0 disables", () => {
    withEnv("BOBI_CIRCUIT_BREAKER", "0", () => expect(circuitBreakerEnabled()).toBe(false));
    withEnv("BOBI_CIRCUIT_BREAKER", "off", () => expect(circuitBreakerEnabled()).toBe(false));
    withEnv("BOBI_CIRCUIT_BREAKER", undefined, () => expect(circuitBreakerEnabled()).toBe(true));
  });

  test("BOBI_BREAKER_THRESHOLD default 3, invalid falls back", () => {
    withEnv("BOBI_BREAKER_THRESHOLD", undefined, () => expect(breakerThreshold()).toBe(3));
    withEnv("BOBI_BREAKER_THRESHOLD", "5", () => expect(breakerThreshold()).toBe(5));
    withEnv("BOBI_BREAKER_THRESHOLD", "abc", () => expect(breakerThreshold()).toBe(3));
    withEnv("BOBI_BREAKER_THRESHOLD", "0", () => expect(breakerThreshold()).toBe(3));
  });

  test("BOBI_BREAKER_COOLDOWN_MS default 30000, invalid falls back", () => {
    withEnv("BOBI_BREAKER_COOLDOWN_MS", undefined, () =>
      expect(breakerBaseCooldownMs()).toBe(30_000),
    );
    withEnv("BOBI_BREAKER_COOLDOWN_MS", "5000", () => expect(breakerBaseCooldownMs()).toBe(5000));
    withEnv("BOBI_BREAKER_COOLDOWN_MS", "-1", () => expect(breakerBaseCooldownMs()).toBe(30_000));
  });
});
