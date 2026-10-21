/**
 * DigestSchedulingService — ALL digest scheduling in one place (platform
 * Phase 10: digests behind the one scheduling facade).
 *
 * Owns the storage-level scheduling of both digests:
 * - the owner's morning digest (the scheduled task named
 *   "blueprint: morning_digest", owned by /blueprint — this service edits
 *   its schedule and its agent action's prompt/destination, never its
 *   ownership), and
 * - per-group digests (assistant config + the group's scheduled
 *   group_digest task, ensured/cancelled through the group_digest row
 *   helpers).
 *
 * The platform's SchedulingFacade exposes this service as
 * `platform.scheduling.digests`; the Mini App management API calls it for
 * its digest.config / groupdigests.* actions. Audit entries are written
 * through the caller-supplied callback so each surface keeps its own
 * audit vocabulary — the service itself is surface-agnostic.
 *
 * The set operations return `Response` for the same reason the Mini App
 * handlers did: they are validated multi-step workflows with several
 * distinct client-visible failures. Bodies use the Mini App envelope
 * ({ ok: true, ... } / { ok: false, error }) — the only surface that
 * consumes them today.
 */
import type { Storage, ScheduledTaskRecord } from "../storage/storage";
import {
  nextSlotAfterNow,
  parseCron,
  validateCustomCron,
} from "../scheduler/cron";
import { parseTaskAction, serializeTaskAction } from "../tools/scheduled_tasks";
import {
  assistantConfigKey,
  getAssistantConfig,
  setAssistantConfig,
} from "../groups/assistant";
import {
  GROUP_DIGEST_TOOL_NAME,
  cancelGroupDigestTask,
  digestTaskName,
  ensureGroupDigestTask,
  validateDigestTime,
  type DigestTaskCalls,
} from "../groups/group_digest";

/** The fixed scheduled-task name of the owner's morning digest. */
export const DIGEST_TASK_NAME = "blueprint: morning_digest";
/** /blueprint's default morning prompt (the digest config view mirrors it). */
export const DIGEST_PROMPT =
  "Morning briefing: briefly summarize today's most important tasks, upcoming reminders, and active goals.";
/** Chat/group id shape shared by the digest endpoints. */
export const CHAT_ID_RE = /^-?\d{1,20}$/;

const MIN_DIGEST_CRON_GAP_MS = 15 * 60 * 1000;
const DIGEST_TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const GROUP_CFG_PREFIX = assistantConfigKey("");

/** Audit sink: the caller binds its surface's operation name into it. */
export type DigestAudit = (
  outcome: "success" | "denied" | "error",
  detail: string,
) => void;

// ---------------------------------------------------------- http bits ------

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const ok = (body: Record<string, unknown> = {}): Response =>
  json(200, { ok: true, ...body });

const fail = (status: number, error: string): Response =>
  json(status, { ok: false, error });

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

// ------------------------------------------------------------- helpers -----

