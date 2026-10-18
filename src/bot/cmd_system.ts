/**
 * Phase: Hermes command parity — system/owner commands (`cmd_system`).
 *
 * All 19 commands in this module are OWNER-ONLY: the handler checks
 * `isOwnerSender` FIRST (before the group/user gates), and a non-owner gets a
 * Persian "owner-only" reply. Never rely on menu hiding as the enforcement.
 *
 * SECURITY notes (see also docs/phase-commands-system.md):
 * - `/update` spawns `git` as the service user: trust assumption is that the
 *   owner controls their own VM and their own repo remote. `git pull
 *   --ff-only` never auto-merges; a failed pull never triggers a restart.
 * - `/debug` bundles diagnostics as a Markdown document. Every log line is
 *   passed through `scrubSecrets()` before it leaves the machine; no reply
 *   anywhere in this module ever contains a key, token, or credential.
 * - Snapshot names are validated against a strict allow-list
 *   (`sanitizeSnapshotName`) and always joined under the snapshots dir, so a
 *   hostile `../` name cannot escape the directory.
 * - Destructive actions (`/snapshot restore`, `/restart`, `/update`,
 *   `/deny`) all need an explicit `--confirm`: the first call only explains
 *   what will happen and prints the exact confirmation command.
 * - The `paused` flag (`isPaused()`) is the public contract for the
 *   scheduler/heartbeat integration; this module only flips the flag and
 *   persists the preference. Wiring the flag into the scheduler is a
 *   coordinator follow-up.
 *
 * All handlers are pure-ish exported `handleXxx` functions over plain values
 * so they are unit-testable; the grammy wrappers in `registerSystemCommands`
 * are thin.
 */
import type { Bot, Context } from "grammy";
import { InputFile } from "grammy";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { HermesCommandDef, HermesCommandDeps } from "./cmd_context";
import {
  commandArg,
  gateGroup,
  gateUser,
  isOwnerSender,
  senderLang,
} from "./bot";
import type { UserPrefStore } from "./bot";
import type { Lang } from "../i18n/types";
import { tr, type SysLang } from "./cmd_system_strings";
import { estimateCost } from "../ai/usage";
import { REASONING_ENV_VAR, resolveReasoningEffort, type ReasoningEffort } from "../ai/reasoning";
import { loadPlugins } from "../plugins/loader";
import type { SkillCache } from "../skills/loader";
import type { McpManager } from "../mcp/bridge";
import type { Storage } from "../storage/storage";
import type { ToolService } from "../tools/service";
import type { ToolActor } from "../tools/types";
import type { UserAccessService } from "../auth/user_service";
import type { GroupAccessService } from "../groups/service";

// ---------------------------------------------------------------- defs ----

export const COMMAND_DEFS: HermesCommandDef[] = [
  { command: "snapshot", descriptionFa: "پشتیبان‌گیری از وضعیت", descriptionEn: "Backup / restore bot state", ownerOnly: true },
  { command: "restart", descriptionFa: "راه‌اندازی مجدد ربات", descriptionEn: "Restart the bot", ownerOnly: true },
  { command: "update", descriptionFa: "به‌روزرسانی بابی", descriptionEn: "Update BOBI from git", ownerOnly: true },
  { command: "debug", descriptionFa: "گزارش اشکال‌زدایی", descriptionEn: "Debug report", ownerOnly: true },
  { command: "usage", descriptionFa: "مصرف توکن", descriptionEn: "Token usage", ownerOnly: true },
  { command: "insights", descriptionFa: "تحلیل مصرف", descriptionEn: "Usage insights", ownerOnly: true },
  { command: "model", descriptionFa: "تغییر مدل", descriptionEn: "Switch the active model", ownerOnly: true },
  { command: "reasoning", descriptionFa: "سطح استدلال", descriptionEn: "Reasoning effort level", ownerOnly: true },
  { command: "autoprune", descriptionFa: "حذف خودکار نشست‌ها", descriptionEn: "Auto-prune sessions", ownerOnly: true },
  { command: "tools", descriptionFa: "مدیریت ابزارها", descriptionEn: "Manage tools", ownerOnly: true },
  { command: "skills", descriptionFa: "مدیریت مهارت‌ها", descriptionEn: "Manage skills", ownerOnly: true },
  { command: "curator", descriptionFa: "نگهداری حافظه", descriptionEn: "Memory curator", ownerOnly: true },
  { command: "plugins", descriptionFa: "افزونه‌ها", descriptionEn: "Plugins", ownerOnly: true },
  { command: "reload_mcp", descriptionFa: "بارگذاری مجدد MCP", descriptionEn: "Reload MCP servers", ownerOnly: true },
  { command: "reload_skills", descriptionFa: "اسکن مجدد مهارت‌ها", descriptionEn: "Rescan skills", ownerOnly: true },
  { command: "approve", descriptionFa: "تأیید درخواست", descriptionEn: "Approve a join request", ownerOnly: true },
  { command: "deny", descriptionFa: "رد درخواست", descriptionEn: "Reject a join request", ownerOnly: true },
  { command: "sethome", descriptionFa: "کانال اصلی", descriptionEn: "Set the home chat", ownerOnly: true },
  { command: "pause", descriptionFa: "توقف اضطراری", descriptionEn: "Emergency pause", ownerOnly: true },
];

// -------------------------------------------------------------- options ----

/** Result of running `git` — injected for tests. */
export interface GitResult {
  code: number;
  out: string;
  err: string;
}

/** Optional wiring the coordinator provides at registration time. */
export interface SystemCommandOpts {
  /** Absolute path of the SQLite database file. Coordinator wires config.dbPath. */
  dbPath?: string;
  /** Snapshots directory; default `BOBI_SNAPSHOT_DIR` or `./data/snapshots`. */
  snapshotDir?: string;
  /** Plugins directory; default `BOBI_PLUGINS_DIR` or `./plugins`. */
  pluginsDir?: string;
  /** The live MCP manager (index.ts). Absent = /reload_mcp reports unavailable. */
  mcp?: McpManager;
  /** The live skill cache (index.ts). Absent = /skills and /reload_skills report unavailable. */
  skills?: SkillCache;
  /** True while any conversation turn is running. Coordinator wires a reader. */
  isAnyTurnRunning?: () => boolean;
  now?: () => number;
  /** Exit hook (default: process.exit) — the service manager restarts us. */
  exit?: (code: number) => void;
  /** Git runner (default: Bun.spawn). Injected in tests. */
  execGit?: (args: string[], cwd: string, timeoutMs: number) => Promise<GitResult>;
}

interface ResolvedOpts extends Required<
  Pick<SystemCommandOpts, "snapshotDir" | "pluginsDir" | "now" | "exit" | "execGit">
> {
  dbPath: string;
  mcp?: McpManager;
  skills?: SkillCache;
  isAnyTurnRunning?: () => boolean;
}

function resolveOpts(opts: SystemCommandOpts = {}): ResolvedOpts {
  return {
    dbPath: opts.dbPath ?? "",
    snapshotDir:
      opts.snapshotDir ??
      ((process.env.BOBI_SNAPSHOT_DIR ?? "").trim() || "./data/snapshots"),
    pluginsDir:
      opts.pluginsDir ??
      ((process.env.BOBI_PLUGINS_DIR ?? "").trim() || "./plugins"),
    now: opts.now ?? Date.now,
    exit: opts.exit ?? ((code: number) => process.exit(code)),
    execGit: opts.execGit ?? defaultExecGit,
    ...(opts.mcp !== undefined ? { mcp: opts.mcp } : {}),
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
    ...(opts.isAnyTurnRunning !== undefined
      ? { isAnyTurnRunning: opts.isAnyTurnRunning }
      : {}),
  };
}

