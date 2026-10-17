/**
 * Authorization core — roles, typed permissions, and the central checks.
 *
 * Everything that decides "may this actor do this?" lives here. Callers do
 * not reach into role tables themselves; they call `can()`. This keeps the
 * policy in one place and testable without Telegram, storage, or the bot.
 *
 * Default posture: DENY. An actor with no role, an unknown role, a missing
 * permission, or an incomplete identity has no access. The owner is granted
 * permissions explicitly, which also means adding a new permission never
 * silently grants it to anyone.
 */

export type Role = "owner" | "user" | "unknown";

/** Explicit, typed permission strings used across SOL. */
export type Permission =
  | "tools.use"
  | "settings.manage"
  | "groups.review"
  | "groups.manage"
  | "users.manage"
  | "admin.view";

/** Every permission SOL knows about, in a stable order. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  "tools.use",
  "settings.manage",
  "groups.review",
  "groups.manage",
  "users.manage",
  "admin.view",
] as const;

/** What each role may do. Deny-by-default: absent key means no access. */
const ROLE_GRANTS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: [
    "tools.use",
    "settings.manage",
    "groups.review",
    "groups.manage",
    "users.manage",
    "admin.view",
  ],
  user: ["tools.use"],
  unknown: [],
} as const;

/** True when a string is one of SOL's known permissions. */
export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/** Permissions implied by a role. Unknown roles grant nothing. */
export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_GRANTS[role] ?? [];
}

/**
 * An actor is a server-side identity, never user-controlled data.
 *
 * `id` is the Telegram NUMERIC user id read from a trusted context. Nothing
 * a user types, clicks, or asks the model to emit contributes to this record,
 * so a crafted message cannot change role, id, or permissions.
 */
export interface Actor {
  /** Telegram numeric user id, from a trusted source. */
  readonly id: number;
  /** Optional display label for logs. Never used for authorization. */
  readonly label?: string;
}

export interface AuthorizationPolicy {
  /** Whether this actor is the configured owner. */
  isOwner(actor: Actor): boolean;
}

/** Resolve an actor's role from server-side facts only. */
export function roleOf(policy: AuthorizationPolicy, actor: Actor): Role {
  if (policy.isOwner(actor)) return "owner";
  return "user";
}

/**
 * The central permission check.
 *
 * Called at execution time for each sensitive operation — not merely when a
 * button is drawn or a menu is built — so a revoked or ineligible actor is
 * refused at the moment the work would actually happen.
 */
export function can(
  policy: AuthorizationPolicy,
  actor: Actor | undefined,
  permission: Permission,
): boolean {
  // Incomplete identity: no access at all.
  if (!actor) return false;
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0) return false;

  const role = roleOf(policy, actor);
  return permissionsForRole(role).includes(permission);
}

/** Convenience wrapper that throws a typed error when access is denied. */
export class AuthorizationDenied extends Error {
  constructor(
    readonly permission: Permission,
    readonly actorId: number | undefined,
  ) {
    super("permission denied");
    this.name = "AuthorizationDenied";
  }
}

/** Check a permission and throw AuthorizationDenied when it is missing. */
export function requirePermission(
  policy: AuthorizationPolicy,
  actor: Actor | undefined,
  permission: Permission,
): void {
  if (!can(policy, actor, permission)) {
    throw new AuthorizationDenied(permission, actor?.id);
  }
}
