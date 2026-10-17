/**
 * Callback-data codec for the owner panel.
 *
 * Telegram caps callback data at 64 bytes and it is fully user-controlled: a
 * malformed or hostile string must never be able to select an action.
 * So the encode side only ever emits data this parser produced, and the parse
 * side is strict — anything unexpected decodes to `undefined` and the caller
 * treats it as an unknown action.
 *
 * Note that a chat id inside a callback is a TARGET, never a proof of
 * authority. Authority comes from the caller's identity plus a live permission
 * check, so a forged payload naming another group merely aims at that group
 * and is still refused for a non-owner.
 */

import { isAdapterType } from "../ai/adapter";
import { isSearchProviderType } from "../search/provider";

/** Hard cap, one byte under Telegram's limit. */
export const MAX_CALLBACK_BYTES = 64;

export type PanelAction =
  | { kind: "menu" }
  | { kind: "pending"; offset: number }
  | { kind: "approved"; offset: number }
  | { kind: "revoke_menu"; offset: number }
  | { kind: "approve"; chatId: string }
  | { kind: "reject"; chatId: string }
  | { kind: "revoke"; chatId: string }
  | { kind: "status" }
  // ---- AI management ----
  | { kind: "ai_menu" }
  | { kind: "ai_providers" }
  | { kind: "ai_provider"; providerId: number }
  | { kind: "ai_add_form" }
  | { kind: "ai_add_adapter"; adapter: string }
  | { kind: "ai_edit"; providerId: number }
  | { kind: "ai_toggle"; providerId: number }
  | { kind: "ai_test"; providerId: number }
  | { kind: "ai_discover"; providerId: number }
  | { kind: "ai_clear_key"; providerId: number }
  | { kind: "ai_delete"; providerId: number }
  | { kind: "ai_models"; providerId: number }
  | { kind: "ai_model_add_form"; providerId: number }
  | { kind: "ai_model_toggle"; modelId: number }
  | { kind: "ai_model_delete"; modelId: number }
  | { kind: "ai_model_default"; modelId: number }
  | { kind: "ai_select_menu" }
  | { kind: "ai_select_provider"; providerId: number }
  | { kind: "ai_select_model"; modelId: number }
  // ---- failover administration ----
  | { kind: "fo_menu" }
  | { kind: "fo_toggle" }
  | { kind: "fo_attempts" }
  | { kind: "fo_attempts_set"; value: number }
  | { kind: "fo_timeout" }
  | { kind: "fo_timeout_set"; value: number }
  | { kind: "fo_add_form" }
  | { kind: "fo_add_pick_provider" }
  | { kind: "fo_add_pick_model"; providerId: number }
  | { kind: "fo_add_confirm"; providerId: number; modelId: number }
  | { kind: "fo_remove"; index: number }
  | { kind: "fo_move_up"; index: number }
  | { kind: "fo_move_down"; index: number }
  // ---- AI operational status ----
  | { kind: "ai_status" }
  // ---- local-target exception ----
  | { kind: "fo_local_menu"; providerId: number }
  | { kind: "fo_local_confirm"; providerId: number }
  // ---- private-chat user access ----
  | { kind: "users_menu" }
  | { kind: "users_pending"; offset: number }
  | { kind: "users_approved"; offset: number }
  | { kind: "users_revoke_menu"; offset: number }
  | { kind: "user_approve"; userId: string }
  | { kind: "user_reject"; userId: string }
  | { kind: "user_revoke"; userId: string }
  // ---- web-search settings ----
  | { kind: "search_menu" }
  | { kind: "search_pick"; provider: string }
  | { kind: "search_set_key_form" }
  | { kind: "search_clear_key" };

export const CALLBACK_PREFIX = "adm" as const;

const MAX_CHAT_ID_LEN = 20;
const MAX_OFFSET = 10000;

