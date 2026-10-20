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
import { resolveReasoningEffort, reasoningParamsFor } from "./reasoning";

export interface GeminiTarget extends AdapterTarget {
  settings?: AdapterSettings;
  allowLocalTargets?: boolean;
}

/**
 * A completion as parsed by this adapter.
 *
 * The shared CompletionResponse contract (provider.ts) has NO finish /
 * stop-reason field, and the OpenAI-compatible adapter exposes its
 * `finish_reason` only inside the empty-response error detail — so no
 * shared field is invented here. This adapter-local subtype is the
 * Gemini surface for the same information (mirroring how
 * GeminiStreamAssembler exposes `finishReason` as a getter alongside —
 * not inside — the StreamEvent contract): `finishReason` carries the
 * candidate's wire value verbatim ("STOP", "MAX_TOKENS", "SAFETY", …)
 * when the service sent one, so a MAX_TOKENS finish with partial text
 * returns the text AND names its truncation instead of presenting the
 * partial answer as silently complete. Callers typed against the shared
 * contract simply do not read the extra field.
 */
export interface GeminiCompletionResponse extends CompletionResponse {
  finishReason?: string;
}

/**
 * Strip a single leading `models/` prefix from a model id.
 *
 * Discovery already stores bare ids, but Google's own documentation
 * presents ids as `models/gemini-2.5-flash`, so a hand-typed or legacy
 * stored id can carry the prefix. Used verbatim it doubled up in the
 * request URL (`/models/models%2Fgemini-2.5-flash:generateContent` →
 * 404). Normalizing at every model-addressed URL build lets those
 * stored rows heal themselves; what discovery stores is unchanged.
 */
