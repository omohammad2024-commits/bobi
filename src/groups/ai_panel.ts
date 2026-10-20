/**
 * AI management panel UI — inline keyboards and text, rendered from the panel
 * string table (`panel_strings.ts`).
 *
 * Rendering only: no authorization, no state change. Every button behind these
 * views is re-checked by AdminBoundary at execution time, exactly like the group
 * panel.
 *
 * Credentials are shown ONLY as set/unset. No key, no header, no URL with a
 * credential ever reaches this module's output.
 *
 * `lang` defaults to Persian (the owner's ground truth); the English mirror
 * comes from the same table. No user-facing literal lives in this file.
 */
import { InlineKeyboard } from "grammy";
import { encode } from "./callbacks";
import { ADAPTER_TEMPLATES, PROVIDER_PRESETS } from "../ai/adapter";
import type { ModelView, ProviderView } from "../ai/provider_service";
import { formatNum, formatTime, tr, type PanelLang } from "./panel_strings";
import { atr } from "./ai_panel_audit_strings";

export function aiMenuKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.ai.menu.providers"), encode({ kind: "ai_providers" }))
    .row()
    .text(tr(lang, "panel.ai.menu.select"), encode({ kind: "ai_select_menu" }))
    .row()
    .text(tr(lang, "panel.ai.menu.failover"), encode({ kind: "fo_menu" }))
    .row()
    .text(tr(lang, "panel.ai.menu.search"), encode({ kind: "search_menu" }))
    .row()
    .text(tr(lang, "panel.ai.menu.status"), encode({ kind: "ai_status" }))
    .row()
    .text(tr(lang, "panel.back"), encode({ kind: "menu" }));
}

export function aiMenuText(
  lang: PanelLang = "fa",
  active?: { providerLabel: string; modelLabel: string } | null,
): string {
  const statusLine =
    active !== undefined && active !== null
      ? tr(lang, "panel.ai.active_line", { p: active.providerLabel, m: active.modelLabel })
      : tr(lang, "panel.ai.inactive_line");
  return [tr(lang, "panel.ai.menu_title"), statusLine, tr(lang, "panel.ai.menu_hint")].join("\n");
}

// ---------- failover ----------

/** A resolved failover candidate, as the panel shows it. */
export interface FailoverRow {
  index: number;
  providerLabel: string;
  modelLabel: string;
  enabled: boolean;
}

export interface FailoverView {
  enabled: boolean;
  maxAttempts: number;
  timeoutMs: number;
  primaryLabel: string | undefined;
  primaryModelLabel: string | undefined;
  rows: readonly FailoverRow[];
}

export function failoverText(v: FailoverView, lang: PanelLang = "fa"): string {
  const state = v.enabled ? tr(lang, "panel.fo.state_on") : tr(lang, "panel.fo.state_off");
  const unset = tr(lang, "panel.fo.unset");
  const lines = [
    tr(lang, "panel.fo.title"),
    "",
    tr(lang, "panel.fo.state", { v: state }),
    tr(lang, "panel.fo.max_attempts", { n: formatNum(v.maxAttempts, lang) }),
    tr(lang, "panel.fo.timeout", { n: formatNum(v.timeoutMs, lang) }),
    "",
    tr(lang, "panel.fo.primary", {
      p: v.primaryLabel ?? unset,
      m: v.primaryModelLabel ?? unset,
    }),
    "",
  ];

  if (v.rows.length === 0) {
    lines.push(tr(lang, "panel.fo.empty"), tr(lang, "panel.fo.empty_hint"));
  } else {
    lines.push(tr(lang, "panel.fo.list_title"));
    v.rows.forEach((r, i) => {
      const note = r.enabled ? "" : tr(lang, "panel.fo.row_disabled_note");
      lines.push(
        tr(lang, "panel.fo.row", {
          i: formatNum(i + 1, lang),
          p: r.providerLabel,
          m: r.modelLabel,
          note,
        }),
      );
    });
    lines.push("", tr(lang, "panel.fo.skip_note"));
  }
  return lines.join("\n");
}

