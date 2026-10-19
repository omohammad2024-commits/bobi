/* BOBI Mini App · section: schedulers
 * Owner-only: scheduler list with enable toggles, daily digest preview &
 * config, per-group digests. ctx.api only. */
(function () {
  "use strict";

  function RS(fa, en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(fa, en);
    }
  }

  RS(
    {
      "sch.list.title": "زمان‌بندها",
      "sch.next": "اجرای بعدی",
      "sch.digest.title": "دایجست روزانه",
      "sch.digest.preview.btn": "نمایش پیش‌نمایش",
      "sch.digest.config.title": "تنظیمات دایجست",
      "sch.gdigest.title": "دایجست گروه‌ها",
      "sch.toggled": "ذخیره شد ✓",
      "sch.empty": "زمان‌بندی ثبت نشده است",
      "sch.gempty": "گروهی ثبت نشده است"
    },
    {
      "sch.list.title": "Schedulers",
      "sch.next": "Next run",
      "sch.digest.title": "Daily digest",
      "sch.digest.preview.btn": "Show preview",
      "sch.digest.config.title": "Digest settings",
      "sch.gdigest.title": "Group digests",
      "sch.toggled": "Saved ✓",
      "sch.empty": "No schedulers yet",
      "sch.gempty": "No groups yet"
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
    if (!n) return "—";
    var loc = lang() === "fa" ? "fa-IR" : "en-US";
    try {
      return new Date(n).toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return new Date(n).toLocaleString();
    }
  }

  function humanize(k) {
    return String(k).replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  }

  function styleTag() {
    return (
      "<style>" +
      ".mx-spin{width:28px;height:28px;margin:18px auto;border:3px solid var(--border,#e2e2e2);border-top-color:var(--accent,#2a7fff);border-radius:50%;animation:mxrot 0.8s linear infinite}" +
      "@keyframes mxrot{to{transform:rotate(360deg)}}" +
      ".mx-center{text-align:center;padding:26px 12px;color:var(--muted,#777)}" +
      ".mx-row{display:flex;align-items:center;justify-content:space-between;gap:10px}" +
      ".mx-muted{font-size:12px;color:var(--muted,#777)}" +
      ".mx-secttl{font-weight:700;margin:2px 0 8px;font-size:15px}" +
      ".mx-toggle{min-width:64px;min-height:44px;border-radius:22px;border:1px solid var(--border,#e2e2e2);background:var(--muted-bg,#eee);font-size:13px}" +
      ".mx-toggle[aria-checked=true]{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}" +
      ".mx-field{margin:10px 0}" +
      ".mx-field label{display:block;font-size:13px;margin-bottom:6px;color:var(--muted,#555)}" +
      ".mx-field .input,.mx-field select{min-height:44px;width:100%}" +
      ".mx-pre{white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.8}" +
      ".mx-kv{font-size:12px;color:var(--muted,#777);word-break:break-all}" +
      ".mx-btnrow{display:flex;gap:8px;margin-top:10px}" +
      ".mx-btnrow .btn{flex:1;min-height:44px}" +
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

  function toggleHtml(on, t) {
    return (
      '<button class="mx-toggle" aria-checked="' + (on ? "true" : "false") + '">' +
      esc(on ? t("action.toggleOn") : t("action.toggleOff")) + "</button>"
    );
  }

  /* Build an editable form from a plain config object. Returns {html, read(root)}. */
  function configForm(cfg, t) {
    var fields = [];
    var html = Object.keys(cfg)
      .map(function (k, i) {
        var v = cfg[k];
        var id = "mx-cf-" + i;
        var label = humanize(k);
        if (typeof v === "boolean") {
          fields.push({ id: id, key: k, type: "bool" });
          return (
            '<div class="mx-field"><div class="mx-row"><label for="' + id + '">' + esc(label) + "</label>" +
            toggleHtml(v, t).replace('class="mx-toggle"', 'class="mx-toggle" id="' + id + '"') + "</div></div>"
          );
        }
        var type = typeof v === "number" ? "number" : "text";
        if (/time|hour/i.test(k) && typeof v === "string" && /^\d{1,2}:\d{2}/.test(v)) type = "time";
        fields.push({ id: id, key: k, type: type });
        return (
          '<div class="mx-field"><label for="' + id + '">' + esc(label) + "</label>" +
          '<input class="input" id="' + id + '" type="' + type + '" value="' + esc(v) + '"/></div>'
        );
      })
      .join("");
    return {
      html: html,
      read: function (root) {
        var out = {};
        fields.forEach(function (f) {
          var n = root.querySelector("#" + f.id);
          if (!n) return;
          if (f.type === "bool") out[f.key] = n.getAttribute("aria-checked") === "true";
          else if (f.type === "number") out[f.key] = Number(n.value);
          else out[f.key] = n.value;
        });
        return out;
      },
      wire: function (root) {
        fields.forEach(function (f) {
          if (f.type !== "bool") return;
          var n = root.querySelector("#" + f.id);
          if (n) n.addEventListener("click", function () {
            var on = n.getAttribute("aria-checked") !== "true";
            n.setAttribute("aria-checked", on ? "true" : "false");
            n.textContent = on ? t("action.toggleOn") : t("action.toggleOff");
          });
        });
      }
    };
  }

  async function render(el, ctx) {
    var t = ctx.t;
    el.innerHTML = styleTag() + loadingHtml(t);

    var data = { schedulers: [], digestConfig: null, groupDigests: [] };
    try {
      try { var r1 = await ctx.api("schedulers.list", {}); data.schedulers = r1.schedulers || r1.items || []; } catch (e1) {}
      try { var r2 = await ctx.api("digest.config", {}); data.digestConfig = r2.config || r2.digest || r2; } catch (e2) {}
      try { var r3 = await ctx.api("groupdigests.list", {}); data.groupDigests = r3.groups || r3.items || []; } catch (e3) {}
    } catch (err) {
      el.innerHTML = styleTag() + errorHtml(t, err);
      var rb = el.querySelector("[data-retry]");
      if (rb) rb.addEventListener("click", function () { render(el, ctx); });
      return;
    }

    var schedHtml = data.schedulers.length
      ? data.schedulers
          .map(function (s, i) {
            var id = s.id !== undefined ? s.id : s.key;
            var name = s.name || s.title || id;
            return (
              '<div class="card" data-s="' + i + '"><div class="mx-row"><div>' +
              "<div><strong>" + esc(name) + "</strong></div>" +
              (s.cron || s.schedule ? '<div class="mx-muted">⏰ ' + esc(s.cron || s.schedule) + "</div>" : "") +
              (s.nextRun || s.next_run ? '<div class="mx-muted">' + esc(t("sch.next")) + ": " + esc(fmtTs(s.nextRun || s.next_run)) + "</div>" : "") +
              '</div><div data-tog>' + toggleHtml(!!s.enabled, t) + "</div></div></div>"
            );
          })
          .join("")
      : '<div class="mx-center">' + esc(t("sch.empty")) + "</div>";

    var digestCfg = data.digestConfig && typeof data.digestConfig === "object" ? data.digestConfig : null;
    var form = digestCfg ? configForm(digestCfg, t) : null;

    var gdHtml = data.groupDigests.length
      ? data.groupDigests
          .map(function (g, i) {
            var gid = g.groupId !== undefined ? g.groupId : g.id;
            return (
              '<div class="card" data-g="' + i + '"><div class="mx-row"><div>' +
              "<div><strong>" + esc(g.title || g.name || gid) + "</strong></div>" +
              (g.time ? '<div class="mx-muted">⏰ ' + esc(g.time) + "</div>" : "") +
              '</div><div data-tog>' + toggleHtml(!!g.enabled, t) + "</div></div></div>"
            );
          })
          .join("")
      : '<div class="mx-center">' + esc(t("sch.gempty")) + "</div>";

    el.innerHTML =
      styleTag() +
      '<div class="card"><div class="mx-secttl">' + esc(t("sch.list.title")) + "</div>" + schedHtml + "</div>" +
      '<div class="card"><div class="mx-secttl">' + esc(t("sch.digest.title")) + "</div>" +
      '<div data-dpreview></div>' +
      '<div class="mx-btnrow"><button class="btn" data-preview>' + esc(t("sch.digest.preview.btn")) + "</button></div>" +
      (form ? '<div class="mx-secttl" style="margin-top:14px">' + esc(t("sch.digest.config.title")) + "</div>" +
        '<div data-dform>' + form.html + "</div>" +
        '<div class="mx-btnrow"><button class="btn" data-dsave>' + esc(t("action.save")) + "</button></div>" : "") +
      "</div>" +
      '<div class="card"><div class="mx-secttl">' + esc(t("sch.gdigest.title")) + "</div>" + gdHtml + "</div>";

    // scheduler toggles
    Array.prototype.forEach.call(el.querySelectorAll("[data-s]"), function (card) {
      var s = data.schedulers[Number(card.getAttribute("data-s"))];
      var btn = card.querySelector("[data-tog] .mx-toggle");
      btn.addEventListener("click", async function () {
        var next = btn.getAttribute("aria-checked") !== "true";
        btn.disabled = true;
        try {
          await ctx.api("schedulers.toggle", { id: s.id !== undefined ? s.id : s.key, enabled: next });
          btn.setAttribute("aria-checked", next ? "true" : "false");
          btn.textContent = next ? t("action.toggleOn") : t("action.toggleOff");
          ctx.toast(t("sch.toggled"));
        } catch (err) {
          ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
        } finally {
          btn.disabled = false;
        }
      });
    });

    // group digest toggles
    Array.prototype.forEach.call(el.querySelectorAll("[data-g]"), function (card) {
      var g = data.groupDigests[Number(card.getAttribute("data-g"))];
      var btn = card.querySelector("[data-tog] .mx-toggle");
      btn.addEventListener("click", async function () {
        var next = btn.getAttribute("aria-checked") !== "true";
        btn.disabled = true;
        try {
          await ctx.api("groupdigests.set", { groupId: g.groupId !== undefined ? g.groupId : g.id, enabled: next });
          btn.setAttribute("aria-checked", next ? "true" : "false");
          btn.textContent = next ? t("action.toggleOn") : t("action.toggleOff");
          ctx.toast(t("sch.toggled"));
        } catch (err) {
          ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
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
          ? '<div class="card"><div class="mx-pre">' + esc(text) + "</div></div>"
          : '<div class="mx-center">' + esc(t("state.empty")) + "</div>";
      } catch (err) {
        pvBox.innerHTML = errorHtml(t, err);
        var b2 = pvBox.querySelector("[data-retry]");
        if (b2) b2.addEventListener("click", function () { pvBtn.click(); });
      }
    });

    // digest config save
    if (form) {
      form.wire(el);
      var saveBtn = el.querySelector("[data-dsave]");
      saveBtn.addEventListener("click", async function () {
        saveBtn.disabled = true;
        try {
          await ctx.api("digest.config", { config: form.read(el) });
          ctx.toast(t("toast.saved"));
        } catch (err) {
          ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
        } finally {
          saveBtn.disabled = false;
        }
      });
    }
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("schedulers", { titleKey: "sec.schedulers", icon: "⏰", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
