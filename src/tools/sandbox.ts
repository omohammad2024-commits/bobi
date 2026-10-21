/**
 * sandbox — the shared path-guard discipline for tools that operate on the
 * owner's files area (files, telegram_actions, voice_tools,
 * extract_document).
 *
 * The model only ever names RELATIVE paths inside one root directory;
 * nothing outside it is reachable:
 * - Absolute paths are refused outright.
 * - Every path is resolved against the root and must stay inside it
 *   lexically (`..` escapes are refused before any I/O).
 * - Symlinks are refused as an escape route too: the deepest existing
 *   ancestor of the target (the target itself when it exists) is
 *   realpath'd and must still be inside the root's real path. The root
 *   itself is realpath'd after its lazy creation, so a root reached
 *   through a symlink compares correctly.
 * - Escape attempts are ToolError("not_allowed", "That path is outside
 *   the files area.") — the message never echoes the resolved path.
 */
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { ToolError } from "./errors";

/** Create the root lazily and return its real (symlink-free) path. */
export async function ensureSandboxRoot(rootDir: string): Promise<string> {
  const abs = resolve(rootDir);
  await mkdir(abs, { recursive: true }).catch(() => {
    throw new ToolError("internal", "The files area couldn't be prepared.");
  });
  return realpath(abs).catch(() => {
    throw new ToolError("internal", "The files area couldn't be prepared.");
  });
}

export function insideSandboxRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

export function outsideSandboxError(): ToolError {
  return new ToolError("not_allowed", "That path is outside the files area.");
}

export interface ResolveSandboxPathOptions {
  /** When true, a missing target is a not_found ToolError. Default false. */
  mustExist?: boolean;
  /** Message for the not_found error when `mustExist` fails. */
  notFoundMessage?: string;
  /** When true, an empty `rel` is refused as invalid_input. Default false. */
  requireNonEmpty?: boolean;
}

/**
 * Resolve `rel` against the root and prove the result stays inside it —
 * lexically first (absolute paths and `..` escapes die here, before any
 * I/O), then through symlinks (see assertNoSandboxEscape).
 *
 * Check order is part of the contract: NUL byte first, then the empty
 * check (only when `requireNonEmpty`), then absolute, then the lexical
 * inside check, then existence (only when `mustExist`), then the symlink
 * walk.
 */
export async function resolveSandboxPath(
  root: string,
  rel: string,
  opts: ResolveSandboxPathOptions = {},
): Promise<string> {
  if (rel.includes("\0")) {
    throw new ToolError("invalid_input", "That path isn't valid.");
  }
  if (opts.requireNonEmpty === true && rel.length === 0) {
    throw new ToolError("invalid_input", "A file path is required.");
  }
  if (isAbsolute(rel)) throw outsideSandboxError();
  const candidate = resolve(root, rel);
  if (!insideSandboxRoot(root, candidate)) throw outsideSandboxError();
  if (opts.mustExist === true) {
    const exists = await lstat(candidate).then(
      () => true,
      () => false,
    );
    if (!exists) {
      throw new ToolError("not_found", opts.notFoundMessage ?? "That path doesn't exist.");
    }
  }
  await assertNoSandboxEscape(root, candidate);
  return candidate;
}

/**
 * Refuse a candidate whose existing portion resolves outside the root.
 *
 * Walks from the candidate up to the deepest existing ancestor (the
 * candidate itself when present — realpath resolves a symlinked FILE as
 * well as a symlinked directory) and requires its real path to stay
 * inside the root. Missing tails are fine: they can only be created
 * under the verified ancestor.
 */
export async function assertNoSandboxEscape(root: string, candidate: string): Promise<void> {
  let cur = candidate;
  for (;;) {
    try {
      const real = await realpath(cur);
      if (!insideSandboxRoot(root, real)) throw outsideSandboxError();
      return;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const parent = dirname(cur);
      if (parent === cur || !insideSandboxRoot(root, parent)) throw outsideSandboxError();
      cur = parent;
    }
  }
}
