/**
 * SchedulingRepo — Reminders, scheduled tasks, goals, heartbeats repository (phase 6).
 *
 * Owns the SQL for: reminders, scheduled_tasks, goals, heartbeat_log.
 * Extracted from the old Storage god class; method bodies are unchanged,
 * only their home moved. Row shapes stay inside the storage layer.
 */

import { RepoBase } from "./base";
import { clampInt } from "./base";

/** How often a reminder repeats after firing. */
export type ReminderRepeat = "none" | "daily" | "weekly";

/** Lifecycle of a reminder. */
export type ReminderState = "pending" | "fired" | "cancelled";

/** Outcome of the most recent run of a scheduled task. */
export type ScheduledTaskStatus = "ok" | "failed" | "skipped";

/** One recurring scheduled task. Created owner-only; see schedule_task. */
export interface ScheduledTaskRecord {
  id: number;
  name: string;
  /** Normalized 5-field cron expression (shorthands expanded at creation). */
  cronExpr: string;
  /** IANA timezone the expression is interpreted in. */
  timezone: string;
  /** Validated action JSON: {"type":"tool"|"message"|"agent", ...}. */
  actionJson: string;
  enabled: boolean;
  /** Owner (Telegram numeric id as string) that created the task. */
  createdByUserId: string;
  /** unix ms — the next scheduled run. Re-armed after every run. */
  nextRunAtMs: number;
  /** unix ms — when the last run happened. */
  lastRunAtMs?: number;
  /** Outcome of the last run. */
  lastStatus?: ScheduledTaskStatus;
  /** How many times the task has run. */
  runCount: number;
  /** unix ms */
  createdAt: number;
}

/** Lifecycle of a goal. */
export type GoalStatus = "active" | "done";

/**
 * One persistent owner goal. Goals belong to the owner: the goal tools are
 * owner-only, so every row is the owner's — but the creator is still recorded
 * so the storage layer never trusts the caller on this.
 */
export interface GoalRecord {
  id: number;
  title: string;
  description: string;
  status: GoalStatus;
  createdBy: string;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
  /** unix ms — set when the goal is completed. */
  doneAt?: number;
}

/** Outcome of one heartbeat pass. */
export type HeartbeatStatus = "ok" | "failed" | "skipped";

/**
 * One row of the heartbeat audit trail. The only autonomous output the
 * heartbeat leaves behind: what it did, how many tools it called, and
 * whether the pass ran, failed, or was skipped.
 */
export interface HeartbeatLogEntry {
  id: number;
  /** unix ms — when the pass ran. */
  ranAtMs: number;
  /** What the pass did (first 500 chars of its reply). */
  summary: string;
  toolCalls: number;
  status: HeartbeatStatus;
}

/** One scheduled reminder. Always scoped to its owner. */
export interface ReminderRecord {
  id: number;
  userId: string;
  /** Chat the reminder is delivered to. */
  chatId: string;
  text: string;
  /** unix ms — when it should fire. */
  dueAt: number;
  repeat: ReminderRepeat;
  state: ReminderState;
  /** unix ms */
  createdAt: number;
  /** unix ms — set when it actually fired. */
  firedAt?: number;
  /**
   * Phase 8 (silo merge): a follow-up is a reminder that resurfaces until
   * the owner closes it (cancel_reminder) — the old nudge system's rows
   * live here now. Firing a follow-up records `remindedAt` and leaves the
   * row pending; it never retires on its own.
   */
  followup: boolean;
  /** unix ms — snooze override: the effective due time while set. */
  snoozedUntil?: number;
  /** unix ms — when a follow-up was last resurfaced. */
  remindedAt?: number;
}

/** Raw row shape shared by the reminder queries. */
interface ReminderRow {
  id: number;
  user_id: string;
  chat_id: string;
  text: string;
  due_at: number;
  repeat: string;
  state: string;
  created_at: number;
  fired_at: number | null;
  followup: number;
  snoozed_until: number | null;
  reminded_at: number | null;
}

/** Column list shared by every reminder SELECT (kept in one place so a new
 *  column can never be read by one query and forgotten by another). */
const REMINDER_COLUMNS =
  "id, user_id, chat_id, text, due_at, repeat, state, created_at, fired_at, followup, snoozed_until, reminded_at";

