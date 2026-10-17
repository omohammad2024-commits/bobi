import { describe, expect, test } from "bun:test";
import { parseOwnerId, OwnerIdentity } from "../src/auth/identity";

// ---------- owner id validation ----------

describe("parseOwnerId", () => {
  test("accepts valid Telegram ids", () => {
    expect(parseOwnerId("123456789")).toEqual({ ok: true, ownerId: 123456789 });
    expect(parseOwnerId("1")).toEqual({ ok: true, ownerId: 1 });
    expect(parseOwnerId("  987654321  ")).toEqual({ ok: true, ownerId: 987654321 });
  });

  test("accepts the safe-integer maximum", () => {
    const max = "9007199254740991";
    expect(parseOwnerId(max)).toEqual({ ok: true, ownerId: 9_007_199_254_740_991 });
  });

  test("rejects a missing value", () => {
    expect(parseOwnerId(undefined)).toEqual({ ok: false, reason: "missing" });
  });

  test("rejects empty and whitespace-only values", () => {
    expect(parseOwnerId("")).toEqual({ ok: false, reason: "empty" });
    expect(parseOwnerId("   ")).toEqual({ ok: false, reason: "empty" });
  });

  test("rejects non-numeric values", () => {
    for (const bad of ["abc", "12px", "1e5", "0x10", "12,5", "+1", "1 2", "id:123"]) {
      expect(parseOwnerId(bad).ok).toBe(false);
    }
  });

  test("rejects decimal values", () => {
    for (const bad of ["123.0", "123.456", "0.5"]) {
      const r = parseOwnerId(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("decimal");
    }
  });

  test("rejects negative and zero", () => {
    const neg = parseOwnerId("-1");
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.reason).toBe("not_numeric");
    expect(parseOwnerId("0").ok).toBe(false);
    expect(parseOwnerId("-123").ok).toBe(false);
  });

  test("rejects a value beyond the safe integer range", () => {
    expect(parseOwnerId("99999999999999999999").ok).toBe(false);
  });

  test("rejects leading zeros", () => {
    expect(parseOwnerId("0123").ok).toBe(false);
  });
});

// ---------- owner identity ----------

describe("OwnerIdentity", () => {
  test("builds from a valid raw value", () => {
    const id = OwnerIdentity.fromRawValue("55555");
    expect(id.configured).toBe(true);
    expect(id.ownerId).toBe(55555);
  });

  test("invalid raw value yields no owner, not a default", () => {
    for (const bad of [undefined, "", "abc", "-1", "0", "1.5"]) {
      const id = OwnerIdentity.fromRawValue(bad);
      expect(id.configured).toBe(false);
      expect(id.ownerId).toBeUndefined();
    }
  });

  test("unconfigured owner matches nobody", () => {
    const id = OwnerIdentity.none();
    expect(id.isOwner(55555)).toBe(false);
    expect(id.isOwner(1)).toBe(false);
    expect(id.isOwner(undefined)).toBe(false);
  });

  test("isOwner matches only the configured numeric id", () => {
    const id = OwnerIdentity.fromRawValue("55555");
    expect(id.isOwner(55555)).toBe(true);
    expect(id.isOwner(55556)).toBe(false);
    expect(id.isOwner(0)).toBe(false);
    expect(id.isOwner(undefined)).toBe(false);
  });

  test("isOwnerValue requires an actual number, not a lookalike", () => {
    const id = OwnerIdentity.fromRawValue("55555");
    // None of these may authenticate as the owner: strings, objects, arrays,
    // booleans and null all fail the typeof check. (Note 55555.0 is the number
    // 55555 and legitimately matches — that is covered separately.)
    for (const spoof of ["55555", "@owner", true, { id: 55555 }, ["55555"], null, undefined]) {
      expect(id.isOwnerValue(spoof)).toBe(false);
    }
  });

  test("isOwnerValue accepts a safe-integer match only", () => {
    const id = OwnerIdentity.fromRawValue("42");
    expect(id.isOwnerValue(42)).toBe(true);
    expect(id.isOwnerValue(42.5)).toBe(false);
    expect(id.isOwnerValue("42")).toBe(false);
  });

  test("a huge number is not the owner", () => {
    const id = OwnerIdentity.fromRawValue("42");
    expect(id.isOwner(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
  });
});
