/**
 * Audit logger — records security events without recording secrets.
 *
 * What goes in: timestamp, operation name, the valid numeric actor id, the
 * outcome, and an optional target id.
 * What never goes in: bot tokens, API keys, full system prompts, message
 * bodies, or any confidential text. Callers pass only already-sanitized
 * metadata, and this module additionally strips anything that still looks
 * like a secret before writing.
 */
import type { Storage } from "../storage/storage";
import type { Permission } from "./roles";

export interface AuditRecord {
  operation: string;
  outcome: "success" | "denied" | "error";
  /** Actor numeric id as a string; absent for an unidentifiable caller. */
  actorId?: string;
  targetId?: string;
  detail?: string;
}

/** Optional sink used when no database is available (e.g. in tests). */
export type AuditSink = (record: AuditRecord) => void;

export class AuditLogger {
  private readonly storage: Storage | undefined;
  private readonly sink: AuditSink | undefined;

  constructor(opts: { storage?: Storage; sink?: AuditSink }) {
    this.storage = opts.storage;
    this.sink = opts.sink;
  }

  /** Record one event. Never throws — logging must not break an operation. */
  record(event: AuditRecord): void {
    // exactOptionalPropertyTypes: build optionals by spread, not with undefined.
    const safe: AuditRecord = {
      operation: clip(event.operation, 64),
      outcome: event.outcome,
      ...(event.actorId !== undefined ? { actorId: clip(event.actorId, 32) } : {}),
      ...(event.targetId !== undefined ? { targetId: clip(event.targetId, 32) } : {}),
      ...(event.detail !== undefined ? { detail: scrubOrUndefined(event.detail) } : {}),
    };
    try {
      this.storage?.appendAudit(safe);
    } catch {
      // A storage failure must not fail the operation that was audited.
    }
    if (this.sink) {
      try {
        this.sink(safe);
      } catch {
        // ignore sink failures
      }
    }
  }

  /** Convenience: an administrative operation and its result. */
  admin(
    operation: string,
    actorId: string | undefined,
    outcome: "success" | "denied" | "error",
    permission: Permission,
    targetId?: string,
  ): void {
    this.record({
      operation,
      outcome,
      detail: `permission=${permission}`,
      ...(actorId !== undefined ? { actorId } : {}),
      ...(targetId !== undefined ? { targetId } : {}),
    });
  }

  /** Read events newest-first. */
  recent(limit?: number): ReturnType<Storage["auditEvents"]> {
    if (!this.storage) return [];
    try {
      return this.storage.auditEvents(limit);
    } catch {
      return [];
    }
  }
}

/** Trim to a bounded length so a field cannot grow without limit. */
function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Remove anything resembling a secret from a free-text detail field, in case
 * a caller passes one by mistake. Callers are still expected to pass metadata.
 */
function scrubOrUndefined(value: string): string {
  let text = clip(value, 200);
  // Telegram bot tokens look like 123456:AA...
  text = text.replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[redacted]");
  // Key=value pairs whose key hints at a secret.
  text = text.replace(
    /\b(token|secret|password|api[_-]?key|authorization)\b\s*[:=]\s*\S+/gi,
    "[redacted]",
  );
  return text;
}
