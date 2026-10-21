/**
 * Phase 3, item 5 — installable skills from chat (personal plugin marketplace).
 * Phase 4, item 5 — skill sharing between instances (`/skill export|import`).
 *
 * Owner-only. The owner installs a skill either by sending a `.md` document
 * or by passing a URL; both sources converge on the same validation pipeline
 * in `src/skills/install.ts` and both require an explicit approve on a review
 * card before anything is written. After install the SkillCache picks the new
 * file up on its next read (directory-mtime reload) — no restart.
 *
 * Management surface (all under `/skill`; the existing `/skills` list command
 * in cmd_system.ts is untouched):
 *   /skill install <url> [--confirm]   fetch, validate, review, install
 *   /skill export <name> [--sign|--no-sign]
 *                                      build a portable `.bobiskill` package
 *                                      (signed when a key exists)
 *   /skill import                      import a package (file / URL / reply)
 *   /skill list                        installed skills + signature status
 *   /skill keygen [--force]            generate the ed25519 signing keypair
 *   /skill keyexport                   retrieve the private key (backup)
 *   /skill trust <id|pubkey> [label]   trust a publisher
 *   /skill untrust <id>                revoke a publisher
 *   /skill trusted                     list trusted publishers
 *   /skill show <name>                 show one installed skill
 *   /skill enable|disable <name>       rename into/out of the hidden-file convention
 *   /skill uninstall <name> [--confirm] two-step delete
 * Sending a `.md` document with caption "/skill install" (or replying
 * "/skill install" to a document message) runs the document install flow.
 * A `.bobiskill` document with caption "/skill import" (or replying
 * "/skill import" to one, or to a message holding the package text) runs
 * the import flow — same validation pipeline, mandatory review card, and
 * imported skills start DISABLED until the owner enables them.
 *
 * Conventions (same as the sibling command modules):
 * - owner-only: `isOwnerSender` is checked FIRST in every handler and in the
 *   callback router; a non-owner gets the short refusal and nothing else;
 * - fa+en strings via the local `cmd_phase3_skills_strings.ts` table for the
 *   phase-3 surface, and the central i18n pack (keys under `ph4_skill_share.*`)
 *   for the phase-4 sharing surface;
 * - logic lives in exported pure-ish `handleXxx` functions over plain values;
 *   the grammy wrappers are thin.
 *
 * This module is NOT registered in index.ts/bot.ts — the coordinator wires
 * `registerPhase3SkillsCommands` (and merges `COMMAND_DEFS` into the menu).
 */
import { randomBytes } from "node:crypto";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { HermesCommandDef, HermesCommandDeps } from "./cmd_context";
import {
  commandArg,
  gateGroup,
  gateUser,
  isOwnerSender,
  senderLang,
} from "./deps";
import type { Lang } from "../i18n/types";
import { t } from "../i18n/index";
import type { SkillCache } from "../skills/loader";
import {
  prepareSkillInstall,
  readInstalledSkill,
  listInstalledSkillNames,
  scanSkillBody,
  setSkillEnabled,
  skillFileStatus,
  uninstallSkillFile,
  writeSkillFile,
  createPinnedSkillFetcher,
  SkillFetchError,
  type InstallPlan,
  type SkillFetcher,
  type ValidatedSkill,
} from "../skills/install";
import {
  buildSkillPackage,
  planSkillImport,
  SKILL_PACKAGE_EXT,
  type PackageSigner,
  type SkillImportError,
  type SkillImportPlan,
} from "../skills/share";
import {
  fingerprintPublicKey,
  generateSigningKeypair,
  parsePublisherInput,
  shortKeyId,
} from "../skills/signing";
import type { Storage } from "../storage/storage";
import { SKILLS_MAX_FILE_BYTES } from "../skills/types";
import { fetchTelegramFileBytes } from "./telegram_file";
import { tr, type Ph3SkillsLang } from "../i18n/strings/cmd_phase3_skills_strings";

// ------------------------------------------------------------------ defs ----

export const COMMAND_DEFS: HermesCommandDef[] = [
  {
    command: "skill",
    descriptionEn: "Install, manage and share skills",
    ownerOnly: true,
  },
];

/** Optional wiring the coordinator provides at registration time. */
export interface Phase3SkillsOpts {
  /** The live skill cache (index.ts). Absent = management reports unavailable. */
  skills?: SkillCache;
  /** Skills directory override; default is the cache's directory. */
  skillsDir?: string;
  /** URL fetcher; default is the SSRF-guarded pinned fetcher. */
  fetcher?: SkillFetcher;
  /** Bot token, for downloading uploaded documents (same file-URL pattern as media.ts). */
  botToken?: string;
  /**
   * Document downloader override (tests). Receives the grammy context and a
   * Telegram file_id, returns the raw bytes or undefined on failure.
   */
  downloadDocument?: (ctx: Context, fileId: string) => Promise<Uint8Array | undefined>;
  now?: () => number;
}

// --------------------------------------------------------------- helpers ----

function toLang(_lang: Lang): Ph3SkillsLang {
  return "en"; // English-only UI
}

async function safeReply(
  ctx: { reply(text: string, extra?: unknown): Promise<unknown> },
  text: string,
  extra?: unknown,
): Promise<void> {
  try {
    await ctx.reply(text, extra as never);
  } catch {
    // The owner may have blocked the bot; that is not an error.
  }
}

/** Owner gate: owner first, then the group/user gates. */
async function gate(
  ctx: Context,
  deps: HermesCommandDeps,
  lang: Ph3SkillsLang,
): Promise<boolean> {
  if (!isOwnerSender(ctx, deps)) {
    await safeReply(ctx, tr(lang, "ph3_skills.owner_only"));
    return false;
  }
  if (!(await gateGroup(ctx, deps.groups, lang))) return false;
  if (!(await gateUser(ctx, deps))) return false;
  return true;
}

function messageArg(ctx: Context): string | undefined {
  const text = ctx.message?.text;
  return text !== undefined ? commandArg(text) : undefined;
}

