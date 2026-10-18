import { bootstrapMessage } from "./core/app";
import { loadConfig, requireBotToken } from "./config/config";
import { createBot } from "./bot/bot";
import type { Bot } from "grammy";
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
import { SearchRegistry } from "./search/registry";
import { SearchSettingsService } from "./search/service";
import { createWebSearchTool } from "./tools/web_search";
import { createMemoryTools } from "./tools/memory";
import { createReminderTools } from "./tools/reminders";
import { ReminderScheduler } from "./scheduler/scheduler";
import { McpManager, mcpTools } from "./mcp/bridge";
import { loadMcpConfig, describeIssues } from "./mcp/config";
import { RateLimiter } from "./core/rate_limit";
import { UsageService, formatCost } from "./core/usage";
import { Logger } from "./core/logger";
import { startHealthServer } from "./core/health";
import type { Tool } from "./tools/types";

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
    ...createMemoryTools({ storage }),
    ...createReminderTools({ storage }),
    ...mcpTools(mcp),
  ];
  if (searchEnabled) {
    extraTools.push(
      createWebSearchTool({ resolve: () => search.active() }) as Tool<unknown, unknown>,
    );
  }

  const tools = new ToolService({
    extraTools,
    onError: (info) =>
      console.error(
        `[sol] tool error: tool=${info.tool} kind=${info.kind} user=${info.userId} ms=${info.durationMs}`,
      ),
  });
  const adapters = new AdapterRegistry();
  const providerSvc = new ProviderService(storage, secrets, adapters);
  const modelSvc = new ModelService(storage);
  const healthSvc = new ProviderHealthService(storage, providerSvc, secrets, adapters);
  const gateway = new AiGateway({ storage, adapters, secrets });

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
  const engine = new ConversationEngine({
    provider,
    model: selection ? selection.modelId : config.aiModel,
    timeoutMs: config.aiTimeoutMs,
    maxConcurrent: config.aiMaxConcurrent,
    storage,
    tools,
    timezone: config.timezone,
    memoryCount: (userId) => storage.countMemories(userId),
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
        cost: formatCost(summary.estimatedUsd),
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
  });
  botApi = bot.api;

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
          }),
          onError: (message) => log.error("health server failed to start", { error: message }),
        })
      : undefined;
  if (health !== undefined) log.info("health endpoint listening", { port: health.port });

  // Graceful shutdown
  const stop = (): void => {
    log.info("shutting down");
    // Stop the scheduler before the database closes: a pass in flight would
    // otherwise write to a closed handle.
    scheduler.stop();
    void health?.close();
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
    onStart: (info) =>
      log.info("bot started", {
        username: info.username,
        env: config.env,
        provider: provider.name,
        tools: tools.listActiveNames(),
        search: searchEnabled,
      }),
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
