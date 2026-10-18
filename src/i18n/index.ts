/**
 * i18n entry point (D5).
 *
 * `t(key, lang, vars)` looks a key up in the requested pack and falls back to
 * the Persian pack, then to the key itself — so a missing translation degrades
 * to Persian, never to an empty string.
 *
 * SECURITY:
 * - `lang` is validated by resolveLang(): only "fa" | "en" ever reach t()
 *   from user state; raw user text is never used as a language.
 * - Interpolation values are server-side only (command names, counts,
 *   owner-configured labels). User-controlled text is never interpolated
 *   into these templates, so no escaping layer is needed.
 */
import { fa } from "./fa";
import { en } from "./en";
import type { Lang, LanguagePack } from "./types";

export type { Lang, LanguagePack };
export { fa, en };

const PACKS: Record<Lang, LanguagePack> = { fa, en };

/** The user_prefs key holding a user's UI language. */
export const LANG_PREF_KEY = "lang";

/**
 * Translate a key.
 *
 * Falls back to the Persian pack for unknown keys, and to the key itself when
 * even Persian has no entry (a bug, but never a blank reply). `{name}`-style
 * placeholders are replaced from `vars`; a placeholder with no value is left
 * as-is rather than blanked.
 */
export function t(
  key: string,
  lang: Lang = "fa",
  vars?: Record<string, string | number>,
): string {
  const pack = PACKS[lang] ?? PACKS.fa;
  let text = pack[key] ?? PACKS.fa[key] ?? key;
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Minimal preference reader, so resolveLang works with any pref store. */
export type GetUserPref = (userId: string, key: string) => string | undefined;

/**
 * Resolve a user's UI language from user_prefs.
 *
 * Only the exact string "en" selects English; anything else — missing,
 * blank, or junk — falls back to Persian. Fail-closed and total: a corrupt
 * or hostile pref value can never select a pack that does not exist. A
 * throwing reader also falls back to Persian rather than breaking the reply.
 */
export function resolveLang(userId: string, getUserPref: GetUserPref): Lang {
  let raw: string | undefined;
  try {
    raw = getUserPref(userId, LANG_PREF_KEY);
  } catch {
    return "fa";
  }
  return raw === "en" ? "en" : "fa";
}
