/**
 * Reminder scheduler.
 *
 * Runs inside the bot process as a repeating timer, because a Telegram bot that
 * only replies when spoken to cannot deliver a reminder on its own. That choice
 * has two consequences this module has to handle:
 *
 *  1. THE PROCESS IS NOT ALWAYS RUNNING. A reminder whose time passed while the
 *     machine was asleep or the bot was stopped has still not been delivered, so
 *     any overdue reminder fires on the next pass. That is the whole point of
 *     storing real timestamps rather than programming timers in memory.
 *
 *  2. TWO PASSES MUST NEVER BOTH SEND. Every delivery is claimed atomically in
 *     storage before the send; a pass that loses the claim skips the row. A
 *     duplicate reminder is worse than a late one.
 *
 * The timer is `unref`'d so it never keeps the process alive on its own, and
 * each pass is serialised so a slow delivery cannot overlap the next tick.
 */
import type { ReminderRecord, Storage } from "../storage/storage";
import type { ReminderRepeat } from "../storage/storage";

/** What a delivery attempt needs to report back. */
export interface ReminderDelivery {
  /** Telegram chat to send to. */
  chatId: string;
  text: string;
}

export interface SchedulerOptions {
  storage: Storage;
  /** Deliver one reminder. Returns whether Telegram accepted it. */
  deliver: (delivery: ReminderDelivery) => Promise<boolean>;
  /** Poll interval, ms. */
  intervalMs: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Optional sink for one-line, secret-free diagnostics. */
  onError?: (message: string) => void;
  /**
   * How far past its due time a reminder may be and still be delivered.
   *
   * Guards the case where the bot is started after a long outage: without it,
   * a reminder from three weeks ago would fire on boot, which is noise rather
   * than a reminder. Overdue reminders inside this window still fire, which is
   * what makes a laptop-lid sleep survivable.
   */
  maxLatenessMs?: number;
}

/** A reminder missed by more than an hour is reported, not delivered. */
const DEFAULT_MAX_LATENESS_MS = 60 * 60 * 1_000;

/** Ceiling on deliveries per pass, so a backlog cannot storm Telegram. */
const MAX_PER_PASS = 20;

/** One day and one week, for re-arming a repeating reminder. */
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;

export class ReminderScheduler {
  private readonly storage: Storage;
  private readonly deliver: SchedulerOptions["deliver"];
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onError: ((message: string) => void) | undefined;
  private readonly maxLatenessMs: number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(opts: SchedulerOptions) {
    this.storage = opts.storage;
    this.deliver = opts.deliver;
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError;
    this.maxLatenessMs = opts.maxLatenessMs ?? DEFAULT_MAX_LATENESS_MS;
  }

  /** Start the loop. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Never hold the process open for a reminder poll.
    this.timer.unref?.();
  }

  /** Stop the loop. Safe to call when not running. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * One pass: deliver everything due.
   *
   * Serialised against itself, so a delivery slower than the interval cannot
   * produce overlapping passes that both read the same due list.
   *
   * Returns a summary, which is what the tests assert on.
   */
  async tick(): Promise<{ delivered: number; missed: number; skipped: number }> {
    if (this.running) return { delivered: 0, missed: 0, skipped: 0 };
    this.running = true;
    try {
      return await this.runPass();
    } finally {
      this.running = false;
    }
  }

  private async runPass(): Promise<{ delivered: number; missed: number; skipped: number }> {
    const now = this.now();
    let due: ReminderRecord[];
    try {
      due = this.storage.dueReminders(now, MAX_PER_PASS);
    } catch (err) {
      this.report(`reminder scan failed: ${msg(err)}`);
      return { delivered: 0, missed: 0, skipped: 0 };
    }

    let delivered = 0;
    let missed = 0;
    let skipped = 0;

    for (const reminder of due) {
      // Claim BEFORE sending. A pass that loses this race does nothing: the
      // winner is already delivering it.
      let claimed: boolean;
      try {
        claimed = this.storage.claimReminder(reminder.id, now);
      } catch (err) {
        this.report(`reminder claim failed: ${msg(err)}`);
        skipped++;
        continue;
      }
      if (!claimed) {
        skipped++;
        continue;
      }

      // A reminder too far past its time is not sent: a flood of stale
      // reminders after an outage helps nobody.
      //
      // A ONE-OFF is retired — its moment has passed, and sending it late is
      // noise. A REPEATING one is different: the series is still going, so it
      // is re-armed to its next future occurrence and the missed one is only
      // counted. Suppressing the series entirely would silently end a daily
      // reminder the user asked for.
      if (now - reminder.dueAt > this.maxLatenessMs) {
        missed++;
        if (reminder.repeat === "none") continue;
        this.rearmIfRepeating(reminder, now);
        continue;
      }

      const ok = await this.safeDeliver(reminder);
      if (ok) {
        delivered++;
        this.rearmIfRepeating(reminder, now);
      } else {
        // Delivery failed. The row is already `fired`, so it will not be
        // retried: retrying a Telegram send that was rejected would loop
        // forever on a chat that blocked the bot.
        this.report(`reminder delivery failed: id=${reminder.id}`);
      }
    }

    return { delivered, missed, skipped };
  }

  /**
   * Re-arm a repeating reminder for its next occurrence.
   *
   * The next time is computed from the SCHEDULED time, not from `now`, so a
   * daily reminder stays at its original hour instead of drifting later by the
   * length of each delay.
   */
  private rearmIfRepeating(reminder: ReminderRecord, now: number): void {
    if (reminder.repeat === "none") return;

    const step = stepFor(reminder.repeat);
    let next = reminder.dueAt + step;
    // Skip any occurrences already past (a long outage on a daily reminder), so
    // the next delivery is in the future rather than immediately again.
    while (next <= now) next += step;

    try {
      this.storage.rearmReminder(reminder.id, next);
    } catch (err) {
      this.report(`reminder re-arm failed: id=${reminder.id} ${msg(err)}`);
    }
  }

  private async safeDeliver(reminder: ReminderRecord): Promise<boolean> {
    try {
      return await this.deliver({
        chatId: reminder.chatId,
        text: `⏰ یادآوری: ${reminder.text}`,
      });
    } catch (err) {
      this.report(`reminder delivery threw: id=${reminder.id} ${msg(err)}`);
      return false;
    }
  }

  private report(message: string): void {
    this.onError?.(message);
  }
}

/** The interval between occurrences of a repeating reminder. */
export function stepFor(repeat: ReminderRepeat): number {
  switch (repeat) {
    case "none":
      return 0;
    case "daily":
      return DAY_MS;
    case "weekly":
      return WEEK_MS;
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
