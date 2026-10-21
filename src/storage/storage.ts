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

import { DbHandle } from "./db_handle";

import { StorageError } from "./errors";

export { StorageError } from "./errors";

const SCHEMA =
  CONVERSATIONS_SCHEMA +
  ACCESS_SCHEMA +
  PROVIDERS_SCHEMA +
  USAGE_SCHEMA +
  SCHEDULING_SCHEMA +
  MEMORIES_SCHEMA +
  MISC_SCHEMA +
  TODO_SCHEMA;

/**
 * Current schema version.
 *
 * Exported so a test can assert it by name rather than repeating the literal:
 * a hardcoded copy silently rots each time this is bumped.
 */
export const SCHEMA_VERSION = 24;

import { ConversationsRepo, CONVERSATIONS_SCHEMA } from "./repos/conversations";
import { ProvidersRepo, PROVIDERS_SCHEMA } from "./repos/providers";
import { AccessRepo, ACCESS_SCHEMA } from "./repos/access";
import { SchedulingRepo, SCHEDULING_SCHEMA } from "./repos/scheduling";
import { MemoriesRepo, MEMORIES_SCHEMA } from "./repos/memories";
import { UsageRepo, USAGE_SCHEMA } from "./repos/usage";
import { MiscRepo, MISC_SCHEMA } from "./repos/misc";
import { TodoRepo, TODO_SCHEMA } from "./repos/todo";
import type { StoredMessage, UserConversationSummary, MessageSearchResult, ConversationSummary } from "./repos/conversations";
import type { AiProviderRow, EncryptedCredentialRow, AiPoolCredentialRow, AiModelRow, SearchSettings, AiRuntimeSettings, AiProviderHealthRow, AiFailoverSettings, AiFailoverCandidate } from "./repos/providers";
import type { AuditOutcome, GroupState, GroupAccessRecord, UserAccessRecord, AuditEvent } from "./repos/access";
import type { ReminderRepeat, ReminderState, ScheduledTaskStatus, ScheduledTaskRecord, GoalStatus, GoalRecord, HeartbeatStatus, HeartbeatLogEntry, ReminderRecord } from "./repos/scheduling";
import type { MemoryRecord } from "./repos/memories";
import type { UsageRecord, UsageLedgerEntry } from "./repos/usage";
import type { SkillSigningKeyRow, TrustedSkillPublisherRow, SkillInstallProvenanceRow, CustomShortcut } from "./repos/misc";
import type { TodoItemRecord } from "./repos/todo";
export * from "./repos/conversations";
export * from "./repos/providers";
export * from "./repos/access";
export * from "./repos/scheduling";
export * from "./repos/memories";
export * from "./repos/usage";
export * from "./repos/misc";
export * from "./repos/todo";

export class Storage {

private handle: DbHandle;

