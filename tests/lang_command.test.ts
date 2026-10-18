/**
 * Tests for the /lang command (D5 follow-up).
 *
 * /lang shows a language picker (فارسی / English buttons); clicking a button
 * persists the choice in user_prefs under LANG_PREF_KEY ("lang"), and
 * resolveLang picks it up. Junk callback data is rejected without touching
 * prefs. No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { t, resolveLang, LANG_PREF_KEY, fa } from "../src/i18n";
import {
  LANG_CALLBACKS,
  isLangCallback,
  buildLangKeyboard,
} from "../src/bot/menu";
import {
  handleLangCommand,
  handleLangCallback,
  langValueForCallback,
  type LangCommandEnv,
} from "../src/bot/bot";

/** In-memory pref store mirroring the bot's UserPrefStore shape. */
function makePrefs(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getUserPref: (userId: string, key: string) =>
      store.get(`${userId}:${key}`),
    setUserPref: (userId: string, key: string, value: string) => {
      store.set(`${userId}:${key}`, value);
    },
    raw: store,
  };
}

type Prefs = ReturnType<typeof makePrefs>;

function makeCtx(prefs: Prefs) {
  const env: LangCommandEnv = { prefs };
  const replies: string[] = [];
  const keyboards: unknown[] = [];
  let answered = 0;
  const ctx = {
    from: { id: 42 },
    reply: async (text: string, extra?: { reply_markup: unknown }) => {
      replies.push(text);
      if (extra?.reply_markup !== undefined) keyboards.push(extra.reply_markup);
    },
    answerCallbackQuery: async () => {
      answered++;
    },
  };
  return { env, ctx, replies, keyboards, answered: () => answered };
}

// ---------------------------------------------------------------------------
// Picker keyboard + callback routing
// ---------------------------------------------------------------------------

