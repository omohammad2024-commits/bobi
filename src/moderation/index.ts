/**
 * Moderation entry point: `createModerator(deps)` → `{ handleMessage, getModLog }`.
 *
 * This is the single function the Telegram message handler calls. Everything
 * stateful (per-user flood timestamps, strike history, forwarded-text memory,
 * mod log, notify cooldowns) lives inside the closure — no globals, so
 * per-group isolation is structural: history maps are keyed by
 * `<chatId>:<userId>` and can never cross groups.
 *
 * SECURITY NOTES:
 *
 * - Owner bypass: the owner's own messages are never moderated (an
 *   auto-moderator that deletes the owner's messages would be both wrong and
 *   a self-DoS vector). Owner identity comes ONLY from the injected
 *   `isOwner`/ownerId — never from message text, usernames, or anything a
 *   chatter can influence.
 * - Disabled by default: a group with no config (or a corrupt config blob)
 *   returns "allow" for everything. Moderation cannot surprise-enable.
 * - Non-text messages are skipped: there is nothing text-based to scan, and
 *   scanning captions/media is out of scope for this phase (documented in
 *   docs/phase-moderation.md as a known gap, not silently half-handled).
 * - Message content is NEVER written to long-term memory or the mod log:
 *   the detectors are pure, the log stores reason codes only, and the owner
 *   notification is a static template. Content lives only in the short-lived
 *   per-user timestamp/text windows needed for flood/loop detection and is
 *   pruned aggressively.
 * - The detectors' patterns are server-side and never revealed: warnings and
 *   notifications carry reason codes rendered as fixed Persian strings, never
 *   the matched pattern or the offending text, so probing the filter yields
 *   at most a binary hit/no-hit signal.
 */
import {
  DEFAULT_MOD_CONFIG,
  getModConfig,
  type ModConfig,
  type ModPrefStore,
} from "./config";
import {
  runChecks,
  type CheckHit,
  type CheckReason,
  type SpamSignalOptions,
} from "./checks";
import {
  createModLog,
  decideAction,
  ESCALATION_WINDOW_MS,
  type ActionDecision,
  type DecideOptions,
  type ModAction,
  type ModLog,
  type ModLogEntry,
  type Strike,
} from "./actions";

export interface ModeratorDeps {
  /** Pref store (Storage satisfies this). Absent → everything allows. */
  storage?: ModPrefStore;
  /** Bot owner's numeric Telegram id, as a string. */
  ownerId: string;
  /**
   * Owner check. Defaults to strict string equality against `ownerId`.
   * Inject the real `AuthorizationService`-backed check at the call site.
   */
  isOwner?: (userId: string) => boolean;
  /**
   * Owner notification sink, e.g. `bot.api.sendMessage(ownerChatId, text)`.
   * Absent → 3rd-strike notifications are logged to the mod log only.
   */
  notifyOwner?: (text: string) => Promise<void>;
  /** Clock seam for tests. Defaults to Date.now. */
  clock?: () => number;
}

export interface IncomingModMessage {
  chatId: string;
  userId: string;
  /** Absent/null/empty → skipped (non-text). */
  text?: string | null | undefined;
  tsMs: number;
  forwarded?: boolean;
}

export interface ModDecision extends ActionDecision {
  /** Convenience: true when the handler should stop processing the message. */
  handled: boolean;
}

export interface Moderator {
  handleMessage(msg: IncomingModMessage): Promise<ModDecision>;
  getModLog(): readonly ModLogEntry[];
}

const MAX_FLOOD_HISTORY = 60;
const MAX_TEXT_HISTORY = 10;
/** Upper bound for pruning: max configured window is 300s; keep a margin. */
const HISTORY_PRUNE_MS = 10 * 60 * 1000;

function historyKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

/**
 * Static Persian owner-notification template. Carries chat id, user id,
 * reason code, and action — NEVER message content.
 */
function ownerNotifyTextFa(
  chatId: string,
  userId: string,
  reason: CheckReason,
  action: ModAction,
): string {
  const reasonEn: Record<CheckReason, string> = {
    flood: "Sending messages in a row",
    link: "Sending a link",
    profanity: "Inappropriate language",
    spam: "Spam-like behavior",
  };
  const actionEn = action === "delete" ? "Delete message" : "Warning";
  return (
    `🛡 Auto-moderation report\n` +
    `Group: ${chatId}\n` +
    `User: ${userId}\n` +
    `Reason: ${reasonEn[reason]}\n` +
    `Action: ${actionEn} (3rd violation in 10 minutes)\n` +
    `Final decision (ban/restrict) is yours.`
  );
}

