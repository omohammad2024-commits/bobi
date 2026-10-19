import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
} from "./provider";
import { AiError } from "./provider";

/**
 * A deterministic, offline provider used until a real one is configured.
 * Makes the whole conversation path testable without an API key.
 * Honors timeout and abort; echoes the last user message.
 */
export class FakeProvider implements AiProvider {
  readonly name = "fake";

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const input = lastUser?.content ?? "";

    // Simulate a tiny amount of async work while honoring abort/timeout.
    await sleepWithAbort(10, req.signal);

    if (req.signal.aborted) {
      throw new AiError("aborted", "request aborted");
    }

    return {
      text: `BOBI test mode: your message was received — "${truncate(input, 200)}". (No real provider is configured yet)`,
      model: req.model,
    };
  }
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AiError("aborted", "request aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new AiError("aborted", "request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