export function failoverKeyboard(v: FailoverView, lang: PanelLang = "fa"): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(
      v.enabled ? tr(lang, "panel.fo.toggle_off") : tr(lang, "panel.fo.toggle_on"),
      encode({ kind: "fo_toggle" }),
    )
    .row()
    .text(
      tr(lang, "panel.fo.max_attempts", { n: formatNum(v.maxAttempts, lang) }),
      encode({ kind: "fo_attempts" }),
    )
    .row()
    .text(
      tr(lang, "panel.fo.timeout_btn", { n: formatNum(Math.round(v.timeoutMs / 1000), lang) }),
      encode({ kind: "fo_timeout" }),
    )
    .row();

  v.rows.forEach((r) => {
    if (r.index > 0) {
      kb.text("↑", encode({ kind: "fo_move_up", index: r.index })).row();
    }
    kb.text(tr(lang, "panel.fo.remove_btn", { label: r.providerLabel }), encode({ kind: "fo_remove", index: r.index })).row();
  });

  kb.text(tr(lang, "panel.fo.add"), encode({ kind: "fo_add_form" })).row();
  kb.text(tr(lang, "panel.back"), encode({ kind: "ai_menu" }));
  return kb;
}

/** The attempt-count picker, within the supported 1..4. */
export function attemptsKeyboard(current: number, lang: PanelLang = "fa"): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const n of [1, 2, 3, 4]) {
    const marker = n === current ? " ✓" : "";
    kb.text(`${formatNum(n, lang)}${marker}`, encode({ kind: "fo_attempts_set", value: n }));
  }
  kb.row().text(tr(lang, "panel.back"), encode({ kind: "fo_menu" }));
  return kb;
}

export function attemptsText(current: number, lang: PanelLang = "fa"): string {
  return [
    tr(lang, "panel.fo.attempts_title"),
    "",
    tr(lang, "panel.fo.attempts_current", { n: formatNum(current, lang) }),
    tr(lang, "panel.fo.attempts_hint"),
  ].join("\n");
}

/** The timeout picker, within the documented 1000..60000 ms. */
export function timeoutKeyboard(current: number, lang: PanelLang = "fa"): InlineKeyboard {
  const options = [5000, 10000, 15000, 30000, 60000];
  const kb = new InlineKeyboard();
  for (const ms of options) {
    const marker = ms === current ? " ✓" : "";
    kb.text(
      tr(lang, "panel.fo.timeout_sec", { n: formatNum(Math.round(ms / 1000), lang) }) + marker,
      encode({ kind: "fo_timeout_set", value: ms }),
    );
  }
  kb.row().text(tr(lang, "panel.back"), encode({ kind: "fo_menu" }));
  return kb;
}

export function timeoutText(current: number, lang: PanelLang = "fa"): string {
  return [
    tr(lang, "panel.fo.timeout_title"),
    "",
    tr(lang, "panel.fo.timeout_current", { n: formatNum(current, lang) }),
    tr(lang, "panel.fo.timeout_hint"),
  ].join("\n");
}

/** Preview before a candidate is committed. */
export function addConfirmText(
  providerLabel: string,
  modelLabel: string,
  lang: PanelLang = "fa",
): string {
  return [
    tr(lang, "panel.fo.add"),
    "",
    tr(lang, "panel.fo.preview_provider", { v: providerLabel }),
    tr(lang, "panel.fo.preview_model", { v: modelLabel }),
    "",
    tr(lang, "panel.fo.preview_hint"),
  ].join("\n");
}

export function addConfirmKeyboard(
  providerId: number,
  modelId: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.fo.add_confirm_btn"), encode({ kind: "fo_add_confirm", providerId, modelId }))
    .row()
    .text(tr(lang, "panel.back"), encode({ kind: "fo_add_form" }));
}

// ---------- local-target exception ----------

/**
 * Confirmation before a provider is allowed to reach loopback/private addresses.
 *
 * The warning states the exposure plainly, because this is the one setting that
 * widens the SSRF boundary. It is per-provider and owner-only.
 */
