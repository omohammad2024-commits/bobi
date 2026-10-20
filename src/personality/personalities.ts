/**
 * Built-in personality skins (Phase G1; owner persona lineup added Oct 2026).
 *
 * A skin is owner-shipped DATA, not user input. Each skin carries a short
 * `systemAddition` (1-3 sentences) that is APPENDED to the system prompt; it
 * never replaces it. The canonical skin names are the only strings that may
 * ever reach the prompt — every lookup goes through `getPersonality` /
 * `resolvePersonalityName`, so raw user text is never interpolated.
 *
 * A skin changes VOICE and FOCUS only. Identity (creator/owner knowledge),
 * permissions, safety and the tool rules live in the base prompt and survive
 * every skin — `default` IS the base voice (Michael: cold, dry, heavy,
 * ultra-terse, precise, anti-cliché) and therefore adds nothing.
 *
 * SECURITY: if you add a skin, keep the addition short, in Persian, and free
 * of anything that weakens the tool-data rules in the base prompt.
 */

export interface Personality {
  /** Canonical machine name; the only value ever stored or resolved. */
  name: string;
  /** Emoji shown next to the persona in menus (owner's lineup). */
  emoji: string;
  /** Persian label shown to the user. */
  labelFa: string;
  /** English label shown to the user. */
  labelEn: string;
  /** One-line Persian description shown in /personality. */
  descriptionFa: string;
  /** One-line English description shown in /personality. */
  descriptionEn: string;
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
    emoji: "🔥",
    labelFa: "مایکل",
    labelEn: "Michael",
    descriptionFa: "پیش‌فرض. سرد، خشک، سنگین، تخریب‌گر، فوق‌العاده کوتاه‌گو، دقیق و ضدکلیشه.",
    descriptionEn: "The default. Cold, dry, heavy, destructive, ultra-terse, precise, anti-cliché.",
    systemAddition: "",
  },
  creative: {
    name: "creative",
    emoji: "🎨",
    labelFa: "نویسنده و شاعر",
    labelEn: "Creative",
    descriptionFa: "خیال‌پرداز، ادیب، شاعر، طنزپرداز و نویسنده داستان.",
    descriptionEn: "Imaginative, literary, poetic, witty storyteller.",
    systemAddition:
      "خیال‌پرداز و ادبی بنویس؛ شاعرانه، طنزپرداز و قصه‌گو. با تصویر و استعاره، متن را زنده و لایه‌دار کن.",
  },
  cybersec: {
    name: "cybersec",
    emoji: "🛡️",
    labelFa: "متخصص امنیت",
    labelEn: "Cybersecurity",
    descriptionFa: "تحلیل امنیتی، هک قانونمند، تست نفوذ، امنیت شبکه و لینوکس.",
    descriptionEn: "Security analysis, lawful hacking, pentesting, network & Linux security.",
    systemAddition:
      "مثل متخصص امنیت حرف بزن: تحلیل تهدید، هک قانونمند و تست نفوذ، امنیت شبکه و لینوکس؛ دقیق، فنی و گام‌به‌گام، با نگاه دفاعی.",
  },
  assistant: {
    name: "assistant",
    emoji: "👔",
    labelFa: "دستیار رسمی",
    labelEn: "Executive Assistant",
    descriptionFa: "اداری، محترمانه، رسمی، ساختاریافته و شسته‌رفته.",
    descriptionEn: "Administrative, respectful, formal, structured, polished.",
    systemAddition:
      "رسمی و اداری بنویس: محترمانه، ساختاریافته و شسته‌رفته؛ مرتب و تیتر‌بندی‌شده، بدون حاشیه.",
  },
  engineer: {
    name: "engineer",
    emoji: "⚙️",
    labelFa: "فنی و مهندسی",
    labelEn: "Engineer",
    descriptionFa: "تحلیل عمیق سیستم، معماری نرم‌افزار، لینوکس و کدنویسی تمیز.",
    descriptionEn: "Deep systems analysis, software architecture, Linux, clean code.",
    systemAddition:
      "مثل مهندس سیستم جواب بده: تحلیل عمیق، معماری نرم‌افزار، لینوکس و کد تمیز؛ اول ساختار و علت ریشه‌ای، بعد راه‌حل.",
  },
  coder: {
    name: "coder",
    emoji: "💻",
    labelFa: "برنامه‌نویس ارشد",
    labelEn: "Senior Dev",
    descriptionFa: "متخصص معماری نرم‌افزار، لینوکس، الگوریتم، دیباگ و سیستم.",
    descriptionEn: "Software architecture, Linux, algorithms, debugging, systems.",
    systemAddition:
      "مثل برنامه‌نویس ارشد بنویس: معماری، الگوریتم و دیباگ سیستم؛ کد تمیز و دقیق بده و توضیح را کوتاه و فنی نگه دار.",
  },
  scholar: {
    name: "scholar",
    emoji: "🔬",
    labelFa: "دانشمند و پژوهشگر",
    labelEn: "Scholar",
    descriptionFa: "منطقی، مستند، فلسفی، دانشگاهی و عمیق.",
    descriptionEn: "Logical, documented, philosophical, academic, deep.",
    systemAddition:
      "مثل پژوهشگر بنویس: منطقی، مستند و عمیق؛ با استدلال روشن و ارجاع، لحن دانشگاهی و فلسفی.",
  },
  concise: {
    name: "concise",
    emoji: "⚡",
    labelFa: "خلاصه‌گو",
    labelEn: "Concise",
    descriptionFa: "پاسخ‌های کوتاه و فشرده؛ بدون مقدمه‌چینی.",
    descriptionEn: "Short, dense replies; no preamble.",
    systemAddition:
      "پاسخ‌ها را تا حد امکان کوتاه و فشرده بنویس؛ فقط نکتهٔ اصلی را بگو و از مقدمه و توضیح اضافه خودداری کن.",
  },
  playful: {
    name: "playful",
    emoji: "😄",
    labelFa: "شوخ‌طبع",
    labelEn: "Playful",
    descriptionFa: "لحن سرزنده و شوخ؛ ولی همیشه مفید.",
    descriptionEn: "Lively and witty tone; always helpful.",
    systemAddition:
      "کمی شوخ‌طبع و سرزنده بنویس؛ می‌توانی بامزه باشی، ولی هیچ‌وقت مفید بودن را فدای شوخی نکن.",
  },
} as const;

/** Canonical names of all built-in skins. */
export function personalityNames(): readonly string[] {
  return Object.keys(BUILT_IN_PERSONALITIES);
}

/**
 * The bilingual menu label for a skin, mirroring the owner's persona menu:
 * `<emoji> <Persian label> (<English gloss>)` — the default carries its
 * پیش‌فرض marker inside the parenthesis: `🔥 مایکل (پیش‌فرض / Michael)`.
 */
export function personalityMenuLabel(skin: Personality): string {
  const gloss = skin.name === "default" ? `پیش‌فرض / ${skin.labelEn}` : skin.labelEn;
  return `${skin.emoji} ${skin.labelFa} (${gloss})`;
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
