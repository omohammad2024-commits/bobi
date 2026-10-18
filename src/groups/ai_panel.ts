/**
 * AI management panel UI — Persian text and inline keyboards.
 *
 * Rendering only: no authorization, no state change. Every button behind these
 * views is re-checked by AdminBoundary at execution time, exactly like the group
 * panel.
 *
 * Credentials are shown ONLY as set/unset. No key, no header, no URL with a
 * credential ever reaches this module's output.
 */
import { InlineKeyboard } from "grammy";
import { encode } from "./callbacks";
import { ADAPTER_TEMPLATES, PROVIDER_PRESETS } from "../ai/adapter";
import type { ModelView, ProviderView } from "../ai/provider_service";

export function aiMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("پروایدرها", encode({ kind: "ai_providers" }))
    .row()
    .text("انتخاب پروایدر و مدل فعال", encode({ kind: "ai_select_menu" }))
    .row()
    .text("جایگزین مطالبه‌ای (Failover)", encode({ kind: "fo_menu" }))
    .row()
    .text("جستجوی وب", encode({ kind: "search_menu" }))
    .row()
    .text("وضعیت عملیاتی", encode({ kind: "ai_status" }))
    .row()
    .text("بازگشت", encode({ kind: "menu" }));
}

export function aiMenuText(): string {
  return ["مدیریت هوش مصنوعی", "یک گزینه را انتخاب کنید:"].join("\n");
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

export function failoverText(v: FailoverView): string {
  const state = v.enabled ? "فعال" : "غیرفعال (پیش‌فرض)";
  const lines = [
    "جایگزین مطالبه‌ای (Failover)",
    "",
    `وضعیت: ${state}`,
    `حداکثر تلاش: ${v.maxAttempts}`,
    `مدت هر تلاش: ${v.timeoutMs} میلی‌ثانیه`,
    "",
    `انتخاب اصلی: ${v.primaryLabel ?? "تنظیم‌نشده"} / ${v.primaryModelLabel ?? "تنظیم‌نشده"}`,
    "",
  ];

  if (v.rows.length === 0) {
    lines.push("جایگزینی تنظیم نشده است.", "با حالت خاموش، درخواست هرگز به پروایدر دیگری نمی‌رود.");
  } else {
    lines.push("جایگزین‌ها به ترتیب اولویت:");
    v.rows.forEach((r, i) => {
      const note = r.enabled ? "" : " (غیرفعال — تا فعال نشود استفاده نمی‌شود)";
      lines.push(`${i + 1}. ${r.providerLabel} / ${r.modelLabel}${note}`);
    });
    lines.push("", "فقط در صورت فعال بودن، پروایدرهای غیرفعال نادیده گرفته می‌شوند.");
  }
  return lines.join("\n");
}

export function failoverKeyboard(v: FailoverView): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(v.enabled ? "غیرفعال کردن" : "فعال کردن", encode({ kind: "fo_toggle" }))
    .row()
    .text(`حداکثر تلاش: ${v.maxAttempts}`, encode({ kind: "fo_attempts" }))
    .row()
    .text(`زمان هر تلاش: ${Math.round(v.timeoutMs / 1000)} ثانیه`, encode({ kind: "fo_timeout" }))
    .row();

  v.rows.forEach((r) => {
    if (r.index > 0) {
      kb.text("↑", encode({ kind: "fo_move_up", index: r.index })).row();
    }
    kb.text(`حذف ${r.providerLabel}`, encode({ kind: "fo_remove", index: r.index })).row();
  });

  kb.text("افزودن جایگزین", encode({ kind: "fo_add_form" })).row();
  kb.text("بازگشت", encode({ kind: "ai_menu" }));
  return kb;
}

/** The attempt-count picker, within the supported 1..4. */
export function attemptsKeyboard(current: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const n of [1, 2, 3, 4]) {
    const marker = n === current ? " ✓" : "";
    kb.text(`${n}${marker}`, encode({ kind: "fo_attempts_set", value: n }));
  }
  kb.row().text("بازگشت", encode({ kind: "fo_menu" }));
  return kb;
}

export function attemptsText(current: number): string {
  return ["حداکثر تلاش", "", `مقدار فعلی: ${current}`, "عدد جدید را انتخاب کنید (۱ تا ۴):"].join(
    "\n",
  );
}

