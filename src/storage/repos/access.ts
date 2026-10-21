/**
 * AccessRepo — Access control + audit log repository (phase 6).
 *
 * Owns the SQL for: audit_log, group_access, user_access.
 * Extracted from the old Storage god class; method bodies are unchanged,
 * only their home moved. Row shapes stay inside the storage layer.
 */

import { RepoBase } from "./base";
import { clampInt } from "./base";

export type AuditOutcome = "success" | "denied" | "error";

/** Group approval lifecycle. */
export type GroupState = "pending" | "approved" | "rejected" | "revoked";

export interface GroupAccessRecord {
  /** Telegram chat id as a string — the stable unique key. */
  chatId: string;
  /** Group title, when Telegram provided one. */
  title?: string;
  chatType: "group" | "supergroup" | "channel";
  state: GroupState;
  /** Numeric id of whoever added the bot, only when genuinely known. */
  requestedBy?: string;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
  /** unix ms — set on approve/reject/revoke. */
  decidedAt?: number;
  /** Numeric owner id that took the decision. */
  decidedBy?: string;
  /** unix ms — set once the owner has been notified. */
  notifiedAt?: number;
}

/**
 * Private-chat user approval, mirroring {@link GroupAccessRecord}.
 *
 * A private chat has no other gate, so this is what stands between an unknown
 * Telegram account and the owner's API budget.
 */
export interface UserAccessRecord {
  /** Telegram numeric user id as a string — the stable unique key. */
  userId: string;
  /** Telegram @username, when the account has one. Cosmetic only. */
  username?: string;
  /** Telegram first name, shown to the owner when deciding. Cosmetic only. */
  firstName?: string;
  state: GroupState;
  /** unix ms */
  requestedAt: number;
  /** unix ms */
  updatedAt: number;
  /** unix ms — set on approve/reject/revoke. */
  decidedAt?: number;
  /** Numeric owner id that took the decision. */
  decidedBy?: string;
  /** unix ms — set once the owner has been notified. */
  notifiedAt?: number;
}

export interface AuditEvent {
  id: number;
  /** unix ms */
  createdAt: number;
  operation: string;
  actorId?: string;
  outcome: AuditOutcome;
  targetId?: string;
  detail?: string;
}

/**
 * Hard cap on audit rows. Oldest rows are pruned once the count exceeds this,
 * which bounds file growth without an external scheduler.
 */
const AUDIT_MAX_ROWS = 5000;

/** Raw row shape shared by the group-access queries. */
interface GroupRow {
  chat_id: string;
  title: string | null;
  chat_type: string;
  state: string;
  requested_by: string | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
  notified_at: number | null;
}

/** Raw row shape for the user-access queries. */
interface UserRow {
  user_id: string;
  username: string | null;
  first_name: string | null;
  state: string;
  requested_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
  notified_at: number | null;
}

/** Map a user row to a record, omitting nulls (exactOptionalPropertyTypes). */
function toUserRecord(r: UserRow): UserAccessRecord {
  return {
    userId: r.user_id,
    state: r.state as GroupState,
    requestedAt: r.requested_at,
    updatedAt: r.updated_at,
    ...(r.username !== null ? { username: r.username } : {}),
    ...(r.first_name !== null ? { firstName: r.first_name } : {}),
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
    ...(r.decided_by !== null ? { decidedBy: r.decided_by } : {}),
    ...(r.notified_at !== null ? { notifiedAt: r.notified_at } : {}),
  };
}

/** Map a row to a record, omitting nulls (exactOptionalPropertyTypes). */
function toGroupRecord(r: GroupRow): GroupAccessRecord {
  return {
    chatId: r.chat_id,
    chatType: r.chat_type as GroupAccessRecord["chatType"],
    state: r.state as GroupState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.requested_by !== null ? { requestedBy: r.requested_by } : {}),
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
    ...(r.decided_by !== null ? { decidedBy: r.decided_by } : {}),
    ...(r.notified_at !== null ? { notifiedAt: r.notified_at } : {}),
  };
}

export class AccessRepo extends RepoBase {
  // ---- audit log ----

  /**
   * Append one security audit event, then prune to the retention cap.
   *
   * `actorId` and `targetId` are ids, not message content. `detail` is a
   * short, caller-supplied note that must already be free of secrets — this
   * layer stores only what it is given and never reads user messages.
   */
  appendAudit(event: {
    operation: string;
    outcome: "success" | "denied" | "error";
    actorId?: string;
    targetId?: string;
    detail?: string;
  }): number {
    const res = this.exec(
      `INSERT INTO audit_log(created_at, operation, actor_id, outcome, target_id, detail)
       VALUES(?,?,?,?,?,?)`,
      [
        Date.now(),
        event.operation,
        event.actorId ?? null,
        event.outcome,
        event.targetId ?? null,
        event.detail ?? null,
      ],
    );
    this.pruneAudit();
    return Number(res.lastInsertRowid);
  }

