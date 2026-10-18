/**
 * Moderation actions: escalation ladder + in-memory mod log + Persian
 * user-facing text.
 *
 * SAFETY MODEL (the core of this module's attack-surface review):
 *
 * 1. Warn-before-delete. The FIRST hit for a user inside the escalation
 *    window only produces a warning reply — never a deletion. Deletion needs
 *    a repeat offense within 10 minutes. This bounds false-positive harm:
 *    a wrongly flagged message costs the user one warning, not lost content.
 * 2. NEVER auto-ban / auto-restrict. The action type is closed:
 *    "allow" | "warn" | "delete". There is deliberately no "ban", "mute", or
 *    "restrict" variant — restricting a user stays a human (owner) decision.
 *    The 3rd strike notifies the owner so THEY can decide; the bot itself
 *    stops at deletion.
 * 3. Link policy "warn" caps severity. When the owner sets linkPolicy:"warn",
 *    links can never escalate to deletion no matter how many strikes accrue —
 *    the owner asked for a nudge, not enforcement. Only linkPolicy:"delete"
 *    opts into the full ladder for links.
 * 4. No content echo. Warning replies and owner notifications are STATIC
 *    Persian strings chosen by reason code. The offending message text is
 *    never interpolated, so hostile content cannot be reflected into the
 *    group or the owner's chat (no quote injection, no filter probing via
 *    echo). The profanity list itself is never logged verbatim either.
 * 5. Notify cooldown. Owner notifications are rate-limited per group (5 min)
 *    so a coordinated flood cannot turn the bot into an owner-harassment
 *    tool via notification spam.
 * 6. Every non-allow action is appended to the in-memory mod log with
 *    chat/user/action/reason/timestamp — the owner has an audit trail for
 *    every automated intervention. (Future work, documented in
 *    docs/phase-moderation.md: one-tap "this was wrong" feedback on log
 *    entries to tune thresholds.)
 */
import type { ModConfig } from "./config";
import type { CheckHit, CheckReason } from "./checks";

/** The closed action set. NOTE: there is intentionally no ban/restrict. */
export type ModAction = "allow" | "warn" | "delete";

export interface Strike {
  tsMs: number;
  reason: CheckReason;
}

export interface ActionDecision {
  action: ModAction;
  /** True only on the 3rd strike — the owner decides what happens next. */
  notifyOwner: boolean;
  reason: CheckReason | null;
  /** Static Persian warning text, or null when no warning is sent. */
  warnTextFa: string | null;
}

/** Strikes older than this do not count toward escalation. */
export const ESCALATION_WINDOW_MS = 10 * 60 * 1000;
/** Minimum gap between owner notifications for the same group. */
export const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Priority when several detectors fire at once: the most "intentional"
 * violation is reported. Flood is last because it is the noisiest signal.
 */
const REASON_PRIORITY: readonly CheckReason[] = [
  "profanity",
  "link",
  "spam",
  "flood",
];

/** Static Persian warnings, keyed by reason code. No message content inside. */
const WARN_TEXT: Record<CheckReason, string> = {
  flood:
    "⚠️ پیام‌های پیاپی زیادی فرستادید؛ لطفاً کمی مکث کنید. تکرارش باعث حذف پیام می‌شود.",
  link: "⚠️ ارسال لینک در این گروه مجاز نیست.",
  profanity: "⚠️ لطفاً از الفاظ نامناسب استفاده نکنید.",
  spam: "⚠️ این پیام شبیه اسپم تشخیص داده شد؛ لطفاً رعایت کنید.",
};

const DELETE_NOTE_FA = "پیام به دلیل تکرار تخلف حذف شد.";

export interface DecideOptions {
  /** Last time the owner was notified for this group (ms); enforces cooldown. */
  lastNotifyMs?: number;
}

/**
 * Map detector hits + strike history to an action.
 *
 * Escalation ladder (strikes = hits within ESCALATION_WINDOW_MS):
 *   0 prior strikes → warn (Persian reply, message stays)
 *   1 prior strike  → delete (silent deletion + short note)
 *   2+ prior strikes → delete + notifyOwner (owner decides: ban, mute, …)
 *
 * `strikes` is the caller's per-(chat,user) history; this function never
 * mutates it — the caller appends the new strike when action != "allow".
 */
export function decideAction(
  hits: CheckHit[],
  cfg: ModConfig,
  strikes: readonly Strike[],
  nowMs: number,
  opts: DecideOptions = {},
): ActionDecision {
  const fired = hits.filter((h) => h.hit);
  if (fired.length === 0) {
    return { action: "allow", notifyOwner: false, reason: null, warnTextFa: null };
  }

  let reason: CheckReason = fired[0]?.reason ?? "flood";
  const priority = REASON_PRIORITY.find((r) => fired.some((h) => h.reason === r));
  if (priority !== undefined) reason = priority;

  // linkPolicy:"warn" is a severity cap: links never escalate past a warning.
  const cappedAtWarn = reason === "link" && cfg.linkPolicy === "warn";

  const recentStrikes = strikes.filter(
    (s) => s.tsMs >= nowMs - ESCALATION_WINDOW_MS && s.tsMs <= nowMs,
  ).length;

  if (cappedAtWarn || recentStrikes === 0) {
    return {
      action: "warn",
      notifyOwner: false,
      reason,
      warnTextFa: WARN_TEXT[reason],
    };
  }

  if (recentStrikes === 1) {
    return {
      action: "delete",
      notifyOwner: false,
      reason,
      warnTextFa: DELETE_NOTE_FA,
    };
  }

  // 3rd strike: delete + notify the owner. The cooldown keeps a flood from
  // becoming an owner-notification flood.
  const lastNotify = opts.lastNotifyMs ?? 0;
  const notifyOwner = nowMs - lastNotify >= NOTIFY_COOLDOWN_MS;
  return {
    action: "delete",
    notifyOwner,
    reason,
    warnTextFa: DELETE_NOTE_FA,
  };
}

// ---------------------------------------------------------------------------
// In-memory mod log (ring buffer). Every automated action lands here so the
// owner can audit what the bot did. Entries carry reason codes only — never
// message content — so the log itself cannot become a content store.
// ---------------------------------------------------------------------------

export interface ModLogEntry {
  tsMs: number;
  chatId: string;
  userId: string;
  action: Exclude<ModAction, "allow">;
  reason: CheckReason;
}

export interface ModLog {
  append(entry: ModLogEntry): void;
  entries(): readonly ModLogEntry[];
  size(): number;
}

export function createModLog(maxEntries = 500): ModLog {
  const buf: ModLogEntry[] = [];
  return {
    append(entry: ModLogEntry): void {
      buf.push(entry);
      if (buf.length > maxEntries) buf.splice(0, buf.length - maxEntries);
    },
    entries(): readonly ModLogEntry[] {
      return buf.slice();
    },
    size(): number {
      return buf.length;
    },
  };
}
