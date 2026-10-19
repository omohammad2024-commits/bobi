/**
 * Stable contract for an AI provider — independent of any vendor SDK.
 * The conversation engine depends only on this interface.
 *
 * Tool calling is part of this contract because every service BOBI talks to
 * expresses it differently on the wire: OpenAI-compatible endpoints nest a
 * JSON *string* under `tool_calls`, Anthropic emits typed content blocks, and
 * Gemini uses `functionCall` parts. Keeping one neutral shape here means the
 * engine never learns a vendor's vocabulary.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One tool the model is allowed to request, in a vendor-neutral shape. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/** A tool invocation the model asked for. */
export interface ToolCall {
  /**
   * Provider-assigned id used to match a result to its request.
   *
   * Anthropic and OpenAI supply one. Gemini does not, so adapters synthesise a
   * stable id from the call's position — the loop only needs it to be unique
   * within a single turn.
   */
  id: string;
  name: string;
  /** Parsed arguments. A provider that sends malformed JSON yields `{}`. */
  arguments: unknown;
}

/**
 * One piece of a message that is not plain text.
 *
 * Deliberately additive: `ChatMessage.content` stays a string, so every existing
 * path — history storage, the transcript, tool results — keeps working
 * unchanged. Attachments ride alongside as `parts`, which is what makes a photo
 * or a voice note expressible without rewriting the conversation model.
 *
 * Binary data is carried as base64 rather than a Buffer because this shape has
 * to survive being JSON-serialised between the bot and an adapter; a Buffer
 * would silently become an object with numeric keys.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; base64: string }
  /** Raw audio, for a provider that transcribes or reasons over it directly. */
  | { type: "audio"; mediaType: string; base64: string }
  | { type: "document"; mediaType: string; base64: string; name?: string };

export interface ChatMessage {
  role: ChatRole;
  /**
   * The message's text.
   *
   * Always present, possibly empty when the turn is only an attachment — a
   * caption-less photo is a real case, and a union type would force every
   * consumer to narrow before reading it.
   */
  content: string;
  /**
   * Non-text attachments, in order.
   *
   * Absent means "text only". When present, `content` still holds the text, so a
   * consumer that cannot handle attachments still sees the words.
   */
  parts?: readonly ContentPart[];
  /** Set on an assistant turn that requested tools instead of answering. */
  toolCalls?: readonly ToolCall[];
  /** Set on a "tool" turn: which call this result answers. */
  toolCallId?: string;
  /** Set on a "tool" turn: the tool that produced it. */
  toolName?: string;
}

/**
 * The parts of a message, as an explicit list.
 *
 * A text-only message yields one text part, so an adapter can iterate
 * uniformly instead of special-casing the common shape.
 */
export function partsOf(message: ChatMessage): ContentPart[] {
  if (message.parts !== undefined && message.parts.length > 0) {
    // Keep the text alongside any attachments; a caption is part of the turn.
    return message.content.length > 0
      ? [{ type: "text", text: message.content }, ...message.parts]
      : [...message.parts];
  }
  return message.content.length > 0 ? [{ type: "text", text: message.content }] : [];
}

/** True when a message carries anything beyond text. */
export function hasAttachments(message: ChatMessage): boolean {
  return message.parts !== undefined && message.parts.length > 0;
}

/**
 * Ceiling on one attachment, in bytes of decoded data.
 *
 * Providers cap uploads themselves, but at different sizes and with unhelpful
 * errors. Checking here means an over-large attachment is refused with a clear
 * message instead of a provider failure partway through a run.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Attachment types BOBI will carry, mapped from a MIME type. */
export function partTypeForMediaType(mediaType: string): ContentPart["type"] | undefined {
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "document";
  return undefined;
}

/** Estimated decoded size of a base64 payload, without decoding it. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Token counts a provider reported, when it reports any. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CompletionRequest {
  /** Prior turns + the new user message (last item is the latest user turn). */
  messages: ChatMessage[];
  /** Selected model id (from config). */
  model: string;
  /** Hard timeout for this request, ms. */
  timeoutMs: number;
  /** Cancellation signal. */
  signal: AbortSignal;
  /**
   * Tools the model may request this turn.
   *
   * Absent or empty means "answer from what you already have" — the loop uses
   * that for its final, tool-free call, so a model that kept requesting tools
   * is forced to produce an answer rather than leaving the user waiting.
   */
  tools?: readonly ToolSpec[];
}

export interface CompletionResponse {
  /** Assistant reply text, already extracted from the provider payload. */
  text: string;
  /** Provider-reported model id (may differ from requested). */
  model: string;
  /**
   * Tools the model asked to run. Present only when it chose not to answer.
   * When this is set, `text` is usually empty — that is valid, not an error.
   */
  toolCalls?: readonly ToolCall[];
  /** Token counts, when the service reports them. */
  usage?: TokenUsage;
}

/**
 * One event from a streaming completion.
 *
 * A stream emits zero or more `text` deltas (concatenating them yields the
 * reply text), optionally a `usage` event when the service reports token
 * counts mid-stream, and exactly one terminal `end` event carrying the
 * authoritative full text plus any tool calls. `end.text` equals the
 * concatenation of the `text` deltas; `end.toolCalls` is non-empty exactly
 * when the model requested tools instead of answering.
 *
 * A stream that throws BEFORE its first `text` event is equivalent to
 * complete() failing: the caller may retry it as a single shot with no
 * visible effect. A stream that throws AFTER a `text` event has already
 * shown partial text to the user, so the caller must handle a partial
 * stream (fall back to a fresh single-shot answer, or surface the error)
 * rather than silently retrying.
 */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "usage"; usage: TokenUsage }
  | {
      type: "end";
      /** Full reply text: the concatenation of every `text` delta. */
      text: string;
      /** Provider-reported model id (may differ from requested). */
      model: string;
      /** Tools the model asked to run instead of answering (may be empty). */
      toolCalls: readonly ToolCall[];
      /** Token counts, when the service reported them. */
      usage?: TokenUsage;
    };

/** Categorized, internal error — never carries secrets. */
export class AiError extends Error {
  constructor(
    readonly kind: "auth" | "quota" | "network" | "invalid_response" | "timeout" | "aborted" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface AiProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /**
   * Stream a completion as text deltas, when the service supports it.
   *
   * Optional: a provider that does not declare it is completed in one shot
   * via complete(). The stream ends with exactly one `end` event (see
   * StreamEvent); a stream that errors before its first `text` event may be
   * retried as a single shot, while a later error means partial text was
   * already shown and must be handled as a partial stream.
   */
  completeStream?(req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined>;
  /**
   * Whether this provider accepts raw audio ContentParts natively, with no
   * transcription needed.
   *
   * Optional: a provider that does not declare it is read as "no native
   * audio". The bot layer asks this before deciding whether a voice message
   * must be transcribed first (Phase B2).
   */
  supportsAudioInput?(): boolean;
  /**
   * Whether this provider accepts document ContentParts natively, with no
   * local extraction needed.
   *
   * Optional: undeclared reads as "no native documents". The bot layer asks
   * this before running local .docx/.xlsx/.pdf extraction (Phase B5).
   */
  supportsDocumentInput?(): boolean;
}