/** Build callback data for a panel action. Always within the byte limit. */
export function encode(action: PanelAction): string {
  switch (action.kind) {
    case "menu":
      return `${CALLBACK_PREFIX}:menu`;
    case "pending":
      // Offset 0 is the canonical entry point, so it stays short and stable.
      return action.offset === 0
        ? `${CALLBACK_PREFIX}:pnd`
        : `${CALLBACK_PREFIX}:pnd:${clampOffset(action.offset)}`;
    case "approved":
      return `${CALLBACK_PREFIX}:apv:${clampOffset(action.offset)}`;
    case "revoke_menu":
      return `${CALLBACK_PREFIX}:rev:${clampOffset(action.offset)}`;
    case "approve":
      return `${CALLBACK_PREFIX}:ok:${action.chatId}`;
    case "reject":
      return `${CALLBACK_PREFIX}:no:${action.chatId}`;
    case "revoke":
      return `${CALLBACK_PREFIX}:del:${action.chatId}`;
    case "status":
      return `${CALLBACK_PREFIX}:sts`;
    // ---- AI management ----
    // Codes stay short: Telegram caps callback data at 64 bytes and a provider
    // id rides along in most of them.
    case "ai_menu":
      return `${CALLBACK_PREFIX}:ai`;
    case "ai_providers":
      return `${CALLBACK_PREFIX}:aip`;
    case "ai_provider":
      return `${CALLBACK_PREFIX}:aiv:${action.providerId}`;
    case "ai_add_form":
      return `${CALLBACK_PREFIX}:aia`;
    case "ai_add_adapter":
      return `${CALLBACK_PREFIX}:ait:${action.adapter}`;
    case "ai_edit":
      return `${CALLBACK_PREFIX}:aie:${action.providerId}`;
    case "ai_toggle":
      return `${CALLBACK_PREFIX}:ais:${action.providerId}`;
    case "ai_test":
      return `${CALLBACK_PREFIX}:aic:${action.providerId}`;
    case "ai_discover":
      return `${CALLBACK_PREFIX}:aid:${action.providerId}`;
    case "ai_clear_key":
      return `${CALLBACK_PREFIX}:aik:${action.providerId}`;
    case "ai_delete":
      return `${CALLBACK_PREFIX}:aix:${action.providerId}`;
    case "ai_models":
      return `${CALLBACK_PREFIX}:aim:${action.providerId}`;
    case "ai_model_add_form":
      return `${CALLBACK_PREFIX}:amma:${action.providerId}`;
    case "ai_model_toggle":
      return `${CALLBACK_PREFIX}:ammt:${action.modelId}`;
    case "ai_model_delete":
      return `${CALLBACK_PREFIX}:ammd:${action.modelId}`;
    case "ai_model_default":
      return `${CALLBACK_PREFIX}:ammf:${action.modelId}`;
    case "ai_select_menu":
      return `${CALLBACK_PREFIX}:asl`;
    case "ai_select_provider":
      return `${CALLBACK_PREFIX}:asp:${action.providerId}`;
    case "ai_select_model":
      return `${CALLBACK_PREFIX}:asm:${action.modelId}`;
    // ---- failover administration ----
    case "fo_menu":
      return `${CALLBACK_PREFIX}:fo`;
    case "fo_toggle":
      return `${CALLBACK_PREFIX}:fot`;
    case "fo_attempts":
      return `${CALLBACK_PREFIX}:foa`;
    case "fo_attempts_set":
      return `${CALLBACK_PREFIX}:foav:${clampAttemptsValue(action.value)}`;
    case "fo_timeout":
      return `${CALLBACK_PREFIX}:fod`;
    case "fo_timeout_set":
      return `${CALLBACK_PREFIX}:fodv:${clampTimeoutValue(action.value)}`;
    case "fo_add_form":
      return `${CALLBACK_PREFIX}:foaf`;
    case "fo_add_pick_provider":
      return `${CALLBACK_PREFIX}:foap`;
    case "fo_add_pick_model":
      return `${CALLBACK_PREFIX}:foam:${action.providerId}`;
    case "fo_add_confirm":
      return `${CALLBACK_PREFIX}:foac:${action.providerId}:${action.modelId}`;
    case "fo_remove":
      return `${CALLBACK_PREFIX}:for:${action.index}`;
    case "fo_move_up":
      return `${CALLBACK_PREFIX}:fou:${action.index}`;
    case "fo_move_down":
      return `${CALLBACK_PREFIX}:fown:${action.index}`;
    // ---- AI operational status ----
    case "ai_status":
      return `${CALLBACK_PREFIX}:aist`;
    // ---- local-target exception ----
    case "fo_local_menu":
      return `${CALLBACK_PREFIX}:folm:${action.providerId}`;
    case "fo_local_confirm":
      return `${CALLBACK_PREFIX}:folc:${action.providerId}`;
    // ---- private-chat user access ----
    // A user id carries no sign (unlike a group chat id), so these stay short.
    case "users_menu":
      return `${CALLBACK_PREFIX}:u`;
    case "users_pending":
      return action.offset === 0
        ? `${CALLBACK_PREFIX}:up`
        : `${CALLBACK_PREFIX}:up:${clampOffset(action.offset)}`;
    case "users_approved":
      return `${CALLBACK_PREFIX}:ua:${clampOffset(action.offset)}`;
    case "users_revoke_menu":
      return `${CALLBACK_PREFIX}:ur:${clampOffset(action.offset)}`;
    case "user_approve":
      return `${CALLBACK_PREFIX}:uok:${action.userId}`;
    case "user_reject":
      return `${CALLBACK_PREFIX}:uno:${action.userId}`;
    case "user_revoke":
      return `${CALLBACK_PREFIX}:udel:${action.userId}`;
    // ---- web-search settings ----
    case "search_menu":
      return `${CALLBACK_PREFIX}:se`;
    case "search_pick":
      return `${CALLBACK_PREFIX}:sep:${action.provider}`;
    case "search_set_key_form":
      return `${CALLBACK_PREFIX}:sesk`;
    case "search_clear_key":
      return `${CALLBACK_PREFIX}:seck`;
  }
}

