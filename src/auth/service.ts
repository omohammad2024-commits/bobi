/**
 * AuthorizationService — binds the OwnerIdentity to the role policy and is
 * the object the rest of BOBI depends on.
 *
 * It exposes the two central entry points used everywhere:
 *   isOwner(actor) — "is this the owner?"
 *   can(actor, permission) — "may this actor do this, right now?"
 *
 * Both take a server-built Actor. There is no path that accepts a username,
 * a chat id, a callback string, or model output in place of the numeric id.
 */
import { OwnerIdentity } from "./identity";
import {
  can,
  isPermission,
  roleOf,
  type Actor,
  type AuthorizationPolicy,
  type Permission,
  type Role,
} from "./roles";

export interface ActorInput {
  /** Telegram numeric user id from a trusted source. */
  id: number | undefined;
  /** Optional label for diagnostics. Never authoritative. */
  label?: string;
}

export class AuthorizationService implements AuthorizationPolicy {
  readonly identity: OwnerIdentity;

  constructor(ownerIdentity: OwnerIdentity) {
    this.identity = ownerIdentity;
  }

  /** Central owner check, by numeric id only. */
  isOwner(actor: Actor | undefined): boolean {
    if (!actor) return false;
    return this.identity.isOwner(actor.id);
  }

  /** Resolve a role for a server-supplied actor. */
  roleFor(actor: Actor | undefined): Role {
    if (!actor) return "unknown";
    return roleOf(this, actor);
  }

  /** Central permission check. Deny-by-default. */
  can(actor: Actor | undefined, permission: Permission): boolean {
    return can(this, actor, permission);
  }

  /**
   * Build an Actor from a trusted numeric id.
   *
   * `undefined` (or a non-safe-integer) yields no actor, so an incomplete
   * identity can never be mistaken for an authorized one.
   */
  actorFrom(input: ActorInput): Actor | undefined {
    const id = input.id;
    if (id === undefined) return undefined;
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    return input.label !== undefined ? { id, label: input.label } : { id };
  }

  /**
   * Actor for a Telegram update, taken from the trusted `from.id` field.
   *
   * This is the ONLY sanctioned way the bot creates an actor. Identity comes
   * from `from.id` alone; `username` is accepted only as a cosmetic label and
   * can never substitute for the numeric id. Message text, callback data and
   * chat id are not identity at all.
   */
  actorFromTelegramUser(
    from: { id?: number | null; username?: string } | undefined,
  ): Actor | undefined {
    const raw = from?.id;
    if (typeof raw !== "number") return undefined;
    const label = from?.username;
    return this.actorFrom({
      id: raw,
      ...(label !== undefined && label.length > 0 ? { label } : {}),
    });
  }

  /** True when a permission string is one BOBI recognizes. */
  isKnownPermission(value: string): boolean {
    return isPermission(value);
  }
}
