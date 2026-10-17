import { describe, expect, test } from "bun:test";

/**
 * Startup fails closed.
 *
 * These spawn the real entry point with a scrubbed environment. The program
 * must exit non-zero with a clear message *before* it ever contacts Telegram,
 * so the test is offline by construction: there is no token to connect with.
 */

const ENTRY = ["src/index.ts"] as const;

/** Run the entry point with the mandatory security variables removed. */
async function runStart(extraEnv: Record<string, string> = {}): Promise<{
  code: number;
  output: string;
  elapsedMs: number;
}> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env["TELEGRAM_BOT_TOKEN"];
  delete env["OWNER_TELEGRAM_ID"];
  delete env["SOL_AI_KEY_MASTER_KEY"];
  for (const [k, v] of Object.entries(extraEnv)) env[k] = v;

  const started = Date.now();
  const proc = Bun.spawn({
    cmd: ["bun", "run", ...ENTRY],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: `${out}${err}`, elapsedMs: Date.now() - started };
}

describe("startup fails closed", () => {
  test("exits non-zero when no configuration exists", async () => {
    const r = await runStart();
    expect(r.code).toBe(1);
    expect(r.output).toContain("startup failed");
    expect(r.output).toContain("TELEGRAM_BOT_TOKEN");
  });

  test("fails fast rather than attempting a connection", async () => {
    const r = await runStart();
    // Connecting to Telegram would take a network round trip; a closed gate
    // returns almost immediately.
    expect(r.elapsedMs).toBeLessThan(15_000);
  });

  test("refuses to run without a valid owner id, naming the variable", async () => {
    // A syntactically fake token is enough to pass the first gate; the owner
    // gate must then refuse. This token never reaches Telegram because the
    // process exits before the bot starts.
    const r = await runStart({ TELEGRAM_BOT_TOKEN: "0:startup-gate-fake-token" });
    expect(r.code).toBe(1);
    expect(r.output).toContain("OWNER_TELEGRAM_ID");
    expect(r.output).toContain("startup failed");
  });

  test("never prints token material or the encryption key", async () => {
    const marker = "startup-secret-marker-abcdef";
    const r = await runStart({
      TELEGRAM_BOT_TOKEN: `0:${marker}`,
      SOL_AI_KEY_MASTER_KEY: `${marker}-key`,
    });
    expect(r.output).not.toContain(marker);
    expect(r.output).not.toContain(`${marker}-key`);
  });

  test("rejects an invalid owner id rather than trusting it", async () => {
    const r = await runStart({
      TELEGRAM_BOT_TOKEN: "0:startup-gate-fake-token",
      OWNER_TELEGRAM_ID: "not-a-number",
    });
    expect(r.code).toBe(1);
    expect(r.output).toContain("OWNER_TELEGRAM_ID");
    expect(r.output).not.toContain("not-a-number");
  });
});
