/**
 * Phase 4, item 5 — skill sharing between BOBI instances.
 *
 * A skill package (`.bobiskill`) is a single, inspectable JSON file: the
 * exact installed `.md` bytes plus metadata (name, version, description,
 * declared capabilities, source-instance info) and a SHA-256 checksum over
 * the canonical payload. No binary blobs.
 *
 * Phase 5, item 1 adds an OPTIONAL `signature` block: ed25519 over the same
 * canonical payload bytes the checksum covers, plus the signer's public key
 * and its fingerprint (`keyId`, the publisher identity). The format version
 * stays 1 — the block is additive, so older readers still verify the
 * checksum and simply ignore the signature.
 *
 * Trust model (deliberate, see docs/PHASE5_SKILL_SIGNING.md):
 * - The checksum only detects tampering of the envelope in transit. It is
 *   NOT a signature: anyone can mint a valid package, so a valid checksum
 *   says nothing about the author's trustworthiness.
 * - A VALID signature proves the package bytes were signed by the holder of
 *   the private key — but trust in the key itself comes ONLY from the
 *   owner's trusted-publisher registry (`/skill trust`). A signature from
 *   an unknown key is shown as such, never as trusted.
 * - The real trust boundary is still the SAME phase-3 pipeline every fresh
 *   install goes through: 64KB cap, frontmatter validation,
 *   prompt-injection scan (fa+en), SSRF-guarded fetch for the URL form —
 *   plus the mandatory owner review card, plus disabled-by-default on
 *   import. `planSkillImport` reuses `prepareSkillInstall` end to end.
 * - The owner must only import packages from sources they trust. Skills
 *   grant no permissions and execute no code, but a skill body becomes
 *   system-prompt context, so a hostile body is a prompt-injection vector.
 */

import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSkillFile } from "./loader";
import {
  fingerprintPublicKey,
  signCanonicalPayload,
  verifyCanonicalSignature,
  SigningError,
  SIGNATURE_ALG,
} from "./signing";
import {
  prepareSkillInstall,
  readInstalledSkill,
  scanSkillBody,
  type SkillValidationError,
  type ValidatedSkill,
} from "./install";
import { SKILLS_MAX_FILE_BYTES } from "./types";
import type { Skill } from "./types";

// ------------------------------------------------------------- envelope ----

/** Magic marker every package envelope carries. */
export const SKILL_PACKAGE_FORMAT = "bobi-skill-package";

/** Envelope schema version this code writes and reads. */
export const SKILL_PACKAGE_FORMAT_VERSION = 1;

/** File extension for exported packages. */
export const SKILL_PACKAGE_EXT = ".bobiskill";

/** Package envelope metadata: where the package came from, what it declares. */
export interface SkillPackageMetadata {
  /** ISO-8601 timestamp of the export. */
  exportedAt: string;
  /** Hostname of the exporting instance ("unknown" when unreadable). */
  sourceInstance: string;
  /**
   * Declared capabilities. Skills NEVER grant permissions and NEVER execute
   * code — this is informational only: always includes "prompt-context"
   * (the body is injected into the system prompt), plus "external-links"
   * when the body references URLs, plus "flagged:<kind>" entries for the
   * warnings the export-time scan found. Import re-scans anyway.
   */
  capabilities: string[];
}

/** The parsed, verified content of a package (checksum already checked). */
export interface VerifiedSkillPackage {
  /** Exact `.md` bytes of the skill, as exported. */
  skillFile: string;
  name: string;
  version?: string;
  description: string;
  triggers: readonly string[];
  metadata: SkillPackageMetadata;
  /**
   * Present when the envelope carries a `signature` block that verified.
   * `keyId` is bound to `publicKeyB64` (recomputed, not trusted from the
   * envelope), so it is the real publisher identity.
   */
  signature?: { keyId: string; publicKeyB64: string };
}

export type PackageVerifyError =
  | { kind: "too_large"; bytes: number; maxBytes: number }
  | { kind: "not_json" }
  | { kind: "bad_envelope"; reason: string }
  | { kind: "checksum_mismatch" }
  | { kind: "bad_signature"; reason: string };

/**
 * Build the canonical payload string the checksum covers.
 *
 * Keys are constructed in a fixed order (not taken from the parsed object)
 * so the checksum is stable regardless of how the JSON was formatted or
 * re-serialized. The `checksum` field itself is never part of the payload.
 */
