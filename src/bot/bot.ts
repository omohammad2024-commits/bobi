import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import {
  buildMainMenu,
  replyForCallback,
  buildVoiceKeyboard,
  isVoiceCallback,
  VOICE_CALLBACKS,
  menuKeyboardFor,
  editMenuMessage,
  startScreenText,
  helpTitle,
  helpGroupTitle,
  helpEntryLine,
  CALLBACKS,
  type HelpGroup,
} from "./menu";
import { shouldHandleMessage } from "./filter";
import { toolProgressLabel } from "./ux";
import { normalizeShortcutName } from "../tools/shortcuts";
import {
  PALETTE_CALLBACK_PREFIX,
  handlePaletteCallback,
  openPaletteMessage,
  paletteCategoriesRender,
  registerPaletteCommands,
} from "./palette";
import {
  DIGEST_CALLBACK_PREFIX,
  handleDigestCallback,
  registerDigestCommands,
} from "./digest_cmd";
import {
  ONBOARDING_CALLBACK_PREFIX,
  handleOnboardingCallback,
  handleOnboardingText,
  maybeStartOnboarding,
  type OnboardingEnv,
} from "./onboarding";
import {
  buildPersonalityKeyboard,
  parsePersonalityCallback,
  PERSONALITY_CALLBACK_PREFIX,
  withChatAction,
} from "./ux";
import { t, type Lang } from "../i18n";
import { runWithStreamSink, streamingEnabled, StreamRenderer } from "../agent/stream";
import type { StreamEventSink } from "../agent/stream";
import {
  blockquoteToEntities,
  replyExpandable,
  stripBlockquoteMarkers,
} from "./expandable_quote";
import type { MessageEntity } from "@grammyjs/types";
import type { ConversationEngine } from "../conversation/engine";
import { EngineError } from "../conversation/engine";
import type { AgentStep } from "../agent/transcript";
import type { ToolService } from "../tools/service";
import type { ToolActor } from "../tools/types";
import type { AuthorizationService } from "../auth/service";
import { authorizeToolUse, toToolActor } from "../auth/tool_bridge";
import { isToolError } from "../tools/errors";
import type { GroupAccessService } from "../groups/service";
import type { PanelController } from "../groups/controller";
import type { AiAdminController } from "../groups/ai_controller";
import { checkGroupAccess, denialNote } from "../groups/enforcement";
import {
  getAssistantConfig,
  recordGroupMessage,
  shouldReplyAssistant,
  type GroupHistory,
} from "../groups/assistant";
import type { UserAccessService } from "../auth/user_service";
import type { UserPanelController } from "../auth/user_controller";
import { checkUserAccess, userDenialNote } from "../auth/user_enforcement";
import {
  isOwnerCtx,
  requireOwnerTier,
} from "./access";
import {
  buildPublicMainMenu,
} from "./menu";
import type { Storage } from "../storage/storage";
import type { RegisterOpts } from "./cmd_system";
import { extractMedia, hasMedia, describeMediaPart, MAX_MEDIA_PER_REPLY } from "./media";
import { createModerator } from "../moderation/index";
import type { RateLimiter } from "../core/rate_limit";
import type { UsageService } from "../core/usage";
import type { ContentPart } from "../ai/provider";
import {
  transcribeAudio,
  TRANSCRIBE_TIMEOUT_MS,
  type TranscribeOptions,
} from "../ai/transcribe";
import {
  synthesizeSpeech,
  planVoiceDelivery,
  TTS_TIMEOUT_MS,
  type TtsOptions,
} from "../ai/tts";
import { maybeExtractDocuments } from "../tools/extract_document";
import {
  getPersonality,
  personalityNames,
  resolvePersonalityName,
} from "../personality/personalities";
import type { CompressResult } from "../conversation/engine";

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
 * The tool-layer actor for a Telegram user, derived from the Authorization
 * Core's trusted numeric id.
 *
 * This is the only place a Telegram identity becomes tool permissions. It
 * reads `ctx.from.id` (server-validated) and applies server-side policy, so
 * message text, callback data, or a username cannot widen the grant. The model
 * chooses which tool to call; what it may call is decided here, on the server.
 */
function toolActorFor(
  tools: ToolService,
  auth: AuthorizationService | undefined,
  ctx: Context,
): ToolActor {
  if (!auth) return { permissions: [], userId: "unknown" };
  // ctx.from is absent for channel posts; treat that as no identity at all
  // rather than guessing, so such an update gets no tool access.
  const actor = ctx.from ? auth.actorFromTelegramUser(ctx.from) : undefined;
  return toToolActor(authorizeToolUse(auth, actor, tools.registry.list()));
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
async function safeReply(
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
 * A progress message that is edited in place as the run proceeds.
 *
 * A tool-using run can take tens of seconds. Without this the user sees nothing
 * until it finishes and reasonably concludes the bot is broken. The message is
 * edited rather than re-sent so a run that calls six tools does not leave six
 * messages behind.
 *
 * Every method is best-effort: if Telegram refuses the edit, the run continues
 * and the final answer is still delivered.
 */
function createProgress(ctx: Context, lang: Lang) {
  let messageId: number | undefined;
  let sent = false;

  return {
    /** The posted status message, once start() succeeded. */
    get messageId(): number | undefined {
      return messageId;
    },

    /** Post the initial "working on it" message. */
    async start(): Promise<void> {
      try {
        const msg = await ctx.reply(t(PROGRESS_THINKING_KEY, lang));
        messageId = msg.message_id;
        sent = true;
      } catch {
        sent = false;
      }
    },

    /** Replace the text with a new status line. */
    async update(text: string): Promise<void> {
      if (!sent || messageId === undefined) return;
      try {
        await ctx.api.editMessageText(ctx.chat!.id, messageId, text);
      } catch {
        // A rejected edit (rate limit, unchanged text) must not fail the run.
      }
    },

    /**
     * Remove the progress message once the answer is ready.
     *
     * Deleting rather than leaving it means the chat shows the answer alone —
     * the transient status has served its purpose.
     */
    async finish(): Promise<void> {
      if (!sent || messageId === undefined) return;
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, messageId);
      } catch {
        // An old message the user deleted is not an error.
      }
    },
  };
}

const PROGRESS_THINKING_KEY = "progress.thinking";

/**
 * Streaming glue for one turn.
 *
 * When streaming applies (kill switch on, text reply modality, no
 * skipped-attachment note to deliver, no voice-unavailable note pending),
 * owns a StreamRenderer bound to the progress message plus the sink the
 * agent loop consumes through the ambient scope (see src/agent/stream.ts).
 *
 * After the turn, deliver() either completes the answer IN PLACE — the
 * progress message BECOMES the reply, so the user keeps reading where the
 * stream left off — or returns false, in which case the caller runs the
 * classic path (delete the status line, deliverReply). stop() halts the
 * flush timer and must be called once the turn settles, whichever path ran.
 */
interface TurnStreamer {
  /** The sink to install around engine.respond(), when streaming applies. */
  readonly sink: StreamEventSink | undefined;
  /** Stop the flush timer. Always call once the turn settles. */
  stop(): void;
  /**
   * Deliver the final chunks. Returns true when the answer went out in
   * place (skip progress.finish() + deliverReply), false otherwise.
   */
  deliver(chunks: readonly string[]): Promise<boolean>;
}

/** Max one placeholder edit per second — Telegram's safe cadence for edits. */
const STREAM_EDIT_INTERVAL_MS = 1000;

function createTurnStreamer(
  ctx: Context,
  deps: BotDeps,
  progress: ReturnType<typeof createProgress>,
  opts: {
    lang: Lang;
    userId: string;
    inputWasVoice: boolean;
    chatType: string;
    /** Attachments that could not be used; named before the answer. */
    skippedCount: number;
  },
): TurnStreamer {
  const inactive: TurnStreamer = {
    sink: undefined,
    stop: () => undefined,
    deliver: () => Promise.resolve(false),
  };

  // The kill switch short-circuits everything: no sink, no renderer, the
  // classic path runs untouched.
  if (!streamingEnabled()) return inactive;

  // Streaming renders into a text message. Voice replies are synthesised
  // from the final text instead, and two special notes (skipped attachments,
  // voice-unavailable) are delivered as separate messages around the answer
  // — all three would fight an in-place render, so those turns keep the
  // classic path.
  let pref: VoicePref = "auto";
  try {
    if (deps.prefs !== undefined) {
      pref = resolveVoicePref(deps.prefs.getUserPref(opts.userId, VOICE_MODE_KEY));
    }
  } catch {
    pref = "auto";
  }
  const ttsConfigured = deps.tts !== undefined && deps.tts.baseUrl.trim().length > 0;
  const textModality =
    decideReplyModality({
      pref,
      inputWasVoice: opts.inputWasVoice,
      chatType: opts.chatType,
      ttsConfigured,
    }) === "text";
  const voiceNotePending = opts.inputWasVoice && !ttsConfigured && deps.prefs !== undefined;
  if (!textModality || voiceNotePending || opts.skippedCount > 0) return inactive;

  const renderer = new StreamRenderer((text) => progress.update(text));
  const sink: StreamEventSink = (ev) => {
    switch (ev.type) {
      case "token": {
        // The first token bypasses the throttle so the time to the first
        // visible word tracks the network, not the flush interval.
        const first = !renderer.started;
        renderer.push(ev.delta);
        if (first) void renderer.flushNow();
        break;
      }
      case "toolcall":
      case "restart":
        // The stream resolved into tool calls, or died and is being
        // re-answered in one shot: drop the partial text. The tool progress
        // lines (toolcall) or the thinking line (restart) take over the
        // message from here via the normal onProgress path.
        renderer.suspend();
        if (ev.type === "restart") void progress.update(t(PROGRESS_THINKING_KEY, opts.lang));
        break;
      case "error":
        renderer.stop();
        break;
    }
  };
  const timer = setInterval(() => {
    void renderer.flush();
  }, STREAM_EDIT_INTERVAL_MS);

  return {
    sink,
    stop: () => clearInterval(timer),
    deliver: async (chunks) => {
      clearInterval(timer);
      renderer.stop();
      if (!renderer.started || chunks.length === 0) return false;
      const messageId = progress.messageId;
      let edited = false;
      if (messageId !== undefined && ctx.chat !== undefined) {
        try {
          // Entities are computed on the FINAL text only: the streamed
          // previews stay plain text so a half-written quote can never be
          // rejected for malformed entities.
          const first = blockquoteToEntities(chunks[0]!);
          await ctx.api.editMessageText(
            ctx.chat.id,
            messageId,
            first.text,
            first.entities.length > 0 ? { entities: first.entities } : undefined,
          );
          edited = true;
        } catch {
          // The edit was refused (deleted message, rate limit): fall
          // through and send everything as new messages instead.
          edited = false;
        }
      }
      for (const c of edited ? chunks.slice(1) : chunks) await replyExpandable(ctx, c);
      return true;
    },
  };
}

