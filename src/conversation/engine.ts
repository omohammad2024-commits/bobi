import type { AiProvider, ChatMessage, ContentPart } from "../ai/provider";
import { AiError } from "../ai/provider";
import type { Storage } from "../storage/storage";
import type { Lang } from "../i18n/types";
import { AgentCancelled, AgentLoop } from "../agent/loop";
import type { AgentBudgets, AgentRunInput } from "../agent/loop";
import { raceDeadline, withDeadline } from "../core/deadline";
import type { AgentRunResult, AgentStep } from "../agent/transcript";
import { buildSystemPrompt } from "../agent/prompt";
import {
  OwnerProfileService,
  renderOwnerProfileBlock,
} from "../profile/owner_profile";
import { ContextFileCache } from "../context/loader";
import { MIN_COMPACT_MESSAGES, summariseHistory, summaryMessage, SUMMARY_MESSAGE_HEADER } from "./summary";
import { Logger } from "../core/logger";
import { estimateMessageTokens, estimateMessagesTokens, estimateTokens } from "./tokens";
import {
  compactHistoryToolResults,
  enforceContextBudget,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  SUMMARY_TRIGGER_RATIO,
} from "./context_budget";
import { formatHistoryForModel, labelAssistantTurn, labelUserTurn } from "./speakers";
import { prioritizeHistory } from "./prioritize";
import {
  getPersonality,
  type Personality,
} from "../personality/personalities";
import type { ToolService } from "../tools/service";
import { applyIntentRouting } from "../routing/route_specs";
import type { ToolActor } from "../tools/types";
import type { SkillCache } from "../skills/loader";
import { buildSkillsContext } from "../skills/context";
import type { HookRunnerLike } from "../hooks/runner";
import type { HookEvent, HookPayload } from "../hooks/events";
import {
  agentStartEvent,
  agentEndEvent,
  toolEndEvent,
  type WebhookEvent,
} from "../webhooks/events";
import { splitTextIntoChunks } from "../core/chunking";

