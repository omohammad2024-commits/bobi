# CHANGELOG — BOBI

## v1.1.0 — "Power Core" — 2026-10-20

### فارسی

**بابی ۱.۱.۰ «Power Core» منتشر شد.** تمرکز این نسخه: چتی که همیشه جواب می‌دهد — هسته‌ی قوی‌تر، اتصال محکم‌تر، و پرووایدری که دیگر نمی‌تواند بی‌سروصدا خراب شود.

- **قابلیت اطمینان چت (تیتر نسخه):** تست اتصال دومرحله‌ای و راست‌گو برای هر مدل (Ping + یک نوبت واقعی با ابزار و استریم)؛ استریم خراب یا خالی → تلاش خودکار بدون استریم؛ پاسخ خالی = خرابی پرووایدر و فیل‌اور به کاندیدای بعدی؛ قرنطینه‌ی per-model برای مدل‌هایی که پشت‌سرهم خراب می‌شوند؛ و خطاهای شفاف با شمارش تلاش‌ها — «(tried N providers)».
- **اپگرید هسته:** اجرای موازی ابزارهای فقط‌خواندنی با خودتصحیحی و تشخیص لوپ، حالت برنامه‌ریزی (planner) برای درخواست‌های چندمرحله‌ای؛ بودجه‌ی توکنی per-turn با فشرده‌سازی نتایج بزرگ ابزار و تریگر خودکار خلاصه‌سازی؛ circuit breaker برای هر پرووایدر با ریتری محدود.
- **هسته‌ی حافظه:** خلاصه‌های اپیزودیک از نشست‌های قبلی، ادغام و ترفیع/فرسایش خودکار خاطرات، فراخوانی پیش‌دستانه‌ی خاطرات مرتبط در پرامپت، و جایگزینی تناقض‌ها (اسکیما v22 با تله‌متری recall).
- **معماری پلاگینی ابزارها + روتر نیت:** هر ابزار مانیفست مستقل خودش را دارد و از هسته جداست؛ روتر قطعیِ بدون LLM پیام را می‌خواند و ابزار درست را جلو می‌اندازد (لینک → دانلودر).
- **لایه‌ی اتصال جدید:** مدیر اتصال per-host با کانکشن‌های گرم و keep-alive (از جمله برای استریم)، احترام کامل به Retry-After، پروب پس‌زمینه و ریکاوری خودکار پرووایدرها، پیش‌گرم‌کردن مقصد فیل‌اور، و آمار زنده‌ی اتصال در نتایج پروب.
- **شفافیت پرووایدر:** خطاها حالا استاتوس واقعی HTTP را نام می‌برند (402 یعنی سهمیه/موجودی تمام است)؛ دکمه‌ی ⚡Test برای تک‌تک مدل‌ها در مینی‌اپ؛ پیش‌فرض تایم‌اوت پرووایدر ۵ دقیقه.
- **شخصیت و حس چت:** شخصیت deadpan به سبک Evil با آینه‌کاری طول پاسخ؛ بابی سازنده‌اش را می‌شناسد («بله پدر؟»)؛ ریپلای/quote صریح در گروه و — از این نسخه — در چت خصوصی هم؛ بلاک‌های طولانی در quote بازشونده.
- **امکانات تازه:** دانلودر همه‌کاره (یوتیوب/اینستا/تیکتاک/X/مستقیم با yt-dlp)، یادآوری با زبان طبیعی فارسی، میان‌برهای شخصی، داشبورد مصرف و هزینه، دایجست صبح هوشمندتر، مسیریابی هوشمند مدل — هر ۶ آیتم بک‌لاگ v1.1 تحویل شد.
- **گروه‌ها:** بیداری با wake word («بابی»)، نقش صریح ضدتقلید از کاربر، و رفع بلعیده‌شدن پیام‌های گروه توسط فرم‌های خصوصی.
- مدل دسترسی دوطبقه دست‌نخورده؛ بیش از ۳۶۰۰ تست خودکار سبز.

### English

**BOBI 1.1.0 "Power Core" released.** Theme: a chat that always answers — a stronger core, a tougher connection layer, and providers that can no longer fail silently.

- **Chat reliability (headline):** an honest two-stage test for every model (Ping + a realistic turn with tools and streaming); a broken or empty stream automatically retries non-streaming; an empty response counts as a provider failure and fails over to the next candidate; per-model quarantine sidelines models that keep failing; final errors report how many providers were tried — "(tried N providers)".
- **Core upgrade:** parallel read-only tool execution with self-correction and loop detection, a planner mode for multi-step requests; per-turn token budgeting with tool-result compaction and an automatic summary-fold trigger; a per-provider circuit breaker with bounded in-call retry.
- **Memory core:** episodic summaries of past sessions, automatic memory consolidation with promotion/decay, proactive recall of relevant memories injected into the prompt, and contradiction supersession (schema v22 with recall telemetry).
- **Plugin tool architecture + intent router:** every tool carries its own independent manifest, decoupled from the core; a deterministic, LLM-free intent router reads each message and puts the right tool first (a link → the downloader).
- **New connection layer:** a per-host connection manager with warm keep-alive connections (streaming included), full Retry-After support, background health probes with automatic provider recovery, failover pre-warming, and live connection stats on probe results.
- **Provider transparency:** errors name the real HTTP status (402 = quota/balance exhausted); a per-model ⚡Test button in the mini app; the default provider timeout is now 5 minutes.
- **Personality & chat feel:** deadpan Evil-style personality with reply-length mirroring; BOBI knows its creator ("Yes, father?"); explicit reply-quoting in groups and — new in this release — private chats too; long blocks render as expandable quotes.
- **New features:** the all-in-one downloader (YouTube/Instagram/TikTok/X/direct via yt-dlp), natural-language Persian reminders, personal shortcuts, a usage & cost dashboard, a smarter morning digest, and smart model routing — all six v1.1 backlog items delivered.
- **Groups:** wake-word replies ("بابی"), an explicit anti-mimicry role guard, and a fix for group messages being swallowed by private setup forms.
- Two-tier access model intact; 3,600+ automated tests green.

