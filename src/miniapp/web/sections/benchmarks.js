/* BOBI Mini App · section: benchmarks
 * Owner-only: benchmark run history, score trends, regression alerts,
 * and the automatic schedule toggle. ctx.api only. */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "bench.sub": "Quality scores, trends and regression alerts.",
      "bench.schedule.title": "Automatic schedule",
      "bench.schedule.desc": "Periodic background benchmark runs",
      "bench.alerts.title": "Quality regression alerts",
      "bench.alerts.sub": "Fires when scores drop",
      "bench.runs.title": "Run history",
      "bench.runs.sub": "Latest benchmark runs",
      "bench.trends.title": "Score trend",
      "bench.trends.sub": "Average score over time",
      "bench.col.time": "Time",
      "bench.col.model": "Provider / model",
      "bench.col.score": "Score",
      "bench.nextRun": "Next run",
      "bench.cadenceNote": "Default: weekly",
      "bench.empty.runs": "No benchmark runs yet",
      "bench.empty.alerts": "No alerts",
      "bench.empty.trends": "No data for the chart",
      "bench.toggled": "Saved"
    });

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtTs(ts) {
    var n = Number(ts);
    if (!n) return "—";
    var loc = "en-US";
    try {
      return new Date(n).toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return new Date(n).toLocaleString();
    }
  }

  function loadingHtml(t) {
    return '<div class="loading-state"><div class="spinner"></div><div>' + esc(t("state.loading")) + "</div></div>";
  }

  function emptyHtml(msg) {
    return '<div class="mx-center">' + esc(msg) + "</div>";
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

  /* Backend shape: { pair, runs: [{ runId, tsMs, avgScorePct }], pairs, tasks, task }.
   * Keep the legacy {points|series|scores} fallbacks for robustness. */
  function normPoints(r) {
    var runs = r.runs || [];
    if (runs.length) {
      return runs
        .map(function (x) {
          return {
            t: x.tsMs !== undefined ? x.tsMs : x.runId,
            score: Number(x.avgScorePct !== undefined ? x.avgScorePct : x.score),
          };
        })
        .filter(function (p) { return isFinite(p.score); });
    }
    var pts = r.points || r.series || r.data || [];
    if (!pts.length && Array.isArray(r.scores)) {
      pts = r.scores.map(function (s, i) { return { t: i, score: s }; });
    }
    return pts
      .map(function (p) {
        return { t: p.t !== undefined ? p.t : p.at !== undefined ? p.at : p.x, score: Number(p.score !== undefined ? p.score : p.y !== undefined ? p.y : p.value) };
      })
      .filter(function (p) { return isFinite(p.score); });
  }

  function scoreBadge(score) {
    if (score === null || score === undefined || !isFinite(Number(score))) return '<span class="score">—</span>';
    var v = Number(score);
    var cls = v >= 85 ? "score-hi" : v >= 60 ? "score-mid" : "score-lo";
    return '<span class="score ' + cls + '">' + esc(String(Math.round(v * 100) / 100)) + "</span>";
  }

  function chartHtml(points, t) {
    var I = window.AppIcons.svg;
    if (!points.length) return emptyHtml(t("bench.empty.trends"));
    var W = 360, H = 170, pad = 30;
    var vals = points.map(function (p) { return p.score; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max === min) max = min + 1;
    function X(i) {
      var f = points.length === 1 ? 0.5 : i / (points.length - 1);
      return pad + f * (W - 2 * pad);
    }
    function Y(v) {
      return H - pad - ((v - min) / (max - min)) * (H - 2 * pad);
    }
    var d = points
      .map(function (p, i) { return (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.score).toFixed(1); })
      .join(" ");
    var area = d + " L" + X(points.length - 1).toFixed(1) + "," + (H - pad) + " L" + X(0).toFixed(1) + "," + (H - pad) + " Z";
    var dots = points
      .map(function (p, i) {
        return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.score).toFixed(1) + '" r="3.5" fill="#0b0f1a" stroke="var(--accent)" stroke-width="2.5"/>';
      })
      .join("");
    return (
      '<svg class="mx-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(t("bench.trends.title")) + '">' +
      "<defs><linearGradient id=\"bchg\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">" +
      '<stop offset="0" stop-color="var(--accent)" stop-opacity="0.35"/>' +
      '<stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>' +
      "</linearGradient></defs>" +
      '<path d="' + area + '" fill="url(#bchg)"/>' +
      '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots +
      '<text x="' + pad + '" y="' + (H - 8) + '" font-size="11" fill="var(--hint)">' + esc(String(Math.round(min * 100) / 100)) + "</text>" +
      '<text x="' + pad + '" y="' + (pad - 8) + '" font-size="11" fill="var(--hint)">' + esc(String(Math.round(max * 100) / 100)) + "</text>" +
      "</svg>"
    );
  }

  async function render(el, ctx) {
    var t = ctx.t;
    var I = window.AppIcons.svg;
    el.innerHTML = ctx.pageHead("chart", t("sec.benchmarks"), t("bench.sub")) + loadingHtml(t);

    function onErr(err) {
      el.innerHTML = ctx.pageHead("chart", t("sec.benchmarks"), t("bench.sub")) + errorHtml(t, err);
      var b = el.querySelector("[data-retry]");
      if (b) b.addEventListener("click", function () { render(el, ctx); });
    }

    var sched = { enabled: false }, alerts = [], runs = [], trendPts = [];
    try {
      var rs = await ctx.api("bench.schedule", {});
      sched = rs.schedule || rs || { enabled: false };
      try { var ra = await ctx.api("bench.alerts", {}); alerts = ra.alerts || ra.items || []; } catch (e1) { alerts = []; }
      try { var rr = await ctx.api("bench.runs", { limit: 20 }); runs = rr.runs || rr.items || []; } catch (e2) { runs = []; }
      try { var rt = await ctx.api("bench.trends", {}); trendPts = normPoints(rt); } catch (e3) { trendPts = []; }
    } catch (err) {
      onErr(err);
      return;
    }

    var latest = trendPts.length ? trendPts[trendPts.length - 1].score : null;

    var runsHtml = runs.length
      ? '<div style="overflow-x:auto;margin:0 -16px;padding:0 16px"><table class="mx-table"><thead><tr>' +
        "<th>" + esc(t("bench.col.time")) + "</th>" +
        "<th>" + esc(t("bench.col.model")) + "</th>" +
        "<th>" + esc(t("bench.col.score")) + "</th></tr></thead><tbody>" +
        runs
          .map(function (r) {
            var model = [r.provider, r.model].filter(Boolean).join(" / ") || "—";
            var scoreVal = r.avgScorePct !== undefined && r.avgScorePct !== null ? Number(r.avgScorePct) : null;
            var detail =
              r.passed !== undefined || r.failed !== undefined
                ? '<div class="mx-kv">' + (r.passed || 0) + "✓ / " + (r.failed || 0) + "✗</div>"
                : "";
            return (
              "<tr><td style=\"white-space:nowrap\">" + esc(fmtTs(r.tsMs || r.startedAt || r.createdAt || r.at || r.time)) + "</td>" +
              '<td class="mono" dir="ltr">' + esc(model) + "</td>" +
              "<td>" + scoreBadge(scoreVal) + detail + "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>"
      : emptyHtml(t("bench.empty.runs"));

    /* Backend shape: { alerts: [{ key, label, lastSentMs }] } */
    var alertsHtml = alerts.length
      ? alerts
          .map(function (a) {
            if (typeof a === "string") {
              return '<div class="note note-warn" style="margin:0 0 8px">' + I("alert") + "<span>" + esc(a) + "</span></div>";
            }
            var text = a.label || a.labelFa || a.text || a.message || a.key || "";
            var at = a.lastSentMs || a.at || a.createdAt || null;
            return (
              '<div class="note note-warn" style="margin:0 0 8px">' + I("alert") + "<span>" + esc(text) +
              (at ? '<br><span class="mx-kv">' + esc(fmtTs(at)) + "</span>" : "") + "</span></div>"
            );
          })
          .join("")
      : emptyHtml(t("bench.empty.alerts"));

    el.innerHTML =
      ctx.pageHead("chart", t("sec.benchmarks"), t("bench.sub")) +
      '<div class="card"><div class="card-head">' +
      '<div class="card-icon">' + I("history") + "</div>" +
      "<div><h2 class=\"card-title\">" + esc(t("bench.schedule.title")) + "</h2>" +
      '<p class="card-sub">' + esc(t("bench.schedule.desc")) + "</p></div>" +
      '<div class="spacer"></div>' +
      '<button class="mx-toggle" data-sched aria-checked="' + (sched.enabled ? "true" : "false") + '">' +
      esc(sched.enabled ? t("action.toggleOn") : t("action.toggleOff")) + "</button></div>" +
      (sched.nextRunAtMs
        ? '<div class="kv"><span class="k">' + esc(t("bench.nextRun")) + '</span><span class="v">' + esc(fmtTs(sched.nextRunAtMs)) + "</span></div>"
        : "") +
      (sched.cron ? '<div class="kv"><span class="k">Cron</span><span class="v mono" dir="ltr">' + esc(sched.cron) + "</span></div>" : "") +
      "</div>" +
      '<div class="card"><div class="card-head">' +
      '<div class="card-icon amber">' + I("alert") + "</div>" +
      "<div><h2 class=\"card-title\">" + esc(t("bench.alerts.title")) + "</h2>" +
      '<p class="card-sub">' + esc(t("bench.alerts.sub")) + "</p></div>" +
      (alerts.length ? '<div class="spacer"></div><span class="badge badge-warn">' + alerts.length + "</span>" : "") +
      "</div>" + alertsHtml + "</div>" +
      '<div class="card"><div class="card-head">' +
      '<div class="card-icon">' + I("trend") + "</div>" +
      "<div><h2 class=\"card-title\">" + esc(t("bench.trends.title")) + "</h2>" +
      '<p class="card-sub">' + esc(t("bench.trends.sub")) + "</p></div>" +
      (latest !== null ? '<div class="spacer"></div>' + scoreBadge(latest) : "") +
      "</div>" + chartHtml(trendPts, t) + "</div>" +
      '<div class="card"><div class="card-head">' +
      '<div class="card-icon blue">' + I("layers") + "</div>" +
      "<div><h2 class=\"card-title\">" + esc(t("bench.runs.title")) + "</h2>" +
      '<p class="card-sub">' + esc(t("bench.runs.sub")) + "</p></div></div>" +
      runsHtml + "</div>";

    var tog = el.querySelector("[data-sched]");
    tog.addEventListener("click", async function () {
      var next = tog.getAttribute("aria-checked") !== "true";
      tog.disabled = true;
      try {
        // The backend requires cron|cadence on every enable (even for an
        // existing task): re-send the stored cron, or fall back to a weekly
        // cadence when no schedule exists yet.
        var params = next
          ? (sched.cron ? { enabled: true, cron: sched.cron } : { enabled: true, cadence: "weekly" })
          : { enabled: false };
        await ctx.api("bench.schedule", params);
        ctx.toast(t("bench.toggled") + (next && !params.cron ? " · " + t("bench.cadenceNote") : ""), "ok");
        render(el, ctx);
      } catch (err) {
        ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""), "err");
      } finally {
        tog.disabled = false;
      }
    });
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("benchmarks", { titleKey: "sec.benchmarks", icon: "chart", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
