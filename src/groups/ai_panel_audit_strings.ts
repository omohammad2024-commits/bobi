/**
 * Audit-fix strings for the /ai panel (Oct 2026 bug-fix & completeness audit).
 *
 * Persian is the ground truth; every key carries an English mirror in the same
 * file. `tests/ai_panel_audit.test.ts` asserts fa/en parity (both present,
 * non-empty, identical `{var}` placeholders).
 *
 * This file exists because the audit's file boundaries forbid touching
 * `src/i18n/*` and `src/groups/panel_strings.ts`; panel code imports `atr`
 * from here instead of hardcoding user-facing text.
 */

export type AuditLang = "fa" | "en";

interface AuditEntry {
  fa: string;
  en: string;
}

const AUDIT_STRINGS: Record<string, AuditEntry> = {
  // ---- add-provider form: show the template's suggested endpoint ----

  "audit.add.suggested_url": {
    fa: "پیشنهاد: {url} — می‌توانی این خط را خالی بگذاری تا همین استفاده شود.",
    en: "Suggested: {url} — you may leave this line empty to use it.",
  },

  // ---- after a bare (non-preset) provider is created ----

  "audit.add.next_step_models": {
    fa: "قدم بعدی: از «مدل‌ها» یک مدل اضافه کن، یا اگر سرویس فهرست مدل می‌دهد از «دریافت مدل‌ها» استفاده کن.",
    en: "Next step: add a model via “Models”, or use “Discover models” if the service lists models.",
  },

  // ---- model discovery import ----

  "audit.discover.imported": {
    fa: "{added} مدل جدید به فهرست اضافه شد (غیرفعال‌اند؛ از فهرست مدل‌ها فعالشان کن).{existing}",
    en: "{added} new models added to the list (they are disabled; enable them from the model list).{existing}",
  },
  "audit.discover.existing_suffix": {
    fa: " {n} مدل از قبل در فهرست بود.",
    en: " {n} models were already in the list.",
  },
  "audit.discover.none_new": {
    fa: "مدل جدیدی پیدا نشد؛ همه از قبل در فهرست بودند.",
    en: "No new models found; all were already in the list.",
  },
  "audit.discover.capped": {
    fa: " (فقط {n} تای اول از {total} مدل وارد شد)",
    en: " (only the first {n} of {total} models were imported)",
  },

  // ---- provider/model quick-switch ----

  "audit.select.active_model": {
    fa: "مدل فعال: {v}",
    en: "Active model: {v}",
  },
  "audit.select.no_models": {
    fa: "این پروایدر هیچ مدل فعالی ندارد؛ اول از صفحهٔ پروایدر با «مدل‌ها» یک مدل اضافه کن.",
    en: "This provider has no enabled models; add one first from the provider page via “Models”.",
  },

  // ---- edit-provider form: adapter ids are slugs, not labels ----

  "audit.edit.adapter_hint": {
    fa: "نوع اتصال را فقط با یکی از این شناسه‌ها بنویس: openai_compatible، gemini، anthropic، nine_router",
    en: "Write the connection type using one of these ids: openai_compatible, gemini, anthropic, nine_router",
  },

  // ---- refusing to activate a model of a disabled provider ----

  "audit.models.provider_disabled": {
    fa: "پروایدر این مدل غیرفعال است؛ اول پروایدر را فعال کن.",
    en: "This model’s provider is disabled; enable the provider first.",
  },
};

/** Every audit string key, for the parity test. */
export const AUDIT_STRING_KEYS: readonly string[] = Object.keys(AUDIT_STRINGS);

/**
 * Render an audit string. Unknown keys return the key itself and an unknown
 * language falls back to Persian, mirroring `tr` in panel_strings.ts.
 */
export function atr(
  lang: AuditLang,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const entry = AUDIT_STRINGS[key];
  if (!entry) return key;
  let text = lang === "en" ? entry.en : entry.fa;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(String(v));
    }
  }
  return text;
}

/**
 * Alias required by the repo-wide `*_strings.ts` table contract
 * (tests/i18n_parity.test.ts): every module-local strings table exports
 * `tr(lang, key, vars)`. Panel code should keep importing `atr` for clarity;
 * this alias exists only for the contract.
 */
export const tr: typeof atr = atr;