function flagSet(arg: string | undefined, flag: string): boolean {
  return (
    arg !== undefined &&
    arg.split(/\s+/).some((p) => p.toLowerCase() === flag)
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function resolveDir(opts: Phase3SkillsOpts): string | undefined {
  if (opts.skillsDir !== undefined) return opts.skillsDir;
  return opts.skills?.directory;
}

// ------------------------------------------------------ pending approvals ----

/** An install waiting on the owner's review-card decision. */
export interface PendingInstall {
  text: string;
  name: string;
  replace: boolean;
  sourceLabel: string;
  /**
   * Set for package imports: the skill is installed DISABLED, and
   * `packageText` (the original envelope) is re-verified at approve time
   * instead of trusting `text` alone.
   */
  startDisabled?: boolean;
  packageText?: string;
}

/** An uninstall waiting on the owner's confirm decision. */
export interface PendingUninstall {
  name: string;
}

/**
 * Short-lived, in-memory approval tokens for the review cards.
 *
 * Tokens are 128-bit random hex; a forged callback cannot guess one, and the
 * callback router re-checks ownership anyway. Entries expire after 10 minutes
 * so a stale card can never install something the owner forgot about.
 */
export class PendingStore {
  private installs = new Map<string, { pending: PendingInstall; createdAt: number }>();
  private uninstalls = new Map<string, { pending: PendingUninstall; createdAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now, ttlMs: number = 10 * 60 * 1000) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  createInstall(pending: PendingInstall): string {
    const token = randomBytes(16).toString("hex");
    this.installs.set(token, { pending, createdAt: this.now() });
    return token;
  }

  /** Take (consume) a pending install; undefined when unknown or expired. */
  takeInstall(token: string): PendingInstall | undefined {
    const entry = this.installs.get(token);
    this.installs.delete(token);
    if (entry === undefined) return undefined;
    if (this.now() - entry.createdAt > this.ttlMs) return undefined;
    return entry.pending;
  }

  createUninstall(pending: PendingUninstall): string {
    const token = randomBytes(16).toString("hex");
    this.uninstalls.set(token, { pending, createdAt: this.now() });
    return token;
  }

  takeUninstall(token: string): PendingUninstall | undefined {
    const entry = this.uninstalls.get(token);
    this.uninstalls.delete(token);
    if (entry === undefined) return undefined;
    if (this.now() - entry.createdAt > this.ttlMs) return undefined;
    return entry.pending;
  }
}

// ------------------------------------------------------------ review card ----

const PREVIEW_LINES = 20;

/**
 * Render the install review card. Pure. Shows name, description, triggers,
 * size, source, the risk warnings (if any), and the first `previewLines`
 * body lines — everything the owner needs to decide, and nothing is
 * installed yet. Trusted-publisher imports render the compact form (fewer
 * preview lines): same approval gate, less to read.
 */
export function renderReviewCard(
  lang: Ph3SkillsLang,
  validated: ValidatedSkill,
  sourceLabel: string,
  previewLines: number = PREVIEW_LINES,
): string {
  const s = validated.skill;
  const lines = [
    tr(lang, "ph3_skills.review.title"),
    "",
    tr(lang, "ph3_skills.review.name", { name: s.name }),
    tr(lang, "ph3_skills.review.description", { description: s.description }),
    tr(lang, "ph3_skills.review.triggers", {
      triggers:
        s.triggers.length > 0 ? s.triggers.join(", ") : tr(lang, "ph3_skills.review.triggers_none"),
    }),
    tr(lang, "ph3_skills.review.size", { size: formatBytes(validated.sizeBytes) }),
    tr(lang, "ph3_skills.review.source", { source: sourceLabel }),
  ];
  if (validated.replace) {
    lines.push("", tr(lang, "ph3_skills.review.replace_note", { name: s.name }));
  }
  if (validated.warnings.length > 0) {
    lines.push("", tr(lang, "ph3_skills.review.warnings_title"));
    for (const w of validated.warnings) {
      lines.push(tr(lang, "ph3_skills.review.warning_item", { detail: w.detail, snippet: w.snippet }));
    }
  }
  const preview = s.body.split("\n").slice(0, previewLines).join("\n").trim();
  lines.push("", tr(lang, "ph3_skills.review.preview_title"), preview, "", tr(lang, "ph3_skills.review.approve_hint"));
  return lines.join("\n");
}

/** Map a validation error to user-facing text. Pure. */
export function renderValidationError(
  lang: Ph3SkillsLang,
  error: InstallPlan & { ok: false },
  sourceLabel: string,
): string {
  const e = error.error;
  switch (e.kind) {
    case "too_large":
      return tr(lang, "ph3_skills.install.too_large", {
        bytes: formatBytes(e.bytes),
        max: formatBytes(e.maxBytes),
      });
    case "parse":
      return tr(lang, "ph3_skills.install.parse_failed", { reason: e.reason });
    case "collision":
      return tr(lang, "ph3_skills.install.collision", { name: e.name, source: sourceLabel });
    case "limit":
      return tr(lang, "ph3_skills.install.limit", { max: e.max, count: e.count });
  }
}

// ---------------------------------------------------------------- install ----

export interface InstallOutcome {
  /** "review" carries a pending token the wrapper turns into buttons. */
  outcome: "review" | "installed" | "error";
  text: string;
  pending?: PendingInstall;
}

/**
 * Plan an install from raw markdown text (either source). Pure-ish: reads the
 * skills directory, writes nothing. On "review" the caller shows
 * `renderReviewCard` with approve/reject buttons bound to `pending`.
 *
 * `confirm` pre-authorizes REPLACING a same-named skill (the phase-1
 * destructive-confirmation style), but it never skips the review card when
 * the scan found warnings — the owner must see those first.
 */
export function planInstallFromText(
  lang: Ph3SkillsLang,
  text: string,
  sourceLabel: string,
  dir: string,
  confirm: boolean,
): InstallOutcome {
  const plan = prepareSkillInstall({ text, source: sourceLabel, dir, allowReplace: confirm });
  if (!plan.ok) {
    // A collision without --confirm is not fatal: the owner may still approve
    // the replacement from the review card, where the risk is explicit.
    if (plan.error.kind === "collision" && !confirm) {
      const retry = prepareSkillInstall({ text, source: sourceLabel, dir, allowReplace: true });
      if (retry.ok) {
        return {
          outcome: "review",
          text: renderReviewCard(lang, retry.validated, sourceLabel),
          pending: {
            text,
            name: retry.validated.skill.name,
            replace: true,
            sourceLabel,
          },
        };
      }
      // fall through to the error render below
    }
    return { outcome: "error", text: renderValidationError(lang, plan, sourceLabel) };
  }

  const validated = plan.validated;
  // Explicit --confirm installs immediately ONLY when the scan is clean; any
  // warning forces the review card so the owner sees it before deciding.
  if (confirm && validated.warnings.length === 0) {
    return { outcome: "installed", text: installNow(lang, dir, validated) };
  }
  return {
    outcome: "review",
    text: renderReviewCard(lang, validated, sourceLabel),
    pending: { text, name: validated.skill.name, replace: validated.replace, sourceLabel },
  };
}

/** Write the file now (post-approval). Never throws user-hostile errors. */
function installNow(lang: Ph3SkillsLang, dir: string, validated: ValidatedSkill): string {
  try {
    writeSkillFile(dir, validated);
  } catch (err) {
    return tr(lang, "ph3_skills.install.write_failed", { reason: String(err) });
  }
  // The SkillCache reloads on directory mtime — no restart needed.
  return tr(
    lang,
    validated.replace ? "ph3_skills.install.done_replaced" : "ph3_skills.install.done",
    { name: validated.skill.name },
  );
}

/** The approve button: consume the pending install and write the file. */
export function approvePendingInstall(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
  dir: string,
): string {
  const pending = store.takeInstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  // Re-validate at approve time: the directory may have changed since the
  // review card was shown (another install, a manual edit).
  const plan = prepareSkillInstall({
    text: pending.text,
    source: pending.sourceLabel,
    dir,
    allowReplace: true,
  });
  if (!plan.ok) return renderValidationError(lang, plan, pending.sourceLabel);
  return installNow(lang, dir, plan.validated);
}

/** The reject button: drop the pending install. */
export function rejectPendingInstall(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
): string {
  const pending = store.takeInstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  return tr(lang, "ph3_skills.review.rejected", { name: pending.name });
}

// -------------------------------------------------------- export / import ----

/**
 * `/skill export <name> [--sign|--no-sign]`: build a portable `.bobiskill`
 * package for one installed skill. Pure: reads the skills directory, writes
 * nothing. The grammy wrapper sends `text` back as a document named
 * `fileName`. When `signer` is given the envelope is ed25519-signed.
 */
export function handleSkillExport(
  dir: string,
  name: string,
  opts: { signer?: PackageSigner } = {},
):
  | {
      ok: true;
      fileName: string;
      text: string;
      skillName: string;
      version?: string;
      signed: boolean;
      keyId?: string;
    }
  | { ok: false; error: "not_found" | "too_large" | "signer_invalid"; name: string } {
  const res = buildSkillPackage(dir, name, opts.signer !== undefined ? { signer: opts.signer } : {});
  if (!res.ok) return { ok: false, error: res.error.kind, name: res.error.name };
  return {
    ok: true,
    fileName: res.pkg.fileName,
    text: res.pkg.text,
    skillName: res.pkg.skillName,
    ...(res.pkg.version !== undefined ? { version: res.pkg.version } : {}),
    signed: res.pkg.signed,
    ...(res.pkg.keyId !== undefined ? { keyId: res.pkg.keyId } : {}),
  };
}

export interface ImportOutcome {
  /** "review" carries a pending token the wrapper turns into buttons. */
  outcome: "review" | "error";
  text: string;
  pending?: PendingInstall;
}

/** Map a package/validation error to user-facing text. Pure. */
export function renderImportError(
  lang: Ph3SkillsLang,
  error: SkillImportError,
  sourceLabel: string,
): string {
  switch (error.kind) {
    case "too_large":
      return t("ph4_skill_share.import.too_large", lang, {
        bytes: formatBytes(error.bytes),
        max: formatBytes(error.maxBytes),
      });
    case "not_json":
      return t("ph4_skill_share.import.bad_envelope", lang, { reason: "not JSON" });
    case "bad_envelope":
      return t("ph4_skill_share.import.bad_envelope", lang, { reason: error.reason });
    case "checksum_mismatch":
      return t("ph4_skill_share.import.checksum_mismatch", lang);
    case "bad_signature":
      return t("ph5_skill_signing.import.bad_signature", lang);
    default:
      // A SkillValidationError from the reused install pipeline.
      return renderValidationError(lang, { ok: false, error }, sourceLabel);
  }
}

function importVersionLine(lang: Ph3SkillsLang, plan: SkillImportPlan): string {
  switch (plan.versionState) {
    case "new":
      return t("ph4_skill_share.import.new_skill", lang);
    case "upgrade":
      return t("ph4_skill_share.import.upgrade", lang, {
        old: plan.installedVersion ?? "?",
        new: plan.packageVersion ?? "?",
      });
    case "downgrade":
      return t("ph4_skill_share.import.downgrade", lang, {
        old: plan.installedVersion ?? "?",
        new: plan.packageVersion ?? "?",
      });
    case "same":
      return t("ph4_skill_share.import.same_version", lang, {
        version: plan.packageVersion ?? "?",
      });
    case "unknown":
      return t("ph4_skill_share.import.unknown_version", lang);
  }
}

/**
 * Owner's trust view over signing keys (Phase 5, item 1). The command layer
 * builds one from `Storage`; pure logic takes this interface so tests can
 * inject a fake without a database.
 */
export interface SkillTrust {
  /** Whether the owner trusts this publisher key id. */
  isTrusted(keyId: string): boolean;
  /** The owner's label for a trusted key id, if any. */
  labelOf(keyId: string): string | undefined;
}

/** Build a `SkillTrust` over the trusted-publisher registry in storage. */
export function storageSkillTrust(storage: Storage): SkillTrust {
  return {
    isTrusted: (keyId) => storage.misc.getTrustedSkillPublisher(keyId) !== undefined,
    labelOf: (keyId) => storage.misc.getTrustedSkillPublisher(keyId)?.label,
  };
}

/** One-line signature status for the import review card. Pure. */
export function renderSignatureStatus(
  lang: Ph3SkillsLang,
  signature: SkillImportPlan["signature"],
  trust?: SkillTrust,
): string {
  if (signature === undefined) {
    return t("ph5_skill_signing.import.sig_unsigned", lang);
  }
  const trusted = trust?.isTrusted(signature.keyId) ?? signature.trusted;
  if (trusted) {
    const label = trust?.labelOf(signature.keyId);
    if (label !== undefined) {
      return t("ph5_skill_signing.import.sig_trusted", lang, { label });
    }
  }
  return t("ph5_skill_signing.import.sig_unknown", lang, { keyId: shortKeyId(signature.keyId) });
}

/**
 * Render the import review card: package trust block (signature status,
 * checksum, version delta, disabled-by-default) on top of the standard
 * skill review card. Pure. Nothing is installed yet.
 *
 * Signed-by-trusted-publisher imports render the COMPACT card (5-line
 * preview instead of 20): same approve/reject gate, same re-verification at
 * approve time, same disabled-by-default — just less review friction for
 * authors the owner already trusts.
 */
export function renderImportReviewCard(
  lang: Ph3SkillsLang,
  plan: SkillImportPlan,
  trust?: SkillTrust,
): string {
  const name = plan.validated.skill.name;
  const trustedSigned = plan.signature !== undefined && (trust?.isTrusted(plan.signature.keyId) ?? plan.signature.trusted);
  const lines = [
    t("ph4_skill_share.import.review_title", lang),
    "",
    renderSignatureStatus(lang, plan.signature, trust),
    t("ph4_skill_share.import.checksum_ok", lang),
    importVersionLine(lang, plan),
    t("ph4_skill_share.import.source", lang, { source: plan.sourceLabel }),
    t("ph4_skill_share.import.exported_at", lang, {
      when: plan.metadata.exportedAt,
      instance: plan.metadata.sourceInstance,
    }),
    t("ph4_skill_share.import.capabilities", lang, {
      caps: plan.metadata.capabilities.length > 0 ? plan.metadata.capabilities.join(", ") : "—",
    }),
    t("ph4_skill_share.import.disabled_note", lang, { name }),
    "",
    "────────────────",
    "",
    renderReviewCard(lang, plan.validated, plan.sourceLabel, trustedSigned ? 5 : PREVIEW_LINES),
  ];
  return lines.join("\n");
}

/**
 * Plan an import from package text (document, pasted content, or URL body).
 * Pure-ish: verifies the envelope (checksum + optional signature), then
 * runs the existing install validation pipeline; writes nothing. On
 * "review" the caller shows `renderImportReviewCard` with approve/reject buttons
 * bound to `pending`. `trust` resolves the signature against the owner's
 * registry for the card; approval re-resolves it.
 */
export function planImportFromPackage(
  lang: Ph3SkillsLang,
  packageText: string,
  sourceLabel: string,
  dir: string,
  trust?: SkillTrust,
): ImportOutcome {
  const res = planSkillImport({
    packageText,
    sourceLabel,
    dir,
    ...(trust !== undefined ? { isTrustedPublisher: (keyId: string) => trust.isTrusted(keyId) } : {}),
  });
  if (!res.ok) {
    return { outcome: "error", text: renderImportError(lang, res.error, sourceLabel) };
  }
  const plan = res.plan;
  return {
    outcome: "review",
    text: renderImportReviewCard(lang, plan, trust),
    pending: {
      text: plan.skillFile,
      packageText,
      name: plan.validated.skill.name,
      replace: plan.validated.replace,
      sourceLabel,
      startDisabled: true,
    },
  };
}

/**
 * The approve button for an import: consume the pending import, re-verify the
 * envelope and re-run validation (the directory may have changed since the
 * review card), write the file, then DISABLE the skill — imported skills
 * never go live without an explicit `/skill enable`.
 */
export function approvePendingImport(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
  dir: string,
  opts: { storage?: Storage; trust?: SkillTrust } = {},
): string {
  const pending = store.takeInstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  if (pending.startDisabled !== true || pending.packageText === undefined) {
    // Not an import pending: refuse rather than mis-installing.
    return t("ph4_skill_share.import.bad_envelope", lang, { reason: "pending mismatch" });
  }
  const res = planSkillImport({
    packageText: pending.packageText,
    sourceLabel: pending.sourceLabel,
    dir,
    ...(opts.trust !== undefined
      ? { isTrustedPublisher: (keyId: string) => opts.trust!.isTrusted(keyId) }
      : {}),
  });
  if (!res.ok) return renderImportError(lang, res.error, pending.sourceLabel);
  const name = res.plan.validated.skill.name;
  try {
    writeSkillFile(dir, res.plan.validated);
    // Disabled-by-default: the loader skips the hidden file, so the import
    // is inert until the owner explicitly enables it.
    setSkillEnabled(dir, name, false);
  } catch (err) {
    return tr(lang, "ph4_skills.install.write_failed", { reason: String(err) });
  }
  // Record the verified signer (if any) as install provenance, so a later
  // untrust flags the skill in "/skill list".
  opts.storage?.recordSkillInstallProvenance({
    skillName: name,
    keyId: res.plan.signature?.keyId ?? null,
  });
  return t("ph4_skill_share.import.done_disabled", lang, { name });
}

/** The reject button for an import: drop the pending import. */
export function rejectPendingImport(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
): string {
  const pending = store.takeInstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  return t("ph4_skill_share.import.rejected", lang, { name: pending.name });
}

// ------------------------------------------- phase 5: signing + trust ----

/**
 * `/skill keygen [--force]`: generate the owner's ed25519 signing keypair
 * and store it (private key included) in the instance database. The reply
 * carries only the public parts: key id (fingerprint) and public key.
 */
export function handleSkillKeygen(
  lang: Ph3SkillsLang,
  storage: Storage,
  force: boolean,
): string {
  const existing = storage.misc.getSkillSigningKey();
  if (existing !== undefined && !force) {
    return t("ph5_skill_signing.keygen.exists", lang, { keyId: shortKeyId(existing.keyId) });
  }
  const kp = generateSigningKeypair();
  storage.misc.setSkillSigningKey({
    keyId: kp.keyId,
    publicKey: kp.publicKeyB64,
    privateKeyJwk: kp.privateKeyJwk,
  });
  const vars = { keyId: kp.keyId, pubkey: kp.publicKeyB64 };
  return t(
    existing !== undefined ? "ph5_skill_signing.keygen.regenerated" : "ph5_skill_signing.keygen.done",
    lang,
    vars,
  );
}

/** The stored keypair as export signer material, if `/skill keygen` has run. */
export function exportSigner(storage: Storage): PackageSigner | undefined {
  const row = storage.misc.getSkillSigningKey();
  if (row === undefined) return undefined;
  return { publicKeyB64: row.publicKey, privateKeyJwk: row.privateKeyJwk };
}

/**
 * `/skill keyexport`: hand the private key back as a document. This is the
 * ONLY path the private key ever leaves storage — explicit, owner-only,
 * and never automatic.
 */
export function handleSkillKeyExport(
  lang: Ph3SkillsLang,
  storage: Storage,
): { ok: true; fileName: string; text: string; keyId: string } | { ok: false; text: string } {
  const row = storage.misc.getSkillSigningKey();
  if (row === undefined) {
    return { ok: false, text: t("ph5_skill_signing.keyexport.missing", lang) };
  }
  let privateJwk: unknown = row.privateKeyJwk;
  try {
    privateJwk = JSON.parse(row.privateKeyJwk);
  } catch {
    // Corrupt row: export the raw string rather than failing silently.
  }
  return {
    ok: true,
    fileName: "bobi-skill-signing-key.json",
    text: JSON.stringify(
      {
        format: "bobi-skill-signing-key",
        keyId: row.keyId,
        publicKey: row.publicKey,
        privateKeyJwk: privateJwk,
        warning: "PRIVATE — anyone holding this can sign packages in your name.",
      },
      null,
      2,
    ),
    keyId: row.keyId,
  };
}

/**
 * `/skill trust <keyId|publicKey> [label]`: add a publisher to the
 * owner-maintained trust registry. Accepts a 64-hex key fingerprint or a
 * base64 raw public key (the fingerprint is derived from it).
 */
export function handleSkillTrust(
  lang: Ph3SkillsLang,
  storage: Storage,
  input: string | undefined,
  label: string | undefined,
): string {
  if (input === undefined || input.trim() === "") {
    return t("ph5_skill_signing.trust.no_input", lang);
  }
  const parsed = parsePublisherInput(input);
  if (parsed.kind === "invalid") {
    return t("ph5_skill_signing.trust.invalid", lang);
  }
  const keyId =
    parsed.kind === "key_id" ? input.trim().toLowerCase() : fingerprintPublicKey(parsed.publicKeyB64);
  const finalLabel = label?.trim() !== "" && label !== undefined ? label.trim() : `key-${keyId.slice(0, 8)}`;
  const { added } = storage.misc.trustSkillPublisher({
    keyId,
    label: finalLabel,
    publicKey: parsed.kind === "public_key" ? parsed.publicKeyB64 : "",
  });
  const vars = { label: finalLabel, keyId: shortKeyId(keyId) };
  return t(added ? "ph5_skill_signing.trust.added" : "ph5_skill_signing.trust.updated", lang, vars);
}

/**
 * `/skill untrust <keyId>`: revoke a publisher. Install provenance is kept,
 * so `/skill list` flags skills that were signed by the revoked key — the
 * owner decides what to do with them.
 */
export function handleSkillUntrust(
  lang: Ph3SkillsLang,
  storage: Storage,
  input: string | undefined,
): string {
  if (input === undefined || input.trim() === "") {
    return t("ph5_skill_signing.untrust.no_input", lang);
  }
  const keyId = input.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(keyId)) {
    return t("ph5_skill_signing.trust.invalid", lang);
  }
  const row = storage.misc.getTrustedSkillPublisher(keyId);
  if (row === undefined) {
    return t("ph5_skill_signing.untrust.missing", lang);
  }
  storage.misc.untrustSkillPublisher(keyId);
  return t("ph5_skill_signing.untrust.removed", lang, {
    label: row.label,
    keyId: shortKeyId(keyId),
  });
}

/** `/skill trusted`: list the owner's trusted publishers. */
export function handleSkillTrustedList(lang: Ph3SkillsLang, storage: Storage): string {
  const rows = storage.misc.listTrustedSkillPublishers();
  if (rows.length === 0) {
    return t("ph5_skill_signing.trusted.empty", lang);
  }
  const lines = [t("ph5_skill_signing.trusted.title", lang, { count: rows.length }), ""];
  for (const r of rows) {
    lines.push(t("ph5_skill_signing.trusted.item", lang, { label: r.label, keyId: shortKeyId(r.keyId) }));
  }
  return lines.join("\n");
}

/**
 * `/skill list`: installed skills (enabled and disabled) with their
 * signature/provenance status. A skill signed by a key that is not — or no
 * longer — trusted is flagged; the owner decides (disable/uninstall).
 */
export function handleSkillList(lang: Ph3SkillsLang, dir: string, storage: Storage): string {
  const skills = listInstalledSkillNames(dir);
  if (skills.length === 0) {
    return t("ph5_skill_signing.list.empty", lang);
  }
  const trust = storageSkillTrust(storage);
  const lines = [t("ph5_skill_signing.list.title", lang, { count: skills.length }), ""];
  for (const s of skills) {
    const prov = storage.misc.getSkillInstallProvenance(s.name);
    let sig: string;
    if (prov?.keyId == null) {
      sig = t("ph5_skill_signing.list.sig_unsigned", lang);
    } else if (trust.isTrusted(prov.keyId)) {
      sig = t("ph5_skill_signing.list.sig_trusted", lang, {
        label: trust.labelOf(prov.keyId) ?? shortKeyId(prov.keyId),
      });
    } else {
      // Signed, but the publisher is not (or no longer) in the trust
      // registry — revoked keys and never-trusted keys both land here.
      sig = t("ph5_skill_signing.list.sig_revoked", lang);
    }
    lines.push(
      t("ph5_skill_signing.list.item", lang, {
        name: s.name,
        status: t(
          s.enabled ? "ph5_skill_signing.list.enabled" : "ph5_skill_signing.list.disabled",
          lang,
        ),
        sig,
      }),
    );
  }
  return lines.join("\n");
}

/** A caption (or reply text) counts as a skill-import request when it starts with /skill import. */
export function isSkillImportCaption(caption: string | undefined): boolean {
  if (caption === undefined) return false;
  const first = caption.trim().split(/\s+/, 2);
  if (first.length < 2) return false;
  if (!/^\/skill(@\w+)?$/i.test(first[0]!)) return false;
  return first[1]!.toLowerCase() === "import";
}

/** Fetch the URL, then plan the install. The fetcher is injected (mocked in tests). */
export async function planInstallFromUrl(
  lang: Ph3SkillsLang,
  url: string,
  dir: string,
  fetcher: SkillFetcher,
  confirm: boolean,
): Promise<InstallOutcome> {
  let text: string;
  try {
    const res = await fetcher(url);
    text = res.text;
  } catch (err) {
    const reason =
      err instanceof SkillFetchError ? friendlyFetchReason(lang, err) : String(err);
    return { outcome: "error", text: tr(lang, "ph3_skills.install.fetch_failed", { reason }) };
  }
  return planInstallFromText(lang, text, url, dir, confirm);
}

function friendlyFetchReason(lang: Ph3SkillsLang, err: SkillFetchError): string {
  // Keep the technical kinds out of the user-facing text; the fa/en detail
  // lives in the message already (English diagnostics are fine here).
  void lang;
  return err.message;
}

// -------------------------------------------------------------- management ----

/** `/skill show <name>`: description, triggers, status, 20-line preview. Pure. */
export function handleSkillShow(lang: Ph3SkillsLang, dir: string, name: string): string {
  const found = readInstalledSkill(dir, name.trim().toLowerCase());
  if (found === undefined) return tr(lang, "ph3_skills.show.not_found", { name });
  const s = found.skill;
  const status = tr(
    lang,
    "ph3_skills.show.status",
    {
      status: tr(
        lang,
        found.status === "enabled"
          ? "ph3_skills.show.status_enabled"
          : "ph3_skills.show.status_disabled",
      ),
    },
  );
  const preview = s.body.split("\n").slice(0, PREVIEW_LINES).join("\n").trim();
  return [
    tr(lang, "ph3_skills.review.name", { name: s.name }),
    tr(lang, "ph3_skills.review.description", { description: s.description }),
    tr(lang, "ph3_skills.review.triggers", {
      triggers: s.triggers.length > 0 ? s.triggers.join(", ") : tr(lang, "ph3_skills.review.triggers_none"),
    }),
    status,
    "",
    tr(lang, "ph3_skills.review.preview_title"),
    preview,
  ].join("\n");
}

/** `/skill enable|disable <name>`. Pure. */
export function handleSkillToggle(
  lang: Ph3SkillsLang,
  dir: string,
  name: string,
  enable: boolean,
): string {
  const clean = name.trim().toLowerCase();
  const before = skillFileStatus(dir, clean);
  if (before === "missing") return tr(lang, "ph3_skills.toggle.missing", { name: clean });
  if (enable && before === "enabled") return tr(lang, "ph3_skills.toggle.noop_enabled", { name: clean });
  if (!enable && before === "disabled") return tr(lang, "ph3_skills.toggle.noop_disabled", { name: clean });
  const after = setSkillEnabled(dir, clean, enable);
  if (enable && after === "enabled") return tr(lang, "ph3_skills.toggle.enabled", { name: clean });
  if (!enable && after === "disabled") return tr(lang, "ph3_skills.toggle.disabled", { name: clean });
  return tr(lang, "ph3_skills.toggle.missing", { name: clean });
}

export interface UninstallOutcome {
  outcome: "confirm" | "done" | "error";
  text: string;
  pending?: PendingUninstall;
}

/** `/skill uninstall <name> [--confirm]`: two-step delete. Pure. */
export function planUninstall(
  lang: Ph3SkillsLang,
  dir: string,
  name: string,
  confirm: boolean,
  store: PendingStore,
): UninstallOutcome {
  const clean = name.trim().toLowerCase();
  if (skillFileStatus(dir, clean) === "missing") {
    return { outcome: "error", text: tr(lang, "ph3_skills.uninstall.missing", { name: clean }) };
  }
  if (!confirm) {
    return {
      outcome: "confirm",
      text: tr(lang, "ph3_skills.uninstall.confirm", { name: clean }),
      pending: { name: clean },
    };
  }
  const removed = uninstallSkillFile(dir, clean);
  return removed
    ? { outcome: "done", text: tr(lang, "ph3_skills.uninstall.done", { name: clean }) }
    : { outcome: "error", text: tr(lang, "ph3_skills.uninstall.failed", { name: clean }) };
}

/** The delete-confirm button: consume the pending uninstall and delete. */
export function approvePendingUninstall(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
  dir: string,
  storage?: Storage,
): string {
  const pending = store.takeUninstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  const removed = uninstallSkillFile(dir, pending.name);
  // Drop install provenance with the skill: no stale flags in "/skill list".
  if (removed) storage?.removeSkillInstallProvenance(pending.name);
  return removed
    ? tr(lang, "ph3_skills.uninstall.done", { name: pending.name })
    : tr(lang, "ph3_skills.uninstall.failed", { name: pending.name });
}

/** The cancel button. */
export function rejectPendingUninstall(
  lang: Ph3SkillsLang,
  store: PendingStore,
  token: string,
): string {
  const pending = store.takeUninstall(token);
  if (pending === undefined) return tr(lang, "ph3_skills.review.expired");
  return tr(lang, "ph3_skills.uninstall.cancelled", { name: pending.name });
}

// ------------------------------------------------------------------ wiring ----

const CB_PREFIX = "ph3skill";

function installKeyboard(lang: Ph3SkillsLang, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "ph3_skills.review.approve"), `${CB_PREFIX}:inst:${token}:ok`)
    .text(tr(lang, "ph3_skills.review.reject"), `${CB_PREFIX}:inst:${token}:no`);
}

