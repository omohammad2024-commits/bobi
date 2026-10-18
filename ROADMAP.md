# نقشهٔ راه — رسیدن به برابری با هرمس

هدف: پوشش همهٔ قابلیت‌های هرمس، با حفظ مزیت‌های بابی (کوچک، قابل‌ممیزی، فارسی، مالکیت کامل).

---

## دسته‌بندی بر اساس واقعیت

### 🟢 دستهٔ ۱ — بنیادی (چند قابلیت را هم‌زمان باز می‌کند)

این‌ها را **اول** می‌سازیم چون بقیه رویشان سوار می‌شوند:

| قطعه | چه چیزی را باز می‌کند |
|---|---|
| **محتوای چندوجهی** (multimodal) | vision + voice + document-extraction + image-generation |
| **زمان‌بند تعمیم‌یافته** (cron) | cron + heartbeat + loops + goals |
| **رجیستری skill/plugin** | skills + plugins + hooks + personality + context-files |

سه قطعه. اگر این سه درست ساخته شوند، بقیه کارِ اتصال است نه معماری.

### 🟡 دستهٔ ۲ — کار واقعی، ولی مستقیم

| قابلیت | تخمین |
|---|---|
| `/help`، `/reset`، `/personality` | ۱ ساعت |
| جستجوی FTS5 روی مکالمات | ۲ ساعت (SQLite از قبل دارد) |
| فایل‌های context | ۱ ساعت |
| استخراج PDF/DOCX | ۲ ساعت |
| ترنسکرایب ویس | ۳ ساعت |
| TTS | ۲ ساعت |
| تولید تصویر | ۲ ساعت |
| credential-pools + provider-routing | ۳ ساعت |
| tool-search | ۲ ساعت |
| delegation (subagent) | ۴ ساعت |
| mixture-of-agents | ۳ ساعت |
| language-packs | ۴ ساعت |
| hooks | ۲ ساعت |
| personality | ۱ ساعت |

### 🔴 دستهٔ ۳ — سنگین یا پرخطر

| قابلیت | مسئله |
|---|---|
| **۶ پلتفرم** | هر کدام یک انتگریشن کامل. Discord/Slack منطقی است؛ WhatsApp/Signal نیاز به کتابخانهٔ جدا و شماره تلفن دارد |
| **۷ backend اجرا** | Docker منطقی، بقیه نیاز به حساب ابری |
| **code-execution** | ⚠️ خطرناک‌ترین قابلیت کل لیست — پایین توضیح داده شده |
| **computer-use** | کنترل دسکتاپ. سطح حملهٔ عظیم |
| **web-dashboard + kanban** | یک محصول جداست، نه یک قابلیت |
| **LSP** | فقط برای کار با کد معنا دارد؛ بابی ربات چت است |
| **browser** | Playwright لازم دارد (سنگین). `fetch_url` بخش زیادی را پوشش می‌دهد |
| **acp / codex-app-server** | اتصال به agent دیگر — اول باید خودمان کامل باشیم |

---

## فازها

### فاز A — بنیاد ✅ (تکمیل ۱۸ اکتبر ۲۰۲۶)
- **A1** ✅ قرارداد پیام چندوجهی: `text | image | audio | document` در provider — ماتریس wire هر آداپتر در تست‌ها پین شد؛ سندهای متنی در `openai_compatible` اینلاین می‌شوند ([docs/phase-a1-multimodal.md](docs/phase-a1-multimodal.md))
- **A2** ✅ زمان‌بند تعمیم‌یافته: از «یادآور» به «کار زمان‌دار با اکشن» — پارسر کرون خالص، جدول `scheduled_tasks`، ابزارهای `schedule_task`/`list_tasks`/`cancel_task` (فقط مالک) ([docs/phase-a2-scheduler.md](docs/phase-a2-scheduler.md))
- **A3** ✅ رجیستری skill: بارگذاری از فایل مارک‌داون + frontmatter، جستجو و تزریق در prompt ([docs/phase-a3-skills.md](docs/phase-a3-skills.md))

