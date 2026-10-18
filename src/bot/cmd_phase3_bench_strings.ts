/**
 * Persian/English strings for the Phase-3 benchmark commands
 * (`src/bot/cmd_phase3_bench.ts`).
 *
 * Kept in a module-local dictionary (NOT in `src/i18n/`) because the
 * coordinator owns the i18n fold-in — this file is the source it merges from.
 * Every key is prefixed `cmd_phase3_bench.*`. Persian is the ground truth.
 */

/** UI languages supported by these commands. */
export type BenchLang = "fa" | "en";

type Vars = Record<string, string | number>;

const fa: Record<string, string> = {
  "cmd_phase3_bench.owner_only": "این دستور فقط برای مالک است.",
  "cmd_phase3_bench.need_tools": "سرویس ابزارها در دسترس نیست؛ این دستور فعلاً کار نمی‌کند.",
  "cmd_phase3_bench.tool_failed": "اجرای ابزار ناموفق بود.",
  "cmd_phase3_bench.no_history": "هنوز هیچ بنچ‌مارکی ثبت نشده است. با «/bench run» یکی اجرا کن.",

  "cmd_phase3_bench.help":
    "استفاده:\n/bench history [n] — آخرین اجراها\n/bench trend [task_id] — روند امتیاز (کلی یا یک تسک)\n/bench run [--live] [task_id ...] — اجرای دستی بنچ‌مارک\n/bench schedule <cron|off> [--live] — زمان‌بندی اجرای دوره‌ای (پیش‌فرض: خاموش)\n/bench status — وضعیت زمان‌بندی و آخرین اجرا",

  "cmd_phase3_bench.history.title": "تاریخچهٔ بنچ‌مارک (آخرین {n}):",
  "cmd_phase3_bench.history.item":
    "#{id} — {date} — {mode} — {model}\nمیانگین امتیاز: {avg}٪ — موفق: {passed} از {tasks}",
  "cmd_phase3_bench.history.mode.offline": "آفلاین",
  "cmd_phase3_bench.history.mode.live": "زنده",

  "cmd_phase3_bench.trend.title": "روند میانگین امتیاز ({mode} — {model}):",
  "cmd_phase3_bench.trend.line": "#{id}: {avg}٪",
  "cmd_phase3_bench.trend.task.title": "روند تسک {task} ({title}):",
  "cmd_phase3_bench.trend.task.line": "#{id}: {pct}٪",
  "cmd_phase3_bench.trend.no_task": "تسکی با شناسهٔ «{task}» در تاریخچه پیدا نشد.",

  "cmd_phase3_bench.run.started": "بنچ‌مارک شروع شد (حالت {mode})؛ کمی صبر کن…",
  "cmd_phase3_bench.run.live_note":
    "اجرای زنده چند دقیقه طول می‌کشد؛ نتیجه همین‌جا اعلام می‌شود.",
  "cmd_phase3_bench.run.unavailable":
    "اجرای دستی بنچ‌مارک در این نمونه وصل نیست؛ از CLI استفاده کن: bun bench/run.ts{live}",

  "cmd_phase3_bench.schedule.created":
    "زمان‌بندی بنچ‌مارک فعال شد: {cron} ({mode}) — شناسهٔ وظیفه: {id}",
  "cmd_phase3_bench.schedule.updated":
    "زمان‌بندی بنچ‌مارک به‌روز شد: {cron} ({mode}) — شناسهٔ وظیفه: {id}",
  "cmd_phase3_bench.schedule.off": "زمان‌بندی بنچ‌مارک خاموش شد.",
  "cmd_phase3_bench.schedule.none": "زمان‌بندی فعالی برای بنچ‌مارک نیست.",
  "cmd_phase3_bench.schedule.bad_cron":
    "عبارت cron نامعتبر است. مثال: «0 3 * * 0» یعنی یکشنبه‌ها ساعت ۳ صبح تهران.",
  "cmd_phase3_bench.schedule.usage":
    "استفاده: /bench schedule <cron|off> [--live]\nمثال: /bench schedule 0 3 * * 0 --live",
  "cmd_phase3_bench.schedule.mode.offline": "آفلاین",
  "cmd_phase3_bench.schedule.mode.live": "زنده",

  "cmd_phase3_bench.status.scheduled": "زمان‌بندی: فعال — {cron} ({mode})، اجرای بعدی: {next}",
  "cmd_phase3_bench.status.unscheduled": "زمان‌بندی: خاموش (پیش‌فرض).",
  "cmd_phase3_bench.status.last":
    "آخرین اجرا: #{id} — {date} — میانگین {avg}٪ ({passed}/{tasks} موفق)",
  "cmd_phase3_bench.status.no_last": "هنوز اجرایی ثبت نشده است.",
};

