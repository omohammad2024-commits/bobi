/**
 * The SQLite memory provider (Phase D2).
 *
 * This is the CURRENT behavior, moved verbatim behind the MemoryProvider
 * interface: every method delegates to the matching Storage method on the
 * `memories` table, with no logic added and none removed. It exists so the
 * tools can stop depending on Storage directly without changing a single
 * observable behavior — the parity test proves it.
 */
import type { Storage } from "../storage/storage";
import type {
  MemoryProvider,
  MemoryPruneDrop,
  MemoryUpsertOptions,
  StoredMemory,
} from "./provider";

export class SqliteMemoryProvider implements MemoryProvider {
  readonly name = "sqlite";

  constructor(private readonly storage: Storage) {}

  upsert(
    userId: string,
    key: string,
    content: string,
    opts?: MemoryUpsertOptions,
  ): void {
    // exactOptionalPropertyTypes: never pass an explicit undefined.
    const importance = opts?.importance;
    this.storage.upsertMemory(
      importance === undefined
        ? { userId, key, content }
        : { userId, key, content, importance },
    );
  }

  get(userId: string, key: string): StoredMemory | undefined {
    const m = this.storage.getMemory(userId, key);
    if (!m) return undefined;
    return {
      key: m.key,
      content: m.content,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      importance: m.importance,
      // Schema-22 recall telemetry is present only once it exists: a
      // never-recalled memory keeps the exact pre-v22 record shape (the
      // parity test pins it), and consumers read recallCount ?? 0.
      ...(m.recallCount > 0 ? { recallCount: m.recallCount } : {}),
      ...(m.lastRecalledAt !== undefined ? { lastRecalledAt: m.lastRecalledAt } : {}),
    };
  }

  list(userId: string, limit = 50): StoredMemory[] {
    return this.storage.listMemories(userId, limit).map((m) => ({
      key: m.key,
      content: m.content,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      importance: m.importance,
      ...(m.recallCount > 0 ? { recallCount: m.recallCount } : {}),
      ...(m.lastRecalledAt !== undefined ? { lastRecalledAt: m.lastRecalledAt } : {}),
    }));
  }

  delete(userId: string, key: string): boolean {
    return this.storage.deleteMemory(userId, key);
  }

  count(userId: string): number {
    return this.storage.countMemories(userId);
  }

  /** Worker-2: summarize-then-drop prune, delegated to Storage. */
  pruneMemories(
    userId: string,
    drops: ReadonlyArray<MemoryPruneDrop>,
  ): number {
    return this.storage.pruneMemories(userId, drops);
  }

  /** Schema 22: recall telemetry, delegated to Storage. */
  bumpRecall(userId: string, keys: readonly string[]): number {
    return this.storage.bumpMemoryRecall(userId, keys);
  }
}
