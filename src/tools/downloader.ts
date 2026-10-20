/**
 * download_media — universal media downloader for links the user shares.
 *
 * Platforms are detected lexically (see `detectPlatform`); platform links go
 * through yt-dlp (which handles YouTube, Instagram, TikTok and X/Twitter
 * natively), and direct file links are streamed with `fetch`.
 *
 * Delivery contract (Phase 0 of the platform redesign — previously the file
 * was never delivered at all): the downloaded bytes ride out-of-band via
 * the tool's `extractMedia`, exactly like `generate_image`/`generate_video`,
 * so the model-facing `data` never carries a server path. The delivering
 * surface (bot layer) sends the part and then settles it with
 * `cleanupDownloadForPart`, which deletes the on-disk file — on success AND
 * on failure, so a temp download can never leak.
 *
 * Security notes:
 * - The URL comes from the MODEL, so it is untrusted input. Direct downloads
 *   are run through `resolveTarget` first (the same SSRF guard `fetch_url`
 *   uses): loopback and RFC1918 targets are refused unless the owner opts in.
 *   One honest caveat: unlike `pinnedFetch` the binary stream is NOT pinned
 *   to the resolved addresses (a plain `fetch` re-resolves DNS), so a
 *   rebinding trick is theoretically possible. The classification at least
 *   blocks the obvious internal-target case.
 * - yt-dlp is run as a subprocess with no shell, a fixed argv, a hard
 *   timeout, and `--restrict-filenames`. Output filenames are id-based, never
 *   title-based, so a malicious title cannot escape the download directory.
 * - ToolError messages are user-safe: raw yt-dlp stderr is classified into a
 *   small set of kinds and never echoed to the user.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { AiError } from "../ai/provider";
import type { ContentPart } from "../ai/provider";
import { resolveTarget } from "../ai/dns_guard";
import { ToolError } from "./errors";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";
import type { Tool, ToolContext } from "./types";

export const DOWNLOAD_MEDIA_PERMISSION = "tools:download_media";

/** Where downloads live, before the bot layer sends and deletes them. */
const DEFAULT_MAX_SIZE_MB = 50; // Telegram Bot API file limit
const HARD_MAX_SIZE_MB = 200;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 90_000;

/** Platforms yt-dlp handles natively, plus direct file links. */
export type Platform = "youtube" | "instagram" | "tiktok" | "twitter" | "direct" | "unknown";

export type DownloadErrorKind =
  | "private"
  | "not_found"
  | "too_large"
  | "unsupported"
  | "network"
  | "unknown";

export type DownloadResult =
  | {
      ok: true;
      filePath: string;
      platform: Platform;
      ext: string;
      sizeBytes: number;
      title?: string;
    }
  | { ok: false; error: string; errorKind: DownloadErrorKind };

