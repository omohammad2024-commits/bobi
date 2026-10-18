import { describe, expect, test } from "bun:test";
import {
  BUILTIN_COMMAND_DEFS,
  publicMenuCommands,
  ownerMenuCommands,
} from "../src/bot/menu";
import { COMMAND_DEFS as SESSION_COMMAND_DEFS } from "../src/bot/cmd_session";
import { COMMAND_DEFS as SYSTEM_COMMAND_DEFS } from "../src/bot/cmd_system";
import { COMMAND_DEFS as AUTO_COMMAND_DEFS } from "../src/bot/cmd_auto";

// Same concatenation order as the setMyCommands wiring in src/index.ts.
const HERMES_DEFS = [
  ...SESSION_COMMAND_DEFS,
  ...SYSTEM_COMMAND_DEFS,
  ...AUTO_COMMAND_DEFS,
];

describe("builtin command defs", () => {
  test("registers the 10 missing builtins in deliberate order", () => {
    expect(BUILTIN_COMMAND_DEFS.map((d) => d.command)).toEqual([
      "start",
      "help",
      "voice",
      "reset",
      "stop",
      "lang",
      "personality",
      "compress",
      "admin",
      "ai",
    ]);
  });

  test("only admin and ai are owner-only", () => {
    expect(
      BUILTIN_COMMAND_DEFS.filter((d) => d.ownerOnly).map((d) => d.command),
    ).toEqual(["admin", "ai"]);
  });

  test("every builtin has a non-empty fa and en description", () => {
    for (const d of BUILTIN_COMMAND_DEFS) {
      expect(d.descriptionFa.length, d.command).toBeGreaterThan(0);
      expect(d.descriptionEn.length, d.command).toBeGreaterThan(0);
    }
  });

  test("builtin names do not collide with Hermes commands", () => {
    const hermesNames = new Set(HERMES_DEFS.map((d) => d.command));
    for (const d of BUILTIN_COMMAND_DEFS) {
      expect(hermesNames.has(d.command), d.command).toBe(false);
    }
  });
});

describe("command menu ordering", () => {
  test("public menu: 8 core builtins, then the 28 public Hermes defs", () => {
    const pub = publicMenuCommands(HERMES_DEFS);
    expect(pub.length).toBe(8 + 28);
    expect(pub.slice(0, 8).map((d) => d.command)).toEqual([
      "start",
      "help",
      "voice",
      "reset",
      "stop",
      "lang",
      "personality",
      "compress",
    ]);
    expect(pub.every((d) => !d.ownerOnly)).toBe(true);
    // Hermes groups keep module order: a session command before an auto one.
    const names = pub.map((d) => d.command);
    expect(names.indexOf("history")).toBeLessThan(names.indexOf("bg"));
    expect(names.indexOf("bg")).toBeGreaterThan(names.indexOf("new"));
  });

  test("owner menu: all 10 builtins, then every Hermes def", () => {
    const own = ownerMenuCommands(HERMES_DEFS);
    expect(own.length).toBe(10 + HERMES_DEFS.length);
    expect(own.slice(0, 10).map((d) => d.command)).toEqual([
      "start",
      "help",
      "voice",
      "reset",
      "stop",
      "lang",
      "personality",
      "compress",
      "admin",
      "ai",
    ]);
    const names = own.map((d) => d.command);
    expect(new Set(names).size).toBe(names.length);
    expect(own.filter((d) => d.ownerOnly).length).toBeGreaterThan(0);
  });

  test("owner menu is a superset of the public menu's commands", () => {
    const pubNames = new Set(publicMenuCommands(HERMES_DEFS).map((d) => d.command));
    const ownNames = new Set(ownerMenuCommands(HERMES_DEFS).map((d) => d.command));
    for (const name of pubNames) {
      expect(ownNames.has(name), name).toBe(true);
    }
  });
});
