/**
 * Storage layer — the only place SQL lives. Conversation logic never
 * touches the database directly.
 *
 * Ownership is enforced HERE (not just in the Telegram handler): every
 * read/write requires the owner's userId, so a caller cannot reach
 * another user's history by guessing a conversation id.
 *
 * Secrets, tokens, and message content are never logged by this layer.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class StorageError extends Error {
  constructor(readonly kind: "open" | "query" | "constraint" | "closed", message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export interface StoredMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number; // unix ms
}

export type AuditOutcome = "success" | "denied" | "error";

/** A configured AI provider, without any credential material. */
export interface AiProviderRow {
  id: number;
  label: string;
  /** Adapter type slug, e.g. "openai_compatible". */
  adapter: string;
  baseUrl: string;
  enabled: boolean;
  /** Owner-set exception allowing loopback/private hosts for this provider. */
  allowLocal: boolean;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
}

/** The encrypted credential envelope for a provider. */
export interface EncryptedCredentialRow {
  providerId: number;
  iv: string;
  ciphertext: string;
  tag: string;
  /** unix ms */
  updatedAt: number;
}

/** A model belonging to a provider. */
export interface AiModelRow {
  id: number;
  providerId: number;
  /** The real id the service expects. Never user-authored display text. */
  modelId: string;
  /** Display name chosen by the owner. */
  label: string;
  enabled: boolean;
  isDefault: boolean;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
}

/** Daily usage counters. Counts only — never message content. */
export interface UsageRecord {
  /** Owner id, or "*" for an aggregate row. */
  userId: string;
  /** Calendar day, YYYY-MM-DD. */
  day: string;
  requests: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** How often a reminder repeats after firing. */
export type ReminderRepeat = "none" | "daily" | "weekly";

/** Lifecycle of a reminder. */
export type ReminderState = "pending" | "fired" | "cancelled";

/** One scheduled reminder. Always scoped to its owner. */
export interface ReminderRecord {
  id: number;
  userId: string;
  /** Chat the reminder is delivered to. */
  chatId: string;
  text: string;
  /** unix ms — when it should fire. */
  dueAt: number;
  repeat: ReminderRepeat;
  state: ReminderState;
  /** unix ms */
  createdAt: number;
  /** unix ms — set when it actually fired. */
  firedAt?: number;
}

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
}

/** The single-row web-search selection. */
export interface SearchSettings {
  /** Provider slug; see SEARCH_PROVIDER_TYPES. */
  provider: string;
}

/** The single-row runtime selection. */
export interface AiRuntimeSettings {
  activeProviderId: number | null;
  activeModelId: number | null;
}

/** Latest health probe result for a provider. */
export interface AiProviderHealthRow {
  providerId: number;
  ok: boolean;
  /** unix ms */
  checkedAt: number;
  /** Safe, provider-chosen message. Never a key or a full response. */
  message?: string;
}

/** Failover policy. Disabled by default. */
export interface AiFailoverSettings {
  enabled: boolean;
  /** Total tries per request, including the first. Bounded 1..4. */
  maxAttempts: number;
  /** Per-candidate timeout, ms. Bounded 1000..60000. */
  timeoutMs: number;
}

/** One ordered failover candidate. */
export interface AiFailoverCandidate {
  providerId: number;
  modelId: number;
  position: number;
}

/** Group approval lifecycle. */
export type GroupState = "pending" | "approved" | "rejected" | "revoked";

export interface GroupAccessRecord {
  /** Telegram chat id as a string — the stable unique key. */
  chatId: string;
  /** Group title, when Telegram provided one. */
  title?: string;
  chatType: "group" | "supergroup" | "channel";
  state: GroupState;
  /** Numeric id of whoever added the bot, only when genuinely known. */
  requestedBy?: string;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
  /** unix ms — set on approve/reject/revoke. */
  decidedAt?: number;
  /** Numeric owner id that took the decision. */
  decidedBy?: string;
  /** unix ms — set once the owner has been notified. */
  notifiedAt?: number;
}

/**
 * Private-chat user approval, mirroring {@link GroupAccessRecord}.
 *
 * A private chat has no other gate, so this is what stands between an unknown
 * Telegram account and the owner's API budget.
 */
export interface UserAccessRecord {
  /** Telegram numeric user id as a string — the stable unique key. */
  userId: string;
  /** Telegram @username, when the account has one. Cosmetic only. */
  username?: string;
  /** Telegram first name, shown to the owner when deciding. Cosmetic only. */
  firstName?: string;
  state: GroupState;
  /** unix ms */
  requestedAt: number;
  /** unix ms */
  updatedAt: number;
  /** unix ms — set on approve/reject/revoke. */
  decidedAt?: number;
  /** Numeric owner id that took the decision. */
  decidedBy?: string;
  /** unix ms — set once the owner has been notified. */
  notifiedAt?: number;
}

export interface AuditEvent {
  id: number;
  /** unix ms */
  createdAt: number;
  operation: string;
  actorId?: string;
  outcome: AuditOutcome;
  targetId?: string;
  detail?: string;
}

