/**
 * MiscRepo — User prefs, owner profile doc, skill trust, shortcuts repository (phase 6).
 *
 * Owns the SQL for: user_prefs, owner_profile, skill_signing_key, skill_trusted_publishers, skill_install_provenance, custom_shortcuts.
 * Extracted from the old Storage god class; method bodies are unchanged,
 * only their home moved. Row shapes stay inside the storage layer.
 */

import { RepoBase } from "./base";
import { StorageError } from "../errors";

/**
 * The owner's ed25519 signing keypair for skill packages (Phase 5, item 1).
 * Single row (id = 1). `privateKeyJwk` is the JWK JSON holding the secret —
 * it is never logged and never returned by any list call.
 */
export interface SkillSigningKeyRow {
  /** SHA-256 hex of the raw 32-byte public key — the publisher id. */
  keyId: string;
  /** Raw 32-byte public key, base64. Safe to share. */
  publicKey: string;
  /** Private key JWK JSON. The secret. */
  privateKeyJwk: string;
  /** unix ms */
  createdAtMs: number;
}

/** One trusted skill-package publisher (Phase 5, item 1). */
export interface TrustedSkillPublisherRow {
  /** SHA-256 hex of the raw 32-byte public key — the publisher id. */
  keyId: string;
  /** Owner-chosen label shown on review cards. */
  label: string;
  /** Raw 32-byte public key, base64; "" when trusted by fingerprint only. */
  publicKey: string;
  /** unix ms */
  addedAtMs: number;
}

/**
 * Install provenance for one skill: which publisher signed it, captured
 * from the verified envelope at import time. `keyId` null = unsigned.
 */
export interface SkillInstallProvenanceRow {
  skillName: string;
  keyId: string | null;
  /** unix ms */
  signedAtMs: number;
}

/** One owner-defined custom shortcut: a command alias. */
export interface CustomShortcut {
  /** Command name without the leading slash, lowercase, e.g. "صبح". */
  name: string;
  /** 'prompt' -> run the action as a prompt; 'tool' -> invoke a tool. */
  kind: "prompt" | "tool";
  /** The prompt text (kind='prompt') or the tool name (kind='tool'). */
  action: string;
  /** Extra tool arguments for kind='tool', JSON object. */
  toolArgs?: Record<string, unknown>;
  /** unix ms */
  createdAt: number;
  /** unix ms */
  updatedAt: number;
}

