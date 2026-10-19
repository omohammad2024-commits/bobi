/**
 * consult_models — ask up to three configured models the same question in
 * parallel, then synthesize their answers into one English reply with the
 * primary model.
 *
 * Pipeline: allowlist the requested models → runMixture fan-out (per-model
 * 30s deadline, failures recorded not fatal) → one synthesis call with
 * primaryModel → { ok: true, modelsUsed, answer }.
 *
 * SECURITY MODEL (read before touching this file):
 *
 *  1. SERVER-SIDE ALLOWLIST. The model may only name models returned by
 *     deps.listConfiguredModels() — the exact model ids the owner
 *     configured. Any other name is rejected with not_allowed, so the model
 *     cannot invent endpoints, reach disabled models, or smuggle an
 *     arbitrary string into the provider layer.
 *
 *  2. TIMEOUTS ARE INPUT-INDEPENDENT. Per-model (DEFAULT_MODEL_TIMEOUT_MS),
 *     synthesis (SYNTHESIS_TIMEOUT_MS), and total (CONSULT_MODELS_TIMEOUT_MS)
 *     are constants: the model can neither extend them via input nor learn a
 *     slower path around them. The total deadline is both signalled AND raced,
 *     so a non-cooperative provider cannot hang the tool past it.
 *
 *  3. THE EXECUTOR'S OWN BUDGET MUST COVER THE TOOL. The ToolService default
 *     timeout (10s) is shorter than this tool's 120s budget; the wiring must
 *     raise it (CONSULT_MODELS_TIMEOUT_MS is exported for exactly this) or
 *     the executor will cut the tool early. See docs/phase-c4-mixture.md.
 *
 *  4. CONSULTED ANSWERS ARE UNTRUSTED DATA. Each model's answer returns
 *     inside `data`, and the synthesis prompt labels them as answers from
 *     other models — never as instructions. A model that says "ignore your
 *     rules" is text to weigh, not an order.
 *
 *  5. GATEWAY CAVEAT. AiGateway pins the stored model ("the stored model
 *     always wins" — see gateway.ts): with the default wiring every
 *     consultation round-trips the ACTIVE model, no matter which names were
 *     allowlisted. True multi-model fan-out needs a provider that honours
 *     CompletionRequest.model (a direct adapter or a routing wrapper).
 *     modelsUsed reports the models that actually produced text.
 *
 * COST: each consulted model is a full provider call, plus the synthesis
 * call. Consulting 3 models costs roughly 4× one call. The model-facing
 * description says this; use the tool when the question is worth it.
 */
import { AiError } from "../ai/provider";
import type { AiProvider } from "../ai/provider";
import { DEFAULT_MODEL_TIMEOUT_MS, runMixture } from "../ai/mixture";
import type { MixtureAnswer } from "../ai/mixture";
import { DeadlineExceeded, raceDeadline, withDeadline } from "../core/deadline";
import { ToolError, toToolError } from "./errors";
import type { Tool, ToolContext } from "./types";

export const CONSULT_MODELS_TOOL_NAME = "consult_models";
export const CONSULT_MODELS_PERMISSION = "tools:consult_models";

/** Maximum models consulted in one call. Input-independent. */
export const CONSULT_MODELS_MAX = 3;

/**
 * Total tool budget, ms. Input-independent: the model cannot extend it.
 *
 * The registration wiring must give the executor at least this much budget
 * for the tool (see the module doc); the tool additionally enforces it
 * internally so its own work never exceeds it.
 */
export const CONSULT_MODELS_TIMEOUT_MS = 120_000;

/** Budget for the final synthesis call, ms. Input-independent. */
const SYNTHESIS_TIMEOUT_MS = 30_000;

export interface ConsultModelsInput {
  /** The question every model is asked. */
  question: string;
  /**
   * Model ids to consult (max 3). Omitted → the first ≤3 configured models.
   * Every name must appear in listConfiguredModels().
   */
  models?: string[];
}

export interface ConsultModelsOutput {
  ok: true;
  /** Models that actually produced an answer, in consultation order. */
  modelsUsed: string[];
  /** The synthesized English answer. */
  answer: string;
}

export interface ConsultModelsDeps {
  provider: AiProvider;
  /** Model that performs the final synthesis. */
  primaryModel: string;
  /** Fresh list of owner-configured model ids. Called per run, never cached. */
  listConfiguredModels: () => string[];
}