### فاز B — ورودی/خروجی ✅ (تکمیل ۱۸ اکتبر ۲۰۲۶)
- **B1** ✅ vision — تحلیل عکس (تلگرام از قبل عکس می‌فرستد)؛ مسیر کامل در تست‌های فاز A1 پین شد
- **B2** ✅ transcribe — پیام صوتی به متن: رونویسی خودکار با Whisper-compatible وقتی پروایدر صدای native ندارد ([docs/phase-b2-transcribe.md](docs/phase-b2-transcribe.md))
- **B3** ✅ TTS — پاسخ صوتی: دستور `/voice` + ترجیح per-user در `user_prefs` ([docs/phase-b3-tts.md](docs/phase-b3-tts.md))
- **B4** ✅ image-generation — تولید تصویر: ابزار `generate_image` با تحویل عکس به کاربر از مسیر `extractMedia` ([docs/phase-b4-imagegen.md](docs/phase-b4-imagegen.md))
- **B5** ✅ document-extraction — PDF/DOCX/XLSX: استخراج محلی بدون وابستگی سنگین (ZIP دستی + `pdf-parse`) وقتی پروایدر سند native ندارد ([docs/phase-b5-docextract.md](docs/phase-b5-docextract.md))

### فاز C — خودمختاری ✅ (تکمیل ۱۸ اکتبر ۲۰۲۶)
- **C1** ✅ cron با عبارات زمان‌بندی — با A2 پوشش داده شد (پارسر کرون + وظایف زمان‌دار)
- **C2** ✅ goals + heartbeat + loops — جدول‌های `goals` و `heartbeat_log` (اسکیما ۱۴)، ابزارهای `add_goal`/`list_goals`/`complete_goal` (فقط مالک)، سرویس `HeartbeatService` با موتور اختصاصی کم‌بودجه (پیش‌فرض خاموش) ([docs/phase-c2-heartbeat.md](docs/phase-c2-heartbeat.md))
- **C3** ✅ delegation — subagent موازی: ابزار `delegate` با رجیستری فیلترشده‌ی ساختاری (عمق ۱، بدون بازگشت)، همان مجوز فراخواننده، بودجه‌ی محدود ([docs/phase-c3-delegate.md](docs/phase-c3-delegate.md))
- **C4** ✅ mixture-of-agents — ابزار `consult_models`: مشورت موازی با حداکثر ۳ مدل + ترکیب با مدل اصلی؛ مسیریابی واقعی چندمدلی از `gateway.completeForModel` ([docs/phase-c4-mixture.md](docs/phase-c4-mixture.md))

### فاز D — حافظه و دانش
- **D1** ✅ FTS5 روی مکالمات گذشته — جدول مجازی `messages_fts` (external-content + تریگرهای هم‌تراکنش)، ابزار `search_history` با اسکوپ per-user ([docs/phase-d1-fts.md](docs/phase-d1-fts.md))
- **D2** ✅ memory-providers (بک‌اند قابل‌تعویض) — رابط `MemoryProvider` + پیاده‌سازی SQLite + رجیستری؛ انتخاب با `BOBI_MEMORY_PROVIDER` ([docs/phase-d2-memory-providers.md](docs/phase-d2-memory-providers.md))
- **D3** ✅ context-files — فایل‌های مارک‌داون دست‌ساز مالک (`BOBI_CONTEXT_FILES`، پیش‌فرض `./AGENTS.md,./SOUL.md`) با کش mtime و snapshot به‌ازای هر نوبت؛ سقف ۱۶KB/فایل و ۸۰۰۰ کاراکتر تزریق ([docs/phase-d3-context-files.md](docs/phase-d3-context-files.md))
- **D4** ✅ curator — نگهدارنده‌ی حافظه: پیشنهادهای ادغام/حذف/تقسیم با تأیید صریح مالک (`curate_memories` / `curator_decide`)، هرگز اعمال خودکار، انقضای ۷ روزه ([docs/phase-d4-curator.md](docs/phase-d4-curator.md))
- **D5** ✅ language-packs — بسته‌های زبانی `src/i18n/` (فارسی پیش‌فرض بایت‌به‌بایت، انگلیسی کامل)؛ زبان per-user با کلید `lang` در `user_prefs` ([docs/phase-d5-i18n.md](docs/phase-d5-i18n.md))

