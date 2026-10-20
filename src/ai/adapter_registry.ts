/**
 * Adapter registry — maps a stored provider to a live adapter instance.
 *
 * The registry is the single place that knows which class implements which
 * adapter type, so adding an adapter never requires touching the gateway, the
 * engine, or the panel. A provider whose type has no adapter is refused rather
 * than silently downgraded.
 */
import type { AIProviderAdapter, AdapterType, AdapterSettings } from "./adapter";
import { isAdapterType } from "./adapter";
import { AiError } from "./provider";
import { OpenAICompatibleAdapter, type OpenAITarget } from "./openai_compatible";
import { GeminiAdapter, type GeminiTarget } from "./gemini";
import { AnthropicAdapter, type AnthropicTarget } from "./anthropic";

/** The config needed to build any adapter. */
export interface AdapterConfig {
  baseUrl: string;
  /** Decrypted key, held only for the lifetime of the adapter. */
  apiKey: string | undefined;
  /** Default model id for the adapter's requests. */
  model: string;
  settings?: {
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
  };
  /**
   * Per-provider owner exception allowing a loopback/private base URL.
   * Off unless the owner set it for THIS provider.
   */
  allowLocalTargets?: boolean;
}

export class AdapterRegistry {
  /** Build the adapter for a provider type, or throw for an unknown type. */
  create(type: string, cfg: AdapterConfig): AIProviderAdapter {
    if (!isAdapterType(type)) {
      // AiError (not a plain Error): the gateway's error mapper turns a bare
      // Error into the generic "unknown" path, losing the real reason. The
      // precise-error treatment names the misconfiguration instead.
      throw new AiError("invalid_response", `unknown adapter type: ${type}`);
    }

    switch (type as AdapterType) {
      case "openai_compatible":
        return new OpenAICompatibleAdapter(toOpenAI(cfg));
      // 9Router deployments that answer the OpenAI chat-completions shape use
      // the same adapter; the owner selects this for their endpoint.
      case "nine_router":
        return new OpenAICompatibleAdapter(toOpenAI(cfg));
      case "gemini":
        return new GeminiAdapter(toGemini(cfg));
      case "anthropic":
        return new AnthropicAdapter(toAnthropic(cfg));
    }
  }

  /** What an adapter type can do, without constructing one. */
  describes(type: string): {
    label: string;
    notes?: string;
    listModels: boolean;
    /**
     * The adapter serialises audio ContentParts natively (Phase B2): no
     * transcription is needed for voice messages. Mirrors the per-adapter
     * `capabilities.audioInput` without constructing an instance (which would
     * need a decrypted credential).
     */
    audioInput: boolean;
    /**
     * The adapter serialises document ContentParts natively (Phase B5): no
     * local extraction is needed. Mirrors `capabilities.documentInput`.
     */
    documentInput: boolean;
    /**
     * The adapter produces text embeddings (Phase 4, semantic memory).
     * Mirrors `capabilities.embeddings` without constructing an instance.
     */
    embeddings: boolean;
  } {
    switch (type) {
      case "openai_compatible":
      case "nine_router":
        return {
          label: type === "nine_router" ? "9Router" : "Custom / OpenAI-compatible",
          notes: "POST {baseUrl}/chat/completions",
          listModels: type === "openai_compatible",
          audioInput: false,
          documentInput: false,
          embeddings: true,
        };
      case "gemini":
        return {
          label: "Google Gemini",
          notes: "generateContent",
          listModels: true,
          audioInput: true,
          documentInput: true,
          embeddings: false,
        };
      case "anthropic":
        return {
          label: "Anthropic",
          notes: "messages",
          listModels: false,
          audioInput: false,
          documentInput: true,
          embeddings: false,
        };
      default:
        return { label: type, listModels: false, audioInput: false, documentInput: false, embeddings: false };
    }
  }
}

/** Shared shape for every target: omit optionals rather than pass undefined. */
function toCommon(cfg: AdapterConfig): {
  baseUrl: string;
  apiKey: string | undefined;
  settings?: AdapterSettings;
  allowLocalTargets?: boolean;
} {
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    ...(cfg.settings !== undefined ? { settings: cfg.settings } : {}),
    ...(cfg.allowLocalTargets !== undefined ? { allowLocalTargets: cfg.allowLocalTargets } : {}),
  };
}

function toOpenAI(cfg: AdapterConfig): OpenAITarget {
  return toCommon(cfg) as OpenAITarget;
}

function toGemini(cfg: AdapterConfig): GeminiTarget {
  return toCommon(cfg) as GeminiTarget;
}

function toAnthropic(cfg: AdapterConfig): AnthropicTarget {
  return toCommon(cfg) as AnthropicTarget;
}
