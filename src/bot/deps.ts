/**
 * Shared bot dependencies, gates and command-option types.
 *
 * Extracted from bot.ts (platform Phase 5, Step B) to break the bot import
 * cycle: bot.ts registers the command modules (cmd_*), and those modules
 * need the shared types and gates that used to live in bot.ts, so every
 * registration was also an import back into bot.ts. Everything here is a
 * leaf: this module imports neither bot.ts nor any cmd_* module. bot.ts
 * re-exports the public surface so existing import paths keep working.
 */
import type { Context } from "grammy";
import { t, type Lang } from "../i18n";
import { checkGroupAccess, denialNote } from "../groups/enforcement";
import { checkUserAccess, userDenialNote } from "../auth/user_enforcement";
import { isOwnerCtx } from "./access";
import type { ConversationEngine } from "../conversation/engine";
import type { Storage } from "../storage/storage";
import type { ToolService } from "../tools/service";
import type { AuthorizationService } from "../auth/service";
import type { GroupAccessService } from "../groups/service";
import type { PanelController } from "../groups/controller";
import type { AiAdminController } from "../groups/ai_controller";
import type { GroupHistory } from "../groups/assistant";
import type { UserAccessService } from "../auth/user_service";
import type { UserPanelController } from "../auth/user_controller";
import type { RateLimiter } from "../core/rate_limit";
import type { UsageService } from "../core/usage";
import type { TranscribeOptions } from "../ai/transcribe";
import type { TtsOptions } from "../ai/tts";
import type { McpManager } from "../mcp/bridge";
import type { SkillCache } from "../skills/loader";

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

/** Minimal proposal-store surface /curator status needs. */
export interface ProposalStoreLike {
  listPending(userId: string): unknown[];
}

export interface RegisterOpts extends SystemCommandOpts {
  /** Pending-proposal store (index.ts wires ProposalStore). */
  proposalStore?: ProposalStoreLike;
}

/**
 * The per-user preference store the bot needs for voice mode.
 *
 * Kept to the two methods actually used so tests can substitute a fake and
 * `Storage` satisfies it structurally — the bot never needs the rest of the
 * storage surface.
 */
export interface UserPrefStore {
  getUserPref(userId: string, key: string): string | undefined;
  setUserPref(userId: string, key: string, value: string): void;
}

export interface BotDeps {
  engine: ConversationEngine;
  /**
   * SQLite storage (Hermes-parity command modules). Optional: without it the
   * /history, /save, /sessions… family reports "unavailable" instead of
   * failing.
   */
  storage?: Storage;
  /**
   * Bot token, needed to download attachment bytes.
   *
   * Telegram reports a file's `file_path` but not its content, and the download
   * URL embeds the token. It is passed here rather than read from the
   * environment so this module never touches configuration directly.
   */
  botToken?: string;
  /** Optional until tools are wired at the call site. */
  tools?: ToolService;
  /** Central authorization; when absent, tools stay unavailable. */
  auth?: AuthorizationService;
  /** Group approval store. When absent, group messages are not gated. */
  groups?: GroupAccessService;
  /** Private-chat user approval. When absent, direct messages are not gated. */
  users?: UserAccessService;
  /** User-access panel controller; absent means no user approval UI. */
  userPanel?: UserPanelController;
  /** Owner panel controller; absent means no /admin route. */
  panel?: PanelController;
  /** AI management controller; absent means no /ai route. */
  aiAdmin?: AiAdminController;
  /** Per-user budgets. When absent, nothing is rate limited. */
  rateLimit?: RateLimiter;
  /** Usage accounting. When absent, spend is not recorded. */
  usage?: UsageService;
  /**
   * Phase B2: whisper-compatible transcription endpoint for voice messages.
   *
   * Optional; absent or an empty baseUrl means transcription is disabled and
   * audio parts keep the existing behaviour (the adapter's named note). Wired
   * from TRANSCRIBE_* configuration.
   */
  transcribe?: TranscribeOptions;
  /**
   * Phase B3: TTS endpoint for voice replies.
   *
   * Optional; absent or an empty baseUrl means voice replies are unavailable
   * and /voice reports that TTS is not configured. Wired from TTS_* config.
   */
  tts?: TtsOptions;
  /**
   * Phase B3: per-user preference store (voice_mode). Optional; without it
   * /voice cannot persist the sender's choice.
   */
  prefs?: UserPrefStore;
  /**
   * Stage-3 moderation: the bot owner's numeric Telegram id as a string.
   * When absent, group moderation stays inert (all messages allowed).
   * Set at the call site from OwnerIdentity — never from message content.
   */
  moderationOwnerId?: string;
  /**
   * Phase-3 group assistant mode (opt-in per group, owner-managed).
   * When absent, the assistant hook in the message path stays inert
   * (all groups behave as before). Set at the call site from OwnerIdentity.
   */
  groupAssistant?: {
    ownerId: string;
    history: GroupHistory;
  };
  /**
   * Bot version string, shown by /version (and its palette tap). Read from
   * package.json once at startup by the coordinator.
   */
  version?: string;
  /**
   * System-command options for the command palette's tap-to-run runners
   * (same object the coordinator passes to registerSystemCommands, so
   * defaults stay in one place).
   */
  systemOpts?: RegisterOpts;
  /**
   * Optional web-search resolver for the interactive /digest headlines
   * section. The coordinator wires the same resolver it gives the
   * build_digest tool; absent means the digest simply has no headlines
   * section (the builder skips it gracefully).
   */
  digestSearchHeadlines?: import("../digest/builder").SearchHeadlinesFn;
}