export function localTargetConfirmText(
  providerLabel: string,
  currentlyAllowed: boolean,
  lang: PanelLang = "fa",
): string {
  const action = currentlyAllowed ? tr(lang, "panel.local.revoke") : tr(lang, "panel.local.grant");
  return [
    tr(lang, "panel.local.title", { action, label: providerLabel }),
    "",
    tr(lang, "panel.local.warn1"),
    tr(lang, "panel.local.ranges"),
    "",
    tr(lang, "panel.local.warn2"),
    tr(lang, "panel.local.warn3"),
    "",
    tr(lang, "panel.local.warn4"),
    currentlyAllowed ? "" : tr(lang, "panel.local.current_closed"),
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

export function localTargetKeyboard(
  providerId: number,
  currentlyAllowed: boolean,
  lang: PanelLang = "fa",
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      currentlyAllowed
        ? tr(lang, "panel.local.confirm_close")
        : tr(lang, "panel.local.confirm_open"),
      encode({ kind: "fo_local_confirm", providerId }),
    )
    .row()
    .text(tr(lang, "panel.back"), encode({ kind: "ai_provider", providerId }));
}

// ---------- operational status ----------

export interface StatusView {
  primaryProvider: string | undefined;
  primaryModel: string | undefined;
  failoverEnabled: boolean;
  candidateCount: number;
  activeCandidateCount: number;
  providers: readonly {
    label: string;
    enabled: boolean;
    hasCredential: boolean;
    allowLocal: boolean;
    lastTestOk?: boolean;
    lastTestAt?: number;
  }[];
  runtimeMatchesPersisted: boolean;
  /**
   * Per-request provider timeout actually in effect, ms — the value the
   * gateway reads from `ai_failover_settings.timeout_ms` in the database.
   */
  providerTimeoutMs: number;
  /**
   * Engine-level AI_TIMEOUT_MS as resolved from the environment, ms. Absent
   * when the controller was not given the engine config (rendered "Not set").
   */
  engineTimeoutMs?: number;
  /**
   * Agent-level AGENT_TOTAL_TIMEOUT_MS as resolved from the environment, ms.
   * Absent when the controller was not given the engine config.
   */
  agentTotalTimeoutMs?: number;
  note: string | undefined;
}

export function statusText(v: StatusView, lang: PanelLang = "fa"): string {
  const unset = tr(lang, "panel.fo.unset");
  const lines = [
    tr(lang, "panel.aistatus.title"),
    "",
    tr(lang, "panel.aistatus.primary", {
      p: v.primaryProvider ?? unset,
      m: v.primaryModel ?? unset,
    }),
    tr(lang, "panel.aistatus.fo", {
      state: v.failoverEnabled ? tr(lang, "panel.fo.state_on") : tr(lang, "panel.fo.state_off"),
      n: formatNum(v.candidateCount, lang),
      a: formatNum(v.activeCandidateCount, lang),
    }),
    // Effective timeouts, one compact line: this is what the owner tunes,
    // and the values shown are the ones actually in force (DB + resolved env).
    // The unit travels with each value so an unwired "Not set" never reads
    // as a broken number.
    tr(lang, "panel.aistatus.timeouts", {
      p: `${formatNum(v.providerTimeoutMs, lang)}ms`,
      e: v.engineTimeoutMs !== undefined ? `${formatNum(v.engineTimeoutMs, lang)}ms` : unset,
      a:
        v.agentTotalTimeoutMs !== undefined
          ? `${formatNum(v.agentTotalTimeoutMs, lang)}ms`
          : unset,
    }),
    tr(lang, "panel.aistatus.sync", {
      v: v.runtimeMatchesPersisted
        ? tr(lang, "panel.aistatus.in_sync")
        : tr(lang, "panel.aistatus.out_sync"),
    }),
    "",
    tr(lang, "panel.aistatus.providers_title"),
  ];

  for (const p of v.providers) {
    const flags: string[] = [];
    if (!p.enabled) flags.push(tr(lang, "panel.aistatus.flag_disabled"));
    if (!p.hasCredential) flags.push(tr(lang, "panel.aistatus.flag_nokey"));
    if (p.allowLocal) flags.push(tr(lang, "panel.aistatus.flag_local"));
    const suffix = flags.length > 0 ? ` (${flags.join(lang === "fa" ? "، " : ", ")})` : "";
    let test = tr(lang, "panel.aistatus.test_none");
    if (p.lastTestOk !== undefined && p.lastTestAt !== undefined) {
      const verdict = p.lastTestOk
        ? tr(lang, "panel.aistatus.test_ok")
        : tr(lang, "panel.aistatus.test_fail");
      test = tr(lang, "panel.aistatus.test_last", {
        v: verdict,
        t: formatTime(p.lastTestAt, lang),
      });
    }
    lines.push(`• ${p.label}${suffix} — ${test}`);
  }

  if (v.note !== undefined) {
    lines.push("", v.note);
  }
  return lines.join("\n");
}

export function statusKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.aistatus.probe_all"), encode({ kind: "ai_probe_all" }))
    .row()
    .text(tr(lang, "panel.back"), encode({ kind: "ai_menu" }));
}

