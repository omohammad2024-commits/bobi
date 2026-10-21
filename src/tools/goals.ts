/**
 * Goal tools — add_goal, list_goals, complete_goal.
 *
 * Goals are persistent intents the heartbeat works toward on its own. They
 * are strictly the OWNER's: the owner sets them conversationally, and the
 * heartbeat reads them back.
 *
 * Owner-only is enforced twice, like the scheduled-task tools: the
 * `ownerOnly` flag keeps the authorization bridge from granting the
 * permission keys to anyone else, and run() checks the server-supplied owner
 * predicate — defence in depth for callers that build actors directly.
 */
import { ToolError } from "./errors";
import type { Storage, GoalStatus } from "../storage/storage";
import type { Tool, ToolContext } from "./types";
import { defineManifest } from "./manifest";
import type { ToolManifest } from "./manifest";

export const ADD_GOAL_PERMISSION = "tools:add_goal";
export const LIST_GOALS_PERMISSION = "tools:list_goals";
export const COMPLETE_GOAL_PERMISSION = "tools:complete_goal";

/** Ceilings, so one actor cannot fill the table or store unbounded text. */
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_GOALS_PER_OWNER = 100;
const MAX_LIST = 50;

const GOAL_STATUSES: readonly GoalStatus[] = ["active", "done"];

export interface GoalToolDeps {
  storage: Storage;
  isOwner: (userId: string) => boolean;
}

// ---------- add_goal ----------

export interface AddGoalInput {
  title: string;
  description?: string;
}

export interface AddGoalOutput {
  id: number;
  title: string;
  status: GoalStatus;
}

/** Plugin discovery manifest for `add_goal`. */
export const addGoalManifest: ToolManifest = defineManifest({
  id: "add_goal",
  version: "1.0.0",
  title: "Add Goal",
  description: "Add a new goal for the owner. Goals are tracked by the automatic heartbeat. Owner only.",
  purpose: "new owner goal",
  useWhen: "owner sets goal",
  doNotUseWhen: "Timed reminder or one-off task — remind_at or schedule_task fit those; goals are ongoing intents the heartbeat tracks.",
  confusableWith: [
    { tool: "schedule_task", difference: "schedule_task runs actions at set times; add_goal records an ongoing intent for the heartbeat." },
    { tool: "remember", difference: "remember stores a fact in memory; add_goal creates a tracked goal the heartbeat works toward." },
  ],
  latencyTier: "instant",
  outputSummary: "Returns the goal id, title and status.",
  category: "schedule",
  triggers: { keywordPatterns: ["هدف (جدید )?(بذار|بساز|اضافه کن)", "add (a )?goal", "set (a )?goal"] },
  costTier: "free",
});

export function createAddGoalTool(deps: GoalToolDeps): Tool<AddGoalInput, AddGoalOutput> {
  return {
    name: "add_goal",
    manifest: addGoalManifest,
    description:
      "Add a new goal for the owner. Goals are tracked by the automatic heartbeat. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [ADD_GOAL_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        title: {
          type: "string",
          required: true,
          description: "Short goal title, max 120 characters.",
          minLength: 1,
          maxLength: MAX_TITLE_LENGTH,
        },
        description: {
          type: "string",
          description: "Extra goal details, max 2000 characters.",
          maxLength: MAX_DESCRIPTION_LENGTH,
        },
      },
    },

    async run(input: AddGoalInput, ctx: ToolContext): Promise<AddGoalOutput> {
      const userId = ownerOf(ctx, deps);

      const title = input.title.trim();
      if (title.length === 0) {
        throw new ToolError("invalid_input", "Goal title is empty.");
      }

      if (deps.storage.scheduling.countGoals(userId) >= MAX_GOALS_PER_OWNER) {
        throw new ToolError(
          "invalid_input",
          "Too many goals; complete some first.",
        );
      }

      const id = deps.storage.scheduling.createGoal({
        title,
        // An absent description is the empty string, so the model always gets
        // a defined field rather than a missing one.
        description: input.description?.trim() ?? "",
        createdBy: userId,
      });

      return { id, title, status: "active" };
    },
  };
}

// ---------- list_goals ----------

export interface ListGoalsInput {
  status?: string;
}

export interface ListGoalsOutput {
  goals: Array<{
    id: number;
    title: string;
    description: string;
    status: GoalStatus;
    /** ISO-8601, only present for done goals. */
    doneAt?: string;
  }>;
  count: number;
}

/** Plugin discovery manifest for `list_goals`. */
export const listGoalsManifest: ToolManifest = defineManifest({
  id: "list_goals",
  version: "1.0.0",
  title: "List Goals",
  description: "List the owner's goals; optionally only active or only done. Owner only.",
  purpose: "goals by status",
  useWhen: "goals asked",
  doNotUseWhen: "Creating or finishing a goal — add_goal creates and complete_goal closes; this only lists existing goals.",
  confusableWith: [
    { tool: "add_goal", difference: "add_goal creates a new goal; list_goals only shows existing goals." },
    { tool: "list_tasks", difference: "list_tasks shows scheduled tasks; list_goals shows heartbeat goals." },
  ],
  latencyTier: "instant",
  outputSummary: "Returns the goal list with id, title, description, status and done-at time.",
  category: "schedule",
  triggers: { keywordPatterns: ["هدفهام", "لیست اهداف", "list (my )?goals", "show (my )?goals"] },
  costTier: "free",
});

