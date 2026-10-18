/**
 * Central runtime configuration for BOBI.
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
  /**
   * How often the autonomous heartbeat runs, ms.
   *
   * Zero (the default) disables it: an agent acting without being spoken to
   * must be an explicit owner choice, so nothing here turns on by itself.
   * Bounded at one day; a longer "interval" is not a heartbeat.
   */
  heartbeatIntervalMs: number;
  /** Whether the web_search tool is offered at all. */
  enableWebSearch: boolean;
  /**
   * Directory of owner-authored skill files (markdown with frontmatter).
   *
   * Skills are injected into the system prompt on match; they grant no
   * permissions and execute no code. Like .env, this directory is an
   * owner-only configuration surface: only the server owner should have
   * write access, and skill bodies must never contain secrets.
   */
  skillsDir: string;
  /**
   * Voice transcription (Whisper-style) endpoint. Empty baseUrl disables it:
   * voice notes then fall back to the adapter's named text note.
   */
  transcribeBaseUrl: string;
  transcribeApiKey: string | undefined;
  transcribeModel: string;
  /**
   * Text-to-speech endpoint (OpenAI-compatible /audio/speech). Empty baseUrl
   * disables voice replies; /voice then explains it is not configured.
   */
  ttsBaseUrl: string;
  ttsApiKey: string | undefined;
  ttsModel: string;
  ttsVoice: string;
  /**
   * Image generation endpoint (OpenAI-compatible /images/generations).
   * Empty baseUrl disables the generate_image tool.
   */
  imageBaseUrl: string;
  imageApiKey: string | undefined;
  imageModel: string;
  /**
   * Path to the MCP server config file.
   *
   * An MCP stdio server is a shell command, so this file is owner-only input;
   * see `src/mcp/config.ts` for the validation rules.
   */
  mcpConfigPath: string;
  /**
   * Port for the health endpoint.
   *
   * A hosting platform decides whether a deploy succeeded by polling a URL, and
   * a long-polling bot has no socket for it to reach. Zero disables the server,
   * which is right for a local run.
   *
   * The platform's own PORT variable wins when present, because that is the one
   * it will actually check.
   */
  healthPort: number;
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
    env: pick(envVar(env, "ENV"), VALID_ENVS, "development"),
    logLevel: pick(envVar(env, "LOG_LEVEL"), VALID_LEVELS, "info"),
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    aiModel: env.AI_MODEL?.trim() || "fake-echo",
    aiTimeoutMs: pickInt(env.AI_TIMEOUT_MS, 30_000),
    aiMaxConcurrent: pickInt(env.AI_MAX_CONCURRENT, 4),
    dbPath: envVar(env, "DB_PATH")?.trim() || "data/bobi.db",
    // Trimmed (so stray whitespace cannot masquerade as a value) but not
    // parsed — OwnerIdentity decides validity and reports the reason.
    ownerTelegramIdRaw: env.OWNER_TELEGRAM_ID?.trim() || undefined,
    // Trimmed but not validated here: the secret store reports the reason.
    aiMasterKey: envVar(env, "AI_KEY_MASTER_KEY")?.trim() || undefined,
    // An unusable zone falls back rather than failing startup: a wrong clock
    // label is not worth refusing to boot over.
    timezone: pickTimezone(envVar(env, "TIMEZONE")),
    // Bounded both ways: a zero would disable the agent, an unbounded value
    // would let one message spend without limit.
    agentMaxIterations: clampInt(envVar(env, "AGENT_MAX_ITERATIONS"), 1, 20, 6),
    agentMaxToolCalls: clampInt(envVar(env, "AGENT_MAX_TOOL_CALLS"), 1, 50, 12),
    agentTotalTimeoutMs: clampInt(envVar(env, "AGENT_TOTAL_TIMEOUT_MS"), 5_000, 600_000, 120_000),
    extraSystemPrompt: envVar(env, "EXTRA_SYSTEM_PROMPT")?.trim() || undefined,
    rateLimitPerMinute: clampInt(envVar(env, "RATE_LIMIT_PER_MINUTE"), 0, 10_000, 20),
    rateLimitToolCallsPerHour: clampInt(envVar(env, "RATE_LIMIT_TOOL_CALLS_PER_HOUR"), 0, 100_000, 200),
    schedulerIntervalMs: clampInt(envVar(env, "SCHEDULER_INTERVAL_MS"), 1_000, 3_600_000, 30_000),
    // Off by default (0). A positive value is the owner's explicit decision to
    // let the bot act on its own between messages.
    heartbeatIntervalMs: clampInt(envVar(env, "HEARTBEAT_INTERVAL_MS"), 0, 86_400_000, 0),
    // On by default: the keyless provider needs no configuration, and an agent
    // without web access cannot answer anything past its training data.
    enableWebSearch: pickBool(envVar(env, "ENABLE_WEB_SEARCH"), true),
    skillsDir: envVar(env, "SKILLS_DIR")?.trim() || "./skills",
    transcribeBaseUrl: envVar(env, "TRANSCRIBE_BASE_URL")?.trim() || "",
    transcribeApiKey: envVar(env, "TRANSCRIBE_API_KEY")?.trim() || undefined,
    transcribeModel: envVar(env, "TRANSCRIBE_MODEL")?.trim() || "whisper-1",
    ttsBaseUrl: envVar(env, "TTS_BASE_URL")?.trim() || "",
    ttsApiKey: envVar(env, "TTS_API_KEY")?.trim() || undefined,
    ttsModel: envVar(env, "TTS_MODEL")?.trim() || "tts-1",
    ttsVoice: envVar(env, "TTS_VOICE")?.trim() || "alloy",
    imageBaseUrl: envVar(env, "IMAGE_BASE_URL")?.trim() || "",
    imageApiKey: envVar(env, "IMAGE_API_KEY")?.trim() || undefined,
    imageModel: envVar(env, "IMAGE_MODEL")?.trim() || "dall-e-3",
    mcpConfigPath: envVar(env, "MCP_CONFIG")?.trim() || "mcp.json",
    // The platform's PORT wins: it is what the healthcheck will actually call.
    // Otherwise BOBI_HEALTH_PORT, then off (0) for a local run.
    healthPort: clampInt(
      env.PORT ?? envVar(env, "HEALTH_PORT"),
      0,
      65_535,
      0,
    ),
  };
}

/**
 * Read a configuration value, accepting the BOBI_ prefix and the older SOL_ one.
 *
 * The project was renamed from BOBI to BOBI. An existing .env in someone's
 * deployment still uses SOL_* keys, and silently ignoring them would fall back
 * to defaults — a quiet behaviour change on upgrade. The old prefix is read as a
 * fallback so a rename never alters how a running install behaves.
 */
function envVar(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`BOBI_${suffix}`] ?? env[`SOL_${suffix}`];
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