function uninstallKeyboard(lang: Ph3SkillsLang, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "ph3_skills.uninstall.confirm_approve"), `${CB_PREFIX}:uninst:${token}:ok`)
    .text(tr(lang, "ph3_skills.uninstall.confirm_cancel"), `${CB_PREFIX}:uninst:${token}:no`);
}

function importKeyboard(lang: Ph3SkillsLang, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "ph3_skills.review.approve"), `${CB_PREFIX}:imp:${token}:ok`)
    .text(tr(lang, "ph3_skills.review.reject"), `${CB_PREFIX}:imp:${token}:no`);
}

/** A caption (or reply text) counts as a skill-install request when it starts with /skill install. */
export function isSkillInstallCaption(caption: string | undefined): boolean {
  if (caption === undefined) return false;
  const first = caption.trim().split(/\s+/, 2);
  if (first.length < 2) return false;
  if (!/^\/skill(@\w+)?$/i.test(first[0]!)) return false;
  return first[1]!.toLowerCase() === "install";
}

interface DocumentRef {
  fileId: string;
  fileName: string | undefined;
  fileSize: number | undefined;
}

/**
 * Register the phase-3 skill commands. The coordinator calls this; nothing
 * here is wired in index.ts/bot.ts by this module.
 */
export function registerPhase3SkillsCommands(
  bot: Bot,
  deps: HermesCommandDeps,
  opts: Phase3SkillsOpts = {},
): void {
  const store = new PendingStore(opts.now ?? Date.now);
  const fetcher: SkillFetcher = opts.fetcher ?? createPinnedSkillFetcher();

  const dirOf = (): string | undefined => resolveDir(opts);

  /**
   * Download an uploaded document's bytes via the shared Telegram file
   * fetch (timeout + streaming cap at SKILLS_MAX_FILE_BYTES).
   */
  const downloadDocument = async (
    c: Context,
    fileId: string,
  ): Promise<Uint8Array | undefined> => {
    if (opts.downloadDocument !== undefined) return opts.downloadDocument(c, fileId);
    if (opts.botToken === undefined) return undefined;
    return fetchTelegramFileBytes(c.api, opts.botToken, fileId, {
      maxBytes: SKILLS_MAX_FILE_BYTES,
    });
  };

  // ------------------------------------------------------------- /skill ----
  bot.command("skill", async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    if (!(await gate(ctx, deps, lang))) return;
    const dir = dirOf();
    if (dir === undefined) {
      await safeReply(ctx, tr(lang, "ph3_skills.unavailable"));
      return;
    }
    const arg = messageArg(ctx);
    const parts = (arg ?? "").trim().split(/\s+/).filter((p) => p.length > 0);
    const sub = parts[0]?.toLowerCase();

    // Reply-to-document install: "/skill install" as a reply to the file.
    const repliedDoc = documentOf(ctx.message?.reply_to_message);
    if ((sub === "install" || sub === undefined) && repliedDoc !== undefined) {
      await installFromDocument(ctx, deps, lang, dir, repliedDoc, store, downloadDocument);
      return;
    }

    switch (sub) {
      case "install": {
        const rest = parts.slice(1).filter((p) => p.toLowerCase() !== "--confirm");
        const confirm = flagSet(arg, "--confirm");
        const url = rest[0];
        if (url === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.install.no_source"));
          return;
        }
        const outcome = await planInstallFromUrl(lang, url, dir, fetcher, confirm);
        if (outcome.outcome === "review" && outcome.pending !== undefined) {
          const token = store.createInstall(outcome.pending);
          await safeReply(ctx, outcome.text, { reply_markup: installKeyboard(lang, token) });
          return;
        }
        await safeReply(ctx, outcome.text);
        return;
      }
      case "export": {
        const name = parts[1];
        if (name === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.usage"));
          return;
        }
        // Phase 5, item 1: sign by default when a key exists; --no-sign to
        // skip, --sign to require (fails loudly when no key was generated).
        const wantSign = flagSet(arg, "--sign");
        const noSign = flagSet(arg, "--no-sign");
        const keyRow = deps.storage.misc.getSkillSigningKey();
        if (wantSign && keyRow === undefined) {
          await safeReply(ctx, t("ph5_skill_signing.export.sign_no_key", lang));
          return;
        }
        const signer =
          !noSign && keyRow !== undefined
            ? { publicKeyB64: keyRow.publicKey, privateKeyJwk: keyRow.privateKeyJwk }
            : undefined;
        const res = handleSkillExport(dir, name, signer !== undefined ? { signer } : {});
        if (!res.ok) {
          await safeReply(
            ctx,
            res.error === "not_found"
              ? t("ph4_skill_share.export.not_found", lang, { name: res.name })
              : res.error === "too_large"
                ? t("ph4_skill_share.export.too_large", lang, { name: res.name })
                : t("ph5_skill_signing.export.signer_invalid", lang),
          );
          return;
        }
        const caption =
          t("ph4_skill_share.export.done", lang, {
            name: res.skillName,
            version: res.version ?? t("ph4_skill_share.export.no_version", lang),
          }) +
          (res.signed && res.keyId !== undefined
            ? "\n" + t("ph5_skill_signing.export.signed_note", lang, { keyId: shortKeyId(res.keyId) })
            : "");
        try {
          await ctx.replyWithDocument(new InputFile(Buffer.from(res.text, "utf8"), res.fileName), {
            caption,
          });
        } catch {
          await safeReply(ctx, t("ph4_skill_share.export.failed", lang));
        }
        return;
      }
      case "keygen": {
        await safeReply(ctx, handleSkillKeygen(lang, deps.storage, flagSet(arg, "--force")));
        return;
      }
      case "keyexport": {
        const res = handleSkillKeyExport(lang, deps.storage);
        if (!res.ok) {
          await safeReply(ctx, res.text);
          return;
        }
        try {
          await ctx.replyWithDocument(new InputFile(Buffer.from(res.text, "utf8"), res.fileName), {
            caption: t("ph5_skill_signing.keyexport.caption", lang),
          });
        } catch {
          await safeReply(ctx, t("ph4_skill_share.export.failed", lang));
        }
        return;
      }
      case "trust": {
        const input = parts[1];
        const label = parts.slice(2).join(" ").trim() || undefined;
        await safeReply(ctx, handleSkillTrust(lang, deps.storage, input, label));
        return;
      }
      case "untrust": {
        await safeReply(ctx, handleSkillUntrust(lang, deps.storage, parts[1]));
        return;
      }
      case "trusted": {
        await safeReply(ctx, handleSkillTrustedList(lang, deps.storage));
        return;
      }
      case "list": {
        await safeReply(ctx, handleSkillList(lang, dir, deps.storage));
        return;
      }
      case "import": {
        // The owner's trust view, resolved per request so registry changes
        // apply immediately to the next review card.
        const trust = storageSkillTrust(deps.storage);
        // Reply-to-document: "/skill import" as a reply to the package file.
        const repliedDoc = documentOf(ctx.message?.reply_to_message);
        if (repliedDoc !== undefined) {
          await importFromDocument(ctx, lang, dir, repliedDoc, store, downloadDocument, trust);
          return;
        }
        // Reply-to-text: the package pasted into a message.
        const repliedText = ctx.message?.reply_to_message?.text;
        if (typeof repliedText === "string" && repliedText.trim().length > 0) {
          await importFromPackageText(
            ctx,
            lang,
            dir,
            store,
            repliedText,
            t("ph4_skill_share.import.source_replied", lang),
            trust,
          );
          return;
        }
        const url = parts.slice(1)[0];
        if (url === undefined) {
          await safeReply(ctx, t("ph4_skill_share.import.no_source", lang));
          return;
        }
        let text: string;
        try {
          text = (await fetcher(url)).text;
        } catch (err) {
          const reason =
            err instanceof SkillFetchError ? err.message : String(err);
          await safeReply(ctx, t("ph4_skill_share.import.fetch_failed", lang, { reason }));
          return;
        }
        await importFromPackageText(ctx, lang, dir, store, text, url, trust);
        return;
      }
      case "show": {
        const name = parts[1];
        if (name === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.usage"));
          return;
        }
        await safeReply(ctx, handleSkillShow(lang, dir, name));
        return;
      }
      case "enable":
      case "disable": {
        const name = parts[1];
        if (name === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.usage"));
          return;
        }
        await safeReply(ctx, handleSkillToggle(lang, dir, name, sub === "enable"));
        return;
      }
      case "uninstall": {
        const name = parts[1];
        if (name === undefined) {
          await safeReply(ctx, tr(lang, "ph3_skills.usage"));
          return;
        }
        const outcome = planUninstall(lang, dir, name, flagSet(arg, "--confirm"), store);
        if (outcome.outcome === "confirm" && outcome.pending !== undefined) {
          const token = store.createUninstall(outcome.pending);
          await safeReply(ctx, outcome.text, { reply_markup: uninstallKeyboard(lang, token) });
          return;
        }
        await safeReply(ctx, outcome.text);
        return;
      }
      default:
        await safeReply(ctx, tr(lang, "ph3_skills.usage"));
        return;
    }
  });

  // --------------------------------------- document install (.md upload) ----
  bot.on("message:document", async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    if (!(await gate(ctx, deps, lang))) return;
    const dir = dirOf();
    if (dir === undefined) {
      await safeReply(ctx, tr(lang, "ph3_skills.unavailable"));
      return;
    }
    const doc = documentOf(ctx.message);
    if (doc === undefined) return;
    const caption = ctx.message?.caption;
    if (isSkillInstallCaption(caption)) {
      await installFromDocument(ctx, deps, lang, dir, doc, store, downloadDocument);
      return;
    }
    if (isSkillImportCaption(caption)) {
      await importFromDocument(
        ctx,
        lang,
        dir,
        doc,
        store,
        downloadDocument,
        storageSkillTrust(deps.storage),
      );
      return;
    }
    // not ours; other handlers proceed
  });

  // ------------------------------------------------------- review buttons ----
  bot.callbackQuery(new RegExp(`^${CB_PREFIX}:(inst|uninst):([0-9a-f]{32}):(ok|no)$`), async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Best effort.
    }
    // Forged callbacks from non-owners die here: the token alone is not
    // authority, and the pending entry is NOT consumed on refusal.
    if (!isOwnerSender(ctx, deps)) {
      await safeReply(ctx, tr(lang, "ph3_skills.owner_only"));
      return;
    }
    const dir = dirOf();
    if (dir === undefined) {
      await safeReply(ctx, tr(lang, "ph3_skills.unavailable"));
      return;
    }
    const match = ctx.callbackQuery.data.match(/^ph3skill:(inst|uninst):([0-9a-f]{32}):(ok|no)$/);
    if (match === null) return;
    const [, kind, token, decision] = match;
    let text: string;
    if (kind === "inst") {
      text =
        decision === "ok"
          ? approvePendingInstall(lang, store, token!, dir)
          : rejectPendingInstall(lang, store, token!);
    } else {
      text =
        decision === "ok"
          ? approvePendingUninstall(lang, store, token!, dir, deps.storage)
          : rejectPendingUninstall(lang, store, token!);
    }
    // Collapse the review card into the result so the buttons cannot be
    // pressed twice.
    try {
      await ctx.editMessageText(text);
    } catch {
      await safeReply(ctx, text);
    }
  });

  // ----------------------------------------------- import review buttons ----
  bot.callbackQuery(new RegExp(`^${CB_PREFIX}:imp:([0-9a-f]{32}):(ok|no)$`), async (ctx) => {
    const lang = toLang(senderLang(ctx, deps.prefs));
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Best effort.
    }
    // Same rule as the install buttons: the token alone is not authority,
    // and the pending entry is NOT consumed on refusal.
    if (!isOwnerSender(ctx, deps)) {
      await safeReply(ctx, tr(lang, "ph3_skills.owner_only"));
      return;
    }
    const dir = dirOf();
    if (dir === undefined) {
      await safeReply(ctx, tr(lang, "ph3_skills.unavailable"));
      return;
    }
    const match = ctx.callbackQuery.data.match(/^ph3skill:imp:([0-9a-f]{32}):(ok|no)$/);
    if (match === null) return;
    const [, token, decision] = match;
    const text =
      decision === "ok"
        ? approvePendingImport(lang, store, token!, dir, { storage: deps.storage, trust: storageSkillTrust(deps.storage) })
        : rejectPendingImport(lang, store, token!);
    try {
      await ctx.editMessageText(text);
    } catch {
      await safeReply(ctx, text);
    }
  });
}

