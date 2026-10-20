/**
 * OpenAI-compatible discovery filter (audit H5).
 *
 * The OpenAI-shaped `/models` listing mixes chat models with embedding /
 * whisper / tts / image / moderation / rerank ids. listModels used to
 * return every id verbatim, so a bulk import could land auto-select or a
 * repaired default on a non-chat id and every chat turn would 400 — the
 * Gemini `aqa` failure mode, still open on this wire. The adapter now
 * filters at the seam (filterChatModels / isLikelyChatModelId), the same
 * place the Gemini adapter filters on supportedGenerationMethods, so
 * nine_router (which rides this adapter) inherits it too.
 *
 * The rule is liberal: only well-known non-chat families are excluded,
 * matched case-insensitively on whole id segments; unknown ids pass.
 * If filtering would empty a non-empty list, the raw list is returned —
 * a weird endpoint beats an empty discovery.
 *
 * Hermetic: predicate/filter unit tests plus a loopback double for the
 * listModels wire, mirroring tests/gemini_discovery_filter.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  OpenAICompatibleAdapter,
  filterChatModels,
  isLikelyChatModelId,
} from "../src/ai/openai_compatible";
import type { RemoteModel } from "../src/ai/adapter";

// ------------------------------------------------------------ predicate ----

describe("isLikelyChatModelId excludes known non-chat families", () => {
  const excluded: readonly string[] = [
    // embedding
    "text-embedding-3-small",
    "text-embedding-ada-002",
    "embed-english-v3.0",
    // whisper / transcription
    "whisper-1",
    "whisper-large-v3",
    "distil-whisper-large-v3-en",
    "gpt-4o-transcribe",
    // tts / speech
    "tts-1",
    "tts-1-hd",
    "playai-tts",
    "gpt-4o-mini-tts",
    "speech-2.0",
    // image
    "dall-e-3",
    "dall-e-2",
    "gpt-image-1",
    // moderation
    "omni-moderation-latest",
    "text-moderation-stable",
    // rerank
    "rerank-english-v3.0",
    "jina-reranker-v2-base-multilingual",
    // legacy base models (no chat/completions shape on this adapter)
    "babbage-002",
    "davinci-002",
    // realtime-audio pair
    "acme/realtime-audio-1",
  ];

  for (const id of excluded) {
    test(`excludes ${id}`, () => {
      expect(isLikelyChatModelId(id)).toBe(false);
    });
  }

  test("matching is case-insensitive", () => {
    expect(isLikelyChatModelId("Text-Embedding-3-Small")).toBe(false);
    expect(isLikelyChatModelId("WHISPER-1")).toBe(false);
    expect(isLikelyChatModelId("DALL-E-3")).toBe(false);
  });

  test("vendor-prefixed ids are judged on their segments", () => {
    expect(isLikelyChatModelId("openai/text-embedding-3-small")).toBe(false);
    expect(isLikelyChatModelId("openai/whisper-1")).toBe(false);
    expect(isLikelyChatModelId("cohere/rerank-v3.5")).toBe(false);
  });
});

describe("isLikelyChatModelId keeps chat and unknown ids", () => {
  const kept: readonly string[] = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "o3-mini",
    "claude-sonnet-4.5",
    "llama-3.3-70b-versatile",
    "deepseek-chat",
    "deepseek-reasoner",
    "qwen3-max",
    "mistral-large-latest",
    // Vision models ARE chat models — "vision" must never exclude.
    "llama-3.2-11b-vision-instruct",
    "gpt-4o-vision-preview",
    // Bare "audio" / "realtime" alone are chat-capable (audio-preview
    // serves chat/completions); only the realtime+audio pair is out.
    "gpt-4o-audio-preview",
    "gpt-4o-realtime-preview",
    // Unknown ids pass: absence of a known family is not incapability.
    "acme/unknown-model-9000",
    "some-local-finetune-v2",
    // Image generation, but no "image" segment and no listed family —
    // the liberal rule keeps it rather than inventing broad patterns.
    "flux-1.1-pro",
  ];

  for (const id of kept) {
    test(`keeps ${id}`, () => {
      expect(isLikelyChatModelId(id)).toBe(true);
    });
  }

  test("vendor-prefixed chat ids are kept", () => {
    expect(isLikelyChatModelId("openai/gpt-4o")).toBe(true);
    expect(isLikelyChatModelId("meta-llama/llama-3.3-70b-instruct")).toBe(true);
  });

  test("family substrings inside a segment do not match", () => {
    // "embed" glued inside one segment is not the embedding family.
    expect(isLikelyChatModelId("embeddingsfree-chat-v1")).toBe(true);
    expect(isLikelyChatModelId("chatts-9000")).toBe(true);
  });
});

// --------------------------------------------------------------- filter ----

describe("filterChatModels", () => {
  const models = (ids: readonly string[]): RemoteModel[] =>
    ids.map((id) => ({ id }));

  test("drops non-chat ids and preserves order", () => {
    const out = filterChatModels(
      models([
        "text-embedding-3-small",
        "gpt-4o",
        "whisper-1",
        "llama-3.3-70b-versatile",
        "dall-e-3",
        "deepseek-chat",
      ]),
    );
    expect(out.map((m) => m.id)).toEqual([
      "gpt-4o",
      "llama-3.3-70b-versatile",
      "deepseek-chat",
    ]);
  });

  test("all-junk fallback returns the raw list rather than empty", () => {
    const raw = models(["text-embedding-3-small", "whisper-1", "tts-1"]);
    expect(filterChatModels(raw).map((m) => m.id)).toEqual([
      "text-embedding-3-small",
      "whisper-1",
      "tts-1",
    ]);
  });

  test("empty input stays empty", () => {
    expect(filterChatModels([])).toEqual([]);
  });
});

// ----------------------------------------------------------- listModels ----

interface Double {
  port: number;
  close: () => void;
}

async function double(payload: unknown): Promise<Double> {
  const server: Server = createServer((_req, res: ServerResponse) =>
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(payload)),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, close: () => server.close() };
}

async function listFrom(payload: unknown): Promise<string[]> {
  const d = await double(payload);
  try {
    const baseUrl = `http://127.0.0.1:${d.port}/v1`;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: "k",
      allowLocalTargets: true,
    });
    const models = await adapter.listModels({
      target: { baseUrl, apiKey: "k" },
      timeoutMs: 2000,
      signal: new AbortController().signal,
    });
    return models.map((m) => m.id);
  } finally {
    d.close();
  }
}

describe("OpenAI-compatible listModels applies the non-chat filter", () => {
  test("junk families in an OpenAI-shaped listing are not imported", async () => {
    const ids = await listFrom({
      object: "list",
      data: [
        { id: "gpt-4o" },
        { id: "text-embedding-3-small" },
        { id: "whisper-1" },
        { id: "tts-1" },
        { id: "dall-e-3" },
        { id: "omni-moderation-latest" },
        { id: "gpt-4o-mini" },
        { id: "babbage-002" },
      ],
    });
    expect(ids).toEqual(["gpt-4o", "gpt-4o-mini"]);
    // The default pick (first discovered) is a chat model.
    expect(ids[0]).toBe("gpt-4o");
  });

  test("an all-junk listing still discovers the raw ids", async () => {
    const ids = await listFrom({
      object: "list",
      data: [{ id: "text-embedding-3-small" }, { id: "whisper-1" }],
    });
    expect(ids).toEqual(["text-embedding-3-small", "whisper-1"]);
  });
});
