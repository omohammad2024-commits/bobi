# PLATFORM — the one BOBI, built once

Platform Phase 5 replaced the two hand-wired entry points (the Telegram
bot's `main()` and the MCP server's `serve.ts`) with a single composition
root. There is exactly **one** BOBI: `buildPlatform()` in
`src/bootstrap.ts` constructs the whole platform once — same tool desk,
same memory stack, same provider gateway, same engine — and each starter
only *mounts a surface* on it. «یه بابی واحد»: the Telegram bot and the
MCP server are two surfaces over one platform, not two programs that
happen to share a database.

The guarantees this document describes are pinned by tests:

- `tests/platform_unified.test.ts` — builds the platform on a temp DB
  (mcp surface, no token, no network) and proves the full tool desk, the
  shared memory/conversation state across surfaces, and the single
  provider selection.
- `tests/import_cycles.test.ts` — the import-cycle gate (§4).

---

## 1. Bootstrap construction order

`buildPlatform(config, opts?)` in `src/bootstrap.ts` constructs, in this
order (construction only — see the deferred list below):

1. **Logger** — `Logger` at `config.logLevel`.
2. **Bot token** — telegram surface: `requireBotToken(config)` (throws
   when absent). mcp surface: the configured value or `""`; no token is
   required and no bot will be built.
3. **Owner identity, fail-closed** — `parseOwnerId(config.ownerTelegramIdRaw)`;
   on failure the reason is written to stderr, `process.exitCode = 1`,
   and `buildPlatform` returns `undefined`. `OwnerIdentity.fromNumber`
   follows.
4. **Storage & side stores** — `Storage.open(config.dbPath)`,
   `AuditLogger`, plus the lazy own-handle stores on the same SQLite
   file: `ProposalStore` (curator), `NudgeTracker`.
5. **Access services** — `AuthorizationService`, `AdminBoundary`,
   `GroupAccessService`, `UserAccessService`.
6. **Secrets & search** — `ProviderSecretStore` (master key; warns when
   unset), `SearchProviderSecretStore`, `SearchRegistry`,
   `SearchSettingsService`, the `searchEnabled` flag and the shared
   digest headline resolver.
7. **MCP client manager** — `loadMcpConfig` (issues are logged, never
   fatal) and `McpManager`. Inert at construction; connecting spawns
   processes and is deferred.
8. **Bench stack** — `BenchHistory`, `BenchJobStore` (durable queue),
   `BenchWorker`, the `run_bench` tool (owner notification is lazy — the
   bot API does not exist yet).
9. **Group history buffer** — in-process, deliberately unpersisted.
10. **Memory stack** — `AdapterRegistry` (built here, early, because the
    embedder needs it), `resolveMemoryProvider(storage)`,
    `ProviderEmbedder`, `MemoryVectorStore`, `SemanticMemorySearch`;
    `indexState()` is reported in the log (DB-local/read-only, so it is
    *not* deferred). Then the **MemoryFacade** over the stack.
11. **`extraTools` assembly** — the factory tools: memory, history,
    reminders, downloader, nudges, goals, scheduled tasks, usage report,
    commands, `run_bench`, digest, curator, the MCP bridge tools; plus
    `group_digest` when an owner is configured, `web_search` when search
    is enabled, `generate_image` / video generation only when their
    endpoints are configured.
12. **Plugins, hooks, skills, context files** — `loadPlugins`,
    `HookRunner`, `SkillCache` (directory skills + plugin skills),
    `ContextFileCache`.
13. **ToolService** — constructed with `extraTools` (defaults from the
    plugin barrel + the factories above); `tool_search` is registered
    immediately after, wired to the actor-filtered viewer.
14. **Provider services & gateway** — `ProviderService`, `ModelService`,
    the one shared `CircuitBreakerRegistry`, `ProviderProbeService`,
    and `AiGateway` (shared breakers, shared `sharedModelQuarantine`,
    pre-warm and unknown-error hooks). Then the **ProvidersFacade**.
    The boot selection is computed and the connection warm-up closure is
    captured (firing it is deferred).
15. **Usage & rate limiting** — `UsageTracker` + the `recordRunUsage`
    observer, `UsageService`, the **UsageFacade**, `RateLimiter`.
16. **Selection check & composed provider** — `ensureSelection()` is
    logged (active pair, or "test mode"); the provider the engine sees is
    the composed `bobi` provider: it delegates to the gateway when a
    selection exists, and otherwise answers with a diagnostic that names
    the selection problem (model `"fake"` — never a silent dead end);
    a `FakeProvider` instance backs its capability checks in that state.
17. **Smart-summary port** — assigned into the group-digest tool deps
    (the tool reads it at run time).
18. **Late tool registrations** — `delegate` (needs the finished
    ToolService), the shortcut tools (validated against the live
    registry), and `consult_models` only when a selection exists. The
    **ToolsFacade** then wraps the finished service.
19. **Engine** — the main `ConversationEngine` (gateway-backed provider,
    tools, skills, context files, memory prompt = latest episode +
    proactive recall, personality/lang resolvers, budgets, hooks,
    usage observer, webhook event sink), wrapped in the **TurnFacade**.
    A dedicated heartbeat engine with tight per-beat budgets is built
    later (step 22) over the same provider/storage/tools.
