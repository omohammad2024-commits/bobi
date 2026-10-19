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

export function createAddGoalTool(deps: GoalToolDeps): Tool<AddGoalInput, AddGoalOutput> {
  return {
    name: "add_goal",
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

      if (deps.storage.countGoals(userId) >= MAX_GOALS_PER_OWNER) {
        throw new ToolError(
          "invalid_input",
          "Too many goals; complete some first.",
        );
      }

      const id = deps.storage.createGoal({
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

export function createListGoalsTool(deps: GoalToolDeps): Tool<ListGoalsInput, ListGoalsOutput> {
  return {
    name: "list_goals",
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
      const rows = deps.storage.listGoals(userId, status, MAX_LIST);

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
  /** False when there was no active goal with that id for this user. */
  completed: boolean;
  remaining: number;
}

export function createCompleteGoalTool(
  deps: GoalToolDeps,
): Tool<CompleteGoalInput, CompleteGoalOutput> {
  return {
    name: "complete_goal",
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
      const completed = deps.storage.completeGoal(userId, input.id);
      if (!completed) {
        throw new ToolError("not_found", "No active goal found with this id.");
      }
      return {
        id: input.id,
        completed: true,
        remaining: deps.storage.countGoals(userId, "active"),
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

