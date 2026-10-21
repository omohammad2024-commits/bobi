/**
 * Voice tools — transcribe_audio + text_to_speech (platform Phase 9).
 *
 * Two callable wrappers over the existing voice pipelines:
 * - `transcribe_audio` reads an audio file the owner already saved in the
 *   files sandbox and returns its transcript via src/ai/transcribe.ts.
 * - `text_to_speech` synthesises speech via src/ai/tts.ts and delivers the
 *   audio to the user as an attachment (extractMedia), never as data.
 *
 * DEPENDENCY RULE: the pipelines are INJECTED through the factories' deps
 * (bootstrap passes `transcribeAudio` / `synthesizeSpeech` at the
 * composition root). The tools layer may not runtime-import the ai layer —
 * the dependency audit (tests/tool_plugin_architecture.test.ts) allowlists
 * only provider/dns_guard/pinned_transport — so this module imports the
 * pipelines' TYPES only, and the two numeric caps are mirrored below with
 * tests pinning the mirrors against the source constants.
 *
 * Both tools are owner-only twice over (the files.ts pattern): the
 * `ownerOnly` flag keeps the authorization bridge from granting the
 * permission key to a non-owner, and run() re-checks the server-supplied
 * `isOwner` predicate as defence in depth.
 *
 * Error hygiene: provider failures (AiError or anything else the pipeline
 * throws) collapse to one fixed internal message per tool. Provider text is
 * NEVER echoed — a transcription/speech service that reflects request data
 * must not be able to leak it (or a key) into a user-visible message. An
 * unconfigured pipeline (no options handed to the factory) is an honest
 * `disabled` error, matching the image_gen convention.
 *
 * Sandbox discipline for the audio path mirrors files.ts (its helpers are
 * module-private, so the same checks are implemented here): absolute paths
 * and `..` escapes refused lexically before any I/O, symlinks refused via a
 * realpath check, and no error message ever echoes a path.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ContentPart } from "../ai/provider";
import type { TranscribeOptions } from "../ai/transcribe";
import type { SpeechResult, TtsOptions } from "../ai/tts";
import { ToolError } from "./errors";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import { ensureSandboxRoot, resolveSandboxPath } from "./sandbox";
import type { Tool, ToolContext } from "./types";

export const TRANSCRIBE_AUDIO_PERMISSION = "tools:transcribe_audio";
export const TEXT_TO_SPEECH_PERMISSION = "tools:text_to_speech";

/**
 * Mirror of MAX_TRANSCRIBE_AUDIO_BYTES in src/ai/transcribe.ts (25 MB).
 * Mirrored, not imported, per the dependency rule in the header; the value
 * is pinned by tests/tools_voice.test.ts against the source constant.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Mirror of MAX_TTS_CHARS in src/ai/tts.ts (4,000). Same mirroring
 * rationale as MAX_AUDIO_BYTES above; pinned by the same test file.
 */
const MAX_TEXT_CHARS = 4_000;

/** The transcription pipeline's call shape (typeof transcribeAudio). */
export type TranscribeFn = (
  options: TranscribeOptions,
  audio: Buffer,
  mediaType: string,
  signal: AbortSignal,
) => Promise<string>;

/** The speech pipeline's call shape (typeof synthesizeSpeech). */
export type SynthesizeFn = (
  options: TtsOptions,
  text: string,
  signal: AbortSignal,
) => Promise<SpeechResult>;

// ---------------------------------------------------------------------------
// transcribe_audio
// ---------------------------------------------------------------------------

export interface TranscribeInput {
  /** Path of the audio file inside the files area, e.g. "voice/note.ogg". */
  path: string;
}

export interface TranscribeOutput {
  /** The transcript text. May be empty (silence) — returned honestly. */
  text: string;
  chars: number;
}

export interface TranscribeToolDeps {
  /** Root of the files sandbox. Created lazily on first use. */
  rootDir: string;
  /** Server-supplied owner predicate; re-checked in run() (defence in depth). */
  isOwner: (userId: string) => boolean;
  /**
   * Transcription endpoint config. Absent = the owner never configured a
   * transcription service, so every run answers `disabled` honestly.
   */
  options?: TranscribeOptions;
  /**
   * The transcription pipeline, injected by the composition root
   * (bootstrap passes src/ai/transcribe's `transcribeAudio`). Required —
   * see the dependency rule in the module header.
   */
  transcribe: TranscribeFn;
}

