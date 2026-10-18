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
 * A provider's response body is never returned to the caller: it can echo the
 * request, so only a caller-chosen static message leaves this module.
 */
import { AiError, base64Bytes, MAX_ATTACHMENT_BYTES } from "./provider";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ContentPart,
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
import { pinnedFetch } from "./pinned_transport";
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
    notes: "POST {baseUrl}/chat/completions، GET {baseUrl}/models و POST {baseUrl}/embeddings",
  };
  readonly label = "سفارشی / سازگار با OpenAI";

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
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });

    return parseResponse(res, req.model);
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
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });

    const data = res["data"];
    if (!Array.isArray(data)) {
      throw new AiError("invalid_response", "پاسخ سرویس قابل خواندن نبود.");
    }
    const out: RemoteModel[] = [];
    for (const entry of data) {
      if (isRecord(entry) && typeof entry["id"] === "string") {
        out.push({ id: entry["id"] });
      }
    }
    return out;
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
    throw new AiError("invalid_response", "پاسخ سرویس قابل خواندن نبود.");
  }
  const vectors: Array<{ index: number; embedding: number[] }> = [];
  for (const entry of data) {
    if (!isRecord(entry)) {
      throw new AiError("invalid_response", "پاسخ سرویس قابل خواندن نبود.");
    }
    const embedding = entry["embedding"];
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      !embedding.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      throw new AiError("invalid_response", "پاسخ سرویس قابل خواندن نبود.");
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
    throw new AiError("invalid_response", "پاسخ سرویس قابل خواندن نبود.");
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

  const settings = target.settings;
  if (settings) {
    if (typeof settings.temperature === "number" && Number.isFinite(settings.temperature)) {
      body["temperature"] = clamp(settings.temperature, 0, 2);
    }
    if (
      typeof settings.maxTokens === "number" &&
      Number.isFinite(settings.maxTokens) &&
      settings.maxTokens > 0
    ) {
      body["max_tokens"] = Math.min(Math.trunc(settings.maxTokens), 100_000);
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
  /** The label, e.g. "[سند متنی notes.txt]: ". */
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
  const label = `[سند متنی ${part.name ?? mediaType}]: `;
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
    text: `${decoded.slice(0, end)}… [ادامه‌ی متن به دلیل حجم زیاد حذف شد]`,
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
      out.push({ type: "text", text: `[پیوست ${part.type}: ${part.mediaType} ارسال نشد]` });
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
  return {
    text: extractContent(res),
    model: extractModel(res, requestedModel),
    ...responseExtras(res),
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
    throw new AiError("invalid_response", "پاسخ سرویس خالی بود.");
  }
  const choices = res["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AiError("invalid_response", "پاسخ سرویس خالی بود.");
  }
  const first = choices[0];
  if (!isRecord(first)) {
    throw new AiError("invalid_response", "پاسخ سرویس خالی بود.");
  }
  const message = first["message"];
  if (!isRecord(message)) {
    throw new AiError("invalid_response", "پاسخ سرویس خالی بود.");
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
    throw new AiError("invalid_response", "پاسخ سرویس قابل خواندن نبود.");
  }
  if (!isRecord(parsed)) {
    throw new AiError("invalid_response", "پاسخ سرویس خالی بود.");
  }
  return parsed;
}

/**
 * Send one request through the pinned transport and map the result.
 *
 * The connection is bound to addresses `resolveTarget` approved, redirects are
 * never followed, and only a 2xx body is parsed. The response body is never
 * echoed into an error, so a provider that echoes the request cannot leak the
 * key into a message.
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
    throw new AiError("network", "ارتباط با سرویس برقرار نشد.");
  });

  if (res.status >= 300 && res.status < 400) {
    throw new AiError("invalid_response", "سرویس به آدرس دیگری ارجاع داد.");
  }
  if (res.status < 200 || res.status >= 300) {
    throw statusToError(res.status);
  }

  return readJson(res.body);
}

/** Map an HTTP status onto the engine's categories. */
function statusToError(status: number): AiError {
  if (status === 401 || status === 403) {
    return new AiError("auth", "احراز هویت سرویس ناموفق بود.");
  }
  if (status === 408) {
    return new AiError("timeout", "پاسخ سرویس به‌موقع نرسید.");
  }
  if (status === 429) {
    return new AiError("quota", "محدودیت نرخ سرویس پر شده است.");
  }
  if (status >= 500) {
    return new AiError("network", "سرویس در دسترس نیست.");
  }
  if (status === 400 || status === 404 || status === 422) {
    // Request-shaped problems are surfaced as invalid, never as the raw body.
    return new AiError("invalid_response", "درخواست به سرویس نامعتبر بود.");
  }
  return new AiError("unknown", "خطای ناشناخته سرویس.");
}


function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
