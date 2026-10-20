/* BOBI Mini App · section: tasks
 * Owner-only: reminders, tasks and goals grouped, with tap-to-act
 * complete/cancel. ctx.api only.
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   tasks.list    {} -> { ok, reminders: [{ id, kind:"reminder", text, dueAtMs,
 *                       repeat, state }], tasks: [{ id, kind:"task", name, enabled,
 *                       cron, nextRunAtMs }], goals: [{ id, kind:"goal", title,
 *                       status, description? }] }
 *   tasks.complete { kind, id } -> { ok, kind, id }
 *                       kind "reminder": dismisses (cancelReminder)
 *                       kind "goal": completes the goal
 *                       kind "task": NOT supported (400)
 *   tasks.cancel   { kind, id, confirm? } -> { ok, kind, id }
 *                       kind "reminder": dismisses
 *                       kind "task": deletes the scheduled task (needs confirm:true)
 *                       kind "goal": NOT supported (400)
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "tsk.sub": "Reminders, scheduled tasks and goals.",
      "tsk.reminders": "Reminders",
      "tsk.tasks": "Tasks",
      "tsk.goals": "Goals",
      "tsk.complete": "Complete",
      "tsk.cancel": "Cancel",
      "tsk.due": "Due",
      "tsk.nextRun": "Next run",
      "tsk.done": "Recorded",
      "tsk.cancelConfirm": "Delete this scheduled task?",
      "tsk.empty": "Nothing here"
    });

  var GROUP_META = {
    reminder: { titleKey: "tsk.reminders", icon: "bell", cardIcon: "amber" },
    task: { titleKey: "tsk.tasks", icon: "clock", cardIcon: "blue" },
    goal: { titleKey: "tsk.goals", icon: "target", cardIcon: "green" },
  };

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtTs(ts) {
    var n = Number(ts);
    if (!n) return "";
    var loc = "en-US";
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

  function loadingHtml(t) {
    return '<div class="loading-state"><div class="spinner"></div><div>' + esc(t("state.loading")) + "</div></div>";
  }

  function errorHtml(t, err) {
    return (
      '<div class="card"><div class="error-state"><div class="error-ic">' + window.AppIcons.svg("alert") + "</div>" +
      "<p>" + esc(t("state.error")) + "</p>" +
      (err && err.message ? '<div class="mx-kv" style="margin-bottom:12px">' + esc(err.message) + "</div>" : "") +
      '<button class="btn btn-primary" data-retry>' + window.AppIcons.svg("refresh") + esc(t("action.retry")) + "</button>" +
      "</div></div>"
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
    var I = window.AppIcons.svg;
    el.innerHTML = ctx.pageHead("tasks", t("sec.tasks"), t("tsk.sub")) + loadingHtml(t);

    async function load() {
      el.innerHTML = ctx.pageHead("tasks", t("sec.tasks"), t("tsk.sub")) + loadingHtml(t);
      try {
        var r = await ctx.api("tasks.list", {});
        var g = normGroups(r);

        function groupHtml(kind, items) {
          var meta = GROUP_META[kind];
          var body = items.length
            ? items
                .map(function (it, i) {
                  var id = it.id !== undefined ? it.id : it.key;
                  var text = it.text || it.title || it.name || "";
                  var due = it.dueAtMs || it.due || it.dueAt || it.remindAt || it.deadline;
                  var nextRun = kind === "task" ? it.nextRunAtMs : null;
                  // The backend only supports: reminder → complete+cancel,
                  // task → cancel (with confirm), goal → complete.
                  var showComplete = kind === "reminder" || kind === "goal";
                  var showCancel = kind === "reminder" || kind === "task";
                  var meta2 =
                    (due ? '<span class="meta-chip">' + I("clock") + esc(t("tsk.due")) + ": " + esc(fmtTs(due)) + "</span>" : "") +
                    (nextRun ? '<span class="meta-chip">' + I("refresh") + esc(t("tsk.nextRun")) + ": " + esc(fmtTs(nextRun)) + "</span>" : "");
                  return (
                    '<div class="card" data-item data-idx="' + i + '" style="margin-bottom:9px">' +
                    '<div class="mx-item">' + esc(text) + "</div>" +
                    (meta2 ? '<div class="meta-chips" style="margin-top:8px">' + meta2 + "</div>" : "") +
                    '<div class="mx-actions">' +
                    (showComplete
                      ? '<button class="btn btn-sm btn-subtle" data-complete>' + I("check") + esc(t("tsk.complete")) + "</button>"
                      : "") +
                    (showCancel
                      ? '<button class="btn btn-sm btn-danger" data-cancel>' + I("x") + esc(t("tsk.cancel")) + "</button>"
                      : "") +
                    "</div></div>"
                  );
                })
                .join("")
            : '<div class="mx-center">' + esc(t("tsk.empty")) + "</div>";
          return (
            '<div class="card"><div class="card-head">' +
            '<div class="card-icon' + (meta.cardIcon ? " " + meta.cardIcon : "") + '">' + I(meta.icon) + "</div>" +
            "<div><h2 class=\"card-title\">" + esc(t(meta.titleKey)) + "</h2></div>" +
            '<div class="spacer"></div><span class="badge">' + items.length + "</span>" +
            "</div>" + body + "</div>"
          );
        }

        var order = [
          { kind: "reminder", items: g.reminders },
          { kind: "task", items: g.tasks },
          { kind: "goal", items: g.goals },
        ];
        el.innerHTML =
          ctx.pageHead("tasks", t("sec.tasks"), t("tsk.sub")) +
          order.map(function (o) { return { html: groupHtml(o.kind, o.items), kind: o.kind, items: o.items }; })
            .map(function (p) { return p.html; })
            .join("");

        // Wire each group's item cards to their own items.
        var cards = el.querySelectorAll(":scope > .card");
        order.forEach(function (o, pi) {
          var sec = cards[pi];
          if (!sec) return;
          Array.prototype.forEach.call(sec.querySelectorAll("[data-item]"), function (card, ci) {
            var it = o.items[ci];
            var id = it.id !== undefined ? it.id : it.key;
            function act(endpoint, params) {
              var btns = card.querySelectorAll("button");
              Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
              ctx
                .api(endpoint, params)
                .then(function () {
                  ctx.toast(t("tsk.done"), "ok");
                  load();
                })
                .catch(function (err) {
                  ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""), "err");
                  Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
                });
            }
            var completeBtn = card.querySelector("[data-complete]");
            if (completeBtn) {
              completeBtn.addEventListener("click", function () {
                act("tasks.complete", { kind: o.kind, id: id });
              });
            }
            var cancelBtn = card.querySelector("[data-cancel]");
            if (cancelBtn) {
              cancelBtn.addEventListener("click", async function () {
                var params = { kind: o.kind, id: id };
                if (o.kind === "task") {
                  var ok = await ctx.confirmDialog(t("dialog.confirmTitle"), t("tsk.cancelConfirm"));
                  if (!ok) return;
                  params.confirm = true;
                }
                act("tasks.cancel", params);
              });
            }
          });
        });
      } catch (err) {
        el.innerHTML = ctx.pageHead("tasks", t("sec.tasks"), t("tsk.sub")) + errorHtml(t, err);
        var b = el.querySelector("[data-retry]");
        if (b) b.addEventListener("click", load);
      }
    }

    await load();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("tasks", { titleKey: "sec.tasks", icon: "tasks", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
