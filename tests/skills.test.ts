import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFile, loadSkills, SkillCache } from "../src/skills/loader";
import { searchSkills } from "../src/skills/search";
import { buildSkillsContext } from "../src/skills/context";
import { buildSystemPrompt } from "../src/agent/prompt";
import { SKILLS_MAX_INJECT_CHARS } from "../src/skills/types";
import type { Skill } from "../src/skills/types";

// ---------- frontmatter parsing ----------

describe("parseSkillFile", () => {
  test("parses a well-formed skill", () => {
    const r = parseSkillFile(
      [
        "---",
        "name: memory-coach",
        "description: Coach the user on memory usage.",
        "triggers: [memory, یادت, فراموش]",
        "---",
        "# Body",
        "",
        "Some guidance here.",
      ].join("\n"),
      "memory-coach.md",
    );
    expect(r.skipped).toBeUndefined();
    expect(r.skill?.name).toBe("memory-coach");
    expect(r.skill?.description).toBe("Coach the user on memory usage.");
    expect(r.skill?.triggers).toEqual(["memory", "یادت", "فراموش"]);
    expect(r.skill?.body).toContain("Some guidance here.");
    expect(r.skill?.source).toBe("memory-coach.md");
  });

  test("triggers are optional", () => {
    const r = parseSkillFile(
      "---\nname: plain\ndescription: No triggers.\n---\nBody text.",
      "plain.md",
    );
    expect(r.skill?.triggers).toEqual([]);
  });

  test("accepts bare comma-separated triggers", () => {
    const r = parseSkillFile(
      "---\nname: plain\ndescription: x\ntriggers: a, b\n---\nBody.",
      "p.md",
    );
    expect(r.skill?.triggers).toEqual(["a", "b"]);
  });

  test("missing name is skipped, never throws", () => {
    const r = parseSkillFile("---\ndescription: x\n---\nBody.", "noname.md");
    expect(r.skill).toBeUndefined();
    expect(r.skipped).toContain("name");
  });

  test("missing description is skipped, never throws", () => {
    const r = parseSkillFile("---\nname: x\n---\nBody.", "nodesc.md");
    expect(r.skill).toBeUndefined();
    expect(r.skipped).toContain("description");
  });

  test("non-kebab-case name is skipped", () => {
    const r = parseSkillFile(
      "---\nname: Bad_Name!\ndescription: x\n---\nBody.",
      "bad.md",
    );
    expect(r.skill).toBeUndefined();
    expect(r.skipped).toContain("kebab-case");
  });

  test("missing frontmatter delimiters are skipped", () => {
    expect(parseSkillFile("no frontmatter at all", "x.md").skipped).toBeDefined();
    expect(
      parseSkillFile("---\nname: x\ndescription: y\nno closing", "x.md").skipped,
    ).toBeDefined();
  });

  test("empty body is skipped", () => {
    const r = parseSkillFile("---\nname: x\ndescription: y\n---\n", "e.md");
    expect(r.skill).toBeUndefined();
    expect(r.skipped).toContain("empty");
  });

  test("ignores comments and malformed lines in frontmatter", () => {
    const r = parseSkillFile(
      "---\n# a comment\nname: x\ndescription: y\nnot a kv line\n---\nBody.",
      "x.md",
    );
    expect(r.skill?.name).toBe("x");
  });
});

// ---------- directory loading ----------

const skillFile = (name: string, desc: string, triggers?: string) =>
  [
    "---",
    `name: ${name}`,
    `description: ${desc}`,
    ...(triggers !== undefined ? [`triggers: [${triggers}]`] : []),
    "---",
    `# ${name}`,
    "Body text.",
  ].join("\n");

describe("loadSkills", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skills-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loads valid files, skips invalid ones with warnings, sorts by name", () => {
    writeFileSync(join(dir, "b-skill.md"), skillFile("b-skill", "Second."));
    writeFileSync(join(dir, "a-skill.md"), skillFile("a-skill", "First."));
    writeFileSync(join(dir, "broken.md"), "---\nname: nope\n---\n");
    writeFileSync(join(dir, ".hidden.md"), skillFile("hidden", "Nope."));
    writeFileSync(join(dir, "notes.txt"), "not markdown");
    writeFileSync(join(dir, "huge.md"), "x".repeat(70 * 1024));

    const warnings: string[] = [];
    const skills = loadSkills(dir, {
      warn: (m) => warnings.push(m),
    });
    expect(skills.map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
    expect(warnings.length).toBeGreaterThanOrEqual(2); // broken + huge
    expect(warnings.some((w) => w.includes("too large"))).toBeTrue();
  });

  test("missing directory returns empty, no crash", () => {
    expect(loadSkills(join(dir, "nope"))).toEqual([]);
  });

  test("caps at 100 skills", () => {
    for (let i = 0; i < 105; i++) {
      const name = `s-${String(i).padStart(3, "0")}`;
      writeFileSync(join(dir, `${name}.md`), skillFile(name, `Skill ${i}.`));
    }
    const warnings: string[] = [];
    const skills = loadSkills(dir, { warn: (m) => warnings.push(m) });
    expect(skills).toHaveLength(100);
    expect(warnings.some((w) => w.includes("limit"))).toBeTrue();
  });
});

// ---------- cache ----------