/** What the agent loop and the plain path both produce. */
interface RunOutcome {
  text: string;
  model: string;
  steps: readonly AgentStep[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: number;
  /** User-facing media from tools, in call order (empty on the plain path). */
  media: ContentPart[];
}

/** Telegram's hard limit for a single message. */
export const TELEGRAM_MAX_LENGTH = 4096;

/**
 * One history row with its storage id when storage-backed (in-memory rows
 * carry no id). The id lets compactedHistory match rows against the
 * summary watermark precisely.
 */
interface HistoryRow {
  id?: number;
  role: ChatMessage["role"];
  content: string;
}


export interface ConversationInput {
  /** Stable id of the conversation owner (chat or user). */
  conversationId: string;
  /** Owner id used for per-user isolation (required when storage is on). */
  userId?: string;
  /** Raw text the user sent. */
  userText: string;
  /**
   * Reply language for this turn. English-only since v1.0: the field is
   * kept for call-site compatibility but no longer selects anything.
   * The value never comes from chat text, so a user cannot set it by
   * asking.
   */
  lang?: Lang;
  /** Optional per-request timeout override. */
  timeoutMs?: number;
  /**
   * Whether this turn is in a group chat. When true, the prompt adds
   * explicit role clarity (you are the bot, not the user) because some
   * models get confused by multi-user group context and start mimicking.
   */
  isGroup?: boolean;
  /**
   * Trusted display name of this turn's sender, resolved server-side by the
   * caller (e.g. from Telegram `ctx.from.first_name`).
   *
   * Used to label this turn in group history (`[Sara]: ...`) so the model
   * can tell group members apart. Absent means the turn is labeled
   * `[Member]:` in groups; private chats never use it. Never derived from
   * chat text — the model must not be able to claim a name.
   */
  senderName?: string;
  /**
   * Whether the current user is the verified owner (resolved server-side
   * from the Telegram ID by the bot). When true, the system prompt tells
   * the model it is talking to its verified creator — so the agent
   * recognizes the owner instead of treating them as an unverified claimant.
   */
  isOwner?: boolean;
  /**
   * Trusted identity the tools run as, resolved by the bot from `from.id`.
   *
   * Absent means "no tool access at all" — the run still answers from the
   * model, because the tool decision belongs to the caller's permission list,
   * not to whether the turn is allowed to happen.
   */
  actor?: ToolActor;
  /**
   * Progress sink for this specific request.
   *
   * Bound per call rather than at construction, because the sink belongs to the
   * chat that made the request and one engine serves every conversation.
   */
  onProgress?: (step: AgentStep) => void;
  /**
   * Attachments to send alongside the text.
   *
   * Absent means a text-only turn. Parts travel to the provider but are NOT
   * persisted in history: storing base64 in the messages table would bloat it
   * without bound, and a model does not need yesterday's photo replayed on
   * every later turn.
   */
  parts?: readonly ContentPart[];
}

export interface ConversationOutput {
  /** Assistant reply, split into Telegram-safe chunks. */
  chunks: string[];
  /** Model that produced it. */
  model: string;
  /** Whether the active provider is the offline fake. */
  isFake: boolean;
  /** Ordered record of the run, for logging and progress display. */
  steps: readonly AgentStep[];
  /** Whether a budget stopped the run short of a clean answer. */
  truncated: boolean;
  /** Token totals across every provider call in this run. */
  usage: { inputTokens: number; outputTokens: number };
  /**
   * User-facing media from tools, in call order. The bot layer delivers it
   * after the text; it is never persisted or replayed to the model.
   */
  media: ContentPart[];
  /** Tool executions that actually ran. */
  toolCalls: number;
}

export interface EngineOptions {  provider: AiProvider;
  model: string;
  /** Default request timeout, ms. */
  timeoutMs: number;
  /** Max in-flight requests allowed at once. */
  maxConcurrent: number;
  /** Optional persistent store; when absent history stays in memory. */
  storage?: Storage;
  /** Max messages sent to the model (memory window). */
  historyLimit?: number;
  /**
   * Per-turn context target in estimated tokens: system prompt + history +
   * live turn must fit it. Default: env BOBI_CONTEXT_TOKEN_BUDGET, else
   * 32000 (the engine does not know the model's true window — this is the
   * configured ceiling the context core budgets against).
   */
  contextTokenBudget?: number;
  /**
   * Master switch for token budgeting and tool-result compaction.
   * Env BOBI_CONTEXT_BUDGET=0 disables both (legacy behavior). Default true.
   */
  contextBudgetEnabled?: boolean;
  /**
   * Tool-result compaction only (oversized history tool results are kept
   * head+tail). Env BOBI_TOOL_RESULT_COMPACT=0 disables it. Default true.
   */
  toolResultCompactEnabled?: boolean;
  /**
   * Logger for context-budget events (counts only, never content).
   * Defaults to a module-level info Logger; inject the app logger so the
   * configured level applies.
   */
  log?: Pick<Logger, "info">;
  /**
   * Tools the agent may run. When absent the engine is a plain chat bot and
   * every run answers from the model alone.
   */
  tools?: ToolService;
  /** Agent budgets (iterations, tool calls, wall clock). */
  budgets?: Partial<AgentBudgets>;
  /** Timezone used when telling the model what "now" is. */
  timezone?: string;
  /** Owner-supplied extra system instructions. */
  extraPrompt?: string;
  /**
   * Phase G1: resolve a user's personality skin name for this turn.
   *
   * Called with the turn's user id; returns a canonical skin name or
   * undefined. The engine re-validates the returned name against the
   * built-in skins (see runAgent), so even a misbehaving resolver can only
   * pick an owner-shipped skin, never inject raw text into the prompt.
   * Absent means the `default` skin (no addition).
   */
  personalityFor?: (userId: string) => string | undefined;
  /**
   * Legacy reply-language resolver. English-only since v1.0: accepted for
   * API compatibility but ignored — every turn answers in English.
   */
  langFor?: (userId: string) => Lang | undefined;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
  /** Progress sink, forwarded from the agent loop. */
  onStep?: (conversationId: string, step: AgentStep) => void;
  /**
   * Per-run usage observer (usage tracking). Called once after each settled
   * turn with the run's token totals. The engine never awaits it, and a
   * throwing observer must not break the turn — callers wrap it.
   */
  onRunUsage?: (info: RunUsageInfo) => void;
  /**
   * How many memories the user has stored.
   *
   * A function rather than a number so it is read per turn — a memory the model
   * stores during a run is reflected on the next one. Omitted when memory is
   * unavailable, in which case the prompt says nothing about it.
   */
  memoryCount?: (userId: string) => number;
  /**
   * Core upgrade (memory core): per-turn prompt memory context — the user's
   * latest episode summary plus proactively recalled memories for THIS
   * message. Fetched by the app from the memory provider (index wires it);
   * the engine only pastes. Absent = no episode/recall blocks in the
   * prompt. A failure inside the callback degrades to "no block", never a
   * broken turn.
   */
  memoryPrompt?: (
    userId: string,
    userText: string,
  ) => Promise<{ episode?: string; recalled?: readonly string[] } | undefined>;
  /**
   * Whether to fold overflowed history into a rolling summary. Default true.
   * Disabled in tests that assert the raw window.
   */
  summariseHistory?: boolean;
  /**
   * Skill registry cache, consulted per turn. Absent means no skills.
   *
   * Matching skills are pasted into the system prompt as owner-authored
   * guidance; they grant no permissions and execute no code.
   */
  skills?: SkillCache;
  /**
   * Project context files (Phase D3), consulted per turn. Absent means no
   * context files. The cache is snapshotted once per turn and the frozen
   * block is pasted into the system prompt; later file edits cannot reach
   * the in-flight turn.
   */
  contextFiles?: ContextFileCache;
  /**
   * Lifecycle hook runner (Phase E2), injected. Absent means no hook
   * emission — the engine never constructs one itself, so unit tests stay
   * offline by default. When present, `agent:start` fires before the agent
   * loop and `agent:end` after it settles; the runner executes each hook's
   * tool action as this turn's actor (never escalated).
   */
  hooks?: HookRunnerLike;
  /**
   * Per-user gate consulted before each tool execution.
   *
   * Returns false to refuse this call. The engine has no opinion on why; the
   * caller decides what the budget is.
   */
  allowToolCall?: (userId: string) => boolean;
  /**
   * Outbound event sink (platform Phase 5): the engine builds webhook event
   * envelopes with the pure builders in src/webhooks/events.ts (metadata
   * only) and hands them here. The enabled check and delivery live in the
   * surface that wires the sink (src/webhooks' `webhookEventSink`); the
   * engine itself carries no delivery machinery. Absent means events are
   * dropped. A throwing sink can never break a turn — the engine guards
   * every call.
   */
  onEvent?: (event: WebhookEvent) => void;
  /**
   * Reply splitter for `ConversationOutput.chunks`. Absent means the core
   * splitter (src/core/chunking.ts) at TELEGRAM_MAX_LENGTH; a surface with
   * a different limit injects its own.
   */
  splitReply?: (text: string) => string[];
}

/** Token totals for one settled turn, handed to `onRunUsage`. */
export interface RunUsageInfo {
  userId: string;
  conversationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Context transparency: the last measured context for a conversation.
 *
 * Returned by `contextStats()`; consumed by UIs/diagnostics later. All
 * numbers are estimates from the tokenizer-free estimator.
 */
export interface ContextStats {
  /** Estimated tokens of the final assembled context (system + history + turn). */
  estimatedTokens: number;
  /** The budget the context was enforced against. */
  budget: number;
  /** User turns carried in the assembled history. */
  historyTurns: number;
  /** Rolling-summary turns present in the assembled history. */
  summaries: number;
  /** Tool results compacted this turn (head+tail plus budget one-liners). */
  compactedResults: number;
}

import { processEnv, readNamed } from "../config/env";
/** env flag helper: "0" disables, anything else keeps the default. */
function envFlag(name: string, fallback: boolean): boolean {
  const v = readNamed(processEnv(), name);
  if (v === undefined) return fallback;
  return v.trim() !== "0";
}

/** The configured context budget: option → env → default. */
function resolveContextBudget(option: number | undefined): number {
  if (option !== undefined && option > 0) return Math.floor(option);
  const raw = Number(readNamed(processEnv(), "BOBI_CONTEXT_TOKEN_BUDGET"));
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_CONTEXT_TOKEN_BUDGET;
}

/** Errors the engine surfaces to the caller (already user-safe categories). */
export class EngineError extends Error {
  constructor(
    readonly kind:
      | AiError["kind"]
      | "empty_input"
      | "empty_response"
      | "overloaded"
      /** A newer message replaced this run; the caller should stay silent. */
      | "superseded",
    message: string,
    /**
     * The provider HTTP status that caused this error, when known. Carried
     * from the AiError so the bot layer can name it in diagnostics. A number
     * only — never response content.
     */
    readonly status?: number,
    /**
     * How many provider candidates the gateway tried before this error
     * became final, when more than one was attempted. Carried from the
     * AiError so the presentation layer can append the
     * `error.tried_providers` note ("(tried N providers)"). Additive only.
     */
    readonly attempts?: number,
    /**
     * The provider's own error words, when the failing response carried
     * any (sanitized + capped at the adapter; see AiError.providerMessage).
     * Carried so the presentation layer can quote them — the provider
     * often names the exact fix. Additive only.
     */
    readonly providerMessage?: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * Phase G1: outcome of an explicit /compress request, for the bot's Persian reply.
 */
export type CompressResult =
  | "compressed"
  | "nothing_to_compress"
  | "failed"
  | "unavailable";

/**
 * Phase G1: the identity of a conversation without a message attached.
 *
 * ConversationInput carries a userText; commands like /reset and /compress do
 * not have one. This is the narrower shape they pass instead, so they never
 * fabricate an empty user message to satisfy the type.
 */
export interface ConversationRef {
  /** Stable id of the conversation owner (chat or user). */
  conversationId: string;
  /** Owner id used for per-user isolation (same fallback as a turn). */
  userId?: string;
}

/**
 * Conversation engine — grammY-agnostic and unit-testable.
 *
 * One `respond()` is now a whole agent run: the model may request tools, BOBI
 * runs them through the authorized Executor, and the loop repeats until the
 * model answers or a budget is reached. History is kept in memory by default;
 * pass `storage` for persistence.
 */
export class ConversationEngine {
  private readonly provider: AiProvider;
  private readonly model: string;
  private readonly defaultTimeoutMs: number;
  private readonly semaphore: Semaphore;
  private readonly storage: Storage | undefined;
  private readonly historyLimit: number;
  private readonly tools: ToolService | undefined;
  private readonly budgets: Partial<AgentBudgets> | undefined;
  private readonly timezone: string;
  private readonly extraPrompt: string | undefined;
  private readonly now: () => Date;
  private readonly onStep: ((conversationId: string, step: AgentStep) => void) | undefined;
  private readonly onRunUsage: ((info: RunUsageInfo) => void) | undefined;
  private readonly memoryCount: ((userId: string) => number) | undefined;
  private readonly memoryPrompt:
    | ((
        userId: string,
        userText: string,
      ) => Promise<{ episode?: string; recalled?: readonly string[] } | undefined>)
    | undefined;
  private readonly allowToolCall: ((userId: string) => boolean) | undefined;
  private readonly skills: SkillCache | undefined;
  private readonly contextFiles: ContextFileCache | undefined;
  private readonly hooks: HookRunnerLike | undefined;
  private readonly onEvent: ((event: WebhookEvent) => void) | undefined;
  private readonly splitReply: (text: string) => string[];
  private readonly personalityFor: ((userId: string) => string | undefined) | undefined;
  private readonly contextTokenBudget: number;
  private readonly contextBudgetEnabled: boolean;
  private readonly toolResultCompactEnabled: boolean;
  private readonly clog: Pick<Logger, "info">;
  // conversationId -> last measured context, for contextStats()
  private readonly contextStatsMap = new Map<string, ContextStats>();
  // Owner profile (Phase 4): the service is built lazily on the first
  // owner turn (it needs storage), and seeding happens once per engine
  // instance — in production one engine serves the process.
  private ownerProfileService: OwnerProfileService | undefined;
  private ownerProfileSeeded = false;

  // in-memory fallback (conversationId -> turns)
  private readonly histories = new Map<string, ChatMessage[]>();
  // conversationId -> chain tail; serializes requests per conversation
  private readonly chains = new Map<string, Promise<unknown>>();
  // conversationId -> live run, so a newer message can cancel a superseded one
  private readonly running = new Map<string, AbortController>();
  private readonly summarisationEnabled: boolean;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.defaultTimeoutMs = opts.timeoutMs;
    this.semaphore = new Semaphore(opts.maxConcurrent);
    this.storage = opts.storage;
    this.historyLimit = opts.historyLimit ?? 50;
    this.tools = opts.tools;
    this.budgets = opts.budgets;
    this.timezone = opts.timezone ?? "Asia/Tehran";
    this.extraPrompt = opts.extraPrompt;
    this.now = opts.now ?? (() => new Date());
    this.onStep = opts.onStep;
    this.onRunUsage = opts.onRunUsage;
    this.memoryCount = opts.memoryCount;
    this.memoryPrompt = opts.memoryPrompt;
    this.summarisationEnabled = opts.summariseHistory !== false;
    this.allowToolCall = opts.allowToolCall;
    this.skills = opts.skills;
    this.contextFiles = opts.contextFiles;
    this.hooks = opts.hooks;
    this.onEvent = opts.onEvent;
    this.splitReply =
      opts.splitReply ?? ((t: string) => splitTextIntoChunks(t, TELEGRAM_MAX_LENGTH));
    this.personalityFor = opts.personalityFor;
    this.contextTokenBudget = resolveContextBudget(opts.contextTokenBudget);
    this.contextBudgetEnabled =
      opts.contextBudgetEnabled ?? envFlag("BOBI_CONTEXT_BUDGET", true);
    // The master switch off means legacy behavior everywhere, compaction
    // included; the dedicated switch narrows only the compaction.
    this.toolResultCompactEnabled =
      this.contextBudgetEnabled &&
      (opts.toolResultCompactEnabled ?? envFlag("BOBI_TOOL_RESULT_COMPACT", true));
    this.clog =
      opts.log ?? new Logger({ level: "info", base: { app: "bobi", component: "context" } });
    // langFor is accepted for API compatibility but ignored: v1.0 is
    // English-only, so the turn language is a constant "en".
    void opts.langFor;
  }

  /**
   * Whether the active provider accepts raw audio ContentParts natively.
   *
   * Phase B2 seam (additive): the bot layer asks this before deciding whether
   * a voice message must be transcribed first. A provider without the method
   * (the offline fake, older tests' stubs) reads as "no native audio" —
   * fail-closed toward the transcription path when transcription is
   * configured; when it is not, audio parts keep their existing behaviour.
   */
  activeSupportsAudioInput(): boolean {
    return this.provider.supportsAudioInput?.() === true;
  }

  /**
   * Whether the active provider accepts document ContentParts natively.
   *
   * Phase B5 seam (additive): the bot layer asks this before deciding whether
   * a .docx/.xlsx/.pdf must be extracted locally first. Undeclared reads as
   * "no native documents" — fail-closed toward local extraction.
   */
  activeSupportsDocumentInput(): boolean {
    return this.provider.supportsDocumentInput?.() === true;
  }

  /**
   * Whether the active provider is the offline fake (Phase C2: the heartbeat
   * skips beats when there is no real model, since an autonomous pass with no
   * model behind it is noise, not work). Additive read of the same condition
   * `respond()` reports in its output; it changes no existing behaviour.
   */
  get isFake(): boolean {
    return this.provider.name === "fake";
  }

  /**
   * The model this engine answers with (for /status). Additive read-only
   * accessor; changes no behaviour.
   */
  get activeModel(): string {
    return this.model;
  }

  /**
   * True while any conversation turn is running (for /snapshot's safety
   * check and /agents). Reads the same internal map `respond()` uses.
   */
  isAnyTurnRunning(): boolean {
    return this.running.size > 0;
  }

  /** Handle one user message end-to-end. Never throws raw provider errors. */
  async respond(input: ConversationInput): Promise<ConversationOutput> {
    const userText = input.userText.trim();
    const hasParts = input.parts !== undefined && input.parts.length > 0;

    // A caption-less photo is a complete turn, so emptiness is judged on the
    // message as a whole rather than on its text alone.
    if (userText.length === 0 && !hasParts) {
      throw new EngineError("empty_input", "Message is empty.");
    }

    // A newer message supersedes an in-flight run in the same conversation: the
    // old run is cancelled rather than queued, so a user who rephrases does not
    // wait for a slow tool to finish first. Without this, an agent run with
    // several tools would hold the conversation for tens of seconds.
    this.cancel(input.conversationId);

    const controller = new AbortController();
    this.running.set(input.conversationId, controller);

    // Serialize per conversation so history never interleaves.
    //
    // The map holds a settled-safe tail, and cleanup compares against THAT
    // value. An earlier version stored `run.catch(...)` but compared to `run`,
    // so the comparison never matched and every conversation leaked a chain
    // entry holding a closure over the request context.
    const tail = this.chains.get(input.conversationId) ?? Promise.resolve();
    const run = tail.then(() => this.runOnce(input, userText, controller.signal));
    const settled = run.catch(() => undefined);
    this.chains.set(input.conversationId, settled);

    try {
      return await run;
    } finally {
      if (this.chains.get(input.conversationId) === settled) {
        this.chains.delete(input.conversationId);
      }
      if (this.running.get(input.conversationId) === controller) {
        this.running.delete(input.conversationId);
      }
    }
  }

  /**
   * Cancel the in-flight run for a conversation, if any.
   *
   * Called automatically when a newer message arrives, and on shutdown.
   */
  cancel(conversationId: string): void {
    this.running.get(conversationId)?.abort();
  }

  /** Cancel every in-flight run — used during graceful shutdown. */
  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  /**
   * Whether a run is currently in flight for this conversation.
   *
   * (Phase: MCP server) — the MCP `bobi_conversation_status` tool. Additive
   * read of the internal `running` map; it changes no existing behaviour.
   */
  isConversationRunning(conversationId: string): boolean {
    return this.running.has(conversationId);
  }

  /**
   * Context transparency: the last measured context for a conversation
   * (estimated tokens, budget, history size, summaries, compactions).
   * Undefined until the conversation has completed one measured turn.
   */
  contextStats(conversationId: string): ContextStats | undefined {
    return this.contextStatsMap.get(conversationId);
  }

  /** Record the measured context of the turn that just assembled. */
  private recordContextStats(
    conversationId: string,
    finalMessages: readonly ChatMessage[],
    systemTokens: number,
    compactedResults: number,
  ): void {
    this.contextStatsMap.set(conversationId, {
      estimatedTokens: systemTokens + estimateMessagesTokens(finalMessages),
      budget: this.contextTokenBudget,
      historyTurns: finalMessages.filter((m) => m.role === "user").length,
      summaries: finalMessages.filter(
        (m) => m.role === "system" && m.content.startsWith(SUMMARY_MESSAGE_HEADER),
      ).length,
      compactedResults,
    });
  }

  /**
   * Enforce the per-turn context budget on the HISTORY slice of an
   * assembled message list (the last element — the live turn — is never
   * touched and never dropped). Returns the final message list.
   *
   * With the budget disabled this is a pass-through that only records
   * stats, so `contextStats` still reflects reality in legacy mode.
   */
  private applyContextBudget(
    messages: ChatMessage[],
    systemPrompt: string | undefined,
    conversationId: string,
    compactedResults: number,
  ): ChatMessage[] {
    const systemTokens = systemPrompt !== undefined ? estimateTokens(systemPrompt) : 0;
    if (!this.contextBudgetEnabled || messages.length <= 1) {
      this.recordContextStats(conversationId, messages, systemTokens, compactedResults);
      return messages;
    }
    const turn = messages[messages.length - 1]!;
    const history = messages.slice(0, -1);
    const totalBefore =
      systemTokens + estimateMessagesTokens(history) + estimateMessageTokens(turn);
    const enforced = enforceContextBudget(history, {
      systemTokens,
      turnTokens: estimateMessageTokens(turn),
      budget: this.contextTokenBudget,
    });
    const finalMessages = [...enforced.messages, turn];
    const compactedTotal = compactedResults + enforced.toolResultsOneLined;
    if (enforced.toolResultsOneLined > 0 || enforced.droppedMessages > 0) {
      // Counts only — never message content.
      this.clog.info("context budget enforced", {
        conversationId,
        beforeTokens: totalBefore,
        afterTokens: systemTokens + estimateMessagesTokens(finalMessages),
        budget: this.contextTokenBudget,
        toolResultsOneLined: enforced.toolResultsOneLined,
        droppedMessages: enforced.droppedMessages,
      });
    }
    this.recordContextStats(conversationId, finalMessages, systemTokens, compactedTotal);
    return finalMessages;
  }

  /**
   * Phase G1: resolve the sender's personality skin to its prompt addition.
   *
   * The lookup goes through getPersonality, the validation boundary: an
   * unknown name (stale pref, hand-edited database row, misbehaving resolver)
   * resolves to undefined, never to raw text in the prompt. A failing
   * resolver also falls back to undefined rather than failing the turn.
   */
  private resolvePersonality(userId: string): Personality | undefined {
    if (this.personalityFor === undefined) return undefined;
    let name: string | undefined;
    try {
      name = this.personalityFor(userId);
    } catch {
      return undefined;
    }
    if (name === undefined) return undefined;
    return getPersonality(name);
  }

  /**
   * The reply language for this turn. English-only since v1.0: always "en".
   *
   * Kept as a method (and `ConversationInput.lang` / the `langFor` option
   * kept on the public surface) so existing call sites keep compiling; the
   * value no longer selects anything — the system prompt's hard English
   * rule is unconditional.
   */
  private resolveTurnLang(_input: ConversationInput): Lang {
    return "en";
  }

  /**
   * Owner profile (Phase 4): the rendered profile block for this turn,
   * or undefined when there is nothing to paste.
   *
   * Owner turns only, and only when storage is present: a non-owner
   * turn returns undefined WITHOUT touching the profile service at all
   * — no seeding, no load, no render — and buildSystemPrompt
   * independently drops any block on a non-owner turn, so the profile
   * cannot leak even if this seam is ever mis-wired.
   *
   * The storage user id is `ownerOf(input).userId` — the identity every
   * Storage read/write in this engine is keyed by (history, summaries,
   * commits), i.e. the same id the memory layer is keyed by. In
   * production it equals `actor.userId` (both are String(from.id));
   * unlike the actor it is also defined on turns with no tool actor.
   *
   * Seeding is lazy and once per engine instance: the first owner turn
   * calls ensureSeeded, later turns load() the stored profile (so edits
   * between turns are picked up). The seeded flag is set only on
   * success, so a failed seed is retried on the next owner turn.
   *
   * Enhancement only — exactly like the memoryPrompt wiring in
   * runAgent: any failure (service construction, seed, load, render)
   * degrades to "no block" and never breaks the turn.
   */
  private async ownerProfileBlockForTurn(
    input: ConversationInput,
  ): Promise<string | undefined> {
    if (input.isOwner !== true || this.storage === undefined) {
      return undefined;
    }
    try {
      const service = (this.ownerProfileService ??= new OwnerProfileService(
        this.storage,
      ));
      const ownerUserId = this.ownerOf(input).userId;
      let profile;
      if (!this.ownerProfileSeeded) {
        const seeded = await service.ensureSeeded(ownerUserId);
        this.ownerProfileSeeded = true;
        profile = seeded.profile;
      } else {
        profile = await service.load();
      }
      // load() reports "no stored profile" as undefined — nothing to paste.
      if (profile === undefined) return undefined;
      const block = renderOwnerProfileBlock(profile);
      return block.trim().length > 0 ? block : undefined;
    } catch {
      return undefined;
    }
  }

  private async runOnce(
    input: ConversationInput,
    userText: string,
    signal: AbortSignal,
  ): Promise<ConversationOutput> {
    return this.semaphore.use(async () => {
      const rawHistory = await this.compactedHistory(input, signal);
      const isGroup = input.isGroup === true;
      // Speaker attribution + priority-aware truncation before the request:
      // every message the model sees carries an explicit `[Name]:` label it
      // cannot misread, and the window keeps summaries, facts/corrections,
      // and recent turns verbatim while dropping middle filler.
      const history = formatHistoryForModel(
        prioritizeHistory(rawHistory, { budget: this.historyLimit }),
        { isGroup },
      );

      // Tool-result compaction (head+tail): oversized results replayed from
      // history keep their shape, not their bulk. The live agent loop still
      // sees full results for the current turn — compaction applies to
      // history entering the model, never to the loop's live context.
      let compactedResults = 0;
      let historyForModel = history;
      if (this.toolResultCompactEnabled) {
        const compacted = compactHistoryToolResults(history);
        if (compacted.compactedCount > 0) {
          compactedResults = compacted.compactedCount;
          historyForModel = compacted.messages;
          // Counts only — never message content.
          this.clog.info("context: tool results compacted", {
            conversationId: input.conversationId,
            compacted: compacted.compactedCount,
            beforeTokens: compacted.beforeTokens,
            afterTokens: compacted.afterTokens,
          });
        }
      }

      // Attachments ride on the live turn only. They are deliberately excluded
      // from `commitTurn`, so history stays text and cannot grow without bound.
      const turn: ChatMessage = {
        role: "user",
        // In groups the live turn carries its speaker label (`[Sara]: ...`);
        // in private it stays bare — unambiguous next to labeled assistant
        // turns, and clean.
        content: labelUserTurn(userText, { isGroup, senderName: input.senderName }),
        ...(input.parts !== undefined && input.parts.length > 0
          ? { parts: input.parts }
          : {}),
      };
      const messages: ChatMessage[] = [...historyForModel, turn];

      // Lifecycle hooks (Phase E2): `agent:start` fires before the loop and
      // `agent:end` after it settles. Hook actions run as this turn's actor —
      // never escalated — and a hook failure never breaks the turn: the
      // runner isolates per-hook failures, and emitHook guards the call.
      const actor = input.actor ?? { userId: "unknown", permissions: [] };
      const startedMs = Date.now();
      const hasAttachments = input.parts !== undefined && input.parts.length > 0;
      await this.emitHook(
        "agent:start",
        {
          event: "agent:start",
          at: new Date().toISOString(),
          conversationId: input.conversationId,
          userId: actor.userId,
          userTextLength: userText.length,
          hasAttachments,
          model: this.model,
        },
        actor,
        signal,
      );

      // Outbound webhooks (additive): the envelope is built here and handed
      // to the injected event sink; the payload carries metadata only (see
      // src/webhooks/events.ts). The sink owns the enabled check and
      // delivery, and emitEvent guards the call, so an unconfigured or
      // failing endpoint cannot affect the turn.
      this.emitEvent(
        agentStartEvent({
          conversationId: input.conversationId,
          userId: actor.userId,
          model: this.model,
          hasAttachments,
          userTextLength: userText.length,
          at: this.now().toISOString(),
        }),
      );

      let ok = true;
      let toolCalls = 0;
      let stopReason: string | undefined;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        const result = await this.runAgent(input, messages, userText, signal, compactedResults);
        toolCalls = result.toolCalls;
        stopReason = result.stopReason;
        usage = result.usage;

        // Commit only after a successful reply — never store a failed turn.
        this.commitTurn(input, userText, result.text);

        return {
          chunks: this.splitReply(result.text),
          model: result.model,
          isFake: this.provider.name === "fake",
          steps: result.steps,
          truncated: result.stopReason === "budget_exhausted",
          usage: result.usage,
          toolCalls: result.toolCalls,
          media: result.media,
        };
      } catch (err) {
        ok = false;
        throw err;
      } finally {
        await this.emitHook(
          "agent:end",
          {
            event: "agent:end",
            at: new Date().toISOString(),
            conversationId: input.conversationId,
            durationMs: Date.now() - startedMs,
            toolCalls,
            ok,
            // exactOptionalPropertyTypes: omit rather than pass undefined.
            ...(stopReason !== undefined ? { stopReason } : {}),
          },
          actor,
          signal,
        );
        this.emitEvent(
          agentEndEvent({
            conversationId: input.conversationId,
            userId: actor.userId,
            durationMs: Date.now() - startedMs,
            toolCalls,
            ok,
            // exactOptionalPropertyTypes: omit rather than pass undefined.
            ...(stopReason !== undefined ? { stopReason } : {}),
            ...(usage !== undefined
              ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
              : {}),
            at: this.now().toISOString(),
          }),
        );
      }
    });
  }

