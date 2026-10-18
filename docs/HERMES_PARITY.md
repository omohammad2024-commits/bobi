# برابری با هرمس — جدول ممیزی دقیق (HERMES_PARITY)

> **وضعیت نهایی (Stage 2، ۱۸ اکتبر ۲۰۲۶):** همه‌ی موارد قابل‌پورت پیاده‌سازی شد.
> جدول زیر عکسِ لحظه‌ی ممیزی است (❌ = «در آن لحظه غایب بود»). مواردِ اکنون ✅:
> توقف میانی (/stop)، credential pools (E3)، reasoning/caching، حافظه‌های قابل‌تعویض (D2)،
> FTS5 (D1)، heartbeat (C2)، goals (C2)، delegation (C3)، mixture-of-agents (C4)،
> سرور MCP، API server (E5)، i18n (D5)، personality (G1)، hooks (E2)، context files (D3)،
> وب‌هوک‌های خروجی، تولید ویدیو، رهگیری مصرف، سیستم پلاگین (E2)، دستورهای اسلش (۵۳ دستور).
> عمداً پورت نشد (با دلیل در بخش ۳): اجرای کد/ترمینال (F1، داکر در محیط نیست)، مرورگر،
> computer-use، LSP، پلتفرم‌های اضافه (Discord/Slack/… )، CLI/TUI/دسکتاپ، ACP، داشبورد،
> Nous Portal، مهاجرت OpenClaw، trajectory compressor، چندپروفایلی، اجرای کد داخل skill.


**تاریخ ممیزی:** ۱۸ اکتبر ۲۰۲۶ — مرحله ۱ پروژه ارتقای BOBI
**مرجع:** `/home/hatch/workspace/hermes-ref` (کلون کامل Hermes Agent، ساخت Nous Research، لایسنس MIT)
**هدف ممیزی:** `/home/hatch/workspace/bobi-agent/extracted/BOBI AGENT`
**مبنای نقشه راه:** `ROADMAP.md` (فازهای A تا G)

**خلاصه شمارش:** از ۵۹ قابلیت ممیزی‌شده:
- ✅ موجود: **۱۳**
- ⚠️ جزئی: **۸**
- ❌ غایب: **۳۸**

از ۳۸ مورد غایب: ۲۳ مورد در `ROADMAP.md` پوشش داده شده‌اند، ۸ مورد **خارج از نقشه راه** هستند (بخش دوم این سند — به لیست کار اضافه می‌شوند)، و ۷ مورد **عمداً پورت نمی‌شوند** (بخش سوم — با دلیل امنیتی/محصولی).

**۵ مورد غایبِ مهم‌تر (اولویت پیشنهادی برای مرحله ۲):**
1. **Subagents / delegation** (C3) — بزرگ‌ترین شکاف معماری؛ موازی‌سازی و واگذاری کار
2. **credential-pools + provider-routing** (E3) — پایداری و چرخش کلید
3. **plugins + hooks** (E2) — بنیانِ توسعه‌پذیری (خیلی چیزها رویش سوار می‌شود)
4. **FTS5 روی مکالمات** (D1) — یادآوری میان‌نشستی، قلب حافظه بلندمدت هرمس
5. **goals + heartbeat + loops** (C2) — فعال بودن عامل بدون پیام کاربر

---

## جدول نگاشت قابلیت‌ها