/** "HH:MM" of a daily `m h * * *` cron, or null for any other shape. */
export function digestTimeOf(cron: string): string | null {
  const m = /^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/u.exec(cron);
  if (m === null) return null;
  return `${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
}

/** The digest task's agent action ({chatId, prompt}), or null when it isn't one. */
export function readDigestAgentAction(
  task: ScheduledTaskRecord,
): { chatId: string; prompt: string } | null {
  try {
    const a = JSON.parse(task.actionJson) as Record<string, unknown>;
    if (
      a !== null &&
      typeof a === "object" &&
      a["type"] === "agent" &&
      typeof a["chatId"] === "string" &&
      typeof a["prompt"] === "string"
    ) {
      return { chatId: a["chatId"], prompt: a["prompt"] };
    }
  } catch {
    // not JSON or wrong shape
  }
  return null;
}

// ------------------------------------------------------------- service -----

export class DigestSchedulingService {
  constructor(private readonly storage: Storage) {}

  private findTask(ownerId: string, name: string): ScheduledTaskRecord | undefined {
    return this.storage.scheduling.listTasks(ownerId, 200).find((t) => t.name === name);
  }

  /** The owner's morning-digest task row, when it exists. */
  morningTask(ownerId: string): ScheduledTaskRecord | undefined {
    return this.findTask(ownerId, DIGEST_TASK_NAME);
  }

  /**
   * digest.config — with no editable field in `body` this is the GET view;
   * with prompt/chatId/enabled/time/cron present it applies the edit.
   * Mirrors the Mini App's historical handler exactly (the row is owned
   * by /blueprint; only its content is edited here).
   */
  morningConfig(
    ownerId: string,
    body: Record<string, unknown>,
    audit: DigestAudit,
  ): Response {
    const hasPrompt = body["prompt"] !== undefined;
    const hasChatId = body["chatId"] !== undefined;
    const hasEnabled = body["enabled"] !== undefined;
    const hasTime = body["time"] !== undefined || body["cron"] !== undefined;
    if (!hasPrompt && !hasChatId && !hasEnabled && !hasTime) {
      return ok(this.morningView(ownerId));
    }
    return this.setMorning(ownerId, body, { hasPrompt, hasChatId, hasEnabled, hasTime }, audit);
  }

  /**
   * The morning digest's config view: ownership surfaced, content shown.
   * GET shape of digest.config.
   */
  morningView(ownerId: string): Record<string, unknown> {
    const task = this.morningTask(ownerId);
    if (task === undefined) {
      return { exists: false, enabled: false, blueprint: "morning_digest", ownedBy: "blueprint" };
    }
    const action = readDigestAgentAction(task);
    const time = digestTimeOf(task.cronExpr);
    const out: Record<string, unknown> = {
      exists: true,
      enabled: task.enabled,
      blueprint: "morning_digest",
      ownedBy: "blueprint",
      cron: task.cronExpr,
      time,
      custom: time === null,
      timezone: task.timezone,
      nextRunAtMs: task.nextRunAtMs,
      actionIsAgent: action !== null,
      prompt: action?.prompt ?? null,
      defaultPrompt: DIGEST_PROMPT,
      isCustomPrompt: action !== null && action.prompt !== DIGEST_PROMPT,
      chatId: action?.chatId ?? null,
      defaultChatId: ownerId,
      isDefaultDestination: action !== null && action.chatId === ownerId,
    };
    if (task.lastRunAtMs !== undefined) out["lastRunAtMs"] = task.lastRunAtMs;
    if (task.lastStatus !== undefined) out["lastStatus"] = task.lastStatus;
    return out;
  }

  private setMorning(
    ownerId: string,
    body: Record<string, unknown>,
    which: { hasPrompt: boolean; hasChatId: boolean; hasEnabled: boolean; hasTime: boolean },
    audit: DigestAudit,
  ): Response {
    const storage = this.storage;
    const task = this.morningTask(ownerId);
    if (task === undefined) {
      audit("denied", "no digest task");
      return fail(400, "No scheduled morning digest.");
    }
    const out: Record<string, unknown> = { id: task.id };

    if (which.hasEnabled || which.hasTime) {
      const r = this.setMorningSchedule(ownerId, task, body, audit);
      if (r instanceof Response) return r;
      Object.assign(out, r);
    }

    if (which.hasPrompt || which.hasChatId) {
      const action = readDigestAgentAction(task);
      if (action === null) {
        audit("denied", "non-agent action");
        return fail(400, "This task has no agent action; check via Telegram.");
      }
      let prompt = action.prompt;
      let chatId = action.chatId;
      if (which.hasPrompt) {
        const p = body["prompt"];
        if (typeof p !== "string" || p.trim().length === 0 || p.length > 4000) {
          audit("denied", "bad prompt");
          return fail(400, "Prompt must be 1–4000 characters.");
        }
        prompt = p;
      }
      if (which.hasChatId) {
        const c = body["chatId"];
        if (typeof c !== "string" || !CHAT_ID_RE.test(c.trim())) {
          audit("denied", "bad chatId");
          return fail(400, "Invalid chat id.");
        }
        chatId = c.trim();
      }
      let actionJson: string;
      try {
        actionJson = serializeTaskAction(parseTaskAction({ type: "agent", chatId, prompt }));
      } catch {
        audit("denied", "action validation failed");
        return fail(400, "Invalid input.");
      }
      if (!storage.scheduling.updateTask(ownerId, task.id, { actionJson })) {
        audit("error", `update failed id=${task.id}`);
        return fail(500, "An internal error occurred.");
      }
      audit("success", `content updated id=${task.id}`);
      out["prompt"] = prompt;
      out["chatId"] = chatId;
      out["isCustomPrompt"] = prompt !== DIGEST_PROMPT;
      out["isDefaultDestination"] = chatId === ownerId;
    }

    return ok(out);
  }

  /** Morning digest on/off/time: the digest scheduler semantics. */
  private setMorningSchedule(
    ownerId: string,
    task: ScheduledTaskRecord,
    body: Record<string, unknown>,
    audit: DigestAudit,
  ): Record<string, unknown> | Response {
    const storage = this.storage;
    const enabled = asBool(body["enabled"]);
    if (enabled === false) {
      if (task.enabled) storage.scheduling.updateTask(ownerId, task.id, { enabled: false });
      audit("success", `disabled id=${task.id}`);
      return { enabled: false };
    }

    const customCronRaw = body["cron"];
    const hasCustomCron = typeof customCronRaw === "string" && customCronRaw.trim() !== "";
    let cron: string;
    let custom = false;
    if (hasCustomCron) {
      const v = validateCustomCron(customCronRaw, MIN_DIGEST_CRON_GAP_MS);
      if (!v.ok) {
        audit("denied", `bad cron (${v.reason})`);
        return fail(
          400,
          v.reason === "too_frequent"
            ? "Schedule too frequent; digest at most every 15 minutes."
            : "Invalid cron expression.",
        );
      }
      cron = v.source;
      custom = true;
    } else {
      const timeRaw = body["time"];
      const timeValid =
        typeof timeRaw === "string" && DIGEST_TIME_RE.test(timeRaw) ? timeRaw : undefined;
      if (timeRaw !== undefined && timeValid === undefined) {
        audit("denied", "bad time");
        return fail(400, "Invalid time (HH:MM format).");
      }
      cron =
        timeValid === undefined
          ? task.cronExpr
          : `${Number(timeValid.slice(3, 5))} ${Number(timeValid.slice(0, 2))} * * *`;
    }

    let source: string;
    let slot: number;
    try {
      source = parseCron(cron).source;
      slot = nextSlotAfterNow(cron);
    } catch {
      audit("denied", "bad cron");
      return fail(400, "Invalid cron expression.");
    }
    if (!storage.scheduling.updateTask(ownerId, task.id, { cronExpr: source, enabled: true, nextRunAtMs: slot })) {
      audit("error", `update failed id=${task.id}`);
      return fail(500, "An internal error occurred.");
    }
    const timeOut = digestTimeOf(source);
    audit("success", `updated id=${task.id} cron=${source}`);
    return { enabled: true, time: timeOut, ...(custom ? { custom: true, cron: source } : {}) };
  }

  // ------------------------------------------------------ group digests --

  /** Storage-backed DigestTaskCalls for the group-digest row helpers. */
  taskCalls(ownerId: string): DigestTaskCalls {
    const storage = this.storage;
    return {
      list: async () =>
        storage.scheduling.listTasks(ownerId, 200).map((t) => ({ id: t.id, name: t.name })),
      create: async (args) => {
        if (storage.scheduling.countTasks(ownerId) >= 200) {
          throw new Error("per-owner task cap reached");
        }
        return storage.scheduling.createTask({
          name: args.name,
          cronExpr: args.cron,
          timezone: args.timezone,
          actionJson: JSON.stringify({
            type: "tool",
            tool: GROUP_DIGEST_TOOL_NAME,
            input: { chatId: args.chatId },
          }),
          createdByUserId: ownerId,
          nextRunAtMs: nextSlotAfterNow(args.cron),
          enabled: true,
        });
      },
      cancel: async (id) => {
        storage.scheduling.deleteTask(ownerId, id);
      },
    };
  }

  /** One group's digest view: assistant config + its scheduled task state. */
  groupView(ownerId: string, chatId: string): Record<string, unknown> {
    const storage = this.storage;
    const cfg = getAssistantConfig(storage.misc, ownerId, chatId);
    const tasks = storage.scheduling.listTasks(ownerId, 200);
    const task = tasks.find((t) => t.name === digestTaskName(chatId));
    const taskOut: Record<string, unknown> = { exists: task !== undefined, enabled: false };
    if (task !== undefined) {
      taskOut["enabled"] = task.enabled;
      taskOut["cron"] = task.cronExpr;
      taskOut["nextRunAtMs"] = task.nextRunAtMs;
      if (task.lastRunAtMs !== undefined) taskOut["lastRunAtMs"] = task.lastRunAtMs;
      if (task.lastStatus !== undefined) taskOut["lastStatus"] = task.lastStatus;
    }
    return {
      chatId,
      assistantEnabled: cfg.enabled,
      digestEnabled: cfg.digestEnabled,
      digestTime: cfg.digestTime,
      task: taskOut,
    };
  }

  /** Every group with an assistant config, with its digest view. */
  listGroups(ownerId: string): Array<Record<string, unknown>> {
    const groups: Array<Record<string, unknown>> = [];
    for (const key of this.storage.misc.listUserPrefKeys(ownerId, GROUP_CFG_PREFIX)) {
      const chatId = key.slice(GROUP_CFG_PREFIX.length);
      if (!CHAT_ID_RE.test(chatId)) continue;
      groups.push(this.groupView(ownerId, chatId));
    }
    return groups;
  }

  /** groupdigests.set — on/off/time for one group's digest. */
  async setGroup(
    ownerId: string,
    body: Record<string, unknown>,
    audit: DigestAudit,
  ): Promise<Response> {
    const storage = this.storage;
    const chatRaw = body["chatId"];
    if (typeof chatRaw !== "string" || !CHAT_ID_RE.test(chatRaw.trim())) {
      audit("denied", "bad chatId");
      return fail(400, "Invalid group id.");
    }
    const chatId = chatRaw.trim();
    const enabled = asBool(body["digestEnabled"]);
    if (enabled === undefined) {
      audit("denied", "bad digestEnabled");
      return fail(400, "Invalid input.");
    }
    const timeRaw = body["time"];
    const time = timeRaw === undefined ? undefined : validateDigestTime(timeRaw);
    if (time !== undefined && !time.ok) {
      audit("denied", "bad time");
      return fail(400, "Invalid time (HH:MM format).");
    }
    const cfg = getAssistantConfig(storage.misc, ownerId, chatId);
    const calls = this.taskCalls(ownerId);

    if (!enabled) {
      const res = setAssistantConfig(storage.misc, ownerId, chatId, { digestEnabled: false });
      if (!res.ok) {
        audit("error", `off config failed chat=${chatId}`);
        return fail(400, "Invalid input.");
      }
      await cancelGroupDigestTask(calls, chatId);
      audit("success", `off chat=${chatId}`);
      return ok({ chatId, digestEnabled: false });
    }

    if (!cfg.enabled) {
      audit("denied", `on without mode chat=${chatId}`);
      return fail(400, "Enable group assistant mode first.");
    }
    let finalTime = cfg.digestTime;
    if (time !== undefined) {
      const res = setAssistantConfig(storage.misc, ownerId, chatId, { digestTime: time.time });
      if (!res.ok) {
        audit("error", `time config failed chat=${chatId}`);
        return fail(400, "Invalid input.");
      }
      finalTime = res.config.digestTime;
    }
    // Create the task BEFORE flipping the config: a failed schedule must not
    // leave the config claiming a digest that will never fire.
    let id: number | undefined;
    try {
      id = await ensureGroupDigestTask(calls, chatId, finalTime);
    } catch {
      id = undefined;
    }
    if (id === undefined) {
      audit("error", `schedule failed chat=${chatId}`);
      return fail(500, "Failed to create the schedule.");
    }
    if (!cfg.digestEnabled) {
      const res = setAssistantConfig(storage.misc, ownerId, chatId, { digestEnabled: true });
      if (!res.ok) {
        await cancelGroupDigestTask(calls, chatId);
        audit("error", `on config failed chat=${chatId}`);
        return fail(500, "An internal error occurred.");
      }
    }
    audit("success", `on chat=${chatId} time=${finalTime} id=${id}`);
    return ok({ chatId, digestEnabled: true, time: finalTime, taskId: id });
  }
}
