# بنچ‌مارک زمان‌بندی‌شده + هشدار افت کیفیت (Phase-3 Item 4)

> وضعیت: پیاده‌سازی کامل در `src/bench/` (history/baseline/tool) و
> `src/bot/cmd_phase3_bench.ts` (+ `cmd_phase3_bench_strings.ts`)؛
> ثبت ابزار `run_bench` در `src/index.ts` و ثبت دستور `/bench` در
> `src/bot/bot.ts` **با هماهنگ‌کننده است** (این ماژول هیچ‌یک از آن فایل‌ها
> را لمس نمی‌کند).

## چی ساخته شد

یک حلقهٔ بسته برای پایش کیفیت بابی:

1. **تاریخچهٔ بنچ‌مارک** (`src/bench/history.ts` — کلاس `BenchHistory`): هر
   اجرای تمام‌شده (CLI یا زمان‌بندی‌شده) با خلاصه (زمان، حالت، provider،
   مدل، تعداد تسک، موفق/ناموفق، میانگین امتیاز، تأخیر، توکن، هزینه) و
   امتیاز تک‌تک تسک‌ها در SQLite ذخیره می‌شود. جدول‌ها lazy با
   `CREATE TABLE IF NOT EXISTS` ساخته می‌شوند — همان الگوی NudgeTracker و
   ProposalStore؛ `src/storage/storage.ts` دست نخورده (مالکیت با بستهٔ
   دیگری است). سقف ۱۰۰ اجرای اخیر (هرس خودکار). گزارش‌های فایل CLI
   (`bench/results/*.json|md`) سر جایشان مانده‌اند.

2. **ابزار `run_bench`** (`src/bench/tool.ts`): فقط مالک (`ownerOnly` +
   بازبینی `isOwner` سمت سرور). ورودی: `{mode: "offline"|"live", tasks?}`.
   - آفلاین (پیش‌فرض): FakeProvider + وبِ شبیه‌سازی‌شده؛ چند ثانیه طول
     می‌کشد و همیشه روی زمان‌بندی امن است.
   - زنده: دقیقاً همان مسیر `bun bench/run.ts --live` (AiGateway روی
     دیتابیس کانفیگ). اگر provider پیکربندی نشده باشد، **با صدای بلند رد
     می‌شود**: به مالک پیام فارسی می‌رسد، هیچ رکوردی ثبت نمی‌شود و هیچ‌چیز
     جعل نمی‌شود (قانون refuse-to-fake رانر).
   - بعد از هر اجرا: ثبت در تاریخچه + مقایسه با خط‌مبنا + هشدار در صورت افت.

3. **خط‌مبنای غلتان + هشدار** (`src/bench/baseline.ts`):
   - خط‌مبنا = میانگین امتیازِ ۵ اجرای اخیرِ موفق برای همان جفت
     (mode, model)؛ حداقل ۳ اجرا لازم است (کمتر از آن = بدون هشدار).
   - **آستانهٔ هشدار**: افتِ میانگین ≥ **۵ واحد درصد** نسبت به خط‌مبنا.
     علاوه بر آن، تسک‌هایی که ≥ **۲۰ واحد** افت کرده‌اند در متن هشدار
     فهرست می‌شوند (اطلاعاتی؛ ماشه همان افت کلی است).
   - **ضد اسپم**: یک هشدار برای هر کلید `regression:<mode>:<model>` در هر
     **۲۴ ساعت**؛ هر اجرا حداکثر یک‌بار ارزیابی می‌شود.
   - متن هشدار فقط عدد است: میانگین این اجرا، میانگین خط‌مبنا، میزان افت،
     بدترین تسک‌ها. **بدون پرامپت، بدون آرگومان ابزار، بدون خروجی خام مدل.**

4. **زمان‌بندی** (cron، پیش‌فرض **خاموش**): مالک با
   `/bench schedule 0 3 * * 0` یک وظیفهٔ زمان‌بندی‌شده می‌سازد که اکشنش
   `{type:"tool", tool:"run_bench", input:{mode}}` است و TaskScheduler
   موجود آن را اجرا می‌کند (claim اتمی، catch-up، re-arm — همان مکانیک
   reminderها). دقیقاً یک زمان‌بندی بنچ‌مارک وجود دارد (نام ثابت
   `bench: scheduled run`)؛ `/bench schedule off` حذفش می‌کند.

