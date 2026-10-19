/**
 * English-only strings for the Hermes-parity automation commands
 * (`src/bot/cmd_auto.ts`).
 *
 * Kept in a module-local dictionary (NOT in `src/i18n/`) because the
 * coordinator owns the i18n fold-in — this file is the source it merges from.
 * Every key is prefixed `cmd_auto.*`.
 */

/** UI languages supported by these commands. */
export type AutoLang = "en";

type Vars = Record<string, string | number>;



const STRINGS: Record<string, string> = {
  "cmd_auto.owner_only": "This command is owner-only.",
  "cmd_auto.need_tools": "The tool service is unavailable; this command cannot run right now.",
  "cmd_auto.tool_failed": "Tool execution failed.",
  "cmd_auto.engine_failed": "Conversation run failed; try again later.",
  "cmd_auto.empty_prompt": "The prompt is empty.",
  "cmd_auto.bad_args": "Invalid arguments. Hint: {hint}",

  "cmd_auto.bg.queued": "Started in the background. ID: {id}",
  "cmd_auto.bg.busy": "Max 3 concurrent tasks; wait for one to finish.",
  "cmd_auto.bg.too_long": "Text can be at most 2000 characters.",
  "cmd_auto.bg.list_empty": "You have no background tasks.",
  "cmd_auto.bg.list_item": "{id} — {status} — {prompt}",
  "cmd_auto.bg.cancelled": "Task {id} cancelled.",
  "cmd_auto.bg.not_found": "No task with ID {id}.",
  "cmd_auto.bg.cancel_usage": "Usage: /bg cancel <id> or /bg list",
  "cmd_auto.bg.status.running": "running",
  "cmd_auto.bg.status.done": "done",
  "cmd_auto.bg.status.failed": "failed",
  "cmd_auto.bg.status.cancelled": "cancelled",
  "cmd_auto.bg.done_prefix": "Background task {id} result:\n\n",
  "cmd_auto.bg.failed_note": "Background task {id} failed: {error}",
  "cmd_auto.bg.help": "Usage: /bg <prompt> | /bg list | /bg cancel <id>",

  "cmd_auto.btw.thread_kept": "Answered in a separate thread (ID: {id}) which is kept; the main thread is untouched.",

  "cmd_auto.queue.added": "Queued (item {n}).",
  "cmd_auto.queue.full": "Queue is full (max {max} items).",
  "cmd_auto.queue.empty": "Queue is empty.",
  "cmd_auto.queue.item": "{n}. {text}",
  "cmd_auto.queue.cleared": "Queue cleared ({n} items removed).",
  "cmd_auto.queue.clear_confirm":
    "⚠️ {n} queued items will be removed:\n{preview}\nThis cannot be undone.\n\nIf you're sure: /queue clear --confirm",
  "cmd_auto.queue.clear_more": "…and {n} more",
  "cmd_auto.queue.note":
    "Note: auto-drain isn't wired yet; for now copy the items manually.",
  "cmd_auto.queue.help": "Usage: /queue <text> | /queue list | /queue clear [--confirm]",

  "cmd_auto.steer.pending": "Guidance saved; it will apply to your next message.",
  "cmd_auto.steer.applied": "Running immediately with your guidance…",
  "cmd_auto.steer.note":
    "Note: auto-injection into the next message isn't wired yet.",
  "cmd_auto.steer.help": "Usage: /steer <guidance>",

  "cmd_auto.agents.title": "Active agents:",
  "cmd_auto.agents.none": "Nothing is active.",
  "cmd_auto.agents.bg_item": "• background task {id}: {status}",
  "cmd_auto.agents.running": "• a turn is running in this chat.",
  "cmd_auto.agents.delegate": "• the delegate tool is available.",
  "cmd_auto.agents.steer_item": "• pending steer: {text}",

  "cmd_auto.goal.set": "Goal saved: {title} (ID: {id})",
  "cmd_auto.goal.show_empty": "No goals saved.",
  "cmd_auto.goal.item": "#{id} [{status}] {title}",
  "cmd_auto.goal.cleared": "{n} active goals completed.",
  "cmd_auto.goal.clear_confirm":
    "⚠️ These {n} goals will be marked completed and leave the active list:\n{preview}\n\nIf you're sure: /goal clear --confirm",
  "cmd_auto.goal.clear_more": "…and {n} more goals",
  "cmd_auto.goal.help": "Usage: /goal set <text> | /goal show | /goal clear [--confirm]",

  "cmd_auto.subgoal.added": "Subgoal saved: {title} (ID: {id})",
  "cmd_auto.subgoal.parent_missing": "No parent goal with ID {id}.",
  "cmd_auto.subgoal.list_empty": "No subgoals found.",
  "cmd_auto.subgoal.item": "#{id} [{status}] {title}",
  "cmd_auto.subgoal.cleared": "{n} subgoals completed.",
  "cmd_auto.subgoal.clear_confirm":
    "⚠️ {n} subgoals will be marked completed ({scope}):\n{preview}\n\nIf you're sure: {cmd}",
  "cmd_auto.subgoal.clear_more": "…and {n} more subgoals",
  "cmd_auto.subgoal.clear_scope_parent": "goal “{title}”",
  "cmd_auto.subgoal.clear_scope_all": "ALL goals — careful!",
  "cmd_auto.subgoal.help": "Usage: /subgoal add <parent-id> <text> | /subgoal list [parent-id] | /subgoal clear <parent-id> [--confirm]",

  "cmd_auto.hb.status_on": "Heartbeat is enabled; interval: {interval}.",
  "cmd_auto.hb.status_off": "Heartbeat is disabled.",
  "cmd_auto.hb.status_unknown": "Heartbeat service status is not visible from here.",
  "cmd_auto.hb.tasks": "Scheduled heartbeat reminders: {n}.",
  "cmd_auto.hb.created": "Periodic reminder created (task {id}, every {interval}).",
  "cmd_auto.hb.bad_interval": "Invalid interval; e.g. 30m, 2h, 1d",
  "cmd_auto.hb.help": "Usage: /heartbeat status | /heartbeat every <interval> <text>",

  "cmd_auto.loop.created": "Loop created (task {id}, every {interval}).",
  "cmd_auto.loop.stopped": "Loop {id} stopped.",
  "cmd_auto.loop.not_found": "No task with ID {id}.",
  "cmd_auto.loop.bad_id": "Invalid ID.",
  "cmd_auto.loop.help": "Usage: /loop every <interval> <text> | /loop stop <id>",

  "cmd_auto.cron.list_empty": "No scheduled tasks.",
  "cmd_auto.cron.item": "#{id} — {name} ({cron}, {tz})",
  "cmd_auto.cron.added": "Task created (ID: {id}, next run: {next}).",
  "cmd_auto.cron.help": "Usage: /cron list | /cron add <cron-expr> <text>",

  "cmd_auto.sug.title": "Automation suggestions (heuristic):",
  "cmd_auto.sug.none": "No clear signal in recent messages.",
  "cmd_auto.sug.item": "• {text} ← {cmd}",

  "cmd_auto.bp.list_title": "Available blueprints:",
  "cmd_auto.bp.item": "• {name}: {desc}",
  "cmd_auto.bp.unknown": "Unknown blueprint “{name}”. Blueprints: {names}",
  "cmd_auto.bp.created_task": "Blueprint “{name}” created (task {id}).",
  "cmd_auto.bp.created_reminder": "Reminder set; I’ll remind you in {minutes} minutes.",
  "cmd_auto.bp.owner_only_tool": "This blueprint needs the scheduler tool, which only the owner can create.",
  "cmd_auto.bp.bad_args": "Invalid blueprint arguments. Hint: {hint}",
  "cmd_auto.bp.help": "Usage: /blueprint list | /blueprint run <name> [args]",

  "cmd_auto.refine.working": "Reviewing the conversation and extracting lessons…",
  "cmd_auto.refine.no_history": "No history found to review.",

  "cmd_auto.review.failed": "Review failed: {error}",

  "cmd_auto.moa.models": "\n\nConsulted models: {models}",

  "cmd_auto.mem.empty": "No memories stored.",
  "cmd_auto.mem.item": "• {key}: {content}",
  "cmd_auto.mem.deleted": "Memory “{key}” deleted.",
  "cmd_auto.mem.not_found": "No memory with key “{key}”.",
  "cmd_auto.mem.help": "Usage: /memory list [n] | /memory search <query> | /memory del <key>",

  "cmd_auto.learn.bad_name": "Invalid skill name; lowercase English letters, digits and dashes only (e.g. my-skill).",
  "cmd_auto.learn.ready": "Skill draft “{name}” is ready; place the file in the skills folder.",
  "cmd_auto.learn.place_note": "Note: writing directly to the skills folder is not done from here; save the attached file.",
  "cmd_auto.learn.help": "Usage: /learn <name> | <description>",

  "cmd_auto.bundles.title": "Suggested skill bundles:",
  "cmd_auto.bundles.item": "• {name}: {tools}\n  {desc}",
  "cmd_auto.bundles.unknown": "Unknown bundle “{name}”. Bundles: {names}",
  "cmd_auto.bundles.used": "Bundle “{name}” saved as your active toolkit. (Advisory for now; the engine doesn't honor it yet.)",
  "cmd_auto.bundles.no_prefs": "Preference storage is unavailable.",
  "cmd_auto.bundles.help": "Usage: /bundles list | /bundles use <name>",
};

/**
 * Translate a `cmd_auto.*` key, substituting `{vars}`.
 * Falls back to the key itself — never throws. The `lang` argument is
 * accepted for signature compatibility and ignored: the UI is English-only.
 */
export function tr(
  _lang: "en" | "fa", // accepted for compatibility; always renders English
  key: string,
  vars?: Vars,
): string {
  let s = STRINGS[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
