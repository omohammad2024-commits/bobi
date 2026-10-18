/**
 * Built-in personality skins (Phase G1).
 *
 * A skin is owner-shipped DATA, not user input. Each skin carries a short
 * `systemAddition` (1-3 sentences) that is APPENDED to the system prompt; it
 * never replaces it. The canonical skin names are the only strings that may
 * ever reach the prompt — every lookup goes through `getPersonality` /
 * `resolvePersonalityName`, so raw user text is never interpolated.
 *
 * SECURITY: if you add a skin, keep the addition short, in Persian, and free
 * of anything that weakens the tool-data rules in the base prompt.
 */

export interface Personality {
  /** Canonical machine name; the only value ever stored or resolved. */
  name: string;
  /** Persian label shown to the user. */
  labelFa: string;
  /** One-line Persian description shown in /personality. */
  descriptionFa: string;
  /**
   * Short addition appended to the system prompt. Empty means "no change"
   * (the `default` skin).
   */
  systemAddition: string;
}

/** The built-in skins, keyed by canonical name. */
export const BUILT_IN_PERSONALITIES: Readonly<Record<string, Personality>> = {
  default: {
    name: "default",
    labelFa: "معمولی",
    descriptionFa: "رفتار عادی بابی؛ بدون تغییر در لحن.",
    systemAddition: "",
  },
  concise: {
    name: "concise",
    labelFa: "خلاصه‌گو",
    descriptionFa: "پاسخ‌های کوتاه و فشرده؛ بدون مقدمه‌چینی.",
    systemAddition:
      "پاسخ‌ها را تا حد امکان کوتاه و فشرده بنویس؛ فقط نکتهٔ اصلی را بگو و از مقدمه و توضیح اضافه خودداری کن.",
  },
  playful: {
    name: "playful",
    labelFa: "شوخ‌طبع",
    descriptionFa: "لحن سرزنده و شوخ؛ ولی همیشه مفید.",
    systemAddition:
      "کمی شوخ‌طبع و سرزنده بنویس؛ می‌توانی بامزه باشی، ولی هیچ‌وقت مفید بودن را فدای شوخی نکن.",
  },
} as const;

/** Canonical names of all built-in skins. */
export function personalityNames(): readonly string[] {
  return Object.keys(BUILT_IN_PERSONALITIES);
}

/**
 * Look up a skin by name (case-insensitive). Returns undefined for anything
 * that is not a built-in skin — this is the validation boundary between user
 * input and the prompt.
 */
export function getPersonality(name: string): Personality | undefined {
  return BUILT_IN_PERSONALITIES[name.trim().toLowerCase()];
}

/**
 * Validate a raw stored/command value into a canonical skin name.
 *
 * Returns the canonical name when it names a built-in skin, otherwise
 * undefined. The engine and the /personality handler both funnel through
 * here, so a stale or hand-edited pref can never become prompt text.
 */
export function resolvePersonalityName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return getPersonality(raw)?.name;
}
