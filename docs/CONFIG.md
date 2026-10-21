# BOBI configuration — one surface (Phase 7)

Every environment knob BOBI reads, in one place. The code registry is
`src/config/env.ts` (KNOBS); this file is generated from it — if they ever
disagree, the registry and tests/config_env_gate.test.ts win.

## How resolution works

- `loadConfig()` (src/config/config.ts) is the boot-time reader and returns
  the frozen `SolConfig`. Per-call kill switches and knobs read through
  `src/config/env.ts` — the ONLY module that touches `process.env`
  (grep-gated by tests/config_env_gate.test.ts).
- Chains (preserved exactly from the pre-Phase-7 readers):
  - **full**: `BOBI_<X>` → `SOL_<X>` → bare `<X>`
  - **prefixed**: `BOBI_<X>` → `SOL_<X>` (no bare step)
  - **bobi**: `BOBI_<X>` only
  - **bare**: the exact (platform) name only
- Boot validation: `validateEnv()` reports every set-but-invalid typed
  (int/float/enum) value loudly on stderr. `BOBI_CONFIG_STRICT=1` turns
  that report into a hard boot failure. Consumers keep their documented
  clamp/fallback semantics either way.

## Knobs

| Name | Chain | Type | Default | Effect | Consumer |
|---|---|---|---|---|---|
| `BOBI_ENV` | full | enum | development | Deployment environment label. | config/config.ts |
| `BOBI_LOG_LEVEL` | full | enum | info | Log verbosity. | config/config.ts |
| `TELEGRAM_BOT_TOKEN` | bare | secret | — | Telegram bot token; required to run the bot. | config/config.ts, miniapp/* |
| `AI_MODEL` | bare | string | fake-echo | Fallback AI model id (provider-agnostic). | config/config.ts |
| `BOBI_AI_TIMEOUT_MS` | full | int | 30000 | Per-request AI timeout, ms (clamped). Note: the full chain's third step reads the bare name too. | config/config.ts |
| `AI_MAX_CONCURRENT` | bare | int | 4 | Max concurrent AI requests. | config/config.ts |
| `BOBI_DB_PATH` | full | string | data/bobi.db | SQLite file path; ':memory:' disables persistence. | config/config.ts |
| `OWNER_TELEGRAM_ID` | bare | string | — | Owner's Telegram user id (strictly validated by OwnerIdentity). | config/config.ts, miniapp/* |
| `BOBI_AI_KEY_MASTER_KEY` | full | secret | — | Master key encrypting stored provider credentials (bare-name reads preserved). | config/config.ts |
| `BOBI_TIMEZONE` | full | string | Asia/Tehran | IANA zone for 'now' and reminders; invalid zone falls back. | config/config.ts |
| `BOBI_AGENT_MAX_ITERATIONS` | full | int | 6 | Model turns allowed per user message. | config/config.ts |
| `BOBI_AGENT_MAX_TOOL_CALLS` | full | int | 12 | Tool executions allowed per user message. | config/config.ts |
| `BOBI_AGENT_TOTAL_TIMEOUT_MS` | full | int | 120000 | Ceiling on a whole agent run, ms. | config/config.ts |
| `BOBI_EXTRA_SYSTEM_PROMPT` | full | string | — | Extra owner instructions appended to the system prompt. | config/config.ts |
| `BOBI_RATE_LIMIT_PER_MINUTE` | full | int | 20 | Message rate limit per user. | config/config.ts |
| `BOBI_RATE_LIMIT_TOOL_CALLS_PER_HOUR` | full | int | 200 | Tool-execution rate limit per user per hour. | config/config.ts |
| `BOBI_SCHEDULER_INTERVAL_MS` | full | int | 30000 | Reminder scheduler wake interval, ms. | config/config.ts |
| `BOBI_HEARTBEAT_INTERVAL_MS` | full | int | 0 | Autonomous heartbeat interval, ms; 0 disables. | config/config.ts |
| `BOBI_ENABLE_WEB_SEARCH` | full | bool | true | Whether the web_search tool is offered. | config/config.ts |
| `BOBI_SKILLS_DIR` | full | string | ./skills | Directory of owner-authored skill files. miniapp/api_manage.ts falls back to the bare name only (preserved). | config/config.ts |
| `BOBI_TRANSCRIBE_BASE_URL` | full | string |  | Voice transcription endpoint; empty disables. | config/config.ts |
| `BOBI_TRANSCRIBE_API_KEY` | full | secret | — | Transcription endpoint key. | config/config.ts |
| `BOBI_TRANSCRIBE_MODEL` | full | string | whisper-1 | Transcription model id. | config/config.ts |
| `BOBI_TTS_BASE_URL` | full | string |  | Text-to-speech endpoint; empty disables voice replies. | config/config.ts |
| `BOBI_TTS_API_KEY` | full | secret | — | TTS endpoint key. | config/config.ts |
| `BOBI_TTS_MODEL` | full | string | tts-1 | TTS model id. | config/config.ts |
| `BOBI_TTS_VOICE` | full | string | alloy | TTS voice id. | config/config.ts |
| `BOBI_IMAGE_BASE_URL` | full | string |  | Image generation endpoint; empty disables generate_image. | config/config.ts |
| `BOBI_IMAGE_API_KEY` | full | secret | — | Image endpoint key. | config/config.ts |
| `BOBI_IMAGE_MODEL` | full | string | dall-e-3 | Image model id. | config/config.ts |
| `BOBI_MCP_CONFIG` | full | string | mcp.json | Path to the MCP server config file. | config/config.ts |
| `BOBI_HEALTH_PORT` | full | int | 0 | Health endpoint port; 0 disables. The platform PORT (bare) wins when present. | config/config.ts |
| `PORT` | bare | int | — | Hosting platform port; wins for health + API binding. | config/config.ts, bootstrap.ts |
| `BOBI_AGENT_PARALLEL` | full | bool | true | Parallel tool execution within one model turn. | agent/settings.ts |
| `BOBI_AGENT_MAX_PARALLEL` | full | int | 4 | Concurrency bound for parallel tool execution. | agent/settings.ts |
| `BOBI_AGENT_PLANNING` | full | bool | true | Planning pass before the first iteration. | agent/settings.ts |
| `BOBI_AGENT_SELF_REVIEW` | full | bool | true | Self-review pass after tool turns. | agent/settings.ts |
| `BOBI_STREAMING` | bobi | bool | true | Streamed provider responses in chat. | agent/stream.ts |
| `BOBI_STREAM_FALLBACK` | bobi | bool | true | Failed/empty stream may fall back to one non-streaming call. | agent/loop.ts |
| `BOBI_CIRCUIT_BREAKER` | bobi | bool | true | Per-provider circuit breaker. | ai/circuit_breaker.ts |
| `BOBI_BREAKER_THRESHOLD` | bobi | int | 3 | Consecutive transient failures that open the breaker. | ai/circuit_breaker.ts |
| `BOBI_BREAKER_COOLDOWN_MS` | bobi | int | 30000 | Breaker cooldown after first opening, ms. | ai/circuit_breaker.ts |
| `BOBI_HEALTH_PROBE_MS` | bobi | int | 60000 | Background provider probe interval, ms; 0 disables. | ai/provider_probe.ts |
| `BOBI_MODEL_QUARANTINE` | bobi | bool | true | Per-model quarantine after repeated failures. | ai/model_quarantine.ts |
| `BOBI_MODEL_QUARANTINE_MS` | bobi | int | 300000 | Quarantine duration, ms; 0 disables. | ai/model_quarantine.ts |
| `BOBI_CONN_MANAGER` | bobi | bool | true | Shared keep-alive connection manager. | ai/connection_manager.ts |
| `BOBI_CONN_IDLE_MS` | bobi | int | 300000 | Idle connection reap threshold, ms. | ai/connection_manager.ts |
| `BOBI_CONN_AGENT_MAX_AGE_MS` | bobi | int | 300000 | Keep-alive agent max age, ms (clamped). | ai/connection_manager.ts |
| `BOBI_KEEPALIVE` | bobi | bool | true | HTTP keep-alive; only exact '0' disables. | ai/connection_manager.ts |
| `BOBI_DNS_CACHE_MS` | bobi | int | 60000 | DNS cache TTL, ms; invalid or ≤0 disables the cache (0). | ai/dns_guard.ts, ai/connection_manager.ts |
| `BOBI_SMART_ROUTING` | bobi | bool | true | Smart model routing by task tier. | ai/smart_router.ts |
| `BOBI_GATEWAY_RETRY` | bobi | bool | true | Gateway retry with backoff on transient failures. | ai/gateway.ts |
| `BOBI_PROMPT_CACHE` | prefixed | bool | false | Prompt-cache breakpoints; opt-in ('1'/'true'/'yes'). SOL_ fallback. | ai/cache_policy.ts |
| `BOBI_REASONING_EFFORT` | prefixed | enum | off | Reasoning effort; anything else resolves to off. SOL_ fallback. | ai/reasoning.ts |
| `BOBI_MEMORY_PROVIDER` | bobi | string | sqlite | Memory provider name; unknown names fail loud at startup. | memory/factory.ts |
| `BOBI_EMBEDDING_MODEL` | bobi | string | text-embedding-3-small | Embedding model for semantic memory. | memory/provider_embedder.ts |
| `BOBI_SEMANTIC_MEMORY` | bobi | bool | true | Semantic/vector memory; only exact '0' disables. | memory/provider_embedder.ts |
| `BOBI_MEMORY_CONSOLIDATE` | bobi | bool | true | Memory consolidation job; only exact '0' disables. | memory/consolidate.ts |
| `BOBI_MEMORY_EPISODES` | bobi | bool | true | Episode snapshots; only exact '0' disables. | memory/episodes.ts |
| `BOBI_MEMORY_PROACTIVE_RECALL` | bobi | bool | true | Proactive recall on the turn path; only exact '0' disables. | memory/proactive_recall.ts |
| `BOBI_MEMORY_RECALL_FLOOR` | bobi | float | 0.025 | Minimum recall score surfaced proactively. | memory/proactive_recall.ts |
| `BOBI_MEMORY_SEMANTIC_BUDGET_MS` | bobi | int | 2000 | Deadline for the turn-path semantic recall leg, ms. | memory/proactive_recall.ts |
| `BOBI_CONTEXT_BUDGET` | bobi | bool | true | Context budget enforcement; '0' disables. | conversation/engine.ts |
| `BOBI_TOOL_RESULT_COMPACT` | bobi | bool | true | Tool-result compaction; '0' disables. | conversation/engine.ts |
| `BOBI_CONTEXT_TOKEN_BUDGET` | bobi | int | 32000 | Context token budget when no per-call option is given. | conversation/engine.ts |
| `BOBI_CONTEXT_FILES` | bobi | string | ./AGENTS.md,./SOUL.md | Comma-separated context files injected into the prompt. | context/loader.ts |
| `BOBI_INTENT_ROUTER` | bobi | bool | true | Intent router (advisory); only exact '0' disables. | routing/intent.ts |
| `BOBI_VIDEO_BASE_URL` | prefixed | string |  | Video generation endpoint; empty means the tool does not exist. | tools/video_gen.ts |
| `BOBI_VIDEO_API_KEY` | prefixed | secret | — | Video endpoint key. | tools/video_gen.ts |
| `BOBI_VIDEO_MODEL` | prefixed | string |  | Video generation model id. | tools/video_gen.ts |
| `BOBI_SNAPSHOT_DIR` | bobi | string | ./data/snapshots | Snapshot directory for system commands. | bot/cmd_system.ts |
| `BOBI_FILES_DIR` | bobi | string | ./data/files | Sandboxed files area for the files tool. | tools/files.ts |
| `BOBI_PLUGINS_DIR` | bobi | string | ./plugins | Plugin directory (deploy-time path choice). | bot/cmd_system.ts, bootstrap.ts |
| `BOBI_HOOKS_DIR` | bobi | string | ./hooks | Hooks directory. | bootstrap.ts |
| `BOBI_LOG_FILE` | bobi | string | — | Log file path shown in debug info tails. | bot/cmd_system.ts, bot/palette.ts |
| `BOBI_MINIAPP_URL` | bobi | string | — | Mini-app URL override (https only). | bot/menu.ts |
| `BOBI_DASHBOARD` | bobi | bool | false | RETIRED (Phase 10): the web dashboard was deleted; the Mini App is the web surface. This knob no longer enables anything. | http/dashboard.ts (retirement handler) |
| `BOBI_BENCH_RESULTS_DIR` | bobi | string | bench/results | Benchmark results directory override (tests). | miniapp/api_manage.ts (bench.report) |
| `BOBI_API_PORT` | bobi | int | 8472 | HTTP API port; BOBI_API_PORT wins, then PORT. | bootstrap.ts |
| `BOBI_API_TOKEN` | bobi | secret | — | HTTP API bearer token; unset means the API stays locked. | bootstrap.ts |
| `BOBI_API_BIND` | bobi | string | 127.0.0.1 | HTTP API bind address. | bootstrap.ts |
| `BOBI_WEBHOOK_URL` | bobi | string | — | Outbound webhook URL(s), comma-separated; needs the secret. | webhooks/config.ts |
| `BOBI_WEBHOOK_SECRET` | bobi | secret | — | Webhook HMAC secret; URL without secret keeps webhooks OFF. | webhooks/config.ts |
| `BOBI_CONFIG_STRICT` | bobi | bool | false | Boot fails (throws) on invalid typed knob values instead of only warning loudly. | index.ts via config/validate.ts |

Chain-derived alias spellings that also resolve: `SOL_ENV`, `ENV`, `SOL_LOG_LEVEL`, `LOG_LEVEL`, `SOL_AI_TIMEOUT_MS`, `AI_TIMEOUT_MS`, `SOL_DB_PATH`, `DB_PATH`, `SOL_AI_KEY_MASTER_KEY`, `AI_KEY_MASTER_KEY`, `SOL_TIMEZONE`, `TIMEZONE`, `SOL_AGENT_MAX_ITERATIONS`, `AGENT_MAX_ITERATIONS`, `SOL_AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_TOOL_CALLS`, `SOL_AGENT_TOTAL_TIMEOUT_MS`, `AGENT_TOTAL_TIMEOUT_MS`, `SOL_EXTRA_SYSTEM_PROMPT`, `EXTRA_SYSTEM_PROMPT`, `SOL_RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_MINUTE`, `SOL_RATE_LIMIT_TOOL_CALLS_PER_HOUR`, `RATE_LIMIT_TOOL_CALLS_PER_HOUR`, `SOL_SCHEDULER_INTERVAL_MS`, `SCHEDULER_INTERVAL_MS`, `SOL_HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_INTERVAL_MS`, `SOL_ENABLE_WEB_SEARCH`, `ENABLE_WEB_SEARCH`, `SOL_SKILLS_DIR`, `SKILLS_DIR`, `SOL_TRANSCRIBE_BASE_URL`, `TRANSCRIBE_BASE_URL`, `SOL_TRANSCRIBE_API_KEY`, `TRANSCRIBE_API_KEY`, `SOL_TRANSCRIBE_MODEL`, `TRANSCRIBE_MODEL`, `SOL_TTS_BASE_URL`, `TTS_BASE_URL`, `SOL_TTS_API_KEY`, `TTS_API_KEY`, `SOL_TTS_MODEL`, `TTS_MODEL`, `SOL_TTS_VOICE`, `TTS_VOICE`, `SOL_IMAGE_BASE_URL`, `IMAGE_BASE_URL`, `SOL_IMAGE_API_KEY`, `IMAGE_API_KEY`, `SOL_IMAGE_MODEL`, `IMAGE_MODEL`, `SOL_MCP_CONFIG`, `MCP_CONFIG`, `SOL_HEALTH_PORT`, `HEALTH_PORT`, `SOL_AGENT_PARALLEL`, `AGENT_PARALLEL`, `SOL_AGENT_MAX_PARALLEL`, `AGENT_MAX_PARALLEL`, `SOL_AGENT_PLANNING`, `AGENT_PLANNING`, `SOL_AGENT_SELF_REVIEW`, `AGENT_SELF_REVIEW`, `SOL_PROMPT_CACHE`, `SOL_REASONING_EFFORT`, `SOL_VIDEO_BASE_URL`, `SOL_VIDEO_API_KEY`, `SOL_VIDEO_MODEL`.

## Runtime settings stored in the database (layered over env config)

Env config decides boot-time shape (paths, ports, timeouts, kill switches).
Mutable operational state lives in the database (providers repository,
phase 6) and is read per request, layered over the env defaults:

| Setting | Where | Effect |
|---|---|---|
| `AiRuntimeSettings` (activeProviderId, activeModelId) | DB providers repo (`getRuntimeSettings()`) | Which provider/model serves traffic; switched from the miniapp / /ai without touching env or restarting. |
| `AiFailoverSettings` (enabled, maxAttempts, candidate order) | DB providers repo | Failover policy the gateway applies per request. |
| `SearchSettings` (provider) | DB providers repo (`getSearchSettings()`) | Which search backend web_search uses. |
| Provider credentials | DB, encrypted with `BOBI_AI_KEY_MASTER_KEY` | Keys are data, not env; the env only holds the master key. |

Rule of thumb: if changing it should survive a redeploy and be switchable
from the miniapp, it is a DB runtime setting; if it shapes the process
itself, it is an env knob above.