function canonicalPayload(input: {
  name: string;
  version: string | undefined;
  description: string;
  triggers: readonly string[];
  skillFile: string;
  metadata: SkillPackageMetadata;
}): string {
  return JSON.stringify({
    format: SKILL_PACKAGE_FORMAT,
    formatVersion: SKILL_PACKAGE_FORMAT_VERSION,
    skill: {
      name: input.name,
      version: input.version ?? null,
      description: input.description,
      triggers: [...input.triggers],
      skillFile: input.skillFile,
    },
    metadata: {
      exportedAt: input.metadata.exportedAt,
      sourceInstance: input.metadata.sourceInstance,
      capabilities: [...input.metadata.capabilities],
    },
  });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --------------------------------------------------------------- signing ----

/**
 * Validate the envelope's `signature` block against the canonical payload.
 *
 * Every check must pass: block shape, algorithm tag, public-key shape,
 * key-id binding (claimed keyId === actual fingerprint of the block's
 * public key), and the ed25519 signature itself. A single failure rejects
 * the whole package — there is no partial trust.
 */
function checkSignatureBlock(
  sigRaw: unknown,
  canonical: string,
): { ok: true; info: { keyId: string; publicKeyB64: string } } | { ok: false; reason: string } {
  if (typeof sigRaw !== "object" || sigRaw === null) {
    return { ok: false, reason: "signature block is not an object" };
  }
  const b = sigRaw as Record<string, unknown>;
  if (b["alg"] !== SIGNATURE_ALG) {
    return { ok: false, reason: `unsupported signature algorithm` };
  }
  const keyId = b["keyId"];
  if (typeof keyId !== "string" || !/^[0-9a-f]{64}$/.test(keyId)) {
    return { ok: false, reason: "signature has a malformed key id" };
  }
  const publicKey = b["publicKey"];
  if (typeof publicKey !== "string") {
    return { ok: false, reason: "signature has a malformed public key" };
  }
  // Bind the claimed publisher id to the actual key: the fingerprint must
  // match, otherwise a valid signature could be transplanted under a
  // different (e.g. trusted) identity.
  let bound: string;
  try {
    bound = fingerprintPublicKey(publicKey);
  } catch (err) {
    if (err instanceof SigningError) {
      return { ok: false, reason: "signature has a malformed public key" };
    }
    throw err;
  }
  if (bound !== keyId.toLowerCase()) {
    return { ok: false, reason: "signature key id does not match its public key" };
  }
  const sig = b["sig"];
  if (typeof sig !== "string") {
    return { ok: false, reason: "signature is missing" };
  }
  // Extra fields inside the block are ignored (forward-compatible); the
  // 32-byte key shape was already enforced by the fingerprint step above.
  if (!verifyCanonicalSignature(canonical, publicKey, sig)) {
    return { ok: false, reason: "signature does not match the package content" };
  }
  return { ok: true, info: { keyId: keyId.toLowerCase(), publicKeyB64: publicKey } };
}

// --------------------------------------------------------------- export ----

export type SkillExportError =
  | { kind: "not_found"; name: string }
  | { kind: "too_large"; name: string }
  | { kind: "signer_invalid"; name: string };

export interface BuiltSkillPackage {
  /** Suggested filename, e.g. "memory-coach.bobiskill". */
  fileName: string;
  /** The full package text (UTF-8 JSON). */
  text: string;
  skillName: string;
  version?: string;
  checksum: string;
  /** True when the envelope carries a signature block. */
  signed: boolean;
  /** Publisher id (key fingerprint) when signed. */
  keyId?: string;
}

/**
 * Key material for signing an export. `keyId` is DERIVED from `publicKeyB64`
 * at export time (single source of truth) — callers pass only the key pair.
 */
export interface PackageSigner {
  /** Raw 32-byte ed25519 public key, base64. */
  publicKeyB64: string;
  /** Private key JWK JSON (as stored by `/skill keygen`). */
  privateKeyJwk: string;
}

function instanceLabel(): string {
  try {
    const h = hostname();
    return h.length > 0 ? h : "unknown";
  } catch {
    return "unknown";
  }
}

/** Declared capabilities for the export metadata (informational only). */
function deriveCapabilities(skill: Skill): string[] {
  const caps = ["prompt-context"];
  if (/https?:\/\//i.test(skill.body)) caps.push("external-links");
  for (const w of scanSkillBody(skill)) {
    const flag = `flagged:${w.kind}`;
    if (!caps.includes(flag)) caps.push(flag);
  }
  return caps;
}

/**
 * Export one installed skill (enabled or disabled) as a portable package.
 *
 * Pure over the skills directory: reads the installed file, writes nothing.
 * The embedded `skillFile` is the exact installed `.md` bytes, so import
 * re-validates precisely what the exporting instance had on disk.
 *
 * When `opts.signer` is given, the envelope gains a `signature` block:
 * ed25519 over the same canonical payload bytes the checksum covers, plus
 * the public key and its fingerprint (`keyId`). A corrupt signer (key id
 * that does not match the public key, unusable private key) fails the
 * export rather than shipping a package that could never verify.
 */
export function buildSkillPackage(
  dir: string,
  name: string,
  opts: { signer?: PackageSigner; exportedAt?: string } = {},
): { ok: true; pkg: BuiltSkillPackage } | { ok: false; error: SkillExportError } {
  const clean = name.trim().toLowerCase();
  const abs = resolve(dir);
  const found = readInstalledSkill(dir, clean);
  if (found === undefined) return { ok: false, error: { kind: "not_found", name: clean } };

  // The raw file bytes (not the re-serialized skill): import re-runs the
  // loader's own parser over exactly these bytes.
  const enabledPath = join(abs, `${clean}.md`);
  const disabledPath = join(abs, `.disabled-${clean}.md`);
  const path = existsSync(enabledPath) ? enabledPath : disabledPath;
  let skillFile: string;
  try {
    skillFile = readFileSync(path, "utf8");
  } catch {
    return { ok: false, error: { kind: "not_found", name: clean } };
  }

  const skill = found.skill;
  const metadata: SkillPackageMetadata = {
    exportedAt: opts.exportedAt ?? new Date().toISOString(),
    sourceInstance: instanceLabel(),
    capabilities: deriveCapabilities(skill),
  };
  const payload = {
    name: skill.name,
    version: skill.version,
    description: skill.description,
    triggers: skill.triggers,
    skillFile,
    metadata,
  };
  const canonical = canonicalPayload(payload);
  const checksum = sha256Hex(canonical);

  // Optional signature: derived keyId is the single source of truth, and a
  // signer whose parts disagree fails closed here, at export time.
  let signature: { alg: string; keyId: string; publicKey: string; sig: string } | undefined;
  let keyId: string | undefined;
  if (opts.signer !== undefined) {
    try {
      keyId = fingerprintPublicKey(opts.signer.publicKeyB64);
      const sig = signCanonicalPayload(canonical, opts.signer.privateKeyJwk);
      signature = { alg: SIGNATURE_ALG, keyId, publicKey: opts.signer.publicKeyB64, sig };
    } catch (err) {
      if (err instanceof SigningError) {
        return { ok: false, error: { kind: "signer_invalid", name: clean } };
      }
      throw err;
    }
  }

  // Pretty-printed so the owner can eyeball a package before importing it.
  // The checksum covers the canonical (compact) form, so formatting is free.
  // The signature block is excluded from the signed bytes (it signs the
  // canonical payload, not itself) for the same reason.
  const text = JSON.stringify(
    {
      format: SKILL_PACKAGE_FORMAT,
      formatVersion: SKILL_PACKAGE_FORMAT_VERSION,
      skill: {
        name: payload.name,
        ...(payload.version !== undefined ? { version: payload.version } : {}),
        description: payload.description,
        triggers: [...payload.triggers],
        skillFile: payload.skillFile,
      },
      metadata: payload.metadata,
      ...(signature !== undefined ? { signature } : {}),
      checksum,
    },
    null,
    2,
  );
  if (Buffer.byteLength(text, "utf8") > SKILLS_MAX_FILE_BYTES) {
    // Same cap as every other skill intake path: a package that does not fit
    // cannot travel through chat. (Skills near the 64KB ceiling hit this;
    // the doc notes the practical limit.)
    return { ok: false, error: { kind: "too_large", name: clean } };
  }
  return {
    ok: true,
    pkg: {
      fileName: `${skill.name}${SKILL_PACKAGE_EXT}`,
      text,
      skillName: skill.name,
      ...(skill.version !== undefined ? { version: skill.version } : {}),
      checksum,
      signed: signature !== undefined,
      ...(keyId !== undefined ? { keyId } : {}),
    },
  };
}

// --------------------------------------------------------------- verify ----

/**
 * Verify a package envelope: size cap, JSON shape, format marker, checksum,
 * then — when the envelope carries one — the ed25519 signature block.
 *
 * Pure. A checksum mismatch means the envelope was altered after export —
 * reject it with a clear message. (Anyone can mint a valid package, so a
 * MATCHING checksum is not trust — see the module docstring.)
 *
 * A PRESENT signature must verify fully or the package is hard-rejected:
 * shape, algorithm, key-id binding (the claimed keyId must be the actual
 * fingerprint of the envelope's public key — no transplanting a valid
 * signature under a different publisher id), and the signature itself over
 * the canonical payload bytes. There is no "invalid but importable" state.
 */
export function verifySkillPackage(
  text: string,
): { ok: true; pkg: VerifiedSkillPackage } | { ok: false; error: PackageVerifyError } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > SKILLS_MAX_FILE_BYTES) {
    return { ok: false, error: { kind: "too_large", bytes, maxBytes: SKILLS_MAX_FILE_BYTES } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: "not_json" } };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: { kind: "bad_envelope", reason: "not an object" } };
  }
  const env = raw as Record<string, unknown>;
  if (env["format"] !== SKILL_PACKAGE_FORMAT) {
    return { ok: false, error: { kind: "bad_envelope", reason: "unknown format marker" } };
  }
  if (env["formatVersion"] !== SKILL_PACKAGE_FORMAT_VERSION) {
    return { ok: false, error: { kind: "bad_envelope", reason: "unsupported format version" } };
  }
  const skillRaw = env["skill"];
  if (typeof skillRaw !== "object" || skillRaw === null) {
    return { ok: false, error: { kind: "bad_envelope", reason: "missing skill section" } };
  }
  const s = skillRaw as Record<string, unknown>;
  if (typeof s["name"] !== "string" || typeof s["description"] !== "string" || typeof s["skillFile"] !== "string") {
    return { ok: false, error: { kind: "bad_envelope", reason: "skill section is incomplete" } };
  }
  const version = s["version"];
  if (version !== undefined && typeof version !== "string") {
    return { ok: false, error: { kind: "bad_envelope", reason: "bad version field" } };
  }
  const triggers = s["triggers"];
  const triggerList: readonly string[] =
    Array.isArray(triggers) && triggers.every((t) => typeof t === "string")
      ? (triggers as string[])
      : [];
  const metaRaw = env["metadata"];
  const metadata: SkillPackageMetadata =
    typeof metaRaw === "object" && metaRaw !== null
      ? {
          exportedAt: typeof (metaRaw as Record<string, unknown>)["exportedAt"] === "string"
            ? ((metaRaw as Record<string, unknown>)["exportedAt"] as string)
            : "unknown",
          sourceInstance: typeof (metaRaw as Record<string, unknown>)["sourceInstance"] === "string"
            ? ((metaRaw as Record<string, unknown>)["sourceInstance"] as string)
            : "unknown",
          capabilities:
            Array.isArray((metaRaw as Record<string, unknown>)["capabilities"]) &&
            ((metaRaw as Record<string, unknown>)["capabilities"] as unknown[]).every((c) => typeof c === "string")
              ? (((metaRaw as Record<string, unknown>)["capabilities"] as string[]).slice())
              : [],
        }
      : { exportedAt: "unknown", sourceInstance: "unknown", capabilities: [] };

  const checksum = env["checksum"];
  if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) {
    return { ok: false, error: { kind: "bad_envelope", reason: "missing or malformed checksum" } };
  }
  const canonical = canonicalPayload({
    name: s["name"] as string,
    version: version as string | undefined,
    description: s["description"] as string,
    triggers: triggerList,
    skillFile: s["skillFile"] as string,
    metadata,
  });
  const recomputed = sha256Hex(canonical);
  if (recomputed !== checksum) {
    return { ok: false, error: { kind: "checksum_mismatch" } };
  }

  // Optional signature block: present means it MUST verify, or hard reject.
  let signature: { keyId: string; publicKeyB64: string } | undefined;
  const sigRaw = env["signature"];
  if (sigRaw !== undefined) {
    const checked = checkSignatureBlock(sigRaw, canonical);
    if (!checked.ok) {
      return { ok: false, error: { kind: "bad_signature", reason: checked.reason } };
    }
    signature = checked.info;
  }

  return {
    ok: true,
    pkg: {
      skillFile: s["skillFile"] as string,
      name: s["name"] as string,
      ...(typeof version === "string" ? { version } : {}),
      description: s["description"] as string,
      triggers: triggerList,
      metadata,
      ...(signature !== undefined ? { signature } : {}),
    },
  };
}

