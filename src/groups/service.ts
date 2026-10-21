/**
 * Group access service — the approval state machine.
 *
 * Rules enforced here:
 * - A group starts `pending` and is never auto-approved, not even when the
 *   owner cannot be notified.
 * - Repeated membership updates are idempotent: only the first creates a row
 *   and only an unnotified row triggers a notification.
 * - Transitions are guarded on the current state, so a replayed or stale
 *   action cannot apply a contradictory change.
 * - `isApproved` reads the database on every call, so revocation takes effect
 *   immediately and survives restarts without any cache invalidation.
 *
 * This service does NOT authorize; the owner's permission is checked by the
 * admin boundary before any of these mutating methods is reached.
 */
import type { Storage, GroupState, GroupAccessRecord } from "../storage/storage";

export interface GroupInfo {
  chatId: string;
  title?: string;
  chatType: GroupAccessRecord["chatType"];
  /** Numeric id of whoever added the bot, only when genuinely known. */
  requestedBy?: string;
}

export type TransitionResult =
  | { ok: true; previous: GroupState }
  | { ok: false; reason: "not_found" | "invalid_transition" | "storage" };

export class GroupAccessService {
  constructor(private readonly storage: Storage) {}

  /**
   * True only for an `approved` group.
   *
   * Read from storage every time — an unapproved group must never reach the
   * conversation engine, the AI provider, or a tool.
   */
  isApproved(chatId: string): boolean {
    try {
      return this.storage.access.groupAccess(chatId)?.state === "approved";
    } catch {
      // A storage failure must not be read as approval.
      return false;
    }
  }

  /** The stored state for diagnostics; undefined when there is no row. */
  stateOf(chatId: string): GroupState | undefined {
    try {
      return this.storage.access.groupAccess(chatId)?.state;
    } catch {
      return undefined;
    }
  }

  /**
   * Record a group as pending, if it does not already have a row.
   *
   * Returns whether the row was newly created so the caller knows whether to
   * notify the owner; an existing row (of any state) is left untouched.
   */
  registerGroup(g: GroupInfo): { created: boolean } {
    try {
      const created = this.storage.access.createPendingGroup({
        chatId: g.chatId,
        chatType: g.chatType,
        // exactOptionalPropertyTypes: omit rather than pass undefined.
        ...(g.title !== undefined ? { title: g.title } : {}),
        ...(g.requestedBy !== undefined ? { requestedBy: g.requestedBy } : {}),
      });
      return { created: created === "created" };
    } catch {
      return { created: false };
    }
  }

  /** The pending record, for building the owner's notification. */
  pendingGroup(chatId: string): GroupAccessRecord | undefined {
    try {
      const row = this.storage.access.groupAccess(chatId);
      return row?.state === "pending" ? row : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the owner still needs to be notified about this group.
   *
   * False once a notification has been recorded, which is what keeps duplicate
   * membership updates from producing notification storms.
   */
  needsNotification(chatId: string): boolean {
    const row = this.storage.access.groupAccess(chatId);
    return row !== undefined && row.notifiedAt === undefined;
  }

  /**
   * Record that the owner was notified, so a repeat update stays quiet.
   *
   * Returns false when the row vanished or the timestamp already moved on, in
   * which case a concurrent attempt won the race and must not send again.
   */
  markNotified(chatId: string, expected: number | undefined): boolean {
    return this.storage.access.markGroupNotified(chatId, expected);
  }

  /** Record that a notification attempt failed. Never approves the group. */
  markNotificationFailed(chatId: string): void {
    // The row stays `pending` with a null `notified_at` so the next update
    // retries; nothing here changes the approval state.
    void this.storage.access.groupAccess(chatId);
  }

  /**
   * Approve a pending group.
   *
   * Only `pending` may become `approved`; an already-approved, rejected, or
   * revoked group is refused so a replay cannot resurrect a revoked group.
   */
  approve(chatId: string, ownerId: string): TransitionResult {
    return this.transition(chatId, "pending", "approved", ownerId);
  }

  /** Reject a pending group. */
  reject(chatId: string, ownerId: string): TransitionResult {
    return this.transition(chatId, "pending", "rejected", ownerId);
  }

  /**
   * Revoke an approved group.
   *
   * Only `approved` may be revoked, so re-clicking a revoked button cannot
   * change state again.
   */
  revoke(chatId: string, ownerId: string): TransitionResult {
    return this.transition(chatId, "approved", "revoked", ownerId);
  }

  private transition(
    chatId: string,
    from: GroupState,
    to: GroupState,
    ownerId: string,
  ): TransitionResult {
    try {
      const row = this.storage.access.groupAccess(chatId);
      if (!row) return { ok: false, reason: "not_found" };
      if (row.state !== from) return { ok: false, reason: "invalid_transition" };

      // The UPDATE itself re-tests `from`, so a concurrent transition that
      // changes the row between the check above and the write is rejected.
      const changed = this.storage.access.transitionGroup(chatId, from, to, ownerId);
      if (!changed) return { ok: false, reason: "invalid_transition" };

      return { ok: true, previous: from };
    } catch {
      return { ok: false, reason: "storage" };
    }
  }

  /** Pending groups awaiting a decision, newest first, one page at a time. */
  listPending(limit = 8, offset = 0): GroupAccessRecord[] {
    return this.storage.access.listGroupsByState("pending", limit, offset);
  }

  /** Approved groups, newest first. */
  listApproved(limit = 8, offset = 0): GroupAccessRecord[] {
    return this.storage.access.listGroupsByState("approved", limit, offset);
  }

  countPending(): number {
    return this.storage.access.countGroupsByState("pending");
  }

  countApproved(): number {
    return this.storage.access.countGroupsByState("approved");
  }
}
