/* BOBI Mini App — shell: header, tab bar / sidebar, section host, dialogs, toast.
 *
 * Section contract (shared with the other frontend worker):
 *   App.registerSection(id, { titleKey, icon, render(el, ctx) })
 *   - `icon` is an AppIcons name (e.g. "chat"); unknown names fall back to a dot.
 *   ctx = { api: MiniApi.apiCall, t: I18N.t, toast(msg, kind?),
 *           confirmDialog(title, body) -> Promise<boolean>,
 *           navigate(sectionId, params), esc, icon(name, cls?),
 *           pageHead(icon, title, sub?) -> html string, state, lang }
 * render(el, ctx) may be async; it must handle loading / empty / error states
 * itself (skeleton/spinner — never a blank screen). App keeps per-section
 * scroll position and a per-section state bag (ctx.state) across tab switches.
 */
(function () {
  "use strict";

  var t = function (k) {
    return window.I18N.t(k);
  };

  var SECTION_ORDER = [
    "chat",
    "providers",
    "users",
    "memory",
    "benchmarks",
    "schedulers",
    "skills",
    "usage",
    "tasks",
    "groups",
  ];

  // Compact labels for the 10-tab bar (full title stays in aria-label).
  var TAB_SHORT = {
    chat: "Chat",
    providers: "AI",
    users: "Users",
    memory: "Memory",
    benchmarks: "Bench",
    schedulers: "Sched",
    skills: "Skills",
    usage: "Usage",
    tasks: "Tasks",
    groups: "Groups",
  };

  var SECTION_FILES = {
    chat: "sections/chat.js",
    providers: "sections/providers.js",
    users: "sections/users.js",
    memory: "sections/memory.js",
    benchmarks: "sections/benchmarks.js",
    schedulers: "sections/schedulers.js",
    skills: "sections/skills.js",
    usage: "sections/usage.js",
    tasks: "sections/tasks.js",
    groups: "sections/groups.js",
  };

  var sections = {}; // id -> { titleKey, icon, render }
  var sectionState = {}; // id -> arbitrary bag kept across switches
  var scrollPos = {}; // id -> scrollTop
  var activeSection = "chat";
  var activeParams = null;
  var booted = false;

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function icon(name, cls) {
    if (window.AppIcons && typeof window.AppIcons.svg === "function") {
      return window.AppIcons.svg(name, cls);
    }
    return '<span class="ic">' + esc(name ? name.charAt(0) : "•") + "</span>";
  }

  function registerSection(id, def) {
    if (!def || typeof def.render !== "function") return;
    sections[id] = {
      titleKey: def.titleKey || ("sec." + id),
      icon: def.icon || "dot",
      render: def.render,
    };
    renderTabs();
    // If this section is currently visible but wasn't registered at render
    // time, (re)render it now. Guard: before boot the host doesn't exist.
    if (booted && id === activeSection) showSection(activeSection, activeParams);
  }

  // ---------- Telegram bootstrap ----------

  function applyTheme() {
    var wa = window.Telegram && window.Telegram.WebApp;
    if (!wa) return;
    var tp = wa.themeParams || {};
    var root = document.documentElement;
    var map = {
      "--tg-theme-bg-color": tp.bg_color,
      "--tg-theme-text-color": tp.text_color,
      "--tg-theme-hint-color": tp.hint_color,
      "--tg-theme-link-color": tp.link_color,
      "--tg-theme-button-color": tp.button_color,
      "--tg-theme-button-text-color": tp.button_text_color,
      "--tg-theme-secondary-bg-color": tp.secondary_bg_color,
    };
    for (var k of Object.keys(map)) {
      if (map[k]) root.style.setProperty(k, map[k]);
    }
    root.setAttribute("data-theme", wa.colorScheme === "light" ? "light" : "dark");
  }

  function telegramError() {
    document.body.innerHTML =
      '<div class="tg-fatal">' +
      '<div class="tg-fatal-card">' +
      '<div class="empty-ic">' + icon("phone") + "</div>" +
      "<h1>" + esc(t("app.openInTelegram")) + "</h1>" +
      "<p>" + esc(t("app.openInTelegramSub")) + "</p>" +
      "</div></div>";
  }

  // ---------- Shell layout ----------

  function buildShell() {
    var root = document.getElementById("app");
    root.innerHTML =
      '<header class="app-header">' +
      '<div class="brand"><span class="orb orb-sm" aria-hidden="true"></span>' +
      '<span class="brand-name">BOBI</span>' +
      '<span class="brand-sub">Control Center</span>' +
      "</div>" +
      '<div class="status-pill off" id="statusPill"><span class="pulse"></span>' +
      '<span id="statusTxt">Connecting</span></div>' +
      "</header>" +
      '<div class="app-body">' +
      '<nav class="tabbar" id="tabbar" aria-label="Sections"></nav>' +
      '<main class="app-main" id="sectionHost"></main>' +
      "</div>" +
      '<div class="toast-wrap" id="toastWrap"></div>' +
      '<div class="sheet-backdrop" id="sheetBackdrop" hidden>' +
      '<div class="sheet" id="sheet" role="dialog" aria-modal="true"></div>' +
      "</div>";
  }

  // Connection status pill, driven by api traffic (wrapped apiCall below).
  function setOnline(state) {
    var pill = document.getElementById("statusPill");
    var txt = document.getElementById("statusTxt");
    if (!pill || !txt) return;
    if (state === true) {
      pill.className = "status-pill on";
      txt.textContent = "Online";
    } else if (state === false) {
      pill.className = "status-pill off";
      txt.textContent = "Offline";
    } else {
      pill.className = "status-pill off";
      txt.textContent = "Connecting";
    }
  }

  function wrapApiCall() {
    var raw = window.MiniApi.apiCall;
    window.MiniApi.apiCall = function (endpoint, params) {
      return raw(endpoint, params).then(
        function (r) {
          setOnline(true);
          return r;
        },
        function (e) {
          // Only transport failures mean offline; app-level errors still
          // prove the server is reachable.
          setOnline(e && (e.code === "network" || e.code === "timeout") ? false : true);
          throw e;
        }
      );
    };
  }

  function renderTabs() {
    var bar = document.getElementById("tabbar");
    if (!bar) return;
    var frag = document.createDocumentFragment();
    for (var id of SECTION_ORDER) {
      (function (sid) {
        var def = sections[sid];
        if (!def) return;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "tab" + (sid === activeSection ? " active" : "");
        b.dataset.section = sid;
        b.setAttribute("aria-label", t(def.titleKey));
        b.innerHTML =
          '<span class="tab-icon">' + icon(def.icon) + "</span>" +
          '<span class="tab-label">' + esc(TAB_SHORT[sid] || t(def.titleKey)) + "</span>";
        b.addEventListener("click", function () {
          showSection(sid);
        });
        frag.appendChild(b);
      })(id);
    }
    bar.innerHTML = "";
    bar.appendChild(frag);
  }

  // ---------- Section host ----------

  function pageHead(ic, title, sub) {
    return (
      '<div class="page-head"><div class="page-icon">' + icon(ic) + "</div>" +
      '<div class="page-head-text"><h1 class="page-title">' + esc(title) + "</h1>" +
      (sub ? '<p class="page-sub">' + esc(sub) + "</p>" : "") +
      "</div></div>"
    );
  }

  function ctxFor(id) {
    if (!sectionState[id]) sectionState[id] = {};
    return {
      api: window.MiniApi.apiCall,
      t: window.I18N.t,
      toast: toast,
      confirmDialog: confirmDialog,
      navigate: function (sid, params) {
        showSection(sid, params);
      },
      esc: esc,
      icon: icon,
      pageHead: pageHead,
      state: sectionState[id],
      lang: window.I18N.getLang(),
    };
  }

  function showSection(id, params, force) {
    var def = sections[id];
    if (!def) return;
    var host = document.getElementById("sectionHost");
    if (host && activeSection && sections[activeSection]) {
      scrollPos[activeSection] = host.scrollTop;
    }
    activeSection = id;
    activeParams = params || null;
    renderTabs();

    host.innerHTML =
      '<div class="section-inner" id="sectionInner">' +
      '<div class="loading-state"><div class="spinner"></div><p>' +
      esc(t("state.loading")) +
      "</p></div></div>";
    var inner = document.getElementById("sectionInner");

    var ctx = ctxFor(id);
    if (params) ctx.params = params;

    var out;
    try {
      out = def.render(inner, ctx);
    } catch (e) {
      renderSectionError(inner, id, ctx, e);
      return;
    }
    if (out && typeof out.then === "function") {
      out.catch(function (e) {
        renderSectionError(inner, id, ctx, e);
      });
    }
    // Restore scroll after the section has painted.
    requestAnimationFrame(function () {
      if (scrollPos[id] && document.getElementById("sectionHost") === host) {
        host.scrollTop = scrollPos[id];
      }
    });
  }

  function renderSectionError(host, id, ctx, e) {
    var msg = (e && (e.message || e.code)) || t("state.error");
    host.innerHTML =
      '<div class="error-state">' +
      '<div class="error-ic">' + icon("alert") + "</div>" +
      "<p>" + esc(msg) + "</p>" +
      '<button type="button" class="btn btn-primary" id="retryBtn">' +
      icon("refresh") + esc(t("action.retry")) +
      "</button></div>";
    var btn = document.getElementById("retryBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        showSection(id, activeParams, true);
      });
    }
  }

  // ---------- Toast ----------

  // kind: "ok" | "err" | undefined (plain)
  function toast(msg, kind) {
    var wrap = document.getElementById("toastWrap");
    if (!wrap) return;
    var el = document.createElement("div");
    el.className = "toast" + (kind === "ok" ? " toast-ok" : kind === "err" ? " toast-err" : "");
    el.innerHTML =
      (kind === "ok" ? icon("checkCircle") : kind === "err" ? icon("xCircle") : "") +
      "<span></span>";
    el.querySelector("span").textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.classList.add("show");
    }, 10);
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () {
        el.remove();
      }, 300);
    }, 2600);
  }

  // ---------- Bottom-sheet dialog ----------

  var sheetResolver = null;

  function openSheet(html) {
    var backdrop = document.getElementById("sheetBackdrop");
    var sheet = document.getElementById("sheet");
    sheet.innerHTML =
      '<div class="sheet-handle"></div>' +
      '<button type="button" class="sheet-close" id="sheetX" aria-label="' +
      esc(t("action.close")) + '">' + icon("x") + "</button>" +
      html;
    backdrop.hidden = false;
    requestAnimationFrame(function () {
      backdrop.classList.add("open");
    });
    var x = document.getElementById("sheetX");
    if (x) x.addEventListener("click", function () { closeSheet(false); });
  }

  function closeSheet(result) {
    var backdrop = document.getElementById("sheetBackdrop");
    if (!backdrop || backdrop.hidden) return;
    backdrop.classList.remove("open");
    setTimeout(function () {
      backdrop.hidden = true;
    }, 200);
    if (sheetResolver) {
      var r = sheetResolver;
      sheetResolver = null;
      r(result);
    }
  }

  function confirmDialog(title, body) {
    return new Promise(function (resolve) {
      sheetResolver = resolve;
      openSheet(
        '<h3 class="sheet-title">' + icon("alert") + esc(title) + "</h3>" +
          (body ? '<div class="sheet-body">' + esc(body) + "</div>" : "") +
          '<div class="sheet-actions">' +
          '<button type="button" class="btn btn-danger" id="sheetYes">' + esc(t("dialog.yes")) + "</button>" +
          '<button type="button" class="btn btn-ghost" id="sheetNo">' + esc(t("dialog.no")) + "</button>" +
          "</div>"
      );
      document.getElementById("sheetYes").addEventListener("click", function () {
        closeSheet(true);
      });
      document.getElementById("sheetNo").addEventListener("click", function () {
        closeSheet(false);
      });
    });
  }

  // Backdrop tap / Escape = dismiss as "no".
  function wireSheet() {
    var backdrop = document.getElementById("sheetBackdrop");
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) closeSheet(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeSheet(false);
    });
  }

  // Generic bottom-sheet used by sections for forms/details.
  function showSheet(html) {
    return new Promise(function (resolve) {
      sheetResolver = resolve;
      openSheet(html);
    });
  }

  // ---------- Section script loader ----------

  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () {
        resolve(true);
      };
      s.onerror = function () {
        resolve(false); // missing section file: tolerate, tab just won't appear
      };
      document.head.appendChild(s);
    });
  }

  async function loadSections() {
    // Sections may also be statically included via index.html — skip those
    // already registered so files never execute twice.
    for (var id of SECTION_ORDER) {
      if (sections[id]) continue;
      await loadScript(SECTION_FILES[id]);
    }
  }

  // ---------- Boot ----------

  async function boot() {
    if (!window.Telegram || !window.Telegram.WebApp) {
      telegramError();
      return;
    }
    var wa = window.Telegram.WebApp;
    try {
      wa.ready();
      wa.expand();
    } catch (_) {}
    applyTheme();
    if (wa.onEvent) {
      wa.onEvent("themeChanged", applyTheme);
    }
    buildShell();
    wireSheet();
    wrapApiCall();
    booted = true;
    await loadSections();
    renderTabs();
    showSection(activeSection, null, true);
  }

  window.App = {
    registerSection: registerSection,
    navigate: function (sid, params) {
      showSection(sid, params);
    },
    toast: toast,
    confirmDialog: confirmDialog,
    showSheet: showSheet,
    closeSheet: closeSheet,
    esc: esc,
    icon: icon,
    get activeSection() {
      return activeSection;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
