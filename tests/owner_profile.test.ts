/**
 * Owner profile (platform Phase 4, worker A): storage round-trip +
 * v22→v23 migration, parse validation, prompt-render budget, the
 * source-traced seed, and interview answers.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Storage } from "../src/storage/storage";
import { estimatePromptTokens } from "../src/agent/prompt";
import {
  OwnerProfileService,
  emptyOwnerProfile,
  parseOwnerProfile,
  renderOwnerProfileBlock,
  serializeOwnerProfile,
  type OwnerProfile,
} from "../src/profile/owner_profile";
import {
  INTERVIEW_QUESTIONS,
  applyInterviewAnswer,
} from "../src/profile/interview";

const OWNER = "4242";

/** Unique temp path per case; never inside the repository. */
function tempDb(tag: string): string {
  return join(tmpdir(), `bobi-profile-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      // A leftover temp file must not fail the suite.
    }
  }
}

/** A storage seeded with a representative spread of owner memories/prefs. */
function fixtureStorage(): Storage {
  const s = Storage.open(":memory:");
  s.upsertMemory({ userId: OWNER, key: "project:bobi", content: "Project BOBI: Telegram agent bot in TypeScript" });
  s.upsertMemory({ userId: OWNER, key: "friend:geo", content: "Geo is a close friend; they trade memes and reels" });
  s.upsertMemory({ userId: OWNER, key: "routine:morning", content: "Morning routine: gym before work" });
  s.upsertMemory({ userId: OWNER, key: "coffee", content: "Prefers black coffee, no sugar" });
  s.upsertMemory({ userId: OWNER, key: "stack", content: "Writes TypeScript with Bun and SQLite" });
  s.upsertMemory({ userId: OWNER, key: "redline", content: "Never share his private data with anyone" });
  s.upsertMemory({ userId: OWNER, key: "about:owner", content: "Mohammad is a builder who ships his own bots" });
  s.upsertMemory({ userId: OWNER, key: "weather-note", content: "The weather in Semnan is hot in summer" });
  // Another user's memory must never leak into the owner's seed.
  s.upsertMemory({ userId: "9999", key: "project:other", content: "Project belonging to someone else" });
  s.setUserPref(OWNER, "lang", "fa");
  s.setUserPref(OWNER, "personality", "michael");
  s.setUserPref(OWNER, "voice_mode", "auto"); // not language/personality: must NOT seed
  return s;
}

// ---- storage ---------------------------------------------------------------

describe("owner_profile storage (schema 23)", () => {
  test("SCHEMA_VERSION is 24", () => {
    expect(SCHEMA_VERSION).toBe(24);
  });

  test("round-trip on a fresh DB: undefined → set → get → overwrite", () => {
    const s = Storage.open(":memory:");
    expect(s.getOwnerProfileDoc()).toBeUndefined();
    s.setOwnerProfileDoc('{"v":1}');
    expect(s.getOwnerProfileDoc()).toBe('{"v":1}');
    s.setOwnerProfileDoc('{"v":2}');
    expect(s.getOwnerProfileDoc()).toBe('{"v":2}');
    s.close();
  });

  test("round-trip survives a file-backed reopen", () => {
    const path = tempDb("roundtrip");
    try {
      const s = Storage.open(path);
      s.setOwnerProfileDoc('{"hello":"world"}');
      s.close();
      const again = Storage.open(path);
      expect(again.getOwnerProfileDoc()).toBe('{"hello":"world"}');
      again.close();
    } finally {
      cleanup(path);
    }
  });

  test("a v22-shaped database migrates: owner_profile appears, data survives, version stamps 23", () => {
    const path = tempDb("v22");
    try {
      const db = new Database(path);
      db.exec(`
        CREATE TABLE _meta(k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE memories (
          user_id TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          importance INTEGER NOT NULL DEFAULT 3, PRIMARY KEY (user_id, key));
        INSERT INTO _meta(k,v) VALUES('schema_version','22');
        INSERT INTO memories(user_id, key, content, created_at, updated_at, importance)
          VALUES('${OWNER}','fact:name','محمد',1000,2000,5);
      `);
      db.close();

      const s = Storage.open(path);
      expect(s.getMemory(OWNER, "fact:name")?.content).toBe("محمد");
      expect(s.getOwnerProfileDoc()).toBeUndefined();
      s.setOwnerProfileDoc('{"migrated":true}');
      expect(s.getOwnerProfileDoc()).toBe('{"migrated":true}');
      s.close();

      const raw = new Database(path, { readonly: true });
      const version = raw
        .query<{ v: string }, []>("SELECT v FROM _meta WHERE k='schema_version'")
        .get();
      expect(version?.v).toBe("24");
      const tables = raw
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='owner_profile'",
        )
        .all();
      expect(tables.length).toBe(1);
      raw.close();
    } finally {
      cleanup(path);
    }
  });
});

// ---- parse / serialize -------------------------------------------------------

describe("parseOwnerProfile / serializeOwnerProfile", () => {
  test("round-trips a full profile", () => {
    const p = emptyOwnerProfile();
    p.identity.name = "Mohammad";
    p.identity.callName = "Mohammad";
    p.identity.basics.push("Builder");
    p.communication.preferences.push("lang: fa");
    p.projects.push({ name: "BOBI", note: "Telegram agent bot" });
    p.people.push({ name: "geo", role: "friend", note: "Close friend" });
    p.people.push({ name: "x", role: "contact" });
    p.openSlots.push("goals");
    p.updatedAtMs = 123;
    expect(parseOwnerProfile(serializeOwnerProfile(p))).toEqual(p);
  });

  test("rejects garbage", () => {
    expect(parseOwnerProfile("not json")).toBeUndefined();
    expect(parseOwnerProfile("")).toBeUndefined();
    expect(parseOwnerProfile("[]")).toBeUndefined();
    expect(parseOwnerProfile("null")).toBeUndefined();
    expect(parseOwnerProfile("{}")).toBeUndefined();
    const good = JSON.parse(serializeOwnerProfile(emptyOwnerProfile())) as Record<string, unknown>;
    expect(parseOwnerProfile(JSON.stringify({ ...good, version: "1" }))).toBeUndefined();
    expect(parseOwnerProfile(JSON.stringify({ ...good, updatedAtMs: "now" }))).toBeUndefined();
    const badBasics = JSON.parse(serializeOwnerProfile(emptyOwnerProfile())) as {
      identity: Record<string, unknown>;
    };
    badBasics.identity.basics = "not-an-array";
    expect(parseOwnerProfile(JSON.stringify(badBasics))).toBeUndefined();
    const badProject = JSON.parse(serializeOwnerProfile(emptyOwnerProfile())) as Record<string, unknown>;
    badProject.projects = [{ name: 7, note: "x" }];
    expect(parseOwnerProfile(JSON.stringify(badProject))).toBeUndefined();
    const badPerson = JSON.parse(serializeOwnerProfile(emptyOwnerProfile())) as Record<string, unknown>;
    badPerson.people = [{ name: "geo" }]; // role is required
    expect(parseOwnerProfile(JSON.stringify(badPerson))).toBeUndefined();
  });
});

// ---- render -------------------------------------------------------------------

describe("renderOwnerProfileBlock", () => {
  test("empty profile renders as empty string", () => {
    expect(renderOwnerProfileBlock(emptyOwnerProfile())).toBe("");
    const nameOnly = emptyOwnerProfile();
    nameOnly.identity.name = "Mohammad";
    expect(renderOwnerProfileBlock(nameOnly)).toBe("");
  });

  test("seeded fixture renders non-empty, framed, and within budget", () => {
    const s = fixtureStorage();
    const svc = new OwnerProfileService(s);
    const { profile } = svc.ensureSeeded(OWNER);
    const block = renderOwnerProfileBlock(profile);
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("Mohammad");
    expect(block).toContain("Standing rules");
    expect(estimatePromptTokens(block)).toBeLessThanOrEqual(600);
    s.close();
  });

  test("oversized lists are trimmed deterministically to the budget", () => {
    const p = emptyOwnerProfile();
    p.identity.name = "Mohammad";
    const filler = "x".repeat(110);
    for (let i = 0; i < 40; i++) {
      p.identity.basics.push(`basic ${i} ${filler}`);
      p.communication.preferences.push(`pref ${i} ${filler}`);
      p.standingRules.push(`rule ${i} ${filler}`);
      p.routines.push(`routine ${i} ${filler}`);
      p.technicalFacts.push(`tech ${i} ${filler}`);
      p.goals.push(`goal ${i} ${filler}`);
      p.projects.push({ name: `proj ${i}`, note: filler });
      p.people.push({ name: `person ${i}`, role: "contact", note: filler });
    }
    const block = renderOwnerProfileBlock(p);
    expect(block.length).toBeGreaterThan(0);
    expect(estimatePromptTokens(block)).toBeLessThanOrEqual(600);
    // Deterministic: rendering twice gives byte-identical output.
    expect(renderOwnerProfileBlock(p)).toBe(block);
    // Trimming actually happened (the untrimmed profile is far over budget).
    expect(block).not.toContain("basic 39");
  });

  test("a single huge item cannot blow the budget", () => {
    const p = emptyOwnerProfile();
    p.identity.name = "Mohammad";
    p.identity.basics.push("y".repeat(10000));
    const block = renderOwnerProfileBlock(p);
    expect(estimatePromptTokens(block)).toBeLessThanOrEqual(600);
  });
});

// ---- seed -----------------------------------------------------------------------

describe("OwnerProfileService.ensureSeeded", () => {
  test("seeds from memories + prefs with source tracing, and only once", () => {
    const s = fixtureStorage();
    const svc = new OwnerProfileService(s);
    const first = svc.ensureSeeded(OWNER);
    expect(first.created).toBe(true);
    const p = first.profile;

    expect(p.identity.name).toBe("Mohammad");
    expect(p.identity.basics).toContain("Mohammad is the creator and father of Bobi.");
    expect(p.identity.basics).toContain("Mohammad is a builder who ships his own bots");
    expect(p.projects).toEqual([
      { name: "bobi", note: "Project BOBI: Telegram agent bot in TypeScript" },
    ]);
    expect(p.people).toEqual([
      { name: "geo", role: "friend", note: "Geo is a close friend; they trade memes and reels" },
    ]);
    expect(p.routines).toEqual(["Morning routine: gym before work"]);
    expect(p.communication.preferences).toContain("Prefers black coffee, no sugar");
    expect(p.communication.preferences).toContain("lang: fa");
    expect(p.communication.preferences).toContain("personality: michael");
    expect(p.communication.preferences.some((x) => x.includes("voice_mode"))).toBe(false);
    expect(p.technicalFacts).toEqual(["Writes TypeScript with Bun and SQLite"]);
    expect(p.standingRules).toEqual(["Never share his private data with anyone"]);

    // Unclassifiable memory is skipped, never dumped raw; other user's too.
    const all = JSON.stringify(p);
    expect(all).not.toContain("Semnan");
    expect(all).not.toContain("someone else");

    // Every seeded field traces to a source.
    const byPath = new Map(first.seededFields.map((f) => [f.path, f.source]));
    expect(byPath.get("identity.name")).toBe("prompt.ts:CREATOR_IDENTITY");
    expect(byPath.get("identity.basics[0]")).toBe("prompt.ts:CREATOR_IDENTITY");
    expect([...byPath.values()]).toContain("memory:project:bobi");
    expect([...byPath.values()]).toContain("memory:friend:geo");
    expect([...byPath.values()]).toContain("memory:redline");
    expect([...byPath.values()]).toContain("user_prefs:lang");
    expect([...byPath.values()]).toContain("user_prefs:personality");
    expect([...byPath.values()]).not.toContain("user_prefs:voice_mode");

    // Covered topics leave openSlots; uncovered ones stay.
    expect(p.openSlots).not.toContain("standing_rules");
    expect(p.openSlots).not.toContain("projects");
    expect(p.openSlots).toContain("goals");
    // The about:owner memory seeded identity.basics, so basics is covered;
    // a seeded standing rule also covers communication_donts.
    expect(p.openSlots).not.toContain("basics");
    expect(p.openSlots).not.toContain("communication_donts");
    expect(p.openSlots).toEqual(["goals"]);

    // The stored doc round-trips to the same profile.
    expect(svc.load()).toEqual(p);

    // Second call: created=false and the stored doc is byte-identical.
    const docBefore = s.getOwnerProfileDoc();
    const second = svc.ensureSeeded(OWNER);
    expect(second.created).toBe(false);
    expect(second.seededFields).toEqual([]);
    expect(second.profile).toEqual(p);
    expect(s.getOwnerProfileDoc()).toBe(docBefore);
    s.close();
  });

  test("no stored rule → standingRules empty and standing_rules stays open", () => {
    const s = Storage.open(":memory:");
    s.upsertMemory({ userId: OWNER, key: "stack", content: "Writes TypeScript with Bun" });
    const svc = new OwnerProfileService(s);
    const { profile, seededFields } = svc.ensureSeeded(OWNER);
    expect(profile.standingRules).toEqual([]);
    expect(profile.openSlots).toContain("standing_rules");
    expect(seededFields.some((f) => f.path.startsWith("standingRules"))).toBe(false);
    s.close();
  });

  test("no memories/prefs at all → only the creator fact seeds, everything else open", () => {
    const s = Storage.open(":memory:");
    const svc = new OwnerProfileService(s);
    const { profile, created, seededFields } = svc.ensureSeeded(OWNER);
    expect(created).toBe(true);
    expect(profile.identity.name).toBe("Mohammad");
    expect(profile.projects).toEqual([]);
    expect(profile.people).toEqual([]);
    expect(seededFields.map((f) => f.source)).toEqual([
      "prompt.ts:CREATOR_IDENTITY",
      "prompt.ts:CREATOR_IDENTITY",
    ]);
    expect(profile.openSlots).toContain("goals");
    expect(profile.openSlots).toContain("people_details");
    expect(profile.openSlots).toContain("technical_facts");
    // The creator fact alone does not close basics (call name/location unknown).
    expect(profile.openSlots).toContain("basics");
    s.close();
  });

  test("an existing doc is never re-seeded or overwritten", () => {
    const s = fixtureStorage();
    const custom = emptyOwnerProfile();
    custom.identity.name = "Mohammad";
    custom.goals.push("Hand-written goal");
    custom.updatedAtMs = 999;
    s.setOwnerProfileDoc(serializeOwnerProfile(custom));
    const svc = new OwnerProfileService(s);
    const res = svc.ensureSeeded(OWNER);
    expect(res.created).toBe(false);
    expect(res.profile.goals).toEqual(["Hand-written goal"]);
    expect(s.getOwnerProfileDoc()).toBe(serializeOwnerProfile(custom));
    s.close();
  });

  test("load/save round-trip through the service", () => {
    const s = Storage.open(":memory:");
    const svc = new OwnerProfileService(s);
    expect(svc.load()).toBeUndefined();
    const p = emptyOwnerProfile();
    p.identity.name = "Mohammad";
    p.routines.push("Up at 7");
    svc.save(p);
    expect(svc.load()).toEqual(p);
    s.close();
  });
});

// ---- interview ---------------------------------------------------------------------

describe("interview", () => {
  test("question set is ~18, bilingual, with unique ids and known slots", () => {
    expect(INTERVIEW_QUESTIONS.length).toBeGreaterThanOrEqual(16);
    expect(INTERVIEW_QUESTIONS.length).toBeLessThanOrEqual(20);
    const ids = new Set(INTERVIEW_QUESTIONS.map((q) => q.id));
    expect(ids.size).toBe(INTERVIEW_QUESTIONS.length);
    for (const q of INTERVIEW_QUESTIONS) {
      expect(q.questionFa.length).toBeGreaterThan(5);
      expect(q.questionEn.length).toBeGreaterThan(5);
      expect(q.topic.length).toBeGreaterThan(0);
      expect(q.slot.length).toBeGreaterThan(0);
    }
    const topics = new Set(INTERVIEW_QUESTIONS.map((q) => q.topic));
    for (const t of [
      "basics", "work_focus", "taste_preferences", "communication_style",
      "communication_donts", "people_details", "routines_schedule",
      "standing_rules", "goals",
    ]) {
      expect(topics.has(t)).toBe(true);
    }
  });

  test("applyInterviewAnswer writes the mapped slot and closes the topic", () => {
    const base = emptyOwnerProfile();
    base.openSlots = ["basics", "goals", "standing_rules", "people_details", "work_focus"];

    const named = applyInterviewAnswer(base, "call_name", "Mohammad");
    expect(named.identity.callName).toBe("Mohammad");
    expect(named.openSlots).not.toContain("basics");
    // Input is not mutated (pure).
    expect(base.identity.callName).toBeUndefined();
    expect(base.openSlots).toContain("basics");

    const located = applyInterviewAnswer(base, "basics_location", "Semnan, Iran — Asia/Tehran");
    expect(located.identity.basics).toContain("Semnan, Iran — Asia/Tehran");

    const goal = applyInterviewAnswer(base, "goals_short_term", "Ship BOBI v1.2");
    expect(goal.goals).toEqual(["Ship BOBI v1.2"]);
    expect(goal.openSlots).not.toContain("goals");

    const rule = applyInterviewAnswer(base, "standing_red_lines", "Never message anyone as me without asking");
    expect(rule.standingRules).toEqual(["Never message anyone as me without asking"]);
    expect(rule.openSlots).not.toContain("standing_rules");

    const person = applyInterviewAnswer(base, "people_important", "Geo — friend — meme buddy");
    expect(person.people).toEqual([{ name: "Geo", role: "friend", note: "meme buddy" }]);
    expect(person.openSlots).not.toContain("people_details");

    const project = applyInterviewAnswer(base, "work_focus", "BOBI: polishing the platform phases");
    expect(project.projects).toEqual([{ name: "BOBI", note: "polishing the platform phases" }]);
    expect(project.openSlots).not.toContain("work_focus");

    const routine = applyInterviewAnswer(base, "routines_sleep", "Wakes 7:00, sleeps 23:30");
    expect(routine.routines).toEqual(["Wakes 7:00, sleeps 23:30"]);
  });

  test("unknown id and empty answers are no-ops", () => {
    const base = emptyOwnerProfile();
    base.openSlots = ["goals"];
    expect(applyInterviewAnswer(base, "no_such_question", "whatever")).toBe(base);
    expect(applyInterviewAnswer(base, "goals_short_term", "   ")).toBe(base);
    expect(base.goals).toEqual([]);
  });
});

// Type re-export sanity: OwnerProfile is the contract shape other workers use.
test("contract shape keys", () => {
  const p: OwnerProfile = emptyOwnerProfile();
  expect(Object.keys(p).sort()).toEqual(
    [
      "communication", "goals", "identity", "openSlots", "people", "projects",
      "routines", "standingRules", "technicalFacts", "updatedAtMs", "version",
    ].sort(),
  );
});
