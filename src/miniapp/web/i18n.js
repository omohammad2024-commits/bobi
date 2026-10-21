/* BOBI Mini App — English-only strings.
 *
 * Contract: every section renders through t(key). English is the only
 * language. t() falls back to the raw key so a missing key never crashes
 * a render (it just shows the key).
 *
 * Sections add their own keys by calling window.__registerSectionStrings(en)
 * at the top of the section file, e.g.:
 *   __registerSectionStrings({ "memory.clear": "Clear" });
 * It merges into STRINGS before the section's render() runs.
 */
(function () {
  "use strict";

  const STRINGS = {
      "app.title": "BOBI",
      "app.openInTelegram": "Open this app from Telegram",
      "app.openInTelegramSub": "Use the bot's menu button to enter",

      "nav.back": "Back",

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
      "prov.testModel": "Test",
      "prov.testingModel": "Testing…",
      "action.toggleOn": "On",
      "action.toggleOff": "Off",

      "state.loading": "Loading…",
      "state.empty": "Nothing here",
      "state.error": "Error",
      "state.tryAgain": "Try again",

      "toast.saved": "Saved",
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
      "sec.desk": "Tool desk",

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
      "prov.probeOk": "Connection OK",
      "prov.probeFail": "Connection failed",
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
      "prov.fetchModels": "Fetch models",
      "prov.fetchingModels": "Fetching…",
      "prov.noModelsFound": "No models found; enter the ID manually.",
      "prov.selectAll": "All",
      "prov.selectNone": "None",
      "prov.manualModelId": "Manual model ID",
      "prov.manualModelHint": "If a model isn't in the list, type its ID yourself.",
      "prov.addManual": "Add",
      "prov.modelsSelected": "models selected",

      "users.ban": "Ban",
      "users.unban": "Unban",
      "users.banned": "Banned",
      "users.banConfirm": "Ban this user?",
      "users.unbanConfirm": "Unban this user?",
      "users.note": "Note",
      "users.empty": "No users yet",
      "users.bannedFilter": "Banned",
    };

  function t(key) {
    if (STRINGS[key] !== undefined) return STRINGS[key];
    return key;
  }

  // English is the only language. These are kept so section code that
  // calls getLang()/setLang() keeps working; setLang is a no-op.
  function getLang() {
    return "en";
  }

  function setLang() {}

  // Merge extra section strings (single English dict).
  function registerSectionStrings(en) {
    const dict = en || {};
    for (const k of Object.keys(dict)) {
      if (STRINGS[k] === undefined) STRINGS[k] = dict[k];
    }
  }

  document.documentElement.setAttribute("lang", "en");
  document.documentElement.setAttribute("dir", "ltr");

  window.__STRINGS = STRINGS;
  window.__registerSectionStrings = registerSectionStrings;
  window.I18N = { t: t, setLang: setLang, getLang: getLang, detectLang: getLang };
})();
