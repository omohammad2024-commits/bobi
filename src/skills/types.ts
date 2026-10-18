/**
 * Skill registry types.
 *
 * A skill is an owner-authored markdown file that teaches the agent a
 * repeatable behaviour (a playbook, a voice, a checklist). Skills are prompt
 * augmentation only: they NEVER grant permissions and NEVER execute code.
 *
 * SECURITY MODEL
 * - The skills directory is an owner-controlled configuration surface, exactly
 *   like .env. Only the server owner must have write access; a skill body is
 *   treated as instructions from the owner (the trusted tier).
 * - Skill bodies must never contain secrets. They are injected into the system
 *   prompt, and prompt content can end up in logs, so treat them like any
 *   other prompt content.
 * - Injected skill content is bounded (see the *_MAX_* constants below) so a
 *   single skill cannot blow the context budget.
 */
export interface Skill {
  /** kebab-case file slug, e.g. "memory-coach". */
  name: string;
  /** One-line summary shown to the model when matching and listing. */
  description: string;
  /** Optional lowercase keywords that boost matching. */
  triggers: readonly string[];
  /** Markdown body injected into the system prompt on a match. */
  body: string;
  /** Absolute path of the file the skill was loaded from. */
  source: string;
}

/** Largest single skill file the loader will read, bytes. Oversize files are skipped. */
export const SKILLS_MAX_FILE_BYTES = 64 * 1024;

/** Maximum number of skills loaded from one directory; extras are skipped. */
export const SKILLS_MAX_SKILLS = 100;

/** Maximum skills injected into one system prompt. */
export const SKILLS_MAX_INJECTED = 3;

/** Hard ceiling on injected skill characters per prompt, across all matches. */
export const SKILLS_MAX_INJECT_CHARS = 6000;

/** Default directory (relative to the process working directory). */
export const DEFAULT_SKILLS_DIR = "./skills";
