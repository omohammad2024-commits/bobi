import type { Lang } from "../i18n";

/**
 * Phase: Hermes command parity — session commands.
 *
 * All user-facing strings for `cmd_session.ts`, English-only (owner
 * direction, Oct 2026: the bot's chrome is English-only).
 * The coordinator folds these keys into `src/i18n/en.ts`
 * later (never touch those files from here); until then this module is the
 * single source of truth. Every key uses the `cmd_session.*` prefix so the
 * fold-in cannot collide with the built-in keys.
 *
 * Template vars are `{name}` placeholders, substituted by `tr()`.
 */

type Vars = Record<string, string | number>;



const STRINGS: Record<string, string> = {
  "cmd_session.storage_error": "Failed to read or store data. Please try again.",
  "cmd_session.prefs_unavailable": "Preference service is unavailable.",
  "cmd_session.prefs_save_failed": "Failed to save the preference.",

  "cmd_session.role_user": "You",
  "cmd_session.role_assistant": "BOBI",
  "cmd_session.role_system": "System",

  "cmd_session.history_empty": "No messages in this conversation yet.",
  "cmd_session.history_title": "📜 Conversation history (last {n} messages):",
  "cmd_session.history_more": "…and {n} older messages",
  "cmd_session.history_bad_arg": "Message count must be a number between 1 and 30. Example: /history 20",

  "cmd_session.save_empty": "No messages in this conversation yet; no file created.",
  "cmd_session.save_bad_arg": "Invalid format. Only `/save` (Markdown) or `/save json` is supported.",
  "cmd_session.save_caption": "BOBI conversation — {date}",
  "cmd_session.save_too_large": "Conversation is too large (over 5000 messages); this operation is not supported on it.",

  "cmd_session.retry_none": "No user message found in history; nothing to retry.",
  "cmd_session.retry_failed": "Retry failed. Please try again.",

  "cmd_session.undo_usage": "Specify how many turns to drop (1–5). Example: /undo 2",
  "cmd_session.undo_bad_arg": "Count must be a number between 1 and 5. Example: /undo 2",
  "cmd_session.undo_nothing": "No messages to drop.",
  "cmd_session.undo_done": "✅ Dropped the last {n} turn(s); you can resend.\nDropped:\n{preview}",

  "cmd_session.title_current": "🏷 Current title of this conversation: {title}",
  "cmd_session.title_none": "No title set for this conversation yet. Set one with `/title <text>`.",
  "cmd_session.title_too_long": "Title can be at most 120 characters.",
  "cmd_session.title_set": "✅ Conversation title set: {title}",

  "cmd_session.branch_usage": "Specify a branch name. Example: /branch ideas",
  "cmd_session.branch_bad_name": "Invalid branch name; letters, digits, dash and underscore only, max 40 characters.",
  "cmd_session.branch_empty": "This conversation has no messages yet; nothing to branch.",
  "cmd_session.branch_done": "🌿 Branch created: `{id}`\n{n} messages copied. See it with /sessions.\n(The rolling summary was not copied — rebuild it in the new branch with /compress if needed.)",

  "cmd_session.resume_usage": "Specify a session name or id. List sessions with /sessions",
  "cmd_session.resume_not_found": "No session with that name or id. See /sessions.",
  "cmd_session.resume_title": "📂 Session “{name}” — last {n} messages:",
  "cmd_session.resume_empty": "(This session has no messages.)",
  "cmd_session.resume_active":
    "✅ “{name}” is now the active session; your next messages continue there.",

  "cmd_session.sessions_empty": "No other sessions recorded.",
  "cmd_session.sessions_title": "💬 Your sessions:",
  "cmd_session.sessions_item": "• {title} — {n} messages — {date}{current}",
  "cmd_session.sessions_current_mark": " (current)",
  "cmd_session.sessions_more": "…and {n} more sessions",

  "cmd_session.status_title": "📊 Session status",
  "cmd_session.status_session": "Session: {id}",
  "cmd_session.status_title_line": "Title: {title}",
  "cmd_session.status_title_none": "—",
  "cmd_session.status_model": "Model: {model}",
  "cmd_session.status_model_unknown": "unknown",
  "cmd_session.status_messages": "Stored messages: {n}",
  "cmd_session.status_running_yes": "Running: yes",
  "cmd_session.status_running_no": "Running: no",
  "cmd_session.status_tokens": "Tokens today: {in} in / {out} out",
  "cmd_session.status_requests": "Requests today: {n}",

  "cmd_session.context_title": "🧠 Context window status",
  "cmd_session.context_messages": "Messages: {n}",
  "cmd_session.context_tokens": "Token estimate (rough): ~{n}",
  "cmd_session.context_window": "Engine window: last {n} messages",
  "cmd_session.context_summary_yes": "Summarisation: active — up to message #{id}",
  "cmd_session.context_summary_no": "Summarisation: no summary built yet",
  "cmd_session.context_note": "Token estimate = character count ÷ 4; rough.",

  "cmd_session.busy_current": "⏳ Busy behavior: {mode}",
  "cmd_session.busy_mode_queue": "queue (new message waits behind the current reply)",
  "cmd_session.busy_mode_interrupt": "interrupt the current reply and answer the new message",
  "cmd_session.busy_mode_ignore": "ignore the new message until the current reply finishes",
  "cmd_session.busy_set": "✅ Busy behavior set: {mode}",
  "cmd_session.busy_bad_arg": "Invalid option. One of: queue, interrupt, ignore — e.g. /busy queue",
  "cmd_session.busy_note": "(This preference is declared only; the engine does not honor it yet.)",

  "cmd_session.whoami_owner": "👑 You are the bot owner.",
  "cmd_session.whoami_user": "👤 You are an approved user.",
  "cmd_session.whoami_groups_user": "Commands: {commands}",
  "cmd_session.whoami_groups_owner": "Owner commands: {commands}",

  "cmd_session.footer_current_on": "📝 Technical reply footer: on",
  "cmd_session.footer_current_off": "📝 Technical reply footer: off",
  "cmd_session.footer_set_on": "✅ Technical reply footer enabled.",
  "cmd_session.footer_set_off": "✅ Technical reply footer disabled.",
  "cmd_session.footer_bad_arg": "Invalid option. `/footer on` or `/footer off`",
  "cmd_session.footer_note": "(This preference is declared only; the reply formatter does not honor it yet.)",

  "cmd_session.version": "🤖 BOBI version {version}",

  "cmd_session.new_confirm":
    "⚠️ A fresh session wipes {n} messages{summary} — no way back.\n\nIf you're sure: /new --confirm",
  "cmd_session.new_confirm_summary": " and the rolling summary",
  "cmd_session.new_done": "🆕 Fresh session started; this conversation's history was cleared.",
};

/**
 * Look up a `cmd_session.*` key and substitute `{vars}`.
 * Unknown keys fall back to the key itself — never throws, so a missing
 * key can never break a handler. The `lang` argument is accepted for
 * signature compatibility and ignored: the UI is English-only.
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
