/**
 * Phase B3 — TTS voice replies.
 *
 * Covers the input caps and delivery planning (pure), the speech endpoint
 * wire shape through the pinned transport against a local server, the
 * text-fallback on TTS failure, the /voice toggle logic, and the user_prefs
 * storage layer including the 12→13 migration.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { InputFile } from "grammy";
import {
  synthesizeSpeech,
  splitForSpeech,
  planVoiceDelivery,
  MAX_TTS_CHARS,
  MAX_VOICE_CHUNKS,
  MAX_VOICE_CHARS,
  type TtsOptions,
} from "../src/ai/tts";
import { AiError } from "../src/ai/provider";
import {
  deliverReply,
  handleVoiceCommand,
  VOICE_FAILED_NOTE,
  VOICE_TRUNCATED_NOTE,
  VOICE_MODE_KEY,
  type VoiceCommandEnv,
  type UserPrefStore,
} from "../src/bot/bot";
import { SCHEMA_VERSION, Storage } from "../src/storage/storage";

// ---------- caps ----------

describe("TTS input caps", () => {
  test("rejects input past MAX_TTS_CHARS instead of truncating", async () => {
    await expect(
      synthesizeSpeech(
        { baseUrl: "http://127.0.0.1:1", apiKey: undefined, model: "tts-1", voice: "alloy" },
        "x".repeat(MAX_TTS_CHARS + 1),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test("rejects empty input", async () => {
    await expect(
      synthesizeSpeech(
        { baseUrl: "http://127.0.0.1:1", apiKey: undefined, model: "tts-1", voice: "alloy" },
        "",
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test("splitForSpeech cuts at the char boundary", () => {
    const text = "y".repeat(MAX_TTS_CHARS + 10);
    const pieces = splitForSpeech(text);
    expect(pieces).toEqual(["y".repeat(MAX_TTS_CHARS), "y".repeat(10)]);
  });
});

describe("planVoiceDelivery", () => {
  test("short replies become voice only", () => {
    const { voice, text } = planVoiceDelivery(["سلام", "چطوری؟"]);
    expect(voice).toEqual(["سلام", "چطوری؟"]);
    expect(text).toEqual([]);
  });

  test("caps at MAX_VOICE_CHUNKS chunks; the rest stays text", () => {
    expect(MAX_VOICE_CHUNKS).toBe(2);
    const { voice, text } = planVoiceDelivery(["یک", "دو", "سه"]);
    expect(voice).toEqual(["یک", "دو"]);
    expect(text).toEqual(["سه"]);
  });

  test("caps total voice chars at MAX_VOICE_CHARS", () => {
    expect(MAX_VOICE_CHARS).toBe(8000);
    const big = "z".repeat(5000);
    const { voice, text } = planVoiceDelivery([big, big, "tail"]);
    expect(voice.join("").length).toBe(8000);
    expect(text.join("").length).toBe(2000 + 4);
  });

  test("an engine-sized chunk is sub-split to the synthesis cap", () => {
    // The engine emits ≤4096-char chunks; the synthesis call takes ≤4000.
    const { voice, text } = planVoiceDelivery(["w".repeat(4096)]);
    expect(voice).toEqual(["w".repeat(4000), "w".repeat(96)]);
    expect(text).toEqual([]);
  });
});

// ---------- wire test through the pinned transport ----------

async function localSpeechServer(status: number, body: Buffer, contentType: string) {
  const seen: Array<{ url: string | undefined; contentType: string | undefined; payload: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url,
        contentType: req.headers["content-type"],
        payload: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

function localOpts(url: string): TtsOptions {
  return { baseUrl: url, apiKey: "k", model: "tts-1", voice: "alloy", allowLocalTargets: true };
}

describe("synthesizeSpeech wire", () => {
  const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 9, 9, 9]);

  test("posts the speech payload and returns raw audio bytes", async () => {
    const s = await localSpeechServer(200, OGG, "audio/ogg");
    try {
      const { audio, mediaType } = await synthesizeSpeech(
        localOpts(s.url),
        "سلام",
        AbortSignal.timeout(5000),
      );
      expect(audio.equals(OGG)).toBe(true);
      expect(mediaType).toBe("audio/ogg");
      expect(s.seen.length).toBe(1);
      expect(s.seen[0]?.url).toBe("/audio/speech");
      const payload = JSON.parse(s.seen[0]!.payload) as Record<string, unknown>;
      expect(payload).toMatchObject({
        model: "tts-1",
        input: "سلام",
        voice: "alloy",
        response_format: "opus",
      });
    } finally {
      s.close();
    }
  });

  test("maps an auth failure onto the auth category", async () => {
    const s = await localSpeechServer(401, Buffer.from("{}"), "application/json");
    try {
      await expect(
        synthesizeSpeech(localOpts(s.url), "سلام", AbortSignal.timeout(5000)),
      ).rejects.toMatchObject({ kind: "auth" });
    } finally {
      s.close();
    }
  });
});

// ---------- delivery ----------

type Sent = Array<{ kind: "text" | "voice"; body: unknown }>;

function fakeCtx(sent: Sent) {
  return {
    reply: async (text: string) => {
      sent.push({ kind: "text", body: text });
    },
    replyWithVoice: async (voice: InputFile) => {
      sent.push({ kind: "voice", body: voice });
    },
  };
}

function okSynth() {
  return async () => ({ audio: Buffer.from("ogg"), mediaType: "audio/ogg" });
}

function failingSynth() {
  return async () => {
    throw new AiError("network", "down");
  };
}

const TTS = { baseUrl: "https://tts.example/v1", apiKey: undefined, model: "tts-1", voice: "alloy" };

function prefsWith(voice: "1" | "0"): UserPrefStore {
  const map = new Map<string, string>([[`7:${VOICE_MODE_KEY}`, voice]]);
  return {
    getUserPref: (u, k) => map.get(`${u}:${k}`),
    setUserPref: (u, k, v) => {
      map.set(`${u}:${k}`, v);
    },
  };
}

describe("deliverReply", () => {
  test("text mode sends text chunks", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("0") },
      "7",
      ["a", "b"],
      okSynth(),
    );
    expect(sent.map((s) => s.kind)).toEqual(["text", "text"]);
    expect(sent.map((s) => s.body)).toEqual(["a", "b"]);
  });

  test("voice mode sends voice instead of text", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("1") },
      "7",
      ["a", "b"],
      okSynth(),
    );
    expect(sent.map((s) => s.kind)).toEqual(["voice", "voice"]);
  });

  test("a TTS failure falls back to all text chunks plus one Persian note", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("1") },
      "7",
      ["a", "b"],
      failingSynth(),
    );
    expect(sent.map((s) => s.kind)).toEqual(["text", "text", "text"]);
    expect(sent[0]?.body).toBe(VOICE_FAILED_NOTE);
    expect(sent.slice(1).map((s) => s.body)).toEqual(["a", "b"]);
  });

  test("chunks past the voice caps arrive as text after a truncation note", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("1") },
      "7",
      ["یک", "دو", "سه"],
      okSynth(),
    );
    expect(sent.map((s) => s.kind)).toEqual(["voice", "voice", "text", "text"]);
    expect(sent[2]?.body).toBe(VOICE_TRUNCATED_NOTE);
    expect(sent[3]?.body).toBe("سه");
  });

  test("no TTS config means text even with the pref on", async () => {
    const sent: Sent = [];
    await deliverReply(fakeCtx(sent), { prefs: prefsWith("1") }, "7", ["a"], okSynth());
    expect(sent.map((s) => s.kind)).toEqual(["text"]);
  });
});

// ---------- /voice toggle ----------

function fakeVoiceCtx(replies: string[]) {
  return {
    from: { id: 7 },
    reply: async (text: string) => {
      replies.push(text);
    },
  };
}

describe("handleVoiceCommand", () => {
  test("reports not-configured and does not set the pref when TTS is absent", async () => {
    const replies: string[] = [];
    const store = prefsWith("0");
    const env: VoiceCommandEnv = { prefs: store };
    await handleVoiceCommand(fakeVoiceCtx(replies), env);
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("پیکربندی نشده");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("0");
  });

  test("does not set the pref when baseUrl is empty", async () => {
    const replies: string[] = [];
    const store = prefsWith("0");
    await handleVoiceCommand(fakeVoiceCtx(replies), { tts: { ...TTS, baseUrl: "" }, prefs: store });
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("0");
  });

  test("toggles off → on and on → off with Persian confirmations", async () => {
    const store = prefsWith("0");
    const env: VoiceCommandEnv = { tts: TTS, prefs: store };

    const r1: string[] = [];
    await handleVoiceCommand(fakeVoiceCtx(r1), env);
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("1");
    expect(r1[0]).toContain("روشن شد");

    const r2: string[] = [];
    await handleVoiceCommand(fakeVoiceCtx(r2), env);
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("0");
    expect(r2[0]).toContain("خاموش شد");
  });

  test("a storage failure keeps the old value and reports it", async () => {
    const replies: string[] = [];
    const store: UserPrefStore = {
      getUserPref: () => "0",
      setUserPref: () => {
        throw new Error("disk full");
      },
    };
    await handleVoiceCommand(fakeVoiceCtx(replies), { tts: TTS, prefs: store });
    expect(replies[0]).toContain("ناموفق بود");
  });
});

// ---------- user_prefs storage ----------

describe("user_prefs", () => {
  test("CRUD round-trips and isolates users", () => {
    const db = Storage.open(":memory:");
    try {
      expect(db.getUserPref("u1", "voice_mode")).toBeUndefined();
      db.setUserPref("u1", "voice_mode", "1");
      expect(db.getUserPref("u1", "voice_mode")).toBe("1");
      db.setUserPref("u1", "voice_mode", "0");
      expect(db.getUserPref("u1", "voice_mode")).toBe("0");
      db.setUserPref("u2", "voice_mode", "1");
      expect(db.getUserPref("u1", "voice_mode")).toBe("0");
      expect(db.getUserPref("u2", "voice_mode")).toBe("1");
    } finally {
      db.close();
    }
  });

  test("a fresh database migrates to the current schema version", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
    const db = Storage.open(":memory:");
    try {
      const row = (
        db as unknown as { query<T>(sql: string): T[] }
      ).query<{ v: string }>(`SELECT v FROM _meta WHERE k='schema_version'`)[0];
      expect(row?.v).toBe(String(SCHEMA_VERSION));
      const tables = (
        db as unknown as { query<T>(sql: string): T[] }
      ).query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='user_prefs'`,
      );
      expect(tables.length).toBe(1);
    } finally {
      db.close();
    }
  });
});