  /**
   * Hand a built webhook event envelope to the injected sink, if one is set.
   * Never throws: event observation must not break the turn it observes —
   * the same contract the engine's old direct delivery calls carried.
   */
  private emitEvent(event: WebhookEvent): void {
    const sink = this.onEvent;
    if (sink === undefined) return;
    try {
      sink(event);
    } catch {
      // Observation is not load-bearing — swallow sink failures.
    }
  }

  /**
   * Fire a lifecycle hook event through the injected runner, if one is set.
   * Never throws: hook observation must not break the turn it observes.
   */
  private async emitHook(
    event: HookEvent,
    payload: HookPayload,
    actor: ToolActor,
    signal: AbortSignal,
  ): Promise<void> {
    const hooks = this.hooks;
    if (!hooks) return;
    try {
      await hooks.runHooks(event, payload, {
        // The engine can run without tools (the plain chat path); hooks then
        // have nothing safe to execute through, and the runner skips them
        // with a warning rather than failing.
        ...(this.tools !== undefined ? { tools: this.tools } : {}),
        actor,
        signal,
      });
    } catch {
      // The runner never throws by contract; this is belt and suspenders so a
      // future change cannot turn hook observation into a turn failure.
    }
  }

  /**
   * Report per-run token totals to the usage observer. Diagnostic only: a
   * throwing or slow observer must never break the turn, so the call is
   * synchronous-fire-and-forget inside its own try/catch.
   */
  private emitRunUsage(
    userId: string,
    conversationId: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number },
  ): void {
    const cb = this.onRunUsage;
    if (cb === undefined) return;
    try {
      cb({
        userId,
        conversationId,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch {
      // Usage is accounting, not load-bearing — swallow observer failures.
    }
  }

  /**
   * Run the agent loop, or fall back to a single provider call when no tool
   * service is configured.
   */
  private async runAgent(
    input: ConversationInput,
    messages: ChatMessage[],
    userText: string,
    signal: AbortSignal,
    compactedResults = 0,
  ): Promise<RunOutcome> {
    if (!this.tools) {
      return this.plainCall(input, messages, signal, compactedResults);
    }

    const actor = input.actor ?? { userId: "unknown", permissions: [] };

    // Outbound webhooks (additive): the loop must observe tool steps even when
    // no progress sink is configured, so the condition below includes the
    // event sink's presence. The emission is metadata-only (tool name,
    // status, duration — never arguments or results) and fire-and-forget
    // through the guarded emitEvent.
    const loop = new AgentLoop({
      provider: this.provider,
      model: this.model,
      tools: this.tools,
      callTimeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      ...(this.budgets !== undefined ? { budgets: this.budgets } : {}),
      now: () => this.now().getTime(),
      ...(this.onStep !== undefined || input.onProgress !== undefined || this.onEvent !== undefined
        ? {
            onStep: (step: AgentStep) => {
              this.onStep?.(input.conversationId, step);
              input.onProgress?.(step);
              if (step.kind === "tool") {
                this.emitEvent(
                  toolEndEvent({
                    conversationId: input.conversationId,
                    userId: actor.userId,
                    tool: step.name,
                    status: step.status,
                    durationMs: step.durationMs,
                    at: this.now().toISOString(),
                  }),
                );
              }
            },
          }
        : {}),
      ...(this.allowToolCall !== undefined
        ? { allowToolCall: this.allowToolCall }
        : {}),
    });

    // The tool list and the memory count are both per-actor, so the prompt
    // describes exactly what THIS run may do — the same set the loop passes as
    // `tools`, so the prompt can never advertise something unavailable.
    //
    // Intent routing (core upgrade): the deterministic router is
    // advisory only — it reorders hinted tools first and adds a note,
    // but never removes a tool from the catalog.
    // BOBI_INTENT_ROUTER=0 leaves the catalog untouched (see route_specs).
    const routed = applyIntentRouting(
      this.tools.toolSpecsFor(actor),
      userText,
      this.tools.pluginCatalog,
    );
    const cardByName = new Map(
      this.tools.pluginCatalog.map((m) => [m.id, m] as const),
    );
    const specs = routed.specs.map((s) => {
      const card = cardByName.get(s.name);
      return {
        name: s.name,
        description: s.description,
        enabled: true,
        requires: [] as readonly string[],
        ...(card !== undefined
          ? { purpose: card.purpose, useWhen: card.useWhen }
          : {}),
      };
    });

    const memoryCount =
      this.memoryCount !== undefined && actor.userId !== "unknown"
        ? this.memoryCount(actor.userId)
        : undefined;

    // Core upgrade (memory core): the latest episode + proactively
    // recalled memories for this message, pasted into the prompt by
    // buildSystemPrompt. Enhancement only — any failure means the turn
    // runs without the blocks, exactly as before this wiring existed.
    let memoryPromptData:
      | { episode?: string; recalled?: readonly string[] }
      | undefined;
    if (
      this.memoryPrompt !== undefined &&
      actor.userId !== "unknown" &&
      userText.length > 0
    ) {
      try {
        memoryPromptData = await this.memoryPrompt(actor.userId, userText);
      } catch {
        memoryPromptData = undefined;
      }
    }

    // Owner profile (Phase 4): owner turns only — the seam itself gates
    // on input.isOwner and storage, lazy-seeds once, and degrades
    // silently to "no block" on any failure (see ownerProfileBlockForTurn).
    // Non-owner turns never touch the profile service.
    const ownerProfileBlock = await this.ownerProfileBlockForTurn(input);

    // Skills are matched against the user's latest text and pasted into the
    // prompt as owner-authored guidance — never as permissions or code.
    const skillContext =
      this.skills !== undefined
        ? buildSkillsContext(this.skills.skills(), userText)
        : undefined;

    // Project context files (Phase D3): snapshot once per turn so the
    // in-flight turn sees a frozen block even if the files change mid-run.
    const contextFiles =
      this.contextFiles !== undefined ? this.contextFiles.snapshot() : undefined;

    // Phase G1 personality: the sender's skin, validated against the
    // built-in list. The default skin carries an empty addition, which
    // buildSystemPrompt skips — so "no personality configured" is
    // byte-identical to the prompt before G1.
    const personality = this.resolvePersonality(input.userId ?? input.conversationId);

    const runInput: AgentRunInput = {
      messages,
      // Router pre-extraction rides as a one-line system note (args only,
      // never an instruction to execute): the model still chooses the call.
      toolSpecs: routed.specs,
      systemPrompt:
        buildSystemPrompt({
          tools: specs,
          now: this.now(),
          timezone: this.timezone,
          // Bilingual agent output: the TURN's user's language — never the
          // owner's, never chat text — so a public user's `en` pref answers
          // them in English while the owner keeps Persian.
          lang: this.resolveTurnLang(input),
          ...(memoryCount !== undefined ? { memoryCount } : {}),
          ...(memoryPromptData?.episode !== undefined
            ? { lastEpisode: memoryPromptData.episode }
            : {}),
          ...(memoryPromptData?.recalled !== undefined &&
          memoryPromptData.recalled.length > 0
            ? { recalledMemories: memoryPromptData.recalled }
            : {}),
          ...(skillContext !== undefined ? { skillContext } : {}),
          ...(contextFiles !== undefined ? { contextFiles } : {}),
          ...(personality?.systemAddition ? { personality: personality.systemAddition } : {}),
          ...(this.extraPrompt !== undefined ? { extra: this.extraPrompt } : {}),
          // Owner recognition: the bot verified this user from the Telegram ID.
          ...(input.isOwner === true ? { isOwner: true as const } : {}),
          // Owner profile (Phase 4): prebuilt block, owner turns only —
          // buildSystemPrompt pastes it only when isOwner is also set.
          ...(ownerProfileBlock !== undefined ? { ownerProfileBlock } : {}),
          // Group role clarity.
          ...(input.isGroup === true ? { isGroup: true as const } : {}),
        }) + (routed.note !== undefined ? `\n\n${routed.note}` : ""),
      actor,
      signal,
      // Tools that must act on the current chat get it from server context,
      // never from the model's arguments.
      conversationId: input.conversationId,
    };

    try {
      // The per-turn context budget is measured here, against the real
      // system prompt and the real message list: system + history + live
      // turn must fit the target, or the history slice is compressed
      // (tool one-liners → priority drops → top-K). The live turn is
      // never touched or dropped.
      const budgetedMessages = this.applyContextBudget(
        messages,
        runInput.systemPrompt,
        input.conversationId,
        compactedResults,
      );
      const result: AgentRunResult = await loop.run({
        ...runInput,
        messages: budgetedMessages,
      });
      // Per-run usage accounting (diagnostic; never breaks the turn).
      this.emitRunUsage(actor.userId, input.conversationId, result.model, result.usage);
      return {
        text: result.text,
        model: result.model,
        steps: result.steps,
        stopReason: result.stopReason,
        usage: result.usage,
        toolCalls: result.toolCallsExecuted,
        media: result.media,
      };
    } catch (err) {
      if (err instanceof AgentCancelled) {
        throw new EngineError("superseded", "Request superseded by a newer message.");
      }
      throw toEngineError(err, signal.aborted);
    }
  }

  /** The no-tools path: one provider call, exactly as before. */
  private async plainCall(
    input: ConversationInput,
    messages: ChatMessage[],
    signal: AbortSignal,
    compactedResults = 0,
  ): Promise<RunOutcome> {
    // Already superseded: don't start a provider call just to abandon it.
    if (signal.aborted) {
      throw new EngineError("superseded", "Request superseded by a newer message.");
    }
    // The plain path sends no separate system prompt (the summary rides
    // inside the message list), so the budget is measured against the
    // messages alone.
    const budgetedMessages = this.applyContextBudget(
      messages,
      undefined,
      input.conversationId,
      compactedResults,
    );
    const timeout = input.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = withDeadline(signal, timeout);
    // Race the caller's abort explicitly: withDeadline's `expired` only
    // rejects when the TIMER fires, never when the caller aborts. A
    // provider that ignores the abort signal would otherwise hang the
    // race below forever and hold the semaphore slot for the lifetime
    // of the process (same bug as loop.ts call() — fixed there first).
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new EngineError("superseded", "Request superseded by a newer message."));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    let res;
    try {
      // Raced as well as signalled: a provider that never settles must not be
      // able to hold a semaphore slot for the lifetime of the process.
      res = await Promise.race([
        raceDeadline(
          this.provider.complete({
            messages: budgetedMessages,
            model: this.model,
            timeoutMs: timeout,
            signal: deadline.signal,
          }),
          deadline,
        ),
        aborted,
      ]);
    } catch (err) {
      // Distinguish the caller replacing this turn from a real deadline: a
      // superseded run must stay silent, while a genuine timeout is reported.
      if (signal.aborted) {
        throw new EngineError("superseded", "Request superseded by a newer message.");
      }
      throw toEngineError(err, deadline.signal.aborted);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      deadline.dispose();
    }

    const text = res.text.trim();
    if (text.length === 0) {
      throw new EngineError("empty_response", "The model returned an empty response.");
    }
    // Per-run usage accounting (diagnostic; never breaks the turn).
    this.emitRunUsage(input.actor?.userId ?? "unknown", input.conversationId, res.model, {
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
    });
    return {
      text,
      model: res.model,
      steps: [],
      stopReason: "answered",
      // Reported by the provider when it supplies counts; zero otherwise,
      // rather than a guess.
      usage: {
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
      },
      toolCalls: 0,
      media: [],
    };
  }

  // ---- history backend ----

  /**
   * Resolve a turn/reference to its storage identity. Accepts the narrower
   * ConversationRef so /reset and /compress never fabricate a user message.
   */
  private ownerOf(input: ConversationInput | ConversationRef): {
    userId: string;
    chatId: string;
  } {
    return { userId: input.userId ?? input.conversationId, chatId: input.conversationId };
  }

  private loadHistory(input: ConversationInput): ChatMessage[] {
    return this.loadHistoryRows(input).map((r) => ({ role: r.role, content: r.content }));
  }

  /**
   * History rows with their storage ids (when storage-backed).
   *
   * The ids let compactedHistory track the summary watermark precisely —
   * which rows the rolling summary already covers — without changing what
   * `loadHistory` exposes to the rest of the engine.
   */
  private loadHistoryRows(input: ConversationInput): HistoryRow[] {
    if (!this.storage) {
      return (this.histories.get(input.conversationId) ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }
    const { userId, chatId } = this.ownerOf(input);
    const rows = this.storage.conversations.history(userId, chatId, this.historyLimit);
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content }));
  }