/** The handler-level environment: plain values, no grammy context. */
export interface SystemEnv {
  ownerId: string;
  chatId?: string;
  storage: Storage;
  tools?: ToolService;
  prefs?: UserPrefStore;
  users?: UserAccessService;
  groups?: GroupAccessService;
  opts: ResolvedOpts;
  version: string;
}

export interface SystemResult {
  text: string;
  /** True when the wrapper must reply and then restart the process. */
  restart?: boolean;
}

// -------------------------------------------------------------- helpers ----

function toSysLang(lang: Lang): SysLang {
  return lang === "en" ? "en" : "fa";
}

async function safeReply(
  ctx: { reply(text: string): Promise<unknown> },
  text: string,
): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // The owner may have blocked the bot; that is not an error.
  }
}

/** Default git runner: Bun.spawn with a hard timeout. Never throws. */
async function defaultExecGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Already gone.
        }
      }, timeoutMs);
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code, out, err };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (e) {
    return { code: 127, out: "", err: String(e) };
  }
}

/** Last N lines of a text blob, for /update's git output tail. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n").trim();
}

/** YYYYMMDD-HHmmss in the local timezone — used as the default snapshot name. */
export function snapshotTimestamp(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Validate a snapshot name.
 *
 * SECURITY: only ASCII letters/digits/dot/dash/underscore, starting with a
 * letter or digit, max 64 chars, no "..". The name is always joined under the
 * snapshots directory, so a traversal attempt is rejected before any fs call.
 */
export function sanitizeSnapshotName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length === 0 || name.length > 64) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  if (name.includes("..")) return undefined;
  return name;
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatFaDate(ms: number): string {
  return new Date(ms).toLocaleString("fa-IR");
}

// ------------------------------------------------------------ /snapshot ----

export interface SnapshotEnv {
  dbPath: string;
  snapshotDir: string;
}

/** SQLite sidecar files that must travel with the snapshot (WAL mode). */
const SNAPSHOT_SIDECARS = ["-wal", "-shm"] as const;

export function handleSnapshotCreate(
  lang: SysLang,
  env: SnapshotEnv,
  nameArg: string | undefined,
  nowMs: number,
): SystemResult {
  if (env.dbPath === "" || env.dbPath === ":memory:") {
    return { text: tr(lang, "cmd_system.snapshot.no_db") };
  }
  const name =
    nameArg === undefined
      ? `bobi-${snapshotTimestamp(nowMs)}`
      : sanitizeSnapshotName(nameArg);
  if (name === undefined) {
    return { text: tr(lang, "cmd_system.snapshot.bad_name") };
  }
  try {
    mkdirSync(resolve(env.snapshotDir), { recursive: true });
    const dest = resolve(env.snapshotDir, `${name}.db`);
    copyFileSync(env.dbPath, dest);
    for (const suffix of SNAPSHOT_SIDECARS) {
      const sidecar = `${env.dbPath}${suffix}`;
      if (existsSync(sidecar)) {
        copyFileSync(sidecar, `${dest}${suffix}`);
      }
    }
    const size = formatBytes(statSync(dest).size);
    return { text: tr(lang, "cmd_system.snapshot.created", { name, size }) };
  } catch (e) {
    return {
      text: tr(lang, "cmd_system.snapshot.create_failed", {
        reason: e instanceof Error ? e.message : String(e),
      }),
    };
  }
}

