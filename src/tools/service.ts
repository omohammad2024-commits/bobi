/**
 * ToolService — the central place BOBI registers its default tools and the
 * internal API used to run them.
 *
 * Design notes:
 * - Built-in tools are listed in ONE barrel (plugins.ts), never imported
 *   here by name: this module knows the plugin catalog exists, not what
 *   is in it. Adding a tool = one line in plugins.ts.
 * - `runTool` requires an explicit actor (userId + permissions). The caller
 *   of this function is trusted server code; the tool input is not. This is
 *   the boundary the future Conversation Engine will call through, and it is
 *   deliberately narrow: identity and permissions go in, a ToolRunResult
 *   comes out, nothing internal escapes.
 * - Nothing here logs tool input or output.
 */
import { ToolExecutor } from "./executor";
import type { ExecuteRequest, ExecutorOptions, ToolFailureInfo } from "./executor";
import { toJsonSchema } from "./json_schema";
import { pluginTools, assertPluginCatalog, getPluginManifests } from "./plugins";
import type { ToolManifest } from "./manifest";
import type {
  ToolSearchDeps,
  VisibleToolInfo,
} from "./tool_search";
import { ToolRegistry } from "./registry";
import type { Tool, ToolActor, ToolRunResult } from "./types";
import type { ToolSpec } from "../ai/provider";

/**
 * Tools that always ship, in menu order — the statically constructible
 * plugins from the barrel (plugins.ts). Factory tools and `web_search`
 * (which needs a configured provider) are built by the composition
 * root and registered via ToolServiceOptions.extraTools. Listing a
 * tool the model cannot use would spend context and invite a request
 * that fails.
 */
export const DEFAULT_TOOLS: readonly Tool<unknown, unknown>[] = pluginTools;

export interface ToolServiceOptions {
  /** Extra or replacement tools, registered after the defaults. */
  extraTools?: readonly Tool<unknown, unknown>[];
  maxConcurrent?: number;
  timeoutMs?: number;
  clock?: () => Date;
  onError?: (info: ToolFailureInfo) => void;
  /**
   * Observer for the `tool:end` lifecycle event, forwarded to the Executor.
   * The hook runner is wired here by index.ts.
   */
  onToolEnd?: ExecutorOptions["onToolEnd"];
}

export interface ToolDescriptor {
  name: string;
  description: string;
  enabled: boolean;
  requires: readonly string[];
  /** Desk-card short "what" (from the tool's manifest, when attached). */
  purpose?: string;
  /** Desk-card short "when to pick it up" (from the manifest, when attached). */
  useWhen?: string;
}

/** One entry of the toolset taxonomy: a toolset name and its tool names. */
export interface ToolsetInfo {
  name: string;
  tools: string[];
}

export interface ToolRunRequest {
  tool: string;
  input: unknown;
  actor: ToolActor;
  timeoutMs?: number;
  /** Caller cancellation, threaded to the tool's own abort signal. */
  signal?: AbortSignal;
}

export class ToolService {
  readonly registry: ToolRegistry;
  readonly executor: ToolExecutor;
  /**
   * Toolsets the model currently sees, or undefined for "all toolsets".
   *
   * When set, `toolSpecsFor` (and everything derived from it, including
   * `searchableTools` for tool_search) includes only tools whose `toolset`
   * is in this list, plus tools with NO toolset — those are core tools and
   * are always visible. Default undefined = pre-E4 behaviour, no filtering.
   */
  private activeToolsets: readonly string[] | undefined;

  constructor(opts: ToolServiceOptions = {}) {
    // Boot assert: a malformed or duplicated plugin manifest fails the
    // service construction (and therefore the boot), naming the file.
    assertPluginCatalog();
    this.registry = new ToolRegistry();
    for (const tool of [...DEFAULT_TOOLS, ...(opts.extraTools ?? [])]) {
      this.registry.register(tool);
    }
    this.executor = new ToolExecutor({
      registry: this.registry,
      // exactOptionalPropertyTypes: omit keys rather than pass undefined.
      ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
      ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
      ...(opts.onToolEnd !== undefined ? { onToolEnd: opts.onToolEnd } : {}),
    });
  }

