import { bootstrapMessage } from "./core/app";
import { fileURLToPath } from "node:url";
import { loadConfig, requireBotToken } from "./config/config";
import { createBot, PERSONALITY_PREF_KEY } from "./bot/bot";
import { publicMenuCommands, ownerMenuCommands, miniAppUrl } from "./bot/menu";
import { resolvePersonalityName } from "./personality/personalities";
import { resolveLang } from "./i18n";
import { describeMediaPart, MAX_MEDIA_PER_REPLY } from "./bot/media";
import type { Bot, Context } from "grammy";
import type { BotCommandScope, LanguageCode } from "@grammyjs/types";
import { FakeProvider } from "./ai/fake";
import { ConversationEngine } from "./conversation/engine";
import { Storage } from "./storage/storage";
import { ToolService } from "./tools/service";
import { AuthorizationService } from "./auth/service";
import { OwnerIdentity, parseOwnerId } from "./auth/identity";
import { AdminBoundary } from "./auth/admin_boundary";
import { AuditLogger } from "./auth/audit";
import { GroupAccessService } from "./groups/service";
import { UserAccessService } from "./auth/user_service";
import { UserPanelController } from "./auth/user_controller";
import { PanelController } from "./groups/controller";
import { AiAdminController } from "./groups/ai_controller";
import { AdapterRegistry } from "./ai/adapter_registry";
import { ProviderSecretStore } from "./ai/secret_store";
import { ModelService, ProviderService } from "./ai/provider_service";
import { ProviderHealthService } from "./ai/health";
import { AiGateway } from "./ai/gateway";
import { SearchProviderSecretStore } from "./search/secret_store";
import { createDelegateTool } from "./tools/delegate";
import { createConsultModelsTool } from "./tools/consult_models";
import type { AiProvider } from "./ai/provider";
import { SearchRegistry } from "./search/registry";
import { SearchSettingsService } from "./search/service";
import { createWebSearchTool } from "./tools/web_search";
import { createImageGenTool, imageGenConfigured } from "./tools/image_gen";
import { createVideoGenTool, videoGenConfigured, videoGenDepsFromEnv } from "./tools/video_gen";
import { createMemoryTools } from "./tools/memory";
import { createHistoryTools } from "./tools/history";
import { resolveMemoryProvider } from "./memory/factory";
import {
  MemoryVectorStore,
  ProviderEmbedder,
  SemanticMemorySearch,
} from "./memory";
import { createReminderTools } from "./tools/reminders";
import { createNudgeTools } from "./tools/nudge_tool";
import { NudgeTracker } from "./nudges/tracker";
import { sweepNudges } from "./nudges/sweep";
import { createScheduledTaskTools } from "./tools/scheduled_tasks";
import { createUsageReportTool } from "./tools/usage_report";
import { createDigestTool } from "./tools/digest_tool";
import type { SearchHeadlinesFn } from "./digest/builder";
import { createCuratorTools } from "./curator/tools";
import { ProposalStore } from "./curator/proposals";
import { registerSessionCommands, COMMAND_DEFS as SESSION_COMMAND_DEFS } from "./bot/cmd_session";
import { registerSystemCommands, COMMAND_DEFS as SYSTEM_COMMAND_DEFS } from "./bot/cmd_system";
import {
  registerAutoCommands,
  COMMAND_DEFS as AUTO_COMMAND_DEFS,
  setHeartbeatInfoProvider,
} from "./bot/cmd_auto";
import type { HermesCommandDef, HermesCommandDeps } from "./bot/cmd_context";
import { Database } from "bun:sqlite";
// Phase-3: group assistant mode (opt-in per group).
import {
  createGroupHistory,
  handleGassistantCommand,
  handleGsummaryCommand,
  handleGpollCommand,
  type DigestSchedulePort,
  type GroupAssistantEnv,
} from "./groups/assistant";
// Phase-4: scheduled group digests (owner's DM, zero LLM).
import {
  createGroupDigestTool,
  digestTaskName,
  digestTimeToCron,
  GROUP_DIGEST_TOOL_NAME,
  type GroupDigestToolDeps,
} from "./groups/group_digest";
// Phase-5: opt-in LLM smart summaries for group discussions (owner-only).
import type { SmartSummaryPort } from "./groups/smart_summary";
// Phase-3: scheduled benchmarks + quality alerts.
import { BenchHistory } from "./bench/history";
import { createRunBenchTool, defaultLiveStackBuilder } from "./bench/tool";
// Phase-4: daemon-side background worker for LIVE benchmark runs (outside
// the scheduler's 30s action budget).
import { BenchWorker } from "./bench/worker";
// Phase-5: durable bench job queue (queued/running jobs survive restarts).
import { BenchJobStore } from "./bench/queue_store";
import {
  registerBenchCommands,
  COMMAND_DEFS as BENCH_COMMAND_DEFS,
} from "./bot/cmd_phase3_bench";
// Phase-3: installable skills from chat.
import {
  registerPhase3SkillsCommands,
  COMMAND_DEFS as SKILLS_COMMAND_DEFS,
} from "./bot/cmd_phase3_skills";
// Phase-5: memory auto event extraction + memory export/import.
import {
  registerPhase5MemoryCommands,
  COMMAND_DEFS as PHASE5_MEMORY_COMMAND_DEFS,
} from "./bot/cmd_phase5_memory";
import { scanForEventCandidates } from "./memory/auto_extract";
// Phase-3: proactive event memory -> nudge sweep wiring.
import { EventStore } from "./memory/events";
import { requireOwnerTier } from "./bot/access";
import { gateGroup, gateUser, senderLang } from "./bot/bot";
import { createGoalTools } from "./tools/goals";
import { HeartbeatService } from "./autonomy/heartbeat";
import { ReminderScheduler, TaskScheduler } from "./scheduler/scheduler";
import { authorizeToolUse, toToolActor } from "./auth/tool_bridge";
import { McpManager, mcpTools } from "./mcp/bridge";
import { loadMcpConfig, describeIssues } from "./mcp/config";
import { RateLimiter } from "./core/rate_limit";
import { UsageService } from "./core/usage";
import { Logger } from "./core/logger";
import { startHealthServer } from "./core/health";
import type { Tool, ToolActor } from "./tools/types";
import { SkillCache } from "./skills/loader";
import { ContextFileCache } from "./context/loader";
import { UsageTracker } from "./ai/usage";
import type { RunUsageInfo } from "./conversation/engine";
import { createSkillsTool } from "./skills/tool";
import { createToolSearchTool } from "./tools/tool_search";
import { HookRunner } from "./hooks/runner";
import { loadPlugins } from "./plugins/loader";
// Phase E5: minimal HTTP API server. Only bound when BOBI_API_TOKEN is set;
// when it is unset, startup is exactly as before (no port, no behavior change).
import { createApiServer, DEFAULT_API_BIND, DEFAULT_API_PORT } from "./http/server";
import type { ApiServer } from "./http/server";

