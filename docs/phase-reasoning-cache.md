# سیاست reasoning/thinking و انضباط prompt caching

**وضعیت:** پیاده‌سازی شده — `src/ai/reasoning.ts`، `src/ai/cache_policy.ts`، ویرایش‌های افزودنی در سه آداپتر
(`anthropic.ts`، `gemini.ts`، `openai_compatible.ts`).
**تست:** `tests/reasoning_cache.test.ts` — ۲۵ تست، سبز.
**پیش‌فرض‌ها بدون تغییر:** reasoning خاموش، کش خاموش؛ مگر با env صریح مالک.

## ۱. سیاست reasoning (پیکربندی)

| متغیر محیطی | مقادیر | پیش‌فرض |
|---|---|---|
| `BOBI_REASONING_EFFORT` | `off` / `low` / `medium` / `high` | `off` |
| `BOBI_PROMPT_CACHE` | `1` (یا `true`/`yes`) | خاموش |

- مقدار نامعتبر یا خالی → **`off`** (fail closed؛ هرگز به سطح قوی‌تر ارتقا پیدا نمی‌کند).
- پیشوند قدیمی `SOL_` هم به‌عنوان fallback خوانده می‌شود (طبق قرارداد `src/config/config.ts`)؛ `BOBI_` اولویت دارد.
- `resolveReasoningEffort(env)` از `src/ai/reasoning.ts` تنها نقطه‌ی خواندن این تنظیم است.
- `reasoningParamsFor(providerId, effort)` برای هر سطح، بودجه‌ی بیشینه‌ی توکن thinking را برمی‌گرداند:

| سطح | بودجه (توکن) |
|---|---|
| `low` | ۱۰۲۴ |
| `medium` | ۴۰۹۶ |
| `high` | ۱۶۳۸۴ |

بودجه‌ها همیشه `low < medium < high` و دست‌کم ۱۰۲۴ (کف موردنیاز Anthropic) هستند. برای وندورهایی که
سقف/کف مستند دارند، بودجه داخل همان بازه clamp می‌شود؛ بقیه بودجه‌ی خنثی را دست‌نخورده می‌گیرند.

## ۲. نگاشت روی سیم (فقط وقتی reasoning روشن باشد)

| آداپتر | فیلد ارسالی |
|---|---|
| Anthropic | `thinking: { type: "enabled", budget_tokens }` + اجبار `temperature: 1` (قانون وندور) + تضمین `max_tokens > budget_tokens` (در صورت نیاز بالا برده می‌شود) |
| OpenAI-compatible | `reasoning_effort: "low" \| "medium" \| "high"` |
| Gemini | `thinkingConfig: { thinkingLevel: "LOW" \| "MEDIUM" \| "HIGH" }` (فیلد سطح‌بالای درخواست) |

وقتی `effort` برابر `off` باشد، **هیچ‌یک** از این فیلدها ارسال نمی‌شود و بدنه‌ی درخواست بایت‌به‌بایت
همان فرمت قبلی است (در تست با snapshot رشته‌ی JSON پین شده).

## ۳. انضباط prompt caching

قرارداد: **سیستم‌پرامپت باید قطعی (deterministic) ساخته شود** — ورودی یکسان، بایت یکسان. هیچ
`Date.now()`، هیچ `Math.random()`، هیچ ترتیبی وابسته به iteration داخل آن نباشد. فقط بخش
کاربر/تاریخچه‌ی درخواست مجاز است بین turnها عوض شود. نقطه‌ی شکست کش (`cache_control`) فقط روی
سیستم‌پرامپت گذاشته می‌شود، نه روی محتوای ابزارها.

- **Anthropic:** با `BOBI_PROMPT_CACHE=1`، فیلد `system` از رشته‌ی ساده به آرایه‌ی بلاک تبدیل می‌شود و
  `cache_control: { type: "ephemeral" }` می‌گیرد. بدون این env، همان رشته‌ی قبلی ارسال می‌شود.
- **Gemini:** کش پرامپت در این وندور **ضمنی و خودکار** است؛ در `generateContent` فیلد breakpoint
  صریحی وجود ندارد، پس چیزی اضافه نشده — پایدار نگه‌داشتن بایت‌های سیستم‌پرامپت همان چیزی است که
  باعث hit شدن کش می‌شود.
- **OpenAI-compatible:** در `chat/completions` استانداردی برای breakpoint نیست و کش سمت سرور خودکار
  است. فیلد `prompt_cache_key` در بعضی endpointها هست ولی معنایش «نام‌گذاری سطل کش» است نه «علامت
  مرز» و مسیریابی را عوض می‌کند؛ پس عمداً ست نشده.

`hashSystemPrompt` (‏sha256 hex‏) اثر انگشت پایداری سیستم‌پرامپت است و `assertPromptStable` در تست
ثابت می‌کند چند turn از یک fixture ثابت، بایت‌به‌بایت یکسان‌اند.

