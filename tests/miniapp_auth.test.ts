/**
 * initData validation — known-answer vectors.
 *
 * A valid initData is built in-test with a fixed bot token (the signing code
 * here is deliberately independent of src/miniapp/auth.ts), then tampered or
 * aged to exercise every rejection path.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { validateInitData } from "../src/miniapp/auth";

const BOT_TOKEN = "fixed-test-bot-token-123";
const OWNER_ID = "777000";

function signInitData(fields: Record<string, string>): string {
  const pairs = Object.entries(fields)
    .filter(([k]) => k !== "hash")
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const dataCheckString = pairs.join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN, "utf8").digest();
  const hash = createHmac("sha256", secret).update(dataCheckString, "utf8").digest("hex");
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

function freshFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAHdF6IQAAAAAN0XohDhr9eA",
    user: JSON.stringify({ id: Number(OWNER_ID), first_name: "Test", language_code: "fa" }),
    ...overrides,
  };
}

describe("validateInitData", () => {
  test("a correctly signed initData validates", () => {
    const initData = signInitData(freshFields());
    const r = validateInitData(initData, BOT_TOKEN, OWNER_ID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.userId).toBe(OWNER_ID);
  });

  test("tampering with any field breaks the signature", () => {
    const initData = signInitData(freshFields());
    const tampered = initData.replace("first_name", "first_naMe");
    // If the replace didn't hit, flip a digit in the query_id instead.
    const target =
      tampered !== initData
        ? tampered
        : initData.replace("AAHdF6IQ", "BAHdF6IQ");
    const r = validateInitData(target, BOT_TOKEN, OWNER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_hash");
  });

  test("a forged hash is rejected", () => {
    const initData = signInitData(freshFields()).replace(/hash=[^&]*$/, "hash=deadbeef");
    const r = validateInitData(initData, BOT_TOKEN, OWNER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_hash");
  });

  test("the wrong bot token fails the signature", () => {
    const initData = signInitData(freshFields());
    const r = validateInitData(initData, "another-token", OWNER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_hash");
  });

  test("auth_date older than 24h is stale", () => {
    const old = String(Math.floor(Date.now() / 1000) - 25 * 60 * 60);
    const initData = signInitData(freshFields({ auth_date: old }));
    const r = validateInitData(initData, BOT_TOKEN, OWNER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale");
  });

  test("auth_date just inside 24h is accepted", () => {
    const recent = String(Math.floor(Date.now() / 1000) - 23 * 60 * 60);
    const initData = signInitData(freshFields({ auth_date: recent }));
    expect(validateInitData(initData, BOT_TOKEN, OWNER_ID).ok).toBe(true);
  });

  test("a different user id is not the owner", () => {
    const initData = signInitData(
      freshFields({
        user: JSON.stringify({ id: 123456789, first_name: "Intruder" }),
      }),
    );
    const r = validateInitData(initData, BOT_TOKEN, OWNER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_owner");
  });

  test("a missing user object is rejected", () => {
    const fields = freshFields();
    delete fields["user"];
    const initData = signInitData(fields);
    const r = validateInitData(initData, BOT_TOKEN, OWNER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_user");
  });

  test("empty initData is rejected without touching crypto", () => {
    for (const bad of ["", "   "]) {
      const r = validateInitData(bad, BOT_TOKEN, OWNER_ID);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("empty");
    }
  });

  test("a missing hash is a signature failure", () => {
    const params = new URLSearchParams(freshFields());
    const r = validateInitData(params.toString(), BOT_TOKEN, OWNER_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_hash");
  });
});
