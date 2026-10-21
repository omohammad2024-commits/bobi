/**
 * files — sandboxed file management for the owner's files area.
 *
 * ONE tool, six actions (list / read / write / append / delete / send) over
 * a single root directory (the BOBI_FILES_DIR knob, default ./data/files,
 * surfaced as `filesDir` on the config object and handed to the factory as
 * `rootDir` by bootstrap). The model only ever names RELATIVE paths inside
 * that area; nothing outside it is reachable.
 *
 * Owner-only, twice over — the established pattern (see goals.ts): the
 * `ownerOnly` flag keeps the authorization bridge from granting the
 * permission key to a non-owner, and when bootstrap supplies the
 * server-side `isOwner` predicate, run() re-checks it as defence in depth
 * for callers that build actors directly. When no predicate is supplied
 * the flag + Executor permission check are the boundary, exactly as for
 * any other ownerOnly tool.
 *
 * Path safety (the heart of this tool):
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
 *
 * Caps: write/append content ≤ 256 KB; read returns text only for
 * UTF-8-decodable files ≤ 256 KB (larger or binary → send it instead);
 * list returns at most 200 entries; delete removes files only, never
 * directories; send delivers files ≤ 50 MB (Telegram's cap) via
 * extractMedia as a document ContentPart — the bytes ride alongside the
 * model-safe data, never inside it (the downloader/image pattern).
 */
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type { ContentPart } from "../ai/provider";
import { ToolError } from "./errors";
import { defineManifest } from "./manifest";
import {
  assertNoSandboxEscape,
  ensureSandboxRoot,
  resolveSandboxPath,
} from "./sandbox";
import type { ToolManifest } from "./manifest";
import type { Tool, ToolContext } from "./types";

export const FILES_PERMISSION = "tools:files";

/** Write/append content ceiling, and the read-as-text ceiling (bytes). */
export const MAX_TEXT_BYTES = 256 * 1024;
/** Send ceiling: Telegram's file limit, bytes. */
export const MAX_SEND_BYTES = 50 * 1024 * 1024;
/** List ceiling: entries returned per call. */
export const MAX_LIST_ENTRIES = 200;

export type FilesAction = "list" | "read" | "write" | "append" | "delete" | "send";

const FILES_ACTIONS: readonly FilesAction[] = [
  "list",
  "read",
  "write",
  "append",
  "delete",
  "send",
];

export interface FilesInput {
  action: FilesAction;
  /** Relative path inside the files area. Required for every action but list (default: the root). */
  path?: string;
  /** Text content for write/append. */
  content?: string;
}

export interface FilesListEntry {
  name: string;
  kind: "file" | "dir";
  sizeBytes: number;
}

export type FilesOutput =
  | {
      action: "list";
      /** The listed directory, relative to the files area ("." = the root). */
      path: string;
      entries: FilesListEntry[];
      count: number;
      /** True when the directory held more than the returned cap. */
      truncated?: boolean;
    }
  | { action: "read"; path: string; content: string; sizeBytes: number }
  | { action: "write" | "append"; path: string; sizeBytes: number }
  | { action: "delete"; path: string; deleted: true }
  | {
      action: "send";
      /** The file itself is delivered to the user as an attachment (see extractMedia). */
      sent: true;
      name: string;
      sizeBytes: number;
    };

export interface FilesToolDeps {
  /** Root of the sandbox. Created lazily on first use. */
  rootDir: string;
  /**
   * Server-supplied owner predicate (the goals.ts pattern). When present,
   * run() re-checks ownership as defence in depth; when absent, the
   * ownerOnly flag + Executor permission check are the boundary.
   */
  isOwner?: (userId: string) => boolean;
}

/** Plugin discovery manifest for `files`. */
export const filesManifest: ToolManifest = defineManifest({
  id: "files",
  version: "1.0.0",
  title: "Files",
  description:
    "List, read, write, append, delete and send files inside the owner's sandboxed files area. Paths are relative and cannot escape the area. Owner only.",
  purpose: "owner files in sandbox",
  useWhen: "file already saved",
  doNotUseWhen:
    "Fetching a file from a link — download_media gets files from URLs; this only manages files already saved.",
  confusableWith: [
    {
      tool: "download_media",
      difference:
        "download_media fetches from a link; this manages files already in the files area",
    },
  ],
  latencyTier: "instant",
  outputSummary:
    "Per action: a listing, file text, a write/delete confirmation, or the file sent as an attachment.",
  category: "system",
  costTier: "free",
});