// -------------------------------------------------------------- versions ----

/** Numeric dot-parts of a version label; missing/invalid labels read as 0.0.0. */
function numericParts(v: string | undefined): [number, number, number] {
  if (v === undefined) return [0, 0, 0];
  const parts = v.split(".").map((p) => {
    const m = /^(\d+)/.exec(p.trim());
    return m !== null ? Number.parseInt(m[1]!, 10) : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * Compare two version labels. -1 when a < b, 0 when equal, 1 when a > b.
 * A missing or unparsable label compares as 0.0.0.
 */
export function compareSkillVersions(a: string | undefined, b: string | undefined): -1 | 0 | 1 {
  const pa = numericParts(a);
  const pb = numericParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}

// --------------------------------------------------------------- import ----

/**
 * How the package version relates to the installed one.
 * - "new": no skill with this name is installed.
 * - "upgrade"/"downgrade"/"same": both sides declare a version.
 * - "unknown": a skill is installed but at least one side has no version.
 */
export type VersionState = "new" | "upgrade" | "downgrade" | "same" | "unknown";

export interface SkillImportPlan {
  /** The package's skill text, run through the full install validation pipeline. */
  validated: ValidatedSkill;
  /** Exact `.md` bytes from the package (kept for approve-time re-validation). */
  skillFile: string;
  packageVersion?: string;
  installedVersion?: string;
  versionState: VersionState;
  metadata: SkillPackageMetadata;
  sourceLabel: string;
  /**
   * Present when the package carried a VERIFIED signature block.
   * `trusted` is resolved against the owner's registry at plan time — the
   * approve path re-resolves it, so a trust change between review and
   * approval takes effect.
   */
  signature?: { keyId: string; publicKeyB64: string; trusted: boolean };
}

export type SkillImportError = PackageVerifyError | SkillValidationError;

/**
 * Plan a package import: verify the envelope, then run the EXISTING install
 * validation pipeline (`prepareSkillInstall`) over the embedded skill text —
 * size cap, frontmatter parse, collision/limit checks — exactly like a fresh
 * install. The prompt-injection scan rides along inside `validated.warnings`.
 *
 * Pure over (package text, directory listing): reads the directory, writes
 * nothing. Replacement is pre-authorized here because the review card is the
 * confirmation; the bot layer re-runs this at approve time anyway.
 */
export function planSkillImport(opts: {
  packageText: string;
  sourceLabel: string;
  dir: string;
  /**
   * Resolve a verified signer key id against the owner's trusted-publisher
   * registry. Absent = nobody is trusted (unsigned-equivalent friction).
   */
  isTrustedPublisher?: (keyId: string) => boolean;
}): { ok: true; plan: SkillImportPlan } | { ok: false; error: SkillImportError } {
  const { packageText, sourceLabel, dir } = opts;
  const verified = verifySkillPackage(packageText);
  if (!verified.ok) return { ok: false, error: verified.error };
  const pkg = verified.pkg;

  const installed = readInstalledSkill(dir, pkg.name);
  const installedVersion = installed?.skill.version;
  let versionState: VersionState;
  if (installed === undefined) {
    versionState = "new";
  } else if (pkg.version !== undefined && installedVersion !== undefined) {
    const cmp = compareSkillVersions(pkg.version, installedVersion);
    versionState = cmp > 0 ? "upgrade" : cmp < 0 ? "downgrade" : "same";
  } else {
    versionState = "unknown";
  }

  const prepared = prepareSkillInstall({
    text: pkg.skillFile,
    source: sourceLabel,
    dir,
    allowReplace: true,
  });
  if (!prepared.ok) return { ok: false, error: prepared.error };

  return {
    ok: true,
    plan: {
      validated: prepared.validated,
      skillFile: pkg.skillFile,
      ...(pkg.version !== undefined ? { packageVersion: pkg.version } : {}),
      ...(installedVersion !== undefined ? { installedVersion } : {}),
      versionState,
      metadata: pkg.metadata,
      sourceLabel,
      ...(pkg.signature !== undefined
        ? {
            signature: {
              keyId: pkg.signature.keyId,
              publicKeyB64: pkg.signature.publicKeyB64,
              trusted: opts.isTrustedPublisher?.(pkg.signature.keyId) ?? false,
            },
          }
        : {}),
    },
  };
}

// Re-exported for the command layer and tests.
export { parseSkillFile };
