/**
 * String table for the owner panels (groups, users, AI management, search).
 *
 * Kept as a local module (not wired into `src/i18n/`) so the panel package
 * stays file-owned and the coordinator can fold it into the global packs
 * later. Key prefix: `panel.*`.
 *
 * User-facing strings: Persian (`fa`) default and ground truth; English (`en`)
 * mirror. A pairing test guards that every key ships both languages.
 *
 * Digit locale rule: Persian digits in `fa`, Latin digits in `en` — see
 * {@link formatNum}. Identifiers (chat ids, user ids, model ids) always stay
 * Latin so they can be copied verbatim.
 */

export type PanelLang = "fa" | "en";

export const PANEL_STRINGS: Record<string, Record<PanelLang, string>> = {
  // ---------- shared ----------

  "panel.denied": {
    fa: "این بخش فقط برای مالک ربات در دسترس است.",
    en: "This section is for the bot owner only.",
  },
  "panel.stale": {
    fa: "این درخواست قدیمی است و دیگر اعمال نمی‌شود.",
    en: "This request is stale and no longer applies.",
  },
  "panel.back": {
    fa: "بازگشت",
    en: "Back",
  },
  "panel.cancel": {
    fa: "لغو",
    en: "Cancel",
  },
  "panel.prev": {
    fa: "قبلی",
    en: "Previous",
  },
  "panel.next": {
    fa: "بعدی",
    en: "Next",
  },
  "panel.confirm_delete": {
    fa: "بله، حذف شود",
    en: "Yes, delete it",
  },
  "panel.confirm_clear": {
    fa: "بله، پاک شود",
    en: "Yes, clear it",
  },
  "panel.unnamed": {
    fa: "بی‌نام",
    en: "Unnamed",
  },
  "panel.deleted_ref": {
    fa: "حذف‌شده ({id})",
    en: "deleted ({id})",
  },

  // ---------- group panel ----------

  "panel.menu.title": {
    fa: "پنل مدیریت BOBI",
    en: "BOBI admin panel",
  },
  "panel.menu.hint": {
    fa: "گروه‌ها، کاربرها، هوش مصنوعی و وضعیت سیستم — انتخاب کن:",
    en: "Groups, users, AI, and system status — pick one:",
  },
  "panel.menu.groups_pending": {
    fa: "درخواست‌های دسترسی گروه",
    en: "Group access requests",
  },
  "panel.menu.groups_approved": {
    fa: "گروه‌های تأییدشده",
    en: "Approved groups",
  },
  "panel.menu.groups_revoke": {
    fa: "لغو دسترسی گروه",
    en: "Revoke group access",
  },
  "panel.menu.users": {
    fa: "دسترسی کاربران",
    en: "User access",
  },
  "panel.menu.ai": {
    fa: "مدیریت هوش مصنوعی",
    en: "AI management",
  },
  "panel.menu.status": {
    fa: "وضعیت سیستم",
    en: "System status",
  },
  "panel.pending.empty_more": {
    fa: "درخواست دسترسی دیگری وجود ندارد.",
    en: "No more access requests.",
  },
  "panel.pending.empty": {
    fa: "درخواست دسترسی گروهی وجود ندارد.",
    en: "No group access requests.",
  },
  "panel.pending.title": {
    fa: "درخواست‌های دسترسی گروه ({from}–{to} از {total}):",
    en: "Group access requests ({from}–{to} of {total}):",
  },
  "panel.pending.hint": {
    fa: "تأیید یا رد هر درخواست رو انتخاب کن:",
    en: "Approve or reject each request:",
  },
  "panel.pending.approve": {
    fa: "تأیید",
    en: "Approve",
  },
  "panel.pending.reject": {
    fa: "رد",
    en: "Reject",
  },
  "panel.status.title": {
    fa: "وضعیت سیستم",
    en: "System status",
  },
  "panel.status.pending": {
    fa: "گروه‌های در انتظار تأیید: {n}",
    en: "Groups pending approval: {n}",
  },
  "panel.status.approved": {
    fa: "گروه‌های تأییدشده: {n}",
    en: "Approved groups: {n}",
  },
  "panel.status.provider": {
    fa: "ارائه‌دهندهٔ گفتگو: {v}",
    en: "Chat provider: {v}",
  },
  "panel.status.model": {
    fa: "مدل: {v}",
    en: "Model: {v}",
  },
  "panel.status.usage_title": {
    fa: "مصرف امروز (همهٔ کاربران):",
    en: "Today's usage (all users):",
  },
  "panel.status.usage_requests": {
    fa: "درخواست‌ها: {n}",
    en: "Requests: {n}",
  },
  "panel.status.usage_tools": {
    fa: "فراخوانی ابزار: {n}",
    en: "Tool calls: {n}",
  },
  "panel.status.usage_in": {
    fa: "توکن ورودی: {n}",
    en: "Input tokens: {n}",
  },
  "panel.status.usage_out": {
    fa: "توکن خروجی: {n}",
    en: "Output tokens: {n}",
  },
  "panel.status.usage_cost": {
    fa: "هزینهٔ تخمینی: {v}{approx}",
    en: "Estimated cost: {v}{approx}",
  },
  "panel.status.cost_approx": {
    fa: " (تقریبی)",
    en: " (approx.)",
  },
  "panel.approved.empty_more": {
    fa: "گروه تأییدشدهٔ دیگری وجود ندارد.",
    en: "No more approved groups.",
  },
  "panel.approved.empty": {
    fa: "هیچ گروه تأییدشده‌ای وجود ندارد.",
    en: "No approved groups.",
  },
  "panel.approved.title": {
    fa: "گروه‌های تأییدشده ({from}–{to} از {total}):",
    en: "Approved groups ({from}–{to} of {total}):",
  },
  "panel.revoke.empty_more": {
    fa: "گروه بیشتری برای لغو دسترسی وجود ندارد.",
    en: "No more groups to revoke.",
  },
  "panel.revoke.empty": {
    fa: "گروهی برای لغو دسترسی وجود ندارد.",
    en: "No groups to revoke access from.",
  },
  "panel.revoke.title": {
    fa: "گروهی که می‌خوای دسترسی‌ش رو لغو کنی انتخاب کن ({from}–{to} از {total}):",
    en: "Pick the group to revoke access from ({from}–{to} of {total}):",
  },
  "panel.group.requested_by": {
    fa: "درخواست‌کننده: {v}",
    en: "Requested by: {v}",
  },
  "panel.group.requested_unknown": {
    fa: "درخواست‌کننده: نامشخص",
    en: "Requested by: unknown",
  },
  "panel.group.notify_title": {
    fa: "ربات به گروهی اضافه شد و منتظر تأییدته.",
    en: "The bot was added to a group and awaits your approval.",
  },
  "panel.group.name": {
    fa: "نام گروه: {v}",
    en: "Group name: {v}",
  },
  "panel.group.id": {
    fa: "شناسهٔ گروه: {v}",
    en: "Group id: {v}",
  },
  "panel.group.type": {
    fa: "نوع: {v}",
    en: "Type: {v}",
  },
  "panel.chattype.group": {
    fa: "گروه",
    en: "Group",
  },
  "panel.chattype.supergroup": {
    fa: "سوپرگروه",
    en: "Supergroup",
  },
  "panel.chattype.channel": {
    fa: "کانال",
    en: "Channel",
  },
  "panel.group.decided.approve": {
    fa: "دسترسی گروه تأیید شد.",
    en: "Group access approved.",
  },
  "panel.group.decided.reject": {
    fa: "درخواست گروه رد شد.",
    en: "Group request rejected.",
  },
  "panel.group.decided.revoke": {
    fa: "دسترسی گروه لغو شد.",
    en: "Group access revoked.",
  },

  // ---------- AI menu ----------

  "panel.ai.menu_title": {
    fa: "مدیریت هوش مصنوعی",
    en: "AI management",
  },
  "panel.ai.menu_hint": {
    fa: "پروایدرها، مدل‌ها، جایگزین خودکار و جستجوی وب — کدوم بخش؟",
    en: "Providers, models, automatic failover, and web search — which section?",
  },
  "panel.ai.active_line": {
    fa: "✅ فعال: {p} / {m}",
    en: "✅ Active: {p} / {m}",
  },
  "panel.ai.inactive_line": {
    fa: "⚠️ هیچ پروایدر فعالی انتخاب نشده — بات در حالت آزمایشی جواب می‌دهد.",
    en: "⚠️ No active provider selected — the bot answers in test mode.",
  },
  "panel.ai.menu.providers": {
    fa: "پروایدرها",
    en: "Providers",
  },
  "panel.ai.menu.select": {
    fa: "انتخاب پروایدر و مدل فعال",
    en: "Active provider & model",
  },
  "panel.ai.menu.failover": {
    fa: "جایگزین خودکار (Failover)",
    en: "Automatic failover",
  },
  "panel.ai.menu.search": {
    fa: "جستجوی وب",
    en: "Web search",
  },
  "panel.ai.menu.status": {
    fa: "وضعیت عملیاتی",
    en: "Operational status",
  },

  // ---------- failover ----------

  "panel.fo.title": {
    fa: "جایگزین خودکار (Failover)",
    en: "Automatic failover",
  },
  "panel.fo.state": {
    fa: "وضعیت: {v}",
    en: "Status: {v}",
  },
  "panel.fo.state_on": {
    fa: "فعال",
    en: "Enabled",
  },
  "panel.fo.state_off": {
    fa: "غیرفعال (پیش‌فرض)",
    en: "Disabled (default)",
  },
  "panel.fo.max_attempts": {
    fa: "حداکثر تلاش: {n}",
    en: "Max attempts: {n}",
  },
  "panel.fo.timeout": {
    fa: "مدت هر تلاش: {n} میلی‌ثانیه",
    en: "Per-attempt timeout: {n} ms",
  },
  "panel.fo.primary": {
    fa: "انتخاب اصلی: {p} / {m}",
    en: "Primary: {p} / {m}",
  },
  "panel.fo.unset": {
    fa: "تنظیم‌نشده",
    en: "Not set",
  },
  "panel.fo.empty": {
    fa: "جایگزینی تنظیم نشده است.",
    en: "No failover candidates configured.",
  },
  "panel.fo.empty_hint": {
    fa: "با حالت خاموش، درخواست هرگز به پروایدر دیگری نمی‌رود.",
    en: "While disabled, a request never goes to another provider.",
  },
  "panel.fo.list_title": {
    fa: "جایگزین‌ها به ترتیب اولویت:",
    en: "Candidates in priority order:",
  },
  "panel.fo.row": {
    fa: "{i}. {p} / {m}{note}",
    en: "{i}. {p} / {m}{note}",
  },
  "panel.fo.row_disabled_note": {
    fa: " (غیرفعال — تا فعال نشود استفاده نمی‌شود)",
    en: " (disabled — not used until enabled)",
  },
  "panel.fo.skip_note": {
    fa: "در صورت فعال بودن، پروایدرهای غیرفعال نادیده گرفته می‌شوند.",
    en: "When enabled, disabled providers are skipped.",
  },
  "panel.fo.toggle_on": {
    fa: "فعال کردن",
    en: "Enable",
  },
  "panel.fo.toggle_off": {
    fa: "غیرفعال کردن",
    en: "Disable",
  },
  "panel.fo.timeout_btn": {
    fa: "زمان هر تلاش: {n} ثانیه",
    en: "Attempt timeout: {n}s",
  },
  "panel.fo.remove_btn": {
    fa: "حذف {label}",
    en: "Remove {label}",
  },
  "panel.fo.add": {
    fa: "افزودن جایگزین",
    en: "Add candidate",
  },
  "panel.fo.enabled": {
    fa: "جایگزین خودکار فعال شد.",
    en: "Automatic failover enabled.",
  },
  "panel.fo.disabled": {
    fa: "جایگزین خودکار غیرفعال شد.",
    en: "Automatic failover disabled.",
  },
  "panel.fo.need_candidate": {
    fa: "اول یک جایگزین اضافه کن، بعد جایگزین خودکار را فعال کن.",
    en: "Add a candidate first, then enable automatic failover.",
  },
  "panel.fo.attempts_title": {
    fa: "حداکثر تلاش",
    en: "Max attempts",
  },
  "panel.fo.attempts_current": {
    fa: "مقدار فعلی: {n}",
    en: "Current value: {n}",
  },
  "panel.fo.attempts_hint": {
    fa: "عدد جدید را انتخاب کن (۱ تا ۴):",
    en: "Pick a new value (1 to 4):",
  },
  "panel.fo.attempts_set": {
    fa: "حداکثر تلاش {n} شد.",
    en: "Max attempts set to {n}.",
  },
  "panel.fo.timeout_title": {
    fa: "زمان هر تلاش",
    en: "Attempt timeout",
  },
  "panel.fo.timeout_current": {
    fa: "مقدار فعلی: {n} میلی‌ثانیه",
    en: "Current value: {n} ms",
  },
  "panel.fo.timeout_hint": {
    fa: "مقدار جدید را انتخاب کن (۱ تا ۶۰ ثانیه):",
    en: "Pick a new value (1 to 60 seconds):",
  },
  "panel.fo.timeout_set": {
    fa: "زمان هر تلاش {n} میلی‌ثانیه شد.",
    en: "Attempt timeout set to {n} ms.",
  },
  "panel.fo.timeout_sec": {
    fa: "{n}ث",
    en: "{n}s",
  },
  "panel.fo.pick_provider": {
    fa: "پروایدر جایگزین را انتخاب کن:",
    en: "Pick a failover provider:",
  },
  "panel.fo.no_provider": {
    fa: "پروایدر فعالی برای افزودن وجود ندارد.",
    en: "No enabled provider to add.",
  },
  "panel.fo.pick_model": {
    fa: "مدل جایگزین را انتخاب کن:",
    en: "Pick a failover model:",
  },
  "panel.fo.no_model": {
    fa: "این پروایدر مدل فعالی ندارد.",
    en: "This provider has no enabled models.",
  },
  "panel.fo.add_confirm_btn": {
    fa: "تأیید و افزودن",
    en: "Confirm & add",
  },
  "panel.fo.preview_provider": {
    fa: "پروایدر: {v}",
    en: "Provider: {v}",
  },
  "panel.fo.preview_model": {
    fa: "مدل: {v}",
    en: "Model: {v}",
  },
  "panel.fo.preview_hint": {
    fa: "برای افزودن به انتهای فهرست تأیید کن.",
    en: "Confirm to append it to the end of the list.",
  },
  "panel.fo.added": {
    fa: "جایگزین اضافه شد.",
    en: "Candidate added.",
  },
  "panel.fo.add_refused_provider": {
    fa: "پروایدر در دسترس نیست.",
    en: "Provider unavailable.",
  },
  "panel.fo.add_refused_model": {
    fa: "مدل در دسترس نیست.",
    en: "Model unavailable.",
  },
  "panel.fo.add_duplicate": {
    fa: "این جایگزین از قبل در فهرست هست.",
    en: "This candidate is already listed.",
  },
  "panel.fo.removed": {
    fa: "جایگزین حذف شد.",
    en: "Candidate removed.",
  },
  "panel.fo.remove_stale": {
    fa: "این جایگزین دیگر در فهرست نیست.",
    en: "This candidate is no longer listed.",
  },
  "panel.fo.moved": {
    fa: "ترتیب تغییر کرد.",
    en: "Order changed.",
  },
  "panel.fo.move_bad": {
    fa: "جابه‌جایی نامعتبر است.",
    en: "Invalid move.",
  },

  // ---------- local-target exception ----------

  "panel.local.title": {
    fa: "{action} برای «{label}»",
    en: "{action} for “{label}”",
  },
  "panel.local.grant": {
    fa: "اجازهٔ دسترسی محلی",
    en: "Allow local access",
  },
  "panel.local.revoke": {
    fa: "لغو دسترسی محلی",
    en: "Revoke local access",
  },
  "panel.local.warn1": {
    fa: "با این تنظیم، این پروایدر می‌تواند به آدرس‌های داخلی یا خصوصی وصل شود:",
    en: "With this setting, this provider can reach internal or private addresses:",
  },
  "panel.local.ranges": {
    fa: "localhost، 127.0.0.0/8، 10.0.0.0/8، 172.16.0.0/12، 192.168.0.0/16، 169.254.0.0/16",
    en: "localhost, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16",
  },
  "panel.local.warn2": {
    fa: "این تنها برای نصب محلی یک سرویس روی همین ماشین مناسب است.",
    en: "This is only appropriate for a service installed locally on this machine.",
  },
  "panel.local.warn3": {
    fa: "روی سرور عمومی این تنظیم را روشن نکن.",
    en: "Do not enable this on a public server.",
  },
  "panel.local.warn4": {
    fa: "تغییر مسیر (redirect) همیشه مسدود است و با این تنظیم باز نمی‌شود.",
    en: "Redirects stay blocked and are not opened by this setting.",
  },
  "panel.local.current_closed": {
    fa: "وضعیت فعلی: دسترسی محلی بسته است.",
    en: "Current state: local access is closed.",
  },
  "panel.local.confirm_open": {
    fa: "تأیید: دسترسی محلی باز شود",
    en: "Confirm: open local access",
  },
  "panel.local.confirm_close": {
    fa: "تأیید: دسترسی محلی بسته شود",
    en: "Confirm: close local access",
  },
  "panel.local.opened": {
    fa: "دسترسی محلی برای این پروایدر باز شد.",
    en: "Local access opened for this provider.",
  },
  "panel.local.closed": {
    fa: "دسترسی محلی برای این پروایدر بسته شد.",
    en: "Local access closed for this provider.",
  },
  "panel.local.btn_open": {
    fa: "دسترسی محلی: باز",
    en: "Local access: open",
  },
  "panel.local.btn_closed": {
    fa: "دسترسی محلی: بسته",
    en: "Local access: closed",
  },

  // ---------- AI operational status ----------

  "panel.aistatus.title": {
    fa: "وضعیت عملیاتی هوش مصنوعی",
    en: "AI operational status",
  },
  "panel.aistatus.primary": {
    fa: "انتخاب اصلی: {p} / {m}",
    en: "Primary: {p} / {m}",
  },
  "panel.aistatus.fo": {
    fa: "جایگزین: {state} — {n} تنظیم‌شده، {a} آماده",
    en: "Failover: {state} — {n} configured, {a} ready",
  },
  "panel.aistatus.sync": {
    fa: "پیکربندی اجرا با پیکربندی ذخیره‌شده: {v}",
    en: "Runtime config vs stored config: {v}",
  },
  "panel.aistatus.in_sync": {
    fa: "همخوان",
    en: "In sync",
  },
  "panel.aistatus.out_sync": {
    fa: "ناهمخوان",
    en: "Out of sync",
  },
  "panel.aistatus.providers_title": {
    fa: "پروایدرها:",
    en: "Providers:",
  },
  "panel.aistatus.flag_disabled": {
    fa: "غیرفعال",
    en: "disabled",
  },
  "panel.aistatus.flag_nokey": {
    fa: "بدون کلید",
    en: "no key",
  },
  "panel.aistatus.flag_local": {
    fa: "دسترسی محلی",
    en: "local access",
  },
  "panel.aistatus.test_none": {
    fa: "تست: ثبت نشده",
    en: "Test: not recorded",
  },
  "panel.aistatus.test_last": {
    fa: "آخرین تست: {v} — {t}",
    en: "Last test: {v} — {t}",
  },
  "panel.aistatus.test_ok": {
    fa: "موفق",
    en: "ok",
  },
  "panel.aistatus.test_fail": {
    fa: "ناموفق",
    en: "failed",
  },
  "panel.aistatus.probe_all": {
    fa: "تست همهٔ پروایدرها",
    en: "Test all providers",
  },
  "panel.aistatus.probing": {
    fa: "در حال تست همهٔ پروایدرها…",
    en: "Testing all providers…",
  },
  "panel.aistatus.probe_done": {
    fa: "تست همهٔ پروایدرها انجام شد.",
    en: "All providers tested.",
  },
  "panel.aistatus.probe_empty": {
    fa: "پروایدری برای تست وجود ندارد.",
    en: "No providers to test.",
  },

  // ---------- providers ----------

  "panel.providers.empty": {
    fa: "هیچ پروایدری ثبت نشده است.\n\nبرای افزودن پروایدر از دکمهٔ زیر استفاده کن.",
    en: "No providers registered.\n\nUse the button below to add one.",
  },
  "panel.providers.title": {
    fa: "پروایدرها:",
    en: "Providers:",
  },
  "panel.providers.item": {
    fa: "• {label} — {state}\n  اتصال: {adapter}\n  کلید: {key}\n  مدل‌ها: {n}",
    en: "• {label} — {state}\n  Connection: {adapter}\n  Key: {key}\n  Models: {n}",
  },
  "panel.providers.state_on": {
    fa: "فعال",
    en: "enabled",
  },
  "panel.providers.state_off": {
    fa: "غیرفعال",
    en: "disabled",
  },
  "panel.providers.key_set": {
    fa: "تنظیم‌شده",
    en: "set",
  },
  "panel.providers.key_unset": {
    fa: "تنظیم‌نشده",
    en: "not set",
  },
  "panel.providers.add": {
    fa: "افزودن پروایدر",
    en: "Add provider",
  },
  "panel.provider.title": {
    fa: "پروایدر: {label}",
    en: "Provider: {label}",
  },
  "panel.provider.state": {
    fa: "وضعیت: {v}",
    en: "Status: {v}",
  },
  "panel.provider.adapter": {
    fa: "نوع اتصال: {v}",
    en: "Connection type: {v}",
  },
  "panel.provider.key": {
    fa: "کلید: {v}",
    en: "Key: {v}",
  },
  "panel.provider.pool": {
    fa: "کلیدهای پشتیبان: {n}",
    en: "Backup keys: {n}",
  },
  "panel.provider.models": {
    fa: "تعداد مدل‌ها: {n}",
    en: "Model count: {n}",
  },
  "panel.provider.lasttest": {
    fa: "آخرین تست اتصال: {v}{t}",
    en: "Last connection test: {v}{t}",
  },
  "panel.provider.lasttest_none": {
    fa: "آخرین تست اتصال: ثبت نشده",
    en: "Last connection test: not recorded",
  },
  "panel.provider.test_msg": {
    fa: "پیام تست: {v}",
    en: "Test message: {v}",
  },
  "panel.provider.enable": {
    fa: "فعال کردن",
    en: "Enable",
  },
  "panel.provider.disable": {
    fa: "غیرفعال کردن",
    en: "Disable",
  },
  "panel.provider.test": {
    fa: "تست اتصال",
    en: "Test connection",
  },
  "panel.provider.testing": {
    fa: "در حال آزمایش اتصال…",
    en: "Testing connection…",
  },
  "panel.provider.test_ok": {
    fa: "تست اتصال موفق بود.",
    en: "Connection test succeeded.",
  },
  "panel.provider.test_fail": {
    fa: "تست اتصال ناموفق بود.",
    en: "Connection test failed.",
  },
  "panel.provider.models_btn": {
    fa: "مدل‌ها",
    en: "Models",
  },
  "panel.provider.edit_key": {
    fa: "جایگزینی کلید",
    en: "Replace key",
  },
  "panel.provider.pool_key": {
    fa: "کلید پشتیبان",
    en: "Backup key",
  },
  "panel.provider.clear_key": {
    fa: "پاک کردن کلید",
    en: "Clear key",
  },
  "panel.provider.discover": {
    fa: "دریافت مدل‌ها",
    en: "Fetch models",
  },
  "panel.provider.discovering": {
    fa: "در حال دریافت فهرست مدل‌ها…",
    en: "Fetching the model list…",
  },
  "panel.provider.discover_ok": {
    fa: "{n} مدل یافت شد. از فهرست مدل‌ها می‌توانی آن‌ها را اضافه کنی.",
    en: "{n} models found. You can add them from the model list.",
  },
  "panel.provider.discover_fail": {
    fa: "دریافت مدل‌ها ناموفق بود.",
    en: "Fetching models failed.",
  },
  "panel.provider.delete": {
    fa: "حذف پروایدر",
    en: "Delete provider",
  },
  "panel.provider.deleted": {
    fa: "پروایدر حذف شد.",
    en: "Provider deleted.",
  },
  "panel.provider.toggled_on": {
    fa: "پروایدر فعال شد.",
    en: "Provider enabled.",
  },
  "panel.provider.toggled_off": {
    fa: "پروایدر غیرفعال شد.",
    en: "Provider disabled.",
  },
  "panel.provider.key_cleared": {
    fa: "کلید پاک شد.",
    en: "Key cleared.",
  },
  "panel.provider.confirm_delete_q": {
    fa: "حذف پروایدر\n\nآیا «{label}» حذف شود؟\nتعداد مدل‌های آن: {n}\n\nاین عمل برگشت‌ناپذیر است.",
    en: "Delete provider\n\nDelete “{label}”?\nIts models: {n}\n\nThis cannot be undone.",
  },
  "panel.provider.confirm_clear_q": {
    fa: "پاک کردن کلید\n\nکلید «{label}» پاک شود؟\nبعد از پاک شدن، تا کلید جدیدی ثبت نکنی این پروایدر کار نمی‌کند.",
    en: "Clear key\n\nClear the key for “{label}”?\nAfter clearing, this provider won't work until you set a new key.",
  },

  // ---------- add / edit provider flows ----------

  "panel.add.pick_type": {
    fa: "نوع اتصال پروایدر را انتخاب کن:",
    en: "Choose the provider connection type:",
  },
  "panel.add.title": {
    fa: "افزودن پروایدر",
    en: "Add provider",
  },
  "panel.add.instructions": {
    fa: "این پیام را پاسخ بده (reply) و مقادیر را خط‌به‌خط بفرست:",
    en: "Reply to this message and send the values line by line:",
  },
  "panel.add.label_line": {
    fa: "نام نمایشی: <هر نامی که دوست داری>",
    en: "Display name: <any name you like>",
  },
  "panel.add.url_line": {
    fa: "آدرس سرویس: <base URL>",
    en: "Service URL: <base URL>",
  },
  "panel.add.key_line": {
    fa: "کلید API: <کلید شما>",
    en: "API key: <your key>",
  },
  "panel.add.note": {
    fa: "نکته: {v}",
    en: "Note: {v}",
  },
  "panel.add.cancel_hint": {
    fa: "برای لغو، دکمهٔ «لغو» را بزن.",
    en: "To cancel, tap “Cancel”.",
  },
  "panel.add.created": {
    fa: "پروایدر اضافه شد.",
    en: "Provider added.",
  },
  "panel.add.created_name": {
    fa: "نام: {v}",
    en: "Name: {v}",
  },
  "panel.add.created_url": {
    fa: "آدرس: {v}",
    en: "URL: {v}",
  },
  "panel.add.created_key": {
    fa: "کلید: تنظیم شد",
    en: "Key: set",
  },
  "panel.add.junk": {
    fa: "ورودی کامل نیست؛ دوباره با همان قالب بفرست:",
    en: "Input is incomplete; send it again in the same format:",
  },
  "panel.add.bad_url": {
    fa: "آدرس هنوز شامل {ph} است؛ آن را با مقدار واقعی عوض کن.",
    en: "The URL still contains {ph}; replace it with the real value.",
  },
  "panel.edit.title": {
    fa: "ویرایش پروایدر",
    en: "Edit provider",
  },
  "panel.edit.instructions": {
    fa: "این پیام را پاسخ بده (reply) و فقط مقادیر تغییرکرده را بفرست:",
    en: "Reply to this message and send only the changed values:",
  },
  "panel.edit.label_line": {
    fa: "نام نمایشی: {v}",
    en: "Display name: {v}",
  },
  "panel.edit.adapter_line": {
    fa: "نوع اتصال: {v}",
    en: "Connection type: {v}",
  },
  "panel.edit.url_line": {
    fa: "آدرس سرویس: {v}",
    en: "Service URL: {v}",
  },
  "panel.edit.key_line": {
    fa: "کلید API: {v}",
    en: "API key: {v}",
  },
  "panel.edit.key_hint": {
    fa: "برای پاک‌کردن کلید از دکمهٔ مربوط در صفحهٔ پروایدر استفاده کن.",
    en: "To clear the key, use the button on the provider page.",
  },
  "panel.edit.updated": {
    fa: "پروایدر به‌روز شد.",
    en: "Provider updated.",
  },
  "panel.edit.junk": {
    fa: "چیزی برای تغییر پیدا نکردم؛ فقط خط‌هایی که عوض شده را بفرست:",
    en: "Nothing to change; send only the lines that changed:",
  },
  "panel.edit.done_adapter": {
    fa: "نوع اتصال: {v}",
    en: "Connection type: {v}",
  },

  // ---------- backup keys ----------

  "panel.pool.prompt1": {
    fa: "کلید پشتیبان را در پیام بعدی بفرست.",
    en: "Send the backup key in your next message.",
  },
  "panel.pool.prompt2": {
    fa: "این کلید فقط وقتی استفاده می‌شود که کلید اصلی با خطای احراز هویت یا قطعی مواجه شود؛ هیچ‌وقت نمایش داده نمی‌شود.",
    en: "This key is only used when the primary key hits an auth or network failure; it is never displayed.",
  },
  "panel.pool.empty": {
    fa: "کلیدی دریافت نشد؛ دوباره بفرست:",
    en: "No key received; send it again:",
  },
  "panel.pool.saved": {
    fa: "کلید پشتیبان «{label}» ذخیره شد.",
    en: "Backup key “{label}” saved.",
  },
  "panel.pool.unknown_service": {
    fa: "این سرویس شناخته نشده است.",
    en: "Unknown service.",
  },

  // ---------- preset setup ----------

  "panel.setup.key_only": {
    fa: "کلید را بفرست.",
    en: "Send the key.",
  },
  "panel.setup.key_extra": {
    fa: "کلید و {ph} را با کاما بفرست: کلید, مقدار",
    en: "Send the key and {ph} separated by a comma: key, value",
  },
  "panel.setup.junk": {
    fa: "نشد؛ دوباره بفرست:",
    en: "Didn't catch that; send it again:",
  },

  // ---------- models ----------

  "panel.models.title": {
    fa: "مدل‌های پروایدر {label}",
    en: "Models of {label}",
  },
  "panel.models.empty": {
    fa: "هیچ مدلی ثبت نشده است.",
    en: "No models registered.",
  },
  "panel.models.empty_hint": {
    fa: "با دکمهٔ «دریافت مدل‌ها» می‌توانی آن‌ها را بگیری یا دستی اضافه کنی.",
    en: "Fetch them with “Fetch models” or add one manually.",
  },
  "panel.models.row": {
    fa: "• {label}{suffix}\n  شناسه: {id}",
    en: "• {label}{suffix}\n  ID: {id}",
  },
  "panel.models.flag_default": {
    fa: "پیش‌فرض",
    en: "default",
  },
  "panel.models.flag_disabled": {
    fa: "غیرفعال",
    en: "disabled",
  },
  "panel.models.add": {
    fa: "افزودن مدل",
    en: "Add model",
  },
  "panel.models.pick_default": {
    fa: "انتخاب پیش‌فرض",
    en: "Set default",
  },
  "panel.models.default_mark": {
    fa: "پیش‌فرض ✓",
    en: "Default ✓",
  },
  "panel.models.enable": {
    fa: "فعال",
    en: "Enable",
  },
  "panel.models.disable": {
    fa: "غیرفعال",
    en: "Disable",
  },
  "panel.models.delete": {
    fa: "حذف",
    en: "Delete",
  },
  "panel.models.toggled_on": {
    fa: "مدل فعال شد.",
    en: "Model enabled.",
  },
  "panel.models.toggled_off": {
    fa: "مدل غیرفعال شد.",
    en: "Model disabled.",
  },
  "panel.models.deleted": {
    fa: "مدل حذف شد.",
    en: "Model deleted.",
  },
  "panel.models.made_default": {
    fa: "مدل فعال و پیش‌فرض شد.",
    en: "Model is now active and default.",
  },
  "panel.models.confirm_q": {
    fa: "حذف مدل\n\nمدل «{label}» حذف شود؟\n\nاین عمل برگشت‌ناپذیر است.",
    en: "Delete model\n\nDelete model “{label}”?\n\nThis cannot be undone.",
  },
  "panel.models.add_id_line": {
    fa: "شناسهٔ مدل: <شناسه واقعی مدل>",
    en: "Model ID: <the real model id>",
  },
  "panel.models.add_junk": {
    fa: "ورودی کامل نیست؛ شناسه و نام را خط‌به‌خط بفرست:",
    en: "Incomplete input; send the ID and name line by line:",
  },
  "panel.models.added": {
    fa: "مدل «{label}» اضافه شد.",
    en: "Model “{label}” added.",
  },

  // ---------- active provider/model selection ----------

  "panel.select.title": {
    fa: "انتخاب پروایدر و مدل فعال",
    en: "Active provider & model",
  },
  "panel.select.provider": {
    fa: "پروایدر انتخابی: {v}",
    en: "Selected provider: {v}",
  },
  "panel.select.model": {
    fa: "مدل پیش‌فرض: {v}",
    en: "Default model: {v}",
  },
  "panel.select.unset": {
    fa: "تعیین‌نشده",
    en: "Not set",
  },
  "panel.select.pick_model": {
    fa: "مدل فعال پروایدر «{label}» را انتخاب کن:",
    en: "Pick the active model for “{label}”:",
  },
  "panel.select.no_model": {
    fa: " (بدون مدل)",
    en: " (no models)",
  },
  "panel.select.done": {
    fa: "مدل فعال اکنون «{label}» است.",
    en: "The active model is now “{label}”.",
  },

  // ---------- web search ----------

  "panel.search.unavailable": {
    fa: "بخش جستجو در دسترس نیست.",
    en: "Search section is unavailable.",
  },
  "panel.search.title": {
    fa: "جستجوی وب",
    en: "Web search",
  },
  "panel.search.about": {
    fa: "ابزار web_search به مدل اجازه می‌دهد اطلاعات تازه را از وب بخواند.",
    en: "The web_search tool lets the model read fresh information from the web.",
  },
  "panel.search.active": {
    fa: "سرویس فعال: {v}",
    en: "Active service: {v}",
  },
  "panel.search.key": {
    fa: "کلید: {v}",
    en: "Key: {v}",
  },
  "panel.search.key_set": {
    fa: "تنظیم‌شده",
    en: "set",
  },
  "panel.search.key_unset": {
    fa: "تنظیم‌نشده",
    en: "not set",
  },
  "panel.search.key_na": {
    fa: "کلید: لازم نیست",
    en: "Key: not needed",
  },
  "panel.search.ready": {
    fa: "وضعیت: آمادهٔ استفاده. ابزار در اختیار مدل است.",
    en: "Status: ready. The tool is available to the model.",
  },
  "panel.search.not_ready": {
    fa: "وضعیت: قابل استفاده نیست؛ تا تنظیم نشود، ابزار به مدل نشان داده نمی‌شود.",
    en: "Status: not usable; until configured, the tool is hidden from the model.",
  },
  "panel.search.change_key": {
    fa: "تغییر کلید",
    en: "Change key",
  },
  "panel.search.set_key": {
    fa: "تنظیم کلید",
    en: "Set key",
  },
  "panel.search.clear_key": {
    fa: "حذف کلید",
    en: "Delete key",
  },
  "panel.search.pick_fail": {
    fa: "انتخاب سرویس ناموفق بود.",
    en: "Selecting the service failed.",
  },
  "panel.search.key_form": {
    fa: "کلید سرویس جستجو را در پیام بعدی بفرست.",
    en: "Send the search service key in your next message.",
  },
  "panel.search.key_form2": {
    fa: "کلید رمزنگاری‌شده ذخیره می‌شود و هرگز نمایش داده نمی‌شود.",
    en: "The key is stored encrypted and never displayed.",
  },
  "panel.search.key_saved": {
    fa: "کلید {label} ذخیره شد.\n\nوضعیت: تنظیم‌شده",
    en: "Key for {label} saved.\n\nStatus: set",
  },
  "panel.search.key_cleared": {
    fa: "کلید {label} حذف شد.",
    en: "Key for {label} deleted.",
  },
  "panel.search.key_confirm_q": {
    fa: "حذف کلید جستجو\n\nکلید «{label}» پاک شود؟\n\nاین عمل برگشت‌ناپذیر است.",
    en: "Delete search key\n\nDelete the key for “{label}”?\n\nThis cannot be undone.",
  },
  "panel.search.no_key_needed": {
    fa: "{label} به کلید نیازی ندارد.",
    en: "{label} needs no key.",
  },
  "panel.search.key_junk": {
    fa: "کلیدی دریافت نشد؛ دوباره بفرست:",
    en: "No key received; send it again:",
  },

  // ---------- user access ----------

  "panel.users.menu_title": {
    fa: "دسترسی کاربران",
    en: "User access",
  },
  "panel.users.menu_about": {
    fa: "هر کسی که در چت خصوصی به ربات پیام بدهد باید ابتدا تأیید شود؛ تا آن زمان هیچ پاسخی از مدل نمی‌گیرد و به هیچ ابزاری دسترسی ندارد.",
    en: "Anyone who messages the bot in a private chat must be approved first; until then they get no model replies and no tool access.",
  },
  "panel.users.pending_n": {
    fa: "در انتظار تأیید: {n}",
    en: "Pending approval: {n}",
  },
  "panel.users.approved_n": {
    fa: "تأییدشده: {n}",
    en: "Approved: {n}",
  },
  "panel.users.menu_pending": {
    fa: "درخواست‌های دسترسی کاربران",
    en: "User access requests",
  },
  "panel.users.menu_approved": {
    fa: "کاربران تأییدشده",
    en: "Approved users",
  },
  "panel.users.menu_revoke": {
    fa: "لغو دسترسی کاربر",
    en: "Revoke user access",
  },
  "panel.users.pending_empty_more": {
    fa: "درخواست دیگری وجود ندارد.",
    en: "No more requests.",
  },
  "panel.users.pending_empty": {
    fa: "درخواست دسترسی کاربری وجود ندارد.",
    en: "No user access requests.",
  },
  "panel.users.pending_title": {
    fa: "درخواست‌های دسترسی کاربران ({from}–{to} از {total}):",
    en: "User access requests ({from}–{to} of {total}):",
  },
  "panel.users.approved_empty_more": {
    fa: "کاربر تأییدشدهٔ دیگری وجود ندارد.",
    en: "No more approved users.",
  },
  "panel.users.approved_empty": {
    fa: "هیچ کاربر تأییدشده‌ای وجود ندارد.",
    en: "No approved users.",
  },
  "panel.users.approved_title": {
    fa: "کاربران تأییدشده ({from}–{to} از {total}):",
    en: "Approved users ({from}–{to} of {total}):",
  },
  "panel.users.revoke_empty_more": {
    fa: "کاربر بیشتری برای لغو وجود ندارد.",
    en: "No more users to revoke.",
  },
  "panel.users.revoke_empty": {
    fa: "کاربری برای لغو دسترسی وجود ندارد.",
    en: "No users to revoke access from.",
  },
  "panel.users.revoke_title": {
    fa: "کاربری که می‌خوای دسترسی‌ش رو لغو کنی انتخاب کن ({from}–{to} از {total}):",
    en: "Pick the user to revoke access from ({from}–{to} of {total}):",
  },
  "panel.users.notify_title": {
    fa: "یه کاربر ناشناس توی چت خصوصی به ربات پیام داده؛ منتظر تأییدته.",
    en: "An unknown user messaged the bot in a private chat and awaits your approval.",
  },
  "panel.users.notify_id": {
    fa: "شناسهٔ کاربر: {v}",
    en: "User id: {v}",
  },
  "panel.users.notify_name": {
    fa: "نام: {v}",
    en: "Name: {v}",
  },
  "panel.users.notify_username": {
    fa: "نام کاربری: @{v}",
    en: "Username: @{v}",
  },
  "panel.users.notify_hint": {
    fa: "تا تأییدت، این کاربر پاسخی از مدل نمی‌گیره.",
    en: "Until you approve, this user gets no model replies.",
  },
  "panel.users.not_approved": {
    fa: "درخواستت برای مالک ربات فرستاده شد؛ بعد از تأیید می‌تونی گفت‌وگو کنی.",
    en: "Your request was sent to the bot owner. You can chat after approval.",
  },
  "panel.users.revoked": {
    fa: "دسترسی‌ت به این ربات لغو شده.",
    en: "Your access to this bot has been revoked.",
  },
  "panel.users.decided.approve": {
    fa: "دسترسی کاربر تأیید شد.",
    en: "User access approved.",
  },
  "panel.users.decided.reject": {
    fa: "درخواست کاربر رد شد.",
    en: "User request rejected.",
  },
  "panel.users.decided.revoke": {
    fa: "دسترسی کاربر لغو شد.",
    en: "User access revoked.",
  },

  // ---------- misc controller copy ----------

  "panel.ai.op_unsupported": {
    fa: "این عملیات پشتیبانی نمی‌شود.",
    en: "This operation is not supported.",
  },
  "panel.discover.no_provider": {
    fa: "پروایدر یافت نشد.",
    en: "Provider not found.",
  },
  "panel.discover.no_list": {
    fa: "این نوع اتصال فهرست مدل‌ها را پشتیبانی نمی‌کند.",
    en: "This connection type does not support listing models.",
  },
  "panel.discover.no_cred": {
    fa: "اعتبارنامه قابل رمزگشایی نبود.",
    en: "The credential could not be decrypted.",
  },
  "panel.discover.cred_unset": {
    fa: "اعتبارنامه تنظیم نشده است.",
    en: "No credential is set.",
  },
  "panel.discover.unsupported": {
    fa: "دریافت فهرست مدل پشتیبانی نمی‌شود.",
    en: "Fetching the model list is not supported.",
  },
  "panel.discover.failed": {
    fa: "دریافت فهرست مدل ناموفق بود.",
    en: "Fetching the model list failed.",
  },
};

/**
 * Translate a `panel.*` key, substituting `{name}` placeholders from
 * server-side values only — never from raw user text, except through the
 * bounded slots the caller validated upstream (labels, ids, counts).
 */
export function tr(
  lang: PanelLang,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const pack = PANEL_STRINGS[key];
  let text = pack !== undefined ? (pack[lang] ?? pack.fa) : key;
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/**
 * Format a number for the panel language: Persian digits with ٬ grouping in
 * `fa`, Latin digits with comma grouping in `en`.
 */
export function formatNum(n: number, lang: PanelLang): string {
  if (!Number.isFinite(n)) return "0";
  const neg = n < 0 ? "-" : "";
  const grouped = Math.trunc(Math.abs(n)).toLocaleString("en-US");
  if (lang === "en") return `${neg}${grouped}`;
  return `${neg}${grouped.replace(/,/g, "٬").replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)] ?? d)}`;
}

/** Convert Latin digits inside an already-formatted display string (timestamps). */
export function faDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)] ?? d);
}

/** Short, safe rendering of a timestamp, in the panel language's digits. */
export function formatTime(ms: number, lang: PanelLang): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return lang === "fa" ? faDigits(s) : s;
}