| قابلیت هرمس | پیاده‌سازی در هرمس (فایل/مرجع) | وضعیت در بابی (✅/⚠️/❌ + شاهد) | اقدام برنامه‌ریزی‌شده |
|---|---|---|---|
| **Agent loop** (مدل → ابزار → مدل تا پاسخ) | `agent/conversation_loop.py` + خواهرهای `agent/turn_*.py` (حدود ۲۵ فاز جدا: preflight، tool_round، overflow، recovery…) | ✅ موجود — `src/agent/loop.ts`؛ قوانین بارِ طراحی (ابزار تنها اثر جانبی، بودجه محدود، خروجی ابزار نامعتبر) مستند شده | — |
| **Iteration budget** (سقف تکرار) | `agent/iteration_budget.py` — والد ۵۰۰، هر ساب‌ایجنت ۵۰؛ `execute_code` ریفاند می‌شود | ✅ موجود — `DEFAULT_BUDGETS` در `src/agent/loop.ts`: ‏۶ تکرار / ۱۲ فراخوانی ابزار / ۱۲۰ ثانیه + مهلت نهایی بدون ابزار | در مرحله ۲ بررسی شود آیا سقف‌ها برای jobهای کرون کافی‌اند |
| **Interrupt / توقف میانی** | `agent/interrupt_control.py`؛ در پیام‌رسان‌ها `/stop` | ❌ غایب — `ToolService` سیگنال abort دارد ولی دستوری برای توقف turn در حال اجرا نیست | خارج از نقشه — پیشنهاد: اضافه شود |
| **Provider registry** (~۴۰ پروایدر) | `providers/` (رجیستری) + `plugins/model-providers/*`: ‏anthropic، openai، gemini، deepseek، openrouter، nous، xai، azure، bedrock، vertex، copilot، ollama، lmstudio، kimi، qwen، minimax، deepinfra، fireworks، nebius، novita، huggingface و… | ⚠️ جزئی — `src/ai/adapter_registry.ts` فقط ۴ نوع: `openai_compatible`، `nine_router`، `gemini`، `anthropic` | E3: credential-pools + provider-routing (پوشش جزئی؛ افزودن پروایدرهای بیشتر در همان فاز) |
| **تعویض مدل در حین اجرا** | `hermes model` و `/model [provider:model]` در CLI و پیام‌رسان | ✅ موجود — پنل `/ai` داخل تلگرام (انتخاب پروایدر/مدل، ورود کلید) | — |
| **Credential pools + چرخش کلید** | `agent/credential_pool.py`، `credential_pool_admin.py`، `auxiliary_key_rotation.py` | ❌ غایب — `src/ai/secret_store.ts` فقط یک کلید رمزنگاری‌شده (AES-256-GCM) به‌ازای هر پروایدر نگه می‌دارد؛ failover بین پروایدرها هست ولی pool/chرخش نیست | E3 |
| **چند API mode** (chat_completions / codex_responses / native) | `agent/anthropic_adapter.py`، `gemini_native_adapter.py`، `codex_responses_adapter.py`، `vertex_adapter.py`، `bedrock_adapter.py` | ⚠️ جزئی — آداپترهای gemini و anthropic نیتیو هستند؛ بقیه فقط chat-completions سازگار با OpenAI | — (با گسترش E3 پوشش داده می‌شود) |
| **Reasoning / thinking policy** | `agent/reasoning_effort.py`، `anthropic_thinking_policy.py`، `reasoning_carriers.py`، `reasoning_summaries.py` | ❌ غایب — هیچ مدیریتی برای thinking block یا reasoning_effort نیست | خارج از نقشه — پیشنهاد: اضافه شود (برای مدل‌های reasoning لازم است) |
| **انضباط prompt caching** | `agent/prompt_caching.py`، `prompt_cache_boundary.py` — system prompt در طول مکالمه بایت‌به‌بایت ثابت می‌ماند؛ تزریق فقط از طریق user message یا tool result | ⚠️ جزئی — `src/ai/pinned_transport.ts` فقط DNS-rebinding را می‌بندد؛ استراتژی cache-breakpoint مستند/پیاده نشده | خارج از نقشه — پیشنهاد: در مرحله ۲ راستی‌آزمایی شود |
| **Skills** (رجیستری + جستجو + تزریق) | `skills/` (درون‌درختی)، `optional-skills/`، `plugin-catalog/`؛ `agent/skill_commands.py` (تزریق به‌صورت user message)، `agent/skills_index_delta.py` | ✅ موجود — `src/skills/{loader,search,tool,context,types}.ts`؛ بارگذاری از مارک‌داون + frontmatter، ابزار `skills` فقط برای discovery (فاز A3) | — |
| **Skill با کد اجرایی + ساخت خودکار skill** | skillها پایتون دلخواه در import اجرا می‌کنند (SECURITY.md §2.4)؛ حلقه یادگیری: ساخت خودکار skill پس از task پیچیده؛ `agent/curator.py` (نگهداری خودکار skill در بیکاری) | ❌ غایب — skillهای بابی فقط متن‌اند؛ curator در نقشه هست ولی ساخت خودکار skill نیست | D4 (curator)؛ اجرای کد داخل skill → عمداً نه (بخش ۳) |
| **حافظه بلندمدت کلید-مقدار** | `agent/memory_manager.py` + ابزار `memory` (inline executor) | ✅ موجود — `src/tools/memory.ts`: ‏`remember`/`recall`/`forget`، سقف ۲۰۰ حافظه به‌ازای کاربر، جداسازی per-owner در storage | — |
| **Memory providers قابل‌تعویض** (byterover، retaindb، مدل‌سازی کاربر Honcho) | `plugins/memory/{byterover,retaindb}`؛ `agent/memory_provider.py`؛ ارجاع Honcho در `agent/agent_init.py` | ❌ غایب | D2 (بک‌اند قابل‌تعویض)؛ مدل‌سازی Honcho → خارج از نقشه |
| **جستجوی FTS5 روی مکالمات گذشته** | `hermes_state_fts.py` + خلاصه‌سازی LLM برای یادآوری میان‌نشستی | ❌ غایب — فقط پنجره مکالمه + summary در `src/conversation/summary.ts` | D1 |
| **فشرده‌سازی مکالمه + `/compress`** | `agent/conversation_compression*.py`، `context_compressor*.py`؛ `/compress` دستی در همه سطوح | ⚠️ جزئی — `src/conversation/summary.ts` (خلاصه روان ۲۰۰۰ کاراکتری)؛ دستور `/compress` دستی نیست | خارج از نقشه — پیشنهاد: `/compress` دستی اضافه شود |
| **زمان‌بند cron** | `cron/` (‏`jobs.py`، `scheduler.py`، `delivery_queue.py`، `occurrences.py`): کرون ۵فیلدی، per-job مدل/پروایدر/skill، اسکریپت پیش‌اجرا (فقط فایل)، زنجیره `context_from`، تحویل چندپلتفرمی، پنجره catch-up، watchdog بیکاری | ⚠️ جزئی — `src/scheduler/{cron.ts,scheduler.ts}` + ابزارهای `schedule_task`/`list_tasks`/`cancel_task` + جدول `scheduled_tasks` (فاز A2/C1)؛ بدون اسکریپت پیش‌اجرا، بدون زنجیره، بدون per-job مدل، تحویل فقط تلگرام | C2 (تکمیل: heartbeat/goals/loops)؛ catch-up hardening → در همان فاز دیده شود |
| **Heartbeat / نudge در بیکاری** | تیکر cron (`cron/jobs.py`، فایل `ticker_heartbeat`) + `agent/periodic_scheduler.py` (تایمر واحد برای callbackهای دوره‌ای) | ❌ غایب | C2 |
| **Goals + loops** | `cron/suggestions.py`، `suggestion_catalog.py` (پیشنهادهای زمان‌بندی‌شده)؛ صف کار kanban در `plugins/kanban` | ❌ غایب | C2 |
| **Subagents / delegation** (ایزوله، موازی) | `tools/delegate_tool.py`، `tools/async_delegation*.py`، `agent/subagent_lifecycle.py` (قرارداد عمومی نسخه‌دار، محدودیت toolset، سقف ۵۰ تکرار، HMAC) | ❌ غایب | C3 |
| **Mixture-of-Agents** | `agent/moa_loop.py` + `moa_alternation.py` (دستور `/moa`: gather از مدل‌های مرجع پیش از هر تکرار) | ❌ غایب | C4 |
| **Terminal backends** (۷ عدد) | `tools/terminal_tool_backends.py`: ‏local، docker، ssh، singularity، modal، daytona، vercel-sandbox | ❌ غایب | F1 فقط Docker؛ بقیه → عمداً نه (بخش ۳) |
| **Code execution** | `tools/code_execution_tool.py` (+ `code_kernel.py`، `code_execution_rpc.py`): ساب‌پروسس میزبان، scrub کردن credential از env | ❌ غایب | F1 با ۷ شرط امنیتی ROADMAP (پیش‌فرض خاموش، `--network none`، فقط مالک…) |
| **Browser** (خودکار، واقعی) | `plugins/browser` + `tools/browser_*.py`: ‏camoufox/CDP، lightpanda، مرورگر ابری (via Nous Portal)، browser_use | ❌ غایب — فقط ابزار `fetch_url` در `src/tools/fetch_url.ts` (خواندن ساده صفحه) | F2 (Playwright) |
| **Computer-use** (کنترل دسکتاپ) | `plugins/computer_use` (cua) | ❌ غایب | F3 (در نقشه به‌عنوان پرخطر علامت خورده) |
| **LSP** (هوش کد) | `agent/lsp/` | ❌ غایب | F4 (فقط برای کار با کد معنا دارد) |
| **MCP client** | `mcp_serve.py` (سرور) + `optional-mcps/` (کانفیگ کلاینت) | ✅ موجود — `src/mcp/bridge.ts`: ‏stdio + StreamableHTTP، یک ابزار آداپتر به‌ازای هر سرور، اعتبارسنجی envelope | — |
| **MCP server** (عامل را به‌صورت MCP عرضه کن) | `mcp_serve.py`: ‏`hermes mcp serve` — ۹ ابزار (لیست مکالمات، خواندن تاریخچه، ارسال پیام، مدیریت approval) برای Claude Code/Cursor/Codex | ❌ غایب | خارج از نقشه — پیشنهاد: اضافه شود (ارزش بالا، هزینه کم) |
| **سطح Telegram** | `plugins/platforms/*` + `gateway/platforms/` — بات تلگرام یکی از آداپترهاست | ✅ موجود — کل بابی روی grammY سوار است (`src/bot/bot.ts`) | — |
| **Discord / Slack / WhatsApp / Signal / Email** | همان gateway؛ هر پلتفرم یک پلاگین/آداپتر | ❌ غایب | E1 (انتزاع پلتفرم + Discord) و E6 (بقیه) |
| **CLI تعاملی** | `cli.py` + `hermes_cli/`: ‏`hermes`، `model`، `tools`، `config`، `gateway`، `setup`، `update`، `doctor`، `cron`، `mcp`… | ❌ غایب | خارج از نقشه — تصمیم محصولی: بابی بات-اول است |
| **TUI** (ترمینال‌UI با Ink) | `ui-tui/` + `tui_gateway/` (بک‌اند JSON-RPC روی IPC محلی) | ❌ غایب | عمداً نه (بخش ۳) |
| **اپ دسکتاپ** | `apps/desktop` | ❌ غایب | عمداً نه (بخش ۳) |
| **API server** (HTTP) | آداپتر API server در `gateway/platforms/` | ❌ غایب | E5 |
| **ACP adapter** (اتصال ویرایشگر/IDE) | `acp_adapter/` (سرور/کلاینت، permissions، elicitation) | ❌ غایب | در دسته ۳ نقشه به‌عنوان «بعداً» ذکر شده |
| **داشبورد وب + kanban** | `plugins/kanban/dashboard` | ❌ غایب | E7 |
| **i18n** (۱۷ زبان + language pack پلاگین) | `locales/*.yaml` (‏en، fa نیست! ar، de، es، fr، ja، ko، ru، tr، uk، zh، pt، it…)، `agent/i18n.py`، `i18n_languages.py` | ❌ غایب — بابی فارسی‌محور است بدون سیستم language-pack | D5 (نکته: خود هرمس هم بسته فارسی ندارد) |
| **Personality / SOUL.md** | `SOUL.md` ریشه + دستور `/personality` (‏`hermes_cli/commands.py`)؛ بارگذاری در `agent/system_prompt.py` | ❌ غایب | G1 |
| **Hooks** (رویدادهای چرخه‌حیات) | `gateway/hooks.py`: رویدادهای `gateway:startup`، `session:start/end/reset`، `agent:start/step/end`، `command:*` با هندلر پایتون در `~/.hermes/hooks/<name>/`؛ `agent/shell_hooks.py` (پل اسکریپت‌شل با allowlist)؛ `agent/outbound_webhooks.py` (POST با امضای HMAC-SHA256) | ❌ غایب | E2 |
| **Context files** (AGENTS.md/SOUL.md از cwd) | `agent/prompt_builder.py`، `agent/subdirectory_hints.py` (فقط cwd، سقف کاراکتر، تغییر mid-conversation ممنوع) | ❌ غایب — `src/skills/context.ts` تزریق skill است نه context-file پروژه | D3 |
| **Evals / بنچمارک** | `evals/` (ده‌ها probe)، `batch_runner.py` (اجرای موازی روی JSONL + trajectory)، `mini_swe_runner.py` (SWE با فرمت trajectory هرمس) | ❌ غایب — فقط تست واحد در `tests/` | خارج از نقشه رسمی (طبق حافظه: بنچمارک بعد از برابری کامل) |
| **Trajectory compressor** (فشرده‌سازی برای ترین مدل) | `trajectory_compressor.py` | ❌ غایب | عمداً نه (ابزار پژوهشی، خارج از محصول) |
| **موضع prompt-injection** | `SECURITY.md` §3.2: خودِ injection آسیب‌پذیری نیست مگر با زنجیره §3.1؛ §2.2: تنها مرز واقعی، ایزولاسیون سطح OS است | ✅ موجود (جزئی) — قانون ۳ `src/agent/loop.ts`: خروجی ابزار در `<tool_result>` پیچیده می‌شود و system prompt آن را «داده، نه دستور» اعلام می‌کند | مستندسازی موضع کامل در سند امنیتی مرحله ۲ |
| **Credential scoping** (حذف secret از env ساب‌پروسس) | `SECURITY.md` §2.3: کلیدهای پروایدر از env شل/MCP/کرون/code-exec حذف می‌شوند | ⚠️ جزئی — `src/ai/secret_store.ts` (AES-256-GCM در rest، fail-closed، بدون لاگ)؛ ولی هنوز ساب‌پروسسی برای scrub کردن وجود ندارد | هم‌زمان با F1 (code-execution) پیاده شود |
| **احراز هویت سطح‌ها** (allowlist) | `SECURITY.md` §2.6: هر آداپتر شبکه‌ای باید allowlist تماس‌گیرنده داشته باشد وگرنه باز نمی‌شود | ✅ موجود — قفل مالک؛ `src/auth/` (مرز ادمین، نقش‌ها، audit بدون secret)؛ ابزارهای حساس فقط مالک | — |
| **Approval gate** (تشخیص الگوی مخرب پیش از اجرا) | `tools/approval*.py` (‏`approval_smart.py`، `approval_floors.py`، `approval_human_wait.py`، `approval_yolo.py`) | ⚠️ جزئی — مدل permission در `ToolService`/`src/auth`؛ چون شل/کد اجرایی نیست، الگوی مخرب قابل‌تشخیصی هم نیست | با F1 بازبینی شود؛ فعلاً خارج از نقشه |
| **Outbound webhooks** | `agent/outbound_webhooks.py`: صف محدود + ورکر daemon، امضای `X-Hermes-Signature-256` | ❌ غایب | خارج از نقشه — پیشنهاد: اضافه شود (ارزان و مفید برای اتوماسیون) |
| **Onboarding / ویزارد راه‌اندازی** | `agent/onboarding*.py` + `hermes setup` | ⚠️ جزئی — دستور `/start` در `src/bot/bot.ts` هست؛ ویزارد پیکربندی کامل نیست | خارج از نقشه |
| **رونویسی صوت** | `agent/transcription_registry.py` + voice memo در gateway | ✅ موجود — فاز B2 (`docs/phase-b2-transcribe.md`): Whisper-compatible وقتی پروایدر native ندارد | — |
| **TTS** | `agent/tts_registry.py`، `tts_provider.py` | ✅ موجود — فاز B3: دستور `/voice` + ترجیح per-user | — |
| **تولید تصویر** | `plugins/image_gen` + `agent/image_gen_registry.py` | ✅ موجود — فاز B4: ابزار `generate_image` | — |
| **تولید ویدیو** | `plugins/video_gen` (‏fal، deepinfra، openrouter، xai) | ❌ غایب | خارج از نقشه — پیشنهاد: با همان الگوی B4 اضافه شود |
| **استخراج سند** (PDF/DOCX/XLSX) | از طریق ابزارها/مدل‌ها | ✅ موجود — فاز B5: استخراج محلی (`pdf-parse` + unzip دستی) | — |
| **جستجوی وب چندپروایدره** | `agent/web_search_registry.py` + `plugins/web` (‏brave، ddgs، exa، firecrawl، keyless_mcp) | ✅ موجود — `src/search/` (‏duckduckgo، tavily) + رجیستری + ابزار `web_search` (فقط وقتی پروایدر پیکربندی شده ثبت می‌شود) | — |
| **Toolsets** (فعال/غیرفعال‌سازی گروهی) + **tool-search** | `enabled_toolsets`/`disabled_toolsets` در ساخت ایجنت؛ `hermes tools` | ⚠️ جزئی — `ToolRegistry` پرچم `enabled` و `ToolDescriptor` دارد ولی toolset گروهی و tool-search پویا نیست | E4 (tool-gateway + tool-search) |
| **رهگیری مصرف/هزینه** | `agent/usage_pricing.py`، `billing_usage.py`، `account_usage.py`، `credits_tracker.py` | ❌ غایب | خارج از نقشه — پیشنهاد: حداقل شمارش توکن per-run برای کنترل هزینه |
| **چندپروفایلی / multiplex** | `gateway` چند home را هم‌زمان سرو می‌کند (`scheduler_provider.py`) | ❌ غایب | عمداً نه — بابی تک‌مالک است (بخش ۳) |
| **سیستم پلاگین** (لودر + کاتالوگ) | `plugins/plugin_loader.py`، `plugin_storage.py`، `plugin-catalog/` (ده‌ها کاتالوگ YAML) | ❌ غایب | E2 (همراه hooks) |
| **دستورات اسلش** (`/help`، `/reset`، `/personality`، `/compress`…) | مشترک بین CLI و پیام‌رسان (جدول README هرمس) | ❌ غایب — فقط `start`/`admin`/`ai`/`voice` در `src/bot/bot.ts` | دسته ۲ نقشه: `/help`، `/reset`، `/personality` (۱ ساعت) |
| **Nous Portal / Tool Gateway** (اشتراک چندابزاری) | سابسکریپشن Nous: ۳۰۰+ مدل + search/image/TTS/browser ابری با یک OAuth | ❌ غایب | عمداً نه — محصول اختصاصی vendor (بخش ۳) |
| **مهاجرت از OpenClaw** | `hermes claw migrate` | ❌ غایب | عمداً نه (بخش ۳) |