/** Provider list with status. Keys appear only as set/unset. */
export function providersText(
  providers: readonly ProviderView[],
  lang: PanelLang = "fa",
): string {
  if (providers.length === 0) {
    return tr(lang, "panel.providers.empty");
  }
  const lines = [tr(lang, "panel.providers.title")];
  for (const p of providers) {
    const state = p.enabled
      ? tr(lang, "panel.providers.state_on")
      : tr(lang, "panel.providers.state_off");
    const key = p.hasCredential
      ? tr(lang, "panel.providers.key_set")
      : tr(lang, "panel.providers.key_unset");
    lines.push(
      "",
      tr(lang, "panel.providers.item", {
        label: p.label,
        state,
        adapter: p.adapterLabel,
        key,
        n: formatNum(p.modelCount, lang),
      }),
    );
  }
  return lines.join("\n");
}

export function providersKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.providers.add"), encode({ kind: "ai_add_form" }))
    .row()
    .text(tr(lang, "panel.back"), encode({ kind: "ai_menu" }));
}

export function providerText(p: ProviderView, lang: PanelLang = "fa"): string {
  const state = p.enabled
    ? tr(lang, "panel.providers.state_on")
    : tr(lang, "panel.providers.state_off");
  const key = p.hasCredential
    ? tr(lang, "panel.providers.key_set")
    : tr(lang, "panel.providers.key_unset");
  const lines = [
    tr(lang, "panel.provider.title", { label: p.label }),
    tr(lang, "panel.provider.state", { v: state }),
    tr(lang, "panel.provider.adapter", { v: p.adapterLabel }),
    tr(lang, "panel.provider.key", { v: key }),
    // Pool keys appear only as a count: key material is never listed.
    tr(lang, "panel.provider.pool", { n: formatNum(p.poolKeyCount, lang) }),
    tr(lang, "panel.provider.models", { n: formatNum(p.modelCount, lang) }),
  ];
  if (p.lastTestOk !== undefined) {
    const when = p.lastTestAt !== undefined ? formatTime(p.lastTestAt, lang) : "";
    const verdict = p.lastTestOk
      ? tr(lang, "panel.aistatus.test_ok")
      : tr(lang, "panel.aistatus.test_fail");
    lines.push(
      tr(lang, "panel.provider.lasttest", {
        v: verdict,
        t: when.length > 0 ? ` (${when})` : "",
      }),
    );
    if (p.lastTestMessage !== undefined) lines.push(tr(lang, "panel.provider.test_msg", { v: p.lastTestMessage }));
  } else {
    lines.push(tr(lang, "panel.provider.lasttest_none"));
  }
  return lines.join("\n");
}

