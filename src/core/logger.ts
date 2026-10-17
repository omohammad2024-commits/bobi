/**
 * Structured logging.
 *
 * Before this, every diagnostic went through a bare `console.error`, which had
 * three problems: the configured `SOL_LOG_LEVEL` was read and then ignored, a
 * debug build and a production build produced identical noise, and nothing
 * stopped a caller from pasting a token or a message body into a log line.
 *
 * This module fixes all three:
 *  - levels are real, and the configured one decides what is emitted;
 *  - output is one JSON object per line, so a log can be filtered mechanically;
 *  - values are passed through a redactor that removes Telegram-token shapes and
 *    the contents of secret-looking keys, and long strings are clipped.
 *
 * The redactor is a safety net, not a licence: callers still must not log
 * secrets. It exists because "we always remember" is not a control.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Numeric ordering, so a threshold comparison is one integer test. */
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Readonly<Record<string, unknown>>;

export interface LoggerOptions {
  level: LogLevel;
  /** Sink for a rendered line. Injectable so tests capture instead of print. */
  write?: (line: string) => void;
  /** Clocks are injected so a test can assert a stable timestamp. */
  now?: () => Date;
  /** Base fields attached to every line, e.g. the app version. */
  base?: LogFields;
}

/**
 * A very long string is almost always a payload or a message body, neither of
 * which belongs in a log line. This bound keeps one bad call from flooding a
 * log, while still leaving enough to identify the value.
 */
const MAX_STRING_LENGTH = 300;

/**
 * Shapes that are credentials regardless of the key they appear under.
 * The Telegram bot-token form is the one that actually appears in this codebase.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\btvly-[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
];

/** Keys whose VALUE is a secret, whatever it happens to look like. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "token",
  "botToken",
  "apiKey",
  "apikey",
  "api_key",
  "key",
  "secret",
  "password",
  "authorization",
  "credential",
  "masterKey",
  "ciphertext",
]);

export class Logger {
  private readonly level: number;
  private readonly write: (line: string) => void;
  private readonly now: () => Date;
  private readonly base: LogFields;

  constructor(opts: LoggerOptions) {
    this.level = LEVEL_ORDER[opts.level];
    this.write = opts.write ?? ((line) => console.log(line));
    this.now = opts.now ?? (() => new Date());
    this.base = opts.base ?? {};
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  /**
   * Log at `error` with an Error's structured detail.
   *
   * The stack is included only at debug level: it is useful when diagnosing and
   * is noise in a normal run. The message is redacted like any other value.
   */
  exception(message: string, err: unknown, fields?: LogFields): void {
    this.emit("error", message, {
      ...fields,
      error: describeError(err, this.level <= LEVEL_ORDER.debug),
    });
  }

  /** True when a message at this level would be emitted. */
  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= this.level;
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (!this.isEnabled(level)) return;

    const record: Record<string, unknown> = {
      time: this.now().toISOString(),
      level,
      message: redactString(message),
      ...redactFields(this.base),
      ...redactFields(fields ?? {}),
    };

    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // A field that cannot be serialised (a circular object, a BigInt) must
      // not break the caller's flow; the message alone is still useful.
      line = JSON.stringify({
        time: record["time"],
        level,
        message: record["message"],
        note: "fields could not be serialised",
      });
    }
    this.write(line);
  }
}

/** A logger that discards everything, for contexts with no configuration. */
export function nullLogger(): Logger {
  return new Logger({ level: "error", write: () => undefined });
}

/**
 * Redact every value in a field bag.
 *
 * Applied to base fields and per-call fields alike, and recursively, since a
 * nested object is exactly how a credential usually gets passed around.
 */
function redactFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEYS.has(key) ? "[redacted]" : redactValue(value, 0);
  }
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  // Depth bound: a pathological structure cannot make logging quadratic.
  if (depth > 4) return "[depth limit]";

  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return value.toString();
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return describeError(value, false);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) ? "[redacted]" : redactValue(v, depth + 1);
  }
  return out;
}

/** Strip credential shapes and clip an over-long string. */
function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.length > MAX_STRING_LENGTH
    ? `${out.slice(0, MAX_STRING_LENGTH)}…(${out.length} chars)`
    : out;
}

/** A safe description of a thrown value. */
function describeError(err: unknown, withStack: boolean): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { message: redactString(String(err)) };
  }
  return {
    name: err.name,
    message: redactString(err.message),
    ...(withStack && err.stack !== undefined
      ? { stack: redactString(err.stack) }
      : {}),
  };
}
