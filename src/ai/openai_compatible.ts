/**
 * OpenAI-compatible adapter — POST {baseUrl}/chat/completions.
 *
 * Wire format: request {model, messages[{role, content}], temperature?,
 * max_tokens?}; response choices[0].message.content.
 *
 * Mapping to the engine's error categories is deliberate, because the panel
 * turns those categories into a short Persian message:
 *   401/403  → auth        429 → quota        5xx → network
 *   408/timeout → timeout   other/abort → respective category
 *
 * A provider's raw response body is never returned to the caller: it can
 * echo the request. Only the status mapper's sanitized extraction of the
 * provider's own error words may ride the error (AiError.providerMessage).
 */
import { AiError, base64Bytes, MAX_ATTACHMENT_BYTES, emptyResponseError } from "./provider";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ContentPart,
  StreamEvent,
  TokenUsage,
  ToolCall,
} from "./provider";
import {
  type AIProviderAdapter,
  type AdapterSettings,
  type EmbedRequest,
  type EmbedResponse,
  type ListModelsRequest,
  type RemoteModel,
} from "./adapter";
import type { AdapterTarget } from "./adapter";
import { resolveTarget, type ResolvedTarget } from "./dns_guard";
import { statusToAiError } from "./http_status";
import { pinnedFetch, pinnedStream } from "./pinned_transport";
import { dataUrl, partDropNote, selectParts, textWithPartNotes } from "./parts";
import type { SendablePart } from "./parts";
import { resolveReasoningEffort, reasoningParamsFor } from "./reasoning";