  /** Newest-first audit events, capped at `limit`. */
  auditEvents(limit = 100): AuditEvent[] {
    const rows = this.query<{
      id: number;
      created_at: number;
      operation: string;
      actor_id: string | null;
      outcome: string;
      target_id: string | null;
      detail: string | null;
    }>(
      `SELECT id, created_at, operation, actor_id, outcome, target_id, detail
         FROM audit_log ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      operation: r.operation,
      outcome: r.outcome as AuditOutcome,
      ...(r.actor_id !== null ? { actorId: r.actor_id } : {}),
      ...(r.target_id !== null ? { targetId: r.target_id } : {}),
      ...(r.detail !== null ? { detail: r.detail } : {}),
    }));
  }

  /** Drop the oldest rows so at most AUDIT_MAX_ROWS remain. */
  private pruneAudit(): void {
    this.exec(
      `DELETE FROM audit_log WHERE id NOT IN (
         SELECT id FROM audit_log ORDER BY id DESC LIMIT ?
       )`,
      [AUDIT_MAX_ROWS],
    );
  }

  // ---- group access ----

  /**
   * Fetch one group record by chat id, or undefined.
   * Used on every group update so access never relies on a stale cache.
   */
  groupAccess(chatId: string): GroupAccessRecord | undefined {
    const rows = this.query<GroupRow>(
      `SELECT chat_id, title, chat_type, state, requested_by,
              created_at, updated_at, decided_at, decided_by, notified_at
         FROM group_access WHERE chat_id=?`,
      [chatId],
    );
    const r = rows[0];
    if (!r) return undefined;
    return toGroupRecord(r);
  }

  /**
   * Insert a pending record for a chat that has no row yet.
   *
   * Returns "created" only for the first insert, so repeated membership
   * updates cannot produce duplicate pending rows or repeat notifications.
   */
  createPendingGroup(g: {
    chatId: string;
    title?: string;
    chatType: GroupAccessRecord["chatType"];
    requestedBy?: string;
  }): "created" | "exists" {
    const existing = this.groupAccess(g.chatId);
    if (existing) return "exists";

    const now = Date.now();
    this.exec(
      `INSERT INTO group_access(chat_id, title, chat_type, state, requested_by, created_at, updated_at)
       VALUES(?,?,?,'pending',?,?,?)`,
      [g.chatId, g.title ?? null, g.chatType, g.requestedBy ?? null, now, now],
    );
    return "created";
  }

  /**
   * Move a group to a new state.
   *
   * The WHERE clause re-tests the expected current state, so a replayed or
   * stale action finds no row to update and reports false instead of applying
   * a contradictory transition. Returns whether the row was changed.
   */
  transitionGroup(chatId: string, expected: GroupState, to: GroupState, decidedBy: string): boolean {
    const res = this.exec(
      `UPDATE group_access
          SET state=?, decided_at=?, decided_by=?, updated_at=?
        WHERE chat_id=? AND state=?`,
      [to, Date.now(), decidedBy, Date.now(), chatId, expected],
    );
    return res.changes > 0;
  }

  /** List groups by state, newest first, with a capped page size. */
  listGroupsByState(state: GroupState, limit = 10, offset = 0): GroupAccessRecord[] {
    // A query that escapes the cap or goes negative is clamped, not guessed at.
    const safeLimit = clampInt(limit, 1, 50, 10);
    const safeOffset = clampInt(offset, 0, 10000, 0);
    const rows = this.query<GroupRow>(
      `SELECT chat_id, title, chat_type, state, requested_by,
              created_at, updated_at, decided_at, decided_by, notified_at
         FROM group_access WHERE state=?
        ORDER BY updated_at DESC, chat_id ASC LIMIT ? OFFSET ?`,
      [state, safeLimit, safeOffset],
    );
    return rows.map(toGroupRecord);
  }

  /** Count of groups in a state — bounded, cheap status information. */
  countGroupsByState(state: GroupState): number {
    return this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM group_access WHERE state=?`,
      [state],
    )[0]?.n ?? 0;
  }

  /**
   * Mark that the owner has already been notified for this group.
   * Conditioned on the stored timestamp so a concurrent retry cannot reset it.
   */
  markGroupNotified(chatId: string, onlyIf: number | undefined): boolean {
    const res =
      onlyIf === undefined
        ? this.exec(`UPDATE group_access SET notified_at=? WHERE chat_id=?`, [
            Date.now(),
            chatId,
          ])
        : this.exec(
            `UPDATE group_access SET notified_at=? WHERE chat_id=? AND notified_at IS ?`,
            [Date.now(), chatId, onlyIf],
          );
    return res.changes > 0;
  }

  // ---- user access ----

