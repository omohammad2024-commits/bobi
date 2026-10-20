/**
 * Gemini gauntlet (audit v2 G2/G3, Gemini rows) + the Wave-3 fixes:
 *
 *  - M2: discovery follows `nextPageToken` (page cap 10, repeat-token
 *    stop), with the generateContent filter applied per page.
 *  - M5: finishReason / promptFeedback are visible — a prompt-level
 *    block names the block instead of the bare "had no text" label, a
 *    SAFETY/RECITATION finish with no text is the empty-response error
 *    WITH the reason in its detail, and a MAX_TOKENS finish with
 *    partial text returns the text with the truncation exposed on the
 *    response's `finishReason` (the adapter-local extras surface; the
 *    shared CompletionResponse has no finish field, and the OpenAI
 *    adapter exposes its finish_reason only in empty-error detail).
 *  - M6: a stored `models/`-prefixed id is normalized at the URL build,
 *    so it completes against `/models/<id>:generateContent`, never a
 *    doubled prefix.
 *  - G3: Google's error envelope on the CHAT path carries its message
 *    verbatim on AiError.providerMessage.
 *
 * Hermetic throughout: a loopback fake speaking REAL Gemini wire
 * shapes (generateContent / streamGenerateContent SSE / ListModels),
 * following the loopback-double idiom of provider_error_words.test.ts.
 * No network, no real keys.
 */
import { describe, expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  GeminiAdapter,
  GeminiStreamAssembler,
  normalizeGeminiModelId,
  type GeminiCompletionResponse,
} from "../src/ai/gemini";
import { AiError, isEmptyResponseError } from "../src/ai/provider";
import type {
  CompletionRequest,
  StreamEvent,
  ToolSpec,
} from "../src/ai/provider";

// ------------------------------------------------------------- doubles ----

interface SeenRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
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
        pathname: url.pathname,
        query: url.searchParams,
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

function adapterFor(port: number): GeminiAdapter {
  return new GeminiAdapter({
    baseUrl: `http://127.0.0.1:${port}/v1beta`,
    apiKey: "gauntlet-key",
    allowLocalTargets: true,
  });
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    model: "gemini-2.5-flash",
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

function sse200(res: ServerResponse, events: readonly Record<string, unknown>[]): void {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  res.writeHead(200, { "content-type": "text/event-stream" }).end(body);
}

async function collectStream(
  adapter: GeminiAdapter,
  req: CompletionRequest,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of adapter.completeStream(req)) out.push(event);
  return out;
}

const GOLDEN_REPLY = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "Hello from Gemini" }] },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 16 },
  modelVersion: "gemini-2.5-flash",
};

// -------------------------------------------------------- golden complete ----

describe("Gemini gauntlet — golden complete", () => {
  test("text + usageMetadata parse; request body shape incl. maxOutputTokens from req.maxTokens", async () => {
    const f = await fake((_seen, res) => json200(res, GOLDEN_REPLY));
    try {
      const adapter = adapterFor(f.port);
      const res = (await adapter.complete(
        request({ maxTokens: 321 }),
      )) as GeminiCompletionResponse;

      expect(res.text).toBe("Hello from Gemini");
      expect(res.model).toBe("gemini-2.5-flash");
      expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
      expect(res.finishReason).toBe("STOP");
      expect(res.toolCalls).toBeUndefined();

      expect(f.seen).toHaveLength(1);
      const seen = f.seen[0]!;
      expect(seen.method).toBe("POST");
      expect(seen.pathname).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
      expect(seen.query.get("key")).toBe("gauntlet-key");
      const body = seen.json!;
      expect(body["contents"]).toEqual([
        { role: "user", parts: [{ text: "hi" }] },
      ]);
      const generation = body["generationConfig"] as Record<string, unknown>;
      expect(generation["maxOutputTokens"]).toBe(321);
    } finally {
      f.close();
    }
  });
});

// --------------------------------------------------------- golden stream ----

describe("Gemini gauntlet — golden stream", () => {
  test("SSE chunks assemble text + a functionCall tool call; finishReason STOP at end", async () => {
    const f = await fake((_seen, res) =>
      sse200(res, [
        {
          modelVersion: "gemini-2.5-flash",
          candidates: [{ content: { parts: [{ text: "Hel" }] } }],
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "lo " },
                  { functionCall: { name: "calculator", args: { a: 5 } } },
                ],
              },
            },
          ],
        },
        {
          candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 7 },
        },
      ]),
    );
    try {
      const adapter = adapterFor(f.port);
      const events = await collectStream(adapter, request());

      const deltas = events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta);
      expect(deltas).toEqual(["Hel", "lo "]);

      const end = events[events.length - 1]!;
      expect(end.type).toBe("end");
      if (end.type !== "end") throw new Error("expected end");
      expect(end.text).toBe("Hello ");
      expect(end.model).toBe("gemini-2.5-flash");
      expect(end.toolCalls).toEqual([
        { id: "call_0_calculator", name: "calculator", arguments: { a: 5 } },
      ]);
      expect(end.usage).toEqual({ inputTokens: 10, outputTokens: 7 });

      const seen = f.seen[0]!;
      expect(seen.pathname).toBe(
        "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      );
      expect(seen.query.get("alt")).toBe("sse");
    } finally {
      f.close();
    }
  });
});