---

## موارد خارج از نقشه‌ی راه

این قابلیت‌ها در هرمس هستند ولی هیچ آیتمی در `ROADMAP.md` ندارند. پیشنهاد می‌شود به لیست کار مرحله ۲ اضافه شوند (ترتیب پیشنهادی بر اساس ارزش/هزینه):

1. **MCP server** (`mcp_serve.py`) — عرضه‌ی بابی به‌عنوان ابزار MCP به Claude Code/Cursor/Codex؛ ۹ ابزار استاندارد (مکالمات، تاریخچه، ارسال پیام، approval). هزینه کم، ارزش اکوسیستمی بالا.
2. **Outbound webhooks** (`agent/outbound_webhooks.py`) — اعلان HMAC-امضاشده‌ی رویدادهای چرخه‌حیات به URL دلخواه؛ زیرساخت اتوماسیون ارزان.
3. **Reasoning / thinking policy** (`agent/reasoning_effort.py`، `anthropic_thinking_policy.py`) — با آمدن مدل‌های reasoning، مدیریت thinking block لازم می‌شود؛ وگرنه توکن هدر می‌رود یا خطا می‌دهد.
4. **تولید ویدیو** (`plugins/video_gen`) — همان الگوی فاز B4؛ افزونه‌ی طبیعی image-gen.
5. **رهگیری مصرف/توکن** (`agent/usage_pricing.py` و خانواده) — حداقل شمارش توکن هر run برای کنترل هزینه مالک؛ هرمس این را جدی گرفته و بابی هنوز هیچ ندارد.
6. **`/stop` و interrupt** (`agent/interrupt_control.py`) — توقف turn در حال اجرا؛ برای عاملِ ابزارمحور ضروری است.
7. **`/compress` دستی** (`agent/conversation_compression_manual.py`) — زیرساخت خلاصه‌سازی (B-فاز) هست ولی دستور دستی‌اش نیست.
8. **انضباط prompt caching** (`agent/prompt_caching.py`) — راستی‌آزمایی اینکه system prompt میان‌مکالمه بازسازی نمی‌شود؛ روی هزینه اثر مستقیم دارد.

