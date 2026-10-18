/**
 * Tests for src/i18n (Phase D5) and the menu/bot string migration.
 *
 * The fa pack holds the ground-truth Persian copy; the en pack must cover
 * every key. The FA_EXPECTED map below pins the exact fa text so any copy
 * drift (accidental or deliberate) fails loudly. No network, no Telegram.
 */
import { describe, expect, test } from "bun:test";
import { t, resolveLang, LANG_PREF_KEY, fa, en } from "../src/i18n";
import {
  MAIN_MENU_LABELS,
  MENU_REPLIES,
  CALLBACKS,
  buildMainMenu,
  replyForCallback,
  toolListText,
} from "../src/bot/menu";
import { tr as trMenu } from "../src/bot/menu_strings";
import {
  VOICE_FAILED_NOTE,
  VOICE_TRUNCATED_NOTE,
  COMPRESS_REPLIES,
  COMMAND_HELP,
  visibleCommandHelp,
  formatCommandHelp,
  handleHelpCommand,
  handleResetCommand,
  handleCompressCommand,
  handleStopCommand,
  handleVoiceCommand,
  handlePersonalityCommand,
  userFacingMessage,
  describeSkipped,
  describeNothingUsable,
  type VoiceCommandEnv,
} from "../src/bot/bot";
import { EngineError } from "../src/conversation/engine";
import { ToolError } from "../src/tools/errors";
import { buildSystemPrompt } from "../src/agent/prompt";

// ---------------------------------------------------------------------------
// fa pack: ground-truth Persian copy (pinned so drift fails loudly).
// ---------------------------------------------------------------------------

/**
 * Every central-pack key with its exact Persian text.
 *
 * These literals were copied from src/bot/menu.ts and src/bot/bot.ts before
 * the D5 migration (byte-identical to the pre-i18n text); the UI voice-polish
 * pass deliberately changed a few (marked above) and added the §11c keys —
 * the test fails if the fa pack ever drifts from this map.
 */