/** Audio extensions the tool accepts, mapped to the media type sent upstream. */
const AUDIO_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
};

/** Plugin discovery manifest for `transcribe_audio`. */
export const transcribeAudioManifest: ToolManifest = defineManifest({
  id: "transcribe_audio",
  version: "1.0.0",
  title: "Transcribe Audio",
  description:
    "Transcribe an audio file (.ogg, .mp3, .wav, .m4a, .webm) saved in the owner's files area into text, using the configured transcription service. Owner only.",
  purpose: "voice/audio file to text",
  useWhen: "audio file already saved",
  doNotUseWhen:
    "the user wants speech generated from text — that is text_to_speech; the content is a document — extract_document",
  confusableWith: [
    {
      tool: "text_to_speech",
      difference:
        "transcribe_audio turns a voice file into text; text_to_speech turns text into a voice message",
    },
    {
      tool: "extract_document",
      difference: "extract_document reads documents; this transcribes audio",
    },
  ],
  latencyTier: "seconds",
  outputSummary: "The transcript text and its character count.",
  category: "media",
  costTier: "cheap",
});

export function createTranscribeTool(
  deps: TranscribeToolDeps,
): Tool<TranscribeInput, TranscribeOutput> {
  return {
    name: "transcribe_audio",
    manifest: transcribeAudioManifest,
    description:
      "Transcribe an audio file saved in the files area (.ogg, .mp3, .wav, .m4a, .webm) into text. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [TRANSCRIBE_AUDIO_PERMISSION] },
    toolset: "media",
    input: {
      fields: {
        path: {
          type: "string",
          required: true,
          description:
            "Path of the audio file inside the files area, e.g. 'voice/note.ogg'. Supported: .ogg, .mp3, .wav, .m4a, .webm.",
          maxLength: 1024,
        },
      },
    },

    async run(input: TranscribeInput, ctx: ToolContext): Promise<TranscribeOutput> {
      assertVoiceOwner(ctx, deps.isOwner, "Voice transcription is owner only.");
      const options = deps.options;
      if (options === undefined) {
        throw new ToolError("disabled", "Voice transcription is not configured.");
      }
      const raw = typeof input.path === "string" ? input.path.trim() : "";
      if (raw.length === 0) {
        throw new ToolError("invalid_input", "A file path is required.");
      }
      const mediaType = AUDIO_MEDIA_TYPES[extname(raw).toLowerCase()];
      if (mediaType === undefined) {
        throw new ToolError(
          "invalid_input",
          "Only .ogg, .mp3, .wav, .m4a and .webm audio files can be transcribed.",
        );
      }
      const root = await ensureSandboxRoot(deps.rootDir);
      const target = await resolveSandboxPath(root, raw, {
        mustExist: true,
        notFoundMessage: "That file doesn't exist.",
      });
      const st = await stat(target).catch(() => undefined);
      if (st === undefined) throw new ToolError("not_found", "That file doesn't exist.");
      if (st.isDirectory()) {
        throw new ToolError("invalid_input", "That path is a folder, not an audio file.");
      }
      if (st.size === 0) {
        throw new ToolError("invalid_input", "That audio file is empty.");
      }
      if (st.size > MAX_AUDIO_BYTES) {
        throw new ToolError(
          "invalid_input",
          `That audio file is larger than the ${MAX_AUDIO_BYTES / (1024 * 1024)} MB transcription limit.`,
        );
      }
      const bytes = await readFile(target).catch(() => {
        throw new ToolError("internal", "The file couldn't be read.");
      });

      let text: string;
      try {
        text = await deps.transcribe(options, bytes, mediaType, ctx.signal);
      } catch {
        // AiError or any other throw: one fixed safe message, never the
        // provider's text (see the module header).
        throw new ToolError("internal", "Transcription failed.");
      }
      return { text, chars: text.length };
    },
  };
}

// ---------------------------------------------------------------------------
// text_to_speech
// ---------------------------------------------------------------------------

export interface TtsInput {
  /** Text to speak, 1..MAX_TEXT_CHARS characters. */
  text: string;
}

export interface TtsOutput {
  /** True: the speech was synthesised and rides out via extractMedia. */
  spoken: true;
  /** Characters of text that were spoken. */
  chars: number;
}

