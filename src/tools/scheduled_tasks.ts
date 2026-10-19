/**
 * Scheduled-task tools — schedule_task, list_tasks, cancel_task.
 *
 * These are OWNER-ONLY: creating a task hands the scheduler standing
 * permission to act later (send messages, run tools, run the agent) with the
 * creator's authority, so the decision to create one is administrative, not
 * conversational. Owner-only is enforced twice: the `ownerOnly` flag keeps
 * the bridge from granting the permission keys to anyone else, and run()
 * re-checks ownership against a server-supplied predicate, so a hand-built
 * actor cannot slip through either.
 *
 * Actions are structured data, never code. The scheduler dispatches on
 * `type` and never evals anything; see parseTaskAction.
 */
import { CronError, nextAfterSchedule, parseCron } from "../scheduler/cron";
import type { CronSchedule } from "../scheduler/cron";
import { ToolError } from "./errors";
import type { ScheduledTaskStatus, Storage } from "../storage/storage";
import type { Tool, ToolContext } from "./types";

export const SCHEDULE_TASK_PERMISSION = "tools:schedule_task";
export const LIST_TASKS_PERMISSION = "tools:list_tasks";
export const CANCEL_TASK_PERMISSION = "tools:cancel_task";

/** Ceilings, so one owner cannot fill the table or store unbounded blobs. */
const MAX_TASKS_PER_OWNER = 25;
const MAX_NAME_LENGTH = 80;
const MAX_ACTION_BYTES = 8 * 1024;
const MAX_MESSAGE_TEXT = 2000;
const MAX_AGENT_PROMPT = 4000;
const MAX_CHAT_ID_LENGTH = 64;

/** Tool names look like the registry's: lowercase snake_case. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** A scheduled task may not create scheduled tasks. See below. */
const FORBIDDEN_NESTED_TOOLS: ReadonlySet<string> = new Set(["schedule_task"]);

/**
 * What a scheduled task does when its time comes.
 *
 * - "tool": run a registered tool with the given input, as the creator.
 * - "message": send text to a chat through the bot.
 * - "agent": run the agent on a prompt and deliver the answer to a chat.
 */
export type TaskAction =
  | { type: "tool"; tool: string; input: Record<string, unknown> }
  | { type: "message"; chatId: string; text: string }
  | { type: "agent"; chatId: string; prompt: string };

export interface ScheduledTaskToolDeps {
  storage: Storage;
  /**
   * Server-supplied owner check. The userId comes from the trusted actor, so
   * this predicate — not anything in the request — decides ownership.
   */
  isOwner: (userId: string) => boolean;
  /** Default IANA timezone when the caller omits one. */
  defaultTimezone: string;
  /** True when a tool name is registered and runnable. */
  toolExists?: (name: string) => boolean;
  /** Injectable clock, ms. */
  now?: () => number;
}

/**
 * Validate an untrusted action value into a TaskAction.
 *
 * Throws ToolError("invalid_input") with an English message on any shape
 * violation. Called at creation time AND again by the scheduler before
 * execution, so a row written around this validator can never dispatch.
 */
export function parseTaskAction(raw: unknown): TaskAction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ToolError("invalid_input", "The action must be an object.");
  }
  const obj = raw as Record<string, unknown>;
  const type = obj["type"];

  if (type === "tool") {
    const tool: unknown = obj["tool"];
    if (typeof tool !== "string" || !TOOL_NAME_RE.test(tool)) {
      throw new ToolError("invalid_input", "Invalid tool name.");
    }
    if (FORBIDDEN_NESTED_TOOLS.has(tool)) {
      // A task that spawns tasks would grow without bound: every run adds a
      // row, each new row runs and adds another. The per-owner cap would stop
      // it eventually, but "eventually fills the table then fails forever" is
      // not a feature. Refuse it up front instead.
      throw new ToolError("invalid_input", "A scheduled task cannot create another task.");
    }
    const input: unknown = obj["input"] ?? {};
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new ToolError("invalid_input", "Tool input must be an object.");
    }
    return { type: "tool", tool, input: input as Record<string, unknown> };
  }

  if (type === "message") {
    const chatId: unknown = obj["chatId"];
    const text: unknown = obj["text"];
    if (typeof chatId !== "string" || chatId.length === 0 || chatId.length > MAX_CHAT_ID_LENGTH) {
      throw new ToolError("invalid_input", "Invalid chat id.");
    }
    if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_MESSAGE_TEXT) {
      throw new ToolError("invalid_input", "Message text must be 1 to 2000 characters.");
    }
    return { type: "message", chatId, text };
  }

  if (type === "agent") {
    const chatId: unknown = obj["chatId"];
    const prompt: unknown = obj["prompt"];
    if (typeof chatId !== "string" || chatId.length === 0 || chatId.length > MAX_CHAT_ID_LENGTH) {
      throw new ToolError("invalid_input", "Invalid chat id.");
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_AGENT_PROMPT) {
      throw new ToolError("invalid_input", "Agent prompt must be 1 to 4000 characters.");
    }
    return { type: "agent", chatId, prompt };
  }

  throw new ToolError("invalid_input", "Invalid action type; one of tool, message or agent.");
}

