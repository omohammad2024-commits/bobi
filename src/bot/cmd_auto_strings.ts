/**
 * Persian/English strings for the Hermes-parity automation commands
 * (`src/bot/cmd_auto.ts`).
 *
 * Kept in a module-local dictionary (NOT in `src/i18n/`) because the
 * coordinator owns the i18n fold-in — this file is the source it merges from.
 * Every key is prefixed `cmd_auto.*`.
 */

/** UI languages supported by these commands. */
export type AutoLang = "fa" | "en";

type Vars = Record<string, string | number>;

const fa: Record<string, string> = {
  "cmd_auto.owner_only": "این دستور فقط برای مالک است.",
  "cmd_auto.need_tools": "سرویس ابزارها در دسترس نیست؛ این دستور فعلاً کار نمی‌کند.",
  "cmd_auto.tool_failed": "اجرای ابزار ناموفق بود.",
  "cmd_auto.engine_failed": "اجرای گفتگو ناموفق بود؛ بعداً تلاش کن.",
  "cmd_auto.empty_prompt": "متن دستور خالی است.",
  "cmd_auto.bad_args": "آرگومان نامعتبر است. راهنما: {hint}",

  "cmd_auto.bg.queued": "در پس‌زمینه شروع شد. شناسه: {id}",
  "cmd_auto.bg.busy": "حداکثر ۳ کار هم‌زمان؛ صبر کن یکی تمام شود.",
  "cmd_auto.bg.too_long": "متن حداکثر ۲۰۰۰ کاراکتر می‌تواند باشد.",
  "cmd_auto.bg.list_empty": "کار پس‌زمینه‌ای نداری.",
  "cmd_auto.bg.list_item": "{id} — {status} — {prompt}",
  "cmd_auto.bg.cancelled": "کار {id} لغو شد.",
  "cmd_auto.bg.not_found": "کاری با شناسهٔ {id} پیدا نشد.",
  "cmd_auto.bg.cancel_usage": "استفاده: /bg cancel <id> یا /bg list",
  "cmd_auto.bg.status.running": "در حال اجرا",
  "cmd_auto.bg.status.done": "تمام شد",
  "cmd_auto.bg.status.failed": "ناموفق",
  "cmd_auto.bg.status.cancelled": "لغو شد",
  "cmd_auto.bg.done_prefix": "نتیجهٔ کار پس‌زمینهٔ {id}:\n\n",
  "cmd_auto.bg.failed_note": "کار پس‌زمینهٔ {id} ناموفق بود: {error}",
  "cmd_auto.bg.help": "استفاده: /bg <دستور> | /bg list | /bg cancel <id>",

  "cmd_auto.btw.thread_kept": "این پرسش در یک گفتگوی جداگانه پاسخ داده شد (شناسه: {id}) و همان‌جا نگه داشته شد؛ رشتهٔ اصلی دست‌نخورده ماند.",

  "cmd_auto.queue.added": "به صف اضافه شد (مورد {n}).",
  "cmd_auto.queue.full": "صف پر است (حداکثر {max} مورد).",
  "cmd_auto.queue.empty": "صف خالی است.",
  "cmd_auto.queue.item": "{n}. {text}",
  "cmd_auto.queue.cleared": "صف پاک شد ({n} مورد حذف شد).",
  "cmd_auto.queue.note":
    "یادداشت: تخلیهٔ خودکار صف به پیام بعدی نیازمند اتصال به موتور گفتگوست (در دست پیگیری)؛ فعلاً موارد را دستی کپی کن.",
  "cmd_auto.queue.help": "استفاده: /queue <متن> | /queue list | /queue clear",

  "cmd_auto.steer.pending": "راهنمایی ثبت شد و با پیام بعدی شما اعمال می‌شود.",
  "cmd_auto.steer.applied": "در حال اجرای فوری با راهنمایی شما…",
  "cmd_auto.steer.note":
    "یادداشت: تزریق خودکار به پیام بعدی نیازمند اتصال به موتور گفتگوست (در دست پیگیری).",
  "cmd_auto.steer.help": "استفاده: /steer <راهنمایی>",

  "cmd_auto.agents.title": "ایجنت‌های فعال:",
  "cmd_auto.agents.none": "چیز فعالی نیست.",
  "cmd_auto.agents.bg_item": "• کار پس‌زمینهٔ {id}: {status}",
  "cmd_auto.agents.running": "• یک گفتگو در این چت در حال اجراست.",
  "cmd_auto.agents.delegate": "• ابزار delegate در دسترس است.",
  "cmd_auto.agents.steer_item": "• راهنمای در انتظار: {text}",

  "cmd_auto.goal.set": "هدف ثبت شد: {title} (شناسه: {id})",
  "cmd_auto.goal.show_empty": "هدفی ثبت نشده است.",
  "cmd_auto.goal.item": "#{id} [{status}] {title}",
  "cmd_auto.goal.cleared": "{n} هدف فعال کامل شد.",
  "cmd_auto.goal.help": "استفاده: /goal set <متن> | /goal show | /goal clear",

  "cmd_auto.subgoal.added": "زیرهدف ثبت شد: {title} (شناسه: {id})",
  "cmd_auto.subgoal.parent_missing": "هدف والدی با شناسهٔ {id} پیدا نشد.",
  "cmd_auto.subgoal.list_empty": "زیرهدفی پیدا نشد.",
  "cmd_auto.subgoal.item": "#{id} [{status}] {title}",
  "cmd_auto.subgoal.cleared": "{n} زیرهدف کامل شد.",
  "cmd_auto.subgoal.help": "استفاده: /subgoal add <شناسهٔ والد> <متن> | /subgoal list [شناسهٔ والد] | /subgoal clear <شناسهٔ والد>",

  "cmd_auto.hb.status_on": "ضربان (heartbeat) فعال است؛ فاصله: {interval}.",
  "cmd_auto.hb.status_off": "ضربان (heartbeat) غیرفعال است.",
  "cmd_auto.hb.status_unknown": "وضعیت سرویس ضربان از اینجا مشخص نیست.",
  "cmd_auto.hb.tasks": "یادآورهای ضربان زمان‌بندی‌شده: {n} مورد.",
  "cmd_auto.hb.created": "یادآور دوره‌ای ساخته شد (وظیفهٔ {id}، هر {interval}).",
  "cmd_auto.hb.bad_interval": "فاصله نامعتبر است؛ مثلاً: 30m یا 2h یا 1d",
  "cmd_auto.hb.help": "استفاده: /heartbeat status | /heartbeat every <فاصله> <متن>",

  "cmd_auto.loop.created": "حلقه ساخته شد (وظیفهٔ {id}، هر {interval}).",
  "cmd_auto.loop.stopped": "حلقهٔ {id} متوقف شد.",
  "cmd_auto.loop.not_found": "وظیفه‌ای با شناسهٔ {id} پیدا نشد.",
  "cmd_auto.loop.bad_id": "شناسه نامعتبر است.",
  "cmd_auto.loop.help": "استفاده: /loop every <فاصله> <متن> | /loop stop <id>",

  "cmd_auto.cron.list_empty": "وظیفهٔ زمان‌بندی‌شده‌ای نیست.",
  "cmd_auto.cron.item": "#{id} — {name} ({cron}، {tz})",
  "cmd_auto.cron.added": "وظیفه ساخته شد (شناسه: {id}، اجرای بعدی: {next}).",
  "cmd_auto.cron.help": "استفاده: /cron list | /cron add <عبارت کرون> <متن>",

  "cmd_auto.sug.title": "پیشنهادهای اتوماسیون (ابتکاری):",
  "cmd_auto.sug.none": "سیگنال مشخصی در پیام‌های اخیر پیدا نشد.",
  "cmd_auto.sug.item": "• {text} ← {cmd}",

  "cmd_auto.bp.list_title": "قالب‌های آماده:",
  "cmd_auto.bp.item": "• {name}: {desc}",
  "cmd_auto.bp.unknown": "قالب «{name}» پیدا نشد. قالب‌ها: {names}",
  "cmd_auto.bp.created_task": "قالب «{name}» ساخته شد (وظیفهٔ {id}).",
  "cmd_auto.bp.created_reminder": "یادآور تنظیم شد؛ {minutes} دقیقهٔ دیگر یادآوری می‌کنم.",
  "cmd_auto.bp.owner_only_tool": "این قالب به ابزار زمان‌بندی نیاز دارد که فقط مالک می‌تواند بسازد.",
  "cmd_auto.bp.bad_args": "آرگومان قالب نامعتبر است. راهنما: {hint}",
  "cmd_auto.bp.help": "استفاده: /blueprint list | /blueprint run <نام> [آرگومان‌ها]",

  "cmd_auto.refine.working": "در حال بازبینی گفتگو و استخراج درس‌ها…",
  "cmd_auto.refine.no_history": "تاریخچه‌ای برای بازبینی پیدا نشد.",

  "cmd_auto.review.failed": "بازبینی ناموفق بود: {error}",

  "cmd_auto.moa.models": "\n\nمدل‌های مشورت‌شده: {models}",

  "cmd_auto.mem.empty": "حافظه‌ای ذخیره نشده است.",
  "cmd_auto.mem.item": "• {key}: {content}",
  "cmd_auto.mem.deleted": "حافظهٔ «{key}» پاک شد.",
  "cmd_auto.mem.not_found": "حافظه‌ای با کلید «{key}» پیدا نشد.",
  "cmd_auto.mem.help": "استفاده: /memory list [n] | /memory search <عبارت> | /memory del <کلید>",

  "cmd_auto.learn.bad_name": "نام مهارت نامعتبر است؛ فقط حروف کوچک انگلیسی، عدد و خط تیره (مثل my-skill).",
  "cmd_auto.learn.ready": "پیش‌نویس مهارت «{name}» آماده شد؛ فایل را در پوشهٔ مهارت‌ها بگذار.",
  "cmd_auto.learn.place_note": "یادداشت: نوشتن مستقیم در پوشهٔ مهارت‌ها از اینجا انجام نمی‌شود؛ فایل پیوست را ذخیره کن.",
  "cmd_auto.learn.help": "استفاده: /learn <نام> | <توضیح>",

  "cmd_auto.bundles.title": "بسته‌های پیشنهادی مهارت:",
  "cmd_auto.bundles.item": "• {name}: {tools}\n  {desc}",
  "cmd_auto.bundles.unknown": "بستهٔ «{name}» پیدا نشد. بسته‌ها: {names}",
  "cmd_auto.bundles.used": "بستهٔ «{name}» به‌عنوان جعبه‌ابزار فعال شما ذخیره شد (توصیه‌ای؛ فیلتر ابزارها هنوز آن را اعمال نمی‌کند).",
  "cmd_auto.bundles.no_prefs": "ذخیرهٔ ترجیحات در دسترس نیست.",
  "cmd_auto.bundles.help": "استفاده: /bundles list | /bundles use <نام>",
};

