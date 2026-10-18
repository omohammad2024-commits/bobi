/**
 * Loading lifecycle hooks from the filesystem.
 *
 * A hook is one markdown file inside `<hooksDir>/<event>/`:
 *
 *   ---
 *   name: warmup-clock
 *   action: {"type": "tool", "tool": "date_time", "input": {}}
 *   ---
 *   Optional markdown notes (never executed).
 *
 * The event a hook subscribes to comes from the SUBDIRECTORY it lives in
 * (`startup/`, `agent:start/`, `agent:end/`, `tool:end/`). Unknown event
 * directories are skipped with a warning, never fatal.
 *
 * SECURITY MODEL (read before touching this file):
 *
 *  1. NO CODE EXECUTION, EVER. A hook file contributes frontmatter data and a
 *     markdown note. Nothing in it is evaled, imported, or spawned. The only
 *     thing a hook can DO is run one registered BOBI tool through the normal
 *     Executor path — the same path the agent loop uses, with the same
 *     validation, permission checks, and timeouts.
 *  2. ONLY TOOL ACTIONS. `parseTaskAction` (from scheduled_tasks.ts) validates
 *     the action shape; "message" and "agent" actions are rejected with a
 *     logged warning. A hook has no chat target and must not gain one through
 *     a data file: sending messages is a conversational privilege that stays
 *     with the scheduler, which is owner-gated at creation time.
 *  3. SAME ACTOR, NO ESCALATION. A hook action runs as the actor of the
 *     triggering turn (see runner.ts), never as the owner — except `startup`,
 *     which the caller explicitly runs with the owner actor because there is
 *     no turn yet. Hook files live in an owner-controlled directory (same
 *     trusted tier as skills/ and .env): only the server owner may write them.
 *  4. A bad file never stops the bot: unknown events, malformed frontmatter,
 *     and invalid actions are skipped with a warning.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ToolError } from "../tools/errors";
import { parseTaskAction } from "../tools/scheduled_tasks";
import { HOOK_EVENTS, isHookEvent } from "./events";
import type { HookEvent } from "./events";

export interface HookWarnings {
  /** Called for every skipped file or directory; defaults to a console.warn. */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/** A validated hook definition: event + one tool action + where it came from. */
export interface HookDef {
  /** kebab-case identifier, unique within its event. */
  name: string;
  event: HookEvent;
  /** The only action kind hooks support: run a registered tool. */
  action: { type: "tool"; tool: string; input: Record<string, unknown> };
  /** Absolute path of the file this hook was loaded from. */
  source: string;
}

/** Result of parsing one file: either a hook or a reason it was skipped. */
export interface ParsedHookFile {
  hook?: HookDef;
  /** Present when the file was skipped; already logged by the loader. */
  skipped?: string;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_DELIM = "---";

/** Largest single hook file the loader will read, bytes. Oversize files are skipped. */
export const HOOKS_MAX_FILE_BYTES = 64 * 1024;

function defaultWarn(message: string, fields?: Record<string, unknown>): void {
  console.warn(`[hooks] ${message}`, fields !== undefined ? fields : "");
}

/**
 * Parse one hook file's text. Pure: no filesystem access.
 *
 * @param text    file contents
 * @param source  identifier used in warnings and on the returned HookDef
 * @param event   the event, taken from the file's parent directory
 */
export function parseHookFile(text: string, source: string, event: HookEvent): ParsedHookFile {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    return { skipped: "missing frontmatter delimiter" };
  }
  const closing = lines.indexOf(FRONTMATTER_DELIM, 1);
  if (closing < 0) {
    return { skipped: "unclosed frontmatter" };
  }
  const front = parseHookFrontmatter(lines.slice(1, closing));

