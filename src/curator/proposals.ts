/**
 * Pending-proposal store (Phase D4).
 *
 * The curator service only PRODUCES proposals; this store is what remembers
 * them between the review pass and the owner's decision. A proposal is inert
 * data in a table — it becomes a memory change only when the `curator_decide`
 * tool runs with decision "approve" and applies the stored action through
 * the MemoryProvider. There is no other apply path.
 *
 * The table is created lazily with CREATE TABLE IF NOT EXISTS on init. This
 * deliberately does NOT go through storage.ts (owned by another worker this
 * batch): the proposals are curator bookkeeping, not core storage, and the
 * lazy create keeps the curator self-contained — it works with any Database
 * handle, including a second connection to the same SQLite file. See the
 * phase doc for the full rationale.
 *
 * SECURITY:
 * - Proposals expire after 7 days: a stale approval can never fire later.
 *   Expiry is enforced on read (listPending/getPending) and on resolve —
 *   expired proposals are marked "expired" and resolve to undefined.
 * - Every row is scoped to user_id; reads and resolves always filter by it.
 * - Status transitions are one-way: a resolved proposal (approved/rejected/
 *   expired) can never become pending again, so a decision cannot double-fire.
 */
import type { Database } from "bun:sqlite";
import type { Proposal, ProposalAction, ProposalKind } from "./curator";

/** How long a proposal stays approvable: 7 days. */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One-way lifecycle: pending -> approved | rejected | expired. */
export type ProposalStatus = "pending" | "approved" | "rejected" | "expired";

export type ProposalDecision = "approve" | "reject";

/** A proposal as stored: the review output plus ownership and lifecycle. */
export interface StoredProposal extends Proposal {
  userId: string;
  status: ProposalStatus;
  /** unix ms */
  createdAt: number;
  /** unix ms, null while pending */
  resolvedAt: number | null;
}

interface ProposalRow {
  id: string;
  user_id: string;
  kind: string;
  memory_ids: string;
  summary_fa: string;
  action: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

export interface ProposalStoreOptions {
  /** Injectable clock, ms. Tests pass a fixed clock to age proposals. */
  now?: () => number;
}

export class ProposalStore {
  private readonly now: () => number;
  private initialized = false;

  constructor(
    private readonly db: Database,
    opts: ProposalStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Create the table if it does not exist. Also called lazily by every
   * method, so a store used without an explicit init() still works — the
   * caller never has to remember a setup step.
   */
  init(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS curator_proposals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        memory_ids TEXT NOT NULL,
        summary_fa TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_curator_proposals_user
        ON curator_proposals(user_id, status);
    `);
    this.initialized = true;
  }

  /**
   * Persist a review's proposals as pending. Idempotent: proposal ids are
   * deterministic (see proposalId), so INSERT OR IGNORE dedupes re-runs over
   * unchanged memories instead of piling up identical rows. Returns the
   * user's current pending proposals, newest first.
   */
  saveProposals(userId: string, proposals: readonly Proposal[]): StoredProposal[] {
    this.init();
    const now = this.now();
    const insert = this.db.query(
      `INSERT OR IGNORE INTO curator_proposals
         (id, user_id, kind, memory_ids, summary_fa, action, status, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    );
    for (const p of proposals) {
      insert.run(
        p.id,
        userId,
        p.kind,
        JSON.stringify(p.memoryIds),
        p.summaryFa,
        JSON.stringify(p.suggestedAction),
        now,
      );
    }
    return this.listPending(userId);
  }

  /**
   * The user's pending, unexpired proposals, newest first. Expired rows found
   * along the way are marked "expired" so they can never be approved later.
   */
  listPending(userId: string): StoredProposal[] {
    this.init();
    this.expireStale(userId);
    const rows = this.db
      .query<ProposalRow, [string]>(
        `SELECT * FROM curator_proposals
         WHERE user_id = ? AND status = 'pending'
         ORDER BY created_at DESC, id ASC`,
      )
      .all(userId);
    return rows.map(rowToProposal);
  }

  /**
   * One pending, unexpired proposal by id — scoped to the user. Returns
   * undefined when the id is unknown, already resolved, or expired (in which
   * case it is marked "expired"). This is the ONLY way the decide tool
   * obtains an actionable proposal.
   */
  getPending(userId: string, id: string): StoredProposal | undefined {
    this.init();
    const row = this.db
      .query<ProposalRow, [string, string]>(
        `SELECT * FROM curator_proposals WHERE user_id = ? AND id = ?`,
      )
      .get(userId, id);
    if (!row) return undefined;
    if (row.status !== "pending") return undefined;
    if (row.created_at + PROPOSAL_TTL_MS <= this.now()) {
      this.markExpired(row.id);
      return undefined;
    }
    return rowToProposal(row);
  }

  /**
   * Record the owner's decision on a pending, unexpired proposal.
   *
   * Returns the stored proposal (with its new status) or undefined when the
   * id is unknown, already resolved, or expired — in the expired case the row
   * is marked "expired". Note this method only flips the row's status: it
   * does NOT apply the action. The action is applied by the `curator_decide`
   * tool through the MemoryProvider, and only for decision "approve".
   */
  resolveProposal(
    userId: string,
    id: string,
    decision: ProposalDecision,
  ): StoredProposal | undefined {
    this.init();
    const pending = this.getPending(userId, id);
    if (!pending) return undefined;
    const status: ProposalStatus = decision === "approve" ? "approved" : "rejected";
    this.db
      .query(`UPDATE curator_proposals SET status = ?, resolved_at = ? WHERE id = ?`)
      .run(status, this.now(), id);
    return { ...pending, status, resolvedAt: this.now() };
  }

  /** Count pending, unexpired proposals — used to keep review output bounded. */
  countPending(userId: string): number {
    return this.listPending(userId).length;
  }

  // ---------- internals ----------

  /** Mark the user's pending rows that aged past the TTL as expired. */
  private expireStale(userId: string): void {
    const cutoff = this.now() - PROPOSAL_TTL_MS;
    this.db
      .query(
        `UPDATE curator_proposals
         SET status = 'expired', resolved_at = ?
         WHERE user_id = ? AND status = 'pending' AND created_at <= ?`,
      )
      .run(this.now(), userId, cutoff);
  }

  private markExpired(id: string): void {
    this.db
      .query(`UPDATE curator_proposals SET status = 'expired', resolved_at = ? WHERE id = ?`)
      .run(this.now(), id);
  }
}

/** Deserialize a row. The JSON was written by saveProposals, not by the user. */
function rowToProposal(row: ProposalRow): StoredProposal {
  return {
    id: row.id,
    kind: row.kind as ProposalKind,
    memoryIds: JSON.parse(row.memory_ids) as string[],
    summaryFa: row.summary_fa,
    suggestedAction: JSON.parse(row.action) as ProposalAction,
    userId: row.user_id,
    status: row.status as ProposalStatus,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