موارد زیر هم خارج از نقشه‌اند ولی اولویت پایین‌تری دارند: مدل‌سازی کاربر به سبک Honcho، onboarding wizard کامل، skill slash command در چت (`/<skill-name>`)، approval-gate برای الگوهای مخرب (تا قبل از F1 موضوعیت ندارد).

---

## مواردی که عمداً پورت نمی‌شوند

| قابلیت هرمس | دلیل عدم پورت |
|---|---|
| **اجرای کد skill در import** (skillهای هرمس پایتون دلخواه اجرا می‌کنند — `SECURITY.md` §2.4) | مرز امنیتی هرمس برای skill شخص‌ثالث «بازبینی مالک پیش از نصب» است؛ در بات تلگرامِ همیشه‌روشن، اجرای کد از فایل مارک‌داون سطح حمله‌ی غیرقابل‌قبول می‌سازد. skillهای بابی عمداً فقط-متن می‌مانند (فاز A3 همین تصمیم را گرفته). |
| **Terminal backends ابری** (SSH/Modal/Daytona/Vercel/Singularity) | نیاز به حساب ابری و اعتماد به زیرساخت شخص‌ثالث؛ برای بات تک‌مالک فارسی، Docker محلیِ F1 کافی است. |
| **TUI و اپ دسکتاپ** (`ui-tui/`، `apps/desktop`) | بابی بات-اول است؛ سطح دسکتاپ/ترمینال محصول جداست، نه برابری. |
| **Nous Portal / Tool Gateway** | محصول اشتراکی اختصاصی Nous Research (vendor lock-in)؛ قابل پورت معنادار نیست. |
| **مهاجرت از OpenClaw** (`hermes claw migrate`) | ابزار مهاجرت از رقیب؛ برای بابی موضوعیت ندارد. |
| **Trajectory compressor** (`trajectory_compressor.py`) | ابزار پژوهشی برای ترین مدل‌های tool-calling؛ خارج از اسکوپ محصول. بنچمارک‌ها طبق تصمیم قبلی بعد از برابری کامل می‌آیند. |
| **چندپروفایلی / multiplex gateway** | هرمس چند home را هم‌زمان سرو می‌کند؛ بابی تک‌مالک است و همین، ساده‌سازی امنیتیِ آگاهانه است (حافظه: مرز حریم خصوصی). |
| **نصب‌کننده‌های Windows/Android** (MSIX، مخزن APT ترموکس) | بابی روی سرور اجرا می‌شود و از تلگرام سرو می‌دهد؛ نصب کلاینت بومی موضوعیت ندارد. |

