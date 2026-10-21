/* BOBI Mini App · section: profile
 * Owner-only: view/edit the owner profile (identity, communication,
 * standing rules, projects, people, routines, technical facts, goals).
 * openSlots are shown as "not yet asked" placeholders — there is no
 * interview flow in the miniapp; this surface is view/edit only.
 * Same-origin /miniapp/api/* via ctx.api only.
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   profile.get   {}              -> { ok, profile }
 *   profile.save  { profile }     -> { ok, profile }
 * The editor is shape-driven: scalar fields get inputs, lists get a
 * per-item editor with add/remove, nested objects get grouped sub-fields —
 * so it renders whatever sections parseOwnerProfile produces.
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "sec.profile": "Profile",
      "prof.sub": "What BOBI knows about you — view and edit it here.",
      "prof.identity": "Identity",
      "prof.communication": "Communication",
      "prof.standingRules": "Standing rules",
      "prof.projects": "Projects",
      "prof.people": "People",
      "prof.routines": "Routines",
      "prof.technicalFacts": "Technical facts",
      "prof.goals": "Goals",
      "prof.openSlots": "Open slots",
      "prof.notYetAsked": "Not yet asked",
      "prof.add": "Add",
      "prof.remove": "Remove",
      "prof.save": "Save profile",
      "prof.saved": "Profile saved",
      "prof.emptySection": "Nothing here yet",
      "prof.item": "Item"
    });

  var SECTIONS = [
    { key: "identity", titleKey: "prof.identity", icon: "user" },
    { key: "communication", titleKey: "prof.communication", icon: "message" },
    { key: "standingRules", titleKey: "prof.standingRules", icon: "shield" },
    { key: "projects", titleKey: "prof.projects", icon: "layers" },
    { key: "people", titleKey: "prof.people", icon: "users" },
    { key: "routines", titleKey: "prof.routines", icon: "clock" },
    { key: "technicalFacts", titleKey: "prof.technicalFacts", icon: "cpu" },
    { key: "goals", titleKey: "prof.goals", icon: "target" },
    { key: "openSlots", titleKey: "prof.openSlots", icon: "sparkles" }
  ];

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function isScalar(v) {
    return v === null || v === undefined || typeof v !== "object";
  }

  function humanize(key) {
    var s = String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(key);
  }

  function loadingHtml(t) {
    return '<div class="loading-state"><div class="spinner"></div><div>' + esc(t("state.loading")) + "</div></div>";
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

  // ---- model paths (dot-joined; numeric segments index into arrays) ------

  function getPath(model, path) {
    var parts = path.split(".");
    var cur = model;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[Array.isArray(cur) ? Number(parts[i]) : parts[i]];
    }
    return cur;
  }

  function setPath(model, path, value) {
    var parts = path.split(".");
    var cur = model;
    for (var i = 0; i < parts.length - 1; i++) {
      cur = cur[Array.isArray(cur) ? Number(parts[i]) : parts[i]];
      if (cur === null || cur === undefined) return;
    }
    var last = parts[parts.length - 1];
    cur[Array.isArray(cur) ? Number(last) : last] = value;
  }

  // ---- field editors -------------------------------------------------------

  function scalarFieldHtml(label, path, value, t) {
    var I = window.AppIcons.svg;
    void I;
    if (typeof value === "boolean") {
      return (
        '<div class="mx-field"><label>' + esc(label) + "</label>" +
        '<label class="checkbox-row"><input type="checkbox" data-bind="' + esc(path) + '"' +
        (value ? " checked" : "") + " /> " + esc(value ? t("action.toggleOn") : t("action.toggleOff")) +
        "</label></div>"
      );
    }
    if (typeof value === "number") {
      return (
        '<div class="mx-field"><label>' + esc(label) + "</label>" +
        '<input class="input" type="number" data-bind="' + esc(path) + '" value="' + esc(value) + '" /></div>'
      );
    }
    var text = value === null || value === undefined ? "" : String(value);
    if (text.length > 60 || /note|desc|rule|detail|summary/i.test(label)) {
      return (
        '<div class="mx-field"><label>' + esc(label) + "</label>" +
        '<textarea class="input" rows="3" data-bind="' + esc(path) + '">' + esc(text) + "</textarea></div>"
      );
    }
    return (
      '<div class="mx-field"><label>' + esc(label) + "</label>" +
      '<input class="input" data-bind="' + esc(path) + '" value="' + esc(text) + '" autocomplete="off" /></div>'
    );
  }

  /** Editor for an object value: one field per key, recursing one level. */
  function objectEditorHtml(path, obj, t, depth) {
    var keys = Object.keys(obj);
    if (!keys.length) return '<p class="mx-hint">' + esc(t("prof.emptySection")) + "</p>";
    return keys
      .map(function (k) {
        var v = obj[k];
        var p = path + "." + k;
        if (isScalar(v)) return scalarFieldHtml(humanize(k), p, v, t);
        if (Array.isArray(v)) {
          return (
            '<div class="mx-field"><label>' + esc(humanize(k)) + "</label>" +
            listEditorHtml(p, v, t, depth + 1) + "</div>"
          );
        }
        if (depth < 2) {
          return (
            '<div class="mx-field"><label>' + esc(humanize(k)) + "</label>" +
            '<div style="padding-inline-start:10px;border-inline-start:2px solid var(--border)">' +
            objectEditorHtml(p, v, t, depth + 1) + "</div></div>"
          );
        }
        return readonlyHtml(p, v);
      })
      .join("");
  }

  /** Read-only JSON fallback for shapes too deep/odd to edit field-wise. */
  function readonlyHtml(path, v) {
    void path;
    return '<div class="mx-pre" style="margin-top:0">' + esc(JSON.stringify(v, null, 2)) + "</div>";
  }

  /** Editor for a list value: per-item editor + remove, plus an add button. */
  function listEditorHtml(path, arr, t, depth) {
    var I = window.AppIcons.svg;
    var items = arr
      .map(function (item, i) {
        var p = path + "." + i;
        var inner;
        if (isScalar(item)) {
          inner = scalarFieldHtml(t("prof.item") + " " + (i + 1), p, item, t);
        } else if (isObj(item)) {
          inner = objectEditorHtml(p, item, t, depth + 1);
        } else {
          inner = readonlyHtml(p, item);
        }
        return (
          '<div class="card" style="margin-bottom:9px">' + inner +
          '<div class="mx-actions"><button type="button" class="btn btn-sm btn-ghost" data-remove="' +
          esc(p) + '">' + I("trash") + esc(t("prof.remove")) + "</button></div></div>"
        );
      })
      .join("");
    return (
      (items || '<p class="mx-hint">' + esc(t("prof.emptySection")) + "</p>") +
      '<button type="button" class="btn btn-sm btn-subtle" data-add="' + esc(path) + '">' +
      I("plus") + esc(t("prof.add")) + "</button>"
    );
  }

  /** Empty item template matching the list's existing item shape. */
  function templateFor(arr) {
    var first = arr.length ? arr[0] : "";
    if (isObj(first)) {
      var out = {};
      Object.keys(first).forEach(function (k) {
        var v = first[k];
        out[k] = typeof v === "number" ? 0 : typeof v === "boolean" ? false : Array.isArray(v) ? [] : isObj(v) ? {} : "";
      });
      return out;
    }
    if (typeof first === "number") return 0;
    if (typeof first === "boolean") return false;
    return "";
  }

  // ---- open slots (placeholders, never editable) ---------------------------

  function slotLabel(slot) {
    if (isScalar(slot)) return String(slot === null || slot === undefined ? "" : slot);
    if (isObj(slot)) {
      var pick = slot.question || slot.label || slot.title || slot.name || slot.key || slot.id || slot.slot;
      if (pick !== undefined && pick !== null && pick !== "") return String(pick);
      var ks = Object.keys(slot);
      return ks.length ? humanize(ks[0]) : "";
    }
    return String(slot);
  }

  function openSlotsHtml(value, t) {
    var I = window.AppIcons.svg;
    var slots = [];
    if (Array.isArray(value)) slots = value;
    else if (isObj(value)) {
      slots = Object.keys(value).filter(function (k) { return value[k] !== false; });
    } else if (value !== undefined && value !== null && value !== "") slots = [value];
    if (!slots.length) return '<p class="mx-hint">' + esc(t("prof.emptySection")) + "</p>";
    return slots
      .map(function (s) {
        return (
          '<div class="mx-item" style="margin-bottom:8px">' + I("sparkles") +
          "<span>" + esc(slotLabel(s)) + "</span>" +
          ' <span class="badge">' + esc(t("prof.notYetAsked")) + "</span></div>"
        );
      })
      .join("");
  }

  // ---- section cards --------------------------------------------------------

  function sectionCardHtml(meta, value, t) {
    var I = window.AppIcons.svg;
    var title = t(meta.titleKey);
    if (title === meta.titleKey) title = humanize(meta.titleKey);
    var body;
    if (meta.key === "openSlots") {
      body = openSlotsHtml(value, t);
    } else if (Array.isArray(value)) {
      body = listEditorHtml(meta.key, value, t, 0);
    } else if (isObj(value)) {
      body = objectEditorHtml(meta.key, value, t, 0);
    } else if (value === undefined) {
      body = '<p class="mx-hint">' + esc(t("prof.emptySection")) + "</p>";
    } else {
      body = scalarFieldHtml(title, meta.key, value, t);
    }
    return (
      '<div class="card" style="margin-bottom:12px"><div class="card-head tight">' +
      '<div class="card-icon blue">' + I(meta.icon) + "</div>" +
      '<div><div class="card-title">' + esc(title) + "</div></div>" +
      "</div>" + body + "</div>"
    );
  }

  // ---- render ----------------------------------------------------------------

  function render(el, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    var model = null;

    function paint() {
      var known = {};
      var cards = SECTIONS.map(function (meta) {
        known[meta.key] = true;
        return sectionCardHtml(meta, model ? model[meta.key] : undefined, t);
      }).join("");
      // Forward-compat: any extra top-level section the backend grows is
      // still shown/editable instead of being silently dropped on save.
      var extra = "";
      if (model) {
        Object.keys(model).forEach(function (k) {
          if (known[k]) return;
          extra += sectionCardHtml({ key: k, titleKey: k, icon: "fileText" }, model[k], t);
        });
      }
      el.innerHTML =
        ctx.pageHead("user", t("sec.profile"), t("prof.sub")) +
        cards + extra +
        '<div class="mx-btnrow"><button type="button" class="btn btn-primary" data-save>' +
        I("check") + esc(t("prof.save")) + "</button></div>";
      wire();
    }

    function wire() {
      Array.prototype.forEach.call(el.querySelectorAll("[data-bind]"), function (inp) {
        inp.addEventListener("input", function () {
          var path = inp.getAttribute("data-bind");
          var orig = getPath(model, path);
          var val;
          if (inp.type === "checkbox") val = !!inp.checked;
          else if (typeof orig === "number") {
            var n = Number(inp.value);
            val = inp.value === "" || isNaN(n) ? inp.value : n;
          } else val = inp.value;
          setPath(model, path, val);
        });
        inp.addEventListener("change", function () {
          // Keep boolean labels (On/Off) in sync after a toggle.
          if (inp.type === "checkbox") paint();
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-add]"), function (b) {
        b.addEventListener("click", function () {
          var path = b.getAttribute("data-add");
          var arr = getPath(model, path);
          if (Array.isArray(arr)) {
            arr.push(templateFor(arr));
            paint();
          }
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-remove]"), function (b) {
        b.addEventListener("click", function () {
          var path = b.getAttribute("data-remove");
          var cut = path.lastIndexOf(".");
          var parent = getPath(model, path.slice(0, cut));
          var idx = Number(path.slice(cut + 1));
          if (Array.isArray(parent) && !isNaN(idx)) {
            parent.splice(idx, 1);
            paint();
          }
        });
      });
      var save = el.querySelector("[data-save]");
      if (save) {
        save.addEventListener("click", async function () {
          save.disabled = true;
          try {
            var r = await ctx.api("profile.save", { profile: model });
            if (r && r.profile) model = r.profile;
            ctx.toast(t("prof.saved"), "ok");
            paint();
          } catch (err) {
            ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""), "err");
            save.disabled = false;
          }
        });
      }
    }

    async function load() {
      el.innerHTML = ctx.pageHead("user", t("sec.profile"), t("prof.sub")) + loadingHtml(t);
      try {
        var r = await ctx.api("profile.get", {});
        model = r.profile || null;
        if (!model) {
          el.innerHTML =
            ctx.pageHead("user", t("sec.profile"), t("prof.sub")) +
            '<div class="card"><div class="empty-state"><div class="empty-ic">' + I("user") + "</div>" +
            '<p class="empty-title">' + esc(t("state.empty")) + "</p></div></div>";
          return;
        }
        paint();
      } catch (err) {
        el.innerHTML = ctx.pageHead("user", t("sec.profile"), t("prof.sub")) + errorHtml(t, err);
        var b = el.querySelector("[data-retry]");
        if (b) b.addEventListener("click", load);
      }
    }

    return load();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("profile", { titleKey: "sec.profile", icon: "user", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
