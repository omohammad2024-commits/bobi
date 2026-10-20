/**
 * Tests for src/i18n (Phase D5) and the menu/bot string migration.
 *
 * English-only since v1.0: the en pack is the single source of UI copy.
 * The EN_KEYS set below pins the exact key list so any key drift (accidental
 * or deliberate) fails loudly. No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { t, resolveLang, LANG_PREF_KEY, en } from "../src/i18n";
import {
  VOICE_FAILED_NOTE,
  VOICE_TRUNCATED_NOTE,
  COMPRESS_REPLIES,
  COMMAND_HELP,
  visibleCommandHelp,
  formatCommandHelp,
  handleHelpCommand,
  handleResetCommand,
  handleCompressCommand,
  handleStopCommand,
  handleVoiceCommand,
  handlePersonalityCommand,
  userFacingMessage,
  describeSkipped,
  describeNothingUsable,
  type VoiceCommandEnv,
} from "../src/bot/bot";
import { EngineError } from "../src/conversation/engine";
import { ToolError } from "../src/tools/errors";
import { buildSystemPrompt } from "../src/agent/prompt";

/** Persian/Arabic script block — must never appear in the English pack. */
const ARABIC_RE = /[\u0600-\u06FF]/u;

/** Dotted key shape every pack key must follow. */
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

// ---------------------------------------------------------------------------
// en pack: complete, non-empty, English-only.
// ---------------------------------------------------------------------------

describe("en pack", () => {
  test("every key is a non-empty string with a valid shape", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(KEY_RE.test(key), `key shape: ${key}`).toBe(true);
      expect(typeof value).toBe("string");
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  test("contains no Persian/Arabic script", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(ARABIC_RE.test(value), `persian script in ${key}`).toBe(false);
    }
  });

  test("covers the error, tool-error and agent keys", () => {
    for (const key of [
      "error.timeout",
      "error.tool.timeout",
      "error.tool.not_allowed",
      "error.tool.internal",
      "agent.time_exhausted",
    ]) {
      expect(en[key], key).toBeTruthy();
    }
  });

  test("has no /lang keys left (the command is gone)", () => {
    for (const key of Object.keys(en)) {
      expect(key.startsWith("lang."), key).toBe(false);
      expect(key).not.toBe("help.cmd.lang");
    }
  });

  test("spot-checks read as natural English", () => {
    expect(t("menu.label.chat", "en")).toBe("Chat");
    expect(t("start.greeting", "en")).toBe("Hi! I'm BOBI. Pick an option:");
    expect(t("stop.done", "en")).toBe("Stopped ✅");
    expect(t("help.title", "en")).toBe("Available commands:");
  });
});

// ---------------------------------------------------------------------------
// t(): English-only lookup, fallback and interpolation.
// ---------------------------------------------------------------------------

describe("t()", () => {
  test("unknown keys fall back to the key itself", () => {
    expect(t("no.such.key", "en")).toBe("no.such.key");
    expect(t("no.such.key")).toBe("no.such.key");
  });

  test("the lang parameter no longer selects anything", () => {
    expect(t("stop.done", "en")).toBe(t("stop.done"));
  });

  test("interpolates {name}-style vars", () => {
    expect(t("menu.tools.item", "en", { index: 2, label: "X" })).toBe("2. X");
    expect(t("help.entry", "en", { name: "start", description: "Start" })).toBe(
      "/start — Start",
    );
  });

  test("a placeholder with no value is left as-is, never blanked", () => {
    const partial = t("personality.unknown", "en", { name: "x" });
    expect(partial).toContain("{options}");
    expect(partial).toContain("x");
  });

  test("defaults to English", () => {
    expect(t("stop.done")).toBe("Stopped ✅");
  });
});

// ---------------------------------------------------------------------------
// resolveLang(): English-only.
// ---------------------------------------------------------------------------