---

## v1.0.0 — 2026-10-19

### فارسی

**بابی ۱.۰.۰ منتشر شد.** بنیان محکم: تکمیل برابری با Hermes (۵۹ ویژگی، ۵۳ دستور)، سپس ارتقا و سخت‌کاری.

- **سیستم پرووایدر (AI Provider):** چندپرووایدره با انتخاب خودکار (auto-select)، تست اتصال هنگام انتخاب (probe-on-select)، پریست‌های Cloudflare Workers AI / 9Router / OpenRouter / OpenCode Zen، خطاهای دقیق با نام پرووایدر خراب، رزولوشن در هر نوبت (per-turn)، و استریمینگ پاسخ‌ها (با سوئیچ قطع `BOBI_STREAMING=0`).
- **دایت پرامپت:** پرامپت سیستم ~۴.۷K → ~۳.۹K توکن؛ پاسخ‌های سریع‌تر و ارزان‌تر.
- **مینی اپ مالک:** ۱۰ تب، طراحی تیرهٔ مدرن بازطراحی‌شده (موبایل‌فرست): چت، AI، حافظه، تقویم، فایل‌ها، بنچمارک، داشبورد، اسکیل‌ها، گروه‌ها، تنظیمات.
- **رابط تلگرام:** منوهای تمیز بر اساس سلیقه مالک، انگلیسی‌زبان یکدست (دستور `/lang` حذف شد)، کالریت دستورات اینلاین، ویزارد آنبوردینگ ۴ مرحله‌ای، /digest تعاملی، حلقه صوتی.
- **ایجنت:** ۳۵ ابزار، حافظهٔ ترکیبی FTS5 + معنایی، دایجست صبحگاهی فارسی، مداخلهٔ هوشمند گروه، خلاصهٔ خودکار مکالمه‌ها؛ **رفع بحرانی:** هنگ شدن روی abort (ایجنت دیگر گیر نمی‌کند).
- **سخت‌کاری v1.0:** رفع باگ‌های سطح بالای حسابرسی — پلیسهولدر `{ACCOUNT_ID}` در فلوی Cloudflare، `allowLocal` در probe، تُوست‌های موفقیت جعلی، تایم‌اوت‌های بدون سقف، حساسیت به حروف کوچک/بزرگ در Bearer.
- مدل دسترسی دوطبقه دست‌نخورده: مالک همه‌چیز می‌بیند، بقیه فقط /start، گفتگو، /help (عمومی) و /lang را — ممنوعه‌ها نامرئی‌اند، نه فقط بلاک‌شده.

### English

**BOBI 1.0.0 released.** Solid foundation: full Hermes parity (59 features, 53 commands), then upgrades and hardening.

- **Provider system:** multi-provider with auto-select, probe-on-select, Cloudflare Workers AI / 9Router / OpenRouter / OpenCode Zen presets, precise errors naming the broken provider, per-turn provider resolution, and streaming responses (kill switch `BOBI_STREAMING=0`).
- **Prompt diet:** system prompt ~4.7K → ~3.9K tokens; faster and cheaper replies.
- **Owner mini app:** 10 tabs, redesigned modern dark UI (mobile-first): Chat, AI, Memory, Calendar, Files, Benchmarks, Dashboard, Skills, Groups, Settings.
- **Telegram UI:** clean menus per owner reference, English-only (removed `/lang`), inline command palette, 4-step onboarding wizard, interactive /digest, voice-first loop.
- **Agent:** 35 tools, hybrid FTS5 + semantic memory, Persian morning digest, smart group moderation, auto conversation summaries; **critical fix:** agent no longer hangs on abort.
- **v1.0 hardening pass:** headline audit fixes — `{ACCOUNT_ID}` placeholder in the Cloudflare flow, `allowLocal` in probe, fake success toasts, unclamped timeouts, Bearer case-sensitivity.
- Two-tier access model intact: owner sees everything; public gets only /start, chat, /help (public part), /lang — owner-only commands are invisible to others, not just blocked.

---

## v1.2 — Backlog / برنامه آینده

Delivered in **v1.1.0** (the old v1.1 plan, complete): provider auto-failover, smart model routing, natural-language reminders/scheduling, usage/cost transparency dashboard, smarter proactive digest, custom shortcuts.

Still planned:

1. **Public skill marketplace** — مارکت‌پلیس عمومی اسکیل‌ها
