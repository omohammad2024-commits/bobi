/**
 * Per-group moderation config (Stage-3 differentiator — Hermes has no group
 * moderation, so there is no parity surface to match; this is new).
 *
 * ATTACK SURFACE / DESIGN NOTES (reviewed as part of the WIN criterion):
 *
 * 1. Default-off. Every field defaults to the least intrusive value and the
 *    whole module defaults to DISABLED per group. A group gets moderation
 *    only when the bot owner explicitly opts it in — a non-owner group admin
 *    cannot enable it, because config writes go through the owner's id (see
 *    below) and the wiring layer is told to expose config only via owner-only
 *    commands/panels.
 * 2. Owner-scoped storage. Config is persisted in `user_prefs` under the
 *    OWNER's user id with key `modcfg:<chatId>` (not under a group id and not
 *    under the requester's id). Rationale: moderation config is an
 *    owner-controlled security policy, not group metadata. Namespacing under
 *    the owner id makes the trust boundary explicit — reading `user_prefs`
 *    for user X can never surface another user's policy — and the `<chatId>`
 *    suffix gives per-group isolation (group A's config cannot affect B).
 * 3. Strict validation. `setModConfig` rejects unknown fields outright (no
 *    silent schema drift an attacker could use to smuggle options) and bounds
 *    every number, so a malicious/compromised admin client cannot set
 *    floodMaxMessages=0 (which would flag every message) or
 *    floodWindowSec=999999 (which would make flood state grow unbounded).
 * 4. Fail-closed reads. A missing, corrupt, or schema-invalid stored blob
 *    yields the default config (disabled). Corrupt state can never enable
 *    moderation by accident.
 */
import type { Storage } from "../storage/storage";

/** What the bot does when a link is detected in a moderated group. */
export type LinkPolicy = "allow" | "warn" | "delete";

export interface ModConfig {
  /** Master switch. Default false — moderation is strictly opt-in per group. */
  enabled: boolean;
  /** Caps/emoji/repetition + forwarded-loop detectors. Default true. */
  antiSpam: boolean;
  /** Link handling. Default "allow" (least intrusive). */
  linkPolicy: LinkPolicy;
  /** Persian profanity filter. Default true. */
  profanityFilter: boolean;
  /** Flood window in seconds. Bounds: 5..300. Default 10. */
  floodWindowSec: number;
  /** Messages within the window that trip the flood detector. Bounds: 2..50. Default 5. */
  floodMaxMessages: number;
}

export const DEFAULT_MOD_CONFIG: Readonly<ModConfig> = {
  enabled: false,
  antiSpam: true,
  linkPolicy: "allow",
  profanityFilter: true,
  floodWindowSec: 10,
  floodMaxMessages: 5,
};

export const FLOOD_WINDOW_SEC_MIN = 5;
export const FLOOD_WINDOW_SEC_MAX = 300;
export const FLOOD_MAX_MESSAGES_MIN = 2;
export const FLOOD_MAX_MESSAGES_MAX = 50;

const LINK_POLICIES: ReadonlySet<string> = new Set(["allow", "warn", "delete"]);

/**
 * Storage key for a group's config. The owner id is the `user_id` row key;
 * the chat id only scopes which group's policy this row holds.
 */
export function modConfigKey(chatId: string): string {
  return `modcfg:${chatId}`;
}

export type ModConfigValidation =
  | { ok: true; config: ModConfig }
  | { ok: false; errors: string[] };

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "enabled",
  "antiSpam",
  "linkPolicy",
  "profanityFilter",
  "floodWindowSec",
  "floodMaxMessages",
]);

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= min &&
    v <= max
  );
}

/**
 * Strictly validate a caller-supplied config patch.
 *
 * Unknown fields are REJECTED (not ignored) so a compromised caller cannot
 * smuggle unexpected options past the validator; numeric fields are
 * integer-bounded so flood state cannot be made degenerate or unbounded.
 * Accepts partial input — missing fields fall back to the current stored
 * config (or defaults).
 */
