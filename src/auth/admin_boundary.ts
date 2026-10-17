/**
 * Secure admin action boundary.
 *
 * Every administrative operation goes through `runAdmin`. The boundary:
 *  1. requires a valid actor (built from a trusted Telegram context)
 *  2. checks the required permission BEFORE doing anything else
 *  3. stops the operation entirely when denied — the handler never runs
 *  4. keeps a user-facing message separate from internal detail
 *  5. leaves the database and settings untouched on denial
 *  6. audits both the denial and the success
 *
 * This is the core only. The admin panel, approval buttons and group
 * management arrive later and will use this same boundary.
 */
import type { AuthorizationService } from "./service";
import type { AuditLogger } from "./audit";
import type { Actor } from "./roles";
import type { Permission } from "./roles";

export interface AdminRequest {
  /** Trusted actor, built by the caller from a Telegram context. */
  actor: Actor | undefined;
  /** Operation label for audit and diagnostics. */
  operation: string;
  /** Permission this operation requires. */
  permission: Permission;
  /** Optional id of the affected object, for audit only. */
  targetId?: string;
}

export type AdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "denied" | "no_identity" | "error"; message: string };

export interface AdminBoundaryOptions {
  auth: AuthorizationService;
  audit?: AuditLogger;
}

/** A short, safe message shown to a denied user. */
export const DENIED_MESSAGE = "این عملیات در دسترس شما نیست.";

export class AdminBoundary {
  private readonly auth: AuthorizationService;
  private readonly audit: AuditLogger | undefined;

  constructor(opts: AdminBoundaryOptions) {
    this.auth = opts.auth;
    this.audit = opts.audit;
  }

  /**
   * Authorize an administrative operation and run it, or refuse it.
   *
   * `decide` performs the identity and permission checks. The `handler`
   * receives the validated actor and is only ever invoked for an authorized
   * owner. When access is denied the handler does not run, so no database
   * write or settings change can occur.
   */
  runAdmin<T>(
    req: AdminRequest,
    handler: (actor: Actor) => Promise<T> | T,
  ): Promise<AdminResult<T>> {
    const actor = req.actor;
    const actorId = actor ? String(actor.id) : undefined;

    // 1. Identity must be present and complete.
    if (!actor) {
      this.audit?.admin(req.operation, actorId, "denied", req.permission, req.targetId);
      return Promise.resolve({ ok: false as const, reason: "no_identity", message: DENIED_MESSAGE });
    }

    // 2. Permission is checked at the moment of execution.
    if (!this.auth.can(actor, req.permission)) {
      this.audit?.admin(req.operation, actorId, "denied", req.permission, req.targetId);
      return Promise.resolve({ ok: false as const, reason: "denied", message: DENIED_MESSAGE });
    }

    // 3. Authorized: run it, audit the outcome, never leak internals.
    return decide(handler, actor).then((outcome) => {
      if (outcome.ok) {
        this.audit?.admin(req.operation, actorId, "success", req.permission, req.targetId);
        return { ok: true as const, data: outcome.data };
      }
      this.audit?.admin(req.operation, actorId, "error", req.permission, req.targetId);
      return {
        ok: false as const,
        reason: "error",
        message: "عملیات ناموفق بود؛ دوباره تلاش کنید.",
      };
    });
  }

  /** Synchronous form for operations that do not await anything. */
  runAdminSync<T>(req: AdminRequest, handler: (actor: Actor) => T): AdminResult<T> {
    const actor = req.actor;
    const actorId = actor ? String(actor.id) : undefined;

    if (!actor) {
      this.audit?.admin(req.operation, actorId, "denied", req.permission, req.targetId);
      return { ok: false, reason: "no_identity", message: DENIED_MESSAGE };
    }
    if (!this.auth.can(actor, req.permission)) {
      this.audit?.admin(req.operation, actorId, "denied", req.permission, req.targetId);
      return { ok: false, reason: "denied", message: DENIED_MESSAGE };
    }

    try {
      const data = handler(actor);
      this.audit?.admin(req.operation, actorId, "success", req.permission, req.targetId);
      return { ok: true, data };
    } catch {
      this.audit?.admin(req.operation, actorId, "error", req.permission, req.targetId);
      return { ok: false, reason: "error", message: "عملیات ناموفق بود؛ دوباره تلاش کنید." };
    }
  }
}

/** Await a handler without letting its exception escape. */
function decide<T>(
  handler: (actor: Actor) => Promise<T> | T,
  actor: Actor,
): Promise<{ ok: true; data: T } | { ok: false }> {
  return (async () => {
    try {
      return { ok: true as const, data: await handler(actor) };
    } catch {
      return { ok: false as const };
    }
  })();
}
