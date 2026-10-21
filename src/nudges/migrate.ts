/**
 * One-time data migration (platform Phase 8, silo merge): move the old
 * follow-up ("nudge") system's rows into the unified reminders table.
 *
 * Before Phase 8 the bot had two "remind me later" stores: `reminders`
 * (one-shot + repeating, fired by the ReminderScheduler) and `nudges`
 * (follow-ups that resurface until acked, fired by a separate sweep).
 * Phase 8 makes reminders the single store: a follow-up is now a reminder
 * with followup=1, snooze is a reminder feature, and closing a follow-up
 * is cancel_reminder. This module moves the data.
 *
 * Mapping (nudges -> reminders):
 * - user_id        -> user_id
 * - user_id        -> chat_id (nudges were delivered to the owner's DM,
 *                     and chat_id = user id is the platform's DM convention)
 * - text           -> text
 * - due_at_ms      -> due_at
 * - status snoozed -> snooze_until_ms copied to snoozed_until (the
 *                     effective-due override both systems share)
 * - reminded_at_ms -> reminded_at (a follow-up already resurfaced for its
 *                     current due time must not fire again — the unified
 *                     eligibility rule in SchedulingRepo.dueReminders)
 * - status acked   -> SKIPPED: an acked nudge is closed history, and the
 *                     reminders table keeps no closed follow-ups. The
 *                     count is reported so nothing vanishes silently.
 *
 * Ids are NOT preserved: the two tables have independent AUTOINCREMENT
 * sequences and a nudge id could collide with an existing reminder id.
 * Migrated rows get fresh reminder ids; list_reminders shows them like
 * any other follow-up.
 *
 * Idempotency: a `_meta` marker (`nudges_migrated_v1`) is written in the
 * same transaction as the row copies, so re-running — at boot or via
 * scripts/migrate-nudges-to-reminders.ts — is a no-op. The old `nudges`
 * table is left in place (read-only history); nothing reads it after the
 * merge, and a later cleanup can drop it.
 */
import type { Database } from "bun:sqlite";

export const NUDGES_MIGRATION_MARKER = "nudges_migrated_v1";

export interface NudgeMigrationResult {
  /** Rows copied into reminders as follow-ups. */
  migrated: number;
  /** Acked nudges skipped (closed history, not carried over). */
  skippedAcked: number;
  /** True when the marker was already present — nothing was done. */
  alreadyMigrated: boolean;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(name);
  return (row?.n ?? 0) > 0;
}

/**
 * Run the migration against a database that already has the Phase-8
 * reminders columns (Storage.open's migrate() adds them). Safe to call on
 * every boot: the marker check is one indexed read.
 */
export function migrateNudgesToReminders(db: Database): NudgeMigrationResult {
  const marker = db
    .query<{ v: string }, [string]>(`SELECT v FROM _meta WHERE k=?`)
    .get(NUDGES_MIGRATION_MARKER);
  if (marker !== null) {
    return { migrated: 0, skippedAcked: 0, alreadyMigrated: true };
  }

  if (!tableExists(db, "nudges")) {
    // Fresh database: the nudge system never existed here. Still record
    // the marker so the check stays a single read forever.
    db.run(`INSERT INTO _meta(k, v) VALUES(?, '1')`, [NUDGES_MIGRATION_MARKER]);
    return { migrated: 0, skippedAcked: 0, alreadyMigrated: false };
  }

  let migrated = 0;
  let skippedAcked = 0;
  db.transaction(() => {
    const acked = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM nudges WHERE status='acked'`,
      )
      .get();
    skippedAcked = acked?.n ?? 0;

    const res = db.run(
      `INSERT INTO reminders
         (user_id, chat_id, text, due_at, repeat, state, created_at,
          fired_at, followup, snoozed_until, reminded_at)
       SELECT user_id, user_id, text, due_at_ms, 'none', 'pending',
              created_at_ms, NULL, 1, snooze_until_ms, reminded_at_ms
         FROM nudges
        WHERE status != 'acked'`,
    );
    migrated = res.changes;

    db.run(`INSERT INTO _meta(k, v) VALUES(?, '1')`, [NUDGES_MIGRATION_MARKER]);
  })();

  return { migrated, skippedAcked, alreadyMigrated: false };
}
