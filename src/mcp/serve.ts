#!/usr/bin/env bun
/**
 * Entry point: `bun src/mcp/serve.ts` — run BOBI as an MCP server over stdio.
 *
 * Connect from a local MCP client (Claude Code, Cursor, …) with a config like:
 *
 *   { "mcpServers": { "bobi": { "command": "bun", "args": ["src/mcp/serve.ts"] } } }
 *
 * Wiring is intentionally MINIMAL compared to `src/index.ts` (the Telegram
 * bot): the same config file, the same database, the same provider selection
 * (AiGateway with owner-configured providers, FakeProvider fallback), the
 * same core tools — but none of the bot-only pieces (panels, schedulers,
 * heartbeat, health endpoint, Telegram delivery). Richer wiring (memory
 * tools, skills, the MCP client tools from `src/mcp/bridge.ts`) can be added
 * here later without changing `src/mcp/server.ts`, which stays transport-
 * and wiring-agnostic.
 *
 * SECURITY: the `ownerActor` passed to the MCP server is built here,
 * server-side, from the validated owner identity — the same
 * `authorizeToolUse` path the bot uses for scheduled tasks and the
 * heartbeat. A request arriving over stdio can never contribute to it; see
 * `src/mcp/server.ts` for the trust model.
 */
import { loadConfig } from "../config/config";
import { Storage } from "../storage/storage";
import { ConversationEngine } from "../conversation/engine";
import { FakeProvider } from "../ai/fake";
import { AiGateway } from "../ai/gateway";
import { AdapterRegistry } from "../ai/adapter_registry";
import { ProviderSecretStore } from "../ai/secret_store";
import { ToolService } from "../tools/service";
import { AuthorizationService } from "../auth/service";
import { OwnerIdentity, parseOwnerId } from "../auth/identity";
import { authorizeToolUse, toToolActor } from "../auth/tool_bridge";
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
  const auth = new AuthorizationService(identity);

  const storage = Storage.open(config.dbPath);

  // Same provider selection as the bot: the owner-configured provider via
  // the gateway, offline fake when nothing is configured.
  const secrets = new ProviderSecretStore(config.aiMasterKey);
  const adapters = new AdapterRegistry();
  const gateway = new AiGateway({ storage, adapters, secrets });
  const selection = gateway.currentSelection();
  const provider = selection ? gateway : new FakeProvider();

  // Core tools only (see module doc): the full extra-tools wiring lives in
  // src/index.ts and is intentionally not duplicated here.
  const tools = new ToolService();
  const engine = new ConversationEngine({
    provider,
    model: selection ? selection.modelId : config.aiModel,
    timeoutMs: config.aiTimeoutMs,
    maxConcurrent: config.aiMaxConcurrent,
    storage,
    tools,
    timezone: config.timezone,
  });

  // Owner-level grants, resolved server-side right now — never from a request.
  const ownerActor = toToolActor(
    authorizeToolUse(auth, { id: ownerId.ownerId }, tools.registry.list()),
  );

  const server = createMcpServer({
    storage,
    engineFactory: () => engine,
    ownerActor,
  });

  const stop = (): void => {
    engine.cancelAll();
    storage.close();
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