export function createListGoalsTool(deps: GoalToolDeps): Tool<ListGoalsInput, ListGoalsOutput> {
  return {
    name: "list_goals",
    manifest: listGoalsManifest,
    description: "List the owner's goals; optionally only active or only done. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [LIST_GOALS_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        status: {
          type: "enum",
          description: "Status filter: active or done. Without it, all goals.",
          choices: [...GOAL_STATUSES],
        },
      },
    },

    async run(input: ListGoalsInput, ctx: ToolContext): Promise<ListGoalsOutput> {
      const userId = ownerOf(ctx, deps);
      const status = parseStatus(input.status);
      const rows = deps.storage.scheduling.listGoals(userId, status, MAX_LIST);

      return {
        goals: rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          status: r.status,
          ...(r.doneAt !== undefined ? { doneAt: new Date(r.doneAt).toISOString() } : {}),
        })),
        count: rows.length,
      };
    },
  };
}

// ---------- complete_goal ----------

export interface CompleteGoalInput {
  id: number;
}

export interface CompleteGoalOutput {
  id: number;
  /**
   * Always true on success: completing a missing or already-done goal throws
   * not_found instead of reporting false, so the model gets a clear error
   * rather than a silent no-op.
   */
  completed: boolean;
  remaining: number;
}

/** Plugin discovery manifest for `complete_goal`. */
export const completeGoalManifest: ToolManifest = defineManifest({
  id: "complete_goal",
  version: "1.0.0",
  title: "Complete Goal",
  description: "Mark a goal done by its id. Owner only.",
  purpose: "mark owner goal done",
  useWhen: "goal finished",
  doNotUseWhen: "Goal not finished or id unknown — list_goals finds ids and status; this only closes an active goal by id.",
  confusableWith: [
    { tool: "list_goals", difference: "list_goals only displays goals; complete_goal marks one active goal done by id." },
    { tool: "cancel_task", difference: "cancel_task stops a scheduled task; complete_goal closes a goal, not a task." },
  ],
  latencyTier: "instant",
  outputSummary: "Returns the completed flag, goal id, and remaining active goal count.",
  category: "schedule",
  triggers: { keywordPatterns: ["هدف.*(تموم|کامل|انجام شد)", "complete (the|my) goal", "mark (the )?goal (as )?(done|complete)"] },
  costTier: "free",
});

export function createCompleteGoalTool(
  deps: GoalToolDeps,
): Tool<CompleteGoalInput, CompleteGoalOutput> {
  return {
    name: "complete_goal",
    manifest: completeGoalManifest,
    description: "Mark a goal done by its id. Owner only.",
    enabled: true,
    ownerOnly: true,
    permission: { requires: [COMPLETE_GOAL_PERMISSION] },
    toolset: "schedule",
    input: {
      fields: {
        id: {
          type: "integer",
          required: true,
          description: "Goal id, from the goal list.",
          minimum: 1,
        },
      },
    },

    async run(input: CompleteGoalInput, ctx: ToolContext): Promise<CompleteGoalOutput> {
      const userId = ownerOf(ctx, deps);
      // Scoped to the creator by the storage layer, and only an active goal
      // may be completed — completing twice reports false, not a fresh stamp.
      const completed = deps.storage.scheduling.completeGoal(userId, input.id);
      if (!completed) {
        throw new ToolError("not_found", "No active goal found with this id.");
      }
      return {
        id: input.id,
        completed: true,
        remaining: deps.storage.scheduling.countGoals(userId, "active"),
      };
    },
  };
}

/** Build all three goal tools. */
export function createGoalTools(deps: GoalToolDeps): readonly Tool<unknown, unknown>[] {
  return [
    createAddGoalTool(deps),
    createListGoalsTool(deps),
    createCompleteGoalTool(deps),
  ] as unknown as readonly Tool<unknown, unknown>[];
}

// ---------- helpers ----------

function parseStatus(raw: string | undefined): GoalStatus | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!GOAL_STATUSES.includes(value as GoalStatus)) {
    throw new ToolError("invalid_input", "Invalid status; active or done.");
  }
  return value as GoalStatus;
}

/**
 * The owner id for this call, taken from the server-supplied actor — and then
 * checked against the server-supplied owner predicate.
 *
 * The Executor already required the permission key, but the key alone does not
 * prove ownership (the bridge withholds it from non-owners, yet a caller that
 * builds actors directly could hold it anyway). This second check is what
 * makes the tools owner-only rather than merely key-gated.
 */
function ownerOf(ctx: ToolContext, deps: GoalToolDeps): string {
  const id = ctx.actor.userId;
  if (typeof id !== "string" || id.length === 0 || id === "unknown") {
    throw new ToolError("not_allowed", "Identity is unknown.");
  }
  if (!deps.isOwner(id)) {
    throw new ToolError("not_allowed", "Goal management is owner only.");
  }
  return id;
}