/** The progress line for one step, in the sender's language. */
function progressText(step: AgentStep, lang: Lang): string | undefined {
  if (step.kind !== "tool") return undefined;
  const label = toolProgressLabel(step.name);
  return step.status === "ok"
    ? t("progress.tool_running", lang, { label })
    : t("progress.tool_done", lang, { label });
}

/**
 * Enforce the per-user message budget.
 *
 * The owner is exempt: locking the owner out of their own bot over a burst is
 * worse than the burst. A refusal says how long to wait, so it reads as a limit
 * rather than a failure.
 */
async function takeMessageBudget(ctx: Context, deps: BotDeps): Promise<boolean> {
  const { rateLimit, auth } = deps;
  if (!rateLimit || !ctx.from) return true;

  const actor = auth ? auth.actorFromTelegramUser(ctx.from) : undefined;
  if (actor !== undefined && auth?.isOwner(actor)) return true;

  const decision = rateLimit.takeMessage(String(ctx.from.id));
  if (decision.allowed) return true;

  const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
  console.error("[sol] rate limited: user message budget");
  const lang = senderLang(ctx, deps.prefs);
  await safeReply(ctx, t("ratelimit.wait", lang, { seconds }));
  return false;
}

/**
 * Phase B2 + phase-2 item 5 — voice transcription and the voice-first loop.
 *
 * B2: when the active provider cannot accept raw audio natively AND the owner
 * configured a transcription endpoint, voice messages are transcribed before
 * reaching the engine. Otherwise the audio parts keep their existing
 * behaviour (native handling, or the adapter's named "not sent" note).
 *
 * Voice-first (phase-2 item 5): the reply modality mirrors the input
 * modality — a voice note gets a voice answer automatically, no toggle
 * needed (see decideReplyModality). Text in → text out, unchanged. /voice is
 * the explicit 3-way override (auto/always/never), not the only path.
 */

/** The user_prefs key for voice replies. */
export const VOICE_MODE_KEY = "voice_mode";

/**
 * Once-per-user flag: the "TTS not configured" note is shown at most once,
 * so a voice user is informed but never nagged. Never set for text users.
 */
export const VOICE_UNCONFIGURED_NOTIFIED_KEY = "voice_unconfigured_notified";

/**
 * The three-way voice preference, stored under VOICE_MODE_KEY.
 *
 * - auto (default): mirror the input — voice in → voice out, text in →
 *   text out. In groups auto stays text (see decideReplyModality).
 * - always: every reply as voice, in any chat.
 * - never: every reply as text.
 */
export type VoicePref = "auto" | "always" | "never";

/** The canonical stored values, in display order. Exported for tests. */
export const VOICE_PREF_VALUES: readonly VoicePref[] = ["auto", "always", "never"];

/**
 * Resolve the stored pref to the three-way value. Pure, for tests.
 *
 * Legacy migration: the old boolean toggle's "1" becomes "always"; "0",
 * an absent key, or anything unexpected becomes "auto" (the new default).
 */
export function resolveVoicePref(stored: string | undefined): VoicePref {
  if (stored === "always") return "always";
  if (stored === "never") return "never";
  if (stored === "1") return "always";
  return "auto";
}

/**
 * Decide the reply modality. Pure, so the whole decision matrix is
 * assertable without a network or Telegram.
 *
 * Rules, in order:
 * 1. TTS unconfigured → text (nothing to synthesise with).
 * 2. pref "never" → text; pref "always" → voice (explicit user choice, in
 *    every chat including groups).
 * 3. pref "auto" (default): voice only when the input was a voice message
 *    AND the chat is private. A bot blurting voice notes into a busy group
 *    is noise, so groups get transcribed + text replies unless the user set
 *    "always".
 */
export function decideReplyModality(input: {
  pref: VoicePref;
  inputWasVoice: boolean;
  /** Telegram chat type: "private" | "group" | "supergroup" | "channel" | ... */
  chatType: string;
  ttsConfigured: boolean;
}): "voice" | "text" {
  if (!input.ttsConfigured) return "text";
  if (input.pref === "never") return "text";
  if (input.pref === "always") return "voice";
  return input.inputWasVoice && input.chatType === "private" ? "voice" : "text";
}

/** Max audio attachments transcribed per turn; extras keep the audio parts. */
export const MAX_TRANSCRIBED_AUDIO_PARTS = 2;

/** The label that replaces a transcribed voice message. Exported for tests. */
export function transcriptLabel(transcript: string): string {
  return `[voice message transcript]: ${transcript}`;
}

/** One transcription call, injected so tests can stub it. */
export type AudioTranscriber = (audio: Buffer, mediaType: string) => Promise<string>;

/**
 * Decide whether this turn's audio parts should be transcribed. Pure, so the
 * decision matrix (disabled / native / transcribe) is assertable without a
 * network.
 *
 * - Transcription disabled (no config or empty baseUrl) → false: the parts
 *   stay and the adapter emits its existing named note.
 * - Provider handles audio natively (e.g. Gemini) → false: the parts stay.
 * - Otherwise → true: each audio part becomes its transcript.
 */
export function shouldTranscribeAudio(
  deps: Pick<BotDeps, "transcribe" | "engine">,
): boolean {
  const cfg = deps.transcribe;
  if (cfg === undefined || cfg.baseUrl.trim().length === 0) return false;
  if (deps.engine.activeSupportsAudioInput()) return false;
  return true;
}

/**
 * Replace up to MAX_TRANSCRIBED_AUDIO_PARTS audio parts with their
 * transcripts, in order. Never throws and never drops content: a failed or
 * empty transcription leaves the original audio part in place (the adapter's
 * named note then covers it), and non-audio parts pass through untouched.
 */
export async function transcribeAudioParts(
  parts: readonly ContentPart[],
  transcribe: AudioTranscriber,
): Promise<ContentPart[]> {
  let budget = MAX_TRANSCRIBED_AUDIO_PARTS;
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type !== "audio" || budget === 0) {
      out.push(part);
      continue;
    }
    budget -= 1;
    try {
      const text = await transcribe(Buffer.from(part.base64, "base64"), part.mediaType);
      if (text.trim().length > 0) {
        out.push({ type: "text", text: transcriptLabel(text.trim()) });
      } else {
        // An empty transcript says nothing; the audio part stays so the
        // adapter's note explains it was heard but had no words.
        console.error("[bobi] transcription returned empty text");
        out.push(part);
      }
    } catch (err) {
      // A failed transcription must never fail the turn: the part stays, the
      // adapter names it, and the detail stays in the log, never the audio.
      console.error("[bobi] transcription failed:", errToLog(err));
      out.push(part);
    }
  }
  return out;
}

/** Bilingual notes for voice-reply delivery. Exported for tests. */
export const VOICE_FAILED_NOTE = t("voice.tts_failed");
export const VOICE_TRUNCATED_NOTE = t("voice.truncated");

/** The context deliverReply needs: sending plus, optionally, chat actions. */
export interface DeliverCtx {
  /**
   * Send a text reply. The optional `extra.entities` is load-bearing: when
   * the reply contains markdown blockquotes, replyExpandable passes the
   * expandable_blockquote entities through it. A reply() that ignores the
   * second argument silently drops the quotes, so callers must forward it.
   * `extra.reply_parameters` makes the reply quote a specific message —
   * used in groups so the bot visibly replies to the user who called it.
   */
  reply(
    text: string,
    extra?: { entities?: MessageEntity[]; reply_parameters?: { message_id: number } },
  ): Promise<unknown>;
  replyWithVoice(voice: InputFile): Promise<unknown>;
  chat?: { id: number | string } | undefined;
  api?:
    | {
        sendChatAction(chatId: number | string, action: string): Promise<unknown>;
      }
    | undefined;
}

/** What deliverReply needs to know about the triggering message. */
export interface DeliverOpts {
  /** True when the triggering message carried a voice note / audio file. */
  inputWasVoice?: boolean;
  /** Telegram chat type: "private" | "group" | "supergroup" | "channel". */
  chatType?: string;
  /**
   * The Telegram message ID to reply to. When set (in groups), the bot's
   * response visibly quotes the user's message via reply_parameters.
   */
  replyToMessageId?: number;
}

/**
 * Deliver the reply chunks, with the modality mirrored from the input
 * (see decideReplyModality): voice in → voice out, text in → text out,
 * unless the sender overrode it with /voice.
 *
 * The first MAX_VOICE_CHUNKS chunks / MAX_VOICE_CHARS characters become voice
 * (see `planVoiceDelivery`); anything past the caps is sent as text so no
 * content is lost. An «upload_voice» chat action runs while synthesising so
 * the voice reply starts ASAP. A TTS failure for any piece falls back to the
 * whole reply as text plus one note in the sender's language — a half-voiced
 * reply would be confusing. Never throws: delivery faults are the caller's
 * (runTurn's) domain.
 */
