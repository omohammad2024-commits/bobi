/**
 * Phase 2, item 5: per-model capability profiles.
 *
 * The base layer is the ADAPTER's declared serialization capability;
 * the overrides are model families that are not chat models on any
 * adapter (embeddings, Gemini "aqa", whisper/TTS). Unknown adapters
 * fail closed (all false); unknown models on a known adapter inherit
 * that adapter's base — a declared capability, not a guess.
 */
import { describe, expect, test } from "bun:test";
import {
  modelCapabilities,
  modelSupportsTools,
  type ModelCapabilityProfile,
} from "../src/ai/model_capabilities";

const ALL_FALSE: ModelCapabilityProfile = {
  supportsTools: false,
  supportsStreaming: false,
  supportsVision: false,
  supportsDocuments: false,
  supportsAudio: false,
};

const OPENAI_BASE: ModelCapabilityProfile = {
  supportsTools: true,
  supportsStreaming: true,
  supportsVision: true,
  supportsDocuments: false,
  supportsAudio: false,
};

const GEMINI_BASE: ModelCapabilityProfile = {
  supportsTools: true,
  supportsStreaming: true,
  supportsVision: true,
  supportsDocuments: true,
  supportsAudio: true,
};

const ANTHROPIC_BASE: ModelCapabilityProfile = {
  supportsTools: true,
  supportsStreaming: true,
  supportsVision: true,
  supportsDocuments: true,
  supportsAudio: false,
};

describe("modelCapabilities — adapter base for ordinary chat models", () => {
  test("openai_compatible chat model", () => {
    expect(modelCapabilities("openai_compatible", "gpt-4o-mini")).toEqual(OPENAI_BASE);
  });

  test("nine_router shares the OpenAI-compatible base (same adapter class)", () => {
    expect(modelCapabilities("nine_router", "llama-3.3-70b-versatile")).toEqual(OPENAI_BASE);
  });

  test("gemini chat model supports everything", () => {
    expect(modelCapabilities("gemini", "gemini-2.5-flash")).toEqual(GEMINI_BASE);
  });

  test("anthropic chat model: documents yes, audio no", () => {
    expect(modelCapabilities("anthropic", "claude-sonnet-4-5")).toEqual(ANTHROPIC_BASE);
  });
});

describe("modelCapabilities — defaults", () => {
  test("unknown adapter → all false, even for an ordinary chat model", () => {
    expect(modelCapabilities("some_future_adapter", "gpt-4o-mini")).toEqual(ALL_FALSE);
  });

  test("unknown model id on a known adapter → that adapter's base", () => {
    expect(modelCapabilities("gemini", "some-future-gemini-model-xyz")).toEqual(GEMINI_BASE);
    expect(modelCapabilities("openai_compatible", "some-future-model-xyz")).toEqual(OPENAI_BASE);
  });
});

describe("modelCapabilities — non-chat model overrides (checked before the base)", () => {
  test("embedding model on openai_compatible → all false", () => {
    expect(modelCapabilities("openai_compatible", "text-embedding-3-small")).toEqual(ALL_FALSE);
    expect(modelCapabilities("openai_compatible", "my-embedding-model")).toEqual(ALL_FALSE);
  });

  test("known embedding families without 'embedding' in the id → all false", () => {
    expect(modelCapabilities("openai_compatible", "bge-large-en-v1.5")).toEqual(ALL_FALSE);
    expect(modelCapabilities("openai_compatible", "e5-large-v2")).toEqual(ALL_FALSE);
    expect(modelCapabilities("openai_compatible", "nomic-embed-text-v1")).toEqual(ALL_FALSE);
    // Vendor-prefixed ids are recognised by their final segment.
    expect(modelCapabilities("openai_compatible", "@cf/baai/bge-large-en-v1.5")).toEqual(ALL_FALSE);
  });

  test("Gemini's non-chat 'aqa' on gemini → all false", () => {
    expect(modelCapabilities("gemini", "aqa")).toEqual(ALL_FALSE);
  });

  test("whisper (audio-only) → all false", () => {
    expect(modelCapabilities("openai_compatible", "whisper-1")).toEqual(ALL_FALSE);
  });

  test("TTS (audio-only) → all false", () => {
    expect(modelCapabilities("openai_compatible", "gpt-4o-mini-tts")).toEqual(ALL_FALSE);
    expect(modelCapabilities("openai_compatible", "tts-1")).toEqual(ALL_FALSE);
  });

  test("overrides are case-insensitive", () => {
    expect(modelCapabilities("gemini", "AQA")).toEqual(ALL_FALSE);
    expect(modelCapabilities("openai_compatible", "TEXT-EMBEDDING-3-SMALL")).toEqual(ALL_FALSE);
    expect(modelCapabilities("openai_compatible", "Whisper-1")).toEqual(ALL_FALSE);
  });
});

describe("modelSupportsTools agrees with modelCapabilities", () => {
  test("across adapters, chat models, overrides and unknowns", () => {
    const pairs: Array<[string, string]> = [
      ["openai_compatible", "gpt-4o-mini"],
      ["nine_router", "llama-3.3-70b-versatile"],
      ["gemini", "gemini-2.5-flash"],
      ["anthropic", "claude-sonnet-4-5"],
      ["gemini", "some-future-gemini-model-xyz"],
      ["openai_compatible", "text-embedding-3-small"],
      ["gemini", "aqa"],
      ["openai_compatible", "whisper-1"],
      ["some_future_adapter", "gpt-4o-mini"],
    ];
    for (const [adapter, model] of pairs) {
      expect(modelSupportsTools(adapter, model)).toBe(
        modelCapabilities(adapter, model).supportsTools,
      );
    }
    // Spot-check the two ends of the agreement explicitly.
    expect(modelSupportsTools("gemini", "gemini-2.5-flash")).toBe(true);
    expect(modelSupportsTools("gemini", "aqa")).toBe(false);
  });
});