// ----------------------------------------------------------------- tools ----

describe("Gemini gauntlet — tools", () => {
  const TOOLS: ToolSpec[] = [
    {
      name: "calculator",
      description: "Add numbers",
      parameters: {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
      },
    },
  ];

  test("functionDeclarations are emitted from tool specs; a functionCall response parses to toolCalls", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "calculator", args: { a: 5 } } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 },
      }),
    );
    try {
      const adapter = adapterFor(f.port);
      const res = await adapter.complete(request({ tools: TOOLS }));

      expect(res.text).toBe("");
      expect(res.toolCalls).toEqual([
        { id: "call_0_calculator", name: "calculator", arguments: { a: 5 } },
      ]);

      const body = f.seen[0]!.json!;
      const tools = body["tools"] as Array<Record<string, unknown>>;
      const decls = tools[0]!["functionDeclarations"] as Array<Record<string, unknown>>;
      expect(decls).toHaveLength(1);
      expect(decls[0]!["name"]).toBe("calculator");
      expect(decls[0]!["description"]).toBe("Add numbers");
      expect(decls[0]!["parameters"]).toEqual(TOOLS[0]!.parameters);
    } finally {
      f.close();
    }
  });
});

// ---------------------------------------------------------------- SAFETY ----

describe("Gemini gauntlet — SAFETY / finish reasons (M5)", () => {
  test("(i) promptFeedback block with no candidates: the error names the block, not the bare label", async () => {
    const f = await fake((_seen, res) =>
      json200(res, { promptFeedback: { blockReason: "SAFETY" } }),
    );
    try {
      const err = await errorOf(adapterFor(f.port).complete(request()));
      expect(err.kind).toBe("invalid_response");
      expect(err.message).toContain("SAFETY");
      expect(err.message).not.toBe("Service response had no text.");
      // The provider's own block words ride along too.
      expect(err.providerMessage).toContain("SAFETY");
      expect(isEmptyResponseError(err)).toBe(true);
    } finally {
      f.close();
    }
  });

  test("(i, streaming) a promptFeedback block over SSE also names the block", async () => {
    const f = await fake((_seen, res) =>
      sse200(res, [{ promptFeedback: { blockReason: "SAFETY" } }]),
    );
    try {
      const err = await errorOf(collectStream(adapterFor(f.port), request()));
      expect(err.message).toContain("SAFETY");
      expect(isEmptyResponseError(err)).toBe(true);
    } finally {
      f.close();
    }
  });

  test("(ii) candidate finishReason SAFETY with no text: empty-response error whose detail names SAFETY", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 0 },
      }),
    );
    try {
      const err = await errorOf(adapterFor(f.port).complete(request()));
      expect(isEmptyResponseError(err)).toBe(true);
      expect(err.message).toContain("finishReason=SAFETY");
    } finally {
      f.close();
    }
  });

  test("(ii) candidate finishReason RECITATION with no text names RECITATION too", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "RECITATION" }],
      }),
    );
    try {
      const err = await errorOf(adapterFor(f.port).complete(request()));
      expect(isEmptyResponseError(err)).toBe(true);
      expect(err.message).toContain("finishReason=RECITATION");
    } finally {
      f.close();
    }
  });

  test("MAX_TOKENS finish with partial text returns the text AND exposes the truncation", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        candidates: [
          {
            content: { parts: [{ text: "partial answer that was cut" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 300 },
      }),
    );
    try {
      const res = (await adapterFor(f.port).complete(
        request({ maxTokens: 300 }),
      )) as GeminiCompletionResponse;
      expect(res.text).toBe("partial answer that was cut");
      // Truncation exposure: the wire finish reason on the response —
      // "MAX_TOKENS" here means the text above is NOT the whole answer.
      expect(res.finishReason).toBe("MAX_TOKENS");
    } finally {
      f.close();
    }
  });

  test("MAX_TOKENS over the stream assembler: partial text ends, finishReason getter names the truncation", () => {
    const a = new GeminiStreamAssembler("gemini-2.5-flash");
    a.push({
      candidates: [
        { content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" },
      ],
    });
    const end = a.finish();
    if (end.type !== "end") throw new Error("expected end");
    expect(end.text).toBe("partial");
    expect(a.finishReason).toBe("MAX_TOKENS");
  });
});

// ------------------------------------------------------- error envelope ----

describe("Gemini gauntlet — Google error envelope on the chat path (G3)", () => {
  test("403 {error:{code,message,status}} → providerMessage carries Google's message verbatim", async () => {
    const GOOGLE_MESSAGE = "API key not valid. Please pass a valid API key.";
    const f = await fake((_seen, res) =>
      res
        .writeHead(403, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            error: { code: 403, message: GOOGLE_MESSAGE, status: "PERMISSION_DENIED" },
          }),
        ),
    );
    try {
      const err = await errorOf(adapterFor(f.port).complete(request()));
      expect(err.kind).toBe("auth");
      expect(err.status).toBe(403);
      expect(err.providerMessage).toBe(GOOGLE_MESSAGE);
    } finally {
      f.close();
    }
  });
});

