/**
 * Mixture of agents — ask several models the same question in parallel and
 * collect every answer.
 *
 * This module is provider-agnostic on purpose: the caller supplies a
 * `complete` function that turns (model, messages, signal) into text, so the
 * fan-out logic stays testable offline and reusable by any tool. The
 * consult_models tool wires it to the real AiProvider and synthesizes the
 * answers into one reply.
 *
 * Failure semantics: a model that fails, times out, or never settles is
 * RECORDED ({ model, error }), never fatal. The caller decides whether the
 * surviving answers are enough.
 *
 * SECURITY / COST NOTES:
 *
 *  - Every consulted model is a full provider call: N models means roughly N×
 *    the token spend of one call, plus the synthesis call. The docs for
 *    consult_models state this plainly; do not hide the cost behind this API.
 *  - The per-model timeout is raced against the promise, not just signalled:
 *    a provider that ignores its AbortSignal cannot hold the fan-out open,
 *    because Promise.allSettled only waits for promises that actually settle
 *    and each per-model promise is independently raced to settle.
 *  - `models` is caller-supplied. This module does NOT validate names — the
 *    caller (consult_models) enforces a server-side allowlist so the model
 *    cannot invent endpoints. Never call runMixture with model-supplied names
 *    directly.
 */
import type { ChatMessage } from "./provider";
import { AiError } from "./provider";
import { DeadlineExceeded, raceDeadline, withDeadline } from "../core/deadline";

export interface MixtureDeps {
  /**
   * Ask one model one question.
   *
   * Must honour `signal` (abort the request) AND settle promptly when it
   * fires; the fan-out additionally races a hard timeout per model, so a
   * non-cooperative implementation degrades to an abandoned promise rather
   * than a hung run.
   */
  complete: (model: string, messages: ChatMessage[], signal: AbortSignal) => Promise<string>;
}

export interface MixtureAnswer {
  model: string;
  /** Set when the model answered. */
  text?: string;
  /** Set when it did not. Persian, user-safe, secret-free. */
  error?: string;
}

export interface MixtureResult {
  /** One entry per requested model, in request order. */
  answers: MixtureAnswer[];
}

export interface MixtureOptions {
  /** Per-model deadline, ms. Input-independent default below. */
  timeoutMsPerModel?: number;
}

/** Default per-model deadline, ms. */
export const DEFAULT_MODEL_TIMEOUT_MS = 30_000;

/**
 * Consult every model in parallel.
 *
 * Promise.allSettled is the fan-out primitive: one model's failure cannot
 * reject the whole batch. Each model additionally gets its own raced
 * deadline, so a hung model is recorded as a timeout instead of stalling
 * the rest.
 */
export async function runMixture(
  deps: MixtureDeps,
  question: string,
  models: string[],
  opts: MixtureOptions = {},
): Promise<MixtureResult> {
  const timeoutMs = opts.timeoutMsPerModel ?? DEFAULT_MODEL_TIMEOUT_MS;
  const settled = await Promise.allSettled(
    models.map((model) => consultOne(deps, model, question, timeoutMs)),
  );
  return {
    answers: settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : // consultOne never throws; this is defence in depth only.
          { model: models[i] ?? "نامشخص", error: "خطای داخلی مشورت." },
    ),
  };
}

/**
 * Ask one model, bounded by its own deadline.
 *
 * The deadline both aborts the provider's signal (so a well-behaved provider
 * tears down early) and races the promise (so one that never settles is cut
 * loose on time). Either way this function always settles.
 */
async function consultOne(
  deps: MixtureDeps,
  model: string,
  question: string,
  timeoutMs: number,
): Promise<MixtureAnswer> {
  // A fresh, never-aborted outer signal: cancellation here is per-model only.
  // The caller abandons the whole batch by dropping the result; orphaned
  // per-model calls settle on their own timeout and are swallowed by
  // allSettled, never surfacing as unhandled rejections.
  const deadline = withDeadline(new AbortController().signal, timeoutMs);
  try {
    const text = await raceDeadline(
      deps.complete(model, [{ role: "user", content: question }], deadline.signal),
      deadline,
    );
    return { model, text };
  } catch (err) {
    return { model, error: mixtureErrorMessage(err) };
  } finally {
    deadline.dispose();
  }
}

/** Fixed, user-safe Persian message for a failed consultation. */
function mixtureErrorMessage(err: unknown): string {
  if (err instanceof DeadlineExceeded) return "پاسخ مدل به‌موقع نرسید.";
  if (err instanceof AiError && err.kind === "aborted") return "درخواست لغو شد.";
  return "مدل پاسخ نداد.";
}
