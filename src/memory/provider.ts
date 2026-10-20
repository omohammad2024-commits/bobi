/**
 * Pluggable long-term memory backends (Phase D2).
 *
 * The remember/recall/forget tools no longer reach into the `memories` table
 * directly: they talk to a MemoryProvider, and the provider decides where the
 * bytes live. Swapping the backend is one environment variable
 * (BOBI_MEMORY_PROVIDER), not a code change.
 */

/** One stored memory, as a provider hands it back. */
export interface StoredMemory {
  key: string;
  content: string;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
  /**
   * Importance 1-5 (worker-2). Optional: providers that predate it omit it
   * and readers fall back to `memoryImportance()` (default 3) from
   * `./hybrid`.
   */
  importance?: number;
}

/** Options for `MemoryProvider.upsert`. All optional, all additive. */
export interface MemoryUpsertOptions {
  /**
   * Importance 1-5 for this write. When omitted, an existing row keeps its
   * importance and a new row gets the default (3).
   */
  importance?: number;
}

/** One summarize-then-drop prune item, as `pruneMemories` consumes it. */
export interface MemoryPruneDrop {
  key: string;
  /** The one-line summary that survives the drop. */
  summary: string;
}

/**
 * A long-term memory backend.
 *
 * The five operations mirror the storage memory API 1:1
 * (upsertMemory/getMemory/listMemories/deleteMemory/countMemories), so the
 * SqliteMemoryProvider is the current behavior moved verbatim and the tools
 * above cannot tell which backend is behind the interface. Methods may be
 * sync or async — the tools await them either way.
 *
 * Ownership stays the tools' job, and a correct provider scopes everything
 * to the owner id it is given — exactly like the memories table's
 * (user_id, key) primary key does. A provider must never read or write
 * another user's rows, and must never invent a user id of its own.
 *
 * SECURITY: a provider holds user data. Custom providers must not log memory
 * content, must not send it anywhere the tools did not ask for, and must
 * treat (userId, key) as the full address of a row — never guess or widen it.
 */
export interface MemoryProvider {
  /** Stable, lowercase identifier used by BOBI_MEMORY_PROVIDER. */
  readonly name: string;
  /**
   * Store a memory, replacing the entry under (userId, key) if one exists.
   * `opts.importance` sets the 1-5 importance; omitted leaves an existing
   * row's importance untouched (new rows default to 3).
   */
  upsert(
    userId: string,
    key: string,
    content: string,
    opts?: MemoryUpsertOptions,
  ): void | Promise<void>;
  /** One memory by key, or undefined. Never another user's. */
  get(userId: string, key: string): StoredMemory | undefined | Promise<StoredMemory | undefined>;
  /** The user's memories, newest first, capped at `limit`. */
  list(userId: string, limit?: number): StoredMemory[] | Promise<StoredMemory[]>;
  /** Delete one memory. True when a row actually went. */
  delete(userId: string, key: string): boolean | Promise<boolean>;
  /** How many memories the user has. */
  count(userId: string): number | Promise<number>;
  /**
   * Summarize-then-drop prune (worker-2). For each drop: replace the content
   * with the one-line summary, reset importance to 1 and bump updatedAt —
   * the key stays stable so existing references keep working. Returns how
   * many rows were pruned. Optional: providers without it simply don't
   * prune.
   */
  pruneMemories?(
    userId: string,
    drops: ReadonlyArray<MemoryPruneDrop>,
  ): number | Promise<number>;
}
