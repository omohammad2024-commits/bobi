/* BOBI Mini App · section: usage
 * Owner-only: usage.report with 7/30-day period selector — stat cards
 * plus a simple daily bar chart (SVG, RTL-aware, no libs). ctx.api only. */
(function () {
  "use strict";

  function RS(fa, en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(fa, en);
    }
  }

  RS(
    {
      "us.period7": "۷ روز",
      "us.period30": "۳۰ روز",
      "us.daily.title": "مصرف روزانه",
      "us.empty": "داده‌ای برای این بازه نیست",
      "us.k.messages": "پیام‌ها",
      "us.k.tokens": "توکن‌ها",
      "us.k.tokens_in": "توکن ورودی",
      "us.k.tokens_out": "توکن خروجی",
      "us.k.cost": "هزینه",
      "us.k.cost_usd": "هزینه (دلار)",
      "us.k.tool_calls": "فراخوانی ابزار",
      "us.k.llm_calls": "فراخوانی مدل"
    },
    {
      "us.period7": "7 days",
      "us.period30": "30 days",
      "us.daily.title": "Daily usage",
      "us.empty": "No data for this period",
      "us.k.messages": "Messages",
      "us.k.tokens": "Tokens",
      "us.k.tokens_in": "Input tokens",
      "us.k.tokens_out": "Output tokens",
      "us.k.cost": "Cost",
      "us.k.cost_usd": "Cost (USD)",
      "us.k.tool_calls": "Tool calls",
      "us.k.llm_calls": "Model calls"
    }
  );

  var PERIOD = 7;

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

  function num(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    try {
      return v.toLocaleString(lang() === "fa" ? "fa-IR" : "en-US");
    } catch (e) {
      return String(v);
    }
  }

  function styleTag() {
    return (
      "<style>" +
      ".mx-spin{width:28px;height:28px;margin:18px auto;border:3px solid var(--border,#e2e2e2);border-top-color:var(--accent,#2a7fff);border-radius:50%;animation:mxrot 0.8s linear infinite}" +
      "@keyframes mxrot{to{transform:rotate(360deg)}}" +
      ".mx-center{text-align:center;padding:26px 12px;color:var(--muted,#777)}" +
      ".mx-period{display:flex;gap:8px;margin-bottom:12px}" +
      ".mx-period .btn{flex:1;min-height:44px}" +
      ".mx-period .btn[aria-pressed=true]{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}" +
      ".mx-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:4px}" +
      ".mx-stat{background:var(--card,#fff);border:1px solid var(--border,#e2e2e2);border-radius:12px;padding:14px 12px;text-align:center}" +
      ".mx-stat b{display:block;font-size:22px;margin-bottom:2px}" +
      ".mx-stat span{font-size:12px;color:var(--muted,#777)}" +
      ".mx-secttl{font-weight:700;margin:2px 0 8px;font-size:15px}" +
      ".mx-chart{width:100%;height:auto;display:block}" +
      ".mx-kv{font-size:12px;color:var(--muted,#777);word-break:break-all}" +
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

  function labelFor(key, t) {
    var k = "us.k." + key;
    var v = t(k);
    if (v !== k) return v;
    return String(key).replace(/_/g, " ");
  }

  /* Accept {stats:[{key,label,value}]} | {totals:{k:v}} shapes. */
  function normStats(r, t) {
    if (Array.isArray(r.stats)) {
      return r.stats.map(function (s) {
        return { label: s.label || labelFor(s.key, t), value: s.value };
      });
    }
    var src = r.totals || r.summary || null;
    if (src && typeof src === "object") {
      return Object.keys(src).map(function (k) {
        return { label: labelFor(k, t), value: src[k] };
      });
    }
    return [];
  }

  /* Accept {daily:[{label|day|date, value|count|tokens}]} | {series:[...]} */
  function normDaily(r) {
    var arr = r.daily || r.series || r.days || [];
    return arr
      .map(function (d) {
        var label = d.label || d.day || d.date || "";
        var value = d.value !== undefined ? d.value : d.count !== undefined ? d.count : d.tokens;
        return { label: String(label), value: Number(value) };
      })
      .filter(function (d) { return isFinite(d.value); });
  }

  function barsHtml(daily, t) {
    if (!daily.length) return '<div class="mx-center">' + esc(t("us.empty")) + "</div>";
    var W = 360, H = 170, padB = 26, padT = 10, padX = 8;
    var max = Math.max.apply(null, daily.map(function (d) { return d.value; }));
    if (max <= 0) max = 1;
    var isRtl = rtl();
    var n = daily.length;
    var slot = (W - 2 * padX) / n;
    var bw = Math.min(34, slot * 0.62);
    var bars = daily
      .map(function (d, i) {
        var h = ((H - padB - padT) * d.value) / max;
        var cx = padX + slot * (i + 0.5);
        var x = isRtl ? W - cx - bw / 2 : cx - bw / 2;
        var y = H - padB - h;
        var short = d.label.length > 6 ? d.label.slice(0, 6) : d.label;
        return (
          '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="4" fill="var(--accent,#2a7fff)" opacity="0.85"/>' +
          '<text x="' + (isRtl ? W - cx : cx).toFixed(1) + '" y="' + (H - 8) + '" font-size="10" text-anchor="middle" fill="var(--muted,#777)">' + esc(short) + "</text>"
        );
      })
      .join("");
    return '<svg class="mx-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(t("us.daily.title")) + '">' + bars + "</svg>";
  }

  async function render(el, ctx) {
    var t = ctx.t;

    async function load() {
      el.innerHTML = styleTag() + periodHtml(t) + loadingHtml(t);
      wirePeriod();
      var body = el.querySelector("[data-body]");
      try {
        var r = await ctx.api("usage.report", { period: PERIOD });
        var stats = normStats(r, t);
        var daily = normDaily(r);
        var statsHtml = stats.length
          ? '<div class="mx-stats">' +
            stats
              .map(function (s) {
                return '<div class="mx-stat"><b>' + esc(num(s.value)) + "</b><span>" + esc(s.label) + "</span></div>";
              })
              .join("") +
            "</div>"
          : '<div class="mx-center">' + esc(t("us.empty")) + "</div>";
        body.innerHTML =
          statsHtml +
          '<div class="card"><div class="mx-secttl">' + esc(t("us.daily.title")) + "</div>" + barsHtml(daily, t) + "</div>";
      } catch (err) {
        body.innerHTML = errorHtml(t, err);
        var b = body.querySelector("[data-retry]");
        if (b) b.addEventListener("click", load);
      }
    }

    function periodHtml(tt) {
      return (
        '<div class="mx-period" role="group">' +
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
      window.App.registerSection("usage", { titleKey: "sec.usage", icon: "📈", render: render });
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    }
  }
  boot();
})();
