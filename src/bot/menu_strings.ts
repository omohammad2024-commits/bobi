import type { Lang } from "../i18n";

/**
 * Phase: menu/help UI redesign — start screen, menu screens, grouped /help.
 *
 * All NEW user-facing strings for `menu.ts` and the /start + /help handlers
 * in `bot.ts`, in Persian and English. The coordinator folds these keys into
 * `src/i18n/fa.ts` / `src/i18n/en.ts` later (never touch those files from
 * here); until then this module is the single source of truth. Every key uses
 * the `menu.*` prefix so the fold-in cannot collide with other tables.
 *
 * Copy rules: Persian is the ground truth — tight, خودمونی, no filler, تو
 * (never شما). English mirrors it 1:1 and must stay free of Persian script
 * (asserted by tests/lang_switch.test.ts). Emoji are purposeful, one per
 * line at most.
 *
 * Template vars are `{name}` placeholders, substituted by `tr()`.
 */

type Vars = Record<string, string | number>;

const FA: Record<string, string> = {
  // ---- /start + home screen ----
  "menu.start.text":
    "🤖 سلام! من بابی‌ام — ایجنت شخصی تو.\n" +
    "\n" +
    "📌 چی بلدم:\n" +
    "💬 گفت‌وگو — هر چی تو ذهنته فقط بنویس\n" +
    "🗂 نشست‌ها — تاریخچه، ذخیره، شاخه‌سازی، ازسرگیری\n" +
    "⚡️ اتوماسیون — یادآور، زمان‌بندی، اجرای پس‌زمینه\n" +
    "🛠 ابزارها — جستجوی وب، حساب‌وکتاب، خواندن صفحه\n" +
    "\n" +
    "🚀 برای شروع:\n" +
    "1️⃣ فقط بنویس — مثلاً «برنامهٔ امروزم رو بچین»\n" +
    "2️⃣ با /voice جواب صوتی رو روشن کن\n" +
    "3️⃣ با /help همهٔ فرمان‌ها رو ببین",

  // ---- menu screens ----
  "menu.screen.chat":
    "💬 گفت‌وگو\n" +
    "\n" +
    "فقط بنویس — همین‌جا. سوال، ایده، کار، هر چی تو ذهنته.\n" +
    "بابی می‌خونه و جواب می‌ده؛ لازم نیست فرمانی بلد باشی.\n" +
    "\n" +
    "می‌خوای تمیز شروع کنی؟ /reset",

  "menu.screen.tools_fallback":
    "🛠 ابزارها\n" + "\n" + "سرویس ابزارها در دسترس نیست؛ لیست ابزارهای فعال رو نمی‌تونم نشون بدم.",

  "menu.screen.commands":
    "⌨️ فرمان‌های پرکاربرد\n" +
    "\n" +
    "/history 20 — تاریخچهٔ گفت‌وگو\n" +
    "/save — ذخیرهٔ گفت‌وگو به‌صورت فایل\n" +
    "/undo 2 — برگردوندن نوبت‌های آخر\n" +
    "/new — شروع نشست تازه\n" +
    "/bg — اجرای دستور در پس‌زمینه\n" +
    "/queue — صف‌بندی پیام\n" +
    "/plan — طرح اجرایی، بدون اجرا\n" +
    "/memory — مدیریت حافظهٔ بلندمدت\n" +
    "\n" +
    "📖 فهرست کامل و دسته‌بندی‌شده: /help",

  "menu.screen.settings":
    "⚙️ تنظیمات سریع\n" +
    "\n" +
    "/voice — روشن/خاموش کردن پاسخ صوتی\n" +
    "/personality — لحن جواب‌های بابی\n" +
    "/lang — زبان رابط (فارسی / English)\n" +
    "/footer — پانویس فنی آخر پاسخ‌ها\n" +
    "/busy — رفتار بابی وقتی مشغوله\n" +
    "\n" +
    "این تنظیم‌ها فقط برای تو ذخیره می‌شن.",

  "menu.screen.about":
    "🤖 بابی — ایجنت شخصی تو.\n" +
    "\n" +
    "اینجا حرف بزن، یادآور بذار، کارهات رو زمان‌بندی کن،\n" +
    "حافظه و ابزارهاش رو مدیریت کن.\n" +
    "\n" +
    "❓ راهنما: /help",

  "menu.screen.help":
    "❓ راهنمای سریع\n" +
    "\n" +
    "💬 فقط بنویس — بابی جواب می‌ده\n" +
    "🗂 /history 20 — تاریخچهٔ گفت‌وگو\n" +
    "💾 /save — ذخیرهٔ گفت‌وگو\n" +
    "🆕 /new — نشست تازه\n" +
    "⚡️ /bg — اجرای پس‌زمینه\n" +
    "\n" +
    "📖 فهرست کامل: /help",

  // ---- menu button labels ----
  "menu.label.chat": "💬 گفت‌وگو",
  "menu.label.tools": "🛠 ابزارها",
  "menu.label.commands": "⌨️ فرمان‌ها",
  "menu.label.settings": "⚙️ تنظیمات",
  "menu.label.about": "ℹ️ دربارهٔ بابی",
  "menu.label.help": "❓ راهنما",
  "menu.label.back": "◀️ بازگشت",
  "menu.label.miniapp": "🛠️ مدیریت (مینی‌اپ)",

  // ---- grouped /help ----
  "menu.help.group.general": "🔹 عمومی",
  "menu.help.group.session": "🗂 نشست",
  "menu.help.group.automation": "⚡️ اتوماسیون",
  "menu.help.group.owner": "🔒 مالک",
  "menu.help.entry": "/{name} — {description}",
  "menu.help.entry_example": "/{name} {example} — {description}",
};

