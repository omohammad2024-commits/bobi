/**
 * Stable contract for an AI provider — independent of any vendor SDK.
 * The conversation engine depends only on this interface.
 *
 * Tool calling is part of this contract because every service SOL talks to
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

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Set on an assistant turn that requested tools instead of answering. */
  toolCalls?: readonly ToolCall[];
  /** Set on a "tool" turn: which call this result answers. */
  toolCallId?: string;
  /** Set on a "tool" turn: the tool that produced it. */
  toolName?: string;
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
}