// ------------------------------------------------------------- discovery ----

describe("Gemini gauntlet — discovery pagination (M2)", () => {
  const chatModel = (id: string, displayName: string) => ({
    name: `models/${id}`,
    displayName,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  });

  test("page 1's nextPageToken is followed; models from BOTH pages return, junk filtered on both", async () => {
    const f = await fake((seen, res) => {
      if (seen.query.get("pageToken") === "page-2-token") {
        json200(res, {
          models: [
            {
              name: "models/imagen-4.0-generate-001",
              displayName: "Imagen 4",
              supportedGenerationMethods: ["predict"],
            },
            chatModel("gemini-2.5-pro", "Gemini 2.5 Pro"),
          ],
        });
        return;
      }
      json200(res, {
        models: [
          { name: "models/aqa", displayName: "AQA", supportedGenerationMethods: [] },
          chatModel("gemini-2.5-flash", "Gemini 2.5 Flash"),
          {
            name: "models/embedding-001",
            displayName: "Embedding 001",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
        nextPageToken: "page-2-token",
      });
    });
    try {
      const adapter = adapterFor(f.port);
      const models = await adapter.listModels({
        target: { baseUrl: `http://127.0.0.1:${f.port}/v1beta`, apiKey: "gauntlet-key" },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(models.map((m) => m.id)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
      // Exactly two pages were fetched, the second with the token.
      expect(f.seen).toHaveLength(2);
      expect(f.seen[0]!.pathname).toBe("/v1beta/models");
      expect(f.seen[0]!.query.get("pageToken")).toBeNull();
      expect(f.seen[1]!.query.get("pageToken")).toBe("page-2-token");
    } finally {
      f.close();
    }
  });

  test("a repeating nextPageToken does not spin: discovery stops instead of re-fetching forever", async () => {
    const f = await fake((_seen, res) =>
      json200(res, {
        models: [chatModel("gemini-2.5-flash", "Gemini 2.5 Flash")],
        nextPageToken: "loop-token",
      }),
    );
    try {
      const adapter = adapterFor(f.port);
      const models = await adapter.listModels({
        target: { baseUrl: `http://127.0.0.1:${f.port}/v1beta`, apiKey: "gauntlet-key" },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(models.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);
      // Page 1 (fresh token) + page 2 (same token again → stop).
      expect(f.seen).toHaveLength(2);
    } finally {
      f.close();
    }
  });

  test("an endless stream of fresh tokens is stopped by the 10-page cap", async () => {
    const f = await fake((seen, res) => {
      const n = seen.query.get("pageToken") === null ? 0 : Number(seen.query.get("pageToken"));
      json200(res, {
        models: [chatModel(`gemini-page-${n}`, `Page ${n}`)],
        nextPageToken: String(n + 1),
      });
    });
    try {
      const adapter = adapterFor(f.port);
      const models = await adapter.listModels({
        target: { baseUrl: `http://127.0.0.1:${f.port}/v1beta`, apiKey: "gauntlet-key" },
        timeoutMs: 2000,
        signal: new AbortController().signal,
      });
      expect(f.seen).toHaveLength(10);
      expect(models).toHaveLength(10);
    } finally {
      f.close();
    }
  });
});

// ------------------------------------------------------ models/ prefix (M6) ----

describe("Gemini gauntlet — models/ prefix normalization (M6)", () => {
  test("normalizeGeminiModelId strips exactly one leading models/", () => {
    expect(normalizeGeminiModelId("models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(normalizeGeminiModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(normalizeGeminiModelId("models/models/x")).toBe("models/x");
  });

  test("a stored models/-prefixed id completes against the correct URL path (no doubled prefix)", async () => {
    const f = await fake((_seen, res) => json200(res, GOLDEN_REPLY));
    try {
      const adapter = adapterFor(f.port);
      const res = await adapter.complete(
        request({ model: "models/gemini-2.5-flash" }),
      );
      expect(res.text).toBe("Hello from Gemini");
      expect(res.model).toBe("gemini-2.5-flash");
      expect(f.seen).toHaveLength(1);
      expect(f.seen[0]!.pathname).toBe(
        "/v1beta/models/gemini-2.5-flash:generateContent",
      );
      expect(f.seen[0]!.pathname).not.toContain("models%2F");
      expect(f.seen[0]!.pathname).not.toContain("models/models");
    } finally {
      f.close();
    }
  });

  test("a stored models/-prefixed id streams against the correct URL path too", async () => {
    const f = await fake((_seen, res) =>
      sse200(res, [
        { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
      ]),
    );
    try {
      const adapter = adapterFor(f.port);
      const events = await collectStream(
        adapter,
        request({ model: "models/gemini-2.5-flash" }),
      );
      const end = events[events.length - 1]!;
      if (end.type !== "end") throw new Error("expected end");
      expect(end.text).toBe("ok");
      expect(end.model).toBe("gemini-2.5-flash");
      expect(f.seen[0]!.pathname).toBe(
        "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      );
    } finally {
      f.close();
    }
  });
});
