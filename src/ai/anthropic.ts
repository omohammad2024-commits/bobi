/**
 * Anthropic adapter.
 *
 * Wire format (NOT OpenAI-compatible):
 *   POST {baseUrl}/messages
 *   headers: x-api-key, anthropic-version
 *   body { model, system?, messages[{role, content}], max_tokens, temperature? }
 *   response content[{type:"text", text}]
 *
 * Notes that shape this implementation:
 * - `max_tokens` is REQUIRED by the service, so a default is applied when the
 *   owner has not set one.
 * - System turns are hoisted into the top-level `system` field, not sent as a
 *   message role.
 * - Extra headers are exactly the ones the service documents; the key never
 *   appears in a URL, so a logged URL cannot expose it.
 */
import { AiError, emptyResponseError } from "./provider";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  TokenUsage,
  ToolCall,
} from "./provider";
import type {
  AIProviderAdapter,
  AdapterSettings,
  AdapterTarget,
  ListModelsRequest,
  RemoteModel,
} from "./adapter";
import { resolveTarget, type ResolvedTarget } from "./dns_guard";
import { statusToAiError } from "./http_status";
import { pinnedFetch, pinnedStream } from "./pinned_transport";
import { SseParser } from "./openai_compatible";
import { selectParts, textWithPartNotes } from "./parts";
import type { SendablePart } from "./parts";
import { resolveReasoningEffort, reasoningParamsFor } from "./reasoning";
import { promptCacheEnabled, anthropicCacheBreakpoint } from "./cache_policy";

/** Anthropic requires an explicit cap; this is only a fallback. */
const DEFAULT_MAX_TOKENS = 1024;

/** API version this adapter speaks. */
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicTarget extends AdapterTarget {
  settings?: AdapterSettings;
  allowLocalTargets?: boolean;
}

export class AnthropicAdapter implements AIProviderAdapter {
  /** Equals the adapter type; the engine reads this for its fake check. */
  readonly name = "anthropic";
  readonly type = "anthropic" as const;
  readonly capabilities = {
    notes: "POST {baseUrl}/messages",
    documentInput: true,
    streaming: true,
  };
  readonly label = "Anthropic";

  private readonly target: AnthropicTarget;

  constructor(target: AnthropicTarget) {
    this.target = target;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const resolved = await resolveTarget(this.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });

    const body = buildBody(this.target, req);
    const res = await fetchJson(resolved, "/messages", {
      method: "POST",
      secret: this.target.apiKey,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(this.target.apiKey !== undefined && this.target.apiKey.length > 0
          ? { "x-api-key": this.target.apiKey }
          : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    });

    return parseResponse(res, req.model);
  }

  /**
   * Stream a completion via POST /messages with `stream: true`.
   *
   * Same StreamEvent contract as the OpenAI-compatible adapter: text
   * deltas as they arrive, a usage event when the service reports the
   * assembled counts, and exactly one terminal `end`. An empty stream
   * (including a thinking-only one) is the empty-response failure, so
   * the gateway fails over.
   */
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const resolved = await resolveTarget(this.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });

    const body = { ...buildBody(this.target, req), stream: true };
    const stream = await pinnedStream({
      url: `${resolved.baseUrl}/messages`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": ANTHROPIC_VERSION,
        ...(this.target.apiKey !== undefined && this.target.apiKey.length > 0
          ? { "x-api-key": this.target.apiKey }
          : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      addresses: resolved.addresses,
      allowLocalTargets: resolved.allowLocalTargets,
    });

    if (stream.status >= 300 && stream.status < 400) {
      await stream.chunks.return(undefined);
      throw new AiError("invalid_response", "The service redirected to another address.");
    }
    if (stream.status < 200 || stream.status >= 300) {
      const errorBody = await readStreamErrorBody(stream.chunks);
      await stream.chunks.return(undefined);
      throw statusToAiError(stream.status, stream.headers, {
        body: errorBody,
        secret: this.target.apiKey,
      });
    }

    const parser = new SseParser();
    const assembler = new AnthropicStreamAssembler(req.model);

    try {
      for await (const chunk of stream.chunks) {
        for (const event of parser.push(chunk.toString("utf8"))) {
          yield* assembler.push(event);
        }
      }
      for (const event of parser.flush()) {
        yield* assembler.push(event);
      }
    } finally {
      await stream.chunks.return(undefined);
    }

    yield assembler.finish();
  }

  // The service's model list is not a simple GET for this adapter's needs, so
  // the capability is intentionally not declared: the panel offers manual entry.
}

