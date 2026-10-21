#!/usr/bin/env bun
/**
 * Entry point: `bun src/mcp/serve.ts` — run BOBI as an MCP server over stdio.
 *
 * Connect from a local MCP client (Claude Code, Cursor, …) with a config like:
 *
 *   { "mcpServers": { "bobi": { "command": "bun", "args": ["src/mcp/serve.ts"] } } }
 *
 * Thin starter over the SAME platform the Telegram bot runs
 * (src/bootstrap.ts buildPlatform, surface "mcp"): same config, same
 * database, same provider selection, the FULL tool wiring and the same
 * memory stack — this is exactly the same BOBI as on Telegram, with the
 * same tools and the same memory. Telegram-only machinery is NOT started
 * here: no bot, no schedulers, no heartbeat/bench worker, no health/API
 * servers, no interval sweeps, no external-MCP connections.
 *
 * SECURITY: the `ownerActor` passed to the MCP server is built here,
 * server-side, from the validated owner identity — the same
 * `authorizeToolUse` path the bot uses for scheduled tasks and the
 * heartbeat. A request arriving over stdio can never contribute to it; see
 * `src/mcp/server.ts` for the trust model.
 */
import { loadConfig } from "../config/config";
import { OwnerIdentity, parseOwnerId } from "../auth/identity";
import { authorizeToolUse, toToolActor } from "../auth/tool_bridge";
import { buildPlatform } from "../bootstrap";
import { createMcpServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();

  const ownerId = parseOwnerId(config.ownerTelegramIdRaw);
  if (!ownerId.ok) {
    // Fail closed, like the bot: no validated owner, no server.
    console.error(
      "startup failed: OWNER_TELEGRAM_ID is not set or invalid. " +
        "Set it to the numeric Telegram user id of the owner and retry. " +
        `(${ownerId.reason})`,
    );
    process.exitCode = 1;
    return;
  }
  const identity = OwnerIdentity.fromNumber(ownerId.ownerId);
  void identity;

  const platform = await buildPlatform(config, { surface: "mcp" });
  if (platform === undefined) return; // fail-closed gate already reported

  // Owner-level grants, resolved server-side right now — never from a request.
  const ownerActor = toToolActor(
    authorizeToolUse(platform.auth, { id: ownerId.ownerId }, platform.tools.registry.list()),
  );

  const server = createMcpServer({
    storage: platform.storage,
    engineFactory: () => platform.turn.engine,
    ownerActor,
  });

  const stop = (): void => {
    platform.turn.engine.cancelAll();
    platform.storage.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await server.serve();
  stop();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`startup failed: ${msg}`);
  process.exitCode = 1;
});