export interface DownloadMediaOptions {
  /** Convert to MP3 instead of keeping video. */
  audioOnly?: boolean;
  /** Cap the download size. Defaults to 50 (the Telegram Bot API limit). */
  maxSizeMB?: number;
  /** Abort the download when the caller's signal fires. */
  signal?: AbortSignal;
  /** Hard ceiling for the whole operation (yt-dlp + fetch). */
  timeoutMs?: number;
  /** Owner opt-in for localhost/LAN direct links. Off by default. */
  allowLocalTargets?: boolean;
  /**
   * Subprocess runner. Injected in tests; defaults to Bun.spawn.
   *
   * Never throws: always resolves with the process outcome, so the caller
   * classifies rather than catches.
   */
  spawn?: SpawnFn;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  argv: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<SpawnResult>;

/**
 * Lexically classify a URL. No network involved, so it is safe to call on
 * any string. Anything that is not a recognised platform and not an obvious
 * direct file link is "unknown" (→ unsupported).
 */
export function detectPlatform(rawUrl: string): Platform {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return "unknown";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be" || host === "youtube-nocookie.com")
    return "youtube";
  if (host === "instagram.com" || host === "instagr.am") return "instagram";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (host === "twitter.com" || host === "x.com" || host === "mobile.twitter.com")
    return "twitter";
  if (MEDIA_EXTENSIONS.has(mediaExtFromPath(url.pathname))) return "direct";
  return "unknown";
}

const MEDIA_EXTENSIONS = new Set([
  "mp4",
  "m4a",
  "mp3",
  "webm",
  "mkv",
  "mov",
  "avi",
  "ogg",
  "oga",
  "opus",
  "flac",
  "wav",
  "3gp",
]);

/** Lowercase extension without the dot, from a URL path. "" when none. */
export function mediaExtFromPath(pathname: string): string {
  const ext = extname(pathname).toLowerCase().replace(/^\./, "");
  return ext;
}

/**
 * Download a media URL to a fresh temp directory.
 *
 * The returned directory is `os.tmpdir()/bobi-dl-<uuid>/`; the caller owns it
 * and must call `cleanupDownload` once the file is no longer needed.
 */
export async function downloadMedia(
  rawUrl: string,
  opts: DownloadMediaOptions = {},
): Promise<DownloadResult> {
  const url = rawUrl.trim();
  const platform = detectPlatform(url);
  if (platform === "unknown") {
    return {
      ok: false,
      errorKind: "unsupported",
      error: "That link doesn't look like a video, audio, or file I can download.",
    };
  }
  if (opts.signal?.aborted) {
    return { ok: false, errorKind: "unknown", error: "The download was cancelled." };
  }

  const dir = join(tmpdir(), `bobi-dl-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return { ok: false, errorKind: "unknown", error: "Couldn't prepare a download folder." };
  }

  try {
    return platform === "direct"
      ? await downloadDirect(url, dir, opts)
      : await downloadWithYtDlp(url, platform, dir, opts);
  } catch {
    await cleanupDownloadDir(dir);
    return { ok: false, errorKind: "unknown", error: "The download failed." };
  }
}

/**
 * Remove a download directory created by `downloadMedia`.
 *
 * Takes either the directory or a file inside it, and refuses to touch
 * anything that is not a `bobi-dl-*` directory — a model-supplied path must
 * never be able to reach outside the sandbox it created.
 */
export async function cleanupDownload(filePathOrDir: string): Promise<void> {
  let dir = resolve(filePathOrDir);
  if (basename(dir).startsWith("bobi-dl-") === false) dir = dirname(dir);
  await cleanupDownloadDir(dir);
}

async function cleanupDownloadDir(dir: string): Promise<void> {
  if (basename(dir).startsWith("bobi-dl-") === false) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp dir is untidy, not a failure.
  }
}

// ------------------------------------------------------------ yt-dlp ------

/**
 * yt-dlp is the whole platform strategy: one subprocess for YouTube,
 * Instagram, TikTok and X/Twitter, with MP3 extraction via ffmpeg.
 *
 * Filenames are `bobi-<video-id>.<ext>` — never the video title — so no
 * title can inject path tricks, and `--restrict-filenames` keeps the id
 * ASCII-safe. The human-readable title is captured separately with
 * `--print after_move:title` for the summary.
 */
async function downloadWithYtDlp(
  url: string,
  platform: Platform,
  dir: string,
  opts: DownloadMediaOptions,
): Promise<DownloadResult> {
  const maxMB = clampMaxSize(opts.maxSizeMB);
  const spawn = opts.spawn ?? defaultSpawn;

  if (!(await ytDlpAvailable(spawn))) {
    return {
      ok: false,
      errorKind: "unsupported",
      error: "Media downloading isn't available on this server yet.",
    };
  }

  const argv = ["yt-dlp", url, ...platformArgs(platform, maxMB, opts.audioOnly === true)];

  const result = await spawn(argv, {
    cwd: dir,
    timeoutMs: opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  if (result.exitCode !== 0) {
    const kind = classifyYtDlpError(result.stderr);
    return { ok: false, errorKind: kind, error: friendlyError(kind, maxMB) };
  }

  const file = await largestFile(dir);
  if (file === undefined) {
    return { ok: false, errorKind: "unknown", error: "The download finished but no file appeared." };
  }
  const sizeBytes = (await stat(file)).size;
  if (sizeBytes > maxMB * 1024 * 1024) {
    await cleanupDownloadDir(dir);
    return { ok: false, errorKind: "too_large", error: friendlyError("too_large", maxMB) };
  }
  if (sizeBytes === 0) {
    await cleanupDownloadDir(dir);
    return { ok: false, errorKind: "unknown", error: "The download finished but the file is empty." };
  }

  const title = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  const ext = extname(file).toLowerCase().replace(/^\./, "") || "bin";
  return {
    ok: true,
    filePath: file,
    platform,
    ext,
    sizeBytes,
    ...(title !== undefined && title.length > 0 ? { title } : {}),
  };
}

function platformArgs(platform: Platform, maxMB: number, audioOnly: boolean): string[] {
  const args = [
    "--no-playlist",
    "--restrict-filenames",
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--max-filesize",
    `${maxMB}M`,
    "-o",
    "bobi-%(id)s.%(ext)s",
    "--print",
    "after_move:title",
  ];
  if (audioOnly) {
    // -x extracts audio via ffmpeg; quality 5 ≈ 130 kbps VBR, kind to the
    // Telegram size cap while still sounding fine.
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "5");
  } else {
    // Prefer an MP4 ≤ 1080p (what Telegram plays inline), degrade gracefully.
    args.push(
      "-f",
      "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    );
  }
  void platform; // Reserved: per-platform tweaks (cookies, clients) go here.
  return args;
}

/** True when the yt-dlp binary runs. A missing binary is a deploy gap, not a user error. */
async function ytDlpAvailable(spawn: SpawnFn): Promise<boolean> {
  try {
    const result = await spawn(["yt-dlp", "--version"], {
      cwd: tmpdir(),
      timeoutMs: 15_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Default runner: Bun.spawn with a hard timeout. Never throws — a failed
 * spawn resolves as exit code 127, which the classifier reads as "not
 * available / unknown" rather than leaking the OS error.
 */
async function defaultSpawn(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<SpawnResult> {
  const program = argv[0] ?? "yt-dlp";
  try {
    const proc = Bun.spawn([program, ...argv.slice(1)], {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const kill = (): void => {
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(kill, opts.timeoutMs);
    const onAbort = opts.signal === undefined ? undefined : (): void => kill();
    opts.signal?.addEventListener("abort", onAbort ?? (() => {}), { once: true });
    try {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (opts.signal?.aborted === true) return { exitCode: 124, stdout: "", stderr: "aborted" };
      return { exitCode: code, stdout: out, stderr: err };
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    return { exitCode: 127, stdout: "", stderr: "" };
  }
}

async function largestFile(dir: string): Promise<string | undefined> {
  let best: { path: string; size: number } | undefined;
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    let size: number;
    try {
      const st = await stat(full);
      if (st.isDirectory()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (best === undefined || size > best.size) best = { path: full, size };
  }
  return best?.path;
}

function clampMaxSize(maxSizeMB: number | undefined): number {
  if (maxSizeMB === undefined) return DEFAULT_MAX_SIZE_MB;
  if (!Number.isFinite(maxSizeMB)) return DEFAULT_MAX_SIZE_MB;
  return Math.min(HARD_MAX_SIZE_MB, Math.max(1, Math.floor(maxSizeMB)));
}

/**
 * Classify yt-dlp's stderr into a user-facing kind.
 *
 * Order matters: size failures are checked before "not found" because a
 * 404-style message can appear in size-related output, and "unsupported" is
 * checked before "private" so a bad URL is never reported as a login problem.
 * Exported for tests.
 */
export function classifyYtDlpError(stderr: string): DownloadErrorKind {
  const s = stderr.toLowerCase();
  if (/larger than the maximum|maximum file size|exceeds the maximum/i.test(s)) return "too_large";
  if (
    /unsupported url|no video formats found|no media found|not a valid url|unknown extractor|no suitable extractor/i.test(
      s,
    )
  )
    return "unsupported";
  if (
    /private video|private status|login required|sign in|please log in|cookies|age[ -]gated|not available in your country|members|requires payment/i.test(
      s,
    )
  )
    return "private";
  if (
    /video unavailable|has been removed|has been deleted|is deleted|http error 404|404 not found|this content isn't available|post not found/i.test(
      s,
    )
  )
    return "not_found";
  if (
    /urlopen error|connection (refused|reset|timed out)|timed out|temporary failure|network is unreachable|name or service not known|http error 5\d\d|http error 429|too many requests|ssl/i.test(
      s,
    )
  )
    return "network";
  return "unknown";
}

function friendlyError(kind: DownloadErrorKind, maxMB: number): string {
  switch (kind) {
    case "private":
      return "That link is private or needs a login, so it can't be downloaded.";
    case "not_found":
      return "That link is gone or doesn't exist.";
    case "too_large":
      return `That file is larger than the ${maxMB} MB limit.`;
    case "unsupported":
      return "That kind of link isn't supported.";
    case "network":
      return "The download failed because of a network problem. Try again in a moment.";
    case "unknown":
      return "The download failed.";
  }
}

// ------------------------------------------------------------ direct ------

/**
 * Stream a direct file link to disk with a size ceiling.
 *
 * The SSRF guard runs first (same policy as fetch_url); then the
 * Content-Length is checked before a single byte is read, and the stream is
 * aborted the moment the ceiling is passed, so a lying header cannot fill
 * the disk.
 */
async function downloadDirect(
  url: string,
  dir: string,
  opts: DownloadMediaOptions,
): Promise<DownloadResult> {
  const maxBytes = clampMaxSize(opts.maxSizeMB) * 1024 * 1024;

  let target: string;
  try {
    target = (
      await resolveTarget(
        { baseUrl: url, apiKey: undefined },
        { allowLocalTargets: opts.allowLocalTargets === true },
      )
    ).baseUrl;
  } catch (err) {
    const blocked = err instanceof AiError && err.kind === "invalid_response";
    return {
      ok: false,
      errorKind: "unsupported",
      error: blocked ? "That URL isn't allowed." : "That URL couldn't be checked.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  const onCallerAbort = opts.signal === undefined ? undefined : (): void => controller.abort();
  opts.signal?.addEventListener("abort", onCallerAbort ?? (() => {}), { once: true });

  try {
    const res = await fetch(target, {
      signal: controller.signal,
      headers: { "user-agent": "BOBI/0.0.1 (+agent)" },
      redirect: "follow",
    });
    if (!res.ok) {
      return {
        ok: false,
        errorKind: res.status === 404 ? "not_found" : "unknown",
        error:
          res.status === 404 ? "That file doesn't exist." : `The server answered ${res.status}.`,
      };
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      return { ok: false, errorKind: "too_large", error: friendlyError("too_large", maxBytes / 1048576) };
    }

    const ext = directExt(res, url);
    const name = sanitizeFilename(basename(new URL(url).pathname) || "download", ext);
    const filePath = join(dir, name);

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader === undefined) {
      return { ok: false, errorKind: "unknown", error: "The download returned no data." };
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        await cleanupDownloadDir(dir);
        return {
          ok: false,
          errorKind: "too_large",
          error: friendlyError("too_large", maxBytes / 1048576),
        };
      }
      chunks.push(value);
    }
    if (total === 0) {
      return { ok: false, errorKind: "unknown", error: "The download was empty." };
    }
    await writeFile(filePath, Buffer.concat(chunks));

    return { ok: true, filePath, platform: "direct", ext, sizeBytes: total };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return opts.signal?.aborted === true
        ? { ok: false, errorKind: "unknown", error: "The download was cancelled." }
        : { ok: false, errorKind: "network", error: "The download timed out." };
    }
    return { ok: false, errorKind: "network", error: friendlyError("network", maxBytes / 1048576) };
  } finally {
    clearTimeout(timer);
    if (onCallerAbort !== undefined) opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

const CONTENT_TYPE_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/flac": "flac",
};

/** Extension for a direct download: trust the URL first, then the content type. */
function directExt(res: Response, url: string): string {
  const fromPath = mediaExtFromPath(new URL(url).pathname);
  if (MEDIA_EXTENSIONS.has(fromPath)) return fromPath;
  const ct = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const fromType = CONTENT_TYPE_EXT[ct];
  if (fromType !== undefined) return fromType;
  return "bin";
}

/**
 * Make a filename that is safe to write into the download dir: no path
 * separators, no control characters, bounded length, always with an
 * extension. Exported for tests.
 */
export function sanitizeFilename(raw: string, ext: string): string {
  const base = raw
    .replace(/[\\/]/g, "_")
    .replace(/[\0-\x1f\x7f]/g, "")
    .replace(/[^\w\-+.()[\] ]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, "") || "download";
  return `${stem}.${ext}`;
}

// ---------------------------------------------------------------- tool ----

export interface DownloadMediaInput {
  url: string;
  /** Extract audio as MP3 instead of downloading the video. */
  audio_only?: boolean;
  /** Size ceiling in MB (default 50, the Telegram Bot API limit). */
  max_size_mb?: number;
}

export interface DownloadMediaOutput {
  url: string;
  platform: Platform;
  title?: string;
  ext: string;
  sizeBytes: number;
  audioOnly: boolean;
  /** The file itself is delivered to the user as an attachment (see extractMedia). */
  deliveredAs: "attachment";
}

/**
 * Downloaded bytes, keyed by the data object `run()` returned.
 *
 * Same proven pattern as `generate_image`/`generate_video`: `extractMedia`
 * receives only the data object, and the data contract forbids embedding
 * base64 (or a server path), so the bytes are stashed here by identity.
 * The Executor passes the exact object `run()` returned, so the lookup
 * cannot miss; a WeakMap keeps entries from outliving their run.
 */
const downloadBytes = new WeakMap<
  object,
  { base64: string; mediaType: string; name: string }
>();

/** Which on-disk file a successful run produced, keyed by its data object. */
const downloadDataFiles = new WeakMap<object, string>();

/**
 * Which on-disk file stands behind a media part `extractMedia` produced.
 *
 * The delivering surface settles every part it was handed with
 * `cleanupDownloadForPart`; parts from other tools simply miss the lookup.
 * WeakMap-keyed by the part object itself: the Executor and the agent loop
 * pass the exact part objects through, so identity holds end to end.
 */
const downloadPartFiles = new WeakMap<ContentPart, string>();

/**
 * Settle one delivered media part: if it came from a download, delete the
 * temp file behind it. Surfaces call this after EVERY send attempt —
 * success or failure — so a downloaded file never leaks on disk. A no-op
 * for parts produced by other tools. Never throws.
 */
export async function cleanupDownloadForPart(part: ContentPart): Promise<void> {
  const filePath = downloadPartFiles.get(part);
  if (filePath === undefined) return;
  downloadPartFiles.delete(part);
  await cleanupDownload(filePath);
}

/** MIME type for a downloaded extension — drives the surface's send kind. */
function mediaTypeForExt(ext: string, audioOnly: boolean): string {
  if (audioOnly) return "audio/mpeg";
  switch (ext.toLowerCase()) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "mov":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    case "3gp":
      return "video/3gpp";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "opus":
      return "audio/opus";
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    default:
      return "application/octet-stream";
  }
}

function mapErrorKind(kind: DownloadErrorKind): "not_found" | "not_allowed" | "invalid_result" | "invalid_input" | "internal" {
  switch (kind) {
    case "not_found":
      return "not_found";
    case "private":
      return "not_allowed";
    case "too_large":
      return "invalid_result";
    case "unsupported":
      return "invalid_input";
    case "network":
    case "unknown":
      return "internal";
  }
}

/**
 * Plugin manifest — the reference implementation for the plugin
 * contract (see manifest.ts). The intent router consumes `triggers`:
 * every URL in this tool's patterns routes here deterministically,
 * and the media MIME types let media messages without a caption
 * still find the downloader.
 *
 * Dependency note (architecture audit, Oct 2026): this module imports
 * `AiError` (the shared error vocabulary) and `resolveTarget` (the
 * SSRF/DNS guard) from ../ai — shared infrastructure primitives, the
 * same class as node:* imports. It imports NOTHING from ../agent or
 * ../bot and never calls a provider, gateway or model: the download
 * is pure subprocess + guarded HTTP, fully self-contained.
 */
export const downloadMediaManifest: ToolManifest = defineManifest({
  id: "download_media",
  version: "1.0.0",
  title: "Media Downloader",
  description:
    "Download a video or audio file from a YouTube, Instagram, TikTok or X (Twitter) link, or a direct media file URL. The file is sent to the user as an attachment.",
  outputSummary: "The downloaded file itself (delivered as an attachment), with platform, title and size.",
  category: "media",
  triggers: {
    urlPatterns: [
      "(?:youtube\\.com/(?:watch|shorts|live)|youtu\\.be/)",
      "instagram\\.com/(?:reel|p|tv)/",
      "(?:tiktok\\.com|vm\\.tiktok\\.com|vt\\.tiktok\\.com)",
      "(?:twitter\\.com|x\\.com)/\\S+/status/",
      "\\.(?:mp4|mov|mkv|webm|mp3|m4a|ogg|wav)(?:\\?|$)",
    ],
    keywordPatterns: [
      "دانلود کن",
      "دانلودش کن",
      "download (this|the|that) (video|clip|song|audio|file)",
    ],
    mimeTypes: ["video/*", "audio/*"],
  },
  timeoutMs: 600_000,
  costTier: "heavy",
});

/** Dependencies a download tool instance may override (tests inject a fake spawn). */
export interface DownloadToolDeps {
  /** Subprocess runner forwarded to `downloadMedia`. Defaults to Bun.spawn. */
  spawn?: SpawnFn;
}

export function createDownloadTool(
  deps: DownloadToolDeps = {},
): Tool<DownloadMediaInput, DownloadMediaOutput> {
  return {
    name: "download_media",
    manifest: downloadMediaManifest,
    description:
      "Download a video or audio file from a YouTube, Instagram, TikTok or X (Twitter) link, or a direct file URL. The downloaded file is sent to the user as an attachment.",
    enabled: true,
    permission: { requires: [DOWNLOAD_MEDIA_PERMISSION] },
    toolset: "media",
    // A download can legitimately take minutes on a slow host.
    timeoutMs: 600_000,
    input: {
      fields: {
        url: {
          type: "string",
          required: true,
          description: "Full media URL, with http or https.",
          minLength: 10,
          maxLength: 2_048,
        },
        audio_only: {
          type: "boolean",
          description: "When true, extract audio as MP3 instead of the video.",
        },
        max_size_mb: {
          type: "integer",
          description: "Size ceiling in MB. Defaults to 50 (the Telegram Bot API limit).",
          minimum: 1,
          maximum: 200,
        },
      },
    },

    extractMedia(data: DownloadMediaOutput) {
      const media = downloadBytes.get(data);
      if (media === undefined) return undefined;
      const part: ContentPart = {
        type: "document",
        mediaType: media.mediaType,
        base64: media.base64,
        name: media.name,
      };
      // Remember which temp file stands behind this part, so the surface
      // that delivers it can delete the file once the send settles
      // (cleanupDownloadForPart). The file path lives ONLY in this map —
      // never in `data`, never in the part the model could see.
      const filePath = downloadDataFiles.get(data);
      if (filePath !== undefined) downloadPartFiles.set(part, filePath);
      return [part];
    },

    async run(input: DownloadMediaInput, ctx: ToolContext): Promise<DownloadMediaOutput> {
      const url = input.url.trim();
      if (url.length === 0) throw new ToolError("invalid_input", "No URL was provided.");

      const result = await downloadMedia(url, {
        audioOnly: input.audio_only === true,
        ...(input.max_size_mb !== undefined ? { maxSizeMB: input.max_size_mb } : {}),
        signal: ctx.signal,
        ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      });

      if (!result.ok) {
        throw new ToolError(mapErrorKind(result.errorKind), result.error, {
          errorKind: result.errorKind,
        });
      }

      // Read the bytes back NOW, while the run still owns the file: they
      // ride out-of-band via extractMedia (the model's `data` stays free of
      // paths and blobs), and the surface deletes the file after delivery.
      let bytes: Buffer;
      try {
        bytes = await readFile(result.filePath);
      } catch {
        await cleanupDownload(result.filePath);
        throw new ToolError(
          "internal",
          "The download finished, but the file couldn't be read back.",
        );
      }

      const data: DownloadMediaOutput = {
        url,
        platform: result.platform,
        ...(result.title !== undefined ? { title: result.title } : {}),
        ext: result.ext,
        sizeBytes: result.sizeBytes,
        audioOnly: input.audio_only === true,
        deliveredAs: "attachment",
      };
      downloadBytes.set(data, {
        base64: bytes.toString("base64"),
        mediaType: mediaTypeForExt(result.ext, input.audio_only === true),
        name:
          result.title !== undefined && result.title.length > 0
            ? sanitizeFilename(result.title, result.ext)
            : basename(result.filePath),
      });
      downloadDataFiles.set(data, result.filePath);
      return data;
    },
  };
}

/** The production download tool (real yt-dlp subprocess). */
export const downloadTool: Tool<DownloadMediaInput, DownloadMediaOutput> =
  createDownloadTool();
