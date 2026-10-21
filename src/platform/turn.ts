/**
 * TurnFacade — the platform's turn surface: a thin, honest wrapper over the
 * ConversationEngine. Delegation only; no new logic lives here.
 */
import type {
  ConversationEngine,
  ConversationInput,
  ConversationOutput,
  ConversationRef,
  CompressResult,
} from "../conversation/engine";

export class TurnFacade {
  constructor(readonly engine: ConversationEngine) {}

  /** The underlying engine handle, for surfaces that need its full API. */
  get handle(): ConversationEngine {
    return this.engine;
  }

  respond(input: ConversationInput): Promise<ConversationOutput> {
    return this.engine.respond(input);
  }

  cancel(conversationId: string): void {
    this.engine.cancel(conversationId);
  }

  cancelAll(): void {
    this.engine.cancelAll();
  }

  compressNow(input: ConversationRef): Promise<CompressResult> {
    return this.engine.compressNow(input);
  }

  isAnyTurnRunning(): boolean {
    return this.engine.isAnyTurnRunning();
  }

  get isFake(): boolean {
    return this.engine.isFake;
  }
}
