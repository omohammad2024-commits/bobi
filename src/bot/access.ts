/**
 * Two-tier access model: OWNER vs PUBLIC.
 *
 * This is the single source of truth for "who may do what" at the bot
 * surface:
 *
 * - TIER 1 — OWNER (محمد, the bot's creator and father): full access to
 *   everything, exactly as before. No behaviour change for the owner.
 * - TIER 2 — PUBLIC: anyone may chat with Bobi, plus /start (public
 *   variant), /help (public portion only), /commands (the same tier-filtered
 *   palette /help opens), /lang and /voice. Nothing more.
 *
 * Enforcement is defence in depth and lives in three layers:
 *   1. INVISIBILITY — public users never SEE owner-only surface: the default
 *      setMyCommands scope lists only public commands, the public main menu
 *      is a separate smaller builder, and the palette / /help render only
 *      public entries for them.
 *   2. GATES — every command handler, callback namespace and the message
 *      path re-checks the tier server-side (requireOwnerTier), so a forged
 *      callback or a manually typed command is refused, never executed.
 *   3. TOOL LAYER — owner-only tools are withheld from non-owner actors by
 *      the authorization bridge (tool.ownerOnly), so the model is never even
 *      told they exist.
 *
 * Ownership is always resolved from the trusted numeric Telegram id via the
 * AuthorizationService — never from message text, callback data, usernames,
 * or anything the model claims. Fail-closed: without auth (or without a
 * sender) nobody counts as the owner.
 */
import type { AuthorizationService } from "../auth/service";
import { t, type Lang } from "../i18n";

export type AccessTier = "owner" | "public";

/**
 * Commands any Telegram user may run. The set is deliberately tiny:
 * - start — the public welcome screen (never the owner onboarding wizard)
 * - help / commands — the command palette, tier-filtered per sender
 * - lang — the interface-language picker
 * - voice — the voice-mode picker (auto/always/never). Voice is
 *   conversation, not administration: anyone chatting with Bobi may choose
 *   how their own replies sound. Per-user prefs, so no cross-user leak.
 *
 * Free-form conversation is not a command and is always public (subject to
 * the ban/mute gate). EVERYTHING else is owner-only.
 */
export const PUBLIC_COMMANDS: ReadonlySet<string> = new Set([
  "start",
  "help",
  "commands",
  "lang",
  "voice",
]);

/** The access tier of a command name. Unknown names are owner-only (deny by default). */
export function commandTier(name: string): AccessTier {
  return PUBLIC_COMMANDS.has(name) ? "public" : "owner";
}

/** True when any Telegram user may run this command. */
export function isPublicCommand(name: string): boolean {
  return commandTier(name) === "public";
}

/** Minimal sender shape for the owner check, so tests need no grammY context. */
export interface TierSender {
  from?: { id: number } | undefined;
}

/**
 * Whether the sender is the owner.
 *
 * Mirrors the owner check used everywhere else: the owner is proven from the
 * trusted numeric id, never from message text. Fail-closed: without auth (or
 * without a sender) nobody counts as the owner.
 */
export function isOwnerCtx(
  ctx: TierSender,
  deps: { auth?: AuthorizationService },
): boolean {
  const { auth } = deps;
  if (!auth || !ctx.from) return false;
  const actor = auth.actorFromTelegramUser(ctx.from);
  return actor !== undefined && auth.isOwner(actor);
}

async function safeTierReply(
  ctx: { reply(text: string): Promise<unknown> },
  text: string,
): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // A user who blocked the bot cannot be told anything; not an error.
  }
}

/**
 * Tier gate for command/callback handlers: the owner passes through, anyone
 * else gets the short, polite refusal — which deliberately reveals NOTHING
 * about what the command does (no owner-feature descriptions leak).
 *
 * Returns true when the caller may proceed.
 */
export async function requireOwnerTier(
  ctx: TierSender & { reply(text: string): Promise<unknown> },
  deps: { auth?: AuthorizationService },
  lang: Lang = "fa",
): Promise<boolean> {
  if (isOwnerCtx(ctx, deps)) return true;
  await safeTierReply(ctx, t("tier.refused", lang));
  return false;
}
