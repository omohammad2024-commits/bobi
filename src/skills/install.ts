/**
 * Installable skills: the validation pipeline behind "install from chat".
 *
 * A skill is markdown-only — there is no code execution anywhere in this
 * flow, so "sandboxing" here means strict validation BEFORE a file ever
 * reaches the skills directory, plus an owner review step. Both install
 * sources (an uploaded `.md` document, a fetched URL) converge on
 * `prepareSkillInstall`, which is pure over (text, directory listing).
 *
 * Security model (see also docs/PHASE3_SKILLS.md):
 * - Byte cap enforced on the raw text (documents: `file_size` checked before
 *   download and the downloaded bytes checked again; URLs: `content-length`
 *   checked before the body is trusted and the bytes re-checked after).
 * - The frontmatter parser is the loader's own — a skill that does not parse
 *   is never installable.
 * - The skill NAME is the only thing that becomes a filename (`<name>.md`);
 *   the name is kebab-case by parser rule, so no `../` can escape the
 *   directory and the uploader's filename is never trusted.
 * - `scanSkillBody` flags prompt-injection payloads aimed at the agent (the
 *   body becomes system-prompt context) and secret-looking content. Warnings
 *   are surfaced on the install review card; nothing is silently installed.
 * - URL fetching reuses the pinned-transport SSRF guards (`resolveTarget` +
 *   `pinnedFetch`): public-only addresses, DNS resolved and classified per
 *   hop, sockets pinned to validated addresses, redirects re-validated hop
 *   by hop, never followed by the transport itself.
 * - Disable = rename to a hidden `.disabled-<name>.md` file, which the
 *   loader already skips. No loader change, no new state file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseSkillFile } from "./loader";
import { SKILLS_MAX_FILE_BYTES, SKILLS_MAX_SKILLS } from "./types";
import type { Skill } from "./types";
import { resolveTarget, type DnsResolver } from "../ai/dns_guard";
import { AiError } from "../ai/provider";

// ------------------------------------------------------------ validation ----

/** A skill that passed validation and is ready for owner review. */
export interface ValidatedSkill {
  skill: Skill;
  /** Raw UTF-8 byte size of the submitted text. */
  sizeBytes: number;
  /** Risk warnings from `scanSkillBody`; shown on the review card. */
  warnings: SkillWarning[];
  /** True when an existing skill with the same name would be replaced. */
  replace: boolean;
}

/** One flagged risk in a skill body. */
export interface SkillWarning {
  /** Machine tag, e.g. "prompt-injection" or "possible-secret". */
  kind: string;
  /** Short human-readable detail (fa/en rendered by the caller). */
  detail: string;
  /** The matched snippet, truncated; shown so the owner can judge. */
  snippet: string;
}

/** Why validation refused the submission. */
export type SkillValidationError =
  | { kind: "too_large"; bytes: number; maxBytes: number }
  | { kind: "parse"; reason: string }
  | { kind: "collision"; name: string }
  | { kind: "limit"; max: number; count: number };

export type InstallPlan =
  | { ok: true; validated: ValidatedSkill }
  | { ok: false; error: SkillValidationError };

export interface PrepareInstallOpts {
  /** Raw markdown text from either source. */
  text: string;
  /** "document" or the URL; used as the Skill.source and in warnings. */
  source: string;
  /** Skills directory (as configured). */
  dir: string;
  /** True when the owner explicitly confirmed replacing a same-named skill. */
  allowReplace?: boolean;
}

/**
 * Run the full validation pipeline over submitted skill text.
 *
 * Pure over (text, directory listing): it reads the directory but writes
 * nothing. Call `writeSkillFile` only after the owner approves the plan.
 */