function documentOf(
  msg: { document?: { file_id: string; file_name?: string; file_size?: number } } | undefined,
): DocumentRef | undefined {
  const d = msg?.document;
  if (d === undefined) return undefined;
  return { fileId: d.file_id, fileName: d.file_name, fileSize: d.file_size };
}

async function installFromDocument(
  ctx: Context,
  deps: HermesCommandDeps,
  lang: Ph3SkillsLang,
  dir: string,
  doc: DocumentRef,
  store: PendingStore,
  downloadDocument: (c: Context, fileId: string) => Promise<Uint8Array | undefined>,
): Promise<void> {
  void deps;
  const fileName = doc.fileName ?? "";
  if (!fileName.toLowerCase().endsWith(".md")) {
    await safeReply(ctx, tr(lang, "ph3_skills.install.not_markdown"));
    return;
  }
  // Size cap BEFORE download.
  if (doc.fileSize !== undefined && doc.fileSize > SKILLS_MAX_FILE_BYTES) {
    await safeReply(ctx, tr(lang, "ph3_skills.install.too_large", {
      bytes: formatBytes(doc.fileSize),
      max: formatBytes(SKILLS_MAX_FILE_BYTES),
    }));
    return;
  }
  const bytes = await downloadDocument(ctx, doc.fileId);
  if (bytes === undefined) {
    await safeReply(ctx, tr(lang, "ph3_skills.install.fetch_failed", { reason: fileName }));
    return;
  }
  // ...and re-checked AFTER download (a lying file_size must not smuggle more).
  if (bytes.byteLength > SKILLS_MAX_FILE_BYTES) {
    await safeReply(
      ctx,
      tr(lang, "ph3_skills.install.too_large", {
        bytes: formatBytes(bytes.byteLength),
        max: formatBytes(SKILLS_MAX_FILE_BYTES),
      }),
    );
    return;
  }
  const text = Buffer.from(bytes).toString("utf8");
  const confirm = flagSet(ctx.message?.caption ?? ctx.message?.text, "--confirm");
  const outcome = planInstallFromText(
    lang,
    text,
    tr(lang, "ph3_skills.review.source_file"),
    dir,
    confirm,
  );
  if (outcome.outcome === "review" && outcome.pending !== undefined) {
    const token = store.createInstall(outcome.pending);
    await safeReply(ctx, outcome.text, { reply_markup: installKeyboard(lang, token) });
    return;
  }
  await safeReply(ctx, outcome.text);
}