export interface OpenAITarget extends AdapterTarget {
  /** Owner-tunable settings. Only known keys are honored. */
  settings?: AdapterSettings;
  /** Allow loopback/private hosts for a self-hosted local deployment. */
  allowLocalTargets?: boolean;
}

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  /** Equals the adapter type; the engine reads this for its fake check. */
  readonly name = "openai_compatible";
  readonly type = "openai_compatible" as const;
  readonly capabilities = {
    listModels: true,
    // Phase 4: POST {baseUrl}/embeddings, the standard OpenAI wire shape.
    embeddings: true,
    // Streaming: POST {baseUrl}/chat/completions with stream:true (SSE).
    streaming: true,
    notes: "POST {baseUrl}/chat/completions, GET {baseUrl}/models and POST {baseUrl}/embeddings",
  };
  readonly label = "Custom / OpenAI-compatible";

  private readonly target: OpenAITarget;

  constructor(target: OpenAITarget) {
    this.target = target;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // Lexical policy + DNS resolution + address approval, per request.
    const target = await resolveTarget(this.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });

    const body = buildRequestBody(this.target, req);
    const res = await fetchJson(target, {
      path: "/chat/completions",
      method: "POST",
      headers: headers(this.target.apiKey),
      secret: this.target.apiKey,
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });

    return parseResponse(res, req.model);
  }

  /**
   * Stream a completion as Server-Sent Events.
   *
   * Wire: the same body as complete() plus `stream: true`, and
   * `stream_options: { include_usage: true }` so token counts arrive in a
   * final usage chunk. The transport is the same pinned, SSRF-guarded one —
   * only the body reading changes (chunks as they arrive instead of one
   * buffered read).
   *
   * Yields `text` for every content delta, `usage` when the service reports
   * it, and exactly one terminal `end`. Tool-call deltas (fragmented across
   * chunks, keyed by index) are accumulated and delivered once, on `end`.
   *
   * Throws only AiError. A non-2xx status is mapped exactly like complete();
   * a malformed event is invalid_response, matching the non-streaming parse.
   */
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> {
    // Same policy as complete(): lexical policy + DNS resolution + address
    // approval, per request. Streaming changes nothing about WHERE the
    // socket may go.
    const target = await resolveTarget(this.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });

    const body = {
      ...buildRequestBody(this.target, req),
      stream: true,
      // Ask for the usage chunk: without it a streamed reply reports no
      // token counts and usage accounting goes blind.
      stream_options: { include_usage: true },
    };

    const stream = await pinnedStream({
      url: `${target.baseUrl}/chat/completions`,
      method: "POST",
      headers: { ...headers(this.target.apiKey), accept: "text/event-stream" },
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      addresses: target.addresses,
      allowLocalTargets: target.allowLocalTargets,
    });

    // The status is known before any chunk is read: map it exactly like the
    // non-streaming path, then close the stream we will not consume.
    if (stream.status >= 300 && stream.status < 400) {
      await stream.chunks.return(undefined);
      throw new AiError("invalid_response", "The service redirected to another address.");
    }
    if (stream.status < 200 || stream.status >= 300) {
      // An error status still carries the provider's own explanation in
      // its body: read a bounded slice before closing, so the mapped
      // error can quote it like the non-streaming path does.
      const errorBody = await readStreamErrorBody(stream.chunks);
      await stream.chunks.return(undefined);
      throw statusToError(stream.status, stream.headers, {
        body: errorBody,
        secret: this.target.apiKey,
      });
    }

    const parser = new SseParser();
    const toolDeltas = new Map<number, { id: string; name: string; args: string }>();
    let text = "";
    let usage: TokenUsage | undefined;
    let hadReasoning = false;
    let lastFinishReason: string | undefined;

    // One event → zero or more stream events. A nested generator (not a
    // closure returning values) so `text`/`usage` stay single-sourced.
    function* handleEvent(event: Record<string, unknown>): Generator<StreamEvent, void, undefined> {
      const delta = choiceDelta(event);

      const content = delta !== undefined ? delta["content"] : undefined;
      if (typeof content === "string" && content.length > 0) {
        text += content;
        yield { type: "text", delta: content };
      }

      // Reasoning-only streams are still empty answers (the chain-of-thought
      // is never surfaced); the flag only feeds the failure's detail line.
      const reasoning = delta !== undefined ? delta["reasoning_content"] : undefined;
      if (typeof reasoning === "string" && reasoning.length > 0) hadReasoning = true;

      const finish = choiceFinishReason(event);
      if (finish !== undefined) lastFinishReason = finish;

      const calls = delta !== undefined ? delta["tool_calls"] : undefined;
      if (Array.isArray(calls)) accumulateToolCallDeltas(toolDeltas, calls);

      const parsed = parseStreamUsage(event["usage"]);
      if (parsed !== undefined) {
        usage = parsed;
        yield { type: "usage", usage: parsed };
      }
    }

    try {
      for await (const chunk of stream.chunks) {
        for (const event of parser.push(chunk.toString("utf8"))) {
          yield* handleEvent(event);
        }
      }
      // A stream that ends without a trailing blank line still has its final
      // event processed rather than dropped.
      for (const event of parser.flush()) {
        yield* handleEvent(event);
      }
    } finally {
      // Idempotent: closes the socket if the consumer broke out early, and
      // is a no-op once the stream already ended.
      await stream.chunks.return(undefined);
    }

    const finalToolCalls = buildStreamedToolCalls(toolDeltas);
    if (text.trim().length === 0 && finalToolCalls.length === 0) {
      // A stream that ends without a single token is the same candidate
      // failure as an empty buffered payload (see parseResponse): raise it
      // instead of emitting an empty `end`, so the gateway fails over and
      // the loop's non-streaming fallback engages.
      const parts: string[] = ["stream"];
      if (lastFinishReason !== undefined) parts.push(`finish_reason=${lastFinishReason}`);
      if (hadReasoning) parts.push("the response carried reasoning only");
      throw emptyResponseError(parts.join(", "));
    }

    yield {
      type: "end",
      text,
      model: req.model,
      toolCalls: finalToolCalls,
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  async listModels(req: ListModelsRequest): Promise<readonly RemoteModel[]> {
    // Same policy as complete(): the local exception, if the owner set it,
    // applies to discovery too rather than being silently dropped.
    const target = await resolveTarget(req.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });
    const res = await fetchJson(target, {
      path: "/models",
      method: "GET",
      headers: headers(req.target.apiKey),
      secret: req.target.apiKey,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });

    const data = res["data"];
    if (!Array.isArray(data)) {
      throw new AiError("invalid_response", "Service response was unreadable.");
    }
    const out: RemoteModel[] = [];
    for (const entry of data) {
      if (isRecord(entry) && typeof entry["id"] === "string") {
        out.push({ id: entry["id"] });
      }
    }
    return filterChatModels(out);
  }

  /**
   * Embed texts via POST {baseUrl}/embeddings (Phase 4, semantic memory).
   *
   * Wire format: request {model, input: string[]}; response
   * {data: [{embedding: number[], index: number}], model?}. Entries are
   * re-ordered by `index` when the service provides it, so a service that
   * answers out of order still lines up with the input texts.
   *
   * Same transport policy as complete(): DNS-pinned, no redirects, and the
   * response body never escapes into an error. A malformed embedding entry
   * fails the whole call rather than silently misaligning vectors with texts.
   */
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (req.texts.length === 0) {
      return { embeddings: [], model: req.model };
    }
    const target = await resolveTarget(this.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });
    const res = await fetchJson(target, {
      path: "/embeddings",
      method: "POST",
      headers: headers(this.target.apiKey),
      secret: this.target.apiKey,
      body: JSON.stringify({ model: req.model, input: req.texts }),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });

    const parsed = parseEmbedResponse(res, req.texts.length);
    return {
      embeddings: parsed.embeddings,
      model: parsed.model ?? req.model,
    };
  }
}