const FA_EXPECTED: Readonly<Record<string, string>> = {
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
  "start.greeting": "سلام! من BOBI هستم. یک گزینه را انتخاب کن:",
  "help.title": "دستورهای موجود:",
  "help.entry": "/{name} — {description}",
  "help.cmd.start": "شروع و نمایش منوی اصلی",
  "help.cmd.help": "راهنمای دستورها",
  "help.cmd.personality": "نمایش یا تغییر لحن پاسخ‌گویی",
  "help.cmd.voice": "انتخاب حالت پاسخ صوتی (خودکار/همیشه/هرگز)",
  "help.cmd.compress": "خلاصه‌سازی فوری گفت‌وگوهای قدیمی",
  "help.cmd.reset": "پاک کردن تاریخچهٔ همین گفت‌وگو",
  "help.cmd.stop": "توقف پاسخ در حال اجرا",
  "help.cmd.admin": "پنل مدیریت ربات",
  "help.cmd.ai": "مدیریت ارائه‌دهندهٔ هوش مصنوعی",
  "voice.not_configured": "تبدیل متن به صدا پیکربندی نشده است؛ حالت صوتی در دسترس نیست.",
  "voice.prompt": "حالت پاسخ صوتی فعلی: {mode}. یکی را انتخاب کن:",
  "voice.option.auto": "🔁 خودکار (آینهٔ ورودی)",
  "voice.option.always": "🎙️ همیشه صوتی",
  "voice.option.never": "📝 همیشه متنی",
  "voice.mode.auto": "خودکار",
  "voice.mode.always": "همیشه",
  "voice.mode.never": "هرگز",
  "voice.set_auto": "انجام شد؛ حالت صوتی: خودکار — پیام صوتی بده، پاسخ صوتی بگیر.",
  "voice.set_always": "انجام شد؛ حالت صوتی: همیشه — همهٔ پاسخ‌ها صوتی می‌شوند.",
  "voice.set_never": "انجام شد؛ حالت صوتی: هرگز — همهٔ پاسخ‌ها متنی می‌مانند.",
  "voice.unknown_option": "گزینهٔ نامعتبر؛ یکی از این‌ها: auto ،always ،never.",
  "voice.tts_failed": "تبدیل متن به صدا ناموفق بود؛ پاسخ را به‌صورت متن می‌فرستم.",
  "voice.truncated": "پاسخ طولانی بود؛ ادامه را به‌صورت متن می‌فرستم:",
  "prefs.save_failed": "ذخیرهٔ تنظیم ناموفق بود؛ دوباره تلاش کن.",
  "personality.unavailable": "تغییر شخصیت در دسترس نیست.",
  "personality.current_title": "شخصیت فعلی پاسخ‌گویی:",
  "personality.list_item": "• {name} — {label}: {description}{mark}",
  "personality.current_mark": " ← فعلی",
  "personality.usage": "برای تغییر: /personality <نام>",
  "personality.unknown": "شخصیت «{name}» ناشناخته است. گزینه‌ها: {options}",
  "personality.changed": "شخصیت پاسخ‌گویی به «{label}» تغییر کرد.",
  "reset.done": "تاریخچهٔ این گفت‌وگو پاک شد. 🧹",
  "compress.compressed":
    "خلاصه‌سازی انجام شد ✅ گفت‌وگوهای قدیمی فشرده شدند و خلاصه‌شان نگه داشته شد.",
  "compress.nothing": "هنوز پیام کافی برای خلاصه‌سازی جمع نشده است.",
  "compress.failed": "خلاصه‌سازی ناموفق بود؛ بعداً دوباره تلاش کن.",
  "compress.unavailable": "خلاصه‌سازی در این حالت فعال نیست.",
  "stop.nothing": "چیزی در حال اجرا نبود.",
  "stop.done": "متوقف شد ✅",
  "lang.prompt": "زبان رابط کاربری را انتخاب کن:",
  "lang.label.fa": "فارسی",
  "lang.label.en": "English",
  "lang.changed": "زبان به «{label}» تغییر کرد ✅",
  "lang.unknown": "گزینهٔ زبان نامشخص است.",
  "lang.unavailable": "تغییر زبان در دسترس نیست.",
  "help.cmd.lang": "تغییر زبان رابط کاربری",
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
  "help.cmd.digest": "خلاصهٔ تعاملی امروز",
  "help.cmd.sethome": "کانال اصلی",
  "help.cmd.pause": "توقف اضطراری",
  "help.cmd.goal": "هدف ماندگار",
  "help.cmd.subgoal": "زیراهداف",
  "help.cmd.heartbeat": "یادآور دوره‌ای",
  "help.cmd.loop": "تکرار خودکار",
  "help.cmd.cron": "وظایف زمان‌بندی‌شده",
  "help.cmd.learn": "آموزش مهارت",
  // ---- interactive digest (/digest, dgst:) ----
  "digest.sec.tasks": "✅ کارهای امروز",
  "digest.sec.reminders": "⏰ یادآورها",
  "digest.sec.proposals": "🧠 پیشنهادهای حافظه",
  "digest.sec.usage": "📊 مصرف ۲۴ ساعت اخیر",
  "digest.sec.headlines": "📰 سرخط خبرها — محتوای بیرونی",
  "digest.sec.memories": "💭 از حافظه‌ات",
  "digest.greeting.morning": "صبح بخیر",
  "digest.greeting.afternoon": "ظهر بخیر",
  "digest.greeting.evening": "عصر بخیر",
  "digest.greeting.night": "شب بخیر",
  "digest.date.body": "امروز {date} است — ساعت {time} به وقت تهران.",
  "digest.tasks.empty": "امروز کار زمان‌بندی‌شده‌ای نداری؛ روز آرومی پیش روئه.",
  "digest.tasks.one": "یک کار زمان‌بندی‌شده داری:",
  "digest.tasks.many": "{count} کار زمان‌بندی‌شده داری:",
  "digest.tasks.time": "ساعت {time}",
  "digest.reminders.many": "{count} یادآور برای امروز داری:",
  "digest.reminders.overdue": " (عقب‌افتاده)",
  "digest.proposals.one": "یک پیشنهاد برای مرتب‌سازی حافظه‌ات منتظر تصمیم توئه.",
  "digest.proposals.many": "{count} پیشنهاد برای مرتب‌سازی حافظه‌ات منتظر تصمیم توئه؛ هر وقت خواستی بررسی‌شون کن.",
  "digest.usage.body": "• درخواست‌ها: {runs} — توکن ورودی: {input}، خروجی: {output}\n• هزینهٔ تقریبی: {cost} (تخمینی، نه صورتحساب)",
  "digest.cost.zero": "۰ دلار",
  "digest.cost.tiny": "کمتر از ۰٫۰۱ دلار",
  "digest.cost.value": "{amount} دلار",
  "digest.headlines.warn": "⚠️ این‌ها از جستجوی وب آمده‌اند و حرف من نیستند:",
  "digest.memories.body": "تازه‌ترین چیزهایی که سپردی به من:",
  "digest.closer": "روز خوبی داشته باشی ✨",
  "digest.btn.refresh": "🔄 به‌روزرسانی",
  "digest.btn.task_run": "▶️ شروع",
  "digest.btn.task_delete": "🗑 حذف",
  "digest.btn.task_confirm_yes": "بله، حذف کن ✅",
  "digest.btn.task_confirm_no": "انصراف",
  "digest.btn.reminder_done": "✅ انجام شد",
  "digest.btn.memory_details": "📖 جزئیات",
  "digest.btn.proposals_review": "🧠 بررسی پیشنهادها",
  "digest.btn.proposal_approve": "✅ تأیید",
  "digest.btn.proposal_reject": "❌ رد",
  "digest.btn.back": "🔙 بازگشت به خلاصه",
  "digest.toast.refreshed": "به‌روزرسانی شد 🔄",
  "digest.toast.fresh": "به‌روز است ✨",
  "digest.toast.task_deleted": "کار حذف شد 🗑",
  "digest.toast.reminder_done": "انجام شد ✅",
  "digest.toast.run_started": "در حال اجرا… ⏳",
  "digest.toast.run_ok": "اجرا شد ✅",
  "digest.toast.run_failed": "اجرا ناموفق بود ⚠️",
  "digest.toast.run_chat_limited": "اجرای مستقیم فقط برای چت خودت ممکنه",
  "digest.toast.approved": "تأیید و اعمال شد ✅",
  "digest.toast.rejected": "رد شد",
  "digest.toast.decide_failed": "ثبت تصمیم ناموفق بود ⚠️",
  "digest.toast.unavailable": "خلاصه در دسترس نیست.",
  "digest.proposals_view.title": "🧠 پیشنهادهای حافظه",
  "digest.proposals_view.empty": "پیشنهاد در انتظاری نداری 🎉",
  "digest.proposals_view.hint": "روی هر پیشنهاد تصمیم بگیر:",
  "digest.proposals_view.item": "• {summary}",
  "digest.proposals_view.more": "…و {count} پیشنهاد دیگر — فهرست کامل با /curator",
  "digest.memory_card.title": "💭 حافظه",
  "digest.memory_card.key": "کلید: {key}",
  "digest.memory_card.saved": "ثبت: {date}",
  "gate.group_not_ready":
    "این ربات در این گروه هنوز فعال نیست. مالک ربات باید ابتدا دسترسی را تأیید کند.",
  // Gate denials (moved into the packs so gateUser can answer in the
  // sender's language; the fa text was tightened by the UI voice-polish
  // pass, so it no longer matches the old user_panel.ts constants).
  "gate.user_revoked": "دسترسی‌ت به این ربات لغو شده.",
  "tier.refused": "متأسفم؛ این بخش فقط برای مالک بابی فعال است.",
  "gate.user_banned": "دسترسی‌ت به بابی مسدود شده.",
  "help.cmd.ban": "مسدود کردن کاربر",
  "help.cmd.unban": "رفع مسدودیت کاربر",
  "help.cmd.mute": "نادیده گرفتن پیام‌های کاربر",
  "help.cmd.unmute": "رفع نادیده گرفتن کاربر",
  // Progress lines (bilingual since the UI upgrade; fa is ground truth).
  "progress.thinking": "در حال فکر کردن…",
  "progress.tool_running": "در حال {label}…",
  "progress.tool_done": "{label} انجام شد.",
  // /reset is two-step since the UI upgrade (with a message-count preview).
  "reset.confirm":
    "⚠️ با این کار {n} پیام این گفت‌وگو کلاً پاک می‌شه — برگشتی نیست.\nاگه مطمئنی: /reset --confirm",
  // Rate-limit and turn-failure copy, i18n'd out of bot.ts (§11c of the UI
  // audit) in the voice-polish pass; fa is ground truth.
  "ratelimit.wait": "یه کم تند رفتی؛ حدود {seconds} ثانیهٔ دیگه دوباره تلاش کن.",
  "reply.truncated": "به سقف مراحل این پاسخ رسیدم؛ برای جزئیات بیشتر دقیق‌تر بپرس.",
  "media.skipped_title": "این پیوست‌ها استفاده نشدند:",
  "media.skipped_too_large": "• {kind}: حجمش بیش از حد مجاز بود.",
  "media.skipped_too_long": "• {kind}: طولش از حد مجاز بیشتر بود.",
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
  "help.cmd.commands": "مرورگر دستورها",
  "pal.title": "⌨️ مرورگر دستورها",
  "pal.subtitle": "یک دسته را انتخاب کن تا دستورهایش را ببینی؛ روی هر دستور بزن تا اجرا شود.",
  "pal.page": "صفحهٔ {page} از {pages}",
  "pal.prev": "‹ قبلی",
  "pal.next": "بعدی ›",
  "pal.back_cats": "« دسته‌ها",
  "pal.back_group": "« برگشت",
  "pal.usage.needs_args": "این دستور آرگومان می‌گیرد؛ در گفت‌وگو تایپش کن:",
  "pal.usage.example": "مثال: {example}",
  "pal.owner_only": "این دستور فقط برای مالک است.",
  "pal.storage_unavailable": "سرویس ذخیره‌سازی در دسترس نیست.",
  "onb.again": "🔁 اجرای مجدد راهنما",
  "onb.back": "‹ بازگشت",
  "onb.cancel": "✖ انصراف",
  "onb.cancelled": "باشه، راهنما لغو شد. هر وقت خواستی با /start onboarding برگرد. 👋",
  "onb.continue": "ادامه ›",
  "onb.demo.l0": "⏰ یادآوری جلسه",
  "onb.demo.l1": "✨ معرفی توانایی‌ها",
  "onb.demo.l2": "🌅 پیام انگیزشی",
  "onb.demo.p0": "یادم بنداز فردا ساعت ۹ صبح جلسهٔ کاری دارم",
  "onb.demo.p1": "خلاصه‌ای از توانایی‌هات بگو",
  "onb.demo.p2": "یه پیام انگیزشی کوتاه برای صبح بنویس",
  "onb.demos.body": "روی یکی بزن تا واقعاً اجراش کنم 👇",
  "onb.demos.finish": "🏁 پایان راه‌اندازی",
  "onb.demos.title": "⚡ امتحانش کن",
  "onb.done.body": "بابی آماده‌ست. از این به بعد فقط حرف بزن — بقیه‌ش با من.\n\nراهنما رو هر وقت خواستی با /start onboarding دوباره اجرا کن.",
  "onb.done.title": "🎉 تمومه!",
  "onb.group_key_hint": "🔒 این مرحله بهتره توی چت خصوصی انجام بشه — کلید اینجا برای بقیهٔ گروه دیده می‌شه.",
  "onb.intro.body": "من بابی‌ام؛ ایجنت فارسی‌زبان تو توی تلگرام.\n\nیادآوری می‌ذارم، خلاصه می‌سازم، وب رو می‌گردم، فایل می‌خونم — فقط کافیه حرف بزنی.\n\nبرای اینکه واقعاً فکر کنم، اول باید به یه سرویس هوش مصنوعی وصل بشم. تو ۴ قدم راه می‌ندازیمش 👇",
  "onb.intro.start": "🚀 شروع",
  "onb.intro.title": "👋 به بابی خوش اومدی!",
  "onb.key.junk": "⚠️ این شبیه کلید نیست؛ کلید API را دوباره بفرست.",
  "onb.key.ok": "✅ وصل شد! تست زنده هم موفق بود.",
  "onb.key.retry_hint": "کلید را دوباره بفرست، یا با «بازگشت» یه سرویس دیگه انتخاب کن.",
  "onb.key.setup_fail": "❌ نشد: {msg}",
  "onb.key.testing": "⏳ دارم وصل می‌شم و یه تست زنده می‌گیرم…",
  "onb.profile.body": "لحن بابی و زبان رابط کاربری رو انتخاب کن. هر وقت خواستی با /personality و /lang عوضشون کن.",
  "onb.profile.lang_label": "🌐 زبان:",
  "onb.profile.pers_label": "🎭 شخصیت:",
  "onb.profile.title": "🎭 شخصیت و زبان",
  "onb.progress": "قدم {n} از {total}",
  "onb.provider.body": "بدون اتصال، بابی فقط یه منوست 😅\n\nیه سرویس انتخاب کن، بعد کلید API رو بفرست. همین — آدرس و مدل خودش تنظیم می‌شه.",
  "onb.provider.configured": "✅ «{label}» وصله و فعاله.",
  "onb.provider.pick": "یه سرویس انتخاب کن:",
  "onb.provider.retry": "🔁 تلاش مجدد تست",
  "onb.provider.test_fail_note": "⚠️ پروایدر ساخته شد ولی تست اتصال ناموفق بود: {msg}\nمی‌تونی دوباره تست کنی، یا ادامه بدی و بعداً از /ai بررسی‌ش کنی.",
  "onb.provider.title": "🔑 اتصال به هوش مصنوعی",
  "onb.skip": "⏭ رد شدن",
};

