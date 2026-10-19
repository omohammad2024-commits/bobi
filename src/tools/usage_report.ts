/**
 * usage_report — owner-only token-usage and approximate-cost report.
 *
 * OWNER-ONLY: the report aggregates across ALL users (the owner sees all),
 * and a non-owner must never see anyone else's spend. Enforced twice: the
 * `ownerOnly` flag keeps the bridge from granting the permission key to
 * anyone else, and run() re-checks ownership against a server-supplied
 * predicate, so a hand-built actor cannot slip through either.
 *
 * The numbers are token counts (metadata, never message content) and the
 * costs are APPROXIMATE — the report says so in Persian, so nobody mistakes
 * it for a bill.
 */
import { UsageTracker } from "../ai/usage";
import type { Storage } from "../storage/storage";
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";

export const USAGE_REPORT_PERMISSION = "tools:usage_report";

export interface UsageReportToolDeps {
  storage: Storage;
  /**
   * Server-supplied owner check. The userId comes from the trusted actor, so
   * this predicate — not anything in the request — decides ownership.
   */
  isOwner: (userId: string) => boolean;
  /** Injectable clock (unix ms), for deterministic tests. */
  now?: () => number;
}

export interface UsageReportOutput {
  /** Persian report text. */
  text: string;
}

/** Millisecond timestamps, day-aligned in UTC so tests are deterministic. */
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Latin digits with thousands separators for display. */
function en(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format an approximate USD amount. */
function enCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "less than $0.01";
  return `$${usd.toFixed(2)}`;
}

export function createUsageReportTool(deps: UsageReportToolDeps): Tool<Record<string, never>, UsageReportOutput> {
  return {
    name: "usage_report",
    description:
      "Token usage and approximate cost report for today and the last 7 days, by model (owner only).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [USAGE_REPORT_PERMISSION] },
    toolset: "system",
    input: { fields: {} },

    async run(_input: Record<string, never>, ctx: ToolContext): Promise<UsageReportOutput> {
      const userId = ctx.actor.userId;
      if (typeof userId !== "string" || userId.length === 0 || userId === "unknown") {
        throw new ToolError("not_allowed", "Identity is unknown.");
      }
      if (!deps.isOwner(userId)) {
        throw new ToolError("not_allowed", "The usage report is owner only.");
      }

      const now = deps.now !== undefined ? deps.now() : Date.now();
      const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
      const weekStart = now - WEEK_MS;

      const tracker = new UsageTracker(deps.storage);
      // Owner view: aggregates across all users. A non-owner can never reach
      // this code — see the check above.
      const today = tracker.totalsAll(todayStart);
      const week = tracker.totalsAll(weekStart);
      const topModels = tracker.byModelAll(weekStart).slice(0, 5);

      const lines: string[] = [];
      lines.push("📊 Usage Report");
      lines.push("");
      lines.push("Today:");
      lines.push(`• Requests: ${en(today.runs)}`);
      lines.push(`• Input tokens: ${en(today.inputTokens)} — Output tokens: ${en(today.outputTokens)}`);
      lines.push(`• Estimated cost: ${enCost(today.estimatedUsd)}`);
      lines.push("");
      lines.push("Last 7 days:");
      lines.push(`• Requests: ${en(week.runs)}`);
      lines.push(`• Input tokens: ${en(week.inputTokens)} — Output tokens: ${en(week.outputTokens)}`);
      lines.push(`• Estimated cost: ${enCost(week.estimatedUsd)}`);

      if (topModels.length > 0) {
        lines.push("");
        lines.push("Top models (last 7 days):");
        topModels.forEach((m, i) => {
          lines.push(
            `${en(i + 1)}. ${m.modelId} — ${en(m.inputTokens)} input, ${en(m.outputTokens)} output, ${en(m.runs)} runs (~${enCost(m.estimatedUsd)})`,
          );
        });
      }

      lines.push("");
      lines.push(
        "⚠️ These costs are approximate and not a real bill; prices may have changed.",
      );

      return { text: lines.join("\n") };
    },
  };
}
