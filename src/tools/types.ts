/**
 * Tool contract — the shared vocabulary for every BOBI tool.
 *
 * Rules enforced by these types:
 * - A tool has a unique, stable name and a description the model can read.
 * - A tool declares whether it is enabled; disabled tools never run.
 * - A tool declares required permissions; permissions are checked at execution
 *   time by the Executor, never assumed from a tool's own claim.
 * - A tool's `run` receives already-validated input and never throws raw
 *   provider/OS errors — it throws ToolError with a safe, categorized kind.
 */
import type { ContentPart } from "../ai/provider";

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
  /**
   * The tool's own specific failure reason, when it threw a ToolError.
   *
   * `message` stays the generic per-kind string (a stable contract other
   * layers localize); `reason` carries the concrete, user-safe explanation
   * the tool itself gave ("That link is private…", "…larger than the 50 MB
   * limit") so the model can tell the user the truth instead of guessing
   * from a status word. Set ONLY from ToolError messages — a raw Error's
   * text never travels here (it may hold paths, payloads, secrets).
   */
  reason?: string;
  /**
   * Media the tool produced for the end user (e.g. a generated image).
   *
   * Shown to the user by the bot layer; it is NOT fed back to the model as
   * data. The tool's `data` must stay model-safe (no raw base64 blobs) — the
   * bytes travel here instead, via the tool's `extractMedia`.
   */
  media?: ContentPart[];
  /** Wall-clock duration of the run, ms. */
  durationMs: number;
}

/**
 * Declarative, codec-friendly input schema.
 * Untrusted input is checked against this BEFORE the tool body runs.
 */
export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "array"
  /**
   * A free-form object bag, passed through without field-level validation.
   *
   * Used by adapters that front another protocol (MCP, say), where the remote
   * service is the authority on its own argument shapes. A declarative spec
   * cannot express an arbitrary JSON Schema, and a lossy translation in front of
   * an untrusted server would be worse than leaving validation to it.
   */
  | "object";

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

/**
 * Deterministic intent triggers for the intent router (src/routing).
 *
 * Regexes are stored as STRINGS so manifests stay pure serializable
 * data; the router compiles them once. A tool with no triggers is
 * simply never router-suggested — the model still sees it in the
 * catalog. Patterns are matched case-insensitively by the router, so
 * write them without flags.
 */
export interface ToolTriggerPatterns {
  /** Matched against URLs found in the user's message text. */
  readonly urlPatterns?: readonly string[];
  /** Matched against the whole message text (Persian variants welcome). */
  readonly keywordPatterns?: readonly string[];
  /** MIME types the tool handles (for media messages without text). */
  readonly mimeTypes?: readonly string[];
}

/** A BOBI tool. Implementations are pure and side-effect free by contract. */
export interface Tool<TIn, TOut> {
  /** Unique, stable, lowercase snake_case identifier. */
  readonly name: string;
  /** One-line description for humans and the model. */
  readonly description: string;
  /** When false the Executor refuses this tool outright. */
  readonly enabled: boolean;
  /** Permission requirement; the Executor checks this per request. */
  readonly permission: ToolPermission;
  /**
   * When true, the authorization bridge never grants this tool's permission
   * keys to a non-owner, so the tool is invisible to them in listings and
   * refused by the Executor. Tools that set this ALSO check ownership in
   * run(), as defence in depth for callers that build actors directly.
   */
  readonly ownerOnly?: boolean;
  /**
   * The toolset this tool belongs to, e.g. "utils", "memory", "schedule",
   * "web", "media", "agents", "system".
   *
   * Toolsets are the E4 tool gateway's grouping knob: `ToolService`
   * can hide whole toolsets from the model (`setActiveToolsets`), and
   * `tool_search` uses them as an extra ranking signal. A tool with NO
   * toolset is a core tool — always visible to the model (subject to the
   * usual permission checks) regardless of the active toolset list.
   */
  readonly toolset?: string;
  /** Input contract used for validation before execution. */
  readonly input: ToolInputSpec;
  /**
   * Plugin discovery metadata (see manifest.ts).
   *
   * Optional during the architecture migration: every built-in tool
   * ships one, and the plugin catalog (plugins.ts) asserts that the
   * statically-registered tools all carry one whose id equals the
   * tool's name. External/dynamically-built tools (MCP adapters) may
   * omit it — they are never intent-router candidates.
   */
  readonly manifest?: import("./manifest").ToolManifest;
  /**
   * Executor timeout override for this tool, ms.
   *
   * Most tools finish in seconds under the 10s default. A tool that is slow
   * by design (mixture-of-agents consults several models) declares its own
   * bound here instead of raising the global default for every tool.
   */
  readonly timeoutMs?: number;
  /**
   * Pull user-facing media out of a successful run's data.
   *
   * Declarative and optional: the Executor calls it on `ok` and attaches the
   * result to `ToolRunResult.media`. Keep `data` model-safe — anything the
   * user should SEE (image, audio, document bytes) belongs in the returned
   * parts, not in `data`.
   *
   * Declared as a method (not a property) so Tool stays covariant-friendly
   * under strictFunctionTypes — method parameters are bivariant.
   */
  extractMedia?(data: TOut): ContentPart[] | undefined;
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
