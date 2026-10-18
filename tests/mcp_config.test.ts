/**
 * MCP configuration validation.
 *
 * An MCP stdio server is a SHELL COMMAND. Its config therefore carries the full
 * authority of the bot process, and these tests are written as though the config
 * file is hostile: every rejection here is a case where running something by
 * accident would have been the alternative.
 */
import { describe, expect, test } from "bun:test";
import { validateMcpConfig, describeIssues } from "../src/mcp/config";
import { MAX_SERVERS, MAX_ARGS, MCP_NAME_PATTERN } from "../src/mcp/types";

const stdio = (over: Record<string, unknown> = {}) => ({
  transport: "stdio",
  command: "npx",
  ...over,
});

describe("config shape", () => {
  test("a valid stdio server parses", () => {
    const r = validateMcpConfig({
      servers: { files: stdio({ args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], enabled: true }) },
    });
    expect(r.issues).toEqual([]);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]!.name).toBe("files");
    expect(r.servers[0]!.command).toBe("npx");
    expect(r.servers[0]!.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(r.servers[0]!.enabled).toBe(true);
  });

  test("a valid http server parses and normalises its URL", () => {
    const r = validateMcpConfig({
      servers: { remote: { transport: "http", url: "https://mcp.example.com/mcp", enabled: true } },
    });
    expect(r.issues).toEqual([]);
    expect(r.servers[0]!.transport).toBe("http");
    expect(r.servers[0]!.url).toContain("mcp.example.com");
  });

  test("a non-object root is rejected", () => {
    expect(validateMcpConfig([]).issues.length).toBeGreaterThan(0);
    expect(validateMcpConfig("nope").issues.length).toBeGreaterThan(0);
    expect(validateMcpConfig(null).issues.length).toBeGreaterThan(0);
  });

  test("an unknown root key is rejected, not ignored", () => {
    // Ignoring it would make a misspelled `server` key look like "nothing
    // configured" and silently do nothing.
    const r = validateMcpConfig({ server: {}, servers: {} });
    expect(r.issues.some((i) => i.path === "server")).toBe(true);
  });

  test("no servers key yields no servers and no issues", () => {
    const r = validateMcpConfig({});
    expect(r.servers).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});

describe("consent is explicit", () => {
  test("a server without enabled:true is configured but inert", () => {
    // Copying a config file into place must not execute anything.
    const r = validateMcpConfig({ servers: { files: stdio() } });
    expect(r.issues).toEqual([]);
    expect(r.servers[0]!.enabled).toBe(false);
  });

  test("enabled must be a boolean, not a truthy string", () => {
    const r = validateMcpConfig({ servers: { files: stdio({ enabled: "yes" }) } });
    expect(r.issues.some((i) => i.path.endsWith(".enabled"))).toBe(true);
    expect(r.servers).toHaveLength(0);
  });

  test("enabled:false is accepted and inert", () => {
    const r = validateMcpConfig({ servers: { files: stdio({ enabled: false }) } });
    expect(r.servers[0]!.enabled).toBe(false);
  });
});

