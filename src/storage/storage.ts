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

/**
 * One pooled backup credential of a provider.
 * The envelope (iv/ciphertext/tag) is the same AES-256-GCM shape as
 * EncryptedCredentialRow; the plaintext key is never exposed by a list call.
 */
export interface AiPoolCredentialRow {
  id: number;
  providerId: number;
  /** Owner-chosen display label, e.g. "backup-1". */
  label: string;
  iv: string;
  ciphertext: string;
  tag: string;
  /** Load-sharing multiplier inside the round-robin order. */
  weight: number;
  enabled: boolean;
  /** unix ms */
  createdAtMs: number;
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

/**
 * The owner's ed25519 signing keypair for skill packages (Phase 5, item 1).
 * Single row (id = 1). `privateKeyJwk` is the JWK JSON holding the secret —
 * it is never logged and never returned by any list call.
 */
export interface SkillSigningKeyRow {
  /** SHA-256 hex of the raw 32-byte public key — the publisher id. */
  keyId: string;
  /** Raw 32-byte public key, base64. Safe to share. */
  publicKey: string;
  /** Private key JWK JSON. The secret. */
  privateKeyJwk: string;
  /** unix ms */
  createdAtMs: number;
}

/** One trusted skill-package publisher (Phase 5, item 1). */
export interface TrustedSkillPublisherRow {
  /** SHA-256 hex of the raw 32-byte public key — the publisher id. */
  keyId: string;
  /** Owner-chosen label shown on review cards. */
  label: string;
  /** Raw 32-byte public key, base64; "" when trusted by fingerprint only. */
  publicKey: string;
  /** unix ms */
  addedAtMs: number;
}

/**
 * Install provenance for one skill: which publisher signed it, captured
 * from the verified envelope at import time. `keyId` null = unsigned.
 */
export interface SkillInstallProvenanceRow {
  skillName: string;
  keyId: string | null;
  /** unix ms */
  signedAtMs: number;
}

/** One owner-defined custom shortcut: a command alias. */
export interface CustomShortcut {
  /** Command name without the leading slash, lowercase, e.g. "صبح". */
  name: string;
  /** 'prompt' -> run the action as a prompt; 'tool' -> invoke a tool. */
  kind: "prompt" | "tool";
  /** The prompt text (kind='prompt') or the tool name (kind='tool'). */
  action: string;
  /** Extra tool arguments for kind='tool', JSON object. */
  toolArgs?: Record<string, unknown>;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
}

/** A conversation's rolling summary plus how far it reaches. */
export interface ConversationSummary {
  summary: string;
  /** Id of the last message folded into the summary. */
  summarisedUntil: number;
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

/** One row of the per-run usage ledger. Token counts only — never content. */
export interface UsageLedgerEntry {
  id: number;
  userId: string;
  conversationId: number;
  providerId: number;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** unix ms — when the attempt completed. */
  atMs: number;
}

/** How often a reminder repeats after firing. */
export type ReminderRepeat = "none" | "daily" | "weekly";

/** Lifecycle of a reminder. */
export type ReminderState = "pending" | "fired" | "cancelled";

/** Outcome of the most recent run of a scheduled task. */
export type ScheduledTaskStatus = "ok" | "failed" | "skipped";

/** One recurring scheduled task. Created owner-only; see schedule_task. */
export interface ScheduledTaskRecord {
  id: number;
  name: string;
  /** Normalized 5-field cron expression (shorthands expanded at creation). */
  cronExpr: string;
  /** IANA timezone the expression is interpreted in. */
  timezone: string;
  /** Validated action JSON: {"type":"tool"|"message"|"agent", ...}. */
  actionJson: string;
  enabled: boolean;
  /** Owner (Telegram numeric id as string) that created the task. */
  createdByUserId: string;
  /** unix ms — the next scheduled run. Re-armed after every run. */
  nextRunAtMs: number;
  /** unix ms — when the last run happened. */
  lastRunAtMs?: number;
  /** Outcome of the last run. */
  lastStatus?: ScheduledTaskStatus;
  /** How many times the task has run. */
  runCount: number;
  /** unix ms */
  createdAt: number;
}

/** Lifecycle of a goal. */
export type GoalStatus = "active" | "done";

/**
 * One persistent owner goal. Goals belong to the owner: the goal tools are
 * owner-only, so every row is the owner's — but the creator is still recorded
 * so the storage layer never trusts the caller on this.
 */
export interface GoalRecord {
  id: number;
  title: string;
  description: string;
  status: GoalStatus;
  createdBy: string;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
  /** unix ms — set when the goal is completed. */
  doneAt?: number;
}

/** Outcome of one heartbeat pass. */
export type HeartbeatStatus = "ok" | "failed" | "skipped";

/**
 * One row of the heartbeat audit trail. The only autonomous output the
 * heartbeat leaves behind: what it did, how many tools it called, and
 * whether the pass ran, failed, or was skipped.
 */
export interface HeartbeatLogEntry {
  id: number;
  /** unix ms — when the pass ran. */
  ranAtMs: number;
  /** What the pass did (first 500 chars of its reply). */
  summary: string;
  toolCalls: number;
  status: HeartbeatStatus;
}

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
  /** Importance 1-5 (worker-2): retrieval prefers important memories. */
  importance: number;
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
  /** Per-candidate timeout, ms. Bounded 1000..600000 (up to 10min). */
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

-- Per-run usage ledger (schema 17). One row per completed provider attempt,
-- finer-grained than the daily "usage" counters: it keeps which provider and
-- model answered, so the owner can see cost per model. METADATA ONLY: counts
-- and identifiers — never prompts, completions, or any message content.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  provider_id     INTEGER NOT NULL,
  model_id        TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  at_ms           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user ON usage_ledger(user_id, at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_model ON usage_ledger(user_id, model_id, at_ms DESC);

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

-- Recurring scheduled tasks (cron expressions). Created owner-only through the
-- schedule_task tool. action_json is a structured, validated action object —
-- never code, never eval'd. next_run_at_ms is re-armed from the cron
-- expression after every run, so the row is also the schedule's queue entry.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  cron_expr          TEXT NOT NULL,
  timezone           TEXT NOT NULL,
  action_json        TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL,
  next_run_at_ms     INTEGER NOT NULL,
  last_run_at_ms     INTEGER,
  last_status        TEXT,
  run_count          INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_next ON scheduled_tasks(enabled, next_run_at_ms);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON scheduled_tasks(created_by_user_id, enabled);

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

-- Credential pool: extra encrypted API keys for one provider. Each row is a
-- full AES-256-GCM envelope (iv, ciphertext, tag), the same format as
-- ai_credentials: the primary key is never distinguished by storage layout.
-- The gateway rotates across these keys on auth/transport failures. weight is
-- a small load-sharing multiplier inside the round-robin order (default 1).
CREATE TABLE IF NOT EXISTS ai_credential_pool (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id   INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  iv            TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,
  tag           TEXT NOT NULL,
  weight        INTEGER NOT NULL DEFAULT 1,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool_provider ON ai_credential_pool(provider_id, enabled);

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
  enabled     INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  timeout_ms  INTEGER NOT NULL DEFAULT 300000
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

-- Generic per-user preferences (Phase B: voice_mode for TTS replies, and any
-- future per-user switches). One row per (user, key); upserted, never appended.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Persistent owner goals (Phase C2). The heartbeat keeps the agent working
-- toward them on its own; the goal tools (owner-only) manage them
-- conversationally. done_at_ms is NULL while the goal is still open. Times
-- use the _ms suffix, like the other C-phase tables.
CREATE TABLE IF NOT EXISTS goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL CHECK(length(title) >= 1 AND length(title) <= 120),
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done')),
  created_by    TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  done_at_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goals_owner_status ON goals(created_by, status, id DESC);

-- Heartbeat audit trail (Phase C2). Every heartbeat pass writes exactly one
-- row: what it did (first 500 chars of its reply), how many tools it called,
-- and whether the pass ran, failed, or was skipped. The owner can read these;
-- they are the only autonomous output a beat leaves behind.
CREATE TABLE IF NOT EXISTS heartbeat_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at_ms   INTEGER NOT NULL,
  summary     TEXT NOT NULL,
  tool_calls  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK(status IN ('ok','failed','skipped'))
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_time ON heartbeat_log(id DESC);

-- Phase 5, item 1 — skill package signing. The owner's ed25519 keypair,
-- single row. The private key lives ONLY here: it is never logged, never
-- sent over any channel, and only leaves through the explicit
-- "/skill keyexport" path. At-rest protection is the database file itself
-- (same class as conversation contents); see docs/PHASE5_SKILL_SIGNING.md
-- for the attack-surface review.
CREATE TABLE IF NOT EXISTS skill_signing_key (
  id              INTEGER PRIMARY KEY CHECK(id = 1),
  key_id          TEXT NOT NULL,
  public_key      TEXT NOT NULL,
  private_key_jwk TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL
);

-- Owner-maintained trusted-publisher registry: key fingerprint -> label.
-- Trust in a signing key comes ONLY from this table; the envelope's own
-- public key is never trusted by itself. Revocation = deleting the row.
CREATE TABLE IF NOT EXISTS skill_trusted_publishers (
  key_id      TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  public_key  TEXT NOT NULL DEFAULT '',
  added_at_ms INTEGER NOT NULL
);

-- Install provenance: which publisher (if any) signed each installed skill,
-- captured from the verified envelope at import time. key_id NULL = the
-- skill was installed unsigned. Survives untrust so "/skill list" can flag
-- skills whose publisher was later revoked.
CREATE TABLE IF NOT EXISTS skill_install_provenance (
  skill_name   TEXT PRIMARY KEY,
  key_id       TEXT,
  signed_at_ms INTEGER NOT NULL
);

-- Owner-defined custom command shortcuts (schema 21). name is stored
-- lowercase, without the leading slash. kind is 'prompt' (action = prompt
-- text, run through the engine as a user message) or 'tool' (action = tool
-- name, tool_args = JSON object of extra arguments).
CREATE TABLE IF NOT EXISTS custom_shortcuts (
  name       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK(kind IN ('prompt','tool')),
  action     TEXT NOT NULL,
  tool_args  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Current schema version.
 *
 * Exported so a test can assert it by name rather than repeating the literal:
 * a hardcoded copy silently rots each time this is bumped.
 */
export const SCHEMA_VERSION = 21;

/**
 * Hard cap on audit rows. Oldest rows are pruned once the count exceeds this,
 * which bounds file growth without an external scheduler.
 */
const AUDIT_MAX_ROWS = 5000;

/**
 * Most messages folded into one summary pass.
 *
 * Bounded so a backlog (after an outage, or after a long gap) is summarised in
 * several affordable calls rather than one that may exceed the model's context
 * and then be retried forever without ever succeeding.
 */
const MAX_SUMMARY_BATCH = 40;

export class Storage {
  private db: Database;
  private closed = false;

  /**
   * Round-robin cursors for credential-pool rotation, one per provider.
   * In-memory: a restart resets rotation (see poolPosition). Process-local
   * state, never persisted, never containing key material.
   */
  private readonly poolCursors = new Map<number, number>();

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
        // Phase D1 (schema 15): index any pre-existing messages. A fresh
        // database has none, so this is a no-op there; an upgraded one gets
        // its history searchable. The backfill deliberately does NOT read
        // from messages_fts (e.g. WHERE id NOT IN (SELECT rowid ...)): a
        // subquery over the FTS table inside its own INSERT..SELECT makes
        // FTS5 index the rows with no terms at all. Idempotency comes from
        // elsewhere instead: FTS5 replaces the document on a duplicate
        // rowid, and this branch only runs while the version stamp is < 15.
        // Triggers keep the index current from here on.
        // Schema 19: the old 15s provider-call default was too aggressive —
        // it cancelled legitimate long answers. Existing databases still on
        // the old default get the new one; an owner-set custom value is kept.
        this.exec(
          `UPDATE ai_failover_settings SET timeout_ms=300000 WHERE timeout_ms=15000`,
        );
        // Schema 20: failover is now on by default. Existing databases get
        // enabled=1; the owner can turn it off in /ai if they want.
        this.exec(
          `UPDATE ai_failover_settings SET enabled=1 WHERE id=1`,
        );
        this.exec(
          `INSERT INTO messages_fts(rowid, content)
             SELECT id, content FROM messages`,
        );
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
    // Worker-2: importance column for memories. Idempotent and outside the
    // version gate on purpose: no SCHEMA_VERSION bump, so existing databases
    // are not pushed through the whole migration block again for this.
    this.addColumnIfMissing("memories", "importance", "INTEGER NOT NULL DEFAULT 3");
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

  // ---- usage ledger (schema 17) ----

  /**
   * Record one completed provider attempt in the usage ledger.
   *
   * A plain append — no upsert — so every attempt is auditable. Token counts
   * only; the ledger never sees prompts or completions. Returns the row id.
   */
  recordUsage(entry: {
    userId: string;
    conversationId: number;
    providerId: number;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    atMs: number;
  }): number {
    const res = this.exec(
      `INSERT INTO usage_ledger(user_id, conversation_id, provider_id, model_id,
         input_tokens, output_tokens, at_ms)
       VALUES(?,?,?,?,?,?,?)`,
      [
        entry.userId,
        entry.conversationId,
        entry.providerId,
        entry.modelId,
        entry.inputTokens,
        entry.outputTokens,
        entry.atMs,
      ],
    );
    return Number(res.lastInsertRowid);
  }

  /**
   * Token totals for one user in a time window, across all models.
   * sinceMs is inclusive; omit it for all-time.
   */
  usageTotals(
    userId: string,
    sinceMs?: number,
  ): { inputTokens: number; outputTokens: number; runs: number } {
    const row = this.query<{
      input_tokens: number;
      output_tokens: number;
      runs: number;
    }>(
      `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COUNT(*) AS runs
         FROM usage_ledger
        WHERE user_id=? ${sinceMs !== undefined ? "AND at_ms>=?" : ""}`,
      sinceMs !== undefined ? [userId, sinceMs] : [userId],
    )[0];
    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      runs: row?.runs ?? 0,
    };
  }

  /**
   * Token totals per model for one user in a time window, most-used first.
   * sinceMs is inclusive; omit it for all-time.
   */
  usageByModel(
    userId: string,
    sinceMs?: number,
  ): { modelId: string; inputTokens: number; outputTokens: number; runs: number }[] {
    return this.query<{
      model_id: string;
      input_tokens: number;
      output_tokens: number;
      runs: number;
    }>(
      `SELECT model_id,
              COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COUNT(*) AS runs
         FROM usage_ledger
        WHERE user_id=? ${sinceMs !== undefined ? "AND at_ms>=?" : ""}
        GROUP BY model_id
        ORDER BY runs DESC, (input_tokens + output_tokens) DESC`,
      sinceMs !== undefined ? [userId, sinceMs] : [userId],
    ).map((r) => ({
      modelId: r.model_id,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      runs: r.runs,
    }));
  }

  /**
   * Token totals across ALL users in a time window, for the owner.
   * sinceMs is inclusive; omit it for all-time.
   */
  usageTotalsAll(
    sinceMs?: number,
  ): { inputTokens: number; outputTokens: number; runs: number } {
    const row = this.query<{
      input_tokens: number;
      output_tokens: number;
      runs: number;
    }>(
      `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COUNT(*) AS runs
         FROM usage_ledger
        ${sinceMs !== undefined ? "WHERE at_ms>=?" : ""}`,
      sinceMs !== undefined ? [sinceMs] : [],
    )[0];
    return {
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      runs: row?.runs ?? 0,
    };
  }

  /**
   * Token totals per model across ALL users in a time window, most-used
   * first, for the owner. sinceMs is inclusive; omit it for all-time.
   */
  usageByModelAll(
    sinceMs?: number,
  ): { modelId: string; inputTokens: number; outputTokens: number; runs: number }[] {
    return this.query<{
      model_id: string;
      input_tokens: number;
      output_tokens: number;
      runs: number;
    }>(
      `SELECT model_id,
              COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COUNT(*) AS runs
         FROM usage_ledger
        ${sinceMs !== undefined ? "WHERE at_ms>=?" : ""}
        GROUP BY model_id
        ORDER BY runs DESC, (input_tokens + output_tokens) DESC`,
      sinceMs !== undefined ? [sinceMs] : [],
    ).map((r) => ({
      modelId: r.model_id,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      runs: r.runs,
    }));
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

  // ---- scheduled tasks (cron) ----

  /** Insert a scheduled task. The cron expression must already be validated. */
  createTask(t: {
    name: string;
    cronExpr: string;
    timezone: string;
    actionJson: string;
    createdByUserId: string;
    nextRunAtMs: number;
    enabled?: boolean;
  }): number {
    const res = this.exec(
      `INSERT INTO scheduled_tasks(
         name, cron_expr, timezone, action_json, enabled,
         created_by_user_id, next_run_at_ms, run_count, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        t.name,
        t.cronExpr,
        t.timezone,
        t.actionJson,
        t.enabled === false ? 0 : 1,
        t.createdByUserId,
        t.nextRunAtMs,
        0,
        Date.now(),
      ],
    );
    return Number(res.lastInsertRowid);
  }

  /** One task by id, scoped to its creator. */
  getTask(userId: string, id: number): ScheduledTaskRecord | undefined {
    const row = this.query<ScheduledTaskRow>(
      `SELECT id, name, cron_expr, timezone, action_json, enabled,
              created_by_user_id, next_run_at_ms, last_run_at_ms,
              last_status, run_count, created_at
         FROM scheduled_tasks WHERE created_by_user_id=? AND id=?`,
      [userId, id],
    )[0];
    return row ? toScheduledTaskRecord(row) : undefined;
  }

  /** A creator's tasks, soonest next run first. */
  listTasks(userId: string, limit = 50): ScheduledTaskRecord[] {
    const safeLimit = clampInt(limit, 1, 200, 50);
    return this.query<ScheduledTaskRow>(
      `SELECT id, name, cron_expr, timezone, action_json, enabled,
              created_by_user_id, next_run_at_ms, last_run_at_ms,
              last_status, run_count, created_at
         FROM scheduled_tasks WHERE created_by_user_id=?
        ORDER BY next_run_at_ms ASC, id ASC LIMIT ?`,
      [userId, safeLimit],
    ).map(toScheduledTaskRecord);
  }

  /** Count of a creator's tasks, for the per-owner cap. */
  countTasks(userId: string): number {
    return (
      this.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM scheduled_tasks WHERE created_by_user_id=?`,
        [userId],
      )[0]?.n ?? 0
    );
  }

  /**
   * Update a task's editable fields, scoped to its creator.
   *
   * Only whitelisted columns are writable: the run bookkeeping columns
   * (next_run_at_ms, last_*, run_count) are the scheduler's alone and are
   * never set through here.
   */
  updateTask(
    userId: string,
    id: number,
    patch: {
      name?: string;
      cronExpr?: string;
      timezone?: string;
      actionJson?: string;
      enabled?: boolean;
      nextRunAtMs?: number;
    },
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name=?");
      params.push(patch.name);
    }
    if (patch.cronExpr !== undefined) {
      sets.push("cron_expr=?");
      params.push(patch.cronExpr);
    }
    if (patch.timezone !== undefined) {
      sets.push("timezone=?");
      params.push(patch.timezone);
    }
    if (patch.actionJson !== undefined) {
      sets.push("action_json=?");
      params.push(patch.actionJson);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled=?");
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.nextRunAtMs !== undefined) {
      sets.push("next_run_at_ms=?");
      params.push(patch.nextRunAtMs);
    }
    if (sets.length === 0) return false;
    params.push(id, userId);
    const res = this.exec(
      `UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id=? AND created_by_user_id=?`,
      params,
    );
    return res.changes > 0;
  }

  /** Delete a task, scoped to its creator. */
  deleteTask(userId: string, id: number): boolean {
    const res = this.exec(`DELETE FROM scheduled_tasks WHERE id=? AND created_by_user_id=?`, [
      id,
      userId,
    ]);
    return res.changes > 0;
  }

  /**
   * Every enabled task whose time has come, across all creators.
   *
   * The scheduler is the only caller: like dueReminders, it must see all
   * owners so one shared timer can serve everyone.
   */
  dueTasks(now: number, limit = 50): ScheduledTaskRecord[] {
    const safeLimit = clampInt(limit, 1, 500, 50);
    return this.query<ScheduledTaskRow>(
      `SELECT id, name, cron_expr, timezone, action_json, enabled,
              created_by_user_id, next_run_at_ms, last_run_at_ms,
              last_status, run_count, created_at
         FROM scheduled_tasks WHERE enabled=1 AND next_run_at_ms<=?
        ORDER BY next_run_at_ms ASC, id ASC LIMIT ?`,
      [now, safeLimit],
    ).map(toScheduledTaskRecord);
  }

  /**
   * Atomically claim a task and re-arm it in the same write.
   *
   * The UPDATE re-tests the expected next_run_at_ms, so two schedulers racing
   * over the same row produce exactly one winner — the same pattern as
   * claimReminder, minus a state column (a recurring task has no terminal
   * state to move to).
   *
   * The re-arm is written HERE, not after execution, and the new value always
   * differs from the expected one (a cron's next slot is strictly in the
   * future). That difference is load-bearing: SQLite counts matched rows as
   * changed, so a no-op compare-update could not tell the winner from the
   * loser. A crash between claim and execution loses one occurrence but can
   * never double-run it — the same trade-off as reminders, where a duplicate
   * send is worse than a late one.
   */
  claimTask(id: number, expectedNextRunAtMs: number, newNextRunAtMs: number): boolean {
    const res = this.exec(
      `UPDATE scheduled_tasks SET next_run_at_ms=?
        WHERE id=? AND next_run_at_ms=? AND enabled=1`,
      [newNextRunAtMs, id, expectedNextRunAtMs],
    );
    return res.changes > 0;
  }

  /**
   * Record a finished run's outcome.
   *
   * The next slot was already written by claimTask, so this only records
   * when, how, and how many. A crash between the two leaves the series
   * re-armed with no outcome recorded — one occurrence lost, never duplicated.
   */
  markTaskRun(id: number, r: { ranAtMs: number; status: ScheduledTaskStatus }): boolean {
    const res = this.exec(
      `UPDATE scheduled_tasks
          SET last_run_at_ms=?, last_status=?, run_count=run_count+1
        WHERE id=?`,
      [r.ranAtMs, r.status, id],
    );
    return res.changes > 0;
  }

  // ---- goals ----

  /** Insert a goal for its creator. Returns its id. */
  createGoal(g: { title: string; description?: string; createdBy: string }): number {
    const now = Date.now();
    const res = this.exec(
      `INSERT INTO goals(title, description, status, created_by, created_at_ms, updated_at_ms, done_at_ms)
       VALUES(?,?,'active',?,?,?,NULL)`,
      [g.title, g.description ?? "", g.createdBy, now, now],
    );
    return Number(res.lastInsertRowid);
  }

  /** One goal by id, scoped to its creator. */
  getGoal(userId: string, id: number): GoalRecord | undefined {
    const row = this.query<GoalRow>(
      `SELECT id, title, description, status, created_by,
              created_at_ms, updated_at_ms, done_at_ms
         FROM goals WHERE created_by=? AND id=?`,
      [userId, id],
    )[0];
    return row ? toGoalRecord(row) : undefined;
  }

  /** A creator's goals, newest first, optionally filtered by status. */
  listGoals(userId: string, status?: GoalStatus, limit = 50): GoalRecord[] {
    const safeLimit = clampInt(limit, 1, 200, 50);
    const rows =
      status === undefined
        ? this.query<GoalRow>(
            `SELECT id, title, description, status, created_by,
                    created_at_ms, updated_at_ms, done_at_ms
               FROM goals WHERE created_by=? ORDER BY id DESC LIMIT ?`,
            [userId, safeLimit],
          )
        : this.query<GoalRow>(
            `SELECT id, title, description, status, created_by,
                    created_at_ms, updated_at_ms, done_at_ms
               FROM goals WHERE created_by=? AND status=? ORDER BY id DESC LIMIT ?`,
            [userId, status, safeLimit],
          );
    return rows.map(toGoalRecord);
  }

  /** How many goals a creator has, optionally filtered by status. */
  countGoals(userId: string, status?: GoalStatus): number {
    const row =
      status === undefined
        ? this.query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM goals WHERE created_by=?`,
            [userId],
          )[0]
        : this.query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM goals WHERE created_by=? AND status=?`,
            [userId, status],
          )[0];
    return row?.n ?? 0;
  }

  /**
   * Mark an active goal done. Only an active row may be completed, and only
   * by its creator — a completed goal cannot be re-completed into a fresh
   * done_at_ms, and a row that is not yours reports false instead of moving.
   */
  completeGoal(userId: string, id: number): boolean {
    const now = Date.now();
    const res = this.exec(
      `UPDATE goals SET status='done', done_at_ms=?, updated_at_ms=?
        WHERE id=? AND created_by=? AND status='active'`,
      [now, now, id, userId],
    );
    return res.changes > 0;
  }

  // ---- heartbeat log ----

  /**
   * Append one heartbeat pass. The summary is truncated to 500 code points
   * (not UTF-16 units) so a long reply cannot bloat the log.
   */
  logHeartbeat(e: {
    summary: string;
    toolCalls: number;
    status: HeartbeatStatus;
    ranAtMs?: number;
  }): number {
    const res = this.exec(
      `INSERT INTO heartbeat_log(ran_at_ms, summary, tool_calls, status) VALUES(?,?,?,?)`,
      [
        e.ranAtMs ?? Date.now(),
        truncateSummary(e.summary),
        clampInt(e.toolCalls, 0, 1_000_000, 0),
        e.status,
      ],
    );
    return Number(res.lastInsertRowid);
  }

  /** The most recent heartbeat passes, newest first. */
  recentHeartbeats(n = 5): HeartbeatLogEntry[] {
    const safeN = clampInt(n, 1, 100, 5);
    return this.query<HeartbeatLogRow>(
      `SELECT id, ran_at_ms, summary, tool_calls, status
         FROM heartbeat_log ORDER BY id DESC LIMIT ?`,
      [safeN],
    ).map(toHeartbeatLogEntry);
  }

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
    }>(
      `SELECT user_id, key, content, created_at, updated_at, importance
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
    }>(
      `SELECT user_id, key, content, created_at, updated_at, importance
         FROM memories WHERE user_id=?
        ORDER BY updated_at DESC, key ASC LIMIT ?`,
      [userId, safeLimit],
    ).map(toMemoryRecord);
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

  // ---- AI credential pool (Phase E3) ----

  /**
   * Store a pool credential envelope. The caller must already have encrypted
   * the key; this layer never sees plaintext. Returns the new pool entry id.
   */
  addPoolCredential(p: {
    providerId: number;
    label: string;
    iv: string;
    ciphertext: string;
    tag: string;
    weight?: number;
  }): number {
    const res = this.exec(
      `INSERT INTO ai_credential_pool(provider_id, label, iv, ciphertext, tag, weight, enabled, created_at_ms)
       VALUES(?,?,?,?,?,?,1,?)`,
      [
        p.providerId,
        p.label,
        p.iv,
        p.ciphertext,
        p.tag,
        Math.max(1, Math.floor(p.weight ?? 1)),
        Date.now(),
      ],
    );
    return Number(res.lastInsertRowid);
  }

  /** Pool entries of a provider, oldest first. Envelopes included, never plaintext. */
  listPoolCredentials(providerId: number): AiPoolCredentialRow[] {
    return this.query<{
      id: number;
      provider_id: number;
      label: string;
      iv: string;
      ciphertext: string;
      tag: string;
      weight: number;
      enabled: number;
      created_at_ms: number;
    }>(
      `SELECT id, provider_id, label, iv, ciphertext, tag, weight, enabled, created_at_ms
         FROM ai_credential_pool WHERE provider_id=? ORDER BY id ASC`,
      [providerId],
    ).map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      label: r.label,
      iv: r.iv,
      ciphertext: r.ciphertext,
      tag: r.tag,
      weight: r.weight,
      enabled: r.enabled === 1,
      createdAtMs: r.created_at_ms,
    }));
  }

  /** One pool entry, or undefined when the id does not exist. */
  getPoolCredential(id: number): AiPoolCredentialRow | undefined {
    const row = this.query<{
      id: number;
      provider_id: number;
      label: string;
      iv: string;
      ciphertext: string;
      tag: string;
      weight: number;
      enabled: number;
      created_at_ms: number;
    }>(
      `SELECT id, provider_id, label, iv, ciphertext, tag, weight, enabled, created_at_ms
         FROM ai_credential_pool WHERE id=?`,
      [id],
    )[0];
    if (!row) return undefined;
    return {
      id: row.id,
      providerId: row.provider_id,
      label: row.label,
      iv: row.iv,
      ciphertext: row.ciphertext,
      tag: row.tag,
      weight: row.weight,
      enabled: row.enabled === 1,
      createdAtMs: row.created_at_ms,
    };
  }

  /** Enable or disable a pool entry. Returns whether the entry exists. */
  setPoolCredentialEnabled(id: number, enabled: boolean): boolean {
    return (
      this.exec(`UPDATE ai_credential_pool SET enabled=? WHERE id=?`, [enabled ? 1 : 0, id])
        .changes > 0
    );
  }

  /** Remove a pool entry. Returns whether a row was deleted. */
  removePoolCredential(id: number): boolean {
    return this.exec(`DELETE FROM ai_credential_pool WHERE id=?`, [id]).changes > 0;
  }

  /**
   * Round-robin cursor for credential-pool rotation.
   *
   * Returns the start index for this request and advances the cursor, so the
   * next request begins at the next key. IN-MEMORY BY DESIGN: a restart resets
   * rotation to 0. That is honest rather than lossy — a persisted cursor would
   * only remember a position whose meaning changes every time a pool entry is
   * added, removed, or disabled, so durability would buy nothing and could
   * pin traffic to a key that no longer deserves it.
   */
  poolPosition(providerId: number, poolSize: number): number {
    if (poolSize <= 0) return 0;
    const current = this.poolCursors.get(providerId) ?? 0;
    this.poolCursors.set(providerId, (current + 1) % poolSize);
    return current % poolSize;
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

  // ---- user preferences (Phase B) ----

  /**
   * Read one per-user preference. Returns undefined when never set.
   *
   * Generic key/value store for per-user switches; the only key in use today
   * is "voice_mode" ("1"/"0", Phase B3 TTS voice replies).
   */
  getUserPref(userId: string, key: string): string | undefined {
    const row = this.query<{ value: string }>(
      `SELECT value FROM user_prefs WHERE user_id=? AND key=?`,
      [userId, key],
    )[0];
    return row?.value;
  }

  /** Upsert one per-user preference. */
  setUserPref(userId: string, key: string, value: string): void {
    this.exec(
      `INSERT INTO user_prefs(user_id, key, value, updated_at_ms) VALUES(?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE
       SET value=excluded.value, updated_at_ms=excluded.updated_at_ms`,
      [userId, key, value, Date.now()],
    );
  }

  /**
   * Phase-5 dashboard: keys of one user's prefs starting with a prefix
   * (e.g. the `gacfg:` group-assistant configs). Additive read-only helper;
   * LIKE wildcards in the prefix are escaped so the match is literal.
   */
  listUserPrefKeys(userId: string, prefix: string): string[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.query<{ key: string }>(
      `SELECT key FROM user_prefs WHERE user_id=? AND key LIKE ? ESCAPE '\\' ORDER BY key ASC`,
      [userId, `${escaped}%`],
    ).map((r) => r.key);
  }

  // ---- phase 5, item 1: skill package signing ----

  /**
   * The owner's signing keypair, if `/skill keygen` has run. The returned
   * row carries the private key — callers must never log it or send it
   * anywhere except the explicit key-export path.
   */
  getSkillSigningKey(): SkillSigningKeyRow | undefined {
    const rows = this.query<{
      key_id: string;
      public_key: string;
      private_key_jwk: string;
      created_at_ms: number;
    }>(`SELECT key_id, public_key, private_key_jwk, created_at_ms FROM skill_signing_key WHERE id=1`);
    const r = rows[0];
    if (r === undefined) return undefined;
    return {
      keyId: r.key_id,
      publicKey: r.public_key,
      privateKeyJwk: r.private_key_jwk,
      createdAtMs: r.created_at_ms,
    };
  }

  /** Store (or replace) the owner's signing keypair. Single row, id = 1. */
  setSkillSigningKey(key: { keyId: string; publicKey: string; privateKeyJwk: string }): void {
    this.exec(
      `INSERT INTO skill_signing_key(id, key_id, public_key, private_key_jwk, created_at_ms)
       VALUES(1,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         key_id=excluded.key_id, public_key=excluded.public_key,
         private_key_jwk=excluded.private_key_jwk, created_at_ms=excluded.created_at_ms`,
      [key.keyId, key.publicKey, key.privateKeyJwk, Date.now()],
    );
  }

  /** Trust a publisher's key: upsert by fingerprint, refreshing the label. */
  trustSkillPublisher(p: { keyId: string; label: string; publicKey: string }): { added: boolean } {
    const existing = this.getTrustedSkillPublisher(p.keyId);
    const now = Date.now();
    if (existing === undefined) {
      this.exec(
        `INSERT INTO skill_trusted_publishers(key_id, label, public_key, added_at_ms)
         VALUES(?,?,?,?)`,
        [p.keyId, p.label, p.publicKey, now],
      );
      return { added: true };
    }
    // Keep the known public key when the new trust carries none (trusted by
    // fingerprint), but prefer a freshly supplied one.
    const publicKey = p.publicKey !== "" ? p.publicKey : existing.publicKey;
    this.exec(
      `UPDATE skill_trusted_publishers SET label=?, public_key=? WHERE key_id=?`,
      [p.label, publicKey, p.keyId],
    );
    return { added: false };
  }

  /** Revoke trust in a publisher. Returns false when it was not trusted. */
  untrustSkillPublisher(keyId: string): boolean {
    const res = this.exec(`DELETE FROM skill_trusted_publishers WHERE key_id=?`, [keyId]);
    return (res.changes as number) > 0;
  }

  getTrustedSkillPublisher(keyId: string): TrustedSkillPublisherRow | undefined {
    const rows = this.query<{
      key_id: string;
      label: string;
      public_key: string;
      added_at_ms: number;
    }>(`SELECT key_id, label, public_key, added_at_ms FROM skill_trusted_publishers WHERE key_id=?`, [
      keyId,
    ]);
    const r = rows[0];
    if (r === undefined) return undefined;
    return { keyId: r.key_id, label: r.label, publicKey: r.public_key, addedAtMs: r.added_at_ms };
  }

  listTrustedSkillPublishers(): TrustedSkillPublisherRow[] {
    return this.query<{
      key_id: string;
      label: string;
      public_key: string;
      added_at_ms: number;
    }>(
      `SELECT key_id, label, public_key, added_at_ms FROM skill_trusted_publishers ORDER BY added_at_ms ASC`,
    ).map((r) => ({
      keyId: r.key_id,
      label: r.label,
      publicKey: r.public_key,
      addedAtMs: r.added_at_ms,
    }));
  }

  /**
   * Record which publisher signed an installed skill (null = unsigned),
   * from the verified envelope at import time. Upserted per skill name.
   */
  recordSkillInstallProvenance(p: { skillName: string; keyId: string | null }): void {
    this.exec(
      `INSERT INTO skill_install_provenance(skill_name, key_id, signed_at_ms)
       VALUES(?,?,?)
       ON CONFLICT(skill_name) DO UPDATE SET
         key_id=excluded.key_id, signed_at_ms=excluded.signed_at_ms`,
      [p.skillName, p.keyId, Date.now()],
    );
  }

  /** Drop a skill's provenance row (on uninstall). */
  removeSkillInstallProvenance(skillName: string): void {
    this.exec(`DELETE FROM skill_install_provenance WHERE skill_name=?`, [skillName]);
  }

  getSkillInstallProvenance(skillName: string): SkillInstallProvenanceRow | undefined {
    const rows = this.query<{ skill_name: string; key_id: string | null; signed_at_ms: number }>(
      `SELECT skill_name, key_id, signed_at_ms FROM skill_install_provenance WHERE skill_name=?`,
      [skillName],
    );
    const r = rows[0];
    if (r === undefined) return undefined;
    return { skillName: r.skill_name, keyId: r.key_id, signedAtMs: r.signed_at_ms };
  }

  // ---- custom shortcuts ----

  /**
   * All owner-defined shortcuts, alphabetical by name.
   *
   * This is owner configuration data, not conversation content; there is no
   * per-user scoping - the whole table belongs to the bot owner.
   */
  listShortcuts(): CustomShortcut[] {
    return this.query<{
      name: string;
      kind: string;
      action: string;
      tool_args: string | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT name, kind, action, tool_args, created_at, updated_at
         FROM custom_shortcuts ORDER BY name ASC`,
    ).map(toCustomShortcut);
  }

  /** One shortcut by name (lowercase, no leading slash), or undefined. */
  getShortcut(name: string): CustomShortcut | undefined {
    const rows = this.query<{
      name: string;
      kind: string;
      action: string;
      tool_args: string | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT name, kind, action, tool_args, created_at, updated_at
         FROM custom_shortcuts WHERE name=?`,
      [name],
    );
    const r = rows[0];
    return r === undefined ? undefined : toCustomShortcut(r);
  }

  /**
   * Insert or replace a shortcut. `kind` must be 'prompt' or 'tool';
   * a bad value is refused here with a clear message rather than at the
   * database CHECK constraint.
   */
  upsertShortcut(s: {
    name: string;
    kind: string;
    action: string;
    toolArgs?: Record<string, unknown>;
  }): void {
    if (s.kind !== "prompt" && s.kind !== "tool") {
      throw new StorageError("query", `invalid shortcut kind: ${s.kind}`);
    }
    const now = Date.now();
    this.exec(
      `INSERT INTO custom_shortcuts(name, kind, action, tool_args, created_at, updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         kind=excluded.kind, action=excluded.action,
         tool_args=excluded.tool_args, updated_at=excluded.updated_at`,
      [s.name, s.kind, s.action, s.toolArgs ? JSON.stringify(s.toolArgs) : null, now, now],
    );
  }

  /** Delete one shortcut. Returns whether a row went. */
  deleteShortcut(name: string): boolean {
    const res = this.exec(`DELETE FROM custom_shortcuts WHERE name=?`, [name]);
    return (res.changes as number) > 0;
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
  importance: number;
}): MemoryRecord {
  return {
    userId: r.user_id,
    key: r.key,
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    importance: r.importance,
  };
}

/** Map a custom_shortcuts row to a record. */
function toCustomShortcut(r: {
  name: string;
  kind: string;
  action: string;
  tool_args: string | null;
  created_at: number;
  updated_at: number;
}): CustomShortcut {
  let toolArgs: Record<string, unknown> | undefined;
  if (r.tool_args !== null && r.tool_args.length > 0) {
    try {
      const parsed: unknown = JSON.parse(r.tool_args);
      if (typeof parsed === "object" && parsed !== null) {
        toolArgs = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON is treated as "no args" rather than a crash - the
      // shortcut itself (name/kind/action) is what matters.
    }
  }
  const out: CustomShortcut = {
    name: r.name,
    kind: r.kind === "tool" ? "tool" : "prompt",
    action: r.action,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (toolArgs !== undefined) out.toolArgs = toolArgs;
  return out;
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

/** Raw row shape shared by the scheduled-task queries. */
interface ScheduledTaskRow {
  id: number;
  name: string;
  cron_expr: string;
  timezone: string;
  action_json: string;
  enabled: number;
  created_by_user_id: string;
  next_run_at_ms: number;
  last_run_at_ms: number | null;
  last_status: string | null;
  run_count: number;
  created_at: number;
}

/** Map a scheduled-task row to a record, omitting nulls. */
function toScheduledTaskRecord(r: ScheduledTaskRow): ScheduledTaskRecord {
  return {
    id: r.id,
    name: r.name,
    cronExpr: r.cron_expr,
    timezone: r.timezone,
    actionJson: r.action_json,
    enabled: r.enabled === 1,
    createdByUserId: r.created_by_user_id,
    nextRunAtMs: r.next_run_at_ms,
    runCount: r.run_count,
    createdAt: r.created_at,
    ...(r.last_run_at_ms !== null ? { lastRunAtMs: r.last_run_at_ms } : {}),
    ...(r.last_status !== null ? { lastStatus: r.last_status as ScheduledTaskStatus } : {}),
  };
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

/** Raw row shape for the goals queries. */
interface GoalRow {
  id: number;
  title: string;
  description: string;
  status: string;
  created_by: string;
  created_at_ms: number;
  updated_at_ms: number;
  done_at_ms: number | null;
}

/** Map a goal row to a record, omitting nulls (exactOptionalPropertyTypes). */
function toGoalRecord(r: GoalRow): GoalRecord {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as GoalStatus,
    createdBy: r.created_by,
    createdAt: r.created_at_ms,
    updatedAt: r.updated_at_ms,
    ...(r.done_at_ms !== null ? { doneAt: r.done_at_ms } : {}),
  };
}

/** Raw row shape for the heartbeat-log queries. */
interface HeartbeatLogRow {
  id: number;
  ran_at_ms: number;
  summary: string;
  tool_calls: number;
  status: string;
}

/** Map a heartbeat-log row to a record. */
function toHeartbeatLogEntry(r: HeartbeatLogRow): HeartbeatLogEntry {
  return {
    id: r.id,
    ranAtMs: r.ran_at_ms,
    summary: r.summary,
    toolCalls: r.tool_calls,
    status: r.status as HeartbeatStatus,
  };
}

/**
 * Truncate a heartbeat summary to 500 characters.
 *
 * Counts code points, not UTF-16 units, so a cut never splits an emoji into a
 * lone surrogate. Defence in depth for the service-side truncation.
 */
function truncateSummary(s: string): string {
  const points = Array.from(s);
  return points.length <= 500 ? s : points.slice(0, 500).join("");
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

/** Attempts are bounded: never let a misconfiguration become an unbounded loop. */
function clampAttempts(raw: number | undefined): number {
  if (raw === undefined) return 2;
  return clampInt(raw, 1, 4, 2);
}

/** Per-candidate timeout is bounded both ways, so it can never be zero. */
function clampTimeout(raw: number | undefined): number {
  if (raw === undefined) return 300_000;
  return clampInt(raw, 1_000, 600_000, 300_000);
}