/**
 * Request body. Exported so the wire format can be asserted without a network.
 */
export function buildBody(target: AnthropicTarget, req: CompletionRequest): Record<string, unknown> {
  // System turns are HOISTED into the single top-level `system` field.
  //
  // They are concatenated, never overwritten. A conversation can legitimately
  // carry more than one system turn — the owner's configured prompt, the
  // agent's own prompt, and a rolling summary of older history — and
  // last-one-wins would discard the earlier ones entirely, dropping the tool
  // rules and identity while promoting model-written summary text into the
  // trusted system slot.
  const messages: Array<{ role: string; content: unknown }> = [];
  const systemParts: string[] = [];
  const configured = target.settings?.systemPrompt;
  if (typeof configured === "string" && configured.length > 0) systemParts.push(configured);

  for (const m of req.messages) {
    if (m.role === "system") {
      if (m.content.length > 0) systemParts.push(m.content);
      continue;
    }
    messages.push(toWireMessage(m));
  }
  const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  if (messages.length === 0) {
    throw new AiError("invalid_response", "The request had no messages.");
  }

  // Opt-in reasoning: off unless the owner set BOBI_REASONING_EFFORT. The
  // params are resolved once per request so the test can toggle them via env.
  const reasoning = reasoningParamsFor("anthropic", resolveReasoningEffort());

  // Per-request cap wins over the settings cap (provider.ts contract,
  // mirroring the OpenAI adapter); the service-required default applies
  // only when neither level sets a valid cap.
  const configuredMaxTokens =
    typeof req.maxTokens === "number" && Number.isFinite(req.maxTokens) && req.maxTokens > 0
      ? Math.min(Math.trunc(req.maxTokens), 100_000)
      : target.settings?.maxTokens !== undefined &&
          Number.isFinite(target.settings.maxTokens) &&
          target.settings.maxTokens > 0
        ? Math.min(Math.trunc(target.settings.maxTokens), 100_000)
        : DEFAULT_MAX_TOKENS;
  // Extended thinking is rejected when max_tokens <= budget_tokens, so the
  // enabled path leaves headroom for actual output above the budget.
  const maxTokens =
    reasoning.enabled && configuredMaxTokens <= reasoning.budgetTokens
      ? reasoning.budgetTokens + 1024
      : configuredMaxTokens;

  const body: Record<string, unknown> = { model: req.model, max_tokens: maxTokens, messages };
  if (system !== undefined && system.length > 0) {
    // Opt-in prompt caching: the system prompt becomes a content block so it
    // can carry a cache_control breakpoint. Off by default, so the default
    // request stays a plain string exactly as before.
    body["system"] = promptCacheEnabled()
      ? [{ type: "text", text: system, ...anthropicCacheBreakpoint() }]
      : system;
  }

  // This service takes tool definitions as a flat array with `input_schema`,
  // not wrapped in the OpenAI `function` envelope.
  if (req.tools !== undefined && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const t = target.settings?.temperature;
  if (reasoning.enabled) {
    // Vendor rule: extended thinking requires temperature 1; anything else is
    // rejected. Only applied on the explicitly enabled path, so the default
    // request (reasoning off) is untouched.
    body["thinking"] = { type: "enabled", budget_tokens: reasoning.budgetTokens };
    body["temperature"] = 1;
  } else if (typeof t === "number" && Number.isFinite(t)) {
    body["temperature"] = clamp(t, 0, 1);
  }
  return body;
}

/** Map one neutral message onto this service's shape. Exported for tests. */
export function toWireMessage(m: ChatMessage): { role: string; content: unknown } {
  // This service has no "tool" role: a tool result is a USER turn carrying a
  // tool_result block, and an assistant tool request is an assistant turn
  // carrying tool_use blocks.
  if (m.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.content,
        },
      ],
    };
  }

  if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
    const blocks: unknown[] = [];
    if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
    for (const call of m.toolCalls) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: asObject(call.arguments),
      });
    }
    return { role: "assistant", content: blocks };
  }

  // A message with attachments becomes a content-block array. This service
  // accepts an image as a base64 source block, and a PDF as a document block,
  // so both travel natively rather than being described in the text.
  const { sendable, dropped } = selectParts(m);
  if (sendable.length > 0) {
    const blocks: unknown[] = [];
    const text = textWithPartNotes(m);
    if (text.length > 0) blocks.push({ type: "text", text });
    for (const part of sendable) blocks.push(attachmentBlock(part));
    return { role: m.role === "assistant" ? "assistant" : "user", content: blocks };
  }
  if (dropped.length > 0) {
    return { role: m.role === "assistant" ? "assistant" : "user", content: textWithPartNotes(m) };
  }

  return {
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  };
}

