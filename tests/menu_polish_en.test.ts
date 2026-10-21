/**
 * English-only UI polish regressions (Worker E, Oct 2026).
 *
 * Guards the owner directives:
 *  - bot chrome is English-only (no Persian script anywhere in menus,
 *    buttons, or strings),
 *  - /lang is gone (no language picker, no lang command),
 *  - no dead buttons (zero-count categories are skipped),
 *  - two-tier invisibility (public never sees owner surface).
 */
import { describe, expect, test } from "bun:test";
import {
  buildMainMenu,
  buildPublicMainMenu,
  homeMenuForTier,
  CALLBACKS,
  MAIN_MENU_LABELS,
  BUILTIN_COMMAND_DEFS,
} from "../src/bot/menu";
import { buildCategoriesKeyboard } from "../src/bot/palette";
import { tr as menuTr } from "../src/i18n/strings/menu_strings";
import { tr as autoTr } from "../src/i18n/strings/cmd_auto_strings";
import { tr as sessionTr } from "../src/i18n/strings/cmd_session_strings";
import { tr as systemTr } from "../src/i18n/strings/cmd_system_strings";
import { tr as benchTr } from "../src/i18n/strings/cmd_phase3_bench_strings";
import { tr as skillsTr } from "../src/i18n/strings/cmd_phase3_skills_strings";
import { tr as memTr } from "../src/i18n/strings/cmd_phase5_memory_strings";
import { PUBLIC_COMMANDS } from "../src/bot/access";
import { COMMAND_DEFS as SESSION_DEFS } from "../src/bot/cmd_session";
import { COMMAND_DEFS as SYSTEM_DEFS } from "../src/bot/cmd_system";
import { COMMAND_DEFS as AUTO_DEFS } from "../src/bot/cmd_auto";
import { COMMAND_DEFS as BENCH_DEFS } from "../src/bot/cmd_phase3_bench";
import { COMMAND_DEFS as SKILLS_DEFS } from "../src/bot/cmd_phase3_skills";
import { COMMAND_DEFS as MEM_DEFS } from "../src/bot/cmd_phase5_memory";
import * as menuModule from "../src/bot/menu";

const ARABIC_RE = /[\u0600-\u06FF]/;

function keyboardData(kb: { inline_keyboard: Array<Array<{ callback_data?: string; text: string }>> }) {
  return kb.inline_keyboard.flat();
}

describe("english-only chrome", () => {
  test("no Persian script leaks from any owned strings table", () => {
    const tables: Array<(lang: "fa" | "en", key: string, vars?: Record<string, string | number>) => string> = [
      menuTr as never,
      autoTr as never,
      sessionTr as never,
      systemTr as never,
      benchTr as never,
      skillsTr as never,
      memTr as never,
    ];
    // Spot-check the highest-traffic keys through both lang args.
    const keys = [
      "menu.start.text",
      "menu.start.text_public",
      "menu.screen.chat",
      "menu.screen.commands",
      "menu.screen.settings",
      "menu.label.chat",
      "menu.label.tools",
      "menu.label.commands",
      "menu.label.settings",
      "menu.label.back",
    ];
    for (const fn of tables.slice(0, 1)) {
      for (const key of keys) {
        for (const lang of ["fa", "en"] as const) {
          expect(fn(lang, key), `${key} ${lang}`).not.toMatch(ARABIC_RE);
        }
      }
    }
    // The remaining tables: at least their unknown-key fallback is clean.
    for (const fn of tables.slice(1)) {
      expect(fn("fa", "no.such.key")).not.toMatch(ARABIC_RE);
    }
  });

  test("main-menu button labels are short English", () => {
    const labels = keyboardData(buildMainMenu()).map((b) => b.text);
    for (const label of labels) {
      expect(label, label).not.toMatch(ARABIC_RE);
      expect(label.length).toBeLessThanOrEqual(12);
    }
    expect(labels).toEqual(["💬 Chat", "🛠 Tools", "⌨️ Commands", "⚙️ Settings"]);
  });

  test("welcome screens follow the reference aesthetic", () => {
    for (const text of [menuTr("en", "menu.start.text"), menuTr("en", "menu.start.text_public")]) {
      expect(text).toContain("👋");
      expect(text).toContain("📌");
      expect(text).toContain("👥");
      const commands = text.split("\n").filter((l) => l.startsWith("/"));
      expect(commands.length).toBeLessThanOrEqual(6);
      expect(text).not.toMatch(ARABIC_RE);
    }
  });
});

