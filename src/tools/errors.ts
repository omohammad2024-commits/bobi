/**
 * Typed, user-safe errors for the tool layer.
 *
 * Hard rule: a ToolError message is safe to show a user. Never put stack
 * traces, provider payloads, file paths, secrets, or raw internal error text
 * in a ToolError message. Log those separately with logger-safe text.
 */

export type ToolErrorKind =
  | "invalid_input"
  | "not_found"
  | "disabled"
  | "not_allowed"
  | "timeout"
  | "aborted"
  | "overloaded"
  | "invalid_result"
  | "internal";

export class ToolError extends Error {
  constructor(
    readonly kind: ToolErrorKind,
    message: string,
    /** Optional structured detail for logs. Must stay secret-free. */
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** True when an error is a tool-layer error (vs an unexpected internal fault). */
export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}

/** Coerce any thrown value into a ToolError without leaking internals. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  return new ToolError("internal", "Internal tool error.");
}

/** Short, user-facing English message per error kind. */
export function userMessageFor(kind: ToolErrorKind): string {
  switch (kind) {
    case "invalid_input":
      return "Invalid input.";
    case "not_found":
      return "Tool not found.";
    case "disabled":
      return "This tool is disabled.";
    case "not_allowed":
      return "You are not allowed to run this tool.";
    case "timeout":
      return "The tool run timed out.";
    case "aborted":
      return "The tool run was cancelled.";
    case "overloaded":
      return "The system is busy; try again in a moment.";
    case "invalid_result":
      return "The tool returned an invalid result.";
    case "internal":
      return "Internal tool error.";
  }
}
