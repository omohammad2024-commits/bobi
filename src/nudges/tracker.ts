/**
 * NudgeTracker — persistent store for proactive follow-ups.
 *
 * A nudge is the user's own "remember this later" request: it is stored when
 * noted and resurfaces when overdue, until the user acks it. Lifecycle:
 *   open -> reminded -> acked        (sweep delivered it; user closes it)
 *   open -> snoozed -> open/reminded (user pushed it; due time overridden)
 *   any  -> acked                    (explicit close; terminal)
 *
 * Like the D4 curator's ProposalStore, this deliberately does NOT go through
 * storage.ts (owned by another worker this batch): it is nudge bookkeeping,
 * not core storage. The table is created lazily with CREATE TABLE IF NOT
 * EXISTS on init, and the store works with any Database handle, including a
 * second connection to the same SQLite file.
 *
 * SECURITY:
 * - Every method is scoped to user_id in the SQL itself (WHERE id = ? AND
 *   user_id = ?), so acking/snoozing another user's nudge id is a no-op, not
 *   an error that leaks existence. No IDOR: ids are only ever meaningful
 *   inside the caller's own row set.
 * - The extractor never sees other users' messages; overdue nudges are
 *   delivered ONLY to the originating user (see sweep.ts).
 * - The text is the user's own words, rendered back as quoted data — never
 *   interpreted (see sweep.ts formatNudgeMessage).
 * - Caps: 50 unacked nudges per user, text ≤ 500 chars, so one runaway
 *   conversation cannot fill the table.
 */
import type { Database } from "bun:sqlite";

/** Max unacked nudges per user: one runaway loop cannot fill the table. */
export const MAX_OPEN_NUDGES_PER_USER = 50;

/** Max nudge text length, mirroring the reminder tool's ceiling. */
export const MAX_NUDGE_TEXT_LENGTH = 500;

export type NudgeStatus = "open" | "reminded" | "snoozed" | "acked";

export interface NudgeRecord {
  id: number;
  userId: string;
  text: string;
  /** unix ms when the nudge was originally due */
  dueAtMs: number;
  /** unix ms override set by snooze(), null when not snoozed */
  snoozeUntilMs: number | null;
  source: string;
  status: NudgeStatus;
  createdAtMs: number;
  remindedAtMs: number | null;
}

interface NudgeRow {
  id: number;
  user_id: string;
  text: string;
  due_at_ms: number;
  snooze_until_ms: number | null;
  source: string;
  status: string;
  created_at_ms: number;
  reminded_at_ms: number | null;
}

export interface NudgeTrackerOptions {
  /** Injectable clock, ms. Tests pass a fixed clock. */
  now?: () => number;
}

export class NudgeTracker {
  private readonly now: () => number;
  private initialized = false;

