import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import {
  buildMainMenu,
  replyForCallback,
  buildLangKeyboard,
  isLangCallback,
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
  LANG_CALLBACKS,
  type HelpGroup,
} from "./menu";
import { shouldHandleMessage } from "./filter";
import { toolProgressLabel } from "./ux";
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
import { t, resolveLang, LANG_PREF_KEY, type Lang } from "../i18n";
import type { ConversationEngine } from "../conversation/engine";
import { EngineError } from "../conversation/engine";
import type { AgentStep } from "../agent/transcript";
import type { ToolService } from "../tools/service";
import type { ToolActor } from "../tools/types";
import type { AuthorizationService } from "../auth/service";
import { authorizeToolUse, toToolActor } from "../auth/tool_bridge";
import { userMessageFor, isToolError } from "../tools/errors";
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
 * Phase D5: resolve the sender's UI language from user_prefs ("lang").
 *
 * Falls back to Persian when prefs are absent, the sender is unknown, or the
 * stored value is anything but "en" — see resolveLang. Command handlers take
 * the resolved lang (defaulting to "fa") so they stay unit-testable.
 */
export function senderLang(
  ctx: { from?: { id: number | string } | undefined },
  prefs: UserPrefStore | undefined,
): Lang {
  if (ctx.from === undefined || prefs === undefined) return "fa";
  const userId = String(ctx.from.id);
  return resolveLang(userId, (uid, key) => prefs.getUserPref(uid, key));
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
  lang: Lang = "fa",
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
  // line. The denial speaks the sender's language (defaults to Persian).
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

/** The progress line for one step, in the sender's language. */
function progressText(step: AgentStep, lang: Lang): string | undefined {
  if (step.kind !== "tool") return undefined;
  const label = toolProgressLabel(lang, step.name);
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
  return `[متن پیام صوتی]: ${transcript}`;
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
export const VOICE_FAILED_NOTE = t("voice.tts_failed", "fa");
export const VOICE_TRUNCATED_NOTE = t("voice.truncated", "fa");

/** The context deliverReply needs: sending plus, optionally, chat actions. */
export interface DeliverCtx {
  reply(text: string): Promise<unknown>;
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
  let lang: Lang = "fa";
  try {
    // The sender's UI language, for the delivery notes below. Resolved from
    // the same validated pref store — never from message text.
    if (prefs !== undefined) {
      pref = resolveVoicePref(prefs.getUserPref(userId, VOICE_MODE_KEY));
      lang = resolveLang(userId, prefs.getUserPref.bind(prefs));
    }
  } catch {
    // A preference read failure is not a reason to break the reply: text.
    pref = "auto";
    lang = "fa";
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
    for (const chunk of chunks) await ctx.reply(chunk);
    return;
  }

  const { voice, text } = planVoiceDelivery(chunks);
  try {
    for (const piece of voice) {
      const { audio } = await withChatAction(ctx, "upload_voice", () =>
        synth(tts!, piece, AbortSignal.timeout(TTS_TIMEOUT_MS)),
      );
      await ctx.replyWithVoice(new InputFile(audio, "bobi.ogg"));
    }
  } catch (err) {
    // Technical detail stays in the log; the user gets the static note.
    console.error("[bobi] TTS failed, falling back to text:", errToLog(err));
    await ctx.reply(t("voice.tts_failed", lang));
    for (const chunk of chunks) await ctx.reply(chunk);
    return;
  }
  if (text.length > 0) {
    await ctx.reply(t("voice.truncated", lang));
    for (const chunk of text) await ctx.reply(chunk);
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
 * - `/voice` — the current mode plus tap-to-pick buttons (the /lang pattern).
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
  lang: Lang = "fa",
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
  lang: Lang = "fa",
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
 * All user-facing replies go through t() (Persian default, English when the
 * sender's user_prefs "lang" is "en"); all comments are English. Handlers are
 * exported with minimal context shapes (the handleVoiceCommand pattern) so
 * they are unit-testable without Telegram. Gates (group/user) stay in the
 * command registrations inside createBot, not in the handlers.
 */

// ---------------------------------------------------------------- /help ----

/** /help sections, in display order. Re-exported from menu.ts for tests. */
export type { HelpGroup };

/** One row of the /help listing. */
export interface CommandHelpEntry {
  name: string;
  descriptionFa: string;
  /** Owner-only entries are hidden from everyone else. */
  ownerOnly: boolean;
  /** /help section this command is listed under. */
  group: HelpGroup;
  /** Example argument, rendered after the command (Persian). */
  exampleFa?: string;
  /** Example argument, rendered after the command (English). */
  exampleEn?: string;
}

/**
 * Every command the bot registers, with a one-line Persian description,
 * its /help section, and an example argument where one is genuinely useful.
 *
 * descriptionFa must stay byte-identical to the central `help.cmd.<name>`
 * pack value (asserted in tests/i18n.test.ts).
 */
export const COMMAND_HELP: readonly CommandHelpEntry[] = [
  // ---- general ----
  // Two-tier access: the public surface is exactly start/help/commands/lang/voice.
  // Every other command is owner-only (ownerOnly: true) — invisible to the
  // public in menus, /help and the palette, and refused by the tier gate.
  { name: "start", descriptionFa: "شروع و نمایش منوی اصلی", ownerOnly: false, group: "general" },
  { name: "help", descriptionFa: "راهنمای دستورها", ownerOnly: false, group: "general" },
  { name: "commands", descriptionFa: "مرورگر دستورها", ownerOnly: false, group: "general" },
  { name: "voice", descriptionFa: "انتخاب حالت پاسخ صوتی (خودکار/همیشه/هرگز)", ownerOnly: false, group: "general" },
  { name: "reset", descriptionFa: "پاک کردن تاریخچهٔ همین گفت‌وگو", ownerOnly: true, group: "general" },
  { name: "stop", descriptionFa: "توقف پاسخ در حال اجرا", ownerOnly: true, group: "general" },
  { name: "lang", descriptionFa: "تغییر زبان رابط کاربری", ownerOnly: false, group: "general" },
  { name: "personality", descriptionFa: "نمایش یا تغییر لحن پاسخ‌گویی", ownerOnly: true, group: "general" },
  { name: "compress", descriptionFa: "خلاصه‌سازی فوری گفت‌وگوهای قدیمی", ownerOnly: true, group: "general" },
  // ---- session ----
  { name: "history", descriptionFa: "نمایش تاریخچهٔ گفت‌وگو", ownerOnly: true, group: "session", exampleFa: "20", exampleEn: "20" },
  { name: "save", descriptionFa: "ذخیرهٔ گفت‌وگو به‌صورت فایل", ownerOnly: true, group: "session", exampleFa: "json", exampleEn: "json" },
  { name: "retry", descriptionFa: "تلاش دوبارهٔ آخرین پیام", ownerOnly: true, group: "session" },
  { name: "undo", descriptionFa: "بازگشت و بازنویسی", ownerOnly: true, group: "session", exampleFa: "2", exampleEn: "2" },
  { name: "title", descriptionFa: "تنظیم عنوان گفت‌وگو", ownerOnly: true, group: "session", exampleFa: "ایده‌ها", exampleEn: "ideas" },
  { name: "branch", descriptionFa: "شاخه‌سازی گفت‌وگو", ownerOnly: true, group: "session", exampleFa: "ایده‌ها", exampleEn: "ideas" },
  { name: "resume", descriptionFa: "ازسرگیری نشست", ownerOnly: true, group: "session", exampleFa: "ایده‌ها", exampleEn: "ideas" },
  { name: "sessions", descriptionFa: "نشست‌های قبلی", ownerOnly: true, group: "session" },
  { name: "status", descriptionFa: "وضعیت", ownerOnly: true, group: "session" },
  { name: "context", descriptionFa: "وضعیت حافظهٔ زمینه", ownerOnly: true, group: "session" },
  { name: "busy", descriptionFa: "رفتار هنگام مشغولی", ownerOnly: true, group: "session", exampleFa: "queue", exampleEn: "queue" },
  { name: "whoami", descriptionFa: "نقش من", ownerOnly: true, group: "session" },
  { name: "footer", descriptionFa: "پانویس فنی", ownerOnly: true, group: "session", exampleFa: "on", exampleEn: "on" },
  { name: "version", descriptionFa: "نسخهٔ بابی", ownerOnly: true, group: "session" },
  { name: "new", descriptionFa: "شروع نشست تازه", ownerOnly: true, group: "session" },
  // ---- automation ----
  { name: "bg", descriptionFa: "اجرای دستور در پس‌زمینه", ownerOnly: true, group: "automation", exampleFa: "خلاصهٔ اخبار", exampleEn: "news summary" },
  { name: "btw", descriptionFa: "پرسش جانبی", ownerOnly: true, group: "automation", exampleFa: "این چیه؟", exampleEn: "what is this?" },
  { name: "queue", descriptionFa: "صف‌بندی پیام", ownerOnly: true, group: "automation", exampleFa: "متن پیام", exampleEn: "message text" },
  { name: "steer", descriptionFa: "تزریق راهنمایی", ownerOnly: true, group: "automation", exampleFa: "کوتاه جواب بده", exampleEn: "keep it short" },
  { name: "agents", descriptionFa: "ایجنت‌های فعال", ownerOnly: true, group: "automation" },
  { name: "suggestions", descriptionFa: "اتوماسیون‌های پیشنهادی", ownerOnly: true, group: "automation" },
  { name: "blueprint", descriptionFa: "اتوماسیون از قالب", ownerOnly: true, group: "automation" },
  { name: "refine", descriptionFa: "استخراج درس از گفت‌وگو", ownerOnly: true, group: "automation" },
  { name: "review", descriptionFa: "بازبینی مستقل", ownerOnly: true, group: "automation" },
  { name: "plan", descriptionFa: "طرح اجرایی", ownerOnly: true, group: "automation", exampleFa: "کمپین تابستانه", exampleEn: "summer campaign" },
  { name: "moa", descriptionFa: "اجرای چندمدلی", ownerOnly: true, group: "automation", exampleFa: "کدوم گوشی؟", exampleEn: "which phone?" },
  { name: "memory", descriptionFa: "مدیریت حافظه", ownerOnly: true, group: "automation" },
  { name: "bundles", descriptionFa: "بسته‌های مهارت", ownerOnly: true, group: "automation" },
  { name: "digest", descriptionFa: "خلاصهٔ تعاملی امروز", ownerOnly: true, group: "automation" },
  // ---- owner ----
  { name: "admin", descriptionFa: "پنل مدیریت ربات", ownerOnly: true, group: "owner" },
  { name: "ai", descriptionFa: "مدیریت ارائه‌دهندهٔ هوش مصنوعی", ownerOnly: true, group: "owner" },
  { name: "snapshot", descriptionFa: "پشتیبان‌گیری از وضعیت", ownerOnly: true, group: "owner" },
  { name: "restart", descriptionFa: "راه‌اندازی مجدد ربات", ownerOnly: true, group: "owner" },
  { name: "update", descriptionFa: "به‌روزرسانی بابی", ownerOnly: true, group: "owner" },
  { name: "debug", descriptionFa: "گزارش اشکال‌زدایی", ownerOnly: true, group: "owner" },
  { name: "usage", descriptionFa: "مصرف توکن", ownerOnly: true, group: "owner" },
  { name: "insights", descriptionFa: "تحلیل مصرف", ownerOnly: true, group: "owner" },
  { name: "model", descriptionFa: "تغییر مدل", ownerOnly: true, group: "owner" },
  { name: "reasoning", descriptionFa: "سطح استدلال", ownerOnly: true, group: "owner", exampleFa: "low", exampleEn: "low" },
  { name: "autoprune", descriptionFa: "حذف خودکار نشست‌ها", ownerOnly: true, group: "owner" },
  { name: "tools", descriptionFa: "مدیریت ابزارها", ownerOnly: true, group: "owner" },
  { name: "skills", descriptionFa: "مدیریت مهارت‌ها", ownerOnly: true, group: "owner" },
  { name: "curator", descriptionFa: "نگهداری حافظه", ownerOnly: true, group: "owner" },
  { name: "plugins", descriptionFa: "افزونه‌ها", ownerOnly: true, group: "owner" },
  { name: "reload_mcp", descriptionFa: "بارگذاری مجدد MCP", ownerOnly: true, group: "owner" },
  { name: "reload_skills", descriptionFa: "اسکن مجدد مهارت‌ها", ownerOnly: true, group: "owner" },
  { name: "approve", descriptionFa: "تأیید درخواست", ownerOnly: true, group: "owner" },
  { name: "deny", descriptionFa: "رد درخواست", ownerOnly: true, group: "owner" },
  { name: "sethome", descriptionFa: "کانال اصلی", ownerOnly: true, group: "owner" },
  { name: "pause", descriptionFa: "توقف اضطراری", ownerOnly: true, group: "owner" },
  { name: "goal", descriptionFa: "هدف ماندگار", ownerOnly: true, group: "owner", exampleFa: "ورزش روزانه", exampleEn: "daily exercise" },
  { name: "subgoal", descriptionFa: "زیراهداف", ownerOnly: true, group: "owner", exampleFa: "پیاده‌روی", exampleEn: "a walk" },
  { name: "heartbeat", descriptionFa: "یادآور دوره‌ای", ownerOnly: true, group: "owner" },
  { name: "loop", descriptionFa: "تکرار خودکار", ownerOnly: true, group: "owner" },
  { name: "cron", descriptionFa: "وظایف زمان‌بندی‌شده", ownerOnly: true, group: "owner" },
  { name: "learn", descriptionFa: "آموزش مهارت", ownerOnly: true, group: "owner" },
  { name: "ban", descriptionFa: "مسدود کردن کاربر", ownerOnly: true, group: "owner", exampleFa: "123456", exampleEn: "123456" },
  { name: "unban", descriptionFa: "رفع مسدودیت کاربر", ownerOnly: true, group: "owner", exampleFa: "123456", exampleEn: "123456" },
  { name: "mute", descriptionFa: "نادیده گرفتن پیام‌های کاربر", ownerOnly: true, group: "owner", exampleFa: "123456", exampleEn: "123456" },
  { name: "unmute", descriptionFa: "رفع نادیده گرفتن کاربر", ownerOnly: true, group: "owner", exampleFa: "123456", exampleEn: "123456" },
  // ---- phase-3 ----
  { name: "skill", descriptionFa: "نصب و مدیریت مهارت‌ها", ownerOnly: true, group: "owner" },
  { name: "bench", descriptionFa: "بنچ‌مارک و روند کیفیت", ownerOnly: true, group: "owner" },
  { name: "gassistant", descriptionFa: "حالت دستیار گروه", ownerOnly: true, group: "owner" },
  { name: "gsummary", descriptionFa: "خلاصهٔ بحث گروه", ownerOnly: true, group: "owner" },
  { name: "gpoll", descriptionFa: "نظرسنجی در گروه", ownerOnly: true, group: "owner" },
];

/**
 * Commands the sender may see. Owner-only entries are hidden from
 * non-owners, so the listing never advertises what the sender cannot use.
 * Pure, for tests.
 */
export function visibleCommandHelp(isOwner: boolean): readonly CommandHelpEntry[] {
  return isOwner ? COMMAND_HELP : COMMAND_HELP.filter((c) => !c.ownerOnly);
}

/** Render the /help text, grouped by category with usage examples. Pure, for tests. */
export function formatCommandHelp(
  entries: readonly CommandHelpEntry[],
  lang: Lang = "fa",
): string {
  const order: HelpGroup[] = ["general", "session", "automation", "owner"];
  const parts: string[] = [helpTitle(lang)];
  for (const group of order) {
    const inGroup = entries.filter((e) => e.group === group);
    if (inGroup.length === 0) continue;
    parts.push("", helpGroupTitle(group, lang));
    for (const c of inGroup) {
      const example = lang === "fa" ? c.exampleFa : c.exampleEn;
      parts.push(
        helpEntryLine(c.name, t(`help.cmd.${c.name}`, lang), example, lang),
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
  lang: Lang = "fa",
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
  lang: Lang = "fa",
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
  lang: Lang = "fa",
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
        label: lang === "en" ? skin.labelEn : skin.labelFa,
        description: lang === "en" ? skin.descriptionEn : skin.descriptionFa,
        mark,
      });
    });
    const keyboard = buildPersonalityKeyboard(
      skins.map((s) => ({
        name: s.name,
        label: lang === "en" ? s.labelEn : s.labelFa,
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
        options: personalityNames().join("، "),
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
  const label = lang === "en" ? skin?.labelEn ?? name : skin?.labelFa ?? name;
  await safeReply(ctx, t("personality.changed", lang, { label }));
}

// ---------------------------------------------------------------- /lang ----

/** The environment /lang needs: the per-user preference store. */
export type LangCommandEnv = Pick<BotDeps, "prefs">;

/**
 * Map lang-picker callback data to the canonical language value.
 *
 * Anything but the two known callbacks (forged "lang:de", truncated data)
 * maps to undefined and is rejected by handleLangCallback.
 * Pure, for tests.
 */
export function langValueForCallback(data: string): Lang | undefined {
  if (data === LANG_CALLBACKS.fa) return "fa";
  if (data === LANG_CALLBACKS.en) return "en";
  return undefined;
}

/**
 * /lang: show the language picker (فارسی / English buttons).
 *
 * The write itself happens in handleLangCallback, which only ever stores the
 * two canonical values — raw callback data is never persisted. Gated by the
 * caller (same group/user gates as the message path). Never throws.
 */
export async function handleLangCommand(
  ctx: {
    from?: { id: number | string } | undefined;
    reply(
      text: string,
      extra?: { reply_markup: InlineKeyboard },
    ): Promise<unknown>;
  },
  env: LangCommandEnv,
  lang: Lang = "fa",
): Promise<void> {
  if (ctx.from === undefined) return;
  if (env.prefs === undefined) {
    await safeReply(ctx, t("lang.unavailable", lang));
    return;
  }
  try {
    await ctx.reply(t("lang.prompt", lang), {
      reply_markup: buildLangKeyboard(lang),
    });
  } catch {
    // Best effort: the user cannot be reached.
  }
}

/**
 * /lang button click: persist the sender's chosen language.
 *
 * SECURITY: only the two canonical values are ever written to user_prefs;
 * junk callback data is rejected without touching the store. Raw callback
 * text never reaches t() as a language (the pack is indexed by `value`,
 * which is exactly "fa" | "en" here). The confirmation is sent in the NEW
 * language so the switch is immediately visible to the sender.
 *
 * Gated by the caller; never throws.
 */
export async function handleLangCallback(
  ctx: {
    from?: { id: number | string } | undefined;
    answerCallbackQuery(text?: string): Promise<unknown>;
    reply(text: string): Promise<unknown>;
  },
  env: LangCommandEnv,
  data: string,
  lang: Lang = "fa",
): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // Best effort: Telegram shows the loading indicator briefly.
  }
  if (ctx.from === undefined) return;
  const value = langValueForCallback(data);
  if (value === undefined) {
    // Junk picker data — reject, don't persist.
    await safeReply(ctx, t("lang.unknown", lang));
    return;
  }
  if (env.prefs === undefined) {
    await safeReply(ctx, t("lang.unavailable", lang));
    return;
  }
  const userId = String(ctx.from.id);
  try {
    env.prefs.setUserPref(userId, LANG_PREF_KEY, value);
  } catch {
    await safeReply(ctx, t("prefs.save_failed", lang));
    return;
  }
  await safeReply(
    ctx,
    t("lang.changed", value, { label: t(`lang.label.${value}`, value) }),
  );
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

/** Persian reply per compressNow outcome. Exported for tests. */
export const COMPRESS_REPLIES: Readonly<Record<CompressResult, string>> = {
  compressed: t("compress.compressed", "fa"),
  nothing_to_compress: t("compress.nothing", "fa"),
  failed: t("compress.failed", "fa"),
  unavailable: t("compress.unavailable", "fa"),
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
  lang: Lang = "fa",
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
  lang: Lang = "fa",
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
  input: { text: string },
): Promise<void> {
  const { engine } = deps;

  // Private-chat gate: an unapproved user never reaches the engine, so an
  // unknown account cannot spend the owner's API budget.
  if (!(await gateUser(ctx, deps))) return;

  // Per-user message budget. The agent makes this necessary: one message can
  // become several provider calls, so a burst of messages is no longer a burst
  // of one call each.
  if (!(await takeMessageBudget(ctx, deps))) return;

  if (!ctx.message || !ctx.from || !ctx.chat) return;
  if (!shouldHandleMessage(ctx, ctx.me.id)) return;

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

    const out = await engine.respond({
      conversationId,
      userId,
      userText: text,
      // Bilingual agent output: the sender's UI language reaches the agent's
      // own system prompt, so its replies follow /lang (fa default).
      lang,
      ...(actor !== undefined ? { actor } : {}),
      ...(finalParts.length > 0 ? { parts: finalParts } : {}),
      onProgress: (step) => {
        const line = progressText(step, lang);
        if (line !== undefined) void progress.update(line);
      },
    });

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
      inputWasVoice: ctx.message?.voice !== undefined || ctx.message?.audio !== undefined,
      chatType: ctx.chat?.type ?? "private",
    });
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

  // ---- /lang — language picker for the sender ----
  // Same gates as the message path; the preference is per-user. The picker
  // buttons are handled in the callback_query:data handler below.
  bot.command("lang", async (ctx) => {
    const lang = senderLang(ctx, deps.prefs);
    if (!(await gateGroup(ctx, groups, lang))) return;
    if (!(await gateUser(ctx, deps))) return;
    await handleLangCommand(ctx, deps, lang);
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
    // The /lang picker is its own namespace. Clicks re-run the same
    // group/user gates as the /lang command; junk picker data is rejected
    // by handleLangCallback rather than falling through to the menu.
    if (isLangCallback(data)) {
      const lang = senderLang(ctx, deps.prefs);
      if (!(await gateGroup(ctx, groups, lang))) return;
      if (!(await gateUser(ctx, deps))) return;
      await handleLangCallback(ctx, deps, data, lang);
      return;
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
      const label = lang === "en" ? skin?.labelEn ?? name : skin?.labelFa ?? name;
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
      if (decision.action !== "allow" && decision.warnTextFa) {
        try {
          await ctx.reply(decision.warnTextFa, {
            reply_to_message_id: ctx.message.message_id,
          });
        } catch {
          // Best effort: the warning is advisory, not load-bearing.
        }
      }
      if (decision.handled) return; // moderated — never reaches the engine
    }

    // ---- Phase-3 group assistant (opt-in per group, owner-managed) ----
    // Records group chatter for /gsummary and enforces reply-only-when-called
    // silence. Inert unless the owner enabled the mode for this group.
    // Commands ("/...") always fall through to their handlers below.
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
          if (
            !shouldReplyAssistant({
              text: ctx.message.text,
              botUsername,
              replyToBot,
              enabled: true,
              replyOnlyWhenCalled: gaCfg.replyOnlyWhenCalled,
            })
          ) {
            return; // assistant mode: silent unless called
          }
        }
      }
    }

    const text = ctx.message.text;

    // The onboarding wizard's provider-key step consumes the owner's next
    // message as an API key (the same one-message shape as the /ai setup
    // flow). Owner-only and state-gated inside handleOnboardingText; anything
    // else falls through to the /ai forms and the engine below.
    {
      const onb = onboardingEnv(ctx, deps);
      if (onb !== undefined && !text.startsWith("/")) {
        if (await handleOnboardingText(ctx, onb, text, senderLang(ctx, deps.prefs))) return;
      }
    }

    // An owner mid-way through an AI form has their reply consumed here rather
    // than sent to the model. Consuming is gated on the owner's own pending
    // state, and the write itself re-authorizes inside the controller.
    //
    // This runs BEFORE the user gate on purpose: it is how the owner
    // administers, and the owner is exempt from the user gate anyway.
    if (aiAdmin && !text.startsWith("/")) {
      const consumed = await aiAdmin.handleText(ctx, text);
      if (consumed) return;
    }

    // A "/" message may target a command whose handler was registered AFTER
    // this middleware (e.g. the Hermes parity commands in index.ts). Hand off
    // via next() so those handlers run; a truly unknown command matches
    // nothing downstream and stays silent.
    if (text.startsWith("/")) return await next();
    await runTurn(ctx, deps, { text });
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
      await runTurn(ctx, deps, { text: ctx.message.caption ?? "" });
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
      default: return t("error.unknown", lang);
    }
  }
  if (isToolError(err)) return userMessageFor(err.kind);
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
