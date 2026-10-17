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
 */
import { Context, InlineKeyboard } from "grammy";
import type { AdminBoundary } from "../auth/admin_boundary";
import type { AuthorizationService } from "../auth/service";
import type { Permission } from "../auth/roles";
import type { ProviderHealthService } from "../ai/health";
import type { ProviderSecretStore } from "../ai/secret_store";
import type { AdapterRegistry } from "../ai/adapter_registry";
import { ModelService, ProviderService, type ProviderView } from "../ai/provider_service";
import type { RemoteModel } from "../ai/adapter";
import { ADAPTER_TEMPLATES } from "../ai/adapter";
import { isAdapterType } from "../ai/adapter";
import type { Storage } from "../storage/storage";
import { decode, encode, type PanelAction } from "./callbacks";
import { PANEL_DENIED, PANEL_STALE, backKeyboard } from "./panel";
import {
  adapterKeyboard,
  addFormText,
  aiMenuKeyboard,
  aiMenuText,
  attemptsKeyboard,
  attemptsText,
  failoverKeyboard,
  failoverText,
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
  timeoutKeyboard,
  timeoutText,
} from "./ai_panel";
import type { SearchSettingsService } from "../search/service";
import {
  backToSearchKeyboard,
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
  kind: "add_provider" | "edit_provider" | "search_key";
  providerId?: number;
  /** When set, the add flow preselects this adapter. */
  adapter?: string;
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
  }

  /** Actor from a trusted context; undefined when identity is absent. */
  private actorFor(ctx: Context) {
    const from = ctx.from;
    if (!from) return undefined;
    return this.auth.actorFromTelegramUser(from);
  }

  /** The search settings view, or a placeholder when search is not wired. */
  private searchView(): { text: string; keyboard: unknown } {
    if (!this.search) {
      return { text: "بخش جستجو در دسترس نیست.", keyboard: backKeyboard() };
    }
    const v = this.search.view();
    return { text: searchMenuText(v), keyboard: searchMenuKeyboard(v.provider, v.hasKey) };
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
    const r = await this.admin.runAdmin(
      { actor, operation: "ai.menu", permission: PERM_VIEW },
      () => ({ text: aiMenuText(), keyboard: aiMenuKeyboard() }),
    );
    if (!r.ok) return void (await this.deny(ctx));
    await this.render(ctx, r.data.text, r.data.keyboard);
  }

  private async dispatch(ctx: Context, action: AiPanelAction): Promise<void> {
    const actor = this.actorFor(ctx);

    switch (action.kind) {
      case "ai_menu":
        await this.open(ctx);
        return;

      // ---- web-search settings ----
      case "search_menu": {
        if (!this.search) return void (await this.deny(ctx));
        const r = await this.admin.runAdmin(
          { actor, operation: "search.menu", permission: PERM_VIEW },
          () => this.searchView(),
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
        const v = this.searchView();
        await this.render(
          ctx,
          r.data.ok ? v.text : "انتخاب سرویس ناموفق بود.",
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
              return { text: searchNoKeyNeededText(this.search!.label()), ok: false as const };
            }
            this.setPending(ctx, { kind: "search_key" });
            return { text: searchKeyFormText(), ok: true as const };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, backToSearchKeyboard());
        return;
      }

      case "search_clear_key": {
        if (!this.search) return void (await this.deny(ctx));
        const r = await this.admin.runAdmin(
          { actor, operation: "search.clear_key", permission: PERM_MANAGE },
          () => ({ cleared: this.search!.clearKey(), label: this.search!.label() }),
        );
        if (!r.ok) return void (await this.deny(ctx));
        const v = this.searchView();
        await this.render(
          ctx,
          `${searchKeyClearedText(r.data.label)}\n\n${v.text}`,
          v.keyboard,
        );
        return;
      }

      // ---- operational status ----
      case "ai_status": {
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.status", permission: PERM_VIEW },
          () => ({ text: this.buildStatusText(), keyboard: backKeyboard() }),
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      // ---- failover administration ----
      case "fo_menu": {
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.menu", permission: PERM_VIEW },
          () => this.failoverView(),
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
                  message: "اول یک جایگزین اضافه کنید، سپس جایگزین مطالبه‌ای را فعال کنید.",
                };
              }
            }
            this.storage.setFailoverSettings({ enabled: next });
            return { ok: true as const, message: next ? "جایگزین مطالبه‌ای فعال شد." : "جایگزین مطالبه‌ای غیرفعال شد." };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(),
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
            return { text: attemptsText(s.maxAttempts), keyboard: attemptsKeyboard(s.maxAttempts) };
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
            return { text: `حداکثر تلاش ${s.maxAttempts} شد.`, keyboard: backKeyboard() };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "fo_timeout": {
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.timeout.view", permission: PERM_VIEW },
          () => {
            const s = this.storage.getFailoverSettings();
            return { text: timeoutText(s.timeoutMs), keyboard: timeoutKeyboard(s.timeoutMs) };
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
            return { text: `زمان هر تلاش ${s.timeoutMs} میلی‌ثانیه شد.`, keyboard: backKeyboard() };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        await this.render(ctx, r.data.text, r.data.keyboard);
        return;
      }

      case "fo_add_form": {
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.add.form", permission: PERM_MANAGE },
          () => {
            // Only enabled providers are offered; a disabled one would be a
            // candidate that silently never runs.
            const pickable = this.providers.listViews().filter((p) => p.enabled);
            if (pickable.length === 0) {
              return { text: "پروایدر فعالی برای افزودن وجود ندارد.", keyboard: backKeyboard() };
            }
            return { text: "پروایدر جایگزین را انتخاب کنید:", keyboard: this.foProviderKeyboard(pickable) };
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
              return { text: "این پروایدر مدل فعالی ندارد.", keyboard: backKeyboard() };
            }
            return { text: "مدل جایگزین را انتخاب کنید:", keyboard: this.foModelKeyboard(providerId, models) };
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
            if (!view || !view.enabled) return { refused: "پروایدر در دسترس نیست." };
            if (!model || !model.enabled || model.providerId !== providerId) {
              return { refused: "مدل در دسترس نیست." };
            }
            const current = this.storage.listFailoverCandidates();
            // A duplicate candidate would double the effective attempt count.
            if (current.some((c) => c.providerId === providerId && c.modelId === modelId)) {
              return { refused: "این جایگزین از قبل در فهرست هست." };
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
          await this.render(ctx, r.data.refused, backKeyboard());
          return;
        }
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `جایگزین اضافه شد.\n\n${view.data.text}`, view.data.keyboard);
        return;
      }

      case "fo_remove": {
        const index = action.index;
        const r = await this.admin.runAdmin(
          { actor, operation: "fo.remove", permission: PERM_MANAGE, targetId: String(index) },
          () => {
            const current = this.storage.listFailoverCandidates();
            // A stale index from an older render must not remove the wrong row.
            if (index < 0 || index >= current.length) return { refused: "این جایگزین دیگر در فهرست نیست." };
            this.storage.setFailoverCandidates(current.filter((_, i) => i !== index));
            return { ok: true as const };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if ("refused" in r.data) {
          await this.render(ctx, r.data.refused, backKeyboard());
          return;
        }
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `جایگزین حذف شد.\n\n${view.data.text}`, view.data.keyboard);
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
              text: localTargetConfirmText(view.label, view.allowLocal),
              keyboard: localTargetKeyboard(providerId, view.allowLocal),
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
          await this.render(ctx, r.data.refused, backKeyboard());
          return;
        }
        // Re-read: the confirmation must state what is now persisted.
        const view = this.providers.view(providerId);
        await this.render(
          ctx,
          view?.allowLocal === true
            ? "دسترسی محلی برای این پروایدر باز شد."
            : "دسترسی محلی برای این پروایدر بسته شد.",
          backKeyboard(),
        );
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
            if (index < 0 || index >= current.length) return { refused: "این جایگزین دیگر در فهرست نیست." };
            if (target < 0 || target >= current.length) return { refused: "جابه‌جایی نامعتبر است." };
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
          await this.render(ctx, r.data.refused, backKeyboard());
          return;
        }
        const view = this.admin.runAdminSync(
          { actor, operation: "fo.menu.refresh", permission: PERM_VIEW },
          () => this.failoverView(),
        );
        if (!view.ok) return void (await this.deny(ctx));
        await this.render(ctx, `ترتیب تغییر کرد.\n\n${view.data.text}`, view.data.keyboard);
        return;
      }

      case "ai_providers": {
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.providers", permission: PERM_VIEW },
          () => ({ text: providersText(this.providers.listViews()), keyboard: providersKeyboard() }),
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
            return { text: providerText(view), keyboard: providerKeyboard(view) };
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
          () => ({ keyboard: adapterKeyboard(), text: "نوع اتصال پروایدر را انتخاب کنید:" }),
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
            return { text: addFormText(adapter), keyboard: backKeyboard() };
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
            return { text: editFormText(view), keyboard: backKeyboard() };
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
        await this.render(ctx, "در حال آزمایش اتصال…", backKeyboard());
        const probe = await this.runAuthorizedProbe(ctx, id);
        await this.render(ctx, probe.text, backKeyboard());
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
        await this.render(ctx, "در حال دریافت فهرست مدل‌ها…", backKeyboard());
        const found = await this.runAuthorizedDiscovery(ctx, id);
        await this.render(ctx, found.text, backKeyboard());
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
              text: view.enabled ? "پروایدر غیرفعال شد." : "پروایدر فعال شد.",
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, backKeyboard());
        return;
      }

      case "ai_clear_key": {
        const id = action.providerId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.clear_key", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const view = this.providers.view(id);
            if (!view) return undefined;
            this.providers.clearCredential(id);
            return { text: "کلید پاک شد.", keyboard: backKeyboard() };
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
          { actor, operation: "ai.delete", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const res = this.providers.remove(id);
            return { ok: res.ok, message: res.ok ? "پروایدر حذف شد." : res.message };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        // A refusal (the provider is active) names the reason and nothing else.
        await this.render(ctx, r.data.message, providersKeyboard());
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
              text: modelsText(models, view.label),
              keyboard: withAddButton(modelsKeyboard(models), id),
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
          () => ({
            text: [
              "افزودن مدل",
              "",
              "این پیام را پاسخ بدهید (reply) و مقادیر را خط‌به‌خط بفرستید:",
              "",
              "شناسهٔ مدل: <شناسه واقعی مدل>",
              "نام نمایشی: <هر نامی که دوست دارید>",
            ].join("\n"),
            keyboard: backKeyboard(),
          }),
        );
        if (!r.ok) return void (await this.deny(ctx));
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
              text: model.enabled ? "مدل غیرفعال شد." : "مدل فعال شد.",
            };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.showModels(ctx, r.data.providerId, r.data.text);
        return;
      }

      case "ai_model_delete": {
        const id = action.modelId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.model_delete", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const model = this.models.get(id);
            if (!model) return undefined;
            const res = this.models.remove(id);
            if (!res.ok) return { providerId: model.providerId, text: res.message };
            return { providerId: model.providerId, text: "مدل حذف شد." };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.showModels(ctx, r.data.providerId, r.data.text);
        return;
      }

      case "ai_model_default": {
        const id = action.modelId;
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.model_default", permission: PERM_MANAGE, targetId: String(id) },
          () => {
            const model = this.models.get(id);
            if (!model) return undefined;
            const res = this.models.setDefault(id);
            if (!res.ok) return { providerId: model.providerId, text: res.message };
            // Selecting the default also activates this provider+model, so a
            // single click both sets the default and makes it live.
            this.storage.setRuntimeSelection({ providerId: model.providerId, modelId: id });
            return { providerId: model.providerId, text: "مدل فعال و پیش‌فرض شد." };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.showModels(ctx, r.data.providerId, r.data.text);
        return;
      }

      case "ai_select_menu": {
        const r = await this.admin.runAdmin(
          { actor, operation: "ai.select.menu", permission: PERM_VIEW },
          () => this.selectView(),
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
            return {
              text: `مدل فعال پروایدر «${view.label}» را انتخاب کنید:`,
              keyboard: modelPickerKeyboard(models),
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
          () => {
            const model = this.models.get(id);
            if (!model || !model.enabled) return undefined;
            const provider = this.storage.getProvider(model.providerId);
            if (!provider || !provider.enabled) return undefined;
            this.storage.setRuntimeSelection({ providerId: model.providerId, modelId: id });
            return { text: `مدل فعال اکنون «${model.label}» است.` };
          },
        );
        if (!r.ok) return void (await this.deny(ctx));
        if (!r.data) return void (await this.stale(ctx));
        await this.render(ctx, r.data.text, backKeyboard());
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
  private async runAuthorizedProbe(ctx: Context, providerId: number): Promise<{ text: string }> {
    const actor = this.actorFor(ctx);
    const r = await this.admin.runAdmin(
      {
        actor,
        operation: "ai.test.run",
        permission: PERM_MANAGE,
        targetId: String(providerId),
      },
      async () => {
        const probe = await this.health.probe(providerId);
        const msg = probe.ok
          ? "تست اتصال موفق بود."
          : `تست اتصال ناموفق بود.${probe.message !== undefined ? ` (${probe.message})` : ""}`;
        return { text: msg };
      },
    );
    if (!r.ok) return { text: "تست اتصال ناموفق بود." };
    return r.data;
  }

  /** Discover a provider's models, inside an authorized run. */
  private async runAuthorizedDiscovery(ctx: Context, providerId: number): Promise<{ text: string }> {
    const actor = this.actorFor(ctx);
    const r = await this.admin.runAdmin(
      {
        actor,
        operation: "ai.discover.run",
        permission: PERM_MANAGE,
        targetId: String(providerId),
      },
      async () => {
        const discovered = await this.discover(providerId);
        if (!discovered.ok) {
          return {
            text: `دریافت مدل‌ها ناموفق بود.${discovered.message !== undefined ? ` (${discovered.message})` : ""}`,
          };
        }
        // Discovered models are NEVER auto-enabled or made default: the owner
        // must pick them from the model list.
        return {
          text: `${discovered.models.length} مدل یافت شد. از فهرست مدل‌ها می‌توانید آن‌ها را اضافه کنید.`,
        };
      },
    );
    if (!r.ok) return { text: "دریافت مدل‌ها ناموفق بود." };
    return r.data;
  }

  /** The active provider + its models, for the quick-switch screen. */
  private selectView(): { text: string; keyboard: InlineKeyboard } {
    const settings = this.storage.getRuntimeSettings();
    const provider =
      settings.activeProviderId !== null ? this.providers.view(settings.activeProviderId) : undefined;
    const models = provider ? this.models.enabledModels(provider.id) : [];
    return {
      text: selectMenuText(models, provider?.label ?? "تعیین‌نشده"),
      keyboard: providerPickerKeyboard(this.providers.listViews()),
    };
  }

  /** Re-render a provider's model list after a model action. */
  private async showModels(ctx: Context, providerId: number, lead: string): Promise<void> {
    const view = this.providers.view(providerId);
    if (!view) {
      await this.render(ctx, lead, backKeyboard());
      return;
    }
    const models = this.models.list(providerId);
    await this.render(
      ctx,
      `${lead}\n\n${modelsText(models, view.label)}`,
      withAddButton(modelsKeyboard(models), providerId),
    );
  }

  /**
   * Fetch models from a service, without touching the panel's model store.
   * The list is returned for the owner to act on; nothing is auto-activated.
   */
  private async discover(
    providerId: number,
  ): Promise<{ ok: true; models: readonly RemoteModel[] } | { ok: false; message?: string }> {
    const provider = this.storage.getProvider(providerId);
    if (!provider) return { ok: false, message: "پروایدر یافت نشد." };
    if (!this.adapters.describes(provider.adapter).listModels) {
      return { ok: false, message: "این نوع اتصال فهرست مدل‌ها را پشتیبانی نمی‌کند." };
    }

    let apiKey: string | undefined;
    try {
      apiKey = this.providers.credentialFor(providerId);
    } catch {
      return { ok: false, message: "اعتبارنامه قابل رمزگشایی نبود." };
    }
    if (apiKey === undefined || apiKey.length === 0) {
      return { ok: false, message: "اعتبارنامه تنظیم نشده است." };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const adapter = this.adapters.create(provider.adapter, {
        baseUrl: provider.baseUrl,
        apiKey,
        model: "discover",
      });
      if (!adapter.listModels) {
        return { ok: false, message: "دریافت فهرست مدل پشتیبانی نمی‌شود." };
      }
      const models = await adapter.listModels({
        target: { baseUrl: provider.baseUrl, apiKey },
        timeoutMs: 15_000,
        signal: controller.signal,
      });
      return { ok: true, models };
    } catch {
      // A failure here never records a partial list or changes any state.
      return { ok: false, message: "دریافت فهرست مدل ناموفق بود." };
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
  private failoverView(): { text: string; keyboard: unknown } {
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
        providerLabel: p?.label ?? `حذف‌شده (${c.providerId})`,
        modelLabel: m?.label ?? `حذف‌شده (${c.modelId})`,
        enabled: p?.enabled === true && m?.enabled === true,
      };
    });

    return {
      text: failoverText({
        enabled: s.enabled,
        maxAttempts: s.maxAttempts,
        timeoutMs: s.timeoutMs,
        primaryLabel: primary?.label,
        primaryModelLabel: primaryModel?.label,
        rows,
      }),
      keyboard: failoverKeyboard({
        enabled: s.enabled,
        maxAttempts: s.maxAttempts,
        timeoutMs: s.timeoutMs,
        primaryLabel: primary?.label,
        primaryModelLabel: primaryModel?.label,
        rows,
      }),
    };
  }

  /** Keyboard offering only enabled providers as failover candidates. */
  private foProviderKeyboard(providers: readonly ProviderView[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const p of providers) {
      kb.text(p.label, encode({ kind: "fo_add_pick_model", providerId: p.id })).row();
    }
    kb.text("بازگشت", encode({ kind: "fo_menu" }));
    return kb;
  }

  /** Keyboard offering only enabled models of one provider. */
  private foModelKeyboard(
    providerId: number,
    models: readonly { id: number; label: string }[],
  ): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const m of models) {
      kb.text(m.label, encode({ kind: "fo_add_confirm", providerId, modelId: m.id })).row();
    }
    kb.text("بازگشت", encode({ kind: "fo_add_form" }));
    return kb;
  }

  /**
   * The operational status view.
   *
   * A health check is reported separately from a real conversation: this text
   * says "last test", never "working", because a probe is a liveness ping and
   * not evidence that a request would succeed.
   */
  private buildStatusText(): string {
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

    return statusText({
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
      note: undefined,
    });
  }

  /**
   * Interpret a free-text reply as a provider/model submission.
   * Returns true when the message was consumed by a pending flow.
   */
  async handleText(ctx: Context, text: string): Promise<boolean> {
    const id = ctx.from?.id;
    if (id === undefined) return false;
    const flow = this.pending.get(id);
    if (!flow) return false;

    const actor = this.actorFor(ctx);
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (flow.kind === "search_key") {
      if (!this.search) {
        this.pending.delete(id);
        await ctx.reply("بخش جستجو در دسترس نیست.");
        return true;
      }
      // Consume the pending state BEFORE the write, so a failed attempt does
      // not leave the owner stuck in the form.
      this.pending.delete(id);

      const key = (lines[0] ?? "").trim();
      const r = await this.admin.runAdmin(
        { actor, operation: "search.set_key", permission: PERM_MANAGE },
        () => this.search!.setKey(key),
      );
      if (!r.ok) {
        await this.deny(ctx);
        return true;
      }
      if (!r.data.ok) {
        await this.render(ctx, r.data.message, backToSearchKeyboard());
        return true;
      }
      // Never echo the key; confirm only that it was stored.
      const v = this.searchView();
      await this.render(ctx, `${searchKeySavedText(this.search.label())}\n\n${v.text}`, v.keyboard);
      return true;
    }

    if (flow.kind === "add_provider") {
      const parsed = parseSubmission(lines);
      if (!parsed) {
        this.pending.delete(id);
        await ctx.reply("ورودی ناقص بود؛ عملیات لغو شد.");
        return true;
      }
      this.pending.delete(id);

      const r = await this.admin.runAdmin(
        { actor, operation: "ai.add", permission: PERM_MANAGE },
        () => {
          const res = this.providers.create({
            label: parsed.label,
            adapter: flow.adapter ?? "openai_compatible",
            baseUrl: parsed.baseUrl,
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
        await this.render(ctx, r.data.message, backKeyboard());
        return true;
      }
      // Never echo the key back; confirm the fields that are not secrets.
      await this.render(
        ctx,
        [
          "پروایدر اضافه شد.",
          "",
          `نام: ${parsed.label}`,
          `آدرس: ${parsed.baseUrl}`,
          "کلید: تنظیم شد",
        ].join("\n"),
        providersKeyboard(),
      );
      return true;
    }

    if (flow.kind === "edit_provider") {
      const providerId = flow.providerId;
      this.pending.delete(id);
      if (providerId === undefined) {
        await this.stale(ctx);
        return true;
      }

      const parsed = parseEditSubmission(lines);
      if (!parsed) {
        await this.render(ctx, "ورودی ناقص بود؛ عملیات لغو شد.", backKeyboard());
        return true;
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
        await this.render(ctx, r.data.message, backKeyboard());
        return true;
      }

      // Re-read from the store: the confirmation must reflect what persisted.
      const view = this.providers.view(providerId);
      if (!view) {
        await this.stale(ctx);
        return true;
      }
      await this.render(
        ctx,
        [
          "پروایدر به‌روز شد.",
          "",
          `نام: ${view.label}`,
          `نوع اتصال: ${view.adapterLabel}`,
          `آدرس: ${view.baseUrl}`,
          `کلید: ${view.hasCredential ? "تنظیم‌شده" : "تنظیم‌نشده"}`,
        ].join("\n"),
        providersKeyboard(),
      );
      return true;
    }

    this.pending.delete(id);
    await ctx.reply("این عملیات پشتیبانی نمی‌شود.");
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

  private async render(ctx: Context, text: string, keyboard: unknown): Promise<void> {
    await safeAnswer(ctx);
    await safeSend(ctx, text, keyboard);
  }
}

/** Add the "افزودن مدل" button to a model list keyboard. */
function withAddButton(kb: InlineKeyboard, providerId: number): InlineKeyboard {
  kb.text("افزودن مدل", encode({ kind: "ai_model_add_form", providerId })).row();
  return kb;
}

/** The add-provider form's expected lines. */
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
  const baseUrl = byKey.get("آدرس سرویس") ?? byKey.get("base url") ?? lines[1];
  const apiKey = byKey.get("کلید api") ?? byKey.get("api key") ?? lines[2];

  if (label === undefined || baseUrl === undefined || apiKey === undefined) return undefined;
  if (label.length === 0 || baseUrl.length === 0 || apiKey.length === 0) return undefined;
  return { label, baseUrl, apiKey };
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
function editFormText(view: ProviderView): string {
  return [
    "ویرایش پروایدر",
    "",
    "این پیام را پاسخ بدهید (reply) و فقط مقادیر تغییرکرده را بفرستید:",
    "",
    `نام نمایشی: ${view.label}`,
    `نوع اتصال: ${view.adapterLabel}`,
    `آدرس سرویس: ${view.baseUrl}`,
    `کلید API: ${view.hasCredential ? "تنظیم‌شده" : "تنظیم‌نشده"}`,
    "",
    "برای پاک‌کردن کلید از دکمهٔ مربوط در صفحهٔ پروایدر استفاده کنید.",
    "برای لغو، /admin را بفرستید.",
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
  "ai_edit",
  "ai_toggle",
  "ai_test",
  "ai_discover",
  "ai_clear_key",
  "ai_delete",
  "ai_models",
  "ai_model_add_form",
  "ai_model_toggle",
  "ai_model_delete",
  "ai_model_default",
  "ai_select_menu",
  "ai_select_provider",
  "ai_select_model",
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
  // ---- web-search settings ----
  "search_menu",
  "search_pick",
  "search_set_key_form",
  "search_clear_key",
]);