const SCHEMA = `
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

-- Security audit trail. Append-only, kept small by a retention cap enforced
-- on write. Message content is never stored here — only operation metadata.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  operation   TEXT NOT NULL,
  actor_id    TEXT,
  outcome     TEXT NOT NULL CHECK(outcome IN ('success','denied','error')),
  target_id   TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(id DESC);

-- Group access approvals. One row per Telegram group, keyed by chat id.
-- requested_by / decided_by hold numeric Telegram user ids, stored only when
-- genuinely known; group titles are chat metadata, not message content.
-- notified_at guards against duplicate owner notifications on retries.
CREATE TABLE IF NOT EXISTS group_access (
  chat_id      TEXT PRIMARY KEY,
  title        TEXT,
  chat_type    TEXT NOT NULL CHECK(chat_type IN ('group','supergroup','channel')),
  state        TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','revoked')),
  requested_by TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT,
  notified_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_group_state ON group_access(state, updated_at DESC);

-- Private-chat user approvals. Mirrors group_access deliberately: the same
-- state machine, the same guarded transitions, the same "never auto-approved"
-- rule. Without this, anyone who finds the bot can spend the owner's API
-- budget, because a private chat has no other gate.
CREATE TABLE IF NOT EXISTS user_access (
  user_id      TEXT PRIMARY KEY,
  username     TEXT,
  first_name   TEXT,
  state        TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','revoked')),
  requested_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT,
  notified_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_state ON user_access(state, updated_at DESC);

-- Active web-search provider. Single row; the default needs no credential, so
-- a fresh install can search without any configuration.
CREATE TABLE IF NOT EXISTS search_settings (
  id       INTEGER PRIMARY KEY CHECK(id = 1),
  provider TEXT NOT NULL DEFAULT 'duckduckgo'
);

-- Encrypted credential for a keyed search provider. Same AES-256-GCM envelope
-- as ai_credentials; a missing row simply means "no key set".
CREATE TABLE IF NOT EXISTS search_credentials (
  id         INTEGER PRIMARY KEY CHECK(id = 1),
  iv         TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Daily usage counters, one row per (owner, day). Token counts let the owner
-- see what the agent actually costs; tool_calls and requests show where the
-- spend comes from. Only counts are stored — never message content.
CREATE TABLE IF NOT EXISTS usage (
  user_id        TEXT NOT NULL,
  day            TEXT NOT NULL,
  requests       INTEGER NOT NULL DEFAULT 0,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day, user_id);

-- Scheduled reminders. Scoped to the owner by user_id on every query, like
-- memories. The state column moves pending -> fired | cancelled, and a fired
-- reminder that repeats is re-armed in place, so what was sent stays recorded.
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  due_at     INTEGER NOT NULL,
  repeat     TEXT NOT NULL DEFAULT 'none' CHECK(repeat IN ('none','daily','weekly')),
  state      TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','fired','cancelled')),
  created_at INTEGER NOT NULL,
  fired_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(state, due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(user_id, state, due_at);

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
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(user_id, updated_at DESC);

-- AI providers. One row per configured service.
-- Credentials live in ai_credentials (encrypted), never here.
CREATE TABLE IF NOT EXISTS ai_providers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  adapter     TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  -- Owner-set exception for a self-hosted local endpoint. Off by default:
  -- a fresh provider must never reach loopback/private addresses.
  allow_local INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Encrypted credentials for a provider. AES-256-GCM: iv, ciphertext, tag.
-- A missing credential row simply means "no key set".
CREATE TABLE IF NOT EXISTS ai_credentials (
  provider_id INTEGER PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
  iv          TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Models offered by a provider. model_id is the real id the service expects;
-- label is a display name the owner chooses. Exactly one per provider is default.
CREATE TABLE IF NOT EXISTS ai_models (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,
  label       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);

-- Runtime selection. Single-row table; a NULL active_* means "none selected".
CREATE TABLE IF NOT EXISTS ai_runtime_settings (
  id               INTEGER PRIMARY KEY CHECK(id = 1),
  active_provider_id INTEGER,
  active_model_id    INTEGER
);

-- Latest health probe result per provider. Never stores key material.
CREATE TABLE IF NOT EXISTS ai_provider_health (
  provider_id    INTEGER PRIMARY KEY REFERENCES ai_providers(id) ON DELETE CASCADE,
  ok             INTEGER NOT NULL,
  checked_at     INTEGER NOT NULL,
  message        TEXT
);

-- Failover settings. Single row: off by default, so nothing ever switches
-- provider without the owner turning it on explicitly.
CREATE TABLE IF NOT EXISTS ai_failover_settings (
  id          INTEGER PRIMARY KEY CHECK(id = 1),
  enabled     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  timeout_ms  INTEGER NOT NULL DEFAULT 15000
);

-- Ordered failover candidates. Only rows the owner added here may be used,
-- and each is revalidated at request time (enabled, credential present).
CREATE TABLE IF NOT EXISTS ai_failover_candidates (
  provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id    INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_failover_order ON ai_failover_candidates(position);
`;

/**
 * Current schema version.
 *
 * Exported so a test can assert it by name rather than repeating the literal:
 * a hardcoded copy silently rots each time this is bumped.
 */
export const SCHEMA_VERSION = 10;

/**
 * Hard cap on audit rows. Oldest rows are pruned once the count exceeds this,
 * which bounds file growth without an external scheduler.
 */
const AUDIT_MAX_ROWS = 5000;

export class Storage {
  private db: Database;
  private closed = false;

  private constructor(db: Database) {
    this.db = db;
  }

  /** Open (or create) a SQLite database and run migrations. Idempotent. */
  static open(path: string): Storage {
    try {
      if (path !== ":memory:") {
        const dir = dirname(path);
        // A bare filename has no directory to create; mkdirSync(".") throws EEXIST here.
        if (dir !== "." && dir.length > 0) mkdirSync(dir, { recursive: true });
      }
      const db = new Database(path);
      const s = new Storage(db);
      s.migrate();
      return s;
    } catch (err) {
      throw new StorageError("open", msg(err));
    }
  }

