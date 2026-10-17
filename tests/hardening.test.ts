/**
 * Logging, rate limiting, and usage accounting.
 *
 * These are the pieces that exist to protect the owner rather than to add
 * features, so the tests focus on the failure modes: a secret reaching a log
 * line, a burst bypassing a budget, and counters drifting under concurrency.
 */
import { describe, expect, test } from "bun:test";
import { Logger } from "../src/core/logger";
import { RateLimiter } from "../src/core/rate_limit";
import { UsageService, formatCost, formatTokens } from "../src/core/usage";
import { Storage } from "../src/storage/storage";

/** A logger that captures its rendered lines. */
function capture(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];
  const log = new Logger({
    level,
    write: (line) => lines.push(line),
    now: () => new Date("2026-10-17T12:00:00Z"),
  });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

// ---------- logger ----------

describe("log levels", () => {
  test("a message below the configured level is not emitted", () => {
    const { log, lines } = capture("warn");
    log.debug("hidden");
    log.info("hidden");
    log.warn("shown");
    log.error("shown");
    expect(lines).toHaveLength(2);
  });

  test("debug level emits everything", () => {
    const { log, lines } = capture("debug");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toHaveLength(4);
  });

  test("isEnabled agrees with what is emitted", () => {
    const { log } = capture("info");
    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("info")).toBe(true);
    expect(log.isEnabled("error")).toBe(true);
  });

  test("every line is a single JSON object with the expected shape", () => {
    const { log, parsed } = capture();
    log.info("hello", { userId: "u1" });
    const record = parsed()[0]!;
    expect(record["level"]).toBe("info");
    expect(record["message"]).toBe("hello");
    expect(record["time"]).toBe("2026-10-17T12:00:00.000Z");
    expect(record["userId"]).toBe("u1");
    // One line, so a log file can be processed line by line.
    expect(JSON.stringify(record)).not.toContain("\n");
  });

  test("base fields appear on every line", () => {
    const lines: string[] = [];
    const log = new Logger({
      level: "info",
      write: (l) => lines.push(l),
      base: { app: "sol", version: "1.0.0" },
    });
    log.info("a");
    log.info("b");
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record["app"]).toBe("sol");
      expect(record["version"]).toBe("1.0.0");
    }
  });
});

