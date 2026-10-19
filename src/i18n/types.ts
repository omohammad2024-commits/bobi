/** Language-pack types (D5). */

/**
 * The language BOBI speaks to users. English-only since v1.0: the `lang`
 * parameter survives on t() and the helper signatures so existing call sites
 * keep compiling, but it no longer selects anything.
 */
export type Lang = "en";

/**
 * A language pack: UI string key → translated text.
 *
 * Placeholders use the {name} form and are filled by t() from server-side
 * values only (names, numbers) — never from raw user text.
 */
export type LanguagePack = Record<string, string>;
