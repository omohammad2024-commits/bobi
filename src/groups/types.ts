/**
 * Group-assistant shared types (platform Phase 5).
 *
 * AssistantConfig and GroupChatMessage used to be defined in
 * assistant.ts while smart_summary.ts imported them from there and
 * assistant.ts imported summarizeSmart back from smart_summary.ts — a
 * cycle. Both types are pure data shapes with no dependencies, so they
 * live in this leaf module; assistant.ts re-exports them (its public
 * surface is unchanged) and smart_summary.ts imports them from here.
 */

export interface AssistantConfig {
  /** Master switch. Default false — assistant mode is strictly opt-in per group. */
  enabled: boolean;
  /**
   * Reply ONLY when mentioned (@Bobi_Agentbot) or replied to. Default true
   * (anti-noise). When false, group turns flow as usual (engine decides).
   */
  replyOnlyWhenCalled: boolean;
  /** Max messages the /gsummary window may span. Bounds: 5..50. Default 30. */
  summaryMaxMessages: number;
  /** Whether the owner may create polls in this group. Default true. */
  pollsAllowed: boolean;
  /**
   * Phase-4: daily digest of this group's discussion, delivered to the
   * OWNER's private chat (never posted into the group). Default false —
   * strictly opt-in like everything else here. Requires `enabled`.
   */
  digestEnabled: boolean;
  /**
   * Phase-4: daily digest time as "HH:MM" 24-hour (Asia/Tehran). Default
   * "08:00". Bounds: valid clock time.
   */
  digestTime: string;
  /**
   * Phase-5: LLM smart summary layer. Default false — strictly opt-in.
   * When ON, the owner's /gsummary and the scheduled digest may additionally
   * request an LLM summary (injection-hardened; see smart_summary.ts).
   * Requires `enabled` (needs the history buffer) and a wired AI provider.
   */
  smartSummary: boolean;
}

export interface GroupChatMessage {
  chatId: string;
  userId: string;
  /** Telegram display name — UNTRUSTED; sanitized at render time. */
  name: string;
  text: string;
  tsMs: number;
}
