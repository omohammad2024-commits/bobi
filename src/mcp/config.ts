/**
 * MCP server configuration loading and validation.
 *
 * The config file is owner-supplied and, for a stdio server, contains a shell
 * command to execute. Everything here is therefore written as though the file
 * is hostile:
 *
 *  - Unknown fields are rejected rather than ignored, so a typo cannot silently
 *    fall back to a default that runs something.
 *  - A server without a usable command (stdio) or URL (http) is refused, not
 *    "connected to" and left to fail later.
 *  - Nothing is enabled implicitly. A `servers` entry is inert unless it says
 *    `enabled: true`, so copying a config file in does not execute anything.
 *  - Bounds on count, argument length, and environment size keep a mistaken
 *    config from exhausting the process.
 *
 * Problems are collected rather than thrown one at a time: an owner fixing a
 * config wants the whole list, not the first error.
 */
import { readFileSync } from "node:fs";
import {
  MAX_ARG_LENGTH,
  MAX_ARGS,
  MAX_ENV_VARS,
  MAX_SERVERS,
  MCP_NAME_PATTERN,
} from "./types";
import type { McpServerConfig, McpValidationIssue } from "./types";

/** Fields a stdio server may declare. */
const STDIO_FIELDS: ReadonlySet<string> = new Set([
  "enabled",
  "transport",
  "command",
  "args",
  "env",
  "cwd",
]);

/** Fields an http server may declare. */
const HTTP_FIELDS: ReadonlySet<string> = new Set([
  "enabled",
  "transport",
  "url",
  "token",
]);

export interface McpLoadResult {
  /** Servers that passed validation, in file order. */
  servers: McpServerConfig[];
  issues: McpValidationIssue[];
  /** True when the file did not exist; not an error. */
  missing: boolean;
}

/**
 * Load and validate a config file.
 *
 * A missing file is normal (MCP is optional) and yields no servers and no
 * issues. A malformed file yields no servers and a precise issue.
 */
export function loadMcpConfig(path: string): McpLoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { servers: [], issues: [], missing: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      servers: [],
      issues: [{ path: "$", message: "فایل JSON معتبر نیست." }],
      missing: false,
    };
  }

  return validateMcpConfig(parsed);
}

/**
 * Validate an already-parsed config object.
 *
 * Pure, so the rules are testable without touching the filesystem.
 */
export function validateMcpConfig(parsed: unknown): McpLoadResult {
  const issues: McpValidationIssue[] = [];

  if (!isRecord(parsed)) {
    return {
      servers: [],
      issues: [{ path: "$", message: "ریشهٔ فایل باید یک شیء باشد." }],
      missing: false,
    };
  }

  const unknownRoot = Object.keys(parsed).filter((k) => k !== "servers");
  for (const key of unknownRoot) {
    // Rejected rather than ignored: a misspelled root key would otherwise look
    // like "no servers configured" and silently do nothing.
    issues.push({ path: key, message: "فیلد ناشناخته در ریشهٔ فایل." });
  }

  const serversRaw = parsed["servers"];
  if (serversRaw === undefined) {
    return { servers: [], issues, missing: false };
  }
  if (!isRecord(serversRaw)) {
    issues.push({ path: "servers", message: "باید یک شیء باشد." });
    return { servers: [], issues, missing: false };
  }

  const names = Object.keys(serversRaw);
  if (names.length > MAX_SERVERS) {
    issues.push({
      path: "servers",
      message: `حداکثر ${MAX_SERVERS} سرور پشتیبانی می‌شود.`,
    });
  }

  const servers: McpServerConfig[] = [];
  for (const name of names.slice(0, MAX_SERVERS)) {
    const server = validateServer(name, serversRaw[name], issues);
    if (server !== undefined) servers.push(server);
  }

  return { servers, issues, missing: false };
}

/**
 * Validate one server entry.
 *
 * Returns undefined when the entry is unusable; the reasons are appended to
 * `issues` with a path that names the exact field.
 */