20. **Controllers** — `PanelController`, `UserPanelController`,
    `AiAdminController` (owner notification resolves the bot API
    lazily), wrapped in the **AdminFacade**. `BOT_VERSION` is read from
    `package.json`.
21. **Telegram surface only** — `createBot(token, …)` fed from the
    facades (turn engine, tools service, usage service, admin panels);
    Hermes-parity command modules, phase-3/5 command modules, and the
    captured (deferred) group-assistant registration and menu sync.
22. **Schedulers & heartbeat (constructed, not started)** —
    `ReminderScheduler`, `EventStore`, `TaskScheduler`, the shared
    server-side `actorForUser` / `mayDeliverTo` gates, the heartbeat
    engine + `HeartbeatService`; the **SchedulingFacade** over them.
23. **Platform assembly** — the `Platform` aggregate (facades + core
    handles + deferred triggers) is returned.

**Deferred to the start phase** (construction side effects a starter may
not want — port binding, process spawning, network calls):
`connectMcp()` (spawns external MCP servers), `warmBootConnection()`
(provider connection warm-up), `registerGroupAssistantCommands()`
(`bot.api.getMe()`), `applyTelegramMenus()` (`setMyCommands`). Only
`startTelegramSurface()` invokes them, in that relative order.

`startTelegramSurface(platform)` then starts, in order: the deferred
triggers above → reminder scheduler → the nudge sweep interval (which
also carries auto event extraction and the throttled memory maintenance)
→ task scheduler → bench worker → heartbeat → background provider health
probes → health server (only when `config.healthPort > 0` and it does
not collide with the API port) → the HTTP API / Mini App server →
SIGINT/SIGTERM handlers → `bot.start()`. Shutdown reverses it: schedulers
and probes stop before engines are cancelled and storage closes.

---

## 2. Facade map

Facades live in `src/platform/*.ts`, are aggregated by the `Platform`
type in `src/platform/index.ts`, and are **delegation only** — no logic,
no reimplemented computation. Each wraps existing core objects and hands
the *same instances* to consumers.

| Facade | Wraps | Consumed by |
| --- | --- | --- |
| `TurnFacade` (`platform/turn.ts`) | `ConversationEngine` — `respond`, `cancel`/`cancelAll`, `compressNow`, `isAnyTurnRunning`, `isFake`, plus the raw `engine` handle | `createBot` (via `turnFacade.engine` in bootstrap), `src/mcp/serve.ts` (`engineFactory: () => platform.turn.engine`), the HTTP API / Mini App turn endpoints (via `platform.engine`, the same object) |
| `ToolsFacade` (`platform/tools.ts`) | `ToolService` — `registry`, `list()`, `listActiveNames()`, `runTool()` | `createBot` (via `toolsFacade.service`), `src/mcp/serve.ts` (owner grants resolved over `platform.tools.registry.list()`), schedulers/heartbeat in the start phase (via `platform.tools.service`) |
| `ProvidersFacade` (`platform/providers.ts`) | `ProviderService` + `ModelService` + `AiGateway` — `currentSelection()` delegates to `AiGateway.currentSelection()` | Mini App server (provider/model services in the start phase), panels/health via the shared gateway + breaker registry; the single-selection property is pinned in `tests/platform_unified.test.ts` |
| `MemoryFacade` (`platform/memory.ts`) | `MemoryProvider` + `SemanticMemorySearch` + `OwnerProfileService` + `Storage` (conversation reader for the episode sweep) — `latestEpisode()`, `scanEndedConversations()`, raw `provider`/`semantic`/`ownerProfile` handles | the start-phase nudge sweep / memory maintenance (via `platform.memory.provider`), episode & recall wiring inside the composition root |
| `SchedulingFacade` (`platform/scheduling.ts`) | `ReminderScheduler` + `TaskScheduler` + `HeartbeatService` | starters read the same handles off `Platform` (`platform.scheduler`, …) to start/stop them; the facade is the domain surface over the trio |
| `AdminFacade` (`platform/admin.ts`) | `PanelController` + `UserPanelController` + `AiAdminController` + `AdminBoundary` | `createBot` (via `adminFacade.panel` / `.userPanel` / `.aiAdmin` in bootstrap) |
| `UsageFacade` (`platform/usage.ts`) | `UsageService` (`src/core/usage`) **and** `UsageTracker` (`src/ai/usage`), presented distinctly — **not merged** (see §6) | `createBot` (via `usageFacade.service`), the engine's per-run observer writes through the tracker inside the composition root |

`Platform` also carries the core handles starters legitimately need
(`config`, `log`, `storage`, `identity`, `auth`, `groups`, `users`,
`engine`, `bot?`, the schedulers, `benchWorker`, `healthSvc`, `breakers`,
`mcp`, `hookRunner`, `skills`, `rateLimit`, stores, `apiPort`, `version`,
`actorForUser`, `mayDeliverTo`, and the deferred triggers).

---