  if (!front.name) {
    return { skipped: "missing required field: name" };
  }
  if (!NAME_PATTERN.test(front.name)) {
    return { skipped: `invalid name "${front.name}": expected kebab-case` };
  }
  if (front.action === undefined) {
    return { skipped: "missing required field: action" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(front.action);
  } catch {
    return { skipped: "action is not valid JSON (must be a single JSON object)" };
  }

  let action;
  try {
    action = parseTaskAction(raw);
  } catch (err) {
    const reason = err instanceof ToolError ? err.message : String(err);
    return { skipped: `invalid action: ${reason}` };
  }

  // Hooks have no chat target, so only tool actions are meaningful here.
  // "message"/"agent" actions belong to scheduled tasks, which are owner-gated
  // at creation time — a hook file must not become a backdoor message sender.
  if (action.type !== "tool") {
    return {
      skipped: `action type "${action.type}" is not allowed in hooks; only "tool" actions are supported`,
    };
  }

  return {
    hook: { name: front.name, event, action, source },
  };
}

interface HookFrontmatter {
  name?: string;
  /** Raw JSON text of the action value (may span several lines). */
  action?: string;
}

function parseHookFrontmatter(lines: string[]): HookFrontmatter {
  const front: HookFrontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    i++;
    // Skip blanks and comments; a malformed line is ignored rather than
    // fatal, so a stray line cannot break the whole file.
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    let value = trimmed.slice(colon + 1).trim();

    if (key === "name") {
      front.name = stripQuotes(value);
    } else if (key === "action") {
      // The action is a JSON object and may span several lines; keep
      // consuming lines until the braces balance, so owners can format the
      // JSON readably instead of cramming it onto one line.
      let depth = 0;
      let inString = false;
      let escaped = false;
      const chunks: string[] = [value];
      const scan = (s: string): void => {
        for (const ch of s) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === "\\" && inString) {
            escaped = true;
            continue;
          }
          if (ch === '"') {
            inString = !inString;
            continue;
          }
          if (inString) continue;
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
      };
      scan(value);
      while (depth > 0 && i < lines.length) {
        const next = lines[i]!;
        i++;
        chunks.push(next);
        scan(next);
      }
      front.action = chunks.join("\n").trim();
    }
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
 * Load every hook from `<hooksRoot>/<event>/` subdirectories, synchronously.
 *
 * Rules: unknown event directories are skipped with a warning; hidden files
 * and non-.md files are ignored; files over HOOKS_MAX_FILE_BYTES are skipped.
 * The result is sorted by (event, name) so execution order is deterministic
 * across runs and filesystems.
 *
 * A missing root directory is not an error — a fresh install simply has no
 * hooks yet.
 */
export function loadHooksFromDir(hooksRoot: string, opts: HookWarnings = {}): HookDef[] {
  const warn = opts.warn ?? defaultWarn;
  const abs = resolve(hooksRoot);
  if (!existsSync(abs)) return [];

  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch (err) {
    warn("cannot read hooks directory", { dir: abs, error: String(err) });
    return [];
  }

  const hooks: HookDef[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue; // hidden: skip
    const eventDir = join(abs, entry);
    let isDir = false;
    try {
      isDir = statSync(eventDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (!isHookEvent(entry)) {
      warn("skipping unknown hook event directory", { dir: entry, known: HOOK_EVENTS.join(", ") });
      continue;
    }
    hooks.push(...loadHookEventDir(eventDir, entry, opts));
  }

  hooks.sort((a, b) =>
    a.event < b.event ? -1 : a.event > b.event ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return hooks;
}

function loadHookEventDir(dir: string, event: HookEvent, opts: HookWarnings): HookDef[] {
  const warn = opts.warn ?? defaultWarn;
  const hooks: HookDef[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    warn("cannot read hook event directory", { dir, error: String(err) });
    return [];
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue; // hidden: skip
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      warn("cannot stat hook file, skipping", { file: entry, event });
      continue;
    }
    if (size > HOOKS_MAX_FILE_BYTES) {
      warn("hook file too large, skipping", {
        file: entry,
        event,
        bytes: size,
        maxBytes: HOOKS_MAX_FILE_BYTES,
      });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      warn("cannot read hook file, skipping", { file: entry, event, error: String(err) });
      continue;
    }
    const parsed = parseHookFile(text, path, event);
    if (parsed.hook !== undefined) {
      hooks.push(parsed.hook);
    } else {
      warn("skipping invalid hook file", { file: entry, event, reason: parsed.skipped });
    }
  }
  return hooks;
}

/**
 * mtime-based hook cache, mirroring SkillCache.
 *
 * Re-scanning the hooks tree on every event would do filesystem I/O per agent
 * turn; this cache returns the previous list until a directory mtime changes.
 * A new or removed hook file takes effect on the next event — no restart, no
 * file watcher, no background thread. (Like SkillCache, it keys on directory
 * mtimes, so an in-place content edit of an existing file is picked up when
 * the file is replaced or its directory entry changes, not on every save.)
 */
export class HookCache {
  private lastSignature = "";
  private lastHooks: HookDef[] = [];
  private readonly root: string;
  private readonly warn: ((message: string, fields?: Record<string, unknown>) => void) | undefined;

  constructor(root: string, opts: HookWarnings = {}) {
    this.root = root;
    this.warn = opts.warn;
  }

  /** The hooks root this cache loads from (as given to the constructor). */
  get directory(): string {
    return this.root;
  }

  /** Return cached hooks, reloading when any watched directory mtime changed. */
  hooks(): HookDef[] {
    const signature = this.signature();
    if (signature === null) {
      // Missing/unreadable root: cache an empty list so we do not hit the
      // filesystem on every event while the dir is absent.
      if (this.lastSignature !== "") {
        this.lastSignature = "";
        this.lastHooks = [];
      }
      return this.lastHooks;
    }
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      const warn = this.warn;
      this.lastHooks = loadHooksFromDir(
        this.root,
        warn !== undefined ? { warn } : {},
      );
    }
    return this.lastHooks;
  }

  /**
   * Cache key: the mtime of the root plus the mtime of every subdirectory.
   * Adding, removing, or renaming a hook file (or an event directory) changes
   * one of these; null when the root cannot be read.
   */
  private signature(): string | null {
    const abs = resolve(this.root);
    const parts: string[] = [];
    try {
      parts.push(`root:${statSync(abs).mtimeMs}`);
      for (const entry of readdirSync(abs)) {
        if (entry.startsWith(".")) continue;
        const p = join(abs, entry);
        try {
          if (statSync(p).isDirectory()) parts.push(`${entry}:${statSync(p).mtimeMs}`);
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
    return parts.join("|");
  }
}