export interface TtsToolDeps {
  /** Server-supplied owner predicate; re-checked in run() (defence in depth). */
  isOwner: (userId: string) => boolean;
  /**
   * Speech endpoint config. Absent = the owner never configured a speech
   * service, so every run answers `disabled` honestly.
   */
  options?: TtsOptions;
  /**
   * The synthesis pipeline, injected by the composition root (bootstrap
   * passes src/ai/tts's `synthesizeSpeech`). Required — see the dependency
   * rule in the module header.
   */
  synthesize: SynthesizeFn;
}

/**
 * Synthesised audio, keyed by the data object run() returned — the
 * image_gen pattern: extractMedia receives only the data object, and the
 * data contract forbids embedding audio bytes, so the SpeechResult is
 * stashed here by identity. A WeakMap keeps entries from outliving their run.
 */
const speechResults = new WeakMap<object, SpeechResult>();

/** Plugin discovery manifest for `text_to_speech`. */
export const textToSpeechManifest: ToolManifest = defineManifest({
  id: "text_to_speech",
  version: "1.0.0",
  title: "Text to Speech",
  description:
    "Turn text into a voice message using the configured speech service; the audio is delivered to the user as an attachment. Owner only.",
  purpose: "text to voice message",
  useWhen: "reply should be spoken aloud",
  doNotUseWhen:
    "the user sent a voice note to be understood — that is transcribe_audio; text over the per-call character cap must be shortened first",
  confusableWith: [
    {
      tool: "transcribe_audio",
      difference:
        "transcribe_audio turns a voice file into text; text_to_speech turns text into a voice message",
    },
  ],
  latencyTier: "seconds",
  outputSummary:
    "Confirmation the text was spoken, delivered as an audio attachment, with the character count.",
  category: "media",
  costTier: "cheap",
});

export function createTtsTool(deps: TtsToolDeps): Tool<TtsInput, TtsOutput> {
  return {
    name: "text_to_speech",
    manifest: textToSpeechManifest,
    description:
      "Turn text into a voice message delivered to the user as an audio attachment. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [TEXT_TO_SPEECH_PERMISSION] },
    toolset: "media",
    input: {
      fields: {
        text: {
          type: "string",
          required: true,
          description: `Text to speak (max ${MAX_TEXT_CHARS} characters per call).`,
          minLength: 1,
          maxLength: MAX_TEXT_CHARS,
        },
      },
    },

    extractMedia(data: TtsOutput) {
      const result = speechResults.get(data);
      if (result === undefined) return undefined;
      const part: ContentPart = {
        type: "audio",
        mediaType: result.mediaType,
        base64: result.audio.toString("base64"),
      };
      return [part];
    },

    async run(input: TtsInput, ctx: ToolContext): Promise<TtsOutput> {
      assertVoiceOwner(ctx, deps.isOwner, "Text-to-speech is owner only.");
      const options = deps.options;
      if (options === undefined) {
        throw new ToolError("disabled", "Text-to-speech is not configured.");
      }
      const text = typeof input.text === "string" ? input.text : "";
      if (text.trim().length === 0) {
        throw new ToolError("invalid_input", "No text was provided to speak.");
      }
      if (text.length > MAX_TEXT_CHARS) {
        // Defence in depth: the field spec caps this first; a direct caller
        // bypassing validation still cannot smuggle a longer text through.
        throw new ToolError(
          "invalid_input",
          `Text is too long: the limit is ${MAX_TEXT_CHARS} characters per call.`,
        );
      }

      let result: SpeechResult;
      try {
        result = await deps.synthesize(options, text, ctx.signal);
      } catch {
        // AiError or any other throw: one fixed safe message, never the
        // provider's text (see the module header).
        throw new ToolError("internal", "Speech synthesis failed.");
      }
      const data: TtsOutput = { spoken: true, chars: text.length };
      // Audio rides out-of-band (see extractMedia); `data` stays model-safe.
      speechResults.set(data, result);
      return data;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The defence-in-depth owner check: the actor id comes from server code, never the model. */
function assertVoiceOwner(
  ctx: ToolContext,
  isOwner: (userId: string) => boolean,
  ownerOnlyMessage: string,
): void {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown.");
  }
  if (!isOwner(id)) {
    throw new ToolError("not_allowed", ownerOnlyMessage);
  }
}

// Path safety uses the shared helper (./sandbox): absolute paths refused,
// lexical `..` escapes refused before any I/O, and the deepest existing
// ancestor realpath'd and required to stay inside the root's real path
// (symlink escapes refused). Error messages never echo the resolved path.
