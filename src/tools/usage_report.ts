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

/** Persian digits for display; keeps the report in the bot's register. */
function fa(n: number): string {
  const digits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  const grouped = Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return grouped.replace(/[0-9]/g, (d) => digits[Number(d)]!);
}

/** Format an approximate USD amount in Persian. */
function faCost(usd: number): string {
  if (usd <= 0) return "۰ دلار";
  if (usd < 0.01) return "کمتر از ۰٫۰۱ دلار";
  const raw = usd.toFixed(2);
  const digits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  return `${raw.replace(/[0-9]/g, (d) => digits[Number(d)]!).replace(".", "٫")} دلار`;
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
      lines.push("📊 گزارش مصرف");
      lines.push("");
      lines.push("امروز:");
      lines.push(`• درخواست‌ها: ${fa(today.runs)}`);
      lines.push(`• توکن ورودی: ${fa(today.inputTokens)} — توکن خروجی: ${fa(today.outputTokens)}`);
      lines.push(`• هزینهٔ تقریبی: ${faCost(today.estimatedUsd)}`);
      lines.push("");
      lines.push("۷ روز اخیر:");
      lines.push(`• درخواست‌ها: ${fa(week.runs)}`);
      lines.push(`• توکن ورودی: ${fa(week.inputTokens)} — توکن خروجی: ${fa(week.outputTokens)}`);
      lines.push(`• هزینهٔ تقریبی: ${faCost(week.estimatedUsd)}`);

      if (topModels.length > 0) {
        lines.push("");
        lines.push("پرمصرف‌ترین مدل‌ها (۷ روز اخیر):");
        topModels.forEach((m, i) => {
          lines.push(
            `${fa(i + 1)}. ${m.modelId} — ${fa(m.inputTokens)} ورودی، ${fa(m.outputTokens)} خروجی، ${fa(m.runs)} بار اجرا (~${faCost(m.estimatedUsd)})`,
          );
        });
      }

      lines.push("");
      lines.push(
        "⚠️ این هزینه‌ها تقریبی‌اند و صورتحساب واقعی نیستند؛ قیمت‌ها ممکن است تغییر کرده باشند.",
      );

      return { text: lines.join("\n") };
    },
  };
}
