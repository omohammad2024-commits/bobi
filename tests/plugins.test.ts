import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginFile, loadPlugins } from "../src/plugins/loader";
import { SkillCache } from "../src/skills/loader";
import type { Skill } from "../src/skills/types";

const pluginMd = (extra = ""): string =>
  [
    "---",
    "name: my-plugin",
    "version: 1.2.0",
    "description: A test plugin.",
    ...(extra ? [extra] : []),
    "---",
    "",
    "# My plugin",
  ].join("\n");

const skillMd = (name: string): string =>
  ["---", `name: ${name}`, "description: A plugin skill.", "---", "", "Skill body."].join("\n");

const hookMd = (name: string, action = `{"type": "tool", "tool": "date_time", "input": {}}`): string =>
  ["---", `name: ${name}`, `action: ${action}`, "---", "", "Hook notes."].join("\n");

// ---------- parsePluginFile ----------

describe("parsePluginFile", () => {
  test("parses a well-formed plugin.md; enabled defaults to true", () => {
    const r = parsePluginFile(pluginMd(), "plugin.md");
    expect(r.skipped).toBeUndefined();
    expect(r.meta).toEqual({
      name: "my-plugin",
      version: "1.2.0",
      description: "A test plugin.",
      enabled: true,
    });
  });

  test("enabled: false is honored", () => {
    const r = parsePluginFile(pluginMd("enabled: false"), "plugin.md");
    expect(r.meta?.enabled).toBe(false);
  });

  test("missing version is skipped, never throws", () => {
    const r = parsePluginFile(
      "---\nname: x\ndescription: y\n---\nbody",
      "plugin.md",
    );
    expect(r.meta).toBeUndefined();
    expect(r.skipped).toContain("version");
  });

  test("missing name is skipped", () => {
    const r = parsePluginFile(
      "---\nversion: 1.0.0\ndescription: y\n---\nbody",
      "plugin.md",
    );
    expect(r.meta).toBeUndefined();
    expect(r.skipped).toContain("name");
  });

  test("missing description is skipped", () => {
    const r = parsePluginFile("---\nname: x\nversion: 1.0.0\n---\nbody", "plugin.md");
    expect(r.meta).toBeUndefined();
    expect(r.skipped).toContain("description");
  });

  test("non-kebab-case name is skipped", () => {
    const r = parsePluginFile(pluginMd().replace("name: my-plugin", "name: Bad_Name"), "plugin.md");
    expect(r.meta).toBeUndefined();
    expect(r.skipped).toContain("kebab-case");
  });

  test("unclosed frontmatter is skipped", () => {
    const r = parsePluginFile("---\nname: x", "plugin.md");
    expect(r.meta).toBeUndefined();
    expect(r.skipped).toContain("unclosed");
  });
});

// ---------- loadPlugins ----------