/**
 * Discovery filter: keep only ids that can plausibly serve chat/completions.
 *
 * OpenAI-shaped `/models` listings mix chat models with embeddings,
 * transcription, TTS, image, moderation and rerank ids. Importing them all
 * verbatim lets auto-select / default-repair land the active model on a
 * non-chat id, after which every chat turn 400s — the exact failure the
 * Gemini `aqa` incident produced on the native wire. This is the sibling
 * of that fix (see the Gemini adapter's listModels, which keeps only
 * models whose supportedGenerationMethods include generateContent):
 * filter at the adapter seam so every discovery surface inherits it.
 * nine_router rides this adapter, so it inherits the filter too.
 *
 * LIBERALITY RULE: OpenAI-shaped listings carry no capability metadata,
 * so this can only pattern-match the id. Exclude ONLY the well-known
 * non-chat families below; an unknown id always passes. A false keep
 * costs one failed chat the owner can see and fix; a false drop hides a
 * model the owner can never select. Matching is case-insensitive and
 * token-based: the id is split on [-_/.:] so a family marker must be a
 * whole segment (or the "realtime"+"audio" segment pair) — substrings
 * inside a segment never match, so e.g. "gpt-4o" (no family token) and
 * vision models (vision ids ARE chat models) are kept.
 *
 * Non-chat families excluded:
 *   embedding    text-embedding-3-small, embed-english-v3.0, …
 *   whisper      whisper-1, whisper-large-v3, distil-whisper-…
 *   tts / speech tts-1, playai-tts, speech-2.0, gpt-4o-mini-tts
 *   transcribe   gpt-4o-transcribe (audio-transcription endpoint only)
 *   image        gpt-image-1, dall-e-2/3 (matched on the glued "dall-e")
 *   moderation   omni-moderation-latest, text-moderation-*
 *   rerank       rerank-*, *-rerank, jina-reranker-*
 *   legacy base  babbage-*, davinci-* (completions-only base models;
 *                they do not serve this adapter's chat/completions shape)
 *   realtime-audio  ids carrying the realtime+audio segment pair
 *                (bare "audio" is kept: gpt-4o-audio-preview is a chat model)
 */
const NON_CHAT_ID_TOKENS: ReadonlySet<string> = new Set([
  "embedding",
  "embeddings",
  "embed",
  "whisper",
  "tts",
  "speech",
  "transcribe",
  "transcription",
  "image",
  "images",
  "moderation",
  "rerank",
  "reranker",
  "babbage",
  "davinci",
]);

