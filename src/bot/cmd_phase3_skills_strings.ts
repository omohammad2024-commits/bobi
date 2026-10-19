/**
 * String table for the phase-3 installable-skills commands
 * (`cmd_phase3_skills.ts`).
 *
 * Local module (not wired into `src/i18n/`) so the feature package stays
 * file-owned, same convention as `cmd_system_strings.ts`. Key prefix:
 * `ph3_skills.*`. English-only (owner direction, Oct 2026).
 */

export type Ph3SkillsLang = "en";

const STRINGS: Record<string, string> = {
  "ph3_skills.owner_only": "⛔ This command is for the bot owner only.",
  "ph3_skills.unavailable": "❌ Skill management is unavailable (skill store not configured).",
  "ph3_skills.usage": "📦 Usage:\n/skill install <url> — install a skill from a URL\n/skill export <name> [--sign|--no-sign] — export a portable skill package (`.bobiskill`); signed when a key exists\n/skill import — import a package (file/URL/reply)\n/skill show <name> — show one skill\n/skill list — list skills with signature status\n/skill enable <name> / /skill disable <name> — enable/disable\n/skill uninstall <name> — remove (with confirmation)\n/skill keygen [--force] — generate the package signing keypair\n/skill keyexport — retrieve the private key (backup)\n/skill trust <key-id|public-key> [label] — trust a publisher\n/skill untrust <key-id> — revoke trust\n/skill trusted — list trusted publishers\n\nOr send a skill `.md` file with the caption “/skill install”, or reply “/skill install” to a message holding the file.\nSend a `.bobiskill` package with the caption “/skill import”, or reply to a message holding one.",

  // ---------- install ----------

  "ph3_skills.install.no_source": "❌ No URL and no file. Pass a URL: /skill install <url>, or send the `.md` file.",
  "ph3_skills.install.not_markdown": "❌ Only `.md` files can be installed.",
  "ph3_skills.install.too_large": "❌ File size ({bytes} bytes) exceeds the {max} byte cap.",
  "ph3_skills.install.fetch_failed": "❌ Fetching the URL failed: {reason}",
  "ph3_skills.install.parse_failed": "❌ This is not a valid skill file: {reason}\nA skill must start with `---` and carry `name` (kebab-case) and `description` fields.",
  "ph3_skills.install.collision": "⚠️ A skill named “{name}” is already installed.\nTo replace it: /skill install {source} --confirm",
  "ph3_skills.install.limit": "❌ The skill limit ({max}) is full ({count} installed). Remove one first.",
  "ph3_skills.review.title": "📦 Review new skill",
  "ph3_skills.review.name": "Name: {name}",
  "ph3_skills.review.description": "Description: {description}",
  "ph3_skills.review.triggers": "Triggers: {triggers}",
  "ph3_skills.review.triggers_none": "—",
  "ph3_skills.review.size": "Size: {size}",
  "ph3_skills.review.source": "Source: {source}",
  "ph3_skills.review.source_file": "uploaded file",
  "ph3_skills.review.replace_note": "⚠️ This install will replace the current “{name}” skill.",
  "ph3_skills.review.warnings_title": "⚠️ Security warnings (read before approving):",
  "ph3_skills.review.warning_item": "• {detail}\n  “{snippet}”",
  "ph3_skills.review.preview_title": "Preview (first 20 lines):",
  "ph3_skills.review.approve_hint": "Installation happens only with your explicit approval.",
  "ph3_skills.review.approve": "✅ Approve",
  "ph3_skills.review.reject": "❌ Reject",
  "ph3_skills.review.expired": "⌛ This approval request has expired; try again.",
  "ph3_skills.review.rejected": "🚫 Installation of “{name}” cancelled.",
  "ph3_skills.install.done": "✅ Skill “{name}” installed and active — no restart needed.",
  "ph3_skills.install.done_replaced": "✅ Skill “{name}” replaced and active — no restart needed.",
  "ph3_skills.install.write_failed": "❌ Writing the skill file failed: {reason}",

  // ---------- show / enable / disable / uninstall ----------

  "ph3_skills.show.not_found": "❌ No skill named “{name}” found.",
  "ph3_skills.show.status": "Status: {status}",
  "ph3_skills.show.status_enabled": "enabled ✅",
  "ph3_skills.show.status_disabled": "disabled ⏸️",
  "ph3_skills.toggle.enabled": "✅ Skill “{name}” enabled.",
  "ph3_skills.toggle.disabled": "⏸️ Skill “{name}” disabled (its file was kept).",
  "ph3_skills.toggle.missing": "❌ No skill named “{name}” found.",
  "ph3_skills.toggle.noop_enabled": "ℹ️ Skill “{name}” is already enabled.",
  "ph3_skills.toggle.noop_disabled": "ℹ️ Skill “{name}” is already disabled.",
  "ph3_skills.uninstall.confirm": "⚠️ Skill “{name}” will be deleted (its file is removed; irreversible).\n\nTo run: /skill uninstall {name} --confirm",
  "ph3_skills.uninstall.confirm_approve": "🗑️ Delete",
  "ph3_skills.uninstall.confirm_cancel": "↩️ Cancel",
  "ph3_skills.uninstall.done": "🗑️ Skill “{name}” deleted.",
  "ph3_skills.uninstall.failed": "❌ Deleting skill “{name}” failed.",
  "ph3_skills.uninstall.missing": "❌ No skill named “{name}” found.",
  "ph3_skills.uninstall.cancelled": "↩️ Deletion of “{name}” cancelled.",
};

/**
 * Translate a `ph3_skills.*` key. The `lang` argument is accepted for
 * signature compatibility and ignored: the UI is English-only.
 */
export function tr(
  _lang: "en" | "fa", // accepted for compatibility; always renders English
  key: string,
  vars?: Record<string, string | number>,
): string {
  let text = STRINGS[key] ?? key;
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** All keys, for completeness tests. */
export function stringKeys(): string[] {
  return Object.keys(STRINGS);
}
