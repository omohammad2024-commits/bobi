/**
 * Tool Executor — the ONLY path through which a tool runs.
 *
 * Security properties this class guarantees:
 * 1. Unknown tools never run            → not_found
 * 2. Unauthorized callers never run     → not_allowed
 * 3. Disabled tools never run           → disabled
 * 4. Input is validated BEFORE the body → invalid_input
 * 5. Permissions are re-checked on every request, never cached on the tool
 * 6. Privileges come only from `actor` (server-supplied, trusted), never from
 *    the request payload — untrusted input cannot escalate them
 * 7. Runs are bounded by concurrency and a per-run timeout
 * 8. No internal message, stack trace, or secret reaches the caller
 *
 * There is deliberately no alternative "direct run" entry point: tools are
 * private implementations reachable only through `execute`.
 */
import { ToolError, userMessageFor } from "./errors";
import type { ToolErrorKind } from "./errors";
import type { ToolRegistry } from "./registry";
import type { ToolActor, ToolContext, ToolRunResult } from "./types";
import { validateInput } from "./validate";
import type { ToolEndPayload } from "../hooks/events";

export interface ExecuteRequest {
  /** Tool name requested by the caller. Untrusted. */
  tool: string;
  /** Raw tool input. Untrusted and validated before execution. */
  input: unknown;
  /** Trusted caller identity + permissions, supplied by server code. */
  actor: ToolActor;
  /** Optional per-run timeout override, ms. */
  timeoutMs?: number;
  /**
   * Caller cancellation, when the caller has one.
   *
   * Combined with this executor's own timeout signal, so a tool is torn down
   * whether the run timed out or the user moved on. Without this, a tool started
   * by the agent loop would keep running after the user sent a newer message.
   */
  signal?: AbortSignal;
  /**
   * The conversation this run belongs to, from server-side context.
   * Never model-supplied; see ToolContext.
   */
  conversationId?: string;
  /**
   * Server-side only: suppress the `tool:end` lifecycle hook emission for
   * this execution.
   *
   * Set by the hook runner for executions a hook itself triggered — without
   * it, a hook on `tool:end` would emit another `tool:end` and recurse
   * without bound. Has NO effect on validation, permissions, timeouts, or
   * the concurrency bound; it only skips the observation callback. Never
   * model-supplied: ExecuteRequest is built by server code (the agent loop,
   * the schedulers, the hook runner), never from model output.
   */
  suppressHooks?: boolean;
}

export interface ExecutorOptions {
  registry: ToolRegistry;
  /** Max concurrent tool executions across all callers. */
  maxConcurrent?: number;
  /** Default per-run timeout, ms. */
  timeoutMs?: number;
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
  /** Optional sink for secret-free diagnostics. */
  onError?: (info: ToolFailureInfo) => void;
  /**
   * Optional observer for the `tool:end` lifecycle event, called after every
   * execution settles (ok or not) with a secret-free payload: tool name,
   * status, duration, and user id — never input or output contents.
   *
   * The callback must not throw; the executor guards the call. It is skipped
   * for executions with `suppressHooks: true` (hook-triggered runs), which
   * prevents a `tool:end` hook from re-triggering itself.
   */
  onToolEnd?: (payload: ToolEndPayload, actor: ToolActor) => void;
}

/** Secret-free diagnostic payload handed to onError. */
export interface ToolFailureInfo {
  tool: string;
  kind: string;
  userId: string;
  durationMs: number;
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly semaphore: Semaphore;
  private readonly defaultTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly onError: ((info: ToolFailureInfo) => void) | undefined;
  private readonly onToolEnd: ((payload: ToolEndPayload, actor: ToolActor) => void) | undefined;

  constructor(opts: ExecutorOptions) {
    this.registry = opts.registry;
    this.semaphore = new Semaphore(opts.maxConcurrent ?? 4);
    this.defaultTimeoutMs = opts.timeoutMs ?? 10_000;
    this.clock = opts.clock ?? (() => new Date());
    this.onError = opts.onError;
    this.onToolEnd = opts.onToolEnd;
  }