/** Parse callback data. Anything malformed or unknown yields undefined. */
export function decode(data: string): PanelAction | undefined {
  if (typeof data !== "string") return undefined;
  // Telegram counts bytes, not code points; guard both.
  if (data.length > MAX_CALLBACK_BYTES) return undefined;
  if (new TextEncoder().encode(data).length > MAX_CALLBACK_BYTES) return undefined;
  if (!data.startsWith(`${CALLBACK_PREFIX}:`)) return undefined;

  const parts = data.split(":");
  if (parts.length < 2) return undefined;
  const [prefix, head, arg] = parts;
  if (prefix !== CALLBACK_PREFIX) return undefined;

  switch (head) {
    case "menu":
      return parts.length === 2 ? { kind: "menu" } : undefined;
    case "sts":
      return parts.length === 2 ? { kind: "status" } : undefined;
    case "pnd":
      // The pending list also paginates, but "pnd" alone stays valid for a
      // button rendered before offsets existed.
      return parts.length === 2
        ? { kind: "pending", offset: 0 }
        : parseOffset(arg, parts.length, (offset) => ({ kind: "pending", offset }));
    case "apv":
      return parseOffset(arg, parts.length, (offset) => ({ kind: "approved", offset }));
    case "rev":
      return parseOffset(arg, parts.length, (offset) => ({ kind: "revoke_menu", offset }));
    case "ok":
      return parseChatId(arg, parts.length, (chatId) => ({ kind: "approve", chatId }));
    case "no":
      return parseChatId(arg, parts.length, (chatId) => ({ kind: "reject", chatId }));
    case "del":
      return parseChatId(arg, parts.length, (chatId) => ({ kind: "revoke", chatId }));
    // ---- AI management ----
    case "ai":
      return parts.length === 2 ? { kind: "ai_menu" } : undefined;
    case "aip":
      return parts.length === 2 ? { kind: "ai_providers" } : undefined;
    case "aiv":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_provider", providerId }));
    case "aia":
      return parts.length === 2 ? { kind: "ai_add_form" } : undefined;
    case "ait":
      return parseAdapter(arg, parts.length);
    case "aie":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_edit", providerId }));
    case "ais":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_toggle", providerId }));
    case "aic":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_test", providerId }));
    case "aid":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_discover", providerId }));
    case "aik":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_clear_key", providerId }));
    case "aix":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_delete", providerId }));
    case "aim":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_models", providerId }));
    case "amma":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_model_add_form", providerId }));
    case "ammt":
      return parseId(arg, parts.length, (modelId) => ({ kind: "ai_model_toggle", modelId }));
    case "ammd":
      return parseId(arg, parts.length, (modelId) => ({ kind: "ai_model_delete", modelId }));
    case "ammf":
      return parseId(arg, parts.length, (modelId) => ({ kind: "ai_model_default", modelId }));
    case "asl":
      return parts.length === 2 ? { kind: "ai_select_menu" } : undefined;
    case "asp":
      return parseId(arg, parts.length, (providerId) => ({ kind: "ai_select_provider", providerId }));
    case "asm":
      return parseId(arg, parts.length, (modelId) => ({ kind: "ai_select_model", modelId }));
    // ---- failover administration ----
    case "fo":
      return parts.length === 2 ? { kind: "fo_menu" } : undefined;
    case "fot":
      return parts.length === 2 ? { kind: "fo_toggle" } : undefined;
    case "foa":
      return parts.length === 2 ? { kind: "fo_attempts" } : undefined;
    case "foav":
      return parseAttempts(arg, parts.length);
    case "fod":
      return parts.length === 2 ? { kind: "fo_timeout" } : undefined;
    case "fodv":
      return parseTimeout(arg, parts.length);
    case "foaf":
      return parts.length === 2 ? { kind: "fo_add_form" } : undefined;
    case "foap":
      return parts.length === 2 ? { kind: "fo_add_pick_provider" } : undefined;
    case "foam":
      return parseId(arg, parts.length, (providerId) => ({ kind: "fo_add_pick_model", providerId }));
    // Two ids ride together: provider:model.
    case "foac": {
      if (parts.length !== 4) return undefined;
      const providerId = parseSmallId(parts[2]);
      const modelId = parseSmallId(parts[3]);
      if (providerId === undefined || modelId === undefined) return undefined;
      return { kind: "fo_add_confirm", providerId, modelId };
    }
    case "for":
      return parseIndex(arg, parts.length, (index) => ({ kind: "fo_remove", index }));
    case "fou":
      return parseIndex(arg, parts.length, (index) => ({ kind: "fo_move_up", index }));
    case "fown":
      return parseIndex(arg, parts.length, (index) => ({ kind: "fo_move_down", index }));
    // ---- AI operational status ----
    case "aist":
      return parts.length === 2 ? { kind: "ai_status" } : undefined;
    // ---- local-target exception ----
    case "folm":
      return parseId(arg, parts.length, (providerId) => ({ kind: "fo_local_menu", providerId }));
    case "folc":
      return parseId(arg, parts.length, (providerId) => ({ kind: "fo_local_confirm", providerId }));
    // ---- private-chat user access ----
    case "u":
      return parts.length === 2 ? { kind: "users_menu" } : undefined;
    case "up":
      // "up" alone stays valid for a button rendered before offsets existed.
      return parts.length === 2
        ? { kind: "users_pending", offset: 0 }
        : parseOffset(arg, parts.length, (offset) => ({ kind: "users_pending", offset }));
    case "ua":
      return parseOffset(arg, parts.length, (offset) => ({ kind: "users_approved", offset }));
    case "ur":
      return parseOffset(arg, parts.length, (offset) => ({ kind: "users_revoke_menu", offset }));
    case "uok":
      return parseUserId(arg, parts.length, (userId) => ({ kind: "user_approve", userId }));
    case "uno":
      return parseUserId(arg, parts.length, (userId) => ({ kind: "user_reject", userId }));
    case "udel":
      return parseUserId(arg, parts.length, (userId) => ({ kind: "user_revoke", userId }));
    // ---- web-search settings ----
    case "se":
      return parts.length === 2 ? { kind: "search_menu" } : undefined;
    case "sep":
      return parseSearchProvider(arg, parts.length);
    case "sesk":
      return parts.length === 2 ? { kind: "search_set_key_form" } : undefined;
    case "seck":
      return parts.length === 2 ? { kind: "search_clear_key" } : undefined;
    default:
      return undefined;
  }
}

