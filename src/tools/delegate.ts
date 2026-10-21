/**
 * delegate — run a bounded child agent as a tool.
 *
 * The parent model hands a self-contained subtask to a fresh AgentLoop that
 * runs with a filtered tool registry and tight budgets, then gets back a
 * short summary. This is how the agent parallelises or isolates work without
 * the parent's context filling up with intermediate steps.
 *
 * SECURITY MODEL (read before touching this file):
 *
 *  1. DEPTH-1 IS STRUCTURAL, NOT A COUNTER. The child loop's ToolService is
 *     built from the parent's registry with `delegate` removed, via
 *     createChildToolService(). The child model is never told `delegate`
 *     exists (toolSpecsFor omits it) and a direct request is refused with
 *     not_found by the Executor. A recursion bomb is impossible by
 *     construction — there is no depth counter the model could influence.
 *
 *  2. SAME ACTOR, NO ESCALATION. The child loop runs as ctx.actor, the exact
 *     identity the parent's tool call was authorized for. The child cannot
 *     reach tools the actor may not run: toolSpecsFor filters by can(), and
 *     the Executor re-checks per call.
 *
 *  3. CHILD BUDGETS ARE CAPPED BELOW THE PARENT'S. maxIterations <= 3,
 *     maxToolCalls <= 5, totalTimeoutMs 60s — all at or under the parent's
 *     typical caps (6 iterations / 12 tool calls / 120s), and none of them is
 *     model-supplied beyond the declared input ranges.
 *
 *  4. CHILD OUTPUT IS UNTRUSTED DATA. The summary returns inside `data`, and
 *     the parent loop wraps every tool result in <tool_result>, which the
 *     system prompt already declares to be data, never instructions. The
 *     parent must not treat the child's words as orders.
 *
 *  5. FAILURES NEVER LEAK INTERNALS. A child throw becomes
 *     { ok: false, error } with a fixed English message; provider payloads,
 *     stack traces, and model names stay out.
 */
import { AgentCancelled, AgentLoop } from "../agent/loop";
import { AiError } from "../ai/provider";
import type { AiProvider } from "../ai/provider";
import type { Lang } from "../i18n/types";
import { DEFAULT_TOOLS, ToolService } from "./service";
import { ToolError } from "./errors";
import type { Tool, ToolContext } from "./types";
import { delegateManifest } from "./delegate_manifest";

export { delegateManifest } from "./delegate_manifest";

export const DELEGATE_TOOL_NAME = "delegate";
export const DELEGATE_PERMISSION = "tools:delegate";

/** Wall-clock ceiling for one delegation, ms. Input-independent. */
export const DELEGATE_TOTAL_TIMEOUT_MS = 60_000;

/** Per provider call inside the child loop, ms. Input-independent. */
const DELEGATE_CALL_TIMEOUT_MS = 20_000;

/** Summary length cap, in characters. Input-independent. */
export const DELEGATE_SUMMARY_MAX_CHARS = 2000;

/** Named note appended when the child's answer is truncated. */
const TRUNCATION_NOTE = "… [note: child response was long and was shortened]";

export interface DelegateInput {
  /** The subtask, self-contained. */
  task: string;
  /** Child model turns, 1..3. Defaults to 3. */
  maxIterations?: number;
  /** Child tool executions, 1..5. Defaults to 5. */
  maxToolCalls?: number;
}

export type DelegateOutput = { ok: true; summary: string } | { ok: false; error: string };

export interface DelegateToolDeps {
  /** Parent registry: the child view is derived from this, minus `delegate`. */
  tools: ToolService;
  provider: AiProvider;
  /** Model id the child loop requests. */
  model: string;
  /**
   * Bilingual agent output: resolve the delegating user's reply language.
   *
   * Called with `ctx.actor.userId`. Absent (or throwing) means English — the
   * default. Same trust shape as the engine's `langFor`: server-side pref
   * only, never model text.
   */
  langFor?: (userId: string) => Lang | undefined;
}

const CHILD_SYSTEM_PROMPT =
  "You are a focused subagent. Complete ONLY this task, answer concisely in English. " +
  "Use the tools available to you. Do not ask clarifying questions.";

/**
 * The child agent's reply language follows the DELEGATING user's `/lang`
 * pref (bilingual agent output). The value comes from the server-side pref,
 * never from the task text, so the parent model cannot steer the child's
 * language by phrasing.
 */
function childSystemPrompt(_lang: Lang): string {
  return CHILD_SYSTEM_PROMPT;
}

/**
 * Build the child's registry view: every tool the parent registry holds,
 * EXCEPT `delegate` itself.
 *
 * Built with the ToolService public API only (constructor + registry.list):
 * the constructor re-registers DEFAULT_TOOLS, so they are excluded from the
 * extra list to avoid duplicate registration. Tool objects are shared by
 * reference — they are stateless, so this is safe.
 */