export interface SnapshotEntry {
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export function listSnapshots(dir: string): SnapshotEntry[] {
  const abs = resolve(dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      const st = statSync(join(abs, f));
      return {
        name: f.slice(0, -3),
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function handleSnapshotList(lang: SysLang, dir: string): SystemResult {
  try {
    const entries = listSnapshots(dir);
    if (entries.length === 0) {
      return { text: tr(lang, "cmd_system.snapshot.empty") };
    }
    const lines = entries.map((e) =>
      tr(lang, "cmd_system.snapshot.list_item", {
        name: e.name,
        size: formatBytes(e.sizeBytes),
        when: formatFaDate(e.mtimeMs),
      }),
    );
    return {
      text: [tr(lang, "cmd_system.snapshot.list_title"), ...lines].join("\n"),
    };
  } catch (e) {
    return {
      text: tr(lang, "cmd_system.snapshot.list_failed", {
        reason: e instanceof Error ? e.message : String(e),
      }),
    };
  }
}

export function handleSnapshotRestore(
  lang: SysLang,
  env: SnapshotEnv,
  nameArg: string | undefined,
  turnRunning: boolean,
  confirmed: boolean,
): SystemResult {
  const name =
    nameArg === undefined ? undefined : sanitizeSnapshotName(nameArg);
  if (name === undefined) {
    return { text: tr(lang, "cmd_system.snapshot.bad_name") };
  }
  const src = resolve(env.snapshotDir, `${name}.db`);
  if (!existsSync(src)) {
    return { text: tr(lang, "cmd_system.snapshot.not_found", { name }) };
  }
  // DESTRUCTIVE + open-db replace: never while a turn holds the database.
  if (turnRunning) {
    return { text: tr(lang, "cmd_system.snapshot.turn_running") };
  }
  if (!confirmed) {
    return {
      text: tr(lang, "cmd_system.snapshot.restore_confirm", { name }),
    };
  }
  try {
    copyFileSync(src, env.dbPath);
    for (const suffix of SNAPSHOT_SIDECARS) {
      const sidecar = `${src}${suffix}`;
      const dest = `${env.dbPath}${suffix}`;
      if (existsSync(sidecar)) {
        copyFileSync(sidecar, dest);
      }
    }
    return { text: tr(lang, "cmd_system.snapshot.restored", { name }) };
  } catch (e) {
    return {
      text: tr(lang, "cmd_system.snapshot.restore_failed", {
        reason: e instanceof Error ? e.message : String(e),
      }),
    };
  }
}

/** `/snapshot [create [name] | list | restore <name> [--confirm]]`. */
export function handleSnapshot(
  lang: SysLang,
  env: SnapshotEnv,
  arg: string | undefined,
  turnRunning: boolean,
  nowMs: number,
): SystemResult {
  const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "list").toLowerCase();
  const confirmed = parts.includes("--confirm");
  const rest = parts.filter((p) => p !== "--confirm").slice(1).join(" ") || undefined;
  if (sub === "create") {
    return handleSnapshotCreate(lang, env, rest, nowMs);
  }
  if (sub === "restore") {
    return handleSnapshotRestore(lang, env, rest, turnRunning, confirmed);
  }
  if (sub === "list") {
    return handleSnapshotList(lang, env.snapshotDir);
  }
  return { text: tr(lang, "cmd_system.snapshot.usage") };
}

// ------------------------------------------------------------- /restart ----

export interface RestartInput {
  turnRunning: boolean;
  force: boolean;
  confirmed: boolean;
}

/**
 * `/restart [--force] [--confirm]`.
 *
 * The wrapper replies with the result text and, on `restart: true`, waits a
 * second so Telegram delivers the reply, then exits(0); the service manager
 * (systemd) brings the bot back up.
 */
export function handleRestart(lang: SysLang, input: RestartInput): SystemResult {
  if (input.turnRunning && !input.force) {
    return { text: tr(lang, "cmd_system.restart.turn_running") };
  }
  if (!input.confirmed) {
    return { text: tr(lang, "cmd_system.restart.confirm") };
  }
  return { text: tr(lang, "cmd_system.restart.done"), restart: true };
}

// -------------------------------------------------------------- /update ----

export interface UpdateEnv {
  execGit: (args: string[], cwd: string, timeoutMs: number) => Promise<GitResult>;
  repoDir: string;
}

/**
 * `/update [--confirm]`.
 *
 * Runs `git pull --ff-only` in the repo dir via Bun.spawn (60s timeout),
 * reports the stdout/stderr tail, then restarts like /restart.
 * `--ff-only` never auto-merges; a failed pull never restarts.
 *
 * TRUST ASSUMPTION: git runs as the service user against the owner's own
 * remote. The owner must trust their remote — a malicious remote ref could
 * ship hostile code that runs with the bot's privileges on restart.
 */
export async function handleUpdate(
  lang: SysLang,
  env: UpdateEnv,
  confirmed: boolean,
): Promise<SystemResult> {
  if (!confirmed) {
    return { text: tr(lang, "cmd_system.update.confirm") };
  }
  try {
    const repo = await env.execGit(
      ["rev-parse", "--is-inside-work-tree"],
      env.repoDir,
      10_000,
    );
    if (repo.code !== 0) {
      return { text: tr(lang, "cmd_system.update.no_repo") };
    }
    const pull = await env.execGit(
      ["pull", "--ff-only"],
      env.repoDir,
      60_000,
    );
    const tail = tailLines(`${pull.out}\n${pull.err}`, 25);
    if (pull.code !== 0) {
      return { text: tr(lang, "cmd_system.update.failed", { tail }) };
    }
    return { text: tr(lang, "cmd_system.update.ok", { tail }), restart: true };
  } catch (e) {
    return {
      text: tr(lang, "cmd_system.update.error", {
        reason: e instanceof Error ? e.message : String(e),
      }),
    };
  }
}
// --------------------------------------------------------------- /debug ----

/**
 * Secret patterns scrubbed from /debug output before anything leaves the
 * machine. The bundle is delivered to the owner in chat, so anything matching
 * one of these is replaced with `[redacted]`.
 *
 * Documented scrub list (see docs/phase-commands-system.md):
 *  1. OpenAI-style keys:        sk-[A-Za-z0-9._~-]{8,}
 *  2. Telegram bot tokens:      123456:ABC-DEF... (>=30 chars after the colon)
 *  3. GitHub tokens:            ghp_|gho_|ghu_|ghs_|ghr_ + 20+ alnum chars
 *  4. Slack tokens:             xox[baprs]-...
 *  5. AWS access keys:          AKIA + 16 alnum chars
 *  6. Generic key=value pairs:  api_key=..., token: ..., password=..., ...
 *  7. JSON "apiKey": "..." style fields
 *  8. Authorization: Bearer ... headers
 */
const SCRUB_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9._~-]{8,}/g,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  /\bgh[opurs]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /("(?:apiKey|api_key|token|secret|password)"\s*:\s*)"[^"]*"/gi,
  /((?:api[_-]?key|apikey|token|secret|password|passwd|pwd|bearer|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~-]{8,}/g,
];

/** Replace every secret-looking span with `[redacted]`. Pure, for tests. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SCRUB_PATTERNS) {
    out = out.replace(re, (m, prefix) =>
      typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]",
    );
  }
  return out;
}

export interface DebugInfo {
  version: string;
  uptimeSec: number;
  providerLabel?: string;
  modelLabel?: string;
  pendingUsers: number;
  approvedUsers: number;
  pendingGroups: number;
  approvedGroups: number;
  /** Recent log lines, if a log file is configured. Already scrubbed by the caller. */
  logTail?: string;
}

function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Build the debug report Markdown. Never throws; scrubbed before delivery. */
export function buildDebugMarkdown(lang: SysLang, info: DebugInfo): string {
  const rows: Array<[string, string]> = [
    ["version", info.version],
    ["uptime", formatUptime(info.uptimeSec)],
    ["provider", info.providerLabel ?? "—"],
    ["model", info.modelLabel ?? "—"],
    ["pending_users", String(info.pendingUsers)],
    ["approved_users", String(info.approvedUsers)],
    ["pending_groups", String(info.pendingGroups)],
    ["approved_groups", String(info.approvedGroups)],
  ];
  const lines = [
    `# ${tr(lang, "cmd_system.debug.title")}`,
    "",
    ...rows.map(([label, value]) =>
      tr(lang, "cmd_system.debug.row", { label, value }),
    ),
  ];
  if (info.logTail !== undefined && info.logTail.trim().length > 0) {
    lines.push("", "```", scrubSecrets(info.logTail).slice(0, 6000), "```");
  }
  return lines.join("\n");
}

/** Read the last `maxLines` of a log file, bounded to `maxBytes`. */
export function readLogTail(
  path: string,
  maxLines = 50,
  maxBytes = 65536,
): string | undefined {
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - maxBytes);
    const text = readFileSync(path, "utf8").slice(start > 0 ? st.size - start : 0);
    // NOTE: readFileSync reads whole file; the slice above approximates the
    // tail for very large logs. Bounded by line count below.
    return text.split("\n").slice(-maxLines).join("\n");
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------- /usage ----

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