**یادداشت امنیتی (از `SECURITY.md` هرمس، قابل اقتباس در مرحله ۲):** هرمس صراحتاً می‌گوید «تنها مرز امنیتی در برابر LLM مهاجم، ایزولاسیون سطح OS است» (§2.2) و «prompt injection به‌خودیِ‌خود آسیب‌پذیری نیست» (§3.2). بابی این فلسفه را در `src/agent/loop.ts` (قانون ۳: خروجی ابزار = داده) شروع کرده؛ در مرحله ۲ باید به سند امنیتی صریح تبدیل شود — مخصوصاً پیش از F1 (code-execution) که نقشه‌ی راه خودش ۷ شرط سخت‌گیرانه برایش گذاشته است.

---

### ارجاع‌های کلیدی هرمس برای مرحله ۲

- حلقه عامل: `agent/AGENTS.md` (خواندنی‌ترین سند معماری)، `agent/conversation_loop.py`
- حافظه: `agent/memory_manager.py`، `hermes_state_fts.py`، `plugins/memory/`
- زمان‌بند: `cron/AGENTS.md` (اینvariantهای hardening)، `cron/scheduler.py`
- ساب‌ایجنت: `agent/subagent_lifecycle.py` (قرارداد عمومی)، `tools/delegate_tool.py`
- امنیت: `SECURITY.md` (مدل اعتماد کامل)، `SOUL.md` (شخصیت)
- پروایدرها: `providers/README.md`، `plugins/model-providers/README.md`
- سطوح: `gateway/`، `acp_adapter/`، `mcp_serve.py`
- پژوهش/ارزیابی: `batch_runner.py`، `mini_swe_runner.py`، `trajectory_compressor.py`، `evals/`

