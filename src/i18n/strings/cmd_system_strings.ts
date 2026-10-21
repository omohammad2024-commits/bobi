import { translateFrom } from "../../i18n";

/**
 * String table for the Hermes-parity system/owner commands (`cmd_system.ts`).
 *
 * Part of the i18n system: this module lives under `src/i18n/strings/`.
 * Key prefix: `cmd_system.*`.
 *
 * User-facing strings: English-only (owner direction, Oct 2026).
 */

export type SysLang = "en";

const STRINGS: Record<string, string> = {
  "cmd_system.owner_only": "⛔ This command is for the bot owner only.",
  "cmd_system.prefs.unavailable": "❌ Preference store is unavailable.",

  // ---------- /snapshot ----------

  "cmd_system.snapshot.no_db": "❌ Database file path is unknown; cannot create a snapshot.",
  "cmd_system.snapshot.bad_name": "❌ Invalid snapshot name. Use ASCII letters, digits, dot, dash or underscore (max 64 chars).",
  "cmd_system.snapshot.created": "✅ Snapshot “{name}” created ({size}).",
  "cmd_system.snapshot.create_failed": "❌ Snapshot creation failed: {reason}",
  "cmd_system.snapshot.empty": "📦 No snapshots stored.\nCreate one with /snapshot create.",
  "cmd_system.snapshot.list_title": "📦 Stored snapshots:",
  "cmd_system.snapshot.list_item": "• {name} — {size} — {when}",
  "cmd_system.snapshot.list_failed": "❌ Could not read the snapshots directory: {reason}",
  "cmd_system.snapshot.not_found": "❌ Snapshot “{name}” not found. List them with /snapshot list.",
  "cmd_system.snapshot.turn_running": "⏳ A conversation turn is running; restoring a snapshot now could corrupt data. Retry after it finishes.",
  "cmd_system.snapshot.restore_confirm": "⚠️ Restoring “{name}” replaces the bot's current state with this snapshot. This is irreversible (unless you have another snapshot).\n\nTo run: /snapshot restore {name} --confirm",
  "cmd_system.snapshot.restored": "✅ Snapshot “{name}” restored.\n🔁 Restart the bot with /restart to apply it.",
  "cmd_system.snapshot.restore_failed": "❌ Restore failed: {reason}",
  "cmd_system.snapshot.usage": "📦 Usage:\n/snapshot create [name]\n/snapshot list\n/snapshot restore <name> --confirm",

  // ---------- /restart ----------

  "cmd_system.restart.turn_running": "⏳ A conversation turn is running. To force a restart: /restart --force --confirm",
  "cmd_system.restart.confirm": "🔁 The bot will restart (the systemd service brings it back up).\n\nTo run: /restart --confirm",
  "cmd_system.restart.done": "🔁 Restarting… I'll be back.",

  // ---------- /update ----------

  "cmd_system.update.no_repo": "❌ The working directory is not a git repository; auto-update is not possible.",
  "cmd_system.update.confirm": "⬆️ This runs `git pull --ff-only` on the bot code, then restarts.\n\nTo run: /update --confirm",
  "cmd_system.update.failed": "❌ Update failed (no restart performed):\n{tail}",
  "cmd_system.update.ok": "✅ Update done; restarting…\n{tail}",
  "cmd_system.update.error": "❌ Error running git: {reason}",

  // ---------- /debug ----------

  "cmd_system.debug.title": "🛠 Debug report",
  "cmd_system.debug.row": "• {label}: {value}",
  "cmd_system.debug.unavailable": "Tool service is not wired; the report is incomplete.",

  // ---------- /usage & /insights ----------

  "cmd_system.usage.today": "📊 Usage today",
  "cmd_system.usage.week": "📊 Usage last 7 days",
  "cmd_system.usage.tokens": "Input tokens: {input} • output: {output} • runs: {runs}",
  "cmd_system.usage.cost": "Approximate cost: ${cost}",
  "cmd_system.usage.disclaimer": "⚠️ Costs are approximate and are not the final bill.",
  "cmd_system.usage.by_model": "Top models:",
  "cmd_system.usage.model_item": "• {model}: {tokens} tokens ({runs} runs)",
  "cmd_system.insights.title": "📈 Usage insights — last {days} days",
  "cmd_system.insights.trend_up": "Trend: 📈 up ({pct}% more than the previous period)",
  "cmd_system.insights.trend_down": "Trend: 📉 down ({pct}% less than the previous period)",
  "cmd_system.insights.trend_flat": "Trend: ➖ roughly unchanged vs the previous period",
  "cmd_system.insights.day_item": "• {day}: {tokens} tokens ({runs} runs)",

  // ---------- /model ----------

  "cmd_system.model.current": "🤖 Active model: {model}\nProvider: {provider}",
  "cmd_system.model.available": "\n\nAvailable models (send the name or id with /model):",
  "cmd_system.model.item": "• {label} ({id}){mark}",
  "cmd_system.model.active_mark": " — active ✅",
  "cmd_system.model.not_found": "❌ No model named “{name}” found. List them with /model.",
  "cmd_system.model.disabled": "❌ This model or its provider is disabled; enable it from the /ai panel first.",
  "cmd_system.model.switched": "✅ The active model is now “{label}”.",

  // ---------- /reasoning ----------

  "cmd_system.reasoning.show": "🧠 Effective reasoning level: {effective}\n(Read from the {env} env var; a live change needs that var set and a restart)",
  "cmd_system.reasoning.stored": "Stored value for the owner: {value} (not applied yet — only the env var affects requests)",
  "cmd_system.reasoning.bad": "❌ Invalid value; allowed: off, low, medium or high",
  "cmd_system.reasoning.set": "✅ Reasoning level stored: {value}\n⚠️ To apply it to requests, set {env} and restart the bot.",

  // ---------- /autoprune ----------

  "cmd_system.autoprune.show_on": "🧹 Auto-prune sessions: on ✅ (threshold: {days} days)\n⚠️ Actual pruning isn't working yet.",
  "cmd_system.autoprune.show_off": "🧹 Auto-prune sessions: off",
  "cmd_system.autoprune.bad": "❌ Usage: /autoprune on [days] | /autoprune off — e.g. /autoprune on 30",
  "cmd_system.autoprune.set": "✅ Auto-prune set: {state}\n⚠️ Actual pruning isn't working yet.",

  // ---------- /tools ----------

  "cmd_system.tools.unavailable": "❌ Tool service is unavailable.",
  "cmd_system.tools.title": "🧰 Registered tools ({count}):",
  "cmd_system.tools.item": "• {name}{toolset}{state}",
  "cmd_system.tools.toolset": " [{toolset}]",
  "cmd_system.tools.disabled": " (disabled)",
  "cmd_system.tools.note": "\nℹ️ Enabling/disabling tools is not supported from this command; list-only.",

  // ---------- /skills ----------

  "cmd_system.skills.unavailable": "❌ Neither the skills tool nor the skill cache is available.",
  "cmd_system.skills.title": "🎯 Installed skills ({count}):",
  "cmd_system.skills.item": "• {name} — {description}",

  // ---------- /curator ----------

  "cmd_system.curator.unavailable": "❌ Tool service is unavailable; memory curation is not possible.",
  "cmd_system.curator.status": "🧠 Pending curator proposals: {count}",
  "cmd_system.curator.ran": "✅ Memory review ran; {count} proposals stored. Review and approve from the curator panel.",
  "cmd_system.curator.run_failed": "❌ Review run failed: {reason}",
  "cmd_system.curator.usage": "🧠 Usage:\n/curator status\n/curator run",

  // ---------- /plugins ----------

  "cmd_system.plugins.empty": "🔌 No plugins installed.",
  "cmd_system.plugins.title": "🔌 Installed plugins ({count}):",
  "cmd_system.plugins.item": "• {name} (v{version}) — {description}",

  // ---------- /reload_mcp & /reload_skills ----------

  "cmd_system.reload_mcp.unavailable": "❌ MCP manager is not wired; reload is not possible.",
  "cmd_system.reload_mcp.ok": "✅ MCP servers reconnected ({count} active).",
  "cmd_system.reload_mcp.failed": "❌ MCP reload failed: {reason}",
  "cmd_system.reload_skills.unavailable": "❌ Skill cache is not wired.",
  "cmd_system.reload_skills.ok": "✅ Skills rescanned ({count} skills).",

  // ---------- /approve & /deny ----------

  "cmd_system.access.none_pending": "✅ No pending requests.",
  "cmd_system.access.pending_title": "📥 Pending requests:",
  "cmd_system.access.user_item": "• user {id}{name} — approve: /approve user {id} --confirm | deny: /deny user {id} --confirm",
  "cmd_system.access.group_item": "• group {id}{name} — approve: /approve group {id} --confirm | deny: /deny group {id} --confirm",
  "cmd_system.access.bad_target": "❌ Invalid target. Usage: /{cmd} <user|group> <id> --confirm",
  "cmd_system.access.need_confirm_approve": "To approve {kind} “{id}”: /{cmd} {kind} {id} --confirm",
  "cmd_system.access.need_confirm_deny": "⚠️ To deny {kind} “{id}”: /{cmd} {kind} {id} --confirm",
  "cmd_system.access.approved": "✅ {kind} “{id}” approved.",
  "cmd_system.access.denied": "🚫 {kind} “{id}” denied.",
  "cmd_system.access.already": "ℹ️ “{id}” is not pending ({reason}) — nothing to change.",
  "cmd_system.access.usage": "📥 Usage:\n/approve — list requests\n/approve <user|group> <id> --confirm\n(use deny instead of approve to reject)",

  // ---------- /sethome ----------

  "cmd_system.sethome.no_prefs": "❌ Preference store is unavailable.",
  "cmd_system.sethome.ok": "✅ This chat is now the home chat for proactive notifications.",

  // ---------- /pause ----------

  "cmd_system.pause.on": "⏸ Bot paused (emergency mode). To resume: /pause off\n⚠️ This flag doesn't affect the scheduler or heartbeat yet.",
  "cmd_system.pause.off": "▶️ Bot resumed.",
  "cmd_system.pause.bad": "❌ Usage: /pause on | /pause off",

  // ---------- /ban /unban /mute /unmute ----------

  "cmd_system.restrict.usage": "❌ Provide the numeric user id. Example: /{cmd} 123456",
  "cmd_system.restrict.bad_target": "❌ Invalid user id; digits only.",
  "cmd_system.restrict.no_users": "❌ User access service is unavailable.",
  "cmd_system.restrict.self": "❌ You cannot {what} yourself.",
  "cmd_system.restrict.failed": "❌ The operation failed.",
  "cmd_system.ban.ok": "🚫 User {id} has been blocked.",
  "cmd_system.unban.ok": "✅ User {id} has been unblocked.",
  "cmd_system.mute.ok": "🔇 Messages from user {id} will now be silently ignored.",
  "cmd_system.unmute.ok": "✅ User {id} is no longer ignored.",
};

/**
 * Translate a `cmd_system.*` key, substituting `{name}` placeholders from
 * server-side values only — never from raw user text (placeholders are
 * filled from values, and user text is passed only through the bounded
 * `{name}` slots already validated upstream). The `lang` argument is
 * accepted for signature compatibility and ignored: the UI is English-only.
 */
export function tr(
  _lang: "en" | "fa", // accepted for compatibility; always renders English
  key: string,
  vars?: Record<string, string | number>,
): string {
  return translateFrom(STRINGS, key, vars);
}