export function validateModConfig(
  input: unknown,
  base: ModConfig = { ...DEFAULT_MOD_CONFIG },
): ModConfigValidation {
  const errors: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["config must be an object"] };
  }
  const patch = input as Record<string, unknown>;

  for (const key of Object.keys(patch)) {
    if (!KNOWN_FIELDS.has(key)) {
      errors.push(`unknown field: ${key}`);
    }
  }

  const next: ModConfig = { ...base };

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") errors.push("enabled must be boolean");
    else next.enabled = patch.enabled;
  }
  if (patch.antiSpam !== undefined) {
    if (typeof patch.antiSpam !== "boolean") errors.push("antiSpam must be boolean");
    else next.antiSpam = patch.antiSpam;
  }
  if (patch.profanityFilter !== undefined) {
    if (typeof patch.profanityFilter !== "boolean")
      errors.push("profanityFilter must be boolean");
    else next.profanityFilter = patch.profanityFilter;
  }
  if (patch.linkPolicy !== undefined) {
    if (typeof patch.linkPolicy !== "string" || !LINK_POLICIES.has(patch.linkPolicy)) {
      errors.push('linkPolicy must be "allow" | "warn" | "delete"');
    } else {
      next.linkPolicy = patch.linkPolicy as LinkPolicy;
    }
  }
  if (patch.floodWindowSec !== undefined) {
    if (!isIntInRange(patch.floodWindowSec, FLOOD_WINDOW_SEC_MIN, FLOOD_WINDOW_SEC_MAX)) {
      errors.push(
        `floodWindowSec must be an integer ${FLOOD_WINDOW_SEC_MIN}..${FLOOD_WINDOW_SEC_MAX}`,
      );
    } else {
      next.floodWindowSec = patch.floodWindowSec;
    }
  }
  if (patch.floodMaxMessages !== undefined) {
    if (
      !isIntInRange(patch.floodMaxMessages, FLOOD_MAX_MESSAGES_MIN, FLOOD_MAX_MESSAGES_MAX)
    ) {
      errors.push(
        `floodMaxMessages must be an integer ${FLOOD_MAX_MESSAGES_MIN}..${FLOOD_MAX_MESSAGES_MAX}`,
      );
    } else {
      next.floodMaxMessages = patch.floodMaxMessages;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: next };
}

/** Minimal pref-store surface this module needs; `Storage` satisfies it. */
export type ModPrefStore = Pick<Storage, "getUserPref" | "setUserPref">;

/**
 * Read a group's moderation config.
 *
 * Fail-closed: missing row, unparseable JSON, or a blob that no longer
 * validates yields the default (disabled) config. Corrupt state can never
 * silently turn moderation on.
 */
export function getModConfig(
  store: ModPrefStore | undefined,
  ownerId: string,
  chatId: string,
): ModConfig {
  if (store === undefined || ownerId.length === 0) return { ...DEFAULT_MOD_CONFIG };
  let raw: string | undefined;
  try {
    raw = store.getUserPref(ownerId, modConfigKey(chatId));
  } catch {
    return { ...DEFAULT_MOD_CONFIG };
  }
  if (raw === undefined) return { ...DEFAULT_MOD_CONFIG };
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = validateModConfig(parsed);
    return validated.ok ? validated.config : { ...DEFAULT_MOD_CONFIG };
  } catch {
    return { ...DEFAULT_MOD_CONFIG };
  }
}

/**
 * Persist a group's moderation config (owner-only by construction: callers
 * must pass the bot owner's id and gate the call behind an owner check).
 *
 * Returns the validation result; NOTHING is written when validation fails.
 */
export function setModConfig(
  store: ModPrefStore | undefined,
  ownerId: string,
  chatId: string,
  patch: unknown,
): ModConfigValidation {
  if (store === undefined || ownerId.length === 0) {
    return { ok: false, errors: ["storage or owner id unavailable"] };
  }
  const current = getModConfig(store, ownerId, chatId);
  const validated = validateModConfig(patch, current);
  if (!validated.ok) return validated;
  store.setUserPref(ownerId, modConfigKey(chatId), JSON.stringify(validated.config));
  return validated;
}