describe("fa pack", () => {
  test("fa pack matches the pinned ground-truth copy", () => {
    for (const [key, expected] of Object.entries(FA_EXPECTED)) {
      expect(t(key, "fa")).toBe(expected);
    }
  });

  test("the pack covers exactly the migrated keys", () => {
    expect(Object.keys(fa).sort()).toEqual(Object.keys(FA_EXPECTED).sort());
  });

  test("menu ground-truth exports match the local menu table", () => {
    // Labels moved out of the central pack into src/bot/menu_strings.ts;
    // MAIN_MENU_LABELS is the fa ground truth for the default menu.
    const labels = Object.values(MAIN_MENU_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    for (const [key, label] of Object.entries(MAIN_MENU_LABELS)) {
      expect(label, key).toBe(trMenu("fa", `menu.label.${key}`));
    }
    for (const cb of Object.values(CALLBACKS)) {
      expect(MENU_REPLIES[cb].length, cb).toBeGreaterThan(0);
    }
    expect(MENU_REPLIES[CALLBACKS.chat]).toBe(trMenu("fa", "menu.screen.chat"));
    expect(MENU_REPLIES[CALLBACKS.about]).toBe(trMenu("fa", "menu.screen.about"));
    expect(MENU_REPLIES[CALLBACKS.home]).toBe(trMenu("fa", "menu.start.text"));
  });

  test("bot ground-truth exports still match the pack", () => {
    expect(t("voice.tts_failed", "fa")).toBe(VOICE_FAILED_NOTE);
    expect(t("voice.truncated", "fa")).toBe(VOICE_TRUNCATED_NOTE);
    expect(t("compress.compressed", "fa")).toBe(COMPRESS_REPLIES.compressed);
    expect(t("compress.nothing", "fa")).toBe(COMPRESS_REPLIES.nothing_to_compress);
    expect(t("compress.failed", "fa")).toBe(COMPRESS_REPLIES.failed);
    expect(t("compress.unavailable", "fa")).toBe(COMPRESS_REPLIES.unavailable);
    for (const c of COMMAND_HELP) {
      expect(t(`help.cmd.${c.name}`, "fa")).toBe(c.descriptionFa);
    }
  });
});

// ---------------------------------------------------------------------------
// en pack: complete, non-empty, natural.
// ---------------------------------------------------------------------------

describe("en pack", () => {
  test("covers exactly the same keys as fa, none empty", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(fa).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value).toBe("string");
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  test("spot-checks read as natural English", () => {
    expect(t("menu.label.chat", "en")).toBe("Chat");
    expect(t("start.greeting", "en")).toBe("Hi! I'm BOBI. Pick an option:");
    expect(t("stop.done", "en")).toBe("Stopped ✅");
    expect(t("help.title", "en")).toBe("Available commands:");
  });
});

// ---------------------------------------------------------------------------
// t(): fallback and interpolation.
// ---------------------------------------------------------------------------

describe("t()", () => {
  test("unknown keys fall back to the key itself (fa has no entry either)", () => {
    expect(t("no.such.key", "en")).toBe("no.such.key");
    expect(t("no.such.key")).toBe("no.such.key");
  });

  test("interpolates {name}-style vars", () => {
    expect(
      t("personality.unknown", "fa", { name: "foo", options: "a، b" }),
    ).toBe("شخصیت «foo» ناشناخته است. گزینه‌ها: a، b");
    expect(t("menu.tools.item", "en", { index: 2, label: "X" })).toBe("2. X");
    expect(t("help.entry", "en", { name: "start", description: "Start" })).toBe(
      "/start — Start",
    );
  });

  test("a placeholder with no value is left as-is, never blanked", () => {
    const partial = t("personality.unknown", "fa", { name: "x" });
    expect(partial).toContain("{options}");
    expect(partial).toContain("x");
  });

  test("defaults to Persian", () => {
    expect(t("stop.done")).toBe(t("stop.done", "fa"));
  });
});

// ---------------------------------------------------------------------------
// resolveLang(): validated, fail-closed.
// ---------------------------------------------------------------------------

describe("resolveLang", () => {
  test("the pref key is 'lang'", () => {
    expect(LANG_PREF_KEY).toBe("lang");
  });

  test("only the exact string 'en' selects English", () => {
    const get = (v: string | undefined) => () => v;
    expect(resolveLang("u", get("en"))).toBe("en");
    expect(resolveLang("u", get("fa"))).toBe("fa");
    expect(resolveLang("u", get(undefined))).toBe("fa");
    expect(resolveLang("u", get(""))).toBe("fa");
    expect(resolveLang("u", get("de"))).toBe("fa");
    expect(resolveLang("u", get("EN"))).toBe("fa");
    expect(resolveLang("u", get(" en "))).toBe("fa");
  });

  test("a throwing reader falls back to Persian", () => {
    expect(
      resolveLang("u", () => {
        throw new Error("db down");
      }),
    ).toBe("fa");
  });
});

// ---------------------------------------------------------------------------
// prompt.ts: the contextFiles block (D3 wiring point).
// ---------------------------------------------------------------------------

function basePrompt() {
  return {
    tools: [],
    now: new Date("2026-10-18T12:00:00Z"),
    timezone: "UTC",
  };
}

describe("buildSystemPrompt contextFiles", () => {
  test("appends the block under the Persian header", () => {
    const prompt = buildSystemPrompt({ ...basePrompt(), contextFiles: "### AGENTS.md\nrules" });
    expect(prompt).toContain("زمینه‌ی پروژه:\n### AGENTS.md\nrules");
  });

  test("ordering: after skills, before owner extra", () => {
    const prompt = buildSystemPrompt({
      ...basePrompt(),
      skillContext: "SKILL-BLOCK",
      contextFiles: "CTX-BLOCK",
      extra: "EXTRA-BLOCK",
    });
    const skillAt = prompt.indexOf("SKILL-BLOCK");
    const ctxAt = prompt.indexOf("زمینه‌ی پروژه:");
    const extraAt = prompt.indexOf("EXTRA-BLOCK");
    expect(skillAt).toBeGreaterThan(-1);
    expect(ctxAt).toBeGreaterThan(skillAt);
    expect(extraAt).toBeGreaterThan(ctxAt);
  });

  test("absent or blank contextFiles adds nothing", () => {
    expect(buildSystemPrompt(basePrompt())).not.toContain("زمینه‌ی پروژه:");
    expect(
      buildSystemPrompt({ ...basePrompt(), contextFiles: "   \n " }),
    ).not.toContain("زمینه‌ی پروژه:");
  });
});

// ---------------------------------------------------------------------------
// Migrated call sites render the sender's language, defaulting to Persian.
// ---------------------------------------------------------------------------

function fakePrefs(lang: string | undefined) {
  const store = new Map<string, string>();
  if (lang !== undefined) store.set("lang", lang);
  return {
    getUserPref: (userId: string, key: string) => store.get(`${userId}:${key}`) ?? store.get(key),
    setUserPref: (userId: string, key: string, value: string) => {
      store.set(`${userId}:${key}`, value);
    },
  };
}

function replyCtx() {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chat: { id: 1 },
      from: { id: 7 },
      message: { text: "" },
      reply: async (text: string) => {
        replies.push(text);
      },
    },
  };
}

