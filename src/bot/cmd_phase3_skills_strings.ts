/**
 * String table for the phase-3 installable-skills commands
 * (`cmd_phase3_skills.ts`).
 *
 * Local module (not wired into `src/i18n/`) so the feature package stays
 * file-owned, same convention as `cmd_system_strings.ts`. Key prefix:
 * `ph3_skills.*`. Persian (`fa`) is ground truth; English (`en`) mirrors it.
 */

export type Ph3SkillsLang = "fa" | "en";

const STRINGS: Record<string, Record<Ph3SkillsLang, string>> = {
  "ph3_skills.owner_only": {
    fa: "⛔ این دستور فقط برای مالک ربات است.",
    en: "⛔ This command is for the bot owner only.",
  },
  "ph3_skills.unavailable": {
    fa: "❌ مدیریت مهارت‌ها در دسترس نیست (حافظهٔ مهارت پیکربندی نشده).",
    en: "❌ Skill management is unavailable (skill store not configured).",
  },
  "ph3_skills.usage": {
    fa: "📦 استفاده:\n/skill install <نشانی> — نصب مهارت از نشانی\n/skill show <نام> — نمایش یک مهارت\n/skill enable <نام> / /skill disable <نام> — فعال/غیرفعال‌سازی\n/skill uninstall <نام> — حذف (با تأیید)\n\nیا یک فایل `.md` مهارت را با کپشن «/skill install» بفرست، یا به پیام حاوی فایل با «/skill install» ریپلای کن.",
    en: "📦 Usage:\n/skill install <url> — install a skill from a URL\n/skill show <name> — show one skill\n/skill enable <name> / /skill disable <name> — enable/disable\n/skill uninstall <name> — remove (with confirmation)\n\nOr send a skill `.md` file with the caption “/skill install”, or reply “/skill install” to a message holding the file.",
  },

  // ---------- install ----------

  "ph3_skills.install.no_source": {
    fa: "❌ نه نشانی دادی نه فایلی. یک نشانی بده: /skill install <نشانی>، یا فایل `.md` را بفرست.",
    en: "❌ No URL and no file. Pass a URL: /skill install <url>, or send the `.md` file.",
  },
  "ph3_skills.install.not_markdown": {
    fa: "❌ فقط فایل `.md` قابل نصب است.",
    en: "❌ Only `.md` files can be installed.",
  },
  "ph3_skills.install.too_large": {
    fa: "❌ حجم فایل ({bytes} بایت) از سقف {max} بایت بیشتر است.",
    en: "❌ File size ({bytes} bytes) exceeds the {max} byte cap.",
  },
  "ph3_skills.install.fetch_failed": {
    fa: "❌ دریافت نشانی ناموفق بود: {reason}",
    en: "❌ Fetching the URL failed: {reason}",
  },
  "ph3_skills.install.parse_failed": {
    fa: "❌ این فایل مهارت معتبر نیست: {reason}\nمهارت باید با `---` شروع شود و فیلدهای `name` (kebab-case) و `description` را داشته باشد.",
    en: "❌ This is not a valid skill file: {reason}\nA skill must start with `---` and carry `name` (kebab-case) and `description` fields.",
  },
  "ph3_skills.install.collision": {
    fa: "⚠️ مهارتی با نام «{name}» از قبل نصب است.\nبرای جایگزینی: /skill install {source} --confirm",
    en: "⚠️ A skill named “{name}” is already installed.\nTo replace it: /skill install {source} --confirm",
  },
  "ph3_skills.install.limit": {
    fa: "❌ سقف تعداد مهارت ({max}) پر است ({count} نصب شده). اول یکی را حذف کن.",
    en: "❌ The skill limit ({max}) is full ({count} installed). Remove one first.",
  },
  "ph3_skills.review.title": {
    fa: "📦 بررسی مهارت جدید",
    en: "📦 Review new skill",
  },
  "ph3_skills.review.name": {
    fa: "نام: {name}",
    en: "Name: {name}",
  },
  "ph3_skills.review.description": {
    fa: "توضیح: {description}",
    en: "Description: {description}",
  },
  "ph3_skills.review.triggers": {
    fa: "تریگرها: {triggers}",
    en: "Triggers: {triggers}",
  },
  "ph3_skills.review.triggers_none": {
    fa: "—",
    en: "—",
  },
  "ph3_skills.review.size": {
    fa: "حجم: {size}",
    en: "Size: {size}",
  },
  "ph3_skills.review.source": {
    fa: "منبع: {source}",
    en: "Source: {source}",
  },
  "ph3_skills.review.source_file": {
    fa: "فایل ارسالی",
    en: "uploaded file",
  },
  "ph3_skills.review.replace_note": {
    fa: "⚠️ این نصب، مهارت فعلی «{name}» را جایگزین می‌کند.",
    en: "⚠️ This install will replace the current “{name}” skill.",
  },
  "ph3_skills.review.warnings_title": {
    fa: "⚠️ هشدارهای امنیتی (قبل از تأیید بخوان):",
    en: "⚠️ Security warnings (read before approving):",
  },
  "ph3_skills.review.warning_item": {
    fa: "• {detail}\n  «{snippet}»",
    en: "• {detail}\n  “{snippet}”",
  },
  "ph3_skills.review.preview_title": {
    fa: "پیش‌نمایش (۲۰ خط اول):",
    en: "Preview (first 20 lines):",
  },
  "ph3_skills.review.approve_hint": {
    fa: "نصب فقط با تأیید صریح تو انجام می‌شود.",
    en: "Installation happens only with your explicit approval.",
  },
  "ph3_skills.review.approve": {
    fa: "✅ تأیید",
    en: "✅ Approve",
  },
  "ph3_skills.review.reject": {
    fa: "❌ رد",
    en: "❌ Reject",
  },
  "ph3_skills.review.expired": {
    fa: "⌛ این درخواست تأیید منقضی شده؛ دوباره تلاش کن.",
    en: "⌛ This approval request has expired; try again.",
  },
  "ph3_skills.review.rejected": {
    fa: "🚫 نصب «{name}» لغو شد.",
    en: "🚫 Installation of “{name}” cancelled.",
  },
  "ph3_skills.install.done": {
    fa: "✅ مهارت «{name}» نصب شد و بدون راه‌اندازی مجدد فعال است.",
    en: "✅ Skill “{name}” installed and active — no restart needed.",
  },
  "ph3_skills.install.done_replaced": {
    fa: "✅ مهارت «{name}» جایگزین شد و بدون راه‌اندازی مجدد فعال است.",
    en: "✅ Skill “{name}” replaced and active — no restart needed.",
  },
  "ph3_skills.install.write_failed": {
    fa: "❌ نوشتن فایل مهارت ناموفق بود: {reason}",
    en: "❌ Writing the skill file failed: {reason}",
  },

  // ---------- show / enable / disable / uninstall ----------

  "ph3_skills.show.not_found": {
    fa: "❌ مهارتی با نام «{name}» پیدا نشد.",
    en: "❌ No skill named “{name}” found.",
  },
  "ph3_skills.show.status": {
    fa: "وضعیت: {status}",
    en: "Status: {status}",
  },
  "ph3_skills.show.status_enabled": {
    fa: "فعال ✅",
    en: "enabled ✅",
  },
  "ph3_skills.show.status_disabled": {
    fa: "غیرفعال ⏸️",
    en: "disabled ⏸️",
  },
  "ph3_skills.toggle.enabled": {
    fa: "✅ مهارت «{name}» فعال شد.",
    en: "✅ Skill “{name}” enabled.",
  },
  "ph3_skills.toggle.disabled": {
    fa: "⏸️ مهارت «{name}» غیرفعال شد (فایلش نگه داشته شد).",
    en: "⏸️ Skill “{name}” disabled (its file was kept).",
  },
  "ph3_skills.toggle.missing": {
    fa: "❌ مهارتی با نام «{name}» پیدا نشد.",
    en: "❌ No skill named “{name}” found.",
  },
  "ph3_skills.toggle.noop_enabled": {
    fa: "ℹ️ مهارت «{name}» از قبل فعال است.",
    en: "ℹ️ Skill “{name}” is already enabled.",
  },
  "ph3_skills.toggle.noop_disabled": {
    fa: "ℹ️ مهارت «{name}» از قبل غیرفعال است.",
    en: "ℹ️ Skill “{name}” is already disabled.",
  },
  "ph3_skills.uninstall.confirm": {
    fa: "⚠️ مهارت «{name}» حذف می‌شود (فایلش پاک می‌شود؛ قابل بازگشت نیست).\n\nبرای اجرا: /skill uninstall {name} --confirm",
    en: "⚠️ Skill “{name}” will be deleted (its file is removed; irreversible).\n\nTo run: /skill uninstall {name} --confirm",
  },
  "ph3_skills.uninstall.confirm_approve": {
    fa: "🗑️ حذف قطعی",
    en: "🗑️ Delete",
  },
  "ph3_skills.uninstall.confirm_cancel": {
    fa: "↩️ انصراف",
    en: "↩️ Cancel",
  },
  "ph3_skills.uninstall.done": {
    fa: "🗑️ مهارت «{name}» حذف شد.",
    en: "🗑️ Skill “{name}” deleted.",
  },
  "ph3_skills.uninstall.failed": {
    fa: "❌ حذف مهارت «{name}» ناموفق بود.",
    en: "❌ Deleting skill “{name}” failed.",
  },
  "ph3_skills.uninstall.missing": {
    fa: "❌ مهارتی با نام «{name}» پیدا نشد.",
    en: "❌ No skill named “{name}” found.",
  },
  "ph3_skills.uninstall.cancelled": {
    fa: "↩️ حذف «{name}» لغو شد.",
    en: "↩️ Deletion of “{name}” cancelled.",
  },
};

export function tr(
  lang: Ph3SkillsLang,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const pack = STRINGS[key];
  let text = pack !== undefined ? (pack[lang] ?? pack.fa) : key;
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** All keys, for parity tests (fa and en must mirror each other). */
export function stringKeys(): string[] {
  return Object.keys(STRINGS);
}