  /**
   * Execute one tool call. Never throws — always returns a ToolRunResult.
   * Any internal fault is reported as a safe "error" status.
   *
   * After the run settles, the `tool:end` lifecycle hook observer fires (when
   * configured and not suppressed). The observer can never change the result
   * or break the caller: its exceptions are swallowed.
   */
  async execute(req: ExecuteRequest): Promise<ToolRunResult> {
    const result = await this.doExecute(req);
    this.emitToolEnd(req, result);
    return result;
  }

  /** The execution itself; separated so the hook emission wraps every path. */
  private async doExecute(req: ExecuteRequest): Promise<ToolRunResult> {
    const started = Date.now();

    const tool = this.registry.find(req.tool);
    if (!tool) {
      return this.result(req, started, "not_found", userMessageFor("not_found"));
    }

    // Permission before the enabled check: an unauthorized caller learns only
    // "not allowed" about any registered name, never a tool's status.
    if (!hasPermission(tool.permission.requires, req.actor.permissions)) {
      return this.result(req, started, "not_allowed", userMessageFor("not_allowed"));
    }

    if (!tool.enabled) {
      return this.result(req, started, "disabled", userMessageFor("disabled"));
    }

    let input: Record<string, unknown>;
    try {
      input = validateInput(tool.input, req.input);
    } catch (err) {
      return this.fail(req, started, err, "invalid_input");
    }

    // Wait for a concurrency slot, then bound the actual work.
    return this.semaphore.use(async () => {
      // Per-call override wins, then the tool's own declared bound (for tools
      // that are slow by design), then the executor default.
      const timeoutMs = req.timeoutMs ?? tool.timeoutMs ?? this.defaultTimeoutMs;
      const controller = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;

      // One signal the tool observes, however the run ends: this executor's own
      // deadline, or the caller cancelling the whole agent run.
      const ctx: ToolContext = {
        clock: this.clock,
        actor: req.actor,
        signal: controller.signal,
        ...(req.conversationId !== undefined
          ? { conversationId: req.conversationId }
          : {}),
      };
      if (req.signal !== undefined) {
        if (req.signal.aborted) {
          controller.abort();
        } else {
          req.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
      }

      // Shape the work into a settled outcome so an unexpected throw and a
      // normal result travel the same path.
      const settled = (async () => {
        try {
          return { tag: "ok" as const, data: await tool.run(input, ctx) };
        } catch (err: unknown) {
          return { tag: "err" as const, err };
        }
      })();

      const timedOut = new Promise<"timeout">((resolve) => {
        deadline = setTimeout(() => {
          controller.abort();
          resolve("timeout");
        }, timeoutMs);
      });

      try {
        const outcome = await Promise.race([settled, timedOut]);

        if (outcome === "timeout") {
          // Hold the slot until the abandoned run settles, so a tool that
          // ignores its abort signal cannot outlive the concurrency bound.
          await settled;
          return this.result(req, started, "error", userMessageFor("timeout"));
        }

        if (outcome.tag === "err") {
          // A tool that rejects its own request keeps the kind it declared,
          // for the categories that are meaningful to a caller. This matters
          // for the agent loop: it feeds the status back to the model, and
          // "error" reads as "something broke, try again" while "not_allowed"
          // reads as "you may not do this" — which is what stops a retry.
          const kind =
            outcome.err instanceof ToolError ? outcome.err.kind : "internal";
          return this.fail(req, started, outcome.err, statusForKind(kind));
        }

        if (outcome.data === undefined) {
          return this.fail(
            req,
            started,
            new ToolError("invalid_result", "نتیجهٔ ابزار نامعتبر بود."),
            "error",
          );
        }

        // User-facing media rides alongside the data, never inside it: the
        // model's tool_result stays model-safe while the bot layer can still
        // deliver what the tool produced (a generated image, say).
        const media = tool.extractMedia?.(outcome.data);

        return {
          tool: req.tool,
          status: "ok",
          data: outcome.data,
          ...(media !== undefined && media.length > 0 ? { media } : {}),
          durationMs: Date.now() - started,
        };
      } finally {
        clearTimeout(deadline);
      }
    });
  }

  /** Convenience: true when the actor may run this tool right now. */
  can(toolName: string, actor: ToolActor): boolean {
    const tool = this.registry.find(toolName);
    if (!tool) return false;
    return hasPermission(tool.permission.requires, actor.permissions);
  }

  /**
   * Fire the `tool:end` lifecycle observer, if one is configured.
   *
   * Skipped for hook-triggered executions (`suppressHooks`), which prevents
   * re-entrant hook storms. Never throws: hook observation must not break the
   * tool call it observes. The payload is deliberately minimal — tool name,
   * status, duration, user id — so no input, output, or secret can leak
   * through it (see the payload privacy contract in hooks/events.ts).
   */
  private emitToolEnd(req: ExecuteRequest, result: ToolRunResult): void {
    if (req.suppressHooks === true) return;
    const cb = this.onToolEnd;
    if (!cb) return;
    try {
      cb(
        {
          event: "tool:end",
          at: new Date().toISOString(),
          tool: req.tool,
          status: result.status,
          durationMs: result.durationMs,
          userId: req.actor.userId,
        },
        req.actor,
      );
    } catch {
      // Hook observation is best-effort; the tool result stands regardless.
    }
  }

  private result(
    req: ExecuteRequest,
    started: number,
    status: ToolRunResult["status"],
    message: string,
  ): ToolRunResult {
    return { tool: req.tool, status, message, durationMs: Date.now() - started };
  }

  private fail(
    req: ExecuteRequest,
    started: number,
    err: unknown,
    status: "invalid_input" | "not_allowed" | "not_found" | "error",
  ): ToolRunResult {
    this.report(req, started, err);
    const message =
      err instanceof ToolError ? userMessageFor(err.kind) : userMessageFor("internal");
    return this.result(req, started, status, message);
  }

  private report(req: ExecuteRequest, started: number, err: unknown): void {
    if (!this.onError) return;
    this.onError({
      tool: req.tool,
      kind: err instanceof ToolError ? err.kind : "internal",
      userId: req.actor.userId,
      durationMs: Date.now() - started,
    });
  }
}

/**
 * True when every required permission is granted to the actor.
 * Reads ONLY the actor's grant list — never request input.
 */
function hasPermission(
  required: readonly string[],
  granted: readonly string[],
): boolean {
  const held = new Set(granted);
  return required.every((p) => held.has(p));
}

/**
 * Map an error kind a tool threw onto the status a caller sees.
 *
 * The kinds preserved here are the ones a MODEL can act on: a request it
 * malformed ("invalid_input"), something it may not do ("not_allowed"), and
 * something that does not exist ("not_found" — how an adapter reports that the
 * model named a tool the remote service never offered). Collapsing those into a
 * generic "error" would tell the model "something broke, try again" when the
 * truth is "you asked wrongly, change the request".
 *
 * Everything else — a timeout, a rejected result, an internal fault — stays
 * "error", because the distinction is diagnostic and belongs in the log rather
 * than in a status the model would try to act on.
 */
function statusForKind(
  kind: ToolErrorKind,
): "invalid_input" | "not_allowed" | "not_found" | "error" {
  switch (kind) {
    case "invalid_input":
      return "invalid_input";
    case "not_allowed":
      return "not_allowed";
    case "not_found":
      return "not_found";
    default:
      return "error";
  }
}

/** Counting semaphore bounding concurrent executions. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {
    if (max < 1) throw new Error("maxConcurrent must be >= 1");
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
