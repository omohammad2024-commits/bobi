/**
 * ToolService — the central place BOBI registers its default tools and the
 * internal API used to run them.
 *
 * Design notes:
 * - Tools are registered here, in one list, so a new tool needs one line.
 * - `runTool` requires an explicit actor (userId + permissions). The caller
 *   of this function is trusted server code; the tool input is not. This is
 *   the boundary the future Conversation Engine will call through, and it is
 *   deliberately narrow: identity and permissions go in, a ToolRunResult
 *   comes out, nothing internal escapes.
 * - Nothing here logs tool input or output.
 */
import { calculatorTool } from "./calculator";
import { dateTimeTool } from "./date_time";
import { ToolExecutor } from "./executor";
import type { ExecuteRequest, ToolFailureInfo } from "./executor";
import { fetchUrlTool } from "./fetch_url";
import { toJsonSchema } from "./json_schema";
import { unitConverterTool } from "./unit_converter";
import { textUtilitiesTool } from "./text_utilities";
import { ToolRegistry } from "./registry";
import type { Tool, ToolActor, ToolRunResult } from "./types";
import type { ToolSpec } from "../ai/provider";

/**
 * Tools that always ship, in menu order.
 *
 * `web_search` is absent on purpose: it needs a configured provider, so it is
 * built and registered at the call site only when one exists. Listing a tool
 * the model cannot use would spend context and invite a request that fails.
 */
export const DEFAULT_TOOLS: readonly Tool<unknown, unknown>[] = [
  calculatorTool,
  dateTimeTool,
  textUtilitiesTool,
  unitConverterTool,
  fetchUrlTool,
] as unknown as readonly Tool<unknown, unknown>[];

export interface ToolServiceOptions {
  /** Extra or replacement tools, registered after the defaults. */
  extraTools?: readonly Tool<unknown, unknown>[];
  maxConcurrent?: number;
  timeoutMs?: number;
  clock?: () => Date;
  onError?: (info: ToolFailureInfo) => void;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  enabled: boolean;
  requires: readonly string[];
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

  constructor(opts: ToolServiceOptions = {}) {
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
  toolSpecsFor(actor: ToolActor): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const tool of this.registry.list()) {
      if (!tool.enabled) continue;
      if (!this.can(tool.name, actor)) continue;
      specs.push({
        name: tool.name,
        description: tool.description,
        parameters: toJsonSchema(tool.input),
      });
    }
    return specs;
  }
}