/** Raw row shape shared by the scheduled-task queries. */
interface ScheduledTaskRow {
  id: number;
  name: string;
  cron_expr: string;
  timezone: string;
  action_json: string;
  enabled: number;
  created_by_user_id: string;
  next_run_at_ms: number;
  last_run_at_ms: number | null;
  last_status: string | null;
  run_count: number;
  created_at: number;
}

/** Map a scheduled-task row to a record, omitting nulls. */
function toScheduledTaskRecord(r: ScheduledTaskRow): ScheduledTaskRecord {
  return {
    id: r.id,
    name: r.name,
    cronExpr: r.cron_expr,
    timezone: r.timezone,
    actionJson: r.action_json,
    enabled: r.enabled === 1,
    createdByUserId: r.created_by_user_id,
    nextRunAtMs: r.next_run_at_ms,
    runCount: r.run_count,
    createdAt: r.created_at,
    ...(r.last_run_at_ms !== null ? { lastRunAtMs: r.last_run_at_ms } : {}),
    ...(r.last_status !== null ? { lastStatus: r.last_status as ScheduledTaskStatus } : {}),
  };
}

/** Map a reminder row to a record, omitting nulls. */
function toReminderRecord(r: ReminderRow): ReminderRecord {
  return {
    id: r.id,
    userId: r.user_id,
    chatId: r.chat_id,
    text: r.text,
    dueAt: r.due_at,
    repeat: r.repeat as ReminderRepeat,
    state: r.state as ReminderState,
    createdAt: r.created_at,
    ...(r.fired_at !== null ? { firedAt: r.fired_at } : {}),
    followup: r.followup === 1,
    ...(r.snoozed_until !== null ? { snoozedUntil: r.snoozed_until } : {}),
    ...(r.reminded_at !== null ? { remindedAt: r.reminded_at } : {}),
  };
}

/** Raw row shape for the goals queries. */
interface GoalRow {
  id: number;
  title: string;
  description: string;
  status: string;
  created_by: string;
  created_at_ms: number;
  updated_at_ms: number;
  done_at_ms: number | null;
}

/** Map a goal row to a record, omitting nulls (exactOptionalPropertyTypes). */
function toGoalRecord(r: GoalRow): GoalRecord {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as GoalStatus,
    createdBy: r.created_by,
    createdAt: r.created_at_ms,
    updatedAt: r.updated_at_ms,
    ...(r.done_at_ms !== null ? { doneAt: r.done_at_ms } : {}),
  };
}

/** Raw row shape for the heartbeat-log queries. */
interface HeartbeatLogRow {
  id: number;
  ran_at_ms: number;
  summary: string;
  tool_calls: number;
  status: string;
}

/** Map a heartbeat-log row to a record. */
function toHeartbeatLogEntry(r: HeartbeatLogRow): HeartbeatLogEntry {
  return {
    id: r.id,
    ranAtMs: r.ran_at_ms,
    summary: r.summary,
    toolCalls: r.tool_calls,
    status: r.status as HeartbeatStatus,
  };
}

/**
 * Truncate a heartbeat summary to 500 characters.
 *
 * Counts code points, not UTF-16 units, so a cut never splits an emoji into a
 * lone surrogate. Defence in depth for the service-side truncation.
 */
function truncateSummary(s: string): string {
  const points = Array.from(s);
  return points.length <= 500 ? s : points.slice(0, 500).join("");
}

export class SchedulingRepo extends RepoBase {
  // ---- reminders ----

  /** Insert a pending reminder. Returns its id. */
  createReminder(r: {
    userId: string;
    chatId: string;
    text: string;
    dueAt: number;
    repeat: ReminderRepeat;
    /** Phase 8: follow-ups resurface until closed (see ReminderRecord). */
    followup?: boolean;
  }): number {
    const res = this.exec(
      `INSERT INTO reminders(user_id, chat_id, text, due_at, repeat, state, created_at, followup)
       VALUES(?,?,?,?,?,'pending',?,?)`,
      [r.userId, r.chatId, r.text, r.dueAt, r.repeat, Date.now(), r.followup === true ? 1 : 0],
    );
    return Number(res.lastInsertRowid);
  }

  /** One reminder by id, scoped to its owner. */
  getReminder(userId: string, id: number): ReminderRecord | undefined {
    const row = this.query<ReminderRow>(
      `SELECT ${REMINDER_COLUMNS}
         FROM reminders WHERE user_id=? AND id=?`,
      [userId, id],
    )[0];
    return row ? toReminderRecord(row) : undefined;
  }

