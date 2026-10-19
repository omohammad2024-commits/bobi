/* BOBI Mini App · section: benchmarks
 * Owner-only: run history, score trends (SVG, RTL-aware, no libs),
 * schedule toggle, regression alerts. ctx.api only. */
(function () {
  "use strict";

  function RS(fa, en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(fa, en);
    }
  }

  RS(
    {
      "bench.schedule.title": "زمان‌بندی خودکار",
      "bench.schedule.desc": "اجرای دوره‌ای بنچمارک در پس‌زمینه",
      "bench.alerts.title": "هشدارهای افت کیفیت",
      "bench.runs.title": "سوابق اجرا",
      "bench.trends.title": "روند امتیاز",
      "bench.col.time": "زمان",
      "bench.col.model": "پروایدر / مدل",
      "bench.col.score": "امتیاز",
      "bench.nextRun": "اجرای بعدی",
      "bench.empty.runs": "هنوز بنچمارکی اجرا نشده است",
      "bench.empty.alerts": "هشداری نیست",
      "bench.empty.trends": "داده‌ای برای نمودار نیست",
      "bench.toggled": "ذخیره شد ✓"
    },
    {
      "bench.schedule.title": "Automatic schedule",
      "bench.schedule.desc": "Periodic background benchmark runs",
      "bench.alerts.title": "Quality regression alerts",
      "bench.runs.title": "Run history",
      "bench.trends.title": "Score trend",
      "bench.col.time": "Time",
      "bench.col.model": "Provider / model",
      "bench.col.score": "Score",
      "bench.nextRun": "Next run",
      "bench.empty.runs": "No benchmark runs yet",
      "bench.empty.alerts": "No alerts",
      "bench.empty.trends": "No data for the chart",
      "bench.toggled": "Saved ✓"
    }
  );

  function esc(v) {
    return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function lang() {
    return (window.I18N && window.I18N.getLang && window.I18N.getLang()) || "fa";
  }

  function rtl() {
    return document.documentElement && document.documentElement.dir === "rtl";
  }

  function fmtTs(ts) {
    var n = Number(ts);
    if (!n) return "—";
    var loc = lang() === "fa" ? "fa-IR" : "en-US";
    try {
      return new Date(n).toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" });
    } catch (e) {
      return new Date(n).toLocaleString();
    }
  }

  function styleTag() {
    return (
      "<style>" +
      ".mx-spin{width:28px;height:28px;margin:18px auto;border:3px solid var(--border,#e2e2e2);border-top-color:var(--accent,#2a7fff);border-radius:50%;animation:mxrot 0.8s linear infinite}" +
      "@keyframes mxrot{to{transform:rotate(360deg)}}" +
      ".mx-center{text-align:center;padding:26px 12px;color:var(--muted,#777)}" +
      ".mx-row{display:flex;align-items:center;justify-content:space-between;gap:10px}" +
      ".mx-muted{font-size:12px;color:var(--muted,#777)}" +
      ".mx-table{width:100%;border-collapse:collapse;font-size:13px}" +
      ".mx-table th,.mx-table td{padding:10px 8px;border-bottom:1px solid var(--border,#eee);text-align:start}" +
      ".mx-table th{font-size:12px;color:var(--muted,#777);font-weight:600}" +
      ".mx-chart{width:100%;height:auto;display:block}" +
      ".mx-toggle{min-width:64px;min-height:44px;border-radius:22px;border:1px solid var(--border,#e2e2e2);background:var(--muted-bg,#eee);font-size:13px}" +
      ".mx-toggle[aria-checked=true]{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}" +
      ".mx-secttl{font-weight:700;margin:2px 0 8px;font-size:15px}" +
      ".mx-kv{font-size:12px;color:var(--muted,#777);word-break:break-all}" +
      "</style>"
    );
  }

  function loadingHtml(t) {
    return '<div class="mx-center"><div class="mx-spin"></div><div>' + esc(t("state.loading")) + "</div></div>";
  }

  function emptyHtml(t, msgKey) {
    return '<div class="mx-center">' + esc(t(msgKey)) + "</div>";
  }

  function errorHtml(t, err) {
    return (
      '<div class="card mx-center"><div>⚠️ ' + esc(t("state.error")) + "</div>" +
      (err && err.message ? '<div class="mx-kv">' + esc(err.message) + "</div>" : "") +
      '<div style="margin-top:12px"><button class="btn" data-retry style="min-height:44px;min-width:120px">' +
      esc(t("action.retry")) + "</button></div></div>"
    );
  }

  /* Normalize trend payloads: {points:[{t,score}]} | {series:[...]} | {scores:[n]} */
  function normPoints(r) {
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

  function chartHtml(points, t) {
    if (!points.length) return emptyHtml(t, "bench.empty.trends");
    var W = 360, H = 160, pad = 30;
    var vals = points.map(function (p) { return p.score; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max === min) max = min + 1;
    var isRtl = rtl();
    function X(i) {
      var f = points.length === 1 ? 0.5 : i / (points.length - 1);
      var x = pad + f * (W - 2 * pad);
      return isRtl ? W - x : x;
    }
    function Y(v) {
      return H - pad - ((v - min) / (max - min)) * (H - 2 * pad);
    }
    var d = points
      .map(function (p, i) { return (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.score).toFixed(1); })
      .join(" ");
    var dots = points
      .map(function (p, i) {
        return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.score).toFixed(1) + '" r="3.5" fill="var(--accent,#2a7fff)"/>';
      })
      .join("");
    var anchor = isRtl ? "end" : "start";
    return (
      '<svg class="mx-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(t("bench.trends.title")) + '">' +
      '<line x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" stroke="var(--border,#ddd)"/>' +
      '<text x="' + (isRtl ? W - pad : pad) + '" y="' + (H - 8) + '" font-size="11" text-anchor="' + anchor + '" fill="var(--muted,#777)">' +
      esc(String(Math.round(max * 100) / 100)) + "</text>" +
      '<text x="' + (isRtl ? W - pad : pad) + '" y="' + (pad - 6) + '" font-size="11" text-anchor="' + anchor + '" fill="var(--muted,#777)">' +
      esc(String(Math.round(min * 100) / 100)) + "</text>" +
      '<path d="' + d + '" fill="none" stroke="var(--accent,#2a7fff)" stroke-width="2.5" stroke-linejoin="round"/>' +
      dots +
      "</svg>"
    );
  }

  async function render(el, ctx) {
    var t = ctx.t;
    el.innerHTML = styleTag() + loadingHtml(t);

    function onErr(err) {
      el.innerHTML = styleTag() + errorHtml(t, err);
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

    var runsHtml = runs.length
      ? '<div style="overflow-x:auto"><table class="mx-table"><thead><tr>' +
        "<th>" + esc(t("bench.col.time")) + "</th>" +
        "<th>" + esc(t("bench.col.model")) + "</th>" +
        "<th>" + esc(t("bench.col.score")) + "</th></tr></thead><tbody>" +
        runs
          .map(function (r) {
            var model = [r.provider, r.model].filter(Boolean).join(" / ") || "—";
            var score = r.score !== undefined && r.score !== null ? r.score : "—";
            return (
              "<tr><td>" + esc(fmtTs(r.startedAt || r.createdAt || r.at || r.time)) + "</td>" +
              "<td>" + esc(model) + "</td>" +
              "<td><strong>" + esc(String(score)) + "</strong></td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div>"
      : emptyHtml(t, "bench.empty.runs");

    var alertsHtml = alerts.length
      ? alerts
          .map(function (a) {
            var text = typeof a === "string" ? a : a.text || a.message || "";
            var at = typeof a === "object" ? a.at || a.createdAt : null;
            return (
              '<div class="card"><div>⚠️ ' + esc(text) + "</div>" +
              (at ? '<div class="mx-muted">' + esc(fmtTs(at)) + "</div>" : "") + "</div>"
            );
          })
          .join("")
      : emptyHtml(t, "bench.empty.alerts");

    el.innerHTML =
      styleTag() +
      '<div class="card"><div class="mx-row"><div>' +
      '<div class="mx-secttl">' + esc(t("bench.schedule.title")) + "</div>" +
      '<div class="mx-muted">' + esc(t("bench.schedule.desc")) + "</div>" +
      (sched.nextRun || sched.next_run
        ? '<div class="mx-muted">' + esc(t("bench.nextRun")) + ": " + esc(fmtTs(sched.nextRun || sched.next_run)) + "</div>"
        : "") +
      '</div><button class="mx-toggle" data-sched aria-checked="' + (sched.enabled ? "true" : "false") + '">' +
      esc(sched.enabled ? t("action.toggleOn") : t("action.toggleOff")) + "</button></div></div>" +
      '<div class="card"><div class="mx-secttl">' + esc(t("bench.alerts.title")) + "</div>" + alertsHtml + "</div>" +
      '<div class="card"><div class="mx-secttl">' + esc(t("bench.trends.title")) + "</div>" + chartHtml(trendPts, t) + "</div>" +
      '<div class="card"><div class="mx-secttl">' + esc(t("bench.runs.title")) + "</div>" + runsHtml + "</div>";

    var tog = el.querySelector("[data-sched]");
    tog.addEventListener("click", async function () {
      var next = tog.getAttribute("aria-checked") !== "true";
      tog.disabled = true;
      try {
        await ctx.api("bench.schedule", { enabled: next });
        tog.setAttribute("aria-checked", next ? "true" : "false");
        tog.textContent = next ? t("action.toggleOn") : t("action.toggleOff");
        ctx.toast(t("bench.toggled"));
      } catch (err) {
        ctx.toast(t("toast.failed") + (err && err.message ? ": " + err.message : ""));
      } finally {
        tog.disabled = false;
      }
    });
  }

  function boot() {
    if (window.App && typeof window.App.registerSection === "function") {
      window.App.registerSection("benchmarks", { titleKey: "sec.benchmarks", icon: "📊", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
