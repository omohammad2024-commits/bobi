/* BOBI Mini App · section: schedulers
 * Owner-only: scheduler list with enable toggles, daily digest preview &
 * config, per-group digests. ctx.api only.
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   schedulers.list   {} -> { ok, schedulers: [{ id, name, enabled, cron,
 *                         timezone, nextRunAtMs, runCount, lastRunAtMs?,
 *                         lastStatus? }] }
 *   schedulers.toggle { id, enabled } -> { ok, id, enabled }
 *   digest.preview    {} -> { ok, text }
 *   digest.config     {} -> { ok, exists, enabled, blueprint, ownedBy, cron?,
 *                         time?, custom?, timezone?, nextRunAtMs?, actionIsAgent?,
 *                         prompt?, defaultPrompt?, isCustomPrompt?, chatId?,
 *                         defaultChatId?, isDefaultDestination?, ... }
 *   digest.config     { enabled? | time? | cron? | prompt? | chatId? } -> { ok, ... }
 *                         (flat params only — { config: {...} } is ignored)
 *   groupdigests.list {} -> { ok, groups: [{ chatId, assistantEnabled,
 *                         digestEnabled, digestTime, task: { exists, enabled, cron,
 *                         nextRunAtMs, lastRunAtMs?, lastStatus? } }] }
 *   groupdigests.set  { chatId, digestEnabled, time? } -> { ok, chatId, digestEnabled, ... }
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "sch.sub": "Automations, the morning digest and group digests.",
      "sch.list.title": "Schedulers",
      "sch.list.sub": "Background automations",
      "sch.next": "Next run",
      "sch.digest.title": "Daily digest",
      "sch.digest.sub": "The morning briefing",
      "sch.digest.preview.btn": "Show preview",
      "sch.digest.config.title": "Digest settings",
      "sch.gdigest.title": "Group digests",
      "sch.gdigest.sub": "One digest per group",
      "sch.toggled": "Saved",
      "sch.digest.enabled": "Morning digest",
      "sch.digest.time": "Send time",
      "sch.digest.prompt": "Digest text",
      "sch.digest.chatId": "Destination (chat id)",
      "sch.digest.missing": "Not created via /blueprint yet; run /blueprint in Telegram first.",
      "sch.digest.customPromptNote": "Default /blueprint text",
      "sch.gd.assistantRequired": "Enable the group assistant in the Groups tab first.",
      "sch.empty": "No schedulers yet",
      "sch.gempty": "No groups yet"
    });

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtTs(ts) {
    var n = Number(ts);
    if (!n) return "—";
    var loc = "en-US";
    try {
      return new Date(n).toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return new Date(n).toLocaleString();
    }
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

  function wireToggleById(id, t) {
    var n = document.getElementById(id);
    if (!n) return;
    n.addEventListener("click", function () {
      var on = n.getAttribute("aria-checked") !== "true";
      n.setAttribute("aria-checked", on ? "true" : "false");
      n.textContent = on ? t("action.toggleOn") : t("action.toggleOff");
    });
  }

  function cardHead(I, ic, title, sub) {
    return (
      '<div class="card-head"><div class="card-icon">' + I(ic) + "</div>" +
      "<div><h2 class=\"card-title\">" + esc(title) + "</h2>" +
      (sub ? '<p class="card-sub">' + esc(sub) + "</p>" : "") + "</div></div>"
    );
  }

  async function render(el, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    el.innerHTML = ctx.pageHead("clock", t("sec.schedulers"), t("sch.sub")) + loadingHtml(t);

    var data = { schedulers: [], digestConfig: null, groupDigests: [] };
    try {
      try { var r1 = await ctx.api("schedulers.list", {}); data.schedulers = r1.schedulers || []; } catch (e1) {}
      try { var r2 = await ctx.api("digest.config", {}); data.digestConfig = r2 || null; } catch (e2) {}
      try { var r3 = await ctx.api("groupdigests.list", {}); data.groupDigests = r3.groups || []; } catch (e3) {}
    } catch (err) {
      el.innerHTML = ctx.pageHead("clock", t("sec.schedulers"), t("sch.sub")) + errorHtml(t, err);
      var rb = el.querySelector("[data-retry]");
      if (rb) rb.addEventListener("click", function () { render(el, ctx); });
      return;
    }

    var schedHtml = data.schedulers.length
      ? data.schedulers
          .map(function (s, i) {
            var name = s.name || ("#" + s.id);
            return (
              '<div class="card" data-s="' + i + '" style="margin-bottom:9px"><div class="mx-row"><div style="min-width:0">' +
              "<div class=\"mx-item\">" + esc(name) + "</div>" +
              (s.cron ? '<div class="mx-kv"><span class="mono" dir="ltr">' + esc(s.cron) + "</span></div>" : "") +
              (s.nextRunAtMs
                ? '<div class="meta-chips"><span class="meta-chip">' + I("clock") + esc(t("sch.next")) + ": " + esc(fmtTs(s.nextRunAtMs)) + "</span></div>"
                : "") +
              '</div><div data-tog>' + toggleHtml(!!s.enabled, t) + "</div></div></div>"
            );
          })
          .join("")
      : '<div class="card"><div class="mx-center">' + esc(t("sch.empty")) + "</div></div>";

    /* Digest config: the backend owns the row (/blueprint) and only accepts
     * FLAT params { enabled?, time?, cron?, prompt?, chatId? }. Render just
     * the editable fields — never the whole response object. */
    var digestCfg = data.digestConfig && typeof data.digestConfig === "object" ? data.digestConfig : null;
    var digestHtml = "";
    if (digestCfg && digestCfg.exists) {
      digestHtml =
        '<div class="mx-field"><div class="mx-row"><label for="mx-dg-enabled">' + esc(t("sch.digest.enabled")) + "</label>" +
        toggleHtml(!!digestCfg.enabled, t, "mx-dg-enabled") + "</div></div>" +
        '<div class="mx-field"><label for="mx-dg-time">' + esc(t("sch.digest.time")) + "</label>" +
        '<input class="input" id="mx-dg-time" type="time" dir="ltr" value="' + esc(digestCfg.time || "") + '"/></div>' +
        '<div class="mx-field"><label for="mx-dg-prompt">' + esc(t("sch.digest.prompt")) + "</label>" +
        '<textarea class="input" id="mx-dg-prompt" rows="3">' + esc(digestCfg.prompt || "") + "</textarea>" +
        (!digestCfg.isCustomPrompt ? '<div class="hint-text">' + esc(t("sch.digest.customPromptNote")) + "</div>" : "") + "</div>" +
        '<div class="mx-field"><label for="mx-dg-chat">' + esc(t("sch.digest.chatId")) + "</label>" +
        '<input class="input" id="mx-dg-chat" type="text" dir="ltr" value="' + esc(digestCfg.chatId || "") + '"/></div>' +
        '<div class="mx-btnrow"><button class="btn btn-primary" data-dsave>' + I("check") + esc(t("action.save")) + "</button></div>";
    } else if (digestCfg) {
      digestHtml = '<div class="note note-info">' + I("info") + "<span>" + esc(t("sch.digest.missing")) + "</span></div>";
    }

    /* Group digests: backend rows are { chatId, assistantEnabled, digestEnabled,
     * digestTime, task } and the setter takes { chatId, digestEnabled, time? }. */
    var gdHtml = data.groupDigests.length
      ? data.groupDigests
          .map(function (g, i) {
            var gid = g.chatId || "";
            return (
              '<div class="card" data-g="' + i + '" style="margin-bottom:9px"><div class="mx-row"><div style="min-width:0">' +
              '<div class="mx-item mono" dir="ltr">' + esc(gid) + "</div>" +
              (g.digestTime
                ? '<div class="meta-chips"><span class="meta-chip">' + I("clock") + '<span dir="ltr">' + esc(g.digestTime) + "</span></span></div>"
                : "") +
              (!g.assistantEnabled
                ? '<div class="mx-kv" style="margin-top:4px">' + I("alert") + " " + esc(t("sch.gd.assistantRequired")) + "</div>"
                : "") +
              '</div><div data-tog>' + toggleHtml(!!g.digestEnabled, t) + "</div></div></div>"
            );
          })
          .join("")
      : '<div class="card"><div class="mx-center">' + esc(t("sch.gempty")) + "</div></div>";

    el.innerHTML =
      ctx.pageHead("clock", t("sec.schedulers"), t("sch.sub")) +
      '<div class="card">' + cardHead(I, "layers", t("sch.list.title"), t("sch.list.sub")) + schedHtml + "</div>" +
      '<div class="card">' + cardHead(I, "bell", t("sch.digest.title"), t("sch.digest.sub")) +
      '<div data-dpreview></div>' +
      '<div class="mx-btnrow"><button class="btn btn-ghost" data-preview>' + I("eye") + esc(t("sch.digest.preview.btn")) + "</button></div>" +
      (digestHtml
        ? '<div class="group-label">' + I("sliders") + esc(t("sch.digest.config.title")) + "</div>" + digestHtml
        : "") +
      "</div>" +
      '<div class="card">' + cardHead(I, "users", t("sch.gdigest.title"), t("sch.gdigest.sub")) + gdHtml + "</div>";

    // scheduler toggles
    Array.prototype.forEach.call(el.querySelectorAll("[data-s]"), function (card) {
      var s = data.schedulers[Number(card.getAttribute("data-s"))];
      var btn = card.querySelector("[data-tog] .mx-toggle");
      btn.addEventListener("click", async function () {
        var next = btn.getAttribute("aria-checked") !== "true";
        btn.disabled = true;
        try {
          await ctx.api("schedulers.toggle", { id: s.id, enabled: next });
          btn.setAttribute("aria-checked", next ? "true" : "false");
          btn.textContent = next ? t("action.toggleOn") : t("action.toggleOff");
          ctx.toast(t("sch.toggled"), "ok");
        } catch (err) {
          ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""), "err");
        } finally {
          btn.disabled = false;
        }
      });
    });

    // group digest toggles: { chatId, digestEnabled } — enabling needs the
    // group assistant mode on, otherwise the backend 400s in Persian.
    Array.prototype.forEach.call(el.querySelectorAll("[data-g]"), function (card) {
      var g = data.groupDigests[Number(card.getAttribute("data-g"))];
      var btn = card.querySelector("[data-tog] .mx-toggle");
      btn.addEventListener("click", async function () {
        var next = btn.getAttribute("aria-checked") !== "true";
        btn.disabled = true;
        try {
          await ctx.api("groupdigests.set", { chatId: g.chatId, digestEnabled: next });
          btn.setAttribute("aria-checked", next ? "true" : "false");
          btn.textContent = next ? t("action.toggleOn") : t("action.toggleOff");
          ctx.toast(t("sch.toggled"), "ok");
        } catch (err) {
          ctx.toast((err && err.message) || t("toast.failed"), "err");
        } finally {
          btn.disabled = false;
        }
      });
    });

    // digest preview
    var pvBtn = el.querySelector("[data-preview]");
    var pvBox = el.querySelector("[data-dpreview]");
    pvBtn.addEventListener("click", async function () {
      pvBox.innerHTML = loadingHtml(t);
      try {
        var r = await ctx.api("digest.preview", {});
        var text = r.preview || r.text || r.digest || "";
        pvBox.innerHTML = text
          ? '<div class="card" style="background:var(--surface-inset)"><div class="mx-pre" style="margin-top:0">' + esc(text) + "</div></div>"
          : '<div class="mx-center">' + esc(t("state.empty")) + "</div>";
      } catch (err) {
        pvBox.innerHTML = errorHtml(t, err);
        var b2 = pvBox.querySelector("[data-retry]");
        if (b2) b2.addEventListener("click", function () { pvBtn.click(); });
      }
    });

    // digest config save — flat params the backend actually reads
    var dsaveBtn = el.querySelector("[data-dsave]");
    if (dsaveBtn && digestCfg && digestCfg.exists) {
      wireToggleById("mx-dg-enabled", t);
      dsaveBtn.addEventListener("click", async function () {
        var params = {};
        var enBtn = el.querySelector("#mx-dg-enabled");
        if (enBtn) params.enabled = enBtn.getAttribute("aria-checked") === "true";
        var timeVal = el.querySelector("#mx-dg-time").value;
        if (timeVal) params.time = timeVal;
        var promptVal = el.querySelector("#mx-dg-prompt").value;
        if (promptVal.trim()) params.prompt = promptVal;
        var chatVal = el.querySelector("#mx-dg-chat").value.trim();
        if (chatVal) params.chatId = chatVal;
        dsaveBtn.disabled = true;
        try {
          await ctx.api("digest.config", params);
          ctx.toast(t("toast.saved"), "ok");
          render(el, ctx);
        } catch (err) {
          ctx.toast((err && err.message) || t("toast.failed"), "err");
        } finally {
          dsaveBtn.disabled = false;
        }
      });
    }
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("schedulers", { titleKey: "sec.schedulers", icon: "clock", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
