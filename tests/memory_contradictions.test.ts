/**
 * Contradiction handling (memory-core upgrade).
 *
 * Pins the supersession contract:
 *  - a new fact with the same kind and an overlapping predicate but a
 *    different value supersedes the stored one (moved to a
 *    `superseded:` tombstone at importance 1, never deleted outright);
 *  - same-key restatements keep the existing in-place replace;
 *  - different kinds and unrelated facts are untouched;
 *  - the log entry carries subject + keys only, never values;
 *  - corrections are refused (they have their own replace path).
 */
import { describe, expect, test } from "bun:test";
import {
  extractFactCandidates,
  factKeyFor,
  type FactCandidate,
} from "../src/memory/auto_extract";
import type {
  MemoryProvider,
  MemoryUpsertOptions,
  StoredMemory,
} from "../src/memory/provider";
import {
  applyFactCandidate,
  factKindOfKey,
  findContradictions,
  type SupersessionLogEntry,
} from "../src/memory/contradictions";

class MapProvider implements MemoryProvider {
  readonly name = "map";
  rows = new Map<string, StoredMemory>();
  now = 1_800_000_000_000;

  upsert(userId: string, key: string, content: string, opts?: MemoryUpsertOptions): void {
    const id = `${userId}${key}`;
    const prev = this.rows.get(id);
    this.rows.set(id, {
      key,
      content,
      createdAt: prev?.createdAt ?? this.now,
      updatedAt: this.now,
      importance: opts?.importance ?? prev?.importance ?? 3,
    });
  }
  get(userId: string, key: string): StoredMemory | undefined {
    return this.rows.get(`${userId}${key}`);
  }
  list(userId: string, limit = 50): StoredMemory[] {
    return [...this.rows.entries()]
      .filter(([id]) => id.startsWith(`${userId}`))
      .map(([, r]) => r)
      .slice(0, limit);
  }
  delete(userId: string, key: string): boolean {
    return this.rows.delete(`${userId}${key}`);
  }
  count(userId: string): number {
    return this.list(userId, 1000).length;
  }
}

function candidate(
  kind: FactCandidate["kind"],
  topic: string,
  content: string,
): FactCandidate {
  return {
    kind,
    key: factKeyFor(kind, topic),
    content,
    importance: 3,
    isCorrection: false,
    source: "test",
  };
}

describe("contradictions: detection", () => {
  test("same kind + shared predicate + different value ⇒ contradiction", () => {
    const stored: StoredMemory[] = [
      {
        key: factKeyFor("preference", "چای"),
        content: "علی چای سبز را به قهوه ترجیح می دهد و دوست دارد",
        createdAt: 1,
        updatedAt: 2,
        importance: 3,
      },
    ];
    const next = candidate(
      "preference",
      "قهوه",
      "علی قهوه تلخ را به چای سبز ترجیح می دهد و دوست دارد",
    );
    const found = findContradictions(next, stored);
    expect(found.map((f) => f.key)).toEqual([stored[0]!.key]);
  });

  test("different kind, same value area ⇒ no contradiction", () => {
    const stored: StoredMemory[] = [
      {
        key: factKeyFor("commitment", "چای"),
        content: "علی چای سبز را به قهوه ترجیح می دهد و دوست دارد",
        createdAt: 1,
        updatedAt: 2,
        importance: 3,
      },
    ];
    const next = candidate(
      "preference",
      "قهوه",
      "علی قهوه تلخ را به چای سبز ترجیح می دهد و دوست دارد",
    );
    expect(findContradictions(next, stored)).toEqual([]);
  });

  test("same key is not a contradiction (in-place replace territory)", () => {
    const stored: StoredMemory[] = [
      {
        key: factKeyFor("preference", "چای"),
        content: "علی چای دوست دارد",
        createdAt: 1,
        updatedAt: 2,
        importance: 3,
      },
    ];
    const next = candidate("preference", "چای", "علی چای دوست ندارد");
    expect(findContradictions(next, stored)).toEqual([]);
  });

  test("factKindOfKey parses the taxonomy", () => {
    expect(factKindOfKey("fact:name")).toBe("name");
    expect(factKindOfKey(factKeyFor("preference", "x"))).toBe("preference");
    expect(factKindOfKey("episode:chat:123")).toBeUndefined();
    expect(factKindOfKey("note:1")).toBeUndefined();
  });
});

describe("contradictions: apply", () => {
  test("new fact supersedes the old: tombstone at importance 1, new value stored, log has no values", async () => {
    const p = new MapProvider();
    const oldKey = factKeyFor("preference", "چای");
    p.upsert("u", oldKey, "علی چای سبز را به قهوه ترجیح می دهد و دوست دارد", { importance: 4 });
    const logs: SupersessionLogEntry[] = [];
    const next = candidate(
      "preference",
      "قهوه",
      "علی قهوه تلخ را به چای سبز ترجیح می دهد و دوست دارد",
    );
    const r = await applyFactCandidate(p, "u", next, (e) => logs.push(e));
    expect(r.stored).toBe(true);
    expect(r.superseded).toEqual([oldKey]);
    // old fact is gone from its key, preserved as a tombstone
    expect(p.get("u", oldKey)).toBeUndefined();
    const tomb = p.get("u", `superseded:${oldKey}`);
    expect(tomb).toBeDefined();
    expect(tomb!.importance).toBe(1);
    expect(tomb!.content).toContain("چای سبز");
    // new fact lives at its own key
    expect(p.get("u", next.key)!.content).toContain("قهوه تلخ");
    // log: subject + keys only, no values anywhere
    expect(logs).toHaveLength(1);
    expect(logs[0]!.kind).toBe("preference");
    expect(logs[0]!.supersededKey).toBe(oldKey);
    expect(JSON.stringify(logs)).not.toContain("قهوه تلخ");
  });

  test("extracted candidates round-trip through applyFactCandidate", async () => {
    const p = new MapProvider();
    const [first] = extractFactCandidates(["اسمم علی است"]);
    expect(first).toBeDefined();
    const r = await applyFactCandidate(p, "u", first!);
    expect(r.stored).toBe(true);
    expect(p.get("u", "fact:name")!.content).toContain("علی");
  });

  test("corrections are refused (they own a different replace path)", async () => {
    const p = new MapProvider();
    const corr: FactCandidate = {
      kind: "correction",
      key: "fact:correction:xyz",
      content: "نه اشتباه گفتی اسمم رضا است",
      importance: 5,
      isCorrection: true,
      source: "test",
    };
    await expect(applyFactCandidate(p, "u", corr)).rejects.toThrow(
      /findCorrectionTarget/,
    );
  });
});
