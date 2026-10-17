import { describe, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { OpenAICompatibleAdapter } from "../src/ai/openai_compatible";
import { GeminiAdapter } from "../src/ai/gemini";
import { AnthropicAdapter } from "../src/ai/anthropic";
import { AiError } from "../src/ai/provider";
import type { CompletionRequest } from "../src/ai/provider";

/**
 * Controlled failure tests.
 *
 * Every double is a loopback server with `allowLocalTargets: true`, so no
 * test contacts a production API, an external endpoint, or an internal
 * target that the SSRF policy would otherwise refuse. No provider quota is
 * consumed because no provider is ever reached.
 */

interface Double {
  port: number;
  hits: number;
  close: () => void;
}

/** A loopback server driven by a scripted responder, one per request. */
async function double(
  respond: (seq: number, res: ServerResponse) => void,
): Promise<Double> {
  let seq = 0;
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits++;
    seq++;
    respond(seq, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    get hits() {
      return hits;
    },
    close: () => server.close(),
  };
}

/** A request that never blocks the adapter from being reused afterwards. */
function request(): CompletionRequest {
  return {
    messages: [{ role: "user", content: "ping" }],
    model: "test-model",
    timeoutMs: 2000,
    signal: new AbortController().signal,
  };
}

function openAi(port: number): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "k",
    allowLocalTargets: true,
  });
}

/** Run a call and return the AiError kind it produced. */
async function kindOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  if (err instanceof AiError) return err.kind;
  return `unexpected:${err instanceof Error ? err.name : typeof err}`;
}

// ---------- HTTP status classification ----------

describe("provider status classification", () => {
  test("401 and 403 map to auth", async () => {
    for (const status of [401, 403]) {
      const d = await double((_s, res) => res.writeHead(status).end());
      try {
        expect(await kindOf(openAi(d.port).complete(request()))).toBe("auth");
      } finally {
        d.close();
      }
    }
  });

  test("429 maps to quota", async () => {
    const d = await double((_s, res) => res.writeHead(429).end());
    try {
      expect(await kindOf(openAi(d.port).complete(request()))).toBe("quota");
    } finally {
      d.close();
    }
  });

  test("5xx maps to network", async () => {
    const d = await double((_s, res) => res.writeHead(503).end());
    try {
      expect(await kindOf(openAi(d.port).complete(request()))).toBe("network");
    } finally {
      d.close();
    }
  });

  test("400 maps to invalid_response", async () => {
    const d = await double((_s, res) => res.writeHead(400).end());
    try {
      expect(await kindOf(openAi(d.port).complete(request()))).toBe("invalid_response");
    } finally {
      d.close();
    }
  });

  test("a 3xx redirect is refused rather than followed", async () => {
    const d = await double((_s, res) =>
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end(),
    );
    try {
      expect(await kindOf(openAi(d.port).complete(request()))).toBe("invalid_response");
      // Exactly one request: the redirect target was never dialled.
      expect(d.hits).toBe(1);
    } finally {
      d.close();
    }
  });
});

// ---------- response shape ----------

describe("response validation", () => {
  test("a non-JSON body is invalid_response", async () => {
    const d = await double((_s, res) =>
      res.writeHead(200, { "content-type": "text/html" }).end("<html>oops</html>"),
    );
    try {
      expect(await kindOf(openAi(d.port).complete(request()))).toBe("invalid_response");
    } finally {
      d.close();
    }
  });

  test("a JSON array instead of an object is invalid_response", async () => {
    const d = await double((_s, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end("[]"),
    );
    try {
      expect(await kindOf(openAi(d.port).complete(request()))).toBe("invalid_response");
    } finally {
      d.close();
    }
  });

  test("a 200 with no choices is invalid_response", async () => {
    const d = await double((_s, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [] })),
    );
    try {
      expect(await kindOf(openAi(d.port).complete(request()))).toBe("invalid_response");
    } finally {
      d.close();
    }
  });

  test("a Gemini-shaped empty response is invalid_response", async () => {
    const d = await double((_s, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({})),
    );
    try {
      const adapter = new GeminiAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      expect(await kindOf(adapter.complete(request()))).toBe("invalid_response");
    } finally {
      d.close();
    }
  });

  test("an Anthropic-shaped empty response is invalid_response", async () => {
    const d = await double((_s, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({})),
    );
    try {
      const adapter = new AnthropicAdapter({
        baseUrl: `http://127.0.0.1:${d.port}/v1`,
        apiKey: "k",
        allowLocalTargets: true,
      });
      expect(await kindOf(adapter.complete(request()))).toBe("invalid_response");
    } finally {
      d.close();
    }
  });
});

// ---------- timeout, cancellation, recovery ----------

describe("timeout, cancellation and recovery", () => {
  test("a server that never answers times out, then the next call works", async () => {
    const d = await double((seq, res) => {
      if (seq === 1) return; // never respond
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "m" }));
    });
    try {
      const adapter = openAi(d.port);
      const slow = { ...request(), timeoutMs: 150 };
      expect(await kindOf(adapter.complete(slow))).toBe("timeout");

      // Recovery: the adapter is not left in a broken state.
      const res = await adapter.complete(request());
      expect(res.text).toBe("ok");
    } finally {
      d.close();
    }
  });

  test("a cancelled request reports aborted without opening a connection", async () => {
    // Always answer: the assertion we care about is that the cancelled request
    // never reaches the server at all, and that the adapter stays usable.
    const d = await double((_seq, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "m" }));
    });
    try {
      const adapter = openAi(d.port);
      const controller = new AbortController();
      const pending = adapter.complete({ ...request(), signal: controller.signal });
      controller.abort();
      expect(await kindOf(pending)).toBe("aborted");

      // The cancellation was honoured before any socket was dialled.
      expect(d.hits).toBe(0);

      // Recovery: a fresh request still succeeds.
      const res = await adapter.complete(request());
      expect(res.text).toBe("ok");
      expect(d.hits).toBe(1);
    } finally {
      d.close();
    }
  });

  test("a failing request does not poison the following one", async () => {
    const d = await double((seq, res) => {
      if (seq === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "recovered" } }], model: "m" }));
    });
    try {
      const adapter = openAi(d.port);
      expect(await kindOf(adapter.complete(request()))).toBe("network");
      const after = await adapter.complete(request());
      expect(after.text).toBe("recovered");
      expect(d.hits).toBe(2);
    } finally {
      d.close();
    }
  });

  test("the error message never carries the provider body or credentials", async () => {
    const d = await double((_s, res) =>
      res.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: { message: "SECRET-leak attempt sk-live-abcdefghijklmnop token=xyz" },
        }),
      ),
    );
    try {
      const err = await openAi(d.port).complete(request()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AiError);
      const message = (err as AiError).message;
      expect(message).not.toContain("sk-live");
      expect(message).not.toContain("SECRET");
      expect(message).not.toContain("token=");
    } finally {
      d.close();
    }
  });

  test("a refused connection is a network failure, not a crash", async () => {
    // Port 1 on loopback is almost certainly closed; nothing is dialled
    // outward because allowLocalTargets scopes this to loopback.
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "k",
      allowLocalTargets: true,
    });
    expect(await kindOf(adapter.complete({ ...request(), timeoutMs: 1500 }))).toBe("network");
  });
});
