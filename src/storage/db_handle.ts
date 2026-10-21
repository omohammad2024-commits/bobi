/**
 * DbHandle — the ONE shared handle on the SQLite file.
 *
 * Phase 6 (storage repositories): every repository receives this handle
 * from the Storage facade instead of opening its own `new Database(...)`
 * on the same file. The guarded wrappers that used to be private methods
 * of the Storage god class live here so repositories share exactly the
 * same error and closed-state semantics.
 */
import { Database } from "bun:sqlite";
import { StorageError, storageErrorMessage as msg } from "./errors";

export class DbHandle {
  private closedFlag = false;

  constructor(readonly raw: Database) {}

  get closed(): boolean {
    return this.closedFlag;
  }

  ensureOpen(): void {
    if (this.closedFlag) throw new StorageError("closed", "storage is closed");
  }

  /** Run one statement; returns the run info (changes / lastInsertRowid). */
  exec(sql: string, params: unknown[] = []) {
    this.ensureOpen();
    try {
      return this.raw.prepare(sql).run(...(params as never[]));
    } catch (err) {
      throw new StorageError("query", msg(err));
    }
  }

  /** Run a multi-statement script (schema DDL). No parameters. */
  execScript(sql: string): void {
    this.ensureOpen();
    try {
      this.raw.exec(sql);
    } catch (err) {
      throw new StorageError("query", msg(err));
    }
  }

  query<T>(sql: string, params: unknown[] = []): T[] {
    this.ensureOpen();
    try {
      return this.raw.prepare(sql).all(...(params as never[])) as T[];
    } catch (err) {
      throw new StorageError("query", msg(err));
    }
  }

  /**
   * Close the database and release its file handle.
   *
   * `close(true)` is required rather than the default `close()`. Every query
   * here goes through `prepare()`, and Bun only releases the connection for
   * outstanding statements once they are finalized or garbage collected — the
   * default form deferred that until GC, so the process could exit with the
   * database file still locked (EBUSY on Windows) and `-wal`/`-shm` left
   * behind. Passing `true` finalizes every outstanding statement and releases
   * the connection immediately.
   */
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    try {
      this.raw.close(true);
    } catch {
      // Cleanup is best-effort during shutdown: report that it did not finish
      // without printing the path or any SQLite detail.
      console.error("[sol] storage: database did not close cleanly");
    }
  }
}