/** Parse a search-provider slug, which must be one SOL knows. */
function parseSearchProvider(
  arg: string | undefined,
  length: number,
): PanelAction | undefined {
  if (length !== 3 || arg === undefined) return undefined;
  if (!isSearchProviderType(arg)) return undefined;
  return { kind: "search_pick", provider: arg };
}

/** Parse an attempt count (1..4). */
function parseAttempts(arg: string | undefined, length: number): PanelAction | undefined {
  if (length !== 3 || arg === undefined) return undefined;
  if (!/^[1-4]$/.test(arg)) return undefined;
  return { kind: "fo_attempts_set", value: Number(arg) };
}

/** Parse a timeout in ms, within the documented 1000..60000 bounds. */
function parseTimeout(arg: string | undefined, length: number): PanelAction | undefined {
  if (length !== 3 || arg === undefined || arg.length === 0) return undefined;
  if (!/^(0|[1-9][0-9]{0,5})$/.test(arg)) return undefined;
  const n = Number(arg);
  if (!Number.isSafeInteger(n) || n < 1000 || n > 60000) return undefined;
  return { kind: "fo_timeout_set", value: n };
}

/** Parse a list position, bounded so a stale index cannot address anything. */
function parseIndex(
  arg: string | undefined,
  length: number,
  build: (index: number) => PanelAction,
): PanelAction | undefined {
  if (length !== 3 || arg === undefined) return undefined;
  if (!/^(0|[1-9][0-9]{0,2})$/.test(arg)) return undefined;
  const n = Number(arg);
  if (!Number.isSafeInteger(n) || n > 200) return undefined;
  return build(n);
}

