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
import { pinnedFetch } from "./pinned_transport";
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
  readonly capabilities = { notes: "POST {baseUrl}/messages", documentInput: true };
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

  const configuredMaxTokens =
    target.settings?.maxTokens !== undefined &&
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
  if (res.status < 200 || res.status >= 300) throw statusToError(res.status, res.headers);

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