async function main(): Promise<void> {
  const config = loadConfig();

  // Structured logging, at the level the owner configured. Every diagnostic
  // below goes through it; the redactor strips credential shapes, so a caller
  // that passes one by mistake cannot leak it into a log file.
  const log = new Logger({ level: config.logLevel, base: { app: "bobi" } });

  const token = requireBotToken(config); // throws a short, clear error

  // Owner identity first: it decides what the rest of the run may do.
  const ownerId = parseOwnerId(config.ownerTelegramIdRaw);
  if (!ownerId.ok) {
    // Fail closed. The program never starts with administrative access
    // derived from an unvalidated value.
    // Written straight to stderr rather than through the logger: this is the
    // one message that must appear even when the configured level would
    // suppress it, because without it the program simply will not start.
    console.error(
      "startup failed: OWNER_TELEGRAM_ID is not set or invalid. " +
        "Set it to the numeric Telegram user id of the owner and retry. " +
        `(${ownerId.reason})`,
    );
    process.exitCode = 1;
    return;
  }
  const identity = OwnerIdentity.fromNumber(ownerId.ownerId);

  const storage = Storage.open(config.dbPath);
  const audit = new AuditLogger({ storage });
  // Shared with the /curator system command (Hermes parity) — one store, one
  // connection pair to the same SQLite file.
  const proposalStore = new ProposalStore(new Database(config.dbPath));
  // Stage-3: proactive follow-ups. Own `nudges` table on the same SQLite file
  // via its own Database handle (D4 curator pattern) — storage.ts untouched.
  const nudgeTracker = new NudgeTracker(new Database(config.dbPath));
  const auth = new AuthorizationService(identity);
  const admin = new AdminBoundary({ auth, audit });
  const groups = new GroupAccessService(storage);
  const users = new UserAccessService(storage);

  // AI gateway: routes requests to the owner-selected provider and model.
  // The master key comes from configuration; when it is absent, credential
  // writes fail closed and the gateway refuses to call without a key.
  const secrets = new ProviderSecretStore(config.aiMasterKey);
  if (!secrets.configured) {
    log.warn(
      "BOBI_AI_KEY_MASTER_KEY is not set; provider credentials cannot be stored. " +
        "Set it in .env or the environment to enable real providers.",
    );
  }

  // Web search. The keyless provider works with no configuration, so search is
  // available on a fresh install; a keyed provider can be selected from /ai.
  const searchSecrets = new SearchProviderSecretStore(config.aiMasterKey);
  const search = new SearchRegistry(storage, searchSecrets);
  const searchSettings = new SearchSettingsService(storage, searchSecrets);
  const searchEnabled = config.enableWebSearch && search.isConfigured();

  // Headline resolver shared by the build_digest tool (scheduled 08:00 text
  // delivery) and the interactive /digest (on-demand tap-to-act version).
  const digestSearchHeadlines: SearchHeadlinesFn | undefined = searchEnabled
    ? async (query: string, limit: number, signal: AbortSignal) =>
        (
          await search.active().search({ query, limit, timeoutMs: 12_000, signal })
        ).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        }))
    : undefined;

  // Central tool service — registers the tools and is the only sanctioned way
  // to run one. The engine reaches tools only through here, so validation,
  // permissions, timeouts and the concurrency bound apply to every call the
  // model makes.
  // MCP servers. The config file is owner-only input, and a server is inert
  // until it says `enabled: true` — a stdio server is a shell command, so
  // nothing here is allowed to run by accident.
  const mcpConfig = loadMcpConfig(config.mcpConfigPath);
  if (mcpConfig.issues.length > 0) {
    // Reported once at startup rather than failing: one bad entry must not
    // stop the bot, but the owner needs to know their config is wrong.
    log.warn("MCP config has problems", { issues: describeIssues(mcpConfig.issues) });
  }
  const mcp = new McpManager(mcpConfig.servers);
  await mcp.connectAll();
  for (const status of mcp.status()) {
    if (status.enabled && !status.connected) {
      log.warn("MCP server unavailable", { server: status.name, error: status.error ?? "" });
    }
  }

  // Phase-3 benchmarks: history store on its own SQLite connection (like
  // ProposalStore) and the run_bench tool. notifyOwner is wired lazily —
  // the bot API only exists after createBot below.
  const benchHistory = new BenchHistory(new Database(config.dbPath));
  let benchNotifyApi:
    | { sendMessage(chatId: number | string, text: string): Promise<unknown> }
    | undefined;
  // Phase-4 group digests: same lazy pattern — the bot API only exists after
  // createBot below. The digest tool DMs the owner the deterministic summary.
  let groupDigestNotifyApi:
    | { sendMessage(chatId: number | string, text: string): Promise<unknown> }
    | undefined;
  // Phase-4: daemon-side background worker for benchmark runs. The
  // scheduler's per-action budget (~30s) cannot fit a multi-minute LIVE
  // suite, so scheduled live actions only ENQUEUE into this worker
  // (milliseconds, no LLM calls in the action path); the worker runs the
  // full suite outside that budget, records history, and drives the
  // regression alert path. Started with the other schedulers below.
  // See src/bench/worker.ts and docs/PHASE4_BENCH_WORKER.md.
  // Phase-5: durable bench job queue — same lazy-table pattern as
  // BenchHistory (own connection to the SQLite file, storage.ts untouched).
  // Queued jobs survive daemon restarts; runs that die mid-flight are
  // recorded as interrupted failures on the next start (never silently
  // re-executed). See docs/PHASE5_BENCH_DURABLE.md.
  const benchJobStore = new BenchJobStore(new Database(config.dbPath));
  const benchWorker = new BenchWorker({
    history: benchHistory,
    jobStore: benchJobStore,
    notifyOwner: async (text) => {
      const api = benchNotifyApi;
      if (api === undefined || identity.ownerId === undefined) return;
      await api.sendMessage(identity.ownerId, text).catch(() => undefined);
    },
    buildLive: defaultLiveStackBuilder(config.dbPath),
    // The worker's owner DMs follow the owner's /lang, like the rest of
    // the bot's proactive messages.
    lang: resolveLang(String(identity.ownerId ?? 0), (uid, key) =>
      storage.getUserPref(uid, key),
    ),
    log: (message) => log.warn(message),
  });
  const runBenchTool = createRunBenchTool({
    history: benchHistory,
    isOwner: (userId) => identity.isOwner(Number(userId)),
    notifyOwner: async (text) => {
      const api = benchNotifyApi;
      if (api === undefined || identity.ownerId === undefined) return;
      await api.sendMessage(identity.ownerId, text).catch(() => undefined);
    },
    buildLive: defaultLiveStackBuilder(config.dbPath),
    enqueueJob: (spec) => benchWorker.enqueue(spec),
  });

  // Phase-3 group assistant: in-process message buffer for /gsummary (and the
  // Phase-4 scheduled group digests). Deliberately NOT persisted (privacy);
  // the mode itself is opt-in per group. Created here because the Phase-4
  // group_digest tool (registered in extraTools below) reads from it.
  const groupHistory = createGroupHistory();

  // Phase 4: semantic memory search. Memories are vectorised with the
  // OWNER'S configured provider (embeddings leave the box to that provider's
  // service — see docs/PHASE4_MEMORY.md) and recall ranks by cosine
  // similarity, falling back to text search whenever embeddings are
  // unavailable. The vector table lives on the same SQLite file via its own
  // handle (curator/bench lazy pattern); storage.ts is untouched.
  // AdapterRegistry is built here — earlier than before — because the
  // provider embedder needs it; the later construction site was removed.
  // Phase 5: recall fuses the text and vector rankings with Reciprocal Rank
  // Fusion (searchMode "hybrid"); each vector records its embedding model
  // id, so a model/provider change marks old rows stale (never mixed into
  // cosine ranking) and the bounded backfill re-embeds them.
  const adapters = new AdapterRegistry();
  const memoryProvider = resolveMemoryProvider(storage);
  const memoryEmbedder = new ProviderEmbedder({ storage, secrets, adapters });
  const memoryVectors = new MemoryVectorStore(new Database(config.dbPath));
  const semanticMemory = new SemanticMemorySearch({
    provider: memoryProvider,
    vectors: memoryVectors,
    embedder: memoryEmbedder,
  });
  // Phase 5: report the vector-index health at startup (owner-visible,
  // log-only — no user-facing strings). Never throws: indexState degrades
  // to raw counts when embeddings are unavailable.
  const memIndexState = await semanticMemory.indexState(
    identity.ownerId === undefined ? "" : String(identity.ownerId),
  );
  log.info(
    `semantic memory search: ${
      memIndexState.enabled
        ? `enabled (hybrid FTS+vector ranking via active provider, model ${
            memIndexState.model || "?"
          }, index ${memIndexState.fresh} fresh / ${memIndexState.stale} stale / ${memIndexState.missing} missing)`
        : "disabled — text search only (no embedding-capable provider, or BOBI_SEMANTIC_MEMORY=0)"
    }`,
  );

  const extraTools: Tool<unknown, unknown>[] = [
    // Phase D2: the memory tools run against the configured MemoryProvider
    // (BOBI_MEMORY_PROVIDER, default "sqlite"), not Storage directly.
    // Phase 4: + semantic ranking through the provider embedder.
    ...createMemoryTools({ provider: memoryProvider, semantic: semanticMemory }),
    // Phase D1: full-text search over the caller's own conversation history.
    ...createHistoryTools({ storage }),
    ...createReminderTools({ storage }),
    // Stage-3: proactive smart follow-ups — the bot remembers what the user
    // forgot. Tools are scoped to the server-side actor's userId; nothing is
    // noted unless the model calls note_followup.
    ...createNudgeTools({ tracker: nudgeTracker, defaultTimezone: config.timezone }),
    // Goals are owner-only like scheduled tasks: they hand the heartbeat
    // standing context to work toward on its own, so both the tool-level
    // check (isOwner) and the bridge's ownerOnly withholding apply.
    ...createGoalTools({
      storage,
      isOwner: (userId) => identity.isOwner(Number(userId)),
    }),
    // Scheduled tasks are owner-only: creation hands the scheduler standing
    // permission to act with the creator's authority, so both the tool-level
    // check (isOwner) and the bridge's ownerOnly withholding apply.
    ...createScheduledTaskTools({
      storage,
      isOwner: (userId) => identity.isOwner(Number(userId)),
      defaultTimezone: config.timezone,
      // Lazily resolved: a task may name any tool registered on this service,
      // including ones registered after this line runs.
      toolExists: (name) => tools.registry.find(name) !== undefined,
    }),
    // Per-run usage/cost report (schema 17 ledger). Owner-only: it aggregates
    // across all users, so the tool-level check (isOwner) and the bridge's
    // ownerOnly withholding both apply.
    createUsageReportTool({
      storage,
      isOwner: (userId) => identity.isOwner(Number(userId)),
    }) as Tool<unknown, unknown>,
    // Phase-3: scheduled benchmarks + quality alerts. Owner-only; runs the
    // bench suite (offline always, live only when a provider is configured)
    // and alerts the owner on quality regression. The notifyOwner channel is
    // resolved lazily because the bot API is not available until createBot
    // runs below (benchNotifyApi is assigned right after).
    runBenchTool as Tool<unknown, unknown>,
    // Stage 3: proactive Persian morning digest. Owner-only; composed from
    // the owner's own data (tasks, reminders, memories, usage) + external
    // headlines (labelled as such). Called by the morning_digest blueprint's
    // scheduled agent task at 08:00 Asia/Tehran.
    createDigestTool({
      storage,
      proposalStore,
      isOwner: (userId) => identity.isOwner(Number(userId)),
      ...(digestSearchHeadlines !== undefined
        ? { searchHeadlines: digestSearchHeadlines }
        : {}),
    }) as Tool<unknown, unknown>,
    // Phase D4: memory curator. Reviews long-term memory and stores proposals
    // (duplicates, stale entries, overloaded entries). The store keeps its own
    // curator_proposals table on the same SQLite file, created lazily with
    // CREATE TABLE IF NOT EXISTS — storage.ts is not touched. Owner-only, and
    // a proposal is applied only via curator_decide with an explicit approve,
    // so nothing rewrites memory without the owner's say.
    ...createCuratorTools({
      provider: resolveMemoryProvider(storage),
      store: proposalStore,
      isOwner: (userId) => identity.isOwner(Number(userId)),
    }),
    ...mcpTools(mcp),
  ];
  // Phase-4: scheduled group digests. Owner-only tool run by the digest
  // scheduled tasks (action {type:"tool", tool:"group_digest"}): builds the
  // deterministic statistical summary and DMs it to the owner — no LLM,
  // never posted into the group. Registered only when an owner is
  // configured; without an owner the digest subcommands have no schedule
  // port and report unavailability.
  //
  // Phase-5: the smart-summary port is assigned below, after the AI gateway
  // exists; the digest tool reads deps.smart at run time, so the assignment
  // lands before any scheduled run. Declared outside the owner check so the
  // later wiring can reach it.
  let groupDigestToolDeps: GroupDigestToolDeps | undefined;
  if (identity.ownerId !== undefined) {
    const digestOwnerId = String(identity.ownerId);
    groupDigestToolDeps = {
      storage,
      ownerId: digestOwnerId,
      isOwner: (userId) => identity.isOwner(Number(userId)),
      history: groupHistory,
      notifyOwner: async (text) => {
        const api = groupDigestNotifyApi;
        if (api === undefined) return;
        await api.sendMessage(identity.ownerId as number, text).catch(() => undefined);
      },
      ownerLang: () =>
        resolveLang(digestOwnerId, (uid, key) => storage.getUserPref(uid, key)),
      log: (message) => log.error(message),
    };
    extraTools.push(createGroupDigestTool(groupDigestToolDeps) as Tool<unknown, unknown>);
  }
  if (searchEnabled) {
    extraTools.push(
      createWebSearchTool({ resolve: () => search.active() }) as Tool<unknown, unknown>,
    );
  }
  // Image generation needs a configured endpoint: with no base URL the tool
  // is not registered at all, so the model never sees a tool it cannot use.
  if (imageGenConfigured(config.imageBaseUrl)) {    extraTools.push(
      createImageGenTool({
        baseUrl: config.imageBaseUrl,
        model: config.imageModel,
        ...(config.imageApiKey !== undefined ? { apiKey: config.imageApiKey } : {}),
      }) as Tool<unknown, unknown>,
    );
  }
  // Phase E5: video generation, wired exactly like image_gen. The tool reads
  // its own env keys (BOBI_VIDEO_* with SOL_VIDEO_* fallback) through
  // videoGenDepsFromEnv, because the shared config loader is owned by another
  // work package. With no base URL the tool is not registered at all, so the
  // model never sees a tool it cannot use.
  {
    const videoDeps = videoGenDepsFromEnv();
    if (videoGenConfigured(videoDeps.baseUrl)) {
      extraTools.push(
        createVideoGenTool({
          baseUrl: videoDeps.baseUrl,
          model: videoDeps.model,
          ...(videoDeps.apiKey !== undefined ? { apiKey: videoDeps.apiKey } : {}),
        }) as Tool<unknown, unknown>,
      );
    }
  }

  // Phase E2: plugins. Each plugin is a directory `<pluginsDir>/<name>/` with
  // a plugin.md manifest plus optional skills/ and hooks/ subdirectories.
  // Plugins COMPOSE existing primitives only — a plugin can never execute
  // code; its skills are prompt guidance and its hooks are validated tool
  // actions (see src/plugins/loader.ts for the security model). Read via
  // process.env directly: this is a deploy-time path choice, not bot config.
  const pluginsDir = (process.env.BOBI_PLUGINS_DIR ?? "").trim() || "./plugins";
  const plugins = loadPlugins(pluginsDir, {
    warn: (message, fields) => log.warn(`[plugins] ${message}`, fields),
  });
  if (plugins.length > 0) {
    log.info("plugins loaded", {
      count: plugins.length,
      plugins: plugins.map((p) => `${p.name}@${p.version}`),
    });
  }

  // Lifecycle hooks (Phase E2): `<hooksDir>/<event>/*.md` plus every loaded
  // plugin's hooks. Hook files live in an owner-controlled directory (same
  // trusted tier as skills/ and .env); hook actions run as the triggering
  // turn's actor, never escalated.
  const hooksDir = (process.env.BOBI_HOOKS_DIR ?? "").trim() || "./hooks";
  const hookRunner = new HookRunner({
    hookDirs: [hooksDir],
    extraHooks: plugins.flatMap((p) => p.hooks),
    warn: (message, fields) => log.warn(`[hooks] ${message}`, fields),
  });

  // Skill registry: owner-authored markdown playbooks matched against each
  // user message and pasted into the system prompt. The directory is an
  // owner-only configuration surface (like .env); the cache reloads when its
  // mtime changes, so a new skill takes effect without a restart.
  // Plugin skills merge in after the directory's own skills (a plugin can
  // never shadow an owner skill of the same name).
  const skills = new SkillCache(config.skillsDir, {
    extraSkills: plugins.flatMap((p) => p.skills),
  });
  extraTools.push(createSkillsTool({ cache: skills }) as Tool<unknown, unknown>);

  // Phase D3: project context files (AGENTS.md/SOUL.md by default, or
  // BOBI_CONTEXT_FILES). Owner-authored local files pasted into the system
  // prompt per turn; the cache reloads on mtime change without a restart.
  const contextFiles = new ContextFileCache(undefined, {
    warn: (message, fields) => log.warn(`[context-files] ${message}`, fields),
  });

  const tools = new ToolService({
    extraTools,
    onError: (info) =>
      console.error(
        `[sol] tool error: tool=${info.tool} kind=${info.kind} user=${info.userId} ms=${info.durationMs}`,
      ),
    // Phase E2: every tool execution emits `tool:end` with a secret-free
    // payload (name, status, duration — never input/output contents). The
    // runner executes matching hooks as the SAME actor the tool ran as, so a
    // hook can never escalate beyond the turn that triggered it; hook
    // executions suppress their own emission to prevent re-entrant loops.
    onToolEnd: (payload, actor) => {
      void hookRunner.runHooks("tool:end", payload, { tools, actor });
    },
  });
  // Phase E4: dynamic tool discovery. Registered after construction so the
  // viewer closure can reference the finished service; the Executor looks
  // tools up per call, so late registration is safe. Wired with the
  // actor-filtered viewer (toolSearchDeps) — never the raw registry — so a
  // non-owner cannot discover ownerOnly tools through it.
  tools.registry.register(
    createToolSearchTool(tools.toolSearchDeps()) as Tool<unknown, unknown>,
  );
  // AdapterRegistry is built once, up near the memory tools (Phase 4: the
  // provider embedder needs it too); reused here for the provider services.
  const providerSvc = new ProviderService(storage, secrets, adapters);
  const modelSvc = new ModelService(storage);
  const healthSvc = new ProviderHealthService(storage, providerSvc, secrets, adapters);
  const gateway = new AiGateway({ storage, adapters, secrets });

  // Per-run token/cost accounting (usage ledger). Diagnostic only: recording
  // never fails a turn — UsageTracker.record() swallows its own errors and
  // the engine wraps the observer too. providerId/conversationId fall back
  // to 0 (unknown) rather than a guess when they cannot be resolved.
  const usageTracker = new UsageTracker(storage, (message, fields) =>
    log.warn(`[usage] ${message}`, fields),
  );
  const recordRunUsage = (info: RunUsageInfo): void => {
    usageTracker.record({
      userId: info.userId,
      conversationId: /^\d+$/.test(info.conversationId) ? Number(info.conversationId) : 0,
      providerId: gateway.currentSelection()?.providerId ?? 0,
      modelId: info.model,
      usage: { inputTokens: info.inputTokens, outputTokens: info.outputTokens },
      at: Date.now(),
    });
  };

  // Per-user budgets. Declared before the engine because the engine consults
  // the tool budget on every tool call.
  const usage = new UsageService(storage);
  const rateLimit = new RateLimiter({
    messages: { limit: config.rateLimitPerMinute, windowMs: 60_000 },
    toolCalls: { limit: config.rateLimitToolCallsPerHour, windowMs: 60 * 60_000 },
  });

  // The engine talks to the gateway, never to a specific service. The provider
  // is resolved PER TURN (not once at startup) so adding or switching a
  // provider from /ai or the Mini App takes effect immediately — no restart
  // needed. Falls back to FakeProvider when nothing is selected yet, so local
  // development and the test suite stay offline.
  const fakeFallback = new FakeProvider();
  const currentProvider = (): AiProvider =>
    gateway.currentSelection() !== undefined ? gateway : fakeFallback;
  const provider: AiProvider = {
    name: "bobi",
    complete: (req) => currentProvider().complete(req),
    supportsAudioInput: () => currentProvider().supportsAudioInput?.() ?? false,
    supportsDocumentInput: () => currentProvider().supportsDocumentInput?.() ?? false,
  };
  const selection = gateway.currentSelection();

  // Phase-5: opt-in LLM smart summaries for group discussions. Resolved per
  // call so it starts working as soon as a real provider is selected — no
  // restart. Degrades to the deterministic summary while unconfigured
  // (FakeProvider = theater, not intelligence). Runs through
  // gateway.completeForModel() so the stored selection is re-validated per
  // call; tool-free single-turn completion.
  const smartSummaryPort: SmartSummaryPort = {
    summarize: async (req) => {
      const sel = gateway.currentSelection();
      if (sel === undefined) throw new Error("no provider selected");
      const res = await gateway.completeForModel({
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        model: sel.modelId,
        timeoutMs: req.timeoutMs,
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      return res.text;
    },
  };
  // groupDigestToolDeps was created before the gateway existed; assign the
  // port now — the tool reads deps.smart at run time.
  if (groupDigestToolDeps !== undefined) {
    groupDigestToolDeps.smart = smartSummaryPort;
  }

  // Phase C3: delegation. Registered AFTER `tools` exists: the delegate tool
  // derives its depth-1 child registry from the parent ToolService (the child
  // structurally cannot delegate further), so it cannot go in extraTools.
  tools.registry.register(
    createDelegateTool({
      tools,
      provider,
      model: selection ? selection.modelId : config.aiModel,
      // The child agent's reply language follows the delegating user's /lang.
      langFor: (userId: string) =>
        resolveLang(userId, (uid, key) => storage.getUserPref(uid, key)),
    }) as Tool<unknown, unknown>,
  );

  // Phase C4: mixture-of-agents. Only with a real provider — consulting the
  // FakeProvider would be theater. Consultation routes through
  // gateway.completeForModel(), which re-validates each model against storage;
  // the main loop keeps complete(), where the stored model always wins.
  if (selection) {
    const consultProvider: AiProvider = {
      name: `consult:${provider.name}`,
      complete: (req) => gateway.completeForModel(req),
    };
    tools.registry.register(
      createConsultModelsTool({
        provider: consultProvider,
        primaryModel: selection.modelId,
        // Fresh per call, never cached: only owner-configured model ids are
        // ever consultable (server-side allowlist enforced inside the tool).
        listConfiguredModels: () => {
          const sel = gateway.currentSelection();
          if (!sel) return [];
          return modelSvc.enabledModels(sel.providerId).map((m) => m.modelId);
        },
      }) as Tool<unknown, unknown>,
    );
  }
  const engine = new ConversationEngine({
    provider,
    model: selection ? selection.modelId : config.aiModel,
    timeoutMs: config.aiTimeoutMs,
    maxConcurrent: config.aiMaxConcurrent,
    storage,
    tools,
    skills,
    contextFiles,
    // Per-run token/cost accounting → usage_ledger (diagnostic, never throws).
    onRunUsage: recordRunUsage,
    // Phase E2: lifecycle hooks. `agent:start` fires before each agent loop,
    // `agent:end` after it settles; hook actions run as the turn's actor.
    hooks: hookRunner,
    timezone: config.timezone,
    memoryCount: (userId) => storage.countMemories(userId),
    // Phase G1: per-user personality skin, validated against the built-in
    // list — only a canonical skin name ever reaches the prompt.
    personalityFor: (userId: string) =>
      resolvePersonalityName(storage.getUserPref(userId, PERSONALITY_PREF_KEY)),
    // Bilingual agent output: the turn's user's /lang pref reaches the
    // agent's system prompt. Server-side lookup (resolveLang), so a corrupt
    // pref falls back to Persian and never to a language that does not exist.
    // Explicit ConversationInput.lang from the bot layer always wins.
    langFor: (userId: string) =>
      resolveLang(userId, (uid, key) => storage.getUserPref(uid, key)),
    // The owner is not budgeted against their own tool use.
    allowToolCall: (userId) =>
      identity.isOwner(Number(userId)) || rateLimit.takeToolCall(userId).allowed,
    budgets: {
      maxIterations: config.agentMaxIterations,
      maxToolCalls: config.agentMaxToolCalls,
      totalTimeoutMs: config.agentTotalTimeoutMs,
    },
    ...(config.extraSystemPrompt !== undefined
      ? { extraPrompt: config.extraSystemPrompt }
      : {}),
  });

  log.info(bootstrapMessage());
  // The owner id itself is never logged, only the fact that one is set.
  log.info("owner identity configured");

  // Owner notifications go out through the bot's API surface. The bot needs the
  // panel for `/admin` and panel callbacks, so the panel is built first with a
  // sender that resolves the bot lazily — Telegram delivery is its only
  // dependency, and a delivery failure leaves a group pending, never approved.
  let botApi: Bot["api"] | undefined;

  const panel = new PanelController({
    auth,
    admin,
    groups,
    // Panels follow the owner's /lang choice (same as AiAdminController).
    prefs: (u, k) => storage.getUserPref(u, k),
    notify: async (chatId, text, keyboard) => {
      if (!botApi) return false;
      try {
        await botApi.sendMessage(chatId, text, { reply_markup: keyboard as never });
        return true;
      } catch (err) {
        // Sanitized: no token, no payload, no stack trace.
        log.error("owner notification failed", { error: errToLog(err) });
        return false;
      }
    },
    statusInfo: () => {
      const sel = gateway.currentSelection();
      return {
        // Operational metadata only: the provider kind and model id.
        provider: sel ? sel.adapterType : provider.name,
        model: sel ? sel.modelId : config.aiModel,
      };
    },
    usageInfo: () => {
      const sel = gateway.currentSelection();
      const summary = usage.summary("", sel ? sel.modelId : config.aiModel);
      return {
        requests: summary.all.requests,
        toolCalls: summary.all.toolCalls,
        inputTokens: summary.all.inputTokens,
        outputTokens: summary.all.outputTokens,
        costUsd: summary.estimatedUsd,
        estimated: summary.estimated,
      };
    },
  });

  // The user-access panel shares the same owner-notification channel as the
  // group panel, so an approval request reaches the owner the same way.
  const userPanel = new UserPanelController({
    auth,
    admin,
    users,
    // Panels follow the owner's /lang choice (same as AiAdminController).
    prefs: (u, k) => storage.getUserPref(u, k),
    notify: async (chatId, text, keyboard) => {
      if (!botApi) return false;
      try {
        await botApi.sendMessage(chatId, text, { reply_markup: keyboard as never });
        return true;
      } catch (err) {
        log.error("owner notification failed", { error: errToLog(err) });
        return false;
      }
    },
  });

  const aiAdmin = new AiAdminController({
    auth,
    admin,
    storage,
    providers: providerSvc,
    models: modelSvc,
    health: healthSvc,
    secrets,
    adapters,
    search: searchSettings,
  });

  // Version shown by /version — read from package.json once at startup.
  const BOT_VERSION: string =
    (await Bun.file(new URL("../package.json", import.meta.url)).json().catch(() => undefined) as
      | { version?: string }
      | undefined)?.version ?? "dev";

  // (groupHistory is created above, next to extraTools — the group_digest
  // tool needs it at registration time.)
  // One options object for the system commands AND the command palette's
  // tap-to-run runners, so defaults (snapshot dir, clock, MCP…) stay in one
  // place. Passed to createBot for the palette and reused below for
  // registerSystemCommands.
  const systemOpts = {
    dbPath: config.dbPath,
    mcp,
    skills,
    proposalStore,
    isAnyTurnRunning: () => engine.isAnyTurnRunning(),
  };

  const bot = createBot(token, {
    engine,
    // Needed to download attachment bytes: Telegram reports a file's path but
    // not its content, and the download URL embeds the token.
    botToken: token,
    tools,
    auth,
    groups,
    users,
    userPanel,
    panel,
    aiAdmin,
    rateLimit,
    usage,
    // Phase B2/B3: voice transcription + TTS. Each is inert unless its base
    // URL is configured; prefs (user_prefs table) backs /voice persistence.
    ...(config.transcribeBaseUrl !== ""
      ? {
          transcribe: {
            baseUrl: config.transcribeBaseUrl,
            apiKey: config.transcribeApiKey,
            model: config.transcribeModel,
          },
        }
      : {}),
    ...(config.ttsBaseUrl !== ""
      ? {
          tts: {
            baseUrl: config.ttsBaseUrl,
            apiKey: config.ttsApiKey,
            model: config.ttsModel,
            voice: config.ttsVoice,
          },
        }
      : {}),
    prefs: storage,
    // Hermes-parity command modules need storage for /history, /save,
    // /sessions, /resume… — without it they report "unavailable".
    storage,
    // Command palette: the version string for /version's tap-run, and the
    // shared system-command options for its tap-to-run runners.
    version: BOT_VERSION,
    systemOpts,
    // Interactive /digest headlines: the same resolver the build_digest tool
    // uses. Absent = the digest simply has no headlines section.
    ...(digestSearchHeadlines !== undefined ? { digestSearchHeadlines } : {}),
    // Stage-3 group moderation: owner's numeric id for the mod gate.
    // Absent = moderation inert (default-off).
    ...(identity.ownerId !== undefined ? { moderationOwnerId: String(identity.ownerId) } : {}),
    // Phase-3 group assistant mode: opt-in per group, owner-managed.
    // Absent = the assistant hook stays inert (default-off).
    ...(identity.ownerId !== undefined
      ? { groupAssistant: { ownerId: String(identity.ownerId), history: groupHistory } }
      : {}),
  });
  botApi = bot.api;

  // ---- Hermes-parity commands (Stage 2) ----
  // 52 commands from the Hermes COMMAND_REGISTRY audit, in three modules.
  // Registration is additive: each module owns its handlers and menu entries.
  //
  // (BOT_VERSION and systemOpts are hoisted above createBot: the palette's
  // tap-to-run runners need them through BotDeps.)
  /** Human interval for /heartbeat status, e.g. "30m", "2h", "45s". */
  const formatIntervalMs = (ms: number): string => {
    if (ms <= 0) return "off";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
  };
  {
    const hermesDeps: HermesCommandDeps = {
      engine,
      storage,
      tools,
      auth,
      groups,
      users,
      userPanel,
      prefs: storage,
      ...(identity.ownerId !== undefined ? { ownerId: identity.ownerId } : {}),
      version: BOT_VERSION,
    };
    registerSessionCommands(bot, hermesDeps);
    registerSystemCommands(bot, hermesDeps, systemOpts);
    registerAutoCommands(bot, hermesDeps);
    // ---- Phase-3 commands ----
    // Group assistant mode (/gassistant owner-only, /gsummary group-visible
    // when the mode is on, /gpoll owner-only). The message-path hook lives in
    // createBot; registration here keeps index.ts as the single wiring point.
    if (identity.ownerId !== undefined) {
      const botUsername =
        (await bot.api.getMe().catch(() => undefined))?.username ?? "";
      const gaOwnerId = String(identity.ownerId);
      // Phase-4: digest task management for /gassistant digest. Implemented
      // with the real schedule_task/list_tasks/cancel_task tools and the
      // owner's live actor (same pattern as /bench schedule). The task's
      // action runs the owner-only group_digest tool, whose notify channel
      // is fixed to the owner's DM — the group chat id in the task row only
      // selects whose history is summarized.
      const ownerToolActor = () =>
        toToolActor(
          authorizeToolUse(auth, toAuthActor(gaOwnerId), tools.registry.list()),
        );
      const findDigestTaskId = async (chatId: string): Promise<number | undefined> => {
        const res = await tools.runTool({
          tool: "list_tasks",
          input: {},
          actor: ownerToolActor(),
        });
        if (res.status !== "ok") return undefined;
        const data = res.data as
          | { tasks?: Array<{ id: number; name: string }> }
          | undefined;
        return data?.tasks?.find((t) => t.name === digestTaskName(chatId))?.id;
      };
      const digestPort: DigestSchedulePort = {
        ensureDigestTask: async (chatId, timeHHMM) => {
          try {
            const actor = ownerToolActor();
            const existing = await findDigestTaskId(chatId);
            if (existing !== undefined) {
              await tools.runTool({
                tool: "cancel_task",
                input: { id: existing },
                actor,
              });
            }
            const created = await tools.runTool({
              tool: "schedule_task",
              input: {
                name: digestTaskName(chatId),
                cron: digestTimeToCron(timeHHMM),
                timezone: "Asia/Tehran",
                action: {
                  type: "tool",
                  tool: GROUP_DIGEST_TOOL_NAME,
                  input: { chatId },
                },
              },
              actor,
            });
            if (created.status !== "ok") return undefined;
            const id = (created.data as { id?: number } | undefined)?.id;
            return typeof id === "number" ? id : undefined;
          } catch {
            return undefined;
          }
        },
        cancelDigestTask: async (chatId) => {
          try {
            const existing = await findDigestTaskId(chatId);
            if (existing === undefined) return;
            await tools.runTool({
              tool: "cancel_task",
              input: { id: existing },
              actor: ownerToolActor(),
            });
          } catch {
            // Never throws by contract: a stale task row only no-ops at run
            // time (the group_digest tool re-reads the config before sending).
          }
        },
      };
      const gaEnv: GroupAssistantEnv = {
        storage,
        ownerId: gaOwnerId,
        botUsername,
        history: groupHistory,
        digest: digestPort,
        smart: smartSummaryPort,
      };
      const gaGate = async (
        ctx: Context,
        lang: "fa" | "en",
        ownerOnly: boolean,
      ): Promise<boolean> => {
        if (!(await gateGroup(ctx, groups, lang))) return false;
        if (!(await gateUser(ctx, { users, auth, userPanel }))) return false;
        if (ownerOnly && !(await requireOwnerTier(ctx, { auth }, lang))) return false;
        return true;
      };
      bot.command("gassistant", async (ctx) => {
        const lang = senderLang(ctx, storage);
        if (!(await gaGate(ctx, lang, true))) return;
        await handleGassistantCommand(ctx, gaEnv, lang);
      });
      bot.command("gsummary", async (ctx) => {
        const lang = senderLang(ctx, storage);
        if (!(await gaGate(ctx, lang, false))) return;
        await handleGsummaryCommand(ctx, gaEnv, lang);
      });
      bot.command("gpoll", async (ctx) => {
        const lang = senderLang(ctx, storage);
        if (!(await gaGate(ctx, lang, true))) return;
        await handleGpollCommand(ctx, gaEnv, lang);
      });
    }
    // Phase-3 benchmarks: /bench (owner-only). The run_bench tool is
    // registered in extraTools above; the command needs the shared history
    // and a direct runner for /bench run.
    registerBenchCommands(bot, {
      ...hermesDeps,
      history: benchHistory,
      ...(identity.ownerId === undefined
        ? {}
        : (() => {
            const ownerNumericId: number = identity.ownerId;
            return {
              runBenchNow: async (opts: {
                mode: "offline" | "live";
                taskIds?: string[];
                background?: boolean;
              }) => {
                const actor = toToolActor(
                  authorizeToolUse(auth, { id: ownerNumericId }, tools.registry.list()),
                );
                return runBenchTool.run(
                  {
                    mode: opts.mode,
                    ...(opts.taskIds !== undefined ? { tasks: opts.taskIds } : {}),
                    // Explicit false keeps the on-demand UX synchronous (the
                    // result is returned to the caller); true enqueues into
                    // the Phase-4 background worker.
                    background: opts.background ?? false,
                    source: "manual",
                  },
                  {
                    clock: () => new Date(),
                    actor,
                    signal: AbortSignal.timeout(600_000),
                  },
                );
              },
              // Phase-4: owner control over the background worker from /bench
              // (status/cancel). Structural typing — no import needed.
              benchWorker,
            };
          })()),
    });
    // The benchmark alert channel can now deliver to the owner's DM.
    benchNotifyApi = bot.api;
    // Phase-4: the group-digest channel can now DM the owner too.
    groupDigestNotifyApi = bot.api;
    // Phase-3 installable skills: /skill (owner-only).
    registerPhase3SkillsCommands(bot, hermesDeps, {
      skills,
      botToken: token,
    });
    // Phase-5 memory: /memory auto|export|import (owner-only).
    registerPhase5MemoryCommands(bot, hermesDeps, {
      prefs: storage,
      conversations: storage,
      provider: memoryProvider,
      proposalStore,
      botToken: token,
    });
    setHeartbeatInfoProvider(() => ({
      enabled: config.heartbeatIntervalMs > 0,
      interval: formatIntervalMs(config.heartbeatIntervalMs),
    }));

    // Telegram command menu: Persian by default, English via language_code.
    // Owner-only commands are scoped to the owner's chat so other users never
    // see them; handlers ALSO gate at runtime (menu hiding is not a security
    // boundary).
    //
    // The 11 built-in commands (start/help/commands/…) are not part of the Hermes
    // modules, so they are prepended here from menu.ts: core commands first,
    // then the Hermes groups in module order (session → system → automation).
    // Public scope shows the non-owner entries; the owner scope shows
    // everything.
    const hermesDefs: HermesCommandDef[] = [
      ...SESSION_COMMAND_DEFS,
      ...SYSTEM_COMMAND_DEFS,
      ...AUTO_COMMAND_DEFS,
      // Phase-3: owner-only commands (invisible to the public via ownerOnly).
      ...SKILLS_COMMAND_DEFS,
      ...BENCH_COMMAND_DEFS,
      // Phase-5: owner-only memory commands (invisible to the public via ownerOnly).
      ...PHASE5_MEMORY_COMMAND_DEFS,
      // Phase-3 group assistant (owner-gated; /gsummary usable in enabled groups).
      { command: "gassistant", descriptionFa: "حالت دستیار گروه", descriptionEn: "Group assistant mode", ownerOnly: true },
      { command: "gsummary", descriptionFa: "خلاصهٔ بحث گروه", descriptionEn: "Summarize group discussion", ownerOnly: true },
      { command: "gpoll", descriptionFa: "نظرسنجی در گروه", descriptionEn: "Create a group poll", ownerOnly: true },
    ];
    const publicDefs = publicMenuCommands(hermesDefs);
    const ownerDefs = ownerMenuCommands(hermesDefs);
    const toMenu = (defs: HermesCommandDef[], fa: boolean) =>
      defs.map((d) => ({ command: d.command, description: fa ? d.descriptionFa : d.descriptionEn }));
    const setMenu = (
      commands: { command: string; description: string }[],
      opts: { scope?: BotCommandScope; language_code?: LanguageCode } = {},
    ) => {
      const params = {
        ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
        ...(opts.language_code !== undefined ? { language_code: opts.language_code } : {}),
      };
      return bot.api
        .setMyCommands(commands, params)
        .catch((err) => log.warn("[commands] setMyCommands failed", { error: errToLog(err) }));
    };
    void setMenu(toMenu(publicDefs, true));
    void setMenu(toMenu(publicDefs, false), { language_code: "en" });
    if (identity.ownerId !== undefined) {
      const ownerScope: BotCommandScope = { type: "chat", chat_id: identity.ownerId };
      void setMenu(toMenu(ownerDefs, true), { scope: ownerScope });
      void setMenu(toMenu(ownerDefs, false), { scope: ownerScope, language_code: "en" });
    }

    // One-tap Mini App access: the persistent menu button next to the message
    // input opens the owner Mini App directly as a Web App. Owner chat only
    // (two-tier: invisible to everyone else). Fail-closed: no public URL → no
    // button override, the default menu button stays.
    const miniUrl = miniAppUrl();
    if (miniUrl !== undefined && identity.ownerId !== undefined) {
      void bot.api
        .setChatMenuButton({
          chat_id: identity.ownerId,
          menu_button: {
            type: "web_app",
            text: "🛠️ مدیریت",
            web_app: { url: miniUrl },
          },
        })
        .catch((err) => log.warn("[commands] setChatMenuButton failed", { error: errToLog(err) }));
    }
  }

  // Reminders run in-process: a bot that only answers when spoken to cannot
  // deliver one on its own. The scheduler is started after the bot so `botApi`
  // is available to the delivery path.
  const scheduler = new ReminderScheduler({
    storage,
    intervalMs: config.schedulerIntervalMs,
    deliver: async ({ chatId, userId, text }) => {
      // Access is re-checked at DELIVERY time, not only when the reminder was
      // created. Revoking a user must stop the bot talking to them, and an
      // approval re-read on every message would otherwise be undermined by a
      // reminder set days earlier.
      if (userId !== undefined && !mayDeliverTo(userId, chatId)) {
        log.info("reminder suppressed: recipient no longer approved", { userId });
        return true; // Claimed and retired; not a delivery failure.
      }

      try {
        await bot.api.sendMessage(chatId, text);
        return true;
      } catch (err) {
        log.error("reminder delivery failed", { error: errToLog(err) });
        return false;
      }
    },
    onError: (message) => log.error(message),
  });
  scheduler.start();

  // Stage-3: proactive follow-up sweep, on the same in-process timer as
  // reminders: a bot that only answers when spoken to cannot resurface a
  // follow-up on its own. The sweep only BUILDS messages — delivery here
  // re-checks access at delivery time via mayDeliverTo, exactly like
  // reminders, and each message goes ONLY to the nudge's own userId
  // (chat_id = user id is the DM convention, per mayDeliverTo) — never a
  // group, never another user's DM.
  //
  // Phase-3: the sweep also carries the owner's dated-event reminders
  // (birthdays, recurring commitments) via the optional events dep — the
  // EventStore rides on the same MemoryProvider, so per-user scoping is
  // free and public users get nothing new.
  const eventStore = new EventStore(resolveMemoryProvider(storage));
  const nudgeSweepTimer = setInterval(() => {
    void (async () => {
      try {
        const deliveries = await sweepNudges({
          tracker: nudgeTracker,
          max: 5,
          ...(identity.ownerId !== undefined
            ? { events: { store: eventStore, userId: String(identity.ownerId) } }
            : {}),
        });
        for (const d of deliveries) {
          if (!mayDeliverTo(d.userId, d.userId)) {
            log.info("nudge suppressed: recipient no longer approved", { userId: d.userId });
            continue;
          }
          try {
            await bot.api.sendMessage(d.userId, d.message);
          } catch (err) {
            log.error("nudge delivery failed", { error: errToLog(err) });
          }
        }
        // Phase-5: opt-in automatic event extraction from the owner's own
        // conversations. This runs HERE — in the background sweep — and
        // NEVER in the chat turn, so it adds zero reply latency. The scan
        // checks the owner pref first and returns after a single pref read
        // when disabled (the default), so a stock instance pays ~nothing.
        // Candidates become curator proposals (kind "event"); nothing is
        // stored without the owner's curator_decide approval.
        if (identity.ownerId !== undefined) {
          try {
            const ex = await scanForEventCandidates({
              prefs: storage,
              conversations: storage,
              provider: memoryProvider,
              proposalStore,
              ownerId: String(identity.ownerId),
              nowMs: Date.now(),
            });
            if (ex.enabled && ex.newProposals > 0) {
              log.info("auto event extraction: new proposals", {
                count: ex.newProposals,
              });
            }
          } catch (err) {
            log.error("auto event extraction sweep failed", { error: errToLog(err) });
          }
        }
      } catch (err) {
        log.error("nudge sweep failed", { error: errToLog(err) });
      }
    })();
  }, config.schedulerIntervalMs);
  nudgeSweepTimer.unref?.();

  // Scheduled tasks (cron) run on the same in-process timer as reminders, for
  // the same reason: a bot that only answers when spoken to cannot act on a
  // schedule by itself. Started after the bot so botApi is available.
  //
  // SECURITY: task actions run with the CREATING owner's live permissions
  // (actorForUser), resolved server-side per run — never from the task row.
  // Task creation is owner-only (see schedule_task), so this delegates the
  // owner's own authority to a schedule they wrote.
  //
  // The server-side actor builder is shared with the heartbeat: both build
  // their actors from server-side facts, never from anything the model said.
  // A malformed id yields an undefined auth actor and no permissions — fail
  // closed (see toAuthActor).
  const actorForUser = (userId: string): ToolActor =>
    toToolActor(authorizeToolUse(auth, toAuthActor(userId), tools.registry.list()));
  const taskScheduler = new TaskScheduler({
    storage,
    tools,
    intervalMs: config.schedulerIntervalMs,
    sendMessage: async ({ chatId, userId, text }) => {
      // Access re-checked at DELIVERY time, like reminders: revoking a user
      // must stop scheduled messages from reaching them.
      if (!mayDeliverTo(userId, chatId)) {
        log.info("scheduled task message suppressed: recipient no longer approved", { userId });
        return true; // Claimed and retired; not a delivery failure.
      }
      try {
        await bot.api.sendMessage(chatId, text);
        return true;
      } catch (err) {
        log.error("scheduled task message failed", { error: errToLog(err) });
        return false;
      }
    },
    runAgent: async ({ chatId, userId, prompt }) => {
      // An agent action is a full agent run as the task's creator, with the
      // answer delivered to the task's chat.
      try {
        const actor = toToolActor(
          authorizeToolUse(auth, toAuthActor(userId), tools.registry.list()),
        );
        const out = await engine.respond({
          conversationId: chatId,
          userId,
          userText: prompt,
          // Bilingual agent output: the scheduled run answers in its
          // creator's /lang — the userId here is the task's creator.
          lang: resolveLang(userId, (uid, key) => storage.getUserPref(uid, key)),
          actor,
        });
        for (const chunk of out.chunks) {
          await bot.api.sendMessage(chatId, chunk);
        }
        // Tool-produced media follows the text on scheduled runs too.
        for (const part of out.media.slice(0, MAX_MEDIA_PER_REPLY)) {
          const m = describeMediaPart(part);
          if (m === undefined) continue;
          if (m.kind === "photo") await bot.api.sendPhoto(chatId, m.file);
          else if (m.kind === "voice") await bot.api.sendVoice(chatId, m.file);
          else await bot.api.sendDocument(chatId, m.file);
        }
        return true;
      } catch (err) {
        log.error("scheduled agent run failed", { error: errToLog(err) });
        return false;
      }
    },
    actorForUser,
    onError: (message) => log.error(message),
  });
  taskScheduler.start();

  // Phase-4: benchmark background worker. Started with the other schedulers
  // so a queued live run survives as long as the daemon does. The pump timer
  // is unref'd — it never keeps the process alive on its own.
  benchWorker.start();

  // Heartbeat: the owner's autonomous tick (Phase C2). It runs on a DEDICATED
  // engine with tight per-beat budgets that shares provider/storage/tools/
  // model with the main engine. The beat's agent gets the NORMAL toolset and
  // MAY call schedule_task — that is the point: autonomy. See
  // src/autonomy/heartbeat.ts for the security model.
  //
  // SECURITY: the heartbeat runs AS THE OWNER (actorForOwner built
  // server-side from the validated owner id). It is DISABLED unless
  // HEARTBEAT_INTERVAL_MS is set — acting without being spoken to is an
  // explicit owner choice.
  const ownerIdStr = String(ownerId.ownerId);
  const heartbeatEngine = new ConversationEngine({
    provider,
    model: selection ? selection.modelId : config.aiModel,
    timeoutMs: config.aiTimeoutMs,
    maxConcurrent: config.aiMaxConcurrent,
    storage,
    tools,
    timezone: config.timezone,
    // Heartbeat turns are accounted too (they run as the owner).
    onRunUsage: recordRunUsage,
    // A beat is a small autonomous pass, never a full conversation: a
    // runaway beat cannot exceed these per-beat budgets.
    budgets: { maxIterations: 3, maxToolCalls: 5, totalTimeoutMs: 60_000 },
    // Bilingual agent output: the heartbeat runs as the owner, so it speaks
    // the owner's /lang.
    langFor: (userId: string) =>
      resolveLang(userId, (uid, key) => storage.getUserPref(uid, key)),
  });
  const heartbeat = new HeartbeatService({
    engine: heartbeatEngine,
    storage,
    ownerId: ownerIdStr,
    actorForOwner: () => actorForUser(ownerIdStr),
    isFake: () => heartbeatEngine.isFake,
    intervalMs: config.heartbeatIntervalMs,
    log,
  });
  heartbeat.start();
  if (config.heartbeatIntervalMs > 0) {
    // Only the interval is logged — the owner id is never logged.
    log.info("heartbeat enabled", { intervalMs: config.heartbeatIntervalMs });
  }

  /**
   * Whether the bot may still send to this reminder's recipient.
   *
   * The owner is always allowed. A private-chat recipient needs an approved
   * row; a group recipient needs its group approved, matching the gate every
   * incoming message passes through.
   */
  function mayDeliverTo(userId: string, chatId: string): boolean {
    if (identity.isOwner(Number(userId))) return true;

    // A negative chat id is a group; the owner's own id is used for direct
    // reminders, so the two cases are distinguishable without extra state.
    if (chatId.startsWith("-")) return groups.isApproved(chatId);
    return users.isApproved(userId);
  }

  /**
   * Server-side authorization actor for a numeric user id string.
   *
   * Undefined when the id is not a valid Telegram id, which yields no
   * permissions downstream — fail closed.
   */
  function toAuthActor(userId: string): { id: number } | undefined {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    return { id };
  }

  // The API server (health + miniapp + turn) prefers BOBI_API_PORT, then the
  // platform's PORT (Railway et al. route public traffic to $PORT). Computed
  // up here so the standalone health server below can stand down when it
  // would bind the same socket — the API server already answers /health.
  const apiPortRaw = Number((process.env.BOBI_API_PORT ?? process.env.PORT ?? "").trim());
  const apiPort =
    Number.isSafeInteger(apiPortRaw) && apiPortRaw > 0 && apiPortRaw < 65536
      ? apiPortRaw
      : DEFAULT_API_PORT;

  // Health endpoint. Started only when a port is configured, so a local run
  // opens no socket at all. A hosting platform polls this to decide whether the
  // deploy is alive, and a long-polling bot has no other socket to offer.
  // Skipped when it would collide with the API server's own /health.
  const health =
    config.healthPort > 0 && config.healthPort !== apiPort
      ? await startHealthServer({
          port: config.healthPort,
          detail: () => ({
            tools: tools.listActiveNames().length,
            scheduler: scheduler.isRunning,
            taskScheduler: taskScheduler.isRunning,
            // Phase-4: benchmark background worker state (idle/running).
            benchWorker: benchWorker.snapshot().state,
          }),
          onError: (message) => log.error("health server failed to start", { error: message }),
        })
      : undefined;
  if (health !== undefined) log.info("health endpoint listening", { port: health.port });

  // Phase E5: minimal HTTP API (GET /health, POST /api/v1/turn). The server
  // always starts: every endpoint guards itself. Without BOBI_API_TOKEN,
  // /api/v1/turn and /dashboard answer 503 ("not configured") and only
  // /health (public by design) plus /miniapp/* stay live — and /miniapp/*
  // authenticates every call via Telegram initData HMAC plus a server-side
  // owner check, never touching the API token. Wrapped in try/catch so an
  // API failure can never crash the bot. The token is never logged; only
  // the bind address is.
  let apiServer: ApiServer | undefined;
  const apiToken = (process.env.BOBI_API_TOKEN ?? "").trim();
  {
    const apiBind = (process.env.BOBI_API_BIND ?? "").trim() || DEFAULT_API_BIND;
    try {
      apiServer = createApiServer(
        {
          storage,
          // The main engine is shared: the turn endpoint gets the full tool
          // set, budgets, and skills of a normal owner conversation.
          engineFactory: () => engine,
          actorForOwner: () => actorForUser(ownerIdStr),
          token: apiToken,
          // Phase-5: the dashboard's live benchmark stream reads progress
          // from the daemon worker (SSE on the same server, Bearer auth).
          benchWorker,
          // Mini App: the owner's complete remote control, served on this
          // same socket. Auth is Telegram initData HMAC + server-side owner
          // check on every /miniapp/api/* call (see src/miniapp/auth.ts).
          miniapp: {
            storage,
            providerSvc,
            modelSvc,
            health: healthSvc,
            engineFactory: () => engine,
            actorForOwner: () => actorForUser(ownerIdStr),
            ownerId: ownerIdStr,
            botToken: token,
            webDir: fileURLToPath(new URL("./miniapp/web", import.meta.url)),
            log: (message, fields) => log.info(message, fields),
          },
          log: (message, fields) => log.info(message, fields),
        },
        { port: apiPort, host: apiBind },
      );
      log.info("API server listening", { bind: apiBind, port: apiPort });
    } catch (err) {
      log.error("API server failed to start", { error: errToLog(err) });
    }
  }

  // Graceful shutdown
  const stop = (): void => {
    log.info("shutting down");
    // Stop the schedulers before the database closes: a pass in flight would
    // otherwise write to a closed handle. The heartbeat stops here too.
    heartbeat.stop();
    scheduler.stop();
    taskScheduler.stop();
    // Phase-4: stop the bench worker's pump and cooperatively abort an
    // active run before the database closes.
    benchWorker.stop();
    clearInterval(nudgeSweepTimer);
    void health?.close();
    apiServer?.stop();
    // Close MCP servers so their child processes are reaped rather than left
    // orphaned when the bot exits.
    void mcp.closeAll();
    // Abort in-flight agent runs first, so a tool or provider call is not left
    // writing to a database handle that is about to close.
    engine.cancelAll();
    void bot.stop();
    storage.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await bot.start({
    onStart: (info) => {
      log.info("bot started", {
        username: info.username,
        env: config.env,
        provider: provider.name,
        tools: tools.listActiveNames(),
        search: searchEnabled,
      });
      // Phase E2: `startup` hooks run once, after the bot is up. There is no
      // turn yet, so the caller passes the owner actor explicitly — startup
      // hooks are owner-installed configuration (same trusted tier as skills
      // and .env), and only the server owner may write hook files. runHooks
      // never throws, but a failure here must not break startup either, so it
      // stays fire-and-forget.
      void hookRunner
        .runHooks(
          "startup",
          {
            event: "startup",
            at: new Date().toISOString(),
            ...(info.username !== undefined ? { botUsername: info.username } : {}),
          },
          { tools, actor: actorForUser(ownerIdStr) },
        )
        .catch(() => undefined);
    },
  });
}

function errToLog(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

main().catch((err: unknown) => {
  // Short, non-secret error — never print config/token.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`startup failed: ${msg}`);
  process.exitCode = 1;
});
