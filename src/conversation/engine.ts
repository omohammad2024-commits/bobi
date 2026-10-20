import type { AiProvider, ChatMessage, ContentPart } from "../ai/provider";
import { AiError } from "../ai/provider";
import type { Storage } from "../storage/storage";
import type { Lang } from "../i18n/types";
import { AgentCancelled, AgentLoop } from "../agent/loop";
import type { AgentBudgets, AgentRunInput } from "../agent/loop";
import { raceDeadline, withDeadline } from "../core/deadline";
import type { AgentRunResult, AgentStep } from "../agent/transcript";
import { buildSystemPrompt } from "../agent/prompt";
import { ContextFileCache } from "../context/loader";
import { MIN_COMPACT_MESSAGES, summariseHistory, summaryMessage } from "./summary";
import { formatHistoryForModel, labelAssistantTurn, labelUserTurn } from "./speakers";
import { prioritizeHistory } from "./prioritize";
import {
  getPersonality,
  type Personality,
} from "../personality/personalities";
import type { ToolService } from "../tools/service";
import type { ToolActor } from "../tools/types";
import type { SkillCache } from "../skills/loader";
import { buildSkillsContext } from "../skills/context";
import type { HookRunnerLike } from "../hooks/runner";
import type { HookEvent, HookPayload } from "../hooks/events";
import {
  webhooksEnabled,
  emitWebhookEvent,
  agentStartEvent,
  agentEndEvent,
  toolEndEvent,
} from "../webhooks";

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
}

/** Token totals for one settled turn, handed to `onRunUsage`. */
export interface RunUsageInfo {
  userId: string;
  conversationId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
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
  private readonly allowToolCall: ((userId: string) => boolean) | undefined;
  private readonly skills: SkillCache | undefined;
  private readonly contextFiles: ContextFileCache | undefined;
  private readonly hooks: HookRunnerLike | undefined;
  private readonly personalityFor: ((userId: string) => string | undefined) | undefined;

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
    this.summarisationEnabled = opts.summariseHistory !== false;
    this.allowToolCall = opts.allowToolCall;
    this.skills = opts.skills;
    this.contextFiles = opts.contextFiles;
    this.hooks = opts.hooks;
    this.personalityFor = opts.personalityFor;
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
      const messages: ChatMessage[] = [...history, turn];

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

      // Outbound webhooks (additive): one cached boolean on the hot path; the
      // payload carries metadata only (see src/webhooks/events.ts) and
      // emission never throws, so an unconfigured or failing endpoint cannot
      // affect the turn.
      const whOn = webhooksEnabled();
      if (whOn) {
        emitWebhookEvent(
          agentStartEvent({
            conversationId: input.conversationId,
            userId: actor.userId,
            model: this.model,
            hasAttachments,
            userTextLength: userText.length,
            at: this.now().toISOString(),
          }),
        );
      }

      let ok = true;
      let toolCalls = 0;
      let stopReason: string | undefined;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        const result = await this.runAgent(input, messages, userText, signal);
        toolCalls = result.toolCalls;
        stopReason = result.stopReason;
        usage = result.usage;

        // Commit only after a successful reply — never store a failed turn.
        this.commitTurn(input, userText, result.text);