/** The timeout picker, within the documented 1000..60000 ms. */
export function timeoutKeyboard(current: number): InlineKeyboard {
  const options = [5000, 10000, 15000, 30000, 60000];
  const kb = new InlineKeyboard();
  for (const ms of options) {
    const marker = ms === current ? " ✓" : "";
    kb.text(`${Math.round(ms / 1000)}ث${marker}`, encode({ kind: "fo_timeout_set", value: ms }));
  }
  kb.row().text("بازگشت", encode({ kind: "fo_menu" }));
  return kb;
}

export function timeoutText(current: number): string {
  return [
    "زمان هر تلاش",
    "",
    `مقدار فعلی: ${current} میلی‌ثانیه`,
    "مقدار جدید را انتخاب کنید (۱ تا ۶۰ ثانیه):",
  ].join("\n");
}

/** Preview before a candidate is committed. */
export function addConfirmText(providerLabel: string, modelLabel: string): string {
  return [
    "افزودن جایگزین",
    "",
    `پروایدر: ${providerLabel}`,
    `مدل: ${modelLabel}`,
    "",
    "برای افزودن به انتهای فهرست تأیید کنید.",
  ].join("\n");
}

export function addConfirmKeyboard(providerId: number, modelId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("تأیید و افزودن", encode({ kind: "fo_add_confirm", providerId, modelId }))
    .row()
    .text("بازگشت", encode({ kind: "fo_add_form" }));
}

// ---------- local-target exception ----------

/**
 * Confirmation before a provider is allowed to reach loopback/private addresses.
 *
 * The warning states the exposure plainly, because this is the one setting that
 * widens the SSRF boundary. It is per-provider and owner-only.
 */
export function localTargetConfirmText(providerLabel: string, currentlyAllowed: boolean): string {
  const action = currentlyAllowed ? "لغو دسترسی محلی" : "اجازهٔ دسترسی محلی";
  return [
    `${action} برای «${providerLabel}»`,
    "",
    "با این تنظیم، این پروایدر می‌تواند به آدرس‌های داخلی یا خصوصی وصل شود:",
    "localhost، 127.0.0.0/8، 10.0.0.0/8، 172.16.0.0/12، 192.168.0.0/16، 169.254.0.0/16",
    "",
    "این تنها برای نصب محلی یک سرویس روی همین ماشین مناسب است.",
    "در یک سراختار عمومی این تنظیم را روشن نکنید.",
    "",
    "تغییر مسیر (redirect) همیشه مسدود است و با این تنظیم باز نمی‌شود.",
    currentlyAllowed ? "" : "وضعیت فعلی: دسترسی محلی بسته است.",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

export function localTargetKeyboard(providerId: number, currentlyAllowed: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      currentlyAllowed ? "تأیید: دسترسی محلی بسته شود" : "تأیید: دسترسی محلی باز شود",
      encode({ kind: "fo_local_confirm", providerId }),
    )
    .row()
    .text("بازگشت", encode({ kind: "ai_provider", providerId }));
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
  note: string | undefined;
}

export function statusText(v: StatusView): string {
  const lines = [
    "وضعیت عملیاتی هوش مصنوعی",
    "",
    `انتخاب اصلی: ${v.primaryProvider ?? "تنظیم‌نشده"} / ${v.primaryModel ?? "تنظیم‌نشده"}`,
    `جایگزین: ${v.failoverEnabled ? "فعال" : "غیرفعال"} — ${v.candidateCount} تنظیم‌شده، ${v.activeCandidateCount} آماده`,
    `پیکربندی اجرا با پیکربندی ذخیره‌شده: ${v.runtimeMatchesPersisted ? "همخوان" : "ناهمخوان"}`,
    "",
    "پروایدرها:",
  ];

  for (const p of v.providers) {
    const flags: string[] = [];
    if (!p.enabled) flags.push("غیرفعال");
    if (!p.hasCredential) flags.push("بدون کلید");
    if (p.allowLocal) flags.push("دسترسی محلی");
    const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    let test = "تست: ثبت نشده";
    if (p.lastTestOk !== undefined && p.lastTestAt !== undefined) {
      const verdict = p.lastTestOk ? "موفق" : "ناموفق";
      test = `آخرین تست: ${verdict} — ${formatTime(p.lastTestAt)}`;
    }
    lines.push(`• ${p.label}${suffix} — ${test}`);
  }

  if (v.note !== undefined) {
    lines.push("", v.note);
  }
  return lines.join("\n");
}

export function statusKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("تست همهٔ پروایدرها", encode({ kind: "ai_status" }))
    .row()
    .text("بازگشت", encode({ kind: "ai_menu" }));
}

