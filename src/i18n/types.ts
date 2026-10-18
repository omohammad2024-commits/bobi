/** Language-pack types (D5). */

/** The languages BOBI speaks to users. Persian is the default. */
export type Lang = "fa" | "en";

/**
 * A language pack: UI string key → translated text.
 *
 * Placeholders use the {name} form and are filled by t() from server-side
 * values only (names, numbers) — never from raw user text.
 */
export type LanguagePack = Record<string, string>;
