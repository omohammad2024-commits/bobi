/**
 * String table for the Phase-3 group assistant mode (`src/groups/assistant.ts`).
 *
 * Part of the i18n system: this module lives under `src/i18n/strings/`.
 * Key prefix: `gassistant.*`.
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
    fa: "کاربرد:\n/gassistant on | /gassistant off | /gassistant status\n/gassistant digest on | off | status | time HH:MM\n/gassistant smart on | off | status",
    en: "Usage:\n/gassistant on | /gassistant off | /gassistant status\n/gassistant digest on | off | status | time HH:MM\n/gassistant smart on | off | status",
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

  // ---------- /gassistant digest (Phase-4 scheduled digests) ----------

  "gassistant.digest.usage": {
    fa: "کاربرد:\n/gassistant digest on — فعال‌سازی خلاصهٔ روزانه (به چت خصوصی مالک)\n/gassistant digest off — غیرفعال‌سازی\n/gassistant digest time HH:MM — ساعت ارسال (مثلاً 08:00)\n/gassistant.digest status — نمایش وضعیت",
    en: "Usage:\n/gassistant digest on — enable the daily digest (to the owner's DM)\n/gassistant digest off — disable it\n/gassistant digest time HH:MM — delivery time (e.g. 08:00)\n/gassistant digest status — show status",
  },
  "gassistant.digest.need_mode": {
    fa: "اول حالت دستیار گروهی را با /gassistant on فعال کن؛ خلاصهٔ روزانه بدون آن چیزی برای خلاصه کردن ندارد.",
    en: "Enable group assistant mode first with /gassistant on — the daily digest has nothing to summarize without it.",
  },
  "gassistant.digest.unavailable": {
    fa: "زمان‌بندی خلاصه در این نسخه فعال نیست؛ وضعیت ذخیره شد ولی وظیفه‌ای ساخته نشد.",
    en: "Digest scheduling is unavailable in this build; the setting was saved but no task was created.",
  },
  "gassistant.digest.schedule_failed": {
    fa: "ساخت وظیفهٔ زمان‌بندی‌شده ناموفق بود؛ لطفاً دوباره تلاش کن.",
    en: "Could not create the scheduled task; please try again.",
  },
  "gassistant.digest.on": {
    fa: "✅ خلاصهٔ روزانهٔ گروه فعال شد.\nهر روز ساعت {time} (تهران) خلاصهٔ بحث به چت خصوصی تو ارسال می‌شود؛ در خود گروه چیزی پست نمی‌شود.",
    en: "✅ Daily group digest enabled.\nEvery day at {time} (Tehran) the discussion summary is sent to your private chat; nothing is posted into the group.",
  },
  "gassistant.digest.off": {
    fa: "خلاصهٔ روزانهٔ گروه غیرفعال شد.",
    en: "Daily group digest disabled.",
  },
  "gassistant.digest.time_set": {
    fa: "ساعت ارسال خلاصهٔ روزانه روی {time} (تهران) تنظیم شد.",
    en: "Daily digest delivery time set to {time} (Tehran).",
  },
  "gassistant.digest.bad_time": {
    fa: "ساعت نامعتبر است؛ قالب «HH:MM» با ساعت ۲۴ساعته، مثلاً 08:00 یا 21:30.",
    en: 'Invalid time; use "HH:MM" 24-hour format, e.g. 08:00 or 21:30.',
  },
  "gassistant.digest.status_on": {
    fa: "روشن (روزانه ساعت {time} تهران)",
    en: "On (daily at {time} Tehran)",
  },
  "gassistant.digest.status_off": {
    fa: "خاموش",
    en: "Off",
  },
  "gassistant.digest.status_line": {
    fa: "• خلاصهٔ روزانه (به چت مالک): {digest}",
    en: "• Daily digest (to owner DM): {digest}",
  },
  "gassistant.digest.header": {
    fa: "🗞 خلاصهٔ روزانهٔ گروه {chat}",
    en: "🗞 Daily digest of group {chat}",
  },

  // ---------- /gassistant smart (Phase-5 opt-in LLM summaries) ----------

  "gassistant.smart.usage": {
    fa: "کاربرد:\n/gassistant smart on — فعال‌سازی خلاصهٔ هوشمند (نیاز به ارائه‌دهندهٔ هوش مصنوعی)\n/gassistant smart off — غیرفعال‌سازی\n/gassistant smart status — نمایش وضعیت",
    en: "Usage:\n/gassistant smart on — enable the smart summary (needs a configured AI provider)\n/gassistant smart off — disable it\n/gassistant smart status — show status",
  },
  "gassistant.smart.need_mode": {
    fa: "اول حالت دستیار گروهی را با /gassistant on فعال کن؛ خلاصهٔ هوشمند بدون آن چیزی برای خلاصه کردن ندارد.",
    en: "Enable group assistant mode first with /gassistant on — the smart summary has nothing to summarize without it.",
  },
  "gassistant.smart.unavailable": {
    fa: "خلاصهٔ هوشمند در دسترس نیست؛ برای بابی ارائه‌دهندهٔ هوش مصنوعی تنظیم نشده است (در تلگرام: /ai).",
    en: "The smart summary is unavailable; no AI provider is configured for Bobi (in Telegram: /ai).",
  },
  "gassistant.smart.on": {
    fa: "✅ خلاصهٔ هوشمند فعال شد.\nاز این به بعد /gsummaryِ تو (مالک) یک بخش هوشمند هم دارد و خلاصهٔ روزانه هم هوشمند می‌شود؛ برای بقیهٔ اعضا همان خلاصهٔ آماری نمایش داده می‌شود.",
    en: "✅ Smart summary enabled.\nFrom now on your (owner) /gsummary also gets a smart section, and the daily digest becomes smart too; other members still see only the stats summary.",
  },
  "gassistant.smart.off": {
    fa: "خلاصهٔ هوشمند غیرفعال شد.",
    en: "Smart summary disabled.",
  },
  "gassistant.smart.status_line": {
    fa: "• خلاصهٔ هوشمند: {smart}",
    en: "• Smart summary: {smart}",
  },
  "gassistant.smart.header": {
    fa: "🤖 خلاصهٔ هوشمند",
    en: "🤖 Smart summary",
  },
  "gassistant.smart.fallback": {
    fa: "⚠️ خلاصهٔ هوشمند این‌بار در دسترس نبود؛ خلاصهٔ آماری نمایش داده شد.",
    en: "⚠️ The smart summary was unavailable this time; showing the stats summary instead.",
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
