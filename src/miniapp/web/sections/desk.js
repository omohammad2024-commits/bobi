/* BOBI Mini App · section: desk (platform Phase 10)
 * Owner-only: the tool desk — the exact cards the model sees, one per
 * registered tool, with a live enable/disable toggle per tool. A toggle
 * takes effect on the bot's next turn and persists across restarts.
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   desk.list   {} -> { ok, tools: [{ name, description, enabled, ownerOnly,
 *                      offDesk, toolset?, manifest? }] }
 *   desk.toggle { name, enabled } -> { ok, name, enabled }
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
    "sec.desk": "Tool desk",
    "desk.sub": "Every tool on BOBI's desk — the same cards the model reads.",
    "desk.empty": "No tools registered",
    "desk.useWhen": "Use when",
    "desk.doNotUseWhen": "Not when",
    "desk.ownerOnly": "Owner only",
    "desk.offDesk": "Off-desk (server-side only)",
    "desk.toggled": "Saved",
    "desk.count": "{n} tools",
  });

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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

  function toolCard(tool, t) {
    var m = tool.manifest || {};
    var title = m.title || tool.name;
    var badges = "";
    if (tool.ownerOnly) badges += '<span class="badge">' + esc(t("desk.ownerOnly")) + "</span>";
    if (tool.offDesk) badges += '<span class="badge">' + esc(t("desk.offDesk")) + "</span>";
    if (tool.toolset) badges += '<span class="badge">' + esc(tool.toolset) + "</span>";
    if (m.latencyTier) badges += '<span class="badge">' + esc(m.latencyTier) + "</span>";
    if (m.costTier) badges += '<span class="badge">' + esc(m.costTier) + "</span>";

    var rows = "";
    if (m.purpose) rows += "<dt>" + esc(t("desk.useWhen")) + "</dt><dd>" + esc(m.useWhen || m.purpose) + "</dd>";
    if (m.doNotUseWhen) rows += "<dt>" + esc(t("desk.doNotUseWhen")) + "</dt><dd>" + esc(m.doNotUseWhen) + "</dd>";

    return (
      '<div class="card" style="margin:12px 0 0">' +
      '<div class="card-head"><div><h3 class="card-title">' + esc(title) + "</h3>" +
      '<p class="card-sub mono">' + esc(tool.name) + "</p></div>" +
      '<button class="mx-toggle" data-toggle="' + esc(tool.name) + '" data-enabled="' + (tool.enabled ? "1" : "0") + '" aria-checked="' + (tool.enabled ? "true" : "false") + '">' +
      esc(tool.enabled ? t("action.toggleOn") : t("action.toggleOff")) + "</button></div>" +
      (m.description || tool.description
        ? '<p class="card-sub">' + esc(m.description || tool.description) + "</p>"
        : "") +
      (badges ? '<div class="mx-badges">' + badges + "</div>" : "") +
      (rows ? '<dl class="mx-dl">' + rows + "</dl>" : "") +
      "</div>"
    );
  }

  async function render(el, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;

    async function load() {
      el.innerHTML = ctx.pageHead("sliders", t("sec.desk"), t("desk.sub")) + loadingHtml(t);
      var tools;
      try {
        var r = await ctx.api("desk.list", {});
        tools = r.tools || [];
      } catch (err) {
        el.innerHTML = ctx.pageHead("sliders", t("sec.desk"), t("desk.sub")) + errorHtml(t, err);
        var rb = el.querySelector("[data-retry]");
        if (rb) rb.addEventListener("click", load);
        return;
      }
      var head = ctx.pageHead(
        "sliders",
        t("sec.desk"),
        t("desk.sub") + " · " + t("desk.count").replace("{n}", String(tools.length)),
      );
      el.innerHTML =
        head +
        (tools.length
          ? tools.map(function (tool) { return toolCard(tool, t); }).join("")
          : '<div class="card"><p class="card-sub">' + esc(t("desk.empty")) + "</p></div>");
      el.querySelectorAll("[data-toggle]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var name = btn.getAttribute("data-toggle");
          var next = btn.getAttribute("data-enabled") !== "1";
          btn.disabled = true;
          try {
            await ctx.api("desk.toggle", { name: name, enabled: next });
            ctx.toast(t("desk.toggled"), "ok");
            load();
          } catch (err) {
            ctx.toast((err && err.message) || t("toast.failed"), "err");
            btn.disabled = false;
          }
        });
      });
    }

    await load();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("desk", { titleKey: "sec.desk", icon: "sliders", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
