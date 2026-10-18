import type { Bot } from "grammy";
import type { ConversationEngine } from "../conversation/engine";
import type { Storage } from "../storage/storage";
import type { ToolService } from "../tools/service";
import type { AuthorizationService } from "../auth/service";
import type { GroupAccessService } from "../groups/service";
import type { UserAccessService } from "../auth/user_service";
import type { UserPanelController } from "../auth/user_controller";
import type { UserPrefStore } from "./bot";

/**
 * Shared context for the Hermes-parity command modules
 * (`cmd_session.ts`, `cmd_system.ts`, `cmd_auto.ts`).
 *
 * Each module exports:
 * - `COMMAND_DEFS: HermesCommandDef[]` — menu entries (Persian + English),
 *   merged by `createBot` into the single `setMyCommands` call.
 * - `registerXCommands(bot, deps)` — the grammy handlers.
 *
 * Handler conventions (same as the built-in commands in `bot.ts`):
 * - user-facing strings in Persian (via `t(key, lang)` from `src/i18n`;
 *   add new keys to BOTH `fa.ts` and `en.ts`, never change existing keys),
 * - run the group/user gates first: import `gateGroup`, `gateUser`,
 *   `isOwnerSender`, `senderLang` from `./bot`,
 * - owner-only commands reject non-owners with a Persian "owner-only" reply
 *   (never silent, never an exception),
 * - no secrets in replies, no raw config dumps in chat,
 * - keep every handler unit-testable: put the logic in an exported
 *   `handleXxx(deps, ...)` function that takes plain values, and keep the
 *   grammy wrapper thin.
 */
export interface HermesCommandDeps {
  engine: ConversationEngine;
  storage: Storage;
  tools?: ToolService;
  prefs?: UserPrefStore;
  auth?: AuthorizationService;
  groups?: GroupAccessService;
  users?: UserAccessService;
  userPanel?: UserPanelController;
  /** Numeric owner id when configured (for menu scoping); undefined = none. */
  ownerId?: number;
  /** Bot version string for /version. */
  version?: string;
}

/** One Telegram bot-menu entry. `command` is without the leading slash. */
export interface HermesCommandDef {
  command: string;
  /** Persian menu description (default language of the bot). */
  descriptionFa: string;
  /** English menu description (set with language_code "en"). */
  descriptionEn: string;
  ownerOnly: boolean;
}

export type HermesRegisterFn = (bot: Bot, deps: HermesCommandDeps) => void;