const en: Record<string, string> = {
  "cmd_auto.owner_only": "This command is owner-only.",
  "cmd_auto.need_tools": "The tool service is unavailable; this command cannot run right now.",
  "cmd_auto.tool_failed": "Tool execution failed.",
  "cmd_auto.engine_failed": "Conversation run failed; try again later.",
  "cmd_auto.empty_prompt": "The prompt is empty.",
  "cmd_auto.bad_args": "Invalid arguments. Hint: {hint}",

  "cmd_auto.bg.queued": "Started in the background. ID: {id}",
  "cmd_auto.bg.busy": "Max 3 concurrent tasks; wait for one to finish.",
  "cmd_auto.bg.too_long": "Text can be at most 2000 characters.",
  "cmd_auto.bg.list_empty": "You have no background tasks.",
  "cmd_auto.bg.list_item": "{id} — {status} — {prompt}",
  "cmd_auto.bg.cancelled": "Task {id} cancelled.",
  "cmd_auto.bg.not_found": "No task with ID {id}.",
  "cmd_auto.bg.cancel_usage": "Usage: /bg cancel <id> or /bg list",
  "cmd_auto.bg.status.running": "running",
  "cmd_auto.bg.status.done": "done",
  "cmd_auto.bg.status.failed": "failed",
  "cmd_auto.bg.status.cancelled": "cancelled",
  "cmd_auto.bg.done_prefix": "Background task {id} result:\n\n",
  "cmd_auto.bg.failed_note": "Background task {id} failed: {error}",
  "cmd_auto.bg.help": "Usage: /bg <prompt> | /bg list | /bg cancel <id>",

  "cmd_auto.btw.thread_kept": "Answered in a separate thread (ID: {id}) which is kept; the main thread is untouched.",

  "cmd_auto.queue.added": "Queued (item {n}).",
  "cmd_auto.queue.full": "Queue is full (max {max} items).",
  "cmd_auto.queue.empty": "Queue is empty.",
  "cmd_auto.queue.item": "{n}. {text}",
  "cmd_auto.queue.cleared": "Queue cleared ({n} items removed).",
  "cmd_auto.queue.note":
    "Note: auto-draining into your next message needs an engine hook (being followed up); for now copy items manually.",
  "cmd_auto.queue.help": "Usage: /queue <text> | /queue list | /queue clear",

  "cmd_auto.steer.pending": "Guidance saved; it will apply to your next message.",
  "cmd_auto.steer.applied": "Running immediately with your guidance…",
  "cmd_auto.steer.note":
    "Note: auto-injection into the next message needs an engine hook (being followed up).",
  "cmd_auto.steer.help": "Usage: /steer <guidance>",

  "cmd_auto.agents.title": "Active agents:",
  "cmd_auto.agents.none": "Nothing is active.",
  "cmd_auto.agents.bg_item": "• background task {id}: {status}",
  "cmd_auto.agents.running": "• a turn is running in this chat.",
  "cmd_auto.agents.delegate": "• the delegate tool is available.",
  "cmd_auto.agents.steer_item": "• pending steer: {text}",

  "cmd_auto.goal.set": "Goal saved: {title} (ID: {id})",
  "cmd_auto.goal.show_empty": "No goals saved.",
  "cmd_auto.goal.item": "#{id} [{status}] {title}",
  "cmd_auto.goal.cleared": "{n} active goals completed.",
  "cmd_auto.goal.help": "Usage: /goal set <text> | /goal show | /goal clear",

  "cmd_auto.subgoal.added": "Subgoal saved: {title} (ID: {id})",
  "cmd_auto.subgoal.parent_missing": "No parent goal with ID {id}.",
  "cmd_auto.subgoal.list_empty": "No subgoals found.",
  "cmd_auto.subgoal.item": "#{id} [{status}] {title}",
  "cmd_auto.subgoal.cleared": "{n} subgoals completed.",
  "cmd_auto.subgoal.help": "Usage: /subgoal add <parent-id> <text> | /subgoal list [parent-id] | /subgoal clear <parent-id>",

  "cmd_auto.hb.status_on": "Heartbeat is enabled; interval: {interval}.",
  "cmd_auto.hb.status_off": "Heartbeat is disabled.",
  "cmd_auto.hb.status_unknown": "Heartbeat service status is not visible from here.",
  "cmd_auto.hb.tasks": "Scheduled heartbeat reminders: {n}.",
  "cmd_auto.hb.created": "Periodic reminder created (task {id}, every {interval}).",
  "cmd_auto.hb.bad_interval": "Invalid interval; e.g. 30m, 2h, 1d",
  "cmd_auto.hb.help": "Usage: /heartbeat status | /heartbeat every <interval> <text>",

  "cmd_auto.loop.created": "Loop created (task {id}, every {interval}).",
  "cmd_auto.loop.stopped": "Loop {id} stopped.",
  "cmd_auto.loop.not_found": "No task with ID {id}.",
  "cmd_auto.loop.bad_id": "Invalid ID.",
  "cmd_auto.loop.help": "Usage: /loop every <interval> <text> | /loop stop <id>",

  "cmd_auto.cron.list_empty": "No scheduled tasks.",
  "cmd_auto.cron.item": "#{id} — {name} ({cron}, {tz})",
  "cmd_auto.cron.added": "Task created (ID: {id}, next run: {next}).",
  "cmd_auto.cron.help": "Usage: /cron list | /cron add <cron-expr> <text>",

  "cmd_auto.sug.title": "Automation suggestions (heuristic):",
  "cmd_auto.sug.none": "No clear signal in recent messages.",
  "cmd_auto.sug.item": "• {text} ← {cmd}",

  "cmd_auto.bp.list_title": "Available blueprints:",
  "cmd_auto.bp.item": "• {name}: {desc}",
  "cmd_auto.bp.unknown": "Unknown blueprint “{name}”. Blueprints: {names}",
  "cmd_auto.bp.created_task": "Blueprint “{name}” created (task {id}).",
  "cmd_auto.bp.created_reminder": "Reminder set; I’ll remind you in {minutes} minutes.",
  "cmd_auto.bp.owner_only_tool": "This blueprint needs the scheduler tool, which only the owner can create.",
  "cmd_auto.bp.bad_args": "Invalid blueprint arguments. Hint: {hint}",
  "cmd_auto.bp.help": "Usage: /blueprint list | /blueprint run <name> [args]",

  "cmd_auto.refine.working": "Reviewing the conversation and extracting lessons…",
  "cmd_auto.refine.no_history": "No history found to review.",

  "cmd_auto.review.failed": "Review failed: {error}",

  "cmd_auto.moa.models": "\n\nConsulted models: {models}",

  "cmd_auto.mem.empty": "No memories stored.",
  "cmd_auto.mem.item": "• {key}: {content}",
  "cmd_auto.mem.deleted": "Memory “{key}” deleted.",
  "cmd_auto.mem.not_found": "No memory with key “{key}”.",
  "cmd_auto.mem.help": "Usage: /memory list [n] | /memory search <query> | /memory del <key>",

  "cmd_auto.learn.bad_name": "Invalid skill name; lowercase English letters, digits and dashes only (e.g. my-skill).",
  "cmd_auto.learn.ready": "Skill draft “{name}” is ready; place the file in the skills folder.",
  "cmd_auto.learn.place_note": "Note: writing directly to the skills folder is not done from here; save the attached file.",
  "cmd_auto.learn.help": "Usage: /learn <name> | <description>",

  "cmd_auto.bundles.title": "Suggested skill bundles:",
  "cmd_auto.bundles.item": "• {name}: {tools}\n  {desc}",
  "cmd_auto.bundles.unknown": "Unknown bundle “{name}”. Bundles: {names}",
  "cmd_auto.bundles.used": "Bundle “{name}” saved as your active toolkit (advisory; the tool filter does not honor it yet).",
  "cmd_auto.bundles.no_prefs": "Preference storage is unavailable.",
  "cmd_auto.bundles.help": "Usage: /bundles list | /bundles use <name>",
};

const DICTS: Record<AutoLang, Record<string, string>> = { fa, en };

/**
 * Translate a `cmd_auto.*` key, substituting `{vars}`.
 * Falls back to Persian, then to the key itself — never throws.
 */
export function tr(lang: AutoLang, key: string, vars?: Vars): string {
  const dict = DICTS[lang] ?? fa;
  let s = dict[key] ?? fa[key] ?? key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
