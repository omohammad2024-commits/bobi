import { bootstrapMessage } from "./core/app";
import { loadConfig, requireBotToken } from "./config/config";
import { createBot, PERSONALITY_PREF_KEY } from "./bot/bot";
import { publicMenuCommands, ownerMenuCommands } from "./bot/menu";
import { resolvePersonalityName } from "./personality/personalities";
import { describeMediaPart, MAX_MEDIA_PER_REPLY } from "./bot/media";
import type { Bot } from "grammy";
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
import { createReminderTools } from "./tools/reminders";
import { createNudgeTools } from "./tools/nudge_tool";
import { NudgeTracker } from "./nudges/tracker";
import { sweepNudges } from "./nudges/sweep";
import { createScheduledTaskTools } from "./tools/scheduled_tasks";
import { createUsageReportTool } from "./tools/usage_report";
import { createDigestTool } from "./tools/digest_tool";
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

  const extraTools: Tool<unknown, unknown>[] = [
    // Phase D2: the memory tools run against the configured MemoryProvider
    // (BOBI_MEMORY_PROVIDER, default "sqlite"), not Storage directly.
    ...createMemoryTools({ provider: resolveMemoryProvider(storage) }),
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
    // Stage 3: proactive Persian morning digest. Owner-only; composed from
    // the owner's own data (tasks, reminders, memories, usage) + external
    // headlines (labelled as such). Called by the morning_digest blueprint's
    // scheduled agent task at 08:00 Asia/Tehran.
    createDigestTool({
      storage,
      proposalStore,
      isOwner: (userId) => identity.isOwner(Number(userId)),
      ...(searchEnabled
        ? {
            searchHeadlines: async (query: string, limit: number, signal: AbortSignal) =>
              (await search.active().search({ query, limit, timeoutMs: 12_000, signal })).map((r) => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet,
              })),
          }
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
  if (searchEnabled) {
    extraTools.push(
      createWebSearchTool({ resolve: () => search.active() }) as Tool<unknown, unknown>,
    );
  }
  // Image generation needs a configured endpoint: with no base URL the tool
  // is not registered at all, so the model never sees a tool it cannot use.
  if (imageGenConfigured(config.imageBaseUrl)) {
    extraTools.push(
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
  const adapters = new AdapterRegistry();
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

  // The engine talks to the gateway, never to a specific service. FakeProvider
  // is only used when no real provider is selected, so local development and
  // the test suite stay offline.
  const selection = gateway.currentSelection();
  const provider = selection ? gateway : new FakeProvider();

  // Phase C3: delegation. Registered AFTER `tools` exists: the delegate tool
  // derives its depth-1 child registry from the parent ToolService (the child
  // structurally cannot delegate further), so it cannot go in extraTools.
  tools.registry.register(
    createDelegateTool({
      tools,
      provider,
      model: selection ? selection.modelId : config.aiModel,
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
    // Stage-3 group moderation: owner's numeric id for the mod gate.
    // Absent = moderation inert (default-off).
    ...(identity.ownerId !== undefined ? { moderationOwnerId: String(identity.ownerId) } : {}),
  });
  botApi = bot.api;

  // ---- Hermes-parity commands (Stage 2) ----
  // 52 commands from the Hermes COMMAND_REGISTRY audit, in three modules.
  // Registration is additive: each module owns its handlers and menu entries.
  //
  // Version shown by /version — read from package.json once at startup.
  const BOT_VERSION: string =
    (await Bun.file(new URL("../package.json", import.meta.url)).json().catch(() => undefined) as
      | { version?: string }
      | undefined)?.version ?? "dev";
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
    registerSystemCommands(bot, hermesDeps, {
      dbPath: config.dbPath,
      mcp,
      skills,
      proposalStore,
      isAnyTurnRunning: () => engine.isAnyTurnRunning(),
    });
    registerAutoCommands(bot, hermesDeps);
    setHeartbeatInfoProvider(() => ({
      enabled: config.heartbeatIntervalMs > 0,
      interval: formatIntervalMs(config.heartbeatIntervalMs),
    }));

    // Telegram command menu: Persian by default, English via language_code.
    // Owner-only commands are scoped to the owner's chat so other users never
    // see them; handlers ALSO gate at runtime (menu hiding is not a security
    // boundary).
    //
    // The 10 built-in commands (start/help/voice/…) are not part of the Hermes
    // modules, so they are prepended here from menu.ts: core commands first,
    // then the Hermes groups in module order (session → system → automation).
    // Public scope shows the non-owner entries; the owner scope shows
    // everything.
    const hermesDefs: HermesCommandDef[] = [
      ...SESSION_COMMAND_DEFS,
      ...SYSTEM_COMMAND_DEFS,
      ...AUTO_COMMAND_DEFS,
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
  const nudgeSweepTimer = setInterval(() => {
    void (async () => {
      try {
        const deliveries = await sweepNudges({ tracker: nudgeTracker, max: 5 });
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

  // Health endpoint. Started only when a port is configured, so a local run
  // opens no socket at all. A hosting platform polls this to decide whether the
  // deploy is alive, and a long-polling bot has no other socket to offer.
  const health =
    config.healthPort > 0
      ? await startHealthServer({
          port: config.healthPort,
          detail: () => ({
            tools: tools.listActiveNames().length,
            scheduler: scheduler.isRunning,
            taskScheduler: taskScheduler.isRunning,
          }),
          onError: (message) => log.error("health server failed to start", { error: message }),
        })
      : undefined;
  if (health !== undefined) log.info("health endpoint listening", { port: health.port });

  // Phase E5: minimal HTTP API (GET /health, POST /api/v1/turn). Started ONLY
  // when BOBI_API_TOKEN is set — with no token the bot boots exactly as
  // before: no port is bound and nothing else changes. The server reuses the
  // already-built storage/engine pieces; the turn endpoint runs as the OWNER
  // actor (actorForUser(ownerIdStr), the same server-side builder the
  // heartbeat uses), never as an arbitrary requester, because the HTTP channel
  // bypasses Telegram identity. Wrapped in try/catch so an API failure can
  // never crash the bot. The token is never logged; only the bind address is.
  let apiServer: ApiServer | undefined;
  const apiToken = (process.env.BOBI_API_TOKEN ?? "").trim();
  if (apiToken !== "") {
    const apiBind = (process.env.BOBI_API_BIND ?? "").trim() || DEFAULT_API_BIND;
    const apiPortRaw = Number((process.env.BOBI_API_PORT ?? "").trim());
    const apiPort =
      Number.isSafeInteger(apiPortRaw) && apiPortRaw > 0 && apiPortRaw < 65536
        ? apiPortRaw
        : DEFAULT_API_PORT;
    try {
      apiServer = createApiServer(
        {
          storage,
          // The main engine is shared: the turn endpoint gets the full tool
          // set, budgets, and skills of a normal owner conversation.
          engineFactory: () => engine,
          actorForOwner: () => actorForUser(ownerIdStr),
          token: apiToken,
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
