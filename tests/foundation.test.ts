import { describe, expect, test } from "bun:test";
import { bootstrapMessage, APP_NAME } from "../src/core/app";
import { loadConfig, requireBotToken } from "../src/config/config";

describe("foundation", () => {
  test("bootstrap message is stable", () => {
    expect(bootstrapMessage()).toBe("BOBI foundation ready");
  });

  test("the app name is BOBI", () => {
    expect(APP_NAME).toBe("BOBI");
  });

  test("default config is development/info", () => {
    const cfg = loadConfig({});
    expect(cfg.env).toBe("development");
    expect(cfg.logLevel).toBe("info");
  });

  test("invalid env falls back to development", () => {
    const cfg = loadConfig({ BOBI_ENV: "garbage" });
    expect(cfg.env).toBe("development");
  });

  test("the BOBI_ prefix is honoured", () => {
    const cfg = loadConfig({ BOBI_ENV: "production", BOBI_LOG_LEVEL: "warn" });
    expect(cfg.env).toBe("production");
    expect(cfg.logLevel).toBe("warn");
  });

  test("the older SOL_ prefix still works, so a rename does not change behaviour", () => {
    // The project was renamed from SOL. An existing deployment's .env uses the
    // old keys, and ignoring them would silently fall back to defaults.
    const cfg = loadConfig({ SOL_ENV: "production", SOL_LOG_LEVEL: "error" });
    expect(cfg.env).toBe("production");
    expect(cfg.logLevel).toBe("error");
  });

  test("BOBI_ wins when both prefixes are present", () => {
    const cfg = loadConfig({ BOBI_ENV: "test", SOL_ENV: "production" });
    expect(cfg.env).toBe("test");
  });

  test("missing token → requireBotToken throws clear error", () => {
    const cfg = loadConfig({});
    expect(() => requireBotToken(cfg)).toThrow("TELEGRAM_BOT_TOKEN is not set");
  });

  test("token in env → trimmed & accepted", () => {
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "  abc123  " });
    expect(cfg.botToken).toBe("abc123");
    expect(() => requireBotToken(cfg)).not.toThrow();
  });
});