  private migrate(): void {
    this.exec("PRAGMA journal_mode=WAL;");
    this.exec("PRAGMA foreign_keys=ON;");
    this.exec(`CREATE TABLE IF NOT EXISTS _meta(k TEXT PRIMARY KEY, v TEXT)`);
    const row = this.query<{ v: string }>(
      `SELECT v FROM _meta WHERE k='schema_version'`,
    )[0];
    const current = row ? Number(row.v) : 0;
    if (current < SCHEMA_VERSION) {
      this.exec("BEGIN");
      try {
        // Must be exec(): SCHEMA is multiple statements, and prepare() runs only the first.
        this.db.exec(SCHEMA);
        // CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so a
        // column added in a later version needs its own idempotent ALTER.
        this.addColumnIfMissing("ai_providers", "allow_local", "INTEGER NOT NULL DEFAULT 0");
        this.exec(
          `INSERT INTO _meta(k,v) VALUES('schema_version',?) ` +
            `ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
          [String(SCHEMA_VERSION)],
        );
        this.exec("COMMIT");
      } catch (err) {
        this.exec("ROLLBACK");
        throw new StorageError("query", `migration failed: ${msg(err)}`);
      }
    }
  }

  /** Add a column when an older database does not have it yet. */
  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const rows = this.query<{ name: string }>(`PRAGMA table_info(${table})`);
    if (rows.some((r) => r.name === column)) return;
    this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

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
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close(true);
    } catch {
      // Cleanup is best-effort during shutdown: report that it did not finish
      // without printing the path or any SQLite detail.
      console.error("[sol] storage: database did not close cleanly");
    }
  }

  // ---- audit log ----

  /**
   * Append one security audit event, then prune to the retention cap.
   *
   * `actorId` and `targetId` are ids, not message content. `detail` is a
   * short, caller-supplied note that must already be free of secrets — this
   * layer stores only what it is given and never reads user messages.
   */
  appendAudit(event: {
    operation: string;
    outcome: "success" | "denied" | "error";
    actorId?: string;
    targetId?: string;
    detail?: string;
  }): number {
    const res = this.exec(
      `INSERT INTO audit_log(created_at, operation, actor_id, outcome, target_id, detail)
       VALUES(?,?,?,?,?,?)`,
      [
        Date.now(),
        event.operation,
        event.actorId ?? null,
        event.outcome,
        event.targetId ?? null,
        event.detail ?? null,
      ],
    );
    this.pruneAudit();
    return Number(res.lastInsertRowid);
  }

  /** Newest-first audit events, capped at `limit`. */
  auditEvents(limit = 100): AuditEvent[] {
    const rows = this.query<{
      id: number;
      created_at: number;
      operation: string;
      actor_id: string | null;
      outcome: string;
      target_id: string | null;
      detail: string | null;
    }>(
      `SELECT id, created_at, operation, actor_id, outcome, target_id, detail
         FROM audit_log ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      operation: r.operation,
      outcome: r.outcome as AuditOutcome,
      ...(r.actor_id !== null ? { actorId: r.actor_id } : {}),
      ...(r.target_id !== null ? { targetId: r.target_id } : {}),
      ...(r.detail !== null ? { detail: r.detail } : {}),
    }));
  }

  /** Drop the oldest rows so at most AUDIT_MAX_ROWS remain. */
  private pruneAudit(): void {
    this.exec(
      `DELETE FROM audit_log WHERE id NOT IN (
         SELECT id FROM audit_log ORDER BY id DESC LIMIT ?
       )`,
      [AUDIT_MAX_ROWS],
    );
  }

  // ---- group access ----

  /**
   * Fetch one group record by chat id, or undefined.
   * Used on every group update so access never relies on a stale cache.
   */
  groupAccess(chatId: string): GroupAccessRecord | undefined {
    const rows = this.query<GroupRow>(
      `SELECT chat_id, title, chat_type, state, requested_by,
              created_at, updated_at, decided_at, decided_by, notified_at
         FROM group_access WHERE chat_id=?`,
      [chatId],
    );
    const r = rows[0];
    if (!r) return undefined;
    return toGroupRecord(r);
  }

  /**
   * Insert a pending record for a chat that has no row yet.
   *
   * Returns "created" only for the first insert, so repeated membership
   * updates cannot produce duplicate pending rows or repeat notifications.
   */
  createPendingGroup(g: {
    chatId: string;
    title?: string;
    chatType: GroupAccessRecord["chatType"];
    requestedBy?: string;
  }): "created" | "exists" {
    const existing = this.groupAccess(g.chatId);
    if (existing) return "exists";

    const now = Date.now();
    this.exec(
      `INSERT INTO group_access(chat_id, title, chat_type, state, requested_by, created_at, updated_at)
       VALUES(?,?,?,'pending',?,?,?)`,
      [g.chatId, g.title ?? null, g.chatType, g.requestedBy ?? null, now, now],
    );
    return "created";
  }

  /**
   * Move a group to a new state.
   *
   * The WHERE clause re-tests the expected current state, so a replayed or
   * stale action finds no row to update and reports false instead of applying
   * a contradictory transition. Returns whether the row was changed.
   */
  transitionGroup(chatId: string, expected: GroupState, to: GroupState, decidedBy: string): boolean {
    const res = this.exec(
      `UPDATE group_access
          SET state=?, decided_at=?, decided_by=?, updated_at=?
        WHERE chat_id=? AND state=?`,
      [to, Date.now(), decidedBy, Date.now(), chatId, expected],
    );
    return res.changes > 0;
  }

  /** List groups by state, newest first, with a capped page size. */
  listGroupsByState(state: GroupState, limit = 10, offset = 0): GroupAccessRecord[] {
    // A query that escapes the cap or goes negative is clamped, not guessed at.
    const safeLimit = clampInt(limit, 1, 50, 10);
    const safeOffset = clampInt(offset, 0, 10000, 0);
    const rows = this.query<GroupRow>(
      `SELECT chat_id, title, chat_type, state, requested_by,
              created_at, updated_at, decided_at, decided_by, notified_at
         FROM group_access WHERE state=?
        ORDER BY updated_at DESC, chat_id ASC LIMIT ? OFFSET ?`,
      [state, safeLimit, safeOffset],
    );
    return rows.map(toGroupRecord);
  }

