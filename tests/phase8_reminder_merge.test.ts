/**
 * Phase 8 (silo merge) — storage-level proof.
 *
 * The follow-up ("nudge") system folds into reminders:
 * - follow-up rows live in the reminders table (followup=1), stay pending
 *   after delivery (reminded_at stamped), and resurface once per due time;
 * - snooze is a reminder feature (snoozed_until effective-due override);
 * - the one-time data migration moves legacy `nudges` rows into the
 *   reminders table — verified here on a database COPY built with the
 *   pre-merge schema, then opened through the real Storage facade.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbHandle } from "../src/storage/db_handle";
import { Storage } from "../src/storage/storage";
import { SCHEDULING_SCHEMA, SchedulingRepo } from "../src/storage/repos/scheduling";
import { migrateNudgesToReminders } from "../src/nudges/migrate";

function schedulingRepo(): SchedulingRepo {
  const h = new DbHandle(new Database(":memory:"));
  h.execScript(SCHEDULING_SCHEMA);
  return new SchedulingRepo(h);
}

describe("follow-up reminders in the unified store", () => {
  test("follow-up claim stamps reminded_at and keeps the row pending, exactly once per due time", () => {
    const repo = schedulingRepo();
    const id = repo.createReminder({
      userId: "u1", chatId: "u1", text: "pay the installment", dueAt: 1000,
      repeat: "none", followup: true,
    });
    const rec = repo.getReminder("u1", id);
    expect(rec?.followup).toBe(true);

    expect(repo.dueReminders(2000).map((r) => r.id)).toContain(id);
    expect(repo.claimReminder(id, 2000)).toBe(true);

    const after = repo.getReminder("u1", id);
    expect(after?.state).toBe("pending");
    expect(after?.remindedAt).toBe(2000);
    // Already resurfaced for this due time: not due again, claim refuses.
    expect(repo.dueReminders(3000).map((r) => r.id)).not.toContain(id);
    expect(repo.claimReminder(id, 3000)).toBe(false);
  });

  test("snoozing a follow-up moves its effective due and makes it fire again after the snooze", () => {
    const repo = schedulingRepo();
    const id = repo.createReminder({
      userId: "u1", chatId: "u1", text: "call the bank", dueAt: 1000,
      repeat: "none", followup: true,
    });
    expect(repo.claimReminder(id, 2000)).toBe(true); // resurfaced once
    expect(repo.snoozeReminder("u1", id, 10_000, 2000)).toBe(true);

    const rec = repo.getReminder("u1", id);
    expect(rec?.snoozedUntil).toBe(10_000);
    expect(rec?.remindedAt).toBeUndefined();
    expect(repo.dueReminders(9_999).map((r) => r.id)).not.toContain(id);
    expect(repo.dueReminders(10_000).map((r) => r.id)).toContain(id);
    expect(repo.claimReminder(id, 10_000)).toBe(true);
  });

  test("snooze also postpones a plain reminder; another user's snooze is a no-op", () => {
    const repo = schedulingRepo();
    const id = repo.createReminder({
      userId: "u1", chatId: "c1", text: "meeting", dueAt: 1000, repeat: "none",
    });
    expect(repo.snoozeReminder("someone-else", id, 5000, 500)).toBe(false);
    expect(repo.snoozeReminder("u1", id, 500, 500)).toBe(false); // into the past
    expect(repo.snoozeReminder("u1", id, 5000, 500)).toBe(true);
    expect(repo.dueReminders(4999).map((r) => r.id)).not.toContain(id);
    expect(repo.dueReminders(5000).map((r) => r.id)).toContain(id);
    // Firing consumes the snooze override.
    expect(repo.claimReminder(id, 5000)).toBe(true);
    const rec = repo.getReminder("u1", id);
    expect(rec?.state).toBe("fired");
    expect(rec?.snoozedUntil).toBeUndefined();
  });

  test("closing a follow-up is a cancel: the row leaves the pending set", () => {
    const repo = schedulingRepo();
    const id = repo.createReminder({
      userId: "u1", chatId: "u1", text: "done soon", dueAt: 1000,
      repeat: "none", followup: true,
    });
    expect(repo.cancelReminder("u1", id)).toBe(true);
    expect(repo.dueReminders(5000).map((r) => r.id)).not.toContain(id);
    expect(repo.listReminders("u1").map((r) => r.id)).not.toContain(id);
  });
});

describe("nudge -> reminder data migration (on a database copy)", () => {
  const LEGACY_NUDGES_DDL = `
    CREATE TABLE nudges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      due_at_ms INTEGER NOT NULL,
      snooze_until_ms INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'open',
      created_at_ms INTEGER NOT NULL,
      reminded_at_ms INTEGER
    )`;
  // Pre-Phase-8 reminders table: no followup/snoozed_until/reminded_at yet.
  const LEGACY_REMINDERS_DDL = `
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      repeat TEXT NOT NULL DEFAULT 'none',
      state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      fired_at INTEGER
    )`;

  function legacyDbCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), "bobi-phase8-migration-"));
    const path = join(dir, "bobi.db");
    const db = new Database(path);
    db.run(LEGACY_NUDGES_DDL);
    db.run(LEGACY_REMINDERS_DDL);
    const ins = db.query(
      `INSERT INTO nudges(user_id, text, due_at_ms, snooze_until_ms, source, status, created_at_ms, reminded_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("42", "open follow-up", 1000, null, "tool", "open", 900, null);
    ins.run("42", "snoozed follow-up", 1000, 8000, "manual", "snoozed", 900, null);
    ins.run("42", "already reminded", 1000, null, "tool", "reminded", 900, 5000);
    ins.run("42", "closed long ago", 1000, null, "tool", "acked", 900, 4000);
    db.run(
      `INSERT INTO reminders(user_id, chat_id, text, due_at, repeat, state, created_at)
       VALUES ('42', '42', 'plain reminder', 2000, 'none', 'pending', 950)`,
    );
    db.close();
    return path;
  }

  test("rows move, acked are skipped, reminded state survives, re-run is a no-op", () => {
    const path = legacyDbCopy();
    try {
      // Opening through Storage applies the Phase-8 columns to the copy.
      const storage = Storage.open(path);
      try {
        const first = migrateNudgesToReminders(storage.database);
        expect(first.alreadyMigrated).toBe(false);
        expect(first.migrated).toBe(3);
        expect(first.skippedAcked).toBe(1);

        const rows = storage.scheduling.listReminders("42", 50);
        expect(rows.length).toBe(4); // 3 migrated + 1 pre-existing plain
        const byText = new Map(rows.map((r) => [r.text, r]));
        expect(byText.get("plain reminder")?.followup).toBe(false);

        const open = byText.get("open follow-up");
        expect(open?.followup).toBe(true);
        expect(open?.chatId).toBe("42"); // DM convention: chat_id = user_id
        expect(open?.dueAt).toBe(1000);

        const snoozed = byText.get("snoozed follow-up");
        expect(snoozed?.snoozedUntil).toBe(8000);

        const reminded = byText.get("already reminded");
        expect(reminded?.remindedAt).toBe(5000);
        // ...and it does not become due again for its old due time.
        expect(
          storage.scheduling.dueReminders(6000).map((r) => r.text),
        ).not.toContain("already reminded");

        expect(byText.has("closed long ago")).toBe(false);

        const second = migrateNudgesToReminders(storage.database);
        expect(second.alreadyMigrated).toBe(true);
        expect(second.migrated).toBe(0);
        expect(storage.scheduling.listReminders("42", 50).length).toBe(4);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("a database that never had nudges migrates as a clean no-op", () => {
    const storage = Storage.open(":memory:");
    try {
      const res = migrateNudgesToReminders(storage.database);
      expect(res).toEqual({ migrated: 0, skippedAcked: 0, alreadyMigrated: false });
      const again = migrateNudgesToReminders(storage.database);
      expect(again.alreadyMigrated).toBe(true);
    } finally {
      storage.close();
    }
  });
});
