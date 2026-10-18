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
  /** Store a memory, replacing the entry under (userId, key) if one exists. */
  upsert(userId: string, key: string, content: string): void | Promise<void>;
  /** One memory by key, or undefined. Never another user's. */
  get(userId: string, key: string): StoredMemory | undefined | Promise<StoredMemory | undefined>;
  /** The user's memories, newest first, capped at `limit`. */
  list(userId: string, limit?: number): StoredMemory[] | Promise<StoredMemory[]>;
  /** Delete one memory. True when a row actually went. */
  delete(userId: string, key: string): boolean | Promise<boolean>;
  /** How many memories the user has. */
  count(userId: string): number | Promise<number>;
}
