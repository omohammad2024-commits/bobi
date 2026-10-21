/**
 * Phase 7 — the single environment touchpoint.
 *
 * Every read of `process.env` in `src/` goes through this module: it is the
 * ONLY file under `src/config/` allowed to name `process.env`, and no file
 * outside `src/config/` may name it at all (pinned by
 * tests/config_env_gate.test.ts). Modules either receive the frozen
 * `SolConfig` from `loadConfig()` or call the small typed readers here with
 * an injectable env record (tests pass their own record and never mutate
 * the real process environment).
 *
 * Resolution chains — preserved EXACTLY from the pre-Phase-7 readers, which
 * did not all agree:
 * - "full":     BOBI_<suffix> → SOL_<suffix> → bare <suffix>
 *               (config.ts envVar, agent/settings.ts agentEnv)
 * - "prefixed": BOBI_<suffix> → SOL_<suffix>
 *               (tools/video_gen.ts pick — bare names were never read there)
 * - "bobi":     BOBI_<name> only (most per-call kill switches / knobs)
 * - "bare":     the exact name only (platform names: TELEGRAM_BOT_TOKEN,
 *               OWNER_TELEGRAM_ID, PORT, AI_MODEL, …)
 *
 * The historical lesson is structural now: a knob only takes effect through
 * one of these documented chains, and KNOBS below lists every chain each
 * name resolves through — a bare `AI_TIMEOUT_MS` in a deployment is not a
 * knob (the knob is BOBI_AI_TIMEOUT_MS via the "full" chain, whose third
 * step DOES read the bare name; see the registry note on aiTimeoutMs).
 */

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** The one place in the codebase that touches the real process env. */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

export type EnvChain = "full" | "prefixed" | "bobi" | "bare";

/**
 * Read a suffix-based knob through its chain. `suffix` is the name without
 * any prefix (e.g. "AI_TIMEOUT_MS"); for "bare" it is the full name.
 */
export function readChained(
  env: EnvRecord,
  suffix: string,
  chain: EnvChain,
): string | undefined {
  switch (chain) {
    case "full":
      return env[`BOBI_${suffix}`] ?? env[`SOL_${suffix}`] ?? env[suffix];
    case "prefixed":
      return env[`BOBI_${suffix}`] ?? env[`SOL_${suffix}`];
    case "bobi":
      return env[`BOBI_${suffix}`];
    case "bare":
      return env[suffix];
  }
}

/** Read one exact name (no chain). */
export function readNamed(env: EnvRecord, name: string): string | undefined {
  return env[name];
}

/* ------------------------------------------------------------------ */
/* Shared value idioms — each one matches an existing reader exactly.  */
/* ------------------------------------------------------------------ */

/**
 * Default-on flag: unset → true; "0"/"false"/"no"/"off" (trimmed,
 * case-insensitive) → false; anything else → true.
 * (agent/stream, loop fallback, circuit breaker, smart router, …)
 */