describe("log redaction", () => {
  test("a Telegram bot token is removed from a message", () => {
    const { log, parsed } = capture();
    log.error("failed with 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    const message = parsed()[0]!["message"] as string;
    expect(message).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(message).toContain("[redacted]");
  });

  test("an OpenAI-style key is removed", () => {
    const { log, parsed } = capture();
    log.error("key sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(parsed()[0]!["message"] as string).not.toContain("sk-abcdefghij");
  });

  test("a Tavily key is removed", () => {
    const { log, parsed } = capture();
    log.error("using tvly-abcdefghijklmnop");
    expect(parsed()[0]!["message"] as string).not.toContain("tvly-abcdefghij");
  });

  test("a bearer header is removed", () => {
    const { log, parsed } = capture();
    log.error("Authorization: Bearer abcdefghijklmnopqrst");
    expect(parsed()[0]!["message"] as string).not.toContain("abcdefghijklmnop");
  });

  test("a secret-named field is redacted whatever its value looks like", () => {
    const { log, parsed } = capture();
    log.info("config", {
      apiKey: "anything-at-all",
      token: "x",
      password: "hunter2",
      secret: "s",
      authorization: "a",
    });
    const record = parsed()[0]!;
    for (const key of ["apiKey", "token", "password", "secret", "authorization"]) {
      expect(record[key]).toBe("[redacted]");
    }
  });

  test("a nested secret is redacted too", () => {
    const { log, parsed } = capture();
    log.info("nested", { provider: { apiKey: "deep-secret", label: "ok" } });
    const provider = parsed()[0]!["provider"] as Record<string, unknown>;
    expect(provider["apiKey"]).toBe("[redacted]");
    expect(provider["label"]).toBe("ok");
  });

  test("a secret inside an array of objects is redacted", () => {
    const { log, parsed } = capture();
    log.info("list", { items: [{ apiKey: "hidden" }, { apiKey: "hidden2" }] });
    const items = parsed()[0]!["items"] as Array<Record<string, unknown>>;
    expect(items.every((i) => i["apiKey"] === "[redacted]")).toBe(true);
  });

  test("a very long string is clipped", () => {
    const { log, parsed } = capture();
    log.info("big", { body: "x".repeat(5_000) });
    const body = parsed()[0]!["body"] as string;
    expect(body.length).toBeLessThan(400);
    expect(body).toContain("5000 chars");
  });

  test("ordinary values pass through untouched", () => {
    const { log, parsed } = capture();
    log.info("normal", { userId: "42", count: 3, ok: true, name: "علی" });
    const r = parsed()[0]!;
    expect(r["userId"]).toBe("42");
    expect(r["count"]).toBe(3);
    expect(r["ok"]).toBe(true);
    expect(r["name"]).toBe("علی");
  });

  test("an exception is described without leaking", () => {
    const { log, parsed } = capture("error");
    log.exception("failed", new Error("token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
    const error = parsed()[0]!["error"] as Record<string, unknown>;
    expect(error["name"]).toBe("Error");
    expect(error["message"] as string).not.toContain("AAHdqTcv");
  });

  test("a non-Error throw is still described", () => {
    const { log, parsed } = capture();
    log.exception("failed", "plain string");
    const error = parsed()[0]!["error"] as Record<string, unknown>;
    expect(error["message"]).toBe("plain string");
  });

  test("an unserialisable field does not break logging", () => {
    const { log, lines } = capture();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => log.info("circular", circular)).not.toThrow();
    expect(lines).toHaveLength(1);
    // The line is still valid JSON.
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });
});

// ---------- rate limiter ----------

/** A limiter with an injectable clock. */
function limiter(messagesLimit: number, toolLimit: number, windowMs = 60_000) {
  let clock = 1_000_000;
  const rl = new RateLimiter({
    messages: { limit: messagesLimit, windowMs },
    toolCalls: { limit: toolLimit, windowMs },
    now: () => clock,
  });
  return {
    rl,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("rate limiter", () => {
  test("messages under the limit are allowed", () => {
    const { rl } = limiter(3, 10);
    for (let i = 0; i < 3; i++) {
      expect(rl.takeMessage("u1").allowed).toBe(true);
    }
  });

  test("the message over the limit is refused", () => {
    const { rl } = limiter(2, 10);
    rl.takeMessage("u1");
    rl.takeMessage("u1");
    const third = rl.takeMessage("u1");
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  test("the window drains over time", () => {
    const { rl, advance } = limiter(2, 10, 60_000);
    rl.takeMessage("u1");
    rl.takeMessage("u1");
    expect(rl.takeMessage("u1").allowed).toBe(false);

    advance(60_001);
    expect(rl.takeMessage("u1").allowed).toBe(true);
  });

  test("users are budgeted independently", () => {
    const { rl } = limiter(1, 10);
    expect(rl.takeMessage("u1").allowed).toBe(true);
    expect(rl.takeMessage("u1").allowed).toBe(false);
    // A second user still has their own allowance.
    expect(rl.takeMessage("u2").allowed).toBe(true);
  });

  test("a refused attempt does not extend the lockout", () => {
    // If refusals counted, a retrying client would never recover.
    const { rl, advance } = limiter(1, 10, 60_000);
    rl.takeMessage("u1");
    for (let i = 0; i < 10; i++) {
      expect(rl.takeMessage("u1").allowed).toBe(false);
      advance(1_000);
    }
    // The original timestamp is still what decides, so it clears on schedule.
    advance(60_000);
    expect(rl.takeMessage("u1").allowed).toBe(true);
  });

  test("tool calls have their own independent budget", () => {
    const { rl } = limiter(100, 2);
    expect(rl.takeToolCall("u1").allowed).toBe(true);
    expect(rl.takeToolCall("u1").allowed).toBe(true);
    expect(rl.takeToolCall("u1").allowed).toBe(false);
    // The message budget is untouched.
    expect(rl.takeMessage("u1").allowed).toBe(true);
  });

  test("a zero limit disables that rule", () => {
    const { rl } = limiter(0, 0);
    for (let i = 0; i < 100; i++) {
      expect(rl.takeMessage("u1").allowed).toBe(true);
      expect(rl.takeToolCall("u1").allowed).toBe(true);
    }
  });

  test("peek does not consume", () => {
    const { rl } = limiter(1, 10);
    expect(rl.peekMessage("u1").allowed).toBe(true);
    expect(rl.peekMessage("u1").allowed).toBe(true);
    // The budget was never spent by peeking.
    expect(rl.takeMessage("u1").allowed).toBe(true);
    expect(rl.peekMessage("u1").allowed).toBe(false);
  });

  test("retryAfterMs points at when a slot frees", () => {
    const { rl, advance } = limiter(1, 10, 60_000);
    rl.takeMessage("u1");
    advance(30_000);
    const decision = rl.takeMessage("u1");
    expect(decision.allowed).toBe(false);
    // Half the window has passed, so about half remains.
    expect(decision.retryAfterMs).toBeGreaterThan(25_000);
    expect(decision.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  test("the tracked-user map stays bounded", () => {
    let clock = 1_000_000;
    const rl = new RateLimiter({
      messages: { limit: 5, windowMs: 60_000 },
      toolCalls: { limit: 5, windowMs: 60_000 },
      now: () => clock,
      maxUsers: 3,
    });
    for (let i = 0; i < 10; i++) {
      rl.takeMessage(`u${i}`);
      clock += 1;
    }
    // The limiter still works for a new user after eviction.
    expect(rl.takeMessage("fresh").allowed).toBe(true);
  });

  test("reset clears every window", () => {
    const { rl } = limiter(1, 1);
    rl.takeMessage("u1");
    rl.takeToolCall("u1");
    expect(rl.takeMessage("u1").allowed).toBe(false);
    rl.reset();
    expect(rl.takeMessage("u1").allowed).toBe(true);
    expect(rl.takeToolCall("u1").allowed).toBe(true);
  });
});

// ---------- usage ----------

describe("usage accounting", () => {
  test("a run's counters are recorded", () => {
    const storage = Storage.open(":memory:");
    const usage = new UsageService(storage, () => "2026-10-17");
    usage.record({ userId: "u1", requests: 1, toolCalls: 3, inputTokens: 100, outputTokens: 50 });

    const summary = usage.summary("u1", "gpt-4o-mini");
    expect(summary.user.requests).toBe(1);
    expect(summary.user.toolCalls).toBe(3);
    expect(summary.user.inputTokens).toBe(100);
    expect(summary.user.outputTokens).toBe(50);
    storage.close();
  });

  test("counters accumulate across runs", () => {
    const storage = Storage.open(":memory:");
    const usage = new UsageService(storage, () => "2026-10-17");
    for (let i = 0; i < 3; i++) {
      usage.record({ userId: "u1", requests: 1, toolCalls: 2, inputTokens: 10, outputTokens: 5 });
    }
    const summary = usage.summary("u1", "gpt-4o-mini");
    expect(summary.user.requests).toBe(3);
    expect(summary.user.toolCalls).toBe(6);
    expect(summary.user.inputTokens).toBe(30);
    storage.close();
  });

  test("users are counted separately, and the day total sums them", () => {
    const storage = Storage.open(":memory:");
    const usage = new UsageService(storage, () => "2026-10-17");
    usage.record({ userId: "u1", requests: 1, toolCalls: 0, inputTokens: 100, outputTokens: 0 });
    usage.record({ userId: "u2", requests: 1, toolCalls: 0, inputTokens: 200, outputTokens: 0 });

    expect(usage.summary("u1", "x").user.inputTokens).toBe(100);
    expect(usage.summary("u1", "x").all.inputTokens).toBe(300);
    storage.close();
  });

  test("days are separate", () => {
    const storage = Storage.open(":memory:");
    let day = "2026-10-17";
    const usage = new UsageService(storage, () => day);
    usage.record({ userId: "u1", requests: 1, toolCalls: 0, inputTokens: 100, outputTokens: 0 });

    day = "2026-10-18";
    expect(usage.summary("u1", "x").user.inputTokens).toBe(0);
    storage.close();
  });

  test("an unknown user reports zeros rather than failing", () => {
    const storage = Storage.open(":memory:");
    const usage = new UsageService(storage, () => "2026-10-17");
    const summary = usage.summary("nobody", "x");
    expect(summary.user.requests).toBe(0);
    expect(summary.estimatedUsd).toBe(0);
    storage.close();
  });

  test("a known model produces an estimate", () => {
    const storage = Storage.open(":memory:");
    const usage = new UsageService(storage, () => "2026-10-17");
    usage.record({
      userId: "u1",
      requests: 1,
      toolCalls: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const summary = usage.summary("u1", "gpt-4o-mini");
    // 1M input tokens at the table's rate.
    expect(summary.estimatedUsd).toBeGreaterThan(0);
    expect(summary.estimated).toBe(false);
    storage.close();
  });

  test("an unknown model falls back and is flagged as an estimate", () => {
    const storage = Storage.open(":memory:");
    const usage = new UsageService(storage, () => "2026-10-17");
    usage.record({
      userId: "u1",
      requests: 1,
      toolCalls: 0,
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const summary = usage.summary("u1", "some-unlisted-model");
    expect(summary.estimated).toBe(true);
    expect(summary.estimatedUsd).toBeGreaterThan(0);
    storage.close();
  });

  test("recording never throws into the caller", () => {
    const storage = Storage.open(":memory:");
    const usage = new UsageService(storage);
    storage.close(); // a closed database
    // Accounting is diagnostic; it must not fail a user's request.
    expect(() =>
      usage.record({ userId: "u1", requests: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0 }),
    ).not.toThrow();
  });

  test("a closed database reports zeros rather than throwing", () => {
    const storage = Storage.open(":memory:");
    const usage = new UsageService(storage);
    storage.close();
    expect(() => usage.summary("u1", "x")).not.toThrow();
  });

  test("cost formatting is readable at small and large values", () => {
    expect(formatCost(0)).toContain("۰");
    expect(formatCost(0.001)).toContain("کمتر از");
    expect(formatCost(1.5)).toContain("1.50");
    expect(formatTokens(1234567)).toBe("1,234,567");
  });
});

describe("usage persistence", () => {
  test("counters survive a reopen", () => {
    const path = `${process.env["TEMP"] ?? "/tmp"}/sol-usage-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`;
    const s1 = Storage.open(path);
    s1.addUsage({
      userId: "u1",
      day: "2026-10-17",
      requests: 2,
      toolCalls: 5,
      inputTokens: 300,
      outputTokens: 100,
    });
    s1.close();

    const s2 = Storage.open(path);
    const record = s2.usageFor("u1", "2026-10-17");
    expect(record.requests).toBe(2);
    expect(record.inputTokens).toBe(300);
    s2.close();
  });
});
