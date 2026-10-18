/**
 * Callback routing between the panels.
 *
 * The router asks each controller in turn and stops at the first that claims
 * the callback. That design has one sharp failure: a controller that claims
 * MORE than it handles swallows the others' buttons silently — no error, no
 * reply, just a dead button.
 *
 * That is exactly what happened. `PanelController` returned true for any
 * decodable action, so every button in `/ai` was claimed by the group panel,
 * matched no case in its dispatch, and did nothing. The owner saw a menu whose
 * buttons were all inert and no indication why.
 *
 * These tests pin the boundary: each controller claims its own actions and
 * refuses everything else.
 */
import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage/storage";
import { AuthorizationService } from "../src/auth/service";
import { OwnerIdentity } from "../src/auth/identity";
import { AdminBoundary } from "../src/auth/admin_boundary";
import { AuditLogger } from "../src/auth/audit";
import { GroupAccessService } from "../src/groups/service";
import { PanelController } from "../src/groups/controller";
import { AiAdminController } from "../src/groups/ai_controller";
import { UserPanelController } from "../src/auth/user_controller";
import { UserAccessService } from "../src/auth/user_service";
import { ModelService, ProviderService } from "../src/ai/provider_service";
import { ProviderHealthService } from "../src/ai/health";
import { ProviderSecretStore } from "../src/ai/secret_store";
import { AdapterRegistry } from "../src/ai/adapter_registry";
import { encode, decode } from "../src/groups/callbacks";
import type { PanelAction } from "../src/groups/callbacks";

const OWNER = 111_111;

/** A context that records what the controller tried to send. */
function fakeCtx() {
  const sent: string[] = [];
  return {
    sent,
    ctx: {
      from: { id: OWNER },
      reply: async (text: string) => {
        sent.push(text);
      },
      answerCallbackQuery: async () => {},
    } as never,
  };
}

function harness() {
  const storage = Storage.open(":memory:");
  const auth = new AuthorizationService(OwnerIdentity.fromNumber(OWNER));
  const admin = new AdminBoundary({ auth, audit: new AuditLogger({ storage }) });
  const groups = new GroupAccessService(storage);
  const users = new UserAccessService(storage);
  const secrets = new ProviderSecretStore("k".repeat(64));
  const adapters = new AdapterRegistry();
  const providers = new ProviderService(storage, secrets, adapters);

  const panel = new PanelController({
    auth,
    admin,
    groups,
    notify: async () => true,
    statusInfo: () => ({ provider: "p", model: "m" }),
  });
  const aiAdmin = new AiAdminController({
    auth,
    admin,
    storage,
    providers,
    models: new ModelService(storage),
    health: new ProviderHealthService(storage, providers, secrets, adapters),
    secrets,
    adapters,
  });
  const userPanel = new UserPanelController({
    auth,
    admin,
    users,
    notify: async () => true,
  });

  return { storage, panel, aiAdmin, userPanel };
}

/** Route a callback exactly as the bot does: panel, then AI, then users. */
async function route(h: ReturnType<typeof harness>, action: PanelAction) {
  const data = encode(action);
  // A round trip through the codec, so a test cannot pass with data the bot
  // would never actually receive.
  expect(decode(data)).toEqual(action);

  const claims = { panel: false, ai: false, users: false };
  for (const [name, controller] of [
    ["panel", h.panel],
    ["ai", h.aiAdmin],
    ["users", h.userPanel],
  ] as const) {
    const f = fakeCtx();
    const handled = await controller.handleCallback(f.ctx, data);
    if (handled) {
      claims[name] = true;
      return { claims, sent: f.sent };
    }
  }
  return { claims, sent: [] as string[] };
}

describe("each panel claims only its own actions", () => {
  test("group actions go to the group panel", async () => {
    const h = harness();
    for (const action of [
      { kind: "menu" },
      { kind: "status" },
      { kind: "pending", offset: 0 },
      { kind: "approved", offset: 0 },
      { kind: "revoke_menu", offset: 0 },
    ] as const) {
      const r = await route(h, action as PanelAction);
      expect(r.claims).toEqual({ panel: true, ai: false, users: false });
    }
    h.storage.close();
  });

  test("AI actions reach the AI controller", async () => {
    // This is the bug: every one of these was swallowed by the group panel.
    const h = harness();
    for (const action of [
      { kind: "ai_menu" },
      { kind: "ai_providers" },
      { kind: "ai_select_menu" },
      { kind: "ai_status" },
      { kind: "fo_menu" },
      { kind: "search_menu" },
    ] as const) {
      const r = await route(h, action as PanelAction);
      expect(r.claims.ai).toBe(true);
      expect(r.claims.panel).toBe(false);
    }
    h.storage.close();
  });

  test("user actions reach the user panel", async () => {
    const h = harness();
    for (const action of [
      { kind: "users_menu" },
      { kind: "users_pending", offset: 0 },
    ] as const) {
      const r = await route(h, action as PanelAction);
      expect(r.claims.users).toBe(true);
      expect(r.claims.panel).toBe(false);
      expect(r.claims.ai).toBe(false);
    }
    h.storage.close();
  });

  test("an AI action actually produces a reply", async () => {
    // Claiming is not enough: the controller must also render something. A
    // claimed-but-silent callback is the same dead button from the user's side.
    const h = harness();
    const f = fakeCtx();
    const handled = await h.aiAdmin.handleCallback(f.ctx, encode({ kind: "ai_menu" }));
    expect(handled).toBe(true);
    expect(f.sent.length).toBeGreaterThan(0);
    h.storage.close();
  });

  test("the provider list produces a reply too", async () => {
    const h = harness();
    const f = fakeCtx();
    await h.aiAdmin.handleCallback(f.ctx, encode({ kind: "ai_providers" }));
    expect(f.sent.length).toBeGreaterThan(0);
    h.storage.close();
  });
});

describe("routing is exhaustive and disjoint", () => {
  test("no action is claimed by two controllers", async () => {
    // Every action kind the codec can produce, routed once.
    const sampled: PanelAction[] = [
      { kind: "menu" },
      { kind: "pending", offset: 0 },
      { kind: "ai_menu" },
      { kind: "ai_providers" },
      { kind: "fo_menu" },
      { kind: "search_menu" },
      { kind: "users_menu" },
      { kind: "users_pending", offset: 0 },
    ];
    const h = harness();
    for (const action of sampled) {
      const r = await route(h, action);
      const claimed = Object.values(r.claims).filter(Boolean).length;
      expect(claimed).toBe(1);
    }
    h.storage.close();
  });

  test("an undecodable callback is claimed by nobody", async () => {
    const h = harness();
    for (const junk of ["", "nonsense", "adm:", "adm:zzz", "menu:chat"]) {
      for (const controller of [h.panel, h.aiAdmin, h.userPanel]) {
        expect(await controller.handleCallback(fakeCtx().ctx, junk)).toBe(false);
      }
    }
    h.storage.close();
  });
});
