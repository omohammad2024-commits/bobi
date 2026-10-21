/**
 * Heartbeat — the bot's autonomous tick.
 *
 * SECURITY MODEL (read this before changing anything):
 *
 * 1. The heartbeat runs AS THE OWNER. Each beat is a ConversationEngine run
 *    carrying the owner's tool actor (actorForOwner), so the agent acts with
 *    the owner's permissions BY DESIGN — it is the owner's agent, not a
 *    guest's. This is why the heartbeat is DISABLED BY DEFAULT
 *    (intervalMs = 0): an agent acting without being spoken to must be an
 *    explicit owner choice, never an accident.
 *
 * 2. Tight per-beat budgets bound every pass. The heartbeat uses a DEDICATED
 *    engine (maxIterations 3, maxToolCalls 5, totalTimeoutMs 60s): a runaway
 *    beat cannot spend like a full conversation, no matter what the model
 *    tries.
 *
 * 3. Every pass writes exactly one row to heartbeat_log: what it did (the
 *    first 500 chars of its reply), how many tools it called, and whether it
 *    ran, failed, or was skipped. The owner can read the log; it is the only
 *    autonomous output a beat leaves behind.
 *
 * 4. A beat NEVER sends a message on its own. If the owner should hear about
 *    something, that happens only through tools the agent chose during the
 *    beat (e.g. schedule_task) or through the log the owner can read.
 *
 * 5. With no real model (the fake provider), a beat is skipped and logged as
 *    skipped: autonomous noise without a model behind it helps nobody.
 *
 * The heartbeat agent receives the NORMAL toolset — it MAY call
 * schedule_task, add_goal, web_search, anything the owner could. That is the
 * point of the heartbeat: autonomy. The tools' own owner-only checks still
 * apply, and the actor is the owner's, so they pass.
 */
import type { ConversationEngine } from "../conversation/engine";
import type { GoalRecord, Storage } from "../storage/storage";
import type { ToolActor } from "../tools/types";
import type { Logger } from "../core/logger";

export interface HeartbeatOptions {
  /** Dedicated engine with tight budgets — never the main conversation engine. */
  engine: ConversationEngine;
  storage: Storage;
  ownerId: string;
  /** The owner's tool actor, built server-side like every other actor. */
  actorForOwner: () => ToolActor;
  /** True when no real model is configured; beats are then skipped. */
  isFake: () => boolean;
  /** ms between beats. 0 disables the heartbeat entirely (the default). */
  intervalMs: number;
  log: Logger;
}

/** Conversation id the heartbeat's own turns are stored under. */
const HEARTBEAT_CONVERSATION_ID = "heartbeat";

/** How many recent pass summaries the beat's prompt carries for continuity. */
const RECENT_BEATS_FOR_PROMPT = 5;

/** How many active goals the beat's prompt carries. */
const GOALS_FOR_PROMPT = 20;

/** The log keeps what the beat did, cut to this many characters. */
const SUMMARY_MAX_CHARS = 500;

export class HeartbeatService {
  private readonly engine: ConversationEngine;
  private readonly storage: Storage;
  private readonly ownerId: string;
  private readonly actorForOwner: () => ToolActor;
  private readonly isFake: () => boolean;
  private readonly intervalMs: number;
  private readonly log: Logger;

  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: HeartbeatOptions) {
    this.engine = opts.engine;
    this.storage = opts.storage;
    this.ownerId = opts.ownerId;
    this.actorForOwner = opts.actorForOwner;
    this.isFake = opts.isFake;
    this.intervalMs = opts.intervalMs;
    this.log = opts.log;
  }

  /** Whether the heartbeat loop is armed. */
  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Start the loop. Idempotent: a second call is a no-op.
   *
   * A non-positive interval means "disabled": nothing is scheduled, because
   * an autonomous agent must be the owner's explicit choice.
   */
  start(): void {
    if (this.intervalMs <= 0) return;
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.beat();
    }, this.intervalMs);
    // Never hold the process open for a heartbeat poll.
    this.timer.unref?.();
  }

  /** Stop the loop. Safe to call when not running. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Run one beat. Public so tests can drive it directly.
   *
   * NEVER throws: a dying timer callback or an unhandled rejection would be
   * silent, so every failure is recorded in heartbeat_log and the error is
   * logged instead.
   */
  async beat(): Promise<void> {
    try {
      await this.runBeat();
    } catch (err) {
      this.log.error("heartbeat failed", { error: describeError(err) });
      try {
        this.storage.scheduling.logHeartbeat({
          summary: describeError(err),
          toolCalls: 0,
          status: "failed",
        });
      } catch {
        // The database itself is unusable; the log above already reported it.
      }
    }
  }

  /** One autonomous pass: gather context, run the agent, log the outcome. */
  private async runBeat(): Promise<void> {
    if (this.isFake()) {
      // No real model: an autonomous pass would be noise, not work. The skip
      // is still logged, so the trail stays an honest record of what the
      // heartbeat did.
      this.storage.scheduling.logHeartbeat({
        summary: "Skipped: no real model configured.",
        toolCalls: 0,
        status: "skipped",
      });
      return;
    }

    const out = await this.engine.respond({
      conversationId: HEARTBEAT_CONVERSATION_ID,
      userId: this.ownerId,
      userText: this.composePrompt(),
      // SECURITY: the heartbeat runs as the owner BY DESIGN — see the header
      // comment. This actor is built server-side from the configured owner id,
      // never from anything the model said.
      actor: this.actorForOwner(),
    });

    this.storage.scheduling.logHeartbeat({
      summary: truncateChars(out.chunks.join(""), SUMMARY_MAX_CHARS),
      toolCalls: out.toolCalls,
      status: "ok",
    });
  }

  /** The beat's prompt: what the heartbeat is, the open goals, recent passes. */
  private composePrompt(): string {
    const goals = this.storage.scheduling.listGoals(this.ownerId, "active", GOALS_FOR_PROMPT);
    // Oldest first: the narrative reads forward.
    const recent = this.storage.scheduling.recentHeartbeats(RECENT_BEATS_FOR_PROMPT).reverse();

    const lines: string[] = [
      "This is a heartbeat: a periodic, autonomous check by the bot, without the owner having sent a message.",
      "You are the owner's assistant acting with their authority. Review the active goals and take action to advance them if needed.",
      "You can use tools — including schedule_task for scheduling follow-ups, and add_goal and complete_goal for managing goals.",
      "",
      "Active goals:",
    ];
    if (goals.length === 0) {
      lines.push("— No goals registered.");
    } else {
      for (const g of goals) lines.push(`— ${describeGoal(g)}`);
    }
    lines.push("", "خلاصهٔ ضربان‌های قبلی:");
    if (recent.length === 0) {
      lines.push("— هنوز ضربانی ثبت نشده است.");
    } else {
      for (const r of recent) lines.push(`— [${r.status}] ${r.summary}`);
    }
    lines.push(
      "",
      "در پایان، خلاصه‌ای کوتاه (چند جمله) از آنچه بررسی یا انجام دادی بنویس؛ همین خلاصه در گزارش ضربان ثبت می‌شود.",
    );
    return lines.join("\n");
  }
}

/** Format a stored goal for the beat's prompt. */
function describeGoal(g: GoalRecord): string {
  const desc = g.description.length > 0 ? ` — ${g.description}` : "";
  return `#${g.id}: ${g.title}${desc}`;
}

/**
 * Truncate to N characters, counting code points rather than UTF-16 units so
 * a cut never splits an emoji into a lone surrogate. The storage layer
 * truncates again on write; this keeps the service's own value honest.
 */
function truncateChars(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join("");
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
