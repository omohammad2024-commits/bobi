/**
 * RepoBase — shared base for the domain repositories (phase 6).
 *
 * A repository owns the SQL for its domain's tables and nothing else: it
 * receives the platform's single DbHandle and exposes typed methods whose
 * row shapes never leave the storage layer. Method bodies moved here from
 * the old Storage god class call `this.exec` / `this.query` exactly as
 * before — the base delegates to the handle, so semantics (guarded
 * errors, closed-state checks) are unchanged.
 */
import type { DbHandle } from "../db_handle";

export abstract class RepoBase {
  constructor(protected readonly handle: DbHandle) {}

  protected exec(sql: string, params: unknown[] = []) {
    return this.handle.exec(sql, params);
  }

  protected query<T>(sql: string, params: unknown[] = []): T[] {
    return this.handle.query<T>(sql, params);
  }

  protected ensureOpen(): void {
    this.handle.ensureOpen();
  }
}

/** Clamp a possibly-hostile integer into a safe range, with a fallback. */
export function clampInt(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  const n = Math.trunc(raw);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
