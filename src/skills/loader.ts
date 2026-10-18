/**
 * Loading skills from the filesystem.
 *
 * A skill is one markdown file:
 *
 *   ---
 *   name: <kebab-case>
 *   description: <one line, Persian or English>
 *   triggers: [keyword1, keyword2]   # optional
 *   ---
 *   # body markdown (the skill content)
 *
 * The frontmatter parser is intentionally minimal: it reads only `name`,
 * `description`, and `triggers` from simple `key: value` lines, with `triggers`
 * additionally accepting the inline-list form `[a, b]`. There is no YAML
 * dependency to exploit or keep updated, and nothing else in the frontmatter
 * is acted upon.
 *
 * Strictness rules: a file missing `name` or `description` is SKIPPED with a
 * logged warning — the loader never throws for a bad file, because one broken
 * markdown file must not stop the bot from booting. `name` must be kebab-case
 * ([a-z0-9-]) so it is a safe, stable identifier.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Skill } from "./types";
import { SKILLS_MAX_FILE_BYTES, SKILLS_MAX_SKILLS } from "./types";

export interface SkillWarnings {
  /** Called for every skipped file; defaults to a console.warn. */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Result of parsing one file: either a skill or a reason it was skipped. */
export interface ParsedSkillFile {
  skill?: Skill;
  /** Present when the file was skipped; already logged by the loader. */
  skipped?: string;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_DELIM = "---";

function defaultWarn(message: string, fields?: Record<string, unknown>): void {
  console.warn(`[skills] ${message}`, fields !== undefined ? fields : "");
}

/**
 * Parse one skill file's text. Pure: no filesystem access.
 *
 * @param text    file contents
 * @param source  identifier used in warnings and on the returned Skill
 */
export function parseSkillFile(text: string, source: string): ParsedSkillFile {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    return { skipped: "missing frontmatter delimiter" };
  }
  const closing = lines.indexOf(FRONTMATTER_DELIM, 1);
  if (closing < 0) {
    return { skipped: "unclosed frontmatter" };
  }
  const front = parseFrontmatter(lines.slice(1, closing));
  const body = lines.slice(closing + 1).join("\n").trim();

  if (!front.name) {
    return { skipped: "missing required field: name" };
  }
  if (!NAME_PATTERN.test(front.name)) {
    return { skipped: `invalid name "${front.name}": expected kebab-case` };
  }
  if (!front.description) {
    return { skipped: "missing required field: description" };
  }
  if (body.length === 0) {
    return { skipped: "empty body" };
  }

  return {
    skill: {
      name: front.name,
      description: front.description,
      triggers: front.triggers,
      body,
      source,
    },
  };
}

interface Frontmatter {
  name?: string;
  description?: string;
  triggers: readonly string[];
}

function parseFrontmatter(lines: string[]): Frontmatter {
  const front: Frontmatter = { triggers: [] };
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip blanks and comments; a malformed line is ignored rather than
    // fatal, so a stray line cannot break the whole file.
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    let value = trimmed.slice(colon + 1).trim();
    // Strip a single pair of surrounding quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") {
      front.name = value;
    } else if (key === "description") {
      front.description = value;
    } else if (key === "triggers") {
      front.triggers = parseTriggers(value);
    }
  }
  return front;
}

function parseTriggers(value: string): readonly string[] {
  // Accept "[a, b, c]" inline-list form; a bare comma-separated string is
  // accepted too, so owners do not have to learn list syntax.
  let inner = value.trim();
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1);
  }
  return inner
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0);
}

/**
 * Load every skill from a directory, synchronously.
 *
 * Rules: hidden files and non-.md files are ignored; files over
 * SKILLS_MAX_FILE_BYTES and any skill beyond SKILLS_MAX_SKILLS are skipped
 * with a warning. The result is sorted by name so prompt construction is
 * deterministic across runs and filesystems.
 *
 * A missing directory is not an error — a fresh install simply has no
 * skills yet.
 */
export function loadSkills(dir: string, opts: SkillWarnings = {}): Skill[] {
  const warn = opts.warn ?? defaultWarn;
  const abs = resolve(dir);
  if (!existsSync(abs)) return [];
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch (err) {
    warn("cannot read skills directory", { dir: abs, error: String(err) });
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue; // hidden: skip
    if (!entry.endsWith(".md")) continue;
    const path = join(abs, entry);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      warn("cannot stat skill file, skipping", { file: entry });
      continue;
    }
    if (size > SKILLS_MAX_FILE_BYTES) {
      warn("skill file too large, skipping", {
        file: entry,
        bytes: size,
        maxBytes: SKILLS_MAX_FILE_BYTES,
      });
      continue;
    }
    if (skills.length >= SKILLS_MAX_SKILLS) {
      warn("skill limit reached, skipping remaining files", {
        max: SKILLS_MAX_SKILLS,
      });
      break;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      warn("cannot read skill file, skipping", { file: entry, error: String(err) });
      continue;
    }
    const parsed = parseSkillFile(text, path);
    if (parsed.skill !== undefined) {
      skills.push(parsed.skill);
    } else {
      warn("skipping invalid skill file", { file: entry, reason: parsed.skipped });
    }
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return skills;
}

/**
 * mtime-based skill cache.
 *
 * Re-parsing the directory on every prompt build would do filesystem I/O per
 * user message; this cache returns the previous list when the directory's
 * mtime has not changed. A new or edited skill file takes effect on the next
 * message — no restart, no file watcher, no background thread.
 *
 * Phase E2 addition: `extraSkills` merges pre-parsed skills (from plugins)
 * after the directory scan. They are static for the process lifetime — a
 * plugin skill change needs a restart, unlike a top-level skill — and on a
 * name collision the directory's own skill wins, so a plugin can never shadow
 * the owner's skills.
 */
export class SkillCache {
  private lastMtime = -1;
  private lastSkills: Skill[] = [];
  private readonly dir: string;
  private readonly extraSkills: readonly Skill[];
  private readonly warn: ((message: string, fields?: Record<string, unknown>) => void) | undefined;

  constructor(dir: string, opts: SkillWarnings & { extraSkills?: readonly Skill[] } = {}) {
    this.dir = dir;
    this.extraSkills = opts.extraSkills ?? [];
    this.warn = opts.warn;
  }

  /** The directory this cache loads from (as given to the constructor). */
  get directory(): string {
    return this.dir;
  }

  /** Return cached skills, reloading when the directory mtime changed. */
  skills(): Skill[] {
    const abs = resolve(this.dir);
    let mtime = 0;
    try {
      mtime = statSync(abs).mtimeMs;
    } catch {
      // Missing/unreadable directory: cache an empty list so we do not hit
      // the filesystem on every message while the dir is absent.
      if (this.lastMtime !== -1) {
        this.lastMtime = -1;
        this.lastSkills = [];
      }
      return this.lastSkills;
    }
    if (mtime !== this.lastMtime) {
      this.lastMtime = mtime;
      const warn = this.warn;
      this.lastSkills = loadSkills(
        abs,
        warn !== undefined ? { warn } : {},
      );
    }
    return mergeSkills(this.lastSkills, this.extraSkills);
  }
}

/**
 * Merge directory skills with plugin-supplied extras. Sorted by name for
 * deterministic prompt construction; on a name collision the directory's own
 * skill wins (a plugin can never shadow the owner's skills).
 */
function mergeSkills(base: readonly Skill[], extra: readonly Skill[]): Skill[] {
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const skill of [...base, ...extra]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
