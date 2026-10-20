/**
 * Per-model capability profiles — what a specific (adapter, model) pair
 * can actually do, as opposed to what the adapter can do in general.
 *
 * WHY this exists: the adapter-level descriptions (AdapterRegistry
 * .describes() / AdapterCapabilities) say what an adapter SERIALIZES —
 * e.g. the OpenAI-compatible adapter can send tool calls, stream, and
 * carry images. But a provider's model list is not all chat models:
 * discovery happily imports embedding models, Gemini's non-chat "aqa",
 * Whisper transcription models, TTS models, and so on. Those models sit
 * behind a fully tool-capable adapter yet cannot answer a chat turn at
 * all, let alone call tools. Routing / gating decisions that only look
 * at the adapter therefore treated them as full chat candidates.
 *
 * This module layers the two facts:
 *   1. BASE — the adapter's declared serialization capabilities.
 *   2. MODEL OVERRIDES — a small, defensible list of model families
 *      that are not chat models on ANY adapter. Checked first.
 *
 * Default rules (honest, fail-closed where it matters):
 * - Unknown MODEL on a known adapter → the adapter base. That is not a
 *   guess about the model: it is the adapter's own declared capability,
 *   and ordinary chat models are the normal case behind these adapters.
 * - Unknown ADAPTER → ALL FALSE. An adapter BOBI does not ship has no
 *   declared capabilities to inherit, so nothing may be assumed —
 *   least of all tool support.
 *
 * Pure data + lookup on purpose: no storage imports, no registry
 * construction, so any layer (router today, Phase 3 routing later) can
 * consume it without cycles or side effects.
 */

/** What one (adapter, model) pair can do. */
export interface ModelCapabilityProfile {
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsDocuments: boolean;
  supportsAudio: boolean;
}

/** The fail-closed profile: a model/adapter we know nothing usable about. */
const ALL_FALSE: ModelCapabilityProfile = {
  supportsTools: false,
  supportsStreaming: false,
  supportsVision: false,
  supportsDocuments: false,
  supportsAudio: false,
};

/**
 * Base layer: what each shipped adapter serializes, mirroring
 * AdapterRegistry.describes() and the adapters' `capabilities`.
 *
 * - openai_compatible / nine_router (the same adapter class): chat
 *   completions with tool calls and SSE streaming; image parts are
 *   serialized, document/audio parts are not (documents are extracted
 *   locally, audio is transcribed first — see describes()).
 * - gemini: generateContent takes tools, streaming, images, documents
 *   and audio natively — every field true.
 * - anthropic: messages with tools, streaming, images and documents;
 *   no native audio input.
 *
 * Embeddings are deliberately NOT a profile field: an embedding model
 * is not a chat model at all (see the overrides), and chat routing
 * never asks "can this chat candidate embed?".
 */
const ADAPTER_BASE: Readonly<Record<string, ModelCapabilityProfile>> = {
  openai_compatible: {
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsDocuments: false,
    supportsAudio: false,
  },
  nine_router: {
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsDocuments: false,
    supportsAudio: false,
  },
  gemini: {
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsDocuments: true,
    supportsAudio: true,
  },
  anthropic: {
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsDocuments: true,
    supportsAudio: false,
  },
};

/**
 * True when a model id names a NON-CHAT model — one that cannot answer
 * a chat turn on any adapter, however capable the adapter is.
 *
 * The table stays small and each entry is a family that is non-chat by
 * construction, never a guess about an ordinary chat model:
 *
 * - Embedding models: their endpoint returns vectors, not text. Caught
 *   by the "embedding" substring (covers "text-embedding-*" too) and by
 *   the well-known open embedding families served without the word in
 *   their id: BGE ("bge-"), E5 ("e5-"), Nomic Embed ("nomic-embed").
 *   Those family prefixes are matched on the id's final segment, so a
 *   vendor-prefixed id ("@cf/baai/bge-large-…", "openai/bge-…") is
 *   still recognised.
 * - Gemini's "aqa": an attributable-QA model id that discovery imports
 *   alongside the chat models; it is not a generateContent chat model.
 *   Matched exactly (final segment), not as a substring, so a future
 *   chat id merely containing those letters is not swept up.
 * - Audio-only models: Whisper ("whisper") transcribes speech and
 *   returns no chat reply; TTS models ("-tts" / "tts-") synthesize
 *   speech. Neither can hold a conversation or call tools.
 */
function isNonChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // Final segment: vendor prefixes ("vendor/model", "models/model",
  // "@cf/baai/model") must not hide the family/name that matters.
  const base = id.split("/").pop() ?? id;

  if (id.includes("embedding")) return true;
  if (
    base.startsWith("bge-") ||
    base.startsWith("e5-") ||
    base.startsWith("nomic-embed")
  ) {
    return true;
  }
  if (base === "aqa") return true;
  if (id.includes("whisper")) return true;
  if (id.includes("-tts") || id.includes("tts-")) return true;
  return false;
}

/**
 * The capability profile for one (adapterType, modelId) pair.
 *
 * Model overrides are checked BEFORE the adapter base: a non-chat model
 * is non-chat even behind the most capable adapter. Adapter lookup is
 * case-insensitive like the model checks — adapter types are stored
 * owner-facing strings, and a casing slip must not flip the profile.
 * Returns a fresh object on every call, so callers may not mutate the
 * shared tables through the result.
 */
export function modelCapabilities(
  adapterType: string,
  modelId: string,
): ModelCapabilityProfile {
  if (isNonChatModel(modelId)) return { ...ALL_FALSE };
  const base = ADAPTER_BASE[adapterType.toLowerCase()];
  if (base === undefined) return { ...ALL_FALSE };
  return { ...base };
}

/** Convenience for the common gate: can this pair be sent tool specs? */
export function modelSupportsTools(adapterType: string, modelId: string): boolean {
  return modelCapabilities(adapterType, modelId).supportsTools;
}