### فاز E — اتصال
- **E1** انتزاع پلتفرم + Discord
- **E2** ✅ plugins + hooks — افزونه = پوشه‌ی `plugin.md` + `skills/` + `hooks/` (بدون اجرای کد، برخلاف هرمس)؛ هوک‌های `startup`/`agent:start`/`agent:end`/`tool:end` با اکشن `tool` اعتبارسنجی‌شده و اجرای same-actor ([docs/phase-e2-plugins-hooks.md](docs/phase-e2-plugins-hooks.md))
- **E3** ✅ credential-pools + provider-routing — جدول `ai_credential_pool` (اسکیما ۱۶): کلیدهای پشتیبان per-provider با رمزنگاری AES-256-GCM، چرخش round-robin وزن‌دار + کول‌داون ۵دقیقه‌ای روی 401؛ دکمه‌ی «کلید پشتیبان» در پنل `/ai` (فقط مالک) ([docs/phase-e3-pools.md](docs/phase-e3-pools.md))
- **E4** ✅ tool-gateway + tool-search — طبقه‌بندی تول‌ست‌ها (`utils`/`memory`/`schedule`/`web`/`media`/`agents`/`system`)، `setActiveToolsets()`، و ابزار `tool_search` (جستجوی فارسی ابزارها، فقط از مجموعه‌ی قابل‌مشاهده‌ی همان اکتر) ([docs/phase-e4-tool-gateway.md](docs/phase-e4-tool-gateway.md))
- **E5** ✅ api-server — سرور HTTP حداقلی: `GET /health` + `POST /api/v1/turn` با Bearer token (constant-time)، نوبت با هویت مالک سمت سرور، bind پیش‌فرض لوکال‌هاست ([docs/phase-e5-api.md](docs/phase-e5-api.md))
- **E6** Slack، WhatsApp، Signal، Email
- **E7** web-dashboard + kanban

### فاز F — کد و کامپیوتر
- **F1** code-execution در Docker (⚠️ بخش امنیتی زیر را بخوان)
- **F2** browser (Playwright)
- **F3** computer-use
- **F4** LSP

### فاز G — ظاهر
- **G1** ✅ personality — skinهای داده‌محور (`default`/`concise`/`playful`)، انتخاب per-user، دستور `/personality`؛ به‌علاوه `/help`، `/reset`، `/compress`، `/stop` ([docs/phase-g1-personality-commands.md](docs/phase-g1-personality-commands.md))
- **G2** skins, pets, bot-screen

### فراتر از نقشه (یافته‌های ممیزی هرمس — مرحله‌ی ۲، بچ ۳)
- ✅ **سرور MCP** — عرضه‌ی بابی به‌عنوان سرور MCP (stdio) با ۴ ابزار؛ ارسال پیام فقط با هویت مالک سمت سرور ([docs/phase-mcp-server.md](docs/phase-mcp-server.md))
- ✅ **وب‌هوک‌های خروجی** — اعلان HMAC-امضاشده‌ی رویدادهای چرخه‌حیات، فقط فراداده ([docs/phase-webhooks.md](docs/phase-webhooks.md))
- ✅ **تولید ویدیو** — ابزار `generate_video` با الگوی `generate_image` ([docs/phase-video-gen.md](docs/phase-video-gen.md))
- ✅ **رهگیری مصرف/هزینه** — جدول `usage_ledger` (اسکیما ۱۷) + ابزار مالک‌محور `usage_report` ([docs/phase-usage.md](docs/phase-usage.md))
- ✅ **سیاست reasoning + انضباط prompt caching** — `BOBI_REASONING_EFFORT` و breakpoint کش opt-in ([docs/phase-reasoning-cache.md](docs/phase-reasoning-cache.md))
- ✅ **سند امنیتی یکپارچه** — [docs/SECURITY.md](docs/SECURITY.md)
- ✅ **دستور `/lang`** — تغییر زبان رابط (فارسی/English)

