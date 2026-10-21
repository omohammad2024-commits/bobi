/**
 * One-time migration script (platform Phase 8): move the old `nudges`
 * table's rows into the unified `reminders` table of a BOBI database.
 *
 * Usage:
 *   bun scripts/migrate-nudges-to-reminders.ts <path-to-bobi.db>
 *
 * Run it against a COPY first to verify the counts, then against the real
 * database (the bot also runs the same migration idempotently at boot, so
 * running this by hand is a verification step, not a requirement).
 * Opening the database through Storage.open applies the Phase-8 column
 * migrations before the row copy runs. The copy itself is idempotent:
 * a `_meta` marker makes any second run a no-op.
 */
import { Storage } from "../src/storage/storage";
import { migrateNudgesToReminders } from "../src/nudges/migrate";

const path = process.argv[2];
if (path === undefined || path.length === 0) {
  console.error("usage: bun scripts/migrate-nudges-to-reminders.ts <path-to-bobi.db>");
  process.exit(2);
}

const storage = Storage.open(path);
try {
  const result = migrateNudgesToReminders(storage.database);
  if (result.alreadyMigrated) {
    console.log("already migrated (marker present); nothing done.");
  } else {
    console.log(
      `migrated ${result.migrated} follow-up(s) into reminders; ` +
        `skipped ${result.skippedAcked} acked (closed) nudge(s).`,
    );
  }
} finally {
  storage.close();
}