const EN: Record<string, string> = {
  // ---- /start + home screen ----
  "menu.start.text":
    "🤖 Hi! I'm BOBI — your personal agent.\n" +
    "\n" +
    "📌 What I can do:\n" +
    "💬 Chat — just type what's on your mind\n" +
    "🗂 Sessions — history, export, branching, resume\n" +
    "⚡️ Automation — reminders, schedules, background runs\n" +
    "🛠 Tools — web search, calculator, page reader\n" +
    "\n" +
    "🚀 To get going:\n" +
    "1️⃣ Just write — e.g. “plan my day”\n" +
    "2️⃣ Turn on voice replies with /voice\n" +
    "3️⃣ See every command with /help",

  // ---- menu screens ----
  "menu.screen.chat":
    "💬 Chat\n" +
    "\n" +
    "Just type — right here. Questions, ideas, tasks, anything on your mind.\n" +
    "No commands to memorize.\n" +
    "\n" +
    "Want a clean slate? /reset",

  "menu.screen.tools_fallback":
    "🛠 Tools\n" + "\n" + "The tool service is unavailable; I can't list the active tools right now.",

  "menu.screen.commands":
    "⌨️ Handy commands\n" +
    "\n" +
    "/history 20 — conversation history\n" +
    "/save — export the conversation to a file\n" +
    "/undo 2 — drop the last turns\n" +
    "/new — start a fresh session\n" +
    "/bg — run a prompt in the background\n" +
    "/queue — queue a message\n" +
    "/plan — step-by-step plan, no execution\n" +
    "/memory — manage long-term memory\n" +
    "\n" +
    "📖 Full grouped reference: /help",

  "menu.screen.settings":
    "⚙️ Quick settings\n" +
    "\n" +
    "/voice — turn voice replies on/off\n" +
    "/personality — BOBI's reply tone\n" +
    "/lang — interface language (Persian / English)\n" +
    "/footer — technical footer on replies\n" +
    "/busy — behavior while BOBI is busy\n" +
    "\n" +
    "These settings are stored just for you.",

  "menu.screen.about":
    "🤖 BOBI — your personal agent.\n" +
    "\n" +
    "Chat here, set reminders, schedule tasks,\n" +
    "manage memory and tools.\n" +
    "\n" +
    "❓ Help: /help",

  "menu.screen.help":
    "❓ Quick help\n" +
    "\n" +
    "💬 Just type — BOBI answers\n" +
    "🗂 /history 20 — conversation history\n" +
    "💾 /save — export the conversation\n" +
    "🆕 /new — fresh session\n" +
    "⚡️ /bg — background run\n" +
    "\n" +
    "📖 Full reference: /help",

  // ---- menu button labels ----
  "menu.label.chat": "💬 Chat",
  "menu.label.tools": "🛠 Tools",
  "menu.label.commands": "⌨️ Commands",
  "menu.label.settings": "⚙️ Settings",
  "menu.label.about": "ℹ️ About BOBI",
  "menu.label.help": "❓ Help",
  "menu.label.back": "◀️ Back",
  "menu.label.miniapp": "🛠️ Manage (Mini App)",

  // ---- grouped /help ----
  "menu.help.group.general": "🔹 General",
  "menu.help.group.session": "🗂 Session",
  "menu.help.group.automation": "⚡️ Automation",
  "menu.help.group.owner": "🔒 Owner",
  "menu.help.entry": "/{name} — {description}",
  "menu.help.entry_example": "/{name} {example} — {description}",
};

const PACKS: Record<Lang, Record<string, string>> = { fa: FA, en: EN };

/**
 * Look up a `menu.*` key and substitute `{vars}`.
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
