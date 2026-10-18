/**
 * Web-search settings UI for the `/ai` panel — text and keyboards rendered
 * from the panel string table (`../groups/panel_strings.ts`).
 *
 * Rendering only: no authorization and no state change. Every button here is
 * re-checked by AdminBoundary when the callback arrives.
 *
 * A credential is shown ONLY as set/unset. No key ever reaches this module's
 * output.
 *
 * `lang` defaults to Persian (the owner's ground truth); the English mirror
 * comes from the same table. No user-facing literal lives in this file.
 */
import { InlineKeyboard } from "grammy";
import { encode } from "../groups/callbacks";
import { SEARCH_TEMPLATES } from "./provider";
import { tr, type PanelLang } from "../groups/panel_strings";

export interface SearchSettingsView {
  /** The provider slug currently selected. */
  provider: string;
  /** Whether a credential is stored for it. */
  hasKey: boolean;
  /** Whether the selected provider is usable right now. */
  usable: boolean;
}

export function searchMenuText(v: SearchSettingsView, lang: PanelLang = "fa"): string {
  const selected = SEARCH_TEMPLATES.find((t) => t.type === v.provider);
  const lines = [
    tr(lang, "panel.search.title"),
    "",
    tr(lang, "panel.search.about"),
    "",
    tr(lang, "panel.search.active", { v: selected?.label ?? v.provider }),
  ];

  if (selected?.needsKey === true) {
    lines.push(
      tr(lang, "panel.search.key", {
        v: v.hasKey ? tr(lang, "panel.search.key_set") : tr(lang, "panel.search.key_unset"),
      }),
    );
  } else {
    lines.push(tr(lang, "panel.search.key_na"));
  }

  lines.push(
    "",
    v.usable ? tr(lang, "panel.search.ready") : tr(lang, "panel.search.not_ready"),
  );

  return lines.join("\n");
}

export function searchMenuKeyboard(
  current: string,
  hasKey: boolean,
  lang: PanelLang = "fa",
): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const t of SEARCH_TEMPLATES) {
    // The active provider is marked, so the owner can see the current choice
    // without reading the text above.
    const mark = t.type === current ? "✅ " : "";
    kb.text(`${mark}${t.label}`, encode({ kind: "search_pick", provider: t.type })).row();
  }

  // The key buttons only make sense for a provider that uses one.
  const selected = SEARCH_TEMPLATES.find((t) => t.type === current);
  if (selected?.needsKey === true) {
    kb.text(
      hasKey ? tr(lang, "panel.search.change_key") : tr(lang, "panel.search.set_key"),
      encode({ kind: "search_set_key_form" }),
    ).row();
    if (hasKey) {
      kb.text(tr(lang, "panel.search.clear_key"), encode({ kind: "search_clear_key" })).row();
    }
  }

  kb.text(tr(lang, "panel.back"), encode({ kind: "ai_menu" }));
  return kb;
}

/** The form prompt shown when the owner is about to type a key. */
export function searchKeyFormText(lang: PanelLang = "fa"): string {
  return [
    tr(lang, "panel.search.key_form"),
    "",
    tr(lang, "panel.search.key_form2"),
    "",
    tr(lang, "panel.add.cancel_hint"),
  ].join("\n");
}

/** Confirmation after a key was stored. Never echoes the key. */
export function searchKeySavedText(providerLabel: string, lang: PanelLang = "fa"): string {
  return tr(lang, "panel.search.key_saved", { label: providerLabel });
}

/** Confirmation after a key was removed. */
export function searchKeyClearedText(providerLabel: string, lang: PanelLang = "fa"): string {
  return tr(lang, "panel.search.key_cleared", { label: providerLabel });
}

/** Shown when a key is requested through a provider that does not use one. */
export function searchNoKeyNeededText(providerLabel: string, lang: PanelLang = "fa"): string {
  return tr(lang, "panel.search.no_key_needed", { label: providerLabel });
}

/** A back path to the search section from a sub-view. */
export function backToSearchKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard().text(tr(lang, "panel.back"), encode({ kind: "search_menu" }));
}

/** Two-tap confirmation before the search key is cleared. */
export function searchClearKeyConfirmText(
  providerLabel: string,
  lang: PanelLang = "fa",
): string {
  return tr(lang, "panel.search.key_confirm_q", { label: providerLabel });
}

export function searchClearKeyConfirmKeyboard(lang: PanelLang = "fa"): InlineKeyboard {
  return new InlineKeyboard()
    .text(tr(lang, "panel.confirm_clear"), encode({ kind: "search_clear_key_confirm" }))
    .row()
    .text(tr(lang, "panel.cancel"), encode({ kind: "search_menu" }));
}