5. **دستور مالک `/bench`**: `history [n]`، `trend [task_id]`،
   `run [--live] [task…]`، `schedule <cron|off> [--live]`، `status`.

## مالک چطور استفاده می‌کند

```
/bench run                  → اجرای دستی آفلاین همین حالا
/bench run --live           → اجرای دستی زنده (چند دقیقه طول می‌کشد)
/bench history 10           → ده اجرای اخیر با میانگین امتیاز
/bench trend                → روند میانگین کلی
/bench trend mem_birthday    → روند یک تسک خاص
/bench schedule 0 3 * * 0   → هر یکشنبه ساعت ۳ صبح تهران، آفلاین
/bench schedule 0 3 * * 0 --live  → همان، ولی زنده
/bench schedule off         → خاموش کردن زمان‌بندی
/bench status               → وضعیت زمان‌بندی + آخرین اجرا
```

نمونهٔ هشدار افت کیفیت:

```
⚠️ هشدار افت کیفیت بنچ‌مارک
حالت: زنده (مدل واقعی) — مدل: gpt-4o-mini
میانگین امتیاز این اجرا: ۶۲٪
میانگین ۵ اجرای اخیر: ۷۸٪ — افت ۱۶ واحد.
بیشترین افت‌ها:
• mem_birthday: ۱۰۰٪ ← ۲۵٪ (افت ۷۵)
زمان اجرا: یکشنبه ۲۷ مهر ۱۴۰۵، ساعت ۰۳:۰۱
جزئیات کامل: /bench history
```

## بررسی سطح حمله (attack-surface review)

- **اجرای سندباکس‌شده**: استک بنچ‌مارک فقط با `buildOfflineStack()` /
  `buildLiveStack()` از `bench/run.ts` ساخته می‌شود؛ *تمام* وضعیت ابزارها
  در یک `Storage.open(":memory:")` تازه است که بعد از اجرا دور ریخته
  می‌شود. یک اجرای زمان‌بندی‌شده هرگز نمی‌تواند مکالمات، حافظه، یادآورها یا
  وظایف واقعی مالک را بخواند/بنویسد. `web_search`/`fetch_url` شبیه‌سازی
  شده‌اند (بدون شبکه). اکتور بنچ فقط مجوزهای رجیستریِ بنچ را دارد — هیچ‌چیز
  از رجیستری زندهٔ ربات در دسترس نیست.
- **نشت بین کاربران**: تاریخچه و هشدارها فقط مالک. ابزار `ownerOnly` است و
  `run()` مالکیت را با predicate سمت سرور دوباره چک می‌کند؛ دستور `/bench`
  پشت `requireOwnerTier` است. هیچ شناسهٔ کاربری از ورودی گرفته نمی‌شود.
- **محتوای هشدار**: فقط امتیاز و دلتا؛ پرامپت تسک‌ها، آرگومان ابزارها و
  خروجی خام مدل هرگز وارد پیام نمی‌شوند (تست `bench_baseline.test.ts` این را
  قفل می‌کند).
- **رد بلندِ زندهٔ بدون provider**: به‌جای جعل امتیاز، پیام فارسی «اجرا نشد»
  به مالک می‌رسد و رکوردی ثبت نمی‌شود — خط‌مبنا با دادهٔ جعلی آلوده نمی‌شود.
- **سقف‌ها**: حداکثر ۱۰۰ اجرا در تاریخچه؛ ورودی `tasks` حداکثر ۳۲ شناسه با
  الگوی `^[a-z0-9][a-z0-9_]{0,63}$`؛ خرابی notify هرگز اجرا را fail نمی‌کند
  (لاگ می‌شود).

## محدودیت شناخته‌شده: اجرای زندهٔ زمان‌بندی‌شده

