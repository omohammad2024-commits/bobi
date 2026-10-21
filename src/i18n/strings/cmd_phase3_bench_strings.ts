import { translateFrom } from "../../i18n";

/**
 * English-only strings for the Phase-3 benchmark commands
 * (`src/bot/cmd_phase3_bench.ts`).
 *
 * Part of the i18n system: this module lives under `src/i18n/strings/`.
 * Every key is prefixed `cmd_phase3_bench.*`.
 */

/** UI languages supported by these commands. */
export type BenchLang = "en";

type Vars = Record<string, string | number>;



const STRINGS: Record<string, string> = {
  "cmd_phase3_bench.owner_only": "This command is owner-only.",
  "cmd_phase3_bench.need_tools": "Tool service unavailable; this command is down for now.",
  "cmd_phase3_bench.tool_failed": "Tool execution failed.",
  "cmd_phase3_bench.no_history": "No benchmark runs recorded yet. Run one with /bench run.",

  "cmd_phase3_bench.help":
    "Usage:\n/bench history [n] — recent runs\n/bench trend [task_id] — score trend (overall or one task)\n/bench run [--live] [--bg] [task_id ...] — run the benchmark now (--bg: in background)\n/bench schedule <cron|off> [--live] — schedule periodic runs (default: off)\n/bench status — schedule, worker and latest run\n/bench cancel — cancel the running/queued background run",

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
  "cmd_phase3_bench.run.queued":
    "Benchmark queued in the background worker (position {position}); the result lands here.",

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
  "cmd_phase3_bench.schedule.live_worker_note":
    "Live runs execute in the background worker (outside the scheduler's 30-second budget); the result and any quality alert land here.",

  "cmd_phase3_bench.status.scheduled": "Schedule: on — {cron} ({mode}), next: {next}",
  "cmd_phase3_bench.status.unscheduled": "Schedule: off (default).",
  "cmd_phase3_bench.status.last":
    "Latest run: #{id} — {date} — avg {avg}% ({passed}/{tasks} passed)",
  "cmd_phase3_bench.status.no_last": "No runs recorded yet.",

  "cmd_phase3_bench.status.worker.idle": "Bench worker: idle.",
  "cmd_phase3_bench.status.worker.running":
    "Bench worker: running ({mode}) since {started}.",
  "cmd_phase3_bench.status.worker.progress":
    "Progress: {done} of {total} tasks — current task: {task} — {elapsed}s elapsed.",
  "cmd_phase3_bench.status.worker.pending": "Worker queue: {n} run(s).",
  "cmd_phase3_bench.status.worker.unavailable": "Bench worker not active in this build.",

  "cmd_phase3_bench.history.note": "Note: {note}",

  "cmd_phase3_bench.cancel.done":
    "Cancelled: {pending} queued and {running} running run(s).",
  "cmd_phase3_bench.cancel.nothing": "No active or queued runs in the bench worker.",
  "cmd_phase3_bench.cancel.unavailable": "Bench worker not active in this build.",
};

/** Translate a key; falls back to the key itself. The `lang` argument is
 * accepted for signature compatibility and ignored: the UI is English-only. */
export function tr(
  _lang: "en" | "fa", // accepted for compatibility; always renders English
  key: string,
  vars?: Vars,
): string {
  return translateFrom(STRINGS, key, vars);
}
