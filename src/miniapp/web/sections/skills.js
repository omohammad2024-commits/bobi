/* BOBI Mini App · section: skills
 * Owner-only: list with enable toggles + trusted badges, install from
 * URL/text with review, uninstall with confirm, trust registry.
 * ctx.api only. Keys/secrets are never displayed. */
(function () {
  "use strict";

  function RS(fa, en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(fa, en);
    }
  }

  RS(
    {
      "sk.list.title": "مهارت‌های نصب‌شده",
      "sk.trusted": "مورد اعتماد ✓",
      "sk.uninstall": "حذف",
      "sk.uninstall.confirm": "این مهارت حذف شود؟",
      "sk.install.title": "نصب مهارت",
      "sk.install.url.ph": "آدرس مهارت (URL)",
      "sk.install.text.ph": "یا متن / مانیفست مهارت را اینجا بچسبان",
      "sk.install.btn": "نصب و بررسی",
      "sk.installed": "نصب شد ✓",
      "sk.review.title": "نتیجهٔ بررسی",
      "sk.disabled.note": "مهارت به‌صورت پیش‌فرض غیرفعال نصب شد؛ پس از بررسی، دستی فعالش کن.",
      "sk.trust.title": "رجیستری اعتماد",
      "sk.trust.add.ph": "نام ناشر",
      "sk.trust.remove.confirm": "این ناشر از رجیستری اعتماد حذف شود؟",
      "sk.empty": "مهارتی نصب نشده است",
      "sk.trust.empty": "ناشر مورداعتمادی ثبت نشده است",
      "sk.review.field.manifest": "مانیفست",
      "sk.review.field.permissions": "دسترسی‌ها",
      "sk.review.field.risk": "ریسک"
    },
    {
      "sk.list.title": "Installed skills",
      "sk.trusted": "Trusted ✓",
      "sk.uninstall": "Uninstall",
      "sk.uninstall.confirm": "Remove this skill?",
      "sk.install.title": "Install skill",
      "sk.install.url.ph": "Skill URL",
      "sk.install.text.ph": "Or paste skill text / manifest here",
      "sk.install.btn": "Install & review",
      "sk.installed": "Installed ✓",
      "sk.review.title": "Review result",
      "sk.disabled.note": "Installed disabled by default; enable it manually after review.",
      "sk.trust.title": "Trust registry",
      "sk.trust.add.ph": "Publisher name",
      "sk.trust.remove.confirm": "Remove this publisher from the trust registry?",
      "sk.empty": "No skills installed",
      "sk.trust.empty": "No trusted publishers",
      "sk.review.field.manifest": "Manifest",
      "sk.review.field.permissions": "Permissions",
      "sk.review.field.risk": "Risk"
    }
  );

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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
      ".mx-field .input,.mx-field textarea{min-height:44px;width:100%}" +
      ".mx-field textarea{min-height:110px;font-family:monospace;font-size:13px}" +
      ".mx-kv{font-size:12px;color:var(--muted,#777);word-break:break-all}" +
      ".mx-pre{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7}" +
      ".mx-btnrow{display:flex;gap:8px;margin-top:10px}" +
      ".mx-btnrow .btn{flex:1;min-height:44px}" +
      ".mx-note{background:var(--warn-bg,#fff8e1);border:1px solid var(--warn-border,#ffe082);border-radius:10px;padding:10px 12px;font-size:13px;margin-top:10px}" +
      ".mx-dl{margin:6px 0;font-size:13px}" +
      ".mx-dl dt{font-weight:600;color:var(--muted,#555);font-size:12px}" +
      ".mx-dl dd{margin:2px 0 8px}" +
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

  function valHtml(v) {
    if (v === undefined || v === null) return "—";
    if (Array.isArray(v)) return esc(v.join(", "));
    if (typeof v === "object") return "<code class=\"mx-pre\">" + esc(JSON.stringify(v, null, 1)) + "</code>";
    return esc(String(v));
  }

  /* Render the review payload generically: highlight known fields, then the rest. */
  function reviewHtml(r, t) {
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
      '<div class="card"><div class="mx-secttl">' + esc(t("sk.review.title")) +
      (name ? ": " + esc(name) : "") + "</div>" +
      '<dl class="mx-dl">' + rows + rest + "</dl>" +
      '<div class="mx-note">🔒 ' + esc(t("sk.disabled.note")) + "</div></div>"
    );
  }

  async function render(el, ctx) {
    var t = ctx.t;
    el.innerHTML = styleTag() + loadingHtml(t);

    async function load() {
      el.innerHTML = styleTag() + loadingHtml(t);
      var skills = [], trusted = [];
      try {
        try { var r1 = await ctx.api("skills.list", {}); skills = r1.skills || r1.items || []; } catch (e1) {}
        try { var r2 = await ctx.api("trust.list", {}); trusted = r2.publishers || r2.trusted || r2.items || []; } catch (e2) {}
      } catch (err) {
        el.innerHTML = styleTag() + errorHtml(t, err);
        var rb = el.querySelector("[data-retry]");
        if (rb) rb.addEventListener("click", load);
        return;
      }

      var skillsHtml = skills.length
        ? skills
            .map(function (s, i) {
              var name = s.name || s.id;
              return (
                '<div class="card" data-s="' + i + '"><div class="mx-row"><div>' +
                "<div><strong>" + esc(s.title || name) + "</strong> " +
                (s.trusted ? '<span class="badge">' + esc(t("sk.trusted")) + "</span>" : "") + "</div>" +
                (s.description ? '<div class="mx-muted">' + esc(s.description) + "</div>" : "") +
                (s.version ? '<div class="mx-kv">v' + esc(s.version) + "</div>" : "") +
                '</div><div data-tog>' + toggleHtml(!!s.enabled, t) + "</div></div>" +
                '<div class="mx-btnrow"><button class="btn" data-uninstall style="color:var(--danger,#d32f2f)">' +
                esc(t("sk.uninstall")) + "</button></div></div>"
              );
            })
            .join("")
        : '<div class="mx-center">' + esc(t("sk.empty")) + "</div>";

      var trustHtml = trusted.length
        ? trusted
            .map(function (p, i) {
              var name = typeof p === "string" ? p : p.publisher || p.name || "";
              return (
                '<div class="card" data-p="' + i + '"><div class="mx-row"><div><strong>' + esc(name) + "</strong></div>" +
                '<button class="btn" data-rm style="min-height:44px;color:var(--danger,#d32f2f)">' +
                esc(t("action.delete")) + "</button></div></div>"
              );
            })
            .join("")
        : '<div class="mx-center">' + esc(t("sk.trust.empty")) + "</div>";

      el.innerHTML =
        styleTag() +
        '<div class="card"><div class="mx-secttl">🧩 ' + esc(t("sk.list.title")) + "</div>" + skillsHtml + "</div>" +
        '<div class="card"><div class="mx-secttl">⬇️ ' + esc(t("sk.install.title")) + "</div>" +
        '<div class="mx-field"><input class="input" data-url dir="ltr" placeholder="' + esc(t("sk.install.url.ph")) + '"/></div>' +
        '<div class="mx-field"><textarea class="input" data-text dir="ltr" placeholder="' + esc(t("sk.install.text.ph")) + '"></textarea></div>' +
        '<div class="mx-btnrow"><button class="btn" data-install>' + esc(t("sk.install.btn")) + "</button></div>" +
        '<div data-review></div></div>' +
        '<div class="card"><div class="mx-secttl">🛡️ ' + esc(t("sk.trust.title")) + "</div>" + trustHtml +
        '<div class="mx-field" style="display:flex;gap:8px;margin-top:12px">' +
        '<input class="input" data-pub style="flex:1;min-height:44px" placeholder="' + esc(t("sk.trust.add.ph")) + '"/>' +
        '<button class="btn" data-addpub style="min-height:44px">' + esc(t("action.add")) + "</button></div></div>";

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
            ctx.toast(t("toast.saved"));
          } catch (err) {
            ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
          } finally {
            btn.disabled = false;
          }
        });
        card.querySelector("[data-uninstall]").addEventListener("click", async function () {
          var ok = await ctx.confirmDialog(t("dialog.confirmTitle"), t("sk.uninstall.confirm"));
          if (!ok) return;
          try {
            await ctx.api("skills.uninstall", { name: s.name || s.id });
            ctx.toast(t("toast.deleted"));
            load();
          } catch (err) {
            ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
          }
        });
      });

      // trust add/remove
      el.querySelector("[data-addpub]").addEventListener("click", async function () {
        var inp = el.querySelector("[data-pub]");
        var name = inp.value.trim();
        if (!name) return;
        try {
          await ctx.api("trust.add", { publisher: name });
          ctx.toast(t("toast.saved"));
          load();
        } catch (err) {
          ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
        }
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-p]"), function (card) {
        var p = trusted[Number(card.getAttribute("data-p"))];
        var name = typeof p === "string" ? p : p.publisher || p.name || "";
        card.querySelector("[data-rm]").addEventListener("click", async function () {
          var ok = await ctx.confirmDialog(t("dialog.confirmTitle"), t("sk.trust.remove.confirm"));
          if (!ok) return;
          try {
            await ctx.api("trust.remove", { publisher: name });
            ctx.toast(t("toast.deleted"));
            load();
          } catch (err) {
            ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
          }
        });
      });

      // install
      var instBtn = el.querySelector("[data-install]");
      instBtn.addEventListener("click", async function () {
        var url = el.querySelector("[data-url]").value.trim();
        var text = el.querySelector("[data-text]").value.trim();
        if (!url && !text) return;
        var box = el.querySelector("[data-review]");
        instBtn.disabled = true;
        box.innerHTML = loadingHtml(t);
        try {
          var payload = url ? { url: url } : { text: text };
          var r = await ctx.api("skills.install", payload);
          ctx.toast(t("sk.installed"));
          box.innerHTML = reviewHtml(r, t);
          el.querySelector("[data-url]").value = "";
          el.querySelector("[data-text]").value = "";
          // refresh list silently in background
          ctx.api("skills.list", {}).then(function () { load(); }).catch(function () {});
        } catch (err) {
          box.innerHTML = errorHtml(t, err);
          var b2 = box.querySelector("[data-retry]");
          if (b2) b2.addEventListener("click", function () { instBtn.click(); });
        } finally {
          instBtn.disabled = false;
        }
      });
    }

    await load();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("skills", { titleKey: "sec.skills", icon: "🧩", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
