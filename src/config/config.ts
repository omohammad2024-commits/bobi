/**
 * Central runtime configuration for SOL.
 * Everything is derived from environment variables with safe defaults.
 * Secrets are never read here — only non-sensitive settings.
 */
export interface SolConfig {
  /** Deployment environment label. */
  env: "development" | "production" | "test";
  /** Log verbosity. */
  logLevel: "debug" | "info" | "warn" | "error";
  /** Telegram bot token; required to run the bot, never logged. */
  botToken: string | undefined;
  /** AI model id to request (provider-agnostic). */
  aiModel: string;
  /** Per-request AI timeout, ms. */
  aiTimeoutMs: number;
  /** Max concurrent AI requests. */
  aiMaxConcurrent: number;
  /** SQLite file path for persistent memory; ":memory:" disables persistence. */
  dbPath: string;
  /**
   * Raw OWNER_TELEGRAM_ID from the environment, kept unparsed so
   * OwnerIdentity owns the strict validation. Never logged.
   */
  ownerTelegramIdRaw: string | undefined;
  /**
   * Master key for encrypting provider credentials.
   *
   * Held outside the database. When absent, credential writes fail closed and
   * real providers cannot be configured. Never logged.
   */
  aiMasterKey: string | undefined;
  /** IANA zone used for the agent's notion of "now" and for reminders. */
  timezone: string;
  /** Model turns allowed per user message, including the first. */
  agentMaxIterations: number;
  /** Tool executions allowed per user message across all turns. */
  agentMaxToolCalls: number;
  /** Ceiling on a whole agent run, ms. */
  agentTotalTimeoutMs: number;
  /** Optional owner instructions appended to the system prompt. */
  extraSystemPrompt: string | undefined;
  /** Message rate limit per user. */
  rateLimitPerMinute: number;
  /** Tool-execution rate limit per user per hour. */
  rateLimitToolCallsPerHour: number;
  /** How often the reminder scheduler wakes up, ms. */
  schedulerIntervalMs: number;
  /** Whether the web_search tool is offered at all. */
  enableWebSearch: boolean;
}

const VALID_ENVS: ReadonlySet<string> = new Set(["development", "production", "test"]);
const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

function pick<T extends string>(
  raw: string | undefined,
  allowed: ReadonlySet<string>,
  fallback: T,
): T {
  return raw !== undefined && allowed.has(raw) ? (raw as T) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SolConfig {
  return {
    env: pick(env.SOL_ENV, VALID_ENVS, "development"),
    logLevel: pick(env.SOL_LOG_LEVEL, VALID_LEVELS, "info"),
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    aiModel: env.AI_MODEL?.trim() || "fake-echo",
    aiTimeoutMs: pickInt(env.AI_TIMEOUT_MS, 30_000),
    aiMaxConcurrent: pickInt(env.AI_MAX_CONCURRENT, 4),
    dbPath: env.SOL_DB_PATH?.trim() || "data/sol.db",
    // Trimmed (so stray whitespace cannot masquerade as a value) but not
    // parsed — OwnerIdentity decides validity and reports the reason.
    ownerTelegramIdRaw: env.OWNER_TELEGRAM_ID?.trim() || undefined,
    // Trimmed but not validated here: the secret store reports the reason.
    aiMasterKey: env.SOL_AI_KEY_MASTER_KEY?.trim() || undefined,
    // An unusable zone falls back rather than failing startup: a wrong clock
    // label is not worth refusing to boot over.
    timezone: pickTimezone(env.SOL_TIMEZONE),
    // Bounded both ways: a zero would disable the agent, an unbounded value
    // would let one message spend without limit.
    agentMaxIterations: clampInt(env.SOL_AGENT_MAX_ITERATIONS, 1, 20, 6),
    agentMaxToolCalls: clampInt(env.SOL_AGENT_MAX_TOOL_CALLS, 1, 50, 12),
    agentTotalTimeoutMs: clampInt(env.SOL_AGENT_TOTAL_TIMEOUT_MS, 5_000, 600_000, 120_000),
    extraSystemPrompt: env.SOL_EXTRA_SYSTEM_PROMPT?.trim() || undefined,
    rateLimitPerMinute: clampInt(env.SOL_RATE_LIMIT_PER_MINUTE, 0, 10_000, 20),
    rateLimitToolCallsPerHour: clampInt(env.SOL_RATE_LIMIT_TOOL_CALLS_PER_HOUR, 0, 100_000, 200),
    schedulerIntervalMs: clampInt(env.SOL_SCHEDULER_INTERVAL_MS, 1_000, 3_600_000, 30_000),
    // On by default: the keyless provider needs no configuration, and an agent
    // without web access cannot answer anything past its training data.
    enableWebSearch: pickBool(env.SOL_ENABLE_WEB_SEARCH, true),
  };
}

/** Parse a boolean env value; only explicit false-y strings disable. */
function pickBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return fallback;
}

/** Accept an IANA zone only when Intl recognizes it. */
function pickTimezone(raw: string | undefined): string {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return "Asia/Tehran";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return "Asia/Tehran";
  }
}

/** Parse an integer and clamp it into range, falling back on nonsense. */
function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function pickInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Validate config for starting the bot. Throws a short, clear error. */
export function requireBotToken(cfg: SolConfig): string {
  if (!cfg.botToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Add it to .env or the environment and retry.",
    );
  }
  return cfg.botToken;
}
