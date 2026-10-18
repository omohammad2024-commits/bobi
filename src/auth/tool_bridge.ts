/**
 * Authorization → tool-system bridge.
 *
 * The tool layer already takes an actor plus a permission list and checks
 * them per execution. This module derives that actor FROM the Authorization
 * Core, so there is exactly one permission system, not two.
 *
 * The mapping is deliberately narrow:
 *   - every authorized user gets the tools they may use
 *   - the tools' own permission keys come from the Registry, which already
 *     requires `tools:<name>` for each tool
 *   - the Authorization Core decides whether this actor holds `tools.use`
 *
 * Because the permission list is built here from server-side facts, a
 * request payload can never contribute to it. Administrative tools (added in
 * a later phase) will require their own authorization permission and will
 * therefore be refused for ordinary users by default.
 */
import type { ToolActor, Tool } from "../tools/types";
import type { AuthorizationService } from "./service";
import type { Actor, Permission } from "./roles";

/** The permission that gates tool use at all. */
export const TOOLS_USE: Permission = "tools.use";

export interface ToolAuthorization {
  actor: Actor | undefined;
  /** Permission strings the actor currently holds for tool execution. */
  permissions: readonly string[];
  /** Whether this actor may use tools at all. */
  allowed: boolean;
}

/**
 * Resolve what tools an actor may run, right now.
 *
 * This is evaluated per call, so a change in role or ownership takes effect
 * on the next operation without any cached grant surviving it.
 */
export function authorizeToolUse(
  auth: AuthorizationService,
  actor: Actor | undefined,
  registeredTools: readonly Tool<unknown, unknown>[],
): ToolAuthorization {
  // Incomplete identity → no tools, full stop.
  if (!actor || !auth.can(actor, TOOLS_USE)) {
    return { actor, permissions: [], allowed: false };
  }

  // Grant the tool permission keys for the tools that exist. The Executor
  // still requires both an enabled tool and the matching key at run time.
  const keys: string[] = [];
  for (const tool of registeredTools) {
    if (!tool.enabled) continue;
    // Owner-only tools are withheld from everyone else: without the key the
    // Executor refuses them, and the model is never told they exist.
    if (tool.ownerOnly === true && !auth.isOwner(actor)) continue;
    for (const key of tool.permission.requires) keys.push(key);
  }

  return { actor, permissions: keys, allowed: true };
}

/** Build the tool-layer actor from an authorization actor and its grants. */
export function toToolActor(result: ToolAuthorization): ToolActor {
  return {
    userId: String(result.actor?.id ?? "unknown"),
    permissions: result.permissions,
  };
}
