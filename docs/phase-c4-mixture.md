# فاز C4 — ترکیب چند مدل (`consult_models` + `runMixture`)

دو لایه:

- `src/ai/mixture.ts` — تابع خالص `runMixture`: یک سؤال را به‌صورت موازی
  (`Promise.allSettled`) از چند مدل می‌پرسد و همهٔ پاسخ‌ها را جمع می‌کند.
  آفلاین و تست‌پذیر؛ هیچ‌چیز از پروایدر واقعی نمی‌داند.
- `src/tools/consult_models.ts` — ابزار `consult_models`: مدل‌ها را allowlist
  می‌کند، با `runMixture` مشورت می‌گیرد و بعد با `primaryModel` همهٔ پاسخ‌ها
  را به **یک جواب فارسی دقیق و بدون حشو** ترکیب می‌کند.

قرارداد در `tests/mixture.test.ts` پین شده است.

## ورودی / خروجی ابزار

| فیلد | نوع | سقف |
|---|---|---|
| `question` | رشته، الزامی | ۱ تا ۲۰۰۰ نویسه |
| `models` | آرایهٔ رشته، اختیاری | حداکثر ۳ (`CONSULT_MODELS_MAX`) |

- `models` خالی → سه مدل اولِ پیکربندی‌شده.
- هر نامی که در `listConfiguredModels()` نباشد → خطای `not_allowed`؛ مدل
  نمی‌تواند endpoint اختراع کند.
- خروجی: `{ ok: true, modelsUsed, answer }` — ‏`modelsUsed` فقط مدل‌هایی است
  که واقعاً متن تولید کردند، به ترتیب مشورت.

پرامپت ترکیب (فارسی): «این پاسخ‌های N مدل به یک سؤال است. بهترین ترکیب را به
فارسی، دقیق و بدون حشو بده.» + پاسخ‌ها با برچسب نام مدل. پاسخِ ناموفقِ یک مدل
حذفِ بی‌صدا نمی‌شود؛ با برچسب «این مدل پاسخ نداد» در پرامپت ترکیب می‌آید.

## سقف‌های زمانی (همه مستقل از ورودی)

| سقف | مقدار | ثابت |
|---|---|---|
| هر مدل | ۳۰ ثانیه | `DEFAULT_MODEL_TIMEOUT_MS` |
| فراخوانی ترکیب | ۳۰ ثانیه | `SYNTHESIS_TIMEOUT_MS` |
| کل ابزار | ۱۲۰ ثانیه | `CONSULT_MODELS_TIMEOUT_MS` |

سقف هر مدل هم روی سیگنال اعمال می‌شود و هم با promise مسابقه داده می‌شود
(`raceDeadline`)؛ پروایدری که سیگنال را نادیده بگیرد و هرگز settle نشود هم
نمی‌تواند اجرا را باز نگه دارد. مدلی که جا بماند به‌صورت `{ model, error }`
ثبت می‌شود — خطای یک مدل، کل مشورت را نمی‌کشد.

> **نکتهٔ سیم‌کشی:** سقف ۱۲۰ ثانیه‌ای داخل خود ابزار هم اعمال می‌شود، ولی
> `timeoutMs` پیش‌فرض اجراکنندهٔ `ToolService` فقط ۱۰ ثانیه است. اگر بودجهٔ
> کامل لازم است، هنگام ساخت `ToolService` مقدار
> `timeoutMs: CONSULT_MODELS_TIMEOUT_MS` بدهید — با این آگاهی که این سقفِ
> پیش‌فرضِ **همهٔ** ابزارها را بالا می‌برد.

## هزینه — صریح و بدون پرده

هر مدلِ مشورت‌شده **یک فراخوانی کامل** از پروایدر است، به‌علاوهٔ یک فراخوانی
ترکیب. مشورت با ۳ مدل ≈ **۴ برابر** هزینهٔ یک پاسخ معمولی. توضیح ابزار هم
همین را به مدل می‌گوید: فقط برای سؤال‌هایی که ارزش چند دیدگاه را دارد.

## مدل امنیتی

1. **Allowlist سمت سرور.** فقط شناسه‌هایی که `listConfiguredModels()` (تازه،
   در هر اجرا، بدون کش) برمی‌گرداند پذیرفته می‌شود. رشتهٔ ناشناس یا غیررشته‌ای
   → ‏`not_allowed`، قبل از هر تماس با پروایدر.
2. **پاسخ‌های مشورت‌شده داده‌اند.** در پرامپت ترکیب با برچسب «پاسخ مدل N»
   می‌آیند — متنی برای سنجیدن، نه دستوری برای اجرا.
3. **خطاها امن و فارسی‌اند.** `ToolError` فقط پیام ثابت فارسی دارد؛ جزئیات
   پروایدر (نام میزبان، payload) هرگز به خروجی راه پیدا نمی‌کند.
4. **محدودیت gateway.** ‏`AiGateway` مدلِ ذخیره‌شده را تحمیل می‌کند («the
   stored model always wins»): با سیم‌کشی پیش‌فرض، هر چند نامی که allowlist
   شود، همهٔ دورهای مشورت به **مدل فعال** می‌روند. ترکیب چندمدلِ واقعی به
   پروایدری نیاز دارد که `CompletionRequest.model` را رعایت کند (آداپتر مستقیم
   یا wrapper مسیریاب). ‏`modelsUsed` صادقانه گزارش می‌دهد چه چیزی جواب داد.

## ثبت در `src/index.ts`

بعد از ساخته‌شدن `tools`، ‏`modelSvc` و `gateway`:

```ts
import {
  createConsultModelsTool,
  CONSULT_MODELS_TIMEOUT_MS,
} from "./tools/consult_models";

// بعد از: const gateway = new AiGateway({ storage, adapters, secrets });
tools.registry.register(
  createConsultModelsTool({
    provider,
    primaryModel: selection ? selection.modelId : config.aiModel,
    // در هر اجرا تازه خوانده می‌شود، هرگز کش نمی‌شود.
    listConfiguredModels: () => {
      const sel = gateway.currentSelection();
      if (!sel) return [];
      return modelSvc.enabledModels(sel.providerId).map((m) => m.modelId);
    },
  }) as Tool<unknown, unknown>,
);
```

مجوز `tools:consult_models` مثل بقیهٔ ابزارها توسط `authorizeToolUse` به
کاربران تأییدشده اعطا می‌شود (`ownerOnly` نیست).