  readonly conversations: ConversationsRepo;
  readonly providers: ProvidersRepo;
  readonly access: AccessRepo;
  readonly scheduling: SchedulingRepo;
  readonly memories: MemoriesRepo;
  readonly usage: UsageRepo;
  readonly misc: MiscRepo;
  readonly todo: TodoRepo;

private constructor(db: Database) {
    this.handle = new DbHandle(db);
    this.conversations = new ConversationsRepo(this.handle);
    this.providers = new ProvidersRepo(this.handle);
    this.access = new AccessRepo(this.handle);
    this.scheduling = new SchedulingRepo(this.handle);
    this.memories = new MemoriesRepo(this.handle);
    this.usage = new UsageRepo(this.handle);
    this.misc = new MiscRepo(this.handle);
    this.todo = new TodoRepo(this.handle);
  }

/** The platform's single shared database handle (phase 6). */
  get dbHandle(): DbHandle {
    return this.handle;
  }

/** The raw Database behind the shared handle — for the satellite stores
   *  (bench history, proposals, nudges, memory vectors) that receive a
   *  Database; they must share this connection instead of opening a
   *  parallel handle on the same file. */
  get database(): Database {
    return this.handle.raw;
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
        this.handle.execScript(SCHEMA);
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
    // Schema 22 (memory core): recall telemetry for memories. recall_count
    // feeds consolidation's promotion rule; last_recalled_at lets staleness
    // mean "not written AND not recalled". Same idempotent ALTER pattern;
    // fresh databases get both columns from the SCHEMA block above.
    this.addColumnIfMissing("memories", "recall_count", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("memories", "last_recalled_at", "INTEGER");
    // Provider health detail: the failing HTTP status and the measured
    // probe latency, so list views can show WHY a provider is red without
    // re-running the probe. Same idempotent pattern; fresh databases get
    // both columns from the SCHEMA block above.
    this.addColumnIfMissing("ai_provider_health", "status", "INTEGER");
    this.addColumnIfMissing("ai_provider_health", "latency_ms", "INTEGER");
    // Phase 8 (silo merge): the reminders table absorbs the follow-up
    // ("nudge") system — followup flag, snooze override, resurface stamp.
    // Same idempotent pattern; fresh databases get all three columns from
    // the SCHEMA block above.
    this.addColumnIfMissing("reminders", "followup", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("reminders", "snoozed_until", "INTEGER");
    this.addColumnIfMissing("reminders", "reminded_at", "INTEGER");
  }

/** Add a column when an older database does not have it yet. */
  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const rows = this.query<{ name: string }>(`PRAGMA table_info(${table})`);
    if (rows.some((r) => r.name === column)) return;
    this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

/** Resolve (or create) the conversation owned by (userId, chatId). */
  conversationId(userId: string, chatId: string): number {
    return this.conversations.conversationId(userId, chatId);
  }

/** Append a message; returns its id. Verifies ownership first. */
  appendMessage(
    userId: string,
    chatId: string,
    role: StoredMessage["role"],
    content: string,
  ): number {
    return this.conversations.appendMessage(userId, chatId, role, content);
  }

/**
   * Read history in chronological order, newest-last.
   * `limit` caps the count (most recent N kept, in order).
   * Returns [] if the caller does not own the conversation.
   */
  history(userId: string, chatId: string, limit = 50): StoredMessage[] {
    return this.conversations.history(userId, chatId, limit);
  }

/** Delete a whole conversation (ownership-checked). */
  deleteConversation(userId: string, chatId: string): void {
    return this.conversations.deleteConversation(userId, chatId);
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
    return this.conversations.listUserConversations(userId);
  }

/**
   * Count persisted messages in one conversation.
   *
   * Used by the MCP `bobi_conversation_status` tool. Ownership-checked: a
   * conversation the caller does not own reads as zero, never as someone
   * else's count.
   */
  countMessages(userId: string, chatId: string): number {
    return this.conversations.countMessages(userId, chatId);
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
    return this.conversations.searchMessages(query, opts);
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
    this.handle.close();
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
    return this.access.appendAudit(event);
  }

/** Newest-first audit events, capped at `limit`. */
  auditEvents(limit = 100): AuditEvent[] {
    return this.access.auditEvents(limit);
  }

// ---- group access ----

  /**
   * Fetch one group record by chat id, or undefined.
   * Used on every group update so access never relies on a stale cache.
   */
  groupAccess(chatId: string): GroupAccessRecord | undefined {
    return this.access.groupAccess(chatId);
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
    return this.access.createPendingGroup(g);
  }

/**
   * Move a group to a new state.
   *
   * The WHERE clause re-tests the expected current state, so a replayed or
   * stale action finds no row to update and reports false instead of applying
   * a contradictory transition. Returns whether the row was changed.
   */
  transitionGroup(chatId: string, expected: GroupState, to: GroupState, decidedBy: string): boolean {
    return this.access.transitionGroup(chatId, expected, to, decidedBy);
  }

/** List groups by state, newest first, with a capped page size. */
  listGroupsByState(state: GroupState, limit = 10, offset = 0): GroupAccessRecord[] {
    return this.access.listGroupsByState(state, limit, offset);
  }

/** Count of groups in a state — bounded, cheap status information. */
  countGroupsByState(state: GroupState): number {
    return this.access.countGroupsByState(state);
  }

/**
   * Mark that the owner has already been notified for this group.
   * Conditioned on the stored timestamp so a concurrent retry cannot reset it.
   */
  markGroupNotified(chatId: string, onlyIf: number | undefined): boolean {
    return this.access.markGroupNotified(chatId, onlyIf);
  }

// ---- user access ----

  /**
   * Fetch one private-chat user record, or undefined.
   * Read on every message so revocation takes effect immediately.
   */
  userAccess(userId: string): UserAccessRecord | undefined {
    return this.access.userAccess(userId);
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
    return this.access.createPendingUser(u);
  }

/**
   * Move a user to a new state.
   *
   * The WHERE clause re-tests the expected current state, so a replayed or
   * stale decision finds no row to update and reports false instead of applying
   * a contradictory transition.
   */
  transitionUser(userId: string, expected: GroupState, to: GroupState, decidedBy: string): boolean {
    return this.access.transitionUser(userId, expected, to, decidedBy);
  }

/** List users by state, newest activity first, with a capped page size. */
  listUsersByState(state: GroupState, limit = 10, offset = 0): UserAccessRecord[] {
    return this.access.listUsersByState(state, limit, offset);
  }

/** Count of users in a state. */
  countUsersByState(state: GroupState): number {
    return this.access.countUsersByState(state);
  }

/**
   * Mark that the owner has already been notified about this user.
   * Conditioned on the stored timestamp so a concurrent retry cannot reset it.
   */
  markUserNotified(userId: string, onlyIf: number | undefined): boolean {
    return this.access.markUserNotified(userId, onlyIf);
  }

// ---- conversation summaries ----

  /** The stored rolling summary for a conversation, if one exists. */
  getConversationSummary(userId: string, chatId: string): ConversationSummary | undefined {
    return this.conversations.getConversationSummary(userId, chatId);
  }

/** Store (or replace) a conversation's rolling summary and watermark. */
  setConversationSummary(s: {
    userId: string;
    chatId: string;
    summary: string;
    summarisedUntil: number;
  }): void {
    return this.conversations.setConversationSummary(s);
  }

/** Drop a conversation's rolling summary. */
  clearConversationSummary(userId: string, chatId: string): boolean {
    return this.conversations.clearConversationSummary(userId, chatId);
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
    return this.conversations.unsummarisedMessages(userId, chatId, summarisedUntil, keepLast);
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
    return this.usage.addUsage(u);
  }

/** One user's counters for one day, or zeros when nothing was recorded. */
  usageFor(userId: string, day: string): UsageRecord {
    return this.usage.usageFor(userId, day);
  }

/** Totals across all users for one day, for the owner's status view. */
  usageForDay(day: string): UsageRecord {
    return this.usage.usageForDay(day);
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
    return this.usage.recordUsage(entry);
  }

/**
   * Token totals for one user in a time window, across all models.
   * sinceMs is inclusive; omit it for all-time.
   */
  usageTotals(
    userId: string,
    sinceMs?: number,
  ): { inputTokens: number; outputTokens: number; runs: number } {
    return this.usage.usageTotals(userId, sinceMs);
  }

/**
   * Token totals per model for one user in a time window, most-used first.
   * sinceMs is inclusive; omit it for all-time.
   */
  usageByModel(
    userId: string,
    sinceMs?: number,
  ): { modelId: string; inputTokens: number; outputTokens: number; runs: number }[] {
    return this.usage.usageByModel(userId, sinceMs);
  }

/**
   * Token totals across ALL users in a time window, for the owner.
   * sinceMs is inclusive; omit it for all-time.
   */
  usageTotalsAll(
    sinceMs?: number,
  ): { inputTokens: number; outputTokens: number; runs: number } {
    return this.usage.usageTotalsAll(sinceMs);
  }

/**
   * Token totals per model across ALL users in a time window, most-used
   * first, for the owner. sinceMs is inclusive; omit it for all-time.
   */
  usageByModelAll(
    sinceMs?: number,
  ): { modelId: string; inputTokens: number; outputTokens: number; runs: number }[] {
    return this.usage.usageByModelAll(sinceMs);
  }

// ---- reminders ----

  /** Insert a pending reminder. Returns its id. */
  createReminder(r: {
    userId: string;
    chatId: string;
    text: string;
    dueAt: number;
    repeat: ReminderRepeat;
    /** Phase 8: follow-ups resurface until closed (see SchedulingRepo). */
    followup?: boolean;
  }): number {
    return this.scheduling.createReminder(r);
  }

/** One reminder by id, scoped to its owner. */
  getReminder(userId: string, id: number): ReminderRecord | undefined {
    return this.scheduling.getReminder(userId, id);
  }

/** A user's pending reminders, soonest first. */
  listReminders(userId: string, limit = 50): ReminderRecord[] {
    return this.scheduling.listReminders(userId, limit);
  }

/** Count of a user's pending reminders, for the per-user cap. */
  countPendingReminders(userId: string): number {
    return this.scheduling.countPendingReminders(userId);
  }

/**
   * Every reminder that is due, across all owners.
   *
   * The scheduler is the only caller: it must see all users so one shared timer
   * can serve everyone.
   */
  dueReminders(now: number, limit = 50): ReminderRecord[] {
    return this.scheduling.dueReminders(now, limit);
  }

/**
   * Claim a reminder for delivery: one-shots go pending -> fired;
   * follow-ups stay pending with `reminded_at` stamped.
   *
   * The UPDATE re-tests `state='pending'`, so two schedulers racing over the
   * same row produce exactly one winner. Without this a reminder could be sent
   * twice, which is worse than sending it late.
   */
  claimReminder(id: number, firedAt: number): boolean {
    return this.scheduling.claimReminder(id, firedAt);
  }

/** Cancel a pending reminder, scoped to its owner. */
  cancelReminder(userId: string, id: number): boolean {
    return this.scheduling.cancelReminder(userId, id);
  }

/** Snooze a pending reminder to a later instant, scoped to its owner. */
  snoozeReminder(userId: string, id: number, untilMs: number, nowMs?: number): boolean {
    return this.scheduling.snoozeReminder(userId, id, untilMs, nowMs);
  }

/**
   * Replace a fired reminder's due time, for a repeating one.
   *
   * Only a `fired` row may be re-armed, so a cancelled reminder cannot be
   * resurrected by a stale scheduler pass.
   */
  rearmReminder(id: number, dueAt: number): boolean {
    return this.scheduling.rearmReminder(id, dueAt);
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
    return this.scheduling.createTask(t);
  }

/** One task by id, scoped to its creator. */
  getTask(userId: string, id: number): ScheduledTaskRecord | undefined {
    return this.scheduling.getTask(userId, id);
  }

/** A creator's tasks, soonest next run first. */
  listTasks(userId: string, limit = 50): ScheduledTaskRecord[] {
    return this.scheduling.listTasks(userId, limit);
  }

/** Count of a creator's tasks, for the per-owner cap. */
  countTasks(userId: string): number {
    return this.scheduling.countTasks(userId);
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
    return this.scheduling.updateTask(userId, id, patch);
  }

/** Delete a task, scoped to its creator. */
  deleteTask(userId: string, id: number): boolean {
    return this.scheduling.deleteTask(userId, id);
  }

/**
   * Every enabled task whose time has come, across all creators.
   *
   * The scheduler is the only caller: like dueReminders, it must see all
   * owners so one shared timer can serve everyone.
   */
  dueTasks(now: number, limit = 50): ScheduledTaskRecord[] {
    return this.scheduling.dueTasks(now, limit);
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
    return this.scheduling.claimTask(id, expectedNextRunAtMs, newNextRunAtMs);
  }

/**
   * Record a finished run's outcome.
   *
   * The next slot was already written by claimTask, so this only records
   * when, how, and how many. A crash between the two leaves the series
   * re-armed with no outcome recorded — one occurrence lost, never duplicated.
   */
  markTaskRun(id: number, r: { ranAtMs: number; status: ScheduledTaskStatus }): boolean {
    return this.scheduling.markTaskRun(id, r);
  }

// ---- goals ----

  /** Insert a goal for its creator. Returns its id. */
  createGoal(g: { title: string; description?: string; createdBy: string }): number {
    return this.scheduling.createGoal(g);
  }

/** One goal by id, scoped to its creator. */
  getGoal(userId: string, id: number): GoalRecord | undefined {
    return this.scheduling.getGoal(userId, id);
  }

/** A creator's goals, newest first, optionally filtered by status. */
  listGoals(userId: string, status?: GoalStatus, limit = 50): GoalRecord[] {
    return this.scheduling.listGoals(userId, status, limit);
  }

/** How many goals a creator has, optionally filtered by status. */
  countGoals(userId: string, status?: GoalStatus): number {
    return this.scheduling.countGoals(userId, status);
  }

/**
   * Mark an active goal done. Only an active row may be completed, and only
   * by its creator — a completed goal cannot be re-completed into a fresh
   * done_at_ms, and a row that is not yours reports false instead of moving.
   */
  completeGoal(userId: string, id: number): boolean {
    return this.scheduling.completeGoal(userId, id);
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
    return this.scheduling.logHeartbeat(e);
  }

/** The most recent heartbeat passes, newest first. */
  recentHeartbeats(n = 5): HeartbeatLogEntry[] {
    return this.scheduling.recentHeartbeats(n);
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
    return this.memories.upsertMemory(m);
  }

/** One memory by key, scoped to its owner. */
  getMemory(userId: string, key: string): MemoryRecord | undefined {
    return this.memories.getMemory(userId, key);
  }

/**
   * A user's memories, newest first.
   *
   * Always filtered by owner: this is the only read path, so there is no
   * unfiltered variant that could leak another user's memory.
   */
  listMemories(userId: string, limit = 50): MemoryRecord[] {
    return this.memories.listMemories(userId, limit);
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
    return this.memories.bumpMemoryRecall(userId, keys);
  }

/**
   * Schema 22: set one memory's importance (1-5, clamped) WITHOUT bumping
   * updated_at — importance bookkeeping (consolidation promote/decay) is
   * not a content edit and must not re-arm the row's write clock.
   * Scoped to the owner. Returns whether a row matched.
   */
  setMemoryImportance(userId: string, key: string, importance: number): boolean {
    return this.memories.setMemoryImportance(userId, key, importance);
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
    return this.memories.pruneMemories(userId, drops);
  }

/** Delete one memory, scoped to its owner. Returns whether a row went. */
  deleteMemory(userId: string, key: string): boolean {
    return this.memories.deleteMemory(userId, key);
  }

/** How many memories a user has stored. Used for the prompt, not the content. */
  countMemories(userId: string): number {
    return this.memories.countMemories(userId);
  }

// ---- web search ----

  /**
   * The active search provider. Always fully specified: a fresh database
   * defaults to the keyless provider, so search works out of the box.
   */
  getSearchSettings(): SearchSettings {
    return this.providers.getSearchSettings();
  }

/** Persist the active search provider. */
  setSearchProvider(provider: string): void {
    return this.providers.setSearchProvider(provider);
  }

/** The stored search credential envelope, or undefined when none is set. */
  getSearchCredential(): EncryptedCredentialRow | undefined {
    return this.providers.getSearchCredential();
  }

/** Store (or replace) the search credential envelope. */
  upsertSearchCredential(c: { iv: string; ciphertext: string; tag: string }): void {
    return this.providers.upsertSearchCredential(c);
  }

/** Remove the search credential. Returns whether a row was deleted. */
  deleteSearchCredential(): boolean {
    return this.providers.deleteSearchCredential();
  }

/** True when a search credential is stored. */
  hasSearchCredential(): boolean {
    return this.providers.hasSearchCredential();
  }

// ---- AI providers ----

  /** All providers, newest first. Never includes credential material. */
  listProviders(): AiProviderRow[] {
    return this.providers.listProviders();
  }

/** One provider, or undefined when the id does not exist. */
  getProvider(id: number): AiProviderRow | undefined {
    return this.providers.getProvider(id);
  }

/** Insert a provider and return its id. */
  createProvider(p: {
    label: string;
    adapter: string;
    baseUrl: string;
    allowLocal?: boolean;
  }): number {
    return this.providers.createProvider(p);
  }

/** Update the editable fields of a provider. */
  updateProvider(
    id: number,
    patch: { label?: string; baseUrl?: string; adapter?: string; allowLocal?: boolean },
  ): void {
    return this.providers.updateProvider(id, patch);
  }

/**
   * Set the per-provider local-target exception.
   *
   * This is the only way a loopback/private target becomes reachable, and it
   * is a per-provider owner decision — never a global switch.
   */
  setProviderAllowLocal(id: number, allow: boolean): void {
    return this.providers.setProviderAllowLocal(id, allow);
  }

/** Enable or disable a provider. */
  setProviderEnabled(id: number, enabled: boolean): void {
    return this.providers.setProviderEnabled(id, enabled);
  }

/**
   * Delete a provider and its credentials, models and health rows.
   *
   * Callers must first ensure the provider is not the active one; this method
   * refuses an active provider so a running selection is never orphaned.
   */
  deleteProvider(id: number): boolean {
    return this.providers.deleteProvider(id);
  }

// ---- AI credentials ----

  /** True when a credential is stored for this provider. */
  hasCredential(providerId: number): boolean {
    return this.providers.hasCredential(providerId);
  }

/** Read the stored credential envelope, or undefined when none is set. */
  getCredential(providerId: number): EncryptedCredentialRow | undefined {
    return this.providers.getCredential(providerId);
  }

/** Store (or replace) a credential envelope. */
  upsertCredential(c: {
    providerId: number;
    iv: string;
    ciphertext: string;
    tag: string;
  }): void {
    return this.providers.upsertCredential(c);
  }

/** Remove a credential. Returns whether a row was deleted. */
  deleteCredential(providerId: number): boolean {
    return this.providers.deleteCredential(providerId);
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
    return this.providers.addPoolCredential(p);
  }

/** Pool entries of a provider, oldest first. Envelopes included, never plaintext. */
  listPoolCredentials(providerId: number): AiPoolCredentialRow[] {
    return this.providers.listPoolCredentials(providerId);
  }

/** One pool entry, or undefined when the id does not exist. */
  getPoolCredential(id: number): AiPoolCredentialRow | undefined {
    return this.providers.getPoolCredential(id);
  }

/** Enable or disable a pool entry. Returns whether the entry exists. */
  setPoolCredentialEnabled(id: number, enabled: boolean): boolean {
    return this.providers.setPoolCredentialEnabled(id, enabled);
  }

/** Remove a pool entry. Returns whether a row was deleted. */
  removePoolCredential(id: number): boolean {
    return this.providers.removePoolCredential(id);
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
    return this.providers.poolPosition(providerId, poolSize);
  }

// ---- AI models ----

  /** Models of a provider, newest first. */
  listModels(providerId: number): AiModelRow[] {
    return this.providers.listModels(providerId);
  }

/** One model, or undefined. */
  getModel(id: number): AiModelRow | undefined {
    return this.providers.getModel(id);
  }

/** Models of a provider whose label contains a filter, for quick switching. */
  findModelByLabel(providerId: number, label: string): AiModelRow | undefined {
    return this.providers.findModelByLabel(providerId, label);
  }

/** Insert a model. Returns its id, or throws on a duplicate (provider, model_id). */
  createModel(m: { providerId: number; modelId: string; label: string }): number {
    return this.providers.createModel(m);
  }

/** Rename a model's display label. */
  setModelLabel(id: number, label: string): boolean {
    return this.providers.setModelLabel(id, label);
  }

/** Enable or disable a model. */
  setModelEnabled(id: number, enabled: boolean): boolean {
    return this.providers.setModelEnabled(id, enabled);
  }

/**
   * Delete a model.
   *
   * Refuses to delete the active model, so a live selection is never left
   * pointing at a missing row. Refuses to delete a provider's only default,
   * since that would leave the provider with no default model.
   */
  deleteModel(id: number): boolean {
    return this.providers.deleteModel(id);
  }

/** Mark exactly one model of its provider as default. */
  setModelDefault(id: number): boolean {
    return this.providers.setModelDefault(id);
  }

// ---- AI runtime selection ----

  /** The single runtime settings row, always fully specified. */
  getRuntimeSettings(): AiRuntimeSettings {
    return this.providers.getRuntimeSettings();
  }

/**
   * Set the active provider and model together, so a selection is never
   * half-applied: a request either sees a consistent pair or none at all.
   */
  setRuntimeSelection(sel: { providerId: number; modelId: number }): void {
    return this.providers.setRuntimeSelection(sel);
  }

// ---- AI provider health ----

  /** Latest probe result for a provider. */
  getProviderHealth(providerId: number): AiProviderHealthRow | undefined {
    return this.providers.getProviderHealth(providerId);
  }

/** Record a probe result. The message must already be free of secrets. */
  setProviderHealth(h: {
    providerId: number;
    ok: boolean;
    message?: string;
    status?: number;
    latencyMs?: number;
  }): void {
    return this.providers.setProviderHealth(h);
  }

// ---- AI failover ----

  /**
   * Failover settings. Defaults to OFF, so a fresh database never switches
   * provider without the owner explicitly enabling it.
   */
  getFailoverSettings(): AiFailoverSettings {
    return this.providers.getFailoverSettings();
  }

/** Persist failover settings. */
  setFailoverSettings(s: {
    enabled?: boolean;
    maxAttempts?: number;
    timeoutMs?: number;
  }): void {
    return this.providers.setFailoverSettings(s);
  }

/** Ordered failover candidates, highest priority first. */
  listFailoverCandidates(): AiFailoverCandidate[] {
    return this.providers.listFailoverCandidates();
  }

/** Replace the candidate list. Order given is priority order. */
  setFailoverCandidates(candidates: readonly { providerId: number; modelId: number }[]): void {
    return this.providers.setFailoverCandidates(candidates);
  }

// ---- user preferences (Phase B) ----

  /**
   * Read one per-user preference. Returns undefined when never set.
   *
   * Generic key/value store for per-user switches; the only key in use today
   * is "voice_mode" ("1"/"0", Phase B3 TTS voice replies).
   */
  getUserPref(userId: string, key: string): string | undefined {
    return this.misc.getUserPref(userId, key);
  }

/** Upsert one per-user preference. */
  setUserPref(userId: string, key: string, value: string): void {
    return this.misc.setUserPref(userId, key, value);
  }

/**
   * Phase-5 dashboard: keys of one user's prefs starting with a prefix
   * (e.g. the `gacfg:` group-assistant configs). Additive read-only helper;
   * LIKE wildcards in the prefix are escaped so the match is literal.
   */
  listUserPrefKeys(userId: string, prefix: string): string[] {
    return this.misc.listUserPrefKeys(userId, prefix);
  }

// ---- owner profile (schema 23, platform Phase 4) ----

  /**
   * The serialized owner-profile document, or undefined when none has been
   * stored yet. Single-row data (there is exactly one owner): the document
   * is opaque JSON owned by src/profile/owner_profile.ts — this layer never
   * parses it, so a corrupt doc reads back verbatim and the profile layer
   * decides what to do with it.
   */
  getOwnerProfileDoc(): string | undefined {
    return this.misc.getOwnerProfileDoc();
  }

/** Store (or replace) the serialized owner-profile document. Single row, id = 1. */
  setOwnerProfileDoc(doc: string): void {
    return this.misc.setOwnerProfileDoc(doc);
  }

// ---- phase 5, item 1: skill package signing ----

  /**
   * The owner's signing keypair, if `/skill keygen` has run. The returned
   * row carries the private key — callers must never log it or send it
   * anywhere except the explicit key-export path.
   */
  getSkillSigningKey(): SkillSigningKeyRow | undefined {
    return this.misc.getSkillSigningKey();
  }

/** Store (or replace) the owner's signing keypair. Single row, id = 1. */
  setSkillSigningKey(key: { keyId: string; publicKey: string; privateKeyJwk: string }): void {
    return this.misc.setSkillSigningKey(key);
  }

/** Trust a publisher's key: upsert by fingerprint, refreshing the label. */
  trustSkillPublisher(p: { keyId: string; label: string; publicKey: string }): { added: boolean } {
    return this.misc.trustSkillPublisher(p);
  }

/** Revoke trust in a publisher. Returns false when it was not trusted. */
  untrustSkillPublisher(keyId: string): boolean {
    return this.misc.untrustSkillPublisher(keyId);
  }

getTrustedSkillPublisher(keyId: string): TrustedSkillPublisherRow | undefined {
    return this.misc.getTrustedSkillPublisher(keyId);
  }

listTrustedSkillPublishers(): TrustedSkillPublisherRow[] {
    return this.misc.listTrustedSkillPublishers();
  }

/**
   * Record which publisher signed an installed skill (null = unsigned),
   * from the verified envelope at import time. Upserted per skill name.
   */
  recordSkillInstallProvenance(p: { skillName: string; keyId: string | null }): void {
    return this.misc.recordSkillInstallProvenance(p);
  }

/** Drop a skill's provenance row (on uninstall). */
  removeSkillInstallProvenance(skillName: string): void {
    return this.misc.removeSkillInstallProvenance(skillName);
  }

getSkillInstallProvenance(skillName: string): SkillInstallProvenanceRow | undefined {
    return this.misc.getSkillInstallProvenance(skillName);
  }

// ---- custom shortcuts ----

  /**
   * All owner-defined shortcuts, alphabetical by name.
   *
   * This is owner configuration data, not conversation content; there is no
   * per-user scoping - the whole table belongs to the bot owner.
   */
  listShortcuts(): CustomShortcut[] {
    return this.misc.listShortcuts();
  }

/** One shortcut by name (lowercase, no leading slash), or undefined. */
  getShortcut(name: string): CustomShortcut | undefined {
    return this.misc.getShortcut(name);
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
    return this.misc.upsertShortcut(s);
  }

/** Delete one shortcut. Returns whether a row went. */
  deleteShortcut(name: string): boolean {
    return this.misc.deleteShortcut(name);
  }

// ---- low-level guarded wrappers (delegate to the shared handle) ----
  private exec(sql: string, params: unknown[] = []) {
    return this.handle.exec(sql, params);
  }

private query<T>(sql: string, params: unknown[] = []): T[] {
    return this.handle.query<T>(sql, params);
  }

private ensureOpen(): void {
    this.handle.ensureOpen();
  }

}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
