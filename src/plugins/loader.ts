/**
 * Loading plugins from the filesystem.
 *
 * A plugin is a directory `<pluginsDir>/<name>/` containing:
 *
 *   plugin.md          # frontmatter: name, version, description (+ optional enabled)
 *   skills/            # optional: skill markdown files, same format as ./skills
 *   hooks/             # optional: <event>/*.md hook files, same format as ./hooks
 *
 * A plugin COMPOSES existing primitives — skills and hooks — under one
 * directory with metadata. That is all a plugin is.
 *
 * SECURITY MODEL (read before touching this file):
 *
 *  1. NO CODE EXECUTION, EVER. A plugin contributes markdown, frontmatter
 *     data, and validated hook actions. Nothing in a plugin directory is
 *     evaled, imported, required, or spawned. BOBI deliberately does not
 *     execute code from skill/plugin files (unlike Hermes) — a plugin that
 *     needs new behaviour ships its skill as prompt guidance and its hooks as
 *     tool actions over the EXISTING registered toolset.
 *  2. Plugin hooks inherit the hook security model: only "tool" actions
 *     (validated by parseTaskAction), run as the triggering turn's actor, no
 *     escalation, capped at 5 per event.
 *  3. Plugin skills inherit the skill security model: prompt guidance only,
 *     no permissions, no code, never contain secrets.
 *  4. The plugins directory is an owner-controlled configuration surface
 *     (same trusted tier as skills/ and .env): only the server owner may
 *     write to it. A plugin never grants its author anything the owner did
 *     not already grant by installing it.
 *  5. A malformed plugin.md never stops the bot: it is skipped with a logged
 *     warning. A plugin with `enabled: false` in its frontmatter is skipped
 *     quietly (that is a deliberate owner choice, not an error).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSkills } from "../skills/loader";
import type { Skill } from "../skills/types";
import { loadHooksFromDir } from "../hooks/loader";
import type { HookDef, HookWarnings } from "../hooks/loader";

export interface PluginWarnings {
  /** Called for every skipped plugin; defaults to a console.warn. */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/** A loaded plugin: metadata plus its composed skills and hooks. */
export interface Plugin {
  /** kebab-case identifier, from plugin.md (validated against expectations). */
  name: string;
  /** Free-form version string, e.g. "1.2.0". */
  version: string;
  /** One-line summary of what the plugin provides. */
  description: string;
  /** Skills parsed from the plugin's skills/ subdirectory. */
  skills: Skill[];
  /** Hooks parsed from the plugin's hooks/ subdirectory. */
  hooks: HookDef[];
}

/** Result of parsing one plugin.md: either metadata or a skip reason. */
export interface ParsedPluginFile {
  meta?: { name: string; version: string; description: string; enabled: boolean };
  /** Present when the plugin was skipped; already logged by the loader. */
  skipped?: string;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_DELIM = "---";

function defaultWarn(message: string, fields?: Record<string, unknown>): void {
  console.warn(`[plugins] ${message}`, fields !== undefined ? fields : "");
}

/**
 * Parse one plugin.md's text. Pure: no filesystem access.
 *
 * @param text    file contents
 * @param source  identifier used in warnings
 */
export function parsePluginFile(text: string, source: string): ParsedPluginFile {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    return { skipped: "missing frontmatter delimiter" };
  }
  const closing = lines.indexOf(FRONTMATTER_DELIM, 1);
  if (closing < 0) {
    return { skipped: "unclosed frontmatter" };
  }
  const front = parsePluginFrontmatter(lines.slice(1, closing));

  if (!front.name) {
    return { skipped: "missing required field: name" };
  }
  if (!NAME_PATTERN.test(front.name)) {
    return { skipped: `invalid name "${front.name}": expected kebab-case` };
  }
  if (!front.version) {
    return { skipped: "missing required field: version" };
  }
  if (!front.description) {
    return { skipped: "missing required field: description" };
  }

  return {
    meta: {
      name: front.name,
      version: front.version,
      description: front.description,
      enabled: front.enabled,
    },
  };
}

interface PluginFrontmatter {
  name?: string;
  version?: string;
  description?: string;
  /** Defaults to true; `enabled: false` opts the plugin out quietly. */
  enabled: boolean;
}

function parsePluginFrontmatter(lines: string[]): PluginFrontmatter {
  const front: PluginFrontmatter = { enabled: true };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = stripQuotes(trimmed.slice(colon + 1).trim());
    if (key === "name") front.name = value;
    else if (key === "version") front.version = value;
    else if (key === "description") front.description = value;
    else if (key === "enabled") front.enabled = value.toLowerCase() !== "false";
  }
  return front;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Load every plugin from a directory, synchronously.
 *
 * Rules: each immediate subdirectory is a plugin candidate; a candidate
 * without a readable plugin.md is skipped with a warning; a candidate whose
 * plugin.md is malformed is skipped with a warning; `enabled: false` skips
 * quietly. The result is sorted by name for deterministic startup behaviour.
 *
 * A missing directory is not an error — a fresh install simply has no
 * plugins yet.
 */
export function loadPlugins(dir: string, opts: PluginWarnings = {}): Plugin[] {
  const warn = opts.warn ?? defaultWarn;
  const abs = resolve(dir);
  if (!existsSync(abs)) return [];

  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch (err) {
    warn("cannot read plugins directory", { dir: abs, error: String(err) });
    return [];
  }

  const plugins: Plugin[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue; // hidden: skip
    const pluginDir = join(abs, entry);
    let isDir = false;
    try {
      isDir = statSync(pluginDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const manifestPath = join(pluginDir, "plugin.md");
    let text: string;
    try {
      text = readFileSync(manifestPath, "utf8");
    } catch {
      warn("skipping plugin without plugin.md", { plugin: entry });
      continue;
    }

    const parsed = parsePluginFile(text, manifestPath);
    if (parsed.meta === undefined) {
      warn("skipping plugin with invalid plugin.md", { plugin: entry, reason: parsed.skipped });
      continue;
    }
    const meta = parsed.meta;
    if (!meta.enabled) {
      // A deliberate owner choice, not an error: stay quiet.
      continue;
    }
    if (meta.name !== entry) {
      warn("plugin name does not match its directory; using the plugin.md name", {
        dir: entry,
        name: meta.name,
      });
    }

    // Compose the plugin from the existing primitives. A plugin's skills and
    // hooks are parsed with the same loaders (and the same strictness) as the
    // top-level directories — a plugin cannot smuggle in a looser format.
    const hookWarn: HookWarnings = { warn };
    plugins.push({
      name: meta.name,
      version: meta.version,
      description: meta.description,
      skills: loadSkills(join(pluginDir, "skills"), { warn }),
      hooks: loadHooksFromDir(join(pluginDir, "hooks"), hookWarn),
    });
  }

  plugins.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return plugins;
}
