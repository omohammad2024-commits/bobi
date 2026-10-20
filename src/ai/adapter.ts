/**
 * AI adapter contract — the shared vocabulary for talking to any AI service.
 *
 * An adapter is the ONLY place that knows a vendor's wire format. Everything
 * above it (the gateway, the engine, the panel) speaks this interface, so
 * adding a service never touches conversation logic.
 *
 * Design rules:
 * - Input is untrusted; the adapter must not assume well-formed settings.
 * - Every failure is mapped onto AiError's categories. A raw response body
 *   never escapes this layer, because it can echo a request (and therefore
 *   a key). The one sanctioned exception is `AiError.providerMessage`: the
 *   provider's own error words, extracted by the status mapper in
 *   http_status.ts only after sanitizing, credential redaction and a hard
 *   length cap — the sanitized quote may ride the error, the body itself
 *   may not.
 * - `capabilities` is declared, not assumed: an adapter says whether it can
 *   list models, so the panel offers "discover models" only when it is real.
 */
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from "./provider";

/** Optional per-provider extras. Absent means "not supported". */
export interface AdapterCapabilities {
  /** The service exposes a model-listing endpoint this adapter can call. */
  listModels?: boolean;
  /** The adapter serialises audio ContentParts natively (no transcription needed). */
  audioInput?: boolean;
  /** The adapter serialises document ContentParts natively (no local extraction needed). */
  documentInput?: boolean;
  /**
   * The adapter can produce text embeddings (Phase 4, semantic memory).
   * Declared, never assumed: only an adapter that implements embed() sets it.
   */
  embeddings?: boolean;
  /**
   * The adapter can stream completions (SSE text deltas) via completeStream().
   * Declared, never assumed: only an adapter that implements completeStream()
   * sets it. Adapters without it are served a synthesised stream by the
   * gateway (one text event + the end event), so callers can stream uniformly.
   */
  streaming?: boolean;
  /** A short note about what this adapter supports, for the panel. */
  notes?: string;
}

/** One embeddings request: a batch of texts to vectorise. */
export interface EmbedRequest {
  /** Texts to embed, in order. The caller keeps batches small. */
  texts: string[];
  /** Embedding model id, as the service expects it. */
  model: string;
  /** Hard timeout for this request, ms. */
  timeoutMs: number;
  /** Cancellation signal. */
  signal: AbortSignal;
}

/** One embeddings response: one vector per input text, in order. */
export interface EmbedResponse {
  /** Unit-length is NOT guaranteed; the caller normalises before comparing. */
  embeddings: number[][];
  /** Provider-reported model id (may differ from requested). */
  model: string;
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
   * Stream a completion as text deltas, when {@link capabilities.streaming}.
   * Throws only AiError. Follows the StreamEvent contract in provider.ts:
   * zero or more `text` events, then exactly one `end` event.
   */
  completeStream?(req: CompletionRequest): AsyncGenerator<StreamEvent, void, undefined>;

  /**
   * List models offered by the service, when {@link capabilities.listModels}.
   * Throws AiError with a user-safe message on failure.
   */
  listModels?(req: ListModelsRequest): Promise<readonly RemoteModel[]>;

  /**
   * Produce embeddings for the given texts, when {@link capabilities.embeddings}.
   *
   * Phase 4 (semantic memory): long-term memories are vectorised with the
   * owner's configured provider so recall can rank by meaning, not just by
   * keyword. Declared optional so adapters without an embeddings endpoint
   * (Gemini, Anthropic) simply do not offer it and the memory layer falls
   * back to text search — no error, no user-visible change.
   *
   * SECURITY: the input texts are memory content, i.e. owner data. Calling
   * this sends that data to the provider's service. The memory layer only
   * calls it for the owner-selected provider, and docs/PHASE4_MEMORY.md
   * carries the privacy note for the owner.
   */
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
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
    note: "The address contains an account ID; replace {ACCOUNT_ID}. API key from the Cloudflare dashboard.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    // Taken from OpenRouter's own live model list, which is public.
    suggestedModel: "anthropic/claude-haiku-5.5",
    note: "Address and model list verified. Models are picked with a vendor/model prefix.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    suggestedModel: "deepseek-chat",
    note: "Address verified (not readable without a key).",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    suggestedModel: "llama-3.3-70b-versatile",
    note: "Address verified. Fast, open-weight models.",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    suggestedModel: "mistral-large-latest",
    note: "Address verified.",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    suggestedModel: "grok-4",
    note: "Address verified.",
  },
  {
    id: "together",
    label: "Together",
    baseUrl: "https://api.together.xyz/v1",
    suggestedModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    note: "Address verified. Models with a vendor/model prefix.",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot AI)",
    baseUrl: "https://api.moonshot.ai/v1",
    suggestedModel: "kimi-k2.5",
    note: "OpenAI-compatible wire. Address from Moonshot's published API docs.",
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    suggestedModel: "nemotron-3-lightning-free",
    // OpenAI-compatible. Free key from opencode.ai/auth (email only, no card).
    // Free models: nemotron-3-ultra-free, nemotron-3-lightning-free, mimo-free,
    // ling-flash-free, big-pickle, muse-spark-free. Note: the free tier may
    // reject requests from outside the OpenCode client (403 FreeTierError) —
    // a paid key removes that restriction.
    note: "OpenAI-compatible. Free key from opencode.ai/auth (email only, no card). Free models: nemotron-3-ultra-free, nemotron-3-lightning-free, mimo-free, ling-flash-free, big-pickle, muse-spark-free. Note: the free tier may return 403 from outside the OpenCode client; a paid key removes that restriction.",
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
    label: "Custom / OpenAI-compatible",
    suggestedBaseUrl: "https://api.openai.com/v1",
    prefilled: false,
    capabilities: {
      listModels: true,
      streaming: true,
      notes: "POST {baseUrl}/chat/completions (streaming via SSE)",
    },
  },
  {
    type: "nine_router",
    label: "9Router",
    suggestedBaseUrl: "",
    prefilled: false,
    capabilities: {
      // Display metadata only: discovery is gated by the registry's
      // describes(), but the template must not understate it — nine_router
      // IS the OpenAI-compatible adapter, listModels included.
      listModels: true,
      notes: "Requires an address and model set by the admin",
    },
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
    // listModels: display metadata only (discovery is gated by the
    // registry's describes()); the adapter does serve GET /v1/models.
    capabilities: { listModels: true, notes: "messages" },
  },
] as const;
