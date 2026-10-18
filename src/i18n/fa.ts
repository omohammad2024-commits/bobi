/**
 * Persian language pack (D5).
 *
 * This is the DEFAULT pack: every string here is byte-identical to the
 * Persian text the bot used before i18n, so existing users see zero change.
 * Keys are grouped by area: menu.*, start.*, help.*, voice.*, prefs.*,
 * personality.*, reset.*, compress.*, stop.*, gate.*.
 */
import type { LanguagePack } from "./types";

export const fa: LanguagePack = {
  // ---- main menu ----
  "menu.label.chat": "گفت‌وگو",
  "menu.label.tools": "ابزارها",
  "menu.label.about": "درباره بابی",
  "menu.reply.chat": "گفت‌وگو: به‌زودی می‌توانی با بابی حرف بزنی.",
  "menu.reply.tools": "ابزارها: فهرست ابزارها در مرحلهٔ بعد اضافه می‌شود.",
  "menu.reply.about": "بابی — ربات ایجنت همه‌کاره. نسخهٔ آزمایشی.",
  "menu.reply.unknown": "گزینهٔ نامشخص.",
  "menu.tool.calculator": "ماشین‌حساب",
  "menu.tool.date_time": "تاریخ و ساعت",
  "menu.tool.text_utilities": "ابزار متن",
  "menu.tool.unit_converter": "تبدیل واحد",
  "menu.tool.fetch_url": "خواندن صفحهٔ وب",
  "menu.tool.web_search": "جستجوی وب",
  "menu.tools.title": "ابزارهای فعال بابی:",
  "menu.tools.empty": "ابزارها: هیچ ابزار فعالی وجود ندارد.",
  "menu.tools.note":
    "فهرست بالا یعنی ابزارها در دسترس‌اند؛ اجرای هر کدوم به اجازهٔ تو بستگی داره.",
  "menu.tools.item": "{index}. {label}",

  // ---- /start ----
  "start.greeting": "سلام! من BOBI هستم. یک گزینه را انتخاب کن:",

  // ---- /help ----
  "help.title": "دستورهای موجود:",
  "help.entry": "/{name} — {description}",
  "help.cmd.start": "شروع و نمایش منوی اصلی",
  "help.cmd.help": "راهنمای دستورها",
  "help.cmd.personality": "نمایش یا تغییر لحن پاسخ‌گویی",
  "help.cmd.voice": "روشن/خاموش کردن پاسخ صوتی",
  "help.cmd.lang": "تغییر زبان رابط کاربری",
  "help.cmd.compress": "خلاصه‌سازی فوری گفت‌وگوهای قدیمی",
  "help.cmd.reset": "پاک کردن تاریخچهٔ همین گفت‌وگو",
  "help.cmd.stop": "توقف پاسخ در حال اجرا",
  "help.cmd.admin": "پنل مدیریت ربات",
  "help.cmd.ai": "مدیریت ارائه‌دهندهٔ هوش مصنوعی",

  // ---- /voice ----
  "voice.not_configured":
    "تبدیل متن به صدا پیکربندی نشده است؛ حالت صوتی در دسترس نیست.",
  "voice.enabled":
    "حالت صوتی روشن شد 🎙️ از این به بعد پاسخ‌ها را به‌صورت پیام صوتی می‌فرستم.",
  "voice.disabled": "حالت صوتی خاموش شد؛ پاسخ‌ها دوباره به‌صورت متن ارسال می‌شوند.",
  "voice.tts_failed": "تبدیل متن به صدا ناموفق بود؛ پاسخ را به‌صورت متن می‌فرستم.",
  "voice.truncated": "پاسخ طولانی بود؛ ادامه را به‌صورت متن می‌فرستم:",

  // ---- shared preference write failure (/voice, /personality) ----
  "prefs.save_failed": "ذخیرهٔ تنظیم ناموفق بود؛ دوباره تلاش کن.",

  // ---- /personality ----
  "personality.unavailable": "تغییر شخصیت در دسترس نیست.",
  "personality.current_title": "شخصیت فعلی پاسخ‌گویی:",
  "personality.list_item": "• {name} — {label}: {description}{mark}",
  "personality.current_mark": " ← فعلی",
  "personality.usage": "برای تغییر: /personality <نام>",
  "personality.unknown": "شخصیت «{name}» ناشناخته است. گزینه‌ها: {options}",
  "personality.changed": "شخصیت پاسخ‌گویی به «{label}» تغییر کرد.",

  // ---- /reset ----
  "reset.done": "تاریخچهٔ این گفت‌وگو پاک شد. 🧹",
  "reset.confirm": "⚠️ با این کار {n} پیام این گفت‌وگو کلاً پاک می‌شه — برگشتی نیست.\nاگه مطمئنی: /reset --confirm",

  // ---- /compress ----
  "compress.compressed":
    "خلاصه‌سازی انجام شد ✅ گفت‌وگوهای قدیمی فشرده شدند و خلاصه‌شان نگه داشته شد.",
  "compress.nothing": "هنوز پیام کافی برای خلاصه‌سازی جمع نشده است.",
  "compress.failed": "خلاصه‌سازی ناموفق بود؛ بعداً دوباره تلاش کن.",
  "compress.unavailable": "خلاصه‌سازی در این حالت فعال نیست.",

  // ---- /stop ----
  "stop.nothing": "چیزی در حال اجرا نبود.",
  "stop.done": "متوقف شد ✅",

  // ---- /lang ----
  "lang.prompt": "زبان رابط کاربری را انتخاب کن:",
  "lang.label.fa": "فارسی",
  "lang.label.en": "English",
  "lang.changed": "زبان به «{label}» تغییر کرد ✅",
  "lang.unknown": "گزینهٔ زبان نامشخص است.",
  "lang.unavailable": "تغییر زبان در دسترس نیست.",

  // ---- gates ----
  "gate.group_not_ready":
    "این ربات در این گروه هنوز فعال نیست. مالک ربات باید ابتدا دسترسی را تأیید کند.",
  "gate.user_not_approved":
    "درخواستت برای مالک ربات فرستاده شد؛ بعد از تأیید می‌تونی گفت‌وگو کنی.",
  "gate.user_revoked": "دسترسی‌ت به این ربات لغو شده.",
  "help.cmd.history": "نمایش تاریخچهٔ گفت‌وگو",
  "help.cmd.save": "ذخیرهٔ گفت‌وگو به‌صورت فایل",
  "help.cmd.retry": "تلاش دوبارهٔ آخرین پیام",
  "help.cmd.undo": "بازگشت و بازنویسی",
  "help.cmd.title": "تنظیم عنوان گفت‌وگو",
  "help.cmd.branch": "شاخه‌سازی گفت‌وگو",
  "help.cmd.resume": "ازسرگیری نشست",
  "help.cmd.sessions": "نشست‌های قبلی",
  "help.cmd.status": "وضعیت",
  "help.cmd.context": "وضعیت حافظهٔ زمینه",
  "help.cmd.busy": "رفتار هنگام مشغولی",
  "help.cmd.whoami": "نقش من",
  "help.cmd.footer": "پانویس فنی",
  "help.cmd.version": "نسخهٔ بابی",
  "help.cmd.new": "شروع نشست تازه",
  "help.cmd.bg": "اجرای دستور در پس‌زمینه",
  "help.cmd.btw": "پرسش جانبی",
  "help.cmd.queue": "صف‌بندی پیام",
  "help.cmd.steer": "تزریق راهنمایی",
  "help.cmd.agents": "ایجنت‌های فعال",
  "help.cmd.suggestions": "اتوماسیون‌های پیشنهادی",
  "help.cmd.blueprint": "اتوماسیون از قالب",
  "help.cmd.refine": "استخراج درس از گفت‌وگو",
  "help.cmd.review": "بازبینی مستقل",
  "help.cmd.plan": "طرح اجرایی",
  "help.cmd.moa": "اجرای چندمدلی",
  "help.cmd.memory": "مدیریت حافظه",
  "help.cmd.bundles": "بسته‌های مهارت",
  "help.cmd.snapshot": "پشتیبان‌گیری از وضعیت",
  "help.cmd.restart": "راه‌اندازی مجدد ربات",
  "help.cmd.update": "به‌روزرسانی بابی",
  "help.cmd.debug": "گزارش اشکال‌زدایی",
  "help.cmd.usage": "مصرف توکن",
  "help.cmd.insights": "تحلیل مصرف",
  "help.cmd.model": "تغییر مدل",
  "help.cmd.reasoning": "سطح استدلال",
  "help.cmd.autoprune": "حذف خودکار نشست‌ها",
  "help.cmd.tools": "مدیریت ابزارها",
  "help.cmd.skills": "مدیریت مهارت‌ها",
  "help.cmd.curator": "نگهداری حافظه",
  "help.cmd.plugins": "افزونه‌ها",
  "help.cmd.reload_mcp": "بارگذاری مجدد MCP",
  "help.cmd.reload_skills": "اسکن مجدد مهارت‌ها",
  "help.cmd.approve": "تأیید درخواست",
  "help.cmd.deny": "رد درخواست",
  "help.cmd.sethome": "کانال اصلی",
  "help.cmd.pause": "توقف اضطراری",
  "help.cmd.goal": "هدف ماندگار",
  "help.cmd.subgoal": "زیراهداف",
  "help.cmd.heartbeat": "یادآور دوره‌ای",
  "help.cmd.loop": "تکرار خودکار",
  "help.cmd.cron": "وظایف زمان‌بندی‌شده",
  "help.cmd.learn": "آموزش مهارت",
  "progress.thinking": "در حال فکر کردن…",
  "progress.tool_running": "در حال {label}…",
  "progress.tool_done": "{label} انجام شد.",

  // ---- rate limit / turn errors (bot.ts §11c) ----
  "ratelimit.wait": "یه کم تند رفتی؛ حدود {seconds} ثانیهٔ دیگه دوباره تلاش کن.",
  "reply.truncated": "به سقف مراحل این پاسخ رسیدم؛ برای جزئیات بیشتر دقیق‌تر بپرس.",
  "media.skipped_title": "این پیوست‌ها استفاده نشدند:",
  "media.skipped_too_large": "• {kind}: حجمش بیش از حد مجاز بود.",
  "media.skipped_unsupported": "• {kind}: این نوع فایل پشتیبانی نمی‌شود.",
  "media.skipped_other": "• {kind}: دریافت نشد.",
  "media.empty": "پیام خالی است.",
  "error.empty_response": "پاسخی نگرفتم؛ دوباره تلاش کن.",
  "error.auth": "سرویس در دسترس نیست (احراز هویت).",
  "error.quota": "سقف استفاده پر شده؛ کمی بعد تلاش کن.",
  "error.network": "خطای شبکه؛ دوباره تلاش کن.",
  "error.timeout": "پاسخ خیلی طول کشید؛ لغو شد.",
  "error.overloaded": "سیستم شلوغه؛ لحظه‌ای بعد تلاش کن.",
  "error.unknown": "خطای موقت؛ دوباره تلاش کن.",
  "error.unexpected": "خطای غیرمنتظره.",
};
