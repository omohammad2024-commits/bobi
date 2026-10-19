/* BOBI Mini App · section: usage
 * Owner-only: usage.report with 7/30-day period selector — stat cards
 * plus a per-model breakdown table. ctx.api only.
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   usage.report { days? } -> { ok, days, runs, inputTokens, outputTokens,
 *                   estimatedUsd, byModel: [{ modelId, runs, inputTokens,
 *                   outputTokens, estimatedUsd }] }
 *   (the backend has NO daily breakdown — don't render one)
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "us.sub": "Token usage and cost breakdown.",
      "us.period7": "7 days",
      "us.period30": "30 days",
      "us.bymodel.title": "By model",
      "us.bymodel.sub": "Runs, tokens and cost per model",
      "us.k.runs": "Runs",
      "us.k.inputTokens": "Input tokens",
      "us.k.outputTokens": "Output tokens",
      "us.k.costUsd": "Est. cost (USD)",
      "us.empty": "No data for this period"
    });

  var PERIOD = 7;

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function num(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    try {
      return v.toLocaleString("en-US");
    } catch (e) {
      return String(v);
    }
  }

  function fmtCost(v) {
    var n = Number(v);
    if (!isFinite(n)) return "—";
    return "$" + n.toFixed(4);
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

  function labelFor(key, t) {
    var k = "us.k." + key;
    var v = t(k);
    if (v !== k) return v;
    return String(key).replace(/_/g, " ");
  }

  /* Backend shape: flat { runs, inputTokens, outputTokens, estimatedUsd }.
   * Keep the legacy {stats}|{totals} fallbacks for robustness. */
  function normStats(r, t) {
    if (
      r.runs !== undefined ||
      r.inputTokens !== undefined ||
      r.outputTokens !== undefined ||
      r.estimatedUsd !== undefined
    ) {
      return [
        { label: t("us.k.runs"), value: r.runs || 0, icon: "gauge", ic: "" },
        { label: t("us.k.inputTokens"), value: r.inputTokens || 0, icon: "download", ic: "blue" },
        { label: t("us.k.outputTokens"), value: r.outputTokens || 0, icon: "upload", ic: "green" },
        { label: t("us.k.costUsd"), value: fmtCost(r.estimatedUsd), icon: "trend", ic: "amber", raw: true },
      ];
    }
    if (Array.isArray(r.stats)) {
      return r.stats.map(function (s) {
        return { label: s.label || labelFor(s.key, t), value: s.value, icon: "chart", ic: "" };
      });
    }
    var src = r.totals || r.summary || null;
    if (src && typeof src === "object") {
      return Object.keys(src).map(function (k) {
        return { label: labelFor(k, t), value: src[k], icon: "chart", ic: "" };
      });
    }
    return [];
  }

  /* Backend shape: byModel: [{ modelId, runs, inputTokens, outputTokens, estimatedUsd }] */
  function byModelHtml(rows, t) {
    var I = window.AppIcons.svg;
    if (!rows || !rows.length) return "";
    var body = rows
      .map(function (m) {
        return (
          "<tr><td class=\"mono\" dir=\"ltr\">" + esc(m.modelId || "—") + "</td>" +
          "<td>" + esc(num(m.runs)) + "</td>" +
          "<td>" + esc(num((m.inputTokens || 0) + (m.outputTokens || 0))) + "</td>" +
          "<td><strong>" + esc(fmtCost(m.estimatedUsd)) + "</strong></td></tr>"
        );
      })
      .join("");
    return (
      '<div class="card"><div class="card-head">' +
      '<div class="card-icon">' + I("cpu") + "</div>" +
      "<div><h2 class=\"card-title\">" + esc(t("us.bymodel.title")) + "</h2>" +
      '<p class="card-sub">' + esc(t("us.bymodel.sub")) + "</p></div></div>" +
      '<div style="overflow-x:auto;margin:0 -16px;padding:0 16px"><table class="mx-table"><thead><tr>' +
      "<th>Model</th><th>" + esc(t("us.k.runs")) + "</th><th>Tokens</th><th>" + esc(t("us.k.costUsd")) + "</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div></div>"
    );
  }

  async function render(el, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;

    async function load() {
      el.innerHTML = ctx.pageHead("trend", t("sec.usage"), t("us.sub")) + periodHtml(t) + loadingHtml(t);
      wirePeriod();
      var body = el.querySelector("[data-body]");
      try {
        var r = await ctx.api("usage.report", { days: PERIOD });
        var stats = normStats(r, t);
        var statsHtml = stats.length
          ? '<div class="stat-grid">' +
            stats
              .map(function (s) {
                var val = s.raw ? s.value : typeof s.value === "number" ? num(s.value) : s.value;
                return (
                  '<div class="stat-card"><div class="stat-top">' +
                  '<div class="stat-ic' + (s.ic ? " " + s.ic : "") + '">' + I(s.icon || "chart") + "</div>" +
                  "</div>" +
                  '<div class="stat-value">' + esc(val) + "</div>" +
                  '<div class="stat-label">' + esc(s.label) + "</div></div>"
                );
              })
              .join("") +
            "</div>"
          : '<div class="card"><div class="mx-center">' + esc(t("us.empty")) + "</div></div>";
        body.innerHTML = statsHtml + byModelHtml(r.byModel, t);
      } catch (err) {
        body.innerHTML = errorHtml(t, err);
        var b = body.querySelector("[data-retry]");
        if (b) b.addEventListener("click", load);
      }
    }

    function periodHtml(tt) {
      return (
        '<div class="mx-period" role="group" aria-label="Period">' +
        '<button class="btn" data-p="7" aria-pressed="' + (PERIOD === 7 ? "true" : "false") + '">' + esc(tt("us.period7")) + "</button>" +
        '<button class="btn" data-p="30" aria-pressed="' + (PERIOD === 30 ? "true" : "false") + '">' + esc(tt("us.period30")) + "</button>" +
        "</div><div data-body></div>"
      );
    }

    function wirePeriod() {
      Array.prototype.forEach.call(el.querySelectorAll("[data-p]"), function (b) {
        b.addEventListener("click", function () {
          var p = Number(b.getAttribute("data-p"));
          if (p !== PERIOD) {
            PERIOD = p;
            load();
          }
        });
      });
    }

    await load();
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("usage", { titleKey: "sec.usage", icon: "trend", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