export function prepareSkillInstall(opts: PrepareInstallOpts): InstallPlan {
  const { text, source, dir } = opts;
  const allowReplace = opts.allowReplace === true;

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > SKILLS_MAX_FILE_BYTES) {
    return { ok: false, error: { kind: "too_large", bytes, maxBytes: SKILLS_MAX_FILE_BYTES } };
  }

  const parsed = parseSkillFile(text, source);
  if (parsed.skill === undefined) {
    return { ok: false, error: { kind: "parse", reason: parsed.skipped ?? "unknown" } };
  }
  const skill = parsed.skill;
  const name = skill.name;

  const abs = resolve(dir);
  const enabledPath = join(abs, `${name}.md`);
  const disabledPath = join(abs, `.disabled-${name}.md`);
  const collides = existsSync(enabledPath) || existsSync(disabledPath);
  if (collides && !allowReplace) {
    return { ok: false, error: { kind: "collision", name } };
  }

  // The loader counts non-hidden .md files; a replace keeps the count.
  let count = 0;
  try {
    for (const entry of readdirSync(abs)) {
      if (!entry.startsWith(".") && entry.endsWith(".md")) count++;
    }
  } catch {
    // Unreadable directory: treat as empty here; the write step will fail
    // loudly if the directory is truly unusable.
  }
  const wouldAdd = collides ? 0 : 1;
  if (count + wouldAdd > SKILLS_MAX_SKILLS) {
    return { ok: false, error: { kind: "limit", max: SKILLS_MAX_SKILLS, count } };
  }

  return {
    ok: true,
    validated: {
      skill,
      sizeBytes: bytes,
      warnings: scanSkillBody(skill),
      replace: collides,
    },
  };
}

/**
 * Write a validated skill into the skills directory.
 *
 * The filename is derived ONLY from the validated kebab-case name, never
 * from the uploader's filename or the URL. Replacing removes a disabled
 * shadow file first so the skill comes back enabled.
 */
export function writeSkillFile(dir: string, validated: ValidatedSkill): string {
  const abs = resolve(dir);
  mkdirSync(abs, { recursive: true });
  const name = validated.skill.name;
  const enabledPath = join(abs, `${name}.md`);
  const disabledPath = join(abs, `.disabled-${name}.md`);
  try {
    if (existsSync(disabledPath)) unlinkSync(disabledPath);
  } catch {
    // Best effort; the write below is what matters.
  }
  writeFileSync(enabledPath, frontmatterRoundTrip(validated), "utf8");
  return enabledPath;
}

/**
 * Re-serialize the validated skill so the installed file is exactly what the
 * review card showed: the parsed frontmatter plus the parsed body. Storing
 * the owner's raw bytes would preserve unparsed frontmatter lines the review
 * never displayed; re-serializing keeps review and install identical.
 */
function frontmatterRoundTrip(validated: ValidatedSkill): string {
  const s = validated.skill;
  const lines = ["---", `name: ${s.name}`, `description: ${s.description}`];
  if (s.version !== undefined) lines.push(`version: ${s.version}`);
  if (s.triggers.length > 0) lines.push(`triggers: [${s.triggers.join(", ")}]`);
  lines.push("---", "", s.body.trim(), "");
  return lines.join("\n");
}

// ------------------------------------------------- prompt-injection scan ----

interface RiskPattern {
  kind: string;
  detail: string;
  pattern: RegExp;
}

/**
 * Patterns for payloads aimed AT the agent. A skill body is injected into
 * the system prompt, so a skill that tells the model to ignore its real
 * instructions is a prompt-injection vector — whether the URL author meant
 * it or copy-pasted it. Matches are warnings for the review card, not silent
 * blocks: the owner decides.
 */
