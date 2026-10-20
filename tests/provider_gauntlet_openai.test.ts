/**
 * OpenAI-family gauntlet (audit v2 G2/G3, OpenAI-family rows) + the
 * Wave-3 fixes:
 *
 *  - L2: a streamed tool-call fragment WITHOUT an `index` continues the
 *    most recently touched call (it used to be keyed to a fresh slot,
 *    splitting one logical call into several same-name calls that would
 *    all execute — or silently mangling its arguments).
 *  - L8: the Kimi/Moonshot preset exists and completes like its siblings.
 *
 * Every preset-driven case constructs the adapter FROM the preset (via
 * the registry): the preset's real base URL string is asserted as a
 * constant, then only the ORIGIN is swapped for the loopback fake, so
 * per-preset path drift (the v1 L2 failure mode) is caught.
 *
 * Hermetic throughout: loopback fakes speaking real OpenAI-wire shapes,
 * following provider_error_words.test.ts / provider_gauntlet_gemini.test.ts.
 * No network, no real keys.
 */
import { describe, expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import { providerPreset } from "../src/ai/adapter";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { AiError } from "../src/ai/provider";
import type {
  CompletionRequest,
  StreamEvent,
  ToolSpec,
} from "../src/ai/provider";
import { Storage } from "../src/storage/storage";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { setupFromPreset } from "../src/ai/setup";
import type { AIProviderAdapter } from "../src/ai/adapter";

// ------------------------------------------------------------- doubles ----

interface SeenRequest {
  method: string;
  /** Raw request target as it arrived on the wire (path + query). */
  rawUrl: string;
  pathname: string;
  authorization: string | undefined;
  json: Record<string, unknown> | undefined;
}

interface Fake {
  port: number;
  seen: SeenRequest[];
  close: () => void;
}

async function fake(
  handler: (seen: SeenRequest, res: ServerResponse) => void,
): Promise<Fake> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let json: Record<string, unknown> | undefined;
      if (raw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            json = parsed as Record<string, unknown>;
          }
        } catch {
          json = undefined;
        }
      }
      const entry: SeenRequest = {
        method: req.method ?? "",
        rawUrl: req.url ?? "",
        pathname: url.pathname,
        authorization: req.headers["authorization"],
        json,
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, seen, close: () => server.close() };
}

const KEY = "gauntlet-key";

/**
 * Build the adapter for a preset exactly as production does (registry,
 * preset base URL) with ONLY the origin swapped to the loopback fake —
 * the preset's path (`/v1`, `/openai/v1`, …) rides along untouched.
 */