/**
 * Bytes behind a successful `send`, keyed by the data object run()
 * returned — the downloader's proven pattern: extractMedia receives only
 * the data object, and the data contract forbids embedding base64, so the
 * bytes are stashed here by identity. A WeakMap keeps entries from
 * outliving their run.
 */
const sendBytes = new WeakMap<
  object,
  { base64: string; mediaType: string; name: string }
>();

export function createFilesTool(deps: FilesToolDeps): Tool<FilesInput, FilesOutput> {
  return {
    name: "files",
    manifest: filesManifest,
    description:
      "Manage files in the owner's sandboxed files area: list, read, write, append, delete, or send a file as an attachment. Paths are relative to the files area. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [FILES_PERMISSION] },
    toolset: "system",
    input: {
      fields: {
        action: {
          type: "enum",
          required: true,
          description: "One of: list, read, write, append, delete, send.",
          choices: [...FILES_ACTIONS],
        },
        path: {
          type: "string",
          description:
            "Relative path inside the files area. Required for read/write/append/delete/send; for list it defaults to the root.",
          maxLength: 1024,
        },
        content: {
          type: "string",
          description: "Text content for write/append (max 256 KB).",
          maxLength: MAX_TEXT_BYTES,
        },
      },
    },

    extractMedia(data: FilesOutput) {
      if (data.action !== "send") return undefined;
      const media = sendBytes.get(data);
      if (media === undefined) return undefined;
      const part: ContentPart = {
        type: "document",
        mediaType: media.mediaType,
        base64: media.base64,
        name: media.name,
      };
      return [part];
    },

    async run(input: FilesInput, ctx: ToolContext): Promise<FilesOutput> {
      assertOwner(ctx, deps);
      const root = await ensureSandboxRoot(deps.rootDir);

      switch (input.action) {
        case "list":
          return listFiles(root, input.path);
        case "read":
          return readTextFile(root, requiredPath(input));
        case "write":
          return writeTextFile(root, requiredPath(input), requiredContent(input), false);
        case "append":
          return writeTextFile(root, requiredPath(input), requiredContent(input), true);
        case "delete":
          return deleteFile(root, requiredPath(input));
        case "send":
          return sendFile(root, requiredPath(input));
        default:
          throw new ToolError(
            "invalid_input",
            "Unknown action; use list, read, write, append, delete or send.",
          );
      }
    },
  };
}

// ------------------------------------------------------------- actions ----

async function listFiles(root: string, rawPath: string | undefined): Promise<FilesOutput> {
  const rel = normalizeRel(rawPath ?? "");
  const target = await resolveSandboxPath(root, rel, { mustExist: true });
  const st = await stat(target).catch(() => undefined);
  if (st === undefined) throw new ToolError("not_found", "That folder doesn't exist.");
  if (!st.isDirectory()) {
    throw new ToolError("invalid_input", "That path is a file; use read or send for it.");
  }
  const dirents = await readdir(target, { withFileTypes: true }).catch(() => {
    throw new ToolError("internal", "The folder couldn't be listed.");
  });
  const entries: FilesListEntry[] = [];
  for (const d of [...dirents].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entries.length >= MAX_LIST_ENTRIES) break;
    let sizeBytes = 0;
    if (!d.isDirectory()) {
      // lstat, not stat: a symlink's own size, never its target's.
      sizeBytes = await lstat(resolve(target, d.name))
        .then((s) => s.size)
        .catch(() => 0);
    }
    entries.push({ name: d.name, kind: d.isDirectory() ? "dir" : "file", sizeBytes });
  }
  return {
    action: "list",
    path: rel === "" ? "." : rel,
    entries,
    count: entries.length,
    ...(dirents.length > entries.length ? { truncated: true } : {}),
  };
}

async function readTextFile(root: string, rawPath: string): Promise<FilesOutput> {
  const rel = normalizeRel(rawPath);
  const target = await resolveSandboxPath(root, rel, { mustExist: true });
  const st = await stat(target).catch(() => undefined);
  if (st === undefined) throw new ToolError("not_found", "That file doesn't exist.");
  if (st.isDirectory()) {
    throw new ToolError("invalid_input", "That path is a folder; use list for it.");
  }
  if (st.size > MAX_TEXT_BYTES) {
    throw new ToolError(
      "invalid_input",
      "That file is too large to read as text (over 256 KB); use send to deliver it.",
    );
  }
  const bytes = await readFile(target).catch(() => {
    throw new ToolError("internal", "The file couldn't be read.");
  });
  return { action: "read", path: rel, content: decodeText(bytes), sizeBytes: bytes.length };
}

