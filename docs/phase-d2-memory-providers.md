# فاز D2 — حافظهٔ بلندمدتِ قابل‌تعویض (Memory Providers)

ابزارهای `remember`/`recall`/`forget` دیگر مستقیم به جدول `memories` دست
نمی‌زنند؛ با یک `MemoryProvider` حرف می‌زنند و پروایدر تصمیم می‌گیرد بایت‌ها
کجا زندگی کنند. عوض کردن بک‌اند یک متغیرِ محیطی است (`BOBI_MEMORY_PROVIDER`)،
نه تغییرِ کد.

## قرارداد پروایدر

`src/memory/provider.ts`:

```ts
interface MemoryProvider {
  readonly name: string;
  upsert(userId, key, content): void | Promise<void>;
  get(userId, key): StoredMemory | undefined | Promise<...>;
  list(userId, limit?): StoredMemory[] | Promise<...>;   // تازه‌ترین اول
  delete(userId, key): boolean | Promise<boolean>;       // true یعنی ردیفی رفت
  count(userId): number | Promise<number>;
}
```

پنج عملیات دقیقاً آینهٔ API حافظهٔ استوریج‌اند
(`upsertMemory`/`getMemory`/`listMemories`/`deleteMemory`/`countMemories`) تا
پروایدرِ SQLite «همان رفتارِ فعلی» باشد که پشت اینترفیس رفته — نه بیشتر، نه
کمتر. متدها می‌توانند sync یا async باشند؛ ابزارها همه را `await` می‌کنند.

نکته‌های قرارداد:

- **مالکیت کارِ ابزارهاست، ولی پروایدر هم باید مقید باشد**: هر متد `userId`
  می‌گیرد و پروایدرِ درست همه‌چیز را به همان کاربر محدود می‌کند — دقیقاً مثل
  کلیدِ اصلیِ `(user_id, key)` جدول. پروایدر هرگز ردیفِ کاربرِ دیگر را
  نمی‌خواند/نمی‌نویسد و شناسهٔ کاربر از خودش درنمی‌آورد.
- منطقِ ابزاری (نرمال‌سازی کلید، سقف ۲۰۰ حافظه، رتبه‌بندیِ `recall`) در
  `src/tools/memory.ts` مانده و به پروایدر نرفته؛ پس رفتارِ ابزارها با هر
  بک‌اندی یکسان است.

## قطعه‌ها

| فایل | نقش |
|---|---|
| `src/memory/provider.ts` | اینترفیس و `StoredMemory` |
| `src/memory/sqlite_provider.ts` | `SqliteMemoryProvider` — رفتارِ فعلی، کلمه‌به‌کلمه پشت اینترفیس |
| `src/memory/registry.ts` | رجیستریِ کوچک: `register` / `get(name)` / `names()` |
| `src/memory/factory.ts` | `resolveMemoryProvider(storage)` — انتخاب از روی محیط |
| `src/memory/index.ts` | نقطهٔ ورودِ واحد برای ایمپورت |

## انتخاب بک‌اند

**بدون دست زدن به `config.ts`**: فکتوری مستقیم `process.env.BOBI_MEMORY_PROVIDER`
را می‌خواند (پیش‌فرض `"sqlite"`). در `.env.example` مستند شده.

- `"sqlite"` (یا خالی): هر بار یک `SqliteMemoryProvider` تازه روی همان
  استوریج می‌سازد — هیچ کشِ کهنه‌ای بین فراخوانی‌ها نیست.
- هر نامِ دیگر باید قبلاً با `registerMemoryProvider` ثبت شده باشد (مثلاً در
  سیم‌کشیِ استارت‌آپ، کنار بقیهٔ boot).
- نامِ ناشناس **خطا** می‌دهد، نه fallbackِ بی‌صدا: بک‌اندِ اشتباه‌پیکربندی‌شده
  باید موقع استارت داد بزند، نه اینکه بعداً غافلگیر کند.

## نوشتن پروایدرِ سفارشی

```ts
import { registerMemoryProvider } from "./memory";
import type { MemoryProvider } from "./memory";

class MyProvider implements MemoryProvider {
  readonly name = "mine";
  // ... پیاده‌سازی پنج متد
}

registerMemoryProvider(new MyProvider());
// BOBI_MEMORY_PROVIDER=mine
```

تستِ `tests/memory_providers.test.ts` همین کار را با یک `MapMemoryProvider`
داخلِ خودِ فایلِ تست می‌کند و ثابت می‌کند ابزارها روی بک‌اندِ غیر-SQLite هم
دقیقاً همان رفتار را دارند.

## امنیت

- پروایدر دادهٔ کاربر را نگه می‌دارد: محتوای حافظه را لاگ نکند، جایی که
  ابزارها نخواسته‌اند نفرستد، و `(userId, key)` را آدرسِ کاملِ ردیف بداند —
  نه حدس بزند، نه بازش کند.
- ابزارها `userId` را فقط از ToolActor می‌گیرند؛ ورودیِ مدل هیچ‌وقت شناسهٔ
  کاربر نیست. تستِ ایزولیشن همین را روی پروایدرِ سفارشی هم چک می‌کند.
