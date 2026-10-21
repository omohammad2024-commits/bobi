/**
 * ConversationsRepo — Conversations repository (phase 6).
 *
 * Owns the SQL for: conversations, messages (+FTS), conversation_summaries.
 * Extracted from the old Storage god class; method bodies are unchanged,
 * only their home moved. Row shapes stay inside the storage layer.
 */

import { RepoBase } from "./base";
import { StorageError } from "../errors";
import { clampInt } from "./base";

export interface StoredMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number; // unix ms
}

/** One conversation owned by a user, with activity metadata (Phase: MCP server). */
export interface UserConversationSummary {
  /** External conversation id (chat_id — the same string the engine uses). */
  conversationId: string;
  createdAt: number; // unix ms
  messageCount: number;
  /** Latest message time, or createdAt when the conversation is still empty. */
  lastActivity: number; // unix ms
}

/** One full-text hit over the conversation history (Phase D1). */
export interface MessageSearchResult {
  id: number;
  conversationId: number;
  role: StoredMessage["role"];
  /** Snippet with the match wrapped in [ ], about 24 tokens of context. */
  snippet: string;
  /**
   * FTS5 bm25 rank (more negative = better). The LIKE fallback assigns 0 and
   * orders by recency instead, so compare ranks only within one code path.
   */
  rank: number;
}

/** A conversation's rolling summary plus how far it reaches. */
export interface ConversationSummary {
  summary: string;
  /** Id of the last message folded into the summary. */
  summarisedUntil: number;
  /** unix ms */
  updatedAt: number;
}

/**
 * Most messages folded into one summary pass.
 *
 * Bounded so a backlog (after an outage, or after a long gap) is summarised in
 * several affordable calls rather than one that may exceed the model's context
 * and then be retried forever without ever succeeding.
 */
const MAX_SUMMARY_BATCH = 40;

/**
 * Turn arbitrary user text into a safe FTS5 match expression.
 *
 * Every whitespace-separated token becomes a double-quoted phrase with
 * embedded quotes doubled (FTS5's own escape), joined by implicit AND. FTS5
 * operators (AND/OR/NOT, *, parentheses, ^, :) therefore never reach the
 * parser: the user always searches literal text, never query syntax. The
 * token count is capped so a hostile input cannot build a huge expression.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 32);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * Snippet for the LIKE fallback: ~60 characters around the first match, with
 * an ellipsis where text was cut. Code-point safe for Persian and emoji.
 */
function excerpt(content: string, needle: string): string {
  const idx = content.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return Array.from(content).slice(0, 120).join("");
  const points = Array.from(content);
  const needleLen = Array.from(needle).length;
  // indexOf counts UTF-16 units; map to code points for the slice.
  const before = Array.from(content.slice(0, idx)).length;
  const start = Math.max(0, before - 60);
  const end = Math.min(points.length, before + needleLen + 60);
  const cut = points.slice(start, end).join("");
  return `${start > 0 ? "…" : ""}${cut}${end < points.length ? "…" : ""}`;
}

export class ConversationsRepo extends RepoBase {
  /** Resolve (or create) the conversation owned by (userId, chatId). */
  conversationId(userId: string, chatId: string): number {
    const existing = this.query<{ id: number }>(
      `SELECT id FROM conversations WHERE user_id=? AND chat_id=?`,
      [userId, chatId],
    )[0];
    if (existing) return existing.id;
    this.exec(
      `INSERT INTO conversations(user_id, chat_id, created_at) VALUES(?,?,?)`,
      [userId, chatId, Date.now()],
    );
    const created = this.query<{ id: number }>(
      `SELECT id FROM conversations WHERE user_id=? AND chat_id=?`,
      [userId, chatId],
    )[0];
    if (!created) throw new StorageError("query", "failed to create conversation");
    return created.id;
  }

  /** Append a message; returns its id. Verifies ownership first. */
  appendMessage(
    userId: string,
    chatId: string,
    role: StoredMessage["role"],
    content: string,
  ): number {
    const convId = this.conversationId(userId, chatId);
    this.assertOwnership(convId, userId);
    const res = this.exec(
      `INSERT INTO messages(conversation_id, role, content, created_at) VALUES(?,?,?,?)`,
      [convId, role, content, Date.now()],
    );
    return Number(res.lastInsertRowid);
  }

