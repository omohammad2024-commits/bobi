/* BOBI Mini App — Providers section.
 * List → detail (toggle, probe, edit, key management, delete) → models
 * (discover, import, manual add, toggle/delete/set-active). Add flow with
 * three tabs: preset grid (8 presets, label+key only), custom
 * OpenAI-compatible form (inline URL validation), 9Router guided form.
 *
 * Backend endpoints used (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   providers.list, providers.get, providers.add, providers.update,
 *   providers.setKey, providers.clearKey, providers.toggle, providers.probe,
 *   providers.delete, models.discover, models.add, models.update,
 *   models.delete, models.setActive
 */
(function () {
  "use strict";

  // The 8 shipped presets, mirrored from src/ai/adapter.ts PROVIDER_PRESETS.
  // baseUrl is pre-filled; the owner only enters label + key.
  const PRESETS = [
    { id: "cloudflare", label: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1", suggestedModel: "@cf/meta/llama-3.1-8b-instruct" },
    { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", suggestedModel: "anthropic/claude-haiku-5.5" },
    { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", suggestedModel: "deepseek-chat" },
    { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", suggestedModel: "llama-3.3-70b-versatile" },
    { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", suggestedModel: "mistral-large-latest" },
    { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", suggestedModel: "grok-4" },
    { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1", suggestedModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    { id: "opencode", label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", suggestedModel: "nemotron-3-lightning-free" },
  ];

  function urlOk(u) {
    return /^https?:\/\/[^\/\s]+\S*$/i.test(String(u || "").trim());
  }

  function render(el, ctx) {
    const st = ctx.state;
    if (!st.view) st.view = { name: "list" };
    paint();

    function paint() {
      const v = st.view;
      el.innerHTML = "";
      if (v.name === "list") return viewList();
      if (v.name === "detail") return viewDetail(v.id);
      if (v.name === "models") return viewModels(v.id);
      if (v.name === "add") return viewAdd();
      return viewList();
    }

    function setView(v) {
      st.view = v;
      paint();
    }

    function skeleton(n) {
      let h = "";
      for (let i = 0; i < (n || 4); i++) h += '<div class="skeleton"></div>';
      return h;
    }

    function subHeader(title) {
      const wrap = document.createElement("div");
      wrap.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">' +
        '<button type="button" class="btn btn-ghost" id="backBtn">‹ ' + ctx.esc(ctx.t("nav.back")) + "</button>" +
        '<h2 style="margin:0;font-size:17px;flex:1">' + ctx.esc(title) + "</h2></div>";
      el.appendChild(wrap);
      wrap.querySelector("#backBtn").addEventListener("click", function () {
        back();
      });
    }

    function back() {
      const v = st.view;
      if (v.name === "models") setView({ name: "detail", id: v.id });
      else if (v.name === "detail" || v.name === "add") setView({ name: "list" });
      else setView({ name: "list" });
    }

    function statusDot(status) {
      const cls = status === "ok" ? "ok" : status === "error" ? "err" : "unknown";
      return '<span class="dot ' + cls + '"></span>';
    }

    function statusText(p) {
      if (p.status === "ok") return ctx.t("prov.statusOk");
      if (p.status === "error") return ctx.t("prov.statusErr");
      return ctx.t("prov.statusUnknown");
    }

    // ---------------- list ----------------
    async function viewList() {
      el.innerHTML = skeleton(4);
      let providers = [];
      try {
        const res = await ctx.api("providers.list", {});
        providers = (res && res.providers) || [];
      } catch (e) {
        el.innerHTML =
          '<div class="error-state"><p>⚠️ ' + ctx.esc(e.message || e.code || ctx.t("state.error")) + "</p>" +
          '<button type="button" class="btn btn-primary" id="retryList">' + ctx.esc(ctx.t("action.retry")) + "</button></div>";
        document.getElementById("retryList").addEventListener("click", paint);
        return;
      }
      el.innerHTML = "";
      if (!providers.length) {
        const d = document.createElement("div");
        d.className = "empty-state";
        d.innerHTML = "<p>🔌</p><p>" + ctx.esc(ctx.t("state.empty")) + "</p>";
        el.appendChild(d);
      } else {
        for (const p of providers) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "list-row";
          const keyBadge = p.hasKey
            ? '<span class="badge key">••••</span>'
            : '<span class="badge nokey">' + ctx.esc(ctx.t("prov.noKey")) + "</span>";
          b.innerHTML =
            statusDot(p.status) +
            '<div class="list-main"><div class="list-title">' +
            ctx.esc(p.label || p.id) +
            keyBadge +
            "</div>" +
            '<div class="list-sub">' +
            ctx.esc(p.adapter || "") +
            " · " +
            (p.enabled ? ctx.esc(ctx.t("prov.enabled")) : ctx.esc(ctx.t("prov.disabled"))) +
            " · " +
            ctx.esc(statusText(p)) +
            " · " +
            (p.modelCount || 0) +
            "</div></div>" +
            '<span class="chev"></span>';
          (function (id) {
            b.addEventListener("click", function () {
              setView({ name: "detail", id: id });
            });
          })(p.id);
          el.appendChild(b);
        }
      }
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn btn-primary btn-block";
      add.textContent = "＋ " + ctx.t("prov.add");
      add.addEventListener("click", function () {
        setView({ name: "add" });
      });
      el.appendChild(add);
    }

    // ---------------- detail ----------------
    async function viewDetail(id) {
      el.innerHTML = skeleton(3);
      let data = null;
      try {
        data = await ctx.api("providers.get", { id: id });
      } catch (e) {
        el.innerHTML =
          '<div class="error-state"><p>⚠️ ' + ctx.esc(e.message || e.code || ctx.t("state.error")) + "</p>" +
          '<button type="button" class="btn btn-primary" id="retryD">' + ctx.esc(ctx.t("action.retry")) + "</button></div>";
        document.getElementById("retryD").addEventListener("click", paint);
        return;
      }
      const p = data.provider || {};
      el.innerHTML = "";
      subHeader(p.label || p.id);

      // Summary card
      const card = document.createElement("div");
      card.className = "card";
      const probe = p.lastProbe
        ? ctx.t("prov.lastProbe") +
          ": " +
          (p.lastProbe.ok ? "✓" : "✗") +
          " " +
          (p.lastProbe.ms || 0) +
          " " +
          ctx.t("prov.ms")
        : ctx.t("prov.statusUnknown");
      card.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        statusDot(p.status) +
        "<strong>" + ctx.esc(p.adapter || "") + "</strong>" +
        (p.hasKey ? '<span class="badge key">••••</span>' : '<span class="badge nokey">' + ctx.esc(ctx.t("prov.noKey")) + "</span>") +
        "</div>" +
        '<div class="list-sub">' + ctx.esc(probe) + "</div>" +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px">' +
        "<span>" + ctx.esc(ctx.t(p.enabled ? "prov.enabled" : "prov.disabled")) + "</span>" +
        '<button type="button" class="toggle" id="enabledToggle" role="switch" aria-checked="' + (p.enabled ? "true" : "false") + '"></button>' +
        "</div>";
      el.appendChild(card);

      // Probe
      const probeRow = document.createElement("div");
      probeRow.innerHTML =
        '<button type="button" class="btn btn-ghost btn-block" id="probeBtn">⚡ ' + ctx.esc(ctx.t("action.probe")) + "</button>" +
        '<div class="list-sub" id="probeResult" style="text-align:center;margin-top:6px"></div>';
      el.appendChild(probeRow);
      probeRow.querySelector("#probeBtn").addEventListener("click", async function () {
        const btn = probeRow.querySelector("#probeBtn");
        const out = probeRow.querySelector("#probeResult");
        btn.disabled = true;
        out.textContent = "…";
        try {
          const r = await ctx.api("providers.probe", { id: id });
          out.textContent =
            (r.ok ? ctx.t("prov.probeOk") : ctx.t("prov.probeFail")) +
            (r.ms !== undefined ? " · " + r.ms + " " + ctx.t("prov.ms") : "") +
            (r.message ? " · " + r.message : "");
        } catch (e2) {
          out.textContent = ctx.t("prov.probeFail") + " · " + (e2.message || e2.code || "");
        }
        btn.disabled = false;
        // Refresh status in background
        paint();
      });

      // Enable toggle
      card.querySelector("#enabledToggle").addEventListener("click", async function () {
        const next = !p.enabled;
        try {
          await ctx.api("providers.toggle", { id: id, enabled: next });
          ctx.toast(ctx.t("toast.saved"));
          paint();
        } catch (e) {
          ctx.toast(ctx.t("toast.failed"));
        }
      });

      // Edit label + URL
      const edit = document.createElement("div");
      edit.className = "card";
      edit.innerHTML =
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
        '<input id="editLabel" type="text" value="' + ctx.esc(p.label || "") + '" dir="auto"></div>' +
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.url")) + "</label>" +
        '<input id="editUrl" type="url" value="' + ctx.esc(p.baseUrl || "") + '" dir="ltr">' +
        '<div class="error" id="editUrlErr" hidden></div></div>' +
        '<button type="button" class="btn btn-primary btn-block" id="saveEdit">' + ctx.esc(ctx.t("action.save")) + "</button>";
      el.appendChild(edit);
      edit.querySelector("#saveEdit").addEventListener("click", async function () {
        const label = edit.querySelector("#editLabel").value.trim();
        const url = edit.querySelector("#editUrl").value.trim();
        const errEl = edit.querySelector("#editUrlErr");
        if (url && !urlOk(url)) {
          errEl.textContent = ctx.t("prov.urlInvalid");
          errEl.hidden = false;
          return;
        }
        errEl.hidden = true;
        try {
          await ctx.api("providers.update", { id: id, label: label, baseUrl: url });
          ctx.toast(ctx.t("toast.saved"));
          paint();
        } catch (e) {
          ctx.toast(ctx.t("toast.failed"));
        }
      });

      // Key management
      const keyCard = document.createElement("div");
      keyCard.className = "card";
      keyCard.innerHTML =
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.key")) + "</label>" +
        '<input id="keyInput" type="password" autocomplete="new-password" placeholder="' +
        ctx.esc(ctx.t("prov.keyPlaceholder")) + '" dir="ltr"></div>' +
        '<div class="btn-row">' +
        '<button type="button" class="btn btn-primary" id="saveKey">' +
        ctx.esc(ctx.t(p.hasKey ? "prov.replaceKey" : "prov.setKey")) + "</button>" +
        (p.hasKey
          ? '<button type="button" class="btn btn-ghost" id="clearKey">' + ctx.esc(ctx.t("prov.clearKey")) + "</button>"
          : "") +
        "</div>";
      el.appendChild(keyCard);
      keyCard.querySelector("#saveKey").addEventListener("click", async function () {
        const key = keyCard.querySelector("#keyInput").value;
        if (!key) return;
        try {
          await ctx.api("providers.setKey", { id: id, key: key });
          keyCard.querySelector("#keyInput").value = "";
          ctx.toast(ctx.t("toast.saved"));
          paint();
        } catch (e) {
          ctx.toast(ctx.t("toast.failed"));
        }
      });
      const clearBtn = keyCard.querySelector("#clearKey");
      if (clearBtn) {
        clearBtn.addEventListener("click", async function () {
          const ok = await ctx.confirmDialog(ctx.t("dialog.confirmTitle"), ctx.t("prov.clearKeyConfirm"));
          if (!ok) return;
          try {
            await ctx.api("providers.clearKey", { id: id });
            ctx.toast(ctx.t("toast.deleted"));
            paint();
          } catch (e) {
            ctx.toast(ctx.t("toast.failed"));
          }
        });
      }

      // Models + delete
      const actions = document.createElement("div");
      actions.innerHTML =
        '<button type="button" class="btn btn-ghost btn-block" id="modelsBtn">🧠 ' + ctx.esc(ctx.t("prov.models")) + "</button>" +
        '<button type="button" class="btn btn-danger btn-block" id="delBtn">' + ctx.esc(ctx.t("action.delete")) + "</button>";
      el.appendChild(actions);
      actions.querySelector("#modelsBtn").addEventListener("click", function () {
        setView({ name: "models", id: id });
      });
      actions.querySelector("#delBtn").addEventListener("click", async function () {
        const ok = await ctx.confirmDialog(ctx.t("dialog.confirmTitle"), ctx.t("prov.deleteConfirm"));
        if (!ok) return;
        try {
          await ctx.api("providers.delete", { id: id });
          ctx.toast(ctx.t("toast.deleted"));
          setView({ name: "list" });
        } catch (e) {
          ctx.toast(ctx.t("toast.failed"));
        }
      });
    }

    // ---------------- models ----------------
    async function viewModels(id) {
      el.innerHTML = skeleton(4);
      let data = null;
      try {
        data = await ctx.api("providers.get", { id: id });
      } catch (e) {
        el.innerHTML =
          '<div class="error-state"><p>⚠️ ' + ctx.esc(e.message || e.code || ctx.t("state.error")) + "</p>" +
          '<button type="button" class="btn btn-primary" id="retryM">' + ctx.esc(ctx.t("action.retry")) + "</button></div>";
        document.getElementById("retryM").addEventListener("click", paint);
        return;
      }
      const p = data.provider || {};
      const models = data.models || [];
      el.innerHTML = "";
      subHeader((p.label || p.id) + " · " + ctx.t("prov.models"));

      // Discover
      const disc = document.createElement("div");
      disc.className = "card";
      disc.innerHTML =
        '<button type="button" class="btn btn-ghost btn-block" id="discBtn">🔍 ' + ctx.esc(ctx.t("prov.discover")) + "</button>" +
        '<div id="discList"></div>';
      el.appendChild(disc);
      disc.querySelector("#discBtn").addEventListener("click", async function () {
        const btn = disc.querySelector("#discBtn");
        const list = disc.querySelector("#discList");
        btn.disabled = true;
        btn.textContent = ctx.t("prov.discovering");
        let found = [];
        try {
          const r = await ctx.api("models.discover", { providerId: id });
          found = r.models || [];
        } catch (e) {
          ctx.toast(ctx.t("toast.failed"));
          btn.disabled = false;
          btn.textContent = "🔍 " + ctx.t("prov.discover");
          return;
        }
        const existing = {};
        for (const m of models) existing[m.id] = true;
        const fresh = found.filter(function (m) { return !existing[m]; });
        if (!fresh.length) {
          list.innerHTML = '<div class="list-sub" style="margin-top:8px">' + ctx.esc(ctx.t("state.empty")) + "</div>";
          btn.disabled = false;
          btn.textContent = "🔍 " + ctx.t("prov.discover");
          return;
        }
        let h = '<div style="margin-top:10px">';
        for (let i = 0; i < fresh.length; i++) {
          h +=
            '<label class="checkbox-row"><input type="checkbox" data-i="' + i + '" checked>' +
            '<span class="mono" dir="ltr">' + ctx.esc(fresh[i]) + "</span></label>";
        }
        h +=
          '</div><button type="button" class="btn btn-primary btn-block" id="importBtn">' +
          ctx.esc(ctx.t("prov.importSelected")) + "</button>";
        list.innerHTML = h;
        list.querySelector("#importBtn").addEventListener("click", async function () {
          const boxes = list.querySelectorAll('input[type="checkbox"]');
          const sel = [];
          for (const b of boxes) if (b.checked) sel.push(fresh[parseInt(b.dataset.i, 10)]);
          try {
            for (const mid of sel) await ctx.api("models.add", { providerId: id, id: mid });
            ctx.toast(ctx.t("toast.saved"));
          } catch (e) {
            ctx.toast(ctx.t("toast.failed"));
          }
          paint();
        });
        btn.disabled = false;
        btn.textContent = "🔍 " + ctx.t("prov.discover");
      });

      // Manual add
      const manual = document.createElement("div");
      manual.className = "card";
      manual.innerHTML =
        '<div class="field"><label>' + ctx.esc(ctx.t("prov.manualAdd")) + "</label>" +
        '<input id="manualId" type="text" dir="ltr" placeholder="model-id"></div>' +
        '<button type="button" class="btn btn-ghost btn-block" id="manualAddBtn">' + ctx.esc(ctx.t("action.add")) + "</button>";
      el.appendChild(manual);
      manual.querySelector("#manualAddBtn").addEventListener("click", async function () {
        const mid = manual.querySelector("#manualId").value.trim();
        if (!mid) return;
        try {
          await ctx.api("models.add", { providerId: id, id: mid });
          ctx.toast(ctx.t("toast.saved"));
          paint();
        } catch (e) {
          ctx.toast(ctx.t("toast.failed"));
        }
      });

      // Model list
      if (!models.length) {
        const d = document.createElement("div");
        d.className = "empty-state";
        d.innerHTML = "<p>" + ctx.esc(ctx.t("prov.noModels")) + "</p>";
        el.appendChild(d);
      } else {
        for (const m of models) {
          const row = document.createElement("div");
          row.className = "card";
          row.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px">' +
            '<div class="list-main"><div class="list-title mono" dir="ltr">' + ctx.esc(m.id) + "</div>" +
            (m.active ? '<div class="list-sub">⭐ ' + ctx.esc(ctx.t("prov.active")) + "</div>" : "") +
            "</div>" +
            '<button type="button" class="toggle" role="switch" aria-checked="' + (m.enabled ? "true" : "false") + '" aria-label="' + ctx.esc(ctx.t("prov.enabled")) + '"></button>' +
            "</div>" +
            '<div class="btn-row" style="margin-top:8px">' +
            (m.active ? "" : '<button type="button" class="btn btn-ghost act-active">' + ctx.esc(ctx.t("prov.setActive")) + "</button>") +
            '<button type="button" class="btn btn-ghost act-del">' + ctx.esc(ctx.t("action.delete")) + "</button>" +
            "</div>";
          row.querySelector(".toggle").addEventListener("click", async function () {
            try {
              await ctx.api("models.update", { providerId: id, id: m.id, enabled: !m.enabled });
              paint();
            } catch (e) {
              ctx.toast(ctx.t("toast.failed"));
            }
          });
          const actBtn = row.querySelector(".act-active");
          if (actBtn) {
            actBtn.addEventListener("click", async function () {
              try {
                await ctx.api("models.setActive", { providerId: id, id: m.id });
                ctx.toast(ctx.t("toast.saved"));
                paint();
              } catch (e) {
                ctx.toast(ctx.t("toast.failed"));
              }
            });
          }
          row.querySelector(".act-del").addEventListener("click", async function () {
            const ok = await ctx.confirmDialog(ctx.t("dialog.confirmTitle"), ctx.t("prov.deleteModelConfirm"));
            if (!ok) return;
            try {
              await ctx.api("models.delete", { providerId: id, id: m.id });
              ctx.toast(ctx.t("toast.deleted"));
              paint();
            } catch (e) {
              ctx.toast(ctx.t("toast.failed"));
            }
          });
          el.appendChild(row);
        }
      }
    }

    // ---------------- add ----------------
    function viewAdd() {
      el.innerHTML = "";
      subHeader(ctx.t("prov.addProviderTitle"));

      const tabs = document.createElement("div");
      tabs.className = "sub-tabs";
      tabs.innerHTML =
        '<button type="button" class="sub-tab active" data-tab="preset">' + ctx.esc(ctx.t("prov.tabPreset")) + "</button>" +
        '<button type="button" class="sub-tab" data-tab="custom">' + ctx.esc(ctx.t("prov.tabCustom")) + "</button>" +
        '<button type="button" class="sub-tab" data-tab="nine">' + ctx.esc(ctx.t("prov.tabNine")) + "</button>";
      el.appendChild(tabs);
      const body = document.createElement("div");
      el.appendChild(body);

      const tabBtns = tabs.querySelectorAll(".sub-tab");
      for (const b of tabBtns) {
        b.addEventListener("click", function () {
          for (const x of tabBtns) x.classList.remove("active");
          b.classList.add("active");
          if (b.dataset.tab === "preset") return tabPreset();
          if (b.dataset.tab === "custom") return tabCustom();
          return tabNine();
        });
      }

      function submitAdd(payload, done) {
        ctx.api("providers.add", payload)
          .then(function () {
            ctx.toast(ctx.t("toast.saved"));
            if (done) done();
            setView({ name: "list" });
          })
          .catch(function (e) {
            ctx.toast((e && e.message) || ctx.t("toast.failed"));
          });
      }

      // --- preset tab ---
      function tabPreset() {
        let h = '<p class="list-sub" style="margin:0 0 10px">' + ctx.esc(ctx.t("prov.presetNote")) + "</p>";
        h += '<div class="preset-grid">';
        for (const pr of PRESETS) {
          h +=
            '<button type="button" class="preset-card" data-pid="' + ctx.esc(pr.id) + '">' +
            '<div class="preset-name">' + ctx.esc(pr.label) + "</div>" +
            '<div class="preset-sub mono" dir="ltr">' + ctx.esc(pr.suggestedModel || "") + "</div></div>";
        }
        h += "</div>";
        body.innerHTML = h;
        const cards = body.querySelectorAll(".preset-card");
        for (const c of cards) {
          c.addEventListener("click", function () {
            const pr = PRESETS.find(function (x) { return x.id === c.dataset.pid; });
            if (pr) presetForm(pr);
          });
        }
      }

      function presetForm(pr) {
        body.innerHTML =
          '<div class="card">' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
          '<input id="pfLabel" type="text" value="' + ctx.esc(pr.label) + '" dir="auto"></div>' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.key")) + "</label>" +
          '<input id="pfKey" type="password" autocomplete="new-password" placeholder="' + ctx.esc(ctx.t("prov.keyPlaceholder")) + '" dir="ltr"></div>' +
          '<div class="list-sub mono" dir="ltr" style="margin-bottom:8px">' + ctx.esc(pr.baseUrl) + "</div>" +
          '<button type="button" class="btn btn-primary btn-block" id="pfSave">' + ctx.esc(ctx.t("action.save")) + "</button>" +
          "</div>";
        body.querySelector("#pfSave").addEventListener("click", function () {
          const label = body.querySelector("#pfLabel").value.trim() || pr.label;
          const key = body.querySelector("#pfKey").value;
          if (!key) {
            ctx.toast(ctx.t("prov.key"));
            return;
          }
          submitAdd({
            kind: "preset",
            presetId: pr.id,
            adapter: "openai_compatible",
            label: label,
            baseUrl: pr.baseUrl,
            key: key,
            modelId: pr.suggestedModel,
          });
        });
      }

      // --- custom tab ---
      function tabCustom() {
        body.innerHTML =
          '<div class="card">' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
          '<input id="cfLabel" type="text" dir="auto"></div>' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.url")) + "</label>" +
          '<input id="cfUrl" type="url" dir="ltr" placeholder="https://…">' +
          '<div class="error" id="cfUrlErr" hidden></div></div>' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.key")) + "</label>" +
          '<input id="cfKey" type="password" autocomplete="new-password" dir="ltr"></div>' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.modelId")) + ' <span class="badge">' + ctx.esc(ctx.t("prov.optional")) + "</span></label>" +
          '<input id="cfModel" type="text" dir="ltr" placeholder="gpt-4o-mini"></div>' +
          '<button type="button" class="btn btn-primary btn-block" id="cfSave">' + ctx.esc(ctx.t("action.save")) + "</button>" +
          "</div>";
        const urlInput = body.querySelector("#cfUrl");
        const errEl = body.querySelector("#cfUrlErr");
        urlInput.addEventListener("input", function () {
          const v = urlInput.value.trim();
          if (v && !urlOk(v)) {
            errEl.textContent = ctx.t("prov.urlInvalid");
            errEl.hidden = false;
          } else {
            errEl.hidden = true;
          }
        });
        body.querySelector("#cfSave").addEventListener("click", function () {
          const label = body.querySelector("#cfLabel").value.trim();
          const url = urlInput.value.trim();
          const key = body.querySelector("#cfKey").value;
          const modelId = body.querySelector("#cfModel").value.trim();
          if (!urlOk(url)) {
            errEl.textContent = ctx.t("prov.urlInvalid");
            errEl.hidden = false;
            return;
          }
          submitAdd({
            kind: "custom",
            adapter: "openai_compatible",
            label: label || url,
            baseUrl: url,
            key: key,
            modelId: modelId || undefined,
          });
        });
      }

      // --- 9Router tab ---
      function tabNine() {
        body.innerHTML =
          '<div class="card">' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.label")) + "</label>" +
          '<input id="nfLabel" type="text" value="9Router" dir="auto"></div>' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.url")) + "</label>" +
          '<input id="nfUrl" type="url" dir="ltr" placeholder="https://…">' +
          '<div class="error" id="nfUrlErr" hidden></div></div>' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.key")) + "</label>" +
          '<input id="nfKey" type="password" autocomplete="new-password" dir="ltr"></div>' +
          '<div class="field"><label>' + ctx.esc(ctx.t("prov.modelId")) + "</label>" +
          '<input id="nfModel" type="text" dir="ltr"></div>' +
          '<button type="button" class="btn btn-primary btn-block" id="nfSave">' + ctx.esc(ctx.t("action.save")) + "</button>" +
          "</div>";
        const urlInput = body.querySelector("#nfUrl");
        const errEl = body.querySelector("#nfUrlErr");
        urlInput.addEventListener("input", function () {
          const v = urlInput.value.trim();
          if (v && !urlOk(v)) {
            errEl.textContent = ctx.t("prov.urlInvalid");
            errEl.hidden = false;
          } else {
            errEl.hidden = true;
          }
        });
        body.querySelector("#nfSave").addEventListener("click", function () {
          const label = body.querySelector("#nfLabel").value.trim() || "9Router";
          const url = urlInput.value.trim();
          const key = body.querySelector("#nfKey").value;
          const modelId = body.querySelector("#nfModel").value.trim();
          if (!urlOk(url)) {
            errEl.textContent = ctx.t("prov.urlInvalid");
            errEl.hidden = false;
            return;
          }
          submitAdd({
            kind: "ninerouter",
            adapter: "nine_router",
            label: label,
            baseUrl: url,
            key: key,
            modelId: modelId || undefined,
          });
        });
      }

      tabPreset();
    }

    paint();
  }

  window.App.registerSection("providers", {
    titleKey: "sec.providers",
    icon: "🔌",
    render: render,
  });
})();