  /**
   * History for this turn: a rolling summary plus the recent window.
   *
   * Compaction is INCREMENTAL and persisted. An earlier version re-summarised
   * the entire prior conversation on every single message once the window
   * filled, which meant a second model call per turn forever. That is a real
   * cost bug, not just wasted work: a chatty conversation would pay double.
   *
   * Now each pass reads only the messages that have overflowed since the last
   * one — tracked by a stored message-id watermark — so every message is folded
   * into the summary exactly once. The summary is stored rather than held in
   * memory, because losing it on restart would permanently drop the old turns
   * it covers.
   *
   * Compaction stays best-effort: if the summariser fails, the turn proceeds
   * with the recent window and whatever summary already exists.
   */
  private async compactedHistory(
    input: ConversationInput,
    signal: AbortSignal,
  ): Promise<ChatMessage[]> {
    const rows = this.loadHistoryRows(input);
    const toMessages = (rs: readonly HistoryRow[]): ChatMessage[] =>
      rs.map((r) => ({ role: r.role, content: r.content }));

    // No storage means no watermark to track; the in-memory window is all
    // there is, which matches the old behaviour for the no-storage engine.
    if (!this.storage || !this.summarisationEnabled) return toMessages(rows);

    const { userId, chatId } = this.ownerOf(input);
    let stored;
    try {
      stored = this.storage.conversations.getConversationSummary(userId, chatId);
    } catch {
      // A failed read is not a reason to fail the turn.
      stored = undefined;
    }
    let summaryText = stored?.summary;

    // Rows the stored summary already covers are not loaded verbatim. In
    // the legacy overflow flow those rows sit outside the window anyway, so
    // this filter is a no-op there; it matters once the token-trigger fold
    // (below) starts folding part of the window itself into the summary.
    let recentRows =
      stored !== undefined
        ? rows.filter((r) => r.id === undefined || r.id > stored.summarisedUntil)
        : rows;

    const finish = (): ChatMessage[] =>
      summaryText !== undefined
        ? [summaryMessage(summaryText), ...toMessages(recentRows)]
        : toMessages(recentRows);

    // Only messages that have fallen out of the window are candidates, and only
    // those past the watermark.
    let overflow;
    try {
      overflow = this.storage.conversations.unsummarisedMessages(
        userId,
        chatId,
        stored?.summarisedUntil ?? 0,
        this.historyLimit,
      );
    } catch {
      // A failed read is not a reason to fail the turn.
      return finish();
    }

    if (overflow.length >= MIN_COMPACT_MESSAGES) {
      const messages: ChatMessage[] = overflow.map((r) => ({
        role: r.role,
        content: r.content,
      }));
      const summary = await summariseHistory(messages, summaryText, {
        provider: this.provider,
        model: this.model,
        signal,
      });

      if (summary !== undefined) {
        summaryText = summary;
        // Advance the watermark only on success, so a failed pass is retried
        // on the next turn instead of silently skipping those messages.
        const lastId = overflow[overflow.length - 1]!.id;
        try {
          this.storage.conversations.setConversationSummary({
            userId,
            chatId,
            summary,
            summarisedUntil: lastId,
          });
        } catch {
          // The summary is still usable this turn even if it could not be stored.
        }
      }
      // On failure what we had is kept; a failed refresh never discards it.
    }

    // Token trigger: when the assembled history (rolling summary + window)
    // is estimated over 60% of the context budget, fold the oldest half of
    // the window's turns into the rolling summary. This runs between turns —
    // this method is awaited before the turn's provider call, exactly like
    // the overflow fold — and advances the same watermark, so folded turns
    // leave the window for good instead of re-appearing next turn.
    if (this.contextBudgetEnabled) {
      const assembledEstimate = estimateMessagesTokens([
        ...(summaryText !== undefined ? [summaryMessage(summaryText)] : []),
        ...toMessages(recentRows),
      ]);
      if (assembledEstimate > SUMMARY_TRIGGER_RATIO * this.contextTokenBudget) {
        const foldable = recentRows.filter(
          (r) => (r.role === "user" || r.role === "assistant") && r.id !== undefined,
        );
        if (foldable.length >= MIN_COMPACT_MESSAGES) {
          const folding = foldable.slice(0, Math.ceil(foldable.length / 2));
          const folded = await summariseHistory(
            folding.map((r) => ({ role: r.role, content: r.content })),
            summaryText,
            { provider: this.provider, model: this.model, signal },
          );
          if (folded !== undefined) {
            summaryText = folded;
            const lastId = folding[folding.length - 1]!.id!;
            try {
              this.storage.conversations.setConversationSummary({
                userId,
                chatId,
                summary: folded,
                summarisedUntil: lastId,
              });
            } catch {
              // Still usable this turn even if it could not be stored.
            }
            const foldedIds = new Set(folding.map((r) => r.id));
            recentRows = recentRows.filter(
              (r) => r.id === undefined || !foldedIds.has(r.id),
            );
            // Counts only — never message content.
            this.clog.info("context: summary fold (token trigger)", {
              conversationId: input.conversationId,
              foldedMessages: folding.length,
              estimatedTokens: assembledEstimate,
              budget: this.contextTokenBudget,
            });
          }
        }
      }
    }

    return finish();
  }

