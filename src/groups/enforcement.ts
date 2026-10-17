/**
 * Group access enforcement — the gate every group update passes through.
 *
 * This is deliberately a plain function over a minimal shape so it can be
 * unit-tested without a Telegram context, and so there is exactly one place
 * that decides whether an incoming update from a group may proceed.
 *
 * The check happens BEFORE the conversation engine, the AI provider, or any
 * tool is reached, and reads group state on every call. An unapproved group
 * therefore cannot reach reasoning even through another update type, because
 * every route funnels through here first.
 */
import type { GroupAccessService } from "./service";
import type { GroupState } from "../storage/storage";

/** The minimal chat/update shape this needs, so tests need no grammY context. */
export interface AccessSubject {
  chatType: string;
  chatId: string;
}

export type AccessDecision =
  | { allowed: true }
  /** Group is not approved; the caller should not process the update. */
  | { allowed: false; state: "pending" | "rejected" | "revoked" | "unknown" };

/** Chat types this gate applies to. Private chats are never gated here. */
const GATED_TYPES: ReadonlySet<string> = new Set(["group", "supergroup"]);

/**
 * Chat types that deliberately bypass group approval.
 *
 * - private: group policy must never affect one-to-one conversations.
 * - channel: the approval workflow covers group membership only. SOL has no
 *   channel handler in this phase, so a channel update reaches no reasoning
 *   path either way; the exemption is stated here rather than falling through
 *   implicitly, so the policy is explicit and reviewable.
 */
const EXEMPT_TYPES: ReadonlySet<string> = new Set(["private", "channel", "sender"]);

/** True when the update type is subject to group approval. */
export function isGatedChat(chatType: string): boolean {
  return GATED_TYPES.has(chatType);
}

/**
 * Decide whether an incoming update may be processed.
 *
 * Private chats and channels never depend on group approval — private
 * behavior stays independent of the group workflow.
 */
export function checkGroupAccess(
  groups: GroupAccessService,
  subject: AccessSubject,
): AccessDecision {
  // Private chat / channel: unaffected by group policy.
  if (!isGatedChat(subject.chatType)) return { allowed: true };

  if (groups.isApproved(subject.chatId)) return { allowed: true };

  // Report the stored state when there is one so logs can be precise. An
  // approved group would have returned above, so any state here (including a
  // missing row or a closed database) is a denial.
  const state = groups.stateOf(subject.chatId);
  const denied: Exclude<GroupState, "approved"> | "unknown" =
    state === undefined || state === "approved" ? "unknown" : state;
  return { allowed: false, state: denied };
}

/** Sanitized note for an operator; never contains message content. */
export function denialNote(subject: AccessSubject, decision: AccessDecision): string {
  if (decision.allowed) return "";
  return `group ${subject.chatId} not approved (state=${decision.state})`;
}
