/**
 * /lang end-to-end: after the language switch, every surface the bot renders
 * through the shared i18n infrastructure must speak the new language.
 *
 * The journey: default (fa) → /lang → pick English → assert help, menus,
 * menu replies, tool list, empty states and gate denials all render in
 * English → switch back → assert Persian again.
 *
 * The assertions are deliberately layout-agnostic (button counts and menu
 * structure belong to the menu owner): they check the LANGUAGE of each
 * surface, plus exact text for the central-pack keys this package owns.
 * No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { t, resolveLang, LANG_PREF_KEY, type Lang } from "../src/i18n";
import { buildMainMenu, replyForCallback, toolListText, CALLBACKS } from "../src/bot/menu";
import {
  formatCommandHelp,
  visibleCommandHelp,
  handleLangCommand,
  handleLangCallback,
  type LangCommandEnv,
} from "../src/bot/bot";

const ARABIC_RE = /[\u0600-\u06FF]/; // \u0600-\u06FF: Persian/Arabic script block

function makePrefs(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getUserPref: (userId: string, key: string) => store.get(`${userId}:${key}`),
    setUserPref: (userId: string, key: string, value: string) => {
      store.set(`${userId}:${key}`, value);
    },
  };
}

type Prefs = ReturnType<typeof makePrefs>;

function makeCtx(prefs: Prefs) {
  const env: LangCommandEnv = { prefs };
  const replies: string[] = [];
  const ctx = {
    from: { id: 7 },
    reply: async (text: string) => {
      replies.push(text);
    },
    answerCallbackQuery: async () => {},
  };
  return { env, ctx, replies };
}

/** The language the bot would use for this user right now. */
function currentLang(prefs: Prefs): Lang {
  return resolveLang("7", (uid, key) => prefs.getUserPref(uid, key));
}

/** Flat list of every button label on the main menu. */
function menuButtonTexts(lang: Lang): string[] {
  return buildMainMenu(lang)
    .inline_keyboard.flat(2)
    .map((b) => (b as { text: string }).text);
}

/** Every user-facing surface rendered for the language, as flat strings. */
function renderAllSurfaces(lang: Lang): [string, string][] {
  return [
    ["help", formatCommandHelp(visibleCommandHelp(false), lang)],
    ...menuButtonTexts(lang).map((t2, i) => [`menu.button[${i}]`, t2] as [string, string]),
    ["reply.chat", replyForCallback(CALLBACKS.chat, undefined, lang)],
    ["reply.about", replyForCallback(CALLBACKS.about, undefined, lang)],
    ["reply.unknown", replyForCallback("menu:nope", undefined, lang)],
    ["tools.empty", toolListText([], lang)],
    ["tools.list", replyForCallback(CALLBACKS.tools, ["calculator"], lang)],
    ["gate.group", t("gate.group_not_ready", lang)],
    ["gate.user.pending", t("gate.user_not_approved", lang)],
    ["gate.user.revoked", t("gate.user_revoked", lang)],
    ["lang.prompt", t("lang.prompt", lang)],
  ];
}