  /** Internal API: run a tool as a specific, already-authorized identity. */
  runTool(req: ToolRunRequest): Promise<ToolRunResult> {
    return this.executor.execute({
      tool: req.tool,
      input: req.input,
      actor: req.actor,
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
  }

  /** Internal API: raw ExecuteRequest form, for the future engine boundary. */
  execute(req: ExecuteRequest): Promise<ToolRunResult> {
    return this.executor.execute(req);
  }

  /** True when this actor may run the tool right now. */
  can(toolName: string, actor: ToolActor): boolean {
    return this.executor.can(toolName, actor);
  }

  /**
   * Restrict which toolsets the model sees.
   *
   * Pass undefined (the default) to show every registered tool — the
   * pre-E4 behaviour, so this is a no-op for existing callers. Pass a list
   * of toolset names to show only tools in those toolsets; tools with NO
   * toolset declared are core tools and stay visible regardless.
   *
   * This is an ergonomic filter like `toolSpecsFor`, never the security
   * boundary: the Executor still checks permissions independently.
   */
  setActiveToolsets(names: string[] | undefined): void {
    this.activeToolsets = names === undefined ? undefined : [...names];
  }

  /** Toolsets currently declared across the registry, with their tool names. */
  listToolsets(): ToolsetInfo[] {
    const groups = new Map<string, string[]>();
    for (const tool of this.registry.list()) {
      if (tool.toolset === undefined) continue; // core tools: no toolset
      const names = groups.get(tool.toolset) ?? [];
      names.push(tool.name);
      groups.set(tool.toolset, names);
    }
    return [...groups.entries()].map(([name, tools]) => ({ name, tools }));
  }

  /** True when a tool passes the active-toolsets filter (undefined = all). */
  private toolsetVisible(tool: Tool<unknown, unknown>): boolean {
    return (
      this.activeToolsets === undefined ||
      tool.toolset === undefined ||
      this.activeToolsets.includes(tool.toolset)
    );
  }

  /** Active tools, for menus and for the model. Not an authorization grant. */
  listActive(): readonly ToolDescriptor[] {
    return this.registry
      .list()
      .filter((t) => t.enabled)
      .map((t) => ({
        name: t.name,
        description: t.description,
        enabled: t.enabled,
        requires: t.permission.requires,
        // Desk-card short forms from the attached manifest, when present
        // (exactOptionalPropertyTypes: omit the keys when absent).
        ...(t.manifest !== undefined
          ? { purpose: t.manifest.purpose, useWhen: t.manifest.useWhen }
          : {}),
      }));
  }

  /** Names of active tools, in registration order. */
  listActiveNames(): readonly string[] {
    return this.registry.listActiveNames();
  }

  /**
   * Tool definitions for a model request, filtered to what this actor may run.
   *
   * The filter is `can()`, which reads only the actor's server-supplied grants.
   * A tool omitted here is one the model is never told about, so it cannot be
   * requested by mistake — and if it requests one anyway, the Executor refuses
   * it independently. This is an ergonomic filter, never the security boundary.
   */
  /**
   * The full built-in plugin manifest catalog — the router's hint space.
   *
   * Served through the service (not a bare barrel import) so modules that
   * load before service.ts (conversation engine, router) can reach the
   * catalog without creating a module-evaluation cycle: service.ts is the
   * side of the cycle that must evaluate the barrel first, so every other
   * consumer goes through it. A construction-time field, not a method:
   * the service's method surface is pinned by test (nothing on it may
   * hand out a tool), and a metadata snapshot does not belong there.
   */
  readonly pluginCatalog: readonly ToolManifest[] = getPluginManifests();

  toolSpecsFor(actor: ToolActor): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const tool of this.registry.list()) {
      if (!tool.enabled) continue;
      if (!this.can(tool.name, actor)) continue;
      if (!this.toolsetVisible(tool)) continue;
      specs.push({
        name: tool.name,
        description: tool.description,
        parameters: toJsonSchema(tool.input),
      });
    }
    return specs;
  }

  /**
   * Actor-visible tool metadata for dynamic discovery (tool_search).
   *
   * Applies the EXACT same filter as `toolSpecsFor` — enabled, permitted for
   * this actor, and within the active toolsets — but carries the toolset and
   * the declarative input fields instead of JSON Schema, which is what the
   * search needs to rank and describe.
   *
   * SECURITY: this is the ONLY data tool_search may search. Wire the tool
   * with `(actor) => service.searchableTools(actor)` (see ToolSearchDeps);
   * never hand it `registry.list()` directly, because the raw registry
   * includes ownerOnly tools a non-owner must not even know exist.
   */
  searchableTools(actor: ToolActor): VisibleToolInfo[] {
    const out: VisibleToolInfo[] = [];
    for (const tool of this.registry.list()) {
      if (!tool.enabled) continue;
      if (!this.can(tool.name, actor)) continue;
      if (!this.toolsetVisible(tool)) continue;
      out.push({
        name: tool.name,
        description: tool.description,
        // exactOptionalPropertyTypes: omit the key rather than pass undefined.
        ...(tool.toolset !== undefined ? { toolset: tool.toolset } : {}),
        fields: Object.entries(tool.input.fields).map(([name, field]) => ({
          name,
          type: field.type,
          required: field.required === true,
        })),
      });
    }
    return out;
  }

  /**
   * Deps for wiring a `tool_search` tool against THIS service.
   *
   * `toolService.toolSearchDeps()` returns `{ visibleTools: (actor) =>
   * toolService.searchableTools(actor) }` — the actor-filtered viewer the
   * security model requires (see `searchableTools`). Prefer this over
   * hand-rolling the closure.
   */
  toolSearchDeps(): ToolSearchDeps {
    return { visibleTools: (actor) => this.searchableTools(actor) };
  }
}
