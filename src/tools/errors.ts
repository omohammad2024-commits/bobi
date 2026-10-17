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
  return new ToolError("internal", "خطای داخلی ابزار.");
}

/** Short, user-facing Persian message per error kind. */
export function userMessageFor(kind: ToolErrorKind): string {
  switch (kind) {
    case "invalid_input":
      return "ورودی نامعتبر است.";
    case "not_found":
      return "ابزار یافت نشد.";
    case "disabled":
      return "این ابزار غیرفعال است.";
    case "not_allowed":
      return "مجوز اجرای این ابزار را ندارید.";
    case "timeout":
      return "اجرای ابزار طول کشید و لغو شد.";
    case "aborted":
      return "اجرای ابزار لغو شد.";
    case "overloaded":
      return "سیستم شلوغ است؛ لحظه‌ای بعد تلاش کن.";
    case "invalid_result":
      return "نتیجهٔ ابزار نامعتبر بود.";
    case "internal":
      return "خطای داخلی ابزار.";
  }
}
