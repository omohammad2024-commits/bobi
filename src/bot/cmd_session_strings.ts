import type { Lang } from "../i18n";

/**
 * Phase: Hermes command parity — session commands.
 *
 * All user-facing strings for `cmd_session.ts`, in Persian and English.
 * The coordinator folds these keys into `src/i18n/fa.ts` / `src/i18n/en.ts`
 * later (never touch those files from here); until then this module is the
 * single source of truth. Every key uses the `cmd_session.*` prefix so the
 * fold-in cannot collide with the built-in keys.
 *
 * Template vars are `{name}` placeholders, substituted by `tr()`.
 */

type Vars = Record<string, string | number>;

const FA: Record<string, string> = {
  "cmd_session.storage_error": "خطا در خواندن یا ذخیرهٔ اطلاعات؛ دوباره تلاش کن.",
  "cmd_session.prefs_unavailable": "سرویس تنظیمات در دسترس نیست.",
  "cmd_session.prefs_save_failed": "ذخیرهٔ تنظیم ناموفق بود.",

  "cmd_session.role_user": "شما",
  "cmd_session.role_assistant": "بابی",
  "cmd_session.role_system": "سیستم",

  "cmd_session.history_empty": "هنوز پیامی در این گفت‌وگو ثبت نشده است.",
  "cmd_session.history_title": "📜 تاریخچهٔ گفت‌وگو (آخرین {n} پیام):",
  "cmd_session.history_more": "…و {n} پیام قدیمی‌تر",
  "cmd_session.history_bad_arg": "تعداد پیام باید عددی بین ۱ تا ۳۰ باشد. مثال: /history 20",

  "cmd_session.save_empty": "هنوز پیامی در این گفت‌وگو ثبت نشده؛ فایلی ساخته نشد.",
  "cmd_session.save_bad_arg": "قالب نامعتبر. فقط `/save` (مارک‌داون) یا `/save json` پشتیبانی می‌شود.",
  "cmd_session.save_caption": "گفت‌وگوی بابی — {date}",
  "cmd_session.save_too_large": "گفت‌وگو بیش از حد بزرگ است (بیش از ۵۰۰۰ پیام)؛ این عملیات روی آن پشتیبانی نمی‌شود.",

  "cmd_session.retry_none": "پیام کاربری در تاریخچه پیدا نشد؛ چیزی برای تلاش دوباره نیست.",
  "cmd_session.retry_failed": "تلاش دوباره ناموفق بود؛ دوباره تلاش کن.",

  "cmd_session.undo_usage": "برای حذف نوبت‌های آخر، تعداد رو مشخص کن (۱ تا ۵). مثال: /undo 2",
  "cmd_session.undo_bad_arg": "تعداد باید عددی بین ۱ تا ۵ باشد. مثال: /undo 2",
  "cmd_session.undo_nothing": "پیامی برای حذف وجود ندارد.",
  "cmd_session.undo_done": "✅ {n} نوبت آخر حذف شد؛ می‌تونی دوباره بنویسی.\nحذف شد:\n{preview}",

  "cmd_session.title_current": "🏷 عنوان فعلی این گفت‌وگو: {title}",
  "cmd_session.title_none": "هنوز عنوانی برای این گفت‌وگو تنظیم نشده است. با `/title <متن>` یکی بذار.",
  "cmd_session.title_too_long": "عنوان حداکثر ۱۲۰ نویسه می‌تواند باشد.",
  "cmd_session.title_set": "✅ عنوان گفت‌وگو تنظیم شد: {title}",

  "cmd_session.branch_usage": "نام شاخه رو مشخص کن. مثال: /branch ایده‌ها",
  "cmd_session.branch_bad_name": "نام شاخه نامعتبر است؛ فقط حروف، عدد، خط تیره و زیرخط، حداکثر ۴۰ نویسه.",
  "cmd_session.branch_empty": "این گفت‌وگو هنوز پیامی ندارد؛ چیزی برای شاخه‌سازی نیست.",
  "cmd_session.branch_done": "🌿 شاخه ساخته شد: `{id}`\n{n} پیام کپی شد. با /sessions می‌تونی ببینیش.\n(خلاصهٔ چرخشی کپی نشد — در صورت نیاز با /compress در شاخهٔ جدید بساز.)",

  "cmd_session.resume_usage": "نام یا شناسهٔ نشست رو مشخص کن. فهرست نشست‌ها: /sessions",
  "cmd_session.resume_not_found": "نشستی با این اسم یا شناسه پیدا نشد؛ /sessions رو ببین.",
  "cmd_session.resume_title": "📂 نشست «{name}» — آخرین {n} پیام:",
  "cmd_session.resume_empty": "(این نشست پیامی ندارد.)",
  "cmd_session.resume_active":
    "✅ «{name}» به‌عنوان نشست فعال انتخاب شد؛ پیام‌های بعدی‌ات در همین نشست ادامه پیدا می‌کند.",

  "cmd_session.sessions_empty": "نشست دیگری ثبت نشده است.",
  "cmd_session.sessions_title": "💬 نشست‌هات:",
  "cmd_session.sessions_item": "• {title} — {n} پیام — {date}{current}",
  "cmd_session.sessions_current_mark": " (فعلی)",
  "cmd_session.sessions_more": "…و {n} نشست دیگر",

  "cmd_session.status_title": "📊 وضعیت نشست",
  "cmd_session.status_session": "نشست: {id}",
  "cmd_session.status_title_line": "عنوان: {title}",
  "cmd_session.status_title_none": "—",
  "cmd_session.status_model": "مدل: {model}",
  "cmd_session.status_model_unknown": "نامشخص",
  "cmd_session.status_messages": "پیام‌های ذخیره‌شده: {n}",
  "cmd_session.status_running_yes": "در حال اجرا: بله",
  "cmd_session.status_running_no": "در حال اجرا: خیر",
  "cmd_session.status_tokens": "توکن امروز: ورودی {in} / خروجی {out}",
  "cmd_session.status_requests": "درخواست امروز: {n}",

  "cmd_session.context_title": "🧠 وضعیت حافظهٔ زمینه",
  "cmd_session.context_messages": "پیام‌ها: {n}",
  "cmd_session.context_tokens": "تخمین توکن‌ها (تقریبی): ~{n}",
  "cmd_session.context_window": "پنجرهٔ موتور: {n} پیام آخر",
  "cmd_session.context_summary_yes": "خلاصه‌سازی: فعال — تا پیام #{id}",
  "cmd_session.context_summary_no": "خلاصه‌سازی: هنوز خلاصه‌ای ساخته نشده",
  "cmd_session.context_note": "تخمین توکن = تعداد نویسه‌ها ÷ ۴؛ تقریبی است.",

  "cmd_session.busy_current": "⏳ رفتار هنگام مشغولی: {mode}",
  "cmd_session.busy_mode_queue": "صف (پیام جدید پشت پاسخ فعلی می‌ماند)",
  "cmd_session.busy_mode_interrupt": "قطع پاسخ فعلی و شروع پاسخ به پیام جدید",
  "cmd_session.busy_mode_ignore": "نادیده گرفتن پیام جدید تا پایان پاسخ فعلی",
  "cmd_session.busy_set": "✅ رفتار هنگام مشغولی تنظیم شد: {mode}",
  "cmd_session.busy_bad_arg": "گزینه نامعتبر. یکی از: queue ،interrupt ،ignore — مثال: /busy queue",
  "cmd_session.busy_note": "(این ترجیح فعلاً اعلامی است؛ موتور هنوز آن را اعمال نمی‌کند.)",

  "cmd_session.whoami_owner": "👑 تو مالک رباتی.",
  "cmd_session.whoami_user": "👤 تو کاربر تأییدشده‌ای.",
  "cmd_session.whoami_groups_user": "دستورها: {commands}",
  "cmd_session.whoami_groups_owner": "دستورهای مالک: {commands}",

  "cmd_session.footer_current_on": "📝 پانویس فنی پاسخ‌ها: روشن",
  "cmd_session.footer_current_off": "📝 پانویس فنی پاسخ‌ها: خاموش",
  "cmd_session.footer_set_on": "✅ پانویس فنی پاسخ‌ها روشن شد.",
  "cmd_session.footer_set_off": "✅ پانویس فنی پاسخ‌ها خاموش شد.",
  "cmd_session.footer_bad_arg": "گزینه نامعتبر. `/footer on` یا `/footer off`",
  "cmd_session.footer_note": "(این ترجیح فعلاً اعلامی است؛ قالب‌بند پاسخ هنوز آن را اعمال نمی‌کند.)",

  "cmd_session.version": "🤖 بابی نسخهٔ {version}",

  "cmd_session.new_confirm":
    "⚠️ «نشست تازه» یعنی خداحافظی با {n} پیام{summary} — برگشتی در کار نیست.\n\nاگه مطمئنی: /new --confirm",
  "cmd_session.new_confirm_summary": " و خلاصهٔ چرخشی",
  "cmd_session.new_done": "🆕 نشست تازه شروع شد؛ تاریخچهٔ همین گفت‌وگو پاک شد.",
};

