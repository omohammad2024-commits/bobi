/**
 * TodoRepo — Per-user todo lists repository (phase 9, Action Layer).
 *
 * Owns the SQL for: todo_items.
 *
 * A todo item is a plain checklist entry on one of a user's named lists
 * ("main" by default; named lists like "shopping" or "watchlist" are just
 * a different list_name). Ownership is enforced HERE, like everywhere in
 * the storage layer: every query is scoped by user_id, so a caller can
 * never read, complete, or delete another user's items — an id that is
 * not the caller's simply matches nothing and reports false.
 */

import { RepoBase } from "./base";

/** One todo checklist item. */
export interface TodoItemRecord {
  id: number;
  /** Owner id — every row belongs to exactly one user. */
  userId: string;
  /** Named list the item sits on ("main" unless the caller named one). */
  listName: string;
  text: string;
  done: boolean;
  /** unix ms — when the item was added. */
  createdAt: number;
  /** unix ms — when the item was completed; absent while it is open. */
  doneAt?: number;
}

/** Raw row shape shared by the todo queries. */
interface TodoItemRow {
  id: number;
  user_id: string;
  list_name: string;
  text: string;
  done: number;
  created_at: number;
  done_at: number | null;
}

/** Column list shared by every todo SELECT (kept in one place so a new
 *  column can never be read by one query and forgotten by another). */
const TODO_COLUMNS = "id, user_id, list_name, text, done, created_at, done_at";

/** Map a todo row to a record, omitting nulls. */
function toTodoItemRecord(r: TodoItemRow): TodoItemRecord {
  return {
    id: r.id,
    userId: r.user_id,
    listName: r.list_name,
    text: r.text,
    done: r.done === 1,
    createdAt: r.created_at,
    ...(r.done_at !== null ? { doneAt: r.done_at } : {}),
  };
}

export class TodoRepo extends RepoBase {
  /** Add one open item to a user's list. Returns the stored row. */
  add(userId: string, listName: string, text: string, nowMs: number): TodoItemRecord {
    const res = this.exec(
      `INSERT INTO todo_items(user_id, list_name, text, done, created_at, done_at)
       VALUES(?,?,?,0,?,NULL)`,
      [userId, listName, text, nowMs],
    );
    return {
      id: Number(res.lastInsertRowid),
      userId,
      listName,
      text,
      done: false,
      createdAt: nowMs,
    };
  }

  /**
   * A user's items on one list, oldest first (creation order, id as the
   * tiebreak for items added in the same millisecond). Done items are
   * included only when `includeDone` is set.
   */
  list(userId: string, listName: string, includeDone: boolean): TodoItemRecord[] {
    const rows = includeDone
      ? this.query<TodoItemRow>(
          `SELECT ${TODO_COLUMNS}
             FROM todo_items WHERE user_id=? AND list_name=?
            ORDER BY created_at ASC, id ASC`,
          [userId, listName],
        )
      : this.query<TodoItemRow>(
          `SELECT ${TODO_COLUMNS}
             FROM todo_items WHERE user_id=? AND list_name=? AND done=0
            ORDER BY created_at ASC, id ASC`,
          [userId, listName],
        );
    return rows.map(toTodoItemRecord);
  }

  /**
   * Set an item's done state, scoped to its owner. Completing stamps
   * `done_at`; reopening clears it. Returns false when no row of this
   * user's matches the id — the item does not exist, or it is not theirs.
   */
  setDone(userId: string, id: number, done: boolean, nowMs: number): boolean {
    const res = this.exec(
      `UPDATE todo_items SET done=?, done_at=? WHERE id=? AND user_id=?`,
      [done ? 1 : 0, done ? nowMs : null, id, userId],
    );
    return res.changes > 0;
  }

  /** Delete one item, scoped to its owner. Returns whether a row went. */
  remove(userId: string, id: number): boolean {
    const res = this.exec(`DELETE FROM todo_items WHERE id=? AND user_id=?`, [id, userId]);
    return res.changes > 0;
  }

  /**
   * Delete every completed item on one of a user's lists.
   * Returns how many rows went.
   */
  clearCompleted(userId: string, listName: string): number {
    const res = this.exec(
      `DELETE FROM todo_items WHERE user_id=? AND list_name=? AND done=1`,
      [userId, listName],
    );
    return res.changes;
  }
}

/** DDL fragment owned by this repository (phase 6). The Storage facade
 *  assembles the full SCHEMA from the domain fragments in a fixed order;
 *  the statements themselves are byte-identical to the pre-split schema. */
export const TODO_SCHEMA = `

-- Per-user todo lists (schema 24, platform Phase 9 — Action Layer). One row
-- per checklist item; list_name separates named lists ("shopping",
-- "watchlist") from the default "main" list. Every query is scoped by
-- user_id, so lists are strictly personal. done_at is NULL while an item
-- is open and stamped when it is completed (cleared again on reopen).
CREATE TABLE IF NOT EXISTS todo_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  list_name  TEXT NOT NULL DEFAULT 'main',
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_todo_items_user_list ON todo_items(user_id, list_name, done);
`;