/** Show the import review card for package text from any source. */
async function importFromPackageText(
  ctx: Context,
  lang: Ph3SkillsLang,
  dir: string,
  store: PendingStore,
  packageText: string,
  sourceLabel: string,
  trust: SkillTrust,
): Promise<void> {
  const outcome = planImportFromPackage(lang, packageText, sourceLabel, dir, trust);
  if (outcome.outcome === "review" && outcome.pending !== undefined) {
    const token = store.createInstall(outcome.pending);
    await safeReply(ctx, outcome.text, { reply_markup: importKeyboard(lang, token) });
    return;
  }
  await safeReply(ctx, outcome.text);
}

/**
 * Import a `.bobiskill` package from an uploaded document. Same size-cap
 * discipline as the `.md` install path: `file_size` before download, bytes
 * re-checked after.
 */
async function importFromDocument(
  ctx: Context,
  lang: Ph3SkillsLang,
  dir: string,
  doc: DocumentRef,
  store: PendingStore,
  downloadDocument: (c: Context, fileId: string) => Promise<Uint8Array | undefined>,
  trust: SkillTrust,
): Promise<void> {
  const fileName = doc.fileName ?? "";
  if (!fileName.toLowerCase().endsWith(SKILL_PACKAGE_EXT)) {
    await safeReply(ctx, t("ph4_skill_share.import.not_package", lang));
    return;
  }
  if (doc.fileSize !== undefined && doc.fileSize > SKILLS_MAX_FILE_BYTES) {
    await safeReply(ctx, t("ph4_skill_share.import.too_large", lang, {
      bytes: formatBytes(doc.fileSize),
      max: formatBytes(SKILLS_MAX_FILE_BYTES),
    }));
    return;
  }
  const bytes = await downloadDocument(ctx, doc.fileId);
  if (bytes === undefined) {
    await safeReply(ctx, t("ph4_skill_share.import.fetch_failed", lang, { reason: fileName }));
    return;
  }
  if (bytes.byteLength > SKILLS_MAX_FILE_BYTES) {
    await safeReply(
      ctx,
      t("ph4_skill_share.import.too_large", lang, {
        bytes: formatBytes(bytes.byteLength),
        max: formatBytes(SKILLS_MAX_FILE_BYTES),
      }),
    );
    return;
  }
  const text = Buffer.from(bytes).toString("utf8");
  await importFromPackageText(
    ctx,
    lang,
    dir,
    store,
    text,
    t("ph4_skill_share.import.source_file", lang),
    trust,
  );
}

// Re-exported for tests: the scan is what the review card surfaces.
export { scanSkillBody };