  /**
   * Fetch one private-chat user record, or undefined.
   * Read on every message so revocation takes effect immediately.
   */
  userAccess(userId: string): UserAccessRecord | undefined {
    const rows = this.query<UserRow>(
      `SELECT user_id, username, first_name, state,
              requested_at, updated_at, decided_at, decided_by, notified_at
         FROM user_access WHERE user_id=?`,
      [userId],
    );
    const r = rows[0];
    if (!r) return undefined;
    return toUserRecord(r);
  }

  /**
   * Insert a pending record for a user who has no row yet.
   *
   * Returns "created" only for the first insert, so repeated messages cannot
   * produce duplicate rows or repeat owner notifications.
   */
  createPendingUser(u: {
    userId: string;
    username?: string;
    firstName?: string;
  }): "created" | "exists" {
    if (this.userAccess(u.userId)) return "exists";

    const now = Date.now();
    this.exec(
      `INSERT INTO user_access(user_id, username, first_name, state, requested_at, updated_at)
       VALUES(?,?,?,'pending',?,?)`,
      [u.userId, u.username ?? null, u.firstName ?? null, now, now],
    );
    return "created";
  }

  /**
   * Move a user to a new state.
   *
   * The WHERE clause re-tests the expected current state, so a replayed or
   * stale decision finds no row to update and reports false instead of applying
   * a contradictory transition.
   */
  transitionUser(userId: string, expected: GroupState, to: GroupState, decidedBy: string): boolean {
    const res = this.exec(
      `UPDATE user_access
          SET state=?, decided_at=?, decided_by=?, updated_at=?
        WHERE user_id=? AND state=?`,
      [to, Date.now(), decidedBy, Date.now(), userId, expected],
    );
    return res.changes > 0;
  }

  /** List users by state, newest activity first, with a capped page size. */
  listUsersByState(state: GroupState, limit = 10, offset = 0): UserAccessRecord[] {
    const safeLimit = clampInt(limit, 1, 50, 10);
    const safeOffset = clampInt(offset, 0, 10000, 0);
    const rows = this.query<UserRow>(
      `SELECT user_id, username, first_name, state,
              requested_at, updated_at, decided_at, decided_by, notified_at
         FROM user_access WHERE state=?
        ORDER BY updated_at DESC, user_id ASC LIMIT ? OFFSET ?`,
      [state, safeLimit, safeOffset],
    );
    return rows.map(toUserRecord);
  }

  /** Count of users in a state. */
  countUsersByState(state: GroupState): number {
    return this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_access WHERE state=?`,
      [state],
    )[0]?.n ?? 0;
  }

  /**
   * Mark that the owner has already been notified about this user.
   * Conditioned on the stored timestamp so a concurrent retry cannot reset it.
   */
  markUserNotified(userId: string, onlyIf: number | undefined): boolean {
    const res =
      onlyIf === undefined
        ? this.exec(`UPDATE user_access SET notified_at=? WHERE user_id=?`, [Date.now(), userId])
        : this.exec(
            `UPDATE user_access SET notified_at=? WHERE user_id=? AND notified_at IS ?`,
            [Date.now(), userId, onlyIf],
          );
    return res.changes > 0;
  }
}

/** DDL fragment owned by this repository (phase 6). The Storage facade
 *  assembles the full SCHEMA from the domain fragments in a fixed order;
 *  the statements themselves are byte-identical to the pre-split schema. */
export const ACCESS_SCHEMA = `

-- Security audit trail. Append-only, kept small by a retention cap enforced
-- on write. Message content is never stored here — only operation metadata.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  operation   TEXT NOT NULL,
  actor_id    TEXT,
  outcome     TEXT NOT NULL CHECK(outcome IN ('success','denied','error')),
  target_id   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(id DESC);

-- Group access approvals. One row per Telegram group, keyed by chat id.
-- requested_by / decided_by hold numeric Telegram user ids, stored only when
-- genuinely known; group titles are chat metadata, not message content.
-- notified_at guards against duplicate owner notifications on retries.
CREATE TABLE IF NOT EXISTS group_access (
  chat_id      TEXT PRIMARY KEY,
  title        TEXT,
  chat_type    TEXT NOT NULL CHECK(chat_type IN ('group','supergroup','channel')),
  state        TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','revoked')),
  requested_by TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT,
  notified_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_group_state ON group_access(state, updated_at DESC);

-- Private-chat user approvals. Mirrors group_access deliberately: the same
-- state machine, the same guarded transitions, the same "never auto-approved"
-- rule. Without this, anyone who finds the bot can spend the owner's API
-- budget, because a private chat has no other gate.
CREATE TABLE IF NOT EXISTS user_access (
  user_id      TEXT PRIMARY KEY,
  username     TEXT,
  first_name   TEXT,
  state        TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','revoked')),
  requested_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT,
  notified_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_state ON user_access(state, updated_at DESC);
`;
