/* BOBI Mini App · section: tasks
 * Owner-only: reminders, tasks and goals grouped, with tap-to-act
 * complete/cancel. ctx.api only. */
(function () {
  "use strict";

  function RS(fa, en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(fa, en);
    }
  }

  RS(
    {
      "tsk.reminders": "یادآورها",
      "tsk.tasks": "کارها",
      "tsk.goals": "هدف‌ها",
      "tsk.complete": "انجام شد",
      "tsk.cancel": "لغو",
      "tsk.due": "مهلت",
      "tsk.done": "ثبت شد ✓",
      "tsk.empty": "موردی نیست"
    },
    {
      "tsk.reminders": "Reminders",
      "tsk.tasks": "Tasks",
      "tsk.goals": "Goals",
      "tsk.complete": "Complete",
      "tsk.cancel": "Cancel",
      "tsk.due": "Due",
      "tsk.done": "Recorded ✓",
      "tsk.empty": "Nothing here"
    }
  );

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
    if (!n) return "";
    var loc = lang() === "fa" ? "fa-IR" : "en-US";
    try {
      var d = new Date(n);
      var now = new Date();
      var sameDay = d.toDateString() === now.toDateString();
      return sameDay
        ? d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return new Date(n).toLocaleString();
    }
  }

  function styleTag() {
    return (
      "<style>" +
      ".mx-spin{width:28px;height:28px;margin:18px auto;border:3px solid var(--border,#e2e2e2);border-top-color:var(--accent,#2a7fff);border-radius:50%;animation:mxrot 0.8s linear infinite}" +
      "@keyframes mxrot{to{transform:rotate(360deg)}}" +
      ".mx-center{text-align:center;padding:26px 12px;color:var(--muted,#777)}" +
      ".mx-secttl{font-weight:700;margin:2px 0 8px;font-size:15px}" +
      ".mx-muted{font-size:12px;color:var(--muted,#777)}" +
      ".mx-item{font-size:14px;line-height:1.7}" +
      ".mx-actions{display:flex;gap:8px;margin-top:10px}" +
      ".mx-actions .btn{flex:1;min-height:44px}" +
      ".mx-kv{font-size:12px;color:var(--muted,#777);word-break:break-all}" +
      "</style>"
    );
  }

  function loadingHtml(t) {
    return '<div class="mx-center"><div class="mx-spin"></div><div>' + esc(t("state.loading")) + "</div></div>";
  }

  function errorHtml(t, err) {
    return (
      '<div class="card mx-center"><div>⚠️ ' + esc(t("state.error")) + "</div>" +
      (err && err.message ? '<div class="mx-kv">' + esc(err.message) + "</div>" : "") +
      '<div style="margin-top:12px"><button class="btn" data-retry style="min-height:44px;min-width:120px">' +
      esc(t("action.retry")) + "</button></div></div>"
    );
  }

  /* Normalize: {reminders:[],tasks:[],goals:[]} | {items:[{kind}]} */
  function normGroups(r) {
    var g = { reminders: [], tasks: [], goals: [] };
    if (Array.isArray(r.reminders)) g.reminders = r.reminders;
    if (Array.isArray(r.tasks)) g.tasks = r.tasks;
    if (Array.isArray(r.goals)) g.goals = r.goals;
    var items = r.items || [];
    items.forEach(function (it) {
      var k = String(it.kind || it.type || "tasks").toLowerCase();
      if (k.indexOf("remind") === 0) g.reminders.push(it);
      else if (k.indexOf("goal") === 0) g.goals.push(it);
      else g.tasks.push(it);
    });
    return g;
  }

  async function render(el, ctx) {
    var t = ctx.t;
    el.innerHTML = styleTag() + loadingHtml(t);

    async function load() {
      el.innerHTML = styleTag() + loadingHtml(t);
      try {
        var r = await ctx.api("tasks.list", {});
        var g = normGroups(r);

        function groupHtml(title, icon, items) {
          var body = items.length
            ? items
                .map(function (it, i) {
                  var id = it.id !== undefined ? it.id : it.key;
                  var text = it.text || it.title || it.name || "";
                  var due = it.due || it.dueAt || it.remindAt || it.deadline;
                  return (
                    '<div class="card" data-item data-idx="' + i + '">' +
                    '<div class="mx-item">' + esc(text) + "</div>" +
                    (due ? '<div class="mx-muted">⏰ ' + esc(t("tsk.due")) + ": " + esc(fmtTs(due)) + "</div>" : "") +
                    '<div class="mx-actions">' +
                    '<button class="btn" data-complete>' + esc(t("tsk.complete")) + "</button>" +
                    '<button class="btn" data-cancel style="color:var(--danger,#d32f2f)">' + esc(t("tsk.cancel")) + "</button>" +
                    "</div></div>"
                  );
                })
                .join("")
            : '<div class="mx-center">' + esc(t("tsk.empty")) + "</div>";
          var html =
            '<div class="card"><div class="mx-secttl">' + icon + " " + esc(title) + "</div>" + body + "</div>";
          return { html: html, items: items };
        }

        var parts = [
          groupHtml(t("tsk.reminders"), "⏰", g.reminders),
          groupHtml(t("tsk.tasks"), "✅", g.tasks),
          groupHtml(t("tsk.goals"), "🎯", g.goals)
        ];
        el.innerHTML = styleTag() + parts.map(function (p) { return p.html; }).join("");

        // Wire each section's item cards to their own group's items.
        var sectionCards = el.querySelectorAll(":scope > .card");
        parts.forEach(function (p, pi) {
          var sec = sectionCards[pi];
          if (!sec) return;
          Array.prototype.forEach.call(sec.querySelectorAll("[data-item]"), function (card, ci) {
            var it = p.items[ci];
            var id = it.id !== undefined ? it.id : it.key;
            function act(endpoint) {
              var btns = card.querySelectorAll("button");
              Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
              ctx
                .api(endpoint, { id: id })
                .then(function () {
                  ctx.toast(t("tsk.done"));
                  load();
                })
                .catch(function (err) {
                  ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
                  Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
                });
            }
            card.querySelector("[data-complete]").addEventListener("click", function () { act("tasks.complete"); });
            card.querySelector("[data-cancel]").addEventListener("click", function () { act("tasks.cancel"); });
          });
        });
      } catch (err) {
        el.innerHTML = styleTag() + errorHtml(t, err);
        var b = el.querySelector("[data-retry]");
        if (b) b.addEventListener("click", load);
      }
    }

    await load();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("tasks", { titleKey: "sec.tasks", icon: "✅", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
