import { describe, expect, test } from "bun:test";
import { tr } from "../src/bot/menu_strings";

// Every key in the local menu table. The i18n_parity test already guards
// fa/en pairing by globbing *_strings.ts; these are the behavioral spot
// checks for this table.
const KEYS = [
  "menu.start.text",
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
  "menu.help.group.general",
  "menu.help.group.session",
  "menu.help.group.automation",
  "menu.help.group.owner",
  "menu.help.entry",
  "menu.help.entry_example",
] as const;

describe("menu_strings", () => {
  test("every key has a non-empty fa and en translation", () => {
    for (const k of KEYS) {
      expect(tr("fa", k).length, `${k} fa`).toBeGreaterThan(0);
      expect(tr("en", k).length, `${k} en`).toBeGreaterThan(0);
      expect(tr("en", k), `${k} en`).not.toBe(k);
    }
  });

  test("English strings contain no Persian script", () => {
    for (const k of KEYS) {
      expect(tr("en", k), `surface ${k} leaks Persian`).not.toMatch(/[\u0600-\u06FF]/);
    }
  });

  test("unknown keys fall back gracefully, never throw", () => {
    expect(tr("fa", "menu.nope")).toBe("menu.nope");
    expect(tr("en", "menu.nope")).toBe("menu.nope");
  });

  test("interpolates {vars}", () => {
    expect(tr("fa", "menu.help.entry", { name: "start", description: "x" })).toBe(
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

  test("fa and en carry the same placeholders", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of KEYS) {
      expect(vars(tr("en", k)), k).toEqual(vars(tr("fa", k)));
    }
  });
});