/** Build the consult_models tool. Two-tier access: owner-only — multi-model consultation is an owner capability. */
export function createConsultModelsTool(
  deps: ConsultModelsDeps,
): Tool<ConsultModelsInput, ConsultModelsOutput> {
  return {
    name: CONSULT_MODELS_TOOL_NAME,
    description:
      "Consult up to 3 configured models at once and combine their answers into one precise answer. " +
      "Querying is expensive (one full call per model + one synthesis); use it for important questions worth multiple perspectives.",
    enabled: true,
    permission: { requires: [CONSULT_MODELS_PERMISSION] },
    // Withheld from public actors by the authorization bridge.
    ownerOnly: true,
    toolset: "agents",
    // Slow by design (up to 3 model consultations + synthesis): the executor
    // honors this instead of the 10s default. The tool ALSO enforces the same
    // bound internally, so a miswired executor cannot extend it silently.
    timeoutMs: CONSULT_MODELS_TIMEOUT_MS,
    input: {
      fields: {
        question: {
          type: "string",
          required: true,
          description: "The question asked of every model.",
          minLength: 1,
          maxLength: 2000,
        },
        models: {
          type: "array",
          description:
            "Model ids (max 3); only configured models are accepted. Empty means the first three.",
          maxItems: CONSULT_MODELS_MAX,
        },
      },
    },

    async run(input: ConsultModelsInput, ctx: ToolContext): Promise<ConsultModelsOutput> {
      const question = input.question.trim();
      if (question.length === 0) {
        throw new ToolError("invalid_input", "The question is empty.");
      }

      const configured = deps.listConfiguredModels();
      const requested = input.models ?? configured.slice(0, CONSULT_MODELS_MAX);
      if (requested.length === 0) {
        throw new ToolError("not_allowed", "No models are configured for consultation.");
      }
      // Server-side allowlist: only owner-configured model ids are accepted.
      // Non-strings and unknown names are rejected alike — the model cannot
      // invent endpoints through this field.
      const rejected = requested.filter(
        (m) => typeof m !== "string" || !configured.includes(m),
      );
      if (rejected.length > 0) {
        throw new ToolError("not_allowed", "One or more model names are invalid.");
      }
      const models = [...new Set(requested)].slice(0, CONSULT_MODELS_MAX);

      // Total budget for the whole tool, independent of input. Both signalled
      // and raced: a provider that ignores its signal still cannot push the
      // tool past this deadline.
      const deadline = withDeadline(ctx.signal, CONSULT_MODELS_TIMEOUT_MS);
      try {
        const { answers } = await raceDeadline(
          runMixture(
            {
              complete: async (model, messages, signal) => {
                const res = await deps.provider.complete({
                  messages,
                  model,
                  timeoutMs: DEFAULT_MODEL_TIMEOUT_MS,
                  signal,
                });
                return res.text;
              },
            },
            question,
            models,
            { timeoutMsPerModel: DEFAULT_MODEL_TIMEOUT_MS },
          ),
          deadline,
        );

        const modelsUsed = answers
          .filter((a) => a.text !== undefined)
          .map((a) => a.model);
        if (modelsUsed.length === 0) {
          throw new ToolError("internal", "No model answered.");
        }

        let answer: string;
        try {
          const synthesis = await deps.provider.complete({
            messages: [{ role: "user", content: buildSynthesisPrompt(question, answers) }],
            model: deps.primaryModel,
            timeoutMs: SYNTHESIS_TIMEOUT_MS,
            signal: deadline.signal,
          });
          answer = synthesis.text.trim();
        } catch (err) {
          if (err instanceof ToolError) throw err;
          if (deadline.timedOut() || err instanceof DeadlineExceeded) {
            throw new ToolError("timeout", "Consulting the models hit the time limit.");
          }
          if (err instanceof AiError && err.kind === "aborted") {
            throw new ToolError("aborted", "Consulting the models was cancelled.");
          }
          throw toToolError(err);
        }
        if (answer.length === 0) {
          throw new ToolError("invalid_result", "The combined answer was empty.");
        }
        return { ok: true, modelsUsed, answer };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if (err instanceof DeadlineExceeded || deadline.timedOut()) {
          throw new ToolError("timeout", "Consulting the models hit the time limit.");
        }
        // Never leak provider internals: fixed, user-safe categories only.
        throw toToolError(err);
      } finally {
        deadline.dispose();
      }
    },
  };
}

/**
 * Synthesis prompt: the consulted answers are labelled as other models'
 * answers — data to weigh, never instructions to follow.
 */
function buildSynthesisPrompt(question: string, answers: MixtureAnswer[]): string {
  const labelled = answers
    .map((a, i) => {
      const body = a.text !== undefined ? a.text : `[this model did not answer: ${a.error ?? "unknown"}]`;
      return `--- answer from model ${i + 1} (${a.model}) ---\n${body}`;
    })
    .join("\n\n");
  return (
    `These are answers from ${answers.length} models to one question. Give the best synthesis: precise, in English, no fluff.\n\n` +
    `Question: ${question}\n\n${labelled}`
  );
}