describe("/lang end-to-end: the full switch journey", () => {
  test("default is Persian; every surface renders fa", () => {
    const prefs = makePrefs();
    expect(currentLang(prefs)).toBe("fa");
    const surfaces = renderAllSurfaces("fa");
    const help = surfaces.find(([n]) => n === "help")![1];
    expect(help).toContain(t("help.title", "fa"));
    // The central-pack surfaces are exact.
    expect(surfaces.find(([n]) => n === "tools.empty")![1]).toBe(t("menu.tools.empty", "fa"));
    expect(surfaces.find(([n]) => n === "gate.group")![1]).toBe(t("gate.group_not_ready", "fa"));
    expect(surfaces.find(([n]) => n === "gate.user.pending")![1]).toBe(
      t("gate.user_not_approved", "fa"),
    );
    expect(surfaces.find(([n]) => n === "gate.user.revoked")![1]).toBe(t("gate.user_revoked", "fa"));
    // Menu buttons are Persian (whatever their current layout).
    const buttons = menuButtonTexts("fa");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.some((b) => ARABIC_RE.test(b))).toBe(true);
  });

  test("picking English flips every surface to en", async () => {
    const prefs = makePrefs();
    const { env, ctx, replies } = makeCtx(prefs);

    await handleLangCommand(ctx, env, "fa");
    expect(replies[0]).toBe(t("lang.prompt", "fa"));

    await handleLangCallback(ctx, env, "lang:en", "fa");
    expect(prefs.getUserPref("7", LANG_PREF_KEY)).toBe("en");
    // The confirmation itself is already in the NEW language.
    expect(replies[1]).toBe(t("lang.changed", "en", { label: "English" }));
    expect(currentLang(prefs)).toBe("en");

    const surfaces = renderAllSurfaces("en");
    const help = surfaces.find(([n]) => n === "help")![1];
    expect(help).toContain(t("help.title", "en"));
    // Central-pack surfaces are exact.
    expect(surfaces.find(([n]) => n === "tools.empty")![1]).toBe(t("menu.tools.empty", "en"));
    expect(surfaces.find(([n]) => n === "gate.group")![1]).toBe(t("gate.group_not_ready", "en"));
    expect(surfaces.find(([n]) => n === "gate.user.pending")![1]).toBe(
      t("gate.user_not_approved", "en"),
    );
    expect(surfaces.find(([n]) => n === "gate.user.revoked")![1]).toBe(t("gate.user_revoked", "en"));
    expect(surfaces.find(([n]) => n === "lang.prompt")![1]).toBe(t("lang.prompt", "en"));

    // No surface leaks Persian once English is active.
    for (const [name, text] of surfaces) {
      expect(text, `surface ${name} leaks Persian`).not.toMatch(ARABIC_RE);
    }
  });

  test("switching back restores Persian everywhere", async () => {
    const prefs = makePrefs({ "7:lang": "en" });
    const { env, ctx, replies } = makeCtx(prefs);

    await handleLangCallback(ctx, env, "lang:fa", "en");
    expect(prefs.getUserPref("7", LANG_PREF_KEY)).toBe("fa");
    expect(replies[0]).toBe(t("lang.changed", "fa", { label: "فارسی" }));
    expect(currentLang(prefs)).toBe("fa");

    const surfaces = renderAllSurfaces("fa");
    expect(surfaces.find(([n]) => n === "help")![1]).toContain(t("help.title", "fa"));
    expect(surfaces.find(([n]) => n === "gate.user.revoked")![1]).toBe(t("gate.user_revoked", "fa"));
    const buttons = menuButtonTexts("fa");
    expect(buttons.some((b) => ARABIC_RE.test(b))).toBe(true);
  });

  test("a forged picker value never changes the language", async () => {
    const prefs = makePrefs();
    const { env, ctx, replies } = makeCtx(prefs);
    for (const junk of ["lang:de", "lang:FA", "lang:", "lang:en "] as const) {
      await handleLangCallback(ctx, env, junk, "fa");
    }
    expect(prefs.getUserPref("7", LANG_PREF_KEY)).toBeUndefined();
    expect(currentLang(prefs)).toBe("fa");
    for (const r of replies) expect(r).toBe(t("lang.unknown", "fa"));
  });

  test("a tampered pref value can never select a non-existent pack", () => {
    const prefs = makePrefs();
    const read = (uid: string, key: string) => prefs.getUserPref(uid, key);
    for (const junk of ["de", "EN", "en ", "fa ", "english", "1", ""]) {
      prefs.setUserPref("7", LANG_PREF_KEY, junk);
      const lang = resolveLang("7", read);
      expect(lang).toBe("fa");
      // …and t() with that lang still renders a real string, never blank.
      expect(t("help.title", lang).length).toBeGreaterThan(0);
    }
  });
});
