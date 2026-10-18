/**
 * String table for the Phase-3 group assistant mode (`src/groups/assistant.ts`).
 *
 * Kept as a local module (not wired into `src/i18n/`) so the group package
 * stays file-owned and the coordinator can fold it into the global packs
 * later. Key prefix: `gassistant.*`.
 *
 * User-facing strings: Persian (`fa`) default and ground truth; English (`en`)
 * mirror. Guarded by the bilingual pairing tests in tests/i18n_parity.test.ts
 * (discovered by glob — no registration needed).
 *
 * Digit locale rule: Persian digits in `fa`, Latin digits in `en` — see
 * `formatNum` in `./panel_strings`. Identifiers (chat ids, user ids) always
 * stay Latin so they can be copied verbatim.
 */

export type AssistantLang = "fa" | "en";

export const ASSISTANT_STRINGS: Record<string, Record<AssistantLang, string>> = {
  // ---------- shared ----------

  "gassistant.denied": {
    fa: "متأسفم؛ این بخش فقط برای مالک بابی فعال است.",
    en: "Sorry — this section is only for Bobi's owner.",
  },
  "gassistant.private": {
    fa: "این دستور فقط در گروه کار می‌کند.",
    en: "This command only works in a group.",
  },
  "gassistant.off": {
    fa: "حالت دستیار گروهی برای این گروه فعال نیست.",
    en: "Group assistant mode is not enabled for this group.",
  },
  "gassistant.name_unknown": {
    fa: "ناشناس",
    en: "Unknown",
  },

  // ---------- /gassistant ----------

  "gassistant.enabled": {
    fa: "✅ حالت دستیار گروهی فعال شد.\n\n• بابی روی گفت‌وگوهای عادی ساکت می‌ماند و فقط وقتی منشنش کنی یا به پیامش ریپلای بزنی جواب می‌دهد.\n• /gsummary خلاصهٔ بحث اخیر را می‌دهد.\n• /gpoll نظرسنجی می‌سازد (فقط مالک).",
    en: "✅ Group assistant mode enabled.\n\n• Bobi stays silent on ordinary chatter and only replies when mentioned or replied to.\n• /gsummary summarizes the recent discussion.\n• /gpoll creates a poll (owner only).",
  },
  "gassistant.disabled": {
    fa: "حالت دستیار گروهی غیرفعال شد.",
    en: "Group assistant mode disabled.",
  },
  "gassistant.bad_arg": {
    fa: "کاربرد: /gassistant on | /gassistant off | /gassistant status",
    en: "Usage: /gassistant on | /gassistant off | /gassistant status",
  },
  "gassistant.status": {
    fa: "🤖 دستیار گروهی\n• وضعیت: {state}\n• پاسخ فقط با منشن یا ریپلای: {silent}\n• حداکثر پیام خلاصه: {n}\n• نظرسنجی: {polls}",
    en: "🤖 Group assistant\n• Status: {state}\n• Reply only on mention/reply: {silent}\n• Summary message cap: {n}\n• Polls: {polls}",
  },
  "gassistant.state_on": {
    fa: "فعال",
    en: "Enabled",
  },
  "gassistant.state_off": {
    fa: "غیرفعال",
    en: "Disabled",
  },
  "gassistant.value_on": {
    fa: "روشن",
    en: "On",
  },
  "gassistant.value_off": {
    fa: "خاموش",
    en: "Off",
  },

  // ---------- /gsummary ----------

  "gassistant.summary.empty": {
    fa: "هنوز پیام کافی برای خلاصه‌سازی ثبت نشده است.",
    en: "Not enough messages recorded yet to summarize.",
  },
  "gassistant.summary.header": {
    fa: "🗞 خلاصهٔ گفت‌وگو",
    en: "🗞 Discussion summary",
  },
  "gassistant.summary.stats": {
    fa: "{n} پیام از {m} نفر · {from} تا {to}",
    en: "{n} messages from {m} people · {from} to {to}",
  },
  "gassistant.summary.top_speakers": {
    fa: "🔥 فعال‌ترین‌ها: {list}",
    en: "🔥 Most active: {list}",
  },
  "gassistant.summary.speaker_row": {
    fa: "{name} ({n})",
    en: "{name} ({n})",
  },
  "gassistant.summary.topics": {
    fa: "💬 واژه‌های پرتکرار: {list}",
    en: "💬 Top words: {list}",
  },

  // ---------- /gpoll ----------

  "gassistant.poll.usage": {
    fa: "کاربرد:\n/gpoll \"سوال\" \"گزینه ۱\" \"گزینه ۲\"\n(حداقل ۲ و حداکثر ۱۰ گزینه؛ گزینه‌ها را در گیومه بگذار.)",
    en: 'Usage:\n/gpoll "question" "option 1" "option 2"\n(2–10 options; quote each option.)',
  },
  "gassistant.poll.too_few": {
    fa: "حداقل دو گزینه لازم است.",
    en: "At least two options are required.",
  },
  "gassistant.poll.too_many": {
    fa: "حداکثر ۱۰ گزینه مجاز است.",
    en: "At most 10 options are allowed.",
  },
  "gassistant.poll.bad_question": {
    fa: "متن سوال خالی یا بیش‌ازحد طولانی است.",
    en: "The question is empty or too long.",
  },
  "gassistant.poll.bad_option": {
    fa: "یک گزینه خالی یا بیش‌ازحد طولانی است (حداکثر ۱۰۰ حرف).",
    en: "An option is empty or too long (max 100 characters).",
  },
  "gassistant.poll.unsupported": {
    fa: "ساخت نظرسنجی در این نسخه در دسترس نیست.",
    en: "Poll creation is unavailable in this version.",
  },
  "gassistant.polls_disabled": {
    fa: "ساخت نظرسنجی برای این گروه خاموش است.",
    en: "Polls are disabled for this group.",
  },
};

/**
 * Translate a `gassistant.*` key, substituting `{name}` placeholders from
 * server-side values only — never from raw user text, except through the
 * bounded slots the caller validated upstream (display names truncated,
 * counts, ids).
 */
export function tr(
  lang: AssistantLang,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const pack = ASSISTANT_STRINGS[key];
  let text = pack !== undefined ? (pack[lang] ?? pack.fa) : key;
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
