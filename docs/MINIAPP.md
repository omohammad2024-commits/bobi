# BOBI Mini App — مدیریت کامل (فقط مالک)

Telegram Mini App که کنترل کامل بابی را به مالک می‌دهد: چت مستقیم با ایجنت،
مدیریت پروایدرها و مدل‌ها، کاربرها، حافظه، بنچمارک‌ها، زمان‌بندها، اسکیل‌ها،
مصرف، تسک‌ها و گروه‌ها — همه از داخل تلگرام، بدون برگشتن به چت.

## دسترسی

- **فقط مالک.** هر درخواست `POST /miniapp/api/*` باید `initData` تلگرام
  بفرستد؛ سرور امضا را با HMAC-SHA256 (کلید = توکن بات) راستی‌آزمایی می‌کند،
  تازگی `auth_date` (۲۴ ساعت) را چک می‌کند و `user.id` را با شناسهٔ مالک
  مقایسه می‌کند. خطا همیشه 401 ژنریک است.
- دکمهٔ ورود فقط در منوی مالک است (`menu.label.miniapp`) و فقط وقتی رندر
  می‌شود که URL عمومی HTTPS پیکربندی شده باشد؛ برای عموم هیچ اثری نیست.
- کلیدهای پروایدر هرگز کامل به کلاینت نمی‌روند (فقط `••••` + ۴ رقم آخر).

## آدرس عمومی

مینی‌اپ فقط روی HTTPS عمومی باز می‌شود (الزام تلگرام). ترتیب resolve:

1. متغیر محیطی `BOBI_MINIAPP_URL`
2. فایل `miniapp.url` در working directory بات (سرویس تونل می‌نویسد)
3. هیچ‌کدام → دکمه رندر نمی‌شود (fail-closed)

جزئیات تونل: `docs/MINIAPP_TUNNEL.md`.

## API

همه `POST /miniapp/api/<action>` با بدنهٔ `{initData, ...}`:

- `turn` — یک نوبت کامل ایجنت به‌عنوان مالک (تب چت + اجرای هر کامند)
- `providers.*` — list, presets, add, update, toggle, delete, probe,
  setKey, clearKey, setActive
- `models.*` — list, discover (از `GET {baseUrl}/models`), import, add,
  toggle, delete, setActive
- `users.*`, `memory.*`, `curator.*`, `events.*`, `bench.*`,
  `schedulers.*`, `digest.*`, `groupdigests.*`, `skills.*`, `trust.*`,
  `usage.*`, `tasks.*`, `groups.*`, `moderation.*`

## معماری

- `src/miniapp/auth.ts` — اعتبارسنجی initData
- `src/miniapp/api.ts` — روتر `/miniapp/*` (فایل استاتیک + JSON)
- `src/miniapp/api_providers.ts` — پروایدر/مدل (روی ProviderService)
- `src/miniapp/api_manage.ts` — بقیهٔ مدیریت
- `src/miniapp/web/` — فرانت‌اند (تک‌صفحه‌ای، بدون بیلد، دوزبانه، RTL)
- روی همان `Bun.serve` سوار است؛ listener دوم ندارد.
