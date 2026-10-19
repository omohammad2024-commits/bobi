/* BOBI Mini App · section: groups
 * Owner-only: group list → tap → detail with group-assistant settings,
 * group digest config, and auto-moderation (rendered dynamically from the
 * backend's schema). ctx.api only. */
(function () {
  "use strict";

  function RS(fa, en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(fa, en);
    }
  }

  RS(
    {
      "grp.list.title": "گروه‌ها",
      "grp.assistant.title": "دستیار گروه",
      "grp.assistant.desc": "پاسخ‌گویی هوشمند در گروه (فقط با اجازهٔ شما)",
      "grp.digests.title": "دایجست گروه",
      "grp.mod.title": "مدیریت خودکار",
      "grp.members": "عضو",
      "grp.saved": "ذخیره شد ✓",
      "grp.empty": "گروهی ثبت نشده است",
      "grp.open": "باز کردن"
    },
    {
      "grp.list.title": "Groups",
      "grp.assistant.title": "Group assistant",
      "grp.assistant.desc": "Smart replies in the group (only with your opt-in)",
      "grp.digests.title": "Group digest",
      "grp.mod.title": "Auto moderation",
      "grp.members": "members",
      "grp.saved": "Saved ✓",
      "grp.empty": "No groups yet",
      "grp.open": "Open"
    }
  );

  var selected = null; // selected group object

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function lang() {
    return (window.I18N && window.I18N.getLang && window.I18N.getLang()) || "fa";
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
      ".mx-gitem{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:start;min-height:60px;background:var(--card,#fff);border:1px solid var(--border,#e2e2e2);border-radius:12px;padding:12px 14px;margin-bottom:8px;font-size:15px}" +
      ".mx-toggle{min-width:64px;min-height:44px;border-radius:22px;border:1px solid var(--border,#e2e2e2);background:var(--muted-bg,#eee);font-size:13px}" +
      ".mx-toggle[aria-checked=true]{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}" +
      ".mx-field{margin:10px 0}" +
      ".mx-field label{display:block;font-size:13px;margin-bottom:6px;color:var(--muted,#555)}" +
      ".mx-field .input,.mx-field select,.mx-field textarea{min-height:44px;width:100%}" +
      ".mx-field textarea{min-height:80px}" +
      ".mx-kv{font-size:12px;color:var(--muted,#777);word-break:break-all}" +
      ".mx-btnrow{display:flex;gap:8px;margin-top:10px}" +
      ".mx-btnrow .btn{flex:1;min-height:44px}" +
      ".mx-back{min-height:44px;margin-bottom:10px}" +
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

  function toggleHtml(on, t, id) {
    return (
      '<button class="mx-toggle"' + (id ? ' id="' + id + '"' : "") + ' aria-checked="' + (on ? "true" : "false") + '">' +
      esc(on ? t("action.toggleOn") : t("action.toggleOff")) + "</button>"
    );
  }

  function wireToggle(btn, t) {
    btn.addEventListener("click", function () {
      var on = btn.getAttribute("aria-checked") !== "true";
      btn.setAttribute("aria-checked", on ? "true" : "false");
      btn.textContent = on ? t("action.toggleOn") : t("action.toggleOff");
    });
  }

  /* --- Dynamic schema-driven form ---------------------------------------
   * Accepts either {schema:{fields:[{key,label,type,options,hint}]}, values:{}}
   * or a flat values object (falls back to type inference). Returns
   * {html, read(root), wire(root)}. */
  function schemaForm(payload, t, prefix) {
    var schema = payload && payload.schema ? payload.schema : null;
    var values = (payload && payload.values) || payload || {};
    if (schema && !schema.fields && Array.isArray(schema)) schema = { fields: schema };
    var fields = [];
    var html;

    if (schema && Array.isArray(schema.fields) && schema.fields.length) {
      html = schema.fields
        .map(function (f, i) {
          var key = f.key || f.name;
          var id = prefix + "-" + i;
          var label = f.label || humanize(key);
          var v = values[key];
          if (f.type === "boolean" || typeof v === "boolean") {
            fields.push({ id: id, key: key, type: "bool" });
            return (
              '<div class="mx-field"><div class="mx-row"><label for="' + id + '">' + esc(label) +
              (f.hint ? '<div class="mx-muted">' + esc(f.hint) + "</div>" : "") + "</label>" +
              toggleHtml(!!v, t, id) + "</div></div>"
            );
          }
          if (f.type === "select" && Array.isArray(f.options)) {
            fields.push({ id: id, key: key, type: "select" });
            return (
              '<div class="mx-field"><label for="' + id + '">' + esc(label) + "</label>" +
              '<select class="input" id="' + id + '">' +
              f.options
                .map(function (o) {
                  var ov = typeof o === "string" ? o : o.value;
                  var ol = typeof o === "string" ? o : o.label || o.value;
                  return '<option value="' + esc(ov) + '"' + (String(v) === String(ov) ? " selected" : "") + ">" + esc(ol) + "</option>";
                })
                .join("") + "</select></div>"
            );
          }
          var type = f.type === "number" || typeof v === "number" ? "number" : "text";
          if (f.type === "time" || (/time|hour/i.test(key) && typeof v === "string" && /^\d{1,2}:\d{2}/.test(v))) type = "time";
          if (f.type === "textarea") {
            fields.push({ id: id, key: key, type: "textarea" });
            return (
              '<div class="mx-field"><label for="' + id + '">' + esc(label) + "</label>" +
              '<textarea class="input" id="' + id + '">' + esc(v !== undefined ? v : "") + "</textarea></div>"
            );
          }
          fields.push({ id: id, key: key, type: type });
          return (
            '<div class="mx-field"><label for="' + id + '">' + esc(label) + "</label>" +
            '<input class="input" id="' + id + '" type="' + type + '" value="' + esc(v !== undefined ? v : "") + '"/></div>'
          );
        })
        .join("");
    } else {
      // Flat object fallback: infer controls from value types.
      html = Object.keys(values)
        .filter(function (k) { return typeof values[k] !== "object" || values[k] === null; })
        .map(function (k, i) {
          var v = values[k];
          var id = prefix + "-" + i;
          var label = humanize(k);
          if (typeof v === "boolean") {
            fields.push({ id: id, key: k, type: "bool" });
            return (
              '<div class="mx-field"><div class="mx-row"><label for="' + id + '">' + esc(label) + "</label>" +
              toggleHtml(v, t, id) + "</div></div>"
            );
          }
          var type = typeof v === "number" ? "number" : "text";
          fields.push({ id: id, key: k, type: type });
          return (
            '<div class="mx-field"><label for="' + id + '">' + esc(label) + "</label>" +
            '<input class="input" id="' + id + '" type="' + type + '" value="' + esc(v !== undefined ? v : "") + '"/></div>'
          );
        })
        .join("");
    }

    return {
      html: html,
      wire: function (root) {
        fields.forEach(function (f) {
          if (f.type !== "bool") return;
          var n = root.querySelector("#" + f.id);
          if (n) wireToggle(n, t);
        });
      },
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
      }
    };
  }

  async function showList(el, ctx) {
    var t = ctx.t;
    el.innerHTML = styleTag() + loadingHtml(t);
    try {
      var r = await ctx.api("groups.list", {});
      var groups = r.groups || r.items || [];
      if (!groups.length) {
        el.innerHTML = styleTag() + '<div class="mx-center">' + esc(t("grp.empty")) + "</div>";
        return;
      }
      el.innerHTML =
        styleTag() +
        '<div class="mx-secttl">👥 ' + esc(t("grp.list.title")) + "</div>" +
        groups
          .map(function (g, i) {
            var title = g.title || g.name || g.id;
            var meta = [];
            if (g.memberCount || g.members) meta.push(num(g.memberCount || g.members) + " " + t("grp.members"));
            return (
              '<button class="mx-gitem" data-g="' + i + '"><span><strong>' + esc(title) + "</strong>" +
              (meta.length ? '<div class="mx-muted">' + esc(meta.join(" · ")) + "</div>" : "") +
              '</span><span>‹</span></button>'
            );
          })
          .join("");
      Array.prototype.forEach.call(el.querySelectorAll("[data-g]"), function (b) {
        b.addEventListener("click", function () {
          selected = groups[Number(b.getAttribute("data-g"))];
          showDetail(el, ctx);
        });
      });
    } catch (err) {
      el.innerHTML = styleTag() + errorHtml(t, err);
      var rb = el.querySelector("[data-retry]");
      if (rb) rb.addEventListener("click", function () { showList(el, ctx); });
    }
  }

  function num(n) {
    var v = Number(n);
    if (!isFinite(v)) return String(n);
    try {
      return v.toLocaleString(lang() === "fa" ? "fa-IR" : "en-US");
    } catch (e) {
      return String(v);
    }
  }

  async function showDetail(el, ctx) {
    var t = ctx.t;
    var g = selected;
    if (!g) { showList(el, ctx); return; }
    var gid = g.id !== undefined ? g.id : g.groupId;
    var title = g.title || g.name || gid;
    el.innerHTML = styleTag() + loadingHtml(t);

    var assistant = null, digests = null, moderation = null;
    try {
      try { var ra = await ctx.api("groups.assistant", { groupId: gid }); assistant = ra.assistant || ra; } catch (e1) {}
      try { var rd = await ctx.api("groups.digests", { groupId: gid }); digests = rd.digests || rd.digest || rd; } catch (e2) {}
      try { var rm = await ctx.api("moderation.get", { groupId: gid }); moderation = rm.moderation || rm; } catch (e3) {}
    } catch (err) {
      el.innerHTML = styleTag() + errorHtml(t, err);
      var rb = el.querySelector("[data-retry]");
      if (rb) rb.addEventListener("click", function () { showDetail(el, ctx); });
      return;
    }

    var asstForm = assistant ? schemaForm(assistant, t, "asst") : null;
    var digForm = digests ? schemaForm(digests, t, "dig") : null;
    var modForm = moderation ? schemaForm(moderation, t, "mod") : null;

    el.innerHTML =
      styleTag() +
      '<button class="btn mx-back" data-back>‹ ' + esc(t("nav.back")) + "</button>" +
      '<div class="mx-secttl">👥 ' + esc(title) + "</div>" +
      (asstForm
        ? '<div class="card"><div class="mx-secttl">🤖 ' + esc(t("grp.assistant.title")) + "</div>" +
          '<div class="mx-muted" style="margin-bottom:6px">' + esc(t("grp.assistant.desc")) + "</div>" +
          asstForm.html +
          '<div class="mx-btnrow"><button class="btn" data-save-asst>' + esc(t("action.save")) + "</button></div></div>"
        : "") +
      (digForm
        ? '<div class="card"><div class="mx-secttl">📰 ' + esc(t("grp.digests.title")) + "</div>" +
          digForm.html +
          '<div class="mx-btnrow"><button class="btn" data-save-dig>' + esc(t("action.save")) + "</button></div></div>"
        : "") +
      (modForm
        ? '<div class="card"><div class="mx-secttl">🛡️ ' + esc(t("grp.mod.title")) + "</div>" +
          modForm.html +
          '<div class="mx-btnrow"><button class="btn" data-save-mod>' + esc(t("action.save")) + "</button></div></div>"
        : "");

    if (asstForm) asstForm.wire(el);
    if (digForm) digForm.wire(el);
    if (modForm) modForm.wire(el);

    el.querySelector("[data-back]").addEventListener("click", function () {
      selected = null;
      showList(el, ctx);
    });

    function bindSave(sel, form, endpoint, extra) {
      var btn = el.querySelector(sel);
      if (!btn || !form) return;
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        try {
          var params = form.read(el);
          params.groupId = gid;
          if (extra) for (var k in extra) params[k] = extra[k];
          await ctx.api(endpoint, params);
          ctx.toast(t("grp.saved"));
        } catch (err) {
          ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
        } finally {
          btn.disabled = false;
        }
      });
    }

    // groups.assistant is a single endpoint: GET with {groupId}, SET by including values.
    bindSave("[data-save-asst]", asstForm, "groups.assistant");
    // groups.digests likewise: GET with {groupId}, SET by including values.
    bindSave("[data-save-dig]", digForm, "groups.digests");
    bindSave("[data-save-mod]", modForm, "moderation.set");
  }

  function render(el, ctx) {
    if (selected) showDetail(el, ctx);
    else showList(el, ctx);
    return Promise.resolve();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("groups", { titleKey: "sec.groups", icon: "👥", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
