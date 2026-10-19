/**
 * Regression test: the conversation engine's no-tools path (`plainCall`)
 * must not hang when the caller aborts while the provider's promise never
 * settles.
 *
 * Same bug class as the agent loop's `call()` (Worker C's fix): the
 * deadline race only rejects on timer fire, so the caller's abort has to
 * be raced explicitly too — otherwise a provider that ignores the abort
 * signal holds the semaphore slot forever.
 * No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import {
  ConversationEngine,
  EngineError,
} from "../src/conversation/engine";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";

/** A provider whose promise never settles — the abort must free it. */
class HangingProvider implements AiProvider {
  readonly name = "hanging";
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return new Promise<CompletionResponse>(() => {});
  }
}

/** No `tools` service -> the engine takes the `plainCall` path. */
function makeEngine(provider: AiProvider): ConversationEngine {
  return new ConversationEngine({
    provider,
    model: "m",
    // Short on purpose: without the explicit abort race, the hanging
    // provider would only be freed by this timer — so a regression fails
    // in ~2s instead of hanging the suite.
    timeoutMs: 2_000,
    maxConcurrent: 4,
    timezone: "UTC",
    summariseHistory: false,
  });
}

describe("conversation engine — plainCall abort", () => {
  test("aborting mid-call raises EngineError(superseded) without hanging", async () => {
    const engine = makeEngine(new HangingProvider());
    const run = engine.respond({
      conversationId: "c1",
      userId: "u1",
      userText: "hi",
    });
    // Let the run reach the provider, then supersede it (as a newer
    // message would). Without the explicit abort race this await hangs
    // forever because the provider ignores the abort signal.
    await new Promise((r) => setTimeout(r, 20));
    engine.cancel("c1");
    const started = Date.now();
    const err = await run.catch((e) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).kind).toBe("superseded");
  });

  test("a settled provider call is unaffected by a later abort", async () => {
    const engine = makeEngine({
      name: "quick",
      async complete(): Promise<CompletionResponse> {
        return { text: "hello", model: "m" };
      },
    });
    const out = await engine.respond({
      conversationId: "c2",
      userId: "u1",
      userText: "hi",
    });
    expect(out.chunks.join("")).toContain("hello");
    // Aborting after settlement is a no-op, not an error.
    engine.cancel("c2");
  });
});
