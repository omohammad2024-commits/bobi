/**
 * Event-reminder sweep (Phase 8 slimming).
 *
 * Before Phase 8 this module also resurfaced follow-up "nudges". That
 * half is gone: follow-ups are reminders now (followup=1 rows in the
 * unified store), delivered by the ReminderScheduler like every other
 * reminder — one delivery engine, not two.
 *
 * What remains is the dated-event half: proactive reminders ahead of the
 * owner's dated events (birthdays, anniversaries, monthly commitments),
 * built on sweepEvents from src/memory/events.ts. The sweep itself NEVER
 * sends anything — delivery stays with the caller, which is the only
 * component that knows how to reach a user (and re-checks access at
 * delivery time, like the reminder scheduler does).
 *
 * SECURITY: event reminders are built for ONE user (the owner) and each
 * returned item carries that userId; the caller MUST route the message
 * to that user and no one else — never a group, never another DM.
 */
import {
  sweepEvents,
  type EventStore,
  type SweepEventsOptions,
} from "../memory/events";

/** One event reminder ready for delivery to `userId` (and only them). */
export interface EventReminderDelivery {
  userId: string;
  message: string;
}

export interface SweepEventRemindersDeps extends SweepEventsOptions {
  store: EventStore;
  /** Whose events to sweep — the owner only; public users get nothing. */
  userId: string;
  /** Injectable clock, ms. Defaults to Date.now. */
  nowMs?: number;
  /** Max reminders per sweep. Defaults to 5. */
  max?: number;
}

const DEFAULT_SWEEP_MAX = 5;

/**
 * Build reminder messages for upcoming dated events (soonest first),
 * capped at `max` per sweep. The underlying sweep marks each event
 * reminded before its message is built, so a failed mark skips the event
 * instead of double-sending on the next pass.
 */
export async function sweepEventReminders(
  deps: SweepEventRemindersDeps,
): Promise<EventReminderDelivery[]> {
  const nowMs = deps.nowMs ?? Date.now();
  const max = deps.max ?? DEFAULT_SWEEP_MAX;
  const deliveries = await sweepEvents(deps.store, deps.userId, nowMs, {
    ...(deps.horizonDays !== undefined ? { horizonDays: deps.horizonDays } : {}),
    ...(deps.remindCooldownMs !== undefined
      ? { remindCooldownMs: deps.remindCooldownMs }
      : {}),
  });
  return deliveries.slice(0, max).map((d) => ({
    userId: d.userId,
    message: d.message,
  }));
}
