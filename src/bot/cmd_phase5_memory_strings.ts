/**
 * String table for the phase-5 memory commands (`cmd_phase5_memory.ts`).
 *
 * Local module (not wired into `src/i18n/`) so the feature package stays
 * file-owned, same convention as `cmd_phase3_skills_strings.ts`. Key prefix:
 * `ph5_mem.*`. English-only (owner direction, Oct 2026).
 */

export type Ph5MemLang = "en";

const STRINGS: Record<string, string> = {
  "ph5_mem.owner_only": "⛔ This command is for the bot owner only.",
  "ph5_mem.unavailable": "❌ Memory management is unavailable (memory/settings not configured).",
  "ph5_mem.usage": "🧠 Usage:\n/memory auto on — enable automatic event extraction from chat\n/memory auto off — disable it\n/memory auto status — status + event proposals awaiting review\n/memory auto scan — one-shot scan of recent conversations\n/memory export — export a portable memory package (`.bobimem`)\n/memory import [--review] — import a package; reply to the message holding the file, or send the file with this caption\n\nAuto-extraction runs only in the background sweep and never stores anything without your approval in /curator.",

  // ---------- auto ----------
  "ph5_mem.auto.on": "✅ Automatic event extraction enabled.\nFrom now on the background sweep finds dated statements in your conversations (birthdays, anniversaries, monthly commitments…) and files them as proposals — nothing is stored without your approval in /curator.",
  "ph5_mem.auto.off": "⏸ Automatic event extraction disabled. Earlier proposals stay in /curator for you to decide.",
  "ph5_mem.auto.status": "🔍 Automatic event extraction: {state}\n📌 “event” proposals awaiting review: {pending}\nReview and approve: /curator",
  "ph5_mem.auto.state_on": "enabled ✅",
  "ph5_mem.auto.state_off": "disabled ⏸",
  "ph5_mem.auto.scan_done": "🔍 Scan done: {messages} messages across {convs} conversations checked.\n🎯 {candidates} events found, {proposals} new proposals filed.\nReview: /curator",
  "ph5_mem.auto.scan_disabled": "⏸ Auto-extraction is disabled; send “/memory auto on” first.",

  // ---------- export ----------
  "ph5_mem.export.failed": "❌ Memory package export failed.",
  "ph5_mem.export.too_large": "❌ Memory ({count} entries) exceeds the export cap.",
  "ph5_mem.export.done": "📦 Memory package: {memories} memories and {events} events. Keep it as confidential as the database.",

  // ---------- import ----------
  "ph5_mem.import.no_source": "❌ No file given. Reply “/memory import” to the message holding the `.bobimem` file, or send the file with this caption.",
  "ph5_mem.import.download_failed": "❌ File download failed.",
  "ph5_mem.import.too_large": "❌ Package size ({bytes}) exceeds the {max} cap.",
  "ph5_mem.import.not_json": "❌ Invalid file: not JSON.",
  "ph5_mem.import.bad_envelope": "❌ Invalid file: {reason}.",
  "ph5_mem.import.checksum_mismatch": "❌ Package checksum mismatch; the file was tampered with or is incomplete.",
  "ph5_mem.import.bad_entry": "❌ Entry #{index} is invalid: {reason}. The whole package was rejected.",
  "ph5_mem.import.done": "📥 Import done: {memories} memories and {events} events added, {skipped} duplicates skipped{review}.",
  "ph5_mem.import.review_suffix": " — {proposals} items filed for review in /curator",
};

/**
 * Translate a `ph5_mem.*` key. The `lang` argument is accepted for signature
 * compatibility and ignored: the UI is English-only.
 */
export function tr(
  _lang: "en" | "fa", // accepted for compatibility; always renders English
  key: string,
  vars?: Record<string, string | number>,
): string {
  const template = STRINGS[key] ?? key;
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : m,
  );
}
