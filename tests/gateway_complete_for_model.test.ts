/**
 * Phase 2, item 4: AiGateway.completeForModel() must return the FULL
 * CompletionResponse.
 *
 * completeForModel() used to rebuild `{ text, model }` and silently drop
 * `toolCalls` and `usage` that send() had produced — the same bug audit
 * C1 fixed in complete(). Mixture-of-agents orchestration calls
 * tool-capable models through this method, so a stripped toolCalls here
 * turns a tool request into an empty "final answer". These tests pin
 * the pass-through with the same fake-registry harness as
 * ai_gateway_toolcalls.test.ts. No network is possible.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import { AiError, type CompletionResponse } from "../src/ai/provider";

const KEY = "gateway-complete-for-model-master-key";

/** Build a gateway whose single fake adapter always answers `response`. */
function build(response: CompletionResponse) {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore(KEY);
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const log: string[] = [];

  const fakeAdapters = {
    create: (type: string, cfg: { model: string }) => {
      void type;
      void cfg;
      return {
        name: "fake",
        complete: async (req: { model: string }) => {
          log.push(req.model);
          return response;
        },
      } as unknown as ReturnType<AdapterRegistry["create"]>;
    },
  } as unknown as AdapterRegistry;

  const gateway = new AiGateway({ storage, adapters: fakeAdapters, secrets });

  const p = providers.create({
    label: "only",
    adapter: "openai_compatible",
    baseUrl: "https://only.invalid/v1",
    apiKey: "sk-only",
  });
  if (!p.ok) throw new Error("provider failed");
  const m = models.add({ providerId: p.data, modelId: "model-only", label: "only" });
  if (!m.ok) throw new Error("model failed");
  models.setDefault(m.data);
  storage.setRuntimeSelection({ providerId: p.data, modelId: m.data });

  return { storage, gateway, log };
}

/** completeForModel resolves by req.model, so it must name the seeded model. */
const REQUEST = {
  messages: [{ role: "user" as const, content: "یادآوری بساز" }],
  model: "model-only",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

const TOOL_CALL = {
  id: "call-1",
  name: "create_reminder",
  arguments: { text: "call mom", inMinutes: 30 },
} as const;

describe("gateway completeForModel() returns tool calls and usage", () => {
  test("a tool response keeps its toolCalls and usage intact", async () => {
    const h = build({
      text: "",
      model: "model-only",
      toolCalls: [TOOL_CALL],
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    const res = await h.gateway.completeForModel(REQUEST);
    expect(res.text).toBe("");
    expect(res.model).toBe("model-only");
    expect(res.toolCalls).toEqual([TOOL_CALL]);
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    h.storage.close();
  });

  test("a response without toolCalls returns none", async () => {
    const h = build({
      text: "پاسخ کامل",
      model: "model-only",
      usage: { inputTokens: 3, outputTokens: 42 },
    });
    const res = await h.gateway.completeForModel(REQUEST);
    expect(res.text).toBe("پاسخ کامل");
    expect(res.model).toBe("model-only");
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 42 });
    // Absent in the adapter response → absent (or undefined) here too,
    // never a fabricated empty value.
    expect(res.toolCalls).toBeUndefined();
    h.storage.close();
  });

  test("an unknown model still throws AiError (existing behaviour preserved)", async () => {
    const h = build({ text: "ok", model: "model-only" });
    let caught: unknown;
    try {
      await h.gateway.completeForModel({ ...REQUEST, model: "no-such-model" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiError);
    expect((caught as AiError).kind).toBe("invalid_response");
    h.storage.close();
  });
});
