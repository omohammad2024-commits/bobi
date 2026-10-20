/* BOBI Mini App · section: groups
 * Owner-only: group list → tap → detail with group-assistant settings,
 * group digest config, and auto-moderation. ctx.api only.
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   groups.list          {} -> { ok, groups: [{ chatId, assistantEnabled,
 *                            digestEnabled, moderationEnabled }] }
 *   groups.assistant     { groupId } -> { ok, groupId, config: { enabled,
 *                            replyOnlyWhenCalled, summaryMaxMessages,
 *                            pollsAllowed, digestEnabled, digestTime,
 *                            smartSummary } }
 *   groups.assistant.set { groupId, enabled, smart? } -> { ok, groupId, config }
 *                            (only enabled + smart are settable here)
 *   groups.digests       { groupId } -> { ok, chatId, assistantEnabled,
 *                            digestEnabled, digestTime, task: { exists, enabled,
 *                            cron, nextRunAtMs, lastRunAtMs?, lastStatus? } }
 *   groups.digests.set   { chatId, digestEnabled, time? } -> { ok, chatId,
 *                            digestEnabled, time?, taskId? }
 *   moderation.get       { groupId } -> { ok, groupId, config: { enabled,
 *                            antiSpam, linkPolicy, profanityFilter,
 *                            floodWindowSec, floodMaxMessages } }
 *   moderation.set       { groupId, ...patch } -> { ok, groupId, config }
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "grp.sub": "Assistant, digests and moderation per group.",
      "grp.list.title": "Groups",
      "grp.assistant.title": "Group assistant",
      "grp.assistant.sub": "Smart replies in the group",
      "grp.assistant.desc": "BOBI replies in the group only with your opt-in.",
      "grp.assistant.enabled": "Assistant mode",
      "grp.assistant.smart": "Smart summaries (LLM)",
      "grp.digests.title": "Group digest",
      "grp.digests.sub": "Daily summary to your inbox",
      "grp.digests.enabled": "Daily digest",
      "grp.digests.time": "Digest time",
      "grp.mod.title": "Auto moderation",
      "grp.mod.sub": "Spam, links and flood control",
      "grp.saved": "Saved",
      "grp.empty": "No groups yet"
    });

  var selected = null; // selected group object

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function humanize(k) {
    return String(k).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  }

  function loadingHtml(t) {
    return '<div class="loading-state"><div class="spinner"></div><div>' + esc(t("state.loading")) + "</div></div>";
  }

  function errorHtml(t, err) {
    var I = window.AppIcons.svg;
    return (
      '<div class="card"><div class="error-state"><div class="error-ic">' + I("alert") + "</div>" +
      "<p>" + esc(t("state.error")) + "</p>" +
      (err && err.message ? '<div class="mx-kv" style="margin-bottom:12px">' + esc(err.message) + "</div>" : "") +
      '<button class="btn btn-primary" data-retry>' + I("refresh") + esc(t("action.retry")) + "</button>" +
      "</div></div>"
    );
  }

  function toggleHtml(on, t, id) {
    return (
      '<button class="mx-toggle"' + (id ? ' id="' + id + '"' : "") + ' aria-checked="' + (on ? "true" : "false") + '">' +
      esc(on ? t("action.toggleOn") : t("action.toggleOff")) + "</button>"
    );
  }

  function wireToggle(btn, t) {
    if (!btn) return;
    btn.addEventListener("click", function () {
      var on = btn.getAttribute("aria-checked") !== "true";
      btn.setAttribute("aria-checked", on ? "true" : "false");
      btn.textContent = on ? t("action.toggleOn") : t("action.toggleOff");
    });
  }

  function cardHead(I, ic, title, sub, icCls) {
    return (
      '<div class="card-head"><div class="card-icon' + (icCls ? " " + icCls : "") + '">' + I(ic) + "</div>" +
      "<div><h2 class=\"card-title\">" + esc(title) + "</h2>" +
      (sub ? '<p class="card-sub">' + esc(sub) + "</p>" : "") + "</div></div>"
    );
  }

  /* Moderation config form: explicit fields (the backend accepts exactly
   * these six keys). linkPolicy renders as a select. */
  var MOD_FIELDS = [
    { key: "enabled", type: "bool" },
    { key: "antiSpam", type: "bool" },
    { key: "linkPolicy", type: "select", options: ["allow", "warn", "delete"] },
    { key: "profanityFilter", type: "bool" },
    { key: "floodWindowSec", type: "number" },
    { key: "floodMaxMessages", type: "number" },
  ];

  function schemaForm(opts, t) {
    var values = (opts && opts.values) || {};
    var prefix = (opts && opts.prefix) || "mx";
    var fields = MOD_FIELDS.filter(function (f) { return values[f.key] !== undefined; });
    var html = fields
      .map(function (f, i) {
        var id = prefix + "-" + i;
        var v = values[f.key];
        var label = humanize(f.key);
        if (f.type === "bool") {
          return (
            '<div class="field"><div class="mx-row"><label for="' + id + '">' + esc(label) + "</label>" +
            toggleHtml(!!v, t, id) + "</div></div>"
          );
        }
        if (f.type === "select") {
          return (
            '<div class="field"><label for="' + id + '">' + esc(label) + "</label>" +
            '<select class="input" id="' + id + '">' +
            f.options
              .map(function (o) {
                return '<option value="' + esc(o) + '"' + (String(v) === o ? " selected" : "") + ">" + esc(o) + "</option>";
              })
              .join("") + "</select></div>"
          );
        }
        return (
          '<div class="field"><label for="' + id + '">' + esc(label) + "</label>" +
          '<input class="input" id="' + id + '" type="number" value="' + esc(v !== undefined ? v : "") + '"/></div>'
        );
      })
      .join("");

    return {
      html: html,
      wire: function (root) {
        fields.forEach(function (f, i) {
          if (f.type !== "bool") return;
          wireToggle(root.querySelector("#" + prefix + "-" + i), t);
        });
      },
      read: function (root) {
        var out = {};
        fields.forEach(function (f, i) {
          var n = root.querySelector("#" + prefix + "-" + i);
          if (!n) return;
          if (f.type === "bool") out[f.key] = n.getAttribute("aria-checked") === "true";
          else if (f.type === "number") out[f.key] = Number(n.value);
          else out[f.key] = n.value;
        });
        return out;
      },
    };
  }

  function metaChips(g, I) {
    var chips = "";
    if (g.assistantEnabled) chips += '<span class="meta-chip lit">' + I("bot") + "Assistant</span>";
    if (g.digestEnabled) chips += '<span class="meta-chip lit">' + I("bell") + "Digest</span>";
    if (g.moderationEnabled) chips += '<span class="meta-chip lit">' + I("shield") + "Mod</span>";
    return chips ? '<div class="meta-chips">' + chips + "</div>" : "";
  }

  async function showList(el, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    el.innerHTML = ctx.pageHead("users", t("sec.groups"), t("grp.sub")) + loadingHtml(t);
    try {
      var r = await ctx.api("groups.list", {});
      var groups = r.groups || r.items || [];
      if (!groups.length) {
        el.innerHTML =
          ctx.pageHead("users", t("sec.groups"), t("grp.sub")) +
          '<div class="card"><div class="empty-state"><div class="empty-ic">' + I("users") + "</div>" +
          '<p class="empty-title">' + esc(t("grp.empty")) + "</p></div></div>";
        return;
      }
      var html =
        ctx.pageHead("users", t("sec.groups"), t("grp.sub")) +
        groups
          .map(function (g, i) {
            var chatId = g.chatId || "";
            return (
              '<button class="list-row" data-g="' + i + '">' +
              window.AppIcons.avatar("G" + chatId) +
              '<div class="list-main"><div class="list-title mono" dir="ltr">' + esc(chatId) + "</div>" +
              metaChips(g, I) +
              '</div><span class="chev">' + I("chevR") + "</span></button>"
            );
          })
          .join("");
      el.innerHTML = html;
      Array.prototype.forEach.call(el.querySelectorAll("[data-g]"), function (b) {
        b.addEventListener("click", function () {
          selected = groups[Number(b.getAttribute("data-g"))];
          showDetail(el, ctx);
        });
      });
    } catch (err) {
      el.innerHTML = ctx.pageHead("users", t("sec.groups"), t("grp.sub")) + errorHtml(t, err);
      var rb = el.querySelector("[data-retry]");
      if (rb) rb.addEventListener("click", function () { showList(el, ctx); });
    }
  }

  async function showDetail(el, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    var g = selected;
    if (!g) { showList(el, ctx); return; }
    var gid = g.chatId || "";
    el.innerHTML = loadingHtml(t);

    var assistant = null, digests = null, moderation = null;
    try {
      try { var ra = await ctx.api("groups.assistant", { groupId: gid }); assistant = ra.config || null; } catch (e1) {}
      try { var rd = await ctx.api("groups.digests", { groupId: gid }); digests = rd || null; } catch (e2) {}
      try { var rm = await ctx.api("moderation.get", { groupId: gid }); moderation = rm.config || null; } catch (e3) {}
    } catch (err) {
      el.innerHTML = errorHtml(t, err);
      var rb = el.querySelector("[data-retry]");
      if (rb) rb.addEventListener("click", function () { showDetail(el, ctx); });
      return;
    }

    /* Assistant: the setter only accepts { enabled, smart } — render just
     * those two toggles, never the whole config object. */
    var asstHtml = assistant
      ? '<div class="field"><div class="mx-row"><label for="mx-ga-enabled">' + esc(t("grp.assistant.enabled")) + "</label>" +
        toggleHtml(!!assistant.enabled, t, "mx-ga-enabled") + "</div></div>" +
        '<div class="field"><div class="mx-row"><label for="mx-ga-smart">' + esc(t("grp.assistant.smart")) + "</label>" +
        toggleHtml(!!assistant.smartSummary, t, "mx-ga-smart") + "</div></div>"
      : "";

    /* Digest: { chatId, digestEnabled, time? } via groups.digests.set. */
    var digHtml = digests
      ? '<div class="field"><div class="mx-row"><label for="mx-gd-enabled">' + esc(t("grp.digests.enabled")) + "</label>" +
        toggleHtml(!!digests.digestEnabled, t, "mx-gd-enabled") + "</div></div>" +
        '<div class="field"><label for="mx-gd-time">' + esc(t("grp.digests.time")) + "</label>" +
        '<input class="input" id="mx-gd-time" type="time" dir="ltr" value="' + esc(digests.digestTime || "") + '"/></div>'
      : "";

    var modForm = moderation ? schemaForm({ values: moderation, prefix: "mod" }, t) : null;

    el.innerHTML =
      '<div class="subhead"><button type="button" class="btn btn-ghost btn-sm" data-back>' +
      I("chevL") + esc(t("nav.back")) + "</button>" +
      '<h2><span dir="ltr">' + esc(gid) + "</span></h2></div>" +
      (asstHtml
        ? '<div class="card">' + cardHead(I, "bot", t("grp.assistant.title"), t("grp.assistant.sub"), "blue") +
          '<div class="note note-info">' + I("info") + "<span>" + esc(t("grp.assistant.desc")) + "</span></div>" +
          asstHtml +
          '<div class="mx-btnrow"><button class="btn btn-primary" data-save-asst>' + I("check") + esc(t("action.save")) + "</button></div></div>"
        : "") +
      (digHtml
        ? '<div class="card">' + cardHead(I, "bell", t("grp.digests.title"), t("grp.digests.sub"), "amber") +
          digHtml +
          '<div class="mx-btnrow"><button class="btn btn-primary" data-save-dig>' + I("check") + esc(t("action.save")) + "</button></div></div>"
        : "") +
      (modForm
        ? '<div class="card">' + cardHead(I, "shield", t("grp.mod.title"), t("grp.mod.sub"), "green") +
          modForm.html +
          '<div class="mx-btnrow"><button class="btn btn-primary" data-save-mod>' + I("check") + esc(t("action.save")) + "</button></div></div>"
        : "");

    wireToggle(el.querySelector("#mx-ga-enabled"), t);
    wireToggle(el.querySelector("#mx-gd-enabled"), t);
    if (modForm) modForm.wire(el);

    el.querySelector("[data-back]").addEventListener("click", function () {
      selected = null;
      showList(el, ctx);
    });

    async function saving(btn, fn) {
      btn.disabled = true;
      try {
        await fn();
        ctx.toast(t("grp.saved"), "ok");
      } catch (err) {
        ctx.toast((err && err.message) || t("toast.failed"), "err");
      } finally {
        btn.disabled = false;
      }
    }

    var asstBtn = el.querySelector("[data-save-asst]");
    if (asstBtn && assistant) {
      asstBtn.addEventListener("click", function () {
        saving(asstBtn, function () {
          return ctx.api("groups.assistant.set", {
            groupId: gid,
            enabled: el.querySelector("#mx-ga-enabled").getAttribute("aria-checked") === "true",
            smart: el.querySelector("#mx-ga-smart").getAttribute("aria-checked") === "true",
          });
        });
      });
    }

    var digBtn = el.querySelector("[data-save-dig]");
    if (digBtn && digests) {
      digBtn.addEventListener("click", function () {
        saving(digBtn, function () {
          var params = {
            chatId: gid,
            digestEnabled: el.querySelector("#mx-gd-enabled").getAttribute("aria-checked") === "true",
          };
          var timeVal = el.querySelector("#mx-gd-time").value;
          if (timeVal) params.time = timeVal;
          return ctx.api("groups.digests.set", params);
        });
      });
    }

    var modBtn = el.querySelector("[data-save-mod]");
    if (modBtn && modForm) {
      modBtn.addEventListener("click", function () {
        saving(modBtn, function () {
          var params = modForm.read(el);
          params.groupId = gid;
          return ctx.api("moderation.set", params);
        });
      });
    }
  }

  function render(el, ctx) {
    if (selected) showDetail(el, ctx);
    else showList(el, ctx);
    return Promise.resolve();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("groups", { titleKey: "sec.groups", icon: "users", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
