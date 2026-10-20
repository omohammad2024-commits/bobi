/* BOBI Mini App — Providers section (UX pass).
 *
 * Views: list → detail (tabbed: Overview / Models / API key) → add
 * (preset grid → 2-field form; custom / 9Router links).
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   providers.list    {} -> { providers: [{ id, label, adapterLabel, enabled,
 *                             keyPresent, keyHint, modelCount, isActive,
 *                             lastProbe: { ok, atMs, latencyMs, message } | null }] }
 *   providers.presets {} -> { presets: [{ id, label, baseUrl, suggestedModel?,
 *                             hasPlaceholder, requiredPlaceholder?, note? }] }
 *   providers.add     preset: { kind:"preset", preset, label?, key }
 *                     custom: { kind:"custom"|"nine_router", label, baseUrl, key?, model? }
 *   providers.update  { id, label?, baseUrl? }
 *   providers.toggle  { id, enabled }
 *   providers.delete  { id, confirm:true }
 *   providers.probe   { id } -> { ok, latencyMs, atMs, message? }
 *   providers.setKey  { id, key }
 *   providers.clearKey { id, confirm:true }
 *   providers.setActive { id }
 *   models.list       { providerId } -> { models: [{ id, label, modelId, enabled, isActive }] }
 *   models.discover   { providerId } -> { models: [{ modelId, label, imported }] }
 *   models.import     { providerId, modelIds } -> { imported, skipped }
 *   models.add        { providerId, modelId, label? }
 *   models.toggle     { id, enabled }
 *   models.delete     { id, confirm:true }
 *   models.setActive  { id }
 *   models.test       { providerId, modelId } -> { ok, latencyMs, atMs, message? }
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "prov.sub": "Connect AI providers and manage their models.",
      "prov.tab.overview": "Overview",
      "prov.tab.models": "Models",
      "prov.tab.key": "API key",
      "prov.emptyTitle": "No providers yet",
      "prov.emptySub": "Connect an AI provider so BOBI can actually answer.",
      "prov.modelCount": "{n} models",
      "prov.activeBadge": "Active",
      "prov.probeNever": "Untested",
      "prov.setActiveProvider": "Set active",
      "prov.autoActive": "Provider activated — the bot now answers with it.",
      "prov.needKeyFirst": "Set the key first",
      "prov.keyRequired": "Enter the API key",
      "prov.nextTitle": "Next step",
      "prov.nextBody": "Tap “Test connection” to make sure it works, then “Discover models”.",
      "prov.discoverHint": "Pulls the model list straight from the provider's server; check and import.",
      "prov.selectAll": "Select all",
      "prov.selectNone": "Select none",
      "prov.imported": "{n} models imported",
      "prov.allImported": "All models are already imported.",
      "prov.accountId": "Account ID",
      "prov.accountIdHint": "Copy it from the Cloudflare dashboard.",
      "prov.baseUrlPreview": "Final URL",
      "prov.customUrlHint": "Base API URL; usually ends with /v1.",
      "prov.customKeyHint": "The key you got from that service's dashboard.",
      "prov.customModelHint": "Optional; you can add via “Discover models” later.",
      "prov.nineGuide": "First create an endpoint in the 9Router dashboard and grab its key.",
      "prov.nineUrlHint": "The endpoint URL 9Router gave you.",
      "prov.nineKeyHint": "The endpoint key from the 9Router dashboard.",
      "prov.nineModelHint": "Exact model name you have in 9Router (required).",
      "prov.nineKeyRequired": "Enter the endpoint key.",
      "prov.nineModelRequired": "Enter the model name.",
      "prov.activated": "Activated",
      "prov.probing": "Testing…",
      "prov.editProvider": "Edit",
      "prov.deleteProvider": "Delete provider",
      "prov.keySaved": "Key saved",
      "prov.addCustom": "Custom (OpenAI)",
      "prov.addNine": "9Router",
      "prov.noModelsYet": "No models yet; tap “Discover models”.",
      "prov.modelActive": "Active model",
      "prov.justAdded": "Provider added",
      "prov.probeOkLine": "Connection OK",
      "prov.probeFailLine": "Connection failed",
      "prov.agoNow": "just now",
      "prov.agoMin": "{n} min ago",
      "prov.agoHour": "{n} h ago",
      "prov.agoDay": "{n} d ago",
      "prov.keyHintLabel": "Key",
      "prov.discoverTitle": "Discover models",
      "prov.actionsTitle": "Actions",
      "prov.keyTitle": "API key",
      "prov.dangerTitle": "Delete",
      "prov.presetNote": "Pick a service — the type is locked to the right wire format, the address is prefilled, then just add the key.",
      "prov.baseUrl": "Base URL",
      "prov.typeLabel": "Type",
      "prov.activeModel": "Active model",
      "prov.customEndpoint": "Custom endpoint",
      "prov.customTypeNote": "Type: OpenAI-compatible (openai_compatible). Native Gemini or Anthropic addresses do not work here — use their presets above instead.",
      "prov.templateFormNote": "Adapter type is locked by this preset; the address is prefilled and can be adjusted before saving.",
      "prov.activeLocked": "This provider is active — its base URL and type are locked. Activate another provider first to change them.",
      "prov.typeChangeNote": "Type cannot be changed on an existing provider. To switch type, delete this provider and add it again with the correct preset.",
      "prov.autoChecking": "Saved. Discovering models, then testing the connection…",
      "prov.addResultTitle": "Setup check",
      "prov.discoveredN": "Discovered {n} models",
      "prov.importedN": "Imported {n} models",
      "prov.discoverFailed": "Model discovery failed",
      "prov.viewProvider": "View provider",
      "prov.breakerOpen": "Circuit open",
      "prov.quarantined": "Quarantined",
      "prov.httpStatus": "HTTP {n}",
    });

  // Fallback presets if providers.presets is unreachable.
  const FALLBACK_PRESETS = [
    { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", suggestedModel: "anthropic/claude-haiku-5.5", hasPlaceholder: false },
    { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", suggestedModel: "deepseek-chat", hasPlaceholder: false },
    { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", suggestedModel: "llama-3.3-70b-versatile", hasPlaceholder: false },
    { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", suggestedModel: "mistral-large-latest", hasPlaceholder: false },
    { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", suggestedModel: "grok-4", hasPlaceholder: false },
    { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", suggestedModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", hasPlaceholder: false },
    { id: "opencode", label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", suggestedModel: "nemotron-3-lightning-free", hasPlaceholder: false },
    { id: "cloudflare", label: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1", suggestedModel: "@cf/meta/llama-3.1-8b-instruct", hasPlaceholder: true, requiredPlaceholder: "ACCOUNT_ID", note: "The URL contains your account ID; replace {ACCOUNT_ID} with it." },
  ];

  // Fallback adapter templates (mirrors ADAPTER_TEMPLATES in src/ai/adapter.ts)
  // for when providers.presets is unreachable. `isTemplate` marks entries the
  // presets list does not carry; saving one sends its locked adapter type.
  const FALLBACK_TEMPLATES = [
    { id: "gemini", type: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", suggestedBaseUrl: "https://generativelanguage.googleapis.com/v1beta", isTemplate: true },
    { id: "anthropic", type: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", suggestedBaseUrl: "https://api.anthropic.com/v1", isTemplate: true },
  ];

  function urlOk(u) {
    return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(String(u || "").trim());
  }

  function adapterLabelFor(type) {
    if (type === "gemini") return "Google Gemini";
    if (type === "anthropic") return "Anthropic";
    if (type === "nine_router") return "9Router";
    if (type === "openai_compatible") return "OpenAI-compatible";
    return type || "";
  }

  // Client-side mirror of the server type↔URL guard: catches the incident
  // combination (native Gemini URL under OpenAI-compatible, and friends)
  // BEFORE save. Returns { message, correctedUrl? } or null.
  function mismatchFor(url, adapterType) {
    const raw = String(url || "").trim();
    if (!raw || !adapterType) return null;
    let host = "", path = "";
    try {
      const u = new URL(raw);
      host = u.hostname.toLowerCase();
      path = u.pathname || "";
    } catch (e) {
      return null; // urlOk / the server own malformed-URL errors
    }
    const hasOpenAiSeg = /(^|\/)openai(\/|$)/.test(path);
    if (host === "generativelanguage.googleapis.com") {
      if (adapterType === "openai_compatible" && !hasOpenAiSeg) {
        const corrected = raw.replace(/\/+$/, "") + "/openai/";
        return {
          message:
            "This is the native Gemini address, but the type here is OpenAI-compatible — the request would go to a path that does not exist. " +
            "Fix: use " + corrected + " with this type, or go back and pick the Google Gemini preset (type gemini) to keep this URL.",
          correctedUrl: corrected,
        };
      }
      if (adapterType === "gemini" && hasOpenAiSeg) {
        const corrected = raw.replace(/\/openai(?=\/|$)/, "");
        return {
          message:
            "This URL has the /openai segment, but the type here is native Gemini (gemini) — that segment only exists on the OpenAI-compatible surface. " +
            "Fix: use " + corrected + " with this type, or pick an OpenAI-compatible preset to keep this URL.",
          correctedUrl: corrected,
        };
      }
    }
    if (host === "api.anthropic.com" && adapterType === "openai_compatible") {
      return {
        message:
          "api.anthropic.com is the native Anthropic address — it does not speak the OpenAI format, and the type here is OpenAI-compatible. " +
          "Fix: go back and pick the Anthropic preset (type anthropic) for this address.",
      };
    }
    return null;
  }

  // Render a thrown API error inline: real message + suggestion when present.
  function showServerError(errEl, e) {
    if (!errEl) return;
    const msg = (e && (e.message || e.code)) || "Server error";
    const sugg = e && e.suggestion ? " " + e.suggestion : "";
    errEl.textContent = msg + sugg;
    errEl.hidden = false;
  }

  function render(el, ctx) {
    const st = ctx.state;
    if (!st.view) st.view = { name: "list" };

    function num(n) {
      return String(n);
    }
    function fmt(key, n) {
      return ctx.t(key).replace("{n}", num(n));
    }
    function fmtAgo(ts) {
      const diff = Date.now() - Number(ts);
      if (!(diff > 0)) return ctx.t("prov.agoNow");
      const min = Math.floor(diff / 60000);
      if (min < 1) return ctx.t("prov.agoNow");
      if (min < 60) return fmt("prov.agoMin", min);
      const h = Math.floor(min / 60);
      if (h < 24) return fmt("prov.agoHour", h);
      return fmt("prov.agoDay", Math.floor(h / 24));
    }
    function probeText(p) {
      const lp = p.lastProbe;
      if (!lp) return ctx.t("prov.probeNever");
      const mark = lp.ok ? "✓" : "✗";
      let s = mark + " " + fmtAgo(lp.atMs);
      if (lp.latencyMs !== undefined && lp.latencyMs !== null) s += " · " + num(lp.latencyMs) + " " + ctx.t("prov.ms");
      if (lp.status !== undefined && lp.status !== null) s += " · " + fmt("prov.httpStatus", lp.status);
      // M3: a failed probe's stored reason is part of the line, not hidden.
      if (!lp.ok && lp.message) s += " · " + lp.message;
      return s;
    }
    function truncUrl(u) {
      const s = String(u || "");
      return s.length > 52 ? s.slice(0, 49) + "…" : s;
    }
    function typeLine(p) {
      const slug = p.adapterType || "";
      const label = p.adapterLabel || adapterLabelFor(slug);
      if (!label && !slug) return "";
      return label + (slug ? " · " + slug : "");
    }
    function activeModelOf(p) {
      return p.activeModelId || p.defaultModelId || p.defaultModel || "";
    }
    // Breaker/quarantine badges — defensive: render only when the API item
    // actually carries such a field (older payloads simply omit them).
    function healthBadges(p) {
      let h = "";
      const breaker = p.breakerOpen || p.circuitOpen || (p.breaker && (p.breaker.open || p.breaker.state === "open")) || p.circuitBreaker === "open";
      const quar = p.quarantined || p.quarantine || (p.modelQuarantine && p.modelQuarantine.active);
      if (breaker) h += '<span class="badge badge-warn prov-badge">' + ctx.esc(ctx.t("prov.breakerOpen")) + "</span>";
      if (quar) h += '<span class="badge badge-danger prov-badge">' + ctx.esc(ctx.t("prov.quarantined")) + "</span>";
      return h;
    }
    // Live two-stage breakdown (Ping / Real) for probe + model-test results.
    function stageBreakdown(r) {
      if (!r || !r.ping) return "";
      const ms = function (v) {
        return v !== undefined && v !== null ? num(v) + " " + ctx.t("prov.ms") : "";
      };
      const pingPart = "Ping " + (r.ping.ok ? "✅ " + ms(r.ping.latencyMs) : "❌ " + (r.ping.error || r.ping.message || ""));
      let realPart = "";
      if (r.real) {
        realPart = r.real.ok
          ? "Real ✅ " + ms(r.real.latencyMs)
          : "Real ⚠️ " + (r.real.detail === "empty response" ? "empty" : r.real.error || r.real.message || "failed");
      }
      return [pingPart, realPart, r.quarantined ? "⛔ " + ctx.t("prov.quarantined") : ""].filter(Boolean).join(" · ");
    }
    function probeLineText(r) {
      const base = (r.ok ? ctx.t("prov.probeOkLine") : ctx.t("prov.probeFailLine")) +
        (r.latencyMs !== undefined && r.latencyMs !== null ? " · " + num(r.latencyMs) + " " + ctx.t("prov.ms") : "") +
        (r.status !== undefined && r.status !== null ? " · " + fmt("prov.httpStatus", r.status) : "") +
        (r.message ? " · " + r.message : "");
      const stages = stageBreakdown(r);
      return stages ? base + " — " + stages : base;
    }
    function statusDot(p) {
      const lp = p.lastProbe;
      const cls = lp ? (lp.ok ? "ok" : "err") : "unknown";
      return '<span class="dot ' + cls + '"></span>';
    }
    function skeleton(n) {
      let h = "";
      for (let i = 0; i < (n || 4); i++) h += '<div class="skeleton"></div>';
      return h;
    }
    function tileHue(id) {
      let h = 0;
      const s = String(id || "?");
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
      return h;
    }
    function provTile(label) {
      const n = String(label || "?").trim() || "?";
      const h = tileHue(n);
      return (
        '<span class="preset-tile" style="background:linear-gradient(135deg,' +
        "hsl(" + h + ",55%,52%),hsl(" + ((h + 40) % 360) + ",55%,38%))" + '">' +
        ctx.esc(n.charAt(0).toUpperCase()) +
        "</span>"
      );
    }
    function activeBadge() {
      return '<span class="badge badge-accent">' + ctx.icon("star") + ctx.esc(ctx.t("prov.activeBadge")) + "</span>";
    }
    function subHeader(title) {
      const wrap = document.createElement("div");
      wrap.innerHTML =
        '<div class="subhead">' +
        '<button type="button" class="btn btn-ghost btn-sm" id="backBtn">' + ctx.icon("chevL") + ctx.esc(ctx.t("nav.back")) + "</button>" +
        '<h2>' + ctx.esc(title) + "</h2></div>";
      el.appendChild(wrap);
      wrap.querySelector("#backBtn").addEventListener("click", back);
    }
    function back() {
      const v = st.view;
      if (v.name === "add" && v.sub) { setView({ name: "add", tab: v.tab }); return; }
      if (v.name === "add" && v.tab) { setView({ name: "add" }); return; }
      setView({ name: "list" });
    }
    function setView(v) {
      st.view = v;
      paint();
    }
    function errHtml(e) {
      return '<div class="error-state"><div class="error-ic">' + ctx.icon("alert") + "</div>" +
        "<p>" + ctx.esc((e && (e.message || e.code)) || ctx.t("state.error")) + "</p>" +
        '<button type="button" class="btn btn-primary" id="retryV">' + ctx.icon("refresh") + ctx.esc(ctx.t("action.retry")) + "</button></div>";
    }
    function wireRetry() {
      const b = document.getElementById("retryV");
      if (b) b.addEventListener("click", paint);
    }

    function paint() {
      const v = st.view;
      el.innerHTML = "";
      if (v.name === "detail") return viewDetail(v.id, !!v.justAdded);
      if (v.name === "add") return viewAdd(v.tab);
      return viewList();
    }

    // ---------------- list ----------------
    async function viewList() {
      el.innerHTML = skeleton(4);
      let providers = [];
      try {
        const res = await ctx.api("providers.list", {});
        providers = (res && res.providers) || [];
      } catch (e) {
        el.innerHTML = errHtml(e);
        wireRetry();
        return;
      }
      el.innerHTML = ctx.pageHead("plug", ctx.t("sec.providers"), ctx.t("prov.sub"));

      if (!providers.length) {
        const d = document.createElement("div");
        d.className = "card";
        d.innerHTML =
          '<div class="empty-state"><div class="empty-ic">' + ctx.icon("plug") + "</div>" +
          '<p class="empty-title">' + ctx.esc(ctx.t("prov.emptyTitle")) + "</p>" +
          '<p class="empty-text">' + ctx.esc(ctx.t("prov.emptySub")) + "</p>" +
          '<button type="button" class="btn btn-primary" id="emptyAdd">' + ctx.icon("plus") + ctx.esc(ctx.t("prov.add")) + "</button></div>";
        el.appendChild(d);
        d.querySelector("#emptyAdd").addEventListener("click", function () { setView({ name: "add" }); });
        return;
      }

      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn btn-primary btn-block";
      add.style.margin = "0 0 12px";
      add.innerHTML = ctx.icon("plus") + ctx.esc(ctx.t("prov.add"));
      add.addEventListener("click", function () { setView({ name: "add" }); });
      el.appendChild(add);

      for (const p of providers) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "list-row";
        const keyBadge = p.keyPresent
          ? '<span class="badge badge-success" dir="ltr">' + ctx.icon("key") + "••••" + ctx.esc(String(p.keyHint || "").slice(-4)) + "</span>"
          : '<span class="badge badge-danger">' + ctx.esc(ctx.t("prov.noKey")) + "</span>";
        const actBadge = p.isActive ? activeBadge() : "";
        const am = activeModelOf(p);
        b.innerHTML =
          provTile(p.label || p.adapterLabel) +
          '<div class="list-main"><div class="list-title">' + statusDot(p) + ctx.esc(p.label || "#" + p.id) + "</div>" +
          '<div class="list-sub">' +
          ctx.esc(typeLine(p)) + " · " + fmt("prov.modelCount", p.modelCount || 0) + " · " + ctx.esc(probeText(p)) +
          "</div>" +
          (p.baseUrl ? '<div class="prov-url mono" dir="ltr" title="' + ctx.esc(p.baseUrl) + '">' + ctx.esc(truncUrl(p.baseUrl)) + "</div>" : "") +
          (am ? '<div class="prov-model mono" dir="ltr">' + ctx.esc(truncUrl(am)) + "</div>" : "") +
          "</div>" +
          '<div class="list-meta">' + actBadge + keyBadge + healthBadges(p) + "</div>" +
          '<span class="chev">' + ctx.icon("chevR") + "</span>";
        (function (id) {
          b.addEventListener("click", function () { setView({ name: "detail", id: id }); });
        })(p.id);
        el.appendChild(b);
      }
    }

    // ---------------- detail ----------------
    // Tabbed: Overview (status + actions + danger zone) / Models / API key.
    const DETAIL_TABS = [
      ["overview", "prov.tab.overview", "sliders"],
      ["models", "prov.tab.models", "cpu"],
      ["key", "prov.tab.key", "key"],
    ];

    async function viewDetail(id, justAdded) {
      el.innerHTML = skeleton(5);
      let p = null, models = [];
      try {
        const res = await ctx.api("providers.list", {});
        p = ((res && res.providers) || []).find(function (x) { return String(x.id) === String(id); });
        if (!p) throw { message: ctx.t("state.error") };
        const mr = await ctx.api("models.list", { providerId: p.id });
        models = (mr && mr.models) || [];
      } catch (e) {
        el.innerHTML = errHtml(e);
        wireRetry();
        return;
      }
      if (st._detailId !== String(id)) {
        st.detailTab = "overview";
        st._detailId = String(id);
      }
      const tab = st.detailTab || "overview";

      el.innerHTML = "";
      subHeader(p.label || ("#" + p.id));

      const seg = document.createElement("div");
      seg.className = "seg";
      seg.setAttribute("role", "tablist");
      seg.innerHTML = DETAIL_TABS.map(function (tb) {
        return '<button type="button" role="tab" data-dtab="' + tb[0] + '" aria-selected="' +
          (tab === tb[0] ? "true" : "false") + '">' + ctx.icon(tb[2]) + ctx.esc(ctx.t(tb[1])) + "</button>";
      }).join("");
      el.appendChild(seg);

      const body = document.createElement("div");
      el.appendChild(body);

      function renderDetailTab(name) {
        body.innerHTML = "";
        if (name === "models") return buildModelsTab(body, p, models);
        if (name === "key") return buildKeyTab(body, p);
        return buildOverviewTab(body, p, justAdded, switchTab);
      }
      function switchTab(name) {
        st.detailTab = name;
        Array.prototype.forEach.call(seg.querySelectorAll("[data-dtab]"), function (b) {
          b.setAttribute("aria-selected", b.getAttribute("data-dtab") === name ? "true" : "false");
        });
        renderDetailTab(name);
      }
      Array.prototype.forEach.call(seg.querySelectorAll("[data-dtab]"), function (b) {
        b.addEventListener("click", function () { switchTab(b.getAttribute("data-dtab")); });
      });
      renderDetailTab(tab);
    }

    // ----- detail tab: overview -----
    function buildOverviewTab(host, p, justAdded, switchTab) {
      if (justAdded) {
        const nx = document.createElement("div");
        nx.className = "note note-info";
        nx.style.margin = "0 0 12px";
        nx.innerHTML =
          ctx.icon("checkCircle") +
          "<span><strong>" + ctx.esc(ctx.t("prov.justAdded")) + "</strong><br>" +
          "<strong>" + ctx.esc(ctx.t("prov.nextTitle")) + ":</strong> " +
          ctx.esc(ctx.t("prov.nextBody")) + "</span>";
        host.appendChild(nx);
      }

      // Status card
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        '<div class="card-head">' +
        provTile(p.label || p.adapterLabel) +
        "<div><div class=\"card-title\">" + ctx.esc(p.adapterLabel || "") + "</div>" +
        '<div class="card-sub" dir="ltr">' + ctx.esc(p.label || "") + "</div></div>" +
        '<div class="spacer"></div>' +
        (p.isActive ? activeBadge() : "") +
        "</div>" +
        '<div class="kv"><span class="k">' + ctx.esc(ctx.t("prov.keyHintLabel")) + "</span>" +
        (p.keyPresent
          ? '<span class="v"><span class="badge badge-success" dir="ltr">' + ctx.icon("key") + "••••" + ctx.esc(String(p.keyHint || "").slice(-4)) + "</span></span>"
          : '<span class="v"><span class="badge badge-danger">' + ctx.esc(ctx.t("prov.noKey")) + "</span></span>") +
        "</div>" +
        '<div class="kv"><span class="k">' + ctx.esc(ctx.t("prov.typeLabel")) + '</span><span class="v">' +
        ctx.esc(p.adapterLabel || adapterLabelFor(p.adapterType)) +
        (p.adapterType ? ' <span class="mono prov-slug" dir="ltr">' + ctx.esc(p.adapterType) + "</span>" : "") + "</span></div>" +
        (p.baseUrl
          ? '<div class="kv"><span class="k">' + ctx.esc(ctx.t("prov.baseUrl")) + '</span><span class="v mono prov-url-inline" dir="ltr" title="' + ctx.esc(p.baseUrl) + '">' + ctx.esc(truncUrl(p.baseUrl)) + "</span></div>"
          : "") +
        (activeModelOf(p)
          ? '<div class="kv"><span class="k">' + ctx.esc(ctx.t("prov.activeModel")) + '</span><span class="v mono" dir="ltr">' + ctx.esc(truncUrl(activeModelOf(p))) + "</span></div>"
          : "") +
        '<div class="kv"><span class="k">' + ctx.esc(ctx.t("prov.lastProbe")) + '</span><span class="v" id="probeLine">' +
        statusDot(p) + " " + ctx.esc(probeText(p)) + "</span></div>" +
        (p.lastProbe && !p.lastProbe.ok && p.lastProbe.message
          ? '<div class="prov-probe-msg" id="probeDetail">' + ctx.esc(p.lastProbe.message) +
            (p.lastProbe.status !== undefined && p.lastProbe.status !== null ? " (" + ctx.esc(fmt("prov.httpStatus", p.lastProbe.status)) + ")" : "") + "</div>"
          : '<div class="prov-probe-msg" id="probeDetail" hidden></div>') +
        (healthBadges(p) ? '<div class="prov-badges">' + healthBadges(p) + "</div>" : "") +
        '<div class="mx-row" style="margin-top:12px"><span style="font-weight:600">' +
        ctx.esc(ctx.t(p.enabled ? "prov.enabled" : "prov.disabled")) + "</span>" +
        '<button type="button" class="toggle" id="enabledToggle" role="switch" aria-checked="' + (p.enabled ? "true" : "false") +
        '" aria-label="' + ctx.esc(ctx.t("prov.enabled")) + '"></button></div>';
      host.appendChild(card);
      card.querySelector("#enabledToggle").addEventListener("click", async function () {
        try {
          await ctx.api("providers.toggle", { id: p.id, enabled: !p.enabled });
          ctx.toast(ctx.t("toast.saved"), "ok");
        } catch (e) {
          ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
        }
        paint();
      });

      // Actions: probe / discover / set-active / edit
      const actions = document.createElement("div");
      actions.className = "card";
      const probeResId = "probeResult";
      actions.innerHTML =
        '<div class="card-head tight"><div class="card-icon amber">' + ctx.icon("zap") + "</div>" +
        "<div><h2 class=\"card-title\">" + ctx.esc(ctx.t("prov.actionsTitle")) + "</h2></div></div>" +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<button type="button" class="btn btn-ghost" id="probeBtn">' + ctx.icon("zap") + ctx.esc(ctx.t("action.probe")) + "</button>" +
        '<button type="button" class="btn btn-ghost" id="discGoBtn">' + ctx.icon("search") + ctx.esc(ctx.t("prov.discoverTitle")) + "</button>" +
        '<button type="button" class="btn btn-ghost" id="activateBtn"' + (p.isActive || !p.keyPresent ? " disabled" : "") + ">" +
        ctx.icon("star") + ctx.esc(ctx.t("prov.setActiveProvider")) + "</button>" +
        '<button type="button" class="btn btn-ghost" id="editBtn">' + ctx.icon("edit") + ctx.esc(ctx.t("prov.editProvider")) + "</button>" +
        "</div>" +
        '<div class="mx-kv" id="' + probeResId + '" style="text-align:center;margin-top:10px"></div>' +
        (!p.keyPresent
          ? '<div class="note note-warn">' + ctx.icon("alert") + "<span>" + ctx.esc(ctx.t("prov.needKeyFirst")) + "</span></div>"
          : "");
      host.appendChild(actions);

      const probeBtn = actions.querySelector("#probeBtn");
      const probeResult = actions.querySelector("#" + probeResId);
      probeBtn.addEventListener("click", async function () {
        probeBtn.disabled = true;
        probeResult.textContent = ctx.t("prov.probing");
        try {
          // Domain results (ok:false, no `error`) now come back from api.js
          // instead of throwing — the real message/status/stages render here.
          const r = await ctx.api("providers.probe", { id: p.id });
          probeResult.textContent = probeLineText(r);
          probeResult.style.color = r.ok ? "var(--success)" : "var(--danger)";
          const pd = card.querySelector("#probeDetail");
          if (pd) {
            pd.textContent = !r.ok && r.message ? r.message : "";
            pd.hidden = !(!r.ok && r.message);
          }
          // refresh the status line in place
          const pl = card.querySelector("#probeLine");
          if (pl) pl.innerHTML = statusDot({ lastProbe: { ok: r.ok } }) + " " +
            ctx.esc((r.ok ? "✓" : "✗") + " " + ctx.t("prov.agoNow") +
              (r.latencyMs !== undefined && r.latencyMs !== null ? " · " + num(r.latencyMs) + " " + ctx.t("prov.ms") : ""));
          const dot = card.querySelector(".dot");
          if (dot) dot.className = "dot " + (r.ok ? "ok" : "err");
        } catch (e2) {
          probeResult.textContent = ctx.t("prov.probeFailLine") + " · " + ((e2 && (e2.message || e2.code)) || "");
          probeResult.style.color = "var(--danger)";
        }
        probeBtn.disabled = false;
      });

      actions.querySelector("#discGoBtn").addEventListener("click", function () {
        switchTab("models");
      });

      const activateBtn = actions.querySelector("#activateBtn");
      if (activateBtn && !activateBtn.disabled) {
        activateBtn.addEventListener("click", async function () {
          activateBtn.disabled = true;
          try {
            const r = await ctx.api("providers.setActive", { id: p.id });
            let msg = ctx.t("prov.activated") + (r.label ? ": " + r.label : "");
            // Probe on select: warn inline when the fresh selection doesn't answer.
            if (r.probe && !r.probe.ok) {
              msg += "\nNote: " + ctx.t("prov.probeFailLine") + (r.probe.message ? ": " + r.probe.message : "");
            }
            ctx.toast(msg, r.probe && !r.probe.ok ? "err" : "ok");
          } catch (e) {
            ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
          }
          paint();
        });
      }

      const editCard = document.createElement("div");
      editCard.className = "card";
      editCard.hidden = true;
      editCard.innerHTML =
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
        '<input id="editLabel" type="text" value="' + ctx.esc(p.label || "") + '" dir="auto"></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.typeLabel")) + "</label>" +
        '<div class="prov-type-locked">' + ctx.esc(p.adapterLabel || adapterLabelFor(p.adapterType)) +
        (p.adapterType ? ' <span class="mono prov-slug" dir="ltr">' + ctx.esc(p.adapterType) + "</span>" : "") + "</div>" +
        '<div class="hint-text">' + ctx.esc(ctx.t("prov.typeChangeNote")) + "</div></div>" +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.url")) + "</label>" +
        '<input id="editUrl" type="url" value="' + ctx.esc(p.baseUrl || "") + '" dir="ltr"' + (p.isActive ? " disabled" : "") + ">" +
        '<div class="error" id="editUrlErr" hidden></div></div>' +
        (p.isActive
          ? '<div class="note note-warn" style="margin:0 0 12px">' + ctx.icon("alert") + "<span>" + ctx.esc(ctx.t("prov.activeLocked")) + "</span></div>"
          : "") +
        '<div class="error" id="editErr" hidden style="margin-bottom:10px"></div>' +
        '<button type="button" class="btn btn-primary btn-block" id="saveEdit">' + ctx.icon("check") + ctx.esc(ctx.t("action.save")) + "</button>";
      host.appendChild(editCard);
      actions.querySelector("#editBtn").addEventListener("click", function () {
        editCard.hidden = !editCard.hidden;
      });
      const editUrlInput = editCard.querySelector("#editUrl");
      const editErrEl = editCard.querySelector("#editUrlErr");
      function checkEditMismatch() {
        const mm = mismatchFor(editUrlInput.value, p.adapterType || "openai_compatible");
        if (mm) {
          editErrEl.textContent = mm.message;
          editErrEl.hidden = false;
          return mm;
        }
        editErrEl.hidden = true;
        return null;
      }
      editUrlInput.addEventListener("input", checkEditMismatch);
      editCard.querySelector("#saveEdit").addEventListener("click", async function () {
        const label = editCard.querySelector("#editLabel").value.trim();
        const url = editUrlInput.value.trim();
        const errEl = editErrEl;
        const srvErrEl = editCard.querySelector("#editErr");
        srvErrEl.hidden = true;
        if (url && !urlOk(url)) {
          errEl.textContent = ctx.t("prov.urlInvalid");
          errEl.hidden = false;
          return;
        }
        if (checkEditMismatch()) return; // hard warning shown inline, before save
        errEl.hidden = true;
        // Only send fields that are actually set; the backend rejects empty
        // values with a 400, so don't round-trip a cleared URL. While the
        // provider is active the URL input is disabled — never send it.
        const patch = { id: p.id };
        if (label) patch.label = label;
        if (url && !p.isActive) patch.baseUrl = url;
        try {
          await ctx.api("providers.update", patch);
          ctx.toast(ctx.t("toast.saved"), "ok");
        } catch (e) {
          // Server guard errors (message + suggestion) render inline here,
          // not just as a toast, and the card stays open for the fix.
          showServerError(srvErrEl, e);
          ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
          return;
        }
        paint();
      });

      // Danger zone: delete provider
      const dz = document.createElement("div");
      dz.className = "danger-zone";
      dz.innerHTML =
        '<div class="card-title">' + ctx.icon("alert") + ctx.esc(ctx.t("prov.dangerTitle")) + "</div>" +
        '<button type="button" class="btn btn-danger btn-block" id="delProv">' +
        ctx.icon("trash") + ctx.esc(ctx.t("prov.deleteProvider")) + "</button>";
      host.appendChild(dz);
      dz.querySelector("#delProv").addEventListener("click", async function () {
        const ok = await ctx.confirmDialog(ctx.t("dialog.confirmTitle"), ctx.t("prov.deleteConfirm"));
        if (!ok) return;
        try {
          await ctx.api("providers.delete", { id: p.id, confirm: true });
          ctx.toast(ctx.t("toast.deleted"), "ok");
          setView({ name: "list" });
        } catch (e) {
          ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
        }
      });
    }

    // ----- detail tab: models -----
    function buildModelsTab(host, p, models) {
      const mcard = document.createElement("div");
      mcard.className = "card";
      mcard.innerHTML =
        '<div class="card-head"><div class="card-icon blue">' + ctx.icon("cpu") + "</div>" +
        "<div><h2 class=\"card-title\">" + ctx.esc(ctx.t("prov.models")) + "</h2>" +
        '<p class="card-sub">' + ctx.esc(ctx.t("prov.discoverHint")) + "</p></div>" +
        '<div class="spacer"></div><span class="badge">' + fmt("prov.modelCount", models.length) + "</span></div>" +
        '<button type="button" class="btn btn-primary btn-block" id="discBtn" style="margin-top:0"></button>' +
        '<div id="discList"></div>' +
        '<div id="modelRows" style="margin-top:8px"></div>';
      host.appendChild(mcard);

      const discBtn = mcard.querySelector("#discBtn");
      function discLabel() {
        discBtn.innerHTML = ctx.icon("search") + ctx.esc(ctx.t("prov.discoverTitle"));
      }
      discLabel();
      paintModelRows(mcard.querySelector("#modelRows"), models, p.id);

      discBtn.addEventListener("click", async function () {
        const list = mcard.querySelector("#discList");
        discBtn.disabled = true;
        discBtn.textContent = ctx.t("prov.discovering");
        let found = [];
        try {
          const r = await ctx.api("models.discover", { providerId: p.id });
          found = (r.models || []).filter(function (m) { return !m.imported; });
        } catch (e) {
          ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
          discBtn.disabled = false;
          discLabel();
          return;
        }
        if (!found.length) {
          list.innerHTML = '<div class="mx-kv" style="margin-top:8px">' + ctx.esc(ctx.t("prov.allImported")) + "</div>";
          discBtn.disabled = false;
          discLabel();
          return;
        }
        let h = '<div style="margin-top:10px;max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:12px;padding:4px 8px">';
        for (let i = 0; i < found.length; i++) {
          h += '<label class="checkbox-row"><input type="checkbox" data-i="' + i + '" checked>' +
            '<span class="mono" dir="ltr">' + ctx.esc(found[i].modelId) + "</span></label>";
        }
        h += "</div>" +
          '<div style="display:flex;gap:8px;margin-top:6px">' +
          '<button type="button" class="btn btn-ghost btn-sm" id="selAll" style="flex:1">' + ctx.esc(ctx.t("prov.selectAll")) + "</button>" +
          '<button type="button" class="btn btn-ghost btn-sm" id="selNone" style="flex:1">' + ctx.esc(ctx.t("prov.selectNone")) + "</button>" +
          "</div>" +
          '<button type="button" class="btn btn-primary btn-block" id="importBtn">' + ctx.icon("download") +
          ctx.esc(ctx.t("prov.importSelected")) + " (" + num(found.length) + ")</button>";
        list.innerHTML = h;
        const setAll = function (v) {
          const boxes = list.querySelectorAll('input[type="checkbox"]');
          for (const b of boxes) b.checked = v;
        };
        list.querySelector("#selAll").addEventListener("click", function () { setAll(true); });
        list.querySelector("#selNone").addEventListener("click", function () { setAll(false); });
        list.querySelector("#importBtn").addEventListener("click", async function () {
          const boxes = list.querySelectorAll('input[type="checkbox"]');
          const sel = [];
          for (const b of boxes) if (b.checked) sel.push(found[parseInt(b.dataset.i, 10)].modelId);
          if (!sel.length) return;
          try {
            const r = await ctx.api("models.import", { providerId: p.id, modelIds: sel });
            ctx.toast(fmt("prov.imported", (r && r.imported) || sel.length), "ok");
          } catch (e) {
            ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
          }
          paint();
        });
        discBtn.disabled = false;
        discLabel();
      });

      // Manual add
      const manual = document.createElement("div");
      manual.innerHTML =
        '<div class="group-label">' + ctx.icon("plus") + ctx.esc(ctx.t("prov.manualAdd")) + "</div>" +
        '<div class="field"><div style="display:flex;gap:8px">' +
        '<input id="manualId" type="text" dir="ltr" placeholder="model-id" style="flex:1;min-width:0" autocomplete="off">' +
        '<button type="button" class="btn btn-ghost" id="manualAddBtn">' + ctx.icon("plus") + ctx.esc(ctx.t("action.add")) + "</button>" +
        "</div></div>";
      host.appendChild(manual);
      manual.querySelector("#manualAddBtn").addEventListener("click", async function () {
        const mid = manual.querySelector("#manualId").value.trim();
        if (!mid) return;
        try {
          await ctx.api("models.add", { providerId: p.id, modelId: mid });
          ctx.toast(ctx.t("toast.saved"), "ok");
        } catch (e) {
          ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
        }
        paint();
      });
    }

    // ----- detail tab: API key -----
    function buildKeyTab(host, p) {
      const keyCard = document.createElement("div");
      keyCard.className = "card";
      keyCard.innerHTML =
        '<div class="card-head"><div class="card-icon green">' + ctx.icon("key") + "</div>" +
        "<div><h2 class=\"card-title\">" + ctx.esc(ctx.t("prov.keyTitle")) + "</h2>" +
        '<p class="card-sub">' +
        (p.keyPresent
          ? '<span class="badge badge-success" dir="ltr">' + ctx.icon("key") + "••••" + ctx.esc(String(p.keyHint || "").slice(-4)) + "</span>"
          : '<span class="badge badge-danger">' + ctx.esc(ctx.t("prov.noKey")) + "</span>") +
        "</p></div></div>" +
        '<div class="field"><label>' + ctx.esc(ctx.t(p.keyPresent ? "prov.replaceKey" : "prov.setKey")) + "</label>" +
        '<input id="keyInput" type="password" autocomplete="new-password" placeholder="' +
        ctx.esc(ctx.t("prov.keyPlaceholder")) + '" dir="ltr"></div>' +
        '<div class="btn-row">' +
        '<button type="button" class="btn btn-primary" id="saveKey">' + ctx.icon("check") +
        ctx.esc(ctx.t(p.keyPresent ? "prov.replaceKey" : "prov.setKey")) + "</button>" +
        (p.keyPresent ? '<button type="button" class="btn btn-ghost" id="clearKey">' + ctx.icon("trash") + ctx.esc(ctx.t("prov.clearKey")) + "</button>" : "") +
        "</div>";
      host.appendChild(keyCard);
      keyCard.querySelector("#saveKey").addEventListener("click", async function () {
        const key = keyCard.querySelector("#keyInput").value;
        if (!key) {
          ctx.toast(ctx.t("prov.keyRequired"), "err");
          return;
        }
        try {
          await ctx.api("providers.setKey", { id: p.id, key: key });
          ctx.toast(ctx.t("prov.keySaved"), "ok");
        } catch (e) {
          ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
        }
        paint();
      });
      const clearBtn = keyCard.querySelector("#clearKey");
      if (clearBtn) {
        clearBtn.addEventListener("click", async function () {
          const ok = await ctx.confirmDialog(ctx.t("dialog.confirmTitle"), ctx.t("prov.clearKeyConfirm"));
          if (!ok) return;
          try {
            await ctx.api("providers.clearKey", { id: p.id, confirm: true });
            ctx.toast(ctx.t("toast.deleted"), "ok");
          } catch (e) {
            ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
          }
          paint();
        });
      }
    }

    function paintModelRows(host, models, providerId) {
      host.innerHTML = "";
      if (!models.length) {
        host.innerHTML = '<div class="mx-center">' + ctx.esc(ctx.t("prov.noModelsYet")) + "</div>";
        return;
      }
      for (const m of models) {
        const row = document.createElement("div");
        row.className = "card";
        row.style.marginBottom = "9px";
        row.innerHTML =
          '<div class="mx-row">' +
          '<div class="list-main"><div class="list-title mono" dir="ltr">' + ctx.esc(m.modelId || m.id) + "</div>" +
          (m.isActive
            ? '<div style="margin-top:5px"><span class="badge badge-accent">' + ctx.icon("star") + ctx.esc(ctx.t("prov.modelActive")) + "</span></div>"
            : "") +
          "</div>" +
          '<button type="button" class="toggle" role="switch" aria-checked="' + (m.enabled ? "true" : "false") + '" aria-label="' + ctx.esc(ctx.t("prov.enabled")) + '"></button>' +
          "</div>" +
          '<div class="btn-row" style="margin-top:10px">' +
          (m.isActive
            ? ""
            : '<button type="button" class="btn btn-sm btn-subtle act-active">' + ctx.icon("star") + ctx.esc(ctx.t("prov.setActiveProvider")) + "</button>") +
          '<button type="button" class="btn btn-sm btn-subtle act-test">' + ctx.icon("zap") + ctx.esc(ctx.t("prov.testModel")) + "</button>" +
          '<span class="model-test-out" style="align-self:center"></span>' +
          '<button type="button" class="btn btn-sm btn-danger act-del" aria-label="' + ctx.esc(ctx.t("action.delete")) + '">' + ctx.icon("trash") + "</button>" +
          "</div>";
        row.querySelector(".toggle").addEventListener("click", async function () {
          try {
            await ctx.api("models.toggle", { id: m.id, enabled: !m.enabled });
            ctx.toast(ctx.t("toast.saved"), "ok");
          } catch (e) {
            ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
          }
          paint();
        });
        const actBtn = row.querySelector(".act-active");
        if (actBtn) {
          actBtn.addEventListener("click", async function () {
            try {
              const r = await ctx.api("models.setActive", { id: m.id });
              let msg = ctx.t("prov.activated");
              // Probe on select: warn inline when the fresh selection doesn't answer.
              if (r && r.probe && !r.probe.ok) {
                msg += "\nNote: " + ctx.t("prov.probeFailLine") + (r.probe.message ? ": " + r.probe.message : "");
              }
              ctx.toast(msg, r && r.probe && !r.probe.ok ? "err" : "ok");
            } catch (e) {
              ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
            }
            paint();
          });
        }
        const testBtn = row.querySelector(".act-test");
        const testOut = row.querySelector(".model-test-out");
        if (testBtn && testOut) {
          testBtn.addEventListener("click", async function () {
            testBtn.disabled = true;
            testOut.style.color = "";
            testOut.textContent = ctx.t("prov.testingModel");
            try {
              const r = await ctx.api("models.test", { providerId: providerId, modelId: m.modelId });
              if (r && r.ping) {
                // Two-stage test: the cheap ping AND a realistic turn.
                // A green ping with a failed real stage is the apinex
                // failure mode — show both so it can never hide again.
                // (Reachable on failure now that api.js returns domain
                // ok:false bodies instead of throwing "Server error".)
                testOut.style.color = r.ok ? "var(--success)" : "var(--danger)";
                testOut.textContent = stageBreakdown(r);
              } else if (r && r.ok) {
                testOut.style.color = "var(--success)";
                testOut.textContent = "✅ " + (r.latencyMs !== undefined && r.latencyMs !== null ? num(r.latencyMs) + " " + ctx.t("prov.ms") : "");
              } else {
                testOut.style.color = "var(--danger)";
                testOut.textContent = "❌ " + ((r && r.message) || ctx.t("prov.probeFailLine"));
              }
            } catch (e) {
              testOut.style.color = "var(--danger)";
              testOut.textContent = "❌ " + ((e && (e.message || e.code)) || ctx.t("prov.probeFailLine"));
            }
            testBtn.disabled = false;
          });
        }
        row.querySelector(".act-del").addEventListener("click", async function () {
          const ok = await ctx.confirmDialog(ctx.t("dialog.confirmTitle"), ctx.t("prov.deleteModelConfirm"));
          if (!ok) return;
          try {
            await ctx.api("models.delete", { id: m.id, confirm: true });
            ctx.toast(ctx.t("toast.deleted"), "ok");
          } catch (e) {
            ctx.toast((e && e.message) || ctx.t("toast.failed"), "err");
          }
          paint();
        });
        host.appendChild(row);
      }
    }

    // ---------------- add ----------------
    async function viewAdd(tab) {
      el.innerHTML = "";
      subHeader(ctx.t("prov.addProviderTitle"));

      const body = document.createElement("div");
      el.appendChild(body);

      if (tab === "custom") return customForm(body);
      if (tab === "nine") return nineForm(body);

      // Gallery = service presets + ALL adapter templates (gemini and
      // anthropic included), normalized to one shape. Each entry locks its
      // adapter type and prefills its base URL.
      let entries = FALLBACK_PRESETS.concat(FALLBACK_TEMPLATES);
      try {
        const r = await ctx.api("providers.presets", {});
        const norm = [];
        const seenIds = new Set();
        const push = function (e) {
          if (!e) return;
          const id = String(e.id || e.type || "");
          if (!id || seenIds.has(id)) return;
          seenIds.add(id);
          norm.push(e);
        };
        if (r && r.presets) for (const pr of r.presets) push(normalizeEntry(pr, false));
        if (r && r.templates) for (const tp of r.templates) {
          // The openai_compatible / nine_router templates duplicate the
          // dedicated Custom / 9Router forms below — don't render them twice.
          if (tp.type === "openai_compatible" || tp.type === "nine_router") continue;
          push(normalizeEntry(tp, true));
        }
        if (norm.length) entries = norm;
      } catch (e) { /* fallback stays */ }

      const sub = st.view.sub;
      if (sub && sub.indexOf("preset:") === 0) {
        const pr = entries.find(function (x) { return String(x.id) === sub.slice(7); });
        if (pr) return pr.isTemplate ? templateForm(body, pr) : presetForm(body, pr);
      }
      return presetGrid(body, entries);
    }

    function normalizeEntry(e, isTemplate) {
      const type = e.adapterType || e.type || (isTemplate ? "" : "openai_compatible");
      return {
        id: String(e.id || e.type || ""),
        label: e.label || adapterLabelFor(type),
        baseUrl: e.baseUrl || e.suggestedBaseUrl || "",
        suggestedModel: e.suggestedModel,
        hasPlaceholder: !!e.hasPlaceholder || !!e.requiredPlaceholder,
        requiredPlaceholder: e.requiredPlaceholder,
        note: e.note || e.notes,
        adapterType: type,
        isTemplate: !!isTemplate,
      };
    }
    function entryType(entry) {
      return entry.adapterType || entry.type || "openai_compatible";
    }

    function presetGrid(body, presets) {
      let h = '<p class="mx-muted" style="margin:0 0 12px">' + ctx.esc(ctx.t("prov.presetNote")) + "</p>";
      h += '<div class="preset-grid">';
      for (const pr of presets) {
        const type = entryType(pr);
        h +=
          '<button type="button" class="preset-card" data-pid="' + ctx.esc(pr.id) + '">' +
          provTile(pr.label) +
          '<div style="min-width:0"><div class="preset-name">' + ctx.esc(pr.label) + "</div>" +
          '<div class="preset-sub prov-type-sub" dir="ltr">' + ctx.esc(adapterLabelFor(type) + " · " + type) + "</div>" +
          (pr.suggestedModel ? '<div class="preset-sub mono" dir="ltr">' + ctx.esc(pr.suggestedModel) + "</div>" : "") +
          "</div></button>";
      }
      h += "</div>";
      h += '<div class="group-label">' + ctx.icon("plus") + ctx.esc(ctx.t("prov.customEndpoint")) + "</div>";
      h += '<p class="mx-muted" style="margin:0 0 8px">' + ctx.esc(ctx.t("prov.customTypeNote")) + "</p>";
      h += '<div style="display:flex;gap:8px">' +
        '<button type="button" class="btn btn-ghost" id="goCustom" style="flex:1">' + ctx.icon("cpu") + ctx.esc(ctx.t("prov.addCustom")) + "</button>" +
        '<button type="button" class="btn btn-ghost" id="goNine" style="flex:1">' + ctx.icon("layers") + ctx.esc(ctx.t("prov.addNine")) + "</button></div>";
      body.innerHTML = h;
      body.querySelector("#goCustom").addEventListener("click", function () { setView({ name: "add", tab: "custom" }); });
      body.querySelector("#goNine").addEventListener("click", function () { setView({ name: "add", tab: "nine" }); });
      const cards = body.querySelectorAll(".preset-card");
      for (const c of cards) {
        c.addEventListener("click", function () {
          const pr = presets.find(function (x) { return String(x.id) === c.dataset.pid; });
          if (pr) pr.isTemplate ? templateForm(body, pr) : presetForm(body, pr);
        });
      }
    }

    // Post-add guided flow, shared by every add form: auto-run Discover
    // models (importing what was picked / found), auto-run Test connection,
    // show both results inline, then a prominent Set active button.
    // opts: { picker?, autoSelected?, skipDiscover? }
    async function finishAddFlow(body, providerId, opts) {
      opts = opts || {};
      const card = document.createElement("div");
      card.className = "card prov-add-result";
      card.innerHTML =
        '<div class="card-head tight"><div class="card-icon green">' + ctx.icon("checkCircle") + "</div>" +
        "<div><h2 class=\"card-title\">" + ctx.esc(ctx.t("prov.addResultTitle")) + "</h2>" +
        '<p class="card-sub">' + ctx.esc(ctx.t("prov.autoChecking")) + "</p></div></div>" +
        '<div class="prov-check-line" id="faDiscover"></div>' +
        '<div class="prov-check-line" id="faProbe"></div>' +
        '<div class="error" id="faErr" hidden style="margin:8px 0"></div>' +
        '<button type="button" class="btn btn-primary btn-block prov-set-active" id="faActivate">' +
        ctx.icon("star") + ctx.esc(ctx.t("prov.setActiveProvider")) + "</button>" +
        '<button type="button" class="btn btn-ghost btn-block" id="faView" style="margin-top:8px">' +
        ctx.esc(ctx.t("prov.viewProvider")) + "</button>";
      body.appendChild(card);
      try { card.scrollIntoView({ block: "nearest" }); } catch (e) { /* older webviews */ }

      const discLine = card.querySelector("#faDiscover");
      const probeLine = card.querySelector("#faProbe");
      const errEl = card.querySelector("#faErr");
      const actBtn = card.querySelector("#faActivate");
      if (opts.autoSelected) {
        actBtn.innerHTML = ctx.icon("star") + ctx.esc(ctx.t("prov.activated"));
        actBtn.disabled = true;
      }
      card.querySelector("#faView").addEventListener("click", function () {
        setView({ name: "detail", id: providerId, justAdded: true });
      });
      actBtn.addEventListener("click", async function () {
        actBtn.disabled = true;
        errEl.hidden = true;
        try {
          const r = await ctx.api("providers.setActive", { id: providerId });
          if (r.probe && !r.probe.ok) {
            showServerError(errEl, { message: ctx.t("prov.probeFailLine") + (r.probe.message ? ": " + r.probe.message : "") });
          }
          ctx.toast(ctx.t("prov.activated") + (r.label ? ": " + r.label : ""), r.probe && !r.probe.ok ? "err" : "ok");
          setView({ name: "detail", id: providerId, justAdded: true });
        } catch (e) {
          showServerError(errEl, e);
          actBtn.disabled = false;
        }
      });

      // 1) Discover models
      if (!opts.skipDiscover) {
        try {
          const picked = opts.picker ? opts.picker.selectedIds() : [];
          if (picked.length) {
            const im = await ctx.api("models.import", { providerId: providerId, modelIds: picked });
            discLine.textContent = "✅ " + fmt("prov.importedN", (im && im.imported) || picked.length);
          } else {
            const r = await ctx.api("models.discover", { providerId: providerId });
            const found = (r && r.models) || [];
            const fresh = found.filter(function (m) { return !m.imported; });
            let line = "✅ " + fmt("prov.discoveredN", found.length);
            if (fresh.length) {
              const im = await ctx.api("models.import", {
                providerId: providerId,
                modelIds: fresh.map(function (m) { return m.modelId; }),
              });
              line += " · " + fmt("prov.importedN", (im && im.imported) || fresh.length);
            }
            discLine.textContent = line;
          }
        } catch (e) {
          discLine.textContent = "⚠️ " + ctx.t("prov.discoverFailed") + ": " + ((e && e.message) || "");
          discLine.style.color = "var(--warning)";
        }
      } else {
        discLine.hidden = true;
      }

      // 2) Test connection — a domain ok:false comes back, never throws.
      try {
        const r = await ctx.api("providers.probe", { id: providerId });
        probeLine.textContent = (r.ok ? "✅ " : "❌ ") + probeLineText(r);
        probeLine.style.color = r.ok ? "var(--success)" : "var(--danger)";
      } catch (e) {
        probeLine.textContent = "❌ " + ctx.t("prov.probeFailLine") + " · " + ((e && (e.message || e.code)) || "");
        probeLine.style.color = "var(--danger)";
      }
    }

    // Draft model picker for the add forms (preset + custom): fetch the
    // provider's model list with the just-typed key/URL, tick to select,
    // "all/none" shortcuts, and a manual ID input for IDs not in the list.
    // opts.getParams() returns { kind, preset?, baseUrl?, key } or throws
    // an Error with a user-facing message.
    function draftModelsPicker(container, opts) {
      const seen = new Set();
      const card = document.createElement("div");
      card.className = "card";
      card.style.marginTop = "12px";
      card.innerHTML =
        '<div class="card-head tight"><div class="card-icon blue">' + ctx.icon("cpu") + "</div>" +
        "<div><h2 class=\"card-title\">" + ctx.esc(ctx.t("prov.models")) + "</h2></div></div>" +
        '<div class="hint-text" style="margin-bottom:10px">' + ctx.esc(ctx.t("prov.draftModelsHint")) + "</div>" +
        '<button type="button" class="btn btn-ghost btn-block" id="dmFetch" style="margin-top:0">' +
        ctx.icon("refresh") + ctx.esc(ctx.t("prov.fetchModels")) + "</button>" +
        '<div class="error" id="dmErr" hidden style="margin-top:8px"></div>' +
        '<div id="dmList" style="margin-top:8px"></div>' +
        '<div id="dmFoot" hidden style="margin-top:10px">' +
        '<div style="display:flex;gap:8px;margin-bottom:10px">' +
        '<button type="button" class="btn btn-ghost" id="dmAll" style="flex:1">' + ctx.esc(ctx.t("prov.selectAll")) + "</button>" +
        '<button type="button" class="btn btn-ghost" id="dmNone" style="flex:1">' + ctx.esc(ctx.t("prov.selectNone")) + "</button>" +
        "</div>" +
        '<div class="field" style="margin-bottom:0"><label>' + ctx.esc(ctx.t("prov.manualModelId")) + "</label>" +
        '<div style="display:flex;gap:8px">' +
        '<input id="dmManual" type="text" dir="ltr" placeholder="gpt-4o-mini" style="flex:1;min-width:0">' +
        '<button type="button" class="btn btn-ghost" id="dmAdd">' + ctx.esc(ctx.t("prov.addManual")) + "</button>" +
        "</div>" +
        '<div class="hint-text">' + ctx.esc(ctx.t("prov.manualModelHint")) + "</div></div>" +
        '<div class="list-sub" id="dmCount" style="margin-top:8px"></div>' +
        "</div>";
      container.appendChild(card);

      const errEl = card.querySelector("#dmErr");
      const listEl = card.querySelector("#dmList");
      const footEl = card.querySelector("#dmFoot");
      const countEl = card.querySelector("#dmCount");
      const fetchBtn = card.querySelector("#dmFetch");

      function updateCount() {
        let n = 0;
        const boxes = listEl.querySelectorAll('input[type="checkbox"]');
        for (let i = 0; i < boxes.length; i++) if (boxes[i].checked) n++;
        countEl.textContent = n + " " + ctx.t("prov.modelsSelected");
      }

      function addRow(id, label, checked) {
        if (!id || seen.has(id)) return;
        seen.add(id);
        const row = document.createElement("label");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border,#eee);cursor:pointer";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked !== false;
        cb.setAttribute("data-mid", id);
        cb.addEventListener("change", updateCount);
        const span = document.createElement("span");
        span.className = "mono";
        span.dir = "ltr";
        span.style.cssText = "word-break:break-all";
        span.textContent = label && label !== id ? label + " (" + id + ")" : id;
        row.appendChild(cb);
        row.appendChild(span);
        listEl.appendChild(row);
        updateCount();
      }

      fetchBtn.addEventListener("click", async function () {
        errEl.hidden = true;
        let p;
        try {
          p = opts.getParams();
        } catch (e) {
          errEl.textContent = (e && e.message) || ctx.t("toast.failed");
          errEl.hidden = false;
          return;
        }
        fetchBtn.disabled = true;
        const old = fetchBtn.textContent;
        fetchBtn.textContent = ctx.t("prov.fetchingModels");
        try {
          const r = await ctx.api("models.discoverDraft", p);
          const models = (r && r.models) || [];
          if (!models.length) {
            errEl.textContent = ctx.t("prov.noModelsFound");
            errEl.hidden = false;
          }
          for (const m of models) addRow(m.modelId, m.label, true);
          footEl.hidden = false;
        } catch (e) {
          errEl.textContent = (e && e.message) || ctx.t("toast.failed");
          errEl.hidden = false;
        } finally {
          fetchBtn.disabled = false;
          fetchBtn.textContent = old;
        }
      });

      card.querySelector("#dmAll").addEventListener("click", function () {
        const boxes = listEl.querySelectorAll('input[type="checkbox"]');
        for (let i = 0; i < boxes.length; i++) boxes[i].checked = true;
        updateCount();
      });
      card.querySelector("#dmNone").addEventListener("click", function () {
        const boxes = listEl.querySelectorAll('input[type="checkbox"]');
        for (let i = 0; i < boxes.length; i++) boxes[i].checked = false;
        updateCount();
      });
      card.querySelector("#dmAdd").addEventListener("click", function () {
        const inp = card.querySelector("#dmManual");
        const id = inp.value.trim();
        if (!id) return;
        addRow(id, id, true);
        inp.value = "";
        footEl.hidden = false;
      });

      return {
        selectedIds: function () {
          const ids = [];
          const boxes = listEl.querySelectorAll('input[type="checkbox"]');
          for (let i = 0; i < boxes.length; i++) {
            if (boxes[i].checked) ids.push(boxes[i].getAttribute("data-mid"));
          }
          return ids;
        },
      };
    }

    function presetForm(body, pr) {
      st.view.sub = "preset:" + pr.id;
      const needsPlaceholder = !!pr.hasPlaceholder && !!pr.requiredPlaceholder;
      const phKey = needsPlaceholder ? String(pr.requiredPlaceholder) : "";
      body.innerHTML =
        '<div class="card">' +
        '<div style="font-weight:700;margin-bottom:6px">' + ctx.esc(pr.label) + "</div>" +
        '<div style="margin-bottom:10px"><span class="badge badge-info prov-badge" dir="ltr">' +
        ctx.esc(adapterLabelFor(entryType(pr)) + " · " + entryType(pr)) + "</span></div>" +
        (pr.note ? '<div class="list-sub" style="white-space:normal;margin-bottom:10px">' + ctx.esc(pr.note) + "</div>" : "") +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
        '<input id="pfLabel" type="text" value="' + ctx.esc(pr.label) + '" dir="auto"></div>' +
        (needsPlaceholder
          ? '<div class="field"><label>' + ctx.esc(ctx.t("prov.accountId")) + " (" + ctx.esc(phKey) + ")</label>" +
            '<input id="pfPh" type="text" dir="ltr" placeholder="' + ctx.esc(phKey) + '">' +
            '<div class="hint-text">' + ctx.esc(ctx.t("prov.accountIdHint")) + "</div>" +
            '<div class="hint-text mono" dir="ltr" id="pfUrlPreview" style="margin-top:4px"></div></div>'
          : "") +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.key")) + "</label>" +
        '<input id="pfKey" type="password" autocomplete="new-password" placeholder="' + ctx.esc(ctx.t("prov.keyPlaceholder")) + '" dir="ltr">' +
        '<div class="error" id="pfKeyErr" hidden></div></div>' +
        '<div class="list-sub mono" dir="ltr" style="margin-bottom:8px;white-space:normal;word-break:break-all">' + ctx.esc(pr.baseUrl) + "</div>" +
        '<div class="error" id="pfErr" hidden style="margin-bottom:10px"></div>' +
        '<button type="button" class="btn btn-primary btn-block" id="pfSave">' + ctx.esc(ctx.t("action.save")) + "</button>" +
        "</div>";

      const phInput = body.querySelector("#pfPh");
      const preview = body.querySelector("#pfUrlPreview");
      if (phInput && preview) {
        const upd = function () {
          const v = phInput.value.trim();
          preview.textContent = ctx.t("prov.baseUrlPreview") + ": " + pr.baseUrl.replace("{" + phKey + "}", v || ("{" + phKey + "}"));
        };
        phInput.addEventListener("input", upd);
        upd();
      }

      const picker = draftModelsPicker(body, {
        getParams: function () {
          const key = body.querySelector("#pfKey").value;
          if (!key) throw new Error(ctx.t("prov.keyRequired"));
          const p = { kind: "preset", preset: pr.id, key: key };
          if (needsPlaceholder) {
            const phVal = phInput.value.trim();
            if (!phVal) throw new Error(ctx.t("prov.accountIdRequired"));
            p.baseUrl = pr.baseUrl.replace("{" + phKey + "}", phVal);
          }
          return p;
        },
      });

      body.querySelector("#pfSave").addEventListener("click", async function () {
        const label = body.querySelector("#pfLabel").value.trim() || pr.label;
        const key = body.querySelector("#pfKey").value;
        const errEl = body.querySelector("#pfKeyErr");
        const srvErrEl = body.querySelector("#pfErr");
        srvErrEl.hidden = true;
        if (!key) {
          errEl.textContent = ctx.t("prov.keyRequired");
          errEl.hidden = false;
          return;
        }
        errEl.hidden = true;
        const btn = body.querySelector("#pfSave");
        btn.disabled = true;
        try {
          const payload = { kind: "preset", preset: pr.id, label: label, key: key };
          if (needsPlaceholder) {
            const phVal = phInput.value.trim();
            if (!phVal) {
              errEl.textContent = ctx.t("prov.accountId");
              errEl.hidden = false;
              btn.disabled = false;
              return;
            }
            payload.baseUrl = pr.baseUrl.replace("{" + phKey + "}", phVal);
          }
          // Mismatch guard on the final URL (type is locked to this preset).
          const mm = mismatchFor(payload.baseUrl || pr.baseUrl, entryType(pr));
          if (mm) {
            srvErrEl.textContent = mm.message;
            srvErrEl.hidden = false;
            btn.disabled = false;
            return;
          }
          const r = await ctx.api("providers.add", payload);
          ctx.toast(ctx.t("prov.justAdded") + (r.autoSelected ? "\n" + ctx.t("prov.autoActive") : ""), "ok");
          // Guided flow: discover → test → prominent Set active, all inline.
          await finishAddFlow(body, r.id, { picker: picker, autoSelected: r.autoSelected });
        } catch (e) {
          showServerError(srvErrEl, e);
          btn.disabled = false;
        }
      });
    }

    // Add form for a native adapter template (gemini / anthropic): the type
    // is locked to the template, the base URL is prefilled and editable,
    // and the save payload carries the adapter type explicitly.
    function templateForm(body, tp) {
      st.view.sub = "preset:" + tp.id;
      const type = entryType(tp);
      body.innerHTML =
        '<div class="card">' +
        '<div style="font-weight:700;margin-bottom:6px">' + ctx.esc(tp.label) + "</div>" +
        '<div style="margin-bottom:10px"><span class="badge badge-info prov-badge" dir="ltr">' +
        ctx.esc(adapterLabelFor(type) + " · " + type) + "</span></div>" +
        '<div class="hint-text" style="margin-bottom:10px">' + ctx.esc(ctx.t("prov.templateFormNote")) + "</div>" +
        (tp.note ? '<div class="list-sub" style="white-space:normal;margin-bottom:10px">' + ctx.esc(tp.note) + "</div>" : "") +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
        '<input id="tfLabel" type="text" value="' + ctx.esc(tp.label) + '" dir="auto"></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.url")) + "</label>" +
        '<input id="tfUrl" type="url" value="' + ctx.esc(tp.baseUrl || "") + '" dir="ltr">' +
        '<div class="error" id="tfUrlErr" hidden></div></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.key")) + "</label>" +
        '<input id="tfKey" type="password" autocomplete="new-password" placeholder="' + ctx.esc(ctx.t("prov.keyPlaceholder")) + '" dir="ltr">' +
        '<div class="error" id="tfKeyErr" hidden></div></div>' +
        '<div class="error" id="tfErr" hidden style="margin-bottom:10px"></div>' +
        '<button type="button" class="btn btn-primary btn-block" id="tfSave">' + ctx.esc(ctx.t("action.save")) + "</button>" +
        "</div>";
      const urlInput = body.querySelector("#tfUrl");
      const urlErr = body.querySelector("#tfUrlErr");
      function checkMismatch() {
        const mm = mismatchFor(urlInput.value, type);
        if (mm) {
          urlErr.textContent = mm.message;
          urlErr.hidden = false;
          return mm;
        }
        urlErr.hidden = true;
        return null;
      }
      urlInput.addEventListener("input", checkMismatch);
      body.querySelector("#tfSave").addEventListener("click", async function () {
        const label = body.querySelector("#tfLabel").value.trim() || tp.label;
        const url = urlInput.value.trim();
        const key = body.querySelector("#tfKey").value;
        const keyErr = body.querySelector("#tfKeyErr");
        const srvErrEl = body.querySelector("#tfErr");
        srvErrEl.hidden = true;
        if (!urlOk(url)) {
          urlErr.textContent = ctx.t("prov.urlInvalid");
          urlErr.hidden = false;
          return;
        }
        if (checkMismatch()) return;
        if (!key) {
          keyErr.textContent = ctx.t("prov.keyRequired");
          keyErr.hidden = false;
          return;
        }
        keyErr.hidden = true;
        const btn = body.querySelector("#tfSave");
        btn.disabled = true;
        try {
          const r = await ctx.api("providers.add", {
            kind: "template", template: type, adapter: type, type: type,
            label: label, baseUrl: url, key: key,
            suggestedModel: tp.suggestedModel || undefined,
          });
          ctx.toast(ctx.t("prov.justAdded") + (r.autoSelected ? "\n" + ctx.t("prov.autoActive") : ""), "ok");
          await finishAddFlow(body, r.id, { autoSelected: r.autoSelected });
        } catch (e) {
          showServerError(srvErrEl, e);
          btn.disabled = false;
        }
      });
    }

    function customForm(body) {
      body.innerHTML =
        '<div class="card">' +
        '<div style="font-weight:700;margin-bottom:6px">' + ctx.esc(ctx.t("prov.customEndpoint")) + "</div>" +
        '<div class="note note-info" style="margin:0 0 12px">' + ctx.icon("info") + "<span>" + ctx.esc(ctx.t("prov.customTypeNote")) + "</span></div>" +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
        '<input id="cfLabel" type="text" dir="auto" placeholder="My Provider"></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.url")) + "</label>" +
        '<input id="cfUrl" type="url" dir="ltr" placeholder="https://api.example.com/v1">' +
        '<div class="hint-text">' + ctx.esc(ctx.t("prov.customUrlHint")) + "</div>" +
        '<div class="error" id="cfUrlErr" hidden></div></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.key")) + "</label>" +
        '<input id="cfKey" type="password" autocomplete="new-password" dir="ltr">' +
        '<div class="hint-text">' + ctx.esc(ctx.t("prov.customKeyHint")) + "</div></div>" +
        '<div class="error" id="cfErr" hidden style="margin-bottom:10px"></div>' +
        '<button type="button" class="btn btn-primary btn-block" id="cfSave">' + ctx.esc(ctx.t("action.save")) + "</button>" +
        "</div>";
      const urlInput = body.querySelector("#cfUrl");
      const errEl = body.querySelector("#cfUrlErr");
      const srvErrEl = body.querySelector("#cfErr");
      // L3: no localStorage replay of the last custom URL — a wrong URL
      // entered once must not silently prefill the next add.
      function checkCustom() {
        const v = urlInput.value.trim();
        if (v && !urlOk(v)) { errEl.textContent = ctx.t("prov.urlInvalid"); errEl.hidden = false; return true; }
        const mm = mismatchFor(v, "openai_compatible");
        if (mm) { errEl.textContent = mm.message; errEl.hidden = false; return true; }
        errEl.hidden = true;
        return false;
      }
      urlInput.addEventListener("input", checkCustom);
      const picker = draftModelsPicker(body, {
        getParams: function () {
          const url = urlInput.value.trim();
          if (!urlOk(url)) throw new Error(ctx.t("prov.urlInvalid"));
          const mm = mismatchFor(url, "openai_compatible");
          if (mm) throw new Error(mm.message);
          const key = body.querySelector("#cfKey").value;
          if (!key) throw new Error(ctx.t("prov.keyRequired"));
          return { kind: "custom", baseUrl: url, key: key };
        },
      });
      body.querySelector("#cfSave").addEventListener("click", async function () {
        const label = body.querySelector("#cfLabel").value.trim();
        const url = urlInput.value.trim();
        const key = body.querySelector("#cfKey").value;
        srvErrEl.hidden = true;
        if (checkCustom()) return;
        errEl.hidden = true;
        const btn = body.querySelector("#cfSave");
        btn.disabled = true;
        try {
          const r = await ctx.api("providers.add", {
            kind: "custom", label: label || url, baseUrl: url,
            key: key || undefined,
          });
          ctx.toast(ctx.t("prov.justAdded") + (r.autoSelected ? "\n" + ctx.t("prov.autoActive") : ""), "ok");
          await finishAddFlow(body, r.id, { picker: picker, autoSelected: r.autoSelected });
        } catch (e) {
          showServerError(srvErrEl, e);
          btn.disabled = false;
        }
      });
    }

    function nineForm(body) {
      body.innerHTML =
        '<div class="card">' +
        '<div class="list-sub" style="white-space:normal;margin-bottom:10px"><div class="note note-info" style="margin:0">' +
        ctx.icon("info") + "<span>" + ctx.esc(ctx.t("prov.nineGuide")) + "</span></div></div>" +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
        '<input id="nfLabel" type="text" value="9Router" dir="auto"></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.url")) + "</label>" +
        '<input id="nfUrl" type="url" dir="ltr" placeholder="https://…">' +
        '<div class="hint-text">' + ctx.esc(ctx.t("prov.nineUrlHint")) + "</div>" +
        '<div class="error" id="nfUrlErr" hidden></div></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.key")) + "</label>" +
        '<input id="nfKey" type="password" autocomplete="new-password" dir="ltr">' +
        '<div class="hint-text">' + ctx.esc(ctx.t("prov.nineKeyHint")) + "</div>" +
        '<div class="error" id="nfKeyErr" hidden></div></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.modelId")) + "</label>" +
        '<input id="nfModel" type="text" dir="ltr" placeholder="model-name">' +
        '<div class="hint-text">' + ctx.esc(ctx.t("prov.nineModelHint")) + "</div>" +
        '<div class="error" id="nfModelErr" hidden></div></div>' +
        '<div class="error" id="nfErr" hidden style="margin-bottom:10px"></div>' +
        '<button type="button" class="btn btn-primary btn-block" id="nfSave">' + ctx.esc(ctx.t("action.save")) + "</button>" +
        "</div>";
      const urlInput = body.querySelector("#nfUrl");
      const errEl = body.querySelector("#nfUrlErr");
      try {
        const remembered = window.localStorage.getItem("bobi_nine_url");
        if (remembered && !urlInput.value) urlInput.value = remembered;
      } catch (e) { /* storage unavailable */ }
      urlInput.addEventListener("input", function () {
        const v = urlInput.value.trim();
        if (v && !urlOk(v)) { errEl.textContent = ctx.t("prov.urlInvalid"); errEl.hidden = false; }
        else errEl.hidden = true;
      });
      body.querySelector("#nfSave").addEventListener("click", async function () {
        const label = body.querySelector("#nfLabel").value.trim() || "9Router";
        const url = urlInput.value.trim();
        const key = body.querySelector("#nfKey").value;
        const modelId = body.querySelector("#nfModel").value.trim();
        const keyErr = body.querySelector("#nfKeyErr");
        const modelErr = body.querySelector("#nfModelErr");
        if (!urlOk(url)) { errEl.textContent = ctx.t("prov.urlInvalid"); errEl.hidden = false; return; }
        errEl.hidden = true;
        // The backend rejects 9Router providers without a key or a model —
        // surface it inline instead of a bare toast.
        if (!key) { keyErr.textContent = ctx.t("prov.nineKeyRequired"); keyErr.hidden = false; return; }
        keyErr.hidden = true;
        if (!modelId) { modelErr.textContent = ctx.t("prov.nineModelRequired"); modelErr.hidden = false; return; }
        modelErr.hidden = true;
        const btn = body.querySelector("#nfSave");
        btn.disabled = true;
        const srvErrEl = body.querySelector("#nfErr");
        srvErrEl.hidden = true;
        try {
          try { window.localStorage.setItem("bobi_nine_url", url); } catch (e) { /* ignore */ }
          const r = await ctx.api("providers.add", {
            kind: "nine_router", label: label, baseUrl: url, key: key, model: modelId,
          });
          ctx.toast(ctx.t("prov.justAdded") + (r.autoSelected ? "\n" + ctx.t("prov.autoActive") : ""), "ok");
          await finishAddFlow(body, r.id, { autoSelected: r.autoSelected, skipDiscover: true });
        } catch (e) {
          showServerError(srvErrEl, e);
          btn.disabled = false;
        }
      });
    }

    paint();
  }

  window.App.registerSection("providers", {
    titleKey: "sec.providers",
    icon: "plug",
    render: render,
  });
})();
