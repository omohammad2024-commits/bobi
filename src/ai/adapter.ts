/**
 * AI adapter contract — the shared vocabulary for talking to any AI service.
 *
 * An adapter is the ONLY place that knows a vendor's wire format. Everything
 * above it (the gateway, the engine, the panel) speaks this interface, so
 * adding a service never touches conversation logic.
 *
 * Design rules:
 * - Input is untrusted; the adapter must not assume well-formed settings.
 * - Every failure is mapped onto AiError's categories. Raw provider text, a
 *   status page, or a response body never escapes this layer, because those can
 *   echo a request (and therefore a key).
 * - `capabilities` is declared, not assumed: an adapter says whether it can
 *   list models, so the panel offers "discover models" only when it is real.
 */
import type { AiProvider, CompletionRequest, CompletionResponse } from "./provider";

/** Optional per-provider extras. Absent means "not supported". */
export interface AdapterCapabilities {
  /** The service exposes a model-listing endpoint this adapter can call. */
  listModels?: boolean;
  /** A short note about what this adapter supports, for the panel. */
  notes?: string;
}

/** A validated connection target. Untrusted input is rejected upstream. */
export interface AdapterTarget {
  /** Service base URL, already validated (scheme, host, no userinfo). */
  baseUrl: string;
  /** Decrypted API key. Held in memory only for the duration of a call. */
  apiKey: string | undefined;
}

/** One entry from a provider's model list. */
export interface RemoteModel {
  /** Model id as the service expects it. */
  id: string;
  /** Human label when the service provides one. */
  label?: string;
}

/** Settings an adapter chooses to honor. Unknown keys are ignored. */
export interface AdapterSettings {
  /** Max tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** System prompt prepended to the conversation. */
  systemPrompt?: string;
}

/**
 * The contract every adapter implements.
 *
 * `name` comes from AiProvider and doubles as the adapter type slug, so the
 * engine's existing `isFake` check keeps working unchanged. `label` is the
 * Persian display name used only by the admin panel.
 */
export interface AIProviderAdapter extends AiProvider {
  /** Adapter type slug, e.g. "openai_compatible". Equals `name`. */
  readonly type: AdapterType;
  /** What this adapter can do. Declared, never guessed at. */
  readonly capabilities: AdapterCapabilities;
  /** Persian label for the admin panel. */
  readonly label: string;

  /** Send a completion request. Throws only AiError. */
  complete(req: CompletionRequest): Promise<CompletionResponse>;

  /**
   * List models offered by the service, when {@link capabilities.listModels}.
   * Throws AiError with a user-safe message on failure.
   */
  listModels?(req: ListModelsRequest): Promise<readonly RemoteModel[]>;
}

export interface ListModelsRequest {
  target: AdapterTarget;
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * Adapters SOL ships with.
 *
 * These are CONNECTION TEMPLATES, not claims of a tested live endpoint: each
 * entry says how the request is shaped, and only the adapters actually
 * verified against a service are described as such in the panel and docs.
 */
export const ADAPTER_TYPES = [
  "openai_compatible",
  "gemini",
  "anthropic",
  "nine_router",
] as const;

export type AdapterType = (typeof ADAPTER_TYPES)[number];

/** True when a string is one of the adapters SOL knows. */
export function isAdapterType(value: string): value is AdapterType {
  return (ADAPTER_TYPES as readonly string[]).includes(value);
}

/**
 * Templates offered when the owner adds a provider.
 *
 * Each entry pre-fills the fields the service needs. `baseUrl` is a starting
 * point the owner can edit; nothing is called until they save and test it.
 */
export interface AdapterTemplate {
  type: AdapterType;
  label: string;
  /** Suggested base URL; editable and never contacted implicitly. */
  suggestedBaseUrl: string;
  /** True when the URL is pre-filled and should be the default. */
  prefilled: boolean;
  capabilities: AdapterCapabilities;
}

export const ADAPTER_TEMPLATES: readonly AdapterTemplate[] = [
  {
    type: "openai_compatible",
    label: "سفارشی / سازگار با OpenAI",
    suggestedBaseUrl: "https://api.openai.com/v1",
    prefilled: false,
    capabilities: { listModels: true, notes: "POST {baseUrl}/chat/completions" },
  },
  {
    type: "nine_router",
    label: "9Router",
    suggestedBaseUrl: "",
    prefilled: false,
    capabilities: { notes: "نیازمند آدرس و مدل تعیین‌شده توسط مدیر" },
  },
  {
    type: "gemini",
    label: "Google Gemini",
    suggestedBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    prefilled: false,
    capabilities: { listModels: true, notes: "generateContent" },
  },
  {
    type: "anthropic",
    label: "Anthropic",
    suggestedBaseUrl: "https://api.anthropic.com/v1",
    prefilled: false,
    capabilities: { notes: "messages" },
  },
] as const;