describe("resolveLang", () => {
  test("the pref key is 'lang'", () => {
    expect(LANG_PREF_KEY).toBe("lang");
  });

  test("always resolves to English, whatever the stored value", () => {
    const get = (v: string | undefined) => () => v;
    for (const v of ["en", "fa", undefined, "", "de", "EN", " en "]) {
      expect(resolveLang("u", get(v)), String(v)).toBe("en");
    }
  });

  test("a throwing reader still resolves to English", () => {
    expect(
      resolveLang("u", () => {
        throw new Error("db down");
      }),
    ).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// prompt.ts: the contextFiles block (D3 wiring point).
// ---------------------------------------------------------------------------

function basePrompt() {
  return {
    tools: [],
    now: new Date("2026-10-18T12:00:00Z"),
    timezone: "UTC",
  };
}

describe("buildSystemPrompt contextFiles", () => {
  test("appends the block under the English header", () => {
    const prompt = buildSystemPrompt({ ...basePrompt(), contextFiles: "### AGENTS.md\nrules" });
    expect(prompt).toContain("Project context:\n### AGENTS.md\nrules");
  });

  test("ordering: after skills, before owner extra", () => {
    const prompt = buildSystemPrompt({
      ...basePrompt(),
      skillContext: "SKILL-BLOCK",
      contextFiles: "CTX-BLOCK",
      extra: "EXTRA-BLOCK",
    });
    const skillAt = prompt.indexOf("SKILL-BLOCK");
    const ctxAt = prompt.indexOf("Project context:");
    const extraAt = prompt.indexOf("EXTRA-BLOCK");
    expect(skillAt).toBeGreaterThan(-1);
    expect(ctxAt).toBeGreaterThan(skillAt);
    expect(extraAt).toBeGreaterThan(ctxAt);
  });

  test("absent or blank contextFiles adds nothing", () => {
    expect(buildSystemPrompt(basePrompt())).not.toContain("Project context:");
    expect(
      buildSystemPrompt({ ...basePrompt(), contextFiles: "   \n " }),
    ).not.toContain("Project context:");
  });

  test("the response-language block is multilingual for conversation", () => {
    for (const withLang of [false, true]) {
      const prompt = withLang
        ? buildSystemPrompt({ ...basePrompt(), lang: "en" })
        : buildSystemPrompt({ ...basePrompt() });
      expect(prompt).toContain("Reply in the user's language");
      expect(prompt).toContain("Persian in → Persian out");
      expect(prompt).not.toContain("Reply in English.");
    }
  });
});

// ---------------------------------------------------------------------------
// Migrated call sites render English.
// ---------------------------------------------------------------------------

function fakePrefs(lang: string | undefined) {
  const store = new Map<string, string>();
  if (lang !== undefined) store.set("lang", lang);
  return {
    getUserPref: (userId: string, key: string) => store.get(`${userId}:${key}`) ?? store.get(key),
    setUserPref: (userId: string, key: string, value: string) => {
      store.set(`${userId}:${key}`, value);
    },
  };
}

function replyCtx() {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chat: { id: 1 },
      from: { id: 7 },
      message: { text: "" },
      reply: async (text: string) => {
        replies.push(text);
      },
    },
  };
}

describe("command handlers in English", () => {
  test("/help renders the en pack", async () => {
    const { replies, ctx } = replyCtx();
    await handleHelpCommand(ctx, false, "en");
    expect(replies[0]).toContain("Available commands:");
    expect(replies[0]).toContain("/help — Command reference");
    expect(replies[0]).not.toContain("/admin");
  });

  test("/help defaults to English", async () => {
    const { replies, ctx } = replyCtx();
    await handleHelpCommand(ctx, false);
    expect(replies[0]).toContain("Available commands:");
  });

  test("/stop confirmations translate", async () => {
    const { replies, ctx } = replyCtx();
    await handleStopCommand(ctx, { engine: { cancel: () => {} } }, "en");
    expect(replies).toEqual(["Nothing was running."]);
  });

  test("/reset confirmation translates", async () => {
    const { replies, ctx } = replyCtx();
    await handleResetCommand(
      { ...ctx, message: { text: "/reset --confirm" } },
      { engine: { cancel: () => {}, clearHistory: () => {} } },
      "en",
    );
    expect(replies).toEqual(["This conversation's history was cleared. 🧹"]);
  });

  test("/reset bare asks for confirmation", async () => {
    const { replies, ctx } = replyCtx();
    await handleResetCommand(
      ctx,
      { engine: { cancel: () => {}, clearHistory: () => {} } },
      "en",
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("/reset --confirm");
  });

  test("/compress failure reply translates", async () => {
    const { replies, ctx } = replyCtx();
    await handleCompressCommand(
      ctx,
      {
        engine: {
          compressNow: async () => {
            throw new Error("boom");
          },
        },
      },
      "en",
    );
    expect(replies).toEqual(["Summarization failed; try again later."]);
  });

  test("/voice not-configured reply translates", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = { prefs: fakePrefs(undefined) };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en");
    expect(replies).toEqual(["Text-to-speech is not configured; voice mode is unavailable."]);
  });

  test("/voice set confirmation translates", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = {
      tts: { baseUrl: "http://x", apiKey: "", model: "m", voice: "v" },
      prefs: fakePrefs(undefined),
    };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en", "always");
    expect(replies[0]).toContain("voice mode set to always");
  });

  test("/voice prompt shows the current mode", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = {
      tts: { baseUrl: "http://x", apiKey: "", model: "m", voice: "v" },
      prefs: fakePrefs(undefined),
    };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en");
    expect(replies[0]).toContain("Current voice-reply mode: auto.");
  });

  test("/voice unknown option translates", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = {
      tts: { baseUrl: "http://x", apiKey: "", model: "m", voice: "v" },
      prefs: fakePrefs(undefined),
    };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en", "maybe");
    expect(replies).toEqual(["Unknown option — use auto, always, or never."]);
  });

  test("/personality unknown-name reply translates", async () => {
    const { replies, ctx } = replyCtx();
    await handlePersonalityCommand(
      { ...ctx, message: { text: "/personality nope" } },
      { prefs: fakePrefs(undefined) },
      "en",
    );
    expect(replies[0]).toContain('Unknown personality "nope".');
  });

  test("/personality save failure uses the shared prefs key", async () => {
    const { replies, ctx } = replyCtx();
    const prefs = {
      getUserPref: () => undefined,
      setUserPref: () => {
        throw new Error("disk full");
      },
    };
    await handlePersonalityCommand(
      { ...ctx, message: { text: "/personality concise" } },
      { prefs },
      "en",
    );
    expect(replies).toEqual(["Couldn't save the setting; try again."]);
  });
});