## 3. Layering rule

```
starters        src/index.ts · src/mcp/serve.ts
   │  import bootstrap only; mount/start one surface
   ▼
bootstrap       src/bootstrap.ts — the one composition root
   │  constructs everything, in the order of §1
   ▼
platform        src/platform/*.ts — facades (delegation only)
   │  wrap, never reimplement
   ▼
core            conversation · tools · ai · memory · scheduler · auth ·
                groups · search · bench · curator · hooks · skills · …
   │
   ▼
storage         src/storage/storage.ts (SQLite) and own-handle side stores
```

Rules:

- **Starters import `bootstrap`; `bootstrap` never imports a starter.**
  `src/index.ts` and `src/mcp/serve.ts` are leaves at the top of the
  graph — nothing in `src/` imports them.
- **Facades may import core; core never imports facades or bootstrap.**
  Surfaces (bot, MCP server, HTTP API) receive platform objects; they do
  not reach around them to re-wire their own copies.
- One object, many surfaces: if two surfaces need the same service, the
  instance comes from the `Platform` aggregate. A second `ToolService`,
  a second gateway, or a privately-constructed engine in a starter is a
  layering bug — it would fork the tool desk, the selection, or the
  memory stack (exactly what §5's predecessor code did).

---

## 4. Import-cycle policy

**`src/` must stay acyclic — zero strongly-connected components with
more than one file.** Cycles make module evaluation order load-bearing,
let surfaces couple to each other through the back door, and were the
root blocker Phase 5 steps C–C3 removed (the last ones by moving
`ToolServicePort` into `tools/types`, `ExecuteRequest` into `types`, and
extracting the `delegate_manifest` leaf).

The gate is `tests/import_cycles.test.ts`:

- It builds the graph of all `src/**/*.ts` files from filesystem reads
  only — static imports, `export … from`, and dynamic `import()`
  specifiers, resolved as `./x` → `x.ts` or `x/index.ts` — and runs
  Tarjan's SCC algorithm over it.
- On failure the assertion message **names the files of every offending
  component**, so the cycle is debuggable from test output alone.
- Fixture self-checks inside the same file prove the scanner still
  detects a static cycle, an export-from edge, a dynamic-import cycle,
  and a self-import — the gate cannot silently rot into a no-op.

When a cycle appears, break it the way Phase 5 did: move the shared
contract *down* to a leaf module (types/interfaces, a manifest, a port)
that both sides can import, or invert the dependency by injecting the
collaborator from the composition root. Never break it by importing a
starter or a facade from core.

---

## 5. The two starters

### `src/index.ts` — Telegram (23 lines)

`loadConfig()` → `buildPlatform(config)` (default surface `"telegram"`)
→ `startTelegramSurface(platform)`. An `undefined` platform means the
fail-closed owner gate already reported and set `process.exitCode`.

Mounts/starts: the grammY bot (long polling), reminder + task
schedulers, the nudge sweep, the bench worker, the heartbeat (inert
unless `HEARTBEAT_INTERVAL_MS > 0`), background provider health probes,
the conditional health server, the HTTP API + Mini App server, external
MCP client connections, Telegram command menus, and the provider
connection warm-up.

### `src/mcp/serve.ts` — MCP server over stdio (75 lines)

`loadConfig()` → the same fail-closed owner parse →
`buildPlatform(config, { surface: "mcp" })` →
`createMcpServer({ storage: platform.storage, engineFactory: () =>
platform.turn.engine, ownerActor })`, where `ownerActor` is built
server-side via `authorizeToolUse` + `toToolActor` from the validated
owner identity — a request over stdio can never contribute to it (see
`src/mcp/server.ts` for the trust model) → `server.serve()`.

Starts **none** of the Telegram machinery: no bot, no schedulers, no
heartbeat/bench worker, no health/API servers, no interval sweeps, no
external-MCP connections, and no bot token is required. SIGINT/SIGTERM
cancel in-flight turns and close storage. Because it mounts the same
platform, the MCP surface exposes the **full** tool desk and the same
memory — the property pinned by `tests/platform_unified.test.ts`.

---

## 6. Known deferred item: the two `priceFor` implementations

There are **two** model-price lookups, and they intentionally remain
unmerged behind the UsageFacade:

- `src/core/usage.ts` — private `priceFor(model)`: scans its price table
  in **insertion order** (`Object.entries(PRICES)`), first substring
  match wins.
- `src/ai/usage.ts` — exported `priceFor(modelId)`: sorts keys
  **longest-key-first** before matching, specifically so `gpt-4o-mini`
  is not priced at the `gpt-4o` rate.

The semantics observably differ: for `gpt-4o-mini`, the core scan hits
`gpt-4o` first (insertion order) and estimates $2.50/$10.00 per 1M
tokens, while the ai lookup matches `gpt-4o-mini` first and estimates
$0.15/$0.60. Unifying them — in either direction — changes cost
estimates shown in usage summaries and reports, so it is a **product
decision, not a refactor**: the UsageFacade presents both services
distinctly (`coreHandle` / `trackerHandle`) and Phase 5 deliberately did
not touch either implementation.
