/**
 * MemoriesRepo — Long-term memories repository (phase 6).
 *
 * Owns the SQL for: memories.
 * Extracted from the old Storage god class; method bodies are unchanged,
 * only their home moved. Row shapes stay inside the storage layer.
 */

import { RepoBase } from "./base";
import { clampInt } from "./base";

/** One stored long-term memory. Always scoped to its owner. */
export interface MemoryRecord {
  userId: string;
  /** Short stable label the model chose, unique per owner. */
  key: string;
  /** The remembered text. */
  content: string;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
  /** Importance 1-5 (worker-2): retrieval prefers important memories. */
  importance: number;
  /** Schema 22: how often retrieval has surfaced this memory. */
  recallCount: number;
  /** Schema 22: unix ms of the most recent recall, undefined if never. */
  lastRecalledAt?: number;
}

/** Map a memory row to a record. */
function toMemoryRecord(r: {
  user_id: string;
  key: string;
  content: string;
  created_at: number;
  updated_at: number;
  importance: number;
  recall_count: number;
  last_recalled_at: number | null;
}): MemoryRecord {
  return {
    userId: r.user_id,
    key: r.key,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    importance: r.importance,
    recallCount: r.recall_count,
    ...(r.last_recalled_at !== null ? { lastRecalledAt: r.last_recalled_at } : {}),
  };
}

export class MemoriesRepo extends RepoBase {
  // ---- long-term memory ----

  /**
   * Store (or replace) one memory for one user.
   *
   * The owner is part of the key, so a write can only ever touch the caller's
   * own memory — there is no way to address another user's row.
   */
  upsertMemory(m: {
    userId: string;
    key: string;
    content: string;
    /** Importance 1-5. Omitted: an existing row keeps its importance, a new row gets 3. */
    importance?: number;
  }): void {
    const now = Date.now();
    if (m.importance === undefined) {
      this.exec(
        `INSERT INTO memories(user_id, key, content, created_at, updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(user_id, key) DO UPDATE SET
           content=excluded.content, updated_at=excluded.updated_at`,
        [m.userId, m.key, m.content, now, now],
      );
      return;
    }
    const imp = Math.min(5, Math.max(1, Math.round(m.importance)));
    this.exec(
      `INSERT INTO memories(user_id, key, content, created_at, updated_at, importance)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         content=excluded.content, updated_at=excluded.updated_at,
         importance=excluded.importance`,
      [m.userId, m.key, m.content, now, now, imp],
    );
  }

  /** One memory by key, scoped to its owner. */
  getMemory(userId: string, key: string): MemoryRecord | undefined {
    const row = this.query<{
      user_id: string;
      key: string;
      content: string;
      created_at: number;
      updated_at: number;
      importance: number;
      recall_count: number;
      last_recalled_at: number | null;
    }>(
      `SELECT user_id, key, content, created_at, updated_at, importance,
              recall_count, last_recalled_at
         FROM memories WHERE user_id=? AND key=?`,
      [userId, key],
    )[0];
    return row ? toMemoryRecord(row) : undefined;
  }

  /**
   * A user's memories, newest first.
   *
   * Always filtered by owner: this is the only read path, so there is no
   * unfiltered variant that could leak another user's memory.
   */
  listMemories(userId: string, limit = 50): MemoryRecord[] {
    const safeLimit = clampInt(limit, 1, 200, 50);
    return this.query<{
      user_id: string;
      key: string;
      content: string;
      created_at: number;
      updated_at: number;
      importance: number;
      recall_count: number;
      last_recalled_at: number | null;
    }>(
      `SELECT user_id, key, content, created_at, updated_at, importance,
              recall_count, last_recalled_at
         FROM memories WHERE user_id=?
        ORDER BY updated_at DESC, key ASC LIMIT ?`,
      [userId, safeLimit],
    ).map(toMemoryRecord);
  }