describe("/lang picker", () => {
  test("callback data is stable and namespaced", () => {
    expect(LANG_CALLBACKS.fa).toBe("lang:fa");
    expect(LANG_CALLBACKS.en).toBe("lang:en");
  });

  test("isLangCallback matches the namespace, including junk", () => {
    expect(isLangCallback("lang:fa")).toBe(true);
    expect(isLangCallback("lang:de")).toBe(true);
    expect(isLangCallback("menu:chat")).toBe(false);
    expect(isLangCallback("")).toBe(false);
  });

  test("langValueForCallback accepts only the two canonical values", () => {
    expect(langValueForCallback("lang:fa")).toBe("fa");
    expect(langValueForCallback("lang:en")).toBe("en");
    expect(langValueForCallback("lang:de")).toBeUndefined();
    expect(langValueForCallback("lang:")).toBeUndefined();
    expect(langValueForCallback("lang:FA")).toBeUndefined();
    expect(langValueForCallback("")).toBeUndefined();
    expect(langValueForCallback("menu:chat")).toBeUndefined();
  });

  test("keyboard has فارسی / English buttons", () => {
    const kb = buildLangKeyboard("fa");
    expect(kb.inline_keyboard).toEqual([
      [
        { text: "فارسی", callback_data: "lang:fa" },
        { text: "English", callback_data: "lang:en" },
      ],
    ]);
  });

  test("/lang replies with the prompt and the keyboard", async () => {
    const prefs = makePrefs();
    const { env, ctx, replies, keyboards } = makeCtx(prefs);
    await handleLangCommand(ctx, env, "fa");
    expect(replies).toEqual([t("lang.prompt", "fa")]);
    expect(keyboards).toHaveLength(1);
    expect(
      (keyboards[0] as { inline_keyboard: unknown }).inline_keyboard,
    ).toEqual(buildLangKeyboard("fa").inline_keyboard);
  });

  test("/lang reports unavailability when prefs are absent", async () => {
    const prefs = makePrefs();
    const { ctx, replies } = makeCtx(prefs);
    await handleLangCommand(ctx, { prefs: undefined as never }, "fa");
    expect(replies).toEqual([t("lang.unavailable", "fa")]);
  });

  test("/lang is silent without a sender", async () => {
    const prefs = makePrefs();
    const env: LangCommandEnv = { prefs };
    const replies: string[] = [];
    await handleLangCommand({ reply: async (t: string) => replies.push(t) }, env, "fa");
    expect(replies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Persisting the choice
// ---------------------------------------------------------------------------

describe("/lang persistence", () => {
  test('picking English writes "en", then picking فارسی writes "fa"', async () => {
    const prefs = makePrefs();
    const { env, ctx, replies, answered } = makeCtx(prefs);
    const key = (uid: string) => `${uid}:${LANG_PREF_KEY}`;

    await handleLangCallback(ctx, env, "lang:en", "fa");
    expect(prefs.raw.get(key("42"))).toBe("en");
    expect(answered()).toBe(1);
    // Confirmation is in the NEW language.
    expect(replies).toEqual([t("lang.changed", "en", { label: "English" })]);

    await handleLangCallback(ctx, env, "lang:fa", "en");
    expect(prefs.raw.get(key("42"))).toBe("fa");
    expect(replies[1]).toBe(t("lang.changed", "fa", { label: "فارسی" }));
  });

  test("junk callback data is rejected and the pref is untouched", async () => {
    const prefs = makePrefs();
    const { env, ctx, replies, answered } = makeCtx(prefs);

    for (const junk of ["lang:de", "lang:", "lang:FA ", "lang:fa\n", "en"]) {
      await handleLangCallback(ctx, env, junk, "fa");
    }
    expect(prefs.raw.size).toBe(0);
    expect(answered()).toBe(5);
    for (const r of replies) {
      expect(r).toBe(t("lang.unknown", "fa"));
    }
  });

  test("callback without prefs store reports unavailability", async () => {
    const { ctx, replies } = makeCtx(makePrefs());
    await handleLangCallback(ctx, { prefs: undefined as never }, "lang:en", "fa");
    expect(replies).toEqual([t("lang.unavailable", "fa")]);
  });

  test("a throwing pref write surfaces the shared save-failed note", async () => {
    const env: LangCommandEnv = {
      prefs: {
        getUserPref: () => undefined,
        setUserPref: () => {
          throw new Error("disk gone");
        },
      },
    };
    const { ctx, replies } = makeCtx(makePrefs());
    await handleLangCallback(ctx, env, "lang:en", "fa");
    expect(replies).toEqual([t("prefs.save_failed", "fa")]);
  });
});

// ---------------------------------------------------------------------------
// resolveLang picks up the new pref
// ---------------------------------------------------------------------------

describe("resolveLang with the /lang pref", () => {
  test("defaults to fa, follows en, rejects junk", () => {
    const prefs = makePrefs();
    const read = (uid: string, key: string) => prefs.getUserPref(uid, key);
    expect(resolveLang("1", read)).toBe("fa");
    prefs.setUserPref("1", LANG_PREF_KEY, "en");
    expect(resolveLang("1", read)).toBe("en");
    prefs.setUserPref("1", LANG_PREF_KEY, "de");
    expect(resolveLang("1", read)).toBe("fa");
    prefs.setUserPref("1", LANG_PREF_KEY, "en ");
    expect(resolveLang("1", read)).toBe("fa");
    prefs.setUserPref("1", LANG_PREF_KEY, "fa");
    expect(resolveLang("1", read)).toBe("fa");
  });

  test("LANG_PREF_KEY is exactly what handleLangCallback writes", () => {
    expect(LANG_PREF_KEY).toBe("lang");
  });
});

// ---------------------------------------------------------------------------
// fa byte-identity still holds (the pack only grew)
// ---------------------------------------------------------------------------

describe("fa pack byte-identity", () => {
  test("pre-existing keys are untouched", () => {
    expect(fa["menu.label.chat"]).toBe("گفت‌وگو");
    expect(fa["personality.changed"]).toBe("شخصیت پاسخ‌گویی به «{label}» تغییر کرد.");
    expect(fa["help.cmd.voice"]).toBe("روشن/خاموش کردن پاسخ صوتی");
    expect(fa["stop.done"]).toBe("متوقف شد ✅");
  });

  test("the new lang keys exist in fa and read naturally", () => {
    expect(fa["lang.prompt"]).toBe("زبان رابط کاربری را انتخاب کن:");
    expect(fa["lang.label.fa"]).toBe("فارسی");
    expect(fa["lang.label.en"]).toBe("English");
  });
});
