/**
 * HookRunner — executes lifecycle hooks when events fire.
 *
 * A hook is a validated tool action (see loader.ts). When an event fires,
 * every hook registered for that event runs its tool action through the normal
 * ToolService path — the same Executor the agent loop uses, with the same
 * validation, permission checks, concurrency bound, and per-tool timeout.
 *
 * SECURITY MODEL (read before touching this file):
 *
 *  1. SAME ACTOR, NO ESCALATION. A hook action runs as the actor of the
 *     triggering turn — the exact identity the turn was authorized for. A
 *     hook can never reach tools its actor may not run: the Executor checks
 *     permissions per call, independently of what the hook file says. The
 *     ONLY exception is `startup`, which has no turn; the caller (index.ts)
 *     passes the owner actor explicitly, because boot-time hooks are
 *     owner-installed configuration (same trusted tier as skills).
 *  2. NO RE-ENTRANCY. Hook-triggered executions set `suppressHooks` on their
 *     ExecuteRequest, so a `tool:end` hook cannot trigger itself forever.
 *     Without this, one hook on `tool:end` would be an infinite loop.
 *  3. FAILURE ISOLATION. Hooks run sequentially; one hook throwing, timing
 *     out, or returning a non-ok status is logged and the rest still run.
 *     runHooks itself never throws — a hook must never break the turn that
 *     triggered it.
 *  4. CAPS. At most MAX_HOOKS_PER_EVENT hooks run per event (extras are
 *     skipped with a warning). Each execution is bounded by the tool's own
 *     timeout via the Executor.
 *  5. Hook results go nowhere: they are logged (status only), never fed back
 *     to the model and never sent to any chat. Hooks observe; they do not
 *     converse.
 */
import type { ToolService } from "../tools/service";
import type { ToolActor } from "../tools/types";
import { isHookEvent } from "./events";
import type { HookEvent, HookPayload } from "./events";
import { HookCache } from "./loader";
import type { HookDef, HookWarnings } from "./loader";

/** Maximum hooks executed for one event firing. Extras are skipped with a warning. */
export const MAX_HOOKS_PER_EVENT = 5;

export interface HookRunnerOptions extends HookWarnings {
  /**
   * Hooks roots to scan, each shaped `<root>/<event>/*.md`.
   * The bot's own hooks dir plus, conventionally, nothing else — plugin hooks
   * arrive parsed via `extraHooks`.
   */
  hookDirs?: readonly string[];
  /**
   * Pre-parsed hook definitions merged after the scanned ones (plugin hooks).
   * On an (event, name) collision the scanned hook wins and the extra is
   * skipped with a warning, so a plugin can never shadow the owner's hooks.
   */
  extraHooks?: readonly HookDef[];
}

export interface HookRunContext {
  /**
   * Tool service used to execute hook actions. When absent, hooks are still
   * loaded but their actions are skipped with a warning (there is nothing
   * safe to run them through).
   */
  tools?: ToolService;
  /**
   * The triggering turn's actor. Hook actions run AS THIS ACTOR — it is the
   * caller's job to supply the right one (the turn's actor, or the owner for
   * `startup`).
   */
  actor: ToolActor;
  /** Caller cancellation, threaded to each hook execution. */
  signal?: AbortSignal;
}

/** Structural type the engine holds, so tests can inject a spy without a runner. */
export interface HookRunnerLike {
  runHooks(event: HookEvent, payload: HookPayload, ctx: HookRunContext): Promise<void>;
}

function defaultWarn(message: string, fields?: Record<string, unknown>): void {
  console.warn(`[hooks] ${message}`, fields !== undefined ? fields : "");
}

export class HookRunner implements HookRunnerLike {
  private readonly caches: HookCache[];
  private readonly extraHooks: readonly HookDef[];
  private readonly warn: (message: string, fields?: Record<string, unknown>) => void;

  constructor(opts: HookRunnerOptions = {}) {
    this.warn = opts.warn ?? defaultWarn;
    const warnOpt = { warn: this.warn };
    this.caches = (opts.hookDirs ?? []).map((dir) => new HookCache(dir, warnOpt));
    this.extraHooks = opts.extraHooks ?? [];
  }

  /** All loaded hook definitions, scanned plus extras, for diagnostics. */
  defs(): HookDef[] {
    return this.merge(this.caches.flatMap((c) => c.hooks()), this.extraHooks);
  }

  /** Hooks registered for one event, in deterministic (event, name) order. */
  defsFor(event: HookEvent): HookDef[] {
    return this.defs().filter((h) => h.event === event);
  }

  /**
   * Run every hook registered for `event`. Never throws: per-hook failures
   * are logged and the rest still run.
   */
  async runHooks(event: HookEvent, payload: HookPayload, ctx: HookRunContext): Promise<void> {
    if (!isHookEvent(event)) {
      this.warn("ignoring unknown hook event", { event });
      return;
    }
    if (payload.event !== event) {
      this.warn("hook payload event mismatch; skipping run", {
        requested: event,
        payload: payload.event,
      });
      return;
    }

    const defs = this.defsFor(event);
    if (defs.length === 0) return;

    if (ctx.tools === undefined) {
      this.warn("hooks skipped: no tool service available", { event, count: defs.length });
      return;
    }

    const limited = defs.slice(0, MAX_HOOKS_PER_EVENT);
    if (defs.length > limited.length) {
      this.warn("too many hooks for event; extras skipped", {
        event,
        total: defs.length,
        ran: limited.length,
        max: MAX_HOOKS_PER_EVENT,
      });
    }

    // Sequential, not parallel: deterministic order and no stampede of
    // concurrent tool executions from a single event.
    for (const def of limited) {
      await this.runOne(def, payload, ctx);
    }
  }

  private async runOne(def: HookDef, payload: HookPayload, ctx: HookRunContext): Promise<void> {
    const tools = ctx.tools!;
    try {
      // suppressHooks: this execution was triggered BY a hook, so it must not
      // emit tool:end itself — otherwise a tool:end hook would recurse
      // without bound. Same actor as the triggering turn: no escalation.
      const result = await tools.execute({
        tool: def.action.tool,
        input: def.action.input,
        actor: ctx.actor,
        // exactOptionalPropertyTypes: omit rather than pass undefined.
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        suppressHooks: true,
      });
      if (result.status !== "ok") {
        // Status only — never input, output, or message. See events.ts.
        this.warn("hook action did not succeed", {
          hook: def.name,
          event: payload.event,
          tool: def.action.tool,
          status: result.status,
          durationMs: result.durationMs,
        });
      }
    } catch (err) {
      // The Executor's execute() never throws by contract, but a custom
      // ToolService (or a future change) might — isolation holds regardless.
      this.warn("hook action threw; continuing with remaining hooks", {
        hook: def.name,
        event: payload.event,
        tool: def.action.tool,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  /**
   * Merge scanned and extra hooks. On an (event, name) collision the FIRST
   * source wins — scanned hooks (the owner's own hooks dir) before plugin
   * extras — and the loser is skipped with a warning.
   */
  private merge(scanned: HookDef[], extra: readonly HookDef[]): HookDef[] {
    const seen = new Set<string>();
    const out: HookDef[] = [];
    for (const def of [...scanned, ...extra]) {
      const key = `${def.event}\0${def.name}`;
      if (seen.has(key)) {
        this.warn("duplicate hook name for event; keeping the first", {
          event: def.event,
          name: def.name,
          source: def.source,
        });
        continue;
      }
      seen.add(key);
      out.push(def);
    }
    return out;
  }
}
