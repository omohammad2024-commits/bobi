/**
 * Tool Registry — the single catalog of tools.
 *
 * Responsibilities:
 * - register a tool and reject duplicate names
 * - find a tool by name
 * - list active (enabled) tools for menus and the model
 *
 * Desk-card contract (platform Phase 1): a tool that carries a manifest
 * (desk card) may only register with a COMPLETE card — an incomplete
 * card is a registration error, thrown here, never a silent degradation
 * of the model's tool desk. Tools with no card at all are external
 * adapters (MCP); they are never desk/catalog entries and never
 * intent-router candidates (see types.ts).
 *
 * The Registry does NOT decide permissions and does NOT run tools — that is
 * the Executor's job. Keeping lookup and execution separate means a tool
 * appearing in the list never implies the caller may run it.
 */
import type { Tool } from "./types";
import { validateManifest } from "./validate_manifest";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<never, never>>();
  /**
   * Owner-disabled tool names (platform Phase 10, the Mini App desk view).
   *
   * A Tool's own `enabled` flag is a build-time property of the tool; this
   * set is the owner's runtime override on top of it, persisted by the
   * wiring (bootstrap) and flipped from the Mini App. A name in this set
   * makes the tool inactive EVERYWHERE the registry's `isEnabled` is
   * consulted — model specs, tool_search, menus, and Executor dispatch —
   * while the tool stays registered, so re-enabling is instant and its
   * desk card never disappears from the owner's desk view.
   */
  private readonly ownerDisabled = new Set<string>();

  /** Register a tool. Throws on a duplicate name or an incomplete desk card. */
  register<TIn extends Record<string, unknown>, TOut>(
    tool: Tool<TIn, TOut>,
  ): this {
    const name = tool.name;
    if (name.length === 0) {
      throw new Error("tool name must not be empty");
    }
    if (this.tools.has(name)) {
      throw new Error(`duplicate tool name: ${name}`);
    }
    if (tool.manifest !== undefined) {
      const problems = validateManifest(tool.manifest);
      if (problems.length > 0) {
        throw new Error(
          `tool "${name}": incomplete desk card — fix the manifest:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
        );
      }
      if (tool.manifest.id !== name) {
        throw new Error(
          `tool "${name}": desk card id "${tool.manifest.id}" does not match the tool name.`,
        );
      }
    }
    this.tools.set(name, tool as unknown as Tool<never, never>);
    return this;
  }

  /** True when a tool with this name is registered (enabled or not). */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Find a registered tool. Returns undefined for unknown names so the
   * Executor can produce a "not found" result rather than a raw failure.
   */
  find<TIn extends Record<string, unknown>, TOut>(
    name: string,
  ): Tool<TIn, TOut> | undefined {
    const tool = this.tools.get(name);
    return tool as unknown as Tool<TIn, TOut> | undefined;
  }

  /** All registered tools, registration order preserved. */
  list(): readonly Tool<never, never>[] {
    return [...this.tools.values()];
  }

  /** Names of registered tools that are enabled, in registration order. */
  listActiveNames(): readonly string[] {
    return this.list()
      .filter((t) => this.isEnabled(t))
      .map((t) => t.name);
  }

  /**
   * Effective enabled state: the tool's own flag AND the owner's desk
   * override. Every "may this tool be offered or run" decision in the
   * service and the executor goes through here, never through
   * `tool.enabled` directly.
   */
  isEnabled(tool: { name: string; enabled: boolean }): boolean {
    return tool.enabled && !this.ownerDisabled.has(tool.name);
  }

  /**
   * Flip the owner's desk override for a registered tool. Returns false
   * for an unknown name (nothing was changed), true otherwise.
   */
  setDisabled(name: string, disabled: boolean): boolean {
    if (!this.tools.has(name)) return false;
    if (disabled) this.ownerDisabled.add(name);
    else this.ownerDisabled.delete(name);
    return true;
  }

  /** True when the owner has desk-disabled this (registered) tool name. */
  isDisabled(name: string): boolean {
    return this.ownerDisabled.has(name);
  }

  /** The owner-disabled names, in the order they were disabled. */
  disabledNames(): readonly string[] {
    return [...this.ownerDisabled];
  }

  /** Number of registered tools (enabled or not). */
  get size(): number {
    return this.tools.size;
  }
}
