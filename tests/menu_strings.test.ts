import { describe, expect, test } from "bun:test";
import { tr } from "../src/i18n/strings/menu_strings";

// Every key in the local menu table. The UI is English-only (owner
// direction, Oct 2026): tr() accepts the lang argument for signature
// compatibility but always renders English.
const KEYS = [
  "menu.start.text",
  "menu.start.text_public",
  "menu.screen.chat",
  "menu.screen.tools_fallback",
  "menu.screen.commands",
  "menu.screen.settings",
  "menu.screen.about",
  "menu.screen.help",
  "menu.label.chat",
  "menu.label.tools",
  "menu.label.commands",
  "menu.label.settings",
  "menu.label.about",
  "menu.label.help",
  "menu.label.back",
  "menu.label.miniapp",
  "menu.help.group.general",
  "menu.help.group.session",
  "menu.help.group.automation",
  "menu.help.group.owner",
  "menu.help.entry",
  "menu.help.entry_example",
] as const;

const ARABIC_RE = /[\u0600-\u06FF]/;

describe("menu_strings", () => {
  test("every key has a non-empty English translation", () => {
    for (const k of KEYS) {
      expect(tr("en", k).length, `${k} en`).toBeGreaterThan(0);
      expect(tr("en", k), `${k} en`).not.toBe(k);
    }
  });

  test("the lang argument is ignored: fa renders the same English text", () => {
    for (const k of KEYS) {
      expect(tr("fa", k), `${k} fa`).toBe(tr("en", k));
    }
  });

  test("no string contains Persian script", () => {
    for (const k of KEYS) {
      for (const lang of ["fa", "en"] as const) {
        expect(tr(lang, k), `surface ${k} leaks Persian`).not.toMatch(ARABIC_RE);
      }
    }
  });

  test("unknown keys fall back gracefully, never throw", () => {
    expect(tr("fa", "menu.nope")).toBe("menu.nope");
    expect(tr("en", "menu.nope")).toBe("menu.nope");
  });

  test("interpolates {vars}", () => {
    expect(tr("en", "menu.help.entry", { name: "start", description: "x" })).toBe(
      "/start — x",
    );
    expect(
      tr("en", "menu.help.entry_example", {
        name: "history",
        example: "20",
        description: "y",
      }),
    ).toBe("/history 20 — y");
  });

  test("the welcome screens follow the reference aesthetic", () => {
    const owner = tr("en", "menu.start.text");
    const pub = tr("en", "menu.start.text_public");
    for (const text of [owner, pub]) {
      expect(text).toContain("👋");
      expect(text).toContain("📌");
      expect(text).toContain("👥");
      // Short: at most 6 command lines, never a wall of commands.
      const commands = text.split("\n").filter((l) => l.startsWith("/"));
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.length).toBeLessThanOrEqual(6);
    }
    // The owner variant adds the two owner-only essentials; the public
    // variant never mentions commands the public cannot use.
    expect(owner).toContain("/reset");
    expect(owner).toContain("/digest");
    expect(pub).not.toContain("/reset");
    expect(pub).not.toContain("/digest");
    expect(pub).not.toContain("/model");
  });
});
