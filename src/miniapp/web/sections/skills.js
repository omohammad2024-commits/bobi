/* BOBI Mini App · section: skills
 * Owner-only: list with enable toggles + trusted badges, install from
 * URL/text with review, uninstall with confirm, trust registry.
 * ctx.api only. Keys/secrets are never displayed.
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   skills.list     {} -> { ok, skills: [{ name, enabled, trusted, version? }] }
 *   skills.toggle   { name, enabled } -> { ok, name, enabled }
 *   skills.install  { source, confirm? } -> { ok, review, needsConfirm:true }   (review step)
 *                  { source, confirm:true } -> { ok, installed:true, name, enabled:false }
 *   skills.uninstall { name, confirm:true } -> { ok, name, removed:true }
 *   trust.list      {} -> { ok, publishers: [{ keyId, shortKeyId, label, addedAtMs }] }
 *   trust.add       { publisher, label? } -> { ok, keyId, label, added }
 *   trust.remove    { publisher, confirm:true } -> { ok, keyId, removed:true }
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "sk.sub": "Extend BOBI with installable skills.",
      "sk.list.title": "Installed skills",
      "sk.list.sub": "Toggle skills on or off",
      "sk.trusted": "Trusted",
      "sk.uninstall": "Uninstall",
      "sk.uninstall.confirm": "Remove this skill?",
      "sk.install.title": "Install skill",
      "sk.install.sub": "From a URL or pasted text",
      "sk.install.url.label": "Skill URL",
      "sk.install.text.label": "Or paste the skill text / manifest",
      "sk.install.btn": "Install & review",
      "sk.install.confirmBtn": "Confirm & install",
      "sk.install.confirmNote": "Read the review? Confirming installs the skill (stays disabled).",
      "sk.installed": "Installed",
      "sk.review.title": "Review result",
      "sk.disabled.note": "Installed disabled by default; enable it manually after review.",
      "sk.trust.title": "Trust registry",
      "sk.trust.sub": "Publishers allowed to auto-install",
      "sk.trust.key.label": "Publisher key",
      "sk.trust.add.ph": "Key fingerprint (64 hex chars) or public key",
      "sk.trust.label.ph": "Label (optional)",
      "sk.trust.remove.confirm": "Remove this publisher from the trust registry?",
      "sk.empty": "No skills installed",
      "sk.trust.empty": "No trusted publishers",
      "sk.review.field.manifest": "Manifest",
      "sk.review.field.permissions": "Permissions",
      "sk.review.field.risk": "Risk"
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

  function toggleHtml(on, t) {
    return (
      '<button class="mx-toggle" aria-checked="' + (on ? "true" : "false") + '">' +
      esc(on ? t("action.toggleOn") : t("action.toggleOff")) + "</button>"
    );
  }

  function cardHead(I, ic, title, sub, icCls) {
    return (
      '<div class="card-head"><div class="card-icon' + (icCls ? " " + icCls : "") + '">' + I(ic) + "</div>" +
      "<div><h2 class=\"card-title\">" + esc(title) + "</h2>" +
      (sub ? '<p class="card-sub">' + esc(sub) + "</p>" : "") + "</div></div>"
    );
  }

  function valHtml(v) {
    if (v === undefined || v === null) return "—";
    if (Array.isArray(v)) return esc(v.join(", "));
    if (typeof v === "object") return "<code class=\"mx-pre mono\" style=\"margin-top:0\">" + esc(JSON.stringify(v, null, 1)) + "</code>";
    return esc(String(v));
  }

  /* Render the review payload generically: highlight known fields, then the rest. */
  function reviewHtml(r, t) {
    var I = window.AppIcons.svg;
    var rev = r.review || r.report || r;
    var name = r.name || rev.name;
    var keys = ["manifest", "permissions", "risk", "warnings", "files", "checksum", "publisher", "version"];
    var seen = {};
    var rows = keys
      .map(function (k) {
        var v = rev[k] !== undefined ? rev[k] : r[k];
        if (v === undefined) return "";
        seen[k] = true;
        var labelKey = "sk.review.field." + k;
        var label = t(labelKey) === labelKey ? k : t(labelKey);
        return '<dt>' + esc(label) + "</dt><dd>" + valHtml(v) + "</dd>";
      })
      .join("");
    var rest = Object.keys(rev)
      .filter(function (k) { return !seen[k] && k !== "name"; })
      .map(function (k) { return "<dt>" + esc(k) + "</dt><dd>" + valHtml(rev[k]) + "</dd>"; })
      .join("");
    return (
      '<div class="card" style="margin:12px 0 0"><div class="mx-secttl">' + I("fileText") + esc(t("sk.review.title")) +
      (name ? ": " + esc(name) : "") + "</div>" +
      '<dl class="mx-dl">' + rows + rest + "</dl>" +
      '<div class="note note-warn">' + I("lock") + "<span>" + esc(t("sk.disabled.note")) + "</span></div></div>"
    );
  }

  async function render(el, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    el.innerHTML = ctx.pageHead("blocks", t("sec.skills"), t("sk.sub")) + loadingHtml(t);

    async function load() {
      el.innerHTML = ctx.pageHead("blocks", t("sec.skills"), t("sk.sub")) + loadingHtml(t);
      var skills = [], trusted = [];
      try {
        try { var r1 = await ctx.api("skills.list", {}); skills = r1.skills || r1.items || []; } catch (e1) {}
        try { var r2 = await ctx.api("trust.list", {}); trusted = r2.publishers || r2.trusted || r2.items || []; } catch (e2) {}
      } catch (err) {
        el.innerHTML = ctx.pageHead("blocks", t("sec.skills"), t("sk.sub")) + errorHtml(t, err);
        var rb = el.querySelector("[data-retry]");
        if (rb) rb.addEventListener("click", load);
        return;
      }

      var skillsHtml = skills.length
        ? skills
            .map(function (s, i) {
              var name = s.name || s.id;
              return (
                '<div class="card" data-s="' + i + '" style="margin-bottom:9px"><div class="mx-row"><div style="min-width:0">' +
                "<div class=\"mx-item\">" + esc(s.title || name) + " " +
                (s.trusted ? '<span class="badge badge-success">' + I("shield") + esc(t("sk.trusted")) + "</span>" : "") + "</div>" +
                (s.description ? '<div class="mx-muted">' + esc(s.description) + "</div>" : "") +
                (s.version ? '<div class="mx-kv">v' + esc(s.version) + "</div>" : "") +
                '</div><div data-tog>' + toggleHtml(!!s.enabled, t) + "</div></div>" +
                '<div class="mx-btnrow"><button class="btn btn-sm btn-danger" data-uninstall>' +
                I("trash") + esc(t("sk.uninstall")) + "</button></div></div>"
              );
            })
            .join("")
        : '<div class="card"><div class="empty-state"><div class="empty-ic">' + I("blocks") + "</div>" +
          '<p class="empty-title">' + esc(t("sk.empty")) + "</p></div></div>";

      var trustHtml = trusted.length
        ? trusted
            .map(function (p, i) {
              var label = typeof p === "string" ? p : p.label || p.shortKeyId || p.keyId || "";
              var sub = typeof p === "object" && p.keyId ? p.keyId : "";
              return (
                '<div class="card" data-p="' + i + '" style="margin-bottom:9px"><div class="mx-row"><div style="min-width:0">' +
                '<div class="mx-item">' + esc(label) + "</div>" +
                (sub ? '<div class="mx-kv mono" dir="ltr">' + esc(sub) + "</div>" : "") +
                "</div>" +
                '<button class="btn btn-icon btn-danger" data-rm aria-label="' + esc(t("action.delete")) + '">' +
                I("trash") + "</button></div></div>"
              );
            })
            .join("")
        : '<div class="card"><div class="mx-center">' + esc(t("sk.trust.empty")) + "</div></div>";

      el.innerHTML =
        ctx.pageHead("blocks", t("sec.skills"), t("sk.sub")) +
        '<div class="card">' + cardHead(I, "blocks", t("sk.list.title"), t("sk.list.sub")) + skillsHtml + "</div>" +
        '<div class="card">' + cardHead(I, "download", t("sk.install.title"), t("sk.install.sub"), "blue") +
        '<div class="field"><label>' + esc(t("sk.install.url.label")) + "</label>" +
        '<input class="input" data-url dir="ltr" placeholder="https://…" autocomplete="off"/></div>' +
        '<div class="field"><label>' + esc(t("sk.install.text.label")) + "</label>" +
        '<textarea class="input mono" data-text dir="ltr" placeholder="---&#10;name: my-skill&#10;---"></textarea></div>' +
        '<div class="mx-btnrow"><button class="btn btn-primary" data-install>' + I("search") + esc(t("sk.install.btn")) + "</button></div>" +
        '<div data-review></div></div>' +
        '<div class="card">' + cardHead(I, "shield", t("sk.trust.title"), t("sk.trust.sub"), "green") + trustHtml +
        '<div class="group-label">' + I("plus") + esc(t("action.add")) + "</div>" +
        '<div class="field"><label>' + esc(t("sk.trust.key.label")) + "</label>" +
        '<input class="input mono" dir="ltr" data-pubkey autocomplete="off" placeholder="' + esc(t("sk.trust.add.ph")) + '"/></div>' +
        '<div class="field" style="display:flex;gap:8px;align-items:flex-end">' +
        '<div style="flex:1"><label>' + esc(t("sk.trust.label.ph")) + '</label><input class="input" data-publabel autocomplete="off"/></div>' +
        '<button class="btn btn-primary" data-addpub style="min-height:46px">' + I("plus") + esc(t("action.add")) + "</button></div></div>";

      // toggles
      Array.prototype.forEach.call(el.querySelectorAll("[data-s]"), function (card) {
        var s = skills[Number(card.getAttribute("data-s"))];
        var btn = card.querySelector("[data-tog] .mx-toggle");
        btn.addEventListener("click", async function () {
          var next = btn.getAttribute("aria-checked") !== "true";
          btn.disabled = true;
          try {
            await ctx.api("skills.toggle", { name: s.name || s.id, enabled: next });
            btn.setAttribute("aria-checked", next ? "true" : "false");
            btn.textContent = next ? t("action.toggleOn") : t("action.toggleOff");
            ctx.toast(t("toast.saved"), "ok");
          } catch (err) {
            ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""), "err");
          } finally {
            btn.disabled = false;
          }
        });
        card.querySelector("[data-uninstall]").addEventListener("click", async function () {
          var ok = await ctx.confirmDialog(t("dialog.confirmTitle"), t("sk.uninstall.confirm"));
          if (!ok) return;
          try {
            await ctx.api("skills.uninstall", { name: s.name || s.id, confirm: true });
            ctx.toast(t("toast.deleted"), "ok");
            load();
          } catch (err) {
            ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""), "err");
          }
        });
      });

      // trust add/remove — the backend takes a key fingerprint or public
      // key as `publisher`, plus an optional `label`.
      el.querySelector("[data-addpub]").addEventListener("click", async function () {
        var key = el.querySelector("[data-pubkey]").value.trim();
        if (!key) return;
        var label = el.querySelector("[data-publabel]").value.trim();
        try {
          await ctx.api("trust.add", label ? { publisher: key, label: label } : { publisher: key });
          ctx.toast(t("toast.saved"), "ok");
          load();
        } catch (err) {
          ctx.toast((err && err.message) || t("toast.failed"), "err");
        }
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-p]"), function (card) {
        var p = trusted[Number(card.getAttribute("data-p"))];
        var keyId = typeof p === "string" ? p : p.keyId || "";
        card.querySelector("[data-rm]").addEventListener("click", async function () {
          var ok = await ctx.confirmDialog(t("dialog.confirmTitle"), t("sk.trust.remove.confirm"));
          if (!ok) return;
          try {
            await ctx.api("trust.remove", { publisher: keyId, confirm: true });
            ctx.toast(t("toast.deleted"), "ok");
            load();
          } catch (err) {
            ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""), "err");
          }
        });
      });

      // install: two steps — review first, then confirm to actually install.
      var instBtn = el.querySelector("[data-install]");
      var pendingSource = null;
      instBtn.addEventListener("click", async function () {
        var url = el.querySelector("[data-url]").value.trim();
        var text = el.querySelector("[data-text]").value.trim();
        if (!url && !text) return;
        var box = el.querySelector("[data-review]");
        instBtn.disabled = true;
        box.innerHTML = loadingHtml(t);
        try {
          var source = url || text;
          var r = await ctx.api("skills.install", { source: source });
          pendingSource = source;
          box.innerHTML =
            reviewHtml(r, t) +
            '<div class="note note-warn">' + I("lock") + "<span>" + esc(t("sk.install.confirmNote")) + "</span></div>" +
            '<div class="mx-btnrow"><button class="btn btn-primary" data-confirm-install>' +
            I("check") + esc(t("sk.install.confirmBtn")) + "</button></div>";
          wireConfirm(box);
        } catch (err) {
          box.innerHTML = errorHtml(t, err);
          var b2 = box.querySelector("[data-retry]");
          if (b2) b2.addEventListener("click", function () { instBtn.click(); });
        } finally {
          instBtn.disabled = false;
        }
      });

      function wireConfirm(box) {
        var cbtn = box.querySelector("[data-confirm-install]");
        if (!cbtn || !pendingSource) return;
        cbtn.addEventListener("click", async function () {
          cbtn.disabled = true;
          try {
            var r = await ctx.api("skills.install", { source: pendingSource, confirm: true });
            ctx.toast(t("sk.installed") + (r && r.name ? ": " + r.name : ""), "ok");
            box.innerHTML = '<div class="note note-warn">' + I("lock") + "<span>" + esc(t("sk.disabled.note")) + "</span></div>";
            el.querySelector("[data-url]").value = "";
            el.querySelector("[data-text]").value = "";
            pendingSource = null;
            load();
          } catch (err) {
            ctx.toast((err && err.message) || t("toast.failed"), "err");
            cbtn.disabled = false;
          }
        });
      }
    }

    await load();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("skills", { titleKey: "sec.skills", icon: "blocks", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