/** Serialize a validated action for storage, enforcing the size cap. */
export function serializeTaskAction(action: TaskAction): string {
  const json = JSON.stringify(action);
  if (new TextEncoder().encode(json).length > MAX_ACTION_BYTES) {
    throw new ToolError("invalid_input", "The action is too large.");
  }
  return json;
}

// ---------- schedule_task ----------

export interface ScheduleTaskInput {
  name: string;
  /** Cron expression or shorthand (@hourly, @daily, @weekly, @monthly). */
  cron: string;
  /** IANA timezone; defaults to the bot's configured zone. */
  timezone?: string;
  /** Structured action: {type:"tool"|"message"|"agent", ...}. */
  action: Record<string, unknown>;
  enabled?: boolean;
}

export interface ScheduleTaskOutput {
  id: number;
  name: string;
  /** Normalized 5-field expression (shorthands expanded). */
  cron: string;
  timezone: string;
  nextRunAt: string;
  enabled: boolean;
}

export function createScheduleTaskTool(deps: ScheduledTaskToolDeps): Tool<ScheduleTaskInput, ScheduleTaskOutput> {
  return {
    name: "schedule_task",
    description:
      "Create a scheduled task with a cron expression (owner only). The action can run a tool, send a message, or run an agent.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [SCHEDULE_TASK_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        name: {
          type: "string",
          required: true,
          description: "Short task name.",
          minLength: 1,
          maxLength: MAX_NAME_LENGTH,
        },
        cron: {
          type: "string",
          required: true,
          description: "Cron expression (5 fields) or @hourly/@daily/@weekly/@monthly.",
          minLength: 1,
          maxLength: 120,
        },
        timezone: {
          type: "string",
          description: "IANA timezone; defaults to the bot's timezone.",
          minLength: 1,
          maxLength: 64,
        },
        action: {
          type: "object",
          required: true,
          description:
            "Structured action: {type:\"tool\", tool, input} or {type:\"message\", chatId, text} or {type:\"agent\", chatId, prompt}.",
        },
        enabled: {
          type: "boolean",
          description: "Enabled by default; false means do not run yet.",
        },
      },
    },

    async run(input: ScheduleTaskInput, ctx: ToolContext): Promise<ScheduleTaskOutput> {
      const userId = ownerOf(ctx, deps);

      const name = input.name.trim();
      if (name.length === 0) {
        throw new ToolError("invalid_input", "Task name is empty.");
      }

      let schedule: CronSchedule;
      try {
        schedule = parseCron(input.cron);
      } catch (err) {
        throw new ToolError(
          "invalid_input",
          err instanceof CronError ? `Invalid cron expression: ${err.message}` : "Invalid cron expression.",
        );
      }

      const timezone = input.timezone === undefined ? deps.defaultTimezone : input.timezone.trim();
      assertTimezoneOrThrow(timezone);

      const action = parseTaskAction(input.action);
      const actionJson = serializeTaskAction(action);

      if (deps.toolExists !== undefined && action.type === "tool" && !deps.toolExists(action.tool)) {
        throw new ToolError("invalid_input", `No tool named "${action.tool}" exists.`);
      }

      if (deps.storage.countTasks(userId) >= MAX_TASKS_PER_OWNER) {
        throw new ToolError(
          "invalid_input",
          "Too many scheduled tasks; delete some first.",
        );
      }

      const now = deps.now?.() ?? Date.now();
      let nextRunAtMs: number;
      try {
        nextRunAtMs = nextAfterSchedule(schedule, now, timezone);
      } catch (err) {
        throw new ToolError(
          "invalid_input",
          err instanceof CronError ? `Impossible schedule: ${err.message}` : "Impossible schedule.",
        );
      }

      const id = deps.storage.createTask({
        name,
        cronExpr: schedule.source,
        timezone,
        actionJson,
        createdByUserId: userId,
        nextRunAtMs,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });

      return {
        id,
        name,
        cron: schedule.source,
        timezone,
        nextRunAt: new Date(nextRunAtMs).toISOString(),
        enabled: input.enabled ?? true,
      };
    },
  };
}