describe("loadPlugins", () => {
  let dir: string;
  const warnings: string[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plugins-"));
    warnings.length = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = () => ({ warn: (m: string, f?: Record<string, unknown>) => warnings.push(`${m} ${JSON.stringify(f ?? {})}`) });

  /** Create a plugin dir with the given layout. */
  const mkPlugin = (
    name: string,
    files: { manifest?: string; skills?: string[]; hooks?: Array<[string, string]> },
  ): string => {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "plugin.md"), files.manifest ?? pluginMd().replace("my-plugin", name));
    for (const s of files.skills ?? []) {
      mkdirSync(join(p, "skills"), { recursive: true });
      writeFileSync(join(p, "skills", `${s}.md`), skillMd(s));
    }
    for (const [event, hook] of files.hooks ?? []) {
      mkdirSync(join(p, "hooks", event), { recursive: true });
      writeFileSync(join(p, "hooks", event, `${hook}.md`), hookMd(hook));
    }
    return p;
  };

  test("loads a full plugin: metadata + skills + hooks with events from subdirs", () => {
    mkPlugin("alpha", {
      skills: ["alpha-skill"],
      hooks: [["startup", "alpha-hook"]],
    });
    const plugins = loadPlugins(dir, opts());
    expect(plugins).toHaveLength(1);
    const p = plugins[0]!;
    expect(p.name).toBe("alpha");
    expect(p.version).toBe("1.2.0");
    expect(p.description).toBe("A test plugin.");
    expect(p.skills.map((s) => s.name)).toEqual(["alpha-skill"]);
    expect(p.skills[0]!.body).toContain("Skill body.");
    expect(p.hooks).toHaveLength(1);
    expect(p.hooks[0]!.name).toBe("alpha-hook");
    expect(p.hooks[0]!.event).toBe("startup");
    expect(p.hooks[0]!.action).toEqual({ type: "tool", tool: "date_time", input: {} });
  });

  test("a plugin without skills/ or hooks/ loads with empty lists", () => {
    mkPlugin("bare", {});
    const plugins = loadPlugins(dir, opts());
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.skills).toEqual([]);
    expect(plugins[0]!.hooks).toEqual([]);
  });

  test("plugin without plugin.md is skipped with a warning", () => {
    mkdirSync(join(dir, "nope"), { recursive: true });
    const plugins = loadPlugins(dir, opts());
    expect(plugins).toEqual([]);
    expect(warnings.some((w) => w.includes("without plugin.md"))).toBe(true);
  });

  test("malformed plugin.md is skipped with a warning, never fatal", () => {
    mkPlugin("bad", { manifest: "---\nname: bad\n---\nno version" });
    mkPlugin("good", {});
    const plugins = loadPlugins(dir, opts());
    expect(plugins.map((p) => p.name)).toEqual(["good"]);
    expect(warnings.some((w) => w.includes("invalid plugin.md"))).toBe(true);
  });

  test("enabled: false skips the plugin quietly (no warning)", () => {
    mkPlugin("off", { manifest: pluginMd("enabled: false").replace("my-plugin", "off") });
    const plugins = loadPlugins(dir, opts());
    expect(plugins).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("plugin hook with a message action is skipped; the plugin still loads", () => {
    mkPlugin("mixed", {
      hooks: [["startup", "bad-hook"]],
    });
    // Rewrite the hook with a forbidden action kind.
    const p = join(dir, "mixed", "hooks", "startup", "bad-hook.md");
    writeFileSync(
      p,
      hookMd("bad-hook", `{"type": "message", "chatId": "1", "text": "hi"}`),
    );
    const plugins = loadPlugins(dir, opts());
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.hooks).toEqual([]);
    expect(warnings.some((w) => w.includes("skipping invalid hook file"))).toBe(true);
  });

  test("invalid plugin skill files are skipped with a warning", () => {
    const p = mkPlugin("s", {});
    mkdirSync(join(p, "skills"), { recursive: true });
    writeFileSync(join(p, "skills", "bad.md"), "no frontmatter at all");
    const plugins = loadPlugins(dir, opts());
    expect(plugins[0]!.skills).toEqual([]);
    expect(warnings.some((w) => w.includes("skipping invalid skill file"))).toBe(true);
  });

  test("plugins are sorted by name", () => {
    mkPlugin("zeta", {});
    mkPlugin("alpha", {});
    const plugins = loadPlugins(dir, opts());
    expect(plugins.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });

  test("missing plugins directory is not an error", () => {
    expect(loadPlugins(join(dir, "nope"), opts())).toEqual([]);
  });

  test("hidden entries are ignored", () => {
    mkdirSync(join(dir, ".hidden"), { recursive: true });
    expect(loadPlugins(dir, opts())).toEqual([]);
  });
});

// ---------- SkillCache plugin merge (Phase E2 additive change) ----------

describe("SkillCache extraSkills (plugin merge)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plugskills-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const mkSkill = (name: string): Skill => ({
    name,
    description: `${name} desc`,
    triggers: [],
    body: `${name} body`,
    source: `plugin/${name}.md`,
  });

  test("plugin skills merge after directory skills, sorted", () => {
    writeFileSync(join(dir, "own.md"), skillMd("own-skill"));
    const cache = new SkillCache(dir, {
      warn: () => {},
      extraSkills: [mkSkill("plugin-skill")],
    });
    expect(cache.skills().map((s) => s.name)).toEqual(["own-skill", "plugin-skill"]);
  });

  test("on a name collision the directory's own skill wins", () => {
    writeFileSync(join(dir, "dup.md"), skillMd("dup"));
    const cache = new SkillCache(dir, {
      warn: () => {},
      extraSkills: [mkSkill("dup")],
    });
    const skills = cache.skills();
    expect(skills).toHaveLength(1);
    expect(skills[0]!.body).toBe("Skill body."); // the directory's file, not the plugin's
  });

  test("without extraSkills the cache behaves exactly as before", () => {
    writeFileSync(join(dir, "one.md"), skillMd("one"));
    const cache = new SkillCache(dir, { warn: () => {} });
    expect(cache.skills().map((s) => s.name)).toEqual(["one"]);
  });
});