export function providerKeyboard(p: ProviderView, lang: PanelLang = "fa"): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(
      p.enabled ? tr(lang, "panel.provider.disable") : tr(lang, "panel.provider.enable"),
      encode({ kind: "ai_toggle", providerId: p.id }),
    )
    .row()
    .text(tr(lang, "panel.provider.test"), encode({ kind: "ai_test", providerId: p.id }))
    .row()
    .text(tr(lang, "panel.provider.models_btn"), encode({ kind: "ai_models", providerId: p.id }))
    .row()
    .text(tr(lang, "panel.provider.edit_key"), encode({ kind: "ai_edit", providerId: p.id }))
    .row()
    // Backup keys: added through the same message-entry flow as the primary
    // key (owner-only, PERM_MANAGE), stored in the encrypted credential pool
    // as "backup-N". They are tried after the primary key on auth/transport
    // failures; they are never displayed.
    .text(tr(lang, "panel.provider.pool_key"), encode({ kind: "ai_pool_key", providerId: p.id }))
    .row();
  if (p.hasCredential) {
    kb.text(tr(lang, "panel.provider.clear_key"), encode({ kind: "ai_clear_key", providerId: p.id })).row();
  }
  if (p.canListModels) {
    kb.text(tr(lang, "panel.provider.discover"), encode({ kind: "ai_discover", providerId: p.id })).row();
  }
  // The local-target exception is deliberately out of the way: it widens the
  // SSRF boundary, so it is a separate, warned step rather than a header flag.
  kb.text(
    p.allowLocal ? tr(lang, "panel.local.btn_open") : tr(lang, "panel.local.btn_closed"),
    encode({ kind: "fo_local_menu", providerId: p.id }),
  ).row();
  kb.text(tr(lang, "panel.provider.delete"), encode({ kind: "ai_delete", providerId: p.id })).row();
  kb.text(tr(lang, "panel.back"), encode({ kind: "ai_providers" }));
  return kb;
}

/**
 * Provider picker for the active provider/model selection flow.
 *
 * Buttons open the model picker for that provider (`ai_select_provider`); the
 * provider's own management screen is one level down in the providers list.
 */
export function providerPickerKeyboard(
  providers: readonly ProviderView[],
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of providers) {
    if (!p.enabled) continue;
    const marker = p.modelCount > 0 ? "" : tr(lang, "panel.select.no_model");
    kb.text(`${p.label}${marker}`, encode({ kind: "ai_select_provider", providerId: p.id })).row();
  }
  kb.text(tr(lang, "panel.back"), encode({ kind: "ai_select_menu" }));
  return kb;
}

export function selectMenuText(
  models: readonly ModelView[],
  providerLabel: string,
  activeModelId: number | null,
  lang: PanelLang = "fa",
): string {
  // The screen manages the ACTIVE model (the runtime selection), which is a
  // different thing from the provider default — show what is actually live.
  const active = models.find((m) => m.id === activeModelId);
  const unset = tr(lang, "panel.select.unset");
  return [
    tr(lang, "panel.select.title"),
    "",
    tr(lang, "panel.select.provider", { v: providerLabel }),
    atr(lang, "audit.select.active_model", { v: active?.label ?? unset }),
  ].join("\n");
}

export function modelPickerKeyboard(
  models: readonly ModelView[],
  activeModelId: number | null,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of models) {
    // Activate-only: switching the live model must not silently flip the
    // provider default, so this encodes ai_select_model (not ai_model_default).
    const marker = m.id === activeModelId ? " ✓" : "";
    kb.text(`${m.label}${marker}`, encode({ kind: "ai_select_model", modelId: m.id })).row();
  }
  kb.text(tr(lang, "panel.back"), encode({ kind: "ai_select_menu" }));
  return kb;
}

export function modelsText(
  models: readonly ModelView[],
  providerLabel: string,
  lang: PanelLang = "fa",
): string {
  if (models.length === 0) {
    return [
      tr(lang, "panel.models.title", { label: providerLabel }),
      "",
      tr(lang, "panel.models.empty"),
      tr(lang, "panel.models.empty_hint"),
    ].join("\n");
  }
  const lines = [tr(lang, "panel.models.title", { label: providerLabel }), ""];
  for (const m of models) {
    const flags: string[] = [];
    if (m.isDefault) flags.push(tr(lang, "panel.models.flag_default"));
    if (!m.enabled) flags.push(tr(lang, "panel.models.flag_disabled"));
    const suffix = flags.length > 0 ? ` (${flags.join(lang === "fa" ? "، " : ", ")})` : "";
    lines.push(tr(lang, "panel.models.row", { label: m.label, suffix, id: m.modelId }));
  }
  return lines.join("\n");
}

/**
 * Model list keyboard. «افزودن مدل» sits above «بازگشت», and the back path
 * returns to the provider screen this list was opened from.
 */