// ---------- list_tasks ----------

export interface ListTasksOutput {
  tasks: Array<{
    id: number;
    name: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    nextRunAt: string;
    lastStatus?: ScheduledTaskStatus;
    runCount: number;
  }>;
  count: number;
}

export function createListTasksTool(deps: ScheduledTaskToolDeps): Tool<Record<string, never>, ListTasksOutput> {
  return {
    name: "list_tasks",
    description: "List scheduled tasks (owner only).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [LIST_TASKS_PERMISSION] },
    toolset: "schedule",
    input: { fields: {} },

    async run(_input: Record<string, never>, ctx: ToolContext): Promise<ListTasksOutput> {
      const userId = ownerOf(ctx, deps);
      const rows = deps.storage.listTasks(userId, MAX_TASKS_PER_OWNER);
      return {
        tasks: rows.map((r) => ({
          id: r.id,
          name: r.name,
          cron: r.cronExpr,
          timezone: r.timezone,
          enabled: r.enabled,
          nextRunAt: new Date(r.nextRunAtMs).toISOString(),
          ...(r.lastStatus !== undefined ? { lastStatus: r.lastStatus } : {}),
          runCount: r.runCount,
        })),
        count: rows.length,
      };
    },
  };
}

// ---------- cancel_task ----------

export interface CancelTaskInput {
  id: number;
}

export interface CancelTaskOutput {
  id: number;
  /** False when there was no such task for this owner. */
  cancelled: boolean;
  remaining: number;
}

export function createCancelTaskTool(deps: ScheduledTaskToolDeps): Tool<CancelTaskInput, CancelTaskOutput> {
  return {
    name: "cancel_task",
    description: "Delete a scheduled task by its id (owner only).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [CANCEL_TASK_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "Task id, from the task list.",
          minimum: 1,
        },
      },
    },

    async run(input: CancelTaskInput, ctx: ToolContext): Promise<CancelTaskOutput> {
      const userId = ownerOf(ctx, deps);
      // Scoped to the creator by the storage layer.
      const cancelled = deps.storage.deleteTask(userId, input.id);
      return {
        id: input.id,
        cancelled,
        remaining: deps.storage.countTasks(userId),
      };
    },
  };
}

/** Build all three scheduled-task tools. */
export function createScheduledTaskTools(
  deps: ScheduledTaskToolDeps,
): readonly Tool<unknown, unknown>[] {
  return [
    createScheduleTaskTool(deps),
    createListTasksTool(deps),
    createCancelTaskTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}

// ---------- helpers ----------

/**
 * The owner id for this call, taken from the server-supplied actor — and then
 * checked against the server-supplied owner predicate.
 *
 * The Executor already required the permission key, but the key alone does not
 * prove ownership (the bridge withholds it from non-owners, yet a caller that
 * builds actors directly could hold it anyway). This second check is what
 * makes the tools owner-only rather than merely key-gated.
 */
function ownerOf(ctx: ToolContext, deps: ScheduledTaskToolDeps): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "Scheduled task management is owner only.");
  }
  return id;
}

/**
 * Exported for tests: the empty check must come before the Intl check (an
 * empty zone fails Intl first, which would make the empty-case branch
 * unreachable and untestable).
 */
export function assertTimezoneOrThrow(tz: string): void {
  if (tz.length === 0) {
    throw new ToolError("invalid_input", "Timezone is empty.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new ToolError("invalid_input", `Invalid timezone: ${tz}`);
  }
}

