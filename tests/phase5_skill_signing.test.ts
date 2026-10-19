/**
 * Phase 5, item 1 — ed25519 signing for skill packages + trusted publishers.
 *
 * Deterministic: filesystem work happens in temp dirs, SQLite in memory, no
 * network, no Telegram. Covers the keygen/sign/verify round-trip, tampered
 * package rejection (checksum AND signature layers), the key-id binding,
 * trust/untrust/revoke behavior, install provenance, unsigned imports still
 * working with explicit approval, and the review-card signature lines.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSigningKeypair,
  fingerprintPublicKey,
  signCanonicalPayload,
  verifyCanonicalSignature,
  parsePublisherInput,
  shortKeyId,
  SIGNATURE_ALG,
} from "../src/skills/signing";
import {
  buildSkillPackage,
  verifySkillPackage,
  planSkillImport,
  type PackageSigner,
} from "../src/skills/share";
import { listInstalledSkillNames } from "../src/skills/install";
import { Storage } from "../src/storage/storage";
import {
  PendingStore,
  handleSkillExport,
  handleSkillKeygen,
  handleSkillKeyExport,
  handleSkillTrust,
  handleSkillUntrust,
  handleSkillTrustedList,
  handleSkillList,
  planImportFromPackage,
  approvePendingImport,
  renderImportError,
  renderSignatureStatus,
  renderImportReviewCard,
  storageSkillTrust,
  exportSigner,
} from "../src/bot/cmd_phase3_skills";
import type { SkillTrust } from "../src/bot/cmd_phase3_skills";

const SKILL = `---
name: memory-coach
description: A coach that sharpens memory habits.
version: 1.2.0
triggers: [memory, habits]
---
# Memory Coach

Review your memories every morning.
Second line.
Third line.
Fourth line.
Fifth line.
Sixth line.
`;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ph5-sign-"));
}

function writeSkill(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, `${name}.md`), text);
}

function keypair(): PackageSigner {
  const kp = generateSigningKeypair();
  return { publicKeyB64: kp.publicKeyB64, privateKeyJwk: kp.privateKeyJwk };
}

function memStorage(): Storage {
  return Storage.open(":memory:");
}

// ---------------------------------------------------------------- crypto ----

describe("ed25519 signing primitives", () => {
  test("keygen produces a 32-byte key with a 64-hex fingerprint", () => {
    const kp = generateSigningKeypair();
    expect(kp.keyId).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(kp.publicKeyB64, "base64").length).toBe(32);
    expect(fingerprintPublicKey(kp.publicKeyB64)).toBe(kp.keyId);
  });

  test("sign/verify round-trip", () => {
    const kp = generateSigningKeypair();
    const sig = signCanonicalPayload("hello canonical", kp.privateKeyJwk);
    expect(verifyCanonicalSignature("hello canonical", kp.publicKeyB64, sig)).toBe(true);
  });

  test("verification fails on tampered message", () => {
    const kp = generateSigningKeypair();
    const sig = signCanonicalPayload("hello canonical", kp.privateKeyJwk);
    expect(verifyCanonicalSignature("hello canonical!", kp.publicKeyB64, sig)).toBe(false);
  });

  test("verification fails with the wrong key", () => {
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    const sig = signCanonicalPayload("hello canonical", a.privateKeyJwk);
    expect(verifyCanonicalSignature("hello canonical", b.publicKeyB64, sig)).toBe(false);
  });

  test("verification never throws on malformed input", () => {
    const kp = generateSigningKeypair();
    expect(verifyCanonicalSignature("x", "not-base64!!!", "also-bad")).toBe(false);
    expect(verifyCanonicalSignature("x", kp.publicKeyB64, "short")).toBe(false);
    expect(verifyCanonicalSignature("x", Buffer.alloc(16).toString("base64"), "eA==")).toBe(false);
  });

  test("parsePublisherInput accepts key ids and public keys, rejects garbage", () => {
    const kp = generateSigningKeypair();
    expect(parsePublisherInput(kp.keyId)).toEqual({ kind: "key_id" });
    expect(parsePublisherInput(kp.keyId.toUpperCase())).toEqual({ kind: "key_id" });
    const parsed = parsePublisherInput(kp.publicKeyB64);
    expect(parsed.kind).toBe("public_key");
    if (parsed.kind === "public_key") {
      expect(fingerprintPublicKey(parsed.publicKeyB64)).toBe(kp.keyId);
    }
    expect(parsePublisherInput("hello")).toEqual({ kind: "invalid" });
    expect(parsePublisherInput("")).toEqual({ kind: "invalid" });
    expect(parsePublisherInput("z".repeat(64))).toEqual({ kind: "invalid" });
  });

  test("shortKeyId truncates long ids", () => {
    expect(shortKeyId("a".repeat(64))).toBe(`${"a".repeat(12)}…`);
  });
});

// ------------------------------------------------------- package signing ----

describe("signed package export/verify", () => {
  test("signed export carries a verifiable signature block", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const signer = keypair();
    const built = buildSkillPackage(dir, "memory-coach", { signer });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.pkg.signed).toBe(true);
    expect(built.pkg.keyId).toMatch(/^[0-9a-f]{64}$/);

    const env = JSON.parse(built.pkg.text) as Record<string, unknown>;
    const sig = env["signature"] as Record<string, unknown>;
    expect(sig["alg"]).toBe(SIGNATURE_ALG);
    expect(sig["keyId"]).toBe(built.pkg.keyId);
    expect(typeof sig["publicKey"]).toBe("string");
    expect(typeof sig["sig"]).toBe("string");

    const verified = verifySkillPackage(built.pkg.text);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.pkg.signature?.keyId).toBe(built.pkg.keyId);
  });

  test("unsigned export still verifies (signature absent)", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const built = buildSkillPackage(dir, "memory-coach");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.pkg.signed).toBe(false);
    const verified = verifySkillPackage(built.pkg.text);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.pkg.signature).toBeUndefined();
  });

  test("tampered skill bytes break the checksum (unsigned package)", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const built = buildSkillPackage(dir, "memory-coach");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const tampered = built.pkg.text.replace("every morning", "every evening");
    const verified = verifySkillPackage(tampered);
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.error.kind).toBe("checksum_mismatch");
  });

  test("corrupted signature block is a hard reject (bad_signature)", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const built = buildSkillPackage(dir, "memory-coach", { signer: keypair() });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Corrupt the signature itself: the checksum (which does not cover the
    // signature block) still matches, so this exercises the signature layer.
    const env = JSON.parse(built.pkg.text) as Record<string, { sig: string }>;
    env["signature"]!.sig = Buffer.alloc(64, 7).toString("base64");
    const verified = verifySkillPackage(JSON.stringify(env));
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.error.kind).toBe("bad_signature");
    expect(renderImportError("en", verified.error, "test")).toContain("Bad package signature");
    expect(renderImportError("en", verified.error, "test")).toContain("Bad package signature");
  });

  test("signature transplanted under a different key id is rejected", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const built = buildSkillPackage(dir, "memory-coach", { signer: keypair() });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Attacker swaps in their own keypair but keeps the victim's keyId.
    const attacker = generateSigningKeypair();
    const env = JSON.parse(built.pkg.text) as Record<string, Record<string, string>>;
    env["signature"]!["publicKey"] = attacker.publicKeyB64;
    const verified = verifySkillPackage(JSON.stringify(env));
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.error.kind).toBe("bad_signature");
  });

  test("attacker keypair verifies as a signature but is not trusted", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const attacker = generateSigningKeypair();
    const built = buildSkillPackage(dir, "memory-coach", {
      signer: { publicKeyB64: attacker.publicKeyB64, privateKeyJwk: attacker.privateKeyJwk },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // The signature itself is valid…
    const verified = verifySkillPackage(built.pkg.text);
    expect(verified.ok).toBe(true);
    // …but nobody trusts that key.
    const plan = planSkillImport({
      packageText: built.pkg.text,
      sourceLabel: "test",
      dir,
      isTrustedPublisher: () => false,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.plan.signature?.trusted).toBe(false);
    const card = renderImportReviewCard("en", plan.plan);
    expect(card).toContain("unknown key");
  });

  test("corrupt signer fails the export, never ships a bad package", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const kp = generateSigningKeypair();
    const bad = buildSkillPackage(dir, "memory-coach", {
      signer: { publicKeyB64: kp.publicKeyB64, privateKeyJwk: "not-json" },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.kind).toBe("signer_invalid");
  });
});

// ------------------------------------------------------------------ trust ----

describe("trusted-publisher registry", () => {
  test("trust / untrust / list round-trip", () => {
    const s = memStorage();
    const kp = generateSigningKeypair();
    expect(s.getTrustedSkillPublisher(kp.keyId)).toBeUndefined();
    expect(s.listTrustedSkillPublishers()).toHaveLength(0);

    const first = s.trustSkillPublisher({ keyId: kp.keyId, label: "me", publicKey: kp.publicKeyB64 });
    expect(first.added).toBe(true);
    expect(s.getTrustedSkillPublisher(kp.keyId)?.label).toBe("me");

    const second = s.trustSkillPublisher({ keyId: kp.keyId, label: "me-2", publicKey: "" });
    expect(second.added).toBe(false);
    // Re-trust keeps the known public key when the new call carries none.
    expect(s.getTrustedSkillPublisher(kp.keyId)).toMatchObject({
      label: "me-2",
      publicKey: kp.publicKeyB64,
    });
    expect(s.listTrustedSkillPublishers()).toHaveLength(1);

    expect(s.untrustSkillPublisher(kp.keyId)).toBe(true);
    expect(s.untrustSkillPublisher(kp.keyId)).toBe(false);
    expect(s.getTrustedSkillPublisher(kp.keyId)).toBeUndefined();
  });

  test("signing key storage round-trip", () => {
    const s = memStorage();
    expect(s.getSkillSigningKey()).toBeUndefined();
    const kp = generateSigningKeypair();
    s.setSkillSigningKey({ keyId: kp.keyId, publicKey: kp.publicKeyB64, privateKeyJwk: kp.privateKeyJwk });
    const row = s.getSkillSigningKey();
    expect(row?.keyId).toBe(kp.keyId);
    expect(row?.privateKeyJwk).toBe(kp.privateKeyJwk);
  });

  test("install provenance round-trip", () => {
    const s = memStorage();
    expect(s.getSkillInstallProvenance("memory-coach")).toBeUndefined();
    s.recordSkillInstallProvenance({ skillName: "memory-coach", keyId: "abc" });
    expect(s.getSkillInstallProvenance("memory-coach")?.keyId).toBe("abc");
    s.recordSkillInstallProvenance({ skillName: "memory-coach", keyId: null });
    expect(s.getSkillInstallProvenance("memory-coach")?.keyId).toBeNull();
    s.removeSkillInstallProvenance("memory-coach");
    expect(s.getSkillInstallProvenance("memory-coach")).toBeUndefined();
  });
});

// ------------------------------------------------------------ key commands ----

describe("/skill keygen and keyexport", () => {
  test("keygen creates, refuses twice, regenerates with --force", () => {
    const s = memStorage();
    const first = handleSkillKeygen("en", s, false);
    expect(first).toContain("keypair");
    const keyId1 = s.getSkillSigningKey()!.keyId;

    const again = handleSkillKeygen("en", s, false);
    expect(again).toContain("already exists");
    expect(s.getSkillSigningKey()!.keyId).toBe(keyId1);

    const forced = handleSkillKeygen("en", s, true);
    expect(forced).toContain("Fresh key");
    expect(s.getSkillSigningKey()!.keyId).not.toBe(keyId1);
  });

  test("keyexport returns the private key as a document payload", () => {
    const s = memStorage();
    const missing = handleSkillKeyExport("en", s);
    expect(missing.ok).toBe(false);

    handleSkillKeygen("en", s, false);
    const res = handleSkillKeyExport("en", s);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fileName).toBe("bobi-skill-signing-key.json");
    const payload = JSON.parse(res.text) as Record<string, unknown>;
    expect(payload["keyId"]).toBe(res.keyId);
    expect((payload["privateKeyJwk"] as Record<string, string>)["d"]).toBeDefined();
  });

  test("exportSigner reflects keygen state", () => {
    const s = memStorage();
    expect(exportSigner(s)).toBeUndefined();
    handleSkillKeygen("en", s, false);
    const signer = exportSigner(s);
    expect(signer?.publicKeyB64).toBe(s.getSkillSigningKey()!.publicKey);
  });
});

describe("/skill trust, untrust, trusted", () => {
  test("trust by public key, then by key id", () => {
    const s = memStorage();
    const kp = generateSigningKeypair();
    const added = handleSkillTrust("en", s, kp.publicKeyB64, "دوستم");
    expect(added).toContain("دوستم");
    expect(added).toContain("trust list");
    expect(s.getTrustedSkillPublisher(kp.keyId)?.publicKey).toBe(kp.publicKeyB64);

    const other = generateSigningKeypair();
    const added2 = handleSkillTrust("en", s, other.keyId, undefined);
    expect(added2).toContain("added to the trust list");
    expect(s.getTrustedSkillPublisher(other.keyId)?.label).toBe(`key-${other.keyId.slice(0, 8)}`);
  });

  test("trust rejects garbage input", () => {
    const s = memStorage();
    expect(handleSkillTrust("en", s, "nope", undefined)).toContain("Invalid input");
    expect(handleSkillTrust("en", s, undefined, undefined)).toContain("Give a publisher id");
  });

  test("untrust revokes; unknown id reports missing", () => {
    const s = memStorage();
    const kp = generateSigningKeypair();
    handleSkillTrust("en", s, kp.keyId, "x");
    const removed = handleSkillUntrust("en", s, kp.keyId);
    expect(removed).toContain("removed from the trust list");
    expect(handleSkillUntrust("en", s, kp.keyId)).toContain("not in the trust list");
    expect(handleSkillUntrust("en", s, undefined)).toContain("Give a publisher id");
  });

  test("trusted lists labels", () => {
    const s = memStorage();
    expect(handleSkillTrustedList("en", s)).toContain("Trust list is empty");
    const a = generateSigningKeypair();
    const b = generateSigningKeypair();
    handleSkillTrust("en", s, a.keyId, "آلفا");
    handleSkillTrust("en", s, b.keyId, "بتا");
    const list = handleSkillTrustedList("en", s);
    expect(list).toContain("آلفا");
    expect(list).toContain("بتا");
    expect(list).toContain("(2)");
  });
});

// ------------------------------------------------------- import flows ----

function signedPackage(dir: string, signer: PackageSigner): string {
  const built = buildSkillPackage(dir, "memory-coach", { signer });
  if (!built.ok) throw new Error("build failed");
  return built.pkg.text;
}

describe("signed import flows", () => {
  test("unsigned import still works with explicit approval", () => {
    const dir = tmpDir();
    const store = new PendingStore();
    const outcome = planImportFromPackage("en", buildSkillPackageSource(dir), "file", dir);
    expect(outcome.outcome).toBe("review");
    expect(outcome.text).toContain("Unsigned");
    const token = store.createInstall(outcome.pending!);
    const done = approvePendingImport("en", store, token, dir);
    expect(done).toContain("imported");
    // Disabled by default.
    expect(listInstalledSkillNames(dir)).toEqual([{ name: "memory-coach", enabled: false }]);
  });

  test("trusted-signed import shows the trusted line and compact card", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const s = memStorage();
    const kp = generateSigningKeypair();
    s.trustSkillPublisher({ keyId: kp.keyId, label: "ناشر خوب", publicKey: kp.publicKeyB64 });
    const trust: SkillTrust = storageSkillTrust(s);

    const pkg = signedPackage(dir, { publicKeyB64: kp.publicKeyB64, privateKeyJwk: kp.privateKeyJwk });
    const outcome = planImportFromPackage("en", pkg, "file", dir, trust);
    expect(outcome.outcome).toBe("review");
    expect(outcome.text).toContain("trusted publisher");
    expect(outcome.text).toContain("ناشر خوب");
    // Compact card: the 6th body line is beyond the 5-line preview.
    expect(outcome.text).not.toContain("Sixth line.");

    // Approve records provenance.
    const store = new PendingStore();
    const token = store.createInstall(outcome.pending!);
    approvePendingImport("en", store, token, dir, { storage: s, trust });
    expect(s.getSkillInstallProvenance("memory-coach")?.keyId).toBe(kp.keyId);

    // /skill list shows the trusted publisher.
    const list = handleSkillList("en", dir, s);
    expect(list).toContain("ناشر خوب");
  });

  test("revocation flags the installed skill in /skill list", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const s = memStorage();
    const kp = generateSigningKeypair();
    s.trustSkillPublisher({ keyId: kp.keyId, label: "ناشر خوب", publicKey: kp.publicKeyB64 });
    const trust: SkillTrust = storageSkillTrust(s);

    const pkg = signedPackage(dir, { publicKeyB64: kp.publicKeyB64, privateKeyJwk: kp.privateKeyJwk });
    const store = new PendingStore();
    const outcome = planImportFromPackage("en", pkg, "file", dir, trust);
    const token = store.createInstall(outcome.pending!);
    approvePendingImport("en", store, token, dir, { storage: s, trust });

    // Revoke…
    s.untrustSkillPublisher(kp.keyId);
    const list = handleSkillList("en", dir, s);
    expect(list).toContain("memory-coach");
    expect(list).toContain("publisher not trusted");
    // …and the English twin renders too.
    expect(handleSkillList("en", dir, s)).toContain("publisher not trusted");
  });

  test("bad-signature package is a hard reject at import time", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const pkg = signedPackage(dir, keypair());
    const env = JSON.parse(pkg) as Record<string, { sig: string }>;
    env["signature"]!.sig = Buffer.alloc(64, 9).toString("base64");
    const outcome = planImportFromPackage("en", JSON.stringify(env), "file", dir);
    expect(outcome.outcome).toBe("error");
    expect(outcome.text).toContain("Bad package signature");
  });

  test("approve re-verifies: a swapped packageText is rejected", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const pkg = signedPackage(dir, keypair());
    const store = new PendingStore();
    const outcome = planImportFromPackage("en", pkg, "file", dir);
    expect(outcome.outcome).toBe("review");
    // Attacker swaps the pending envelope after the review card was shown.
    outcome.pending!.packageText = pkg.replace("memory-coach", "memory-evil");
    const token = store.createInstall(outcome.pending!);
    const done = approvePendingImport("en", store, token, dir);
    expect(done).toContain("tampered with");
  });

  test("renderSignatureStatus covers all three states", () => {
    const kp = generateSigningKeypair();
    const trust: SkillTrust = {
      isTrusted: (id) => id === kp.keyId,
      labelOf: (id) => (id === kp.keyId ? "خودم" : undefined),
    };
    expect(renderSignatureStatus("en", undefined, trust)).toContain("Unsigned");
    expect(
      renderSignatureStatus("en", { keyId: kp.keyId, publicKeyB64: kp.publicKeyB64, trusted: true }, trust),
    ).toContain("خودم");
    const other = generateSigningKeypair();
    expect(
      renderSignatureStatus("en", { keyId: other.keyId, publicKeyB64: other.publicKeyB64, trusted: false }, trust),
    ).toContain("unknown key");
  });

  test("/skill list on an empty dir", () => {
    const s = memStorage();
    expect(handleSkillList("en", tmpDir(), s)).toContain("No skills installed");
  });
});

/** Build an unsigned package for the plain import test. */
function buildSkillPackageSource(dir: string): string {
  writeSkill(dir, "memory-coach", SKILL);
  const built = buildSkillPackage(dir, "memory-coach");
  if (!built.ok) throw new Error("build failed");
  return built.pkg.text;
}

// ------------------------------------------------------- export command ----

describe("/skill export with signing", () => {
  test("handleSkillExport signs when a signer is passed", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const plain = handleSkillExport(dir, "memory-coach");
    expect(plain.ok && plain.signed).toBe(false);

    const kp = keypair();
    const signed = handleSkillExport(dir, "memory-coach", { signer: kp });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.signed).toBe(true);
    expect(signed.keyId).toMatch(/^[0-9a-f]{64}$/);
    const verified = verifySkillPackage(signed.text);
    expect(verified.ok).toBe(true);
  });

  test("handleSkillExport maps a corrupt signer", () => {
    const dir = tmpDir();
    writeSkill(dir, "memory-coach", SKILL);
    const kp = generateSigningKeypair();
    const res = handleSkillExport(dir, "memory-coach", {
      signer: { publicKeyB64: kp.publicKeyB64, privateKeyJwk: "junk" },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("signer_invalid");
  });
});