/** True when `id` is not a known non-chat family member (see above). */
export function isLikelyChatModelId(id: string): boolean {
  const lower = id.trim().toLowerCase();
  if (lower.length === 0) return false;
  // "dall-e" tokenizes to [dall, e, …], so match the glued form directly.
  if (lower.includes("dall-e")) return false;
  const tokens = lower.split(/[-_/.:]+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    if (NON_CHAT_ID_TOKENS.has(token)) return false;
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (
      (a === "realtime" && b === "audio") ||
      (a === "audio" && b === "realtime")
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Apply {@link isLikelyChatModelId} to a discovered list, order unchanged.
 *
 * Fallback: if filtering would empty a non-empty list, return the raw
 * list instead. A weird endpoint whose ids all look non-chat (or whose
 * naming this filter misjudges wholesale) still beats an empty discovery
 * — discovery failing entirely is the worse outcome, and the owner can
 * pick from the raw list manually.
 */
export function filterChatModels(
  models: readonly RemoteModel[],
): readonly RemoteModel[] {
  const chat = models.filter((m) => isLikelyChatModelId(m.id));
  return chat.length > 0 ? chat : models;
}

/**
 * Parse an /embeddings response body.
 *
 * Exported so the wire format can be asserted without a network (same
 * rationale as buildRequestBody). Entries are re-ordered by `index` when the
 * service provides it, so a service that answers out of order still lines up
 * with the input texts. A malformed entry or a count mismatch throws AiError
 * rather than silently misaligning vectors with texts — a shifted vector
 * would poison the memory index with the wrong meaning.
 */
export function parseEmbedResponse(
  res: Record<string, unknown>,
  expectedCount: number,
): { embeddings: number[][]; model?: string } {
  const data = res["data"];
  if (!Array.isArray(data) || data.length === 0) {
    throw new AiError("invalid_response", "Service response was unreadable.");
  }
  const vectors: Array<{ index: number; embedding: number[] }> = [];
  for (const entry of data) {
    if (!isRecord(entry)) {
      throw new AiError("invalid_response", "Service response was unreadable.");
    }
    const embedding = entry["embedding"];
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      !embedding.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      throw new AiError("invalid_response", "Service response was unreadable.");
    }
    const index = entry["index"];
    vectors.push({
      index: typeof index === "number" && Number.isInteger(index) ? index : vectors.length,
      embedding: embedding as number[],
    });
  }
  vectors.sort((a, b) => a.index - b.index);
  const embeddings = vectors.map((v) => v.embedding);
  if (embeddings.length !== expectedCount) {
    throw new AiError("invalid_response", "Service response was unreadable.");
  }
  const model = res["model"];
  return {
    embeddings,
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
  };
}

/**
 * Request body, restricted to the knobs this adapter is allowed to set.
 * Exported so the wire format can be asserted without a network.
 */
export function buildRequestBody(
  target: OpenAITarget,
  req: CompletionRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toWireMessages(req.messages),
  };

  // Declared tools go in the request's `tools` array. Absent means the model
  // must answer from what it already has, which is how the loop forces a final
  // answer when a budget runs out.
  if (req.tools !== undefined && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  // Output-token cap: a per-request cap (e.g. the health probe's tiny one)
  // wins over the provider-level default in settings.
  const settings = target.settings;
  const maxTokens =
    typeof req.maxTokens === "number" && Number.isFinite(req.maxTokens) && req.maxTokens > 0
      ? Math.min(Math.trunc(req.maxTokens), 100_000)
      : typeof settings?.maxTokens === "number" &&
          Number.isFinite(settings.maxTokens) &&
          settings.maxTokens > 0
        ? Math.min(Math.trunc(settings.maxTokens), 100_000)
        : undefined;
  if (maxTokens !== undefined) body["max_tokens"] = maxTokens;

  if (settings) {
    if (typeof settings.temperature === "number" && Number.isFinite(settings.temperature)) {
      body["temperature"] = clamp(settings.temperature, 0, 2);
    }
  }

  // No explicit cache breakpoint exists on the chat-completions wire: prompt
  // caching there is automatic and server-side. A `prompt_cache_key` field
  // exists on some endpoints but it changes routing semantics (it names the
  // cache bucket rather than marking a breakpoint), so it is deliberately not
  // set. Documented, not changed.

  // Opt-in reasoning: off unless the owner set BOBI_REASONING_EFFORT.
  const reasoning = reasoningParamsFor("openai_compatible", resolveReasoningEffort());
  if (reasoning.enabled && reasoning.levelName !== undefined) {
    body["reasoning_effort"] = reasoning.levelName;
  }

  const system = settings?.systemPrompt;
  if (typeof system === "string" && system.length > 0) {
    // Prepend as a system turn; the service decides how to treat it.
    const existing = body["messages"] as Array<Record<string, unknown>>;
    body["messages"] = [{ role: "system", content: system }, ...existing];
  }

  return body;
}

/** Map a whole conversation onto the wire shape. Exported for tests. */
export function toWireMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map(toWireMessage);
}

/**
 * One neutral message → the OpenAI chat shape.
 *
 * The two tool roles are not plain text turns: an assistant turn that requested
 * tools must carry `tool_calls`, and a tool result must carry the
 * `tool_call_id` it answers. Sending either as ordinary content is rejected by
 * a strict endpoint, so the mapping is explicit rather than uniform.
 */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId ?? "",
      content: m.content,
    };
  }

  if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      // Some services reject an assistant turn whose content is absent, so an
      // empty string is sent rather than omitting the key.
      content: m.content.length > 0 ? m.content : null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: stringifyArguments(c.arguments) },
      })),
    };
  }

  // A message with attachments becomes a content ARRAY. This service requires
  // that form for images, and an unsupported attachment is described in the text
  // so the model at least learns it was sent.
  //
  // A text/* document is plain UTF-8 under the base64, and this wire format
  // carries text natively — so it is decoded and inlined as a labeled text
  // block instead of being reported as unsent. Binary documents keep the
  // existing named-note fallback; they never pass through here.
  const split = splitInlineTextDocuments(m);
  const { sendable, dropped } = selectParts(split.message);
  const text = [textWithPartNotes(split.message), ...split.droppedNotes]
    .filter((s) => s.length > 0)
    .join("\n");
  if (sendable.length > 0 || split.inlineDocs.length > 0) {
    return { role: m.role, content: contentArray(text, sendable, split.inlineDocs) };
  }
  if (dropped.length > 0 || split.droppedNotes.length > 0) {
    return { role: m.role, content: text };
  }

  return { role: m.role, content: m.content };
}

