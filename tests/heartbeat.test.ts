/**
 * Heartbeat service.
 *
 * The heartbeat is the bot's autonomous tick; the behaviours that matter:
 *  - a beat with no real model is SKIPPED and logged, never run
 *  - a beat composes its prompt from the owner's active goals and recent
 *    pass summaries, runs the engine as the owner, and logs one row
 *  - start() is a no-op when the interval is 0 (the default: off)
 *  - beat() never throws: an engine failure is recorded as failed
 *  - the 500-char summary cut never splits an emoji
 *
 * The engine, actor, and clock are all injected fakes; no network, no timers
 * with real delays (start() with a positive interval is only asserted for
 * arming, then stopped).
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { HeartbeatService } from "../src/autonomy/heartbeat";
import type { ConversationEngine, ConversationOutput } from "../src/conversation/engine";
import type { Logger } from "../src/core/logger";
import type { ToolActor } from "../src/tools/types";

const OWNER = "999";

function nullLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as Logger;
}

/** Captures the respond() input and returns a canned output. */
function fakeEngine(opts: {
  reply: string;
  toolCalls?: number;
  fail?: boolean;
}): { engine: ConversationEngine; seen: Array<Record<string, unknown>>; calls: { n: number } } {
  const seen: Array<Record<string, unknown>> = [];
  const calls = { n: 0 };
  const engine = {
    async respond(input: Record<string, unknown>): Promise<ConversationOutput> {
      calls.n += 1;
      seen.push(input);
      if (opts.fail) throw new Error("provider exploded");
      return {
        chunks: [opts.reply],
        model: "fake-test",
        isFake: false,
        steps: [],
        truncated: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        toolCalls: opts.toolCalls ?? 0,
        media: [],
      };
    },
  } as unknown as ConversationEngine;
  return { engine, seen, calls };
}

interface BeatSetup {
  service: HeartbeatService;
  storage: Storage;
  engine: ConversationEngine;
  seen: Array<Record<string, unknown>>;
  calls: { n: number };
  actorForOwnerCalls: { n: number };
}

function setup(opts: {
  intervalMs?: number;
  isFake?: boolean;
  reply?: string;
  toolCalls?: number;
  fail?: boolean;
}): BeatSetup {
  const storage = Storage.open(":memory:");
  const { engine, seen, calls } = fakeEngine({
    reply: opts.reply ?? "همه‌چیز خوب است.",
    // exactOptionalPropertyTypes: omit keys rather than pass undefined.
    ...(opts.toolCalls !== undefined ? { toolCalls: opts.toolCalls } : {}),
    ...(opts.fail !== undefined ? { fail: opts.fail } : {}),
  });
  const actorForOwnerCalls = { n: 0 };
  const actorForOwner = (): ToolActor => {
    actorForOwnerCalls.n += 1;
    return { userId: OWNER, permissions: [] };
  };
  const service = new HeartbeatService({
    engine,
    storage,
    ownerId: OWNER,
    actorForOwner,
    isFake: () => opts.isFake ?? false,
    intervalMs: opts.intervalMs ?? 0,
    log: nullLogger(),
  });
  return { service, storage, engine, seen, calls, actorForOwnerCalls };
}

describe("beat()", () => {
  test("skips when there is no real model, and logs the skip", async () => {
    const { service, storage, calls, actorForOwnerCalls } = setup({ isFake: true });
    await service.beat();

    expect(calls.n).toBe(0);
    expect(actorForOwnerCalls.n).toBe(0);
    const rows = storage.recentHeartbeats(5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("skipped");
    storage.close();
  });

  test("runs the engine as the owner, with goals and recent summaries in the prompt", async () => {
    const { service, storage, seen } = setup({ reply: "هدف‌ها بررسی شدند؛ اقدامی لازم نبود." });
    storage.createGoal({ title: "یادگیری زبان", description: "روزی یک درس", createdBy: OWNER });
    storage.logHeartbeat({ summary: "ضربان قبلی: آرام", toolCalls: 0, status: "ok" });

    await service.beat();

    expect(seen).toHaveLength(1);
    const input = seen[0]!;
    expect(input["conversationId"]).toBe("heartbeat");
    expect(input["userId"]).toBe(OWNER);
    expect((input["actor"] as ToolActor).userId).toBe(OWNER);
    const prompt = input["userText"] as string;
    expect(prompt).toContain("یادگیری زبان");
    expect(prompt).toContain("روزی یک درس");
    expect(prompt).toContain("ضربان قبلی: آرام");

    const rows = storage.recentHeartbeats(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ok");
    expect(rows[0]!.summary).toBe("هدف‌ها بررسی شدند؛ اقدامی لازم نبود.");
    expect(rows[0]!.toolCalls).toBe(0);
    storage.close();
  });

  test("records tool calls and truncates the summary to 500 chars", async () => {
    const reply = "x".repeat(800);
    const { service, storage } = setup({ reply, toolCalls: 3 });
    await service.beat();

    const row = storage.recentHeartbeats(1)[0]!;
    expect(row.status).toBe("ok");
    expect(row.toolCalls).toBe(3);
    expect(row.summary.length).toBe(500);
    storage.close();
  });

  test("an emoji at the cut is not split", async () => {
    const reply = "a".repeat(499) + "😀" + "b".repeat(100);
    const { service, storage } = setup({ reply });
    await service.beat();

    const summary = storage.recentHeartbeats(1)[0]!.summary;
    expect(Array.from(summary).length).toBe(500);
    expect(summary.endsWith("😀")).toBe(true);
    storage.close();
  });

  test("an engine failure is logged as failed and beat() does not throw", async () => {
    const { service, storage } = setup({ fail: true });
    await service.beat(); // must not reject

    const row = storage.recentHeartbeats(1)[0]!;
    expect(row.status).toBe("failed");
    expect(row.toolCalls).toBe(0);
    expect(row.summary.length).toBeGreaterThan(0);
    storage.close();
  });
});

describe("start()/stop()", () => {
  test("start() is a no-op when the interval is 0 (disabled by default)", async () => {
    const { service, calls } = setup({ intervalMs: 0 });
    service.start();
    expect(service.isRunning).toBe(false);
    // Even after a real wait, nothing fires.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.n).toBe(0);
    service.stop();
  });

  test("start() arms the loop and stop() disarms it", async () => {
    const { service } = setup({ intervalMs: 10_000 });
    service.start();
    expect(service.isRunning).toBe(true);
    service.start(); // idempotent
    expect(service.isRunning).toBe(true);
    service.stop();
    expect(service.isRunning).toBe(false);
    service.stop(); // safe when not running
  });
});