export async function deliverReply(
  ctx: DeliverCtx,
  env: Pick<BotDeps, "tts" | "prefs">,
  userId: string,
  chunks: readonly string[],
  synth: typeof synthesizeSpeech = synthesizeSpeech,
  opts: DeliverOpts = {},
): Promise<void> {
  const tts = env.tts;
  const prefs = env.prefs;
  const ttsConfigured = tts !== undefined && tts.baseUrl.trim().length > 0;
  let pref: VoicePref = "auto";
  const lang: Lang = "en";
  try {
    // The sender's voice-mode preference, resolved from the validated pref
    // store — never from message text. UI language is English-only (v1.0).
    if (prefs !== undefined) {
      pref = resolveVoicePref(prefs.getUserPref(userId, VOICE_MODE_KEY));
    }
  } catch {
    // A preference read failure is not a reason to break the reply: text.
    pref = "auto";
  }

  const inputWasVoice = opts.inputWasVoice === true;
  const modality = decideReplyModality({
    pref,
    inputWasVoice,
    chatType: opts.chatType ?? "private",
    ttsConfigured,
  });

  if (modality === "text") {
    // A voice note that cannot be answered in voice deserves one short
    // explanation — bilingual, shown once per user, and never to text
    // users (they did not ask for voice).
    if (!ttsConfigured && inputWasVoice && prefs !== undefined) {
      await noteVoiceUnavailable(ctx, prefs, userId, lang);
    }
    for (const chunk of chunks) await replyExpandable(ctx, chunk, opts.replyToMessageId);
    return;
  }

  const { voice, text } = planVoiceDelivery(chunks);
  try {
    for (const piece of voice) {
      const { audio } = await withChatAction(ctx, "upload_voice", () =>
        // Strip quote markers: the voice must never read "> " aloud.
        synth(tts!, stripBlockquoteMarkers(piece), AbortSignal.timeout(TTS_TIMEOUT_MS)),
      );
      await ctx.replyWithVoice(new InputFile(audio, "bobi.ogg"));
    }
  } catch (err) {
    // Technical detail stays in the log; the user gets the static note.
    console.error("[bobi] TTS failed, falling back to text:", errToLog(err));
    await ctx.reply(t("voice.tts_failed", lang));
    for (const chunk of chunks) await replyExpandable(ctx, chunk);
    return;
  }
  if (text.length > 0) {
    await ctx.reply(t("voice.truncated", lang));
    for (const chunk of text) await replyExpandable(ctx, chunk);
  }
}

/**
 * Tell a voice user once that TTS is not configured, then remember it.
 *
 * Best-effort and silent on failure: a preference hiccup must not break the
 * reply, and a user who cannot be reached does not need a retry loop.
 */
async function noteVoiceUnavailable(
  ctx: { reply(text: string): Promise<unknown> },
  prefs: UserPrefStore,
  userId: string,
  lang: Lang,
): Promise<void> {
  let notified = false;
  try {
    notified = prefs.getUserPref(userId, VOICE_UNCONFIGURED_NOTIFIED_KEY) === "1";
  } catch {
    notified = false;
  }
  if (notified) return;
  try {
    prefs.setUserPref(userId, VOICE_UNCONFIGURED_NOTIFIED_KEY, "1");
  } catch {
    // The note below still goes out; the flag is an optimisation.
  }
  try {
    await ctx.reply(t("voice.not_configured", lang));
  } catch {
    // Best effort: the user cannot be reached.
  }
}

/** The environment /voice needs: TTS config plus the preference store. */
export type VoiceCommandEnv = Pick<BotDeps, "tts" | "prefs">;

/**
 * Parse a /voice argument into the canonical pref value. Pure, for tests.
 * Accepts the three canonical values, case-insensitively; anything else
 * (including an absent argument) is undefined and handled by the caller.
 */
export function parseVoiceArg(arg: string | undefined): VoicePref | undefined {
  if (arg === undefined) return undefined;
  const v = arg.trim().toLowerCase();
  return (VOICE_PREF_VALUES as readonly string[]).includes(v)
    ? (v as VoicePref)
    : undefined;
}

/** Parse a voice: callback into the canonical pref value; junk → undefined. */
export function voiceValueForCallback(data: string): VoicePref | undefined {
  if (data === VOICE_CALLBACKS.auto) return "auto";
  if (data === VOICE_CALLBACKS.always) return "always";
  if (data === VOICE_CALLBACKS.never) return "never";
  return undefined;
}

/**
 * /voice: show or set the sender's voice-mode preference (auto/always/never).
 *
 * - `/voice` — the current mode plus tap-to-pick buttons.
 * - `/voice auto|always|never` — set it directly.
 *
 * Public under the two-tier model (voice is conversation): gated by the
 * caller with the same group/user gates as the message path, never the tier
 * gate. Never throws. When TTS is not configured the preference is NOT set —
 * an enabled flag with no endpoint behind it would silently change nothing.
 */
export async function handleVoiceCommand(
  ctx: {
    from?: { id: number | string } | undefined;
    reply(text: string, extra?: { reply_markup: InlineKeyboard }): Promise<unknown>;
  },
  env: VoiceCommandEnv,
  lang: Lang = "en",
  arg?: string,
): Promise<void> {
  if (ctx.from === undefined) return;
  if (env.tts === undefined || env.tts.baseUrl.trim().length === 0 || env.prefs === undefined) {
    try {
      await ctx.reply(t("voice.not_configured", lang));
    } catch {
      // Best effort: the user cannot be reached.
    }
    return;
  }

  const userId = String(ctx.from.id);

  // An explicit argument sets the preference directly.
  const value = parseVoiceArg(arg);
  if (value !== undefined) {
    await storeVoicePref(ctx, env.prefs, userId, value, lang);
    return;
  }
  if (arg !== undefined && arg.trim().length > 0) {
    try {
      await ctx.reply(t("voice.unknown_option", lang));
    } catch {
      // Best effort.
    }
    return;
  }

  // Bare /voice: the current mode with tap-to-pick buttons. The write itself
  // happens in handleVoiceCallback, which only ever stores canonical values.
  let current: VoicePref = "auto";
  try {
    current = resolveVoicePref(env.prefs.getUserPref(userId, VOICE_MODE_KEY));
  } catch {
    // Default auto; the set below will surface a real storage fault.
  }
  try {
    await ctx.reply(t("voice.prompt", lang, { mode: t(`voice.mode.${current}`, lang) }), {
      reply_markup: buildVoiceKeyboard(lang),
    });
  } catch {
    // Best effort: the user cannot be reached.
  }
}

/**
 * Persist one canonical voice pref and confirm in the sender's language.
 * A storage failure reports the shared prefs failure line, as before.
 */
async function storeVoicePref(
  ctx: { reply(text: string): Promise<unknown> },
  prefs: UserPrefStore,
  userId: string,
  value: VoicePref,
  lang: Lang,
): Promise<void> {
  try {
    prefs.setUserPref(userId, VOICE_MODE_KEY, value);
  } catch {
    try {
      await ctx.reply(t("prefs.save_failed", lang));
    } catch {
      // Best effort.
    }
    return;
  }
  try {
    await ctx.reply(t(`voice.set_${value}`, lang));
  } catch {
    // The preference was saved; a failed confirmation is not worth failing over.
  }
}

/**
 * /voice button click: persist the sender's chosen mode.
 *
 * SECURITY: only the three canonical values are ever written to user_prefs;
 * junk callback data is rejected without touching the store. Raw callback
 * text never reaches t() as a mode (the key suffix is exactly one of the
 * three canonical values here).
 *
 * Gated by the caller (same group/user gates as the /voice command, no tier
 * gate — voice is conversation); never throws.
 */
export async function handleVoiceCallback(
  ctx: {
    from?: { id: number | string } | undefined;
    answerCallbackQuery(text?: string): Promise<unknown>;
    reply(text: string): Promise<unknown>;
  },
  env: VoiceCommandEnv,
  data: string,
  lang: Lang = "en",
): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // Best effort: Telegram shows the loading indicator briefly.
  }
  if (ctx.from === undefined) return;
  const value = voiceValueForCallback(data);
  if (value === undefined) {
    // Junk picker data — reject, don't persist.
    await safeReply(ctx, t("voice.unknown_option", lang));
    return;
  }
  if (env.tts === undefined || env.tts.baseUrl.trim().length === 0 || env.prefs === undefined) {
    await safeReply(ctx, t("voice.not_configured", lang));
    return;
  }
  await storeVoicePref(ctx, env.prefs, String(ctx.from.id), value, lang);
}

/**
 * Phase G1 — user commands.
 *
 * All user-facing replies go through t() (English-only since v1.0); all
 * comments are English. Handlers are
 * exported with minimal context shapes (the handleVoiceCommand pattern) so
 * they are unit-testable without Telegram. Gates (group/user) stay in the
 * command registrations inside createBot, not in the handlers.
 */

// ---------------------------------------------------------------- /help ----

/** /help sections, in display order. Re-exported from menu.ts for tests. */
export type { HelpGroup };

// The command catalog lives in ./command_help (grammY-free, shared with
// the agent tool layer); re-exported here so existing imports keep working.
import { COMMAND_HELP, visibleCommandHelp } from "./command_help";
import type { CommandHelpEntry } from "./command_help";
export { COMMAND_HELP, visibleCommandHelp };
export type { CommandHelpEntry };

