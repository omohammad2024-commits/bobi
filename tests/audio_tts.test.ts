/**
 * Phase B3 — TTS voice replies.
 *
 * Covers the input caps and delivery planning (pure), the speech endpoint
 * wire shape through the pinned transport against a local server, the
 * text-fallback on TTS failure, the modality-mirroring decision matrix, the
 * /voice 3-way preference (command + picker callbacks), and the user_prefs
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
  handleVoiceCallback,
  decideReplyModality,
  resolveVoicePref,
  parseVoiceArg,
  voiceValueForCallback,
  VOICE_FAILED_NOTE,
  VOICE_TRUNCATED_NOTE,
  VOICE_MODE_KEY,
  VOICE_UNCONFIGURED_NOTIFIED_KEY,
  type VoiceCommandEnv,
  type UserPrefStore,
  type VoicePref,
} from "../src/bot/bot";
import {
  buildVoiceKeyboard,
  isVoiceCallback,
  VOICE_CALLBACKS,
} from "../src/bot/menu";
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

function fakeCtx(
  sent: Sent,
  extra: {
    chat?: { id: number | string };
    api?: { sendChatAction(chatId: number | string, action: string): Promise<unknown> };
  } = {},
) {
  return {
    reply: async (text: string) => {
      sent.push({ kind: "text", body: text });
    },
    replyWithVoice: async (voice: InputFile) => {
      sent.push({ kind: "voice", body: voice });
    },
    ...(extra.chat !== undefined ? { chat: extra.chat } : {}),
    ...(extra.api !== undefined ? { api: extra.api } : {}),
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

function prefsWith(voice: string): UserPrefStore {
  const map = new Map<string, string>([[`7:${VOICE_MODE_KEY}`, voice]]);
  return {
    getUserPref: (u, k) => map.get(`${u}:${k}`),
    setUserPref: (u, k, v) => {
      map.set(`${u}:${k}`, v);
    },
  };
}

// ---------- preference resolution & the decision matrix ----------

describe("resolveVoicePref", () => {
  test("canonical values pass through", () => {
    expect(resolveVoicePref("auto")).toBe("auto");
    expect(resolveVoicePref("always")).toBe("always");
    expect(resolveVoicePref("never")).toBe("never");
  });

  test("legacy boolean toggle migrates: 1 -> always, 0/absent -> auto", () => {
    expect(resolveVoicePref("1")).toBe("always");
    expect(resolveVoicePref("0")).toBe("auto");
    expect(resolveVoicePref(undefined)).toBe("auto");
  });

  test("junk values fail safe to auto", () => {
    expect(resolveVoicePref("yes")).toBe("auto");
    expect(resolveVoicePref("")).toBe("auto");
  });
});

describe("decideReplyModality", () => {
  const base = { pref: "auto" as VoicePref, inputWasVoice: true, chatType: "private", ttsConfigured: true };

  test("auto mirrors the input: voice in -> voice out, text in -> text out", () => {
    expect(decideReplyModality(base)).toBe("voice");
    expect(decideReplyModality({ ...base, inputWasVoice: false })).toBe("text");
  });

  test("auto in a group stays text even for voice input", () => {
    for (const chatType of ["group", "supergroup", "channel"]) {
      expect(decideReplyModality({ ...base, chatType })).toBe("text");
    }
  });

  test("always voices everything, everywhere — explicit user choice", () => {
    expect(decideReplyModality({ ...base, pref: "always", chatType: "supergroup" })).toBe("voice");
    expect(decideReplyModality({ ...base, pref: "always", inputWasVoice: false })).toBe("voice");
  });

  test("never is always text", () => {
    expect(decideReplyModality({ ...base, pref: "never" })).toBe("text");
  });

  test("TTS unconfigured is always text", () => {
    expect(decideReplyModality({ ...base, ttsConfigured: false })).toBe("text");
    expect(decideReplyModality({ ...base, pref: "always", ttsConfigured: false })).toBe("text");
  });
});

describe("parseVoiceArg", () => {
  test("accepts the three canonical values case-insensitively", () => {
    expect(parseVoiceArg("auto")).toBe("auto");
    expect(parseVoiceArg("Always")).toBe("always");
    expect(parseVoiceArg(" NEVER ")).toBe("never");
  });

  test("rejects junk and the legacy booleans", () => {
    expect(parseVoiceArg("maybe")).toBeUndefined();
    expect(parseVoiceArg("1")).toBeUndefined();
    expect(parseVoiceArg("")).toBeUndefined();
    expect(parseVoiceArg(undefined)).toBeUndefined();
  });
});

describe("voice picker callbacks", () => {
  test("the three canonical callbacks parse", () => {
    expect(voiceValueForCallback(VOICE_CALLBACKS.auto)).toBe("auto");
    expect(voiceValueForCallback(VOICE_CALLBACKS.always)).toBe("always");
    expect(voiceValueForCallback(VOICE_CALLBACKS.never)).toBe("never");
  });

  test("junk picker data is rejected", () => {
    expect(voiceValueForCallback("voice:maybe")).toBeUndefined();
    expect(voiceValueForCallback("lang:fa")).toBeUndefined();
  });

  test("isVoiceCallback routes by prefix so junk reaches the rejecting handler", () => {
    expect(isVoiceCallback("voice:auto")).toBe(true);
    expect(isVoiceCallback("voice:maybe")).toBe(true);
    expect(isVoiceCallback("lang:fa")).toBe(false);
  });

  test("the picker keyboard carries the three canonical callbacks", () => {
    const kb = buildVoiceKeyboard("fa");
    const data = JSON.stringify(kb);
    expect(data).toContain(VOICE_CALLBACKS.auto);
    expect(data).toContain(VOICE_CALLBACKS.always);
    expect(data).toContain(VOICE_CALLBACKS.never);
  });
});

describe("deliverReply", () => {
  test("auto: voice input in a private chat gets a voice reply", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("auto") },
      "7",
      ["a", "b"],
      okSynth(),
      { inputWasVoice: true, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["voice", "voice"]);
  });

  test("auto: text input gets a text reply", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("auto") },
      "7",
      ["a", "b"],
      okSynth(),
      { inputWasVoice: false, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["text", "text"]);
    expect(sent.map((s) => s.body)).toEqual(["a", "b"]);
  });

  test("auto: a voice note in a group gets a text reply (no group noise)", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("auto") },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: true, chatType: "supergroup" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["text"]);
  });

  test("always: every reply is voice, even text input in a group", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("always") },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: false, chatType: "supergroup" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["voice"]);
  });

  test("never: a voice note gets a text reply", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("never") },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: true, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["text"]);
  });

  test("legacy pref '1' migrates to always: text input is voiced", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("1") },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: false, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["voice"]);
  });

  test("legacy pref '0' migrates to auto: voice input is mirrored", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("0") },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: true, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["voice"]);
  });

  test("absent pref means auto: text stays text", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("") },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: false, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["text"]);
  });

  test("an upload_voice chat action runs while synthesising", async () => {
    const sent: Sent = [];
    const actions: string[] = [];
    await deliverReply(
      fakeCtx(sent, {
        chat: { id: 9 },
        api: {
          sendChatAction: async (chatId, action) => {
            actions.push(`${String(chatId)}:${action}`);
            return undefined;
          },
        },
      }),
      { tts: TTS, prefs: prefsWith("always") },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: false, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["voice"]);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0]).toBe("9:upload_voice");
  });

  test("a TTS failure falls back to all text chunks plus one note in the sender's language", async () => {
    const faSent: Sent = [];
    await deliverReply(
      fakeCtx(faSent),
      { tts: TTS, prefs: prefsWith("always") },
      "7",
      ["a", "b"],
      failingSynth(),
      { inputWasVoice: false, chatType: "private" },
    );
    expect(faSent.map((s) => s.kind)).toEqual(["text", "text", "text"]);
    expect(faSent[0]?.body).toBe(VOICE_FAILED_NOTE);
    expect(faSent.slice(1).map((s) => s.body)).toEqual(["a", "b"]);

    const enPrefs = prefsWith("always");
    enPrefs.setUserPref("7", "lang", "en");
    const enSent: Sent = [];
    await deliverReply(
      fakeCtx(enSent),
      { tts: TTS, prefs: enPrefs },
      "7",
      ["a"],
      failingSynth(),
      { inputWasVoice: false, chatType: "private" },
    );
    expect(enSent[0]?.body).toBe("Text-to-speech failed; sending the reply as text.");
  });

  test("chunks past the voice caps arrive as text after a truncation note", async () => {
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { tts: TTS, prefs: prefsWith("always") },
      "7",
      ["یک", "دو", "سه"],
      okSynth(),
      { inputWasVoice: false, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["voice", "voice", "text", "text"]);
    expect(sent[2]?.body).toBe(VOICE_TRUNCATED_NOTE);
    expect(sent[3]?.body).toBe("سه");
  });

  test("TTS unconfigured: a voice note gets text plus the bilingual note, once per user", async () => {
    const prefs = prefsWith("auto");
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { prefs },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: true, chatType: "private" },
    );
    expect(sent.map((s) => s.kind)).toEqual(["text", "text"]);
    expect(sent[0]?.body).toBe(
      "تبدیل متن به صدا پیکربندی نشده است؛ حالت صوتی در دسترس نیست.",
    );
    expect(sent[1]?.body).toBe("a");
    expect(prefs.getUserPref("7", VOICE_UNCONFIGURED_NOTIFIED_KEY)).toBe("1");

    // The second voice note: no more nagging, just the text reply.
    const sent2: Sent = [];
    await deliverReply(
      fakeCtx(sent2),
      { prefs },
      "7",
      ["b"],
      okSynth(),
      { inputWasVoice: true, chatType: "private" },
    );
    expect(sent2.map((s) => s.body)).toEqual(["b"]);
  });

  test("TTS unconfigured: text users never see the note", async () => {
    const prefs = prefsWith("auto");
    const sent: Sent = [];
    await deliverReply(
      fakeCtx(sent),
      { prefs },
      "7",
      ["a"],
      okSynth(),
      { inputWasVoice: false, chatType: "private" },
    );
    expect(sent.map((s) => s.body)).toEqual(["a"]);
    expect(prefs.getUserPref("7", VOICE_UNCONFIGURED_NOTIFIED_KEY)).toBeUndefined();
  });
});

// ---------- /voice: the 3-way preference ----------

function fakeVoiceCtx(replies: string[]) {
  return {
    from: { id: 7 },
    reply: async (text: string) => {
      replies.push(text);
    },
  };
}

function fakePickerCtx() {
  const calls: Array<{ text: string; markup: unknown }> = [];
  return {
    calls,
    ctx: {
      from: { id: 7 },
      reply: async (text: string, extra?: { reply_markup: unknown }) => {
        calls.push({ text, markup: extra?.reply_markup });
      },
    },
  };
}

function fakeCallbackCtx() {
  const answered: string[] = [];
  const replies: string[] = [];
  return {
    answered,
    replies,
    ctx: {
      from: { id: 7 },
      answerCallbackQuery: async (text?: string) => {
        answered.push(text ?? "");
      },
      reply: async (text: string) => {
        replies.push(text);
      },
    },
  };
}

describe("handleVoiceCommand", () => {
  test("reports not-configured and does not set the pref when TTS is absent", async () => {
    const replies: string[] = [];
    const store = prefsWith("auto");
    const env: VoiceCommandEnv = { prefs: store };
    await handleVoiceCommand(fakeVoiceCtx(replies), env);
    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("پیکربندی نشده");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("auto");
  });

  test("does not set the pref when baseUrl is empty", async () => {
    const replies: string[] = [];
    const store = prefsWith("auto");
    await handleVoiceCommand(fakeVoiceCtx(replies), { tts: { ...TTS, baseUrl: "" }, prefs: store }, "fa", "always");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("auto");
  });

  test("/voice always|never|auto sets the pref with a confirmation", async () => {
    const store = prefsWith("auto");
    const env: VoiceCommandEnv = { tts: TTS, prefs: store };

    const r1: string[] = [];
    await handleVoiceCommand(fakeVoiceCtx(r1), env, "fa", "always");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("always");
    expect(r1[0]).toContain("همیشه");

    const r2: string[] = [];
    await handleVoiceCommand(fakeVoiceCtx(r2), env, "fa", "never");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("never");
    expect(r2[0]).toContain("هرگز");

    const r3: string[] = [];
    await handleVoiceCommand(fakeVoiceCtx(r3), env, "en", "auto");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("auto");
    expect(r3[0]).toContain("auto");
  });

  test("an unknown argument is rejected without touching the pref", async () => {
    const replies: string[] = [];
    const store = prefsWith("auto");
    const env: VoiceCommandEnv = { tts: TTS, prefs: store };
    await handleVoiceCommand(fakeVoiceCtx(replies), env, "fa", "maybe");
    expect(replies[0]).toContain("نامعتبر");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("auto");
  });

  test("bare /voice shows the current mode with the picker keyboard", async () => {
    const { calls, ctx } = fakePickerCtx();
    const store = prefsWith("always");
    const env: VoiceCommandEnv = { tts: TTS, prefs: store };
    await handleVoiceCommand(ctx, env, "fa");
    expect(calls.length).toBe(1);
    expect(calls[0]?.text).toContain("همیشه");
    expect(calls[0]?.markup).toBeDefined();
  });

  test("bare /voice defaults to auto when nothing is stored", async () => {
    const { calls, ctx } = fakePickerCtx();
    const store = prefsWith("");
    const env: VoiceCommandEnv = { tts: TTS, prefs: store };
    await handleVoiceCommand(ctx, env, "en");
    expect(calls[0]?.text).toContain("auto");
  });

  test("a storage failure keeps the old value and reports it", async () => {
    const replies: string[] = [];
    const store: UserPrefStore = {
      getUserPref: () => "auto",
      setUserPref: () => {
        throw new Error("disk full");
      },
    };
    await handleVoiceCommand(fakeVoiceCtx(replies), { tts: TTS, prefs: store }, "fa", "never");
    expect(replies[0]).toContain("ناموفق بود");
  });
});

describe("handleVoiceCallback", () => {
  test("a picker tap persists the canonical value with a confirmation", async () => {
    const { answered, replies, ctx } = fakeCallbackCtx();
    const store = prefsWith("auto");
    const env: VoiceCommandEnv = { tts: TTS, prefs: store };
    await handleVoiceCallback(ctx, env, VOICE_CALLBACKS.always, "fa");
    expect(answered.length).toBe(1);
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("always");
    expect(replies[0]).toContain("همیشه");
  });

  test("junk picker data is rejected without touching the store", async () => {
    const { replies, ctx } = fakeCallbackCtx();
    const store = prefsWith("auto");
    const env: VoiceCommandEnv = { tts: TTS, prefs: store };
    await handleVoiceCallback(ctx, env, "voice:maybe", "en");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("auto");
    expect(replies[0]).toContain("Unknown option");
  });

  test("a tap with TTS unconfigured reports it and does not persist", async () => {
    const { replies, ctx } = fakeCallbackCtx();
    const store = prefsWith("auto");
    await handleVoiceCallback(ctx, { prefs: store }, VOICE_CALLBACKS.never, "fa");
    expect(store.getUserPref("7", VOICE_MODE_KEY)).toBe("auto");
    expect(replies[0]).toContain("پیکربندی نشده");
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