describe("menu in English", () => {
  test("main menu buttons use the en table", () => {
    const kb = buildMainMenu("en");
    expect(kb.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ["💬 Chat", "🛠 Tools"],
      ["⌨️ Commands", "⚙️ Settings"],
      ["ℹ️ About BOBI", "❓ Help"],
    ]);
  });

  test("default stays Persian", () => {
    const kb = buildMainMenu();
    expect(kb.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([
      [MAIN_MENU_LABELS.chat, MAIN_MENU_LABELS.tools],
      [MAIN_MENU_LABELS.commands, MAIN_MENU_LABELS.settings],
      [MAIN_MENU_LABELS.about, MAIN_MENU_LABELS.help],
    ]);
  });

  test("unknown callback and tools list translate", () => {
    expect(replyForCallback("menu:nope", undefined, "en")).toBe("Unknown option.");
    expect(toolListText([], "en")).toBe("Tools: there are no active tools.");
    const text = toolListText(["calculator", "mystery_tool"], "en");
    expect(text).toContain("BOBI's active tools:");
    expect(text).toContain("1. Calculator");
    expect(text).toContain("2. mystery_tool");
  });
});

describe("command handlers in English", () => {
  test("/help renders the en pack", async () => {
    const { replies, ctx } = replyCtx();
    await handleHelpCommand(ctx, false, "en");
    expect(replies[0]).toContain("Available commands:");
    expect(replies[0]).toContain("/help — Command reference");
    expect(replies[0]).not.toContain("/admin");
  });

  test("/help defaults to Persian", async () => {
    const { replies, ctx } = replyCtx();
    await handleHelpCommand(ctx, false);
    expect(replies[0]).toContain("دستورهای موجود:");
  });

  test("/stop confirmations translate", async () => {
    const { replies, ctx } = replyCtx();
    await handleStopCommand(ctx, { engine: { cancel: () => {} } }, "en");
    expect(replies).toEqual(["Nothing was running."]);
  });

  test("/reset confirmation translates", async () => {
    const { replies, ctx } = replyCtx();
    await handleResetCommand(
      { ...ctx, message: { text: "/reset --confirm" } },
      { engine: { cancel: () => {}, clearHistory: () => {} } },
      "en",
    );
    expect(replies).toEqual(["This conversation's history was cleared. 🧹"]);
  });

  test("/reset bare asks for confirmation in the sender's language", async () => {
    const { replies, ctx } = replyCtx();
    await handleResetCommand(
      ctx,
      { engine: { cancel: () => {}, clearHistory: () => {} } },
      "en",
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("/reset --confirm");
  });

  test("/compress failure reply translates", async () => {
    const { replies, ctx } = replyCtx();
    await handleCompressCommand(
      ctx,
      {
        engine: {
          compressNow: async () => {
            throw new Error("boom");
          },
        },
      },
      "en",
    );
    expect(replies).toEqual(["Summarization failed; try again later."]);
  });

  test("/voice not-configured reply translates", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = { prefs: fakePrefs(undefined) };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en");
    expect(replies).toEqual(["Text-to-speech is not configured; voice mode is unavailable."]);
  });

  test("/voice set confirmation translates", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = {
      tts: { baseUrl: "http://x", apiKey: "", model: "m", voice: "v" },
      prefs: fakePrefs(undefined),
    };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en", "always");
    expect(replies[0]).toContain("voice mode: always");
  });

  test("/voice prompt shows the current mode in the sender's language", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = {
      tts: { baseUrl: "http://x", apiKey: "", model: "m", voice: "v" },
      prefs: fakePrefs(undefined),
    };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en");
    expect(replies[0]).toContain("Current voice-reply mode: auto.");
  });

  test("/voice unknown option translates", async () => {
    const replies: string[] = [];
    const env: VoiceCommandEnv = {
      tts: { baseUrl: "http://x", apiKey: "", model: "m", voice: "v" },
      prefs: fakePrefs(undefined),
    };
    await handleVoiceCommand({ from: { id: 7 }, reply: async (t) => { replies.push(t); } }, env, "en", "maybe");
    expect(replies).toEqual(["Unknown option; use one of: auto, always, never."]);
  });

  test("/personality unknown-name reply translates", async () => {
    const { replies, ctx } = replyCtx();
    await handlePersonalityCommand(
      { ...ctx, message: { text: "/personality nope" } },
      { prefs: fakePrefs(undefined) },
      "en",
    );
    expect(replies[0]).toContain("Unknown personality «nope».");
  });

  test("/personality save failure uses the shared prefs key", async () => {
    const { replies, ctx } = replyCtx();
    const prefs = {
      getUserPref: () => undefined,
      setUserPref: () => {
        throw new Error("disk full");
      },
    };
    await handlePersonalityCommand(
      { ...ctx, message: { text: "/personality concise" } },
      { prefs },
      "en",
    );
    expect(replies).toEqual(["Couldn't save the setting; try again."]);
  });
});

