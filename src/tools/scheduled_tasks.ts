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
import type { ScheduledTaskRecord, ScheduledTaskStatus, Storage } from "../storage/storage";
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
 * Throws ToolError("invalid_input") with a Persian message on any shape
 * violation. Called at creation time AND again by the scheduler before
 * execution, so a row written around this validator can never dispatch.
 */
export function parseTaskAction(raw: unknown): TaskAction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ToolError("invalid_input", "اکشن باید یک آبجکت باشد.");
  }
  const obj = raw as Record<string, unknown>;
  const type = obj["type"];

  if (type === "tool") {
    const tool: unknown = obj["tool"];
    if (typeof tool !== "string" || !TOOL_NAME_RE.test(tool)) {
      throw new ToolError("invalid_input", "نام ابزار نامعتبر است.");
    }
    if (FORBIDDEN_NESTED_TOOLS.has(tool)) {
      // A task that spawns tasks would grow without bound: every run adds a
      // row, each new row runs and adds another. The per-owner cap would stop
      // it eventually, but "eventually fills the table then fails forever" is
      // not a feature. Refuse it up front instead.
      throw new ToolError("invalid_input", "یک وظیفهٔ زمان‌بندی‌شده نمی‌تواند وظیفهٔ دیگری بسازد.");
    }
    const input: unknown = obj["input"] ?? {};
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new ToolError("invalid_input", "ورودی ابزار باید یک آبجکت باشد.");
    }
    return { type: "tool", tool, input: input as Record<string, unknown> };
  }

  if (type === "message") {
    const chatId: unknown = obj["chatId"];
    const text: unknown = obj["text"];
    if (typeof chatId !== "string" || chatId.length === 0 || chatId.length > MAX_CHAT_ID_LENGTH) {
      throw new ToolError("invalid_input", "شناسهٔ چت نامعتبر است.");
    }
    if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_MESSAGE_TEXT) {
      throw new ToolError("invalid_input", "متن پیام باید بین ۱ تا ۲۰۰۰ کاراکتر باشد.");
    }
    return { type: "message", chatId, text };
  }

  if (type === "agent") {
    const chatId: unknown = obj["chatId"];
    const prompt: unknown = obj["prompt"];
    if (typeof chatId !== "string" || chatId.length === 0 || chatId.length > MAX_CHAT_ID_LENGTH) {
      throw new ToolError("invalid_input", "شناسهٔ چت نامعتبر است.");
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_AGENT_PROMPT) {
      throw new ToolError("invalid_input", "پرامپت ایجنت باید بین ۱ تا ۴۰۰۰ کاراکتر باشد.");
    }
    return { type: "agent", chatId, prompt };
  }

  throw new ToolError("invalid_input", "نوع اکشن نامعتبر است؛ یکی از tool، message یا agent.");
}

/** Serialize a validated action for storage, enforcing the size cap. */
export function serializeTaskAction(action: TaskAction): string {
  const json = JSON.stringify(action);
  if (new TextEncoder().encode(json).length > MAX_ACTION_BYTES) {
    throw new ToolError("invalid_input", "اکشن بیش از حد بزرگ است.");
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
      "یک وظیفهٔ زمان‌بندی‌شده با عبارت کرون بساز (فقط مالک). اکشن می‌تواند اجرای ابزار، ارسال پیام یا اجرای ایجنت باشد.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [SCHEDULE_TASK_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        name: {
          type: "string",
          required: true,
          description: "نام کوتاه وظیفه.",
          minLength: 1,
          maxLength: MAX_NAME_LENGTH,
        },
        cron: {
          type: "string",
          required: true,
          description: "عبارت کرون (۵ فیلد) یا @hourly/@daily/@weekly/@monthly.",
          minLength: 1,
          maxLength: 120,
        },
        timezone: {
          type: "string",
          description: "منطقهٔ زمانی IANA؛ پیش‌فرض منطقهٔ زمانی ربات.",
          minLength: 1,
          maxLength: 64,
        },
        action: {
          type: "object",
          required: true,
          description:
            "اکشن ساخت‌یافته: {type:\"tool\", tool, input} یا {type:\"message\", chatId, text} یا {type:\"agent\", chatId, prompt}.",
        },
        enabled: {
          type: "boolean",
          description: "پیش‌فرض فعال است؛ false یعنی فعلاً اجرا نشود.",
        },
      },
    },

    async run(input: ScheduleTaskInput, ctx: ToolContext): Promise<ScheduleTaskOutput> {
      const userId = ownerOf(ctx, deps);

      const name = input.name.trim();
      if (name.length === 0) {
        throw new ToolError("invalid_input", "نام وظیفه خالی است.");
      }

      let schedule: CronSchedule;
      try {
        schedule = parseCron(input.cron);
      } catch (err) {
        throw new ToolError(
          "invalid_input",
          err instanceof CronError ? `عبارت کرون نامعتبر است: ${err.message}` : "عبارت کرون نامعتبر است.",
        );
      }

      const timezone = input.timezone === undefined ? deps.defaultTimezone : input.timezone.trim();
      assertTimezoneOrThrow(timezone);

      const action = parseTaskAction(input.action);
      const actionJson = serializeTaskAction(action);

      if (deps.toolExists !== undefined && action.type === "tool" && !deps.toolExists(action.tool)) {
        throw new ToolError("invalid_input", `ابزاری با نام «${action.tool}» وجود ندارد.`);
      }

      if (deps.storage.countTasks(userId) >= MAX_TASKS_PER_OWNER) {
        throw new ToolError(
          "invalid_input",
          "تعداد وظایف زمان‌بندی‌شده پر است؛ ابتدا چند مورد را حذف کن.",
        );
      }

      const now = deps.now?.() ?? Date.now();
      let nextRunAtMs: number;
      try {
        nextRunAtMs = nextAfterSchedule(schedule, now, timezone);
      } catch (err) {
        throw new ToolError(
          "invalid_input",
          err instanceof CronError ? `زمان‌بندی ناممکن است: ${err.message}` : "زمان‌بندی ناممکن است.",
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
    description: "وظایف زمان‌بندی‌شده را فهرست کن (فقط مالک).",
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
    description: "یک وظیفهٔ زمان‌بندی‌شده را با شناسه‌اش حذف کن (فقط مالک).",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [CANCEL_TASK_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "شناسهٔ وظیفه، از فهرست وظایف.",
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
    throw new ToolError("not_allowed", "هویت مشخص نیست.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "مدیریت وظایف زمان‌بندی‌شده فقط برای مالک است.");
  }
  return id;
}

function assertTimezoneOrThrow(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new ToolError("invalid_input", `منطقهٔ زمانی نامعتبر است: ${tz}`);
  }
  if (tz.length === 0) {
    throw new ToolError("invalid_input", "منطقهٔ زمانی خالی است.");
  }
}

/** Format a stored task for a model-facing summary. */
export function describeTask(r: ScheduledTaskRecord): string {
  const state = r.enabled ? "فعال" : "غیرفعال";
  return `#${r.id} — ${r.name} (${r.cronExpr}، ${r.timezone}، ${state}، اجرای بعدی: ${new Date(r.nextRunAtMs).toISOString()})`;
}