export function flagUnlessOff(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * Kill-switch idiom: ONLY the exact string "0" disables; unset, "" and
 * every other value keep the feature on. No trimming, no case folding.
 * (memory kill switches, BOBI_KEEPALIVE, intent router)
 */
export function flagUnlessZero(raw: string | undefined): boolean {
  return raw !== "0";
}

/**
 * Opt-in flag: only explicit "1"/"true"/"yes" (trimmed, case-insensitive)
 * enable; some legacy flags also accept "on". Default off.
 */
export function optInFlag(raw: string | undefined, allowOn: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || (allowOn && v === "on");
}

/**
 * Boolean with fallback (config.ts pickBool): explicit false-y strings
 * ("0","false","no","off") → false; explicit true-y ("1","true","yes","on")
 * → true; unset or junk → fallback.
 */
export function boolWithFallback(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return fallback;
}

/** Trimmed string or undefined when unset/blank. */
export function trimmedOrUndefined(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v !== undefined && v.length > 0 ? v : undefined;
}

/* ------------------------------------------------------------------ */
/* Knob registry — the inventory of every environment knob.            */
/*                                                                     */
/* `name` is the primary spelling an operator sets. `chain` says how   */
/* the value resolves. `type` drives boot validation (validateEnv).    */
/* The completeness of this list is pinned by a test that scans src/   */
/* for env-name literals and fails on any unregistered name.           */
/* ------------------------------------------------------------------ */

export type KnobType = "string" | "int" | "float" | "bool" | "enum" | "secret";

export interface Knob {
  /** Primary (operator-facing) name. */
  name: string;
  /** How the value resolves; suffix chains are relative to `name`'s suffix. */
  chain: EnvChain;
  type: KnobType;
  /** Default when unset (display string; "—" for none/secret). */
  default: string;
  /** What the knob controls, one line. */
  effect: string;
  /** Main consumer module(s). */
  consumer: string;
  /** Enum values when type is "enum". */
  enumValues?: readonly string[];
  /** Whether the consumer matches enum values case-insensitively. */
  enumCaseInsensitive?: boolean;
  /** Inclusive numeric bounds when known; validation warns outside them. */
  min?: number;
  max?: number;
}

export const KNOBS: readonly Knob[] = [
  // ---- core (loadConfig, chain "full" unless noted) ----
  { name: "BOBI_ENV", chain: "full", type: "enum", enumValues: ["development", "production", "test"], default: "development", effect: "Deployment environment label.", consumer: "config/config.ts" },
  { name: "BOBI_LOG_LEVEL", chain: "full", type: "enum", enumValues: ["debug", "info", "warn", "error"], default: "info", effect: "Log verbosity.", consumer: "config/config.ts" },
  { name: "TELEGRAM_BOT_TOKEN", chain: "bare", type: "secret", default: "—", effect: "Telegram bot token; required to run the bot.", consumer: "config/config.ts, miniapp/*" },
  { name: "AI_MODEL", chain: "bare", type: "string", default: "fake-echo", effect: "Fallback AI model id (provider-agnostic).", consumer: "config/config.ts" },
  { name: "BOBI_AI_TIMEOUT_MS", chain: "full", type: "int", min: 1000, max: 600000, default: "30000", effect: "Per-request AI timeout, ms (clamped). Note: the full chain's third step reads the bare name too.", consumer: "config/config.ts" },
  { name: "AI_MAX_CONCURRENT", chain: "bare", type: "int", min: 1, default: "4", effect: "Max concurrent AI requests.", consumer: "config/config.ts" },
  { name: "BOBI_DB_PATH", chain: "full", type: "string", default: "data/bobi.db", effect: "SQLite file path; ':memory:' disables persistence.", consumer: "config/config.ts" },
  { name: "OWNER_TELEGRAM_ID", chain: "bare", type: "string", default: "—", effect: "Owner's Telegram user id (strictly validated by OwnerIdentity).", consumer: "config/config.ts, miniapp/*" },
  { name: "BOBI_AI_KEY_MASTER_KEY", chain: "full", type: "secret", default: "—", effect: "Master key encrypting stored provider credentials (bare-name reads preserved).", consumer: "config/config.ts" },
  { name: "BOBI_TIMEZONE", chain: "full", type: "string", default: "Asia/Tehran", effect: "IANA zone for 'now' and reminders; invalid zone falls back.", consumer: "config/config.ts" },
  { name: "BOBI_AGENT_MAX_ITERATIONS", chain: "full", type: "int", min: 1, max: 20, default: "6", effect: "Model turns allowed per user message.", consumer: "config/config.ts" },
  { name: "BOBI_AGENT_MAX_TOOL_CALLS", chain: "full", type: "int", min: 1, max: 50, default: "12", effect: "Tool executions allowed per user message.", consumer: "config/config.ts" },
  { name: "BOBI_AGENT_TOTAL_TIMEOUT_MS", chain: "full", type: "int", min: 5000, max: 600000, default: "120000", effect: "Ceiling on a whole agent run, ms.", consumer: "config/config.ts" },
  { name: "BOBI_EXTRA_SYSTEM_PROMPT", chain: "full", type: "string", default: "—", effect: "Extra owner instructions appended to the system prompt.", consumer: "config/config.ts" },
  { name: "BOBI_RATE_LIMIT_PER_MINUTE", chain: "full", type: "int", min: 0, max: 10000, default: "20", effect: "Message rate limit per user.", consumer: "config/config.ts" },
  { name: "BOBI_RATE_LIMIT_TOOL_CALLS_PER_HOUR", chain: "full", type: "int", min: 0, max: 100000, default: "200", effect: "Tool-execution rate limit per user per hour.", consumer: "config/config.ts" },
  { name: "BOBI_SCHEDULER_INTERVAL_MS", chain: "full", type: "int", min: 1000, max: 3600000, default: "30000", effect: "Reminder scheduler wake interval, ms.", consumer: "config/config.ts" },
  { name: "BOBI_HEARTBEAT_INTERVAL_MS", chain: "full", type: "int", min: 0, max: 86400000, default: "0", effect: "Autonomous heartbeat interval, ms; 0 disables.", consumer: "config/config.ts" },
  { name: "BOBI_ENABLE_WEB_SEARCH", chain: "full", type: "bool", default: "true", effect: "Whether the web_search tool is offered.", consumer: "config/config.ts" },
  { name: "BOBI_SKILLS_DIR", chain: "full", type: "string", default: "./skills", effect: "Directory of owner-authored skill files. miniapp/api_manage.ts falls back to the bare name only (preserved).", consumer: "config/config.ts" },
  { name: "BOBI_TRANSCRIBE_BASE_URL", chain: "full", type: "string", default: "", effect: "Voice transcription endpoint; empty disables.", consumer: "config/config.ts" },
  { name: "BOBI_TRANSCRIBE_API_KEY", chain: "full", type: "secret", default: "—", effect: "Transcription endpoint key.", consumer: "config/config.ts" },
  { name: "BOBI_TRANSCRIBE_MODEL", chain: "full", type: "string", default: "whisper-1", effect: "Transcription model id.", consumer: "config/config.ts" },
  { name: "BOBI_TTS_BASE_URL", chain: "full", type: "string", default: "", effect: "Text-to-speech endpoint; empty disables voice replies.", consumer: "config/config.ts" },
  { name: "BOBI_TTS_API_KEY", chain: "full", type: "secret", default: "—", effect: "TTS endpoint key.", consumer: "config/config.ts" },
  { name: "BOBI_TTS_MODEL", chain: "full", type: "string", default: "tts-1", effect: "TTS model id.", consumer: "config/config.ts" },
  { name: "BOBI_TTS_VOICE", chain: "full", type: "string", default: "alloy", effect: "TTS voice id.", consumer: "config/config.ts" },
  { name: "BOBI_IMAGE_BASE_URL", chain: "full", type: "string", default: "", effect: "Image generation endpoint; empty disables generate_image.", consumer: "config/config.ts" },
  { name: "BOBI_IMAGE_API_KEY", chain: "full", type: "secret", default: "—", effect: "Image endpoint key.", consumer: "config/config.ts" },
  { name: "BOBI_IMAGE_MODEL", chain: "full", type: "string", default: "dall-e-3", effect: "Image model id.", consumer: "config/config.ts" },
  { name: "BOBI_MCP_CONFIG", chain: "full", type: "string", default: "mcp.json", effect: "Path to the MCP server config file.", consumer: "config/config.ts" },
  { name: "BOBI_HEALTH_PORT", chain: "full", type: "int", min: 0, max: 65535, default: "0", effect: "Health endpoint port; 0 disables. The platform PORT (bare) wins when present.", consumer: "config/config.ts" },
  { name: "PORT", chain: "bare", type: "int", min: 0, max: 65535, default: "—", effect: "Hosting platform port; wins for health + API binding.", consumer: "config/config.ts, bootstrap.ts" },
  // ---- agent brain switches (agent/settings.ts, chain "full") ----
  { name: "BOBI_AGENT_PARALLEL", chain: "full", type: "bool", default: "true", effect: "Parallel tool execution within one model turn.", consumer: "agent/settings.ts" },
  { name: "BOBI_AGENT_MAX_PARALLEL", chain: "full", type: "int", min: 1, max: 8, default: "4", effect: "Concurrency bound for parallel tool execution.", consumer: "agent/settings.ts" },
  { name: "BOBI_AGENT_PLANNING", chain: "full", type: "bool", default: "true", effect: "Planning pass before the first iteration.", consumer: "agent/settings.ts" },
  { name: "BOBI_AGENT_SELF_REVIEW", chain: "full", type: "bool", default: "true", effect: "Self-review pass after tool turns.", consumer: "agent/settings.ts" },
  { name: "BOBI_STREAMING", chain: "bobi", type: "bool", default: "true", effect: "Streamed provider responses in chat.", consumer: "agent/stream.ts" },
  { name: "BOBI_STREAM_FALLBACK", chain: "bobi", type: "bool", default: "true", effect: "Failed/empty stream may fall back to one non-streaming call.", consumer: "agent/loop.ts" },
  // ---- AI transport / reliability (chain "bobi", read per call) ----
  { name: "BOBI_CIRCUIT_BREAKER", chain: "bobi", type: "bool", default: "true", effect: "Per-provider circuit breaker.", consumer: "ai/circuit_breaker.ts" },
  { name: "BOBI_BREAKER_THRESHOLD", chain: "bobi", type: "int", min: 1, default: "3", effect: "Consecutive transient failures that open the breaker.", consumer: "ai/circuit_breaker.ts" },
  { name: "BOBI_BREAKER_COOLDOWN_MS", chain: "bobi", type: "int", min: 1, default: "30000", effect: "Breaker cooldown after first opening, ms.", consumer: "ai/circuit_breaker.ts" },
  { name: "BOBI_HEALTH_PROBE_MS", chain: "bobi", type: "int", min: 0, default: "60000", effect: "Background provider probe interval, ms; 0 disables.", consumer: "ai/provider_probe.ts" },
  { name: "BOBI_MODEL_QUARANTINE", chain: "bobi", type: "bool", default: "true", effect: "Per-model quarantine after repeated failures.", consumer: "ai/model_quarantine.ts" },
  { name: "BOBI_MODEL_QUARANTINE_MS", chain: "bobi", type: "int", min: 0, default: "300000", effect: "Quarantine duration, ms; 0 disables.", consumer: "ai/model_quarantine.ts" },
  { name: "BOBI_CONN_MANAGER", chain: "bobi", type: "bool", default: "true", effect: "Shared keep-alive connection manager.", consumer: "ai/connection_manager.ts" },
  { name: "BOBI_CONN_IDLE_MS", chain: "bobi", type: "int", min: 1, default: "300000", effect: "Idle connection reap threshold, ms.", consumer: "ai/connection_manager.ts" },
  { name: "BOBI_CONN_AGENT_MAX_AGE_MS", chain: "bobi", type: "int", min: 30000, max: 3600000, default: "300000", effect: "Keep-alive agent max age, ms (clamped).", consumer: "ai/connection_manager.ts" },
  { name: "BOBI_KEEPALIVE", chain: "bobi", type: "bool", default: "true", effect: "HTTP keep-alive; only exact '0' disables.", consumer: "ai/connection_manager.ts" },
  { name: "BOBI_DNS_CACHE_MS", chain: "bobi", type: "int", min: 0, default: "60000", effect: "DNS cache TTL, ms; invalid or ≤0 disables the cache (0).", consumer: "ai/dns_guard.ts, ai/connection_manager.ts" },
  { name: "BOBI_SMART_ROUTING", chain: "bobi", type: "bool", default: "true", effect: "Smart model routing by task tier.", consumer: "ai/smart_router.ts" },
  { name: "BOBI_GATEWAY_RETRY", chain: "bobi", type: "bool", default: "true", effect: "Gateway retry with backoff on transient failures.", consumer: "ai/gateway.ts" },
  { name: "BOBI_PROMPT_CACHE", chain: "prefixed", type: "bool", default: "false", effect: "Prompt-cache breakpoints; opt-in ('1'/'true'/'yes'). SOL_ fallback.", consumer: "ai/cache_policy.ts" },
  { name: "BOBI_REASONING_EFFORT", chain: "prefixed", type: "enum", enumValues: ["low", "medium", "high"], enumCaseInsensitive: true, default: "off", effect: "Reasoning effort; anything else resolves to off. SOL_ fallback.", consumer: "ai/reasoning.ts" },
  // ---- memory (chain "bobi") ----
  { name: "BOBI_MEMORY_PROVIDER", chain: "bobi", type: "string", default: "sqlite", effect: "Memory provider name; unknown names fail loud at startup.", consumer: "memory/factory.ts" },
  { name: "BOBI_EMBEDDING_MODEL", chain: "bobi", type: "string", default: "text-embedding-3-small", effect: "Embedding model for semantic memory.", consumer: "memory/provider_embedder.ts" },
  { name: "BOBI_SEMANTIC_MEMORY", chain: "bobi", type: "bool", default: "true", effect: "Semantic/vector memory; only exact '0' disables.", consumer: "memory/provider_embedder.ts" },
  { name: "BOBI_MEMORY_CONSOLIDATE", chain: "bobi", type: "bool", default: "true", effect: "Memory consolidation job; only exact '0' disables.", consumer: "memory/consolidate.ts" },
  { name: "BOBI_MEMORY_EPISODES", chain: "bobi", type: "bool", default: "true", effect: "Episode snapshots; only exact '0' disables.", consumer: "memory/episodes.ts" },
  { name: "BOBI_MEMORY_PROACTIVE_RECALL", chain: "bobi", type: "bool", default: "true", effect: "Proactive recall on the turn path; only exact '0' disables.", consumer: "memory/proactive_recall.ts" },
  { name: "BOBI_MEMORY_RECALL_FLOOR", chain: "bobi", type: "float", min: 0, default: "0.025", effect: "Minimum recall score surfaced proactively.", consumer: "memory/proactive_recall.ts" },
  { name: "BOBI_MEMORY_SEMANTIC_BUDGET_MS", chain: "bobi", type: "int", min: 0, default: "2000", effect: "Deadline for the turn-path semantic recall leg, ms.", consumer: "memory/proactive_recall.ts" },
  // ---- conversation / context / routing ----
  { name: "BOBI_CONTEXT_BUDGET", chain: "bobi", type: "bool", default: "true", effect: "Context budget enforcement; '0' disables.", consumer: "conversation/engine.ts" },
  { name: "BOBI_TOOL_RESULT_COMPACT", chain: "bobi", type: "bool", default: "true", effect: "Tool-result compaction; '0' disables.", consumer: "conversation/engine.ts" },
  { name: "BOBI_CONTEXT_TOKEN_BUDGET", chain: "bobi", type: "int", min: 1, default: "32000", effect: "Context token budget when no per-call option is given.", consumer: "conversation/engine.ts" },
  { name: "BOBI_CONTEXT_FILES", chain: "bobi", type: "string", default: "./AGENTS.md,./SOUL.md", effect: "Comma-separated context files injected into the prompt.", consumer: "context/loader.ts" },
  { name: "BOBI_INTENT_ROUTER", chain: "bobi", type: "bool", default: "true", effect: "Intent router (advisory); only exact '0' disables.", consumer: "routing/intent.ts" },
  // ---- media tools ----
  { name: "BOBI_VIDEO_BASE_URL", chain: "prefixed", type: "string", default: "", effect: "Video generation endpoint; empty means the tool does not exist.", consumer: "tools/video_gen.ts" },
  { name: "BOBI_VIDEO_API_KEY", chain: "prefixed", type: "secret", default: "—", effect: "Video endpoint key.", consumer: "tools/video_gen.ts" },
  { name: "BOBI_VIDEO_MODEL", chain: "prefixed", type: "string", default: "", effect: "Video generation model id.", consumer: "tools/video_gen.ts" },
  // ---- surfaces: bot / http / miniapp / webhooks / bootstrap ----
  { name: "BOBI_SNAPSHOT_DIR", chain: "bobi", type: "string", default: "./data/snapshots", effect: "Snapshot directory for system commands.", consumer: "bot/cmd_system.ts" },
  { name: "BOBI_FILES_DIR", chain: "bobi", type: "string", default: "./data/files", effect: "Sandboxed files area for the files tool.", consumer: "tools/files.ts" },
  { name: "BOBI_PLUGINS_DIR", chain: "bobi", type: "string", default: "./plugins", effect: "Plugin directory (deploy-time path choice).", consumer: "bot/cmd_system.ts, bootstrap.ts" },
  { name: "BOBI_HOOKS_DIR", chain: "bobi", type: "string", default: "./hooks", effect: "Hooks directory.", consumer: "bootstrap.ts" },
  { name: "BOBI_LOG_FILE", chain: "bobi", type: "string", default: "—", effect: "Log file path shown in debug info tails.", consumer: "bot/cmd_system.ts, bot/palette.ts" },
  { name: "BOBI_MINIAPP_URL", chain: "bobi", type: "string", default: "—", effect: "Mini-app URL override (https only).", consumer: "bot/menu.ts" },
  { name: "BOBI_DASHBOARD", chain: "bobi", type: "bool", default: "false", effect: "RETIRED (Phase 10): the web dashboard was deleted; the Mini App is the web surface. This knob no longer enables anything.", consumer: "http/dashboard.ts (retirement handler)" },
  { name: "BOBI_BENCH_RESULTS_DIR", chain: "bobi", type: "string", default: "bench/results", effect: "Benchmark results directory override (tests).", consumer: "miniapp/api_manage.ts (bench.report)" },
  { name: "BOBI_API_PORT", chain: "bobi", type: "int", min: 1, max: 65535, default: "8472", effect: "HTTP API port; BOBI_API_PORT wins, then PORT.", consumer: "bootstrap.ts" },
  { name: "BOBI_API_TOKEN", chain: "bobi", type: "secret", default: "—", effect: "HTTP API bearer token; unset means the API stays locked.", consumer: "bootstrap.ts" },
  { name: "BOBI_API_BIND", chain: "bobi", type: "string", default: "127.0.0.1", effect: "HTTP API bind address.", consumer: "bootstrap.ts" },
  { name: "BOBI_WEBHOOK_URL", chain: "bobi", type: "string", default: "—", effect: "Outbound webhook URL(s), comma-separated; needs the secret.", consumer: "webhooks/config.ts" },
  { name: "BOBI_WEBHOOK_SECRET", chain: "bobi", type: "secret", default: "—", effect: "Webhook HMAC secret; URL without secret keeps webhooks OFF.", consumer: "webhooks/config.ts" },
  // ---- phase 7 itself ----
  { name: "BOBI_CONFIG_STRICT", chain: "bobi", type: "bool", default: "false", effect: "Boot fails (throws) on invalid typed knob values instead of only warning loudly.", consumer: "index.ts via config/validate.ts" },
];

/** All spellings that resolve to a knob (primary + chain-derived). */
export function knobNames(knob: Knob): string[] {
  const names = [knob.name];
  if (knob.chain === "full" || knob.chain === "prefixed") {
    if (knob.name.startsWith("BOBI_")) {
      names.push(`SOL_${knob.name.slice("BOBI_".length)}`);
    }
    if (knob.chain === "full" && knob.name.startsWith("BOBI_")) {
      names.push(knob.name.slice("BOBI_".length));
    }
  }
  return names;
}
