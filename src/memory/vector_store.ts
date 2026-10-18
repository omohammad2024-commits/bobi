/**
 * SQLite store for memory embedding vectors (Phase 4, semantic memory).
 *
 * Follows the Phase-D4 curator pattern: its own `memory_embeddings` table on
 * the same SQLite file, created lazily with CREATE TABLE IF NOT EXISTS —
 * `src/storage/storage.ts` is NOT touched, and there is no schema-version
 * bump to coordinate. A fresh database simply gets the table on first use;
 * an upgraded one is migrated by the same lazy path.
 *
 * One row per (user_id, key), matching the memories table's ownership model:
 * every read and write is scoped to the caller-supplied user id, so vectors
 * can never leak across users. Vectors are stored as Float32 little-endian
 * BLOBs with an explicit `dim` column, so a later embedding-model change
 * (different dimension) is detected at read time and the stale rows are
 * ignored rather than compared against incompatible vectors.
 */
import type { Database } from "bun:sqlite";
import type { Embedding } from "./embeddings";

/** One stored vector, as the store hands it back. */
export interface StoredVector {
  key: string;
  vector: number[];
  /** Embedding dimension, as stored. */
  dim: number;
  /**
   * Phase 5: the embedding model id this vector was written with
   * (e.g. "text-embedding-3-small"). "" for rows written before the
   * column existed — those keep the phase-4 dimension-only rule.
   */
  model: string;
}

export class MemoryVectorStore {
  private initialized = false;

  constructor(private readonly db: Database) {}

  /**
   * Create the table if it does not exist. Also called lazily by every
   * method, so a store used without an explicit init() still works.
   */
  init(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `);
    // Phase 5: the embedding model id travels with each vector, so a model
    // change marks old rows stale instead of mixing incompatible vectors.
    // Tables created by phase 4 lack the column — migrate lazily, same as
    // the table itself (storage.ts stays untouched).
    const cols = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(memory_embeddings)`)
      .all();
    if (!cols.some((c) => c.name === "model")) {
      this.db.exec(
        `ALTER TABLE memory_embeddings ADD COLUMN model TEXT NOT NULL DEFAULT ''`,
      );
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_user
        ON memory_embeddings(user_id);
    `);
    this.initialized = true;
  }

  /**
   * Store (or replace) the vector for one memory.
   *
   * Phase 5: `model` is the embedding model id the vector was written with.
   * Rows written without it ("") keep the phase-4 dimension-only staleness
   * rule; rows with a model are invalidated when the model changes.
   */
  save(userId: string, key: string, vector: Embedding, model = ""): void {
    this.init();
    const dim = vector.length;
    this.db
      .query(
        `INSERT INTO memory_embeddings(user_id, key, dim, vec, model, updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(user_id, key) DO UPDATE SET
           dim=excluded.dim, vec=excluded.vec, model=excluded.model,
           updated_at=excluded.updated_at`,
      )
      .run(userId, key, dim, encodeVector(vector), model, Date.now());
  }

  /** One vector by key, scoped to its owner. */
  get(userId: string, key: string): StoredVector | undefined {
    this.init();
    const row = this.db
      .query<
        { key: string; dim: number; vec: Uint8Array; model: string },
        [string, string]
      >(
        `SELECT key, dim, vec, model FROM memory_embeddings WHERE user_id=? AND key=?`,
      )
      .get(userId, key);
    if (!row) return undefined;
    return {
      key: row.key,
      dim: row.dim,
      vector: decodeVector(row.vec, row.dim),
      model: row.model ?? "",
    };
  }

  /** All of a user's vectors. Small by design (≤ a few hundred memories). */
  listAll(userId: string): StoredVector[] {
    this.init();
    return this.db
      .query<{ key: string; dim: number; vec: Uint8Array; model: string }, [string]>(
        `SELECT key, dim, vec, model FROM memory_embeddings WHERE user_id=?`,
      )
      .all(userId)
      .map((row) => ({
        key: row.key,
        dim: row.dim,
        vector: decodeVector(row.vec, row.dim),
        model: row.model ?? "",
      }));
  }

  /** Delete one vector. True when a row actually went. */
  delete(userId: string, key: string): boolean {
    this.init();
    const res = this.db
      .query(`DELETE FROM memory_embeddings WHERE user_id=? AND key=?`)
      .run(userId, key);
    return (res.changes as number) > 0;
  }

  /** How many vectors a user has stored. */
  count(userId: string): number {
    this.init();
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM memory_embeddings WHERE user_id=?`,
      )
      .get(userId);
    return row?.n ?? 0;
  }
}

/** Pack a vector as Float32 little-endian bytes. */
export function encodeVector(vector: Embedding): Uint8Array {
  const buf = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < vector.length; i++) {
    view.setFloat32(i * 4, vector[i]!, true);
  }
  return new Uint8Array(buf);
}

/**
 * Unpack a vector. A truncated or over-long BLOB degrades to the stored
 * `dim` floats (zero-filled past the data) rather than throwing, so one
 * corrupt row cannot break a whole search.
 */
export function decodeVector(blob: Uint8Array, dim: number): number[] {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out: number[] = [];
  for (let i = 0; i < dim; i++) {
    out.push(i * 4 + 4 <= view.byteLength ? view.getFloat32(i * 4, true) : 0);
  }
  return out;
}