  /**
   * Persist a successful turn.
   *
   * Attachments are NOT stored: base64 in the messages table would grow it
   * without bound, and a later turn does not need an earlier photo replayed.
   * A caption-less attachment is recorded as a short marker so the transcript
   * still shows that a turn happened.
   */
  private commitTurn(input: ConversationInput, userText: string, reply: string): void {
    const stored = userText.length > 0 ? userText : this.describeAttachmentsOnly(input);
    // Group transcripts keep their speaker labels in storage, so a later turn
    // still knows who said what. Private chats stay clean: one human, and the
    // request-time labels are enough for the model.
    const isGroup = input.isGroup === true;
    const userContent = isGroup
      ? labelUserTurn(stored, { isGroup: true, senderName: input.senderName })
      : stored;
    const assistantContent = isGroup ? labelAssistantTurn(reply) : reply;

    if (!this.storage) {
      const h = this.histories.get(input.conversationId) ?? [];
      h.push(
        { role: "user", content: userContent },
        { role: "assistant", content: assistantContent },
      );
      this.histories.set(input.conversationId, h);
      return;
    }
    const { userId, chatId } = this.ownerOf(input);
    this.storage.conversations.appendMessage(userId, chatId, "user", userContent);
    this.storage.conversations.appendMessage(userId, chatId, "assistant", assistantContent);
  }