export function createModerator(deps: ModeratorDeps): Moderator {
  const now = deps.clock ?? Date.now;
  const isOwner =
    deps.isOwner ?? ((userId: string) => userId === deps.ownerId);
  const log: ModLog = createModLog();

  // Per-(chat,user) state. Keyed by chatId AND userId: group A's strikes can
  // never leak into group B, and one user's flood cannot implicate another.
  const floodTs = new Map<string, number[]>();
  const strikes = new Map<string, Strike[]>();
  const recentTexts = new Map<string, string[]>();
  const lastNotify = new Map<string, number>();

  function prune(key: string, tsMs: number): void {
    const arr = floodTs.get(key);
    if (arr) {
      const kept = arr.filter((t) => t >= tsMs - HISTORY_PRUNE_MS);
      if (kept.length === 0) floodTs.delete(key);
      else floodTs.set(key, kept.slice(-MAX_FLOOD_HISTORY));
    }
    const st = strikes.get(key);
    if (st) {
      const kept = st.filter((s) => s.tsMs >= tsMs - ESCALATION_WINDOW_MS);
      if (kept.length === 0) strikes.delete(key);
      else strikes.set(key, kept);
    }
    const tx = recentTexts.get(key);
    if (tx && tx.length > MAX_TEXT_HISTORY) {
      recentTexts.set(key, tx.slice(-MAX_TEXT_HISTORY));
    }
  }

  async function handleMessage(msg: IncomingModMessage): Promise<ModDecision> {
    const allow: ModDecision = {
      action: "allow",
      notifyOwner: false,
      reason: null,
      warnText: null,
      handled: false,
    };

    const text = msg.text ?? "";
    // Skip: non-text, owner messages, missing storage/owner.
    if (text.length === 0) return allow;
    if (isOwner(msg.userId)) return allow;
    if (deps.storage === undefined || deps.ownerId.length === 0) return allow;

    // Skip: moderation not enabled for this group. Default-off is the whole
    // point: an unconfigured group is never moderated.
    const cfg: ModConfig = getModConfig(deps.storage, deps.ownerId, msg.chatId);
    if (!cfg.enabled) return allow;

    const tsMs = msg.tsMs;
    const key = historyKey(msg.chatId, msg.userId);
    prune(key, tsMs);

    // Flood history: include the current message, then run detectors.
    const ts = floodTs.get(key) ?? [];
    ts.push(tsMs);
    floodTs.set(key, ts);

    // Build the optional-parameter objects field-by-field: with
    // exactOptionalPropertyTypes, assigning an explicit `undefined` is a
    // type error, so absent inputs stay absent.
    const spamOpts: SpamSignalOptions = {};
    if (msg.forwarded !== undefined) spamOpts.forwarded = msg.forwarded;
    const prevTexts = recentTexts.get(key);
    if (prevTexts !== undefined) spamOpts.recentTexts = prevTexts;
    const hits: CheckHit[] = runChecks(text, cfg, ts, tsMs, spamOpts);

    const decideOpts: DecideOptions = {};
    const lastN = lastNotify.get(msg.chatId);
    if (lastN !== undefined) decideOpts.lastNotifyMs = lastN;
    const decision = decideAction(hits, cfg, strikes.get(key) ?? [], tsMs, decideOpts);

    if (decision.action === "allow") {
      // Remember forwarded text for loop detection even on clean messages.
      if (msg.forwarded === true) {
        const arr = recentTexts.get(key) ?? [];
        arr.push(text);
        recentTexts.set(key, arr.slice(-MAX_TEXT_HISTORY));
      }
      return allow;
    }

    // Record the strike for the escalation ladder.
    const userStrikes = strikes.get(key) ?? [];
    userStrikes.push({ tsMs, reason: decision.reason as CheckReason });
    strikes.set(key, userStrikes);

    // Every automated action is audit-logged (reason codes only).
    log.append({
      tsMs,
      chatId: msg.chatId,
      userId: msg.userId,
      action: decision.action,
      reason: decision.reason as CheckReason,
    });

    // 3rd strike: notify the owner (static template, no message content).
    // The cooldown inside decideAction keeps this from becoming a
    // notification flood; failures to notify never fail moderation itself.
    if (decision.notifyOwner && deps.notifyOwner) {
      lastNotify.set(msg.chatId, tsMs);
      const note = ownerNotifyTextFa(
        msg.chatId,
        msg.userId,
        decision.reason as CheckReason,
        decision.action,
      );
      await deps.notifyOwner(note).catch(() => undefined);
    }

    return { ...decision, handled: true };
  }

  return {
    handleMessage,
    getModLog: () => log.entries(),
  };
}

export { DEFAULT_MOD_CONFIG };
export type { ModConfig, CheckHit, CheckReason, ModAction, ModLogEntry };
