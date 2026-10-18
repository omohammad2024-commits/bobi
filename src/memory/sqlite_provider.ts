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
import type { MemoryProvider, StoredMemory } from "./provider";

export class SqliteMemoryProvider implements MemoryProvider {
  readonly name = "sqlite";

  constructor(private readonly storage: Storage) {}

  upsert(userId: string, key: string, content: string): void {
    this.storage.upsertMemory({ userId, key, content });
  }

  get(userId: string, key: string): StoredMemory | undefined {
    const m = this.storage.getMemory(userId, key);
    if (!m) return undefined;
    return {
      key: m.key,
      content: m.content,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  list(userId: string, limit = 50): StoredMemory[] {
    return this.storage.listMemories(userId, limit).map((m) => ({
      key: m.key,
      content: m.content,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
  }

  delete(userId: string, key: string): boolean {
    return this.storage.deleteMemory(userId, key);
  }

  count(userId: string): number {
    return this.storage.countMemories(userId);
  }
}
