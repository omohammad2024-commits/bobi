import { describe, expect, test } from "bun:test";
import { AiError } from "../src/ai/provider";
import type {
  AiProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
} from "../src/ai/provider";
import { ToolService } from "../src/tools/service";
import type { Tool, ToolActor, ToolContext } from "../src/tools/types";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  runMixture,
} from "../src/ai/mixture";
import type { MixtureDeps } from "../src/ai/mixture";
import {
  CONSULT_MODELS_MAX,
  CONSULT_MODELS_TOOL_NAME,
  createConsultModelsTool,
} from "../src/tools/consult_models";

// ---------- mixture helpers ----------

const ACTOR: ToolActor = { userId: "u1", permissions: ["tools:consult_models"] };

function ctxFor(): ToolContext {
  return {
    clock: () => new Date(),
    actor: ACTOR,
    signal: new AbortController().signal,
  };
}

describe("runMixture", () => {
  test("fans out to all models and collects every answer", async () => {
    const seen: string[] = [];
    const deps: MixtureDeps = {
      complete: async (model, messages, _signal) => {
        seen.push(model);
        const q = messages.find((m) => m.role === "user")?.content ?? "";
        return `${model} می‌گوید: ${q}`;
      },
    };

    const { answers } = await runMixture(deps, "هوا چطور است؟", ["a", "b", "c"]);

    expect(answers).toHaveLength(3);
    expect(answers.map((a) => a.model)).toEqual(["a", "b", "c"]);
    for (const a of answers) {
      expect(a.text).toContain("هوا چطور است؟");
      expect(a.error).toBeUndefined();
    }
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("one failing model is recorded, not fatal", async () => {
    const deps: MixtureDeps = {
      complete: async (model, _messages, _signal) => {
        if (model === "bad") throw new AiError("network", "provider exploded");
        return `پاسخ ${model}`;
      },
    };

    const { answers } = await runMixture(deps, "سؤال", ["good1", "bad", "good2"]);

    expect(answers).toHaveLength(3);
    expect(answers[0]?.text).toBe("پاسخ good1");
    expect(answers[2]?.text).toBe("پاسخ good2");
    const failed = answers[1];
    expect(failed?.text).toBeUndefined();
    expect(failed?.error).toBeDefined();
    // User-safe: no provider internals.
    expect(failed?.error).not.toContain("exploded");
  });

  test("a hung model is cut by the per-model timeout", async () => {
    const deps: MixtureDeps = {
      // Ignores the signal and never settles: the race must still free us.
      complete: (_model, _messages, _signal) => new Promise<string>(() => {}),
    };

    const started = Date.now();
    const { answers } = await runMixture(deps, "سؤال", ["hung"], {
      timeoutMsPerModel: 50,
    });
    const elapsed = Date.now() - started;

    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBeUndefined();
    expect(answers[0]?.error).toBeDefined();
    expect(elapsed).toBeLessThan(5_000);
  });

  test("default per-model timeout is 30s", () => {
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBe(30_000);
  });
});

// ---------- consult_models helpers ----------

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

const CONFIGURED = ["model-a", "model-b", "model-c", "model-d"];

function makeTool(provider: AiProvider, configured: string[] = CONFIGURED) {
  return createConsultModelsTool({
    provider,
    primaryModel: "model-a",
    listConfiguredModels: () => [...configured],
  });
}

describe("consult_models tool", () => {
  test("consults each model and synthesizes with the primary model", async () => {
    const provider = new ModelKeyedProvider({
      "model-a": "پاسخ الف",
      "model-b": "پاسخ ب",
      "model-synth": "ترکیب نهایی",
    });
    const tool = createConsultModelsTool({
      provider,
      primaryModel: "model-synth",
      listConfiguredModels: () => ["model-a", "model-b", "model-synth"],
    });

    const out = await tool.run(
      { question: "بهترین زبان برنامه‌نویسی کدام است؟", models: ["model-a", "model-b"] },
      ctxFor(),
    );

    expect(out.ok).toBe(true);
    expect(out.modelsUsed).toEqual(["model-a", "model-b"]);
    expect(out.answer).toBe("ترکیب نهایی");

    // The synthesis call went to the primary model with labelled answers.
    const synthReq = provider.requests[provider.requests.length - 1]!;
    expect(synthReq.model).toBe("model-synth");
    const prompt = synthReq.messages.map((m: ChatMessage) => m.content).join("\n");
    expect(prompt).toContain("بهترین ترکیب");
    expect(prompt).toContain("پاسخ الف");
    expect(prompt).toContain("پاسخ ب");
    expect(prompt).toContain("بهترین زبان برنامه‌نویسی کدام است؟");
  });

  test("omitted models default to the first three configured", async () => {
    const provider = new ModelKeyedProvider({
      "model-a": "a",
      "model-b": "b",
      "model-c": "c",
      "model-d": "d",
      "model-synth": "ترکیب",
    });
    const tool = createConsultModelsTool({
      provider,
      primaryModel: "model-synth",
      listConfiguredModels: () => ["model-a", "model-b", "model-c", "model-d"],
    });

    const out = await tool.run({ question: "سؤال" }, ctxFor());

    expect(out.ok).toBe(true);
    expect(out.modelsUsed).toEqual(["model-a", "model-b", "model-c"]);
    const consulted = provider.requests
      .slice(0, 3)
      .map((r) => r.model);
    expect(consulted).toEqual(["model-a", "model-b", "model-c"]);
  });

  test("partial failure: surviving answers are synthesized, failure noted", async () => {
    const provider = new ModelKeyedProvider({
      "model-a": "پاسخ الف",
      "model-b": new AiError("quota", "out of quota"),
      "model-synth": "ترکیب نهایی",
    });
    const tool = makeTool(provider);

    const out = await tool.run(
      { question: "سؤال", models: ["model-a", "model-b"] },
      ctxFor(),
    );

    expect(out.ok).toBe(true);
    expect(out.modelsUsed).toEqual(["model-a"]);
    const synthReq = provider.requests[provider.requests.length - 1]!;
    const prompt = synthReq.messages.map((m: ChatMessage) => m.content).join("\n");
    expect(prompt).toContain("پاسخ الف");
    // The failed model is labelled as failed, not silently dropped.
    expect(prompt).toContain("model-b");
  });

  test("unknown model names are rejected by the allowlist", async () => {
    const provider = new ModelKeyedProvider({ "model-a": "a" });
    const tool = makeTool(provider);

    await expect(
      tool.run({ question: "سؤال", models: ["model-a", "evil-model"] }, ctxFor()),
    ).rejects.toMatchObject({ name: "ToolError", kind: "not_allowed" });
    expect(provider.requests).toHaveLength(0);
  });

  test("more than three models is rejected at validation", async () => {
    const provider = new ModelKeyedProvider({});
    const service = new ToolService();
    service.registry.register(
      createConsultModelsTool({
        provider,
        primaryModel: "model-a",
        listConfiguredModels: () => ["m1", "m2", "m3", "m4"],
      }) as Tool<unknown, unknown>,
    );

    const res = await service.runTool({
      tool: CONSULT_MODELS_TOOL_NAME,
      input: { question: "سؤال", models: ["m1", "m2", "m3", "m4"] },
      actor: ACTOR,
    });
    expect(res.status).toBe("invalid_input");
    expect(provider.requests).toHaveLength(0);
  });

  test("empty configuration is refused", async () => {
    const provider = new ModelKeyedProvider({});
    const tool = makeTool(provider, []);

    await expect(tool.run({ question: "سؤال" }, ctxFor())).rejects.toMatchObject({
      name: "ToolError",
    });
  });

  test("all models failing surfaces a user-safe error, never raw", async () => {
    const provider = new ModelKeyedProvider({
      "model-a": new AiError("network", "secret-internal-detail"),
    });
    const tool = makeTool(provider);

    await expect(
      tool.run({ question: "سؤال", models: ["model-a"] }, ctxFor()),
    ).rejects.toMatchObject({ name: "ToolError" });
  });

  test("consult limit constant is 3", () => {
    expect(CONSULT_MODELS_MAX).toBe(3);
  });

  test("executor enforces the tools:consult_models permission", async () => {
    const provider = new ModelKeyedProvider({ "model-a": "a", "model-synth": "s" });
    const service = new ToolService();
    service.registry.register(
      createConsultModelsTool({
        provider,
        primaryModel: "model-synth",
        listConfiguredModels: () => ["model-a", "model-synth"],
      }) as Tool<unknown, unknown>,
    );

    const denied = await service.runTool({
      tool: CONSULT_MODELS_TOOL_NAME,
      input: { question: "سؤال" },
      actor: { userId: "u9", permissions: [] },
    });
    expect(denied.status).toBe("not_allowed");
  });
});