  /** Transcript marker for a turn that was attachments only. */
  private describeAttachmentsOnly(input: ConversationInput): string {
    const count = input.parts?.length ?? 0;
    return count > 0 ? `[${count} attachment(s)]` : "[message with no text]";
  }

  /** Read history — memory or storage depending on configuration. */
  getHistory(input: ConversationInput | string): readonly ChatMessage[] {
    if (typeof input === "string") {
      return this.histories.get(input) ?? [];
    }
    return this.loadHistory(input);
  }

  clearHistory(input: ConversationInput | ConversationRef | string): void {
    if (typeof input === "string") {
      this.histories.delete(input);
      return;
    }
    if (this.storage) {
      const { userId, chatId } = this.ownerOf(input);
      this.storage.conversations.deleteConversation(userId, chatId);
      // The rolling summary is a separate row with no foreign key, so it must
      // be dropped explicitly. Leaving it would re-inject a summary of the
      // cleared conversation into the next one — a privacy surprise, and a
      // context contamination the user explicitly asked to be rid of.
      try {
        this.storage.conversations.clearConversationSummary(userId, chatId);
      } catch {
        // Best-effort: the messages are gone either way.
      }
    }
    this.histories.delete(input.conversationId);
  }

  /**
   * Phase G1: compress THIS conversation's history right now (/compress).
   *
   * Reuses the exact summariser and watermark machinery the automatic path
   * uses (see compactedHistory), so a manual compression and an automatic
   * one can never disagree about what has been summarised: the watermark
   * advances the same way, and a later turn will not re-summarise the same
   * messages.
   *
   * Returns a code for the bot's Persian reply — never the summary text
   * itself, which the user did not ask to see.
   *
   * Best-effort like the automatic path: a failed summarisation leaves the
   * history untouched and reports "failed" instead of throwing.
   */
  async compressNow(input: ConversationRef): Promise<CompressResult> {
    if (!this.storage || !this.summarisationEnabled) return "unavailable";

    const { userId, chatId } = this.ownerOf(input);

    let stored;
    try {
      stored = this.storage.conversations.getConversationSummary(userId, chatId);
    } catch {
      return "failed";
    }

    // Only what has overflowed the window since the last pass is a candidate —
    // the same boundary compactedHistory uses.
    let overflow;
    try {
      overflow = this.storage.conversations.unsummarisedMessages(
        userId,
        chatId,
        stored?.summarisedUntil ?? 0,
        this.historyLimit,
      );
    } catch {
      return "failed";
    }

    if (overflow.length < MIN_COMPACT_MESSAGES) {
      // An explicit request still waits for a meaningful batch: compressing
      // three messages would spend a model call for nothing.
      return "nothing_to_compress";
    }

    const messages: ChatMessage[] = overflow.map((r) => ({
      role: r.role,
      content: r.content,
    }));
    const summary = await summariseHistory(messages, stored?.summary, {
      provider: this.provider,
      model: this.model,
    });
    if (summary === undefined) return "failed";

    const lastId = overflow[overflow.length - 1]!.id;
    try {
      this.storage.conversations.setConversationSummary({
        userId,
        chatId,
        summary,
        summarisedUntil: lastId,
      });
    } catch {
      return "failed";
    }
    return "compressed";
  }
}

/**
 * Split text into ≤4096-char chunks on word/line boundaries.
 *
 * Compat export: the algorithm lives in the platform core splitter
 * (src/core/chunking.ts); the Telegram surface has its own re-export in
 * src/bot/chunking.ts. Kept here for existing importers (tests).
 */
export function splitForTelegram(text: string): string[] {
  return splitTextIntoChunks(text, TELEGRAM_MAX_LENGTH);
}

/** Convert any thrown error into an EngineError with a safe kind. */
function toEngineError(err: unknown, aborted: boolean): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof AiError) {
    return new EngineError(err.kind, err.message, err.status, err.attempts, err.providerMessage);
  }
  if (aborted) return new EngineError("timeout", "Request was cancelled or timed out.");
  return new EngineError("unknown", "Unknown error while processing the request.");
}

/**
 * Counting semaphore to bound concurrent provider calls.
 *
 * The slot is handed OVER, not re-fetched: a waiter is resolved only when a
 * permit is already free, and the permit transfers to it without incrementing
 * again. An earlier version had the waiter increment on wake, which let a
 * caller arriving between a release and the wakee's continuation also take the
 * slot — briefly exceeding `maxConcurrent`.
 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {
    if (max < 1) throw new Error("maxConcurrent must be >= 1");
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // Wait for a permit to be handed over. The caller that releases it has
      // already accounted for this waiter, so no increment happens here.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }

    try {
      return await fn();
    } finally {
      // Hand the permit to the next waiter, or give it back to the pool. The
      // count is not decremented first, so there is no window in which a new
      // caller can see a free slot that is already promised to a waiter.
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
