/**
 * Audit C1: AiGateway.complete() must return the FULL CompletionResponse.
 *
 * Both success exits of complete() used to rebuild `{ text, model }` and
 * silently drop `toolCalls` and `usage` that attempt() had produced — so
 * on every non-streaming turn (and every stream→single-shot fallback turn)
 * a tool-only model reply became an empty "final answer" and no tool ever
 * ran. These tests pin the pass-through against a fake adapter registry
 * and in-memory storage (the ai_failover / ai_gateway_reliability harness
 * shape). No network is possible.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { AiGateway } from "../src/ai/gateway";
import type { CompletionResponse, StreamEvent } from "../src/ai/provider";

const KEY = "gateway-toolcalls-master-key";

async function withRoutingOff<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env["BOBI_SMART_ROUTING"];
  process.env["BOBI_SMART_ROUTING"] = "0";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["BOBI_SMART_ROUTING"];
    else process.env["BOBI_SMART_ROUTING"] = prev;
  }
}

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
        // No completeStream: the gateway synthesises a stream from this
        // single-shot complete() (the attemptStream path).
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

const REQUEST = {
  messages: [{ role: "user" as const, content: "یادآوری بساز" }],
  model: "ignored",
  timeoutMs: 1000,
  signal: new AbortController().signal,
};

const TOOL_CALL = {
  id: "call-1",
  name: "create_reminder",
  arguments: { text: "call mom", inMinutes: 30 },
} as const;

describe("gateway complete() returns tool calls and usage (C1)", () => {
  test("a tool-only response keeps its toolCalls and usage", async () => {
    await withRoutingOff(async () => {
      const h = build({
        text: "",
        model: "model-only",
        toolCalls: [TOOL_CALL],
        usage: { inputTokens: 11, outputTokens: 7 },
      });
      const res = await h.gateway.complete(REQUEST);
      expect(res.text).toBe("");
      expect(res.model).toBe("model-only");
      expect(res.toolCalls).toEqual([TOOL_CALL]);
      expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
      h.storage.close();
    });
  });

  test("a text+usage response still returns text/model/usage unchanged", async () => {
    await withRoutingOff(async () => {
      const h = build({
        text: "پاسخ کامل",
        model: "model-only",
        usage: { inputTokens: 3, outputTokens: 42 },
      });
      const res = await h.gateway.complete(REQUEST);
      expect(res.text).toBe("پاسخ کامل");
      expect(res.model).toBe("model-only");
      expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 42 });
      expect(res.toolCalls).toBeUndefined();
      h.storage.close();
    });
  });

  test("the synthesised stream's terminal end event carries the tool calls", async () => {
    await withRoutingOff(async () => {
      // The fake adapter has no completeStream, so completeStream() runs
      // the gateway's synthesised-stream path in attemptStream — its end
      // event must carry the single-shot response's toolCalls too.
      const h = build({
        text: "",
        model: "model-only",
        toolCalls: [TOOL_CALL],
        usage: { inputTokens: 5, outputTokens: 2 },
      });
      const events: StreamEvent[] = [];
      for await (const ev of h.gateway.completeStream(REQUEST)) events.push(ev);
      const end = events.find((e) => e.type === "end");
      expect(end?.type).toBe("end");
      if (end?.type === "end") {
        expect(end.toolCalls).toEqual([TOOL_CALL]);
        expect(end.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
        expect(end.model).toBe("model-only");
      }
      h.storage.close();
    });
  });
});
