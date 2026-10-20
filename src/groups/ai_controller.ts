/**
 * AI admin controller — every AI management action, behind the boundary.
 *
 * Security posture, matching the group controller exactly:
 *  - The actor is rebuilt from the trusted `ctx.from.id` on every click, never
 *    from callback data.
 *  - Every action runs through AdminBoundary, which re-checks identity and
 *    permission at execution time and audits the outcome.
 *  - A callback is a request for an operation, never a grant of authority.
 *  - Credentials never appear in output, audit, or logs: the panel shows
 *    set/unset and only the store can decrypt.
 *  - Free-text input (labels, base URLs, keys, model ids) is validated here and
 *    reaches SQL only as a parameter.
 *
 * Panel button clicks edit the panel message in place (editMessageText) instead
 * of stacking a new message per click. Free-text replies still arrive as new
 * messages and are answered with new messages.
 */
import { Context, InlineKeyboard } from "grammy";
import type { AdminBoundary } from "../auth/admin_boundary";
import type { AuthorizationService } from "../auth/service";
import type { Permission } from "../auth/roles";
import type { ProviderHealthService, ProbeResult } from "../ai/health";
import type { ProviderSecretStore } from "../ai/secret_store";
import type { AdapterRegistry } from "../ai/adapter_registry";
import { ModelService, ProviderService, type ProviderView } from "../ai/provider_service";
import type { RemoteModel } from "../ai/adapter";
import { ADAPTER_TEMPLATES, providerPreset } from "../ai/adapter";
import { setupFromPreset, parseSetupReply, setupPrompt, type SetupResult } from "../ai/setup";
import {
  checkProviderUrl,
  type ProviderUrlGuardIssue,
} from "../ai/provider_url_guard";
import { isAdapterType } from "../ai/adapter";
import type { Storage } from "../storage/storage";
import { resolveLang } from "../i18n";
import { decode, encode, type PanelAction } from "./callbacks";
import { PANEL_DENIED, PANEL_STALE, backKeyboard } from "./panel";
import { formatNum, tr, type PanelLang } from "./panel_strings";
import { atr } from "./ai_panel_audit_strings";
import {
  adapterKeyboard,
  addFormText,
  aiMenuKeyboard,
  aiMenuText,
  attemptsKeyboard,
  attemptsText,
  confirmClearKeyKeyboard,
  confirmClearKeyText,
  confirmDeleteModelKeyboard,
  confirmDeleteModelText,
  confirmDeleteProviderKeyboard,
  confirmDeleteProviderText,
  failoverKeyboard,
  failoverText,
  formCancelKeyboard,
  localTargetConfirmText,
  localTargetKeyboard,
  modelPickerKeyboard,
  modelsKeyboard,
  modelsText,
  providerKeyboard,
  providerPickerKeyboard,
  providerText,
  providersKeyboard,
  providersText,
  selectMenuText,
  statusText,
  statusKeyboard,
  timeoutKeyboard,
  timeoutText,
} from "./ai_panel";
import type { SearchSettingsService } from "../search/service";
import {
  backToSearchKeyboard,
  searchClearKeyConfirmKeyboard,
  searchClearKeyConfirmText,
  searchKeyClearedText,
  searchKeyFormText,
  searchKeySavedText,
  searchMenuKeyboard,
  searchMenuText,
  searchNoKeyNeededText,
} from "../search/panel";

/** Permissions required for AI management. */
const PERM_VIEW: Permission = "admin.view";
const PERM_MANAGE: Permission = "settings.manage";

/** A pending free-text submission, keyed by the owner's Telegram id. */
interface PendingInput {
  kind:
    | "add_provider"
    | "edit_provider"
    | "search_key"
    | "setup_preset"
    | "add_pool_key"
    | "add_model";
  providerId?: number;
  /** When set, the add flow preselects this adapter. */
  adapter?: string;
  /** When set, the add flow came from a named service preset. */
  presetId?: string;
}

export interface AiAdminOptions {
  auth: AuthorizationService;
  admin: AdminBoundary;
  storage: Storage;
  providers: ProviderService;
  models: ModelService;
  health: ProviderHealthService;
  secrets: ProviderSecretStore;
  adapters: AdapterRegistry;
  /** Web-search settings; absent means the search section is not offered. */
  search?: SearchSettingsService;
  /**
   * Owner language preference reader. Defaults to the storage-backed
   * `user_prefs` reader, so panels follow the owner's /lang choice.
   */
  prefs?: (userId: string, key: string) => string | undefined;
  /**
   * Engine-level timeouts as resolved from the environment (AI_TIMEOUT_MS,
   * AGENT_TOTAL_TIMEOUT_MS). Optional: when absent the /ai status timeouts
   * line renders "Not set" for those values instead of guessing.
   */
  engineTimeouts?: { aiTimeoutMs: number; agentTotalTimeoutMs: number };
}

export class AiAdminController {
  private readonly auth: AuthorizationService;
  private readonly admin: AdminBoundary;
  private readonly storage: Storage;
  private readonly providers: ProviderService;
  private readonly models: ModelService;
  private readonly health: ProviderHealthService;
  private readonly secrets: ProviderSecretStore;
  private readonly adapters: AdapterRegistry;
  private readonly search: SearchSettingsService | undefined;
  private readonly prefs: (userId: string, key: string) => string | undefined;
  private readonly engineTimeouts:
    | { aiTimeoutMs: number; agentTotalTimeoutMs: number }
    | undefined;

  /** Per-owner state for the free-text add/replace flows. Never in a callback. */
  private readonly pending = new Map<number, PendingInput>();

  constructor(opts: AiAdminOptions) {
    this.auth = opts.auth;
    this.admin = opts.admin;
    this.storage = opts.storage;
    this.providers = opts.providers;
    this.models = opts.models;
    this.health = opts.health;
    this.secrets = opts.secrets;
    this.adapters = opts.adapters;
    this.search = opts.search;
    this.engineTimeouts = opts.engineTimeouts;
    this.prefs = opts.prefs ?? ((u, k) => this.storage.getUserPref(u, k));
  }

  /** Actor from a trusted context; undefined when identity is absent. */
  private actorFor(ctx: Context) {
    const from = ctx.from;
    if (!from) return undefined;
    return this.auth.actorFromTelegramUser(from);
  }

  /** The owner's panel language: Persian unless they chose English. */
  private langFor(ctx: Context): PanelLang {
    const id = ctx.from?.id;
    if (id === undefined) return "fa";
    return resolveLang(String(id), this.prefs);
  }

  /** The search settings view, or a placeholder when search is not wired. */
  private searchView(lang: PanelLang): { text: string; keyboard: unknown } {
    if (!this.search) {
      return { text: tr(lang, "panel.search.unavailable"), keyboard: backKeyboard(lang) };
    }
    const v = this.search.view();
    return {
      text: searchMenuText(v, lang),
      keyboard: searchMenuKeyboard(v.provider, v.hasKey, lang),
    };
  }

  /** True when data belonged to the AI panel and was handled. */
  async handleCallback(ctx: Context, data: string): Promise<boolean> {
    const action = decode(data);
    if (!action) return false;
    if (!AI_ACTION_KINDS.has(action.kind)) return false;
    // Narrowed by the kind set above; the cast is only for the union extract.
    await this.dispatch(ctx, action as AiPanelAction);
    return true;
  }

  /** `/ai` — open the AI section for the owner only. */
  async open(ctx: Context): Promise<void> {
    const actor = this.actorFor(ctx);
    const lang = this.langFor(ctx);
    const r = await this.admin.runAdmin(
      { actor, operation: "ai.menu", permission: PERM_VIEW },
      () => ({
        text: aiMenuText(lang, this.activePairForPanel()),
        keyboard: aiMenuKeyboard(lang),
      }),
    );
    if (!r.ok) return void (await this.deny(ctx));
    await this.render(ctx, r.data.text, r.data.keyboard);
  }

  /**
   * The active provider/model pair for the /ai panel header. Null when
   * nothing valid is selected — the panel then shows the plain "not
   * configured" line with its one-tap add path instead of silence.
   */
  private activePairForPanel(): { providerLabel: string; modelLabel: string } | null {
    try {
      const sel = this.storage.getRuntimeSettings();
      if (sel.activeProviderId === null || sel.activeModelId === null) return null;
      const p = this.storage.getProvider(sel.activeProviderId);
      const m = this.storage.getModel(sel.activeModelId);
      if (!p || !m || !p.enabled || !m.enabled || m.providerId !== p.id) return null;
      return { providerLabel: p.label, modelLabel: m.label };
    } catch {
      return null;
    }
  }

  // --------------------------------------- onboarding wizard support ----