  constructor(
    private readonly db: Database,
    opts: NudgeTrackerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Create the table if it does not exist. Also called lazily by every
   * method, so a tracker used without an explicit init() still works.
   */
  init(): void {
    if (this.initialized) return;
    this.db.run(`
      CREATE TABLE IF NOT EXISTS nudges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        due_at_ms INTEGER NOT NULL,
        snooze_until_ms INTEGER,
        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'open',
        created_at_ms INTEGER NOT NULL,
        reminded_at_ms INTEGER
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_nudges_user_status_due
      ON nudges(user_id, status, due_at_ms)
    `);
    this.initialized = true;
  }

  /**
   * Store a follow-up. Throws on empty/oversize text, a bad due time, an
   * unknown user, or when the user already has 50 unacked nudges.
   */
  note(userId: string, text: string, dueAtMs: number, source = "manual"): number {
    this.init();
    if (typeof userId !== "string" || userId.length === 0 || userId === "unknown") {
      throw new Error("شناسهٔ کاربر نامعتبر است.");
    }
    const clean = text.trim();
    if (clean.length === 0) throw new Error("متن پیگیری خالی است.");
    if (clean.length > MAX_NUDGE_TEXT_LENGTH) {
      throw new Error(`متن پیگیری حداکثر ${MAX_NUDGE_TEXT_LENGTH} نویسه می‌تواند باشد.`);
    }
    if (!Number.isFinite(dueAtMs) || dueAtMs <= 0) {
      throw new Error("زمان پیگیری نامعتبر است.");
    }
    if (this.countOpen(userId) >= MAX_OPEN_NUDGES_PER_USER) {
      throw new Error(
        "پیگیری‌های باز پر است؛ ابتدا چند مورد را ببند یا به تعویق بینداز.",
      );
    }
    const src = source.trim().length > 0 ? source.trim() : "manual";
    const res = this.db
      .query(
        `INSERT INTO nudges
           (user_id, text, due_at_ms, snooze_until_ms, source, status, created_at_ms, reminded_at_ms)
         VALUES (?, ?, ?, NULL, ?, 'open', ?, NULL)`,
      )
      .run(userId, clean, Math.floor(dueAtMs), src, this.now());
    return Number(res.lastInsertRowid);
  }

  /** Overdue, unacked nudges for one user. Reminded ones are excluded: the
   *  sweep marks them `reminded` so they do not resurface every pass; the
   *  user closes them explicitly with ack(). */
  due(userId: string, nowMs: number): NudgeRecord[] {
    this.init();
    return this.db
      .query<NudgeRow, [string, number, number]>(
        `SELECT * FROM nudges
         WHERE user_id = ?
           AND status IN ('open', 'snoozed')
           AND COALESCE(snooze_until_ms, due_at_ms) <= ?
         ORDER BY COALESCE(snooze_until_ms, due_at_ms) ASC, id ASC
         LIMIT ?`,
      )
      .all(userId, nowMs, MAX_OPEN_NUDGES_PER_USER)
      .map(toRecord);
  }

  /** Overdue, unacked nudges across ALL users, oldest first — the sweep's
   *  input. Callers MUST deliver each row only to its own userId (see
   *  sweep.ts); this method never delivers anything itself. */
  dueAll(nowMs: number, limit = MAX_OPEN_NUDGES_PER_USER): NudgeRecord[] {
    this.init();
    const capped = Math.max(1, Math.min(limit, MAX_OPEN_NUDGES_PER_USER));
    return this.db
      .query<NudgeRow, [number, number]>(
        `SELECT * FROM nudges
         WHERE status IN ('open', 'snoozed')
           AND COALESCE(snooze_until_ms, due_at_ms) <= ?
         ORDER BY COALESCE(snooze_until_ms, due_at_ms) ASC, id ASC
         LIMIT ?`,
      )
      .all(nowMs, capped)
      .map(toRecord);
  }

  /** All unacked nudges for a user, soonest due first (reminded included —
   *  they still need an explicit ack). */
  list(userId: string): NudgeRecord[] {
    this.init();
    return this.db
      .query<NudgeRow, [string, number]>(
        `SELECT * FROM nudges
         WHERE user_id = ? AND status != 'acked'
         ORDER BY COALESCE(snooze_until_ms, due_at_ms) ASC, id ASC
         LIMIT ?`,
      )
      .all(userId, MAX_OPEN_NUDGES_PER_USER)
      .map(toRecord);
  }

  /** Explicit close. Ownership is in the WHERE clause: another user's id is
   *  simply not found, so there is no IDOR and no existence leak. */
  ack(id: number, userId: string): boolean {
    this.init();
    if (!Number.isInteger(id) || id <= 0) return false;
    const res = this.db
      .query(
        `UPDATE nudges SET status = 'acked'
         WHERE id = ? AND user_id = ? AND status != 'acked'`,
      )
      .run(id, userId);
    return res.changes > 0;
  }

  /**
   * Push a nudge to a later instant. `untilMs` must be in the future —
   * snoozing into the past would make the nudge immediately due again,
   * which is never what "remind me later" means.
   */
  snooze(id: number, userId: string, untilMs: number): boolean {
    this.init();
    if (!Number.isInteger(id) || id <= 0) return false;
    if (!Number.isFinite(untilMs) || untilMs <= this.now()) return false;
    const res = this.db
      .query(
        `UPDATE nudges SET status = 'snoozed', snooze_until_ms = ?
         WHERE id = ? AND user_id = ? AND status != 'acked'`,
      )
      .run(Math.floor(untilMs), id, userId);
    return res.changes > 0;
  }

  /**
   * Called by the sweep after a reminder message is built: marks the nudge
   * `reminded` so it is not re-delivered on the next pass. The row is NOT
   * deleted — the user still acks (or snoozes) it explicitly.
   */
  markReminded(id: number, userId: string): boolean {
    this.init();
    if (!Number.isInteger(id) || id <= 0) return false;
    const res = this.db
      .query(
        `UPDATE nudges SET status = 'reminded', reminded_at_ms = ?
         WHERE id = ? AND user_id = ? AND status IN ('open', 'snoozed')`,
      )
      .run(this.now(), id, userId);
    return res.changes > 0;
  }

  /** One nudge by id, only if owned by userId. */
  get(id: number, userId: string): NudgeRecord | undefined {
    this.init();
    if (!Number.isInteger(id) || id <= 0) return undefined;
    const row = this.db
      .query<NudgeRow, [number, string]>(
        `SELECT * FROM nudges WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId);
    return row === null ? undefined : toRecord(row);
  }

  countOpen(userId: string): number {
    this.init();
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM nudges WHERE user_id = ? AND status != 'acked'`,
      )
      .get(userId);
    return row?.n ?? 0;
  }
}

function toRecord(row: NudgeRow): NudgeRecord {
  return {
    id: row.id,
    userId: row.user_id,
    text: row.text,
    dueAtMs: row.due_at_ms,
    snoozeUntilMs: row.snooze_until_ms,
    source: row.source,
    status: row.status as NudgeStatus,
    createdAtMs: row.created_at_ms,
    remindedAtMs: row.reminded_at_ms,
  };
}
