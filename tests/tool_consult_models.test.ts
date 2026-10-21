/**
 * Phase 8, Unit F — consult_models live selection.
 *
 * Pins the fix for the boot-condition bug: the tool used to be registered
 * only `if (selection)` existed at boot (and its primaryModel was frozen
 * there), so a bot booted before any provider was configured never got
 * consultation until a restart. Now the tool is built once with a
 * `resolveConsult` resolver that is called fresh on EVERY run:
 *
 *  (a) resolver → undefined: honest not-configured ToolError, ZERO
 *      provider calls — never a faked answer, never a fallback model.
 *  (b) resolver → fake provider + primary: the full consult flow works.
 *  (c) resolver returning DIFFERENT primaries on successive runs: the
 *      synthesis of the second run uses the second run's primary —
 *      live selection proven, nothing is frozen at construction.
 *  (+) the SAME tool instance goes from not-configured to working when
 *      the resolver starts returning a selection (provider added after
 *      boot, no tool rebuild, no restart).
 */
import { describe, expect, test } from "bun:test";
import { AiError } from "../src/ai/provider";
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";
import type { ToolActor, ToolContext } from "../src/tools/types";
import {
  CONSULT_NOT_CONFIGURED_MESSAGE,
  createConsultModelsTool,
} from "../src/tools/consult_models";

const ACTOR: ToolActor = { userId: "u1", permissions: ["tools:consult_models"] };

function ctxFor(): ToolContext {
  return {
    clock: () => new Date(),
    actor: ACTOR,
    signal: new AbortController().signal,
  };
}

/** Stub AiProvider keyed by requested model; records every request. */
class ModelKeyedProvider implements AiProvider {
  readonly name = "keyed";
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly answers: Record<string, string | Error>) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const a = this.answers[req.model];
    if (a === undefined) throw new AiError("invalid_response", `unknown model ${req.model}`);
    if (a instanceof Error) throw a;
    return { text: a, model: req.model };
  }
}

const CONFIGURED = ["model-a", "model-b", "model-synth", "synth-1", "synth-2"];

describe("consult_models live selection (Phase 8)", () => {
  test("(a) resolveConsult → undefined: honest not-configured error, zero provider calls", async () => {
    // A provider exists in the closure's reach but the resolver says no
    // provider is configured — the tool must not touch it, not even once.
    const provider = new ModelKeyedProvider({ "model-a": "a" });
    let resolveCalls = 0;
    const tool = createConsultModelsTool({
      resolveConsult: () => {
        resolveCalls += 1;
        return undefined;
      },
      listConfiguredModels: () => [...CONFIGURED],
    });

    const err = await tool
      .run({ question: "what is the best approach?", models: ["model-a"] }, ctxFor())
      .then(
        () => {
          throw new Error("expected the run to throw");
        },
        (e: unknown) => e,
      );

    expect(err).toMatchObject({ name: "ToolError", kind: "not_allowed" });
    expect((err as Error).message).toBe(CONSULT_NOT_CONFIGURED_MESSAGE);
    expect((err as Error).message).toContain("No AI provider is configured yet");
    expect((err as Error).message).toContain("once a provider is set up");
    expect(provider.requests).toHaveLength(0);
    expect(resolveCalls).toBeGreaterThanOrEqual(1);
  });

  test("(a+) same tool instance: not-configured first, works after a provider appears", async () => {
    const provider = new ModelKeyedProvider({
      "model-a": "answer a",
      "model-b": "answer b",
      "model-synth": "synthesized",
    });
    // Mutable live selection — undefined at "boot", set later, exactly
    // like a provider added via /ai after the bot started.
    let live: { provider: AiProvider; primaryModel: string } | undefined;
    const tool = createConsultModelsTool({
      resolveConsult: () => live,
      listConfiguredModels: () =>
        live === undefined ? [] : ["model-a", "model-b", "model-synth"],
    });

    await expect(tool.run({ question: "q?" }, ctxFor())).rejects.toMatchObject({
      name: "ToolError",
      kind: "not_allowed",
    });
    expect(provider.requests).toHaveLength(0);

    live = { provider, primaryModel: "model-synth" };
    const out = await tool.run(
      { question: "q?", models: ["model-a", "model-b"] },
      ctxFor(),
    );
    expect(out.ok).toBe(true);
    expect(out.modelsUsed).toEqual(["model-a", "model-b"]);
    expect(out.answer).toBe("synthesized");
  });

  test("(b) resolver → fake provider + primary: full consult flow works", async () => {
    const provider = new ModelKeyedProvider({
      "model-a": "answer a",
      "model-b": "answer b",
      "model-synth": "combined answer",
    });
    const tool = createConsultModelsTool({
      resolveConsult: () => ({ provider, primaryModel: "model-synth" }),
      listConfiguredModels: () => ["model-a", "model-b", "model-synth"],
    });

    const out = await tool.run(
      { question: "which way?", models: ["model-a", "model-b"] },
      ctxFor(),
    );

    expect(out.ok).toBe(true);
    expect(out.modelsUsed).toEqual(["model-a", "model-b"]);
    expect(out.answer).toBe("combined answer");
    // Fan-out hit each consulted model; synthesis hit the primary.
    expect(provider.requests.slice(0, 2).map((r) => r.model)).toEqual([
      "model-a",
      "model-b",
    ]);
    const synthReq = provider.requests[provider.requests.length - 1]!;
    expect(synthReq.model).toBe("model-synth");
    const prompt = synthReq.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("answer a");
    expect(prompt).toContain("answer b");
  });

  test("(c) different primaries on successive runs: synthesis uses the second run's primary", async () => {
    const provider = new ModelKeyedProvider({
      "model-a": "answer a",
      "synth-1": "synthesis one",
      "synth-2": "synthesis two",
    });
    let currentPrimary = "synth-1";
    let resolveCalls = 0;
    const tool = createConsultModelsTool({
      resolveConsult: () => {
        resolveCalls += 1;
        return { provider, primaryModel: currentPrimary };
      },
      listConfiguredModels: () => [...CONFIGURED],
    });

    const first = await tool.run(
      { question: "q?", models: ["model-a"] },
      ctxFor(),
    );
    expect(first.answer).toBe("synthesis one");
    expect(provider.requests[provider.requests.length - 1]!.model).toBe("synth-1");

    // Owner switches the primary model — no tool rebuild, no restart.
    currentPrimary = "synth-2";
    const callsBeforeSecond = resolveCalls;
    const second = await tool.run(
      { question: "q?", models: ["model-a"] },
      ctxFor(),
    );
    expect(second.answer).toBe("synthesis two");
    expect(provider.requests[provider.requests.length - 1]!.model).toBe("synth-2");
    // The resolver was consulted again for the second run (not cached).
    expect(resolveCalls).toBeGreaterThan(callsBeforeSecond);
  });

  test("allowlist still enforced under the live deps shape", async () => {
    const provider = new ModelKeyedProvider({ "model-a": "a" });
    const tool = createConsultModelsTool({
      resolveConsult: () => ({ provider, primaryModel: "model-a" }),
      listConfiguredModels: () => ["model-a"],
    });

    await expect(
      tool.run({ question: "q?", models: ["model-a", "evil-model"] }, ctxFor()),
    ).rejects.toMatchObject({ name: "ToolError", kind: "not_allowed" });
    expect(provider.requests).toHaveLength(0);
  });
});