async function writeTextFile(
  root: string,
  rawPath: string,
  content: string,
  append: boolean,
): Promise<FilesOutput> {
  const rel = normalizeRel(rawPath);
  if (rel === "") {
    throw new ToolError("invalid_input", "A file path is required.");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) {
    throw new ToolError("invalid_input", "Content is too large: the limit is 256 KB.");
  }
  const target = await resolveSandboxPath(root, rel, { mustExist: false });
  const parent = dirname(target);
  await mkdir(parent, { recursive: true }).catch(() => {
    throw new ToolError("internal", "The folder couldn't be created.");
  });
  // Re-verify after mkdir: the parent chain that now exists must still
  // resolve inside the root before a single byte is written through it.
  await assertNoSandboxEscape(root, target);
  const existing = await stat(target).catch(() => undefined);
  if (existing?.isDirectory()) {
    throw new ToolError("invalid_input", "That path is a folder; it can't be written to.");
  }
  try {
    if (append) await appendFile(target, content, "utf8");
    else await writeFile(target, content, "utf8");
  } catch {
    throw new ToolError("internal", "The file couldn't be written.");
  }
  const st = await stat(target).catch(() => undefined);
  return { action: append ? "append" : "write", path: rel, sizeBytes: st?.size ?? 0 };
}

async function deleteFile(root: string, rawPath: string): Promise<FilesOutput> {
  const rel = normalizeRel(rawPath);
  const target = await resolveSandboxPath(root, rel, { mustExist: true });
  const st = await lstat(target).catch(() => undefined);
  if (st === undefined) throw new ToolError("not_found", "That file doesn't exist.");
  if (st.isDirectory()) {
    throw new ToolError("invalid_input", "That path is a folder; only files can be deleted.");
  }
  await unlink(target).catch(() => {
    throw new ToolError("internal", "The file couldn't be deleted.");
  });
  return { action: "delete", path: rel, deleted: true };
}

async function sendFile(root: string, rawPath: string): Promise<FilesOutput> {
  const rel = normalizeRel(rawPath);
  const target = await resolveSandboxPath(root, rel, { mustExist: true });
  const st = await stat(target).catch(() => undefined);
  if (st === undefined) throw new ToolError("not_found", "That file doesn't exist.");
  if (st.isDirectory()) {
    throw new ToolError("invalid_input", "That path is a folder; only files can be sent.");
  }
  if (st.size > MAX_SEND_BYTES) {
    throw new ToolError(
      "invalid_input",
      "That file is larger than the 50 MB limit for sending.",
    );
  }
  const bytes = await readFile(target).catch(() => {
    throw new ToolError("internal", "The file couldn't be read.");
  });
  const name = basename(target);
  const data: FilesOutput = { action: "send", sent: true, name, sizeBytes: bytes.length };
  sendBytes.set(data, {
    base64: bytes.toString("base64"),
    mediaType: mediaTypeForName(name),
    name,
  });
  return data;
}

// ------------------------------------------------------------- sandbox ----
//
// Path safety lives in the shared helper (./sandbox); this module only
// keeps its display normalization.

/**
 * Normalize a model-supplied relative path for display/echo purposes:
 * forward slashes, no trailing slash. Resolution itself is left to
 * resolveSandboxPath — this only shapes the string the output reports.
 */
function normalizeRel(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

// ------------------------------------------------------------- helpers ----

/**
 * The defence-in-depth owner check (the goals.ts pattern): only runs when
 * bootstrap supplied the server-side predicate. The actor id comes from
 * server code, never from the model.
 */
function assertOwner(ctx: ToolContext, deps: FilesToolDeps): void {
  if (deps.isOwner === undefined) return;
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "File management is owner only.");
  }
}

function requiredPath(input: FilesInput): string {
  const p = typeof input.path === "string" ? input.path.trim() : "";
  if (p.length === 0) throw new ToolError("invalid_input", "A file path is required.");
  return p;
}

function requiredContent(input: FilesInput): string {
  if (typeof input.content !== "string") {
    throw new ToolError("invalid_input", "Content is required for write and append.");
  }
  return input.content;
}

/** Strict UTF-8 decode; NUL bytes or invalid sequences mean "binary". */
function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) {
    throw new ToolError(
      "invalid_input",
      "That file is binary and can't be read as text; use send to deliver it.",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError(
      "invalid_input",
      "That file is binary or not valid UTF-8 text; use send to deliver it.",
    );
  }
}

/** MIME type for a sent file, guessed from its extension. */
function mediaTypeForName(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".txt":
    case ".log":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".html":
      return "text/html";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}