const RISK_PATTERNS: RiskPattern[] = [
  {
    kind: "prompt-injection",
    detail: "tells the agent to ignore or disregard previous instructions",
    pattern: /\b(ignore|disregard)\s+(all\s+|any\s+)?(previous|prior|earlier)\s+(instructions?|directives?)\b/i,
  },
  {
    kind: "prompt-injection",
    detail: "tells the agent to forget what it was told",
    pattern: /\bforget\s+(everything|all|your)\s+(you\s+)?(were\s+|have\s+been\s+)?(told|instructed)\b/i,
  },
  {
    kind: "prompt-injection",
    detail: "tries to reassign the agent's identity or role",
    pattern: /\byou are now\s+(a|an|in)\b/i,
  },
  {
    kind: "prompt-injection",
    detail: "jailbreak / developer-mode phrasing",
    pattern: /\b(developer mode|jailbreak|DAN mode|do anything now)\b/i,
  },
  {
    kind: "prompt-injection",
    detail: "asks to reveal the system prompt or hidden instructions",
    pattern: /\b(reveal|print|output|show|leak|repeat)\b[^.\n]{0,60}\bsystem\s+(prompt|instructions?|message)\b/i,
  },
  {
    kind: "prompt-injection",
    detail: "دستور به عامل برای نادیده گرفتن دستورات قبلی",
    pattern: /دستور(ات|العمل‌های?)?\s+(قبلی|قبل)\s+را\s+(نادیده|فراموش)/,
  },
  {
    kind: "prompt-injection",
    detail: "تلاش برای تغییر هویت یا نقش عامل",
    pattern: /از این به بعد تو\s+(یک|یه)/,
  },
  {
    kind: "possible-secret",
    detail: "looks like it contains a key, token or password (skill bodies must not hold secrets)",
    pattern: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|password|passwd)\s*[:=]\s*\S+/i,
  },
  {
    kind: "possible-secret",
    detail: "به نظر می‌رسد رمز یا کلید دارد (بدنهٔ مهارت نباید رمز داشته باشد)",
    pattern: /(رمز|گذرواژه|کلید\s+(محرمانه|api))\s*[:=]\s*\S+/,
  },
];

const SNIPPET_CHARS = 120;