function adapterFromPreset(presetId: string, port: number): AIProviderAdapter {
  const preset = providerPreset(presetId);
  if (preset === undefined) throw new Error(`missing preset ${presetId}`);
  const path = new URL(preset.baseUrl).pathname.replace(/\/+$/, "");
  return new AdapterRegistry().create("openai_compatible", {
    baseUrl: `http://127.0.0.1:${port}${path}`,
    apiKey: KEY,
    model: preset.suggestedModel ?? "test-model",
    allowLocalTargets: true,
  });
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    model: "test-model",
    timeoutMs: 2000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function errorOf(p: Promise<unknown>): Promise<AiError> {
  const err = await p.catch((e: unknown) => e);
  if (err instanceof AiError) return err;
  throw new Error(`expected AiError, got ${String(err)}`);
}

function json200(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

function sse200(res: ServerResponse, events: readonly unknown[]): void {
  const body =
    events
      .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  res.writeHead(200, { "content-type": "text/event-stream" }).end(body);
}

/** A realistic chat.completion payload echoing the requested model. */
function completionPayload(seen: SeenRequest, content: string): unknown {
  return {
    id: "chatcmpl-gauntlet",
    object: "chat.completion",
    model: seen.json?.["model"] ?? "unknown",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
  };
}

async function collectStream(
  adapter: AIProviderAdapter,
  req: CompletionRequest,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of adapter.completeStream!(req)) out.push(event);
  return out;
}

const TOOLS: ToolSpec[] = [
  {
    name: "calculator",
    description: "Add numbers",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

// ------------------------------------------------------- OpenAI golden ----

describe("OpenAI gauntlet — golden complete with tools", () => {
  test("request shape (model/messages/tools/auth) asserted; tool_calls response parses", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        id: "chatcmpl-tools",
        object: "chat.completion",
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "calculator", arguments: '{"a":5,"b":2}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
      }),
    );
    try {
      // The OpenAI template endpoint, origin-swapped like every preset.
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${f.port}/v1`,
        apiKey: KEY,
        allowLocalTargets: true,
      });
      const res = await adapter.complete(
        request({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "add 5 and 2" }],
          tools: TOOLS,
        }),
      );

      expect(res.text).toBe("");
      expect(res.model).toBe("gpt-4o-mini");
      expect(res.toolCalls).toEqual([
        { id: "call_1", name: "calculator", arguments: { a: 5, b: 2 } },
      ]);
      expect(res.usage).toEqual({ inputTokens: 21, outputTokens: 7 });

      expect(f.seen).toHaveLength(1);
      const seen = f.seen[0]!;
      expect(seen.method).toBe("POST");
      expect(seen.pathname).toBe("/v1/chat/completions");
      expect(seen.authorization).toBe(`Bearer ${KEY}`);
      const body = seen.json!;
      expect(body["model"]).toBe("gpt-4o-mini");
      expect(body["messages"]).toEqual([{ role: "user", content: "add 5 and 2" }]);
      expect(body["tools"]).toEqual([
        {
          type: "function",
          function: {
            name: "calculator",
            description: "Add numbers",
            parameters: TOOLS[0]!.parameters,
          },
        },
      ]);
    } finally {
      f.close();
    }
  });
});

describe("OpenAI gauntlet — golden stream with fragmented tool deltas (L2)", () => {
  // Two interleaved calls. Chunk 6 carries NO index: it must continue
  // call_b (index 1, the most recently touched), completing its
  // arguments — the L2 pin. Chunk 7 returns to index 0.
  const STREAM_EVENTS: readonly unknown[] = [
    { choices: [{ delta: { role: "assistant", content: "" } }] },
    { choices: [{ delta: { content: "Let me" } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_a", function: { name: "calculator", arguments: '{"a":' } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "5," } }] } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, id: "call_b", function: { name: "reminder", arguments: '{"text":' } },
            ],
          },
        },
      ],
    },
    // Index-less fragment: continues call_b, NOT a fresh third call.
    { choices: [{ delta: { tool_calls: [{ function: { arguments: '"wake"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b":2}' } }] } }] },
    { choices: [{ delta: { content: " compute." } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
  ];

  test("interleaved indexed + index-less fragments assemble into exactly the two calls", async () => {
    const f = await fake((_seen, res) => sse200(res, STREAM_EVENTS));
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${f.port}/v1`,
        apiKey: KEY,
        allowLocalTargets: true,
      });
      const events = await collectStream(
        adapter,
        request({ model: "gpt-4o-mini", tools: TOOLS }),
      );

      const deltas = events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta);
      expect(deltas).toEqual(["Let me", " compute."]);
      expect(events.filter((e) => e.type === "usage")).toEqual([
        { type: "usage", usage: { inputTokens: 12, outputTokens: 8 } },
      ]);

      const end = events[events.length - 1]!;
      if (end.type !== "end") throw new Error("expected end");
      expect(end.text).toBe("Let me compute.");
      // Exactly two calls: the index-less fragment did not spawn a third.
      expect(end.toolCalls).toEqual([
        { id: "call_a", name: "calculator", arguments: { a: 5, b: 2 } },
        { id: "call_b", name: "reminder", arguments: { text: "wake" } },
      ]);
      expect(end.usage).toEqual({ inputTokens: 12, outputTokens: 8 });

      const body = f.seen[0]!.json!;
      expect(body["stream"]).toBe(true);
      expect(body["stream_options"]).toEqual({ include_usage: true });
    } finally {
      f.close();
    }
  });

  test("a stream whose fragments NEVER carry an index assembles one call", async () => {
    const f = await fake((_seen, res) =>
      sse200(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: "call_x", function: { name: "calculator", arguments: '{"a":' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ function: { arguments: "1}" } }] } }] },
        { choices: [{ delta: { content: "done" }, finish_reason: "tool_calls" }] },
      ]),
    );
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${f.port}/v1`,
        apiKey: KEY,
        allowLocalTargets: true,
      });
      const events = await collectStream(adapter, request({ tools: TOOLS }));
      const end = events[events.length - 1]!;
      if (end.type !== "end") throw new Error("expected end");
      // Both fragments belong to the single (first) call.
      expect(end.toolCalls).toEqual([
        { id: "call_x", name: "calculator", arguments: { a: 1 } },
      ]);
    } finally {
      f.close();
    }
  });
});

// ------------------------------------------------------ per-preset goldens ----

const PRESET_BASE_URLS: Readonly<Record<string, string>> = {
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  kimi: "https://api.moonshot.ai/v1",
};

describe("OpenAI gauntlet — per-preset golden completions", () => {
  for (const [presetId, expectedBaseUrl] of Object.entries(PRESET_BASE_URLS)) {
    test(`${presetId}: preset baseUrl constant + golden completion through the shared adapter`, async () => {
      const preset = providerPreset(presetId);
      expect(preset).toBeDefined();
      expect(preset!.baseUrl).toBe(expectedBaseUrl);
      expect(preset!.suggestedModel).toBeDefined();

      const f = await fake((seen, res) =>
        json200(res, completionPayload(seen, `Hello from ${presetId}`)),
      );
      try {
        const adapter = adapterFromPreset(presetId, f.port);
        const res = await adapter.complete(
          request({ model: preset!.suggestedModel! }),
        );
        expect(res.text).toBe(`Hello from ${presetId}`);
        expect(res.model).toBe(preset!.suggestedModel!);
        expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 4 });

        expect(f.seen).toHaveLength(1);
        const seen = f.seen[0]!;
        // The preset's own path survived the origin swap.
        const presetPath = new URL(expectedBaseUrl).pathname.replace(/\/+$/, "");
        expect(seen.pathname).toBe(`${presetPath}/chat/completions`);
        expect(seen.authorization).toBe(`Bearer ${KEY}`);
        expect(seen.json!["model"]).toBe(preset!.suggestedModel);
        expect(seen.json!["messages"]).toEqual([{ role: "user", content: "hi" }]);
      } finally {
        f.close();
      }
    });
  }
});

// ------------------------------------------------------------ error shapes ----

describe("OpenAI gauntlet — error fixtures (G3)", () => {
  test("OpenRouter 402: kind quota + the provider's words verbatim", async () => {
    const MESSAGE =
      "Insufficient credits. Add funds to your OpenRouter account to continue.";
    const f = await fake((_seen, res) =>
      res
        .writeHead(402, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: MESSAGE, code: 402 } })),
    );
    try {
      const adapter = adapterFromPreset("openrouter", f.port);
      const err = await errorOf(
        adapter.complete(request({ model: providerPreset("openrouter")!.suggestedModel! })),
      );
      expect(err.kind).toBe("quota");
      expect(err.status).toBe(402);
      expect(err.providerMessage).toBe(MESSAGE);
    } finally {
      f.close();
    }
  });

  test("OpenCode Zen 403 FreeTierError: the nested envelope's sentence surfaces", async () => {
    const MESSAGE =
      "OpenCode's free models aren't available from your current network.";
    const f = await fake((_seen, res) =>
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            type: "error",
            error: { type: "FreeTierError", message: MESSAGE },
          }),
        ),
    );
    try {
      const adapter = adapterFromPreset("opencode", f.port);
      const err = await errorOf(
        adapter.complete(request({ model: providerPreset("opencode")!.suggestedModel! })),
      );
      expect(err.kind).toBe("auth");
      expect(err.status).toBe(403);
      expect(err.providerMessage).toBe(MESSAGE);
      expect(err.providerMessage).toContain("free models aren't available");
    } finally {
      f.close();
    }
  });
});

// ------------------------------------------------------------- Cloudflare ----

describe("OpenAI gauntlet — Cloudflare Workers AI end-to-end", () => {
  const ACCOUNT_ID = "cf-gauntlet-account-1234";

  test("save via setupFromPreset with the substituted URL → probe + chat hit the substituted path only", async () => {
    const preset = providerPreset("cloudflare")!;
    expect(preset.baseUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1",
    );
    expect(preset.requiredPlaceholder).toBe("ACCOUNT_ID");

    // The substitution exactly as the panel/onboarding perform it.
    const realSubstituted = preset.baseUrl.replace("{ACCOUNT_ID}", ACCOUNT_ID);
    expect(realSubstituted).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`,
    );
    expect(realSubstituted).not.toContain("{ACCOUNT_ID}");

    const f = await fake((seen, res) => {
      if (seen.pathname.endsWith("/chat/completions")) {
        if (seen.json?.["stream"] === true) {
          sse200(res, [
            { choices: [{ delta: { content: "cf-pong" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
          ]);
          return;
        }
        json200(res, completionPayload(seen, "cf-pong"));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
    });

    const storage = Storage.open(":memory:");
    try {
      const secrets = new ProviderSecretStore("gauntlet-cf-key");
      const registry = new AdapterRegistry();
      const providers = new ProviderService(storage, secrets, registry);
      const models = new ModelService(storage);
      const deps = { storage, providers, models, secrets };

      // The unsubstituted template is refused by the real save path.
      const refused = setupFromPreset(deps, "cloudflare", "cf-token");
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("{ACCOUNT_ID}");
      expect(providers.listViews()).toHaveLength(0);

      // Origin swap only: the substituted path rides to the loopback fake.
      const loopbackUrl = `http://127.0.0.1:${f.port}${new URL(realSubstituted).pathname}`;
      const saved = setupFromPreset(deps, "cloudflare", "cf-token", loopbackUrl);
      expect(saved.ok).toBe(true);
      const providerId = saved.providerId!;
      expect(saved.activatedModel).toBe(preset.suggestedModel);
      // The owner's loopback exception, via its production route.
      expect(providers.setAllowLocal(providerId, true).ok).toBe(true);

      const row = storage.getProvider(providerId)!;
      expect(row.baseUrl).toBe(loopbackUrl);
      expect(row.baseUrl).toContain(ACCOUNT_ID);
      expect(row.baseUrl).not.toContain("{ACCOUNT_ID}");

      // Probe (two-stage: ping completion + realistic stream).
      const health = new ProviderHealthService(storage, providers, secrets, registry);
      const probe = await health.probe(providerId);
      expect(probe.ok).toBe(true);

      // Chat, built from the stored row the way the gateway builds it.
      const chat = registry.create(row.adapter, {
        baseUrl: row.baseUrl,
        apiKey: providers.credentialFor(providerId),
        model: preset.suggestedModel!,
        allowLocalTargets: true,
      });
      const res = await chat.complete(request({ model: preset.suggestedModel! }));
      expect(res.text).toBe("cf-pong");

      // Every wire request went to the substituted account path; the
      // literal placeholder never reached the wire in any form.
      expect(f.seen.length).toBeGreaterThanOrEqual(3);
      for (const seen of f.seen) {
        expect(seen.pathname.startsWith(`/client/v4/accounts/${ACCOUNT_ID}/ai/v1/`)).toBe(true);
        expect(seen.rawUrl).not.toContain("{ACCOUNT_ID}");
        expect(seen.rawUrl).not.toContain("%7BACCOUNT_ID%7D");
      }
      expect(
        f.seen.some((s) => s.pathname.endsWith("/chat/completions")),
      ).toBe(true);
    } finally {
      storage.close();
      f.close();
    }
  });
});

// ---------------------------------------------------------------- 9Router ----

describe("OpenAI gauntlet — 9Router via the registry", () => {
  test("completion + listModels through the nine_router adapter (post-M4)", async () => {
    const f = await fake((seen, res) => {
      if (seen.pathname === "/v1/models") {
        json200(res, {
          object: "list",
          data: [{ id: "openai/gpt-4o-mini" }, { id: "anthropic/claude-sonnet-4-5" }],
        });
        return;
      }
      json200(res, completionPayload(seen, "Hello from 9Router"));
    });
    try {
      const registry = new AdapterRegistry();
      expect(registry.describes("nine_router").listModels).toBe(true);
      const adapter = registry.create("nine_router", {
        baseUrl: `http://127.0.0.1:${f.port}/v1`,
        apiKey: KEY,
        model: "openai/gpt-4o-mini",
        allowLocalTargets: true,
      });

      const res = await adapter.complete(request({ model: "openai/gpt-4o-mini" }));
      expect(res.text).toBe("Hello from 9Router");
      expect(res.model).toBe("openai/gpt-4o-mini");

      const models = await adapter.listModels!({
        target: { baseUrl: `http://127.0.0.1:${f.port}/v1`, apiKey: KEY },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(models.map((m) => m.id)).toEqual([
        "openai/gpt-4o-mini",
        "anthropic/claude-sonnet-4-5",
      ]);

      expect(f.seen.map((s) => s.pathname)).toEqual([
        "/v1/chat/completions",
        "/v1/models",
      ]);
      expect(f.seen[0]!.authorization).toBe(`Bearer ${KEY}`);
    } finally {
      f.close();
    }
  });
});

// ------------------------------------------------------- discovery junk (H5) ----

describe("OpenAI gauntlet — discovery junk pin (H5 regression)", () => {
  test("/models mixing non-chat families imports only the chat ids", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        object: "list",
        data: [
          { id: "gpt-4o-mini" },
          { id: "text-embedding-3-small" },
          { id: "whisper-1" },
          { id: "tts-1" },
          { id: "dall-e-3" },
          { id: "omni-moderation-latest" },
          { id: "gpt-4o-transcribe" },
          { id: "speech-2.0" },
          { id: "rerank-english-v3.0" },
          { id: "babbage-002" },
          { id: "gpt-4o-realtime-audio-preview" },
          // Kept on purpose: bare "audio" ids ARE chat models.
          { id: "gpt-4o-audio-preview" },
          { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
        ],
      }),
    );
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${f.port}/v1`,
        apiKey: KEY,
        allowLocalTargets: true,
      });
      const models = await adapter.listModels({
        target: { baseUrl: `http://127.0.0.1:${f.port}/v1`, apiKey: KEY },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(models.map((m) => m.id)).toEqual([
        "gpt-4o-mini",
        "gpt-4o-audio-preview",
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      ]);
      expect(f.seen[0]!.pathname).toBe("/v1/models");
      expect(f.seen[0]!.authorization).toBe(`Bearer ${KEY}`);
    } finally {
      f.close();
    }
  });
});