/** Short, safe rendering of a timestamp. */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Provider list with status. Keys appear only as set/unset. */
export function providersText(
  providers: readonly ProviderView[],
): string {
  if (providers.length === 0) {
    return "هیچ پروایدری ثبت نشده است.\n\nبرای افزودن پروایدر از دکمهٔ زیر استفاده کنید.";
  }
  const lines = ["پروایدرها:"];
  for (const p of providers) {
    const state = p.enabled ? "فعال" : "غیرفعال";
    const key = p.hasCredential ? "تنظیم‌شده" : "تنظیم‌نشده";
    lines.push(
      "",
      `• ${p.label} — ${state}`,
      `  اتصال: ${p.adapterLabel}`,
      `  کلید: ${key}`,
      `  مدل‌ها: ${p.modelCount}`,
    );
  }
  return lines.join("\n");
}

export function providersKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("افزودن پروایدر", encode({ kind: "ai_add_form" }))
    .row()
    .text("بازگشت", encode({ kind: "ai_menu" }));
}

export function providerText(p: ProviderView): string {
  const state = p.enabled ? "فعال" : "غیرفعال";
  const key = p.hasCredential ? "تنظیم‌شده" : "تنظیم‌نشده";
  const lines = [
    `پروایدر: ${p.label}`,
    `وضعیت: ${state}`,
    `نوع اتصال: ${p.adapterLabel}`,
    `کلید: ${key}`,
    // Pool keys appear only as a count: key material is never listed.
    `کلیدهای پشتیبان: ${p.poolKeyCount}`,
    `تعداد مدل‌ها: ${p.modelCount}`,
  ];
  if (p.lastTestOk !== undefined) {
    const when = p.lastTestAt !== undefined ? formatTime(p.lastTestAt) : "";
    const verdict = p.lastTestOk ? "موفق" : "ناموفق";
    lines.push(`آخرین تست اتصال: ${verdict}${when.length > 0 ? ` (${when})` : ""}`);
    if (p.lastTestMessage !== undefined) lines.push(`پیام تست: ${p.lastTestMessage}`);
  } else {
    lines.push("آخرین تست اتصال: ثبت نشده");
  }
  return lines.join("\n");
}

export function providerKeyboard(p: ProviderView): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(p.enabled ? "غیرفعال کردن" : "فعال کردن", encode({ kind: "ai_toggle", providerId: p.id }))
    .row()
    .text("تست اتصال", encode({ kind: "ai_test", providerId: p.id }))
    .row()
    .text("مدل‌ها", encode({ kind: "ai_models", providerId: p.id }))
    .row()
    .text("جایگزینی کلید", encode({ kind: "ai_edit", providerId: p.id }))
    .row()
    // Backup keys: added through the same message-entry flow as the primary
    // key (owner-only, PERM_MANAGE), stored in the encrypted credential pool
    // as "backup-N". They are tried after the primary key on auth/transport
    // failures; they are never displayed.
    .text("کلید پشتیبان", encode({ kind: "ai_pool_key", providerId: p.id }))
    .row();
  if (p.hasCredential) {
    kb.text("پاک کردن کلید", encode({ kind: "ai_clear_key", providerId: p.id })).row();
  }
  if (p.canListModels) {
    kb.text("دریافت مدل‌ها", encode({ kind: "ai_discover", providerId: p.id })).row();
  }
  // The local-target exception is deliberately out of the way: it widens the
  // SSRF boundary, so it is a separate, warned step rather than a header flag.
  kb.text(
    p.allowLocal ? "دسترسی محلی: باز" : "دسترسی محلی: بسته",
    encode({ kind: "fo_local_menu", providerId: p.id }),
  ).row();
  kb.text("حذف پروایدر", encode({ kind: "ai_delete", providerId: p.id })).row();
  kb.text("بازگشت", encode({ kind: "ai_providers" }));
  return kb;
}