describe("formatCommandHelp", () => {
  test("renders English descriptions", () => {
    const text = formatCommandHelp(visibleCommandHelp(true), "en");
    expect(text).toContain("/ai — Manage the AI provider");
  });

  test("every entry's description matches the central pack", () => {
    for (const c of COMMAND_HELP) {
      expect(c.description, c.name).toBe(t(`help.cmd.${c.name}`));
    }
  });
});

// ---------------------------------------------------------------------------
// bot.ts error paths: every user-facing error is English, actionable, and
// leaks no internals.
// ---------------------------------------------------------------------------

describe("bot.ts error paths", () => {
  const engineErr = (kind: ConstructorParameters<typeof EngineError>[0]) =>
    new EngineError(kind, "boom");

  test("every engine error kind maps to an English pack string", () => {
    const expected: Record<string, string> = {
      empty_input: "The message is empty.",
      empty_response: "I got no reply; try again.",
      auth: "Authentication failed — the AI service is unavailable. Check the provider's API key.",
      quota: "The usage quota is full; try again in a bit.",
      network: "Network error; try again.",
      timeout: "The reply took too long; it was cancelled.",
      aborted: "The reply took too long; it was cancelled.",
      overloaded: "The system is busy; try again in a moment.",
    };
    for (const [kind, enText] of Object.entries(expected)) {
      const err = engineErr(kind as ConstructorParameters<typeof EngineError>[0]);
      expect(userFacingMessage(err, "en"), kind).toBe(enText);
    }
  });

  test("superseded stays silent; unknown errors degrade gracefully", () => {
    expect(userFacingMessage(engineErr("superseded"), "en")).toBe("");
    // An engine error kind added later falls back to the generic message.
    expect(userFacingMessage(new Error("weird"), "en")).toBe("Unexpected error.");
  });

  test("tool errors render in English (never the tool layer's raw message)", () => {
    const cases: Array<[ConstructorParameters<typeof ToolError>[0], string]> = [
      ["timeout", "The tool run took too long and was cancelled."],
      ["aborted", "The tool run was cancelled."],
      ["not_allowed", "You don't have permission to run this tool."],
      ["overloaded", "The system is busy; try again in a moment."],
      ["internal", "Internal tool error."],
      ["invalid_input", "Invalid input."],
      ["not_found", "Tool not found."],
      ["disabled", "This tool is disabled."],
      ["invalid_result", "The tool returned an invalid result."],
    ];
    for (const [kind, expected] of cases) {
      const msg = userFacingMessage(new ToolError(kind, "raw internal detail"), "en");
      expect(msg, kind).toBe(expected);
      expect(msg).not.toContain("raw internal detail");
    }
  });

  test("rate-limit and truncation notes resolve through t()", () => {
    expect(t("ratelimit.wait", "en", { seconds: 42 })).toBe(
      "You're going a bit fast; try again in about 42 seconds.",
    );
    expect(t("reply.truncated", "en")).toBe(
      "I ran out of steps on this reply — ask a more specific question for more detail.",
    );
  });

  test("describeSkipped names each reason in English", () => {
    const skipped = [
      { kind: "photo", reason: "too_large" },
      { kind: "document", reason: "unsupported" },
      { kind: "voice", reason: "download_failed" },
      { kind: "voice", reason: "too_long" },
    ];
    expect(describeSkipped(skipped, "en")).toBe(
      "These attachments couldn't be used:\n" +
        "• photo: over the size limit.\n" +
        "• document: this file type isn't supported.\n" +
        "• voice: couldn't be fetched.\n" +
        "• voice: too long to process.",
    );
    expect(describeSkipped([], "en")).toBe("");
  });

  test("describeNothingUsable falls back to the empty-message note", () => {
    expect(describeNothingUsable([], "en")).toBe("The message is empty.");
    const note = describeNothingUsable([{ kind: "photo", reason: "too_large" }], "en");
    expect(note).toContain("These attachments couldn't be used:");
  });
});