/** A bare positive id with no zero, used for the two-id confirm action. */
function parseSmallId(arg: string | undefined): number | undefined {
  if (arg === undefined || arg.length === 0) return undefined;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(arg)) return undefined;
  const n = Number(arg);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return n;
}

/** Parse a positive numeric id carried in callback data. */
function parseId(
  arg: string | undefined,
  length: number,
  build: (id: number) => PanelAction,
): PanelAction | undefined {
  if (length !== 3 || arg === undefined || arg.length === 0) return undefined;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(arg)) return undefined;
  const n = Number(arg);
  if (!Number.isSafeInteger(n)) return undefined;
  // Ids are positive: 0 is never a valid row and must not decode.
  if (n <= 0) return undefined;
  return build(n);
}

/** Parse an adapter slug carried in callback data. */
function parseAdapter(
  arg: string | undefined,
  length: number,
): PanelAction | undefined {
  if (length !== 3 || arg === undefined) return undefined;
  if (!isAdapterType(arg)) return undefined;
  return { kind: "ai_add_adapter", adapter: arg };
}

function parseOffset(
  arg: string | undefined,
  length: number,
  build: (offset: number) => PanelAction,
): PanelAction | undefined {
  if (length !== 3 || arg === undefined || arg.length === 0) return undefined;
  // Digits only, no leading zeros: "0" is fine, "007" is not.
  if (!/^(0|[1-9][0-9]*)$/.test(arg)) return undefined;
  const n = Number(arg);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_OFFSET) return undefined;
  return build(n);
}

/**
 * A Telegram chat id is a (possibly negated) integer; supergroups are negative.
 * Anything else — letters, separators, a path, SQL — is rejected outright.
 */
function parseChatId(
  arg: string | undefined,
  length: number,
  build: (chatId: string) => PanelAction,
): PanelAction | undefined {
  if (length !== 3 || arg === undefined) return undefined;
  if (arg.length === 0 || arg.length > MAX_CHAT_ID_LEN) return undefined;
  if (!/^-?[0-9]+$/.test(arg)) return undefined;
  if (!/^-?(0|[1-9][0-9]*)$/.test(arg)) return undefined; // no leading zeros
  const n = Number(arg);
  if (!Number.isSafeInteger(n)) return undefined;
  if (n === 0 || n === -1) return undefined; // not plausible chat ids
  return build(arg);
}

/**
 * A Telegram USER id is a positive integer — never negative.
 *
 * Stricter than {@link parseChatId} on purpose: a user id cannot be negated, so
 * accepting a sign here would let a malformed payload name something the
 * approval table can never contain.
 */
function parseUserId(
  arg: string | undefined,
  length: number,
  build: (userId: string) => PanelAction,
): PanelAction | undefined {
  if (length !== 3 || arg === undefined) return undefined;
  if (arg.length === 0 || arg.length > MAX_CHAT_ID_LEN) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(arg)) return undefined; // digits, no leading zeros
  const n = Number(arg);
  if (!Number.isSafeInteger(n)) return undefined;
  if (n <= 0) return undefined; // user ids are positive
  return build(arg);
}

function clampOffset(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n > MAX_OFFSET ? MAX_OFFSET : n;
}

/**
 * Attempts are bounded to the supported 1..4 so a malformed value can never
 * widen the retry budget beyond what storage enforces.
 */
function clampAttemptsValue(n: number): number {
  if (!Number.isSafeInteger(n)) return 1;
  if (n < 1) return 1;
  return n > 4 ? 4 : n;
}

/** Timeout is bounded to the documented 1000..60000 ms. */
function clampTimeoutValue(n: number): number {
  if (!Number.isSafeInteger(n)) return 15_000;
  if (n < 1000) return 1000;
  return n > 60_000 ? 60_000 : n;
}
