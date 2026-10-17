/**
 * User access service — the private-chat approval state machine.
 *
 * Why this exists: a group is gated by `GroupAccessService`, but a private chat
 * had no gate at all. Anyone who found the bot could message it and spend the
 * owner's API budget — and once the agent can browse the web and write memory,
 * an unknown account could also make it act. This is the missing gate.
 *
 * The rules deliberately mirror GroupAccessService:
 * - a user starts `pending` and is never auto-approved, not even when the owner
 *   cannot be notified;
 * - repeated messages are idempotent: only the first creates a row, and only an
 *   unnotified row triggers a notification;
 * - transitions are guarded on the current state, so a replayed or stale
 *   decision cannot apply a contradictory change;
 * - `isApproved` reads the database on every call, so revocation takes effect
 *   immediately and survives a restart with no cache to invalidate.
 *
 * The owner short-circuits all of this: the owner is always allowed, and never
 * needs a row of their own.
 *
 * This service does NOT authorize. The owner's permission to decide is checked
 * by the AdminBoundary before any mutating method here is reached.
 */
import type { Storage, GroupState, UserAccessRecord } from "../storage/storage";

export interface UserInfo {
  /** Telegram numeric user id as a string. */
  userId: string;
  /** @username, when the account has one. Cosmetic only. */
  username?: string;
  /** First name, shown to the owner when deciding. Cosmetic only. */
  firstName?: string;
}

export type UserTransition =
  | { ok: true; previous: GroupState }
  | { ok: false; reason: "not_found" | "invalid_transition" | "storage" };

export class UserAccessService {
  constructor(private readonly storage: Storage) {}

  /**
   * True only for an `approved` user.
   *
   * Read from storage every time — an unapproved user must never reach the
   * conversation engine, the AI provider, or a tool.
   */
  isApproved(userId: string): boolean {
    try {
      return this.storage.userAccess(userId)?.state === "approved";
    } catch {
      // A storage failure must not be read as approval.
      return false;
    }
  }

  /** The stored state, for diagnostics; undefined when there is no row. */
  stateOf(userId: string): GroupState | undefined {
    try {
      return this.storage.userAccess(userId)?.state;
    } catch {
      return undefined;
    }
  }

  /**
   * Record a user as pending, if they have no row yet.
   *
   * Returns whether the row was newly created, so the caller knows whether to
   * notify the owner. An existing row of any state is left untouched, which is
   * what stops a rejected user from re-requesting access by messaging again.
   */
  registerUser(u: UserInfo): { created: boolean } {
    try {
      const created = this.storage.createPendingUser({
        userId: u.userId,
        // exactOptionalPropertyTypes: omit rather than pass undefined.
        ...(u.username !== undefined ? { username: u.username } : {}),
        ...(u.firstName !== undefined ? { firstName: u.firstName } : {}),
      });
      return { created: created === "created" };
    } catch {
      return { created: false };
    }
  }

  /** The pending record, for building the owner's notification. */
  pendingUser(userId: string): UserAccessRecord | undefined {
    try {
      const row = this.storage.userAccess(userId);
      return row?.state === "pending" ? row : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the owner still needs to be told about this user.
   *
   * False once a notification has been recorded, which is what keeps an unknown
   * account from producing a notification storm by messaging repeatedly.
   */
  needsNotification(userId: string): boolean {
    const row = this.storage.userAccess(userId);
    return row !== undefined && row.notifiedAt === undefined;
  }

  /**
   * Record that the owner was notified, so a repeat message stays quiet.
   *
   * Returns false when the row vanished or the timestamp already moved on, in
   * which case a concurrent attempt won the race and must not send again.
   */
  markNotified(userId: string, expected: number | undefined): boolean {
    return this.storage.markUserNotified(userId, expected);
  }

  /** Approve a pending user. */
  approve(userId: string, ownerId: string): UserTransition {
    return this.transition(userId, "pending", "approved", ownerId);
  }

  /** Reject a pending user. */
  reject(userId: string, ownerId: string): UserTransition {
    return this.transition(userId, "pending", "rejected", ownerId);
  }

  /**
   * Revoke an approved user.
   *
   * Only `approved` may be revoked, so re-clicking a revoked button cannot
   * change state again, and a replayed approval cannot resurrect the access.
   */
  revoke(userId: string, ownerId: string): UserTransition {
    return this.transition(userId, "approved", "revoked", ownerId);
  }

  private transition(
    userId: string,
    from: GroupState,
    to: GroupState,
    ownerId: string,
  ): UserTransition {
    try {
      const row = this.storage.userAccess(userId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.state !== from) return { ok: false, reason: "invalid_transition" };

      // The UPDATE itself re-tests `from`, so a concurrent transition that
      // changes the row between the check above and the write is rejected.
      const changed = this.storage.transitionUser(userId, from, to, ownerId);
      if (!changed) return { ok: false, reason: "invalid_transition" };

      return { ok: true, previous: from };
    } catch {
      return { ok: false, reason: "storage" };
    }
  }

  /** Pending users awaiting a decision, newest first, one page at a time. */
  listPending(limit = 8, offset = 0): UserAccessRecord[] {
    return this.storage.listUsersByState("pending", limit, offset);
  }

  /** Approved users, newest first. */
  listApproved(limit = 8, offset = 0): UserAccessRecord[] {
    return this.storage.listUsersByState("approved", limit, offset);
  }

  countPending(): number {
    return this.storage.countUsersByState("pending");
  }

  countApproved(): number {
    return this.storage.countUsersByState("approved");
  }
}
