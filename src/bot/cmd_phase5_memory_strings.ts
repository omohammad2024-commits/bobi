/**
 * String table for the phase-5 memory commands (`cmd_phase5_memory.ts`).
 *
 * Local module (not wired into `src/i18n/`) so the feature package stays
 * file-owned, same convention as `cmd_phase3_skills_strings.ts`. Key prefix:
 * `ph5_mem.*`. Persian (`fa`) is ground truth; English (`en`) mirrors it.
 */

export type Ph5MemLang = "fa" | "en";

const STRINGS: Record<string, Record<Ph5MemLang, string>> = {
  "ph5_mem.owner_only": {
    fa: "⛔ این دستور فقط برای مالک ربات است.",
    en: "⛔ This command is for the bot owner only.",
  },
  "ph5_mem.unavailable": {
    fa: "❌ مدیریت حافظه در دسترس نیست (حافظه/تنظیمات پیکربندی نشده).",
    en: "❌ Memory management is unavailable (memory/settings not configured).",
  },
  "ph5_mem.usage": {
    fa: "🧠 استفاده:\n/memory auto on — فعال‌سازی استخراج خودکار رویدادها از گفتگو\n/memory auto off — غیرفعال‌سازی\n/memory auto status — وضعیت + پیشنهادهای رویداد در انتظار بررسی\n/memory auto scan — اسکن فوری گفتگوهای اخیر (یک‌بار)\n/memory export — صدور بستهٔ قابل انتقال حافظه (`.bobimem`)\n/memory import [--review] — ورود بسته؛ به پیام حاوی فایل ریپلای کن یا فایل را با همین کپشن بفرست\n\nاستخراج خودکار فقط در پس‌زمینه (sweep) اجرا می‌شود و هیچ‌چیز را بدون تأیید تو در /curator ثبت نمی‌کند.",
    en: "🧠 Usage:\n/memory auto on — enable automatic event extraction from chat\n/memory auto off — disable it\n/memory auto status — status + event proposals awaiting review\n/memory auto scan — one-shot scan of recent conversations\n/memory export — export a portable memory package (`.bobimem`)\n/memory import [--review] — import a package; reply to the message holding the file, or send the file with this caption\n\nAuto-extraction runs only in the background sweep and never stores anything without your approval in /curator.",
  },

  // ---------- auto ----------
  "ph5_mem.auto.on": {
    fa: "✅ استخراج خودکار رویدادها فعال شد.\nاز این به بعد گذر پس‌زمینه جمله‌های تاریخ‌دار گفتگوهای تو (تولد، سالگرد، تعهد ماهانه…) را پیدا می‌کند و به‌صورت «پیشنهاد» ثبت می‌کند — ثبت نهایی فقط با تأیید تو در /curator.",
    en: "✅ Automatic event extraction enabled.\nFrom now on the background sweep finds dated statements in your conversations (birthdays, anniversaries, monthly commitments…) and files them as proposals — nothing is stored without your approval in /curator.",
  },
  "ph5_mem.auto.off": {
    fa: "⏸ استخراج خودکار رویدادها غیرفعال شد. پیشنهادهای قبلی در /curator می‌مانند تا تصمیم بگیری.",
    en: "⏸ Automatic event extraction disabled. Earlier proposals stay in /curator for you to decide.",
  },
  "ph5_mem.auto.status": {
    fa: "🔍 استخراج خودکار رویدادها: {state}\n📌 پیشنهادهای «رویداد» در انتظار بررسی: {pending}\nبررسی و تأیید: /curator",
    en: "🔍 Automatic event extraction: {state}\n📌 “event” proposals awaiting review: {pending}\nReview and approve: /curator",
  },
  "ph5_mem.auto.state_on": {
    fa: "فعال ✅",
    en: "enabled ✅",
  },
  "ph5_mem.auto.state_off": {
    fa: "غیرفعال ⏸",
    en: "disabled ⏸",
  },
  "ph5_mem.auto.scan_done": {
    fa: "🔍 اسکن انجام شد: {messages} پیام در {convs} گفتگو بررسی شد.\n🎯 {candidates} رویداد یافت شد، {proposals} پیشنهاد جدید ثبت شد.\nبررسی: /curator",
    en: "🔍 Scan done: {messages} messages across {convs} conversations checked.\n🎯 {candidates} events found, {proposals} new proposals filed.\nReview: /curator",
  },
  "ph5_mem.auto.scan_disabled": {
    fa: "⏸ استخراج خودکار غیرفعال است؛ اول «/memory auto on» را بفرست.",
    en: "⏸ Auto-extraction is disabled; send “/memory auto on” first.",
  },

  // ---------- export ----------
  "ph5_mem.export.failed": {
    fa: "❌ صدور بستهٔ حافظه ناموفق بود.",
    en: "❌ Memory package export failed.",
  },
  "ph5_mem.export.too_large": {
    fa: "❌ حافظه ({count} مورد) از سقف صدور بیشتر است.",
    en: "❌ Memory ({count} entries) exceeds the export cap.",
  },
  "ph5_mem.export.done": {
    fa: "📦 بستهٔ حافظه: {memories} حافظه و {events} رویداد. مثل دیتابیس، محرمانه نگهش دار.",
    en: "📦 Memory package: {memories} memories and {events} events. Keep it as confidential as the database.",
  },

  // ---------- import ----------
  "ph5_mem.import.no_source": {
    fa: "❌ فایلی نداد. به پیام حاوی فایل `.bobimem` ریپلای کن با «/memory import»، یا فایل را با همین کپشن بفرست.",
    en: "❌ No file given. Reply “/memory import” to the message holding the `.bobimem` file, or send the file with this caption.",
  },
  "ph5_mem.import.download_failed": {
    fa: "❌ دانلود فایل ناموفق بود.",
    en: "❌ File download failed.",
  },
  "ph5_mem.import.too_large": {
    fa: "❌ حجم بسته ({bytes}) از سقف {max} بیشتر است.",
    en: "❌ Package size ({bytes}) exceeds the {max} cap.",
  },
  "ph5_mem.import.not_json": {
    fa: "❌ فایل معتبر نیست: JSON نیست.",
    en: "❌ Invalid file: not JSON.",
  },
  "ph5_mem.import.bad_envelope": {
    fa: "❌ فایل معتبر نیست: {reason}.",
    en: "❌ Invalid file: {reason}.",
  },
  "ph5_mem.import.checksum_mismatch": {
    fa: "❌ امضای بسته هم‌خوانی ندارد؛ فایل دست‌کاری شده یا ناقص است.",
    en: "❌ Package checksum mismatch; the file was tampered with or is incomplete.",
  },
  "ph5_mem.import.bad_entry": {
    fa: "❌ ورودی شمارهٔ {index} نامعتبر است: {reason}. کل بسته رد شد.",
    en: "❌ Entry #{index} is invalid: {reason}. The whole package was rejected.",
  },
  "ph5_mem.import.done": {
    fa: "📥 ورود انجام شد: {memories} حافظه و {events} رویداد اضافه شد، {skipped} مورد تکراری رد شد{review}.",
    en: "📥 Import done: {memories} memories and {events} events added, {skipped} duplicates skipped{review}.",
  },
  "ph5_mem.import.review_suffix": {
    fa: " — {proposals} مورد نیازمند بررسی در /curator ثبت شد",
    en: " — {proposals} items filed for review in /curator",
  },
};

export function tr(lang: Ph5MemLang, key: string, vars?: Record<string, string | number>): string {
  const entry = STRINGS[key];
  const template = entry?.[lang] ?? entry?.fa ?? key;
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : m,
  );
}
