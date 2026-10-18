/**
 * Phase B2 — voice transcription.
 *
 * Covers the multipart wire shape, the whisper JSON parsing (including error
 * shapes), the decision matrix in bot.ts (native / disabled / transcribe),
 * and the per-turn replacement with its never-crash contract. One wire test
 * goes through the real pinned transport against a local server; everything
 * else is offline.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  transcribeAudio,
  parseTranscriptionText,
  buildTranscriptionForm,
  TRANSCRIBE_TIMEOUT_MS,
  type TranscribeOptions,
} from "../src/ai/transcribe";
import { AiError } from "../src/ai/provider";
import {
  shouldTranscribeAudio,
  transcribeAudioParts,
  transcriptLabel,
  MAX_TRANSCRIBED_AUDIO_PARTS,
  type BotDeps,
} from "../src/bot/bot";
import type { ConversationEngine } from "../src/conversation/engine";
import type { ContentPart } from "../src/ai/provider";

const AUDIO = Buffer.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]); // fake ogg bytes

function audioPart(base64 = AUDIO.toString("base64")): ContentPart {
  return { type: "audio", mediaType: "audio/ogg", base64 };
}

function fakeEngine(native: boolean): ConversationEngine {
  return { activeSupportsAudioInput: () => native } as ConversationEngine;
}

function deps(native: boolean, baseUrl = "https://transcribe.example/v1"): Pick<BotDeps, "transcribe" | "engine"> {
  return {
    transcribe: { baseUrl, apiKey: "k", model: "whisper-1" } satisfies TranscribeOptions,
    engine: fakeEngine(native),
  };
}

// ---------- multipart wire shape ----------

describe("transcription multipart body", () => {
  test("carries file, model and response_format fields with a boundary", () => {
    const { body, contentType } = buildTranscriptionForm(AUDIO, "audio/ogg", "whisper-1");
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----bobi[0-9a-f]{32}$/);

    const text = body.toString("latin1");
    expect(text).toContain('name="model"');
    expect(text).toContain("whisper-1");
    expect(text).toContain('name="response_format"');
    expect(text).toContain("json");
    expect(text).toContain('name="file"; filename="voice.ogg"');
    expect(text).toContain("Content-Type: audio/ogg");
    // The raw audio bytes ride inside the body.
    expect(body.includes(AUDIO)).toBe(true);
  });

  test("derives a safe filename from the media type", () => {
    const { body } = buildTranscriptionForm(AUDIO, "audio/mpeg", "whisper-1");
    expect(body.toString("latin1")).toContain('filename="voice.mp3"');
  });
});

// ---------- whisper JSON parsing ----------

describe("parseTranscriptionText", () => {
  test("returns the text on the success shape", () => {
    expect(parseTranscriptionText(JSON.stringify({ text: "سلام دنیا" }))).toBe("سلام دنیا");
  });

  test("an empty transcript is valid (silence)", () => {
    expect(parseTranscriptionText(JSON.stringify({ text: "" }))).toBe("");
  });

  test("rejects the error shape without echoing it", () => {
    const raw = JSON.stringify({ error: { message: "bad key", type: "auth" } });
    try {
      parseTranscriptionText(raw);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AiError);
      expect((err as AiError).kind).toBe("invalid_response");
      expect((err as Error).message).not.toContain("bad key");
    }
  });

  test("rejects malformed JSON and missing text", () => {
    for (const raw of ["not json", JSON.stringify({}), JSON.stringify({ text: 42 })]) {
      expect(() => parseTranscriptionText(raw)).toThrow(AiError);
    }
  });
});

// ---------- decision matrix ----------

describe("shouldTranscribeAudio", () => {
  test("false when transcription is not configured", () => {
    expect(shouldTranscribeAudio({ engine: fakeEngine(false) })).toBe(false);
    expect(
      shouldTranscribeAudio({ engine: fakeEngine(false), transcribe: { baseUrl: "  ", apiKey: undefined, model: "w" } }),
    ).toBe(false);
  });

  test("false when the provider handles audio natively", () => {
    expect(shouldTranscribeAudio(deps(true))).toBe(false);
  });

  test("true when transcription is configured and the provider cannot hear audio", () => {
    expect(shouldTranscribeAudio(deps(false))).toBe(true);
  });
});

// ---------- per-turn replacement ----------

describe("transcribeAudioParts", () => {
  const ok = async () => "متن تست";

  test("replaces audio parts with the labeled transcript", async () => {
    const parts = await transcribeAudioParts(
      [audioPart(), { type: "image", mediaType: "image/jpeg", base64: "aGk=" }],
      ok,
    );
    expect(parts[0]).toEqual({ type: "text", text: transcriptLabel("متن تست") });
    expect(parts[1]?.type).toBe("image");
  });

  test("transcribes at most MAX_TRANSCRIBED_AUDIO_PARTS per turn", async () => {
    expect(MAX_TRANSCRIBED_AUDIO_PARTS).toBe(2);
    let calls = 0;
    const parts = await transcribeAudioParts(
      [audioPart(), audioPart(), audioPart()],
      async () => {
        calls += 1;
        return "t";
      },
    );
    expect(calls).toBe(2);
    expect(parts[0]?.type).toBe("text");
    expect(parts[1]?.type).toBe("text");
    expect(parts[2]?.type).toBe("audio");
  });

  test("a failed transcription leaves the audio part in place", async () => {
    const parts = await transcribeAudioParts([audioPart()], async () => {
      throw new AiError("network", "down");
    });
    expect(parts).toEqual([audioPart()]);
  });

  test("an empty transcript leaves the audio part in place", async () => {
    const parts = await transcribeAudioParts([audioPart()], async () => "   ");
    expect(parts).toEqual([audioPart()]);
  });
});

// ---------- wire test through the pinned transport ----------

interface LocalServer {
  url: string;
  bodies: Buffer[];
  status: number;
  payload: string;
  close: () => void;
}

async function localServer(status: number, payload: string): Promise<LocalServer> {
  const bodies: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    status,
    payload,
    close: () => server.close(),
  };
}

function localOpts(url: string): TranscribeOptions {
  return { baseUrl: url, apiKey: "k", model: "whisper-1", allowLocalTargets: true };
}

describe("transcribeAudio wire", () => {
  test("posts multipart and returns the transcript", async () => {
    const s = await localServer(200, JSON.stringify({ text: "رونویسی شد" }));
    try {
      const text = await transcribeAudio(
        localOpts(s.url),
        AUDIO,
        "audio/ogg",
        AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      );
      expect(text).toBe("رونویسی شد");
      expect(s.bodies.length).toBe(1);
      const sent = s.bodies[0]!.toString("latin1");
      expect(sent).toContain('name="file"');
      expect(sent).toContain("whisper-1");
    } finally {
      s.close();
    }
  });

  test("maps error statuses onto the shared categories", async () => {
    const cases: Array<[number, string]> = [
      [401, "auth"],
      [429, "quota"],
      [500, "network"],
      [400, "invalid_response"],
    ];
    for (const [status, kind] of cases) {
      const s = await localServer(status, JSON.stringify({ error: { message: "x" } }));
      try {
        await expect(
          transcribeAudio(localOpts(s.url), AUDIO, "audio/ogg", AbortSignal.timeout(5000)),
        ).rejects.toMatchObject({ kind });
      } finally {
        s.close();
      }
    }
  });
});
