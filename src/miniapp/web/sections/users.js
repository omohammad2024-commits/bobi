/* BOBI Mini App — Users section.
 * List with ban state; tap → detail (ban/unban with confirm).
 * The backend decides which fields exist: list rows render name, username,
 * ban state and the backend's note if provided.
 *
 * Backend endpoints used (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   users.list   {} -> { users: [{ id, name, username, banned, note? }] }
 *   users.ban    { id } -> {}
 *   users.unban  { id } -> {}
 */
(function () {
  "use strict";

  function render(el, ctx) {
    const st = ctx.state;
    if (!st.view) st.view = { name: "list" };
    paint();

    function paint() {
      el.innerHTML = "";
      if (st.view.name === "detail") return viewDetail(st.view.id);
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

    async function viewList() {
      el.innerHTML = skeleton(4);
      let users = [];
      try {
        const res = await ctx.api("users.list", {});
        users = (res && res.users) || [];
      } catch (e) {
        el.innerHTML =
          '<div class="error-state"><p>⚠️ ' + ctx.esc(e.message || e.code || ctx.t("state.error")) + "</p>" +
          '<button type="button" class="btn btn-primary" id="retryU">' + ctx.esc(ctx.t("action.retry")) + "</button></div>";
        document.getElementById("retryU").addEventListener("click", paint);
        return;
      }
      el.innerHTML = "";
      if (!users.length) {
        const d = document.createElement("div");
        d.className = "empty-state";
        d.innerHTML = "<p>👥</p><p>" + ctx.esc(ctx.t("users.empty")) + "</p>";
        el.appendChild(d);
        return;
      }
      for (const u of users) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "list-row";
        const name = u.name || u.username || String(u.id);
        const handle = u.username ? "@" + u.username : "#" + u.id;
        const banBadge = u.banned
          ? '<span class="badge nokey">' + ctx.esc(ctx.t("users.banned")) + "</span>"
          : "";
        b.innerHTML =
          '<div class="list-main"><div class="list-title">' + ctx.esc(name) + banBadge + "</div>" +
          '<div class="list-sub" dir="ltr">' + ctx.esc(handle) + "</div></div>" +
          '<span class="chev"></span>';
        (function (id) {
          b.addEventListener("click", function () {
            setView({ name: "detail", id: id });
          });
        })(u.id);
        el.appendChild(b);
      }
    }

    async function viewDetail(id) {
      el.innerHTML = skeleton(3);
      let users = [];
      try {
        const res = await ctx.api("users.list", {});
        users = (res && res.users) || [];
      } catch (e) {
        el.innerHTML =
          '<div class="error-state"><p>⚠️ ' + ctx.esc(e.message || e.code || ctx.t("state.error")) + "</p>" +
          '<button type="button" class="btn btn-primary" id="retryUd">' + ctx.esc(ctx.t("action.retry")) + "</button></div>";
        document.getElementById("retryUd").addEventListener("click", paint);
        return;
      }
      const u = users.find(function (x) { return String(x.id) === String(id); });
      if (!u) {
        setView({ name: "list" });
        return;
      }
      el.innerHTML = "";

      const back = document.createElement("div");
      back.innerHTML =
        '<button type="button" class="btn btn-ghost" id="backBtn" style="margin-bottom:12px">‹ ' +
        ctx.esc(ctx.t("nav.back")) + "</button>";
      el.appendChild(back);
      back.querySelector("#backBtn").addEventListener("click", function () {
        setView({ name: "list" });
      });

      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        '<div class="list-title" style="font-size:18px">' + ctx.esc(u.name || u.username || String(u.id)) + "</div>" +
        '<div class="list-sub" dir="ltr" style="margin:4px 0 10px">' +
        (u.username ? "@" + ctx.esc(u.username) + " · " : "") + "#" + ctx.esc(String(u.id)) + "</div>" +
        (u.banned
          ? '<span class="badge nokey">' + ctx.esc(ctx.t("users.banned")) + "</span>"
          : '<span class="badge key">' + ctx.esc(ctx.t("prov.enabled")) + "</span>") +
        (u.note
          ? '<div style="margin-top:10px"><div class="list-sub">' + ctx.esc(ctx.t("users.note")) + "</div>" +
            "<div>" + ctx.esc(u.note) + "</div></div>"
          : "");
      el.appendChild(card);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-block " + (u.banned ? "btn-primary" : "btn-danger");
      btn.textContent = u.banned ? ctx.t("users.unban") : ctx.t("users.ban");
      btn.addEventListener("click", async function () {
        const ok = await ctx.confirmDialog(
          ctx.t("dialog.confirmTitle"),
          u.banned ? ctx.t("users.unbanConfirm") : ctx.t("users.banConfirm")
        );
        if (!ok) return;
        try {
          await ctx.api(u.banned ? "users.unban" : "users.ban", { id: u.id });
          ctx.toast(ctx.t("toast.saved"));
          setView({ name: "list" });
        } catch (e) {
          ctx.toast(ctx.t("toast.failed"));
        }
      });
      el.appendChild(btn);
    }

    paint();
  }

  window.App.registerSection("users", {
    titleKey: "sec.users",
    icon: "👥",
    render: render,
  });
})();
