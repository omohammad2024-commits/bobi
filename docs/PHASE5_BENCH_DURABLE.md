# صف بادوام بنچ‌مارک + پخش زندهٔ پیشرفت (Phase-5 Item 5)

> وضعیت: پیاده‌سازی کامل در `src/bench/queue_store.ts` (جدید)، توسعهٔ
> `src/bench/worker.ts` (بازیابی + رویدادهای زنده)، توسعهٔ `src/bench/history.ts`
> (ستون `note`)، توسعهٔ `/bench` (`cmd_phase3_bench.ts` + strings)، مسیر SSE جدید
> در داشبورد (`src/http/dashboard.ts` + `dashboard_pages.ts`) و سیم‌کشی در
> `src/http/server.ts` و `src/index.ts`.

## مسئله

فاز ۴ دو چیز را آگاهانه ناتمام گذاشت:

1. **صف in-memory بود**: ری‌استارت دیمون نوبت‌های در صف را می‌انداخت و —
   بدتر — اگر دیمون **وسط یک اجرا** می‌مرد، هیچ ردی از آن اجرا باقی نمی‌ماند
   (نه در `bench_runs`، نه در صف).
2. **پیشرفت زنده دیده نمی‌شد**: مالک فقط می‌فهمید ورکر «در حال اجرا»ست، نه
   چند تسک از چندتا تمام شده و تسک جاری چیست.

## راه‌حل

### ۱. صف بادوام (`src/bench/queue_store.ts`)

جدول جدید `bench_job_queue` با همان الگوی lazy جدول‌های بنچ (اتصال جداگانه به
فایل SQLite، `CREATE TABLE IF NOT EXISTS`، بدون دست‌کاری `storage.ts`):

| ستون | نقش |
|---|---|
| `seq` | ترتیب درج (ترتیب صف) |
| `job_id` | شناسهٔ یکتا (`UNIQUE`) |
| `mode` / `source` / `task_ids_json` / `enqueued_at_ms` | مشخصات جاب |
| `status` | `queued` / `running` |
| `recorded_run_id` | شناسهٔ ردیف `bench_runs` وقتی اجرا ثبت شد (ضدتکرر در کرش) |

چرخهٔ عمر ردیف:

```
enqueue → status='queued'
pump → claimForRun (اتمیک: UPDATE … WHERE status='queued') → 'running'
ثبت در bench_runs → markRecorded(runId) → finish (DELETE)
```

- **enqueue قبل از push در حافظه persist می‌شود**؛ خرابی store بلند خطا می‌دهد
  (اکشن زمان‌بند fail می‌شود، نه اینکه جاب ساکت گم شود).
- **`claimForRun` اتمیک است**: همان یک `UPDATE`، ضمانت exactly-once در برابر
  ری‌استارت است — فقط یک claimant برنده می‌شود.
- **حالت‌های پایانی ردیفی باقی نمی‌گذارند** (نتیجه در `bench_runs` است)؛
  `cancelPending` ردیف‌های در صف را هم پاک می‌کند تا جابِ لغوشده بعد از
  ری‌استارت زنده نشود.

### ۲. بازیابی در استارت (`BenchWorker.recover`)

`start()` اول `recover()` را صدا می‌زند (یک‌بار در هر فرایند؛ تست‌ها مستقیم
صدایش می‌زنند):

| ردیف | رفتار |
|---|---|
| `running` با `recorded_run_id` | اجرا قبل از کرش ثبت شده؛ فقط ردیف صف پاک می‌شود (بدون ردیف تکراری، بدون هشدار) |
| `running` بدون `recorded_run_id` | یک ردیف `bench_runs` با `status='failed'` و `note` روشن («ری‌استارت دیمون وسط اجرا») ثبت می‌شود؛ **اجرا دوباره انجام نمی‌شود** — فراخوانی‌های provider شاید قبلاً رخ داده‌اند و exactly-once تکرار کور را منع می‌کند. یک پیام به مالک + مسیر هشدار خطاهای پیاپی |
| `queued` | با **همان شناسهٔ قبلی** دوباره در صف حافظه قرار می‌گیرد (شناسهٔ تازه یعنی ردیف یتیم و اجرای دوباره در بازیابی بعدی — ممنوع) |