  /** A user's pending reminders, soonest first (by effective due time). */
  listReminders(userId: string, limit = 50): ReminderRecord[] {
    const safeLimit = clampInt(limit, 1, 200, 50);
    return this.query<ReminderRow>(
      `SELECT ${REMINDER_COLUMNS}
         FROM reminders WHERE user_id=? AND state='pending'
        ORDER BY COALESCE(snoozed_until, due_at) ASC, id ASC LIMIT ?`,
      [userId, safeLimit],
    ).map(toReminderRecord);
  }

  /** Count of a user's pending reminders, for the per-user cap. */
  countPendingReminders(userId: string): number {
    return (
      this.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM reminders WHERE user_id=? AND state='pending'`,
        [userId],
      )[0]?.n ?? 0
    );
  }

  /**
   * Every reminder that is due, across all owners.
   *
   * The scheduler is the only caller: it must see all users so one shared timer
   * can serve everyone.
   *
   * The effective due time is the snooze override when one is set. A
   * follow-up that was already resurfaced for its current effective due
   * time is NOT due again — it resurfaces once per due time and then waits
   * for the owner to close it or snooze it (a snooze moves the effective
   * due past `reminded_at`, which makes it eligible again).
   */
  dueReminders(now: number, limit = 50): ReminderRecord[] {
    const safeLimit = clampInt(limit, 1, 500, 50);
    return this.query<ReminderRow>(
      `SELECT ${REMINDER_COLUMNS}
         FROM reminders
        WHERE state='pending'
          AND COALESCE(snoozed_until, due_at)<=?
          AND (followup=0 OR reminded_at IS NULL
               OR reminded_at < COALESCE(snoozed_until, due_at))
        ORDER BY COALESCE(snoozed_until, due_at) ASC, id ASC LIMIT ?`,
      [now, safeLimit],
    ).map(toReminderRecord);
  }

  /**
   * Claim a reminder for delivery.
   *
   * One-shots: pending -> fired (the snooze override is consumed). The
   * UPDATE re-tests `state='pending'`, so two schedulers racing over the
   * same row produce exactly one winner. Without this a reminder could be
   * sent twice, which is worse than sending it late.
   *
   * Follow-ups: the row STAYS pending and the claim only stamps
   * `reminded_at` — the same re-test makes the resurface exactly-once per
   * effective due time (mirrors dueReminders' eligibility rule).
   */
  claimReminder(id: number, firedAt: number): boolean {
    const followup = this.exec(
      `UPDATE reminders SET reminded_at=?
        WHERE id=? AND state='pending' AND followup=1
          AND (reminded_at IS NULL OR reminded_at < COALESCE(snoozed_until, due_at))`,
      [firedAt, id],
    );
    if (followup.changes > 0) return true;
    const res = this.exec(
      `UPDATE reminders SET state='fired', fired_at=?, snoozed_until=NULL
        WHERE id=? AND state='pending' AND followup=0`,
      [firedAt, id],
    );
    return res.changes > 0;
  }

  /**
   * Snooze a pending reminder (or follow-up) to a later instant, scoped to
   * its owner. This is the phase-8 unified snooze: what used to be the
   * nudge system's separate snooze is now a reminder feature.
   *
   * `reminded_at` is cleared so a follow-up that already resurfaced fires
   * again when the snooze expires. `untilMs` must be in the future —
   * snoozing into the past would make the row immediately due again,
   * which is never what "remind me later" means.
   */
  snoozeReminder(userId: string, id: number, untilMs: number, nowMs: number = Date.now()): boolean {
    if (!Number.isInteger(id) || id <= 0) return false;
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) return false;
    const res = this.exec(
      `UPDATE reminders SET snoozed_until=?, reminded_at=NULL
        WHERE id=? AND user_id=? AND state='pending'`,
      [Math.floor(untilMs), id, userId],
    );
    return res.changes > 0;
  }

  /** Cancel a pending reminder, scoped to its owner. */
  cancelReminder(userId: string, id: number): boolean {
    const res = this.exec(
      `UPDATE reminders SET state='cancelled' WHERE id=? AND user_id=? AND state='pending'`,
      [id, userId],
    );
    return res.changes > 0;
  }

  /**
   * Replace a fired reminder's due time, for a repeating one.
   *
   * Only a `fired` row may be re-armed, so a cancelled reminder cannot be
   * resurrected by a stale scheduler pass.
   */
  rearmReminder(id: number, dueAt: number): boolean {
    const res = this.exec(
      `UPDATE reminders SET state='pending', due_at=?, fired_at=NULL, snoozed_until=NULL, reminded_at=NULL WHERE id=? AND state='fired'`,
      [dueAt, id],
    );
    return res.changes > 0;
  }

  // ---- scheduled tasks (cron) ----

  /** Insert a scheduled task. The cron expression must already be validated. */
  createTask(t: {
    name: string;
    cronExpr: string;
    timezone: string;
    actionJson: string;
    createdByUserId: string;
    nextRunAtMs: number;
    enabled?: boolean;
  }): number {
    const res = this.exec(
      `INSERT INTO scheduled_tasks(
         name, cron_expr, timezone, action_json, enabled,
         created_by_user_id, next_run_at_ms, run_count, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        t.name,
        t.cronExpr,
        t.timezone,
        t.actionJson,
        t.enabled === false ? 0 : 1,
        t.createdByUserId,
        t.nextRunAtMs,
        0,
        Date.now(),
      ],
    );
    return Number(res.lastInsertRowid);
  }

