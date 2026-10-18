/**
 * String table for the Hermes-parity system/owner commands (`cmd_system.ts`).
 *
 * Kept as a local module (not wired into `src/i18n/`) so the system-command
 * package stays file-owned and the coordinator can fold it into the global
 * packs later. Key prefix: `cmd_system.*`.
 *
 * User-facing strings: Persian (`fa`) default; English (`en`) fallback.
 */

export type SysLang = "fa" | "en";

const STRINGS: Record<string, Record<SysLang, string>> = {
  "cmd_system.owner_only": {
    fa: "⛔ این دستور فقط برای مالک ربات است.",
    en: "⛔ This command is for the bot owner only.",
  },
  "cmd_system.prefs.unavailable": {
    fa: "❌ ذخیرهٔ تنظیمات در دسترس نیست.",
    en: "❌ Preference store is unavailable.",
  },

  // ---------- /snapshot ----------

  "cmd_system.snapshot.no_db": {
    fa: "❌ مسیر فایل دیتابیس مشخص نیست؛ نمی‌توانم اسنپشات بگیرم.",
    en: "❌ Database file path is unknown; cannot create a snapshot.",
  },
  "cmd_system.snapshot.bad_name": {
    fa: "❌ نام اسنپشات معتبر نیست. فقط حروف انگلیسی، عدد، نقطه، خط‌تیره و زیرخط (حداکثر ۶۴ کاراکتر).",
    en: "❌ Invalid snapshot name. Use ASCII letters, digits, dot, dash or underscore (max 64 chars).",
  },
  "cmd_system.snapshot.created": {
    fa: "✅ اسنپشات «{name}» ساخته شد ({size}).",
    en: "✅ Snapshot “{name}” created ({size}).",
  },
  "cmd_system.snapshot.create_failed": {
    fa: "❌ ساخت اسنپشات ناموفق بود: {reason}",
    en: "❌ Snapshot creation failed: {reason}",
  },
  "cmd_system.snapshot.empty": {
    fa: "📦 هیچ اسنپشاتی ذخیره نشده است.\nبا /snapshot create یکی بساز.",
    en: "📦 No snapshots stored.\nCreate one with /snapshot create.",
  },
  "cmd_system.snapshot.list_title": {
    fa: "📦 اسنپشات‌های ذخیره‌شده:",
    en: "📦 Stored snapshots:",
  },
  "cmd_system.snapshot.list_item": {
    fa: "• {name} — {size} — {when}",
    en: "• {name} — {size} — {when}",
  },
  "cmd_system.snapshot.list_failed": {
    fa: "❌ خواندن پوشهٔ اسنپشات‌ها ناموفق بود: {reason}",
    en: "❌ Could not read the snapshots directory: {reason}",
  },
  "cmd_system.snapshot.not_found": {
    fa: "❌ اسنپشات «{name}» پیدا نشد. فهرست را با /snapshot list ببین.",
    en: "❌ Snapshot “{name}” not found. List them with /snapshot list.",
  },
  "cmd_system.snapshot.turn_running": {
    fa: "⏳ یک گفت‌وگو در حال اجراست؛ بازگردانی اسنپشات ممکن است داده را خراب کند. بعد از اتمام گفت‌وگو دوباره تلاش کن.",
    en: "⏳ A conversation turn is running; restoring a snapshot now could corrupt data. Retry after it finishes.",
  },
  "cmd_system.snapshot.restore_confirm": {
    fa: "⚠️ بازگردانی «{name}» وضعیت فعلی ربات را با این اسنپشات جایگزین می‌کند. این عمل برگشت‌ناپذیر است (مگر اسنپشات دیگری گرفته باشی).\n\nبرای اجرا: /snapshot restore {name} --confirm",
    en: "⚠️ Restoring “{name}” replaces the bot's current state with this snapshot. This is irreversible (unless you have another snapshot).\n\nTo run: /snapshot restore {name} --confirm",
  },
  "cmd_system.snapshot.restored": {
    fa: "✅ اسنپشات «{name}» بازگردانی شد.\n🔁 برای اعمال، ربات را با /restart راه‌اندازی مجدد کن.",
    en: "✅ Snapshot “{name}” restored.\n🔁 Restart the bot with /restart to apply it.",
  },
  "cmd_system.snapshot.restore_failed": {
    fa: "❌ بازگردانی ناموفق بود: {reason}",
    en: "❌ Restore failed: {reason}",
  },
  "cmd_system.snapshot.usage": {
    fa: "📦 استفاده:\n/snapshot create [name]\n/snapshot list\n/snapshot restore <name> --confirm",
    en: "📦 Usage:\n/snapshot create [name]\n/snapshot list\n/snapshot restore <name> --confirm",
  },

  // ---------- /restart ----------

  "cmd_system.restart.turn_running": {
    fa: "⏳ یک گفت‌وگو در حال اجراست. برای راه‌اندازی مجددِ اجباری: /restart --force --confirm",
    en: "⏳ A conversation turn is running. To force a restart: /restart --force --confirm",
  },
  "cmd_system.restart.confirm": {
    fa: "🔁 ربات راه‌اندازی مجدد می‌شود (سرویس systemd آن را بالا می‌آورد).\n\nبرای اجرا: /restart --confirm",
    en: "🔁 The bot will restart (the systemd service brings it back up).\n\nTo run: /restart --confirm",
  },
  "cmd_system.restart.done": {
    fa: "🔁 در حال راه‌اندازی مجدد… برمی‌گردم.",
    en: "🔁 Restarting… I'll be back.",
  },

  // ---------- /update ----------

  "cmd_system.update.no_repo": {
    fa: "❌ پوشهٔ اجرا یک مخزن git نیست؛ به‌روزرسانی خودکار ممکن نیست.",
    en: "❌ The working directory is not a git repository; auto-update is not possible.",
  },
  "cmd_system.update.confirm": {
    fa: "⬆️ این دستور `git pull --ff-only` را روی کد ربات اجرا می‌کند و سپس راه‌اندازی مجدد می‌شود.\n\nبرای اجرا: /update --confirm",
    en: "⬆️ This runs `git pull --ff-only` on the bot code, then restarts.\n\nTo run: /update --confirm",
  },
  "cmd_system.update.failed": {
    fa: "❌ به‌روزرسانی ناموفق بود (راه‌اندازی مجدد انجام نشد):\n{tail}",
    en: "❌ Update failed (no restart performed):\n{tail}",
  },
  "cmd_system.update.ok": {
    fa: "✅ به‌روزرسانی انجام شد؛ راه‌اندازی مجدد…\n{tail}",
    en: "✅ Update done; restarting…\n{tail}",
  },
  "cmd_system.update.error": {
    fa: "❌ خطا در اجرای git: {reason}",
    en: "❌ Error running git: {reason}",
  },

  // ---------- /debug ----------

  "cmd_system.debug.title": {
    fa: "🛠 گزارش اشکال‌زدایی",
    en: "🛠 Debug report",
  },
  "cmd_system.debug.row": {
    fa: "• {label}: {value}",
    en: "• {label}: {value}",
  },
  "cmd_system.debug.unavailable": {
    fa: "سرویس ابزارها وصل نیست؛ گزارش کامل نیست.",
    en: "Tool service is not wired; the report is incomplete.",
  },

  // ---------- /usage & /insights ----------

  "cmd_system.usage.today": {
    fa: "📊 مصرف امروز",
    en: "📊 Usage today",
  },
  "cmd_system.usage.week": {
    fa: "📊 مصرف ۷ روز اخیر",
    en: "📊 Usage last 7 days",
  },
  "cmd_system.usage.tokens": {
    fa: "توکن ورودی: {input} • خروجی: {output} • اجراها: {runs}",
    en: "Input tokens: {input} • output: {output} • runs: {runs}",
  },
  "cmd_system.usage.cost": {
    fa: "هزینهٔ تقریبی: ${cost}",
    en: "Approximate cost: ${cost}",
  },
  "cmd_system.usage.disclaimer": {
    fa: "⚠️ هزینه‌ها تقریبی‌اند و صورتحساب نهایی محسوب نمی‌شوند.",
    en: "⚠️ Costs are approximate and are not the final bill.",
  },
  "cmd_system.usage.by_model": {
    fa: "پر مصرف‌ترین مدل‌ها:",
    en: "Top models:",
  },
  "cmd_system.usage.model_item": {
    fa: "• {model}: {tokens} توکن ({runs} اجرا)",
    en: "• {model}: {tokens} tokens ({runs} runs)",
  },
  "cmd_system.insights.title": {
    fa: "📈 تحلیل مصرف — {days} روز اخیر",
    en: "📈 Usage insights — last {days} days",
  },
  "cmd_system.insights.trend_up": {
    fa: "روند: 📈 صعودی ({pct}% بیشتر از دورهٔ قبل)",
    en: "Trend: 📈 up ({pct}% more than the previous period)",
  },
  "cmd_system.insights.trend_down": {
    fa: "روند: 📉 نزولی ({pct}% کمتر از دورهٔ قبل)",
    en: "Trend: 📉 down ({pct}% less than the previous period)",
  },
  "cmd_system.insights.trend_flat": {
    fa: "روند: ➖ تقریباً بدون تغییر نسبت به دورهٔ قبل",
    en: "Trend: ➖ roughly unchanged vs the previous period",
  },
  "cmd_system.insights.day_item": {
    fa: "• {day}: {tokens} توکن ({runs} اجرا)",
    en: "• {day}: {tokens} tokens ({runs} runs)",
  },

  // ---------- /model ----------

  "cmd_system.model.current": {
    fa: "🤖 مدل فعال: {model}\nپروایدر: {provider}",
    en: "🤖 Active model: {model}\nProvider: {provider}",
  },
  "cmd_system.model.available": {
    fa: "\n\nمدل‌های موجود (نام یا شناسه را با /model بفرست):",
    en: "\n\nAvailable models (send the name or id with /model):",
  },
  "cmd_system.model.item": {
    fa: "• {label} ({id}){mark}",
    en: "• {label} ({id}){mark}",
  },
  "cmd_system.model.active_mark": {
    fa: " — فعال ✅",
    en: " — active ✅",
  },
  "cmd_system.model.not_found": {
    fa: "❌ مدلی با نام «{name}» پیدا نشد. فهرست را با /model ببین.",
    en: "❌ No model named “{name}” found. List them with /model.",
  },
  "cmd_system.model.disabled": {
    fa: "❌ این مدل یا پروایدرش غیرفعال است؛ ابتدا از پنل /ai فعالش کن.",
    en: "❌ This model or its provider is disabled; enable it from the /ai panel first.",
  },
  "cmd_system.model.switched": {
    fa: "✅ مدل فعال اکنون «{label}» است.",
    en: "✅ The active model is now “{label}”.",
  },

  // ---------- /reasoning ----------

  "cmd_system.reasoning.show": {
    fa: "🧠 سطح استدلال مؤثر: {effective}\n(از متغیر محیطی {env} خوانده می‌شود؛ تغییر زنده نیازمند تنظیم آن و راه‌اندازی مجدد است)",
    en: "🧠 Effective reasoning level: {effective}\n(Read from the {env} env var; a live change needs that var set and a restart)",
  },
  "cmd_system.reasoning.stored": {
    fa: "مقدار ذخیره‌شده برای مالک: {value} (هنوز اعمال نشده — فقط متغیر محیطی روی درخواست‌ها اثر دارد)",
    en: "Stored value for the owner: {value} (not applied yet — only the env var affects requests)",
  },
  "cmd_system.reasoning.bad": {
    fa: "❌ مقدار نامعتبره؛ مجاز: off، low، medium یا high",
    en: "❌ Invalid value; allowed: off, low, medium or high",
  },
  "cmd_system.reasoning.set": {
    fa: "✅ سطح استدلال ذخیره شد: {value}\n⚠️ برای اعمال روی درخواست‌ها، متغیر {env} را تنظیم و ربات را راه‌اندازی مجدد کن.",
    en: "✅ Reasoning level stored: {value}\n⚠️ To apply it to requests, set {env} and restart the bot.",
  },

  // ---------- /autoprune ----------

  "cmd_system.autoprune.show_on": {
    fa: "🧹 حذف خودکار نشست‌ها: روشن ✅ (آستانه: {days} روز)\n⚠️ حذف واقعی هنوز کار نمی‌کنه.",
    en: "🧹 Auto-prune sessions: on ✅ (threshold: {days} days)\n⚠️ Actual pruning isn't working yet.",
  },
  "cmd_system.autoprune.show_off": {
    fa: "🧹 حذف خودکار نشست‌ها: خاموش",
    en: "🧹 Auto-prune sessions: off",
  },
  "cmd_system.autoprune.bad": {
    fa: "❌ استفاده: /autoprune on [روز] | /autoprune off — مثال: /autoprune on 30",
    en: "❌ Usage: /autoprune on [days] | /autoprune off — e.g. /autoprune on 30",
  },
  "cmd_system.autoprune.set": {
    fa: "✅ حذف خودکار تنظیم شد: {state}\n⚠️ حذف واقعی هنوز کار نمی‌کنه.",
    en: "✅ Auto-prune set: {state}\n⚠️ Actual pruning isn't working yet.",
  },

  // ---------- /tools ----------

  "cmd_system.tools.unavailable": {
    fa: "❌ سرویس ابزارها در دسترس نیست.",
    en: "❌ Tool service is unavailable.",
  },
  "cmd_system.tools.title": {
    fa: "🧰 ابزارهای ثبت‌شده ({count}):",
    en: "🧰 Registered tools ({count}):",
  },
  "cmd_system.tools.item": {
    fa: "• {name}{toolset}{state}",
    en: "• {name}{toolset}{state}",
  },
  "cmd_system.tools.toolset": {
    fa: " [{toolset}]",
    en: " [{toolset}]",
  },
  "cmd_system.tools.disabled": {
    fa: " (غیرفعال)",
    en: " (disabled)",
  },
  "cmd_system.tools.note": {
    fa: "\nℹ️ فعال/غیرفعال‌کردن ابزار از این دستور پشتیبانی نمی‌شود؛ فقط فهرست.",
    en: "\nℹ️ Enabling/disabling tools is not supported from this command; list-only.",
  },

  // ---------- /skills ----------

  "cmd_system.skills.unavailable": {
    fa: "❌ نه ابزار skills و نه حافظهٔ مهارت‌ها در دسترس نیست.",
    en: "❌ Neither the skills tool nor the skill cache is available.",
  },
  "cmd_system.skills.title": {
    fa: "🎯 مهارت‌های نصب‌شده ({count}):",
    en: "🎯 Installed skills ({count}):",
  },
  "cmd_system.skills.item": {
    fa: "• {name} — {description}",
    en: "• {name} — {description}",
  },

  // ---------- /curator ----------

  "cmd_system.curator.unavailable": {
    fa: "❌ سرویس ابزارها در دسترس نیست؛ نگهداری حافظه ممکن نیست.",
    en: "❌ Tool service is unavailable; memory curation is not possible.",
  },
  "cmd_system.curator.status": {
    fa: "🧠 پیشنهادهای در انتظار نگهدارندهٔ حافظه: {count}",
    en: "🧠 Pending curator proposals: {count}",
  },
  "cmd_system.curator.ran": {
    fa: "✅ بازبینی حافظه اجرا شد؛ {count} پیشنهاد ذخیره شد. بررسی و تأیید از پنل نگهدارنده.",
    en: "✅ Memory review ran; {count} proposals stored. Review and approve from the curator panel.",
  },
  "cmd_system.curator.run_failed": {
    fa: "❌ اجرای بازبینی ناموفق بود: {reason}",
    en: "❌ Review run failed: {reason}",
  },
  "cmd_system.curator.usage": {
    fa: "🧠 استفاده:\n/curator status\n/curator run",
    en: "🧠 Usage:\n/curator status\n/curator run",
  },

  // ---------- /plugins ----------

  "cmd_system.plugins.empty": {
    fa: "🔌 هیچ افزونه‌ای نصب نشده است.",
    en: "🔌 No plugins installed.",
  },
  "cmd_system.plugins.title": {
    fa: "🔌 افزونه‌های نصب‌شده ({count}):",
    en: "🔌 Installed plugins ({count}):",
  },
  "cmd_system.plugins.item": {
    fa: "• {name} (نسخهٔ {version}) — {description}",
    en: "• {name} (v{version}) — {description}",
  },

  // ---------- /reload_mcp & /reload_skills ----------

  "cmd_system.reload_mcp.unavailable": {
    fa: "❌ مدیر MCP وصل نیست؛ بارگذاری مجدد ممکن نیست.",
    en: "❌ MCP manager is not wired; reload is not possible.",
  },
  "cmd_system.reload_mcp.ok": {
    fa: "✅ سرورهای MCP دوباره وصل شدند ({count} سرور فعال).",
    en: "✅ MCP servers reconnected ({count} active).",
  },
  "cmd_system.reload_mcp.failed": {
    fa: "❌ بارگذاری مجدد MCP ناموفق بود: {reason}",
    en: "❌ MCP reload failed: {reason}",
  },
  "cmd_system.reload_skills.unavailable": {
    fa: "❌ حافظهٔ مهارت‌ها وصل نیست.",
    en: "❌ Skill cache is not wired.",
  },
  "cmd_system.reload_skills.ok": {
    fa: "✅ مهارت‌ها بازخوانی شدند ({count} مهارت).",
    en: "✅ Skills rescanned ({count} skills).",
  },

  // ---------- /approve & /deny ----------

  "cmd_system.access.none_pending": {
    fa: "✅ درخواست در انتظاری نیست.",
    en: "✅ No pending requests.",
  },
  "cmd_system.access.pending_title": {
    fa: "📥 درخواست‌های در انتظار:",
    en: "📥 Pending requests:",
  },
  "cmd_system.access.user_item": {
    fa: "• کاربر {id}{name} — برای تأیید: /approve user {id} --confirm | برای رد: /deny user {id} --confirm",
    en: "• user {id}{name} — approve: /approve user {id} --confirm | deny: /deny user {id} --confirm",
  },
  "cmd_system.access.group_item": {
    fa: "• گروه {id}{name} — برای تأیید: /approve group {id} --confirm | برای رد: /deny group {id} --confirm",
    en: "• group {id}{name} — approve: /approve group {id} --confirm | deny: /deny group {id} --confirm",
  },
  "cmd_system.access.bad_target": {
    fa: "❌ هدف معتبر نیست. استفاده: /{cmd} <user|group> <id> --confirm",
    en: "❌ Invalid target. Usage: /{cmd} <user|group> <id> --confirm",
  },
  "cmd_system.access.need_confirm_approve": {
    fa: "برای تأیید {kind} «{id}»: /{cmd} {kind} {id} --confirm",
    en: "To approve {kind} “{id}”: /{cmd} {kind} {id} --confirm",
  },
  "cmd_system.access.need_confirm_deny": {
    fa: "⚠️ برای رد {kind} «{id}»: /{cmd} {kind} {id} --confirm",
    en: "⚠️ To deny {kind} “{id}”: /{cmd} {kind} {id} --confirm",
  },
  "cmd_system.access.approved": {
    fa: "✅ {kind} «{id}» تأیید شد.",
    en: "✅ {kind} “{id}” approved.",
  },
  "cmd_system.access.denied": {
    fa: "🚫 {kind} «{id}» رد شد.",
    en: "🚫 {kind} “{id}” denied.",
  },
  "cmd_system.access.already": {
    fa: "ℹ️ «{id}» در انتظار نیست ({reason}) — تغییری لازم نیست.",
    en: "ℹ️ “{id}” is not pending ({reason}) — nothing to change.",
  },
  "cmd_system.access.usage": {
    fa: "📥 استفاده:\n/approve — فهرست درخواست‌ها\n/approve <user|group> <id> --confirm\n(به‌جای approve می‌توان deny نوشت)",
    en: "📥 Usage:\n/approve — list requests\n/approve <user|group> <id> --confirm\n(use deny instead of approve to reject)",
  },

  // ---------- /sethome ----------

  "cmd_system.sethome.no_prefs": {
    fa: "❌ ذخیرهٔ تنظیمات در دسترس نیست.",
    en: "❌ Preference store is unavailable.",
  },
  "cmd_system.sethome.ok": {
    fa: "✅ این گفت‌وگو به‌عنوان «کانال اصلی» برای اعلان‌های فعال ثبت شد.",
    en: "✅ This chat is now the home chat for proactive notifications.",
  },

  // ---------- /pause ----------

  "cmd_system.pause.on": {
    fa: "⏸ ربات متوقف شد (حالت اضطراری). برای ادامه: /pause off\n⚠️ این پرچم فعلاً روی زمان‌بند و ضربان‌قلب اثر نمی‌ذاره.",
    en: "⏸ Bot paused (emergency mode). To resume: /pause off\n⚠️ This flag doesn't affect the scheduler or heartbeat yet.",
  },
  "cmd_system.pause.off": {
    fa: "▶️ ربات از حالت توقف خارج شد.",
    en: "▶️ Bot resumed.",
  },
  "cmd_system.pause.bad": {
    fa: "❌ استفاده: /pause on | /pause off",
    en: "❌ Usage: /pause on | /pause off",
  },

  // ---------- /ban /unban /mute /unmute ----------

  "cmd_system.restrict.usage": {
    fa: "❌ شناسهٔ عددی کاربر را بده. مثال: /{cmd} 123456",
    en: "❌ Provide the numeric user id. Example: /{cmd} 123456",
  },
  "cmd_system.restrict.bad_target": {
    fa: "❌ شناسهٔ کاربر معتبر نیست؛ فقط عدد.",
    en: "❌ Invalid user id; digits only.",
  },
  "cmd_system.restrict.no_users": {
    fa: "❌ سرویس دسترسی کاربر در دسترس نیست.",
    en: "❌ User access service is unavailable.",
  },
  "cmd_system.restrict.self": {
    fa: "❌ نمی‌توانی خودت را {what} کنی.",
    en: "❌ You cannot {what} yourself.",
  },
  "cmd_system.restrict.failed": {
    fa: "❌ عملیات انجام نشد.",
    en: "❌ The operation failed.",
  },
  "cmd_system.ban.ok": {
    fa: "🚫 کاربر {id} مسدود شد.",
    en: "🚫 User {id} has been blocked.",
  },
  "cmd_system.unban.ok": {
    fa: "✅ مسدودیت کاربر {id} برداشته شد.",
    en: "✅ User {id} has been unblocked.",
  },
  "cmd_system.mute.ok": {
    fa: "🔇 پیام‌های کاربر {id} از این به بعد نادیده گرفته می‌شود.",
    en: "🔇 Messages from user {id} will now be silently ignored.",
  },
  "cmd_system.unmute.ok": {
    fa: "✅ نادیده گرفتن کاربر {id} برداشته شد.",
    en: "✅ User {id} is no longer ignored.",
  },
};

/**
 * Translate a `cmd_system.*` key, substituting `{name}` placeholders from
 * server-side values only — never from raw user text (see the Persian-pack
 * rule: placeholders are filled from values, and user text is passed only
 * through the bounded `{name}` slots already validated upstream).
 */
export function tr(
  lang: SysLang,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const pack = STRINGS[key];
  let text = pack !== undefined ? (pack[lang] ?? pack.fa) : key;
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