مسیر contention قفل (`requeueFront`) حالا `releaseClaim` هم می‌کند تا جابی که
فقط به‌خاطر قفل برگشته، در بازیابی بعدی «ناتمام» تلقی نشود.

### ۳. پخش زندهٔ پیشرفت

- مجری سوئیت حالا یک tick اختیاری `onProgress(done, total, taskId, titleFa)`
  می‌گیرد؛ حلقهٔ پیش‌فرض بین تسک‌ها tick می‌زند. مجری‌های تزریقی که tick
  نزنند فقط «بدون جزئیات پیشرفت» گزارش می‌شوند (سازگار با قبل).
- ورکر `subscribeProgress(cb)` دارد؛ رویدادها **هم‌زمان و مرتب** پخش می‌شوند:
  `snapshot` در هر تغییر وضعیت، `progress` به ترتیب تسک‌ها، دقیقاً یک
  `terminal` در پایان هر اجرا. listenerای که throw کند گرفته و لاگ می‌شود —
  هرگز اجرا را خراب نمی‌کند.
- **داشبورد**: `GET /api/v1/dashboard/benchmarks/live/stream` — Server-Sent
  Events روی همان `Bun.serve` و همان Bearer auth (بدون listener جدید، بدون
  CDN). اول `snapshot` فعلی، بعد `progress`/`terminal`، و هر ۱۵ ثانیه یک
  `: ping` برای زنده نگه‌داشتن اتصال. قطع اتصال کلاینت listener را پاک می‌کند.
  بالای تب بنچ‌مارک‌ها یک کارت «اجرای زنده» هست: نوار پیشرفت، تسک جاری، ثانیه‌شمار
  سپری‌شده، تعداد در صف. چون `EventSource` نمی‌تواند هدر `Authorization`
  بفرستد، کلاینت با `fetch` + `ReadableStream` استریم را می‌خواند.
- **تلگرام**: `/bench status` حالا خط پیشرفت را هم نشان می‌دهد
  («پیشرفت: ۷ از ۲۴ تسک — تسک جاری: … — ۶۵ ثانیه گذشته»)، و `/bench history`
  یادداشت (`note`) اجراهای ناموفق را چاپ می‌کند.

### ۴. حفظ‌شده‌ها (بدون تغییر رفتار)

- **exactly-once**: صف حافظه (یک فعال + حداکثر ۲ در صف) + قفل سراسری فرایند
  + claim اتمیک دیتابیسی. تست «۱۰ enqueue هم‌زمان → دقیقاً ۲ قبول، هر جاب
  دقیقاً یک‌بار اجرا».
- **کنسل**: `/bench cancel` ردیف‌های در صف را از store هم پاک می‌کند؛ اجرای
  فعال cooperative لغو و `cancelled` ثبت می‌شود.
- **هشدار افت کیفیت**: بدون تغییر — همان مسیر `baseline.ts` با همان cooldownها؛
  ردیف‌های `failed`/`cancelled` خط‌مبنا را آلوده نمی‌کنند.

## بررسی سطح حمله

1. **بدون سطح شبکهٔ جدید**: استریم SSE روی همان سوکت و همان توکن داشبورد است؛
   همان ریت‌لیمیت (۳۰/دقیقه) قبل از احراز هویت. خودِ استریم یک درخواست است،
   نه polling پرتکرار.
2. **فقط مالک**: استریم پشت Bearer توکنِ مالک است (401 بدون توکن)؛ خودِ ورکر فقط
   از ابزارِ `ownerOnly` تغذیه می‌شود. هیچ سطح عمومی‌ای اضافه نشده.
3. **بدون نشت داده**: payloadها فقط شناسه/شمارش/عنوان تسک‌اند — نه پرامپت، نه
   خروجی خام مدل (همان قانون تاریخچهٔ بنچ). `note` هم فقط دلیل کوتاه است.
