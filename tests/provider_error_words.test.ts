/**
 * Provider error words: a non-2xx body is no longer discarded.
 *
 * Adapters used to throw the mapped label alone, so a 9Router 401 whose
 * body literally says "API key required for remote API access" surfaced
 * as a bare "Key or address was not accepted (HTTP 403)". Now the status
 * mapper extracts the provider's own words (sanitized, capped, with the
 * request credential redacted) onto AiError.providerMessage, and the
 * probe + chat surfaces quote them — once, with the status named once.
 *
 * Offline throughout: loopback doubles + a recording fake registry.
 */
import { describe, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import { GeminiAdapter } from "../src/ai/gemini";
import { AiError } from "../src/ai/provider";
import type { CompletionRequest } from "../src/ai/provider";
import {
  extractProviderMessage,
  statusToAiError,
  withHttpStatusSuffix,
} from "../src/ai/http_status";
import { Storage } from "../src/storage/storage";
import { AdapterRegistry, type AdapterConfig } from "../src/ai/adapter_registry";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderProbeService } from "../src/ai/provider_probe";
import type { AIProviderAdapter } from "../src/ai/adapter";
import type { CompletionResponse } from "../src/ai/provider";
import { EngineError } from "../src/conversation/engine";
import { userFacingMessage } from "../src/bot/bot";

// ------------------------------------------------------------ doubles ----

interface Double {
  port: number;
  close: () => void;
}