### دستورهای هرمس (Stage 2 — دستور مالک)
- ✅ **۵۳ دستور برابری هرمس** — ممیزی ۱۰۳ دستور رجیستری هرمس؛ ۸ موجود بود، ۵۳ پیاده شد (`cmd_session`/`cmd_system`/`cmd_auto`)، ۴۳ عمداً نه (ترمینال‌محور، بیلینگ Nous، ناسازگار امنیتی مثل `/yolo`). منوی `setMyCommands` فارسی/انگلیسی با اسکوپ مالک؛ نگاشت کامل در [docs/HERMES_PARITY.md](docs/HERMES_PARITY.md)

### فراتر از هرمس (Stage 3 — تمایزدهنده‌ها)
- ✅ **دایجست صبحگاهی فارسی** — ابزار مالک‌محور `build_digest` (زمان‌بندی با `/blueprint run morning_digest`) ([docs/phase-digest.md](docs/phase-digest.md))
- ✅ **مدیریت هوشمند گروه** — ضدفلاد/ضداسپم/فیلتر فحاشی فارسی، نردبان warn←حذف←اطلاع، بدون بن خودکار ([docs/phase-moderation.md](docs/phase-moderation.md))
- ✅ **پیگیری‌های هوشمند** — ثبت و یادآوری خودکار پیگیری‌ها با فهم زمان فارسی ([docs/phase-nudges.md](docs/phase-nudges.md))

### بنچمارک روبه‌رو با هرمس
- ✅ **`bench/`** — ۲۴ تسک YAML (پرامپت فارسی، تزریق‌ستیزی، روبریک فارسی)، رانر headless با گزارش فارسی، آداپتر واقعی هرمس (`batch_runner.py` → trajectory parse → امتیازدهی یکسان). اجرای زنده نیازمند پیکربندی provider توسط مالک ([bench/README.md](bench/README.md))

---

## ⚠️ هشدار دربارهٔ code-execution

این تنها قابلیتی است که **ممکن است بابی را از امن‌تر تبدیل به ناامن‌تر کند** — یعنی مزیت اصلی ما را از بین ببرد.

هرمس آن را با «container isolation» انجام می‌دهد. ولی یک کانتینر که شبکه دارد، می‌تواند:
- داده را بیرون بفرستد
- به metadata سرویس ابری برسد
- منابع را تمام کند

**قواعدی که اگر بسازیم، رعایت می‌شوند:**
1. پیش‌فرض **خاموش**، مثل `allowLocalTargets`
2. بدون شبکه (`--network none`)
3. فقط وقتی صریحاً فعال شود
4. CPU/حافظه/زمان/دیسک محدود
5. بدون mount از فایل‌سیستم میزبان (به‌جز یک پوشهٔ خالی موقت)
6. فقط مالک بتواند فعال کند
7. خروجی مثل هر ابزار دیگر = داده، نه دستور

اگر این هفت شرط رعایت نشوند، **نمی‌سازیمش**.

---

## معیار برد

هر قابلیت وقتی «تمام» است که:
- ✅ تست دارد (هدف: نسبت تست به کد حفظ شود)
- ✅ در README مستند شده
- ✅ سطح حمله‌اش بررسی شده
- ✅ اگر مثل هرمس خطرناک است، امن‌تر ساخته شده

**نه** وقتی که فقط کار می‌کند.
