/**
 * Tool contract — the shared vocabulary for every SOL tool.
 *
 * Rules enforced by these types:
 * - A tool has a unique, stable name and a description the model can read.
 * - A tool declares whether it is enabled; disabled tools never run.
 * - A tool declares required permissions; permissions are checked at execution
 *   time by the Executor, never assumed from a tool's own claim.
 * - A tool's `run` receives already-validated input and never throws raw
 *   provider/OS errors — it throws ToolError with a safe, categorized kind.
 */

/** Status of a tool run, as reported by the Executor. */
export type ToolRunStatus =
  | "ok"
  | "invalid_input"
  | "not_found"
  | "disabled"
  | "not_allowed"
  | "error";

/** Result of running a tool through the Executor. Never contains internals. */
export interface ToolRunResult<T = unknown> {
  /** Tool that was executed. */
  tool: string;
  status: ToolRunStatus;
  /** Tool output when status === "ok". */
  data?: T;
  /** Short, user-safe message when status !== "ok". */
  message?: string;
  /** Wall-clock duration of the run, ms. */
  durationMs: number;
}

/**
 * Declarative, codec-friendly input schema.
 * Untrusted input is checked against this BEFORE the tool body runs.
 */
export type FieldType = "string" | "number" | "integer" | "boolean" | "enum" | "array";

export interface FieldSpec {
  type: FieldType;
  /** Whether the field must be present. Defaults to false (optional). */
  required?: boolean;
  /** Human-readable purpose, shown in the tool list. */
  description?: string;
  /** Allowed values for "enum". */
  choices?: readonly string[];
  /** Minimum/maximum length for strings. */
  minLength?: number;
  /** Hard cap; input longer than this is rejected before execution. */
  maxLength?: number;
  /** Minimum/maximum for numbers (inclusive). */
  minimum?: number;
  /** Maximum for numbers (inclusive). */
  maximum?: number;
  /** Allow the JSON `null` value (still optional if not required). */
  nullable?: boolean;
  /** For "array": max number of items. */
  maxItems?: number;
}

export interface ToolInputSpec {
  /** Field name → spec. Unknown fields are rejected by the validator. */
  fields: Record<string, FieldSpec>;
}

/** Access requirements a tool declares. Checked per request, not per tool. */
export interface ToolPermission {
  /** Permission keys this tool requires, e.g. "tools:calculator". */
  readonly requires: readonly string[];
}

/** A SOL tool. Implementations are pure and side-effect free by contract. */
export interface Tool<TIn, TOut> {
  /** Unique, stable, lowercase snake_case identifier. */
  readonly name: string;
  /** One-line description for humans and the model. */
  readonly description: string;
  /** When false the Executor refuses this tool outright. */
  readonly enabled: boolean;
  /** Permission requirement; the Executor checks this per request. */
  readonly permission: ToolPermission;
  /** Input contract used for validation before execution. */
  readonly input: ToolInputSpec;
  /** Execute with already-validated input. Must throw only ToolError. */
  run(input: TIn, ctx: ToolContext): Promise<TOut>;
}

/**
 * Context handed to a tool. Carries nothing secret.
 * `clock` makes time deterministic in tests; the default reads the real clock.
 */
export interface ToolContext {
  /** Current time, injectable. Tests pass a fixed Date. */
  readonly clock: () => Date;
  /** Caller identity, for auditing only — never a source of privileges. */
  readonly actor: ToolActor;
  /** Per-run abort signal, honoured by cooperative tools. */
  readonly signal: AbortSignal;
  /**
   * The conversation this run belongs to.
   *
   * Supplied by server code, never by the model, so a tool that must act on the
   * current chat (a reminder, say) can target it without the model being able to
   * name a different one. Absent when the caller has no conversation context.
   */
  readonly conversationId?: string;
}

/** Identity of the caller, supplied explicitly on each execution. */
export interface ToolActor {
  /** Stable user id. */
  readonly userId: string;
  /** Permissions granted to this actor for this request. */
  readonly permissions: readonly string[];
}

/** Validated input bag handed to a tool body. */
export type ToolInput = Record<string, unknown>;