  /** One task by id, scoped to its creator. */
  getTask(userId: string, id: number): ScheduledTaskRecord | undefined {
    const row = this.query<ScheduledTaskRow>(
      `SELECT id, name, cron_expr, timezone, action_json, enabled,
              created_by_user_id, next_run_at_ms, last_run_at_ms,
              last_status, run_count, created_at
         FROM scheduled_tasks WHERE created_by_user_id=? AND id=?`,
      [userId, id],
    )[0];
    return row ? toScheduledTaskRecord(row) : undefined;
  }

  /** A creator's tasks, soonest next run first. */
  listTasks(userId: string, limit = 50): ScheduledTaskRecord[] {
    const safeLimit = clampInt(limit, 1, 200, 50);
    return this.query<ScheduledTaskRow>(
      `SELECT id, name, cron_expr, timezone, action_json, enabled,
              created_by_user_id, next_run_at_ms, last_run_at_ms,
              last_status, run_count, created_at
         FROM scheduled_tasks WHERE created_by_user_id=?
        ORDER BY next_run_at_ms ASC, id ASC LIMIT ?`,
      [userId, safeLimit],
    ).map(toScheduledTaskRecord);
  }

  /** Count of a creator's tasks, for the per-owner cap. */
  countTasks(userId: string): number {
    return (
      this.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM scheduled_tasks WHERE created_by_user_id=?`,
        [userId],
      )[0]?.n ?? 0
    );
  }

  /**
   * Update a task's editable fields, scoped to its creator.
   *
   * Only whitelisted columns are writable: the run bookkeeping columns
   * (next_run_at_ms, last_*, run_count) are the scheduler's alone and are
   * never set through here.
   */
  updateTask(
    userId: string,
    id: number,
    patch: {
      name?: string;
      cronExpr?: string;
      timezone?: string;
      actionJson?: string;
      enabled?: boolean;
      nextRunAtMs?: number;
    },
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name=?");
      params.push(patch.name);
    }
    if (patch.cronExpr !== undefined) {
      sets.push("cron_expr=?");
      params.push(patch.cronExpr);
    }
    if (patch.timezone !== undefined) {
      sets.push("timezone=?");
      params.push(patch.timezone);
    }
    if (patch.actionJson !== undefined) {
      sets.push("action_json=?");
      params.push(patch.actionJson);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled=?");
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.nextRunAtMs !== undefined) {
      sets.push("next_run_at_ms=?");
      params.push(patch.nextRunAtMs);
    }
    if (sets.length === 0) return false;
    params.push(id, userId);
    const res = this.exec(
      `UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id=? AND created_by_user_id=?`,
      params,
    );
    return res.changes > 0;
  }

  /** Delete a task, scoped to its creator. */
  deleteTask(userId: string, id: number): boolean {
    const res = this.exec(`DELETE FROM scheduled_tasks WHERE id=? AND created_by_user_id=?`, [
      id,
      userId,
    ]);
    return res.changes > 0;
  }

  /**
   * Every enabled task whose time has come, across all creators.
   *
   * The scheduler is the only caller: like dueReminders, it must see all
   * owners so one shared timer can serve everyone.
   */
  dueTasks(now: number, limit = 50): ScheduledTaskRecord[] {
    const safeLimit = clampInt(limit, 1, 500, 50);
    return this.query<ScheduledTaskRow>(
      `SELECT id, name, cron_expr, timezone, action_json, enabled,
              created_by_user_id, next_run_at_ms, last_run_at_ms,
              last_status, run_count, created_at
         FROM scheduled_tasks WHERE enabled=1 AND next_run_at_ms<=?
        ORDER BY next_run_at_ms ASC, id ASC LIMIT ?`,
      [now, safeLimit],
    ).map(toScheduledTaskRecord);
  }

  /**
   * Atomically claim a task and re-arm it in the same write.
   *
   * The UPDATE re-tests the expected next_run_at_ms, so two schedulers racing
   * over the same row produce exactly one winner — the same pattern as
   * claimReminder, minus a state column (a recurring task has no terminal
   * state to move to).
   *
   * The re-arm is written HERE, not after execution, and the new value always
   * differs from the expected one (a cron's next slot is strictly in the
   * future). That difference is load-bearing: SQLite counts matched rows as
   * changed, so a no-op compare-update could not tell the winner from the
   * loser. A crash between claim and execution loses one occurrence but can
   * never double-run it — the same trade-off as reminders, where a duplicate
   * send is worse than a late one.
   */
  claimTask(id: number, expectedNextRunAtMs: number, newNextRunAtMs: number): boolean {
    const res = this.exec(
      `UPDATE scheduled_tasks SET next_run_at_ms=?
        WHERE id=? AND next_run_at_ms=? AND enabled=1`,
      [newNextRunAtMs, id, expectedNextRunAtMs],
    );
    return res.changes > 0;
  }

  /**
   * Record a finished run's outcome.
   *
   * The next slot was already written by claimTask, so this only records
   * when, how, and how many. A crash between the two leaves the series
   * re-armed with no outcome recorded — one occurrence lost, never duplicated.
   */
  markTaskRun(id: number, r: { ranAtMs: number; status: ScheduledTaskStatus }): boolean {
    const res = this.exec(
      `UPDATE scheduled_tasks
          SET last_run_at_ms=?, last_status=?, run_count=run_count+1
        WHERE id=?`,
      [r.ranAtMs, r.status, id],
    );
    return res.changes > 0;
  }

  // ---- goals ----

  /** Insert a goal for its creator. Returns its id. */
  createGoal(g: { title: string; description?: string; createdBy: string }): number {
    const now = Date.now();
    const res = this.exec(
      `INSERT INTO goals(title, description, status, created_by, created_at_ms, updated_at_ms, done_at_ms)
       VALUES(?,?,'active',?,?,?,NULL)`,
      [g.title, g.description ?? "", g.createdBy, now, now],
    );
    return Number(res.lastInsertRowid);
  }

  /** One goal by id, scoped to its creator. */
  getGoal(userId: string, id: number): GoalRecord | undefined {
    const row = this.query<GoalRow>(
      `SELECT id, title, description, status, created_by,
              created_at_ms, updated_at_ms, done_at_ms
         FROM goals WHERE created_by=? AND id=?`,
      [userId, id],
    )[0];
    return row ? toGoalRecord(row) : undefined;
  }

  /** A creator's goals, newest first, optionally filtered by status. */
  listGoals(userId: string, status?: GoalStatus, limit = 50): GoalRecord[] {
    const safeLimit = clampInt(limit, 1, 200, 50);
    const rows =
      status === undefined
        ? this.query<GoalRow>(
            `SELECT id, title, description, status, created_by,
                    created_at_ms, updated_at_ms, done_at_ms
               FROM goals WHERE created_by=? ORDER BY id DESC LIMIT ?`,
            [userId, safeLimit],
          )
        : this.query<GoalRow>(
            `SELECT id, title, description, status, created_by,
                    created_at_ms, updated_at_ms, done_at_ms
               FROM goals WHERE created_by=? AND status=? ORDER BY id DESC LIMIT ?`,
            [userId, status, safeLimit],
          );
    return rows.map(toGoalRecord);
  }

  /** How many goals a creator has, optionally filtered by status. */
  countGoals(userId: string, status?: GoalStatus): number {
    const row =
      status === undefined
        ? this.query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM goals WHERE created_by=?`,
            [userId],
          )[0]
        : this.query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM goals WHERE created_by=? AND status=?`,
            [userId, status],
          )[0];
    return row?.n ?? 0;
  }

  /**
   * Mark an active goal done. Only an active row may be completed, and only
   * by its creator — a completed goal cannot be re-completed into a fresh
   * done_at_ms, and a row that is not yours reports false instead of moving.
   */
  completeGoal(userId: string, id: number): boolean {
    const now = Date.now();
    const res = this.exec(
      `UPDATE goals SET status='done', done_at_ms=?, updated_at_ms=?
        WHERE id=? AND created_by=? AND status='active'`,
      [now, now, id, userId],
    );
    return res.changes > 0;
  }

  // ---- heartbeat log ----

  /**
   * Append one heartbeat pass. The summary is truncated to 500 code points
   * (not UTF-16 units) so a long reply cannot bloat the log.
   */
  logHeartbeat(e: {
    summary: string;
    toolCalls: number;
    status: HeartbeatStatus;
    ranAtMs?: number;
  }): number {
    const res = this.exec(
      `INSERT INTO heartbeat_log(ran_at_ms, summary, tool_calls, status) VALUES(?,?,?,?)`,
      [
        e.ranAtMs ?? Date.now(),
        truncateSummary(e.summary),
        clampInt(e.toolCalls, 0, 1_000_000, 0),
        e.status,
      ],
    );
    return Number(res.lastInsertRowid);
  }

  /** The most recent heartbeat passes, newest first. */
  recentHeartbeats(n = 5): HeartbeatLogEntry[] {
    const safeN = clampInt(n, 1, 100, 5);
    return this.query<HeartbeatLogRow>(
      `SELECT id, ran_at_ms, summary, tool_calls, status
         FROM heartbeat_log ORDER BY id DESC LIMIT ?`,
      [safeN],
    ).map(toHeartbeatLogEntry);
  }
}

/** DDL fragment owned by this repository (phase 6). The Storage facade
 *  assembles the full SCHEMA from the domain fragments in a fixed order;
 *  the statements themselves are byte-identical to the pre-split schema. */
export const SCHEDULING_SCHEMA = `

-- Scheduled reminders. Scoped to the owner by user_id on every query, like
-- memories. The state column moves pending -> fired | cancelled, and a fired
-- reminder that repeats is re-armed in place, so what was sent stays recorded.
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  due_at     INTEGER NOT NULL,
  repeat     TEXT NOT NULL DEFAULT 'none' CHECK(repeat IN ('none','daily','weekly')),
  state      TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','fired','cancelled')),
  created_at INTEGER NOT NULL,
  fired_at   INTEGER,
  -- Phase 8 (silo merge): the follow-up ("nudge") system's rows live here.
  -- followup=1 rows stay pending after delivery (reminded_at stamped) until
  -- the owner closes them; snoozed_until overrides due_at while set.
  followup     INTEGER NOT NULL DEFAULT 0,
  snoozed_until INTEGER,
  reminded_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(state, due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(user_id, state, due_at);

-- Recurring scheduled tasks (cron expressions). Created owner-only through the
-- schedule_task tool. action_json is a structured, validated action object —
-- never code, never eval'd. next_run_at_ms is re-armed from the cron
-- expression after every run, so the row is also the schedule's queue entry.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  cron_expr          TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  action_json        TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL,
  next_run_at_ms     INTEGER NOT NULL,
  last_run_at_ms     INTEGER,
  last_status        TEXT,
  run_count          INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_next ON scheduled_tasks(enabled, next_run_at_ms);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON scheduled_tasks(created_by_user_id, enabled);

-- Persistent owner goals (Phase C2). The heartbeat keeps the agent working
-- toward them on its own; the goal tools (owner-only) manage them
-- conversationally. done_at_ms is NULL while the goal is still open. Times
-- use the _ms suffix, like the other C-phase tables.
CREATE TABLE IF NOT EXISTS goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL CHECK(length(title) >= 1 AND length(title) <= 120),
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done')),
  created_by    TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  done_at_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goals_owner_status ON goals(created_by, status, id DESC);

-- Heartbeat audit trail (Phase C2). Every heartbeat pass writes exactly one
-- row: what it did (first 500 chars of its reply), how many tools it called,
-- and whether the pass ran, failed, or was skipped. The owner can read these;
-- they are the only autonomous output a beat leaves behind.
CREATE TABLE IF NOT EXISTS heartbeat_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at_ms   INTEGER NOT NULL,
  summary     TEXT NOT NULL,
  tool_calls  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK(status IN ('ok','failed','skipped'))
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_time ON heartbeat_log(id DESC);
`;