  /** Count of groups in a state — bounded, cheap status information. */
  countGroupsByState(state: GroupState): number {
    return this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM group_access WHERE state=?`,
      [state],
    )[0]?.n ?? 0;
  }

  /**
   * Mark that the owner has already been notified for this group.
   * Conditioned on the stored timestamp so a concurrent retry cannot reset it.
   */
  markGroupNotified(chatId: string, onlyIf: number | undefined): boolean {
    const res =
      onlyIf === undefined
        ? this.exec(`UPDATE group_access SET notified_at=? WHERE chat_id=?`, [
            Date.now(),
            chatId,
          ])
        : this.exec(
            `UPDATE group_access SET notified_at=? WHERE chat_id=? AND notified_at IS ?`,
            [Date.now(), chatId, onlyIf],
          );
    return res.changes > 0;
  }

  // ---- user access ----

  /**
   * Fetch one private-chat user record, or undefined.
   * Read on every message so revocation takes effect immediately.
   */
  userAccess(userId: string): UserAccessRecord | undefined {
    const rows = this.query<UserRow>(
      `SELECT user_id, username, first_name, state,
              requested_at, updated_at, decided_at, decided_by, notified_at
         FROM user_access WHERE user_id=?`,
      [userId],
    );
    const r = rows[0];
    if (!r) return undefined;
    return toUserRecord(r);
  }

  /**
   * Insert a pending record for a user who has no row yet.
   *
   * Returns "created" only for the first insert, so repeated messages cannot
   * produce duplicate rows or repeat owner notifications.
   */
  createPendingUser(u: {
    userId: string;
    username?: string;
    firstName?: string;
  }): "created" | "exists" {
    if (this.userAccess(u.userId)) return "exists";

    const now = Date.now();
    this.exec(
      `INSERT INTO user_access(user_id, username, first_name, state, requested_at, updated_at)
       VALUES(?,?,?,'pending',?,?)`,
      [u.userId, u.username ?? null, u.firstName ?? null, now, now],
    );
    return "created";
  }

  /**
   * Move a user to a new state.
   *
   * The WHERE clause re-tests the expected current state, so a replayed or
   * stale decision finds no row to update and reports false instead of applying
   * a contradictory transition.
   */
  transitionUser(userId: string, expected: GroupState, to: GroupState, decidedBy: string): boolean {
    const res = this.exec(
      `UPDATE user_access
          SET state=?, decided_at=?, decided_by=?, updated_at=?
        WHERE user_id=? AND state=?`,
      [to, Date.now(), decidedBy, Date.now(), userId, expected],
    );
    return res.changes > 0;
  }

  /** List users by state, newest activity first, with a capped page size. */
  listUsersByState(state: GroupState, limit = 10, offset = 0): UserAccessRecord[] {
    const safeLimit = clampInt(limit, 1, 50, 10);
    const safeOffset = clampInt(offset, 0, 10000, 0);
    const rows = this.query<UserRow>(
      `SELECT user_id, username, first_name, state,
              requested_at, updated_at, decided_at, decided_by, notified_at
         FROM user_access WHERE state=?
        ORDER BY updated_at DESC, user_id ASC LIMIT ? OFFSET ?`,
      [state, safeLimit, safeOffset],
    );
    return rows.map(toUserRecord);
  }

  /** Count of users in a state. */
  countUsersByState(state: GroupState): number {
    return this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_access WHERE state=?`,
      [state],
    )[0]?.n ?? 0;
  }

  /**
   * Mark that the owner has already been notified about this user.
   * Conditioned on the stored timestamp so a concurrent retry cannot reset it.
   */
  markUserNotified(userId: string, onlyIf: number | undefined): boolean {
    const res =
      onlyIf === undefined
        ? this.exec(`UPDATE user_access SET notified_at=? WHERE user_id=?`, [Date.now(), userId])
        : this.exec(
            `UPDATE user_access SET notified_at=? WHERE user_id=? AND notified_at IS ?`,
            [Date.now(), userId, onlyIf],
          );
    return res.changes > 0;
  }

  // ---- usage ----

  /**
   * Add one run's counters to a user's day.
   *
   * An upsert of increments, so concurrent runs for the same user cannot
   * overwrite each other's totals — the arithmetic happens in SQLite.
   */
  addUsage(u: {
    userId: string;
    day: string;
    requests: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  }): void {
    this.exec(
      `INSERT INTO usage(user_id, day, requests, tool_calls, input_tokens, output_tokens)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         requests      = requests + excluded.requests,
         tool_calls    = tool_calls + excluded.tool_calls,
         input_tokens  = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens`,
      [u.userId, u.day, u.requests, u.toolCalls, u.inputTokens, u.outputTokens],
    );
  }

  /** One user's counters for one day, or zeros when nothing was recorded. */
  usageFor(userId: string, day: string): UsageRecord {
    const row = this.query<{
      user_id: string;
      day: string;
      requests: number;
      tool_calls: number;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT user_id, day, requests, tool_calls, input_tokens, output_tokens
         FROM usage WHERE user_id=? AND day=?`,
      [userId, day],
    )[0];

    return row
      ? toUsageRecord(row)
      : {
          userId,
          day,
          requests: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
  }

  /** Totals across all users for one day, for the owner's status view. */
  usageForDay(day: string): UsageRecord {
    const row = this.query<{
      requests: number;
      tool_calls: number;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT COALESCE(SUM(requests),0) AS requests,
              COALESCE(SUM(tool_calls),0) AS tool_calls,
              COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens
         FROM usage WHERE day=?`,
      [day],
    )[0];

    return {
      userId: "*",
      day,
      requests: row?.requests ?? 0,
      toolCalls: row?.tool_calls ?? 0,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
    };
  }

  // ---- reminders ----

  /** Insert a pending reminder. Returns its id. */
  createReminder(r: {
    userId: string;
    chatId: string;
    text: string;
    dueAt: number;
    repeat: ReminderRepeat;
  }): number {
    const res = this.exec(
      `INSERT INTO reminders(user_id, chat_id, text, due_at, repeat, state, created_at)
       VALUES(?,?,?,?,?,'pending',?)`,
      [r.userId, r.chatId, r.text, r.dueAt, r.repeat, Date.now()],
    );
    return Number(res.lastInsertRowid);
  }

  /** One reminder by id, scoped to its owner. */
  getReminder(userId: string, id: number): ReminderRecord | undefined {
    const row = this.query<ReminderRow>(
      `SELECT id, user_id, chat_id, text, due_at, repeat, state, created_at, fired_at
         FROM reminders WHERE user_id=? AND id=?`,
      [userId, id],
    )[0];
    return row ? toReminderRecord(row) : undefined;
  }

  /** A user's pending reminders, soonest first. */
  listReminders(userId: string, limit = 50): ReminderRecord[] {
    const safeLimit = clampInt(limit, 1, 200, 50);
    return this.query<ReminderRow>(
      `SELECT id, user_id, chat_id, text, due_at, repeat, state, created_at, fired_at
         FROM reminders WHERE user_id=? AND state='pending'
        ORDER BY due_at ASC, id ASC LIMIT ?`,
      [userId, safeLimit],
    ).map(toReminderRecord);
  }

  /** Count of a user's pending reminders, for the per-user cap. */
  countPendingReminders(userId: string): number {
    return (
      this.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM reminders WHERE user_id=? AND state='pending'`,
        [userId],
      )[0]?.n ?? 0
    );
  }

  /**
   * Every reminder that is due, across all owners.
   *
   * The scheduler is the only caller: it must see all users so one shared timer
   * can serve everyone.
   */
  dueReminders(now: number, limit = 50): ReminderRecord[] {
    const safeLimit = clampInt(limit, 1, 500, 50);
    return this.query<ReminderRow>(
      `SELECT id, user_id, chat_id, text, due_at, repeat, state, created_at, fired_at
         FROM reminders WHERE state='pending' AND due_at<=?
        ORDER BY due_at ASC, id ASC LIMIT ?`,
      [now, safeLimit],
    ).map(toReminderRecord);
  }

  /**
   * Claim a reminder for delivery: pending -> fired.
   *
   * The UPDATE re-tests `state='pending'`, so two schedulers racing over the
   * same row produce exactly one winner. Without this a reminder could be sent
   * twice, which is worse than sending it late.
   */
  claimReminder(id: number, firedAt: number): boolean {
    const res = this.exec(
      `UPDATE reminders SET state='fired', fired_at=? WHERE id=? AND state='pending'`,
      [firedAt, id],
    );
    return res.changes > 0;
  }

  /** Cancel a pending reminder, scoped to its owner. */
  cancelReminder(userId: string, id: number): boolean {
    const res = this.exec(
      `UPDATE reminders SET state='cancelled' WHERE id=? AND user_id=? AND state='pending'`,
      [id, userId],
    );
    return res.changes > 0;
  }

  /**
   * Replace a fired reminder's due time, for a repeating one.
   *
   * Only a `fired` row may be re-armed, so a cancelled reminder cannot be
   * resurrected by a stale scheduler pass.
   */
  rearmReminder(id: number, dueAt: number): boolean {
    const res = this.exec(
      `UPDATE reminders SET state='pending', due_at=?, fired_at=NULL WHERE id=? AND state='fired'`,
      [dueAt, id],
    );
    return res.changes > 0;
  }

  // ---- long-term memory ----

  /**
   * Store (or replace) one memory for one user.
   *
   * The owner is part of the key, so a write can only ever touch the caller's
   * own memory — there is no way to address another user's row.
   */
  upsertMemory(m: { userId: string; key: string; content: string }): void {
    const now = Date.now();
    this.exec(
      `INSERT INTO memories(user_id, key, content, created_at, updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         content=excluded.content, updated_at=excluded.updated_at`,
      [m.userId, m.key, m.content, now, now],
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
    }>(
      `SELECT user_id, key, content, created_at, updated_at
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
    }>(
      `SELECT user_id, key, content, created_at, updated_at
         FROM memories WHERE user_id=?
        ORDER BY updated_at DESC, key ASC LIMIT ?`,
      [userId, safeLimit],
    ).map(toMemoryRecord);
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

  // ---- web search ----

  /**
   * The active search provider. Always fully specified: a fresh database
   * defaults to the keyless provider, so search works out of the box.
   */
  getSearchSettings(): SearchSettings {
    const row = this.query<{ provider: string }>(
      `SELECT provider FROM search_settings WHERE id=1`,
    )[0];
    return { provider: row?.provider ?? "duckduckgo" };
  }

  /** Persist the active search provider. */
  setSearchProvider(provider: string): void {
    this.exec(
      `INSERT INTO search_settings(id, provider) VALUES(1,?)
       ON CONFLICT(id) DO UPDATE SET provider=excluded.provider`,
      [provider],
    );
  }

  /** The stored search credential envelope, or undefined when none is set. */
  getSearchCredential(): EncryptedCredentialRow | undefined {
    const row = this.query<{
      iv: string;
      ciphertext: string;
      tag: string;
      updated_at: number;
    }>(`SELECT iv, ciphertext, tag, updated_at FROM search_credentials WHERE id=1`)[0];
    if (!row) return undefined;
    return {
      providerId: 0,
      iv: row.iv,
      ciphertext: row.ciphertext,
      tag: row.tag,
      updatedAt: row.updated_at,
    };
  }

  /** Store (or replace) the search credential envelope. */
  upsertSearchCredential(c: { iv: string; ciphertext: string; tag: string }): void {
    this.exec(
      `INSERT INTO search_credentials(id, iv, ciphertext, tag, updated_at)
       VALUES(1,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         iv=excluded.iv, ciphertext=excluded.ciphertext,
         tag=excluded.tag, updated_at=excluded.updated_at`,
      [c.iv, c.ciphertext, c.tag, Date.now()],
    );
  }

  /** Remove the search credential. Returns whether a row was deleted. */
  deleteSearchCredential(): boolean {
    return this.exec(`DELETE FROM search_credentials WHERE id=1`).changes > 0;
  }

  /** True when a search credential is stored. */
  hasSearchCredential(): boolean {
    const row = this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM search_credentials WHERE id=1`,
    )[0];
    return (row?.n ?? 0) > 0;
  }

  // ---- AI providers ----

  /** All providers, newest first. Never includes credential material. */
  listProviders(): AiProviderRow[] {
    return this.query<{
      id: number;
      label: string;
      adapter: string;
      base_url: string;
      enabled: number;
      allow_local: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, label, adapter, base_url, enabled, allow_local, created_at, updated_at
         FROM ai_providers ORDER BY id DESC`,
    ).map((r) => ({
      id: r.id,
      label: r.label,
      adapter: r.adapter,
      baseUrl: r.base_url,
      enabled: r.enabled === 1,
      // A pre-migration row reads 0, so an existing provider is never allowed
      // local targets retroactively.
      allowLocal: r.allow_local === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** One provider, or undefined when the id does not exist. */
  getProvider(id: number): AiProviderRow | undefined {
    return this.listProviders().find((p) => p.id === id);
  }

  /** Insert a provider and return its id. */
  createProvider(p: {
    label: string;
    adapter: string;
    baseUrl: string;
    allowLocal?: boolean;
  }): number {
    const now = Date.now();
    const res = this.exec(
      `INSERT INTO ai_providers(label, adapter, base_url, enabled, allow_local, created_at, updated_at)
       VALUES(?,?,?,1,?,?,?)`,
      [p.label, p.adapter, p.baseUrl, p.allowLocal === true ? 1 : 0, now, now],
    );
    return Number(res.lastInsertRowid);
  }

  /** Update the editable fields of a provider. */
  updateProvider(
    id: number,
    patch: { label?: string; baseUrl?: string; adapter?: string; allowLocal?: boolean },
  ): void {
    const sets: string[] = ["updated_at=?"];
    const params: unknown[] = [Date.now()];
    if (patch.label !== undefined) {
      sets.push("label=?");
      params.push(patch.label);
    }
    if (patch.baseUrl !== undefined) {
      sets.push("base_url=?");
      params.push(patch.baseUrl);
    }
    if (patch.adapter !== undefined) {
      sets.push("adapter=?");
      params.push(patch.adapter);
    }
    if (patch.allowLocal !== undefined) {
      sets.push("allow_local=?");
      params.push(patch.allowLocal ? 1 : 0);
    }
    params.push(id);
    this.exec(`UPDATE ai_providers SET ${sets.join(", ")} WHERE id=?`, params);
  }

  /**
   * Set the per-provider local-target exception.
   *
   * This is the only way a loopback/private target becomes reachable, and it
   * is a per-provider owner decision — never a global switch.
   */
  setProviderAllowLocal(id: number, allow: boolean): void {
    this.exec(`UPDATE ai_providers SET allow_local=?, updated_at=? WHERE id=?`, [
      allow ? 1 : 0,
      Date.now(),
      id,
    ]);
  }

  /** Enable or disable a provider. */
  setProviderEnabled(id: number, enabled: boolean): void {
    this.exec(`UPDATE ai_providers SET enabled=?, updated_at=? WHERE id=?`, [
      enabled ? 1 : 0,
      Date.now(),
      id,
    ]);
  }

  /**
   * Delete a provider and its credentials, models and health rows.
   *
   * Callers must first ensure the provider is not the active one; this method
   * refuses an active provider so a running selection is never orphaned.
   */
  deleteProvider(id: number): boolean {
    const active = this.getRuntimeSettings();
    if (active.activeProviderId === id) return false;
    const res = this.exec(`DELETE FROM ai_providers WHERE id=?`, [id]);
    return res.changes > 0;
  }

  // ---- AI credentials ----

  /** True when a credential is stored for this provider. */
  hasCredential(providerId: number): boolean {
    const row = this.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ai_credentials WHERE provider_id=?`,
      [providerId],
    )[0];
    return (row?.n ?? 0) > 0;
  }

  /** Read the stored credential envelope, or undefined when none is set. */
  getCredential(providerId: number): EncryptedCredentialRow | undefined {
    const row = this.query<{
      provider_id: number;
      iv: string;
      ciphertext: string;
      tag: string;
      updated_at: number;
    }>(
      `SELECT provider_id, iv, ciphertext, tag, updated_at
         FROM ai_credentials WHERE provider_id=?`,
      [providerId],
    )[0];
    if (!row) return undefined;
    return {
      providerId: row.provider_id,
      iv: row.iv,
      ciphertext: row.ciphertext,
      tag: row.tag,
      updatedAt: row.updated_at,
    };
  }

  /** Store (or replace) a credential envelope. */
  upsertCredential(c: {
    providerId: number;
    iv: string;
    ciphertext: string;
    tag: string;
  }): void {
    this.exec(
      `INSERT INTO ai_credentials(provider_id, iv, ciphertext, tag, updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(provider_id) DO UPDATE SET
         iv=excluded.iv, ciphertext=excluded.ciphertext,
         tag=excluded.tag, updated_at=excluded.updated_at`,
      [c.providerId, c.iv, c.ciphertext, c.tag, Date.now()],
    );
  }

  /** Remove a credential. Returns whether a row was deleted. */
  deleteCredential(providerId: number): boolean {
    return this.exec(`DELETE FROM ai_credentials WHERE provider_id=?`, [providerId]).changes > 0;
  }

  // ---- AI models ----

  /** Models of a provider, newest first. */
  listModels(providerId: number): AiModelRow[] {
    return this.query<{
      id: number;
      provider_id: number;
      model_id: string;
      label: string;
      enabled: number;
      is_default: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, provider_id, model_id, label, enabled, is_default, created_at, updated_at
         FROM ai_models WHERE provider_id=? ORDER BY id DESC`,
      [providerId],
    ).map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      modelId: r.model_id,
      label: r.label,
      enabled: r.enabled === 1,
      isDefault: r.is_default === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** One model, or undefined. */
  getModel(id: number): AiModelRow | undefined {
    const row = this.query<{
      id: number;
      provider_id: number;
      model_id: string;
      label: string;
      enabled: number;
      is_default: number;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, provider_id, model_id, label, enabled, is_default, created_at, updated_at
         FROM ai_models WHERE id=?`,
      [id],
    )[0];
    if (!row) return undefined;
    return {
      id: row.id,
      providerId: row.provider_id,
      modelId: row.model_id,
      label: row.label,
      enabled: row.enabled === 1,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Models of a provider whose label contains a filter, for quick switching. */
  findModelByLabel(providerId: number, label: string): AiModelRow | undefined {
    return this.listModels(providerId).find((m) => m.label === label);
  }

  /** Insert a model. Returns its id, or throws on a duplicate (provider, model_id). */
  createModel(m: { providerId: number; modelId: string; label: string }): number {
    const now = Date.now();
    const res = this.exec(
      `INSERT INTO ai_models(provider_id, model_id, label, enabled, is_default, created_at, updated_at)
       VALUES(?,?,?,1,0,?,?)`,
      [m.providerId, m.modelId, m.label, now, now],
    );
    return Number(res.lastInsertRowid);
  }

  /** Rename a model's display label. */
  setModelLabel(id: number, label: string): boolean {
    return this.exec(`UPDATE ai_models SET label=?, updated_at=? WHERE id=?`, [
      label,
      Date.now(),
      id,
    ]).changes > 0;
  }

  /** Enable or disable a model. */
  setModelEnabled(id: number, enabled: boolean): boolean {
    return this.exec(`UPDATE ai_models SET enabled=?, updated_at=? WHERE id=?`, [
      enabled ? 1 : 0,
      Date.now(),
      id,
    ]).changes > 0;
  }

  /**
   * Delete a model.
   *
   * Refuses to delete the active model, so a live selection is never left
   * pointing at a missing row. Refuses to delete a provider's only default,
   * since that would leave the provider with no default model.
   */
  deleteModel(id: number): boolean {
    const model = this.getModel(id);
    if (!model) return false;

    const active = this.getRuntimeSettings();
    if (active.activeModelId === id) return false;

    // Never leave a provider with no enabled model, whether or not the one
    // being deleted is the current default: a provider with zero models cannot
    // serve a request but would still look configured.
    const remaining = this.listModels(model.providerId).filter(
      (m) => m.id !== id && m.enabled,
    );
    if (remaining.length === 0) return false;

    const res = this.exec(`DELETE FROM ai_models WHERE id=?`, [id]);
    if (res.changes > 0 && model.isDefault) {
      // Promote a replacement so the provider keeps exactly one default.
      this.setModelDefault(remaining[0]!.id);
    }
    return res.changes > 0;
  }

  /** Mark exactly one model of its provider as default. */
  setModelDefault(id: number): boolean {
    const model = this.getModel(id);
    if (!model) return false;
    this.exec("BEGIN");
    try {
      this.exec(`UPDATE ai_models SET is_default=0 WHERE provider_id=?`, [model.providerId]);
      this.exec(`UPDATE ai_models SET is_default=1, updated_at=? WHERE id=?`, [
        Date.now(),
        id,
      ]);
      this.exec("COMMIT");
      return true;
    } catch (err) {
      this.exec("ROLLBACK");
      throw new StorageError("query", `default model failed: ${msg(err)}`);
    }
  }

  // ---- AI runtime selection ----

  /** The single runtime settings row, always fully specified. */
  getRuntimeSettings(): AiRuntimeSettings {
    const row = this.query<{
      active_provider_id: number | null;
      active_model_id: number | null;
    }>(
      `SELECT active_provider_id, active_model_id FROM ai_runtime_settings WHERE id=1`,
    )[0];
    return {
      activeProviderId: row?.active_provider_id ?? null,
      activeModelId: row?.active_model_id ?? null,
    };
  }

  /**
   * Set the active provider and model together, so a selection is never
   * half-applied: a request either sees a consistent pair or none at all.
   */
  setRuntimeSelection(sel: { providerId: number; modelId: number }): void {
    this.exec(
      `INSERT INTO ai_runtime_settings(id, active_provider_id, active_model_id)
       VALUES(1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         active_provider_id=excluded.active_provider_id,
         active_model_id=excluded.active_model_id`,
      [sel.providerId, sel.modelId],
    );
  }

  // ---- AI provider health ----

  /** Latest probe result for a provider. */
  getProviderHealth(providerId: number): AiProviderHealthRow | undefined {
    const row = this.query<{
      provider_id: number;
      ok: number;
      checked_at: number;
      message: string | null;
    }>(
      `SELECT provider_id, ok, checked_at, message FROM ai_provider_health WHERE provider_id=?`,
      [providerId],
    )[0];
    if (!row) return undefined;
    return {
      providerId: row.provider_id,
      ok: row.ok === 1,
      checkedAt: row.checked_at,
      ...(row.message !== null ? { message: row.message } : {}),
    };
  }

  /** Record a probe result. The message must already be free of secrets. */
  setProviderHealth(h: { providerId: number; ok: boolean; message?: string }): void {
    this.exec(
      `INSERT INTO ai_provider_health(provider_id, ok, checked_at, message)
       VALUES(?,?,?,?)
       ON CONFLICT(provider_id) DO UPDATE SET
         ok=excluded.ok, checked_at=excluded.checked_at, message=excluded.message`,
      [h.providerId, h.ok ? 1 : 0, Date.now(), h.message ?? null],
    );
  }

  // ---- AI failover ----

  /**
   * Failover settings. Defaults to OFF, so a fresh database never switches
   * provider without the owner explicitly enabling it.
   */
  getFailoverSettings(): AiFailoverSettings {
    const row = this.query<{
      enabled: number;
      max_attempts: number;
      timeout_ms: number;
    }>(
      `SELECT enabled, max_attempts, timeout_ms FROM ai_failover_settings WHERE id=1`,
    )[0];
    return {
      enabled: row?.enabled === 1,
      maxAttempts: clampAttempts(row?.max_attempts),
      timeoutMs: clampTimeout(row?.timeout_ms),
    };
  }

  /** Persist failover settings. */
  setFailoverSettings(s: {
    enabled?: boolean;
    maxAttempts?: number;
    timeoutMs?: number;
  }): void {
    const current = this.getFailoverSettings();
    this.exec(
      `INSERT INTO ai_failover_settings(id, enabled, max_attempts, timeout_ms)
       VALUES(1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled=excluded.enabled,
         max_attempts=excluded.max_attempts,
         timeout_ms=excluded.timeout_ms`,
      [
        s.enabled ?? current.enabled ? 1 : 0,
        clampAttempts(s.maxAttempts ?? current.maxAttempts),
        clampTimeout(s.timeoutMs ?? current.timeoutMs),
      ],
    );
  }

  /** Ordered failover candidates, highest priority first. */
  listFailoverCandidates(): AiFailoverCandidate[] {
    return this.query<{ provider_id: number; model_id: number; position: number }>(
      `SELECT provider_id, model_id, position
         FROM ai_failover_candidates ORDER BY position ASC, model_id ASC`,
    ).map((r) => ({
      providerId: r.provider_id,
      modelId: r.model_id,
      position: r.position,
    }));
  }

  /** Replace the candidate list. Order given is priority order. */
  setFailoverCandidates(candidates: readonly { providerId: number; modelId: number }[]): void {
    this.exec("BEGIN");
    try {
      this.exec(`DELETE FROM ai_failover_candidates`);
      candidates.forEach((c, index) => {
        this.exec(
          `INSERT INTO ai_failover_candidates(provider_id, model_id, position) VALUES(?,?,?)`,
          [c.providerId, c.modelId, index],
        );
      });
      this.exec("COMMIT");
    } catch (err) {
      this.exec("ROLLBACK");
      throw new StorageError("query", `failover candidates failed: ${msg(err)}`);
    }
  }

  // ---- low-level guarded wrappers ----
  private exec(sql: string, params: unknown[] = []) {
    this.ensureOpen();
    try {
      return this.db.prepare(sql).run(...(params as never[]));
    } catch (err) {
      throw new StorageError("query", msg(err));
    }
  }
  private query<T>(sql: string, params: unknown[] = []): T[] {
    this.ensureOpen();
    try {
      return this.db.prepare(sql).all(...(params as never[])) as T[];
    } catch (err) {
      throw new StorageError("query", msg(err));
    }
  }
  private ensureOpen(): void {
    if (this.closed) throw new StorageError("closed", "storage is closed");
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Raw row shape shared by the group-access queries. */
interface GroupRow {
  chat_id: string;
  title: string | null;
  chat_type: string;
  state: string;
  requested_by: string | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
  notified_at: number | null;
}

/** Map a memory row to a record. */
function toMemoryRecord(r: {
  user_id: string;
  key: string;
  content: string;
  created_at: number;
  updated_at: number;
}): MemoryRecord {
  return {
    userId: r.user_id,
    key: r.key,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Map a usage row to a record. */
function toUsageRecord(r: {
  user_id: string;
  day: string;
  requests: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
}): UsageRecord {
  return {
    userId: r.user_id,
    day: r.day,
    requests: r.requests,
    toolCalls: r.tool_calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
  };
}

/** Raw row shape shared by the reminder queries. */
interface ReminderRow {
  id: number;
  user_id: string;
  chat_id: string;
  text: string;
  due_at: number;
  repeat: string;
  state: string;
  created_at: number;
  fired_at: number | null;
}

/** Map a reminder row to a record, omitting nulls. */
function toReminderRecord(r: ReminderRow): ReminderRecord {
  return {
    id: r.id,
    userId: r.user_id,
    chatId: r.chat_id,
    text: r.text,
    dueAt: r.due_at,
    repeat: r.repeat as ReminderRepeat,
    state: r.state as ReminderState,
    createdAt: r.created_at,
    ...(r.fired_at !== null ? { firedAt: r.fired_at } : {}),
  };
}

/** Raw row shape for the user-access queries. */
interface UserRow {
  user_id: string;
  username: string | null;
  first_name: string | null;
  state: string;
  requested_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
  notified_at: number | null;
}

/** Map a user row to a record, omitting nulls (exactOptionalPropertyTypes). */
function toUserRecord(r: UserRow): UserAccessRecord {
  return {
    userId: r.user_id,
    state: r.state as GroupState,
    requestedAt: r.requested_at,
    updatedAt: r.updated_at,
    ...(r.username !== null ? { username: r.username } : {}),
    ...(r.first_name !== null ? { firstName: r.first_name } : {}),
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
    ...(r.decided_by !== null ? { decidedBy: r.decided_by } : {}),
    ...(r.notified_at !== null ? { notifiedAt: r.notified_at } : {}),
  };
}

/** Map a row to a record, omitting nulls (exactOptionalPropertyTypes). */
function toGroupRecord(r: GroupRow): GroupAccessRecord {
  return {
    chatId: r.chat_id,
    chatType: r.chat_type as GroupAccessRecord["chatType"],
    state: r.state as GroupState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.title !== null ? { title: r.title } : {}),
    ...(r.requested_by !== null ? { requestedBy: r.requested_by } : {}),
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
    ...(r.decided_by !== null ? { decidedBy: r.decided_by } : {}),
    ...(r.notified_at !== null ? { notifiedAt: r.notified_at } : {}),
  };
}

/** Clamp a possibly-hostile integer into a safe range, with a fallback. */
function clampInt(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  const n = Math.trunc(raw);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Attempts are bounded: never let a misconfiguration become an unbounded loop. */
function clampAttempts(raw: number | undefined): number {
  if (raw === undefined) return 2;
  return clampInt(raw, 1, 4, 2);
}

/** Per-candidate timeout is bounded both ways, so it can never be zero. */
function clampTimeout(raw: number | undefined): number {
  if (raw === undefined) return 15_000;
  return clampInt(raw, 1_000, 60_000, 15_000);
}
