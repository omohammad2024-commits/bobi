/**
 * MemoryFacade — the platform's memory surface: one object over the memory
 * stack (the long-term memory provider, episodes, semantic search, and the
 * Phase-4 owner profile service). Delegating methods only; no behavior
 * change lives here.
 */
import {
  latestEpisode,
  scanEndedConversations,
  type EpisodeDeps,
} from "../memory/episodes";
import type { SemanticMemorySearch } from "../memory/semantic";
import type { MemoryProvider, StoredMemory } from "../memory/provider";
import type { OwnerProfileService } from "../profile/owner_profile";
import type { ConversationsRepo } from "../storage/repos/conversations";

export interface MemoryHandles {
  provider: MemoryProvider;
  semantic: SemanticMemorySearch;
  ownerProfile: OwnerProfileService;
  /** Conversation reader for the episode sweep (the conversations repo). */
  conversations: ConversationsRepo;
}

export class MemoryFacade {
  readonly provider: MemoryProvider;
  readonly semantic: SemanticMemorySearch;
  readonly ownerProfile: OwnerProfileService;
  private readonly conversations: ConversationsRepo;

  constructor(handles: MemoryHandles) {
    this.provider = handles.provider;
    this.semantic = handles.semantic;
    this.ownerProfile = handles.ownerProfile;
    this.conversations = handles.conversations;
  }

  /** The long-term memory provider handle. */
  get handle(): MemoryProvider {
    return this.provider;
  }

  latestEpisode(userId: string): Promise<StoredMemory | undefined> {
    return latestEpisode(this.provider, userId);
  }

  scanEndedConversations(
    userId: string,
    maxConversations?: number,
  ): Promise<{ checked: number; stored: number }> {
    const deps: EpisodeDeps = {
      conversations: this.conversations,
      provider: this.provider,
    };
    return scanEndedConversations(deps, userId, maxConversations);
  }
}