4. **مقاومت در برابر listener مخرب/کند**: هر subscriber در try/catch است؛
   کندی کلاینت SSE روی اجرای بنچ‌مارک اثر ندارد (صف‌کشی سمت استریم).
5. **خطر پر شدن دیسک**: جدول صف فقط جاب‌های فعال/در صف را نگه می‌دارد (پایانی‌ها
   DELETE می‌شوند)؛ `bench_runs` همان سقف ۱۰۰تایی قبلی را دارد. `task_ids_json`
   هنگام خواندن اعتبارسنجی می‌شود (JSON خراب → کل سوئیت، نه کرش).
6. **بازیابی مخرب؟** ردیف‌های `running`/`queued` فقط از همین دیمون می‌آیند
   (فایل SQLite مال بات است)؛ `recover` شناسه‌ها را بازتولید نمی‌کند و هیچ‌چیز
   را خودکار دوباره اجرا نمی‌کند.

## عمداً بیرون گذاشته شده (و چرا)

- **timeout preemptive**: همچنان cooperative است (بین تسک‌ها) — مثل فاز ۴. لغو
  آنی وسط یک turn به kill کردن thread نیاز دارد که در مدل تک‌فرایند Bun امن نیست.
- **اجرای خودکارِ دوبارهٔ جاب‌های ناتمام**: عمداً نه — تکرار کور یعنی فراخوانی
  دوبارهٔ provider و شکستن exactly-once. مالک با `/bench run` خودش دوباره اجرا
  می‌گیرد.
- **شمارندهٔ خطاهای پیاپی بادوام**: همچنان in-memory است و با ری‌استارت صفر
  می‌شود؛ کرشِ حین اجرا یک واحد به آن اضافه می‌کند ولی آستانه (۳) و cooldown
  (۲۴ساعت) جلوی هشدارِ بی‌موردِ ری‌استارت‌های معمولی را می‌گیرد.
- **پیشرفتِ درونِ یک تسک** (نه بین تسک‌ها): tickها در مرز تسک‌اند؛ granularتر
  شدن به hook در `runTask` نیاز دارد که قرارداد bench/run.ts را عوض می‌کند.
- **صف نامحدود بادوام**: سقف ۲ نوبتِ در صف حفظ شده؛ overflow همچنان `queue_full`
  می‌دهد (ردِ بلند، نه گم‌شدن ساکت).

## فایل‌ها

- `src/bench/queue_store.ts` — جدید: `BenchJobStore` (جدول `bench_job_queue`)
- `src/bench/worker.ts` — `jobStore`، `claim`/`releaseClaim`/`markRecorded`/`finish`،
  `recover()`، `subscribeProgress`/`BenchLiveEvent`/`BenchProgress`، tickهای
  `onProgress` در مجری پیش‌فرض، `progress` در `snapshot()`
- `src/bench/worker_strings.ts` — `bench.worker.reason.interrupted` و
  `bench.worker.recovered` (فا/انگلیسی)
- `src/bench/history.ts` — ستون `note` (ALTER guarded برای دیتابیس‌های قدیمی) +
  پارامتر `note` در `recordRun`
- `src/bot/cmd_phase3_bench.ts` — خط پیشرفت در `workerStatusLine` + نمایش `note`
  در `history`
- `src/bot/cmd_phase3_bench_strings.ts` — `status.worker.progress` و `history.note`
- `src/http/dashboard.ts` — `BenchWorkerProgress`، مسیر
  `/api/v1/dashboard/benchmarks/live/stream` (SSE)
- `src/http/dashboard_pages.ts` — کارت «اجرای زنده» + کلاینت SSE در تب بنچ‌مارک‌ها
- `src/http/server.ts` — عبور `benchWorker` به داشبورد
- `src/index.ts` — ساخت `BenchJobStore`، تزریق به ورکر و API سرور
- `tests/bench_phase5.test.ts` — ۱۷ تست (بازیابی، exactly-once، ترتیب رویدادها،
  کنسل، استریم SSE، `/bench status`)
- `tests/dashboard.test.ts` — مسیر استریم به فهرست authz اضافه شد