### یافته‌ی ممیزی `src/agent/prompt.ts` (فقط مستند شده، رفتار عوض نشده)

- `buildSystemPrompt` نسبت به `PromptContext` داده‌شده **تابع خالص و قطعی** است: `now` تزریقی است و
  هیچ منبع تصادفی/زمانی درونش نیست. با context ثابت، خروجی بایت‌به‌بایت ثابت است.
- اما `src/conversation/engine.ts` هر turn یک `Date` تازه به `now` می‌دهد و بلاک «زمان فعلی: …»
  داخل پرامپت جاسازی می‌شود؛ پس **در عمل، دو turn پیاپی حداقل در همان یک خط فرق دارند** و کش
  پرامپت می‌شکند. تست «ساعت متحرک کش را می‌شکند» همین را پین می‌کند.
- دو بردار دیگرِ شکست کش: `memoryCount` (اگر حین مکالمه حافظه‌ای ذخیره شود عددش عوض می‌شود) و
  `skillContext` (بر اساس آخرین پیام کاربر ساخته می‌شود و ذاتاً هر turn فرق می‌کند).
- تصمیم آگاهانه: این رفتار **تغییر نکرده**. راه‌حل (فریز کردن `now` برای هر conversation، یا بردن
  ساعت به پیام کاربر به‌جای سیستم‌پرامپت) یک تصمیم محصولی است و به فاز بعد موکول شده.

## ۴. یادداشت امنیتی / سطح حمله (SECURITY)

1. **بلاک thinking خروجی مدل است، نه دستور.** محتوای thinking/reasoning دقیقاً مثل هر completion
   دیگری «داده‌ی نامعتبر» تلقی می‌شود: هرگز به سیستم‌پرامپت، تعریف ابزار، یا آرگومان ابزار تزریق
   نمی‌شود. آداپترها در parse پاسخ فقط بلاک‌های `text` را می‌خوانند؛ بلاک thinking ذاتاً نادیده
   گرفته می‌شود و نمی‌تواند وارد turn بعدی شود.
2. **سطح reasoning فقط از env مالک می‌آید** (`BOBI_REASONING_EFFORT`)، نه از ورودی کاربر چت. کاربر
   نمی‌تواند هزینه‌ی توکن یا تأخیر را بالا ببرد.
3. **مقادیر نامعتبر fail-closed** هستند (→ `off`) و بودجه‌ها clamp می‌شوند؛ پس env خراب نمی‌تواند
   بودجه‌ی نامعقول درخواست کند.
4. **نقطه‌ی شکست کش فقط روی سیستم‌پرامپت** (متن مالک/سرور، سطح اعتماد بالا) گذاشته می‌شود —
   هرگز روی `tool_result` که می‌تواند محتوای مهاجم‌محور (صفحه‌ی وب fetchشده و…) حمل کند.
5. **کلید API هرگز در URL لاگ‌شدنی قرار نمی‌گیرد** (قرارداد موجود آداپترها) و بدنه‌ی درخواست فقط
   از همین مسیر امن ارسال می‌شود؛ فیلدهای جدید thinking/caching هیچ داده‌ی حساسی حمل نمی‌کنند.
6. **ریسک باقی‌مانده‌ی آگاهانه:** تا وقتی ساعت داخل سیستم‌پرامپت جاسازی می‌شود (§۳)، کش عملاً hit
   نمی‌شود و هر turn ورودی کامل قیمت‌گذاری می‌شود — ریسک هزینه است، نه امنیت؛ و با فعال‌سازی
   `BOBI_PROMPT_CACHE=1` قبل از پایدار شدن پرامپت، فقط هزینه‌ی write کش (۱٫۲۵ برابر ورودی) پرداخت
   می‌شود بی‌آنکه خوانده شود.

## ۵. فایل‌ها

- جدید: `src/ai/reasoning.ts` — واژگان `ReasoningEffort`، `resolveReasoningEffort`،
  `reasoningParamsFor`، جدول بودجه‌ی سطح‌ها.
- جدید: `src/ai/cache_policy.ts` — `hashSystemPrompt`، `assertPromptStable`،
  `promptCacheEnabled`، `anthropicCacheBreakpoint`، قرارداد کش و نتیجه‌ی ممیزی prompt.
- ویرایش افزودنی: `src/ai/anthropic.ts` (‏`thinking` + `cache_control` روی system)،
  `src/ai/gemini.ts` (‏`thinkingConfig`)، `src/ai/openai_compatible.ts` (‏`reasoning_effort`).
- دست‌نخورده: `src/ai/gateway.ts`، `src/ai/secret_store.ts`، `src/storage/storage.ts`،
  `src/agent/prompt.ts`، `README.md`.
- تست: `tests/reasoning_cache.test.ts`.