export function normalizeGeminiModelId(model: string): string {
  return model.replace(/^models\//, "");
}

export class GeminiAdapter implements AIProviderAdapter {
  /** Equals the adapter type; the engine reads this for its fake check. */
  readonly name = "gemini";
  readonly type = "gemini" as const;
  readonly capabilities = {
    listModels: true,
    audioInput: true,
    documentInput: true,
    streaming: true,
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

    const model = normalizeGeminiModelId(req.model);
    const body = buildBody(this.target, req);
    const res = await fetchJson(
      resolved,
      `/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        apiKey: this.target.apiKey,
      },
    );

    return parseResponse(res, model);
  }

  /**
   * Stream a completion via :streamGenerateContent with alt=sse.
   *
   * Same StreamEvent contract as the OpenAI-compatible adapter: text
   * deltas as they arrive, a usage event when the service reports
   * usageMetadata, and exactly one terminal `end`. An empty stream is
   * the empty-response failure, so the gateway fails over.
   */
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const resolved = await resolveTarget(this.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });

    if (this.target.apiKey === undefined || this.target.apiKey.length === 0) {
      throw new AiError("auth", "Service key is not set.");
    }

    const model = normalizeGeminiModelId(req.model);
    const body = buildBody(this.target, req);
    const url = new URL(
      `${resolved.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent`,
    );
    url.searchParams.set("alt", "sse");
    url.searchParams.set("key", this.target.apiKey);

    const stream = await pinnedStream({
      url: url.toString(),
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
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
    const assembler = new GeminiStreamAssembler(model);

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

  async listModels(req: ListModelsRequest): Promise<readonly RemoteModel[]> {
    const resolved = await resolveTarget(req.target, {
      ...(this.target.allowLocalTargets !== undefined
        ? { allowLocalTargets: this.target.allowLocalTargets }
        : {}),
    });

    // ListModels paginates (default page size 50): a single GET silently
    // loses every model past page 1. Follow `nextPageToken` via the
    // `pageToken` query parameter until the service stops handing one
    // out, with two termination guards against a misbehaving endpoint:
    // a hard cap of 10 pages, and a stop when a token repeats (a loop
    // would otherwise re-fetch the same pages until the cap).
    const MAX_PAGES = 10;
    const seenTokens = new Set<string>();
    const seenIds = new Set<string>();
    const out: RemoteModel[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const path =
        pageToken === undefined
          ? "/models"
          : `/models?pageToken=${encodeURIComponent(pageToken)}`;
      const res = await fetchJson(resolved, path, {
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
      for (const entry of models) {
        if (!isRecord(entry) || typeof entry["name"] !== "string") continue;
        // Discovery IS the import — every consumer of listModels treats
        // the result as the provider's usable model list — and this
        // service's ListModels returns EVERY model it hosts: chat models
        // alongside aqa, embedding, imagen, veo and TTS entries that
        // cannot answer a chat completion. Importing them all once landed
        // a provider's default on `aqa`, whose generateContent call 404s.
        // Only models the service says support generateContent belong
        // here. An entry with NO methods field at all is kept: some
        // compatible endpoints omit the metadata, and absence of metadata
        // is not evidence of incapability. The filter applies per page.
        const methods = entry["supportedGenerationMethods"];
        if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
        // "models/gemini-2.5-flash" → "gemini-2.5-flash"
        const id = entry["name"].replace(/^models\//, "");
        // First occurrence wins if an id repeats across pages (a
        // repeating-token page re-lists the same models; discovery is
        // an import, so duplicates would be imported twice).
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const displayName = entry["displayName"];
        out.push({
          id,
          ...(typeof displayName === "string" && displayName.length > 0
            ? { label: displayName }
            : {}),
        });
      }

      const next = res["nextPageToken"];
      if (typeof next !== "string" || next.length === 0) break;
      if (seenTokens.has(next)) break;
      seenTokens.add(next);
      pageToken = next;
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
  // Per-request cap wins over the settings cap (provider.ts contract,
  // mirroring the OpenAI adapter): an invalid per-request value falls
  // through to the settings value rather than dropping the cap entirely.
  const maxTokens =
    typeof req.maxTokens === "number" && Number.isFinite(req.maxTokens) && req.maxTokens > 0
      ? Math.min(Math.trunc(req.maxTokens), 100_000)
      : s?.maxTokens !== undefined && Number.isFinite(s.maxTokens) && s.maxTokens > 0
        ? Math.min(Math.trunc(s.maxTokens), 100_000)
        : undefined;
  if (maxTokens !== undefined) {
    generation["maxOutputTokens"] = maxTokens;
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
): GeminiCompletionResponse {
  const finishReason = finishReasonOf(res);
  const blockReason = blockReasonOf(res);

  let text: string;
  try {
    text = extractText(res);
  } catch (err) {
    // extractText throws only when the payload carries no candidate
    // parts at all. A prompt-level block lands exactly there (Google
    // answers with promptFeedback and NO candidates): name the block
    // instead of surfacing the bare "had no text" label, so the owner
    // can tell "Google blocked the prompt" from a gateway glitch.
    if (blockReason !== undefined) throw promptBlockedError(res, blockReason);
    if (finishReason !== undefined) {
      throw emptyResponseError(emptyPayloadDetail(finishReason, blockReason));
    }
    throw err;
  }

  const extras = responseExtras(res);
  if (text.trim().length === 0 && (extras.toolCalls ?? []).length === 0) {
    // No text and no function call: a candidate failure, not a silent
    // empty success (same rule as the OpenAI-compatible adapter). The
    // detail names the finish/block reason when the service sent one —
    // a SAFETY/RECITATION finish is a different problem (and a
    // different fix) from an unexplained empty answer, mirroring the
    // OpenAI adapter's finish_reason detail.
    if (blockReason !== undefined && finishReason === undefined) {
      throw promptBlockedError(res, blockReason);
    }
    const detail = emptyPayloadDetail(finishReason, blockReason);
    throw emptyResponseError(detail.length > 0 ? detail : undefined);
  }
  return {
    text,
    model: extractModel(res, requestedModel),
    ...extras,
  };
}

/**
 * Machine-safe detail for an empty Gemini payload: the candidate's
 * finish reason and/or the prompt block reason, when the service sent
 * either. Never carries response content.
 */
function emptyPayloadDetail(
  finishReason: string | undefined,
  blockReason: string | undefined,
): string {
  const parts: string[] = [];
  if (finishReason !== undefined) parts.push(`finishReason=${finishReason}`);
  if (blockReason !== undefined) parts.push(`blockReason=${blockReason}`);
  return parts.join(", ");
}

/**
 * The failure for a prompt-level block: Google refused the PROMPT
 * (promptFeedback.blockReason, e.g. SAFETY) and returned no candidates.
 * Built as the empty-response failure — another candidate may answer —
 * with the block named in BOTH the message detail and the provider
 * words, since blockReason (and its optional human-readable message)
 * are the provider's own explanation of the refusal.
 */
function promptBlockedError(res: Record<string, unknown>, blockReason: string): AiError {
  const feedback = res["promptFeedback"];
  const blockMessage =
    isRecord(feedback) &&
    typeof feedback["blockReasonMessage"] === "string" &&
    feedback["blockReasonMessage"].length > 0
      ? feedback["blockReasonMessage"].slice(0, 600)
      : undefined;
  const providerMessage =
    blockMessage ?? `promptFeedback blockReason=${blockReason}`;
  return new AiError(
    "invalid_response",
    `Provider returned an empty response (promptFeedback blockReason=${blockReason})`,
    undefined,
    undefined,
    true,
    undefined,
    providerMessage,
  );
}

/** The first candidate record of a payload, when present and well-formed. */
function firstCandidate(res: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates = res["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const first = candidates[0];
  return isRecord(first) ? first : undefined;
}

/** `candidates[0].finishReason` ("STOP" / "MAX_TOKENS" / "SAFETY" / …). */
function finishReasonOf(res: Record<string, unknown>): string | undefined {
  const fr = firstCandidate(res)?.["finishReason"];
  return typeof fr === "string" && fr.length > 0 ? fr : undefined;
}

/** `promptFeedback.blockReason` ("SAFETY" / "OTHER" / …), when blocked. */
function blockReasonOf(res: Record<string, unknown>): string | undefined {
  const feedback = res["promptFeedback"];
  if (!isRecord(feedback)) return undefined;
  const br = feedback["blockReason"];
  return typeof br === "string" && br.length > 0 ? br : undefined;
}

/**
 * Assembles Gemini SSE events into the neutral StreamEvent contract.
 *
 * Exported for tests, like SseParser/buildBody: completeStream drives
 * one instance per request, feeding each parsed SSE JSON event to
 * push() and yielding whatever it returns, then yields finish() once.
 *
 * Parts with `thought === true` are reasoning, never answer text: they
 * are excluded from the deltas and only feed the empty-stream detail,
 * so a reasoning-only stream is still an empty response. (The buffered
 * parseResponse path does not split thought parts out — it joins every
 * text part — so streamed and buffered text can differ on a payload
 * that carries thought parts.)
 */
export class GeminiStreamAssembler {
  private textAcc = "";
  private readonly calls: ToolCall[] = [];
  private usageValue: TokenUsage | undefined;
  private modelValue: string;
  private hadReasoningFlag = false;
  private finishReasonValue: string | undefined;
  private blockReasonValue: string | undefined;

  constructor(requestedModel: string) {
    this.modelValue = requestedModel;
  }

  get text(): string {
    return this.textAcc;
  }
  get toolCalls(): readonly ToolCall[] {
    return this.calls;
  }
  get usage(): TokenUsage | undefined {
    return this.usageValue;
  }
  get model(): string {
    return this.modelValue;
  }
  get hadReasoning(): boolean {
    return this.hadReasoningFlag;
  }
  get finishReason(): string | undefined {
    return this.finishReasonValue;
  }

  push(event: Record<string, unknown>): StreamEvent[] {
    const out: StreamEvent[] = [];

    if (typeof event["modelVersion"] === "string" && event["modelVersion"].length > 0) {
      this.modelValue = event["modelVersion"];
    }

    const feedback = event["promptFeedback"];
    if (isRecord(feedback) && typeof feedback["blockReason"] === "string") {
      this.blockReasonValue = feedback["blockReason"];
    }

    const candidates = event["candidates"];
    if (Array.isArray(candidates) && candidates.length > 0 && isRecord(candidates[0])) {
      const first = candidates[0];
      if (typeof first["finishReason"] === "string" && first["finishReason"].length > 0) {
        this.finishReasonValue = first["finishReason"];
      }
      const content = first["content"];
      const parts = isRecord(content) ? content["parts"] : undefined;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!isRecord(part)) continue;
          if (part["thought"] === true) {
            this.hadReasoningFlag = true;
            continue;
          }
          if (typeof part["text"] === "string" && part["text"].length > 0) {
            this.textAcc += part["text"];
            out.push({ type: "text", delta: part["text"] });
          }
          const fn = part["functionCall"];
          if (isRecord(fn)) {
            const name = fn["name"];
            if (typeof name === "string" && name.length > 0) {
              // No call id on this wire: positional, exactly like parseResponse.
              this.calls.push({
                id: `call_${this.calls.length}_${name}`,
                name,
                arguments: fn["args"] ?? {},
              });
            }
          }
        }
      }
    }

    const usage = event["usageMetadata"];
    if (isRecord(usage)) {
      const input = numberOrUndefined(usage["promptTokenCount"]);
      const output = numberOrUndefined(usage["candidatesTokenCount"]);
      if (input !== undefined || output !== undefined) {
        this.usageValue = {
          ...(input !== undefined ? { inputTokens: input } : {}),
          ...(output !== undefined ? { outputTokens: output } : {}),
        };
        out.push({ type: "usage", usage: this.usageValue });
      }
    }

    return out;
  }

  /** Terminal `end` event, or the empty-response failure when nothing arrived. */
  finish(): StreamEvent {
    if (this.textAcc.trim().length === 0 && this.calls.length === 0) {
      const parts: string[] = ["stream"];
      if (this.finishReasonValue !== undefined) parts.push(`finishReason=${this.finishReasonValue}`);
      if (this.blockReasonValue !== undefined) parts.push(`blockReason=${this.blockReasonValue}`);
      if (this.hadReasoningFlag) parts.push("the response carried reasoning only");
      throw emptyResponseError(parts.join(", "));
    }
    return {
      type: "end",
      text: this.textAcc,
      model: this.modelValue,
      toolCalls: [...this.calls],
      ...(this.usageValue !== undefined ? { usage: this.usageValue } : {}),
    };
  }
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

/** `functionCall` parts, token usage and the finish reason, when present. */
function responseExtras(res: Record<string, unknown>): {
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  finishReason?: string;
} {
  const out: { toolCalls?: ToolCall[]; usage?: TokenUsage; finishReason?: string } = {};

  // The finish reason rides along here — the extras surface — so a
  // MAX_TOKENS finish with partial text is exposed as truncated (see
  // GeminiCompletionResponse) rather than looking silently complete.
  const finishReason = finishReasonOf(res);
  if (finishReason !== undefined) out.finishReason = finishReason;

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
