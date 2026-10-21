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
import type { ScheduledTaskRecord, ScheduledTaskStatus } from "../storage/storage";
import { nextAfterSchedule, parseCron } from "./cron";
import type { CronSchedule } from "./cron";
import { parseTaskAction } from "../tools/scheduled_tasks";
import type { TaskAction } from "../tools/scheduled_tasks";
import type { ToolService } from "../tools/service";
import type { ToolActor } from "../tools/types";

/** What a delivery attempt needs to report back. */
export interface ReminderDelivery {
  /** Telegram chat to send to. */
  chatId: string;
  /**
   * Owner the reminder belongs to.
   *
   * Supplied so the delivery path can re-check that access is still granted.
   * A reminder set days ago must not keep talking to a user who has since been
   * revoked.
   */
  userId: string;
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
      due = this.storage.scheduling.dueReminders(now, MAX_PER_PASS);
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
        claimed = this.storage.scheduling.claimReminder(reminder.id, now);
      } catch (err) {
        this.report(`reminder claim failed: ${msg(err)}`);
        skipped++;
        continue;
      }
      if (!claimed) {
        skipped++;
        continue;
      }

      // Phase 8: follow-ups are EXEMPT from the lateness rule below — a
      // follow-up exists to resurface late; that is its whole job. The
      // claim above already stamped reminded_at, so it fires exactly once
      // for this due time and then waits for the owner to close or snooze
      // it. Delivery failure leaves it reminded (the old nudge sweep's
      // semantics): it is reported, not retried in a loop.
      if (reminder.followup) {
        const ok = await this.safeDeliver(reminder);
        if (ok) {
          delivered++;
        } else {
          this.report(`follow-up delivery failed: id=${reminder.id}`);
        }
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
      //
      // Lateness is measured from the EFFECTIVE due time (the snooze
      // override when one is set): a reminder the owner snoozed past an
      // outage is on time, not stale.
      const effectiveDueAt = reminder.snoozedUntil ?? reminder.dueAt;
      if (now - effectiveDueAt > this.maxLatenessMs) {
        missed++;
        if (reminder.repeat === "none") continue;
        this.rearmIfRepeating(reminder, now);
        continue;
      }

      const ok = await this.safeDeliver(reminder);
      if (ok) {
        delivered++;
        // A one-off is done; a repeating one continues to its next occurrence.
        this.rearmIfRepeating(reminder, now);
      } else {
        // Delivery failed — a Telegram 5xx, a network blip, a rate limit.
        //
        // A ONE-OFF is left fired: retrying a send that was rejected outright
        // would loop forever on a chat that blocked the bot.
        //
        // A REPEATING one is still re-armed. Skipping that would end the series
        // permanently on a single transient failure, so a user who asked for a
        // daily reminder would silently stop receiving it — a worse outcome
        // than one missed occurrence.
        this.report(`reminder delivery failed: id=${reminder.id}`);
        this.rearmIfRepeating(reminder, now);
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
      this.storage.scheduling.rearmReminder(reminder.id, next);
    } catch (err) {
      this.report(`reminder re-arm failed: id=${reminder.id} ${msg(err)}`);
    }
  }

  private async safeDeliver(reminder: ReminderRecord): Promise<boolean> {
    try {
      return await this.deliver({
        chatId: reminder.chatId,
        userId: reminder.userId,
        text: reminder.followup
          ? formatFollowupMessage(reminder.text)
          : `⏰ Reminder: ${reminder.text}`,
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

/**
 * Render a follow-up delivery (Phase 8: the old nudge sweep's message,
 * byte-identical — users know this wording). The text is the owner's own
 * words, quoted as data inside "" — never interpreted.
 */
export function formatFollowupMessage(text: string): string {
  return (
    `🔔 Follow-up reminder:\n"${text}"\n` +
    `You saved this for follow-up. When it's done, say "done" and I'll close it.`
  );
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

// ---------------------------------------------------------------------------
// Scheduled tasks (cron)
// ---------------------------------------------------------------------------

/**
 * What a "message" action needs to deliver.
 *
 * userId is the task's creator, supplied so the delivery path can re-check
 * that access is still granted — mirroring ReminderDelivery.
 */
export interface TaskMessageDelivery {
  chatId: string;
  userId: string;
  text: string;
}

/** What an "agent" action needs to run. */
export interface TaskAgentRun {
  chatId: string;
  userId: string;
  prompt: string;
}

export interface TaskSchedulerOptions {
  storage: Storage;
  tools: ToolService;
  /** Deliver a "message" action. Returns whether Telegram accepted it. */
  sendMessage: (delivery: TaskMessageDelivery) => Promise<boolean>;
  /**
   * Run an "agent" action end-to-end (prompt the model, deliver the answer).
   * When absent, agent actions are marked failed with a clear reason instead
   * of crashing the pass — the scheduler must not hard-depend on the engine.
   */
  runAgent?: (run: TaskAgentRun) => Promise<boolean>;
  /**
   * Build the server-side ToolActor for a task creator, with their CURRENT
   * permissions. Called per run, so a revocation between scheduling and
   * execution takes effect on the next run.
   */
  actorForUser: (userId: string) => ToolActor;
  /** Poll interval, ms. */
  intervalMs: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /**
   * How far past its slot a task may be and still run. Mirrors the reminder
   * catch-up policy: overdue within the window runs once, older slots are
   * skipped to the next future occurrence.
   */
  maxLatenessMs?: number;
  /** Per-run action budget, ms. */
  actionTimeoutMs?: number;
  /** Optional sink for one-line, secret-free diagnostics. */
  onError?: (message: string) => void;
}

/** A task missed by more than an hour is skipped, not run. */
const DEFAULT_TASK_MAX_LATENESS_MS = 60 * 60 * 1_000;

/** Default per-run budget for one task action. */
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

/**
 * Task scheduler: cron-driven recurring tasks with structured actions.
 *
 * The mechanics mirror ReminderScheduler on purpose — one shared timer, an
 * atomic claim before any side effect, overdue catch-up on boot, re-arming
 * from the SCHEDULED slot so series do not drift — because the failure modes
 * are the same: the process is not always running, and two passes must never
 * both act.
 *
 * SECURITY: a task's "tool" action runs with the CREATING owner's live
 * permissions (see actorForUser), resolved server-side at execution time.
 * Tasks are created owner-only (see schedule_task), so this is the owner's own
 * authority delegated to a schedule they wrote — never ambient authority, and
 * never anything derived from message text. Actions are structured data
 * validated by parseTaskAction; nothing is ever eval'd.
 */
export class TaskScheduler {
  private readonly storage: Storage;
  private readonly tools: ToolService;
  private readonly sendMessage: TaskSchedulerOptions["sendMessage"];
  private readonly runAgent: TaskSchedulerOptions["runAgent"];
  private readonly actorForUser: TaskSchedulerOptions["actorForUser"];
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onError: ((message: string) => void) | undefined;
  private readonly maxLatenessMs: number;
  private readonly actionTimeoutMs: number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(opts: TaskSchedulerOptions) {
    this.storage = opts.storage;
    this.tools = opts.tools;
    this.sendMessage = opts.sendMessage;
    this.runAgent = opts.runAgent;
    this.actorForUser = opts.actorForUser;
    this.intervalMs = opts.intervalMs;
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError;
    this.maxLatenessMs = opts.maxLatenessMs ?? DEFAULT_TASK_MAX_LATENESS_MS;
    this.actionTimeoutMs = opts.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  /** Start the loop. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Never hold the process open for a task poll.
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
   * One pass: run everything due.
   *
   * Serialised against itself, like the reminder scheduler, and returns a
   * summary for the tests to assert on.
   */
  async tick(): Promise<{ executed: number; failed: number; skipped: number }> {
    if (this.running) return { executed: 0, failed: 0, skipped: 0 };
    this.running = true;
    try {
      return await this.runPass();
    } finally {
      this.running = false;
    }
  }

  private async runPass(): Promise<{ executed: number; failed: number; skipped: number }> {
    const now = this.now();
    let due: ScheduledTaskRecord[];
    try {
      due = this.storage.scheduling.dueTasks(now, MAX_PER_PASS);
    } catch (err) {
      this.report(`task scan failed: ${msg(err)}`);
      return { executed: 0, failed: 0, skipped: 0 };
    }

    let executed = 0;
    let failed = 0;
    let skipped = 0;

    for (const task of due) {
      // Validate BEFORE claiming. The claim is what writes the re-arm, so the
      // next slot has to be decided up front; a row that fails validation is
      // still claimed and re-armed, because one bad row must not wedge the
      // schedule — and the failure stays visible in last_status.
      let action: TaskAction | undefined;
      let schedule: CronSchedule | undefined;
      try {
        action = parseTaskAction(JSON.parse(task.actionJson) as unknown);
        schedule = parseCron(task.cronExpr);
      } catch (err) {
        this.report(`task invalid: id=${task.id} ${msg(err)}`);
      }

      // Catch-up policy, mirroring reminders: a slot missed by more than the
      // window is NOT replayed — the series jumps to its next future slot.
      // Anything inside the window runs exactly once.
      const tooOld = now - task.nextRunAtMs > this.maxLatenessMs;
      const willRun = action !== undefined && schedule !== undefined && !tooOld;

      // The next slot is computed from the SCHEDULED slot when the task runs,
      // so a late run does not push the whole series later (no drift); a
      // skipped or invalid task jumps to the next slot after now.
      const newSlot = this.nextSlotAfter(schedule, task, willRun ? task.nextRunAtMs : now, now);

      // Claim BEFORE acting. A pass that loses this race does nothing: the
      // winner already re-armed the row and is running it.
      let claimed: boolean;
      try {
        claimed = this.storage.scheduling.claimTask(task.id, task.nextRunAtMs, newSlot);
      } catch (err) {
        this.report(`task claim failed: id=${task.id} ${msg(err)}`);
        skipped++;
        continue;
      }
      if (!claimed) {
        skipped++;
        continue;
      }

      let status: ScheduledTaskStatus;
      if (willRun) {
        const ok = await this.executeAction(task, action!);
        status = ok ? "ok" : "failed";
        if (ok) executed++;
        else failed++;
      } else if (action === undefined || schedule === undefined) {
        status = "failed";
        failed++;
      } else {
        status = "skipped";
        skipped++;
      }
      this.finish(task.id, now, status);
    }

    return { executed, failed, skipped };
  }

  /**
   * The next slot at or after `fromMs`, pushed past `now` when the schedule
   * would otherwise land in the past. A task whose cron cannot be parsed (or
   * whose next slot cannot be computed) falls back to one interval out, so a
   * bad row retries later instead of hot-looping.
   */
  private nextSlotAfter(
    schedule: CronSchedule | undefined,
    task: ScheduledTaskRecord,
    fromMs: number,
    now: number,
  ): number {
    if (schedule === undefined) return now + this.intervalMs;
    try {
      let next = nextAfterSchedule(schedule, fromMs, task.timezone);
      if (next <= now) next = nextAfterSchedule(schedule, now, task.timezone);
      return next;
    } catch (err) {
      this.report(`task re-arm failed: id=${task.id} ${msg(err)}`);
      return now + this.intervalMs;
    }
  }

  private finish(id: number, ranAtMs: number, status: ScheduledTaskStatus): void {
    try {
      this.storage.scheduling.markTaskRun(id, { ranAtMs, status });
    } catch (err) {
      this.report(`task mark-run failed: id=${id} ${msg(err)}`);
    }
  }

  /**
   * Dispatch one validated action.
   *
   * Every branch is bounded by the per-run budget. A "tool" action goes
   * through the ToolService — the same permission → enabled → validate → run
   * path as a live tool call — with the creator's actor.
   */
  private async executeAction(task: ScheduledTaskRecord, action: TaskAction): Promise<boolean> {
    switch (action.type) {
      case "tool": {
        // SECURITY: scheduled tools run with the CREATOR's permissions,
        // resolved live via actorForUser — not stored, not model-supplied.
        // Task creation is owner-only, so this delegates the owner's own
        // authority to a schedule they wrote.
        let actor: ToolActor;
        try {
          actor = this.actorForUser(task.createdByUserId);
        } catch (err) {
          this.report(`task actor failed: id=${task.id} ${msg(err)}`);
          return false;
        }
        const result = await this.tools.runTool({
          tool: action.tool,
          input: action.input,
          actor,
          timeoutMs: this.actionTimeoutMs,
        });
        if (result.status !== "ok") {
          this.report(
            `task tool failed: id=${task.id} tool=${action.tool} status=${result.status}`,
          );
          return false;
        }
        return true;
      }

      case "message": {
        try {
          return await this.withTimeout(
            this.sendMessage({
              chatId: action.chatId,
              userId: task.createdByUserId,
              text: action.text,
            }),
            `task message timed out: id=${task.id}`,
          );
        } catch (err) {
          this.report(`task message failed: id=${task.id} ${msg(err)}`);
          return false;
        }
      }

      case "agent": {
        if (this.runAgent === undefined) {
          // Not a crash: the scheduler works without an engine attached, and
          // the reason is recorded where the owner can see it.
          this.report(`task agent failed: id=${task.id} (no agent runner configured)`);
          return false;
        }
        try {
          return await this.withTimeout(
            this.runAgent({
              chatId: action.chatId,
              userId: task.createdByUserId,
              prompt: action.prompt,
            }),
            `task agent timed out: id=${task.id}`,
          );
        } catch (err) {
          this.report(`task agent failed: id=${task.id} ${msg(err)}`);
          return false;
        }
      }
    }
  }

  /** Bound a sender/runner promise by the per-run budget. False on timeout. */
  private async withTimeout(promise: Promise<boolean>, message: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.actionTimeoutMs);
      });
      const outcome = await Promise.race([promise, timeout]);
      if (outcome === "timeout") {
        this.report(message);
        return false;
      }
      return outcome;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private report(message: string): void {
    this.onError?.(message);
  }
}