async function double(
  respond: (res: ServerResponse) => void,
): Promise<Double> {
  const server: Server = createServer((_req, res) => respond(res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, close: () => server.close() };
}

function request(): CompletionRequest {
  return {
    messages: [{ role: "user", content: "ping" }],
    model: "test-model",
    timeoutMs: 2000,
    signal: new AbortController().signal,
  };
}

async function errorOf(p: Promise<unknown>): Promise<AiError> {
  const err = await p.catch((e: unknown) => e);
  if (err instanceof AiError) return err;
  throw new Error(`expected AiError, got ${String(err)}`);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ------------------------------------------------- mapper unit behavior ----

describe("extractProviderMessage", () => {
  test("reads error.message, error string, message, and detail shapes", () => {
    expect(
      extractProviderMessage('{"error":{"message":"quota is gone"}}'),
    ).toBe("quota is gone");
    expect(
      extractProviderMessage('{"error":"API key required for remote API access"}'),
    ).toBe("API key required for remote API access");
    expect(extractProviderMessage('{"message":"slow down"}')).toBe("slow down");
    expect(extractProviderMessage('{"detail":"bad model name"}')).toBe(
      "bad model name",
    );
    expect(
      extractProviderMessage('{"detail":[{"msg":"field required"},{"msg":"too long"}]}'),
    ).toBe("field required; too long");
  });

  test("sanitizes a non-JSON body: tags and control chars stripped", () => {
    const out = extractProviderMessage(
      "<html><body><h1>404</h1> <p>Not Found</p></body></html>",
    );
    expect(out).toBe("404 Not Found");
    expect(out).not.toContain("<");
  });

  test("empty, blank, and missing bodies yield undefined", () => {
    expect(extractProviderMessage(undefined)).toBeUndefined();
    expect(extractProviderMessage("")).toBeUndefined();
    expect(extractProviderMessage("   \n ")).toBeUndefined();
    expect(extractProviderMessage("{}")).toBeUndefined();
  });

  test("hard-caps the extracted text", () => {
    const out = extractProviderMessage("x".repeat(900));
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(600);
  });

  test("redacts the request credential wherever the provider echoed it", () => {
    const out = extractProviderMessage(
      '{"error":{"message":"key sk-echo-123 was rejected (sk-echo-123)"}}',
      "sk-echo-123",
    );
    expect(out).toBe("key ••• was rejected (•••)");
    expect(out).not.toContain("sk-echo-123");
  });
});

describe("extractProviderMessage unwraps nested relay envelopes", () => {
  const FREE_TIER =
    "OpenCode's free models aren't available from your current network.";

  test("a [403]: {…FreeTierError…} relay string unwraps to the sentence", () => {
    // The live 9Router incident shape: the router embedded the upstream
    // body as a string inside its own error field.
    const inner = JSON.stringify({
      type: "error",
      error: { type: "FreeTierError", message: FREE_TIER },
    });
    const body = JSON.stringify({ error: `[403]: ${inner}` });
    expect(extractProviderMessage(body)).toBe(FREE_TIER);
  });

  test("two relay levels unwrap", () => {
    const lvl2 = JSON.stringify({ error: { message: "deep cause" } });
    const lvl1 = JSON.stringify({ message: `[500]: ${lvl2}` });
    const body = JSON.stringify({ error: `[502]: ${lvl1}` });
    expect(extractProviderMessage(body)).toBe("deep cause");
  });

  test("a relay prefix on a non-JSON string is left untouched", () => {
    expect(extractProviderMessage('{"error":"[403]: upstream said no"}')).toBe(
      "[403]: upstream said no",
    );
  });

  test("a JSON-looking string without error fields is left untouched", () => {
    expect(extractProviderMessage('{"error":"[403]: {\\"foo\\":1}"}')).toBe(
      '[403]: {"foo":1}',
    );
  });

  test("redaction still applies after the unwrap", () => {
    const inner = JSON.stringify({
      error: { message: "key sk-nested-1 blocked" },
    });
    const body = JSON.stringify({ error: `[401]: ${inner}` });
    const out = extractProviderMessage(body, "sk-nested-1");
    expect(out).toBe("key ••• blocked");
    expect(out).not.toContain("sk-nested-1");
  });

  test("statusToAiError carries the unwrapped sentence", () => {
    const inner = JSON.stringify({
      type: "error",
      error: { type: "FreeTierError", message: FREE_TIER },
    });
    const err = statusToAiError(403, undefined, {
      body: JSON.stringify({ error: `[403]: ${inner}` }),
    });
    expect(err.providerMessage).toBe(FREE_TIER);
  });
});

describe("statusToAiError with a body", () => {
  test("attaches providerMessage and keeps the mapped label untouched", () => {
    const err = statusToAiError(401, undefined, {
      body: '{"error":"API key required for remote API access"}',
    });
    expect(err.kind).toBe("auth");
    expect(err.message).toBe("Service authentication failed.");
    expect(err.providerMessage).toBe(
      "API key required for remote API access",
    );
  });

  test("no body → no providerMessage (previous behavior)", () => {
    const err = statusToAiError(403);
    expect(err.providerMessage).toBeUndefined();
    expect(err.message).toBe("Service authentication failed.");
  });

  test("an unreadable/empty body → no providerMessage", () => {
    const err = statusToAiError(403, undefined, { body: "" });
    expect(err.providerMessage).toBeUndefined();
  });
});

describe("withHttpStatusSuffix", () => {
  test("appends once and never duplicates the same status", () => {
    expect(withHttpStatusSuffix("Nope.", 403)).toBe("Nope. (HTTP 403)");
    expect(withHttpStatusSuffix("Nope (HTTP 403).", 403)).toBe(
      "Nope (HTTP 403).",
    );
    expect(
      withHttpStatusSuffix(
        withHttpStatusSuffix("Nope.", 403),
        403,
      ),
    ).toBe("Nope. (HTTP 403)");
  });
});

// ------------------------------------------------------- adapter level ----

describe("adapters capture the provider's words", () => {
  test("OpenAI-compatible 403 with a JSON body carries the provider text", async () => {
    const d = await double((res) =>
      res
        .writeHead(403, { "content-type": "application/json" })
        .end('{"error":"API key required for remote API access"}'),
    );
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const err = await errorOf(adapter.complete(request()));
      expect(err.kind).toBe("auth");
      expect(err.status).toBe(403);
      expect(err.providerMessage).toBe(
        "API key required for remote API access",
      );
    } finally {
      d.close();
    }
  });

  test("OpenAI-compatible streaming 403 (before any delta) carries it too", async () => {
    const d = await double((res) =>
      res
        .writeHead(403, { "content-type": "application/json" })
        .end('{"error":{"message":"remote access needs a key"}}'),
    );
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const err = await errorOf(
        (async () => {
          for await (const _event of adapter.completeStream!(request())) {
            // The error status throws before the first event.
          }
        })(),
      );
      expect(err.kind).toBe("auth");
      expect(err.providerMessage).toBe("remote access needs a key");
    } finally {
      d.close();
    }
  });

  test("Gemini 403 with its error envelope carries error.message", async () => {
    const d = await double((res) =>
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(
          '{"error":{"code":403,"message":"API key not valid. Please pass a valid API key.","status":"PERMISSION_DENIED"}}',
        ),
    );
    try {
      const adapter = new GeminiAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1beta`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const err = await errorOf(adapter.complete(request()));
      expect(err.providerMessage).toBe(
        "API key not valid. Please pass a valid API key.",
      );
    } finally {
      d.close();
    }
  });

  test("an HTML 404 body yields a sanitized snippet, no tags", async () => {
    const d = await double((res) =>
      res
        .writeHead(404, { "content-type": "text/html" })
        .end("<html><head><title>404</title></head><body><h1>Not Found</h1></body></html>"),
    );
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const err = await errorOf(adapter.complete(request()));
      expect(err.kind).toBe("invalid_response");
      expect(err.providerMessage).toBeDefined();
      expect(err.providerMessage).not.toContain("<");
      expect(err.providerMessage).toContain("Not Found");
    } finally {
      d.close();
    }
  });

  test("an empty 403 body leaves providerMessage undefined and the label unchanged", async () => {
    const d = await double((res) => res.writeHead(403).end());
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      const err = await errorOf(adapter.complete(request()));
      expect(err.providerMessage).toBeUndefined();
      expect(err.message).toBe("Service authentication failed.");
    } finally {
      d.close();
    }
  });

  test("a body echoing the request key is surfaced redacted", async () => {
    const KEY = "sk-echo-123";
    const d = await double((res) =>
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(`{"error":{"message":"credential ${KEY} is not recognized"}}`),
    );
    try {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1`,
        apiKey: KEY,
        allowLocalTargets: true,
      });
      const err = await errorOf(adapter.complete(request()));
      expect(err.providerMessage).toBe("credential ••• is not recognized");
      expect(err.providerMessage).not.toContain(KEY);
      expect(err.message).not.toContain(KEY);
    } finally {
      d.close();
    }
  });
});