/** This service's block for one attachment. */
function attachmentBlock(part: SendablePart): Record<string, unknown> {
  if (part.type === "image") {
    return {
      type: "image",
      source: { type: "base64", media_type: part.mediaType, data: part.base64 },
    };
  }
  if (part.type === "document") {
    return {
      type: "document",
      source: { type: "base64", media_type: part.mediaType, data: part.base64 },
      ...(part.name !== undefined ? { title: part.name } : {}),
    };
  }
  // Audio has no block form here, so it is named in the text rather than sent
  // as a block the service would reject.
  return { type: "text", text: `[Audio attachment: ${part.mediaType} not sent]` };
}

/**
 * Parse a response payload into the neutral shape. Exported for tests.
 */
export function parseResponse(
  res: Record<string, unknown>,
  requestedModel: string,
): CompletionResponse {
  const text = extractText(res);
  const extras = responseExtras(res);
  if (text.trim().length === 0 && (extras.toolCalls ?? []).length === 0) {
    // No text block and no tool_use block: a candidate failure, not a
    // silent empty success. A thinking-only payload is still empty —
    // chain-of-thought is never surfaced as the answer.
    const content = res["content"];
    const thinkingOnly =
      Array.isArray(content) &&
      content.some((b) => isRecord(b) && b["type"] === "thinking");
    throw emptyResponseError(thinkingOnly ? "the response carried reasoning only" : undefined);
  }
  return {
    text,
    model: extractModel(res, requestedModel),
    ...extras,
  };
}

/**
 * Assembles Anthropic SSE events into the neutral StreamEvent contract.
 *
 * Exported for tests, like SseParser/buildBody: completeStream drives
 * one instance per request, feeding each parsed SSE JSON payload to
 * push() and yielding whatever it returns, then yields finish() once.
 *
 * Tool input arrives fragmented as input_json_delta partial-JSON
 * strings for the open tool_use block; the block is finalised at
 * content_block_stop, with a malformed accumulation yielding {} —
 * the same leniency the OpenAI adapter applies to streamed arguments.
 * thinking deltas/blocks only set the reasoning flag: a thinking-only
 * stream is still an empty response, never a surfaced answer.
 */
export class AnthropicStreamAssembler {
  private textAcc = "";
  private modelValue: string;
  private inputTokensValue: number | undefined;
  private outputTokensValue: number | undefined;
  private stopReasonValue: string | undefined;
  private hadReasoningFlag = false;
  /** Open (not yet stopped) blocks by their SSE index. */
  private readonly openBlocks = new Map<
    number,
    { kind: "text" | "tool_use" | "thinking" | "other"; id: string; name: string; argsText: string; initialInput: unknown }
  >();
  /** Finalised tool calls by block index, so end order follows the wire. */
  private readonly finishedCalls = new Map<number, ToolCall>();

  constructor(requestedModel: string) {
    this.modelValue = requestedModel;
  }

  get text(): string {
    return this.textAcc;
  }
  get toolCalls(): readonly ToolCall[] {
    return [...this.finishedCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call);
  }
  get usage(): TokenUsage | undefined {
    if (this.inputTokensValue === undefined && this.outputTokensValue === undefined) {
      return undefined;
    }
    return {
      ...(this.inputTokensValue !== undefined ? { inputTokens: this.inputTokensValue } : {}),
      ...(this.outputTokensValue !== undefined ? { outputTokens: this.outputTokensValue } : {}),
    };
  }
  get model(): string {
    return this.modelValue;
  }
  get stopReason(): string | undefined {
    return this.stopReasonValue;
  }
  get hadReasoning(): boolean {
    return this.hadReasoningFlag;
  }