describe("SkillCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skillcache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reloads when the directory mtime changes", () => {
    const cache = new SkillCache(dir, { warn: () => {} });
    writeFileSync(join(dir, "one.md"), skillFile("one", "One."));
    expect(cache.skills().map((s) => s.name)).toEqual(["one"]);

    // Same mtime window: no reload yet — still cached.
    const cached = cache.skills();
    expect(cached).toHaveLength(1);

    // Force a new mtime and add a file: reload picks it up.
    writeFileSync(join(dir, "two.md"), skillFile("two", "Two."));
    const future = new Date(Date.now() + 5000);
    utimesSync(dir, future, future);
    expect(cache.skills().map((s) => s.name)).toEqual(["one", "two"]);
  });

  test("missing directory caches empty", () => {
    const cache = new SkillCache(join(dir, "nope"));
    expect(cache.skills()).toEqual([]);
  });
});

// ---------- search ----------

const mkSkill = (
  name: string,
  description: string,
  triggers: string[] = [],
  body = "body",
): Skill => ({ name, description, triggers, body, source: `${name}.md` });

describe("searchSkills", () => {
  const skills = [
    mkSkill("memory-coach", "Coach memory usage", ["حافظه", "یادت"], "use remember tool"),
    mkSkill("translator", "Translate text", ["ترجمه"], "translation guidance"),
    mkSkill("weather-fan", "Weather smalltalk", [], "sunny day talk"),
  ];

  test("name match outranks trigger match outranks description match", () => {
    const ranked = searchSkills(skills, "memory", 10);
    expect(ranked[0]?.name).toBe("memory-coach");
  });

  test("Persian trigger query matches", () => {
    const ranked = searchSkills(skills, "یادت نره اینو", 10);
    expect(ranked.map((s) => s.name)).toContain("memory-coach");
  });

  test("Persian description query matches", () => {
    const ranked = searchSkills(skills, "ترجمه", 10);
    expect(ranked[0]?.name).toBe("translator");
  });

  test("no match returns empty", () => {
    expect(searchSkills(skills, "زرافه بنفش", 10)).toEqual([]);
  });

  test("empty query returns empty", () => {
    expect(searchSkills(skills, "   ", 10)).toEqual([]);
  });

  test("limit is respected and tiebreak is deterministic by name", () => {
    const twins = [
      mkSkill("zzz", "shared word here"),
      mkSkill("aaa", "shared word here"),
    ];
    const ranked = searchSkills(twins, "shared word", 10);
    expect(ranked.map((s) => s.name)).toEqual(["aaa", "zzz"]);
    expect(searchSkills(twins, "shared word", 1)).toHaveLength(1);
  });
});

// ---------- prompt injection ----------

describe("skills prompt injection", () => {
  test("buildSkillsContext renders matched skills with a delimiter header", () => {
    const skills = [mkSkill("memory-coach", "Coach.", ["memory"], "Remember to offer.")];
    const ctx = buildSkillsContext(skills, "help my memory");
    expect(ctx).toContain("Active skills");
    expect(ctx).toContain("### memory-coach");
    expect(ctx).toContain("Remember to offer.");
  });

  test("returns undefined when nothing matches", () => {
    const skills = [mkSkill("memory-coach", "Coach.", ["memory"])];
    expect(buildSkillsContext(skills, "زرافه بنفش")).toBeUndefined();
  });

  test("total injected chars never exceed the cap", () => {
    const big = "x".repeat(5000);
    const skills = [
      mkSkill("a-one", "First.", ["alpha"], big),
      mkSkill("b-two", "Second.", ["alpha"], big),
      mkSkill("c-three", "Third.", ["alpha"], big),
    ];
    const ctx = buildSkillsContext(skills, "alpha");
    expect(ctx).toBeDefined();
    expect(ctx!.length).toBeLessThanOrEqual(
      SKILLS_MAX_INJECT_CHARS + "مهارت‌های فعال (دستورهای مالک — راهنمای رفتاری، نه ابزار):".length + 200,
    );
    // At most one whole 5000-char skill fits under the cap.
    expect(ctx!.match(/### /g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  test("at most 3 skills injected by default", () => {
    const skills = [1, 2, 3, 4, 5].map((i) =>
      mkSkill(`s-${i}`, `Skill ${i}.`, ["common"]),
    );
    const ctx = buildSkillsContext(skills, "common");
    expect(ctx!.match(/### /g)).toHaveLength(3);
  });

  test("buildSystemPrompt includes the skills block additively", () => {
    const skills = [mkSkill("memory-coach", "Coach.", ["memory"], "Offer to remember.")];
    const skillContext = buildSkillsContext(skills, "my memory is bad");
    const prompt = buildSystemPrompt({
      tools: [],
      now: new Date("2026-10-18T12:00:00Z"),
      timezone: "Asia/Tehran",
      ...(skillContext !== undefined ? { skillContext } : {}),
    });
    expect(prompt).toContain("### memory-coach");
    // Existing structure untouched: identity, tool rules, answer rule present.
    expect(prompt).toContain("You are Bobi");
    expect(prompt).toContain("Tool rules:");
    expect(prompt).toContain("answer directly without calling tools");
  });

  test("omitted skillContext leaves the prompt unchanged", () => {
    const withNone = buildSystemPrompt({
      tools: [],
      now: new Date("2026-10-18T12:00:00Z"),
      timezone: "Asia/Tehran",
    });
    expect(withNone).not.toContain("Active skills");
  });
});