export interface UsageModelRow extends UsageTotals {
  modelId: string;
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function handleUsage(
  lang: SysLang,
  today: UsageTotals & { costUsd: number },
  week: UsageTotals & { costUsd: number },
  topModels: UsageModelRow[],
): string {
  const lines = [
    `📊 ${tr(lang, "cmd_system.usage.today")}`,
    tr(lang, "cmd_system.usage.tokens", {
      input: formatNum(today.inputTokens),
      output: formatNum(today.outputTokens),
      runs: formatNum(today.runs),
    }),
    tr(lang, "cmd_system.usage.cost", { cost: today.costUsd.toFixed(4) }),
    "",
    `📊 ${tr(lang, "cmd_system.usage.week")}`,
    tr(lang, "cmd_system.usage.tokens", {
      input: formatNum(week.inputTokens),
      output: formatNum(week.outputTokens),
      runs: formatNum(week.runs),
    }),
    tr(lang, "cmd_system.usage.cost", { cost: week.costUsd.toFixed(4) }),
  ];
  if (topModels.length > 0) {
    lines.push("", tr(lang, "cmd_system.usage.by_model"));
    for (const m of topModels.slice(0, 5)) {
      lines.push(
        tr(lang, "cmd_system.usage.model_item", {
          model: m.modelId,
          tokens: formatNum(m.inputTokens + m.outputTokens),
          runs: formatNum(m.runs),
        }),
      );
    }
  }
  lines.push("", tr(lang, "cmd_system.usage.disclaimer"));
  return lines.join("\n");
}

// ------------------------------------------------------------ /insights ----

export interface InsightDay extends UsageTotals {
  /** ISO date label, e.g. 2026-10-18. */
  day: string;
}

function trendLine(lang: SysLang, curTokens: number, prevTokens: number): string {
  if (prevTokens <= 0 || curTokens <= 0) {
    return tr(lang, "cmd_system.insights.trend_flat");
  }
  const pct = Math.round((Math.abs(curTokens - prevTokens) / prevTokens) * 100);
  if (pct < 5) return tr(lang, "cmd_system.insights.trend_flat");
  return curTokens > prevTokens
    ? tr(lang, "cmd_system.insights.trend_up", { pct })
    : tr(lang, "cmd_system.insights.trend_down", { pct });
}

export function handleInsights(
  lang: SysLang,
  days: number,
  cur: InsightDay[],
  prev: UsageTotals,
  topModels: UsageModelRow[],
): string {
  const curTokens = cur.reduce((s, d) => s + d.inputTokens + d.outputTokens, 0);
  const prevTokens = prev.inputTokens + prev.outputTokens;
  const lines = [
    tr(lang, "cmd_system.insights.title", { days }),
    "",
    trendLine(lang, curTokens, prevTokens),
    "",
  ];
  for (const d of cur) {
    lines.push(
      tr(lang, "cmd_system.insights.day_item", {
        day: d.day,
        tokens: formatNum(d.inputTokens + d.outputTokens),
        runs: formatNum(d.runs),
      }),
    );
  }
  if (topModels.length > 0) {
    lines.push("", tr(lang, "cmd_system.usage.by_model"));
    for (const m of topModels.slice(0, 5)) {
      lines.push(
        tr(lang, "cmd_system.usage.model_item", {
          model: m.modelId,
          tokens: formatNum(m.inputTokens + m.outputTokens),
          runs: formatNum(m.runs),
        }),
      );
    }
  }
  lines.push("", tr(lang, "cmd_system.usage.disclaimer"));
  return lines.join("\n");
}

// --------------------------------------------------------------- /model ----

export interface ModelListItem {
  providerLabel: string;
  label: string;
  modelId: string;
  enabled: boolean;
  isActive: boolean;
}

export function handleModelShow(
  lang: SysLang,
  current: { providerLabel?: string; modelLabel?: string },
  models: ModelListItem[],
): string {
  const lines = [
    tr(lang, "cmd_system.model.current", {
      model: current.modelLabel ?? "—",
      provider: current.providerLabel ?? "—",
    }),
  ];
  if (models.length > 0) {
    lines.push(tr(lang, "cmd_system.model.available"));
    for (const m of models) {
      lines.push(
        tr(lang, "cmd_system.model.item", {
          label: m.label,
          id: m.modelId,
          mark: m.isActive
            ? tr(lang, "cmd_system.model.active_mark")
            : m.enabled
              ? ""
              : tr(lang, "cmd_system.tools.disabled"),
        }),
      );
    }
  }
  return lines.join("\n");
}

/**
 * The storage surface /model needs. There is no service-level "switch model"
 * method; the canonical path (see `ai_controller.ts` `ai_select_model`) is:
 * validate the model + provider are enabled, then
 * `storage.setRuntimeSelection(...)`. This command replicates exactly that
 * validation, owner-gated at the handler level.
 */
export type ModelSwitchStorage = Pick<
  Storage,
  "listProviders" | "listModels" | "getProvider" | "setRuntimeSelection"
>;

export function handleModelSwitch(
  lang: SysLang,
  storage: ModelSwitchStorage,
  name: string,
): SystemResult {
  const needle = name.trim().toLowerCase();
  for (const provider of storage.listProviders()) {
    for (const model of storage.listModels(provider.id)) {
      if (
        model.label.toLowerCase() !== needle &&
        model.modelId.toLowerCase() !== needle
      ) {
        continue;
      }
      if (!model.enabled || !provider.enabled) {
        return { text: tr(lang, "cmd_system.model.disabled") };
      }
      storage.setRuntimeSelection({ providerId: provider.id, modelId: model.id });
      return { text: tr(lang, "cmd_system.model.switched", { label: model.label }) };
    }
  }
  return { text: tr(lang, "cmd_system.model.not_found", { name: name.trim() }) };
}

// ----------------------------------------------------------- /reasoning ----

/**
 * Reasoning effort policy: the adapters read `resolveReasoningEffort()`
 * (env `BOBI_REASONING_EFFORT`) on EVERY request, so there is no per-call
 * seam a per-user pref could plug into without changing the adapters.
 *
 * `/reasoning` therefore:
 * - shows the current effective level (what the next request will use),
 * - stores the owner's choice in the `reasoning_effort` user_pref as a
 *   STAGED value, and says plainly that a live change needs the env var
 *   set plus a process restart.
 *
 * Be honest about it: the pref does not change live behavior by itself.
 */
export const REASONING_PREF_KEY = "reasoning_effort";

const REASONING_LEVELS: readonly ReasoningEffort[] = [
  "off",
  "low",
  "medium",
  "high",
];

function parseReasoningLevel(raw: string): ReasoningEffort | undefined {
  const v = raw.trim().toLowerCase();
  return (REASONING_LEVELS as readonly string[]).includes(v)
    ? (v as ReasoningEffort)
    : undefined;
}

export function handleReasoningShow(
  lang: SysLang,
  stored: string | undefined,
): string {
  const lines = [
    tr(lang, "cmd_system.reasoning.show", {
      effective: resolveReasoningEffort(),
      env: REASONING_ENV_VAR,
    }),
  ];
  if (stored !== undefined) {
    lines.push("", tr(lang, "cmd_system.reasoning.stored", { value: stored }));
  }
  return lines.join("\n");
}

export function handleReasoningSet(
  lang: SysLang,
  prefs: UserPrefStore,
  ownerId: string,
  raw: string,
): string {
  const level = parseReasoningLevel(raw);
  if (level === undefined) {
    return tr(lang, "cmd_system.reasoning.bad");
  }
  prefs.setUserPref(ownerId, REASONING_PREF_KEY, level);
  return tr(lang, "cmd_system.reasoning.set", {
    value: level,
    env: REASONING_ENV_VAR,
  });
}

// ----------------------------------------------------------- /autoprune ----

/**
 * Auto-prune preference. The actual pruning job is a documented coordinator
 * follow-up — this command only records the owner's intent in the
 * `autoprune` pref ("off" | "on:<days>").
 */
export const AUTOPRUNE_PREF_KEY = "autoprune";

export interface AutopruneState {
  on: boolean;
  days: number;
}

export function parseAutoprune(value: string | undefined): AutopruneState {
  if (value === undefined) return { on: false, days: 30 };
  const m = /^on:(\d+)$/.exec(value.trim());
  if (m !== null && m[1] !== undefined) {
    const days = Math.max(1, Math.min(365, Number(m[1])));
    return { on: true, days };
  }
  return { on: false, days: 30 };
}

export function handleAutopruneShow(lang: SysLang, state: AutopruneState): string {
  return state.on
    ? tr(lang, "cmd_system.autoprune.show_on", { days: state.days })
    : tr(lang, "cmd_system.autoprune.show_off");
}

export function handleAutopruneSet(
  lang: SysLang,
  prefs: UserPrefStore,
  ownerId: string,
  raw: string | undefined,
): string {
  const parts = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  const verb = (parts[0] ?? "").toLowerCase();
  if (verb === "off") {
    prefs.setUserPref(ownerId, AUTOPRUNE_PREF_KEY, "off");
    return tr(lang, "cmd_system.autoprune.set", { state: "off" });
  }
  if (verb === "on") {
    const days = parts[1] !== undefined ? Number(parts[1]) : 30;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return tr(lang, "cmd_system.autoprune.bad");
    }
    prefs.setUserPref(ownerId, AUTOPRUNE_PREF_KEY, `on:${days}`);
    return tr(lang, "cmd_system.autoprune.set", { state: `on (${days}d)` });
  }
  return tr(lang, "cmd_system.autoprune.bad");
}

