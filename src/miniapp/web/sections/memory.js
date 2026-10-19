/* BOBI Mini App · section: memory
 * Owner-only: search memory, browse all memories, review curator proposals,
 * list structured events. Same-origin /miniapp/api/* via ctx.api only. */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "mem.sub": "Search what BOBI remembers, review proposals, track events.",
      "mem.tab.search": "Search",
      "mem.tab.all": "All",
      "mem.tab.curator": "Proposals",
      "mem.tab.events": "Events",
      "mem.search.ph": "Search memory…",
      "mem.search.btn": "Search",
      "mem.search.hint": "Name, topic, key, or date",
      "mem.approve": "Approve",
      "mem.reject": "Reject",
      "mem.decided": "Recorded",
      "mem.reason": "Reason",
      "mem.updated": "Updated",
      "mem.kind.birthday": "Birthday",
      "mem.kind.anniversary": "Anniversary",
      "mem.kind.monthly": "Monthly",
      "mem.kind.once": "One-time",
      "mem.pending": "Pending review",
      "mem.today": "Today",
      "mem.daysLeft": "{n} days left"
    });

  var TAB = "search";

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

  function emptyHtml(t) {
    var I = window.AppIcons.svg;
    return (
      '<div class="card"><div class="empty-state"><div class="empty-ic">' + I("database") + "</div>" +
      '<p class="empty-title">' + esc(t("state.empty")) + "</p></div></div>"
    );
  }

  function errorHtml(t, err, retry) {
    var I = window.AppIcons.svg;
    return (
      '<div class="card"><div class="error-state"><div class="error-ic">' + I("alert") + "</div>" +
      "<p>" + esc(t("state.error")) + "</p>" +
      (err && err.message ? '<div class="mx-kv" style="margin-bottom:12px">' + esc(err.message) + "</div>" : "") +
      '<button class="btn btn-primary" data-retry>' + I("refresh") + esc(t("action.retry")) + "</button>" +
      "</div></div>"
    );
  }

  function wireRetry(body, fn) {
    var b = body.querySelector("[data-retry]");
    if (b) b.addEventListener("click", fn);
  }

  function memoryCard(m, t) {
    var I = window.AppIcons.svg;
    var key = m.key !== undefined ? m.key : m.id;
    return (
      '<div class="card" style="margin-bottom:9px">' +
      (key !== undefined && key !== ""
        ? '<div style="margin-bottom:8px"><span class="badge badge-accent">' + I("key") + esc(key) + "</span></div>"
        : "") +
      '<div class="mx-pre" style="margin-top:0">' + esc(m.content !== undefined ? m.content : m.text !== undefined ? m.text : m.snippet || "") + "</div>" +
      (m.updatedAt || m.createdAt
        ? '<div class="mx-kv" style="margin-top:8px">' + esc(t("mem.updated")) + ": " + esc(fmtTs(m.updatedAt || m.createdAt)) + "</div>"
        : "") +
      "</div>"
    );
  }

  async function showSearch(body, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    body.innerHTML =
      '<form class="mx-searchrow" data-form>' +
      '<div class="searchbar" style="flex:1;margin-bottom:0">' + I("search") +
      '<input class="input" data-q placeholder="' + esc(t("mem.search.ph")) + '" enterkeyhint="search" autocomplete="off" /></div>' +
      '<button class="btn btn-primary" type="submit" style="min-height:46px">' + esc(t("mem.search.btn")) + "</button>" +
      "</form>" +
      '<p class="mx-hint">' + esc(t("mem.search.hint")) + "</p>" +
      '<div data-results></div>';
    var form = body.querySelector("[data-form]");
    var input = body.querySelector("[data-q]");
    var results = body.querySelector("[data-results]");
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      results.innerHTML = loadingHtml(t);
      try {
        var r = await ctx.api("memory.search", { q: q, limit: 30 });
        var items = r.mems || [];
        if (!items.length) {
          results.innerHTML = emptyHtml(t);
          return;
        }
        results.innerHTML = items.map(function (m) { return memoryCard(m, t); }).join("");
      } catch (err) {
        results.innerHTML = errorHtml(t, err);
        wireRetry(results, function () { form.requestSubmit(); });
      }
    });
  }

  async function showList(body, ctx) {
    var t = ctx.t;
    body.innerHTML = loadingHtml(t);
    try {
      var r = await ctx.api("memory.list", { limit: 100 });
      var items = r.mems || [];
      if (!items.length) {
        body.innerHTML = emptyHtml(t);
        return;
      }
      body.innerHTML = items.map(function (m) { return memoryCard(m, t); }).join("");
    } catch (err) {
      body.innerHTML = errorHtml(t, err);
      wireRetry(body, function () { showList(body, ctx); });
    }
  }

  async function showCurator(body, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    async function load() {
      body.innerHTML = loadingHtml(t);
      try {
        var r = await ctx.api("curator.proposals", {});
        var items = r.proposals || r.items || [];
        if (!items.length) {
          body.innerHTML = emptyHtml(t);
          return;
        }
        body.innerHTML = items
          .map(function (p, i) {
            return (
              '<div class="card" data-p="' + i + '" style="margin-bottom:9px;border-inline-start:3px solid var(--warning)">' +
              '<div style="margin-bottom:8px"><span class="badge badge-warn">' + I("clock") + esc(t("mem.pending")) + "</span>" +
              (p.kindFa ? ' <span class="badge">' + esc(p.kindFa) + "</span>" : "") + "</div>" +
              '<div class="mx-pre" style="margin-top:0">' + esc(p.summaryFa || "") + "</div>" +
              '<div class="mx-actions">' +
              '<button class="btn btn-sm btn-subtle" data-approve>' + I("check") + esc(t("mem.approve")) + "</button>" +
              '<button class="btn btn-sm btn-ghost" data-reject>' + I("x") + esc(t("mem.reject")) + "</button>" +
              "</div></div>"
            );
          })
          .join("");
        Array.prototype.forEach.call(body.querySelectorAll("[data-p]"), function (card) {
          var p = items[Number(card.getAttribute("data-p"))];
          function decide(approve) {
            var btns = card.querySelectorAll("button");
            Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
            ctx
              .api("curator.decide", { id: p.id, approve: approve })
              .then(function () {
                ctx.toast(t("mem.decided"), "ok");
                load();
              })
              .catch(function (err) {
                ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""), "err");
                Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
              });
          }
          card.querySelector("[data-approve]").addEventListener("click", function () { decide(true); });
          card.querySelector("[data-reject]").addEventListener("click", function () { decide(false); });
        });
      } catch (err) {
        body.innerHTML = errorHtml(t, err);
        wireRetry(body, load);
      }
    }
    await load();
  }

  async function showEvents(body, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    body.innerHTML = loadingHtml(t);
    try {
      var r = await ctx.api("events.list", {});
      var items = r.events || r.items || [];
      if (!items.length) {
        body.innerHTML = emptyHtml(t);
        return;
      }
      body.innerHTML = items
        .map(function (ev) {
          var kindKey = "mem.kind." + (ev.kind || "");
          var kindLabel = t(kindKey) === kindKey ? ev.kind || "" : t(kindKey);
          var d = ev.daysUntil === undefined || ev.daysUntil === null ? null : Number(ev.daysUntil);
          var daysBadge = "";
          if (d !== null && !isNaN(d)) {
            if (d === 0) daysBadge = '<span class="badge badge-warn">' + I("sparkles") + esc(t("mem.today")) + "</span>";
            else if (d <= 7) daysBadge = '<span class="badge badge-info">' + esc(t("mem.daysLeft").replace("{n}", String(d))) + "</span>";
            else daysBadge = '<span class="badge">' + esc(t("mem.daysLeft").replace("{n}", String(d))) + "</span>";
          }
          return (
            '<div class="card" style="margin-bottom:9px">' +
            '<div class="card-head tight">' +
            '<div class="card-icon">' + I("calendar") + "</div>" +
            "<div><div class=\"card-title\">" + esc(ev.name || "") + "</div></div>" +
            '<div class="spacer"></div>' + daysBadge +
            "</div>" +
            ((ev.labelFa || kindLabel)
              ? '<div style="margin-bottom:6px">' +
                (ev.labelFa ? '<span class="badge">' + esc(ev.labelFa) + "</span> " : "") +
                (kindLabel ? '<span class="badge">' + esc(kindLabel) + "</span>" : "") +
                "</div>"
              : "") +
            (ev.note ? '<div class="mx-pre" style="margin-top:0">' + esc(ev.note) + "</div>" : "") +
            "</div>"
          );
        })
        .join("");
    } catch (err) {
      body.innerHTML = errorHtml(t, err);
      wireRetry(body, function () { showEvents(body, ctx); });
    }
  }

  var TABS = [
    ["search", "mem.tab.search"],
    ["list", "mem.tab.all"],
    ["curator", "mem.tab.curator"],
    ["events", "mem.tab.events"]
  ];

  function render(el, ctx) {
    var t = ctx.t;
    el.innerHTML =
      ctx.pageHead("database", t("sec.memory"), t("mem.sub")) +
      '<div class="mx-tabs" role="tablist">' +
      TABS.map(function (tb) {
        return (
          '<button class="mx-tab" role="tab" data-tab="' + tb[0] + '" aria-selected="' +
          (TAB === tb[0] ? "true" : "false") + '">' + esc(t(tb[1])) + "</button>"
        );
      }).join("") +
      "</div><div data-body></div>";
    var body = el.querySelector("[data-body]");

    function show(tab) {
      TAB = tab;
      Array.prototype.forEach.call(el.querySelectorAll("[data-tab]"), function (b) {
        b.setAttribute("aria-selected", b.getAttribute("data-tab") === tab ? "true" : "false");
      });
      if (tab === "search") showSearch(body, ctx);
      else if (tab === "list") showList(body, ctx);
      else if (tab === "curator") showCurator(body, ctx);
      else showEvents(body, ctx);
    }

    Array.prototype.forEach.call(el.querySelectorAll("[data-tab]"), function (b) {
      b.addEventListener("click", function () { show(b.getAttribute("data-tab")); });
    });
    show(TAB);
    return Promise.resolve();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("memory", { titleKey: "sec.memory", icon: "database", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
