/**
 * Deadline plumbing shared by the engine and the agent loop.
 *
 * Two independent things can end a provider call, and both have to work:
 *
 *  - the caller cancelling (a newer message superseded this run, or shutdown)
 *  - the call's own deadline passing
 *
 * Passing `timeoutMs` down is not sufficient on its own, and neither is merely
 * aborting a signal. Aborting only helps a caller that listens; a provider whose
 * promise never settles would hang the `await` regardless, and because each
 * in-flight call holds a semaphore slot, a few hung calls would wedge the bot
 * entirely. So the deadline is also RACED against the promise, which is the only
 * thing that can free a caller from a promise that will not settle.
 */

/** Thrown when a raced promise exceeds its deadline. */
export class DeadlineExceeded extends Error {
  constructor() {
    super("deadline exceeded");
    this.name = "DeadlineExceeded";
  }
}

export interface Deadline {
  /** Signal to hand the provider, so a well-behaved one tears down early. */
  readonly signal: AbortSignal;
  /** True when the deadline fired (as opposed to the caller cancelling). */
  timedOut(): boolean;
  /** Rejects when the deadline fires; never settles otherwise. */
  readonly expired: Promise<never>;
  /** Clears the timer and detaches the listener. Always call this. */
  dispose(): void;
}

/**
 * A deadline over `signal`, firing after `timeoutMs`.
 *
 * @param signal the caller's cancellation signal
 * @param timeoutMs deadline in ms; values < 1 are clamped so a timer always arms
 */
export function withDeadline(signal: AbortSignal, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = (): void => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let fire: (err: unknown) => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    fire = reject;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    fire(new DeadlineExceeded());
  }, Math.max(1, timeoutMs));

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    expired,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Await `work`, giving up when the deadline fires.
 *
 * The abandoned promise keeps whatever rejection it would have produced; a
 * no-op handler is attached so that a late failure is not reported as an
 * unhandled rejection after the caller has already moved on.
 */
export async function raceDeadline<T>(work: Promise<T>, deadline: Deadline): Promise<T> {
  try {
    return await Promise.race([work, deadline.expired]);
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      void work.catch(() => undefined);
      throw err;
    }
    throw err;
  }
}