// ---------------------------------------------------------- probe level ----

class ThrowingAdapters extends AdapterRegistry {
  failWith: unknown;
  override create(_type: string, _cfg: AdapterConfig): AIProviderAdapter {
    const self = this;
    return {
      name: "fake",
      type: "openai_compatible",
      label: "fake",
      capabilities: {},
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        if (self.failWith !== undefined) throw self.failWith;
        return { text: "pong", model: req.model };
      },
    };
  }
}

function probeHarness(failWith: unknown): {
  health: ProviderProbeService;
  providerId: number;
  close: () => void;
} {
  const storage = Storage.open(":memory:");
  const secrets = new ProviderSecretStore("provider-words-test-key");
  const adapters = new ThrowingAdapters();
  adapters.failWith = failWith;
  const providers = new ProviderService(storage, secrets, adapters);
  const models = new ModelService(storage);
  const health = new ProviderProbeService(storage, providers, secrets, adapters);
  const created = providers.create({
    label: "Test provider",
    adapter: "openai_compatible",
    baseUrl: "https://api.invalid.example/v1",
    apiKey: "sk-test-credential",
  });
  if (!created.ok) throw new Error("provider create failed");
  const m = models.add({ providerId: created.data, modelId: "m1", label: "M1" });
  if (!m.ok) throw new Error("model add failed");
  models.setDefault(m.data);
  return { health, providerId: created.data, close: () => storage.close() };
}

describe("probe messages quote the provider once", () => {
  test("403 with words: text present once, status named once", async () => {
    const h = probeHarness(
      statusToAiError(403, undefined, {
        body: '{"error":"API key required for remote API access"}',
      }),
    );
    try {
      const result = await h.health.probe(h.providerId);
      expect(result.ok).toBe(false);
      expect(result.message).toBe(
        "Key or address was not accepted (HTTP 403). Provider said: API key required for remote API access",
      );
      expect(occurrences(result.message!, "(HTTP 403)")).toBe(1);
      expect(
        occurrences(result.message!, "API key required for remote API access"),
      ).toBe(1);
    } finally {
      h.close();
    }
  });

  test("403 with an empty body: byte-identical to the old probe message", async () => {
    const h = probeHarness(statusToAiError(403));
    try {
      const result = await h.health.probe(h.providerId);
      expect(result.message).toBe("Key or address was not accepted (HTTP 403).");
    } finally {
      h.close();
    }
  });
});

// ----------------------------------------------------------- chat level ----

describe("chat-facing errors quote the provider", () => {
  test("userFacingMessage appends the provider's words", () => {
    const err = new EngineError(
      "auth",
      "Service authentication failed.",
      403,
      undefined,
      "API key required for remote API access",
    );
    const message = userFacingMessage(err, "en");
    expect(message).toContain("Authentication failed");
    expect(message).toContain(
      'Provider said: "API key required for remote API access"',
    );
  });

  test("without provider words the chat message is unchanged", () => {
    const err = new EngineError("auth", "Service authentication failed.", 403);
    const message = userFacingMessage(err, "en");
    expect(message).not.toContain("Provider said");
  });
});