// --------------------------------------------------------------- /tools ----

export interface ToolListItem {
  name: string;
  toolset?: string;
  enabled: boolean;
}

/**
 * `/tools`: list-only.
 *
 * GAP (documented, not worked around): `ToolRegistry` has no public
 * enable/disable method, so this command cannot toggle tools. Only
 * registration-time code decides enabled state.
 */
export function handleTools(
  lang: SysLang,
  tools: ToolService | undefined,
): string {
  if (tools === undefined) {
    return tr(lang, "cmd_system.tools.unavailable");
  }
  const descriptors = tools.listActive();
  const seen = new Set<string>();
  const items: ToolListItem[] = [];
  // Registry order is the display order; listActive() and registry.list()
  // cover the same catalog, so one pass suffices.
  for (const tool of tools.registry.list()) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const item: ToolListItem = { name: tool.name, enabled: tool.enabled };
    if (tool.toolset !== undefined) item.toolset = tool.toolset;
    items.push(item);
  }
  void descriptors;
  const lines = [
    tr(lang, "cmd_system.tools.title", { count: items.length }),
  ];
  for (const item of items) {
    lines.push(
      tr(lang, "cmd_system.tools.item", {
        name: item.name,
        toolset:
          item.toolset !== undefined
            ? tr(lang, "cmd_system.tools.toolset", { toolset: item.toolset })
            : "",
        state: item.enabled ? "" : tr(lang, "cmd_system.tools.disabled"),
      }),
    );
  }
  lines.push(tr(lang, "cmd_system.tools.note"));
  return lines.join("\n");
}

// -------------------------------------------------------------- /skills ----

function ownerToolActor(ownerId: string, permissions: readonly string[]): ToolActor {
  return { userId: ownerId, permissions };
}

export interface SkillListItem {
  name: string;
  description: string;
}

export function formatSkills(lang: SysLang, skills: SkillListItem[]): string {
  const lines = [
    tr(lang, "cmd_system.skills.title", { count: skills.length }),
  ];
  for (const s of skills) {
    lines.push(
      tr(lang, "cmd_system.skills.item", {
        name: s.name,
        description: s.description,
      }),
    );
  }
  return lines.join("\n");
}

/**
 * `/skills`: list installed skills, names + one-line descriptions only.
 *
 * Path 1 (preferred): run the registered `skills` tool through
 * ToolService.execute with an owner actor. Path 2 (fallback): read through
 * the SkillCache directly. Neither path returns skill bodies.
 */
export async function handleSkills(
  lang: SysLang,
  env: { tools?: ToolService; skills?: SkillCache; ownerId: string },
): Promise<string> {
  if (env.tools !== undefined) {
    try {
      const res = await env.tools.execute({
        tool: "skills",
        input: {},
        actor: ownerToolActor(env.ownerId, ["tools:skills"]),
      });
      const data = res.data as { skills?: SkillListItem[] } | undefined;
      if (res.status === "ok" && Array.isArray(data?.skills)) {
        return formatSkills(lang, data.skills);
      }
    } catch {
      // Fall through to the cache path.
    }
  }
  if (env.skills !== undefined) {
    return formatSkills(
      lang,
      env.skills.skills().map((s) => ({ name: s.name, description: s.description })),
    );
  }
  return tr(lang, "cmd_system.skills.unavailable");
}

// ------------------------------------------------------------- /curator ----

/**
 * `/curator status|run`.
 *
 * `status` reports the pending proposal count by running the
 * `curate_memories`... no — status must be read-only and cheap, so it goes
 * through the proposal store directly. `run` executes the `curate_memories`
 * tool with an owner actor (the tool itself only READS and stores proposals;
 * applying them stays in `curator_decide`).
 */
export function handleCuratorStatus(
  lang: SysLang,
  tools: ToolService | undefined,
  pendingCount: number,
): string {
  if (tools === undefined) {
    return tr(lang, "cmd_system.curator.unavailable");
  }
  return tr(lang, "cmd_system.curator.status", { count: pendingCount });
}

