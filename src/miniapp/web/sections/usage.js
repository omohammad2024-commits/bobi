/* BOBI Mini App · section: usage
 * Owner-only usage/cost dashboard: usage.report stat cards + per-model table,
 * plus usage.daily (daily bar chart), usage.byProvider (per-provider cards)
 * and usage.latency (per-model latency percentiles). ctx.api only.
 *
 * Backend contract (POST /miniapp/api/<endpoint>, {initData, ...}, { days? }):
 *   usage.report { days? } -> { ok, days, runs, inputTokens, outputTokens,
 *                   estimatedUsd, byModel: [{ modelId, runs, inputTokens,
 *                   outputTokens, estimatedUsd }] }
 *   usage.daily { days? } -> { ok, days, daily: [{ date, dayStartMs, runs,
 *                   inputTokens, outputTokens, estimatedUsd }] }
 *   usage.byProvider { days? } -> { ok, days, providers: [{ providerId,
 *                   providerName, runs, successRate, avgLatencyMs,
 *                   inputTokens, outputTokens, estimatedUsd }] }
 *   usage.latency { days? } -> { ok, days, tracked, perModel: [{ modelId,
 *                   runs, p50Ms, p95Ms, maxMs }] }
 * Per-attempt latency and failure counts are not recorded by the usage
 * ledger, so latency percentiles / success rates come back null until
 * tracking exists — the UI degrades gracefully (see latencyHtml).
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
      "us.daily.title": "Daily usage",
      "us.daily.sub": "Runs and tokens per day",
      "us.byprovider.title": "By provider",
      "us.byprovider.sub": "Runs, tokens and cost per provider",
      "us.bymodel.title": "By model",
      "us.bymodel.sub": "Runs, tokens and cost per model",
      "us.latency.title": "Latency",
      "us.latency.sub": "Response-time percentiles per model",
      "us.latency.untracked": "Per-attempt latency is not recorded yet — the usage ledger stores token counts only.",
      "us.k.runs": "Runs",
      "us.k.inputTokens": "Input tokens",
      "us.k.outputTokens": "Output tokens",
      "us.k.tokens": "Tokens",
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

  function fmtMs(v) {
    var n = Number(v);
    if (!isFinite(n)) return "—";
    return n >= 1000 ? (n / 1000).toFixed(1) + "s" : Math.round(n) + "ms";
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

  function cardHead(icon, title, sub) {
    var I = window.AppIcons.svg;
    return (
      '<div class="card-head"><div class="card-icon">' + I(icon) + "</div>" +
      '<div><h2 class="card-title">' + esc(title) + "</h2>" +
      '<p class="card-sub">' + esc(sub) + "</p></div></div>"
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
        { label: t("us.k.runs"), value: r.runs || 0, icon: "gauge", ic: "", key: "runs", sparkCls: "" },
        { label: t("us.k.inputTokens"), value: r.inputTokens || 0, icon: "download", ic: "blue", key: "inputTokens", sparkCls: "teal" },
        { label: t("us.k.outputTokens"), value: r.outputTokens || 0, icon: "upload", ic: "green", key: "outputTokens", sparkCls: "green" },
        { label: t("us.k.costUsd"), value: fmtCost(r.estimatedUsd), icon: "trend", ic: "amber", raw: true, key: "estimatedUsd", sparkCls: "purple" },
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

  /* Sparkline + delta from the usage.daily series (same payload the daily
   * bar chart already renders): points normalized to a 100x36 viewBox.
   * Delta = last day vs previous day, only when a previous day exists and
   * is non-zero — usage.report carries no prior-period totals, so no
   * period-over-period delta is ever shown. */
  function sparkSvg(values, cls) {
    if (!values || values.length < 2) return "";
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min;
    var pts = values.map(function (v, i) {
      var x = (i / (values.length - 1)) * 100;
      var y = span === 0 ? 18 : 34 - ((v - min) / span) * 32;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var area = "M0,36 L" + pts.join(" L") + " L100,36 Z";
    return (
      '<div class="spark' + (cls ? " " + cls : "") + '">' +
      '<svg viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="spark-area" d="' + area + '"/>' +
      '<polyline class="spark-line" points="' + pts.join(" ") + '"/>' +
      "</svg></div>"
    );
  }

  function deltaHtml(values) {
    if (!values || values.length < 2) return "";
    var prev = values[values.length - 2];
    var last = values[values.length - 1];
    if (!isFinite(prev) || !isFinite(last) || prev === 0) return "";
    var pct = ((last - prev) / Math.abs(prev)) * 100;
    var up = last >= prev;
    return (
      '<span class="stat-delta ' + (up ? "up" : "down") + '" title="vs previous day">' +
      (up ? "▲ " : "▼ ") + Math.abs(pct).toFixed(1) + "%</span>"
    );
  }

  function statsHtml(stats, t, daily) {
    var I = window.AppIcons.svg;
    if (!stats.length) {
      return '<div class="card"><div class="mx-center">' + esc(t("us.empty")) + "</div></div>";
    }
    return (
      '<div class="stat-grid">' +
      stats
        .map(function (s) {
          var val = s.raw ? s.value : typeof s.value === "number" ? num(s.value) : s.value;
          var series = null;
          if (s.key && daily && daily.length >= 2) {
            series = daily.map(function (d) { return Number(d[s.key]) || 0; });
          }
          return (
            '<div class="stat-card"><div class="stat-top">' +
            '<div class="stat-ic' + (s.ic ? " " + s.ic : "") + '">' + I(s.icon || "chart") + "</div>" +
            (series ? deltaHtml(series) : "") +
            "</div>" +
            '<div class="stat-value">' + esc(val) + "</div>" +
            '<div class="stat-label">' + esc(s.label) + "</div>" +
            (series ? sparkSvg(series, s.sparkCls) : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  /* Daily bar chart — pure SVG, no chart library. Bars show total tokens
   * per day; <title> carries runs + cost for touch/long-press. */
  function dailyChartHtml(rows, t) {
    if (!rows || !rows.length) return "";
    var W = 640, H = 240, padL = 10, padR = 10, padT = 14, padB = 30;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var vals = rows.map(function (d) {
      return (Number(d.inputTokens) || 0) + (Number(d.outputTokens) || 0);
    });
    var max = Math.max.apply(null, vals.concat([1]));
    var n = rows.length;
    var slot = plotW / n;
    var barW = Math.max(4, Math.floor(slot * 0.62));
    var labelEvery = Math.max(1, Math.ceil(n / 8));
    var bars = rows
      .map(function (d, i) {
        var v = vals[i];
        var h = Math.max(v > 0 ? 3 : 0, Math.round((v / max) * plotH));
        var x = padL + i * slot + (slot - barW) / 2;
        var y = padT + plotH - h;
        var mmdd = String(d.date || "").slice(5) || "—";
        var tip = (d.date || "") + " · " + num(d.runs || 0) + " " + t("us.k.runs") +
          " · " + num(v) + " " + t("us.k.tokens") + " · " + fmtCost(d.estimatedUsd);
        var label = i % labelEvery === 0 || i === n - 1
          ? '<text x="' + (padL + i * slot + slot / 2).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="11" fill="var(--hint)">' + esc(mmdd) + "</text>"
          : "";
        return (
          '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW + '" height="' + h + '" rx="3" fill="var(--accent)">' +
          "<title>" + esc(tip) + "</title></rect>" + label
        );
      })
      .join("");
    var baseline = '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" stroke="var(--border)" stroke-width="1"/>';
    return (
      '<div class="card">' +
      cardHead("chart", t("us.daily.title"), t("us.daily.sub")) +
      '<div style="width:100%;overflow-x:auto">' +
      '<svg viewBox="0 0 ' + W + " " + H + '" style="display:block;min-width:100%;height:auto" role="img" aria-label="' + esc(t("us.daily.title")) + '">' +
      baseline + bars +
      "</svg></div></div>"
    );
  }

  /* Per-provider cards: name, runs, tokens, est. cost. successRate and
   * avgLatencyMs render only when the backend supplies them (currently
   * null — the ledger records completed attempts only, no latency). */
  function providerCardsHtml(rows, t) {
    if (!rows || !rows.length) return "";
    var cards = rows
      .map(function (p) {
        var stats = [
          { label: t("us.k.runs"), value: num(p.runs), icon: "gauge", ic: "" },
          { label: t("us.k.tokens"), value: num((Number(p.inputTokens) || 0) + (Number(p.outputTokens) || 0)), icon: "layers", ic: "blue" },
          { label: t("us.k.costUsd"), value: fmtCost(p.estimatedUsd), icon: "trend", ic: "amber" },
        ];
        if (p.successRate !== undefined && p.successRate !== null) {
          stats.push({ label: "Success", value: Math.round(Number(p.successRate) * 100) + "%", icon: "check", ic: "green" });
        }
        if (p.avgLatencyMs !== undefined && p.avgLatencyMs !== null) {
          stats.push({ label: "Avg latency", value: fmtMs(p.avgLatencyMs), icon: "clock", ic: "" });
        }
        var grid = stats
          .map(function (s) {
            var I = window.AppIcons.svg;
            return (
              '<div class="stat-card"><div class="stat-top">' +
              '<div class="stat-ic' + (s.ic ? " " + s.ic : "") + '">' + I(s.icon) + "</div></div>" +
              '<div class="stat-value">' + esc(s.value) + "</div>" +
              '<div class="stat-label">' + esc(s.label) + "</div></div>"
            );
          })
          .join("");
        return (
          '<div class="card">' +
          cardHead("plug", p.providerName || "—", num(p.runs) + " " + t("us.k.runs")) +
          '<div class="stat-grid">' + grid + "</div></div>"
        );
      })
      .join("");
    return (
      '<div style="margin-bottom:4px">' +
      '<div style="font-weight:600;margin:16px 2px 8px;font-size:var(--fs-h2)">' + esc(t("us.byprovider.title")) + "</div>" +
      '<div class="mx-kv" style="margin:0 2px 10px">' + esc(t("us.byprovider.sub")) + "</div>" +
      cards + "</div>"
    );
  }

  /* Backend shape: byModel: [{ modelId, runs, inputTokens, outputTokens, estimatedUsd }] */
  function byModelHtml(rows, t) {
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
      '<div class="card">' +
      cardHead("cpu", t("us.bymodel.title"), t("us.bymodel.sub")) +
      '<div style="overflow-x:auto;margin:0 -16px;padding:0 16px"><table class="mx-table"><thead><tr>' +
      "<th>Model</th><th>" + esc(t("us.k.runs")) + "</th><th>" + esc(t("us.k.tokens")) + "</th><th>" + esc(t("us.k.costUsd")) + "</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div></div>"
    );
  }

  /* Latency section. Until the backend tracks per-attempt latency
   * (tracked === false), show a muted explainer instead of a fake table. */
  function latencyHtml(lat, t) {
    if (!lat || !lat.tracked || !lat.perModel || !lat.perModel.length) {
      return (
        '<div class="card">' +
        cardHead("clock", t("us.latency.title"), t("us.latency.sub")) +
        '<div class="mx-kv">' + esc(t("us.latency.untracked")) + "</div></div>"
      );
    }
    var body = lat.perModel
      .map(function (m) {
        return (
          "<tr><td class=\"mono\" dir=\"ltr\">" + esc(m.modelId || "—") + "</td>" +
          "<td>" + esc(num(m.runs)) + "</td>" +
          "<td>" + esc(fmtMs(m.p50Ms)) + "</td>" +
          "<td>" + esc(fmtMs(m.p95Ms)) + "</td>" +
          "<td>" + esc(fmtMs(m.maxMs)) + "</td></tr>"
        );
      })
      .join("");
    return (
      '<div class="card">' +
      cardHead("clock", t("us.latency.title"), t("us.latency.sub")) +
      '<div style="overflow-x:auto;margin:0 -16px;padding:0 16px"><table class="mx-table"><thead><tr>' +
      "<th>Model</th><th>" + esc(t("us.k.runs")) + "</th><th>p50</th><th>p95</th><th>Max</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div></div>"
    );
  }

  function settledValue(s) {
    return s && s.status === "fulfilled" ? s.value : null;
  }

  async function render(el, ctx) {
    var t = ctx.t;

    async function load() {
      el.innerHTML = ctx.pageHead("trend", t("sec.usage"), t("us.sub")) + periodHtml(t) + loadingHtml(t);
      wirePeriod();
      var body = el.querySelector("[data-body]");
      try {
        var results = await Promise.allSettled([
          ctx.api("usage.report", { days: PERIOD }),
          ctx.api("usage.daily", { days: PERIOD }),
          ctx.api("usage.byProvider", { days: PERIOD }),
          ctx.api("usage.latency", { days: PERIOD }),
        ]);
        var r = settledValue(results[0]);
        var daily = settledValue(results[1]);
        var byProv = settledValue(results[2]);
        var lat = settledValue(results[3]);
        if (!r && !daily && !byProv && !lat) {
          var failed = results[0];
          throw failed && failed.status === "rejected" ? failed.reason : new Error("request failed");
        }
        var html = statsHtml(normStats(r || {}, t), t, daily && daily.daily ? daily.daily : null);
        if (daily && daily.daily) html += dailyChartHtml(daily.daily, t);
        if (byProv && byProv.providers) html += providerCardsHtml(byProv.providers, t);
        if (r && r.byModel) html += byModelHtml(r.byModel, t);
        html += latencyHtml(lat, t);
        body.innerHTML = html;
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
