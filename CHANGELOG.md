# CHANGELOG — BOBI

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

## v1.1 — Backlog / برنامه آینده

The following 7 items are planned for v1.1 (no web search used):

1. **Provider auto-failover** — خودکار سوئیچ بین پرووایدرها در صورت خرابی
2. **Smart model routing** — مسیریابی هوشمند به مدل مناسب هر درخواست
3. **Natural-language reminders/scheduling** — یادآوری و زمان‌بندی با زبان طبیعی
4. **Usage/cost transparency dashboard** — داشبورد شفاف مصرف و هزینه
5. **Smarter proactive digest** — دایجست فعال هوشمندتر
6. **Custom shortcuts** — میان‌برهای سفارشی
7. **Public skill marketplace** — مارکت‌پلیس عمومی اسکیل‌ها
