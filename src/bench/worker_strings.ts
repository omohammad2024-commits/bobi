/**
 * Persian/English strings for the Phase-4 benchmark background worker
 * (`src/bench/worker.ts`) — owner DMs the worker sends on completion,
 * failure, and repeated-failure alerts.
 *
 * Module-local table (same pattern as `cmd_phase3_bench_strings.ts`):
 * every key is prefixed `bench.worker.*`, Persian is ground truth, and the
 * i18n parity test discovers this file by glob — fa/en must stay paired.
 */

/** UI languages supported by the worker's owner messages. */
export type WorkerLang = "fa" | "en";

type Vars = Record<string, string | number>;

const fa: Record<string, string> = {
  "bench.worker.mode.live": "زنده",
  "bench.worker.mode.offline": "آفلاین",

  "bench.worker.done":
    "✅ بنچ‌مارک پس‌زمینه تمام شد ({mode}).\nمیانگین امتیاز: {avg}٪ — موفق: {passed} از {tasks}\nشناسهٔ ثبت: {id}",
  "bench.worker.failed":
    "❌ بنچ‌مارک پس‌زمینه ناموفق بود ({mode}).\nدلیل: {reason}\nجزئیات: /bench history",
  "bench.worker.failed_alert":
    "⚠️ هشدار: {n} اجرای پیاپی بنچ‌مارک پس‌زمینه ناموفق بود.\nآخرین خطا: {reason}\nبرای بررسی: /bench history و /bench status",

  "bench.worker.reason.timeout": "تمام شدن مهلت اجرا",
  "bench.worker.reason.cancelled": "لغو توسط مالک",
  "bench.worker.reason.interrupted": "ری‌استارت دیمون وسط اجرا",

  "bench.worker.recovered":
    "⚠️ دیمون وسط اجرای بنچ‌مارک ری‌استارت شد.\n{n} اجرا ناتمام ماند و «ناموفق» ثبت شد؛ {m} نوبت در صف دوباره فعال شدند.\nجزئیات: /bench history",
};

const en: Record<string, string> = {
  "bench.worker.mode.live": "live",
  "bench.worker.mode.offline": "offline",

  "bench.worker.done":
    "✅ Background benchmark finished ({mode}).\nAvg score: {avg}% — passed: {passed} of {tasks}\nRun id: {id}",
  "bench.worker.failed":
    "❌ Background benchmark failed ({mode}).\nReason: {reason}\nDetails: /bench history",
  "bench.worker.failed_alert":
    "⚠️ Alert: {n} consecutive background benchmark runs failed.\nLast error: {reason}\nCheck /bench history and /bench status",

  "bench.worker.reason.timeout": "run timeout",
  "bench.worker.reason.cancelled": "cancelled by owner",
  "bench.worker.reason.interrupted": "daemon restarted mid-run",

  "bench.worker.recovered":
    "⚠️ The daemon restarted mid-benchmark.\n{n} run(s) were left unfinished and recorded as failed; {m} queued run(s) reactivated.\nDetails: /bench history",
};

const DICTS: Record<WorkerLang, Record<string, string>> = { fa, en };

/** Translate a key; falls back to Persian, then to the key itself. */
export function tr(lang: WorkerLang, key: string, vars?: Vars): string {
  const dict = DICTS[lang] ?? fa;
  let s = dict[key] ?? fa[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
