/* BOBI Mini App — shell: tab bar, header, section host, dialogs, toast.
 *
 * Section contract (shared with the other frontend worker):
 *   App.registerSection(id, { titleKey, icon, render(el, ctx) })
 *   ctx = { api: MiniApi.apiCall, t: I18N.t, toast(msg),
 *           confirmDialog(title, body) -> Promise<boolean>,
 *           navigate(sectionId, params), esc, lang }
 * render(el, ctx) may be async; it must handle loading / empty / error states
 * itself (skeleton/spinner — never a blank screen). App keeps per-section
 * scroll position and a per-section state bag (ctx.state) across tab switches.
 */
(function () {
  "use strict";

  const t = function (k) {
    return window.I18N.t(k);
  };

  const SECTION_ORDER = [
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

  const SECTION_FILES = {
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

  const sections = {}; // id -> { titleKey, icon, render }
  const sectionState = {}; // id -> arbitrary bag kept across switches
  const scrollPos = {}; // id -> scrollTop
  let activeSection = "chat";
  let activeParams = null;
  let booted = false;

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function registerSection(id, def) {
    if (!def || typeof def.render !== "function") return;
    sections[id] = {
      titleKey: def.titleKey || ("sec." + id),
      icon: def.icon || "•",
      render: def.render,
    };
    renderTabs();
    // If this section is currently visible but wasn't registered at render
    // time, (re)render it now. Guard: before boot the host doesn't exist.
    if (booted && id === activeSection) showSection(activeSection, activeParams);
  }

  // ---------- Telegram bootstrap ----------

  function applyTheme() {
    const wa = window.Telegram && window.Telegram.WebApp;
    if (!wa) return;
    const tp = wa.themeParams || {};
    const root = document.documentElement;
    const map = {
      "--tg-theme-bg-color": tp.bg_color,
      "--tg-theme-text-color": tp.text_color,
      "--tg-theme-hint-color": tp.hint_color,
      "--tg-theme-link-color": tp.link_color,
      "--tg-theme-button-color": tp.button_color,
      "--tg-theme-button-text-color": tp.button_text_color,
      "--tg-theme-secondary-bg-color": tp.secondary_bg_color,
    };
    for (const k of Object.keys(map)) {
      if (map[k]) root.style.setProperty(k, map[k]);
    }
    if (wa.colorScheme) root.setAttribute("data-theme", wa.colorScheme);
  }

  function telegramError() {
    document.body.innerHTML =
      '<div class="tg-fatal">' +
      '<div class="tg-fatal-card">' +
      "<div class=\"tg-fatal-emoji\">📲</div>" +
      "<h1>" + esc(t("app.openInTelegram")) + "</h1>" +
      "<p>" + esc(t("app.openInTelegramSub")) + "</p>" +
      '<hr><h1 dir="ltr">Open this app from Telegram</h1>' +
      '<p dir="ltr">Use the bot\'s menu button to enter</p>' +
      "</div></div>";
  }

  // ---------- Shell layout ----------

  function buildShell() {
    const root = document.getElementById("app");
    root.innerHTML =
      '<header class="app-header">' +
      '<div class="app-title">' + esc(t("app.title")) + "</div>" +
      '<button class="lang-toggle" id="langToggle" type="button">' + esc(t("nav.lang")) + "</button>" +
      "</header>" +
      '<main class="app-main" id="sectionHost"></main>' +
      '<nav class="tabbar" id="tabbar"></nav>' +
      '<div class="toast-wrap" id="toastWrap"></div>' +
      '<div class="sheet-backdrop" id="sheetBackdrop" hidden>' +
      '<div class="sheet" id="sheet" role="dialog" aria-modal="true"></div>' +
      "</div>";
    document
      .getElementById("langToggle")
      .addEventListener("click", function () {
        const next = window.I18N.getLang() === "fa" ? "en" : "fa";
        window.I18N.setLang(next);
        buildShell();
        showSection(activeSection, activeParams, true);
      });
  }

  function renderTabs() {
    const bar = document.getElementById("tabbar");
    if (!bar) return;
    const frag = document.createDocumentFragment();
    for (const id of SECTION_ORDER) {
      const def = sections[id];
      if (!def) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab" + (id === activeSection ? " active" : "");
      b.dataset.section = id;
      b.setAttribute("aria-label", t(def.titleKey));
      b.innerHTML =
        '<span class="tab-icon">' + esc(def.icon) + "</span>" +
        '<span class="tab-label">' + esc(t(def.titleKey)) + "</span>";
      b.addEventListener("click", function () {
        showSection(id);
      });
      frag.appendChild(b);
    }
    bar.innerHTML = "";
    bar.appendChild(frag);
  }

  // ---------- Section host ----------

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
      state: sectionState[id],
      lang: window.I18N.getLang(),
    };
  }

  function showSection(id, params, force) {
    const def = sections[id];
    if (!def) return;
    const host = document.getElementById("sectionHost");
    if (host && activeSection && sections[activeSection]) {
      scrollPos[activeSection] = host.scrollTop;
    }
    activeSection = id;
    activeParams = params || null;
    renderTabs();

    host.innerHTML =
      '<div class="loading-state"><div class="spinner"></div><p>' +
      esc(t("state.loading")) +
      "</p></div>";

    const ctx = ctxFor(id);
    if (params) ctx.params = params;

    let out;
    try {
      out = def.render(host, ctx);
    } catch (e) {
      renderSectionError(host, id, ctx, e);
      return;
    }
    if (out && typeof out.then === "function") {
      out.catch(function (e) {
        renderSectionError(host, id, ctx, e);
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
    const msg = (e && (e.message || e.code)) || t("state.error");
    host.innerHTML =
      '<div class="error-state">' +
      "<p>⚠️ " + esc(msg) + "</p>" +
      '<button type="button" class="btn btn-primary" id="retryBtn">' +
      esc(t("action.retry")) +
      "</button></div>";
    const btn = document.getElementById("retryBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        showSection(id, activeParams, true);
      });
    }
  }

  // ---------- Toast ----------

  function toast(msg) {
    const wrap = document.getElementById("toastWrap");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
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

  let sheetResolver = null;

  function openSheet(html) {
    const backdrop = document.getElementById("sheetBackdrop");
    const sheet = document.getElementById("sheet");
    sheet.innerHTML = html;
    backdrop.hidden = false;
    requestAnimationFrame(function () {
      backdrop.classList.add("open");
    });
  }

  function closeSheet(result) {
    const backdrop = document.getElementById("sheetBackdrop");
    if (!backdrop || backdrop.hidden) return;
    backdrop.classList.remove("open");
    setTimeout(function () {
      backdrop.hidden = true;
    }, 200);
    if (sheetResolver) {
      const r = sheetResolver;
      sheetResolver = null;
      r(result);
    }
  }

  function confirmDialog(title, body) {
    return new Promise(function (resolve) {
      sheetResolver = resolve;
      openSheet(
        '<div class="sheet-handle"></div>' +
          '<h3 class="sheet-title">' + esc(title) + "</h3>" +
          (body ? '<div class="sheet-body">' + body + "</div>" : "") +
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

  // Backdrop tap = dismiss as "no".
  function wireSheet() {
    const backdrop = document.getElementById("sheetBackdrop");
    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) closeSheet(false);
    });
  }

  // Generic bottom-sheet used by sections for forms/details.
  function showSheet(html) {
    return new Promise(function (resolve) {
      sheetResolver = resolve;
      openSheet('<div class="sheet-handle"></div>' + html);
    });
  }

  // ---------- Section script loader ----------

  function loadScript(src) {
    return new Promise(function (resolve) {
      const s = document.createElement("script");
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
    for (const id of SECTION_ORDER) {
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
    const wa = window.Telegram.WebApp;
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