/** Shown once to a group that is not approved yet. */
const GROUP_NOT_READY_KEY = "gate.group_not_ready";

/**
 * The sender's UI language. English-only since v1.0: always "en".
 *
 * Kept as a function (rather than inlining "en") because dozens of call
 * sites — including other workers' command modules — take it, and the
 * signature stays stable while they migrate.
 */
export function senderLang(
  _ctx: { from?: { id: number | string } | undefined },
  _prefs: UserPrefStore | undefined,
): Lang {
  return "en";
}

/**
 * Group access gate.
 *
 * Called before anything else runs for a group update. A pending, rejected,
 * or revoked group never reaches the engine, the provider, or a tool, and the
 * decision is read from the database each time.
 */
export async function gateGroup(
  ctx: Context,
  groups: GroupAccessService | undefined,
  lang: Lang = "en",
): Promise<boolean> {
  // No store configured: nothing to enforce. Groups simply stay ungated.
  if (!groups) return true;
  if (!ctx.chat) return true;

  const decision = checkGroupAccess(groups, {
    chatType: ctx.chat.type,
    chatId: String(ctx.chat.id),
  });
  if (decision.allowed) return true;

  console.error(`[sol] group blocked: ${denialNote({ chatType: ctx.chat.type, chatId: String(ctx.chat.id) }, decision)}`);
  try {
    await ctx.reply(t(GROUP_NOT_READY_KEY, lang));
  } catch {
    // A blocked group may have removed the bot; that is not an error.
  }
  return false;
}

/**
 * Private-chat access gate — the two-tier model.
 *
 * Public chat is OPEN: anyone may talk to Bobi, no approval queue. The owner
 * is exempt from everything. Two persisted owner controls remain:
 * - banned (`rejected`): the sender gets one short, polite refusal.
 * - muted (`revoked`): the update is silently dropped — no reply at all.
 *
 * Everyone else — no row, `pending`, or `approved` — is allowed through.
 * Legacy `pending` rows (from the old approval flow) no longer gate anything:
 * no new pending rows are created here and the owner is never notified.
 *
 * The decision is read from the database on every call, so a ban/mute takes
 * effect on the very next message.
 */
export async function gateUser(
  ctx: Context,
  deps: {
    users?: UserAccessService;
    auth?: AuthorizationService;
    userPanel?: UserPanelController;
    prefs?: UserPrefStore;
  },
): Promise<boolean> {
  const { users } = deps;
  if (!users || !ctx.chat || !ctx.from) return true;

  const auth = deps.auth;
  const actor = auth ? auth.actorFromTelegramUser(ctx.from) : undefined;
  const isOwner = auth !== undefined && auth.isOwner(actor);
  const userId = String(ctx.from.id);

  const decision = checkUserAccess(users, {
    userId,
    isOwner,
    chatType: ctx.chat.type,
  });
  if (decision.allowed) return true;

  console.error(
    `[sol] user blocked: ${userDenialNote({ userId, isOwner, chatType: ctx.chat.type }, decision)}`,
  );
  // A muted user hears nothing at all; a banned user gets one short, polite
  // line. The denial is English (the bot's only UI language since v1.0).
  if (decision.state === "revoked") return false;
  const lang = senderLang(ctx, deps.prefs);
  await safeReply(ctx, t("gate.user_banned", lang));
  return false;
}

/** Reply, tolerating a failure (blocked bot, deleted message). */
export async function safeReply(
  ctx: { reply(text: string): Promise<unknown> },
  text: string,
): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // A user who blocked the bot cannot be told anything; that is not an error.
  }
}

/**
 * Whether the sender is the owner, for help filtering.
 *
 * Delegates to the two-tier access module: the owner is proven from the
 * trusted numeric id, never from message text. Fail-closed: without auth (or
 * without a sender) nobody counts as the owner.
 */
export function isOwnerSender(
  ctx: Context,
  deps: { auth?: AuthorizationService },
): boolean {
  return isOwnerCtx(ctx, deps);
}

/** The user_prefs key for the per-user personality skin. Exported for index.ts wiring. */
export const PERSONALITY_PREF_KEY = "personality";

/**
 * Extract the argument from a command text like "/personality concise" or
 * "/personality@bot concise". Returns undefined when there is no argument.
 * Pure, for tests.
 */
export function commandArg(text: string): string | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  return parts.slice(1).join(" ");
}