  push(event: Record<string, unknown>): StreamEvent[] {
    const out: StreamEvent[] = [];
    const type = event["type"];

    if (type === "error") {
      throw anthropicStreamError(event);
    }

    if (type === "message_start") {
      const message = event["message"];
      if (isRecord(message)) {
        if (typeof message["model"] === "string" && message["model"].length > 0) {
          this.modelValue = message["model"];
        }
        const usage = message["usage"];
        if (isRecord(usage)) {
          const input = numberOrUndefined(usage["input_tokens"]);
          const output = numberOrUndefined(usage["output_tokens"]);
          if (input !== undefined) this.inputTokensValue = input;
          if (output !== undefined) this.outputTokensValue = output;
        }
      }
      return out;
    }

    if (type === "content_block_start") {
      const index = blockIndex(event);
      const block = event["content_block"];
      if (index === undefined || !isRecord(block)) return out;
      const blockType = block["type"];
      if (blockType === "tool_use") {
        this.openBlocks.set(index, {
          kind: "tool_use",
          id: typeof block["id"] === "string" && block["id"].length > 0 ? block["id"] : `call_${index}`,
          name: typeof block["name"] === "string" ? block["name"] : "",
          argsText: "",
          initialInput: block["input"],
        });
      } else if (blockType === "text") {
        this.openBlocks.set(index, { kind: "text", id: "", name: "", argsText: "", initialInput: undefined });
        if (typeof block["text"] === "string" && block["text"].length > 0) {
          this.textAcc += block["text"];
          out.push({ type: "text", delta: block["text"] });
        }
      } else if (blockType === "thinking") {
        this.hadReasoningFlag = true;
        this.openBlocks.set(index, { kind: "thinking", id: "", name: "", argsText: "", initialInput: undefined });
      } else {
        this.openBlocks.set(index, { kind: "other", id: "", name: "", argsText: "", initialInput: undefined });
      }
      return out;
    }

    if (type === "content_block_delta") {
      const index = blockIndex(event);
      const delta = event["delta"];
      if (index === undefined || !isRecord(delta)) return out;
      const deltaType = delta["type"];
      if (deltaType === "text_delta") {
        if (typeof delta["text"] === "string" && delta["text"].length > 0) {
          this.textAcc += delta["text"];
          out.push({ type: "text", delta: delta["text"] });
        }
      } else if (deltaType === "input_json_delta") {
        const open = this.openBlocks.get(index);
        if (open !== undefined && open.kind === "tool_use" && typeof delta["partial_json"] === "string") {
          open.argsText += delta["partial_json"];
        }
      } else if (deltaType === "thinking_delta") {
        this.hadReasoningFlag = true;
      }
      return out;
    }

    if (type === "content_block_stop") {
      const index = blockIndex(event);
      if (index === undefined) return out;
      const open = this.openBlocks.get(index);
      this.openBlocks.delete(index);
      if (open !== undefined && open.kind === "tool_use" && open.name.length > 0) {
        this.finishedCalls.set(index, {
          id: open.id,
          name: open.name,
          arguments: finalizeToolInput(open.argsText, open.initialInput),
        });
      }
      return out;
    }

    if (type === "message_delta") {
      const delta = event["delta"];
      if (isRecord(delta) && typeof delta["stop_reason"] === "string" && delta["stop_reason"].length > 0) {
        this.stopReasonValue = delta["stop_reason"];
      }
      const usage = event["usage"];
      if (isRecord(usage)) {
        const output = numberOrUndefined(usage["output_tokens"]);
        if (output !== undefined) this.outputTokensValue = output;
        const assembled = this.usage;
        if (assembled !== undefined) out.push({ type: "usage", usage: assembled });
      }
      return out;
    }

    // message_stop / ping / unknown types carry nothing to yield; the
    // terminal end is built by finish() once the byte stream closes.
    return out;
  }

