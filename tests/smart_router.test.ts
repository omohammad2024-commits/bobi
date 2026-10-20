/**
 * Worker-1: smart routing tests.
 *
 * Covers the classifier tiers, the scorer ordering (cheap for trivial,
 * strong for heavy), the BOBI_SMART_ROUTING kill switch, deterministic
 * tie-breaks, the single-provider fallback, and the gateway integration
 * (routing picks the routed candidate first; disabled routing keeps the
 * active selection).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import {
  SmartRouter,
  classifyTask,
  costHint,
  smartRoutingEnabled,
  SMART_ROUTING_ENV_VAR,
} from "../src/ai/smart_router";
import type { ChatMessage, ToolSpec } from "../src/ai/provider";

const KEY = "smart-routing-test-key";
const adapters = new AdapterRegistry();

const prevEnv = process.env[SMART_ROUTING_ENV_VAR];
afterEach(() => {
  if (prevEnv === undefined) delete process.env[SMART_ROUTING_ENV_VAR];
  else process.env[SMART_ROUTING_ENV_VAR] = prevEnv;
});

function msg(content: string): ChatMessage {
  return { role: "user", content };
}

function build() {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  return { storage, secrets, providers, models };
}

function seed(
  b: ReturnType<typeof build>,
  label: string,
  modelId: string,
  opts: { adapter?: string; apiKey?: string } = {},
): { providerId: number; modelDbId: number } {
  const p = b.providers.create({
    label,
    adapter: opts.adapter ?? "openai_compatible",
    baseUrl: `https://${label}.invalid/v1`,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : { apiKey: "key-" + label }),
  });
  if (!p.ok) throw new Error(`provider failed: ${label}`);
  const m = b.models.add({ providerId: p.data, modelId, label: modelId });
  if (!m.ok) throw new Error(`model failed: ${modelId}`);
  return { providerId: p.data, modelDbId: m.data };
}

// ---------- kill switch ----------

describe("kill switch", () => {
  test("enabled by default (unset)", () => {
    delete process.env[SMART_ROUTING_ENV_VAR];
    expect(smartRoutingEnabled()).toBe(true);
  });

  test("disabled by 0 / false / no / off", () => {
    for (const v of ["0", "false", "no", "off", "OFF", " False "]) {
      process.env[SMART_ROUTING_ENV_VAR] = v;
      expect(smartRoutingEnabled()).toBe(false);
    }
  });

  test("enabled by any other value", () => {
    process.env[SMART_ROUTING_ENV_VAR] = "1";
    expect(smartRoutingEnabled()).toBe(true);
  });

  test("shouldRoute is false when the kill switch is off", () => {
    const b = build();
    seed(b, "cheap", "llama-3.1-8b-instruct");
    seed(b, "strong", "claude-opus-4");
    process.env[SMART_ROUTING_ENV_VAR] = "0";
    expect(new SmartRouter(b.storage, adapters).shouldRoute()).toBe(false);
    b.storage.close();
  });
});

// ---------- classifier ----------

describe("classifyTask", () => {
  test("chit-chat is trivial", () => {
    expect(classifyTask([msg("hi")])).toBe("trivial");
    expect(classifyTask([msg("سلام، چطوری؟")])).toBe("trivial");
  });

  test("a plain short question is trivial, a longer one is simple", () => {
    expect(classifyTask([msg("What's the capital of France?")])).toBe("trivial");
    const longer =
      "What's the capital of France, and while you're at it, could you tell me " +
      "a bit about its history and the best time of year to visit for someone " +
      "who has never been to Europe before and wants to see the main sights?";
    expect(classifyTask([msg(longer)])).toBe("simple");
  });

  test("a medium-length prompt is standard", () => {
    const text = (
      "I'm planning a weekend trip to the mountains with three friends. " +
      "We like hiking and good food, nothing too extreme. Could you suggest " +
      "a rough itinerary for two days, including where to eat and what trails " +
      "to try? Also any packing tips would be great since the weather is " +
      "unpredictable this time of year and one of us gets cold easily."
    ).repeat(4);
    expect(text.length).toBeGreaterThan(1200);
    expect(classifyTask([msg(text)])).toBe("standard");
  });

  test("tool offers raise the tier", () => {
    const tools: ToolSpec[] = [{ name: "search", description: "web search", parameters: {} }];
    expect(classifyTask([msg("hi")], tools)).not.toBe("trivial");
  });

  test("tool-call history is agentic work (complex+)", () => {
    const messages: ChatMessage[] = [
      msg("check the weather and my calendar"),
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "search", arguments: {} }] },
      { role: "tool", content: "sunny", toolCallId: "1" },
    ];
    const tier = classifyTask(messages);
    expect(["complex", "heavy"]).toContain(tier);
  });

  test("document attachments are heavy work", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "summarize this",
        parts: [{ type: "document", mediaType: "application/pdf", base64: "AAA" }],
      },
    ];
    expect(classifyTask(messages)).toBe("heavy");
  });

  test("code blocks raise the tier", () => {
    const code = "```ts\nfunction foo() {\n  return bar;\n}\n```\nwhat does this do?";
    expect(classifyTask([msg(code)])).toBe("standard");
  });

  test("multi-step planning language is complex/heavy", () => {
    const text =
      "Give me a step-by-step plan to refactor our codebase: first analyze the " +
      "module structure, then compare two architecture options with pros and cons, " +
      "and finally outline the trade-offs of each approach in detail.";
    const tier = classifyTask([msg(text)]);
    expect(["complex", "heavy"]).toContain(tier);
  });

  test("very long prompts are heavy", () => {
    expect(classifyTask([msg("lorem ipsum ".repeat(800))])).toBe("heavy");
  });
});

// ---------- cost hints ----------

describe("costHint", () => {
  test("cheap models score below expensive ones", () => {
    expect(costHint("llama-3.1-8b-instruct")).toBeLessThan(costHint("claude-opus-4"));
    expect(costHint("nemotron-3-lightning-free")).toBeLessThan(costHint("gpt-5"));
  });

  test("unknown models get the default", () => {
    expect(costHint("some-future-model-xyz")).toBe(50);
  });
});

// ---------- router decisions ----------

describe("SmartRouter.route", () => {
  test("trivial request picks the cheapest candidate", () => {
    const b = build();
    seed(b, "cheap", "llama-3.1-8b-instruct");
    seed(b, "strong", "claude-opus-4");
    const d = new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] });
    expect(d).toBeDefined();
    expect(d!.modelId).toBe("llama-3.1-8b-instruct");
    expect(d!.tier).toBe("trivial");
    b.storage.close();
  });

  test("heavy request picks a strong candidate", () => {
    const b = build();
    seed(b, "cheap", "llama-3.1-8b-instruct");
    seed(b, "strong", "claude-opus-4");
    const d = new SmartRouter(b.storage, adapters).route({
      messages: [msg("lorem ipsum ".repeat(800))],
    });
    expect(d).toBeDefined();
    expect(d!.modelId).toBe("claude-opus-4");
    expect(d!.tier).toBe("heavy");
    b.storage.close();
  });

  test("documents route to a document-capable adapter", () => {
    const b = build();
    seed(b, "oai", "gpt-4o-mini", { adapter: "openai_compatible" });
    seed(b, "gem", "gemini-2.5-flash", { adapter: "gemini" });
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "summarize this document for me please, it is quite long",
        parts: [{ type: "document", mediaType: "application/pdf", base64: "AAA" }],
      },
    ];
    const d = new SmartRouter(b.storage, adapters).route({ messages });
    expect(d).toBeDefined();
    // gemini serialises documents natively; openai_compatible does not.
    expect(d!.modelId).toBe("gemini-2.5-flash");
    b.storage.close();
  });

  test("a provider without a credential is never picked", () => {
    const b = build();
    seed(b, "nokey", "llama-3.1-8b-instruct");
    seed(b, "strong", "claude-opus-4");
    // Remove the credential row entirely.
    const all = b.storage.listProviders();
    const nokey = all.find((p) => p.label === "nokey")!;
    b.storage.deleteCredential(nokey.id);
    const d = new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] });
    expect(d).toBeDefined();
    expect(d!.modelId).toBe("claude-opus-4");
    b.storage.close();
  });

  test("disabled models are excluded", () => {
    const b = build();
    const cheap = seed(b, "cheap", "llama-3.1-8b-instruct");
    seed(b, "strong", "claude-opus-4");
    b.models.setEnabled(cheap.modelDbId, false);
    const d = new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] });
    expect(d).toBeDefined();
    expect(d!.modelId).toBe("claude-opus-4");
    b.storage.close();
  });

  test("deterministic tie-break: identical candidates pick the lower provider id, stably", () => {
    const b = build();
    seed(b, "a", "same-model-xyz");
    seed(b, "b", "same-model-xyz");
    const router = new SmartRouter(b.storage, adapters);
    const first = router.route({ messages: [msg("hi")] });
    const second = router.route({ messages: [msg("hi")] });
    expect(first).toBeDefined();
    expect(first).toEqual(second);
    // Provider ids ascend with creation order, so "a" wins the tie.
    expect(first!.providerLabel).toBe("a");
    b.storage.close();
  });

  test("the active selection wins ties but never a score difference", () => {
    const b = build();
    seed(b, "a", "same-model-xyz");
    const second = seed(b, "b", "same-model-xyz");
    const router = new SmartRouter(b.storage, adapters);
    const prefer = { providerId: second.providerId, modelId: "same-model-xyz" };
    // Equal scores: the preferred (active) provider wins the tie.
    const d = router.route({ messages: [msg("hi")] }, { prefer });
    expect(d).toBeDefined();
    expect(d!.providerLabel).toBe("b");
    // A strict score difference still beats the preference: "hi" is trivial,
    // so the cheap model wins even when the expensive one is preferred.
    const c = build();
    seed(c, "cheap", "llama-3.1-8b-instruct");
    const strong = seed(c, "strong", "claude-opus-4");
    const d2 = new SmartRouter(c.storage, adapters).route(
      { messages: [msg("hi")] },
      { prefer: { providerId: strong.providerId, modelId: "claude-opus-4" } },
    );
    expect(d2).toBeDefined();
    expect(d2!.modelId).toBe("llama-3.1-8b-instruct");
    b.storage.close();
    c.storage.close();
  });

  test("falls back to the strongest candidate when nothing meets the tier floor", () => {
    const b = build();
    seed(b, "cheap", "llama-3.1-8b-instruct");
    seed(b, "cheaper", "qwen-2.5-7b-instruct");
    const d = new SmartRouter(b.storage, adapters).route({
      messages: [msg("lorem ipsum ".repeat(800))],
    });
    // No strong model exists; the request must still go somewhere.
    expect(d).toBeDefined();
    b.storage.close();
  });

  test("cost overrides win over defaults", () => {
    const b = build();
    seed(b, "cheap", "llama-3.1-8b-instruct");
    seed(b, "strong", "claude-opus-4");
    const router = new SmartRouter(b.storage, adapters, {
      costHints: { exact: { "claude-opus-4": 1 } },
    });
    const d = router.route({ messages: [msg("hi")] });
    expect(d).toBeDefined();
    expect(d!.modelId).toBe("claude-opus-4");
    b.storage.close();
  });

  test("shouldRoute needs 2+ eligible providers", () => {
    const b = build();
    seed(b, "only", "llama-3.1-8b-instruct");
    expect(new SmartRouter(b.storage, adapters).shouldRoute()).toBe(false);
    seed(b, "second", "claude-opus-4");
    expect(new SmartRouter(b.storage, adapters).shouldRoute()).toBe(true);
    b.storage.close();
  });

  test("no candidates → undefined decision", () => {
    const b = build();
    expect(new SmartRouter(b.storage, adapters).route({ messages: [msg("hi")] })).toBeUndefined();
    b.storage.close();
  });
});

// ---------- gateway integration ----------

function recordingAdapters(log: string[]) {
  return {
    create: (_type: string, cfg: { model: string }) =>
      ({
        name: "recorder",
        complete: async (req: { model: string; timeoutMs: number }) => {
          log.push(`${req.model}@${req.timeoutMs}`);
          void cfg;
          return { text: "ok", model: req.model };
        },
      }) as unknown as AdapterRegistry,
  } as unknown as AdapterRegistry;
}

const GATEWAY_REQ = {
  messages: [{ role: "user" as const, content: "hi" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

describe("gateway smart-routing integration", () => {
  test("trivial request routes to the cheapest model, not the active selection", async () => {
    const b = build();
    const log: string[] = [];
    const gateway = new AiGateway({
      storage: b.storage,
      adapters: recordingAdapters(log),
      secrets: b.secrets,
    });
    seed(b, "cheap", "llama-3.1-8b-instruct");
    const strong = seed(b, "strong", "claude-opus-4");
    // The owner selected the STRONG pair — routing should override for "hi".
    b.storage.setRuntimeSelection({ providerId: strong.providerId, modelId: strong.modelDbId });
    const res = await gateway.complete(GATEWAY_REQ);
    expect(res.text).toBe("ok");
    expect(log).toEqual(["llama-3.1-8b-instruct@1000"]);
    b.storage.close();
  });

  test("with the kill switch off, the active selection is used exactly", async () => {
    const b = build();
    const log: string[] = [];
    const gateway = new AiGateway({
      storage: b.storage,
      adapters: recordingAdapters(log),
      secrets: b.secrets,
    });
    seed(b, "cheap", "llama-3.1-8b-instruct");
    const strong = seed(b, "strong", "claude-opus-4");
    b.storage.setRuntimeSelection({ providerId: strong.providerId, modelId: strong.modelDbId });
    process.env[SMART_ROUTING_ENV_VAR] = "0";
    await gateway.complete(GATEWAY_REQ);
    expect(log).toEqual(["claude-opus-4@1000"]);
    b.storage.close();
  });

  test("single provider: existing behavior is unchanged", async () => {
    const b = build();
    const log: string[] = [];
    const gateway = new AiGateway({
      storage: b.storage,
      adapters: recordingAdapters(log),
      secrets: b.secrets,
    });
    const only = seed(b, "only", "some-model");
    b.storage.setRuntimeSelection({ providerId: only.providerId, modelId: only.modelDbId });
    await gateway.complete(GATEWAY_REQ);
    expect(log).toEqual(["some-model@1000"]);
    b.storage.close();
  });
});
