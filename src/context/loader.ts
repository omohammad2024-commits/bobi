/**
 * Owner-authored markdown context files (D3).
 *
 * Like skills (A3), these are trusted-tier prompt augmentation: markdown the
 * server owner writes — project conventions, persona notes — that is pasted
 * into the system prompt under a clear header. The canonical pair is
 * ./AGENTS.md and ./SOUL.md, mirroring what Hermes loads from the cwd.
 *
 * SECURITY:
 * - Context files are an owner-controlled config surface, exactly like skill
 *   files. Only the server owner should have write access to them; anyone who
 *   can edit them can steer the agent's behaviour on every turn.
 * - Never put secrets in these files: their content enters the prompt on
 *   every turn, and prompt text is the most-leaked surface a bot has.
 * - Char caps (per-file and total) bound how much prompt space an edited file
 *   can consume — a context-bomb via a huge file is rejected, not injected.
 *
 * Snapshot semantics: the caller (the conversation engine) takes ONE snapshot
 * per turn at prompt-build time via ContextFileCache.snapshot(). A file edited
 * mid-turn does not alter the in-flight prompt — the turn keeps the text it
 * started with, and the new content applies from the next turn on.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Env var listing context files, comma-separated. Read directly (not via config). */
import { processEnv } from "../config/env";
export const CONTEXT_FILES_ENV = "BOBI_CONTEXT_FILES";

/** Default pair, mirroring Hermes' cwd context files. */
export const DEFAULT_CONTEXT_FILES = "./AGENTS.md,./SOUL.md";

/** A single file is never injected beyond this many bytes. */
export const CONTEXT_MAX_FILE_BYTES = 16 * 1024;

/** The whole block is never injected beyond this many characters. */
export const CONTEXT_MAX_TOTAL_CHARS = 8000;

export interface ContextFileWarnings {
  /** Called for every skipped/truncated file; defaults to a console.warn. */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/** One successfully loaded file. */
export interface LoadedContextFile {
  /** The path as listed (not resolved), for stable prompt delimiters. */
  path: string;
  /** Raw markdown content, already capped. */
  content: string;
}

function defaultWarn(message: string, fields?: Record<string, unknown>): void {
  console.warn(`[context] ${message}`, fields !== undefined ? fields : "");
}

/**
 * Resolve the configured file list.
 *
 * `BOBI_CONTEXT_FILES` is read from the environment directly — it is process
 * configuration, not user configuration, so it intentionally bypasses
 * config.ts (which must stay untouched by this phase). An unset or blank
 * value falls back to ./AGENTS.md,./SOUL.md. Blank entries are dropped.
 *
 * `env` is injectable so tests do not mutate the process environment.
 */
export function contextFilePaths(env: NodeJS.ProcessEnv = processEnv()): string[] {
  const raw = env[CONTEXT_FILES_ENV];
  const list =
    raw === undefined || raw.trim().length === 0 ? DEFAULT_CONTEXT_FILES : raw;
  return list
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Load every listed file, synchronously.
 *
 * Rules: a missing or unreadable file is skipped SILENTLY (a fresh checkout
 * simply has no context files yet — that is not an error); a file over
 * CONTEXT_MAX_FILE_BYTES is skipped with a warning; injection stops at
 * CONTEXT_MAX_TOTAL_CHARS — the file crossing the cap is truncated at the
 * boundary with a warning, and later files are skipped. Order follows the
 * configured list, so the owner controls priority by ordering.
 */
export function loadContextFiles(
  paths: readonly string[],
  opts: ContextFileWarnings = {},
): LoadedContextFile[] {
  const warn = opts.warn ?? defaultWarn;
  const out: LoadedContextFile[] = [];
  let totalChars = 0;

  for (const path of paths) {
    const abs = resolve(path);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      // Missing/unreadable: silent skip. Context files are optional.
      continue;
    }
    if (size > CONTEXT_MAX_FILE_BYTES) {
      warn("context file too large, skipping", {
        file: path,
        bytes: size,
        maxBytes: CONTEXT_MAX_FILE_BYTES,
      });
      continue;
    }
    if (totalChars >= CONTEXT_MAX_TOTAL_CHARS) {
      warn("context total cap reached, skipping remaining files", {
        maxChars: CONTEXT_MAX_TOTAL_CHARS,
      });
      break;
    }
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      // Vanished between stat and read: silent skip, same as missing.
      continue;
    }
    const room = CONTEXT_MAX_TOTAL_CHARS - totalChars;
    let content = text;
    if (text.length > room) {
      content = text.slice(0, room);
      warn("context file truncated to total cap", {
        file: path,
        keptChars: content.length,
        maxChars: CONTEXT_MAX_TOTAL_CHARS,
      });
    }
    totalChars += content.length;
    out.push({ path, content });
  }

  return out;
}

/**
 * Format loaded files as one prompt block.
 *
 * Each file gets a markdown section headed by its basename, so the model can
 * tell where one file ends and the next begins. prompt.ts adds the outer
 * Persian header ("زمینه‌ی پروژه") around this block.
 */
export function formatContextFiles(files: readonly LoadedContextFile[]): string {
  return files
    .map((f) => `### ${basename(f.path)}\n${f.content.trim()}`)
    .join("\n\n");
}

interface FileState {
  path: string;
  /** mtimeMs, or -1 when the file is missing/unreadable. */
  mtimeMs: number;
}

function snapshotState(paths: readonly string[]): FileState[] {
  return paths.map((path) => {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(resolve(path)).mtimeMs;
    } catch {
      // Missing: -1, so a file appearing later counts as a change.
    }
    return { path, mtimeMs };
  });
}

function sameState(a: readonly FileState[], b: readonly FileState[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s.path === b[i]?.path && s.mtimeMs === b[i]?.mtimeMs);
}

/**
 * mtime-based context-file cache (the SkillCache pattern).
 *
 * Re-reading the files on every prompt build would do filesystem I/O per user
 * message; this cache returns the previous list while no file's mtime (or
 * missing-state) changed. An edited file takes effect on the next turn — no
 * restart, no watcher, no background thread.
 *
 * `snapshot()` is the per-turn entry point: it returns the formatted block to
 * paste into the prompt, or undefined when no files loaded. The caller passes
 * that string into PromptContext.contextFiles ONCE per turn, which is what
 * gives the snapshot semantics — later edits cannot reach the in-flight turn.
 */
export class ContextFileCache {
  private readonly paths: readonly string[];
  private readonly warn: ContextFileWarnings["warn"];
  private lastState: readonly FileState[] | undefined;
  private lastFiles: LoadedContextFile[] = [];

  constructor(paths?: readonly string[], opts: ContextFileWarnings = {}) {
    this.paths = paths ?? contextFilePaths();
    this.warn = opts.warn;
  }

  /** The configured paths (as given), for logging and tests. */
  get filePaths(): readonly string[] {
    return this.paths;
  }

  /** Return cached files, reloading when any file's mtime changed. */
  files(): LoadedContextFile[] {
    const state = snapshotState(this.paths);
    if (this.lastState === undefined || !sameState(state, this.lastState)) {
      this.lastState = state;
      this.lastFiles = loadContextFiles(
        this.paths,
        this.warn !== undefined ? { warn: this.warn } : {},
      );
    }
    return this.lastFiles;
  }

  /**
   * The formatted block for one prompt build, or undefined when empty.
   *
   * Call once per turn and pass the result into the prompt context; do not
   * call again mid-turn, or the snapshot guarantee is void.
   */
  snapshot(): string | undefined {
    const files = this.files();
    if (files.length === 0) return undefined;
    return formatContextFiles(files);
  }
}
