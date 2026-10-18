/**
 * Private-chat user enforcement — the gate every direct message passes through.
 *
 * Two-tier access model: public chat is OPEN, so this gate only stops the
 * owner's explicit ban/mute decisions. Group updates already pass through
 * `checkGroupAccess`; this is the matching per-user gate for one-to-one
 * chats.
 *
 * State semantics (persisted in the user_access table):
 * - `rejected` → BANNED: the caller must refuse with one short, polite line.
 * - `revoked`  → MUTED: the caller must silently drop the update, no reply.
 * - anything else (no row, `pending`, `approved`) → allowed.
 *
 * Like the group gate, this is a plain function over a minimal shape so it can
 * be unit-tested without a Telegram context, and it reads state on every call
 * so a ban/mute takes effect on the very next message.
 *
 * The owner is exempt: the owner is never gated by their own table.
 */
import type { UserAccessService } from "./user_service";

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
  /**
   * Banned (`rejected`) — refuse with one short, polite line — or muted
   * (`revoked`) — drop silently. The caller decides the reply behaviour.
   */
  | { allowed: false; state: "rejected" | "revoked" };

/**
 * Decide whether a direct message may be processed.
 *
 * Returns `allowed` for the owner, for any non-private chat, and for every
 * user the owner has not explicitly banned or muted. Only `rejected`
 * (banned) and `revoked` (muted) rows deny; a missing row or any other state
 * is a public user in good standing.
 */
export function checkUserAccess(
  users: UserAccessService,
  subject: UserSubject,
): UserAccessDecision {
  // The owner is never gated by their own table.
  if (subject.isOwner) return { allowed: true };

  // Groups and channels have their own gate; gating them per-user here would
  // make one muted member silently disable the whole group.
  if (subject.chatType !== "private") return { allowed: true };

  const state = users.stateOf(subject.userId);
  if (state === "rejected") return { allowed: false, state: "rejected" };
  if (state === "revoked") return { allowed: false, state: "revoked" };
  return { allowed: true };
}

/** Sanitized note for an operator; never contains message content. */
export function userDenialNote(
  subject: UserSubject,
  decision: UserAccessDecision,
): string {
  if (decision.allowed) return "";
  return `user ${subject.userId} blocked (state=${decision.state})`;
}