const en: Record<string, string> = {
  "cmd_phase3_bench.owner_only": "This command is owner-only.",
  "cmd_phase3_bench.need_tools": "Tool service unavailable; this command is down for now.",
  "cmd_phase3_bench.tool_failed": "Tool execution failed.",
  "cmd_phase3_bench.no_history": "No benchmark runs recorded yet. Run one with /bench run.",

  "cmd_phase3_bench.help":
    "Usage:\n/bench history [n] — recent runs\n/bench trend [task_id] — score trend (overall or one task)\n/bench run [--live] [task_id ...] — run the benchmark now\n/bench schedule <cron|off> [--live] — schedule periodic runs (default: off)\n/bench status — schedule state and latest run",

  "cmd_phase3_bench.history.title": "Benchmark history (last {n}):",
  "cmd_phase3_bench.history.item":
    "#{id} — {date} — {mode} — {model}\nAvg score: {avg}% — passed: {passed} of {tasks}",
  "cmd_phase3_bench.history.mode.offline": "offline",
  "cmd_phase3_bench.history.mode.live": "live",

  "cmd_phase3_bench.trend.title": "Average score trend ({mode} — {model}):",
  "cmd_phase3_bench.trend.line": "#{id}: {avg}%",
  "cmd_phase3_bench.trend.task.title": "Trend for task {task} ({title}):",
  "cmd_phase3_bench.trend.task.line": "#{id}: {pct}%",
  "cmd_phase3_bench.trend.no_task": "No history for task id \"{task}\".",

  "cmd_phase3_bench.run.started": "Benchmark started ({mode}); one moment…",
  "cmd_phase3_bench.run.live_note":
    "A live run takes several minutes; the result lands here.",
  "cmd_phase3_bench.run.unavailable":
    "Manual benchmark runs are not wired in this build; use the CLI: bun bench/run.ts{live}",

  "cmd_phase3_bench.schedule.created":
    "Benchmark schedule enabled: {cron} ({mode}) — task id: {id}",
  "cmd_phase3_bench.schedule.updated":
    "Benchmark schedule updated: {cron} ({mode}) — task id: {id}",
  "cmd_phase3_bench.schedule.off": "Benchmark schedule turned off.",
  "cmd_phase3_bench.schedule.none": "No active benchmark schedule.",
  "cmd_phase3_bench.schedule.bad_cron":
    "Invalid cron expression. Example: \"0 3 * * 0\" = Sundays 03:00 Tehran.",
  "cmd_phase3_bench.schedule.usage":
    "Usage: /bench schedule <cron|off> [--live]\nExample: /bench schedule 0 3 * * 0 --live",
  "cmd_phase3_bench.schedule.mode.offline": "offline",
  "cmd_phase3_bench.schedule.mode.live": "live",

  "cmd_phase3_bench.status.scheduled": "Schedule: on — {cron} ({mode}), next: {next}",
  "cmd_phase3_bench.status.unscheduled": "Schedule: off (default).",
  "cmd_phase3_bench.status.last":
    "Latest run: #{id} — {date} — avg {avg}% ({passed}/{tasks} passed)",
  "cmd_phase3_bench.status.no_last": "No runs recorded yet.",
};

const DICTS: Record<BenchLang, Record<string, string>> = { fa, en };

/** Translate a key; falls back to Persian, then to the key itself. */
export function tr(lang: BenchLang, key: string, vars?: Vars): string {
  const dict = DICTS[lang] ?? fa;
  let s = dict[key] ?? fa[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