  /**
   * True when a REAL provider is configured: the runtime selection points at
   * an existing, enabled provider that has a stored credential and at least
   * one model. This is the wizard's "already connected" check — anything less
   * (no selection, disabled provider, missing key/model) reads as the
   * FakeProvider state the wizard exists to fix.
   *
   * Read-only and fail-closed: a storage hiccup reports "not configured"
   * rather than breaking /start.
   */
  hasConfiguredProvider(): boolean {
    try {
      const sel = this.storage.getRuntimeSettings();
      if (sel.activeProviderId === null || sel.activeProviderId === undefined) return false;
      const p = this.storage.getProvider(sel.activeProviderId);
      if (p === undefined || !p.enabled) return false;
      if (!this.storage.hasCredential(sel.activeProviderId)) return false;
      if (this.storage.listModels(sel.activeProviderId).length === 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The label of the currently active provider, for the wizard's "already
   * connected" checkmark. Undefined when nothing real is configured.
   */
  activeProviderLabel(): string | undefined {
    try {
      const sel = this.storage.getRuntimeSettings();
      if (sel.activeProviderId === null || sel.activeProviderId === undefined) return undefined;
      return this.storage.getProvider(sel.activeProviderId)?.label;
    } catch {
      return undefined;
    }
  }

  /**
   * One-message preset setup for the onboarding wizard: create the provider
   * from a preset, add its suggested model, and activate the pair — the same
   * `setupFromPreset` transaction the /ai one-message flow uses.
   *
   * SECURITY: runs inside the AdminBoundary with PERM_MANAGE, so ownership is
   * re-checked server-side at execution time — a forged wizard callback from a
   * non-owner never reaches the write. The key is never echoed back; the
   * SetupResult only names what was created.
   */
  async wizardSetupPreset(
    from: { id?: number | null; username?: string } | undefined,
    presetId: string,
    apiKey: string,
    baseUrlOverride?: string,
  ): Promise<SetupResult> {
    const actor = this.auth.actorFromTelegramUser(from);
    const r = await this.admin.runAdmin(
      { actor, operation: "ai.setup", permission: PERM_MANAGE, targetId: presetId },
      () =>
        setupFromPreset(
          {
            storage: this.storage,
            providers: this.providers,
            models: this.models,
            secrets: this.secrets,
          },
          presetId,
          apiKey,
          baseUrlOverride,
        ),
    );
    if (!r.ok) {
      // Unreachable for the owner (the wizard is owner-gated and PERM_MANAGE
      // is owner-only); surface the boundary's own denial text rather than a
      // hardcoded literal — panel sources must not carry Persian literals.
      return { ok: false, message: r.message, notes: [] };
    }
    return r.data;
  }

  /**
   * Live hello-test for a provider, for the wizard's verification step.
   * Runs the same `health.probe` the panel's «تست» button uses (a minimal
   * completion or model-list call), inside the AdminBoundary with
   * PERM_MANAGE. Never leaks key material: the probe message is chosen by
   * the health module.
   */
  async wizardProbeProvider(
    from: { id?: number | null; username?: string } | undefined,
    providerId: number,
  ): Promise<ProbeResult> {
    const actor = this.auth.actorFromTelegramUser(from);
    const r = await this.admin.runAdmin(
      { actor, operation: "ai.test.run", permission: PERM_MANAGE, targetId: String(providerId) },
      async () => this.health.probe(providerId),
    );
    if (!r.ok) return { ok: false, checkedAt: Date.now() };
    return r.data;
  }

  private async dispatch(ctx: Context, action: AiPanelAction): Promise<void> {
    const actor = this.actorFor(ctx);
    const lang = this.langFor(ctx);

    switch (action.kind) {
      case "ai_menu":
        await this.open(ctx);
        return;

      // ---- free-text form cancel ----
      case "ai_form_cancel": {
        const ownerId = ctx.from?.id;
        const flow = ownerId !== undefined ? this.pending.get(ownerId) : undefined;
        if (ownerId !== undefined) this.pending.delete(ownerId);
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.form.cancel", permission: PERM_VIEW },
          () => this.cancelView(flow, lang),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      // ---- web-search settings ----
      case "search_menu": {
        if (!this.search) return void (await this.deny(ctx));
        const r = await this.admin.runAdmin(
          { actor, operation: "search.menu", permission: PERM_VIEW },
          () => this.searchView(lang),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "search_pick": {
        const search = this.search;
        if (!search) return void (await this.deny(ctx));
        const r = await this.admin.runAdmin(
          { actor, operation: "search.pick", permission: PERM_MANAGE, targetId: action.provider },
          () => search.select(action.provider),
        );
        if (!r.ok) return void (await this.deny(ctx));
        const v = this.searchView(lang);
        await this.render(
          ctx,
          r.data.ok ? v.text : tr(lang, "panel.search.pick_fail"),
          v.keyboard,
        );
        return;
      }

      case "search_set_key_form": {
        if (!this.search) return void (await this.deny(ctx));
        const r = await this.admin.runAdmin(
          { actor, operation: "search.set_key_form", permission: PERM_MANAGE },
          () => {
            if (!this.search!.selectedNeedsKey()) {
              return {
                text: searchNoKeyNeededText(this.search!.label(), lang),
                ok: false as const,
              };
            }
            this.setPending(ctx, { kind: "search_key" });
            return { text: searchKeyFormText(lang), ok: true as const };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(
          ctx,
          r.data.text,
          r.data.ok ? formCancelKeyboard(lang) : backToSearchKeyboard(lang),
        );
        return;
      }

      case "search_clear_key": {
        if (!this.search) return void (await this.deny(ctx));
        const r = await this.admin.runAdmin(
          { actor, operation: "search.clear_key.confirm", permission: PERM_MANAGE },
          () => ({
            text: searchClearKeyConfirmText(this.search!.label(), lang),
            keyboard: searchClearKeyConfirmKeyboard(lang),
          }),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "search_clear_key_confirm": {
        if (!this.search) return void (await this.deny(ctx));
        const r = await this.admin.runAdmin(
          { actor, operation: "search.clear_key", permission: PERM_MANAGE },
          () => ({ cleared: this.search!.clearKey(), label: this.search!.label() }),
        );
        if (!r.ok) return void (await this.deny(ctx));
        const v = this.searchView(lang);
        await this.render(
          ctx,
          `${searchKeyClearedText(r.data.label, lang)}\n\n${v.text}`,
          v.keyboard,
        );
        return;
      }

      // ---- operational status ----
      case "ai_status": {
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.status", permission: PERM_VIEW },
          () => ({ text: this.buildStatusText(lang), keyboard: statusKeyboard(lang) }),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_probe_all": {
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.probe_all", permission: PERM_MANAGE },
          () => "authorized",
        );
        if (!r.ok) {
          await this.deny(ctx);
          return;
        }
        await this.render(ctx, tr(lang, "panel.aistatus.probing"), backKeyboard(lang));
        const results = await this.runAuthorizedProbeAll(ctx, lang);
        await this.render(ctx, results, statusKeyboard(lang));
        return;
      }

      // ---- failover administration ----
      case "fo_menu": {
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.menu", permission: PERM_VIEW },
          () => this.failoverView(lang),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "fo_toggle": {
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.toggle", permission: PERM_MANAGE },
          () => {
            const s = this.storage.getFailoverSettings();
            const next = !s.enabled;
            if (next) {
              // Turning failover on with no usable candidate would silently do
              // nothing later, so say so now rather than pretending.
              if (this.storage.listFailoverCandidates().length === 0) {
                return {
                  ok: false as const,
                  message: tr(lang, "panel.fo.need_candidate"),
                };
              }
            }
            this.storage.setFailoverSettings({ enabled: next });
            return {
              ok: true as const,
              message: next
                ? tr(lang, "panel.fo.enabled")
                : tr(lang, "panel.fo.disabled"),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(lang),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `${r.data.message}\n\n${view.data.text}`, view.data.keyboard);
        return;
      }

      case "fo_attempts": {
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.attempts.view", permission: PERM_VIEW },
          () => {
            const s = this.storage.getFailoverSettings();
            return {
              text: attemptsText(s.maxAttempts, lang),
              keyboard: attemptsKeyboard(s.maxAttempts, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "fo_attempts_set": {
        const value = action.value;
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.attempts.set", permission: PERM_MANAGE, targetId: String(value) },
          () => {
            // The codec already bounds 1..4; storage clamps again.
            this.storage.setFailoverSettings({ maxAttempts: value });
            const s = this.storage.getFailoverSettings();
            return tr(lang, "panel.fo.attempts_set", { n: formatNum(s.maxAttempts, lang) });
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        // Back to the screen the picker was opened from: the failover menu.
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(lang),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `${r.data}\n\n${view.data.text}`, view.data.keyboard);
        return;
      }

      case "fo_timeout": {
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.timeout.view", permission: PERM_VIEW },
          () => {
            const s = this.storage.getFailoverSettings();
            return {
              text: timeoutText(s.timeoutMs, lang),
              keyboard: timeoutKeyboard(s.timeoutMs, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "fo_timeout_set": {
        const value = action.value;
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.timeout.set", permission: PERM_MANAGE, targetId: String(value) },
          () => {
            this.storage.setFailoverSettings({ timeoutMs: value });
            const s = this.storage.getFailoverSettings();
            return tr(lang, "panel.fo.timeout_set", { n: formatNum(s.timeoutMs, lang) });
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        // Back to the screen the picker was opened from: the failover menu.
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(lang),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `${r.data}\n\n${view.data.text}`, view.data.keyboard);
        return;
      }

      // fo_add_pick_provider is a legacy two-step picker code that no current
      // keyboard emits; it is handled like fo_add_form so a stale button can
      // never silently do nothing.
      case "fo_add_form":
      case "fo_add_pick_provider": {
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.add.form", permission: PERM_MANAGE },
          () => {
            // Only enabled providers are offered; a disabled one would be a
            // candidate that silently never runs.
            const pickable = this.providers.listViews().filter((p) => p.enabled);
            if (pickable.length === 0) {
              return { text: tr(lang, "panel.fo.no_provider"), keyboard: backKeyboard(lang) };
            }
            return {
              text: tr(lang, "panel.fo.pick_provider"),
              keyboard: this.foProviderKeyboard(pickable, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "fo_add_pick_model": {
        const providerId = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.add.pick_model", permission: PERM_MANAGE, targetId: String(providerId) },
          () => {
            const view = this.providers.view(providerId);
            if (!view || !view.enabled) return undefined;
            const models = this.models.enabledModels(providerId);
            if (models.length === 0) {
              return { text: tr(lang, "panel.fo.no_model"), keyboard: backKeyboard(lang) };
            }
            return {
              text: tr(lang, "panel.fo.pick_model"),
              keyboard: this.foModelKeyboard(providerId, models, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "fo_add_confirm": {
        const providerId = action.providerId;
        const modelId = action.modelId;
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.add", permission: PERM_MANAGE, targetId: `${providerId}:${modelId}` },
          () => {
            const view = this.providers.view(providerId);
            const model = this.models.get(modelId);
            if (!view || !view.enabled) return { refused: tr(lang, "panel.fo.add_refused_provider") };
            if (!model || !model.enabled || model.providerId !== providerId) {
              return { refused: tr(lang, "panel.fo.add_refused_model") };
            }
            const current = this.storage.listFailoverCandidates();
            // A duplicate candidate would double the effective attempt count.
            if (current.some((c) => c.providerId === providerId && c.modelId === modelId)) {
              return { refused: tr(lang, "panel.fo.add_duplicate") };
            }
            this.storage.setFailoverCandidates([
              ...current,
              { providerId, modelId },
            ]);
            return { added: true };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if ("refused" in r.data) {
          await this.render(ctx, r.data.refused, backKeyboard(lang));
          return;
        }
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(lang),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `${tr(lang, "panel.fo.added")}\n\n${view.data.text}`, view.data.keyboard);
        return;
      }

      case "fo_remove": {
        const index = action.index;
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.remove", permission: PERM_MANAGE, targetId: String(index) },
          () => {
            const current = this.storage.listFailoverCandidates();
            // A stale index from an older render must not remove the wrong row.
            if (index < 0 || index >= current.length) {
              return { refused: tr(lang, "panel.fo.remove_stale") };
            }
            this.storage.setFailoverCandidates(current.filter((_, i) => i !== index));
            return { ok: true as const };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if ("refused" in r.data) {
          await this.render(ctx, r.data.refused, backKeyboard(lang));
          return;
        }
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(lang),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `${tr(lang, "panel.fo.removed")}\n\n${view.data.text}`, view.data.keyboard);
        return;
      }

      case "fo_local_menu": {
        const providerId = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.local.view", permission: PERM_MANAGE, targetId: String(providerId) },
          () => {
            const view = this.providers.view(providerId);
            if (!view) return undefined;
            return {
              text: localTargetConfirmText(view.label, view.allowLocal, lang),
              keyboard: localTargetKeyboard(providerId, view.allowLocal, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "fo_local_confirm": {
        const providerId = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.local.set", permission: PERM_MANAGE, targetId: String(providerId) },
          () => {
            const view = this.providers.view(providerId);
            if (!view) return undefined;
            // The service is also the place a duplicate write would be refused,
            // so route through update() rather than the storage setter.
            const res = this.providers.setAllowLocal(providerId, !view.allowLocal);
            if (!res.ok) return { refused: res.message };
            return { allowed: !view.allowLocal };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        if ("refused" in r.data) {
          await this.render(ctx, r.data.refused, backKeyboard(lang));
          return;
        }
        // Back to the provider screen the exception was opened from; the
        // confirmation states what is now persisted.
        const lead = r.data.allowed
          ? tr(lang, "panel.local.opened")
          : tr(lang, "panel.local.closed");
        await this.showProvider(ctx, providerId, lead, lang);
        return;
      }

      case "fo_move_up":
      case "fo_move_down": {
        const index = action.index;
        const up = action.kind === "fo_move_up";
        const r = await this.admin.runAdmin(
          {
            actor,
            operation: up ? "fo.move_up" : "fo.move_down",
            permission: PERM_MANAGE,
            targetId: String(index),
          },
          () => {
            const current = this.storage.listFailoverCandidates();
            const target = up ? index - 1 : index + 1;
            // Refuse a move that would go outside the list, rather than
            // silently reordering something unintended.
            if (index < 0 || index >= current.length) {
              return { refused: tr(lang, "panel.fo.remove_stale") };
            }
            if (target < 0 || target >= current.length) {
              return { refused: tr(lang, "panel.fo.move_bad") };
            }
            const next = [...current];
            const a = next[index]!;
            const b = next[target]!;
            next[index] = b;
            next[target] = a;
            this.storage.setFailoverCandidates(next);
            return { ok: true as const };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if ("refused" in r.data) {
          await this.render(ctx, r.data.refused, backKeyboard(lang));
          return;
        }
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(lang),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `${tr(lang, "panel.fo.moved")}\n\n${view.data.text}`, view.data.keyboard);
        return;
      }

      case "ai_providers": {
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.providers", permission: PERM_VIEW },
          () => ({
            text: providersText(this.providers.listViews(), lang),
            keyboard: providersKeyboard(lang),
          }),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_provider": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.provider.view", permission: PERM_VIEW, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            return { text: providerText(view, lang), keyboard: providerKeyboard(view, lang) };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_add_form": {
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.add.form", permission: PERM_MANAGE },
          () => ({ keyboard: adapterKeyboard(lang), text: tr(lang, "panel.add.pick_type") }),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_add_adapter": {
        const adapter = action.adapter;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.add.adapter", permission: PERM_MANAGE, targetId: adapter },
          () => {
            // Remember the owner is mid-flow so the next free-text reply is
            // interpreted as a provider, not as a chat message.
            this.setPending(ctx, { kind: "add_provider", adapter });
            return { text: addFormText(adapter, lang), keyboard: formCancelKeyboard(lang) };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_add_preset": {
        const preset = providerPreset(action.preset);
        if (!preset) return void (await this.deny(ctx));
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.add.preset", permission: PERM_MANAGE, targetId: preset.id },
          () => {
            // The owner is asked for ONE thing — the key — and everything else
            // comes from the preset. The pending state carries the preset id so
            // the reply can be applied without a second form.
            this.setPending(ctx, { kind: "setup_preset", presetId: preset.id });
            return { text: setupPrompt(preset, lang), keyboard: formCancelKeyboard(lang) };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_edit": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.edit.form", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            this.setPending(ctx, { kind: "edit_provider", providerId: id });
            return { text: editFormText(view, lang), keyboard: formCancelKeyboard(lang) };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_test": {
        const id = action.providerId;
        // Authorization runs BEFORE any progress message: an unauthorized click
        // must see only the generic denial, never a hint that a tool exists.
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.test", permission: PERM_MANAGE, targetId: String(id) },
          () => "authorized",
        );
        if (!r.ok) {
          await this.deny(ctx);
          return;
        }
        await this.render(ctx, tr(lang, "panel.provider.testing"), backKeyboard(lang));
        const probe = await this.runAuthorizedProbe(ctx, id, lang);
        // Back to the provider screen the test was launched from.
        await this.showProvider(ctx, id, probe.text, lang);
        return;
      }

      case "ai_discover": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.discover", permission: PERM_MANAGE, targetId: String(id) },
          () => "authorized",
        );
        if (!r.ok) {
          await this.deny(ctx);
          return;
        }
        await this.render(ctx, tr(lang, "panel.provider.discovering"), backKeyboard(lang));
        const found = await this.runAuthorizedDiscovery(ctx, id, lang);
        // On success the models landed in the model list, so land there: the
        // owner enables what they want next. On failure, back to the provider.
        if (found.ok) {
          await this.showModels(ctx, id, found.text, lang);
        } else {
          await this.showProvider(ctx, id, found.text, lang);
        }
        return;
      }

      case "ai_toggle": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.toggle", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            // The service refuses a change that would break the live selection,
            // so the message must report the refusal, not a stale success.
            const res = this.providers.setEnabled(id, !view.enabled);
            if (!res.ok) return { refused: true, text: res.message };
            return {
              refused: false,
              text: view.enabled
                ? tr(lang, "panel.provider.toggled_off")
                : tr(lang, "panel.provider.toggled_on"),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        // Back to the provider screen the toggle was tapped on.
        await this.showProvider(ctx, id, r.data.text, lang);
        return;
      }

      case "ai_clear_key": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.clear_key.confirm", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            return {
              text: confirmClearKeyText(view.label, lang),
              keyboard: confirmClearKeyKeyboard(id, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_clear_key_confirm": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.clear_key", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            this.providers.clearCredential(id);
            return { ok: true as const };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.showProvider(ctx, id, tr(lang, "panel.provider.key_cleared"), lang);
        return;
      }

      case "ai_pool_key": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.pool_key.form", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            // The key travels in the owner's next message, server-side only:
            // it is never shown, echoed, or handed to a model.
            this.setPending(ctx, { kind: "add_pool_key", providerId: id });
            return {
              text: [
                tr(lang, "panel.pool.prompt1"),
                "",
                tr(lang, "panel.pool.prompt2"),
                "",
                tr(lang, "panel.add.cancel_hint"),
              ].join("\n"),
              keyboard: formCancelKeyboard(lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_delete": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.delete.confirm", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            // First tap only asks; the second tap (ai_delete_confirm) destroys.
            return {
              text: confirmDeleteProviderText(view, lang),
              keyboard: confirmDeleteProviderKeyboard(id, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_delete_confirm": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.delete", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const res = this.providers.remove(id);
            return { ok: res.ok, message: res.ok ? undefined : res.message };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data.ok) {
          // A refusal (the provider is active) names the reason and nothing
          // else, on the provider screen it still exists on.
          await this.showProvider(ctx, id, r.data.message ?? "", lang);
          return;
        }
        const list = await this.admin.runAdmin(
          { actor, operation: "ai.providers.refresh", permission: PERM_VIEW },
          () => ({
            text: providersText(this.providers.listViews(), lang),
            keyboard: providersKeyboard(lang),
          }),
        );
        if (!list.ok) return void (await this.deny(ctx));
        await this.render(
          ctx,
          `${tr(lang, "panel.provider.deleted")}\n\n${list.data.text}`,
          list.data.keyboard,
        );
        return;
      }

      case "ai_models": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.models", permission: PERM_VIEW, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            const models = this.models.list(id);
            return {
              text: modelsText(models, view.label, lang),
              keyboard: modelsKeyboard(models, id, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_model_add_form": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.model_add.form", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            // The reply is consumed by handleText, like the other free-text
            // flows; the لغو button clears the pending state.
            this.setPending(ctx, { kind: "add_model", providerId: id });
            return {
              text: [
                tr(lang, "panel.add.title"),
                "",
                tr(lang, "panel.add.instructions"),
                "",
                tr(lang, "panel.models.add_id_line"),
                tr(lang, "panel.add.label_line"),
                "",
                tr(lang, "panel.add.cancel_hint"),
              ].join("\n"),
              keyboard: formCancelKeyboard(lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_model_toggle": {
        const id = action.modelId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.model_toggle", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const model = this.models.get(id);
            if (!model) return undefined;
            // Report the refusal verbatim rather than a stale "done" message.
            const res = this.models.setEnabled(id, !model.enabled);
            if (!res.ok) return { providerId: model.providerId, text: res.message };
            return {
              providerId: model.providerId,
              text: model.enabled
                ? tr(lang, "panel.models.toggled_off")
                : tr(lang, "panel.models.toggled_on"),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.showModels(ctx, r.data.providerId, r.data.text, lang);
        return;
      }

      case "ai_model_delete": {
        const id = action.modelId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.model_delete.confirm", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const model = this.models.get(id);
            if (!model) return undefined;
            // First tap only asks; the second tap (ai_model_delete_confirm)
            // destroys.
            return {
              providerId: model.providerId,
              text: confirmDeleteModelText(model.label, lang),
              keyboard: confirmDeleteModelKeyboard(id, model.providerId, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_model_delete_confirm": {
        const id = action.modelId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.model_delete", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const model = this.models.get(id);
            if (!model) return undefined;
            const res = this.models.remove(id);
            if (!res.ok) return { providerId: model.providerId, text: res.message };
            return { providerId: model.providerId, text: tr(lang, "panel.models.deleted") };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.showModels(ctx, r.data.providerId, r.data.text, lang);
        return;
      }

      case "ai_model_default": {
        const id = action.modelId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.model_default", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const model = this.models.get(id);
            if (!model) return undefined;
            // Activating a model of a disabled provider would point the
            // runtime at a provider that can never answer; refuse it here
            // instead of leaving a dead selection behind.
            const provider = this.storage.getProvider(model.providerId);
            if (!provider || !provider.enabled) {
              return {
                providerId: model.providerId,
                text: atr(lang, "audit.models.provider_disabled"),
              };
            }
            const res = this.models.setDefault(id);
            if (!res.ok) return { providerId: model.providerId, text: res.message };
            // Selecting the default also activates this provider+model, so a
            // single click both sets the default and makes it live.
            this.storage.setRuntimeSelection({ providerId: model.providerId, modelId: id });
            return { providerId: model.providerId, text: tr(lang, "panel.models.made_default") };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.showModels(ctx, r.data.providerId, r.data.text, lang);
        return;
      }

      case "ai_select_menu": {
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.select.menu", permission: PERM_VIEW },
          () => this.selectView(lang),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_select_provider": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.select.provider", permission: PERM_VIEW, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            const models = this.models.enabledModels(id);
            const settings = this.storage.getRuntimeSettings();
            if (models.length === 0) {
              // A provider with no enabled models is still listed (marked) on
              // the picker; say plainly what to do instead of showing an empty
              // picker with only a back button.
              return {
                text: atr(lang, "audit.select.no_models"),
                keyboard: new InlineKeyboard().text(
                  tr(lang, "panel.back"),
                  encode({ kind: "ai_select_menu" }),
                ),
              };
            }
            return {
              text: tr(lang, "panel.select.pick_model", { label: view.label }),
              keyboard: modelPickerKeyboard(models, settings.activeModelId, lang),
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "ai_select_model": {
        const id = action.modelId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.select.model", permission: PERM_MANAGE, targetId: String(id) },
          async () => {
            const model = this.models.get(id);
            if (!model || !model.enabled) return undefined;
            const provider = this.storage.getProvider(model.providerId);
            if (!provider || !provider.enabled) return undefined;
            this.storage.setRuntimeSelection({ providerId: model.providerId, modelId: id });
            // Probe on select: warn inline when the fresh selection doesn't
            // answer, so the owner discovers a dead provider here — not by
            // chatting into the void. A failed probe never blocks the selection.
            let probeNote = "";
            try {
              const probe = await this.health.probe(model.providerId);
              probeNote = probe.ok
                ? `\n${tr(lang, "panel.provider.test_ok")}`
                : `\n${tr(lang, "panel.provider.test_fail")}${
                    probe.message !== undefined ? ` (${probe.message})` : ""
                  }`;
            } catch {
              probeNote = `\n${tr(lang, "panel.provider.test_fail")}`;
            }
            return { text: tr(lang, "panel.select.done", { label: model.label }) + probeNote };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        // Back to the selection screen the model was picked from.
        const view = this.selectView(lang);
        await this.render(ctx, `${r.data.text}\n\n${view.text}`, view.keyboard);
        return;
      }
    }
  }

  /**
   * Probe a provider, inside an authorized run.
   *
   * The probe is the second authorized run for the same operation, so the
   * outcome is audited even though the progress message already went out.
   */
  private async runAuthorizedProbe(
    ctx: Context,
    providerId: number,
    lang: PanelLang,
  ): Promise<{ text: string }> {
    const actor = this.actorFor(ctx);
    const r = await this.admin.runAdmin(
      {
        actor,
        operation: "ai.test.run",
        permission: PERM_MANAGE,
        targetId: String(providerId),
      },
      async () => {
        // A stale button can name a provider that no longer exists; the
        // health service records against the provider row, so check first
        // instead of letting the probe throw on a missing row.
        if (!this.storage.getProvider(providerId)) {
          return {
            text: `${tr(lang, "panel.provider.test_fail")} (${tr(lang, "panel.discover.no_provider")})`,
          };
        }
        const probe = await this.health.probe(providerId);
        const msg = probe.ok
          ? tr(lang, "panel.provider.test_ok")
          : `${tr(lang, "panel.provider.test_fail")}${probe.message !== undefined ? ` (${probe.message})` : ""}`;
        return { text: msg };
      },
    );
    if (!r.ok) return { text: tr(lang, "panel.provider.test_fail") };
    return r.data;
  }

  /**
   * Probe every provider in sequence, inside one authorized run.
   *
   * The old «تست همهٔ پروایدرها» button only re-rendered the status view — the
   * label promised a probe, so now it performs one. Each probe records its
   * outcome (the same store the status view reads), so the result below is
   * also visible on the status screen afterwards.
   */
  private async runAuthorizedProbeAll(ctx: Context, lang: PanelLang): Promise<string> {
    const actor = this.actorFor(ctx);
    const r = await this.admin.runAdmin(
      {
        actor,
        operation: "ai.probe_all.run",
        permission: PERM_MANAGE,
      },
      async () => {
        const providers = this.providers.listViews();
        if (providers.length === 0) return tr(lang, "panel.aistatus.probe_empty");
        const lines = [tr(lang, "panel.aistatus.probe_done"), ""];
        for (const p of providers) {
          const probe = await this.health.probe(p.id);
          const verdict = probe.ok
            ? tr(lang, "panel.aistatus.test_ok")
            : tr(lang, "panel.aistatus.test_fail");
          // The message is chosen by the health module, never copied from a
          // provider response, so it cannot leak key material.
          const detail =
            !probe.ok && probe.message !== undefined ? ` (${probe.message})` : "";
          lines.push(`• ${p.label}: ${verdict}${detail}`);
        }
        return lines.join("\n");
      },
    );
    if (!r.ok) return tr(lang, "panel.provider.test_fail");
    return r.data;
  }

  /** Discover a provider's models, inside an authorized run. */
  private async runAuthorizedDiscovery(
    ctx: Context,
    providerId: number,
    lang: PanelLang,
  ): Promise<{ ok: boolean; text: string }> {
    const actor = this.actorFor(ctx);
    const r = await this.admin.runAdmin(
      {
        actor,
        operation: "ai.discover.run",
        permission: PERM_MANAGE,
        targetId: String(providerId),
      },
      async () => {
        const discovered = await this.discover(providerId, lang);
        if (!discovered.ok) {
          return {
            ok: false as const,
            text: `${tr(lang, "panel.provider.discover_fail")}${discovered.message !== undefined ? ` (${discovered.message})` : ""}`,
          };
        }
        // Discovered models are imported into the model list — never
        // auto-enabled or made default: the owner picks them from the model
        // list. Before this, the fetch succeeded and the list was silently
        // dropped, so "discover" found models the owner could never use.
        const imported = this.importDiscoveredModels(providerId, discovered.models);
        // The one exception to "never made default": a REPAIR, not a
        // pick. For Gemini, discovery is the authoritative chat-model
        // list, so a stored default it no longer returns (the non-chat
        // `aqa` a bulk import once landed on) moves to the first
        // discovered chat model — same repair as the mini app's
        // discovery. A still-discoverable default is never touched.
        const provider = this.storage.getProvider(providerId);
        if (provider?.adapter === "gemini") {
          this.models.resetDefaultToFirstOf(
            providerId,
            discovered.models.map((m) => m.id),
          );
        }
        return { ok: true as const, text: this.importReport(imported, lang) };
      },
    );
    if (!r.ok) return { ok: false, text: tr(lang, "panel.provider.discover_fail") };
    return r.data;
  }

  /**
   * Import freshly discovered models into the provider's model list.
   *
   * Duplicates (same model id already listed) are skipped, not re-added.
   * The import is capped so one chatty service cannot flood the panel with
   * hundreds of buttons.
   */
  private importDiscoveredModels(
    providerId: number,
    remote: readonly RemoteModel[],
  ): { added: number; existing: number; capped: boolean; total: number } {
    const CAP = 50;
    const present = new Set(this.models.list(providerId).map((m) => m.modelId));
    let added = 0;
    let existing = 0;
    for (const r of remote.slice(0, CAP)) {
      if (present.has(r.id)) {
        existing++;
        continue;
      }
      const res = this.models.add({
        providerId,
        modelId: r.id,
        label: r.label?.trim() ? r.label!.trim() : r.id,
      });
      if (!res.ok) {
        existing++;
        continue;
      }
      // Never auto-enabled or default: the owner enables them explicitly.
      this.models.setEnabled(res.data, false);
      present.add(r.id);
      added++;
    }
    return { added, existing, capped: remote.length > CAP, total: remote.length };
  }

  /** The user-facing report for a discovery import. */
  private importReport(
    imported: { added: number; existing: number; capped: boolean; total: number },
    lang: PanelLang,
  ): string {
    // When the cap truncated the import, the report must say so as
    // "first 50 of N" (audit M7) — including when nothing in the first
    // 50 was new, where the old code returned the plain "none new"
    // text and dropped the truncation note entirely.
    const cappedSuffix = imported.capped
      ? atr(lang, "audit.discover.capped", {
          n: formatNum(50, lang),
          total: formatNum(imported.total, lang),
        })
      : "";
    if (imported.added === 0) return atr(lang, "audit.discover.none_new") + cappedSuffix;
    const text = atr(lang, "audit.discover.imported", {
      added: formatNum(imported.added, lang),
      existing:
        imported.existing > 0
          ? atr(lang, "audit.discover.existing_suffix", {
              n: formatNum(imported.existing, lang),
            })
          : "",
    });
    return text + cappedSuffix;
  }

  /** The active provider + its models, for the quick-switch screen. */
  private selectView(lang: PanelLang): { text: string; keyboard: InlineKeyboard } {
    const settings = this.storage.getRuntimeSettings();
    const provider =
      settings.activeProviderId !== null ? this.providers.view(settings.activeProviderId) : undefined;
    const models = provider ? this.models.enabledModels(provider.id) : [];
    return {
      text: selectMenuText(
        models,
        provider?.label ?? tr(lang, "panel.select.unset"),
        settings.activeModelId,
        lang,
      ),
      keyboard: providerPickerKeyboard(this.providers.listViews(), lang),
    };
  }

  /** Re-render a provider's model list after a model action. */
  private async showModels(
    ctx: Context,
    providerId: number,
    lead: string,
    lang: PanelLang,
  ): Promise<void> {
    const view = this.providers.view(providerId);
    if (!view) {
      await this.render(ctx, lead, backKeyboard(lang));
      return;
    }
    const models = this.models.list(providerId);
    await this.render(
      ctx,
      `${lead}\n\n${modelsText(models, view.label, lang)}`,
      modelsKeyboard(models, providerId, lang),
    );
  }

  /** Re-render a provider's screen after an action, with a result lead. */
  private async showProvider(
    ctx: Context,
    providerId: number,
    lead: string,
    lang: PanelLang,
  ): Promise<void> {
    const view = this.providers.view(providerId);
    if (!view) {
      await this.render(ctx, lead, providersKeyboard(lang));
      return;
    }
    await this.render(
      ctx,
      `${lead}\n\n${providerText(view, lang)}`,
      providerKeyboard(view, lang),
    );
  }

  /**
   * The screen a form-cancel returns to, based on the flow being cancelled.
   * Cancelling never writes: it only clears the pending state.
   */
  private cancelView(
    flow: PendingInput | undefined,
    lang: PanelLang,
  ): { text: string; keyboard: unknown } {
    switch (flow?.kind) {
      case "add_provider":
      case "setup_preset":
        return { text: tr(lang, "panel.add.pick_type"), keyboard: adapterKeyboard(lang) };
      case "edit_provider":
      case "add_pool_key": {
        const view =
          flow.providerId !== undefined ? this.providers.view(flow.providerId) : undefined;
        if (!view) {
          return {
            text: providersText(this.providers.listViews(), lang),
            keyboard: providersKeyboard(lang),
          };
        }
        return { text: providerText(view, lang), keyboard: providerKeyboard(view, lang) };
      }
      case "add_model": {
        const view =
          flow.providerId !== undefined ? this.providers.view(flow.providerId) : undefined;
        if (!view) {
          return {
            text: providersText(this.providers.listViews(), lang),
            keyboard: providersKeyboard(lang),
          };
        }
        const models = this.models.list(flow.providerId!);
        return {
          text: modelsText(models, view.label, lang),
          keyboard: modelsKeyboard(models, flow.providerId!, lang),
        };
      }
      case "search_key":
        return this.searchView(lang);
      default:
        return {
          text: aiMenuText(lang, this.activePairForPanel()),
          keyboard: aiMenuKeyboard(lang),
        };
    }
  }

  /**
   * Fetch models from a service, without touching the panel's model store.
   * The list is returned for the owner to act on; nothing is auto-activated.
   */
  private async discover(
    providerId: number,
    lang: PanelLang,
  ): Promise<{ ok: true; models: readonly RemoteModel[] } | { ok: false; message?: string }> {
    const provider = this.storage.getProvider(providerId);
    if (!provider) return { ok: false, message: tr(lang, "panel.discover.no_provider") };
    // A row saved before the guard existed can still hold a known-broken
    // type ↔ URL pair: name the fix instead of a doomed request's
    // generic failure.
    const urlIssue = checkProviderUrl(provider.adapter, provider.baseUrl);
    if (urlIssue !== null) {
      return { ok: false, message: urlGuardRefusalText(urlIssue) };
    }
    if (!this.adapters.describes(provider.adapter).listModels) {
      return { ok: false, message: tr(lang, "panel.discover.no_list") };
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.providers.credentialFor(providerId);
    } catch {
      return { ok: false, message: tr(lang, "panel.discover.no_cred") };
    }
    if (apiKey === undefined || apiKey.length === 0) {
      return { ok: false, message: tr(lang, "panel.discover.cred_unset") };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const adapter = this.adapters.create(provider.adapter, {
        baseUrl: provider.baseUrl,
        apiKey,
        model: "discover",
        // The owner may have granted this provider the local-target
        // exception; discovery must honor the same boundary as the runtime.
        ...(provider.allowLocal ? { allowLocalTargets: true } : {}),
      });
      if (!adapter.listModels) {
        return { ok: false, message: tr(lang, "panel.discover.unsupported") };
      }
      const models = await adapter.listModels({
        target: { baseUrl: provider.baseUrl, apiKey },
        timeoutMs: 15_000,
        signal: controller.signal,
      });
      return { ok: true, models };
    } catch {
      // A failure here never records a partial list or changes any state.
      return { ok: false, message: tr(lang, "panel.discover.failed") };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Remember that this owner is mid-way through a free-text flow. */
  private setPending(ctx: Context, input: PendingInput): void {
    const id = ctx.from?.id;
    if (id === undefined) return;
    this.pending.set(id, input);
  }

  /**
   * The failover view: settings plus an ordered, resolved candidate list.
   *
   * A candidate whose provider or model is disabled is still listed but marked,
   * so the owner can see why it would never be used.
   */
  private failoverView(lang: PanelLang): { text: string; keyboard: unknown } {
    const s = this.storage.getFailoverSettings();
    const settings = this.storage.getRuntimeSettings();
    const primary =
      settings.activeProviderId !== null ? this.providers.view(settings.activeProviderId) : undefined;
    const primaryModel = settings.activeModelId !== null ? this.models.get(settings.activeModelId) : undefined;

    const rows = this.storage.listFailoverCandidates().map((c, i) => {
      const p = this.providers.view(c.providerId);
      const m = this.models.get(c.modelId);
      return {
        index: i,
        providerLabel: p?.label ?? tr(lang, "panel.deleted_ref", { id: c.providerId }),
        modelLabel: m?.label ?? tr(lang, "panel.deleted_ref", { id: c.modelId }),
        enabled: p?.enabled === true && m?.enabled === true,
      };
    });

    return {
      text: failoverText(
        {
          enabled: s.enabled,
          maxAttempts: s.maxAttempts,
          timeoutMs: s.timeoutMs,
          primaryLabel: primary?.label,
          primaryModelLabel: primaryModel?.label,
          rows,
        },
        lang,
      ),
      keyboard: failoverKeyboard(
        {
          enabled: s.enabled,
          maxAttempts: s.maxAttempts,
          timeoutMs: s.timeoutMs,
          primaryLabel: primary?.label,
          primaryModelLabel: primaryModel?.label,
          rows,
        },
        lang,
      ),
    };
  }

  /** Keyboard offering only enabled providers as failover candidates. */
  private foProviderKeyboard(providers: readonly ProviderView[], lang: PanelLang): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const p of providers) {
      kb.text(p.label, encode({ kind: "fo_add_pick_model", providerId: p.id })).row();
    }
    kb.text(tr(lang, "panel.back"), encode({ kind: "fo_menu" }));
    return kb;
  }

  /** Keyboard offering only enabled models of one provider. */
  private foModelKeyboard(
    providerId: number,
    models: readonly { id: number; label: string }[],
    lang: PanelLang,
  ): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const m of models) {
      kb.text(m.label, encode({ kind: "fo_add_confirm", providerId, modelId: m.id })).row();
    }
    kb.text(tr(lang, "panel.back"), encode({ kind: "fo_add_form" }));
    return kb;
  }

  /**
   * The operational status view.
   *
   * A health check is reported separately from a real conversation: this text
   * says "last test", never "working", because a probe is a liveness ping and
   * not evidence that a request would succeed.
   */
  private buildStatusText(lang: PanelLang): string {
    const s = this.storage.getFailoverSettings();
    const settings = this.storage.getRuntimeSettings();
    const providers = this.providers.listViews();
    const primary =
      settings.activeProviderId !== null ? providers.find((p) => p.id === settings.activeProviderId) : undefined;
    const primaryModel =
      settings.activeModelId !== null ? this.models.get(settings.activeModelId) : undefined;

    const candidates = this.storage.listFailoverCandidates();
    const activeCandidates = candidates.filter((c) => {
      const p = providers.find((x) => x.id === c.providerId);
      const m = this.models.get(c.modelId);
      return p?.enabled === true && m?.enabled === true;
    }).length;

    return statusText(
      {
        primaryProvider: primary?.label,
        primaryModel: primaryModel?.label,
        failoverEnabled: s.enabled,
        candidateCount: candidates.length,
        activeCandidateCount: activeCandidates,
        providers: providers.map((p) => ({
          label: p.label,
          enabled: p.enabled,
          hasCredential: p.hasCredential,
          allowLocal: p.allowLocal,
          ...(p.lastTestOk !== undefined ? { lastTestOk: p.lastTestOk } : {}),
          ...(p.lastTestAt !== undefined ? { lastTestAt: p.lastTestAt } : {}),
        })),
        // The runtime reads the database per request, so any mismatch means the
        // primary selection no longer resolves (e.g. it was disabled).
        runtimeMatchesPersisted: primary !== undefined,
        // The per-request provider timeout is the DB value the gateway reads;
        // the engine and agent timeouts are the resolved env values, when the
        // controller was constructed with them. Showing all three here is what
        // stops an env setting from silently disagreeing with the DB.
        providerTimeoutMs: s.timeoutMs,
        ...(this.engineTimeouts !== undefined
          ? {
              engineTimeoutMs: this.engineTimeouts.aiTimeoutMs,
              agentTotalTimeoutMs: this.engineTimeouts.agentTotalTimeoutMs,
            }
          : {}),
        note: undefined,
      },
      lang,
    );
  }

  /**
   * Interpret a free-text reply as a provider/model submission.
   * Returns true when the message was consumed by a pending flow.
   *
   * Junk input re-prompts the form instead of cancelling the flow: the pending
   * state is only cleared on success, on explicit لغو, or on an explicit
   * refusal from the service.
   */
  async handleText(ctx: Context, text: string): Promise<boolean> {
    const id = ctx.from?.id;
    if (id === undefined) return false;
    const flow = this.pending.get(id);
    if (!flow) return false;

    const actor = this.actorFor(ctx);
    const lang = this.langFor(ctx);
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (flow.kind === "setup_preset") {
      const preset = flow.presetId !== undefined ? providerPreset(flow.presetId) : undefined;
      if (!preset) {
        this.pending.delete(id);
        await ctx.reply(tr(lang, "panel.pool.unknown_service"));
        return true;
      }

      const needsExtra = preset.requiredPlaceholder !== undefined;
      const parsed = parseSetupReply(text, needsExtra);
      if (!parsed) {
        // Keep the pending state: the owner gets another try, not a dead flow.
        await this.render(
          ctx,
          `${tr(lang, "panel.setup.junk")}\n\n${
            needsExtra
              ? tr(lang, "panel.setup.key_extra", { ph: preset.requiredPlaceholder ?? "" })
              : tr(lang, "panel.setup.key_only")
          }`,
          formCancelKeyboard(lang),
        );
        return true;
      }
      // Consume the pending state only now that the input parsed.
      this.pending.delete(id);

      // The URL is completed here rather than asked for: the preset knows its
      // own shape, and the only unknown is the one value the owner just gave.
      const baseUrl =
        parsed.extra !== undefined && preset.requiredPlaceholder !== undefined
          ? preset.baseUrl.replace(`{${preset.requiredPlaceholder}}`, parsed.extra)
          : undefined;

      const r = await this.admin.runAdmin(
        { actor, operation: "ai.setup", permission: PERM_MANAGE, targetId: preset.id },
        () =>
          setupFromPreset(
            {
              storage: this.storage,
              providers: this.providers,
              models: this.models,
              secrets: this.secrets,
            },
            preset.id,
            parsed.apiKey,
            baseUrl,
          ),
      );
      if (!r.ok) {
        await this.deny(ctx);
        return true;
      }

      // The key is never echoed back; the confirmation names what was created.
      const result = r.data;
      const body = [result.message, ...result.notes.map((n) => `• ${n}`)].join("\n");
      const providers = await this.admin.runAdmin(
        { actor, operation: "ai.setup.refresh", permission: PERM_VIEW },
        () => ({
          text: providersText(this.providers.listViews(), lang),
          keyboard: providersKeyboard(lang),
        }),
      );
      await this.render(
        ctx,
        providers.ok ? `${body}\n\n${providers.data.text}` : body,
        providers.ok ? providers.data.keyboard : backKeyboard(lang),
      );
      return true;
    }

    if (flow.kind === "search_key") {
      if (!this.search) {
        this.pending.delete(id);
        await ctx.reply(tr(lang, "panel.search.unavailable"));
        return true;
      }

      const key = (lines[0] ?? "").trim();
      if (key.length === 0) {
        // Keep the pending state and ask again instead of dropping the flow.
        await this.render(
          ctx,
          `${tr(lang, "panel.search.key_junk")}\n\n${searchKeyFormText(lang)}`,
          formCancelKeyboard(lang),
        );
        return true;
      }
      this.pending.delete(id);

      const r = await this.admin.runAdmin(
        { actor, operation: "search.set_key", permission: PERM_MANAGE },
        () => this.search!.setKey(key),
      );
      if (!r.ok) {
        await this.deny(ctx);
        return true;
      }
      if (!r.data.ok) {
        await this.render(ctx, r.data.message, backToSearchKeyboard(lang));
        return true;
      }
      // Never echo the key; confirm only that it was stored.
      const v = this.searchView(lang);
      await this.render(
        ctx,
        `${searchKeySavedText(this.search.label(), lang)}\n\n${v.text}`,
        v.keyboard,
      );
      return true;
    }

    if (flow.kind === "add_provider") {
      const parsed = parseSubmission(lines);
      if (!parsed) {
        // Junk input re-prompts; the flow stays alive until لغو or success.
        await this.render(
          ctx,
          `${tr(lang, "panel.add.junk")}\n\n${addFormText(flow.adapter ?? "openai_compatible", lang)}`,
          formCancelKeyboard(lang),
        );
        return true;
      }
      this.pending.delete(id);

      // A preset supplies its endpoint, so the owner may leave the URL line out
      // of the form entirely. An explicitly typed URL still wins, which is how
      // the Cloudflare placeholder gets filled in. A bare adapter template
      // with a known endpoint (e.g. Gemini) behaves the same: the suggested
      // URL from the add form is the fallback, so the owner is not retyping a
      // URL they never chose. A template with no suggestion (9Router) still
      // requires the URL, and the service says so plainly.
      const preset = flow.presetId !== undefined ? providerPreset(flow.presetId) : undefined;
      const template =
        flow.presetId === undefined
          ? ADAPTER_TEMPLATES.find((t) => t.type === (flow.adapter ?? "openai_compatible"))
          : undefined;
      const baseUrl =
        parsed.baseUrl.trim().length > 0
          ? parsed.baseUrl
          : (preset?.baseUrl ?? template?.suggestedBaseUrl ?? "");

      // A placeholder that was never substituted would be sent verbatim and
      // fail with a confusing error, so it is refused here with a clear one.
      if (preset?.requiredPlaceholder !== undefined &&
          baseUrl.includes(`{${preset.requiredPlaceholder}}`)) {
        await this.render(
          ctx,
          tr(lang, "panel.add.bad_url", { ph: `{${preset.requiredPlaceholder}}` }),
          backKeyboard(lang),
        );
        return true;
      }

      // Type ↔ URL mismatch (e.g. the native Gemini address under the
      // OpenAI-compatible type) can never work — every request would 404.
      // Refuse the save with the guard's fix instead of storing a dead row.
      const urlIssue = checkProviderUrl(flow.adapter ?? "openai_compatible", baseUrl);
      if (urlIssue !== null) {
        await this.render(ctx, urlGuardRefusalText(urlIssue), backKeyboard(lang));
        return true;
      }

      const r = await this.admin.runAdmin(
        { actor, operation: "ai.add", permission: PERM_MANAGE },
        () => {
          const res = this.providers.create({
            label: parsed.label,
            adapter: flow.adapter ?? "openai_compatible",
            baseUrl,
            apiKey: parsed.apiKey,
          });
          // One shape for both outcomes so the caller never sees a partial type.
          if (!res.ok) return { ok: false as const, message: res.message };
          return { ok: true as const, providerId: res.data };
        },
      );
      if (!r.ok) {
        await this.deny(ctx);
        return true;
      }
      if (!r.data.ok) {
        await this.render(ctx, r.data.message, backKeyboard(lang));
        return true;
      }
      // Never echo the key back; confirm the fields that are not secrets.
      // Land on the new provider's own screen (not the providers list): it
      // carries the مدل‌ها and دریافت مدل‌ها buttons, which is exactly the
      // next step — a bare provider cannot answer without a model.
      const createdLead = [
        tr(lang, "panel.add.created"),
        "",
        tr(lang, "panel.add.created_name", { v: parsed.label }),
        tr(lang, "panel.add.created_url", { v: baseUrl }),
        tr(lang, "panel.add.created_key"),
        "",
        atr(lang, "audit.add.next_step_models"),
      ].join("\n");
      await this.showProvider(ctx, r.data.providerId, createdLead, lang);
      return true;
    }

    if (flow.kind === "add_pool_key") {
      const providerId = flow.providerId;
      if (providerId === undefined) {
        this.pending.delete(id);
        await this.stale(ctx);
        return true;
      }

      // The key is the whole message; take the first line only, like the
      // setup flow, so a pasted key is never truncated or split.
      const apiKey = (lines[0] ?? "").trim();
      if (apiKey.length === 0) {
        await this.render(
          ctx,
          `${tr(lang, "panel.pool.empty")}\n\n${tr(lang, "panel.pool.prompt1")}\n\n${tr(lang, "panel.pool.prompt2")}`,
          formCancelKeyboard(lang),
        );
        return true;
      }
      this.pending.delete(id);

      const r = await this.admin.runAdmin(
        {
          actor,
          operation: "ai.pool_key.add",
          permission: PERM_MANAGE,
          targetId: String(providerId),
        },
        () => {
          // backup-N: N follows the current pool size. Labels are display
          // text, not identifiers, so a gap left by a removal is harmless.
          const label = `backup-${this.providers.listPoolKeys(providerId).length + 1}`;
          const res = this.providers.addPoolKey(providerId, label, apiKey);
          // One shape for both outcomes so the caller never sees a partial type.
          if (!res.ok) return { ok: false as const, message: res.message };
          return { ok: true as const, label };
        },
      );
      if (!r.ok) {
        await this.deny(ctx);
        return true;
      }
      if (!r.data.ok) {
        await this.render(ctx, r.data.message, backKeyboard(lang));
        return true;
      }
      // Never echo the key; confirm the label it was stored under, then show
      // the provider screen again with the updated backup-key count.
      const body = tr(lang, "panel.pool.saved", { label: r.data.label });
      const view = await this.admin.runAdmin(
        {
          actor,
          operation: "ai.provider.view",
          permission: PERM_VIEW,
          targetId: String(providerId),
        },
        () => {
          const v = this.providers.view(providerId);
          if (!v) return undefined;
          return { text: providerText(v, lang), keyboard: providerKeyboard(v, lang) };
        },
      );
      await this.render(
        ctx,
        view.ok && view.data ? `${body}\n\n${view.data.text}` : body,
        view.ok && view.data ? view.data.keyboard : backKeyboard(lang),
      );
      return true;
    }

    if (flow.kind === "add_model") {
      const providerId = flow.providerId;
      if (providerId === undefined) {
        this.pending.delete(id);
        await this.stale(ctx);
        return true;
      }

      const parsed = parseModelSubmission(lines);
      if (!parsed) {
        await this.render(
          ctx,
          `${tr(lang, "panel.models.add_junk")}\n\n${tr(lang, "panel.models.add_id_line")}\n${tr(lang, "panel.add.label_line")}`,
          formCancelKeyboard(lang),
        );
        return true;
      }
      this.pending.delete(id);

      const r = await this.admin.runAdmin(
        { actor, operation: "ai.model_add", permission: PERM_MANAGE, targetId: String(providerId) },
        () => {
          const res = this.models.add({
            providerId,
            modelId: parsed.modelId,
            label: parsed.label,
          });
          if (!res.ok) return { ok: false as const, message: res.message };
          return { ok: true as const };
        },
      );
      if (!r.ok) {
        await this.deny(ctx);
        return true;
      }
      if (!r.data.ok) {
        await this.render(ctx, r.data.message, backKeyboard(lang));
        return true;
      }
      await this.showModels(
        ctx,
        providerId,
        tr(lang, "panel.models.added", { label: parsed.label }),
        lang,
      );
      return true;
    }

    if (flow.kind === "edit_provider") {
      const providerId = flow.providerId;
      if (providerId === undefined) {
        this.pending.delete(id);
        await this.stale(ctx);
        return true;
      }

      const parsed = parseEditSubmission(lines);
      if (Object.keys(parsed).length === 0) {
        // Junk input re-prompts; an empty patch would otherwise "succeed"
        // while changing nothing.
        const view = this.providers.view(providerId);
        await this.render(
          ctx,
          view
            ? `${tr(lang, "panel.edit.junk")}\n\n${editFormText(view, lang)}`
            : tr(lang, "panel.edit.junk"),
          formCancelKeyboard(lang),
        );
        return true;
      }
      this.pending.delete(id);

      // Same type ↔ URL guard as the create path, applied to the EFFECTIVE
      // combination (a patch may change only the type or only the URL).
      // Label/key-only edits skip it — a pre-existing mismatch is not made
      // worse by renaming, and the owner must stay able to fix fields one
      // at a time.
      if (parsed.adapter !== undefined || parsed.baseUrl !== undefined) {
        const current = this.providers.view(providerId);
        if (current !== undefined) {
          const urlIssue = checkProviderUrl(
            parsed.adapter ?? current.adapter,
            parsed.baseUrl ?? current.baseUrl,
          );
          if (urlIssue !== null) {
            await this.render(ctx, urlGuardRefusalText(urlIssue), backKeyboard(lang));
            return true;
          }
        }
      }

      const r = await this.admin.runAdmin(
        {
          actor,
          operation: "ai.edit",
          permission: PERM_MANAGE,
          targetId: String(providerId),
        },
        () => {
          const res = this.providers.update(providerId, parsed);
          if (!res.ok) return { ok: false as const, message: res.message };
          return { ok: true as const };
        },
      );
      if (!r.ok) {
        await this.deny(ctx);
        return true;
      }
      if (!r.data.ok) {
        // The service refused, e.g. repointing the active provider's endpoint.
        await this.render(ctx, r.data.message, backKeyboard(lang));
        return true;
      }

      // Re-read from the store: the confirmation must reflect what persisted.
      // Land on the provider's own screen, like every other provider action.
      const view = this.providers.view(providerId);
      if (!view) {
        await this.stale(ctx);
        return true;
      }
      await this.showProvider(
        ctx,
        providerId,
        [
          tr(lang, "panel.edit.updated"),
          "",
          tr(lang, "panel.add.created_name", { v: view.label }),
          tr(lang, "panel.edit.done_adapter", { v: view.adapterLabel }),
          tr(lang, "panel.add.created_url", { v: view.baseUrl }),
          tr(lang, "panel.provider.key", {
            v: view.hasCredential
              ? tr(lang, "panel.providers.key_set")
              : tr(lang, "panel.providers.key_unset"),
          }),
        ].join("\n"),
        lang,
      );
      return true;
    }

    this.pending.delete(id);
    await ctx.reply(tr(lang, "panel.ai.op_unsupported"));
    return true;
  }

  /** Generic denial. */
  private async deny(ctx: Context): Promise<void> {
    await safeAnswer(ctx);
    await safeSend(ctx, PANEL_DENIED);
  }

  /** Stale or deleted target. */
  private async stale(ctx: Context): Promise<void> {
    await safeAnswer(ctx);
    await safeSend(ctx, PANEL_STALE);
  }

  /**
   * Render a panel view.
   *
   * Button clicks edit the panel message in place; anything else (a /ai
   * command, a free-text form reply) arrives as a new message and is answered
   * with a new message.
   */
  private async render(ctx: Context, text: string, keyboard: unknown): Promise<void> {
    await safeAnswer(ctx);
    await safeEditOrSend(ctx, text, keyboard);
  }
}

/**
 * The add-provider form's expected lines.
 *
 * `baseUrl` may be EMPTY when the flow came from a preset, because the preset
 * already supplies one — the owner only has to fill in what is genuinely
 * theirs. It is returned as an empty string rather than undefined so the caller
 * can tell "left blank on purpose" from "the field was missing".
 */
function parseSubmission(
  lines: readonly string[],
): { label: string; baseUrl: string; apiKey: string } | undefined {
  // Accept either "key: value" lines or bare values in a fixed order.
  const byKey = new Map<string, string>();
  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep > 0) {
      byKey.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim());
    }
  }

  const label = byKey.get("نام نمایشی") ?? byKey.get("label") ?? lines[0];
  // A labelled but empty URL line is honoured as "empty", not treated as absent.
  const baseUrl = byKey.has("آدرس سرویس")
    ? (byKey.get("آدرس سرویس") ?? "")
    : byKey.has("base url")
      ? (byKey.get("base url") ?? "")
      : (lines[1] ?? "");
  const apiKey = byKey.get("کلید api") ?? byKey.get("api key") ?? lines[2];

  if (label === undefined || apiKey === undefined) return undefined;
  if (label.length === 0 || apiKey.length === 0) return undefined;
  return { label, baseUrl, apiKey };
}

/**
 * The add-model form's expected lines: model id, then display label.
 * Accepts either "key: value" lines or bare values in a fixed order.
 */
function parseModelSubmission(
  lines: readonly string[],
): { modelId: string; label: string } | undefined {
  const byKey = new Map<string, string>();
  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep > 0) {
      byKey.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim());
    }
  }

  const modelId = byKey.get("شناسهٔ مدل") ?? byKey.get("model id") ?? lines[0];
  const label = byKey.get("نام نمایشی") ?? byKey.get("label") ?? lines[1];

  if (modelId === undefined || label === undefined) return undefined;
  if (modelId.length === 0 || label.length === 0) return undefined;
  return { modelId, label };
}

/**
 * The panel text for a type ↔ URL guard refusal: the guard's own message
 * (short, English, names the fix), plus the corrected address when the
 * guard could name one unambiguously.
 */
function urlGuardRefusalText(issue: ProviderUrlGuardIssue): string {
  return issue.suggestion !== undefined
    ? `${issue.message}\n\nSuggested address: ${issue.suggestion}`
    : issue.message;
}

/**
 * An edit submission: every field is optional, so only the keys present are
 * changed. An empty line means "leave unchanged", never "clear the field".
 */
function parseEditSubmission(lines: readonly string[]): {
  label?: string;
  baseUrl?: string;
  adapter?: string;
  apiKey?: string;
} {
  const byKey = new Map<string, string>();
  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    byKey.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim());
  }

  const patch: {
    label?: string;
    baseUrl?: string;
    adapter?: string;
    apiKey?: string;
  } = {};

  const label = byKey.get("نام نمایشی") ?? byKey.get("label");
  if (label !== undefined && label.length > 0) patch.label = label;

  const baseUrl = byKey.get("آدرس سرویس") ?? byKey.get("base url");
  if (baseUrl !== undefined && baseUrl.length > 0) patch.baseUrl = baseUrl;

  const adapter = byKey.get("نوع اتصال") ?? byKey.get("adapter");
  if (adapter !== undefined && adapter.length > 0) patch.adapter = adapter;

  // An empty key line means "keep the current key", not "store an empty key".
  const apiKey = byKey.get("کلید api") ?? byKey.get("api key");
  if (apiKey !== undefined && apiKey.length > 0) patch.apiKey = apiKey;

  return patch;
}

/** The edit form: shows the current values, and only asks for changes. */
function editFormText(view: ProviderView, lang: PanelLang): string {
  return [
    tr(lang, "panel.edit.title"),
    "",
    tr(lang, "panel.edit.instructions"),
    "",
    tr(lang, "panel.edit.label_line", { v: view.label }),
    // The edit parser expects the adapter SLUG, so the form must show it: the
    // Persian label alone left the owner guessing what to type.
    tr(lang, "panel.edit.adapter_line", { v: `${view.adapterLabel} (${view.adapter})` }),
    atr(lang, "audit.edit.adapter_hint"),
    tr(lang, "panel.edit.url_line", { v: view.baseUrl }),
    tr(lang, "panel.edit.key_line", {
      v: view.hasCredential
        ? tr(lang, "panel.providers.key_set")
        : tr(lang, "panel.providers.key_unset"),
    }),
    "",
    tr(lang, "panel.edit.key_hint"),
    tr(lang, "panel.add.cancel_hint"),
  ].join("\n");
}

async function safeAnswer(ctx: Context): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
  } catch {
    // An expired button must not surface an error.
  }
}

async function safeSend(ctx: Context, text: string, keyboard?: unknown): Promise<void> {
  try {
    if (keyboard === undefined) {
      await ctx.reply(text);
      return;
    }
    await ctx.reply(text, { reply_markup: keyboard as never });
  } catch {
    console.error("[sol] ai panel: telegram send failed");
  }
}

/**
 * Edit the panel message in place when this render answers a button click;
 * otherwise send a new message.
 *
 * A failed edit (stale, deleted, or unchanged message) is swallowed without
 * falling back to a reply: stacking a new message would undo the whole point.
 */
async function safeEditOrSend(ctx: Context, text: string, keyboard?: unknown): Promise<void> {
  const qc = ctx as unknown as {
    callbackQuery?: unknown;
    editMessageText?: (text: string, other?: { reply_markup?: unknown }) => Promise<unknown>;
  };
  if (qc.callbackQuery !== undefined && typeof qc.editMessageText === "function") {
    try {
      await qc.editMessageText.call(
        ctx,
        text,
        keyboard !== undefined ? { reply_markup: keyboard } : undefined,
      );
      return;
    } catch {
      // Stale, deleted, or byte-identical message: leave it alone.
    }
    return;
  }
  await safeSend(ctx, text, keyboard);
}

/**
 * The actions this controller owns: the AI section, the failover section, the
 * operational status view, and web-search settings. Group-panel and user-access
 * actions are excluded, so their controllers still receive their own callbacks.
 */
type AiPanelAction = Extract<
  PanelAction,
  { kind: `ai_${string}` | `fo_${string}` | `search_${string}` }
>;

/** Every AI action kind, used to decide whether a callback is ours. */
const AI_ACTION_KINDS: ReadonlySet<string> = new Set([
  "ai_menu",
  "ai_providers",
  "ai_provider",
  "ai_add_form",
  "ai_add_adapter",
  "ai_add_preset",
  "ai_edit",
  "ai_toggle",
  "ai_test",
  "ai_discover",
  "ai_clear_key",
  "ai_clear_key_confirm",
  "ai_pool_key",
  "ai_delete",
  "ai_delete_confirm",
  "ai_models",
  "ai_model_add_form",
  "ai_model_toggle",
  "ai_model_delete",
  "ai_model_delete_confirm",
  "ai_model_default",
  "ai_select_menu",
  "ai_select_provider",
  "ai_select_model",
  "ai_form_cancel",
  // ---- failover administration ----
  "fo_menu",
  "fo_toggle",
  "fo_attempts",
  "fo_attempts_set",
  "fo_timeout",
  "fo_timeout_set",
  "fo_add_form",
  "fo_add_pick_provider",
  "fo_add_pick_model",
  "fo_add_confirm",
  "fo_remove",
  "fo_move_up",
  "fo_move_down",
  "fo_local_menu",
  "fo_local_confirm",
  // ---- AI operational status ----
  "ai_status",
  "ai_probe_all",
  // ---- web-search settings ----
  "search_menu",
  "search_pick",
  "search_set_key_form",
  "search_clear_key",
  "search_clear_key_confirm",
]);