describe("name restrictions", () => {
  test("a valid name is accepted", () => {
    for (const name of ["files", "my-server", "srv_2", "a1"]) {
      expect(MCP_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  test("names that would break tool addressing are rejected", () => {
    // The name becomes a tool-name prefix that also appears in callback data.
    for (const name of ["Files", "1files", "my server", "a:b", "a/b", "a.b", "", "-x", "x".repeat(40)]) {
      expect(MCP_NAME_PATTERN.test(name)).toBe(false);
    }
  });

  test("a bad name yields an issue naming the server", () => {
    const r = validateMcpConfig({ servers: { "Bad Name": stdio() } });
    expect(r.issues.some((i) => i.path === "servers.Bad Name")).toBe(true);
    expect(r.servers).toHaveLength(0);
  });
});

describe("transport-specific fields", () => {
  test("a missing transport is rejected", () => {
    const r = validateMcpConfig({ servers: { x: { command: "npx" } } });
    expect(r.issues.some((i) => i.path.endsWith(".transport"))).toBe(true);
  });

  test("an unknown transport is rejected", () => {
    const r = validateMcpConfig({ servers: { x: { transport: "tcp", command: "npx" } } });
    expect(r.servers).toHaveLength(0);
  });

  test("a url on a stdio entry is rejected, not ignored", () => {
    // The file is confused about which server it describes, and guessing is how
    // a surprise gets executed.
    const r = validateMcpConfig({ servers: { x: stdio({ url: "https://e.com" }) } });
    expect(r.issues.some((i) => i.path.endsWith(".url"))).toBe(true);
    expect(r.servers).toHaveLength(0);
  });

  test("a command on an http entry is rejected", () => {
    const r = validateMcpConfig({
      servers: { x: { transport: "http", url: "https://e.com", command: "rm" } },
    });
    expect(r.issues.some((i) => i.path.endsWith(".command"))).toBe(true);
    expect(r.servers).toHaveLength(0);
  });

  test("stdio without a command is rejected", () => {
    const r = validateMcpConfig({ servers: { x: { transport: "stdio" } } });
    expect(r.issues.some((i) => i.path.endsWith(".command"))).toBe(true);
  });

  test("http without a url is rejected", () => {
    const r = validateMcpConfig({ servers: { x: { transport: "http" } } });
    expect(r.issues.some((i) => i.path.endsWith(".url"))).toBe(true);
  });
});

describe("http url restrictions", () => {
  test("only http and https are accepted", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://e.com", "data:text/html,x"]) {
      const r = validateMcpConfig({ servers: { x: { transport: "http", url } } });
      expect(r.servers).toHaveLength(0);
    }
  });

  test("a url with credentials is rejected", () => {
    // Credentials in a URL end up in logs and error paths.
    const r = validateMcpConfig({
      servers: { x: { transport: "http", url: "https://user:pass@e.com/mcp" } },
    });
    expect(r.issues.some((i) => i.message.includes("نام کاربری"))).toBe(true);
  });

  test("a malformed url is rejected", () => {
    const r = validateMcpConfig({ servers: { x: { transport: "http", url: "not a url" } } });
    expect(r.servers).toHaveLength(0);
  });
});

describe("bounds", () => {
  test("more servers than the cap is reported", () => {
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SERVERS + 5; i++) servers[`s${i}`] = stdio();
    const r = validateMcpConfig({ servers });
    expect(r.issues.some((i) => i.path === "servers")).toBe(true);
    expect(r.servers.length).toBeLessThanOrEqual(MAX_SERVERS);
  });

  test("too many args is rejected", () => {
    const args = Array.from({ length: MAX_ARGS + 1 }, (_, i) => `a${i}`);
    const r = validateMcpConfig({ servers: { x: stdio({ args }) } });
    expect(r.issues.some((i) => i.path.endsWith(".args"))).toBe(true);
  });

  test("an over-long arg is rejected", () => {
    const r = validateMcpConfig({ servers: { x: stdio({ args: ["x".repeat(600)] }) } });
    expect(r.servers).toHaveLength(0);
  });

  test("a non-string arg is rejected", () => {
    const r = validateMcpConfig({ servers: { x: stdio({ args: ["ok", 42] }) } });
    expect(r.servers).toHaveLength(0);
  });

  test("a non-string env value is rejected", () => {
    const r = validateMcpConfig({ servers: { x: stdio({ env: { KEY: 1 } }) } });
    expect(r.servers).toHaveLength(0);
  });

  test("string env values are accepted", () => {
    const r = validateMcpConfig({ servers: { x: stdio({ env: { API_KEY: "v" } }) } });
    expect(r.servers[0]!.env).toEqual({ API_KEY: "v" });
  });
});

describe("issue reporting", () => {
  test("several problems are collected, not thrown one at a time", () => {
    // An owner fixing a config wants the whole list.
    const r = validateMcpConfig({
      servers: {
        bad1: { transport: "stdio" },
        bad2: { transport: "http", url: "ftp://x" },
        good: stdio({ enabled: true }),
      },
    });
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
    // The valid one still loads.
    expect(r.servers.some((s) => s.name === "good")).toBe(true);
  });

  test("describeIssues renders a readable list", () => {
    const text = describeIssues([
      { path: "servers.x.command", message: "دستور اجرا لازم است." },
    ]);
    expect(text).toContain("servers.x.command");
    expect(describeIssues([])).toBe("");
  });
});