/**
 * Ceiling on the decoded text inlined from one text/* document, in bytes.
 *
 * The document rides as ordinary text in the request body, so it still costs
 * context; the cap keeps one pasted file from crowding the rest of the turn
 * out. Anything longer is cut at a character boundary and the cut is named.
 */
const MAX_INLINE_TEXT_DOC_BYTES = 50 * 1024;

/** A text/* document decoded for inlining as one labeled text block. */
interface InlineTextDoc {
  /** The label, e.g. "[Text document notes.txt]: ". */
  label: string;
  /** The decoded text, possibly truncated (the truncation is named). */
  text: string;
}

type TextDocumentPart = Extract<ContentPart, { type: "document" }>;

/**
 * Split text/* documents out of a message.
 *
 * Unlike binary attachments they have a safe wire form here — plain UTF-8 —
 * so they are decoded and inlined as labeled text blocks rather than being
 * reported as unsent. Binary documents stay in `message` and keep the existing
 * named-note fallback; they never pass through here.
 *
 * A text document past the attachment ceiling is not decoded at all: it gets
 * the same named "too large" note every other dropped attachment gets, through
 * the shared partDropNote wording.
 */
function splitInlineTextDocuments(message: ChatMessage): {
  inlineDocs: InlineTextDoc[];
  message: ChatMessage;
  droppedNotes: string[];
} {
  if (message.parts === undefined) return { inlineDocs: [], message, droppedNotes: [] };

  const inlineDocs: InlineTextDoc[] = [];
  const rest: ContentPart[] = [];
  const droppedNotes: string[] = [];

  for (const part of message.parts) {
    if (part.type !== "document") {
      rest.push(part);
      continue;
    }
    const mediaType = part.mediaType.split(";")[0]!.trim().toLowerCase();
    if (!mediaType.startsWith("text/")) {
      rest.push(part);
      continue;
    }
    if (base64Bytes(part.base64) > MAX_ATTACHMENT_BYTES) {
      droppedNotes.push(partDropNote(mediaType, "too_large"));
      continue;
    }
    inlineDocs.push(decodeTextDocument(part, mediaType));
  }

  return { inlineDocs, message: { ...message, parts: rest }, droppedNotes };
}

/**
 * Decode one text/* document into a labeled text block.
 *
 * The byte cap is applied to the DECODED text: anything longer is cut at a
 * character boundary and the cut is named, so the model knows it did not see
 * the whole file.
 */
function decodeTextDocument(part: TextDocumentPart, mediaType: string): InlineTextDoc {
  const label = `[Text document ${part.name ?? mediaType}]: `;
  const decoded = Buffer.from(part.base64, "base64").toString("utf8");
  if (Buffer.byteLength(decoded, "utf8") <= MAX_INLINE_TEXT_DOC_BYTES) {
    return { label, text: decoded };
  }

  // Shrink by characters; removing characters only ever shrinks the byte
  // length, so this converges.
  let end = Math.max(
    1,
    Math.floor((MAX_INLINE_TEXT_DOC_BYTES / Buffer.byteLength(decoded, "utf8")) * decoded.length),
  );
  while (end > 0 && Buffer.byteLength(decoded.slice(0, end), "utf8") > MAX_INLINE_TEXT_DOC_BYTES) {
    end = Math.floor(end / 2);
  }
  return {
    label,
    text: `${decoded.slice(0, end)}... [rest of text omitted due to size]`,
  };
}

/**
 * Build the multimodal content array.
 *
 * Images use the `image_url` form with an inline data URL, which is the shape
 * this family of services accepts without a separate upload step. Audio has no
 * portable representation here, so it is named in the text instead of being sent
 * as a part the endpoint would reject.
 *
 * SECURITY: a data URL carries the raw attachment bytes. It is built here only
 * to be placed in the request body sent to the configured provider through the
 * pinned, SSRF-guarded transport (see pinned_transport.ts and dns_guard.ts);
 * it is never logged and never persisted — the engine commits text-only turns
 * to history, so the bytes live only for the duration of this request.
 */
