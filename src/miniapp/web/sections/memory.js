/* BOBI Mini App · section: memory
 * Owner-only: search memory, browse all memories, review curator proposals,
 * list structured events. Same-origin /miniapp/api/* via ctx.api only. */
(function () {
  "use strict";

  function RS(fa, en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(fa, en);
    }
  }

  RS(
    {
      "mem.tab.search": "جستجو",
      "mem.tab.all": "همه",
      "mem.tab.curator": "پیشنهادها",
      "mem.tab.events": "رویدادها",
      "mem.search.ph": "در حافظه جستجو کن…",
      "mem.search.btn": "جستجو",
      "mem.search.hint": "نام، موضوع، کلید یا تاریخ",
      "mem.approve": "تأیید",
      "mem.reject": "رد",
      "mem.decided": "ثبت شد ✓",
      "mem.reason": "دلیل",
      "mem.updated": "به‌روزرسانی",
      "mem.kind.birthday": "تولد",
      "mem.kind.anniversary": "سالگرد",
      "mem.kind.monthly": "ماهانه",
      "mem.kind.once": "یک‌باره",
      "mem.pending": "در انتظار بررسی",
      "mem.today": "امروز 🎉",
      "mem.daysLeft": "{n} روز مانده"
    },
    {
      "mem.tab.search": "Search",
      "mem.tab.all": "All",
      "mem.tab.curator": "Proposals",
      "mem.tab.events": "Events",
      "mem.search.ph": "Search memory…",
      "mem.search.btn": "Search",
      "mem.search.hint": "Name, topic, key, or date",
      "mem.approve": "Approve",
      "mem.reject": "Reject",
      "mem.decided": "Recorded ✓",
      "mem.reason": "Reason",
      "mem.updated": "Updated",
      "mem.kind.birthday": "Birthday",
      "mem.kind.anniversary": "Anniversary",
      "mem.kind.monthly": "Monthly",
      "mem.kind.once": "One-time",
      "mem.pending": "Pending review",
      "mem.today": "Today 🎉",
      "mem.daysLeft": "{n} days left"
    }
  );

  var TAB = "search";

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function lang() {
    return (window.I18N && window.I18N.getLang && window.I18N.getLang()) || "fa";
  }

  function fmtTs(ts) {
    var n = Number(ts);
    if (!n) return "—";
    var loc = lang() === "fa" ? "fa-IR" : "en-US";
    try {
      return new Date(n).toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return new Date(n).toLocaleString();
    }
  }

  function styleTag() {
    return (
      "<style>" +
      ".mx-tabs{display:flex;gap:6px;overflow-x:auto;padding:4px 0 10px}" +
      ".mx-tab{flex:1 0 auto;min-height:44px;padding:10px 14px;border-radius:12px;border:1px solid var(--border,#e2e2e2);background:var(--card,#fff);font-size:14px;white-space:nowrap}" +
      ".mx-tab[aria-selected=true]{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}" +
      ".mx-spin{width:28px;height:28px;margin:18px auto;border:3px solid var(--border,#e2e2e2);border-top-color:var(--accent,#2a7fff);border-radius:50%;animation:mxrot 0.8s linear infinite}" +
      "@keyframes mxrot{to{transform:rotate(360deg)}}" +
      ".mx-center{text-align:center;padding:26px 12px;color:var(--muted,#777)}" +
      ".mx-kv{font-size:12px;color:var(--muted,#777);word-break:break-all}" +
      ".mx-pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font-size:14px;line-height:1.7}" +
      ".mx-actions{display:flex;gap:8px;margin-top:10px}" +
      ".mx-actions .btn{flex:1;min-height:44px}" +
      ".mx-searchrow{display:flex;gap:8px;margin-bottom:6px}" +
      ".mx-searchrow .input{flex:1;min-height:44px}" +
      ".mx-hint{font-size:12px;color:var(--muted,#777);margin:0 0 12px}" +
      "</style>"
    );
  }

  function loadingHtml(t) {
    return '<div class="mx-center"><div class="mx-spin"></div><div>' + esc(t("state.loading")) + "</div></div>";
  }

  function emptyHtml(t) {
    return '<div class="mx-center">' + esc(t("state.empty")) + "</div>";
  }

  function errorHtml(t, err, retry) {
    return (
      '<div class="card mx-center"><div>⚠️ ' + esc(t("state.error")) + "</div>" +
      (err && err.message ? '<div class="mx-kv">' + esc(err.message) + "</div>" : "") +
      '<div style="margin-top:12px"><button class="btn btn-primary" data-retry style="min-height:44px;min-width:120px">' +
      esc(t("action.retry")) + "</button></div></div>"
    );
  }

  function wireRetry(body, fn) {
    var b = body.querySelector("[data-retry]");
    if (b) b.addEventListener("click", fn);
  }

  function memoryCard(m, t) {
    var key = m.key !== undefined ? m.key : m.id;
    return (
      '<div class="card">' +
      (key !== undefined && key !== "" ? '<div class="mx-kv">🔑 ' + esc(key) + "</div>" : "") +
      '<div class="mx-pre">' + esc(m.content !== undefined ? m.content : m.text !== undefined ? m.text : m.snippet || "") + "</div>" +
      (m.updatedAt || m.createdAt
        ? '<div class="mx-kv">' + esc(t("mem.updated")) + ": " + esc(fmtTs(m.updatedAt || m.createdAt)) + "</div>"
        : "") +
      "</div>"
    );
  }

  async function showSearch(body, ctx) {
    var t = ctx.t;
    body.innerHTML =
      '<form class="mx-searchrow" data-form>' +
      '<input class="input" data-q placeholder="' + esc(t("mem.search.ph")) + '" enterkeyhint="search" />' +
      '<button class="btn btn-primary" type="submit" style="min-height:44px">' + esc(t("mem.search.btn")) + "</button>" +
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
              '<div class="card" data-p="' + i + '">' +
              '<div class="mx-kv">' + esc(t("mem.pending")) +
              (p.kindFa ? ' · <span class="badge">' + esc(p.kindFa) + "</span>" : "") + "</div>" +
              '<div class="mx-pre">' + esc(p.summaryFa || "") + "</div>" +
              '<div class="mx-actions">' +
              '<button class="btn btn-primary" data-approve>' + esc(t("mem.approve")) + "</button>" +
              '<button class="btn btn-ghost" data-reject>' + esc(t("mem.reject")) + "</button>" +
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
                ctx.toast(t("mem.decided"));
                load();
              })
              .catch(function (err) {
                ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
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
          var daysLabel = "";
          if (d !== null && !isNaN(d)) {
            if (d === 0) daysLabel = t("mem.today");
            else {
              var ds = String(d);
              if (lang() === "fa") ds = ds.replace(/\d/g, function (x) { return "۰۱۲۳۴۵۶۷۸۹"[x]; });
              daysLabel = t("mem.daysLeft").replace("{n}", ds);
            }
          }
          return (
            '<div class="card">' +
            '<div><strong>' + esc(ev.name || "") + "</strong>" +
            (ev.labelFa ? ' · <span class="badge">' + esc(ev.labelFa) + "</span>" : "") +
            (kindLabel ? ' <span class="badge">' + esc(kindLabel) + "</span>" : "") +
            "</div>" +
            (daysLabel ? '<div class="mx-kv" style="margin-top:4px">📅 ' + esc(daysLabel) + "</div>" : "") +
            (ev.note ? '<div class="mx-pre">' + esc(ev.note) + "</div>" : "") +
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
      styleTag() +
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
      window.App.registerSection("memory", { titleKey: "sec.memory", icon: "🧠", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
