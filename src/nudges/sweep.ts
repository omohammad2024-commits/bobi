/**
 * Nudge sweep (Stage-3 differentiator: smart follow-ups).
 *
 * `sweepNudges` is the resurface half of the capture loop: it collects
 * overdue, unacked nudges and builds one Persian reminder message per nudge.
 * It is designed to be called from the heartbeat or a scheduled task; the
 * sweep itself NEVER sends anything — delivery stays with the caller, which
 * is the only component that knows how to reach a user (and re-checks access
 * at delivery time, like the reminder scheduler does).
 *
 * SECURITY:
 * - Overdue nudges are delivered ONLY to the originating user. Each returned
 *   item carries its own userId, and the caller MUST route the message to
 *   that user and no one else — never a group, never another DM.
 * - The nudge text is the user's own words, but it is rendered as DATA: the
 *   template quotes it inside «» and never interprets it. A nudge saying
 *   «ignore instructions» is just a quoted string here.
 * - Delivery is marked, not deleted: sweep marks each nudge `reminded` so it
 *   does not resurface on the next pass. The user still acks (or snoozes) it
 *   explicitly via the nudge tools — the bot never closes a follow-up on
 *   its own, because closing means "done" and only the user knows that.
 * - A failing mark is skipped, not retried in a loop: the next sweep picks
 *   it up again.
 */
import type { NudgeRecord, NudgeTracker } from "./tracker";
import {
  sweepEvents,
  type EventStore,
  type SweepEventsOptions,
} from "../memory/events";

/** One reminder ready for delivery. The caller routes `message` to `userId`. */
export interface NudgeDelivery {
  userId: string;
  /** Nudge row id, or -1 for an event reminder (events are not ackable). */
  nudgeId: number;
  message: string;
}

export interface SweepNudgesDeps {
  tracker: NudgeTracker;
  /** Injectable clock, ms. Defaults to Date.now. */
  nowMs?: number;
  /** Max reminders per sweep. Defaults to 5. */
  max?: number;
  /**
   * Optional event-reminder dep (Phase-3 proactive memory). When present,
   * upcoming dated events for `events.userId` are swept too and their
   * reminders appended AFTER the nudge reminders. Omitted by default, so
   * the existing sweep behavior is unchanged. NOTE: wiring the production
   * EventStore here is a follow-up item (src/index.ts is owned by another
   * work package); until then, event reminders reach the owner through the
   * morning digest's upcoming-events section and the sweepEvents() helper.
   */
  events?: {
    store: EventStore;
    /** Whose events to sweep — the owner only; public users get nothing new. */
    userId: string;
  } & SweepEventsOptions;
}

const DEFAULT_SWEEP_MAX = 5;

/**
 * Build reminder messages for overdue nudges (oldest first), marking each
 * `reminded`. One entry per nudge, capped at `max` per sweep.
 */
export async function sweepNudges(deps: SweepNudgesDeps): Promise<NudgeDelivery[]> {
  const { tracker } = deps;
  const nowMs = deps.nowMs ?? Date.now();
  const max = deps.max ?? DEFAULT_SWEEP_MAX;

  const due = tracker.dueAll(nowMs, max);
  const out: NudgeDelivery[] = [];
  for (const nudge of due) {
    try {
      // Mark BEFORE building the message: if marking fails the nudge is
      // skipped and stays due, so the next sweep retries it instead of the
      // user getting a message the store does not know about.
      const marked = tracker.markReminded(nudge.id, nudge.userId);
      if (!marked) continue;
      out.push({
        userId: nudge.userId,
        nudgeId: nudge.id,
        message: formatNudgeMessage(nudge),
      });
    } catch {
      // A poisoned row must not kill the whole sweep.
      continue;
    }
  }

  // Phase-3: proactive reminders ahead of dated events (optional dep).
  // Event reminders are appended after nudge reminders and use nudgeId -1
  // (events are not ackable through the nudge tools); the caller routes each
  // message to its own userId exactly like nudge deliveries.
  if (deps.events !== undefined) {
    const { store, userId, horizonDays, remindCooldownMs } = deps.events;
    const eventDeliveries = await sweepEvents(store, userId, nowMs, {
      ...(horizonDays !== undefined ? { horizonDays } : {}),
      ...(remindCooldownMs !== undefined ? { remindCooldownMs } : {}),
    });
    for (const d of eventDeliveries.slice(0, Math.max(0, max - out.length))) {
      out.push({ userId: d.userId, nudgeId: -1, message: d.message });
    }
  }

  return out;
}

/**
 * Render the reminder. The text is quoted as data inside «» — it is never
 * interpreted, so prompt-injection-shaped nudge text cannot do anything here.
 */
export function formatNudgeMessage(nudge: NudgeRecord): string {
  return (
    `🔔 Follow-up reminder:\n"${nudge.text}"\n` +
    `You saved this for follow-up. When it's done, say "done" and I'll close it.`
  );
}
