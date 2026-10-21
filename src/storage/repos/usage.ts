/**
 * UsageRepo — Usage counters + ledger repository (phase 6).
 *
 * Owns the SQL for: usage, usage_ledger.
 * Extracted from the old Storage god class; method bodies are unchanged,
 * only their home moved. Row shapes stay inside the storage layer.
 */

import { RepoBase } from "./base";

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

export class UsageRepo extends RepoBase {
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
}

/** DDL fragment owned by this repository (phase 6). The Storage facade
 *  assembles the full SCHEMA from the domain fragments in a fixed order;
 *  the statements themselves are byte-identical to the pre-split schema. */
export const USAGE_SCHEMA = `

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
`;