/** Render the /help text, grouped by category with usage examples. Pure, for tests. */
export function formatCommandHelp(
  entries: readonly CommandHelpEntry[],
  lang: Lang = "en",
): string {
  const order: HelpGroup[] = ["general", "session", "automation", "owner"];
  const parts: string[] = [helpTitle(lang)];
  for (const group of order) {
    const inGroup = entries.filter((e) => e.group === group);
    if (inGroup.length === 0) continue;
    parts.push("", helpGroupTitle(group, lang));
    for (const c of inGroup) {
      parts.push(
        helpEntryLine(c.name, t(`help.cmd.${c.name}`, lang), c.example, lang),
      );
    }
  }
  return parts.join("\n");
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

/**
 * Try to run an owner-defined custom shortcut for a "/name" message.
 *
 * Returns true when a shortcut matched and was executed (the caller must
 * not hand the message to downstream handlers). Returns false when there
 * is no shortcut, the sender is not the owner, or deps are missing — the
 * message falls through to normal command handling untouched.
 *
 * kind="prompt": the stored action is fed to the engine as if the owner
 * typed it (full conversation context, normal delivery).
 * kind="tool": the named tool runs via the ToolService under the owner's
 * actor and its result is delivered as the reply.
 */
async function tryRunShortcut(
  ctx: Context,
  deps: BotDeps,
  text: string,
): Promise<boolean> {
  const storage = deps.storage;
  if (!storage || typeof storage.getShortcut !== "function") return false;
  if (!isOwnerSender(ctx, deps)) return false;
  // "/name" or "/name@bot" or "/name args..." -> "name"
  const first = text.slice(1).split(/\s/)[0] ?? "";
  const atIdx = first.indexOf("@");
  const raw = atIdx >= 0 ? first.slice(0, atIdx) : first;
  let name: string;
  try {
    name = normalizeShortcutName(raw);
  } catch {
    return false;
  }
  const shortcut = storage.getShortcut(name);
  if (!shortcut) return false;

  if (shortcut.kind === "prompt") {
    await runTurn(ctx, deps, { text: shortcut.action });
    return true;
  }
  // kind === "tool"
  const tools = deps.tools;
  if (!tools) return false;
  const actor = toolActorFor(tools, deps.auth, ctx);
  try {
    const result = await tools.runTool({
      tool: shortcut.action,
      input: shortcut.toolArgs ?? {},
      actor,
    });
    const out =
      result.status === "ok"
        ? typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data)
        : `Shortcut failed: ${result.message ?? "unknown error"}`;
    await ctx.reply(out.slice(0, 4000));
  } catch (err) {
    await ctx.reply(
      `Shortcut failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 4000),
    );
  }
  return true;
}

/**
 * Build the onboarding wizard's environment for one update, or undefined when
 * the wizard cannot run (no per-user pref store — the wizard's state would
 * not survive a restart).
 *
 * Ownership is resolved server-side here via isOwnerSender; the wizard module
 * re-checks it on every entry point, so a non-owner can never reach the
 * provider-key steps even with a forged callback.
 */
function onboardingEnv(ctx: Context, deps: BotDeps): OnboardingEnv | undefined {
  if (deps.prefs === undefined) return undefined;
  const aiAdmin = deps.aiAdmin;
  return {
    prefs: deps.prefs,
    isOwner: isOwnerSender(ctx, deps),
    ai:
      aiAdmin === undefined
        ? undefined
        : {
            hasConfiguredProvider: () => aiAdmin.hasConfiguredProvider(),
            activeProviderLabel: () => aiAdmin.activeProviderLabel(),
            wizardSetupPreset: (from, presetId, apiKey, baseUrl) =>
              aiAdmin.wizardSetupPreset(from, presetId, apiKey, baseUrl),
            wizardProbeProvider: (from, providerId) =>
              aiAdmin.wizardProbeProvider(from, providerId),
          },
    runDemo: (c, text) => runWizardDemo(c, deps, text),
    isGroupChat: ctx.chat?.type === "group" || ctx.chat?.type === "supergroup",
  };
}

/** /help: list the commands the sender may use. Never throws. */
export async function handleHelpCommand(
  ctx: { reply(text: string): Promise<unknown> },
  isOwner: boolean,
  lang: Lang = "en",
): Promise<void> {
  await safeReply(ctx, formatCommandHelp(visibleCommandHelp(isOwner), lang));
}

// --------------------------------------------------------------- /reset ----

/** The user_prefs key for the per-user personality skin. Exported for index.ts wiring. */
export const PERSONALITY_PREF_KEY = "personality";

/** The environment /reset needs: the engine's cancel + history clearing. */
export type ResetEnv = {
  engine: Pick<ConversationEngine, "cancel" | "clearHistory">;
  storage?: Pick<Storage, "countMessages">;
};

/**
 * /reset: clear THIS conversation's history — messages plus the rolling
 * summary — for the current chat only. DESTRUCTIVE, so it is two-step: a
 * bare /reset only shows the warning and the exact confirmation command;
 * `/reset --confirm` executes. The flag is matched as an exact token —
 * "--confirmx" does not count, so a crafted argument cannot smuggle consent.
 *
 * The storage layer deletes by (userId, chatId), so another chat's history
 * is untouched. An in-flight turn is cancelled first, so a run that finishes
 * after the clear cannot commit its answer into the fresh history.
 * Gated by the caller (same group/user gates as the message path).
 */
export async function handleResetCommand(
  ctx: {
    chat?: { id: number | string } | undefined;
    from?: { id: number | string } | undefined;
    message?: { text?: string } | undefined;
    reply(text: string): Promise<unknown>;
  },
  env: ResetEnv,
  lang: Lang = "en",
): Promise<void> {
  if (ctx.chat === undefined || ctx.from === undefined) return;
  const userId = String(ctx.from.id);
  const conversationId = String(ctx.chat.id);
  const raw = ctx.message?.text;
  const confirmed =
    raw !== undefined &&
    raw
      .trim()
      .split(/\s+/)
      .some((p) => p.toLowerCase() === "--confirm");
  if (!confirmed) {
    // Preview what will be destroyed, like /new does.
    let n = 0;
    try {
      n = env.storage?.countMessages(userId, conversationId) ?? 0;
    } catch {
      // A failed read still asks for confirmation; it just can't preview.
    }
    await safeReply(ctx, t("reset.confirm", lang, { n }));
    return;
  }
  env.engine.cancel(conversationId);
  stopTurn(conversationId);
  env.engine.clearHistory({ conversationId, userId });
  await safeReply(ctx, t("reset.done", lang));
}

// --------------------------------------------------------- /personality ----

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

/** The environment /personality needs: the per-user preference store. */
export type PersonalityCommandEnv = Pick<BotDeps, "prefs">;

/**
 * /personality: show the sender's current tone skin and the available ones;
 * /personality <name> sets it (per-user, stored in user_prefs).
 *
 * SECURITY: the name is validated against the built-in skins via
 * resolvePersonalityName — only a canonical skin name is ever stored, and the
 * engine re-validates before anything reaches the prompt. Raw user text never
 * becomes prompt text.
 *
 * Gated by the caller (same group/user gates as the message path).
 */
export async function handlePersonalityCommand(
  ctx: {
    from?: { id: number | string } | undefined;
    message?: { text?: string } | undefined;
    reply(text: string, extra?: Record<string, unknown>): Promise<unknown>;
  },
  env: PersonalityCommandEnv,
  lang: Lang = "en",
): Promise<void> {
  if (ctx.from === undefined) return;
  if (env.prefs === undefined) {
    await safeReply(ctx, t("personality.unavailable", lang));
    return;
  }
  const userId = String(ctx.from.id);
  const rawArg =
    ctx.message?.text !== undefined ? commandArg(ctx.message.text) : undefined;

  if (rawArg === undefined) {
    // Show current skin plus the full list, with the current one marked,
    // and tap-to-pick buttons.
    let current: string | undefined;
    try {
      current = resolvePersonalityName(env.prefs.getUserPref(userId, PERSONALITY_PREF_KEY));
    } catch {
      // A failed read falls back to the default skin.
      current = undefined;
    }
    const currentName = current ?? "default";
    const skins = personalityNames().map((n) => getPersonality(n)!);
    const lines = skins.map((skin) => {
      const mark = skin.name === currentName ? t("personality.current_mark", lang) : "";
      return t("personality.list_item", lang, {
        name: skin.name,
        label: skin.labelEn,
        description: skin.descriptionEn,
        mark,
      });
    });
    const keyboard = buildPersonalityKeyboard(
      skins.map((s) => ({
        name: s.name,
        label: s.labelEn,
      })),
      currentName,
      lang,
    );
    const text = [t("personality.current_title", lang), ...lines, "", t("personality.usage", lang)].join("\n");
    try {
      await ctx.reply(text, { reply_markup: keyboard });
    } catch {
      // Best effort: fall back to the text-only reply.
      await safeReply(ctx, text);
    }
    return;
  }

  const name = resolvePersonalityName(rawArg);
  if (name === undefined) {
    await safeReply(
      ctx,
      t("personality.unknown", lang, {
        name: rawArg.trim(),
        options: personalityNames().join(", "),
      }),
    );
    return;
  }
  try {
    env.prefs.setUserPref(userId, PERSONALITY_PREF_KEY, name);
  } catch {
    await safeReply(ctx, t("prefs.save_failed", lang));
    return;
  }
  const skin = getPersonality(name);
  const label = skin?.labelEn ?? name;
  await safeReply(ctx, t("personality.changed", lang, { label }));
}

// ------------------------------------------------------------ /compress ----

/** The environment /compress needs: the engine's immediate-compression seam. */
export type CompressEnv = { engine: Pick<ConversationEngine, "compressNow"> };

/** Reply key per compressNow outcome. Exported for tests via COMPRESS_REPLIES. */
const COMPRESS_KEYS: Readonly<Record<CompressResult, string>> = {
  compressed: "compress.compressed",
  nothing_to_compress: "compress.nothing",
  failed: "compress.failed",
  unavailable: "compress.unavailable",
};

/** English reply per compressNow outcome. Exported for tests. */
export const COMPRESS_REPLIES: Readonly<Record<CompressResult, string>> = {
  compressed: t("compress.compressed"),
  nothing_to_compress: t("compress.nothing"),
  failed: t("compress.failed"),
  unavailable: t("compress.unavailable"),
};

/**
 * /compress: trigger immediate summary compression of the current
 * conversation, reusing the engine's existing summariser and watermark.
 *
 * Replies with a confirmation only — never the summary text itself, which the
 * user did not ask to see. Gated by the caller (same gates as the message
 * path).
 */
export async function handleCompressCommand(
  ctx: {
    chat?: { id: number | string } | undefined;
    from?: { id: number | string } | undefined;
    reply(text: string): Promise<unknown>;
  },
  env: CompressEnv,
  lang: Lang = "en",
): Promise<void> {
  if (ctx.chat === undefined || ctx.from === undefined) return;
  let result: CompressResult;
  try {
    result = await env.engine.compressNow({
      conversationId: String(ctx.chat.id),
      userId: String(ctx.from.id),
    });
  } catch {
    // A seam failure is reported, not thrown at the user.
    result = "failed";
  }
  await safeReply(ctx, t(COMPRESS_KEYS[result], lang));
}

// ---------------------------------------------------------------- /stop ----

/**
 * Phase G1: per-conversation registry of in-flight turns, so /stop can abort
 * exactly the turn running in the chat that sent it.
 *
 * runTurn enters a controller when the turn's work begins and removes it when
 * the turn completes (success, failure, or supersession), so a finished turn
 * never looks in-flight. /stop aborts the controller and cancels the engine's
 * run for that conversation; the agent loop already honors the abort signal,
 * and the abandoned run stays silent (it surfaces as "superseded").
 */
const stopControllers = new Map<string, AbortController>();

/** Register an in-flight turn for a conversation. Exported for tests. */
export function enterTurn(conversationId: string): AbortController {
  const controller = new AbortController();
  stopControllers.set(conversationId, controller);
  return controller;
}

/** Remove a finished turn from the registry. Exported for tests. */
export function exitTurn(conversationId: string): void {
  stopControllers.delete(conversationId);
}

/**
 * Abort the in-flight turn for a conversation, if any.
 * Returns true when something was aborted. Exported for tests.
 */
export function stopTurn(conversationId: string): boolean {
  const controller = stopControllers.get(conversationId);
  if (controller === undefined) return false;
  stopControllers.delete(conversationId);
  controller.abort();
  return true;
}

/** The environment /stop needs: the engine's cancellation. */
export type StopEnv = { engine: Pick<ConversationEngine, "cancel"> };

/**
 * /stop: abort the in-flight turn for this chat.
 *
 * The engine's cancel aborts the run the agent loop is executing; the
 * abandoned run surfaces as EngineError("superseded"), whose user-facing
 * message is empty — so /stop's own confirmation is the only reply the user
 * sees. Gated by the caller (same gates as the message path).
 */
export async function handleStopCommand(
  ctx: {
    chat?: { id: number | string } | undefined;
    reply(text: string): Promise<unknown>;
  },
  env: StopEnv,
  lang: Lang = "en",
): Promise<void> {
  if (ctx.chat === undefined) return;
  const conversationId = String(ctx.chat.id);
  if (!stopTurn(conversationId)) {
    await safeReply(ctx, t("stop.nothing", lang));
    return;
  }
  env.engine.cancel(conversationId);
  await safeReply(ctx, t("stop.done", lang));
}

/**
 * Run one user turn: gates, engine, delivery, accounting.
 *
 * Both the text and the media paths go through here, so there is exactly one
 * place that decides whether a message may reach the engine and one place that
 * records what it cost. Duplicating that per message type is how a gate ends up
 * missing from one of them.
 *
 * Attachments are downloaded HERE rather than by the caller, so a failed
 * download is reported to the user alongside the answer instead of being
 * swallowed.
 */
async function runTurn(
  ctx: Context,
  deps: BotDeps,
  input: { text: string; groupAssistantApproved?: boolean },
): Promise<void> {
  const { engine } = deps;

  // Private-chat gate: an unapproved user never reaches the engine, so an
  // unknown account cannot spend the owner's API budget.
  if (!(await gateUser(ctx, deps))) {
    // Muted users are dropped silently by design (gateUser); banned users got
    // a refusal. Log the group case so the drop is always traceable.
    if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
      console.error(
        `[bobi] group drop: user gate denied chat=${ctx.chat.id} user=${ctx.from ? ctx.from.id : "?"}`,
      );
    }
    return;
  }

  // Per-user message budget. The agent makes this necessary: one message can
  // become several provider calls, so a burst of messages is no longer a burst
  // of one call each.
  // NOTE: takeMessageBudget already replies with a "wait" notice and logs, so
  // an exhausted budget is never a silent drop — no extra logging here.
  if (!(await takeMessageBudget(ctx, deps))) return;

  if (!ctx.message || !ctx.from || !ctx.chat) {
    console.error(
      `[bobi] group drop: missing message/from/chat chat=${ctx.chat?.type ?? "?"} text="${ctx.message?.text?.slice(0, 30) ?? ""}"`,
    );
    return;
  }
  // Legacy privacy-mode filter: in groups, only replies-to-the-bot and
  // commands pass. Skipped when the group assistant already approved this
  // message (wake-word / reply-to-bot) — re-filtering would silently discard
  // the exact message the assistant just green-lit.
  if (!input.groupAssistantApproved && !shouldHandleMessage(ctx, ctx.me.id)) {
    console.error(
      `[bobi] group drop: legacy privacy filter (shouldHandleMessage) chat=${ctx.chat.type} text="${ctx.message.text?.slice(0, 30) ?? ""}"`,
    );
    return;
  }

  const userId = String(ctx.from.id);

  // Hermes-parity /resume: the session module stores the chosen active thread
  // as the `active_conversation:<chatId>` pref. Honor it only when it names a
  // conversation that actually belongs to this user — the value is
  // user-controlled storage, so format-check it and verify ownership before
  // letting it steer the thread. Any hiccup falls back to the default thread.
  let conversationId = String(ctx.chat.id);
  try {
    const active = deps.prefs?.getUserPref(userId, `active_conversation:${ctx.chat.id}`);
    if (
      active !== undefined &&
      active !== "" &&
      active !== conversationId &&
      /^[A-Za-z0-9:_-]{1,128}$/.test(active) &&
      deps.storage?.listUserConversations(userId).some((c) => c.conversationId === active) === true
    ) {
      conversationId = active;
    }
  } catch {
    // Pref/storage hiccup → default thread; never break the turn.
  }

  // Phase G1: register this turn so /stop can abort it. Removed in the
  // finally below, so a finished turn never looks in-flight.
  enterTurn(conversationId);
  try {
    return await runTurnInner(ctx, deps, input, conversationId, userId);
  } finally {
    exitTurn(conversationId);
  }
}

/**
 * Run one wizard starter prompt as a real agent turn, from a button tap.
 *
 * Exported for the onboarding wizard (`src/bot/onboarding.ts`). Same gates as
 * the message path — group gate, user gate, per-user message budget. The
 * bot-mention check is skipped on purpose: a button tap is explicit intent,
 * not ambient chat. Callback queries carry no `ctx.message`, so the tapped
 * message stands in for it (shadowed, not mutated) to satisfy runTurnInner's
 * guards; every reply still goes through the real context.
 */
export async function runWizardDemo(ctx: Context, deps: BotDeps, text: string): Promise<void> {
  const lang = senderLang(ctx, deps.prefs);
  if (!(await gateGroup(ctx, deps.groups, lang))) return;
  if (!(await gateUser(ctx, deps))) return;
  if (!(await takeMessageBudget(ctx, deps))) return;
  if (!ctx.from || !ctx.chat) return;
  const message = ctx.message ?? ctx.callbackQuery?.message;
  if (
    message === undefined ||
    message === null ||
    typeof message !== "object" ||
    !("message_id" in message)
  ) {
    return;
  }
  const userId = String(ctx.from.id);
  const conversationId = String(ctx.chat.id);
  const msgCtx = Object.create(ctx, {
    message: { value: message, enumerable: true, configurable: true },
  }) as Context;
  enterTurn(conversationId);
  try {
    await runTurnInner(msgCtx, deps, { text }, conversationId, userId);
  } finally {
    exitTurn(conversationId);
  }
}

/**
 * The body of one user turn, split out so runTurn can own the /stop
 * registration lifecycle around it.
 */
async function runTurnInner(
  ctx: Context,
  deps: BotDeps,
  input: { text: string },
  conversationId: string,
  userId: string,
): Promise<void> {
  const { engine } = deps;

  // The caller's guards (message/from/chat presence) do not narrow across the
  // function boundary, so runTurnInner re-checks what it touches.
  if (!ctx.message) return;

  // Tools run as this actor, resolved from the trusted numeric id. Without a
  // tool service the turn still answers — it simply has no tools.
  const actor = deps.tools ? toolActorFor(deps.tools, deps.auth, ctx) : undefined;

  // Show that work has started; a tool-using run can take tens of seconds.
  // Progress lines speak the sender's language.
  const lang = senderLang(ctx, deps.prefs);
  const progress = createProgress(ctx, lang);
  await progress.start();

  try {
    // Attachments are fetched before the gate on emptiness, so a caption-less
    // photo is still a valid turn.
    const media = hasMedia(ctx.message)
      ? await extractMedia(ctx, deps.botToken ?? "")
      : { parts: [], skipped: [], text: input.text };

    const text = input.text.trim() || media.text.trim();
    // Phase B2: a voice message becomes its transcript when the active
    // provider cannot hear audio natively and transcription is configured.
    // Anything else (native audio, transcription disabled, failure) keeps the
    // audio parts and their existing behaviour — this never throws.
    const parts = shouldTranscribeAudio(deps)
      ? await transcribeAudioParts(media.parts, (audio, mediaType) =>
          transcribeAudio(
            deps.transcribe!,
            audio,
            mediaType,
            AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
          ),
        )
      : media.parts;

    // Phase B5: a .docx/.xlsx/.pdf the active provider cannot read natively is
    // extracted locally into text the model can read. Providers with native
    // document support (Gemini, Anthropic) receive the parts untouched, and an
    // extraction failure keeps the original part so the adapter's named note
    // covers it. Extracted text is DATA, never instructions. Never throws.
    const finalParts = await maybeExtractDocuments(
      parts,
      deps.engine.activeSupportsDocumentInput(),
    );

    // A message with nothing usable at all is answered rather than silently
    // dropped: the user sent something and deserves to know it did not arrive.
    if (text.length === 0 && finalParts.length === 0) {
      await progress.finish();
      await safeReply(ctx, describeNothingUsable(media.skipped, lang));
      return;
    }

    // Streaming: when every precondition holds, the answer renders into the
    // progress message as the tokens arrive (throttled to ~1 edit/sec);
    // otherwise the streamer is inactive and the classic path below runs
    // untouched.
    const inputWasVoice = ctx.message?.voice !== undefined || ctx.message?.audio !== undefined;
    const streamer = createTurnStreamer(ctx, deps, progress, {
      lang,
      userId,
      inputWasVoice,
      chatType: ctx.chat?.type ?? "private",
      skippedCount: media.skipped.length,
    });

    const respond = () =>
      engine.respond({
        conversationId,
        userId,
        userText: text,
        // English-only agent output (v1.0): the turn's language is always
        // English, so the agent's replies are English.
        lang,
        // Owner recognition: verified server-side from the Telegram ID, so
        // the agent knows it is talking to its creator Mohammad.
        ...(isOwnerSender(ctx, deps) ? { isOwner: true as const } : {}),
        // Group role clarity: prevent model mimicry in multi-user context.
        ...(ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
          ? { isGroup: true as const }
          : {}),
        ...(actor !== undefined ? { actor } : {}),
        ...(finalParts.length > 0 ? { parts: finalParts } : {}),
        onProgress: (step) => {
          const line = progressText(step, lang);
          if (line !== undefined) void progress.update(line);
        },
      });
    let out: Awaited<ReturnType<typeof respond>>;
    try {
      out =
        streamer.sink !== undefined
          ? await runWithStreamSink(streamer.sink, respond)
          : await respond();
    } finally {
      streamer.stop();
    }

    // A streamed answer is delivered in place: the progress message became
    // the reply, so there is nothing left to do. Otherwise remove the status
    // line and deliver classically. (Turns that need the skipped-attachment
    // or voice-unavailable notes keep the streamer inactive, so those notes
    // still land exactly where the classic path puts them.)
    if (!(await streamer.deliver(out.chunks))) {
      // Remove the status line before the answer, so the chat shows only the
      // reply once it exists.
      await progress.finish();

      // An attachment that could not be used is named before the answer, so the
      // model's reply is not read as a comment on something it never received.
      const note = describeSkipped(media.skipped, lang);
      if (note.length > 0) await ctx.reply(note);

      // Phase-2 item 5 (voice-first): the reply modality mirrors the input —
      // a voice note gets a voice answer automatically in private chats (the
      // sender can override with /voice). Text in → text out, unchanged.
      // Failures fall back to text inside.
      await deliverReply(ctx, deps, userId, out.chunks, synthesizeSpeech, {
        inputWasVoice,
        chatType: ctx.chat?.type ?? "private",
        // Visibly reply to the user's message so it's clear what the bot
        // is answering — in groups and in private chats alike.
        ...(ctx.message?.message_id !== undefined
          ? { replyToMessageId: ctx.message.message_id }
          : {}),
      });
    }
    // Media a tool produced for the user (a generated image, say) follows the
    // text. It never entered the prompt or history — this is its only trip.
    for (const part of out.media.slice(0, MAX_MEDIA_PER_REPLY)) {
      const m = describeMediaPart(part);
      if (m === undefined) continue;
      if (m.kind === "photo") await ctx.replyWithPhoto(m.file);
      else if (m.kind === "voice") await ctx.replyWithVoice(m.file);
      else await ctx.replyWithDocument(m.file);
    }
    // A run that hit a budget got a best-effort answer; saying so is more
    // honest than presenting it as complete.
    if (out.truncated) {
      await ctx.reply(t("reply.truncated", lang));
    }
    // Recorded after delivery: the spend already happened, so a failed send
    // must not hide it.
    deps.usage?.record({
      userId,
      requests: 1,
      toolCalls: out.toolCalls,
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
    });
  } catch (err) {
    // Clear the status line first: leaving "thinking…" above an error message
    // would suggest the bot is still working.
    await progress.finish();
    await replyToFailure(ctx, err, lang);
    // Technical detail stays in logs, never the secret or payload.
    console.error("[bobi] conversation error:", errToLog(err));
  }
}

/** A short note about attachments that could not be used. Exported for tests. */
export function describeSkipped(
  skipped: readonly { kind: string; reason: string }[],
  lang: Lang,
): string {
  if (skipped.length === 0) return "";
  const lines = skipped.map((s) =>
    s.reason === "too_large"
      ? t("media.skipped_too_large", lang, { kind: s.kind })
      : s.reason === "too_long"
        ? t("media.skipped_too_long", lang, { kind: s.kind })
        : s.reason === "unsupported"
          ? t("media.skipped_unsupported", lang, { kind: s.kind })
          : t("media.skipped_other", lang, { kind: s.kind }),
  );
  return [t("media.skipped_title", lang), ...lines].join("\n");
}

/** The reply when a message carried nothing that could be used. Exported for tests. */
export function describeNothingUsable(
  skipped: readonly { kind: string; reason: string }[],
  lang: Lang,
): string {
  const note = describeSkipped(skipped, lang);
  return note.length > 0 ? note : t("media.empty", lang);
}

export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token);
  const { engine, groups, panel, aiAdmin, userPanel } = deps;

  // ---- Stage-3: AI group-admin moderation (opt-in per group, owner-managed) ----
  // Hermes has no equivalent. Default-off: with no moderationOwnerId or no
  // storage the moderator allows everything, so this is inert until wired.
  const moderator = createModerator({
    ...(deps.storage !== undefined ? { storage: deps.storage } : {}),
    ownerId: deps.moderationOwnerId ?? "",
    isOwner: (userId: string) => {
      const n = Number(userId);
      // Owner identity is numeric-only, mirroring isOwnerSender's rule:
      // anything non-numeric (usernames, text) never matches.
      if (!Number.isSafeInteger(n)) return false;
      return deps.auth?.isOwner({ id: n }) ?? false;
    },
    ...(deps.moderationOwnerId !== undefined
      ? (() => {
          const ownerChatId: string = deps.moderationOwnerId;
          return {
            notifyOwner: async (text: string) => {
              // Owner notifications go to the owner's DM via the Bot API.
              await bot.api.sendMessage(ownerChatId, text).catch(() => undefined);
            },
          };
        })()
      : {}),
  });

  // ---- /start — always respond, private & group ----
  // Deliberately NOT gated: a greeting in any chat is harmless and carries no
  // reasoning, tool access, or stored content. Every entry that does — the
  // tools menu button and the conversation engine — is gated separately.
  //
  // The onboarding wizard may take over this /start for the OWNER: fresh
  // owners (no provider configured) get the 4-step wizard; returning owners
  // keep this phase-1 screen. Non-owners never see the wizard.
  bot.command("start", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    const onb = onboardingEnv(ctx, deps);
    if (onb !== undefined) {
      const arg =
        ctx.message?.text !== undefined ? commandArg(ctx.message.text) : undefined;
      if ((await maybeStartOnboarding(ctx, onb, lang, arg)).handled) return;
    }
    await ctx.reply(startScreenText(lang), {
      // Two-tier menus: the owner keeps the full 6-button menu; the public
      // gets a smaller menu with no owner-only buttons rendered at all.
      reply_markup: isOwnerSender(ctx, deps)
        ? buildMainMenu(lang)
        : buildPublicMainMenu(lang),
    });
  });

  // ---- /admin — owner-only panel entry ----
  bot.command("admin", async (ctx) => {
    if (panel) await panel.openPanel(ctx);
  });

  // ---- /ai — owner-only AI management entry ----
  bot.command("ai", async (ctx) => {
    if (aiAdmin) await aiAdmin.open(ctx);
  });

  // ---- /voice — show or set the sender's voice-mode preference ----
  // Public under the two-tier model (voice is conversation): the group/user
  // gates run, the tier gate does not. The picker write itself lives in
  // handleVoiceCommand/handleVoiceCallback so it is unit-testable without
  // Telegram.
  bot.command("voice", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    const arg =
      ctx.message?.text !== undefined ? commandArg(ctx.message.text) : undefined;
    await handleVoiceCommand(ctx, deps, lang, arg);
  });

  // ---- /help — open the command palette ----
  // The palette is the primary command browser now: it renders from the same
  // COMMAND_HELP source as the old text wall (same grouping, same
  // owner-filtering), categorized and paginated instead of one long message.
  // Deliberately ungated like /start: the listing is harmless (owner-only
  // entries are hidden from non-owners by visibleCommandHelp).
  bot.command("help", async (ctx) => {
    await openPaletteMessage(
      ctx,
      isOwnerSender(ctx, deps),
      senderLang(ctx, deps.prefs),
    );
  });

  // ---- /commands — the categorized, paginated command browser ----
  // Same entry point as /help, for users who reach for the explicit name.
  registerPaletteCommands(
    bot,
    { deps, sysOpts: deps.systemOpts ?? {} },
  );

  // ---- /digest — the interactive daily digest (Phase-2 item 3) ----
  // Owner-only: the digest aggregates the owner's private data (tasks,
  // reminders, memories, usage). The tier gate runs in the command handler
  // and again on every dgst: callback tap (see the router below).
  registerDigestCommands(
    bot,
    { deps, sysOpts: deps.systemOpts ?? {} },
  );

  // ---- /reset — clear THIS conversation's history ----
  // Owner-only (two-tier model). The destructive scope is the current chat
  // only (storage deletes by user+chat pair); the handler cancels any
  // in-flight turn first.
  bot.command("reset", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    if (!(await requireOwnerTier(ctx, deps, lang))) return;
    await handleResetCommand(ctx, deps, lang);
  });

  // ---- /personality — show/set the sender's tone skin ----
  // Owner-only (two-tier model); the preference is per-user.
  bot.command("personality", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    if (!(await requireOwnerTier(ctx, deps, lang))) return;
    await handlePersonalityCommand(ctx, deps, lang);
  });


  // ---- /compress — immediate summary compression of this conversation ----
  // Owner-only (two-tier model). The reply is a confirmation only, never
  // the summary text itself.
  bot.command("compress", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    if (!(await requireOwnerTier(ctx, deps, lang))) return;
    await handleCompressCommand(ctx, deps, lang);
  });

  // ---- /stop — abort the in-flight turn for this chat ----
  // Owner-only (two-tier model); aborts only the turn registered for this
  // conversation (see enterTurn/stopTurn above).
  bot.command("stop", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    if (!(await requireOwnerTier(ctx, deps, lang))) return;
    await handleStopCommand(ctx, deps, lang);
  });

  // ---- bot added to / removed from a group ----
  bot.on("my_chat_member", async (ctx) => {
    const update = ctx.myChatMember;
    if (!update) return;
    const chat = update.chat;
    // Only groups and supergroups participate in the approval workflow.
    if (chat.type !== "group" && chat.type !== "supergroup") return;

    const botId = ctx.me?.id;
    const newStatus = update.new_chat_member?.status;
    const wasMember =
      newStatus === "member" || newStatus === "administrator" || newStatus === "creator";
    const status = wasMember ? "added" : "removed";
    if (botId === undefined) return;

    if (status === "added" && panel) {
      // `from` is the person who performed the action; it is not assumed to be
      // the group's owner, and it is only recorded when genuinely present.
      const requester = update.from;
      const created = deps.groups?.registerGroup({
        chatId: String(chat.id),
        chatType: chat.type === "supergroup" ? "supergroup" : "group",
        // Omit rather than pass undefined (exactOptionalPropertyTypes).
        ...(chat.title !== undefined ? { title: chat.title } : {}),
        ...(requester ? { requestedBy: String(requester.id) } : {}),
      });
      // Only the first insert for a chat leads to a notification, so repeated
      // membership updates cannot storm the owner.
      if (created?.created) {
        const sent = await panel.notifyOwnerRequest({
          chatId: String(chat.id),
          title: chat.title,
          chatType: chat.type === "supergroup" ? "supergroup" : "group",
        });
        if (!sent) {
          // The group stays pending; a delivery failure is never an approval.
          console.error("[sol] owner notification failed for pending group");
        }
      }
    }
  });

  // ---- menu buttons ----
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    // The owner panel is checked BEFORE the group gate on purpose: an owner
    // administering from any chat — including a group that is pending, revoked
    // or not yet known — must be able to fix it. Authority here comes from
    // AdminBoundary re-checking the owner per click, never from group approval,
    // so this is not a bypass of the permission model.
    if (panel) {
      const handled = await panel.handleCallback(ctx, data);
      if (handled) return;
    }
    // The AI section is its own namespace; every click re-authorizes too.
    if (aiAdmin) {
      const handled = await aiAdmin.handleCallback(ctx, data);
      if (handled) return;
    }
    // The user-access section; every click re-authorizes via users.manage.
    if (userPanel) {
      const handled = await userPanel.handleCallback(ctx, data);
      if (handled) return;
    }
    // The /voice picker (voice:) — its own namespace, like the lang: picker.
    // Public under the two-tier model (voice is conversation): clicks re-run
    // the same group/user gates as the /voice command, junk picker data is
    // rejected by handleVoiceCallback rather than falling through to the
    // menu, and no tier gate runs here either.
    if (isVoiceCallback(data)) {
      const lang = senderLang(ctx, deps.prefs);
      if (!(await gateGroup(ctx, groups, lang))) return;
      if (!(await gateUser(ctx, deps))) return;
      await handleVoiceCallback(ctx, deps, data, lang);
      return;
    }
    // The personality picker (tap-to-pick skins from /personality). Its own
    // namespace; the payload is re-validated against the built-in skins and
    // the gates re-run, so a forged callback can't set anything invalid.
    // /personality is owner-only under the two-tier model, so the tier gate
    // runs here too — a non-owner tap is refused, never applied.
    if (data.startsWith(PERSONALITY_CALLBACK_PREFIX)) {
      const lang = senderLang(ctx, deps.prefs);
      if (!(await gateGroup(ctx, groups, lang))) return;
      if (!(await gateUser(ctx, deps))) return;
      if (!(await requireOwnerTier(ctx, deps, lang))) return;
      const name = parsePersonalityCallback(data);
      await ctx.answerCallbackQuery().catch(() => undefined);
      if (name === undefined || deps.prefs === undefined) return;
      const userId = ctx.from !== undefined ? String(ctx.from.id) : "";
      if (userId === "") return;
      try {
        deps.prefs.setUserPref(userId, PERSONALITY_PREF_KEY, name);
      } catch {
        await safeReply(ctx, t("prefs.save_failed", lang));
        return;
      }
      const skin = getPersonality(name);
      const label = skin?.labelEn ?? name;
      await safeReply(ctx, t("personality.changed", lang, { label }));
      return;
    }
    // The command palette (pal:) — its own namespace, like the lang: picker.
    // Clicks re-run the same group/user gates as the menu buttons; the
    // payload is strictly validated by parsePaletteCallback and owner-only
    // entries re-check ownership server-side per tap, so a forged callback
    // can neither run nor reveal anything hidden.
    if (data.startsWith(PALETTE_CALLBACK_PREFIX)) {
      const lang = senderLang(ctx, deps.prefs);
      if (!(await gateGroup(ctx, groups, lang))) return;
      if (!(await gateUser(ctx, deps))) return;
      await ctx.answerCallbackQuery().catch(() => undefined);
      await handlePaletteCallback(
        ctx,
        { deps, sysOpts: deps.systemOpts ?? {} },
        data,
        lang,
      );
      return;
    }
    // The interactive digest (dgst:) — its own namespace, like the palette.
    // Clicks re-run the same group/user gates as the menu buttons, then the
    // owner tier gate: the digest aggregates the owner's private data, so a
    // non-owner tap is refused, never executed. The payload is strictly
    // validated by parseDigestCallback and ownership is re-checked
    // server-side on every tap inside handleDigestCallback, so a forged
    // callback can neither mutate state nor reveal anything.
    if (data.startsWith(DIGEST_CALLBACK_PREFIX)) {
      const lang = senderLang(ctx, deps.prefs);
      if (!(await gateGroup(ctx, groups, lang))) return;
      if (!(await gateUser(ctx, deps))) return;
      if (!(await requireOwnerTier(ctx, deps, lang))) return;
      await handleDigestCallback(
        ctx,
        { deps, sysOpts: deps.systemOpts ?? {} },
        data,
        lang,
      );
      return;
    }
    // The onboarding wizard (onb:) — its own namespace, like the palette.
    // Owner-only by design (provider keys are involved): ownership is
    // re-checked server-side inside the handler, so a forged callback from a
    // non-owner is silently ignored and can never reach the key steps.
    if (data.startsWith(ONBOARDING_CALLBACK_PREFIX)) {
      const lang = senderLang(ctx, deps.prefs);
      if (!(await gateGroup(ctx, groups, lang))) return;
      if (!(await gateUser(ctx, deps))) return;
      await ctx.answerCallbackQuery().catch(() => undefined);
      const onb = onboardingEnv(ctx, deps);
      if (onb !== undefined) await handleOnboardingCallback(ctx, onb, data, lang);
      return;
    }
    // Ordinary menu buttons DO depend on group approval, so the gate applies.
    // Two-tier invisibility: the tools and settings buttons are never
    // rendered for the public (see buildPublicMainMenu), so a non-owner tap
    // on either is a forged callback — refused politely, never rendered.
    for (const cb of Object.values(CALLBACKS)) {
      if (data !== cb) continue;
      const lang = senderLang(ctx, deps.prefs);
      if (!(await gateGroup(ctx, groups, lang))) return;
      if (!(await gateUser(ctx, deps))) return;
      const owner = isOwnerSender(ctx, deps);
      if (!owner && (cb === CALLBACKS.tools || cb === CALLBACKS.settings)) {
        await ctx.answerCallbackQuery();
        await safeReply(ctx, t("tier.refused", lang));
        return;
      }
      await ctx.answerCallbackQuery();
      // The commands and help buttons open the palette — the categorized,
      // paginated command browser. It renders from the same COMMAND_HELP
      // source as /help (same owner filtering), so nothing leaks and the
      // two can never drift apart. Every palette screen carries its own
      // back button, so there are no dead ends.
      if (cb === CALLBACKS.commands || cb === CALLBACKS.help) {
        const render = paletteCategoriesRender(isOwnerSender(ctx, deps), lang);
        await editMenuMessage(ctx, render.text, render.keyboard);
        return;
      }
      const text = replyForCallback(
        cb,
        cb === CALLBACKS.tools ? deps.tools?.listActiveNames() : undefined,
        lang,
      );
      await editMenuMessage(ctx, text, menuKeyboardFor(cb, lang, owner));
      return;
    }

    // Not handled by this router: hand off to downstream namespace handlers
    // (sess:, mdl:, pers: — registered after this middleware). A downstream
    // handler answers the query itself; if none matches, answer here so
    // Telegram stops the loading indicator.
    await next();
    await ctx.answerCallbackQuery().catch(() => undefined);
  });

  // ---- text messages → conversation engine ----
  bot.on("message:text", async (ctx, next) => {
    // Group gate runs first: an unapproved group never reaches reasoning.
    if (!(await gateGroup(ctx, groups, senderLang(ctx, deps.prefs)))) return;

    // ---- Stage-3 moderation gate (groups only, owner-configured) ----
    // Runs before any form handling or the conversation engine: a moderated
    // message never reaches reasoning. Owner messages bypass inside the
    // moderator; disabled groups fall through untouched.
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      const decision = await moderator.handleMessage({
        chatId: String(ctx.chat.id),
        userId: ctx.from ? String(ctx.from.id) : "",
        text: ctx.message.text,
        tsMs: Date.now(),
      });
      if (decision.action === "delete") {
        try {
          await ctx.deleteMessage();
        } catch {
          // Already gone, or the bot lacks delete rights — best effort.
        }
      }
      if (decision.action !== "allow" && decision.warnText) {
        try {
          await ctx.reply(decision.warnText, {
            reply_to_message_id: ctx.message.message_id,
          });
        } catch {
          // Best effort: the warning is advisory, not load-bearing.
        }
      }
      if (decision.handled) {
        // Moderated — never reaches the engine. The user usually sees a
        // deletion and/or a warning; log the drop so a moderation decision
        // can never be mistaken for a silent engine bug.
        console.error(
          `[bobi] group drop: moderated (action=${decision.action}, reason=${decision.reason ?? "n/a"}) chat=${ctx.chat.id} user=${ctx.from ? ctx.from.id : "?"} text="${ctx.message.text.slice(0, 30)}"`,
        );
        return;
      }
    }

    // ---- Phase-3 group assistant (opt-in per group, owner-managed) ----
    // Records group chatter for /gsummary and enforces reply-only-when-called
    // silence. Inert unless the owner enabled the mode for this group.
    // Commands ("/...") always fall through to their handlers below.
    //
    // When the assistant approves a reply (wake-word / reply-to-bot), that
    // decision is carried into runTurn via groupAssistantApproved so the
    // legacy shouldHandleMessage filter (replies-and-commands only) does not
    // silently discard the very message the assistant just approved.
    let groupAssistantApproved = false;
    if (
      (ctx.chat.type === "group" || ctx.chat.type === "supergroup") &&
      deps.groupAssistant !== undefined
    ) {
      const ga = deps.groupAssistant;
      const gaChatId = String(ctx.chat.id);
      recordGroupMessage(
        {
          ...(deps.storage !== undefined ? { storage: deps.storage } : {}),
          ownerId: ga.ownerId,
          history: ga.history,
        },
        {
          chatId: gaChatId,
          userId: ctx.from ? String(ctx.from.id) : "",
          name:
            ctx.from !== undefined
              ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")
              : "",
          text: ctx.message.text,
          tsMs: Date.now(),
        },
      );
      if (!ctx.message.text.startsWith("/")) {
        const gaCfg = getAssistantConfig(deps.storage, ga.ownerId, gaChatId);
        if (gaCfg.enabled) {
          const replyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
          const botUsername = ctx.me.username ?? "";
          const shouldReply = shouldReplyAssistant({
            text: ctx.message.text,
            botUsername,
            replyToBot,
            enabled: true,
            replyOnlyWhenCalled: gaCfg.replyOnlyWhenCalled,
          });
          if (!shouldReply) {
            // Assistant mode: silent unless called. By design — but never
            // unlogged, so a missing reply is always traceable to this
            // decision rather than mistaken for a dropped update.
            console.error(
              `[bobi] group drop: assistant mode silent (not mentioned/replied-to) chat=${gaChatId} text="${ctx.message.text.slice(0, 30)}"`,
            );
            return;
          }
          // The assistant approved this message — runTurn must not re-filter
          // it out via the legacy replies-and-commands-only rule.
          groupAssistantApproved = true;
        }
      }
    }

    const text = ctx.message.text;

    // The onboarding wizard's provider-key step consumes the owner's next
    // message as an API key (the same one-message shape as the /ai setup
    // flow). Owner-only and state-gated inside handleOnboardingText; anything
    // else falls through to the /ai forms and the engine below.
    // PRIVATE CHATS ONLY: never consume group messages as setup answers.
    {
      const onb = onboardingEnv(ctx, deps);
      if (onb !== undefined && !text.startsWith("/") && ctx.chat.type === "private") {
        if (await handleOnboardingText(ctx, onb, text, senderLang(ctx, deps.prefs))) return;
      }
    }

    // An owner mid-way through an AI form has their reply consumed here rather
    // than sent to the model. Consuming is gated on the owner's own pending
    // state, and the write itself re-authorizes inside the controller.
    //
    // This runs BEFORE the user gate on purpose: it is how the owner
    // administers, and the owner is exempt from the user gate anyway.
    //
    // PRIVATE CHATS ONLY: the AI setup forms must never consume group
    // messages. If the owner starts a provider setup in DM then says "بابی"
    // in a group, that group message must reach the assistant, not be
    // swallowed as a setup answer.
    if (aiAdmin && !text.startsWith("/") && ctx.chat.type === "private") {
      const consumed = await aiAdmin.handleText(ctx, text);
      if (consumed) return;
    }

    // Custom shortcuts (owner-defined command aliases like /صبح). Checked
    // before downstream handlers: shortcut names cannot collide with
    // built-ins (enforced at creation), so a hit here is unambiguous.
    // Owner-only: anyone else's /name falls through to next() untouched.
    if (text.startsWith("/")) {
      if (await tryRunShortcut(ctx, deps, text)) return;
      return await next();
    }
    await runTurn(ctx, deps, { text, groupAssistantApproved });
  });

  // ---- media messages → conversation engine ----
  //
  // A photo, voice note, or document is an ordinary turn whose content happens
  // to be an attachment. The gates below are the same ones the text path uses,
  // applied through `runTurn` so there is one place that decides whether a
  // message may reach the engine.
  for (const kind of ["message:photo", "message:voice", "message:audio", "message:document"] as const) {
    bot.on(kind, async (ctx) => {
      if (!(await gateGroup(ctx, groups, senderLang(ctx, deps.prefs)))) return;
      const caption = ctx.message.caption ?? "";
      // Group assistant for media: a caption containing the wake word
      // ("بابی اینو ببین") must trigger a reply like a text message would.
      // Without this, media bypassed shouldReplyAssistant and the legacy
      // filter silently dropped it.
      let groupAssistantApproved = false;
      if (
        (ctx.chat.type === "group" || ctx.chat.type === "supergroup") &&
        deps.groupAssistant !== undefined &&
        caption.length > 0
      ) {
        const ga = deps.groupAssistant;
        const gaChatId = String(ctx.chat.id);
        recordGroupMessage(
          {
            ...(deps.storage !== undefined ? { storage: deps.storage } : {}),
            ownerId: ga.ownerId,
            history: ga.history,
          },
          {
            chatId: gaChatId,
            userId: ctx.from ? String(ctx.from.id) : "",
            name:
              ctx.from !== undefined
                ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")
                : "",
            text: caption,
            tsMs: Date.now(),
          },
        );
        const gaCfg = getAssistantConfig(deps.storage, ga.ownerId, gaChatId);
        if (gaCfg.enabled) {
          const replyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
          const botUsername = ctx.me.username ?? "";
          const shouldReply = shouldReplyAssistant({
            text: caption,
            botUsername,
            replyToBot,
            enabled: true,
            replyOnlyWhenCalled: gaCfg.replyOnlyWhenCalled,
          });
          if (!shouldReply) {
            console.error(
              `[bobi] group drop: assistant mode silent for media caption (not mentioned/replied-to) chat=${gaChatId} caption="${caption.slice(0, 30)}"`,
            );
            return;
          }
          groupAssistantApproved = true;
        }
      }
      await runTurn(ctx, deps, { text: caption, groupAssistantApproved });
    });
  }

  // ---- edited messages ----
  // Explicit policy: an edit never produces a fresh reply. Answering an edited
  // message would read as a duplicate answer to the same turn, so the engine is
  // not invoked for edits at all. The group gate still runs first, so an edit
  // is not a way to reach the engine from an unapproved group.
  bot.on("edited_message:text", async (ctx) => {
    if (!(await gateGroup(ctx, groups, senderLang(ctx, deps.prefs)))) return;
    if (!(await gateUser(ctx, deps))) return;
    // Deliberately no engine call: edits are not re-answered.
  });

  bot.catch((err) => {
    console.error("[sol] bot error:", err.message);
  });

  return bot;
}

/** Short message per error kind, in the sender's language; technical detail stays in logs. Exported for tests. */
export function userFacingMessage(err: unknown, lang: Lang): string {
  // A newer message replaced this run: the user already moved on, so
  // replying about the abandoned one would be noise. Silence needs no key
  // (the parity test forbids empty translations).
  if (err instanceof EngineError && err.kind === "superseded") return "";
  if (err instanceof EngineError) {
    switch (err.kind) {
      case "empty_input": return t("media.empty", lang);
      case "empty_response": return t("error.empty_response", lang);
      case "auth": return t("error.auth", lang);
      case "quota": return t("error.quota", lang);
      case "network": return t("error.network", lang);
      case "timeout":
      case "aborted": return t("error.timeout", lang);
      case "overloaded": return t("error.overloaded", lang);
      case "invalid_response": return t("error.invalid_response", lang);
      case "unknown":
        // When the provider's HTTP status is known, name it: a bare
        // "temporary error" hides causes the owner can act on (e.g. 402).
        return err.status !== undefined
          ? t("error.unknown_status", lang, { status: err.status })
          : t("error.unknown", lang);
      default: return t("error.unknown", lang);
    }
  }
  if (isToolError(err)) return t(`error.tool.${err.kind}`, lang);
  return t("error.unexpected", lang);
}

/**
 * Reply to a failed turn, unless the failure was supersession.
 *
 * Returns false when nothing was sent, so the caller can skip logging a turn
 * that produced no visible outcome.
 */
async function replyToFailure(ctx: Context, err: unknown, lang: Lang): Promise<boolean> {
  const message = userFacingMessage(err, lang);
  if (message.length === 0) return false;
  try {
    await ctx.reply(message);
    return true;
  } catch {
    return false;
  }
}

function errToLog(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