  /**
   * Read history in chronological order, newest-last.
   * `limit` caps the count (most recent N kept, in order).
   * Returns [] if the caller does not own the conversation.
   */
  history(userId: string, chatId: string, limit = 50): StoredMessage[] {
    const conv = this.query<{ id: number }>(
      `SELECT id FROM conversations WHERE user_id=? AND chat_id=?`,
      [userId, chatId],
    )[0];
    if (!conv) return [];
    // subquery picks the last N by id, outer select re-orders ascending
    return this.query<StoredMessage>(
      `SELECT id, conversation_id AS conversationId, role, content, created_at AS createdAt
         FROM (
           SELECT id, conversation_id, role, content, created_at
           FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      [conv.id, limit],
    );
  }

  /** Delete a whole conversation (ownership-checked). */
  deleteConversation(userId: string, chatId: string): void {
    this.exec(`DELETE FROM conversations WHERE user_id=? AND chat_id=?`, [
      userId,
      chatId,
    ]);
  }

  // ---- conversation listing for the MCP server (Phase: MCP server) ----

  /**
   * List every conversation owned by a user, newest activity first.
   *
   * Used by the MCP `bobi_list_conversations` tool. Ownership is enforced by
   * filtering on user_id: a caller only ever sees their own conversations.
   * The external conversation id is the chat_id — the same string the
   * ConversationEngine uses as its conversationId.
   */
  listUserConversations(userId: string): UserConversationSummary[] {
    const rows = this.query<{
      chat_id: string;
      created_at: number;
      message_count: number;
      last_activity: number | null;
    }>(
      `SELECT c.chat_id, c.created_at,
              COUNT(m.id) AS message_count,
              MAX(m.created_at) AS last_activity
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.user_id = ?
        GROUP BY c.id
        ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC`,
      [userId],
    );
    return rows.map((r) => ({
      conversationId: r.chat_id,
      createdAt: r.created_at,
      messageCount: r.message_count,
      // An empty conversation has no messages; its creation time is the
      // freshest fact we have about it.
      lastActivity: r.last_activity ?? r.created_at,
    }));
  }

  /**
   * Count persisted messages in one conversation.
   *
   * Used by the MCP `bobi_conversation_status` tool. Ownership-checked: a
   * conversation the caller does not own reads as zero, never as someone
   * else's count.
   */
  countMessages(userId: string, chatId: string): number {
    const row = this.query<{ n: number }>(
      `SELECT COUNT(m.id) AS n
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ? AND c.chat_id = ?`,
      [userId, chatId],
    )[0];
    return row?.n ?? 0;
  }

  // ---- full-text search over message history (Phase D1) ----

  /**
   * Full-text search over message content, via the messages_fts index.
   *
   * SECURITY — two properties hold here, both enforced below:
   * 1. The MATCH expression is built from user input but never concatenated
   *    into SQL: it travels as a bound parameter, and sanitizeFtsQuery quotes
   *    every token first, so FTS5 operators can never reach the parser.
   * 2. Ownership is enforced by joining conversations on user_id: a caller
   *    only ever sees their own conversations. A conversationId that is not
   *    the caller's simply matches nothing.
   *
   * A query FTS5 cannot parse falls back to a literal LIKE search rather than
   * throwing — search must degrade, not fail, on odd input.
   */
  searchMessages(
    query: string,
    opts: { userId?: string; limit?: number; conversationId?: number } = {},
  ): MessageSearchResult[] {
    const limit = clampInt(opts.limit ?? 5, 1, 20, 5);
    if (query.trim().length === 0) return [];

    const match = sanitizeFtsQuery(query);
    try {
      return this.ftsSearch(match, opts, limit);
    } catch {
      return this.likeSearch(query.trim(), opts, limit);
    }
  }

  /** The FTS5 code path: indexed, ranked, with highlighted snippets. */
  private ftsSearch(
    match: string,
    opts: { userId?: string; conversationId?: number },
    limit: number,
  ): MessageSearchResult[] {
    const filters: string[] = [];
    // The MATCH operand is a bound parameter, not string concatenation: the
    // expression is user-derived but SQLite parses it as data, never as SQL.
    const params: unknown[] = [match];
    if (opts.userId !== undefined) {
      filters.push("c.user_id = ?");
      params.push(opts.userId);
    }
    if (opts.conversationId !== undefined) {
      filters.push("m.conversation_id = ?");
      params.push(opts.conversationId);
    }
    params.push(limit);
    const where = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
    const rows = this.query<{
      id: number;
      conversation_id: number;
      role: string;
      snippet: string;
      rank: number;
    }>(
      `SELECT m.id AS id, m.conversation_id, m.role,
              snippet(messages_fts, 0, '[', ']', '…', 24) AS snippet,
              rank AS rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ?
          ${where}
        ORDER BY rank
        LIMIT ?`,
      params,
    );
    // The CHECK constraint on messages.role guarantees these three values.
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as StoredMessage["role"],
      snippet: r.snippet,
      rank: r.rank,
    }));
  }

  /** Literal substring fallback when FTS5 cannot parse the query. */
  private likeSearch(
    query: string,
    opts: { userId?: string; conversationId?: number },
    limit: number,
  ): MessageSearchResult[] {
    // Escape LIKE wildcards first so the fallback stays literal, then wrap.
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const filters: string[] = [];
    const params: unknown[] = [pattern];
    if (opts.userId !== undefined) {
      filters.push("c.user_id = ?");
      params.push(opts.userId);
    }
    if (opts.conversationId !== undefined) {
      filters.push("m.conversation_id = ?");
      params.push(opts.conversationId);
    }
    params.push(limit);
    const where = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
    const rows = this.query<{ id: number; conversation_id: number; role: string; content: string }>(
      `SELECT m.id AS id, m.conversation_id, m.role, m.content
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.content LIKE ? ESCAPE '\\'
          ${where}
        ORDER BY m.id DESC
        LIMIT ?`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as StoredMessage["role"],
      snippet: excerpt(r.content, query),
      rank: 0,
    }));
  }

  /** Assert convId belongs to userId; throw otherwise. */
  private assertOwnership(convId: number, userId: string): void {
    const row = this.query<{ user_id: string }>(
      `SELECT user_id FROM conversations WHERE id=?`,
      [convId],
    )[0];
    if (!row || row.user_id !== userId) {
      throw new StorageError("constraint", "conversation not owned by caller");
    }
  }

  // ---- conversation summaries ----

  /** The stored rolling summary for a conversation, if one exists. */
  getConversationSummary(userId: string, chatId: string): ConversationSummary | undefined {
    const row = this.query<{
      summary: string;
      summarised_until: number;
      updated_at: number;
    }>(
      `SELECT summary, summarised_until, updated_at
         FROM conversation_summaries WHERE user_id=? AND chat_id=?`,
      [userId, chatId],
    )[0];
    if (!row) return undefined;
    return {
      summary: row.summary,
      summarisedUntil: row.summarised_until,
      updatedAt: row.updated_at,
    };
  }

  /** Store (or replace) a conversation's rolling summary and watermark. */
  setConversationSummary(s: {
    userId: string;
    chatId: string;
    summary: string;
    summarisedUntil: number;
  }): void {
    this.exec(
      `INSERT INTO conversation_summaries(user_id, chat_id, summary, summarised_until, updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(user_id, chat_id) DO UPDATE SET
         summary=excluded.summary,
         summarised_until=excluded.summarised_until,
         updated_at=excluded.updated_at`,
      [s.userId, s.chatId, s.summary, s.summarisedUntil, Date.now()],
    );
  }

  /** Drop a conversation's rolling summary. */
  clearConversationSummary(userId: string, chatId: string): boolean {
    return (
      this.exec(`DELETE FROM conversation_summaries WHERE user_id=? AND chat_id=?`, [
        userId,
        chatId,
      ]).changes > 0
    );
  }

  /**
   * Messages that overflow the window and are not yet summarised.
   *
   * This is the incremental read that replaces re-summarising the whole prior
   * conversation: only rows after the watermark are returned, so each message
   * is folded into the summary exactly once.
   *
   * `keepLast` messages are excluded, because those still fit in the window and
   * belong to the model verbatim rather than to the summary.
   */
  unsummarisedMessages(
    userId: string,
    chatId: string,
    summarisedUntil: number,
    keepLast: number,
  ): StoredMessage[] {
    const conv = this.query<{ id: number }>(
      `SELECT id FROM conversations WHERE user_id=? AND chat_id=?`,
      [userId, chatId],
    )[0];
    if (!conv) return [];

    // The id of the newest message that still fits in the window. Everything
    // strictly below it is overflow.
    const boundary = this.query<{ id: number }>(
      `SELECT id FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1 OFFSET ?`,
      [conv.id, Math.max(0, keepLast - 1)],
    )[0];
    if (!boundary) return [];

    // Bounded on purpose. An outage can leave a large backlog unsummarised; a
    // batch that grew without limit would eventually be too big to summarise
    // at all, and every subsequent turn would retry that impossible call
    // forever. Taking the oldest chunk first guarantees the watermark can
    // always advance.
    return this.query<StoredMessage>(
      `SELECT id, conversation_id AS conversationId, role, content, created_at AS createdAt
         FROM messages
        WHERE conversation_id=? AND id>? AND id<?
        ORDER BY id ASC LIMIT ?`,
      [conv.id, summarisedUntil, boundary.id, MAX_SUMMARY_BATCH],
    );
  }
}

/** DDL fragment owned by this repository (phase 6). The Storage facade
 *  assembles the full SCHEMA from the domain fragments in a fixed order;
 *  the statements themselves are byte-identical to the pre-split schema. */
export const CONVERSATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(user_id, chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);

-- Full-text index over message content (Phase D1).
--
-- An external-content FTS5 table: the index lives in messages_fts while the
-- documents stay in messages, so the index can never drift from the table it
-- mirrors. The three triggers keep it in sync inside the same transaction as
-- the message write — a sync step in the insert path could not guarantee
-- that: any writer that bypassed the path would leave the index stale, and a
-- rolled-back transaction would leave the index ahead. unicode61 tokenizes
-- Persian text into words. If FTS5 were ever compiled out of SQLite, this
-- CREATE would fail the migration loudly instead of silently shipping a bot
-- whose history search pretends to work.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES(new.id, new.content);
END;

-- Rolling summary of a conversation's older turns, plus a watermark.
--
-- The summarised_until column is the id of the last message folded into the
-- summary. It is what makes compaction incremental: each turn summarises only the messages
-- that have overflowed the window since the last pass, instead of re-summarising
-- the whole prior conversation. Without a watermark the bot pays for a second
-- model call on every single message once a conversation grows past its window.
--
-- Stored rather than kept in memory so a restart does not lose the summary —
-- losing it would permanently drop the older turns it covers.
CREATE TABLE IF NOT EXISTS conversation_summaries (
  user_id          TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  summary          TEXT NOT NULL,
  summarised_until INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);
`;