/** Scan a parsed skill body for risky payloads. Pure. */
export function scanSkillBody(skill: Skill): SkillWarning[] {
  const warnings: SkillWarning[] = [];
  const haystack = `${skill.name}\n${skill.description}\n${skill.body}`;
  for (const { kind, detail, pattern } of RISK_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match) {
      const at = Math.max(0, (match.index ?? 0) - 40);
      warnings.push({
        kind,
        detail,
        snippet: haystack.slice(at, at + SNIPPET_CHARS).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return warnings;
}

// ------------------------------------------------------------ file state ----

export type SkillFileStatus = "enabled" | "disabled" | "missing";

/** Whether `<name>.md` (enabled), `.disabled-<name>.md` (disabled), or neither exists. */
export function skillFileStatus(dir: string, name: string): SkillFileStatus {
  const abs = resolve(dir);
  if (existsSync(join(abs, `${name}.md`))) return "enabled";
  if (existsSync(join(abs, `.disabled-${name}.md`))) return "disabled";
  return "missing";
}

/**
 * Enable or disable an installed skill by renaming it into / out of the
 * loader's hidden-file convention. Returns the new status, or "missing".
 */
export function setSkillEnabled(dir: string, name: string, enabled: boolean): SkillFileStatus {
  const abs = resolve(dir);
  const enabledPath = join(abs, `${name}.md`);
  const disabledPath = join(abs, `.disabled-${name}.md`);
  try {
    if (enabled && existsSync(disabledPath)) {
      renameSync(disabledPath, enabledPath);
      return "enabled";
    }
    if (!enabled && existsSync(enabledPath)) {
      renameSync(enabledPath, disabledPath);
      return "disabled";
    }
  } catch {
    // Fall through to the status read below.
  }
  return skillFileStatus(dir, name);
}

/** Delete an installed skill file (enabled or disabled). Returns true when a file was removed. */
export function uninstallSkillFile(dir: string, name: string): boolean {
  const abs = resolve(dir);
  let removed = false;
  for (const p of [join(abs, `${name}.md`), join(abs, `.disabled-${name}.md`)]) {
    try {
      if (existsSync(p)) {
        unlinkSync(p);
        removed = true;
      }
    } catch {
      // Keep trying the other path.
    }
  }
  return removed;
}

/**
 * Names of installed skills (enabled and disabled), sorted. Reads only the
 * directory listing — filenames, never file contents — so it stays cheap
 * and never fails on a corrupt skill file.
 */
export function listInstalledSkillNames(dir: string): { name: string; enabled: boolean }[] {
  let entries: string[];
  try {
    entries = readdirSync(resolve(dir));
  } catch {
    return [];
  }
  const out: { name: string; enabled: boolean }[] = [];
  for (const e of entries.sort()) {
    if (!e.endsWith(".md")) continue;
    if (!e.startsWith(".")) {
      out.push({ name: e.slice(0, -".md".length), enabled: true });
    } else if (e.startsWith(".disabled-")) {
      out.push({ name: e.slice(".disabled-".length, -".md".length), enabled: false });
    }
  }
  return out;
}

/** Read one installed skill file back (enabled or disabled), parsed. */
export function readInstalledSkill(
  dir: string,
  name: string,
): { skill: Skill; status: Exclude<SkillFileStatus, "missing"> } | undefined {
  const abs = resolve(dir);
  for (const [p, status] of [
    [join(abs, `${name}.md`), "enabled"],
    [join(abs, `.disabled-${name}.md`), "disabled"],
  ] as const) {
    try {
      if (!existsSync(p)) continue;
      const parsed = parseSkillFile(readFileSync(p, "utf8"), p);
      if (parsed.skill !== undefined) return { skill: parsed.skill, status };
      return undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ------------------------------------------------------------ URL fetch ----

/** What a skill-URL fetch returned. */
export interface SkillFetchResult {
  /** The URL as given. */
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  /** Raw markdown text. */
  text: string;
}

/** Typed fetch failure; the caller renders it fa/en. */
export class SkillFetchError extends Error {
  constructor(
    public readonly kind: "invalid_input" | "invalid_result" | "timeout" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "SkillFetchError";
  }
}

/**
 * Fetch markdown for a skill URL. Inject the whole fetcher in tests; in
 * production use `createPinnedSkillFetcher()`.
 */
export type SkillFetcher = (url: string) => Promise<SkillFetchResult>;

export interface PinnedSkillFetcherOpts {
  /** Injectable resolver so tests never touch real DNS. */
  resolver?: DnsResolver;
  /**
   * Allow loopback/RFC1918 targets. Default false (public-only, like
   * fetch_url). Tests pass true against a local stub server.
   */
  allowLocalTargets?: boolean;
  timeoutMs?: number;
}

const FETCH_MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Content types accepted for a skill URL, checked on the response HEADERS
 * before a single body byte is read. A skill must be raw markdown: HTML
 * pages are refused with a hint to use the raw URL, because an HTML document
 * never parses as a skill file.
 */
const SKILL_READABLE_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/json",
]);

function isSkillReadable(contentType: string): boolean {
  return SKILL_READABLE_TYPES.has(contentType);
}

/**
 * One HTTP response whose body has NOT been read yet.
 *
 * The headers are available first, so the caller enforces the content-type
 * and content-length policy before deciding to stream the body — and
 * `readBody` aborts the stream the moment the byte cap is crossed, so an
 * over-large body is never fully downloaded.
 */
interface PinnedResponseHandle {
  status: number;
  headers: Record<string, string | undefined>;
  /** Stream the body, refusing past `maxBytes`. */
  readBody(maxBytes: number): Promise<Buffer>;
  /** Drop the body without reading it (redirects). */
  discard(): void;
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`body exceeds the ${SKILLS_MAX_FILE_BYTES} byte skill cap`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * GET one URL, connecting ONLY to the validated addresses.
 *
 * The SSRF posture mirrors `pinnedFetch`: the addresses came from
 * `resolveTarget` (resolved and classified per hop), and the socket is
 * opened to the address literally — no DNS is consulted for the connection,
 * which is what closes the rebinding race on runtimes where a custom
 * `lookup` is not honoured. The original hostname is preserved on the wire
 * via the Host header and TLS SNI (`servername`), so virtual hosts and
 * certificate verification keep working.
 *
 * Unlike `pinnedFetch` this streams: headers are returned first and the
 * body is capped WHILE downloading, which is what lets the caller enforce
 * SKILLS_MAX_FILE_BYTES before the download completes.
 */
function pinnedGet(opts: {
  url: string;
  addresses: readonly string[];
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<PinnedResponseHandle> {
  const url = new URL(opts.url);
  const secure = url.protocol === "https:";
  const requestFn = secure ? httpsRequest : httpRequest;
  const originHost = url.hostname;
  const port = url.port !== "" ? Number(url.port) : secure ? 443 : 80;
  const path = `${url.pathname}${url.search}`;
  const headers = { ...opts.headers, host: url.host };

  return new Promise<PinnedResponseHandle>((resolve, reject) => {
    let lastError: unknown;
    let addressIndex = 0;

    const tryNext = (): void => {
      if (addressIndex >= opts.addresses.length) {
        reject(
          lastError instanceof Error
            ? lastError
            : new Error("no validated address answered"),
        );
        return;
      }
      const address = opts.addresses[addressIndex++]!;
      const requestOptions: RequestOptions = {
        host: address,
        port,
        path,
        method: "GET",
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs),
        ...(secure ? { servername: originHost } : {}),
      };
      const req = requestFn(requestOptions, (res) => {
        const outHeaders: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          outHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        let bodySettled = false;
        const handle: PinnedResponseHandle = {
          status: res.statusCode ?? 0,
          headers: outHeaders,
          discard() {
            res.resume();
          },
          readBody(maxBytes: number): Promise<Buffer> {
            return new Promise<Buffer>((resBody, rejBody) => {
              const chunks: Buffer[] = [];
              let total = 0;
              const fail = (err: Error): void => {
                if (bodySettled) return;
                bodySettled = true;
                try {
                  res.destroy();
                } catch {
                  // Already gone.
                }
                rejBody(err);
              };
              res.on("data", (chunk: Buffer) => {
                total += chunk.length;
                if (total > maxBytes) {
                  fail(new BodyTooLargeError());
                  return;
                }
                chunks.push(chunk);
              });
              res.on("end", () => {
                if (bodySettled) return;
                bodySettled = true;
                resBody(Buffer.concat(chunks));
              });
              res.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
            });
          },
        };
        resolve(handle);
      });
      req.on("error", (err) => {
        lastError = err;
        // A black-holed address must not consume the whole run: try the next
        // validated address (same rationale as the transport's retry loop).
        tryNext();
      });
      req.end();
    };

    tryNext();
  });
}

/**
 * The production fetcher: same SSRF posture as `fetch_url` (resolve +
 * classify EVERY address per hop, connect only to validated addresses,
 * re-validate each redirect hop, public-only unless the caller opts in),
 * plus a byte ceiling of SKILLS_MAX_FILE_BYTES enforced BEFORE the download
 * completes: the `content-length` header is refused up front, the
 * content-type is checked on the headers, and the streaming body is aborted
 * the moment the cap is crossed.
 */
export function createPinnedSkillFetcher(opts: PinnedSkillFetcherOpts = {}): SkillFetcher {
  const allowLocal = opts.allowLocalTargets === true;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  return async (rawUrl: string): Promise<SkillFetchResult> => {
    const start = normaliseSkillUrl(rawUrl);
    let current = start;

    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      const resolved = await resolveSkillTarget(current, opts.resolver, allowLocal);
      let res: PinnedResponseHandle;
      try {
        res = await pinnedGet({
          url: resolved.baseUrl,
          addresses: resolved.addresses,
          headers: {
            accept: "text/markdown,text/plain;q=0.9,application/json;q=0.1",
            "user-agent": "BOBI/0.0.1 (+skill-install)",
          },
          timeoutMs,
        });
      } catch (err) {
        throw mapRequestError(err);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers["location"];
        res.discard();
        if (typeof location !== "string" || location.length === 0) {
          throw new SkillFetchError("invalid_result", "redirect without a location header");
        }
        if (hop === FETCH_MAX_REDIRECTS) {
          throw new SkillFetchError("invalid_result", "too many redirects");
        }
        // Resolve relative to the current URL, then re-validate the next hop
        // from scratch — a public URL redirecting to 169.254.169.254 is the
        // classic SSRF bypass and must die here.
        current = new URL(location, current).toString();
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        res.discard();
        throw new SkillFetchError("invalid_result", `unexpected HTTP status ${res.status}`);
      }

      const contentType = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (!isSkillReadable(contentType)) {
        res.discard();
        throw new SkillFetchError(
          "invalid_input",
          `unreadable content type "${contentType || "unknown"}": a skill URL must serve raw markdown (use the raw file URL)`,
        );
      }

      // Declared size is refused before the body streams.
      const declared = res.headers["content-length"];
      if (typeof declared === "string" && /^\d+$/.test(declared.trim())) {
        if (Number(declared) > SKILLS_MAX_FILE_BYTES) {
          res.discard();
          throw new SkillFetchError(
            "invalid_result",
            `content-length ${declared.trim()} exceeds the ${SKILLS_MAX_FILE_BYTES} byte skill cap`,
          );
        }
      }

      let raw: Buffer;
      try {
        raw = await res.readBody(SKILLS_MAX_FILE_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          throw new SkillFetchError("invalid_result", err.message);
        }
        throw mapRequestError(err);
      }

      return {
        url: start,
        finalUrl: current,
        status: res.status,
        contentType: contentType || "unknown",
        text: raw.toString("utf8"),
      };
    }

    // Unreachable: the loop returns or throws on the final hop.
    throw new SkillFetchError("internal", "fetch loop fell through");
  };
}

/** Map transport-level failures to typed fetch errors. */
function mapRequestError(err: unknown): SkillFetchError {
  if (err instanceof SkillFetchError) return err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new SkillFetchError("timeout", "fetch timed out");
  }
  return new SkillFetchError("internal", "fetch failed");
}

function normaliseSkillUrl(raw: string): string {
  const trimmed = raw.trim().replace(/^[<"\u201c]+|[>"\u201d.,;]+$/g, "");
  if (trimmed.length === 0) throw new SkillFetchError("invalid_input", "empty URL");
  if (trimmed.length > 2_048) throw new SkillFetchError("invalid_input", "URL too long");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new SkillFetchError("invalid_input", "URL must start with http:// or https://");
  }
  return trimmed;
}

async function resolveSkillTarget(
  url: string,
  resolver: DnsResolver | undefined,
  allowLocal: boolean,
): Promise<{ baseUrl: string; addresses: readonly string[] }> {
  try {
    const resolved = await resolveTarget(
      { baseUrl: url, apiKey: undefined },
      resolver !== undefined
        ? { resolver, allowLocalTargets: allowLocal }
        : { allowLocalTargets: allowLocal },
    );
    return { baseUrl: resolved.baseUrl, addresses: resolved.addresses };
  } catch (err) {
    if (err instanceof AiError) {
      // Policy rejection (private/loopback/link-local, DNS failure, bad
      // scheme): deliberately not repeating the resolved address.
      throw new SkillFetchError("invalid_input", "URL is not allowed or unreachable");
    }
    if (err instanceof SkillFetchError) throw err;
    throw new SkillFetchError("internal", "target validation failed");
  }
}