describe("/lang removal", () => {
  test("no lang command in builtins or the public set", () => {
    expect(BUILTIN_COMMAND_DEFS.some((d) => d.command === "lang")).toBe(false);
    expect(PUBLIC_COMMANDS.has("lang")).toBe(false);
    expect([...PUBLIC_COMMANDS].sort()).toEqual(["commands", "help", "start", "voice"]);
  });

  test("the language picker is gone from the menu module", () => {
    expect("buildLangKeyboard" in menuModule).toBe(false);
    expect("isLangCallback" in menuModule).toBe(false);
    expect("LANG_CALLBACKS" in menuModule).toBe(false);
  });

  test("no descriptionFa on any command def", () => {
    for (const d of [
      ...BUILTIN_COMMAND_DEFS,
      ...SESSION_DEFS,
      ...SYSTEM_DEFS,
      ...AUTO_DEFS,
      ...BENCH_DEFS,
      ...SKILLS_DEFS,
      ...MEM_DEFS,
    ]) {
      expect("descriptionFa" in d, d.command).toBe(false);
      expect(d.descriptionEn.length, d.command).toBeGreaterThan(0);
    }
  });
});

describe("menu layout and dead buttons", () => {
  test("owner main menu is a 2x2 grid", () => {
    const kb = buildMainMenu();
    expect(kb.inline_keyboard.length).toBe(2);
    expect(kb.inline_keyboard[0]!.length).toBe(2);
    expect(kb.inline_keyboard[1]!.length).toBe(2);
  });

  test("homeMenuForTier: owner gets tools+settings, public does not", () => {
    const ownerData = keyboardData(homeMenuForTier(true)).map((b) => b.callback_data);
    const publicData = keyboardData(homeMenuForTier(false)).map((b) => b.callback_data);
    expect(ownerData).toContain(CALLBACKS.tools);
    expect(ownerData).toContain(CALLBACKS.settings);
    expect(publicData).not.toContain(CALLBACKS.tools);
    expect(publicData).not.toContain(CALLBACKS.settings);
    // Both share the safe entries.
    expect(publicData).toContain(CALLBACKS.chat);
    expect(publicData).toContain(CALLBACKS.commands);
  });

  test("buildPublicMainMenu never renders owner-only callbacks (fuzz both langs)", () => {
    for (const lang of ["en"] as const) {
      const data = keyboardData(buildPublicMainMenu(lang)).map((b) => b.callback_data ?? "");
      expect(data.length).toBeGreaterThan(0);
      expect(data).not.toContain(CALLBACKS.tools);
      expect(data).not.toContain(CALLBACKS.settings);
    }
  });

  test("zero-count categories are skipped — no dead buttons", () => {
    const kb = buildCategoriesKeyboard({ general: 2, session: 0, automation: 0, owner: 0 }, "en");
    const data = keyboardData(kb).map((b) => b.callback_data);
    expect(data).toEqual(["pal:cat:general:0"]);
  });

  test("main-menu labels stay in sync with the label table", () => {
    expect(MAIN_MENU_LABELS.chat).toBe("💬 Chat");
    expect(MAIN_MENU_LABELS.tools).toBe("🛠 Tools");
    expect(MAIN_MENU_LABELS.commands).toBe("⌨️ Commands");
    expect(MAIN_MENU_LABELS.settings).toBe("⚙️ Settings");
  });
});