function validateServer(
  name: string,
  raw: unknown,
  issues: McpValidationIssue[],
): McpServerConfig | undefined {
  const path = `servers.${name}`;

  if (!MCP_NAME_PATTERN.test(name)) {
    issues.push({
      path,
      message: "نام باید با حرف شروع شود و فقط حروف کوچک، رقم، _ و - داشته باشد.",
    });
    return undefined;
  }

  if (!isRecord(raw)) {
    issues.push({ path, message: "باید یک شیء باشد." });
    return undefined;
  }

  const transport = raw["transport"];
  if (transport !== "stdio" && transport !== "http") {
    issues.push({ path: `${path}.transport`, message: "باید stdio یا http باشد." });
    return undefined;
  }

  // Only the fields that belong to this transport are allowed. A `url` on a
  // stdio entry, or a `command` on an http one, means the file is confused —
  // and guessing which one the owner meant is how a surprise gets executed.
  const allowed = transport === "stdio" ? STDIO_FIELDS : HTTP_FIELDS;
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      issues.push({ path: `${path}.${key}`, message: `برای ${transport} مجاز نیست.` });
      return undefined;
    }
  }

  // Consent is explicit. Absent means "do not run".
  const enabledRaw = raw["enabled"];
  if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
    issues.push({ path: `${path}.enabled`, message: "باید true یا false باشد." });
    return undefined;
  }
  const enabled = enabledRaw === true;

  return transport === "stdio"
    ? validateStdio(name, raw, enabled, issues)
    : validateHttp(name, raw, enabled, issues);
}

function validateStdio(
  name: string,
  raw: Record<string, unknown>,
  enabled: boolean,
  issues: McpValidationIssue[],
): McpServerConfig | undefined {
  const path = `servers.${name}`;

  const command = raw["command"];
  if (typeof command !== "string" || command.trim().length === 0) {
    issues.push({ path: `${path}.command`, message: "دستور اجرا لازم است." });
    return undefined;
  }
  if (command.length > MAX_ARG_LENGTH) {
    issues.push({ path: `${path}.command`, message: "دستور خیلی طولانی است." });
    return undefined;
  }

  const args = stringArray(raw["args"], `${path}.args`, issues);
  if (args === undefined && raw["args"] !== undefined) return undefined;
  if (args !== undefined && args.length > MAX_ARGS) {
    issues.push({ path: `${path}.args`, message: `حداکثر ${MAX_ARGS} آرگومان.` });
    return undefined;
  }

  const env = stringRecord(raw["env"], `${path}.env`, issues);
  if (env === undefined && raw["env"] !== undefined) return undefined;
  if (env !== undefined && Object.keys(env).length > MAX_ENV_VARS) {
    issues.push({ path: `${path}.env`, message: `حداکثر ${MAX_ENV_VARS} متغیر.` });
    return undefined;
  }

  const cwd = raw["cwd"];
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    issues.push({ path: `${path}.cwd`, message: "باید مسیر غیرخالی باشد." });
    return undefined;
  }

  return {
    name,
    transport: "stdio",
    enabled,
    command: command.trim(),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
  };
}

function validateHttp(
  name: string,
  raw: Record<string, unknown>,
  enabled: boolean,
  issues: McpValidationIssue[],
): McpServerConfig | undefined {
  const path = `servers.${name}`;

  const url = raw["url"];
  if (typeof url !== "string" || url.trim().length === 0) {
    issues.push({ path: `${path}.url`, message: "آدرس سرویس لازم است." });
    return undefined;
  }

  // Only http(s). A file: or javascript: URL here is not an endpoint.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    issues.push({ path: `${path}.url`, message: "آدرس نامعتبر است." });
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    issues.push({ path: `${path}.url`, message: "آدرس باید http یا https باشد." });
    return undefined;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    issues.push({ path: `${path}.url`, message: "آدرس نباید نام کاربری داشته باشد." });
    return undefined;
  }

  const token = raw["token"];
  if (token !== undefined && (typeof token !== "string" || token.length === 0)) {
    issues.push({ path: `${path}.token`, message: "باید رشتهٔ غیرخالی باشد." });
    return undefined;
  }

  return {
    name,
    transport: "http",
    enabled,
    url: parsed.toString(),
    ...(typeof token === "string" ? { token } : {}),
  };
}

/** A string array, or undefined when absent; invalid entries are reported. */
function stringArray(
  raw: unknown,
  path: string,
  issues: McpValidationIssue[],
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({ path, message: "باید آرایه باشد." });
    return undefined;
  }
  const out: string[] = [];
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "string") {
      issues.push({ path: `${path}[${i}]`, message: "باید رشته باشد." });
      return undefined;
    }
    if (item.length > MAX_ARG_LENGTH) {
      issues.push({ path: `${path}[${i}]`, message: "طولانی‌تر از حد مجاز است." });
      return undefined;
    }
    out.push(item);
  }
  return out;
}

/** A string→string record, or undefined when absent. */
function stringRecord(
  raw: unknown,
  path: string,
  issues: McpValidationIssue[],
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push({ path, message: "باید یک شیء باشد." });
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      issues.push({ path: `${path}.${key}`, message: "باید رشته باشد." });
      return undefined;
    }
    out[key] = value;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Render an issue list for a log line or a panel message. */
export function describeIssues(issues: readonly McpValidationIssue[]): string {
  if (issues.length === 0) return "";
  return issues.map((i) => `${i.path}: ${i.message}`).join("\n");
}