  /** Terminal `end` event, or the empty-response failure when nothing arrived. */
  finish(): StreamEvent {
    // A tool block the service never stopped still counts: finalise any
    // open tool blocks in index order rather than dropping the calls.
    for (const [index, open] of [...this.openBlocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (open.kind === "tool_use" && open.name.length > 0 && !this.finishedCalls.has(index)) {
        this.finishedCalls.set(index, {
          id: open.id,
          name: open.name,
          arguments: finalizeToolInput(open.argsText, open.initialInput),
        });
      }
    }
    this.openBlocks.clear();

    const calls = this.toolCalls;
    if (this.textAcc.trim().length === 0 && calls.length === 0) {
      const parts: string[] = ["stream"];
      if (this.stopReasonValue !== undefined) parts.push(`stop_reason=${this.stopReasonValue}`);
      if (this.hadReasoningFlag) parts.push("the response carried reasoning only");
      throw emptyResponseError(parts.join(", "));
    }
    const usage = this.usage;
    return {
      type: "end",
      text: this.textAcc,
      model: this.modelValue,
      toolCalls: calls,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}

/** The top-level `index` of a content_block_* event, when well-formed. */
function blockIndex(event: Record<string, unknown>): number | undefined {
  const index = event["index"];
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * Final tool input: the accumulated partial JSON parsed, falling back
 * to the block's initial input (or {}) on parse failure — mirroring
 * the OpenAI adapter's leniency for malformed streamed arguments.
 */
function finalizeToolInput(argsText: string, initialInput: unknown): unknown {
  const trimmed = argsText.trim();
  if (trimmed.length === 0) return initialInput ?? {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

/**
 * Map an Anthropic mid-stream `error` event onto AiError: the kind from
 * the provider's error type, its own sentence carried as
 * providerMessage (never as the headline message).
 */
function anthropicStreamError(event: Record<string, unknown>): AiError {
  const error = event["error"];
  const errorType = isRecord(error) && typeof error["type"] === "string" ? error["type"] : undefined;
  const providerMessage =
    isRecord(error) && typeof error["message"] === "string" && error["message"].length > 0
      ? error["message"]
      : undefined;
  const kind: AiError["kind"] =
    errorType === "authentication_error"
      ? "auth"
      : errorType === "rate_limit_error"
        ? "quota"
        : errorType === "overloaded_error"
          ? "network"
          : "invalid_response";
  return new AiError(
    kind,
    "The service returned an error during streaming.",
    undefined,
    undefined,
    undefined,
    undefined,
    providerMessage,
  );
}

/**
 * Read just enough of a streamed error body for the status mapper to
 * quote the provider's own words — bounded, never throwing. Local copy
 * of the OpenAI adapter's helper (not exported there).
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

/**
 * Text from the response's content blocks.
 *
 * A turn that requested tools may carry no text block at all, which is valid —
 * the loop checks for tool calls before treating empty text as a failure.
 */
function extractText(res: Record<string, unknown>): string {
  const content = res["content"];
  if (!Array.isArray(content)) {
    throw new AiError("invalid_response", "Service response had no text.");
  }
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
      texts.push(block["text"]);
    }
  }
  return texts.join("");
}

/** `tool_use` blocks and token usage, when present. */
function responseExtras(res: Record<string, unknown>): {
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
} {
  const out: { toolCalls?: ToolCall[]; usage?: TokenUsage } = {};

  const content = res["content"];
  if (Array.isArray(content)) {
    const calls: ToolCall[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block["type"] !== "tool_use") continue;
      const name = block["name"];
      if (typeof name !== "string" || name.length === 0) continue;
      const id = typeof block["id"] === "string" && block["id"].length > 0
        ? block["id"]
        : `call_${calls.length}`;
      calls.push({ id, name, arguments: block["input"] ?? {} });
    }
    if (calls.length > 0) out.toolCalls = calls;
  }

  const usage = res["usage"];
  if (isRecord(usage)) {
    const input = numberOrUndefined(usage["input_tokens"]);
    const output = numberOrUndefined(usage["output_tokens"]);
    if (input !== undefined || output !== undefined) {
      out.usage = {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
      };
    }
  }

  return out;
}

/** This service requires `input` to be an object. */
function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractModel(res: Record<string, unknown>, requested: string): string {
  return typeof res["model"] === "string" ? res["model"] : requested;
}

interface AnthropicFetchOptions {
  method: string;
  headers: Record<string, string>;
  /** The request credential, used ONLY to redact it from provider error text. */
  secret?: string | undefined;
  timeoutMs: number;
  signal: AbortSignal;
  body?: string;
}

async function fetchJson(
  resolved: ResolvedTarget,
  path: string,
  opts: AnthropicFetchOptions,
): Promise<Record<string, unknown>> {
  const res = await pinnedFetch({
    url: `${resolved.baseUrl}${path}`,
    method: opts.method,
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    addresses: resolved.addresses,
    allowLocalTargets: resolved.allowLocalTargets,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  }).catch((err: unknown) => {
    // pinnedFetch already categorises timeout/cancel/transport failures.
    if (err instanceof AiError) throw err;
    if (opts.signal.aborted) throw new AiError("aborted", "Request was cancelled.");
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    // A malformed body is a response fault, not a network fault.
    throw new AiError("invalid_response", "Service response was unreadable.");
  }
  if (!isRecord(parsed)) throw new AiError("invalid_response", "Service response was empty.");
  return parsed;
}

/** Same status mapping as the OpenAI-compatible adapter (shared implementation). */
const statusToError = statusToAiError;


function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