> **به‌روزرسانی Phase-4:** این محدودیت با ورکر پس‌زمینه برطرف شد —
> `docs/PHASE4_BENCH_WORKER.md`. `/bench schedule … --live` حالا اکشن
> `{mode:"live", background:true}` می‌سازد که در میلی‌ثانیه enqueue می‌شود
> و ورکر دیمون اجرای کامل زنده را خارج از بودجهٔ ۳۰ ثانیه‌ای انجام می‌دهد
> (ثبت تاریخچه + هشدار افت کیفیت + پیام به مالک). پاراگراف زیر فقط رفتار
> **قبل از Phase-4** را توصیف می‌کند.

یک اجرای زندهٔ کامل (۲۴ تسک) چند دقیقه طول می‌کشد؛ بیشتر از بودجهٔ هر اکشن
زمان‌بند (پیش‌فرض ۳۰ ثانیه). اجرا در پس‌زمینه تمام می‌شود و نتیجه ثبت و
اطلاع‌رسانی می‌شود، اما آن اسلات در `list_tasks` «failed» دیده می‌شود.
توصیه: **آفلاین روی زمان‌بندی** (سریع، در بودجه) و **زنده به‌صورت دستی**
(`bun bench/run.ts --live` یا `/bench run --live`).

## نکات اتصال برای هماهنگ‌کننده (wiring)

`src/index.ts` (کنار بقیهٔ ابزارها):

```ts
import { Database } from "bun:sqlite";
import { BenchHistory } from "./bench/history";
import { createRunBenchTool, defaultLiveStackBuilder } from "./bench/tool";

const benchHistory = new BenchHistory(new Database(config.dbPath)); // اتصال دوم، مثل ProposalStore
const runBenchTool = createRunBenchTool({
  isOwner: (userId) => identity.isOwner(Number(userId)),
  history: benchHistory,
  notifyOwner: async (text) => {
    // همان مسیر تحویل proactive مثل nudge sweep: فقط DM مالک، با بازبینی
    // دسترسی لحظهٔ تحویل (mayDeliverTo). هرگز گروه، هرگز کاربر دیگر.
    if (mayDeliverTo(String(ownerId), String(ownerId))) {
      await bot.api.sendMessage(ownerId, text);
    }
  },
  buildLive: defaultLiveStackBuilder(config.dbPath),
});
extraTools.push(runBenchTool as Tool<unknown, unknown>);
```

`src/bot/bot.ts` (در `createBot`، کنار بقیهٔ `register*Commands`):

```ts
import { registerBenchCommands, COMMAND_DEFS as BENCH_COMMAND_DEFS } from "./cmd_phase3_bench";
// COMMAND_DEFS را در setMyCommands ادغام کن (ownerOnly: true → فقط منوی مالک)
// registerBenchCommands(bot, { ...deps, history: benchHistory, runBenchNow })
```

برای `runBenchNow` (اجرای دستی از تلگرام): همان `runBenchTool.run(...)`
با یک ToolContext که اکتورش اکتورِ سمتِ سرورِ مالک است:

```ts
runBenchNow: (opts) =>
  runBenchTool.run(opts, {
    clock: () => new Date(),
    actor: toToolActor(authorizeToolUse(auth, toAuthActor(String(ownerId)), tools.registry.list())),
    signal: new AbortController().signal,
  }),
```

## عمداً جا افتاده (و چرا)

- **ثبت ابزار/dستور در index.ts و bot.ts**: قانون بسته — فقط هماهنگ‌کننده.
- **تغییر `bench/run.ts`**: رفتار CLI دست نخورده؛ ابزار از همان سازنده‌های
  صادرشده (`buildOfflineStack`/`buildLiveStack`/`runTask`) استفاده می‌کند.
- **تغییر `src/storage/storage.ts`**: جدول‌ها lazy در `src/bench/history.ts`
  ساخته می‌شوند (مالکیت storage.ts با بستهٔ دیگری است).
- **هشدار برای حالت آفلاین هم فعال است**: افت امتیاز آفلاین یعنی خرابی
  plumbing — همان‌قدر ارزش هشدار دارد.
- **داشبورد وب**: آیتم ۳ (داشبورد مالک) بستهٔ دیگری است؛ `/bench trend` تا
  آن زمان خروجی متنی می‌دهد.
