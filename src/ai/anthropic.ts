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
import { AiError } from "./provider";
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
import { pinnedFetch } from "./pinned_transport";

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
  readonly capabilities = { notes: "POST {baseUrl}/messages" };
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
  let system = target.settings?.systemPrompt;

  // A system turn supplies the top-level `system` field; everything else
  // becomes a message.
  const messages: Array<{ role: string; content: unknown }> = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      system = m.content;
      continue;
    }
    messages.push(toWireMessage(m));
  }

  if (messages.length === 0) {
    throw new AiError("invalid_response", "درخواست پیامی نداشت.");
  }

  const maxTokens =
    target.settings?.maxTokens !== undefined &&
    Number.isFinite(target.settings.maxTokens) &&
    target.settings.maxTokens > 0
      ? Math.min(Math.trunc(target.settings.maxTokens), 100_000)
      : DEFAULT_MAX_TOKENS;

  const body: Record<string, unknown> = { model: req.model, max_tokens: maxTokens, messages };
  if (system !== undefined && system.length > 0) body["system"] = system;

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
  if (typeof t === "number" && Number.isFinite(t)) {
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

  return {
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  };
}

/**
 * Parse a response payload into the neutral shape. Exported for tests.
 */
export function parseResponse(
  res: Record<string, unknown>,
  requestedModel: string,
): CompletionResponse {
  return {
    text: extractText(res),
    model: extractModel(res, requestedModel),
    ...responseExtras(res),
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
    throw new AiError("invalid_response", "پاسخ سرویس متن نداشت.");
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
    if (opts.signal.aborted) throw new AiError("aborted", "درخواست لغو شد.");
    throw new AiError("network", "ارتباط با سرویس برقرار نشد.");
  });

  if (res.status >= 300 && res.status < 400) {
    throw new AiError("invalid_response", "سرویس به آدرس دیگری ارجاع داد.");
  }
  if (res.status < 200 || res.status >= 300) throw statusToError(res.status);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    // A malformed body is a response fault, not a network fault.
    throw new AiError("invalid_response", "پاسخ سرویس قابل خواندن نبود.");
  }
  if (!isRecord(parsed)) throw new AiError("invalid_response", "پاسخ سرویس خالی بود.");
  return parsed;
}

function statusToError(status: number): AiError {
  if (status === 401 || status === 403) {
    return new AiError("auth", "احراز هویت سرویس ناموفق بود.");
  }
  if (status === 408) return new AiError("timeout", "پاسخ سرویس به‌موقع نرسید.");
  if (status === 429) return new AiError("quota", "محدودیت نرخ سرویس پر شده است.");
  if (status >= 500) return new AiError("network", "سرویس در دسترس نیست.");
  if (status === 400 || status === 404 || status === 422) {
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
