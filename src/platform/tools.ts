/**
 * ToolsFacade — the platform's tools surface: a thin, honest wrapper over
 * the ToolService. Delegation only; no new logic lives here.
 */
import type { ToolService, ToolRunRequest } from "../tools/service";
import type { ToolRegistry } from "../tools/registry";
import type { ToolRunResult } from "../tools/types";

export class ToolsFacade {
  constructor(readonly service: ToolService) {}

  /** The underlying ToolService handle. */
  get handle(): ToolService {
    return this.service;
  }

  get registry(): ToolRegistry {
    return this.service.registry;
  }

  /** The registry's tool list, exactly as ToolService exposes it. */
  list() {
    return this.service.registry.list();
  }

  listActiveNames(): readonly string[] {
    return this.service.listActiveNames();
  }

  runTool(req: ToolRunRequest): Promise<ToolRunResult> {
    return this.service.runTool(req);
  }
}