---

## نگاشت دستورها (Stage 2 — دستور مالک: «تمام کامندهای هرمس روی بات»)

ممیزی کامل رجیستری دستوری هرمس (`hermes_cli/commands.py` — مرجع واحد CLI، گیت‌وی، تلگرام و Slack): **۱۰۳ دستور** —
۸ مورد از قبل در بابی بود (`start/help/personality/voice/compress/reset/stop` + `/admin` و `/ai` مالک‌محور)،
**۵۳ مورد پیاده‌سازی شد**، **۴۳ مورد عمداً پیاده نشد**.

پیاده‌شده‌ها (با همان نام، توضیح فارسی در `setMyCommands`، دسته‌بندی در `/help`):
- **نشست** (کاربر): `history save retry undo title branch resume sessions status context busy whoami footer version new`
- **خودکارسازی و دانش** (کاربر): `bg btw queue steer agents suggestions blueprint refine review plan moa memory bundles`
- **سیستمی** (فقط مالک): `snapshot restart update debug usage insights model reasoning autoprune tools skills curator plugins reload_mcp reload_skills approve deny sethome pause goal subgoal heartbeat loop cron learn`
- پیاده‌سازی در `src/bot/cmd_session.ts` / `cmd_system.ts` / `cmd_auto.ts` (+ `cmd_context.ts`)؛ ثبت در `createBot`؛ منو با `setMyCommands` (فارسی پیش‌فرض، انگلیسی با `language_code`، دستورهای مالک‌محور فقط در چت مالک)؛ هندلرها هم جداگانه گیت می‌شوند.
- نگاشت‌های خاص: `approve`/`deny` هرمس (تأیید اجرای خطرناک) → تأیید/رد درخواست‌های عضویت (تنها سطح تأیید واقعی بابی)؛ `moa` → ابزار `consult_models`؛ `new` نام مستعار `reset`.

پیاده‌نشده‌ها (۴۳) — با دلیل:
- **مفاهیم ترمینال** (بدون معادل تلگرامی): `clear redraw statusbar battery timestamps verbose focus indicator skin palette quit copy paste image prompt handoff`
- **اختصاصی Nous/بیلینگ**: `subscription login topup codex-runtime`
- **زیرساخت داخلی هرمس**: `egress profile platform platforms fast worktree diff export import config reload journey`
- **بدون معادل در بابی**: `topic` (تاپیک انجمن)، `kanban`، `pet`/`hatch` (مسکات)، `init` (اسکن ریپو)، `wake` (wake-word)
- **ناسازگار با امنیت بابی**: `yolo` (دور زدن تأییدها — بابی fail-closed است)، `approvals` (صف تأیید اجرای خطرناک نداریم)، `browser` (مرورگر/CDP خارج از اسکوپ امنیتی)
- جزئیات کامل جدول ۱۰۳تایی در گزارش ممیزی؛ خلاصه‌ی رفتار هر دستور پیاده‌شده در `docs/phase-commands-*.md`.