  /**
   * Schema 22: record that retrieval surfaced these memories.
   *
   * Increments recall_count and stamps last_recalled_at per key — and
   * deliberately does NOT touch updated_at: a recall is a read, and
   * bumping the write clock would make every recalled memory look freshly
   * written (defeating consolidation's staleness rule and the recency
   * ranking). Scoped to the owner like every memory write. Returns how
   * many rows actually matched.
   *
   * Addressing note: memories are keyed by (user_id, key) — there is no
   * numeric id column — so callers pass the keys a recall returned.
   */
  bumpMemoryRecall(userId: string, keys: readonly string[]): number {
    if (keys.length === 0) return 0;
    const now = Date.now();
    let bumped = 0;
    for (const key of new Set(keys)) {
      if (key.length === 0) continue;
      bumped +=
        this.exec(
          `UPDATE memories
              SET recall_count = recall_count + 1, last_recalled_at = ?
            WHERE user_id = ? AND key = ?`,
          [now, userId, key],
        ).changes > 0
          ? 1
          : 0;
    }
    return bumped;
  }

  /**
   * Schema 22: set one memory's importance (1-5, clamped) WITHOUT bumping
   * updated_at — importance bookkeeping (consolidation promote/decay) is
   * not a content edit and must not re-arm the row's write clock.
   * Scoped to the owner. Returns whether a row matched.
   */
  setMemoryImportance(userId: string, key: string, importance: number): boolean {
    const imp = Math.min(5, Math.max(1, Math.round(importance)));
    return (
      this.exec(
        `UPDATE memories SET importance = ? WHERE user_id = ? AND key = ?`,
        [imp, userId, key],
      ).changes > 0
    );
  }

  /**
   * Summarize-then-drop prune (worker-2): the principled forgetting policy.
   *
   * For each drop: the full text is replaced by its one-line summary, the
   * importance resets to 1 and updatedAt bumps to now — the key stays
   * stable, so nothing that referenced it breaks, and the summarized row
   * will not be re-pruned immediately. The ranking (which rows to drop) is
   * computed by `buildPrunePlan` in src/memory/hybrid.ts; this method only
   * executes a plan. Returns how many rows were pruned. Scoped to the
   * owner like every other memory write.
   */
  pruneMemories(
    userId: string,
    drops: ReadonlyArray<{ key: string; summary: string }>,
  ): number {
    if (drops.length === 0) return 0;
    const now = Date.now();
    let pruned = 0;
    for (const d of drops) {
      const summary = d.summary.trim().slice(0, 500);
      if (d.key.length === 0 || summary.length === 0) continue;
      pruned +=
        this.exec(
          `UPDATE memories
              SET content=?, importance=1, updated_at=?
            WHERE user_id=? AND key=?`,
          [summary, now, userId, d.key],
        ).changes > 0
          ? 1
          : 0;
    }
    return pruned;
  }

  /** Delete one memory, scoped to its owner. Returns whether a row went. */
  deleteMemory(userId: string, key: string): boolean {
    return (
      this.exec(`DELETE FROM memories WHERE user_id=? AND key=?`, [userId, key]).changes > 0
    );
  }

  /** How many memories a user has stored. Used for the prompt, not the content. */
  countMemories(userId: string): number {
    return (
      this.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memories WHERE user_id=?`,
        [userId],
      )[0]?.n ?? 0
    );
  }
}

/** DDL fragment owned by this repository (phase 6). The Storage facade
 *  assembles the full SCHEMA from the domain fragments in a fixed order;
 *  the statements themselves are byte-identical to the pre-split schema. */
export const MEMORIES_SCHEMA = `

-- Long-term memory, one row per (owner, key). Ownership is part of the primary
-- key, so one user's memory can never be read or overwritten by another; the
-- read path filters on user_id exactly like the conversations table does.
-- Content is user-facing text the model chose to store, never message history.
CREATE TABLE IF NOT EXISTS memories (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  importance INTEGER NOT NULL DEFAULT 3,
  recall_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(user_id, updated_at DESC);
`;
