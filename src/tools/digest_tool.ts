/**
 * build_digest — owner-only proactive Persian morning digest.
 *
 * Stage-3 differentiator: composes a morning briefing from real in-repo
 * sources (date, today's tasks, reminders due today, pending curator
 * proposals, yesterday's usage, 3 web headlines, newest memories) and returns
 * it as formatted Persian text. A scheduled_task (or the existing
 * `/blueprint run morning_digest` blueprint) calls this at 08:00 Asia/Tehran;
 * the scheduler's owner delivery carries the text to the owner's chat.
 *
 * OWNER-ONLY (twice, like usage_report): the `ownerOnly` flag keeps the
 * authorization bridge from granting the permission key to anyone else, and
 * run() re-checks ownership against a server-supplied predicate, so a
 * hand-built actor cannot slip through either. The digest aggregates the
 * owner's private data — tasks, reminders, memories, usage — so a non-owner
 * must never see it.
 *
 * The tool never names a chat: delivery is the scheduler's job, whose
 * scheduled_task creation is owner-only and whose "agent" action receives a
 * server-supplied chatId (the sender's own chat). There is no path for the
 * digest to reach anyone but the owner.
 *
 * Degrades gracefully: the builder wraps every source so one failing source
 * is logged and skipped, never failing the digest.
 */
import { ProposalStore } from "../curator/proposals";
import { Storage } from "../storage/storage";
import type { SearchHeadlinesFn } from "../digest/builder";
import { buildDigest, formatDigest } from "../digest/builder";
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";

export const BUILD_DIGEST_PERMISSION = "tools:build_digest";

export interface DigestToolDeps {
  storage: Storage;
  proposalStore: ProposalStore;
  /** Server-supplied owner check. The userId comes from the trusted actor. */
  isOwner: (userId: string) => boolean;
  /** Optional web-search resolver for the headlines section. Omit to skip it. */
  searchHeadlines?: SearchHeadlinesFn;
  /** Injectable clock (unix ms), for deterministic tests. */
  now?: () => number;
  /** Diagnostic log for skipped/failed digest sources. */
  log?: (message: string) => void;
}

export interface DigestToolOutput {
  /** Formatted Persian digest, capped for a Telegram message. */
  text: string;
}

export function createDigestTool(deps: DigestToolDeps): Tool<Record<string, never>, DigestToolOutput> {
  return {
    name: "build_digest",
    description:
      "خلاصهٔ صبحگاهی فارسی: کارهای امروز، یادآورها، پیشنهادهای حافظه، مصرف دیروز، سرخط خبرها و نکته‌های حافظه (فقط مالک).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [BUILD_DIGEST_PERMISSION] },
    toolset: "system",
    input: { fields: {} },

    async run(_input: Record<string, never>, ctx: ToolContext): Promise<DigestToolOutput> {
      const userId = ctx.actor.userId;
      if (typeof userId !== "string" || userId.length === 0 || userId === "unknown") {
        throw new ToolError("not_allowed", "هویت مشخص نیست.");
      }
      if (!deps.isOwner(userId)) {
        throw new ToolError("not_allowed", "خلاصهٔ صبحگاهی فقط برای مالک است.");
      }

      const sections = await buildDigest({
        storage: deps.storage,
        proposalStore: deps.proposalStore,
        userId,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.searchHeadlines !== undefined ? { searchHeadlines: deps.searchHeadlines } : {}),
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      });
      return { text: formatDigest(sections) };
    },
  };
}
