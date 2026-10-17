import { describe, expect, test } from "bun:test";
import { bootstrapMessage } from "../src/core/app";
import { loadConfig, requireBotToken } from "../src/config/config";

describe("foundation", () => {
  test("bootstrap message is stable", () => {
    expect(bootstrapMessage()).toBe("SOL foundation ready");
  });

  test("default config is development/info", () => {
    const cfg = loadConfig({});
    expect(cfg.env).toBe("development");
    expect(cfg.logLevel).toBe("info");
  });

  test("invalid env falls back to development", () => {
    const cfg = loadConfig({ SOL_ENV: "garbage" });
    expect(cfg.env).toBe("development");
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
