/**
 * i18n entry point (D5).
 *
 * English-only since v1.0: `t(key, lang, vars)` looks a key up in the English
 * pack and falls back to the key itself — so a missing translation degrades
 * to the key, never to an empty string. The `lang` parameter is kept so
 * existing call sites keep compiling; it no longer selects a language.
 *
 * SECURITY:
 * - Interpolation values are server-side only (command names, counts,
 *   owner-configured labels). User-controlled text is never interpolated
 *   into these templates, so no escaping layer is needed.
 */
import { en } from "./en";
import type { Lang, LanguagePack } from "./types";

export type { Lang, LanguagePack };
export { en };

/**
 * The user_prefs key that used to hold a user's UI language (pre-v1.0).
 * Kept exported: onboarding still references it until its own migration.
 */
export const LANG_PREF_KEY = "lang";

/**
 * Translate a key.
 *
 * Falls back to the key itself when English has no entry (a bug, but never a
 * blank reply). `{name}`-style placeholders are replaced from `vars`; a
 * placeholder with no value is left as-is rather than blanked.
 */
export function t(
  key: string,
  lang: Lang = "en",
  vars?: Record<string, string | number>,
): string {
  void lang; // English-only: accepted for call-site compatibility.
  let text = en[key] ?? key;
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** Minimal preference reader, kept for resolveLang's signature compatibility. */
export type GetUserPref = (userId: string, key: string) => string | undefined;

/**
 * Resolve a user's UI language. English-only since v1.0: always "en".
 * Kept (rather than removed) because several modules still call it; their
 * owners drop the calls in their own migrations.
 */
export function resolveLang(_userId: string, _getUserPref: GetUserPref): Lang {
  return "en";
}