export function providerPickerKeyboard(
  providers: readonly ProviderView[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of providers) {
    if (!p.enabled) continue;
    const marker = p.modelCount > 0 ? "" : " (بدون مدل)";
    kb.text(`${p.label}${marker}`, encode({ kind: "ai_provider", providerId: p.id })).row();
  }
  kb.text("بازگشت", encode({ kind: "ai_menu" }));
  return kb;
}

export function selectMenuText(models: readonly ModelView[], providerLabel: string): string {
  const active = models.find((m) => m.isDefault);
  return [
    "انتخاب پروایدر و مدل فعال",
    "",
    `پروایدر انتخابی: ${providerLabel}`,
    `مدل پیش‌فرض: ${active?.label ?? "تعیین‌نشده"}`,
  ].join("\n");
}

export function modelPickerKeyboard(models: readonly ModelView[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of models) {
    const marker = m.isDefault ? " ✓" : "";
    kb.text(`${m.label}${marker}`, encode({ kind: "ai_model_default", modelId: m.id })).row();
  }
  kb.text("بازگشت", encode({ kind: "ai_select_menu" }));
  return kb;
}

export function modelsText(models: readonly ModelView[], providerLabel: string): string {
  if (models.length === 0) {
    return [
      `مدل‌های پروایدر ${providerLabel}`,
      "",
      "هیچ مدلی ثبت نشده است.",
      "مدل‌ها را می‌توانید با دکمهٔ «دریافت مدل‌ها» بگیرید یا دستی اضافه کنید.",
    ].join("\n");
  }
  const lines = [`مدل‌های پروایدر ${providerLabel}`, ""];
  for (const m of models) {
    const flags: string[] = [];
    if (m.isDefault) flags.push("پیش‌فرض");
    if (!m.enabled) flags.push("غیرفعال");
    const suffix = flags.length > 0 ? ` (${flags.join("، ")})` : "";
    lines.push(`• ${m.label}${suffix}`);
    lines.push(`  شناسه: ${m.modelId}`);
  }
  return lines.join("\n");
}

export function modelsKeyboard(models: readonly ModelView[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of models) {
    kb.text(m.isDefault ? "پیش‌فرض ✓" : "انتخاب پیش‌فرض", encode({ kind: "ai_model_default", modelId: m.id }));
    kb.text(m.enabled ? "غیرفعال" : "فعال", encode({ kind: "ai_model_toggle", modelId: m.id }));
    kb.text("حذف", encode({ kind: "ai_model_delete", modelId: m.id }));
    kb.row();
  }
  kb.text("بازگشت", encode({ kind: "ai_providers" }));
  return kb;
}

/**
 * Service picker for the add-provider flow.
 *
 * Named services come first because they pre-fill the endpoint — the owner adds
 * a label and a key instead of transcribing a URL. The generic adapter types
 * follow, for anything not listed.
 */
export function adapterKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PROVIDER_PRESETS) {
    kb.text(p.label, encode({ kind: "ai_add_preset", preset: p.id })).row();
  }
  kb.row();
  for (const t of ADAPTER_TEMPLATES) {
    kb.text(t.label, encode({ kind: "ai_add_adapter", adapter: t.type })).row();
  }
  kb.text("بازگشت", encode({ kind: "ai_menu" }));
  return kb;
}

export function addFormText(adapter: string): string {
  const t = ADAPTER_TEMPLATES.find((x) => x.type === adapter);
  const notes = t?.capabilities.notes;
  return [
    "افزودن پروایدر",
    "",
    "این پیام را پاسخ بدهید (reply) و مقادیر را خط‌به‌خط بفرستید:",
    "",
    `نام نمایشی: <هر نامی که دوست دارید>`,
    `آدرس سرویس: <base URL>`,
    `کلید API: <کلید شما>`,
    ...(notes !== undefined ? ["", `نکته: ${notes}`] : []),
    "",
    "برای لغو، /admin را بفرستید.",
  ].join("\n");
}

/** Confirmation shown before a destructive action. */
export function confirmDeleteProviderText(p: ProviderView): string {
  return [
    "حذف پروایدر",
    "",
    `آیا «${p.label}» حذف شود؟`,
    `تعداد مدل‌های آن: ${p.modelCount}`,
    "",
    "برای تأیید دوباره دکمهٔ حذف را بزنید.",
  ].join("\n");
}