        return {
          chunks: splitForTelegram(result.text),
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
        if (whOn) {
          emitWebhookEvent(
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
      }
    });
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
  ): Promise<RunOutcome> {
    if (!this.tools) {
      return this.plainCall(input, messages, signal);
    }

    const actor = input.actor ?? { userId: "unknown", permissions: [] };

    // Outbound webhooks (additive): the loop must observe tool steps even when
    // no progress sink is configured, so the condition below includes the
    // webhook flag. The emission is metadata-only (tool name, status,
    // duration — never arguments or results) and fire-and-forget.
    const whOn = webhooksEnabled();

    const loop = new AgentLoop({
      provider: this.provider,
      model: this.model,
      tools: this.tools,
      callTimeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      ...(this.budgets !== undefined ? { budgets: this.budgets } : {}),
      now: () => this.now().getTime(),
      ...(this.onStep !== undefined || input.onProgress !== undefined || whOn
        ? {
            onStep: (step: AgentStep) => {
              this.onStep?.(input.conversationId, step);
              input.onProgress?.(step);
              if (whOn && step.kind === "tool") {
                emitWebhookEvent(
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
    const specs = this.tools.toolSpecsFor(actor).map((s) => ({
      name: s.name,
      description: s.description,
      enabled: true,
      requires: [] as readonly string[],
    }));

    const memoryCount =
      this.memoryCount !== undefined && actor.userId !== "unknown"
        ? this.memoryCount(actor.userId)
        : undefined;

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
      systemPrompt: buildSystemPrompt({
        tools: specs,
        now: this.now(),
        timezone: this.timezone,
        // Bilingual agent output: the TURN's user's language — never the
        // owner's, never chat text — so a public user's `en` pref answers
        // them in English while the owner keeps Persian.
        lang: this.resolveTurnLang(input),
        ...(memoryCount !== undefined ? { memoryCount } : {}),
        ...(skillContext !== undefined ? { skillContext } : {}),
        ...(contextFiles !== undefined ? { contextFiles } : {}),
        ...(personality?.systemAddition ? { personality: personality.systemAddition } : {}),
        ...(this.extraPrompt !== undefined ? { extra: this.extraPrompt } : {}),
        // Owner recognition: the bot verified this user from the Telegram ID.
        ...(input.isOwner === true ? { isOwner: true as const } : {}),
        // Group role clarity.
        ...(input.isGroup === true ? { isGroup: true as const } : {}),
      }),
      actor,
      signal,
      // Tools that must act on the current chat get it from server context,
      // never from the model's arguments.
      conversationId: input.conversationId,
    };

    try {
      const result: AgentRunResult = await loop.run(runInput);
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
  ): Promise<RunOutcome> {
    // Already superseded: don't start a provider call just to abandon it.
    if (signal.aborted) {
      throw new EngineError("superseded", "Request superseded by a newer message.");
    }
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
            messages,
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
    if (!this.storage) {
      return this.histories.get(input.conversationId) ?? [];
    }
    const { userId, chatId } = this.ownerOf(input);
    const rows = this.storage.history(userId, chatId, this.historyLimit);
    return rows.map((r) => ({ role: r.role, content: r.content }));
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
    const recent = this.loadHistory(input);

    // No storage means no watermark to track; the in-memory window is all
    // there is, which matches the old behaviour for the no-storage engine.
    if (!this.storage || !this.summarisationEnabled) return recent;

    const { userId, chatId } = this.ownerOf(input);
    const stored = this.storage.getConversationSummary(userId, chatId);

    // Only messages that have fallen out of the window are candidates, and only
    // those past the watermark.
    let overflow;
    try {
      overflow = this.storage.unsummarisedMessages(
        userId,
        chatId,
        stored?.summarisedUntil ?? 0,
        this.historyLimit,
      );
    } catch {
      // A failed read is not a reason to fail the turn.
      return stored !== undefined ? [summaryMessage(stored.summary), ...recent] : recent;
    }

    if (overflow.length < MIN_COMPACT_MESSAGES) {
      // Nothing new has overflowed; reuse the existing summary. This is the
      // case that used to trigger an unnecessary model call every turn.
      return stored !== undefined ? [summaryMessage(stored.summary), ...recent] : recent;
    }

    const messages: ChatMessage[] = overflow.map((r) => ({ role: r.role, content: r.content }));
    const summary = await summariseHistory(messages, stored?.summary, {
      provider: this.provider,
      model: this.model,
      signal,
    });

    if (summary === undefined) {
      // Keep what we had; a failed refresh must not discard it.
      return stored !== undefined ? [summaryMessage(stored.summary), ...recent] : recent;
    }

    // Advance the watermark only on success, so a failed pass is retried on the
    // next turn instead of silently skipping those messages.
    const lastId = overflow[overflow.length - 1]!.id;
    try {
      this.storage.setConversationSummary({
        userId,
        chatId,
        summary,
        summarisedUntil: lastId,
      });
    } catch {
      // The summary is still usable this turn even if it could not be stored.
    }

    return [summaryMessage(summary), ...recent];
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
    this.storage.appendMessage(userId, chatId, "user", userContent);
    this.storage.appendMessage(userId, chatId, "assistant", assistantContent);
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
      this.storage.deleteConversation(userId, chatId);
      // The rolling summary is a separate row with no foreign key, so it must
      // be dropped explicitly. Leaving it would re-inject a summary of the
      // cleared conversation into the next one — a privacy surprise, and a
      // context contamination the user explicitly asked to be rid of.
      try {
        this.storage.clearConversationSummary(userId, chatId);
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
      stored = this.storage.getConversationSummary(userId, chatId);
    } catch {
      return "failed";
    }

    // Only what has overflowed the window since the last pass is a candidate —
    // the same boundary compactedHistory uses.
    let overflow;
    try {
      overflow = this.storage.unsummarisedMessages(
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
      this.storage.setConversationSummary({
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

/** Split text into ≤4096-char chunks on word/line boundaries. */
export function splitForTelegram(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (cut < TELEGRAM_MAX_LENGTH / 2) cut = rest.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
    if (cut < TELEGRAM_MAX_LENGTH / 2) cut = TELEGRAM_MAX_LENGTH;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Convert any thrown error into an EngineError with a safe kind. */
function toEngineError(err: unknown, aborted: boolean): EngineError {
  if (err instanceof EngineError) return err;
  if (err instanceof AiError) return new EngineError(err.kind, err.message);
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
