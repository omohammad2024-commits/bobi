/**
 * Voice tools (platform Phase 9) — transcribe_audio + text_to_speech.
 *
 * Pins:
 *  - identity / permission / ownerOnly / manifest validity + tiers for both
 *  - unconfigured pipelines answer `disabled` with the fixed messages
 *  - transcribe: an injected fake receives the exact sandbox bytes, the
 *    extension-derived media type, the deps options and the run signal; an
 *    empty transcript is returned honestly; ANY throw (AiError carrying
 *    provider text, or a plain Error) collapses to the fixed internal
 *    message with no provider text echoed
 *  - transcribe sandbox discipline: missing file, traversal, unsupported
 *    extension, and the MAX_TRANSCRIBE_AUDIO_BYTES cap (sparse file; the
 *    pipeline is never called)
 *  - TTS: an injected fake's SpeechResult rides out via extractMedia as one
 *    audio part whose base64 decodes to the fake's bytes, while `data`
 *    stays free of audio; input caps (empty, over MAX_TTS_CHARS) refuse
 *    before the pipeline runs; failures collapse to the fixed message
 *  - the owner gate fires for non-owners on both tools
 *
 * Temp dirs and injected fakes only — no network, nothing touches the repo.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TEXT_TO_SPEECH_PERMISSION,
  TRANSCRIBE_AUDIO_PERMISSION,
  createTranscribeTool,
  createTtsTool,
  textToSpeechManifest,
  transcribeAudioManifest,
} from "../src/tools/voice_tools";
import {
  MAX_TRANSCRIBE_AUDIO_BYTES,
  type TranscribeOptions,
} from "../src/ai/transcribe";
import { MAX_TTS_CHARS, type SpeechResult, type TtsOptions } from "../src/ai/tts";
import { AiError } from "../src/ai/provider";
import { ToolError } from "../src/tools/errors";
import { validateManifest } from "../src/tools/validate_manifest";
import type { ToolContext } from "../src/tools/types";

const isOwner = (userId: string): boolean => userId === "owner";

function ctxFor(userId: string): ToolContext {
  return {
    clock: () => new Date("2026-10-21T12:00:00Z"),
    actor: { userId, permissions: [TRANSCRIBE_AUDIO_PERMISSION, TEXT_TO_SPEECH_PERMISSION] },
    signal: new AbortController().signal,
  };
}
const ownerCtx = ctxFor("owner");

const TRANSCRIBE_OPTS: TranscribeOptions = {
  baseUrl: "https://transcribe.example/v1",
  apiKey: undefined,
  model: "whisper-1",
};
const TTS_OPTS: TtsOptions = {
  baseUrl: "https://speech.example/v1",
  apiKey: undefined,
  model: "tts-1",
  voice: "alloy",
};

const bases: string[] = [];

function freshRoot(): string {
  const base = mkdtempSync(join(tmpdir(), "bobi-voice-tools-"));
  bases.push(base);
  return join(base, "files-area");
}

afterEach(() => {
  for (const dir of bases.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir must not fail the suite.
    }
  }
});

function put(rootDir: string, rel: string, data: string | Buffer): void {
  const abs = join(rootDir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, data);
}

async function expectToolError(
  p: Promise<unknown>,
  kind: ToolError["kind"],
  message?: string,
): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe(kind);
    if (message !== undefined) expect((err as ToolError).message).toBe(message);
    return err as ToolError;
  }
  throw new Error(`expected ToolError(${kind}) but the run succeeded`);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("voice tool shapes", () => {
  test("transcribe_audio: identity, permission, ownerOnly, tiers", () => {
    const t = createTranscribeTool({ rootDir: freshRoot(), isOwner, transcribe: async () => "" });
    expect(t.name).toBe("transcribe_audio");
    expect(TRANSCRIBE_AUDIO_PERMISSION).toBe("tools:transcribe_audio");
    expect(t.permission.requires).toEqual(["tools:transcribe_audio"]);
    expect(t.ownerOnly).toBe(true);
    expect(t.enabled).toBe(true);
    expect(t.manifest).toBe(transcribeAudioManifest);
    expect(transcribeAudioManifest.latencyTier).toBe("seconds");
    expect(transcribeAudioManifest.costTier).toBe("cheap");
    expect(transcribeAudioManifest.category).toBe("media");
  });

  test("text_to_speech: identity, permission, ownerOnly, tiers", () => {
    const t = createTtsTool({
      isOwner,
      synthesize: async () => ({ audio: Buffer.from("x"), mediaType: "audio/ogg" }),
    });
    expect(t.name).toBe("text_to_speech");
    expect(TEXT_TO_SPEECH_PERMISSION).toBe("tools:text_to_speech");
    expect(t.permission.requires).toEqual(["tools:text_to_speech"]);
    expect(t.ownerOnly).toBe(true);
    expect(t.enabled).toBe(true);
    expect(t.manifest).toBe(textToSpeechManifest);
    expect(textToSpeechManifest.latencyTier).toBe("seconds");
    expect(textToSpeechManifest.costTier).toBe("cheap");
    expect(textToSpeechManifest.category).toBe("media");
    expect(t.input.fields["text"]?.maxLength).toBe(MAX_TTS_CHARS);
  });

  test("both manifests validate and cross-reference each other", () => {
    expect(validateManifest(transcribeAudioManifest)).toEqual([]);
    expect(validateManifest(textToSpeechManifest)).toEqual([]);
    expect(transcribeAudioManifest.confusableWith.map((c) => c.tool)).toEqual([
      "text_to_speech",
      "extract_document",
    ]);
    expect(textToSpeechManifest.confusableWith.map((c) => c.tool)).toEqual([
      "transcribe_audio",
    ]);
  });
});

// ---------------------------------------------------------------------------
// transcribe_audio
// ---------------------------------------------------------------------------

describe("transcribe_audio", () => {
  test("unconfigured → disabled with the fixed message", async () => {
    const root = freshRoot();
    put(root, "note.ogg", Buffer.from([1, 2, 3]));
    const t = createTranscribeTool({ rootDir: root, isOwner, transcribe: async () => "unused" });
    await expectToolError(
      t.run({ path: "note.ogg" }, ownerCtx),
      "disabled",
      "Voice transcription is not configured.",
    );
  });

  test("fake pipeline receives bytes, media type, options and signal", async () => {
    const root = freshRoot();
    const audio = Buffer.from([0x4f, 0x67, 0x67, 0x53, 9, 8, 7]);
    put(root, "voice/note.mp3", audio);
    const seen: {
      options?: TranscribeOptions;
      audio?: Buffer;
      mediaType?: string;
      signal?: AbortSignal;
    } = {};
    const t = createTranscribeTool({
      rootDir: root,
      isOwner,
      options: TRANSCRIBE_OPTS,
      transcribe: async (options, bytes, mediaType, signal) => {
        seen.options = options;
        seen.audio = bytes;
        seen.mediaType = mediaType;
        seen.signal = signal;
        return "سلام دنیا";
      },
    });
    const out = await t.run({ path: "voice/note.mp3" }, ownerCtx);
    expect(out).toEqual({ text: "سلام دنیا", chars: "سلام دنیا".length });
    expect(seen.options).toBe(TRANSCRIBE_OPTS);
    expect(seen.audio?.equals(audio)).toBe(true);
    expect(seen.mediaType).toBe("audio/mpeg");
    expect(seen.signal).toBe(ownerCtx.signal);
  });

  test("an empty transcript is returned honestly, not an error", async () => {
    const root = freshRoot();
    put(root, "silence.ogg", Buffer.from([1]));
    const t = createTranscribeTool({
      rootDir: root,
      isOwner,
      options: TRANSCRIBE_OPTS,
      transcribe: async () => "",
    });
    await expect(t.run({ path: "silence.ogg" }, ownerCtx)).resolves.toEqual({
      text: "",
      chars: 0,
    });
  });

  test("an AiError with provider text collapses to the fixed internal message", async () => {
    const root = freshRoot();
    put(root, "note.ogg", Buffer.from([1, 2]));
    const t = createTranscribeTool({
      rootDir: root,
      isOwner,
      options: TRANSCRIBE_OPTS,
      transcribe: async () => {
        throw new AiError("auth", "provider said: bad key sk-live-123");
      },
    });
    const err = await expectToolError(
      t.run({ path: "note.ogg" }, ownerCtx),
      "internal",
      "Transcription failed.",
    );
    expect(err.message).not.toContain("bad key");
    expect(err.message).not.toContain("sk-live-123");
  });

  test("a plain Error throw collapses the same way", async () => {
    const root = freshRoot();
    put(root, "note.wav", Buffer.from([1, 2]));
    const t = createTranscribeTool({
      rootDir: root,
      isOwner,
      options: TRANSCRIBE_OPTS,
      transcribe: async () => {
        throw new Error("boom at /internal/path/secret.ts");
      },
    });
    const err = await expectToolError(
      t.run({ path: "note.wav" }, ownerCtx),
      "internal",
      "Transcription failed.",
    );
    expect(err.message).not.toContain("/internal/path");
  });

  test("unsupported extension, missing file, traversal", async () => {
    const root = freshRoot();
    put(root, "song.flac", Buffer.from([1]));
    const t = createTranscribeTool({
      rootDir: root,
      isOwner,
      options: TRANSCRIBE_OPTS,
      transcribe: async () => "unused",
    });
    await expectToolError(
      t.run({ path: "song.flac" }, ownerCtx),
      "invalid_input",
      "Only .ogg, .mp3, .wav, .m4a and .webm audio files can be transcribed.",
    );
    const missing = await expectToolError(
      t.run({ path: "ghost.ogg" }, ownerCtx),
      "not_found",
      "That file doesn't exist.",
    );
    expect(missing.message).not.toContain("ghost.ogg");
    await expectToolError(
      t.run({ path: "../outside.ogg" }, ownerCtx),
      "not_allowed",
      "That path is outside the files area.",
    );
  });

  test("over the byte cap → invalid_input naming the cap; pipeline never called", async () => {
    const root = freshRoot();
    put(root, "huge.ogg", "seed");
    truncateSync(join(root, "huge.ogg"), MAX_TRANSCRIBE_AUDIO_BYTES + 1);
    let calls = 0;
    const t = createTranscribeTool({
      rootDir: root,
      isOwner,
      options: TRANSCRIBE_OPTS,
      transcribe: async () => {
        calls++;
        return "unused";
      },
    });
    await expectToolError(
      t.run({ path: "huge.ogg" }, ownerCtx),
      "invalid_input",
      "That audio file is larger than the 25 MB transcription limit.",
    );
    expect(calls).toBe(0);
  });

  test("owner gate fires before anything else", async () => {
    const root = freshRoot();
    put(root, "note.ogg", Buffer.from([1]));
    const t = createTranscribeTool({
      rootDir: root,
      isOwner,
      options: TRANSCRIBE_OPTS,
      transcribe: async () => "unused",
    });
    await expectToolError(
      t.run({ path: "note.ogg" }, ctxFor("stranger")),
      "not_allowed",
      "Voice transcription is owner only.",
    );
  });
});

// ---------------------------------------------------------------------------
// text_to_speech
// ---------------------------------------------------------------------------

describe("text_to_speech", () => {
  const FAKE_AUDIO = Buffer.from("fake-ogg-opus-bytes");

  function fakeSynthesize(seen?: {
    options?: TtsOptions;
    text?: string;
    signal?: AbortSignal;
  }): (options: TtsOptions, text: string, signal: AbortSignal) => Promise<SpeechResult> {
    return async (options, text, signal) => {
      if (seen !== undefined) {
        seen.options = options;
        seen.text = text;
        seen.signal = signal;
      }
      return { audio: FAKE_AUDIO, mediaType: "audio/ogg" };
    };
  }

  test("unconfigured → disabled with the fixed message", async () => {
    const t = createTtsTool({
      isOwner,
      synthesize: async () => ({ audio: Buffer.from("x"), mediaType: "audio/ogg" }),
    });
    await expectToolError(
      t.run({ text: "hello" }, ownerCtx),
      "disabled",
      "Text-to-speech is not configured.",
    );
  });

  test("audio rides via extractMedia; data stays free of audio bytes", async () => {
    const seen: { options?: TtsOptions; text?: string; signal?: AbortSignal } = {};
    const t = createTtsTool({
      isOwner,
      options: TTS_OPTS,
      synthesize: fakeSynthesize(seen),
    });
    const out = await t.run({ text: "سلام" }, ownerCtx);
    expect(out).toEqual({ spoken: true, chars: 4 });
    expect(seen.options).toBe(TTS_OPTS);
    expect(seen.text).toBe("سلام");
    expect(seen.signal).toBe(ownerCtx.signal);

    // Data must never contain the audio — no base64 anywhere in it.
    expect(JSON.stringify(out)).not.toContain(FAKE_AUDIO.toString("base64"));

    const media = t.extractMedia?.(out);
    expect(media).toHaveLength(1);
    const part = media?.[0];
    if (part?.type !== "audio") throw new Error("expected an audio part");
    expect(part.mediaType).toBe("audio/ogg");
    expect(Buffer.from(part.base64, "base64").equals(FAKE_AUDIO)).toBe(true);
  });

  test("extractMedia on a foreign data object returns undefined", () => {
    const t = createTtsTool({ isOwner, options: TTS_OPTS, synthesize: fakeSynthesize() });
    expect(t.extractMedia?.({ spoken: true, chars: 1 })).toBeUndefined();
  });

  test("a synthesis failure collapses to the fixed internal message", async () => {
    const t = createTtsTool({
      isOwner,
      options: TTS_OPTS,
      synthesize: async () => {
        throw new AiError("quota", "provider said: balance exhausted on acct 42");
      },
    });
    const err = await expectToolError(
      t.run({ text: "hello" }, ownerCtx),
      "internal",
      "Speech synthesis failed.",
    );
    expect(err.message).not.toContain("balance exhausted");
  });

  test("input caps: empty, whitespace-only and over-cap refuse before synthesis", async () => {
    let calls = 0;
    const t = createTtsTool({
      isOwner,
      options: TTS_OPTS,
      synthesize: async () => {
        calls++;
        return { audio: FAKE_AUDIO, mediaType: "audio/ogg" };
      },
    });
    await expectToolError(
      t.run({ text: "" }, ownerCtx),
      "invalid_input",
      "No text was provided to speak.",
    );
    await expectToolError(t.run({ text: "   " }, ownerCtx), "invalid_input");
    const err = await expectToolError(
      t.run({ text: "x".repeat(MAX_TTS_CHARS + 1) }, ownerCtx),
      "invalid_input",
    );
    expect(err.message).toContain(String(MAX_TTS_CHARS));
    expect(calls).toBe(0);
  });

  test("owner gate fires for non-owners", async () => {
    const t = createTtsTool({
      isOwner,
      options: TTS_OPTS,
      synthesize: fakeSynthesize(),
    });
    await expectToolError(
      t.run({ text: "hello" }, ctxFor("stranger")),
      "not_allowed",
      "Text-to-speech is owner only.",
    );
  });
});
