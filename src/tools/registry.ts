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
      .filter((t) => t.enabled)
      .map((t) => t.name);
  }

  /** Number of registered tools (enabled or not). */
  get size(): number {
    return this.tools.size;
  }
}
