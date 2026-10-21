/**
 * Platform — the one composition aggregate built by buildPlatform()
 * (src/bootstrap.ts). Facades are the domain surfaces (turn / tools /
 * providers / memory / scheduling / admin / usage); the remaining fields
 * are the core handles the starters need. Starters import the facades and
 * handles from here — never the reverse (the import graph stays acyclic:
 * platform/ and bootstrap import no starter).
 */
import type { Bot } from "grammy";
import type { SolConfig } from "../config/config";
import type { Logger } from "../core/logger";
import type { Storage } from "../storage/storage";
import type { OwnerIdentity } from "../auth/identity";
import type { AuthorizationService } from "../auth/service";
import type { AdminBoundary } from "../auth/admin_boundary";
import type { GroupAccessService } from "../groups/service";
import type { UserAccessService } from "../auth/user_service";
import type { ConversationEngine } from "../conversation/engine";
import type { ToolActor } from "../tools/types";
import type { CircuitBreakerRegistry } from "../ai/circuit_breaker";
import type { ProviderProbeService } from "../ai/provider_probe";
import type { BenchWorker } from "../bench/worker";
import type { McpManager } from "../mcp/bridge";
import type { HookRunner } from "../hooks/runner";
import type { SkillCache } from "../skills/loader";
import type { RateLimiter } from "../core/rate_limit";
import type { ReminderScheduler, TaskScheduler } from "../scheduler/scheduler";
import type { HeartbeatService } from "../autonomy/heartbeat";
import type { EventStore } from "../memory/events";
import type { ProposalStore } from "../curator/proposals";
import type { HealthServer } from "../core/health";
import type { ApiServer } from "../http/server";
import type { TurnFacade } from "./turn";
import type { ToolsFacade } from "./tools";
import type { ProvidersFacade } from "./providers";
import type { MemoryFacade } from "./memory";
import type { SchedulingFacade } from "./scheduling";
import type { AdminFacade } from "./admin";
import type { UsageFacade } from "./usage";

export { TurnFacade } from "./turn";
export { ToolsFacade } from "./tools";
export { ProvidersFacade } from "./providers";
export { MemoryFacade } from "./memory";
export { SchedulingFacade } from "./scheduling";
export { AdminFacade } from "./admin";
export { UsageFacade } from "./usage";

export interface Platform {
  // Facades — the domain surfaces.
  turn: TurnFacade;
  tools: ToolsFacade;
  providers: ProvidersFacade;
  memory: MemoryFacade;
  scheduling: SchedulingFacade;
  admin: AdminFacade;
  usage: UsageFacade;

  // Core handles the starters need.
  config: SolConfig;
  log: Logger;
  logger: Logger;
  storage: Storage;
  identity: OwnerIdentity;
  /** String form of the validated owner id ("" never occurs: build fails closed first). */
  ownerIdStr: string;
  /** Bot token for the Telegram surface; "" when built for a non-Telegram surface without one. */
  token: string;
  auth: AuthorizationService;
  adminBoundary: AdminBoundary;
  groups: GroupAccessService;
  users: UserAccessService;
  /** The main conversation engine (same object as turn.engine). */
  engine: ConversationEngine;
  heartbeatEngine: ConversationEngine;
  /** The Telegram bot — present only on the Telegram surface. */
  bot?: Bot;
  scheduler: ReminderScheduler;
  taskScheduler: TaskScheduler;
  heartbeat: HeartbeatService;
  benchWorker: BenchWorker;
  healthSvc: ProviderProbeService;
  breakers: CircuitBreakerRegistry;
  mcp: McpManager;
  hookRunner: HookRunner;
  skills: SkillCache;
  rateLimit: RateLimiter;
  eventStore: EventStore;
  proposalStore: ProposalStore;
  /** Port the HTTP API server binds in the Telegram start phase. */
  apiPort: number;
  /** Bot version string (package.json), for /version. */
  version: string;
  /** Name of the composed provider facade ("bobi"), for startup logging. */
  providerName: string;
  /** Whether web search is configured/enabled, for startup logging. */
  searchEnabled: boolean;

  // Server-side actor / delivery gates, built in the composition root from
  // server-side facts only — shared by schedulers, heartbeat and starters.
  actorForUser: (userId: string) => ToolActor;
  mayDeliverTo: (userId: string, chatId: string) => boolean;

  // Deferred triggers: construction side effects that bind ports, spawn
  // processes or open network connections live behind these, invoked only
  // by the Telegram start phase (see buildPlatform's side-effect audit).
  /** Connect the configured external MCP servers (spawns their processes). */
  connectMcp: () => Promise<void>;
  /** Fire-and-forget warm-up of the active provider's connection. */
  warmBootConnection: () => void;
  /** Telegram-only: fetch the bot username and register the group-assistant commands. */
  registerGroupAssistantCommands?: () => Promise<void>;
  /** Telegram-only: sync the Telegram command menus (setMyCommands + menu button). */
  applyTelegramMenus?: () => void;

  // Mutable start-phase state, filled by startTelegramSurface.
  sweepTimer?: ReturnType<typeof setInterval> | undefined;
  healthServer?: HealthServer | undefined;
  apiServer?: ApiServer | undefined;
}
