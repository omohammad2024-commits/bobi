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
 * Adapters BOBI ships with.
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

/** True when a string is one of the adapters BOBI knows. */
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
  /**
   * A well-known model id for this service, offered as a starting point.
   *
   * A suggestion, never applied automatically: the owner still adds the model
   * explicitly, because a service may have retired this id (which is exactly
   * what happened when Gemini closed `gemini-2.5-flash` to new users).
   */
  suggestedModel?: string;
  /**
   * A placeholder the owner must replace, when the URL is not usable as-is.
   *
   * Cloudflare's endpoint embeds an account id, so the template cannot be
   * complete. Naming the placeholder lets the panel say what to substitute
   * rather than leaving the owner to decode the URL.
   */
  requiredPlaceholder?: string;
}

/**
 * Named OpenAI-compatible services the owner can add in one step.
 *
 * They share the `openai_compatible` adapter — the wire format is the same — so
 * this is purely a convenience list that pre-fills the endpoint. Each entry was
 * checked against the live service where that was possible; the notes say what
 * was actually verified.
 */
export interface ProviderPreset {
  /** Stable slug, used as the provider label seed. */
  id: string;
  label: string;
  baseUrl: string;
  /** A starting model id. A suggestion, never applied automatically. */
  suggestedModel?: string;
  /** Placeholder the owner must replace before the URL works. */
  requiredPlaceholder?: string;
  /** What was actually verified, stated plainly. */
  note: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI",
    // The account id is part of the path, so this URL is a template the owner
    // completes. Nothing contacts it until they save and test.
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1",
    suggestedModel: "@cf/meta/llama-3.1-8b-instruct",
    requiredPlaceholder: "ACCOUNT_ID",
    note: "آدرس شامل شناسهٔ حساب است؛ آن را جایگزین {ACCOUNT_ID} کن. کلید API از پنل Cloudflare.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    note: "آدرس بررسی شد. مدل‌ها با پیشوند vendor/model، مثل anthropic/claude-sonnet-5-5.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    suggestedModel: "deepseek-chat",
    note: "آدرس بررسی شد.",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    note: "آدرس بررسی شد. سرعت بالا، مدل‌های open-weight.",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    note: "آدرس بررسی شد.",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    suggestedModel: "grok-4",
    note: "آدرس بررسی شد.",
  },
  {
    id: "together",
    label: "Together",
    baseUrl: "https://api.together.xyz/v1",
    note: "آدرس بررسی شد. مدل‌ها با پیشوند vendor/model.",
  },
];

/** True when a string names a preset BOBI ships. */
export function isProviderPreset(value: string): boolean {
  return PROVIDER_PRESETS.some((p) => p.id === value);
}

/** Look up a preset by its slug. */
export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
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