function contentArray(
  text: string,
  sendable: readonly SendablePart[],
  inlineDocs: readonly InlineTextDoc[],
): unknown[] {
  const out: unknown[] = [];
  if (text.length > 0) out.push({ type: "text", text });

  // Decoded text documents ride as labeled plain-text blocks.
  for (const doc of inlineDocs) {
    out.push({ type: "text", text: `${doc.label}${doc.text}` });
  }

  for (const part of sendable) {
    if (part.type === "image") {
      out.push({ type: "image_url", image_url: { url: dataUrl(part) } });
    } else {
      // Named rather than sent: this adapter has no wire form for audio or a
      // (binary) document, and a fabricated one would be rejected by the endpoint.
      out.push({ type: "text", text: `[${part.type} attachment: ${part.mediaType} not sent]` });
    }
  }
  return out;
}

/** This service expects `arguments` as a JSON *string*, not an object. */
function stringifyArguments(args: unknown): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Parse a response payload into the neutral shape. Exported for tests, which
 * assert the wire format without a network round trip.
 */
export function parseResponse(res: unknown, requestedModel: string): CompletionResponse {
  const text = extractContent(res);
  const extras = responseExtras(res);
  if (text.trim().length === 0 && (extras.toolCalls ?? []).length === 0) {
    // A structurally valid payload with no answer in it is a candidate
    // failure, not a silent success: free gateways answer HTTP 200 with an
    // empty content field (quota quietly exhausted, model warming up), and
    // an empty string used to sail through as a reply and dead-end the
    // chat turn. Tool-requesting turns (toolCalls present) stay legal.
    throw emptyResponseError(emptyPayloadDetail(res));
  }
  return {
    text,
    model: extractModel(res, requestedModel),
    ...extras,
  };
}

/**
 * Machine-safe detail for an empty payload: the finish reason, and whether
 * the message carried reasoning only. A reasoning-only payload is still
 * empty — chain-of-thought is never surfaced as the answer.
 */
function emptyPayloadDetail(res: unknown): string {
  const parts: string[] = [];
  let finishReason: string | undefined;
  let hadReasoning = false;
  if (isRecord(res) && Array.isArray(res["choices"]) && res["choices"].length > 0) {
    const first = res["choices"][0];
    if (isRecord(first)) {
      const fr = first["finish_reason"];
      if (typeof fr === "string" && fr.length > 0) finishReason = fr;
      const message = first["message"];
      if (isRecord(message)) {
        const rc = message["reasoning_content"];
        const r = message["reasoning"];
        hadReasoning =
          (typeof rc === "string" && rc.length > 0) ||
          (typeof r === "string" && r.length > 0);
      }
    }
  }
  if (finishReason !== undefined) parts.push(`finish_reason=${finishReason}`);
  if (hadReasoning) parts.push("the response carried reasoning only");
  return parts.join(", ");
}

/**
 * Incremental Server-Sent Events parser for the streaming path.
 *
 * Chunks arrive as arbitrary byte slices: a line — or a whole JSON payload —
 * can be split across two pushes, so the parser buffers until it has complete
 * lines. Events are dispatched on blank lines (the SSE framing); a `data:`
 * line holds one JSON payload, `: ...` comment lines (heartbeats) are
 * ignored, and `data: [DONE]` ends the event flow.
 *
 * Exported so the wire format is assertable without a network, like the
 * other parse helpers in this module.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private done = false;

  /**
   * Feed one text chunk; returns the complete events parsed from it.
   * A malformed `data:` payload throws AiError("invalid_response"), matching
   * the strictness of the non-streaming parse — a service that speaks broken
   * SSE is a response fault, not something to silently skip.
   */
  push(text: string): Record<string, unknown>[] {
    if (this.done) return [];
    this.buffer += text;
    const events: Record<string, unknown>[] = [];

    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);

      if (line === "") {
        const event = this.dispatch();
        if (event !== undefined) events.push(event);
        continue;
      }
      if (line.startsWith(":")) continue; // comment / heartbeat
      if (line.startsWith("data:")) {
        // Per SSE, one optional leading space is stripped.
        const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
        if (value === "[DONE]") {
          this.done = true;
          this.dataLines = [];
          continue;
        }
        this.dataLines.push(value);
        continue;
      }
      // Unknown SSE fields (event:, id:, retry:) carry no payload here.
    }

    return events;
  }

  /**
   * Flush any event still buffered when the byte stream ends without a
   * trailing blank line. completeStream calls this after its read loop so a
   * final event is never silently dropped.
   */
  flush(): Record<string, unknown>[] {
    if (this.done) return [];
    // A dangling partial line plus a blank line: the normal framing takes
    // over, so a half-buffered final event is parsed, not dropped.
    return [...this.push("\n"), ...this.push("\n")];
  }

  private dispatch(): Record<string, unknown> | undefined {
    const lines = this.dataLines;
    this.dataLines = [];
    if (lines.length === 0) return undefined;
    const raw = lines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AiError("invalid_response", "Service response was unreadable.");
    }
    if (!isRecord(parsed)) {
      throw new AiError("invalid_response", "Service response was unreadable.");
    }
    return parsed;
  }
}