export function createChildToolService(parent: ToolService): ToolService {
  const defaultNames = new Set(DEFAULT_TOOLS.map((t) => t.name));
  const childTools = parent.registry
    .list()
    .filter((t) => t.name !== DELEGATE_TOOL_NAME && !defaultNames.has(t.name));
  const child = new ToolService({
    extraTools: childTools as unknown as readonly Tool<unknown, unknown>[],
  });
  // The owner's desk-disabled set is a runtime override on the PARENT
  // registry; a fresh registry starts empty, which would resurrect tools
  // the owner deliberately turned off. Copy it over so a disabled tool
  // stays disabled inside delegated sub-tasks too. (`delegate` itself is
  // absent from the child, so its entry — if any — is a harmless no-op.)
  for (const name of parent.registry.disabledNames()) {
    child.registry.setDisabled(name, true);
  }
  return child;
}

/** Build the delegate tool. Two-tier access: owner-only — the public chats, it never delegates. */
export function createDelegateTool(deps: DelegateToolDeps): Tool<DelegateInput, DelegateOutput> {
  return {
    name: DELEGATE_TOOL_NAME,
    manifest: delegateManifest,
    description:
      "Hand an independent subtask to a child agent with limited tools and a time budget. " +
      "Use it for side work that should not clutter the main conversation; returns a short summary.",
    enabled: true,
    permission: { requires: [DELEGATE_PERMISSION] },
    // Withheld from public actors by the authorization bridge.
    ownerOnly: true,
    toolset: "agents",
    // Slow by design (the child loop is budgeted DELEGATE_TOTAL_TIMEOUT_MS):
    // without this the executor's 10s default kills every delegation that a
    // slow provider stretches past ten seconds, while the orphaned child keeps
    // burning tokens in the background. Same pattern as consult_models.
    timeoutMs: DELEGATE_TOTAL_TIMEOUT_MS,
    input: {
      fields: {
        task: {
          type: "string",
          required: true,
          description: "Full, self-contained description of the subtask.",
          minLength: 1,
          maxLength: 2000,
        },
        maxIterations: {
          type: "integer",
          description: "Model turn cap in the child agent (1 to 3, default 3).",
          minimum: 1,
          maximum: 3,
        },
        maxToolCalls: {
          type: "integer",
          description: "Tool call cap in the child agent (1 to 5, default 5).",
          minimum: 1,
          maximum: 5,
        },
      },
    },

    async run(input: DelegateInput, ctx: ToolContext): Promise<DelegateOutput> {
      const task = input.task.trim();
      if (task.length === 0) {
        throw new ToolError("invalid_input", "The subtask description is empty.");
      }
      const maxIterations = input.maxIterations ?? 3;
      const maxToolCalls = input.maxToolCalls ?? 5;

      // Depth-1 by construction: this registry has no `delegate` tool, so the
      // child model cannot delegate further no matter what it tries.
      const childTools = createChildToolService(deps.tools);
      const loop = new AgentLoop({
        provider: deps.provider,
        model: deps.model,
        tools: childTools,
        callTimeoutMs: DELEGATE_CALL_TIMEOUT_MS,
        budgets: {
          maxIterations,
          maxToolCalls,
          totalTimeoutMs: DELEGATE_TOTAL_TIMEOUT_MS,
        },
      });

      try {
        const result = await loop.run({
          systemPrompt: childSystemPrompt(resolveDelegateLang(deps, ctx.actor.userId)),
          messages: [{ role: "user", content: task }],
          // The SAME actor as the parent call: no privilege escalation. The
          // child's tool visibility and every execution are authorized against
          // this identity, exactly as the parent's own tools are.
          actor: ctx.actor,
          signal: ctx.signal,
        });
        // The summary travels in `data`: the parent loop wraps it in
        // <tool_result>, i.e. untrusted data, never instructions.
        return { ok: true, summary: truncateSummary(result.text) };
      } catch (err) {
        // Never rethrow raw: a child failure may carry provider internals.
        // Cancellation included: the parent loop re-checks its own signal at
        // the next boundary and raises AgentCancelled itself.
        return { ok: false, error: childErrorMessage(err) };
      }
    },
  };
}

/**
 * Resolve the child's reply language for the delegating user. Fail-closed to
 * English on a missing, throwing, or misbehaving resolver — the child answer
 * must never be missing or in an unselected language.
 */
function resolveDelegateLang(deps: DelegateToolDeps, userId: string): Lang {
  try {
    const resolved = deps.langFor?.(userId);
    if (resolved === "en") return resolved;
  } catch {
    // fall through to the English default
  }
  return "en";
}

/** Cap the child's answer; the cut is marked with a named note. */
function truncateSummary(text: string): string {
  if (text.length <= DELEGATE_SUMMARY_MAX_CHARS) return text;
  return text.slice(0, DELEGATE_SUMMARY_MAX_CHARS - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
}

/** Fixed, user-safe English message for any child failure. */
function childErrorMessage(err: unknown): string {
  if (err instanceof ToolError) return err.message; // already user-safe
  if (err instanceof AgentCancelled) return "The subtask run was cancelled.";
  if (err instanceof AiError) {
    switch (err.kind) {
      case "timeout":
        return "The subtask hit its time limit and did not finish.";
      case "aborted":
        return "The subtask run was cancelled.";
      case "quota":
        return "The AI service quota is exhausted; try again later.";
      case "auth":
        return "The AI service configuration is invalid.";
      default:
        return "Running the subtask failed.";
    }
  }
  return "Running the subtask failed.";
}