/** Map a custom_shortcuts row to a record. */
function toCustomShortcut(r: {
  name: string;
  kind: string;
  action: string;
  tool_args: string | null;
  created_at: number;
  updated_at: number;
}): CustomShortcut {
  let toolArgs: Record<string, unknown> | undefined;
  if (r.tool_args !== null && r.tool_args.length > 0) {
    try {
      const parsed: unknown = JSON.parse(r.tool_args);
      if (typeof parsed === "object" && parsed !== null) {
        toolArgs = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON is treated as "no args" rather than a crash - the
      // shortcut itself (name/kind/action) is what matters.
    }
  }
  const out: CustomShortcut = {
    name: r.name,
    kind: r.kind === "tool" ? "tool" : "prompt",
    action: r.action,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (toolArgs !== undefined) out.toolArgs = toolArgs;
  return out;
}

export class MiscRepo extends RepoBase {
  // ---- user preferences (Phase B) ----

  /**
   * Read one per-user preference. Returns undefined when never set.
   *
   * Generic key/value store for per-user switches; the only key in use today
   * is "voice_mode" ("1"/"0", Phase B3 TTS voice replies).
   */
  getUserPref(userId: string, key: string): string | undefined {
    const row = this.query<{ value: string }>(
      `SELECT value FROM user_prefs WHERE user_id=? AND key=?`,
      [userId, key],
    )[0];
    return row?.value;
  }

  /** Upsert one per-user preference. */
  setUserPref(userId: string, key: string, value: string): void {
    this.exec(
      `INSERT INTO user_prefs(user_id, key, value, updated_at_ms) VALUES(?,?,?,?)
       ON CONFLICT(user_id, key) DO UPDATE
       SET value=excluded.value, updated_at_ms=excluded.updated_at_ms`,
      [userId, key, value, Date.now()],
    );
  }

  /**
   * Phase-5 dashboard: keys of one user's prefs starting with a prefix
   * (e.g. the `gacfg:` group-assistant configs). Additive read-only helper;
   * LIKE wildcards in the prefix are escaped so the match is literal.
   */
  listUserPrefKeys(userId: string, prefix: string): string[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.query<{ key: string }>(
      `SELECT key FROM user_prefs WHERE user_id=? AND key LIKE ? ESCAPE '\\' ORDER BY key ASC`,
      [userId, `${escaped}%`],
    ).map((r) => r.key);
  }

  // ---- owner profile (schema 23, platform Phase 4) ----

  /**
   * The serialized owner-profile document, or undefined when none has been
   * stored yet. Single-row data (there is exactly one owner): the document
   * is opaque JSON owned by src/profile/owner_profile.ts — this layer never
   * parses it, so a corrupt doc reads back verbatim and the profile layer
   * decides what to do with it.
   */
  getOwnerProfileDoc(): string | undefined {
    const row = this.query<{ doc: string }>(
      `SELECT doc FROM owner_profile WHERE id=1`,
    )[0];
    return row?.doc;
  }

  /** Store (or replace) the serialized owner-profile document. Single row, id = 1. */
  setOwnerProfileDoc(doc: string): void {
    this.exec(
      `INSERT INTO owner_profile(id, doc, updated_at_ms) VALUES(1,?,?)
       ON CONFLICT(id) DO UPDATE
       SET doc=excluded.doc, updated_at_ms=excluded.updated_at_ms`,
      [doc, Date.now()],
    );
  }

  // ---- phase 5, item 1: skill package signing ----

  /**
   * The owner's signing keypair, if `/skill keygen` has run. The returned
   * row carries the private key — callers must never log it or send it
   * anywhere except the explicit key-export path.
   */
  getSkillSigningKey(): SkillSigningKeyRow | undefined {
    const rows = this.query<{
      key_id: string;
      public_key: string;
      private_key_jwk: string;
      created_at_ms: number;
    }>(`SELECT key_id, public_key, private_key_jwk, created_at_ms FROM skill_signing_key WHERE id=1`);
    const r = rows[0];
    if (r === undefined) return undefined;
    return {
      keyId: r.key_id,
      publicKey: r.public_key,
      privateKeyJwk: r.private_key_jwk,
      createdAtMs: r.created_at_ms,
    };
  }

  /** Store (or replace) the owner's signing keypair. Single row, id = 1. */
  setSkillSigningKey(key: { keyId: string; publicKey: string; privateKeyJwk: string }): void {
    this.exec(
      `INSERT INTO skill_signing_key(id, key_id, public_key, private_key_jwk, created_at_ms)
       VALUES(1,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         key_id=excluded.key_id, public_key=excluded.public_key,
         private_key_jwk=excluded.private_key_jwk, created_at_ms=excluded.created_at_ms`,
      [key.keyId, key.publicKey, key.privateKeyJwk, Date.now()],
    );
  }

  /** Trust a publisher's key: upsert by fingerprint, refreshing the label. */
  trustSkillPublisher(p: { keyId: string; label: string; publicKey: string }): { added: boolean } {
    const existing = this.getTrustedSkillPublisher(p.keyId);
    const now = Date.now();
    if (existing === undefined) {
      this.exec(
        `INSERT INTO skill_trusted_publishers(key_id, label, public_key, added_at_ms)
         VALUES(?,?,?,?)`,
        [p.keyId, p.label, p.publicKey, now],
      );
      return { added: true };
    }
    // Keep the known public key when the new trust carries none (trusted by
    // fingerprint), but prefer a freshly supplied one.
    const publicKey = p.publicKey !== "" ? p.publicKey : existing.publicKey;
    this.exec(
      `UPDATE skill_trusted_publishers SET label=?, public_key=? WHERE key_id=?`,
      [p.label, publicKey, p.keyId],
    );
    return { added: false };
  }

  /** Revoke trust in a publisher. Returns false when it was not trusted. */
  untrustSkillPublisher(keyId: string): boolean {
    const res = this.exec(`DELETE FROM skill_trusted_publishers WHERE key_id=?`, [keyId]);
    return (res.changes as number) > 0;
  }

  getTrustedSkillPublisher(keyId: string): TrustedSkillPublisherRow | undefined {
    const rows = this.query<{
      key_id: string;
      label: string;
      public_key: string;
      added_at_ms: number;
    }>(`SELECT key_id, label, public_key, added_at_ms FROM skill_trusted_publishers WHERE key_id=?`, [
      keyId,
    ]);
    const r = rows[0];
    if (r === undefined) return undefined;
    return { keyId: r.key_id, label: r.label, publicKey: r.public_key, addedAtMs: r.added_at_ms };
  }

  listTrustedSkillPublishers(): TrustedSkillPublisherRow[] {
    return this.query<{
      key_id: string;
      label: string;
      public_key: string;
      added_at_ms: number;
    }>(
      `SELECT key_id, label, public_key, added_at_ms FROM skill_trusted_publishers ORDER BY added_at_ms ASC`,
    ).map((r) => ({
      keyId: r.key_id,
      label: r.label,
      publicKey: r.public_key,
      addedAtMs: r.added_at_ms,
    }));
  }

  /**
   * Record which publisher signed an installed skill (null = unsigned),
   * from the verified envelope at import time. Upserted per skill name.
   */
  recordSkillInstallProvenance(p: { skillName: string; keyId: string | null }): void {
    this.exec(
      `INSERT INTO skill_install_provenance(skill_name, key_id, signed_at_ms)
       VALUES(?,?,?)
       ON CONFLICT(skill_name) DO UPDATE SET
         key_id=excluded.key_id, signed_at_ms=excluded.signed_at_ms`,
      [p.skillName, p.keyId, Date.now()],
    );
  }

  /** Drop a skill's provenance row (on uninstall). */
  removeSkillInstallProvenance(skillName: string): void {
    this.exec(`DELETE FROM skill_install_provenance WHERE skill_name=?`, [skillName]);
  }

  getSkillInstallProvenance(skillName: string): SkillInstallProvenanceRow | undefined {
    const rows = this.query<{ skill_name: string; key_id: string | null; signed_at_ms: number }>(
      `SELECT skill_name, key_id, signed_at_ms FROM skill_install_provenance WHERE skill_name=?`,
      [skillName],
    );
    const r = rows[0];
    if (r === undefined) return undefined;
    return { skillName: r.skill_name, keyId: r.key_id, signedAtMs: r.signed_at_ms };
  }

  // ---- custom shortcuts ----

  /**
   * All owner-defined shortcuts, alphabetical by name.
   *
   * This is owner configuration data, not conversation content; there is no
   * per-user scoping - the whole table belongs to the bot owner.
   */
  listShortcuts(): CustomShortcut[] {
    return this.query<{
      name: string;
      kind: string;
      action: string;
      tool_args: string | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT name, kind, action, tool_args, created_at, updated_at
         FROM custom_shortcuts ORDER BY name ASC`,
    ).map(toCustomShortcut);
  }

  /** One shortcut by name (lowercase, no leading slash), or undefined. */
  getShortcut(name: string): CustomShortcut | undefined {
    const rows = this.query<{
      name: string;
      kind: string;
      action: string;
      tool_args: string | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT name, kind, action, tool_args, created_at, updated_at
         FROM custom_shortcuts WHERE name=?`,
      [name],
    );
    const r = rows[0];
    return r === undefined ? undefined : toCustomShortcut(r);
  }

  /**
   * Insert or replace a shortcut. `kind` must be 'prompt' or 'tool';
   * a bad value is refused here with a clear message rather than at the
   * database CHECK constraint.
   */
  upsertShortcut(s: {
    name: string;
    kind: string;
    action: string;
    toolArgs?: Record<string, unknown>;
  }): void {
    if (s.kind !== "prompt" && s.kind !== "tool") {
      throw new StorageError("query", `invalid shortcut kind: ${s.kind}`);
    }
    const now = Date.now();
    this.exec(
      `INSERT INTO custom_shortcuts(name, kind, action, tool_args, created_at, updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         kind=excluded.kind, action=excluded.action,
         tool_args=excluded.tool_args, updated_at=excluded.updated_at`,
      [s.name, s.kind, s.action, s.toolArgs ? JSON.stringify(s.toolArgs) : null, now, now],
    );
  }

  /** Delete one shortcut. Returns whether a row went. */
  deleteShortcut(name: string): boolean {
    const res = this.exec(`DELETE FROM custom_shortcuts WHERE name=?`, [name]);
    return (res.changes as number) > 0;
  }
}

/** DDL fragment owned by this repository (phase 6). The Storage facade
 *  assembles the full SCHEMA from the domain fragments in a fixed order;
 *  the statements themselves are byte-identical to the pre-split schema. */
export const MISC_SCHEMA = `

-- Generic per-user preferences (Phase B: voice_mode for TTS replies, and any
-- future per-user switches). One row per (user, key); upserted, never appended.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Phase 5, item 1 — skill package signing. The owner's ed25519 keypair,
-- single row. The private key lives ONLY here: it is never logged, never
-- sent over any channel, and only leaves through the explicit
-- "/skill keyexport" path. At-rest protection is the database file itself
-- (same class as conversation contents); see docs/PHASE5_SKILL_SIGNING.md
-- for the attack-surface review.
CREATE TABLE IF NOT EXISTS skill_signing_key (
  id              INTEGER PRIMARY KEY CHECK(id = 1),
  key_id          TEXT NOT NULL,
  public_key      TEXT NOT NULL,
  private_key_jwk TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL
);

-- Owner-maintained trusted-publisher registry: key fingerprint -> label.
-- Trust in a signing key comes ONLY from this table; the envelope's own
-- public key is never trusted by itself. Revocation = deleting the row.
CREATE TABLE IF NOT EXISTS skill_trusted_publishers (
  key_id      TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  public_key  TEXT NOT NULL DEFAULT '',
  added_at_ms INTEGER NOT NULL
);

-- Install provenance: which publisher (if any) signed each installed skill,
-- captured from the verified envelope at import time. key_id NULL = the
-- skill was installed unsigned. Survives untrust so "/skill list" can flag
-- skills whose publisher was later revoked.
CREATE TABLE IF NOT EXISTS skill_install_provenance (
  skill_name   TEXT PRIMARY KEY,
  key_id       TEXT,
  signed_at_ms INTEGER NOT NULL
);

-- Owner-defined custom command shortcuts (schema 21). name is stored
-- lowercase, without the leading slash. kind is 'prompt' (action = prompt
-- text, run through the engine as a user message) or 'tool' (action = tool
-- name, tool_args = JSON object of extra arguments).
CREATE TABLE IF NOT EXISTS custom_shortcuts (
  name       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK(kind IN ('prompt','tool')),
  action     TEXT NOT NULL,
  tool_args  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Owner profile (schema 23, platform Phase 4). Single row (id = 1): there
-- is exactly one owner, so the document needs no user_id column. The doc
-- column is the serialized OwnerProfile JSON (see
-- src/profile/owner_profile.ts); this layer stores it opaquely.
CREATE TABLE IF NOT EXISTS owner_profile (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  doc           TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`;
