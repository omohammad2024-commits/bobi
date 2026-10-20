/**
 * Which tool calls may run concurrently, and the bounded mapper that runs them.
 *
 * The loop cannot see a tool's true dependency graph — a ToolSpec carries only
 * a name, a description, and a JSON schema. So independence is decided by a
 * conservative heuristic instead:
 *
 *  - A tool is WRITE-LIKE when its name contains a mutating verb token
 *    (add, delete, remember, remind, schedule, …) or its description uses one
 *    (saves, creates, sends, …). Write-like calls are NEVER parallelised:
 *    they run alone, in order, behind a barrier, because they can change
 *    state that a neighbouring call reads.
 *  - Everything else is treated as read-only and may overlap.
 *
 * A false positive (a read tool misread as write-like) only costs some
 * parallelism; a false negative would need BOTH checks to miss, and the
 * Executor still bounds total concurrency underneath us.
 */
import type { ToolSpec } from "../ai/provider";

/** Mutating verb tokens recognised in tool names (split on "_"). */
const WRITE_NAME_TOKENS: ReadonlySet<string> = new Set([
  "add", "ack", "ban", "cancel", "complete", "create", "delete", "download",
  "export", "forget", "generate", "import", "mute", "note", "pin", "post",
  "remember", "remind", "remove", "reply", "save", "schedule", "send",
  "set", "snooze", "store", "update", "upload", "write",
]);

/** Mutating verbs recognised in tool descriptions. */
const WRITE_DESCRIPTION_RE =
  /\b(saves?|creates?|deletes?|updates?|sends?|writes?|stores?|schedules?|removes?|adds?|cancels?|generates?|downloads?|remembers?|forgets?|uploads?|posts?|mutes?|bans?|pins?|sets?|completes?)\b/i;

/** True when a tool looks like it mutates state and must run sequentially. */
export function isWriteLikeTool(spec: Pick<ToolSpec, "name" | "description">): boolean {
  for (const token of spec.name.split("_")) {
    if (WRITE_NAME_TOKENS.has(token)) return true;
  }
  return WRITE_DESCRIPTION_RE.test(spec.description);
}

/**
 * Map with a concurrency bound, allSettled-style: every item is attempted,
 * results land at their original index, and one rejection never cancels the
 * rest. A small worker pool pulls indices in order, so at most `limit`
 * invocations of `fn` are in flight at once.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  if (items.length === 0) return results;
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!, index) };
      } catch (err) {
        results[index] = { status: "rejected", reason: err };
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, () => runWorker()));
  return results;
}
