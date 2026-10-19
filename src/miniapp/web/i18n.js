/* BOBI Mini App — bilingual strings (fa ground truth, en mirror).
 *
 * Contract: every section renders through t(key). fa is ground truth; en is
 * its translation. t() falls back fa -> en -> key, so a missing key never
 * crashes a render (it just shows the raw key).
 *
 * OTHER FRONTEND WORKER: you cannot edit this file (not yours). To add keys
 * for your sections, call window.__registerSectionStrings(fa, en)
 * at the top of your section file, e.g.:
 *   __registerSectionStrings({ "memory.clear": "پاک کردن" }, { "memory.clear": "Clear" });
 * It merges into STRINGS before your render() runs.
 */
(function () {
  "use strict";

  const STRINGS = {
    fa: {
      "app.title": "بابی",
      "app.openInTelegram": "این برنامه فقط از داخل تلگرام باز می‌شود",
      "app.openInTelegramSub": "از دکمهٔ منوی ربات وارد شوید",

      "nav.back": "بازگشت",
      "nav.lang": "EN",

      "action.save": "ذخیره",
      "action.cancel": "لغو",
      "action.delete": "حذف",
      "action.confirm": "تأیید",
      "action.close": "بستن",
      "action.add": "افزودن",
      "action.edit": "ویرایش",
      "action.retry": "تلاش مجدد",
      "action.done": "انجام شد",
      "action.probe": "تست اتصال",
      "action.toggleOn": "روشن",
      "action.toggleOff": "خاموش",

      "state.loading": "در حال بارگذاری…",
      "state.empty": "چیزی نیست",
      "state.error": "خطا",
      "state.tryAgain": "دوباره تلاش کن",

      "toast.saved": "ذخیره شد ✓",
      "toast.deleted": "حذف شد",
      "toast.failed": "ناموفق بود، دوباره تلاش کن",
      "toast.copied": "کپی شد",

      "dialog.confirmTitle": "مطمئنی؟",
      "dialog.yes": "بله",
      "dialog.no": "نه",

      "sec.chat": "چت",
      "sec.providers": "پروایدرها",
      "sec.users": "کاربران",
      "sec.memory": "حافظه",
      "sec.benchmarks": "بنچمارک",
      "sec.schedulers": "زمان‌بندها",
      "sec.skills": "مهارت‌ها",
      "sec.usage": "مصرف",
      "sec.tasks": "کارها",
      "sec.groups": "گروه‌ها",

      "chat.placeholder": "هر دستوری بنویس… مثلاً /model",
      "chat.send": "ارسال",
      "chat.hint": "دسترسی کامل: هر دستوری که در چت ربات کار می‌کند، اینجا هم کار می‌کند.",
      "chat.typing": "بابی دارد می‌نویسد…",
      "chat.failed": "ارسال ناموفق بود",

      "prov.add": "افزودن پروایدر",
      "prov.models": "مدل‌ها",
      "prov.noKey": "بدون کلید",
      "prov.hasKey": "کلید ثبت شده",
      "prov.enabled": "فعال",
      "prov.disabled": "غیرفعال",
      "prov.statusOk": "سالم",
      "prov.statusErr": "خطادار",
      "prov.statusUnknown": "تست نشده",
      "prov.lastProbe": "آخرین تست",
      "prov.tabPreset": "پیش‌فرض‌ها",
      "prov.tabCustom": "سفارشی",
      "prov.tabNine": "9Router",
      "prov.label": "نام",
      "prov.key": "کلید API",
      "prov.keyPlaceholder": "کلید را اینجا وارد کن",
      "prov.url": "آدرس پایه (Base URL)",
      "prov.urlInvalid": "آدرس معتبر نیست؛ باید با http:// یا https:// شروع شود",
      "prov.modelId": "شناسهٔ مدل",
      "prov.probeOk": "اتصال موفق ✓",
      "prov.probeFail": "اتصال ناموفق ✗",
      "prov.setKey": "ثبت کلید",
      "prov.replaceKey": "تعویض کلید",
      "prov.clearKey": "حذف کلید",
      "prov.clearKeyConfirm": "کلید این پروایدر حذف شود؟",
      "prov.deleteConfirm": "این پروایدر حذف شود؟",
      "prov.discover": "کشف مدل‌ها",
      "prov.discovering": "در حال کشف…",
      "prov.importSelected": "وارد کردن انتخاب‌شده‌ها",
      "prov.manualAdd": "افزودن دستی مدل",
      "prov.setActive": "فعال‌سازی",
      "prov.active": "فعال",
      "prov.noModels": "مدلی ثبت نشده",
      "prov.addProviderTitle": "پروایدر جدید",
      "prov.presetNote": "فقط نام و کلید لازم است؛ بقیه از پیش‌فرض پر می‌شود.",
      "prov.deleteModelConfirm": "این مدل حذف شود؟",
      "prov.optional": "اختیاری",
      "prov.ms": "میلی‌ثانیه",
      "prov.keyRequired": "اول کلید API رو وارد کن.",
      "prov.accountId": "شناسهٔ حساب",
      "prov.accountIdRequired": "مقدار جایگزین (مثلاً Account ID) لازم است.",
      "prov.draftModelsHint": "با همین کلید و آدرس، لیست مدل‌های این پروایدر رو می‌گیرم — تیک بزن کدوم‌ها فعال بشن.",
      "prov.fetchModels": "🔍 دریافت مدل‌ها",
      "prov.fetchingModels": "در حال دریافت…",
      "prov.noModelsFound": "مدلی پیدا نشد؛ شناسه رو دستی وارد کن.",
      "prov.selectAll": "همه",
      "prov.selectNone": "هیچ‌کدام",
      "prov.manualModelId": "شناسهٔ مدل دستی",
      "prov.manualModelHint": "اگه مدلی توی لیست نیست، شناسه‌ش رو خودت بنویس.",
      "prov.addManual": "➕ افزودن",
      "prov.modelsSelected": "مدل انتخاب شد",

      "users.ban": "مسدود",
      "users.unban": "رفع مسدودیت",
      "users.banned": "مسدود شده",
      "users.banConfirm": "این کاربر مسدود شود؟",
      "users.unbanConfirm": "مسدودیت این کاربر برداشته شود؟",
      "users.note": "یادداشت",
      "users.empty": "کاربری ثبت نشده",
      "users.bannedFilter": "مسدودها",
    },
    en: {
      "app.title": "BOBI",
      "app.openInTelegram": "Open this app from Telegram",
      "app.openInTelegramSub": "Use the bot's menu button to enter",

      "nav.back": "Back",
      "nav.lang": "فارسی",

      "action.save": "Save",
      "action.cancel": "Cancel",
      "action.delete": "Delete",
      "action.confirm": "Confirm",
      "action.close": "Close",
      "action.add": "Add",
      "action.edit": "Edit",
      "action.retry": "Retry",
      "action.done": "Done",
      "action.probe": "Test connection",
      "action.toggleOn": "On",
      "action.toggleOff": "Off",

      "state.loading": "Loading…",
      "state.empty": "Nothing here",
      "state.error": "Error",
      "state.tryAgain": "Try again",

      "toast.saved": "Saved ✓",
      "toast.deleted": "Deleted",
      "toast.failed": "Failed, try again",
      "toast.copied": "Copied",

      "dialog.confirmTitle": "Are you sure?",
      "dialog.yes": "Yes",
      "dialog.no": "No",

      "sec.chat": "Chat",
      "sec.providers": "Providers",
      "sec.users": "Users",
      "sec.memory": "Memory",
      "sec.benchmarks": "Benchmarks",
      "sec.schedulers": "Schedulers",
      "sec.skills": "Skills",
      "sec.usage": "Usage",
      "sec.tasks": "Tasks",
      "sec.groups": "Groups",

      "chat.placeholder": "Type anything… e.g. /model",
      "chat.send": "Send",
      "chat.hint": "Full access: any command that works in the bot chat works here too.",
      "chat.typing": "BOBI is typing…",
      "chat.failed": "Send failed",

      "prov.add": "Add provider",
      "prov.models": "Models",
      "prov.noKey": "No key",
      "prov.hasKey": "Key set",
      "prov.enabled": "Enabled",
      "prov.disabled": "Disabled",
      "prov.statusOk": "Healthy",
      "prov.statusErr": "Error",
      "prov.statusUnknown": "Untested",
      "prov.lastProbe": "Last probe",
      "prov.tabPreset": "Presets",
      "prov.tabCustom": "Custom",
      "prov.tabNine": "9Router",
      "prov.label": "Label",
      "prov.key": "API key",
      "prov.keyPlaceholder": "Paste the key here",
      "prov.url": "Base URL",
      "prov.urlInvalid": "Invalid URL; must start with http:// or https://",
      "prov.modelId": "Model ID",
      "prov.probeOk": "Connection OK ✓",
      "prov.probeFail": "Connection failed ✗",
      "prov.setKey": "Set key",
      "prov.replaceKey": "Replace key",
      "prov.clearKey": "Remove key",
      "prov.clearKeyConfirm": "Remove this provider's key?",
      "prov.deleteConfirm": "Delete this provider?",
      "prov.discover": "Discover models",
      "prov.discovering": "Discovering…",
      "prov.importSelected": "Import selected",
      "prov.manualAdd": "Add model manually",
      "prov.setActive": "Set active",
      "prov.active": "Active",
      "prov.noModels": "No models added",
      "prov.addProviderTitle": "New provider",
      "prov.presetNote": "Only label and key needed; the rest is pre-filled.",
      "prov.deleteModelConfirm": "Delete this model?",
      "prov.optional": "optional",
      "prov.ms": "ms",
      "prov.keyRequired": "Enter the API key first.",
      "prov.accountId": "Account ID",
      "prov.accountIdRequired": "The placeholder value (e.g. Account ID) is required.",
      "prov.draftModelsHint": "Using this key and URL, I'll fetch this provider's model list — tick the ones to enable.",
      "prov.fetchModels": "🔍 Fetch models",
      "prov.fetchingModels": "Fetching…",
      "prov.noModelsFound": "No models found; enter the ID manually.",
      "prov.selectAll": "All",
      "prov.selectNone": "None",
      "prov.manualModelId": "Manual model ID",
      "prov.manualModelHint": "If a model isn't in the list, type its ID yourself.",
      "prov.addManual": "➕ Add",
      "prov.modelsSelected": "models selected",

      "users.ban": "Ban",
      "users.unban": "Unban",
      "users.banned": "Banned",
      "users.banConfirm": "Ban this user?",
      "users.unbanConfirm": "Unban this user?",
      "users.note": "Note",
      "users.empty": "No users yet",
      "users.bannedFilter": "Banned",
    },
  };

  let lang = "fa";

  function t(key) {
    const table = STRINGS[lang] || {};
    if (table[key] !== undefined) return table[key];
    const en = STRINGS.en || {};
    if (en[key] !== undefined) return en[key];
    return key;
  }

  function setLang(l) {
    lang = l === "en" ? "en" : "fa";
    const html = document.documentElement;
    html.setAttribute("lang", lang);
    html.setAttribute("dir", lang === "fa" ? "rtl" : "ltr");
    try {
      localStorage.setItem("bobi-miniapp-lang", lang);
    } catch (_) {}
  }

  function getLang() {
    return lang;
  }

  function detectLang() {
    try {
      const saved = localStorage.getItem("bobi-miniapp-lang");
      if (saved === "fa" || saved === "en") return saved;
    } catch (_) {}
    try {
      const code =
        (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe &&
          window.Telegram.WebApp.initDataUnsafe.user &&
          window.Telegram.WebApp.initDataUnsafe.user.language_code) || "";
      return code.toLowerCase().startsWith("fa") ? "fa" : "en";
    } catch (_) {
      return "fa";
    }
  }

  // For the other frontend worker: merge extra section strings.
  function registerSectionStrings(fa, en) {
    for (const k of Object.keys(fa || {})) {
      if (STRINGS.fa[k] === undefined) STRINGS.fa[k] = fa[k];
    }
    for (const k of Object.keys(en || {})) {
      if (STRINGS.en[k] === undefined) STRINGS.en[k] = en[k];
    }
  }

  setLang(detectLang());

  window.__STRINGS = STRINGS;
  window.__registerSectionStrings = registerSectionStrings;
  window.I18N = { t: t, setLang: setLang, getLang: getLang, detectLang: detectLang };
})();