const EN: Record<string, string> = {
  "cmd_session.storage_error": "Failed to read or store data. Please try again.",
  "cmd_session.prefs_unavailable": "Preference service is unavailable.",
  "cmd_session.prefs_save_failed": "Failed to save the preference.",

  "cmd_session.role_user": "You",
  "cmd_session.role_assistant": "BOBI",
  "cmd_session.role_system": "System",

  "cmd_session.history_empty": "No messages in this conversation yet.",
  "cmd_session.history_title": "📜 Conversation history (last {n} messages):",
  "cmd_session.history_more": "…and {n} older messages",
  "cmd_session.history_bad_arg": "Message count must be a number between 1 and 30. Example: /history 20",

  "cmd_session.save_empty": "No messages in this conversation yet; no file created.",
  "cmd_session.save_bad_arg": "Invalid format. Only `/save` (Markdown) or `/save json` is supported.",
  "cmd_session.save_caption": "BOBI conversation — {date}",
  "cmd_session.save_too_large": "Conversation is too large (over 5000 messages); this operation is not supported on it.",

  "cmd_session.retry_none": "No user message found in history; nothing to retry.",
  "cmd_session.retry_failed": "Retry failed. Please try again.",

  "cmd_session.undo_usage": "Specify how many turns to drop (1–5). Example: /undo 2",
  "cmd_session.undo_bad_arg": "Count must be a number between 1 and 5. Example: /undo 2",
  "cmd_session.undo_nothing": "No messages to drop.",
  "cmd_session.undo_done": "✅ Dropped the last {n} turn(s); you can resend.\nDropped:\n{preview}",

  "cmd_session.title_current": "🏷 Current title of this conversation: {title}",
  "cmd_session.title_none": "No title set for this conversation yet. Set one with `/title <text>`.",
  "cmd_session.title_too_long": "Title can be at most 120 characters.",
  "cmd_session.title_set": "✅ Conversation title set: {title}",

  "cmd_session.branch_usage": "Specify a branch name. Example: /branch ideas",
  "cmd_session.branch_bad_name": "Invalid branch name; letters, digits, dash and underscore only, max 40 characters.",
  "cmd_session.branch_empty": "This conversation has no messages yet; nothing to branch.",
  "cmd_session.branch_done": "🌿 Branch created: `{id}`\n{n} messages copied. See it with /sessions.\n(The rolling summary was not copied — rebuild it in the new branch with /compress if needed.)",

  "cmd_session.resume_usage": "Specify a session name or id. List sessions with /sessions",
  "cmd_session.resume_not_found": "No session with that name or id. See /sessions.",
  "cmd_session.resume_title": "📂 Session “{name}” — last {n} messages:",
  "cmd_session.resume_empty": "(This session has no messages.)",
  "cmd_session.resume_active":
    "✅ “{name}” is now the active session; your next messages continue there.",

  "cmd_session.sessions_empty": "No other sessions recorded.",
  "cmd_session.sessions_title": "💬 Your sessions:",
  "cmd_session.sessions_item": "• {title} — {n} messages — {date}{current}",
  "cmd_session.sessions_current_mark": " (current)",
  "cmd_session.sessions_more": "…and {n} more sessions",

  "cmd_session.status_title": "📊 Session status",
  "cmd_session.status_session": "Session: {id}",
  "cmd_session.status_title_line": "Title: {title}",
  "cmd_session.status_title_none": "—",
  "cmd_session.status_model": "Model: {model}",
  "cmd_session.status_model_unknown": "unknown",
  "cmd_session.status_messages": "Stored messages: {n}",
  "cmd_session.status_running_yes": "Running: yes",
  "cmd_session.status_running_no": "Running: no",
  "cmd_session.status_tokens": "Tokens today: {in} in / {out} out",
  "cmd_session.status_requests": "Requests today: {n}",

  "cmd_session.context_title": "🧠 Context window status",
  "cmd_session.context_messages": "Messages: {n}",
  "cmd_session.context_tokens": "Token estimate (rough): ~{n}",
  "cmd_session.context_window": "Engine window: last {n} messages",
  "cmd_session.context_summary_yes": "Summarisation: active — up to message #{id}",
  "cmd_session.context_summary_no": "Summarisation: no summary built yet",
  "cmd_session.context_note": "Token estimate = character count ÷ 4; rough.",

  "cmd_session.busy_current": "⏳ Busy behavior: {mode}",
  "cmd_session.busy_mode_queue": "queue (new message waits behind the current reply)",
  "cmd_session.busy_mode_interrupt": "interrupt the current reply and answer the new message",
  "cmd_session.busy_mode_ignore": "ignore the new message until the current reply finishes",
  "cmd_session.busy_set": "✅ Busy behavior set: {mode}",
  "cmd_session.busy_bad_arg": "Invalid option. One of: queue, interrupt, ignore — e.g. /busy queue",
  "cmd_session.busy_note": "(This preference is declared only; the engine does not honor it yet.)",

  "cmd_session.whoami_owner": "👑 You are the bot owner.",
  "cmd_session.whoami_user": "👤 You are an approved user.",
  "cmd_session.whoami_groups_user": "Commands: {commands}",
  "cmd_session.whoami_groups_owner": "Owner commands: {commands}",

  "cmd_session.footer_current_on": "📝 Technical reply footer: on",
  "cmd_session.footer_current_off": "📝 Technical reply footer: off",
  "cmd_session.footer_set_on": "✅ Technical reply footer enabled.",
  "cmd_session.footer_set_off": "✅ Technical reply footer disabled.",
  "cmd_session.footer_bad_arg": "Invalid option. `/footer on` or `/footer off`",
  "cmd_session.footer_note": "(This preference is declared only; the reply formatter does not honor it yet.)",

  "cmd_session.version": "🤖 BOBI version {version}",

  "cmd_session.new_confirm":
    "⚠️ A fresh session wipes {n} messages{summary} — no way back.\n\nIf you're sure: /new --confirm",
  "cmd_session.new_confirm_summary": " and the rolling summary",
  "cmd_session.new_done": "🆕 Fresh session started; this conversation's history was cleared.",
};

const PACKS: Record<Lang, Record<string, string>> = { fa: FA, en: EN };

/**
 * Look up a `cmd_session.*` key and substitute `{vars}`.
 * Unknown keys fall back to the Persian table, then to the key itself —
 * never throws, so a missing key can never break a handler.
 */
export function tr(lang: Lang, key: string, vars?: Vars): string {
  let s = PACKS[lang]?.[key] ?? FA[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