describe("formatCommandHelp", () => {
  test("fa pack descriptions match the entries", () => {
    const text = formatCommandHelp(visibleCommandHelp(true), "fa");
    expect(text).toContain("/ai — مدیریت ارائه‌دهندهٔ هوش مصنوعی");
  });

  test("en renders translated descriptions", () => {
    const text = formatCommandHelp(visibleCommandHelp(true), "en");
    expect(text).toContain("/ai — Manage the AI provider");
  });
});

// ---------------------------------------------------------------------------
// bot.ts §11c: the remaining hardcoded strings now go through t().
// ---------------------------------------------------------------------------

describe("bot.ts error paths (§11c i18n)", () => {
  const engineErr = (kind: ConstructorParameters<typeof EngineError>[0]) =>
    new EngineError(kind, "boom");

  test("every engine error kind maps to a pack string in both languages", () => {
    const expected: Record<string, [string, string]> = {
      empty_input: ["پیام خالی است.", "The message is empty."],
      empty_response: ["پاسخی نگرفتم؛ دوباره تلاش کن.", "I got no reply; try again."],
      auth: ["سرویس در دسترس نیست (احراز هویت).", "The service is unavailable (authentication)."],
      quota: ["سقف استفاده پر شده؛ کمی بعد تلاش کن.", "The usage quota is full; try again in a bit."],
      network: ["خطای شبکه؛ دوباره تلاش کن.", "Network error; try again."],
      timeout: ["پاسخ خیلی طول کشید؛ لغو شد.", "The reply took too long; it was cancelled."],
      aborted: ["پاسخ خیلی طول کشید؛ لغو شد.", "The reply took too long; it was cancelled."],
      overloaded: ["سیستم شلوغه؛ لحظه‌ای بعد تلاش کن.", "The system is busy; try again in a moment."],
    };
    for (const [kind, [faText, enText]] of Object.entries(expected)) {
      const err = engineErr(kind as ConstructorParameters<typeof EngineError>[0]);
      expect(userFacingMessage(err, "fa"), kind).toBe(faText);
      expect(userFacingMessage(err, "en"), kind).toBe(enText);
    }
  });

  test("superseded stays silent; unknown engine errors and non-engine errors degrade gracefully", () => {
    expect(userFacingMessage(engineErr("superseded"), "fa")).toBe("");
    expect(userFacingMessage(engineErr("superseded"), "en")).toBe("");
    // An engine error kind added later falls back to the generic message.
    expect(userFacingMessage(new Error("weird"), "fa")).toBe("خطای غیرمنتظره.");
    expect(userFacingMessage(new Error("weird"), "en")).toBe("Unexpected error.");
  });

  test("tool errors still use the tool layer's message (unchanged behaviour)", () => {
    const err = new ToolError("timeout", "timed out");
    const msg = userFacingMessage(err, "fa");
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  test("rate-limit and truncation notes resolve through t() in both languages", () => {
    expect(t("ratelimit.wait", "fa", { seconds: 42 })).toBe(
      "یه کم تند رفتی؛ حدود 42 ثانیهٔ دیگه دوباره تلاش کن.",
    );
    expect(t("ratelimit.wait", "en", { seconds: 42 })).toBe(
      "You're going a bit fast; try again in about 42 seconds.",
    );
    expect(t("reply.truncated", "fa")).toBe(
      "به سقف مراحل این پاسخ رسیدم؛ برای جزئیات بیشتر دقیق‌تر بپرس.",
    );
    expect(t("reply.truncated", "en")).toBe(
      "I hit this reply's step budget; ask more specifically for more detail.",
    );
  });

  test("describeSkipped names each reason in both languages", () => {
    const skipped = [
      { kind: "photo", reason: "too_large" },
      { kind: "document", reason: "unsupported" },
      { kind: "voice", reason: "download_failed" },
      { kind: "voice", reason: "too_long" },
    ];
    expect(describeSkipped(skipped, "fa")).toBe(
      "این پیوست‌ها استفاده نشدند:\n" +
        "• photo: حجمش بیش از حد مجاز بود.\n" +
        "• document: این نوع فایل پشتیبانی نمی‌شود.\n" +
        "• voice: دریافت نشد.\n" +
        "• voice: طولش از حد مجاز بیشتر بود.",
    );
    expect(describeSkipped(skipped, "en")).toBe(
      "These attachments couldn't be used:\n" +
        "• photo: over the size limit.\n" +
        "• document: this file type isn't supported.\n" +
        "• voice: couldn't be fetched.\n" +
        "• voice: too long to process.",
    );
    expect(describeSkipped([], "fa")).toBe("");
  });

  test("describeNothingUsable falls back to the empty-message note", () => {
    expect(describeNothingUsable([], "fa")).toBe("پیام خالی است.");
    expect(describeNothingUsable([], "en")).toBe("The message is empty.");
    const note = describeNothingUsable([{ kind: "photo", reason: "too_large" }], "fa");
    expect(note).toContain("این پیوست‌ها استفاده نشدند:");
  });
});
