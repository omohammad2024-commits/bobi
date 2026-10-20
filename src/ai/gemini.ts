/**
 * Google Gemini adapter.
 *
 * Wire format for this service is NOT OpenAI-compatible:
 *   POST {baseUrl}/models/{model}:generateContent?key=...
 *   body { contents[{role, parts[{text}]}], systemInstruction?,
 *          generationConfig{ temperature, maxOutputTokens } }
 *   response candidates[0].content.parts[].text
 *
 * Auth is the `key` query parameter, so it is never placed in a header or a
 * URL that could be logged whole: the key is attached by this module at call
 * time only, and error messages never include the URL.
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
import { resolveReasoningEffort, reasoningParamsFor } from "./reasoning";

export interface GeminiTarget extends AdapterTarget {
  settings?: AdapterSettings;
  allowLocalTargets?: boolean;
}

export class GeminiAdapter implements AIProviderAdapter {
  /** Equals the adapter type; the engine reads this for its fake check. */
  readonly name = "gemini";
  readonly type = "gemini" as const;
  readonly capabilities = {
    listModels: true,
    audioInput: true,
    documentInput: true,
    notes: "POST {baseUrl}/models/{model}:generateContent",
  };
  readonly label = "Google Gemini";

  private readonly target: GeminiTarget;

  constructor(target: GeminiTarget) {
    this.target = target;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const resolved = await resolveTarget(this.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });

    const body = buildBody(this.target, req);
    const res = await fetchJson(
      resolved,
      `/models/${encodeURIComponent(req.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        apiKey: this.target.apiKey,
      },
    );

    return parseResponse(res, req.model);
  }

  async listModels(req: ListModelsRequest): Promise<readonly RemoteModel[]> {
    const resolved = await resolveTarget(req.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });
    const res = await fetchJson(resolved, "/models", {
      method: "GET",
      headers: { accept: "application/json" },
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      apiKey: req.target.apiKey,
    });

    const models = res["models"];
    if (!Array.isArray(models)) {
      throw new AiError("invalid_response", "Service response was unreadable.");
    }
    const out: RemoteModel[] = [];
    for (const entry of models) {
      if (!isRecord(entry) || typeof entry["name"] !== "string") continue;
      // "models/gemini-2.5-flash" → "gemini-2.5-flash"
      const id = entry["name"].replace(/^models\//, "");
      const displayName = entry["displayName"];
      out.push({
        id,
        ...(typeof displayName === "string" && displayName.length > 0
          ? { label: displayName }
          : {}),
      });
    }
    return out;
  }
}

/**
 * Map one neutral message onto this service's shape. Exported for tests.
 */
export function toWireMessage(m: ChatMessage): { role: string; parts: unknown[] } {
  // This service has no "tool" role either: a tool result is a user turn with
  // a functionResponse part, keyed by the function NAME rather than an id.
  if (m.role === "tool") {
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: m.toolName ?? "",
            response: { content: m.content },
          },
        },
      ],
    };
  }

  if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
    const parts: unknown[] = [];
    if (m.content.length > 0) parts.push({ text: m.content });
    for (const call of m.toolCalls) {
      parts.push({ functionCall: { name: call.name, args: asObject(call.arguments) } });
    }
    return { role: "model", parts };
  }

  // A message with attachments becomes a parts array. This service accepts
  // images, audio, and documents as `inlineData`, so all three travel natively
  // rather than being described in the text.
  const { sendable, dropped } = selectParts(m);
  if (sendable.length > 0) {
    const parts: unknown[] = [];
    const text = textWithPartNotes(m);
    if (text.length > 0) parts.push({ text });
    for (const part of sendable) {
      parts.push({
        inlineData: { mimeType: part.mediaType, data: part.base64 },
      });
    }
    return { role: m.role === "assistant" ? "model" : "user", parts };
  }
  if (dropped.length > 0) {
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: textWithPartNotes(m) }],
    };
  }

  return {
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  };
}

/**
 * Request body. Exported so the wire format can be asserted without a network.
 */
export function buildBody(target: GeminiTarget, req: CompletionRequest): Record<string, unknown> {
  // Gemini's roles are "user" and "model"; system turns become the single
  // systemInstruction.
  //
  // They are concatenated, never overwritten. A conversation can legitimately
  // carry more than one system turn — the prompt, plus a rolling summary of
  // older history — and last-one-wins would discard the prompt entirely,
  // dropping the tool rules and identity while promoting model-written summary
  // text into the trusted instruction slot.
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  const systemParts: string[] = [];
  if (target.settings?.systemPrompt !== undefined && target.settings.systemPrompt.length > 0) {
    systemParts.push(target.settings.systemPrompt);
  }

  for (const m of req.messages) {
    if (m.role === "system") {
      if (m.content.length > 0) systemParts.push(m.content);
      continue;
    }
    contents.push(toWireMessage(m));
  }
  const systemText = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  if (contents.length === 0) {
    throw new AiError("invalid_response", "The request had no messages.");
  }

  const body: Record<string, unknown> = { contents };

  if (systemText !== undefined && systemText.length > 0) {
    body["systemInstruction"] = { parts: [{ text: systemText }] };
  }

  // This service nests tool definitions under `functionDeclarations`.
  if (req.tools !== undefined && req.tools.length > 0) {
    body["tools"] = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  // No explicit cache breakpoint exists on this wire: the service caches
  // the prompt prefix implicitly, so there is nothing additive to set here.
  // Keeping the system prompt byte-stable (see src/ai/cache_policy.ts) is
  // what makes that implicit caching hit. Documented, not changed.

  // Opt-in reasoning: off unless the owner set BOBI_REASONING_EFFORT.
  const reasoning = reasoningParamsFor("gemini", resolveReasoningEffort());
  if (reasoning.enabled && reasoning.levelName !== undefined) {
    // thinkingConfig is a top-level request field. The level enum
    // (LOW/MEDIUM/HIGH) is the documented knob for current models; it maps
    // 1:1 onto BOBI's tiers.
    body["thinkingConfig"] = { thinkingLevel: reasoning.levelName.toUpperCase() };
  }

  const generation: Record<string, number> = {};
  const s = target.settings;
  if (s?.temperature !== undefined && Number.isFinite(s.temperature)) {
    generation["temperature"] = clamp(s.temperature, 0, 2);
  }
  if (s?.maxTokens !== undefined && Number.isFinite(s.maxTokens) && s.maxTokens > 0) {
    generation["maxOutputTokens"] = Math.min(Math.trunc(s.maxTokens), 100_000);
  }
  if (Object.keys(generation).length > 0) {
    body["generationConfig"] = generation;
  }

  return body;
}

/** The first candidate's parts, or undefined when the shape is unusable. */
function firstParts(res: Record<string, unknown>): unknown[] | undefined {
  const candidates = res["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const first = candidates[0];
  if (!isRecord(first)) return undefined;
  const content = first["content"];
  if (!isRecord(content)) return undefined;
  const parts = content["parts"];
  return Array.isArray(parts) ? parts : undefined;
}

/**
 * Text from the response parts.
 *
 * A turn that requested a function may carry no text part, which is valid; the
 * loop decides based on whether function calls came back.
 */
/** Parse a response payload. Exported for tests. */
export function parseResponse(
  res: Record<string, unknown>,
  requestedModel: string,
): CompletionResponse {
  const text = extractText(res);
  const extras = responseExtras(res);
  if (text.trim().length === 0 && (extras.toolCalls ?? []).length === 0) {
    // No text and no function call: a candidate failure, not a silent
    // empty success (same rule as the OpenAI-compatible adapter).
    throw emptyResponseError();
  }
  return {
    text,
    model: extractModel(res, requestedModel),
    ...extras,
  };
}

function extractText(res: Record<string, unknown>): string {
  const parts = firstParts(res);
  if (!parts) {
    // A blocked or empty finish reason lands here.
    throw new AiError("invalid_response", "Service response had no text.");
  }
  const texts: string[] = [];
  for (const part of parts) {
    if (isRecord(part) && typeof part["text"] === "string") texts.push(part["text"]);
  }
  return texts.join("");
}

/** `functionCall` parts and token usage, when present. */
function responseExtras(res: Record<string, unknown>): {
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
} {
  const out: { toolCalls?: ToolCall[]; usage?: TokenUsage } = {};

  const parts = firstParts(res);
  if (parts) {
    const calls: ToolCall[] = [];
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const fn = part["functionCall"];
      if (!isRecord(fn)) continue;
      const name = fn["name"];
      if (typeof name !== "string" || name.length === 0) continue;
      // This service provides no call id, so a positional one is synthesised —
      // it only has to be unique within this turn.
      calls.push({ id: `call_${calls.length}_${name}`, name, arguments: fn["args"] ?? {} });
    }
    if (calls.length > 0) out.toolCalls = calls;
  }

  const usage = res["usageMetadata"];
  if (isRecord(usage)) {
    const input = numberOrUndefined(usage["promptTokenCount"]);
    const output = numberOrUndefined(usage["candidatesTokenCount"]);
    if (input !== undefined || output !== undefined) {
      out.usage = {
        ...(input !== undefined ? { inputTokens: input } : {}),
        ...(output !== undefined ? { outputTokens: output } : {}),
      };
    }
  }

  return out;
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractModel(res: unknown, requested: string): string {
  if (isRecord(res) && typeof res["modelVersion"] === "string") {
    return res["modelVersion"];
  }
  return requested;
}

interface GeminiFetchOptions {
  method: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  apiKey: string | undefined;
  body?: string;
}

async function fetchJson(
  resolved: ResolvedTarget,
  path: string,
  opts: GeminiFetchOptions,
): Promise<Record<string, unknown>> {
  if (opts.apiKey === undefined || opts.apiKey.length === 0) {
    throw new AiError('auth', 'Service key is not set.');
  }

  // This service's protocol carries the key as a query parameter, so it is
  // appended here rather than being logged or stored anywhere else.
  const url = new URL(`${resolved.baseUrl}${path}`);
  url.searchParams.set("key", opts.apiKey);

  const res = await pinnedFetch({
    url: url.toString(),
    method: opts.method,
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    addresses: resolved.addresses,
    allowLocalTargets: resolved.allowLocalTargets,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  }).catch((err: unknown) => {
    if (err instanceof AiError) throw err;
    throw new AiError('network', 'Could not reach the service.');
  });

  if (res.status >= 300 && res.status < 400) {
    throw new AiError('invalid_response', 'The service redirected to another address.');
  }
  if (res.status < 200 || res.status >= 300) {
    throw statusToError(res.status, res.headers, {
      body: res.body,
      secret: opts.apiKey,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new AiError('invalid_response', 'Service response was unreadable.');
  }
  if (!isRecord(parsed)) throw new AiError('invalid_response', 'Service response was empty.');
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