export async function handleCuratorRun(
  lang: SysLang,
  tools: ToolService | undefined,
  ownerId: string,
): Promise<string> {
  if (tools === undefined) {
    return tr(lang, "cmd_system.curator.unavailable");
  }
  try {
    const res = await tools.execute({
      tool: "curate_memories",
      input: {},
      actor: ownerToolActor(ownerId, ["tools:curate_memories"]),
    });
    if (res.status !== "ok") {
      return tr(lang, "cmd_system.curator.run_failed", {
        reason: res.message ?? res.status,
      });
    }
    const data = res.data as { count?: number } | undefined;
    return tr(lang, "cmd_system.curator.ran", { count: data?.count ?? 0 });
  } catch (e) {
    return tr(lang, "cmd_system.curator.run_failed", {
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

// ------------------------------------------------------------- /plugins ----

export interface PluginListItem {
  name: string;
  version: string;
  description: string;
}

/**
 * `/plugins`: list installed plugins from the plugins dir.
 * `loadPlugins` only parses markdown metadata — no plugin code is executed.
 */
export function handlePlugins(lang: SysLang, pluginsDir: string): string {
  const plugins: PluginListItem[] = loadPlugins(pluginsDir, {
    warn: () => {
      // Malformed plugin.md files are skipped by the loader; stay quiet here.
    },
  }).map((p) => ({ name: p.name, version: p.version, description: p.description }));
  if (plugins.length === 0) {
    return tr(lang, "cmd_system.plugins.empty");
  }
  const lines = [
    tr(lang, "cmd_system.plugins.title", { count: plugins.length }),
  ];
  for (const p of plugins) {
    lines.push(
      tr(lang, "cmd_system.plugins.item", {
        name: p.name,
        version: p.version,
        description: p.description,
      }),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------- /reload_mcp ----

/**
 * `/reload_mcp`: reload MCP servers.
 *
 * `McpManager` exposes no dedicated `reload()` method, so the reload is
 * `closeAll()` + `connectAll()` — real reconnection over the configured
 * server list, not a no-op. The manager's config set is unchanged, which
 * matches how the bridge is designed (configs come from mcp.json).
 */
export async function handleReloadMcp(
  lang: SysLang,
  mcp: McpManager | undefined,
): Promise<string> {
  if (mcp === undefined) {
    return tr(lang, "cmd_system.reload_mcp.unavailable");
  }
  try {
    await mcp.closeAll();
    await mcp.connectAll();
    return tr(lang, "cmd_system.reload_mcp.ok", {
      count: mcp.status().filter((s) => s.connected).length,
    });
  } catch (e) {
    return tr(lang, "cmd_system.reload_mcp.failed", {
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}

// ------------------------------------------------------- /reload_skills ----

/**
 * `/reload_skills`: rescan the skills directory.
 *
 * `SkillCache` has no explicit invalidate/reload method; `skills()` refreshes
 * automatically when the directory mtime changes. This command forces the
 * read-through and reports the count, so the owner gets confirmation.
 */
export function handleReloadSkills(
  lang: SysLang,
  skills: SkillCache | undefined,
): string {
  if (skills === undefined) {
    return tr(lang, "cmd_system.reload_skills.unavailable");
  }
  const count = skills.skills().length;
  return tr(lang, "cmd_system.reload_skills.ok", { count });
}

// -------------------------------------------------------- /approve /deny ----

/**
 * Approve/deny PENDING user & group join requests.
 *
 * REMAP NOTE (Hermes audit): Hermes's /approve & /deny approved *tool calls*
 * mid-turn. BOBI's actual pending-approval surface is the user/group access
 * gates (`UserAccessService` / `GroupAccessService`), so the semantics are
 * remapped here: the commands approve or reject pending join requests.
 * Documented in docs/phase-commands-system.md.
 *
 * Both actions are owner-only (handler level) and audit-logged via
 * `storage.appendAudit`.
 */
export type AccessKind = "user" | "group";

export interface PendingAccessItem {
  kind: AccessKind;
  id: string;
  label: string;
}

export interface AccessServices {
  users?: UserAccessService;
  groups?: GroupAccessService;
}

function accessServicesOf(deps: {
  users?: UserAccessService;
  groups?: GroupAccessService;
}): AccessServices {
  const out: AccessServices = {};
  if (deps.users !== undefined) out.users = deps.users;
  if (deps.groups !== undefined) out.groups = deps.groups;
  return out;
}

export function listPendingAccess(svc: AccessServices, limit = 8): PendingAccessItem[] {
  const out: PendingAccessItem[] = [];
  if (svc.users !== undefined) {
    for (const u of svc.users.listPending(limit)) {
      const name =
        [u.firstName, u.username !== undefined ? `@${u.username}` : ""]
          .filter(Boolean)
          .join(" ");
      out.push({ kind: "user", id: u.userId, label: name });
    }
  }
  if (svc.groups !== undefined) {
    for (const g of svc.groups.listPending(limit)) {
      out.push({
        kind: "group",
        id: g.chatId,
        label: g.title !== undefined ? ` «${g.title}»` : "",
      });
    }
  }
  return out;
}

export function handleAccessList(lang: SysLang, pending: PendingAccessItem[]): string {
  if (pending.length === 0) {
    return tr(lang, "cmd_system.access.none_pending");
  }
  const lines = [tr(lang, "cmd_system.access.pending_title")];
  for (const p of pending) {
    const name = p.label.length > 0 ? ` (${p.label})` : "";
    lines.push(
      p.kind === "user"
        ? tr(lang, "cmd_system.access.user_item", { id: p.id, name })
        : tr(lang, "cmd_system.access.group_item", { id: p.id, name }),
    );
  }
  return lines.join("\n");
}

export interface AccessDecisionInput {
  kind: AccessKind;
  id: string;
  approve: boolean;
  confirmed: boolean;
  ownerId: string;
}

export function handleAccessDecision(
  lang: SysLang,
  svc: AccessServices,
  storage: Storage,
  input: AccessDecisionInput,
): SystemResult {
  const cmd = input.approve ? "approve" : "deny";
  if (!input.confirmed) {
    const key = input.approve
      ? "cmd_system.access.need_confirm_approve"
      : "cmd_system.access.need_confirm_deny";
    return {
      text: tr(lang, key, { kind: input.kind, id: input.id, cmd }),
    };
  }
  const service = input.kind === "user" ? svc.users : svc.groups;
  if (service === undefined) {
    return { text: tr(lang, "cmd_system.access.bad_target", { cmd }) };
  }
  const transition = input.approve
    ? service.approve(input.id, input.ownerId)
    : service.reject(input.id, input.ownerId);
  try {
    storage.appendAudit({
      operation: input.approve ? "access.approve" : "access.reject",
      outcome: transition.ok ? "success" : "denied",
      actorId: input.ownerId,
      targetId: input.id,
      detail: input.kind,
    });
  } catch {
    // Audit failure must not block the decision itself.
  }
  if (!transition.ok) {
    return {
      text: tr(lang, "cmd_system.access.already", {
        id: input.id,
        reason: transition.reason,
      }),
    };
  }
  const key = input.approve
    ? "cmd_system.access.approved"
    : "cmd_system.access.denied";
  return { text: tr(lang, key, { kind: input.kind, id: input.id }) };
}

/**
 * Parse `/approve [user|group] <id> [--confirm]`.
 * Bare `/approve` → undefined (list pending).
 */
export function parseAccessTarget(
  arg: string | undefined,
): { kind: AccessKind; id: string; confirmed: boolean } | undefined {
  const parts = (arg ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const confirmed = parts.includes("--confirm");
  const rest = parts.filter((p) => p !== "--confirm");
  if (rest.length < 2) return undefined;
  const kind = rest[0]!.toLowerCase();
  if (kind !== "user" && kind !== "group") return undefined;
  const id = rest[1]!.trim();
  if (id.length === 0 || id.length > 64) return undefined;
  return { kind, id, confirmed };
}

// ------------------------------------------------------------- /sethome ----

/** The owner-pref key marking the home chat for proactive notifications. */
export const HOME_CHAT_PREF_KEY = "home_chat_id";

export function handleSetHome(
  lang: SysLang,
  prefs: UserPrefStore | undefined,
  ownerId: string,
  chatId: string,
): string {
  if (prefs === undefined) {
    return tr(lang, "cmd_system.sethome.no_prefs");
  }
  prefs.setUserPref(ownerId, HOME_CHAT_PREF_KEY, chatId);
  return tr(lang, "cmd_system.sethome.ok");
}

// ---------------------------------------------------------------- /pause ----

/**
 * Emergency pause flag.
 *
 * This module is the contract owner: `isPaused()` is the exported reader the
 * scheduler/heartbeat will consult, and the `paused` user_pref persists the
 * choice across restarts. Wiring the flag into the scheduler and heartbeat
 * loop is a coordinator follow-up — this command only flips and persists it.
 */
export const PAUSED_PREF_KEY = "paused";

let pausedFlag = false;

/** True while the owner has engaged the emergency pause. */
export function isPaused(): boolean {
  return pausedFlag;
}

/** Set the pause flag directly (registration restores it from prefs). */
export function setPaused(value: boolean): void {
  pausedFlag = value;
}

export function handlePause(
  lang: SysLang,
  prefs: UserPrefStore | undefined,
  ownerId: string,
  raw: string | undefined,
): string {
  const verb = (raw ?? "").trim().toLowerCase();
  if (verb === "on") {
    setPaused(true);
    prefs?.setUserPref(ownerId, PAUSED_PREF_KEY, "1");
    return tr(lang, "cmd_system.pause.on");
  }
  if (verb === "off") {
    setPaused(false);
    prefs?.setUserPref(ownerId, PAUSED_PREF_KEY, "0");
    return tr(lang, "cmd_system.pause.off");
  }
  return tr(lang, "cmd_system.pause.bad");
}

// ------------------------------------------------------ registration ----

/** Minimal proposal-store surface /curator status needs. */
export interface ProposalStoreLike {
  listPending(userId: string): unknown[];
}

export interface RegisterOpts extends SystemCommandOpts {
  /** Pending-proposal store (index.ts wires ProposalStore). */
  proposalStore?: ProposalStoreLike;
}

interface ResolvedRegisterOpts extends ResolvedOpts {
  proposalStore?: ProposalStoreLike;
}

function resolveRegisterOpts(opts: RegisterOpts = {}): ResolvedRegisterOpts {
  const base = resolveOpts(opts);
  return opts.proposalStore !== undefined
    ? { ...base, proposalStore: opts.proposalStore }
    : base;
}

/**
 * Owner check, run FIRST in every handler — before the group/user gates.
 * Non-owners get the Persian owner-only reply (never silent, never a throw).
 * Exported so tests can exercise the exact preamble every wrapper runs.
 */
export async function checkOwner(
  ctx: Context,
  deps: HermesCommandDeps,
  lang: SysLang,
): Promise<boolean> {
  if (isOwnerSender(ctx, deps)) return true;
  await safeReply(ctx, tr(lang, "cmd_system.owner_only"));
  return false;
}

function messageArg(ctx: Context): string | undefined {
  const text = ctx.message?.text;
  return text !== undefined ? commandArg(text) : undefined;
}

function flagSet(arg: string | undefined, flag: string): boolean {
  return (
    arg !== undefined &&
    arg
      .split(/\s+/)
      .some((p) => p.toLowerCase() === flag)
  );
}

function startOfTodayMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function audit(
  storage: Storage,
  event: {
    operation: string;
    outcome: "success" | "denied" | "error";
    actorId?: string;
    targetId?: string;
    detail?: string;
  },
): void {
  try {
    storage.appendAudit(event);
  } catch {
    // Audit is best-effort; never break the command.
  }
}

/**
 * Register all system/owner commands on the grammy bot.
 *
 * The coordinator calls this from `createBot` alongside the sibling command
 * modules. Optional live services (MCP manager, skill cache, proposal store,
 * db path, turn-running reader) come through `opts`; commands whose service
 * is absent answer with an honest "not available" instead of failing.
 */
export function registerSystemCommands(
  bot: Bot,
  deps: HermesCommandDeps,
  opts: RegisterOpts = {},
): void {
  const o = resolveRegisterOpts(opts);

  // Restore the pause flag from the owner's persisted preference.
  if (deps.prefs !== undefined && deps.ownerId !== undefined) {
    try {
      const stored = deps.prefs.getUserPref(
        String(deps.ownerId),
        PAUSED_PREF_KEY,
      );
      setPaused(stored === "1");
    } catch {
      // A failed read keeps the flag off (fail closed = running).
    }
  }

  const envOf = (ownerId: string, chatId?: string): SystemEnv => ({
    ownerId,
    ...(chatId !== undefined ? { chatId } : {}),
    storage: deps.storage,
    ...(deps.tools !== undefined ? { tools: deps.tools } : {}),
    ...(deps.prefs !== undefined ? { prefs: deps.prefs } : {}),
    ...(deps.users !== undefined ? { users: deps.users } : {}),
    ...(deps.groups !== undefined ? { groups: deps.groups } : {}),
    opts: o,
    version: deps.version ?? "?",
  });

  /** Common preamble: owner check, then the standard gates. */
  const gate = async (
    ctx: Context,
    lang: SysLang,
  ): Promise<{ env: SystemEnv } | undefined> => {
    if (!(await checkOwner(ctx, deps, lang))) return undefined;
    if (!(await gateGroup(ctx, deps.groups, lang))) return undefined;
    if (!(await gateUser(ctx, deps))) return undefined;
    const ownerId = ctx.from !== undefined ? String(ctx.from.id) : "";
    const chatId = ctx.chat !== undefined ? String(ctx.chat.id) : undefined;
    return { env: envOf(ownerId, chatId) };
  };

  const doRestart = async (ctx: Context, result: SystemResult): Promise<void> => {
    await safeReply(ctx, result.text);
    if (result.restart === true) {
      setTimeout(() => o.exit(0), 1000);
    }
  };

  // ------------------------------------------------------- /snapshot ----
  bot.command("snapshot", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const arg = messageArg(ctx);
    const result = handleSnapshot(
      lang,
      { dbPath: o.dbPath, snapshotDir: o.snapshotDir },
      arg,
      o.isAnyTurnRunning?.() ?? false,
      o.now(),
    );
    if (
      arg !== undefined &&
      arg.toLowerCase().startsWith("restore") &&
      flagSet(arg, "--confirm")
    ) {
      audit(deps.storage, {
        operation: "snapshot.restore",
        outcome: "success",
        actorId: g.env.ownerId,
      });
    }
    await safeReply(ctx, result.text);
  });

  // -------------------------------------------------------- /restart ----
  bot.command("restart", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const arg = messageArg(ctx);
    const result = handleRestart(lang, {
      turnRunning: o.isAnyTurnRunning?.() ?? false,
      force: flagSet(arg, "--force"),
      confirmed: flagSet(arg, "--confirm"),
    });
    audit(deps.storage, {
      operation: "bot.restart",
      outcome: result.restart === true ? "success" : "denied",
      actorId: g.env.ownerId,
      detail: result.restart === true ? "confirmed" : "refused",
    });
    await doRestart(ctx, result);
  });

  // --------------------------------------------------------- /update ----
  bot.command("update", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const arg = messageArg(ctx);
    const result = await handleUpdate(
      lang,
      { execGit: o.execGit, repoDir: process.cwd() },
      flagSet(arg, "--confirm"),
    );
    audit(deps.storage, {
      operation: "bot.update",
      outcome: result.restart === true ? "success" : "denied",
      actorId: g.env.ownerId,
    });
    await doRestart(ctx, result);
  });

  // ---------------------------------------------------------- /debug ----
  bot.command("debug", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const storage = deps.storage;
    const rs = storage.getRuntimeSettings();
    const provider =
      rs.activeProviderId != null
        ? storage.getProvider(rs.activeProviderId)
        : undefined;
    const model =
      rs.activeModelId != null
        ? storage.getModel(rs.activeModelId)
        : undefined;
    const logFile = (process.env.BOBI_LOG_FILE ?? "").trim();
    const logTail = logFile.length > 0 ? readLogTail(logFile) : undefined;
    const info: DebugInfo = {
      version: g.env.version,
      uptimeSec: process.uptime(),
      pendingUsers: deps.users?.countPending() ?? 0,
      approvedUsers: deps.users?.countApproved() ?? 0,
      pendingGroups: deps.groups?.countPending() ?? 0,
      approvedGroups: deps.groups?.countApproved() ?? 0,
    };
    if (provider !== undefined) info.providerLabel = provider.label;
    if (model !== undefined) info.modelLabel = model.label;
    if (logTail !== undefined) info.logTail = logTail;
    const markdown = buildDebugMarkdown(lang, info);
    const filename = `bobi-debug-${snapshotTimestamp(o.now())}.md`;
    try {
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(markdown, "utf8"), filename),
      );
    } catch {
      await safeReply(ctx, markdown.slice(0, 4000));
    }
  });

  // ---------------------------------------------------------- /usage ----
  bot.command("usage", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const storage = deps.storage;
    const todayStart = startOfTodayMs(o.now());
    const weekStart = todayStart - 6 * 86400000;
    const costOf = (rows: UsageModelRow[]): number =>
      rows.reduce(
        (s, r) =>
          s + estimateCost(r.inputTokens, r.outputTokens, r.modelId).usd,
        0,
      );
    const todayRows = storage.usageByModelAll(todayStart);
    const weekRows = storage.usageByModelAll(weekStart);
    const today = storage.usageTotalsAll(todayStart);
    const week = storage.usageTotalsAll(weekStart);
    await safeReply(
      ctx,
      handleUsage(
        lang,
        { ...today, costUsd: costOf(todayRows) },
        { ...week, costUsd: costOf(weekRows) },
        weekRows,
      ),
    );
  });

  // ------------------------------------------------------- /insights ----
  bot.command("insights", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const rawDays = Number((messageArg(ctx) ?? "").trim());
    const days = Number.isInteger(rawDays)
      ? Math.max(1, Math.min(30, rawDays))
      : 7;
    const storage = deps.storage;
    const now = o.now();
    const todayStart = startOfTodayMs(now);
    const windowTotals = (sinceMs: number, untilMs?: number): UsageTotals => {
      const a = storage.usageTotalsAll(sinceMs);
      if (untilMs === undefined) return a;
      const b = storage.usageTotalsAll(untilMs);
      return {
        inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
        outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
        runs: Math.max(0, a.runs - b.runs),
      };
    };
    const cur: InsightDay[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = todayStart - i * 86400000;
      cur.push({
        day: isoDay(start),
        ...windowTotals(start, start + 86400000),
      });
    }
    const prev = windowTotals(
      todayStart - days * 86400000,
      todayStart,
    );
    const byModel = storage.usageByModelAll(todayStart - days * 86400000);
    await safeReply(ctx, handleInsights(lang, days, cur, prev, byModel));
  });

  // ---------------------------------------------------------- /model ----
  bot.command("model", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const storage = deps.storage;
    const name = messageArg(ctx);
    if (name === undefined) {
      const rs = storage.getRuntimeSettings();
      const provider =
        rs.activeProviderId != null
          ? storage.getProvider(rs.activeProviderId)
          : undefined;
      const model =
        rs.activeModelId != null
          ? storage.getModel(rs.activeModelId)
          : undefined;
      const items: ModelListItem[] = [];
      for (const p of storage.listProviders()) {
        for (const m of storage.listModels(p.id)) {
          items.push({
            providerLabel: p.label,
            label: m.label,
            modelId: m.modelId,
            enabled: m.enabled,
            isActive: m.id === rs.activeModelId,
          });
        }
      }
      await safeReply(
        ctx,
        handleModelShow(
          lang,
          {
            ...(provider !== undefined ? { providerLabel: provider.label } : {}),
            ...(model !== undefined ? { modelLabel: model.label } : {}),
          },
          items,
        ),
      );
      return;
    }
    const result = handleModelSwitch(lang, storage, name);
    await safeReply(ctx, result.text);
  });

  // ------------------------------------------------------ /reasoning ----
  bot.command("reasoning", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const arg = messageArg(ctx);
    if (arg === undefined) {
      const stored = deps.prefs?.getUserPref(g.env.ownerId, REASONING_PREF_KEY);
      await safeReply(ctx, handleReasoningShow(lang, stored));
      return;
    }
    if (deps.prefs === undefined) {
      await safeReply(ctx, tr(lang, "cmd_system.prefs.unavailable"));
      return;
    }
    await safeReply(
      ctx,
      handleReasoningSet(lang, deps.prefs, g.env.ownerId, arg),
    );
  });

  // ------------------------------------------------------ /autoprune ----
  bot.command("autoprune", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const arg = messageArg(ctx);
    if (deps.prefs === undefined) {
      await safeReply(ctx, tr(lang, "cmd_system.prefs.unavailable"));
      return;
    }
    if (arg === undefined) {
      const state = parseAutoprune(
        deps.prefs.getUserPref(g.env.ownerId, AUTOPRUNE_PREF_KEY),
      );
      await safeReply(ctx, handleAutopruneShow(lang, state));
      return;
    }
    await safeReply(
      ctx,
      handleAutopruneSet(lang, deps.prefs, g.env.ownerId, arg),
    );
  });

  // ---------------------------------------------------------- /tools ----
  bot.command("tools", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    await safeReply(ctx, handleTools(lang, deps.tools));
  });

  // --------------------------------------------------------- /skills ----
  bot.command("skills", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    await safeReply(
      ctx,
      await handleSkills(lang, {
        ...(deps.tools !== undefined ? { tools: deps.tools } : {}),
        ...(o.skills !== undefined ? { skills: o.skills } : {}),
        ownerId: g.env.ownerId,
      }),
    );
  });

  // -------------------------------------------------------- /curator ----
  bot.command("curator", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    const arg = (messageArg(ctx) ?? "status").toLowerCase();
    if (arg === "run") {
      await safeReply(ctx, await handleCuratorRun(lang, deps.tools, g.env.ownerId));
      return;
    }
    if (arg === "status") {
      let pending = 0;
      try {
        pending = o.proposalStore?.listPending(g.env.ownerId).length ?? 0;
      } catch {
        // Unreadable store = report what we know (zero), honestly.
      }
      await safeReply(
        ctx,
        handleCuratorStatus(lang, deps.tools, pending),
      );
      return;
    }
    await safeReply(ctx, tr(lang, "cmd_system.curator.usage"));
  });

  // -------------------------------------------------------- /plugins ----
  bot.command("plugins", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    await safeReply(ctx, handlePlugins(lang, o.pluginsDir));
  });

  // ----------------------------------------------------- /reload_mcp ----
  bot.command("reload_mcp", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    await safeReply(ctx, await handleReloadMcp(lang, o.mcp));
  });

  // -------------------------------------------------- /reload_skills ----
  bot.command("reload_skills", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    await safeReply(ctx, handleReloadSkills(lang, o.skills));
  });

  // -------------------------------------------------- /approve & /deny ----
  const accessCommand = (cmdName: "approve" | "deny", approve: boolean) => {
    bot.command(cmdName, async (ctx) => {
      const lang = toSysLang(senderLang(ctx, deps.prefs));
      const g = await gate(ctx, lang);
      if (g === undefined) return;
      const arg = messageArg(ctx);
      if (arg === undefined) {
        await safeReply(
          ctx,
          handleAccessList(
            lang,
            listPendingAccess(accessServicesOf(deps)),
          ),
        );
        return;
      }
      const target = parseAccessTarget(arg);
      if (target === undefined) {
        await safeReply(
          ctx,
          tr(lang, "cmd_system.access.bad_target", { cmd: cmdName }),
        );
        return;
      }
      const result = handleAccessDecision(lang, accessServicesOf(deps), deps.storage, {
        kind: target.kind,
        id: target.id,
        approve,
        confirmed: target.confirmed,
        ownerId: g.env.ownerId,
      });
      await safeReply(ctx, result.text);
    });
  };
  accessCommand("approve", true);
  accessCommand("deny", false);

  // -------------------------------------------------------- /sethome ----
  bot.command("sethome", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    if (g.env.chatId === undefined) {
      await safeReply(ctx, tr(lang, "cmd_system.prefs.unavailable"));
      return;
    }
    await safeReply(
      ctx,
      handleSetHome(lang, deps.prefs, g.env.ownerId, g.env.chatId),
    );
  });

  // ---------------------------------------------------------- /pause ----
  bot.command("pause", async (ctx) => {
    const lang = toSysLang(senderLang(ctx, deps.prefs));
    const g = await gate(ctx, lang);
    if (g === undefined) return;
    await safeReply(
      ctx,
      handlePause(lang, deps.prefs, g.env.ownerId, messageArg(ctx)),
    );
  });
}