/** The `choices[0].delta` object of one streamed event, when present. */
function choiceDelta(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = event["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  const delta = first["delta"];
  return isRecord(delta) ? delta : undefined;
}

/** The `choices[0].finish_reason` of one streamed event, when present. */
function choiceFinishReason(event: Record<string, unknown>): string | undefined {
  const choices = event["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (!isRecord(first)) return undefined;
  const fr = first["finish_reason"];
  return typeof fr === "string" && fr.length > 0 ? fr : undefined;
}

/**
 * Accumulate fragmented tool-call deltas.
 *
 * OpenAI streams one tool call across many chunks: the first carries
 * `index`, `id` and `function.name`, later ones append to
 * `function.arguments`. Fragments are keyed by `index`; a fragment without
 * one is appended to the most recent call.
 */
function accumulateToolCallDeltas(
  acc: Map<number, { id: string; name: string; args: string }>,
  deltas: unknown[],
): void {
  for (const d of deltas) {
    if (!isRecord(d)) continue;
    const rawIndex = d["index"];
    const index =
      typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0
        ? rawIndex
        : acc.size;
    const fn = isRecord(d["function"]) ? d["function"] : undefined;

    let entry = acc.get(index);
    if (entry === undefined) {
      entry = { id: "", name: "", args: "" };
      acc.set(index, entry);
    }
    const id = d["id"];
    if (typeof id === "string" && id.length > 0) entry.id = id;
    if (fn !== undefined) {
      const name = fn["name"];
      if (typeof name === "string" && name.length > 0) entry.name = name;
      const args = fn["arguments"];
      if (typeof args === "string") entry.args += args;
    }
  }
}

/**
 * Build the neutral ToolCall[] from accumulated fragments, in index order.
 *
 * Entries without a name are dropped (a nameless call cannot be executed);
 * the id falls back to `call_<index>` like the non-streaming path, and
 * malformed argument JSON yields `{}` rather than failing the turn — the
 * same leniency parseResponse applies.
 */
function buildStreamedToolCalls(
  acc: Map<number, { id: string; name: string; args: string }>,
): ToolCall[] {
  const out: ToolCall[] = [];
  const indexes = [...acc.keys()].sort((a, b) => a - b);
  for (const index of indexes) {
    const entry = acc.get(index);
    if (entry === undefined || entry.name.length === 0) continue;
    out.push({
      id: entry.id.length > 0 ? entry.id : `call_${out.length}`,
      name: entry.name,
      arguments: parseArguments(entry.args),
    });
  }
  return out;
}

/** Token counts from a streamed `usage` payload, when well-formed. */
function parseStreamUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = numberOrUndefined(raw["prompt_tokens"]);
  const output = numberOrUndefined(raw["completion_tokens"]);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

/**
 * The assistant text from a response.
 *
 * A tool-requesting turn legitimately has null or empty content, so an absent
 * string is NOT an error here — the caller decides, based on whether tool calls
 * came back. Only a structurally unusable payload throws.
 */
function extractContent(res: unknown): string {
  const message = extractMessage(res);

  // `content` may be a string or an array of parts; handle both.
  const content = message["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (isRecord(part) && typeof part["text"] === "string") texts.push(part["text"]);
    }
    return texts.join("");
  }
  if (content === null || content === undefined) return "";
  return "";
}

/** Tool calls and usage, when the service reported them. */
function responseExtras(res: unknown): { toolCalls?: ToolCall[]; usage?: TokenUsage } {
  const message = extractMessage(res);
  const out: { toolCalls?: ToolCall[]; usage?: TokenUsage } = {};

  const raw = message["tool_calls"];
  if (Array.isArray(raw)) {
    const calls: ToolCall[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const fn = entry["function"];
      if (!isRecord(fn)) continue;
      const name = fn["name"];
      if (typeof name !== "string" || name.length === 0) continue;
      const id = typeof entry["id"] === "string" && entry["id"].length > 0
        ? entry["id"]
        // A service that omits the id still needs a stable one to correlate
        // the result with; position within the turn is sufficient.
        : `call_${calls.length}`;
      calls.push({
        id,
        name,
        arguments: parseArguments(fn["arguments"]),
      });
    }
    if (calls.length > 0) out.toolCalls = calls;
  }

  const usage = res !== null && isRecord(res) ? res["usage"] : undefined;
  if (isRecord(usage)) {
    const input = numberOrUndefined(usage["prompt_tokens"]);
    const output = numberOrUndefined(usage["completion_tokens"]);
    if (input !== undefined || output !== undefined) {
      out.usage = {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
      };
    }
  }

  return out;
}

/** The first choice's message object, or a response-fault error. */
function extractMessage(res: unknown): Record<string, unknown> {
  if (!isRecord(res)) {
    throw new AiError("invalid_response", "Service response was empty.");
  }
  const choices = res["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AiError("invalid_response", "Service response was empty.");
  }
  const first = choices[0];
  if (!isRecord(first)) {
    throw new AiError("invalid_response", "Service response was empty.");
  }
  const message = first["message"];
  if (!isRecord(message)) {
    throw new AiError("invalid_response", "Service response was empty.");
  }
  return message;
}

/**
 * This service sends arguments as a JSON string.
 *
 * Malformed JSON yields `{}` rather than throwing: a truncated argument blob is
 * a model mistake, and letting it fall through to input validation produces a
 * clearer outcome than failing the whole turn.
 */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractModel(res: unknown, requested: string): string {
  if (isRecord(res) && typeof res["model"] === "string") return res["model"];
  return requested;
}

function headers(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (apiKey !== undefined && apiKey.length > 0) {
    h["authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

interface FetchOptions {
  /** Path appended to the validated base URL, e.g. `/chat/completions`. */
  path: string;
  method: string;
  headers: Record<string, string>;
  /** The request credential, used ONLY to redact it from provider error text. */
  secret?: string | undefined;
  timeoutMs: number;
  signal: AbortSignal;
  body?: string;
}

/**
 * Parse a JSON response body into a record.
 *
 * A malformed body is a response problem, not a network problem, so it maps to
 * invalid_response: failover treats that as non-retryable, which is correct —
 * a second provider would not fix a body this service produced.
 */
function readJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiError("invalid_response", "Service response was unreadable.");
  }
  if (!isRecord(parsed)) {
    throw new AiError("invalid_response", "Service response was empty.");
  }
  return parsed;
}

/**
 * Send one request through the pinned transport and map the result.
 *
 * The connection is bound to addresses `resolveTarget` approved, redirects are
 * never followed, and only a 2xx body is parsed. A non-2xx body never leaves
 * raw: only the status mapper's sanitized, capped, credential-redacted
 * extraction of the provider's own error words rides the thrown AiError.
 */
async function fetchJson(
  target: ResolvedTarget,
  opts: FetchOptions,
): Promise<Record<string, unknown>> {
  const res = await pinnedFetch({
    url: `${target.baseUrl}${opts.path}`,
    method: opts.method,
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    addresses: target.addresses,
    allowLocalTargets: target.allowLocalTargets,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  }).catch((err: unknown) => {
    // pinnedFetch already throws AiError with the right category.
    if (err instanceof AiError) throw err;
    throw new AiError("network", "Could not reach the service.");
  });

  if (res.status >= 300 && res.status < 400) {
    throw new AiError("invalid_response", "The service redirected to another address.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw statusToError(res.status, res.headers, {
      body: res.body,
      secret: opts.secret,
    });
  }

  return readJson(res.body);
}

/**
 * Read just enough of an error response's body for the status mapper to
 * quote the provider's own words — bounded, and never throwing: a body
 * that cannot be read simply leaves the mapped error without a quote.
 */
async function readStreamErrorBody(
  chunks: AsyncGenerator<Buffer, void, undefined>,
): Promise<string> {
  let text = "";
  try {
    for await (const chunk of chunks) {
      text += chunk.toString("utf8");
      if (text.length >= 600) break;
    }
  } catch {
    // Keep whatever arrived; the mapper treats an unreadable body as none.
  }
  return text;
}

/** Map an HTTP status onto the engine's categories (shared implementation). */
const statusToError = statusToAiError;


function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