export function modelsKeyboard(
  models: readonly ModelView[],
  providerId: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of models) {
    kb.text(
      m.isDefault
        ? tr(lang, "panel.models.default_mark")
        : tr(lang, "panel.models.pick_default"),
      encode({ kind: "ai_model_default", modelId: m.id }),
    );
    kb.text(
      m.enabled ? tr(lang, "panel.models.disable") : tr(lang, "panel.models.enable"),
      encode({ kind: "ai_model_toggle", modelId: m.id }),
    );
    kb.text(tr(lang, "panel.models.delete"), encode({ kind: "ai_model_delete", modelId: m.id }));
    kb.row();
  }
  kb.text(tr(lang, "panel.models.add"), encode({ kind: "ai_model_add_form", providerId })).row();
  kb.text(tr(lang, "panel.back"), encode({ kind: "ai_provider", providerId }));
  return kb;
}

/**
 * Service picker for the add-provider flow.
 *
 * Named services come first because they pre-fill the endpoint — the owner adds
 * a label and a key instead of transcribing a URL. The generic adapter types
 * follow, for anything not listed.
 */
export function adapterKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PROVIDER_PRESETS) {
    kb.text(p.label, encode({ kind: "ai_add_preset", preset: p.id })).row();
  }
  kb.row();
  for (const t of ADAPTER_TEMPLATES) {
    kb.text(t.label, encode({ kind: "ai_add_adapter", adapter: t.type })).row();
  }
  kb.text(tr(lang, "panel.back"), encode({ kind: "ai_menu" }));
  return kb;
}

export function addFormText(adapter: string, lang: PanelLang = "fa"): string {
  const t = ADAPTER_TEMPLATES.find((x) => x.type === adapter);
  const notes = t?.capabilities.notes;
  const lines = [
    tr(lang, "panel.add.title"),
    "",
    tr(lang, "panel.add.instructions"),
    "",
    tr(lang, "panel.add.label_line"),
    tr(lang, "panel.add.url_line"),
  ];
  // A template that knows its endpoint says so: the owner can leave the URL
  // line empty instead of retyping a URL they never chose. A template with no
  // suggestion (9Router) shows no line, and the URL stays required.
  if (t?.suggestedBaseUrl) {
    lines.push(atr(lang, "audit.add.suggested_url", { url: t.suggestedBaseUrl }));
  }
  lines.push(
    tr(lang, "panel.add.key_line"),
    ...(notes !== undefined ? ["", tr(lang, "panel.add.note", { v: notes })] : []),
    "",
    tr(lang, "panel.add.cancel_hint"),
  );
  return lines.join("\n");
}

/** Keyboard for free-text form screens: an explicit cancel, nothing else. */
export function formCancelKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard().text(tr(lang, "panel.cancel"), encode({ kind: "ai_form_cancel" }));
}

/** Two-tap confirmation before a provider is deleted. */
export function confirmDeleteProviderText(p: ProviderView, lang: PanelLang = "fa"): string {
  return tr(lang, "panel.provider.confirm_delete_q", {
    label: p.label,
    n: formatNum(p.modelCount, lang),
  });
}

export function confirmDeleteProviderKeyboard(
  providerId: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.confirm_delete"), encode({ kind: "ai_delete_confirm", providerId }))
    .row()
    .text(tr(lang, "panel.cancel"), encode({ kind: "ai_provider", providerId }));
}

/** Two-tap confirmation before a model is deleted. */
export function confirmDeleteModelText(
  modelLabel: string,
  lang: PanelLang = "fa",
): string {
  return tr(lang, "panel.models.confirm_q", { label: modelLabel });
}

export function confirmDeleteModelKeyboard(
  modelId: number,
  providerId: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      tr(lang, "panel.confirm_delete"),
      encode({ kind: "ai_model_delete_confirm", modelId }),
    )
    .row()
    .text(tr(lang, "panel.cancel"), encode({ kind: "ai_models", providerId }));
}

/** Two-tap confirmation before a provider key is cleared. */
export function confirmClearKeyText(
  providerLabel: string,
  lang: PanelLang = "fa",
): string {
  return tr(lang, "panel.provider.confirm_clear_q", { label: providerLabel });
}

export function confirmClearKeyKeyboard(
  providerId: number,
  lang: PanelLang = "fa",
): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.confirm_clear"), encode({ kind: "ai_clear_key_confirm", providerId }))
    .row()
    .text(tr(lang, "panel.cancel"), encode({ kind: "ai_provider", providerId }));
}
