/**
 * Private-chat user enforcement — the gate every direct message passes through.
 *
 * Group updates already pass through `checkGroupAccess`. This is the matching
 * gate for one-to-one chats, which previously had none: anyone who found the
 * bot could reach the engine and spend the owner's API budget.
 *
 * Like the group gate, this is a plain function over a minimal shape so it can
 * be unit-tested without a Telegram context, and it reads state on every call
 * so a revocation takes effect on the very next message.
 *
 * The owner is exempt: the owner never needs approval from themselves.
 */
import type { UserAccessService } from "./user_service";
import type { GroupState } from "../storage/storage";

/** The minimal update shape this needs, so tests need no grammY context. */
export interface UserSubject {
  /** Telegram numeric user id as a string, from the trusted `from.id`. */
  userId: string;
  /** Whether this actor is the owner. Always true for the configured owner. */
  isOwner: boolean;
  /**
   * Chat type. Only private chats are gated here: a group has its own gate,
   * and its members are decided by group approval rather than per user.
   */
  chatType: string;
}

export type UserAccessDecision =
  | { allowed: true }
  /** User is not approved; the caller must not process the update. */
  | { allowed: false; state: "pending" | "rejected" | "revoked" | "unknown" };

/**
 * Decide whether a direct message may be processed.
 *
 * Returns `allowed` for the owner and for any non-private chat. Everything else
 * needs an `approved` row.
 */
export function checkUserAccess(
  users: UserAccessService,
  subject: UserSubject,
): UserAccessDecision {
  // The owner is never gated by their own approval table.
  if (subject.isOwner) return { allowed: true };

  // Groups and channels have their own gate; gating them per-user here would
  // make one unapproved member silently disable the whole group.
  if (subject.chatType !== "private") return { allowed: true };

  if (users.isApproved(subject.userId)) return { allowed: true };

  // An approved user returned above, so any state here (including a missing
  // row or a closed database) is a denial.
  const state = users.stateOf(subject.userId);
  const denied: Exclude<GroupState, "approved"> | "unknown" =
    state === undefined || state === "approved" ? "unknown" : state;
  return { allowed: false, state: denied };
}

/** Sanitized note for an operator; never contains message content. */
export function userDenialNote(
  subject: UserSubject,
  decision: UserAccessDecision,
): string {
  if (decision.allowed) return "";
  return `user ${subject.userId} not approved (state=${decision.state})`;
}
