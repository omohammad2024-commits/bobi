/* BOBI Mini App — Users section.
 * List with ban state and search; tap → detail (ban/unban with confirm).
 *
 * Backend endpoints used (POST /miniapp/api/<endpoint>, {initData, ...}):
 *   users.list   { q? } -> { users: [{ id, state, isBanned, username?, firstName? }], total }
 *   users.ban    { id, confirm:true } -> {}
 *   users.unban  { id } -> {}
 */
(function () {
  "use strict";

  function RS(en) {
    if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
      window.__registerSectionStrings(en);
    }
  }

  RS({
      "users.sub": "Everyone who has talked to the bot.",
      "users.search": "Search users…",
      "users.notBanned": "Active",
      "users.id": "User ID",
      "users.total": "{n} users",
    });

  function avatarFor(u) {
    var name = u.firstName || u.username || String(u.id);
    return window.AppIcons.avatar(name);
  }

  function statusBadge(u, t) {
    return u.isBanned
      ? '<span class="badge badge-danger">' + t("users.banned") + "</span>"
      : '<span class="badge badge-success">' + t("users.notBanned") + "</span>";
  }

  function render(el, ctx) {
    var st = ctx.state;
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
      var h = "";
      for (var i = 0; i < (n || 4); i++) h += '<div class="skeleton"></div>';
      return h;
    }

    function errHtml(e) {
      return (
        '<div class="error-state"><div class="error-ic">' + ctx.icon("alert") + "</div>" +
        "<p>" + ctx.esc((e && (e.message || e.code)) || ctx.t("state.error")) + "</p>" +
        '<button type="button" class="btn btn-primary" data-retry>' + ctx.icon("refresh") +
        ctx.esc(ctx.t("action.retry")) + "</button></div>"
      );
    }

    function wireRetry(fn) {
      var b = el.querySelector("[data-retry]");
      if (b) b.addEventListener("click", fn);
    }

    async function viewList() {
      el.innerHTML = ctx.pageHead("users", ctx.t("sec.users"), ctx.t("users.sub")) + skeleton(4);
      var users = [];
      try {
        var res = await ctx.api("users.list", st.q ? { q: st.q } : {});
        users = (res && res.users) || [];
      } catch (e) {
        el.innerHTML = ctx.pageHead("users", ctx.t("sec.users"), ctx.t("users.sub")) + errHtml(e);
        wireRetry(paint);
        return;
      }

      var head = ctx.pageHead("users", ctx.t("sec.users"), ctx.t("users.sub"));
      var wrap = document.createElement("div");
      wrap.innerHTML =
        head +
        '<div class="searchbar">' + ctx.icon("search") +
        '<input class="input" id="userSearch" type="search" placeholder="' +
        ctx.esc(ctx.t("users.search")) + '" value="' + ctx.esc(st.q || "") + '" dir="auto" autocomplete="off"></div>' +
        '<div id="userRows"></div>';
      el.innerHTML = "";
      el.appendChild(wrap);

      var rows = wrap.querySelector("#userRows");
      var debounce = null;
      wrap.querySelector("#userSearch").addEventListener("input", function (ev) {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(function () {
          st.q = ev.target.value.trim();
          viewList().then(function () {
            var s = document.getElementById("userSearch");
            if (s) {
              s.focus();
              try { s.setSelectionRange(s.value.length, s.value.length); } catch (ignore) {}
            }
          });
        }, 450);
      });

      if (!users.length) {
        rows.innerHTML =
          '<div class="empty-state"><div class="empty-ic">' + ctx.icon("users") + "</div>" +
          '<p class="empty-title">' + ctx.esc(ctx.t("users.empty")) + "</p></div>";
        return;
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < users.length; i++) {
        (function (u) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "list-row";
          var name = u.firstName || u.username || String(u.id);
          var handle = u.username ? "@" + u.username : "#" + u.id;
          b.innerHTML =
            avatarFor(u) +
            '<div class="list-main"><div class="list-title">' + ctx.esc(name) + "</div>" +
            '<div class="list-sub" dir="ltr">' + ctx.esc(handle) + "</div></div>" +
            '<div class="list-meta">' + statusBadge(u, ctx.t) + "</div>" +
            '<span class="chev">' + ctx.icon("chevR") + "</span>";
          b.addEventListener("click", function () {
            setView({ name: "detail", id: u.id });
          });
          frag.appendChild(b);
        })(users[i]);
      }
      rows.appendChild(frag);
    }

    async function viewDetail(id) {
      el.innerHTML = skeleton(3);
      var users = [];
      try {
        var res = await ctx.api("users.list", {});
        users = (res && res.users) || [];
      } catch (e) {
        el.innerHTML = errHtml(e);
        wireRetry(paint);
        return;
      }
      var u = null;
      for (var i = 0; i < users.length; i++) {
        if (String(users[i].id) === String(id)) { u = users[i]; break; }
      }
      if (!u) {
        setView({ name: "list" });
        return;
      }
      el.innerHTML = "";

      var name = u.firstName || u.username || String(u.id);

      var back = document.createElement("div");
      back.innerHTML =
        '<div class="subhead"><button type="button" class="btn btn-ghost btn-sm" id="backBtn">' +
        ctx.icon("chevL") + ctx.esc(ctx.t("nav.back")) + "</button></div>";
      el.appendChild(back);
      back.querySelector("#backBtn").addEventListener("click", function () {
        setView({ name: "list" });
      });

      var card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        '<div class="card-head">' +
        window.AppIcons.avatar(name, "lg") +
        '<div><div class="card-title" style="font-size:18px">' + ctx.esc(name) + "</div>" +
        '<div class="card-sub" dir="ltr">' +
        (u.username ? "@" + ctx.esc(u.username) : "#" + ctx.esc(String(u.id))) +
        "</div></div>" +
        '<div class="spacer"></div>' + statusBadge(u, ctx.t) +
        "</div>" +
        '<div class="kv"><span class="k">' + ctx.esc(ctx.t("users.id")) + '</span>' +
        '<span class="v mono" dir="ltr">' + ctx.esc(String(u.id)) + "</span></div>" +
        (u.state
          ? '<div class="kv"><span class="k">State</span><span class="v">' + ctx.esc(u.state) + "</span></div>"
          : "") +
        (u.note
          ? '<div class="kv"><span class="k">' + ctx.esc(ctx.t("users.note")) + '</span><span class="v">' +
            ctx.esc(u.note) + "</span></div>"
          : "");
      el.appendChild(card);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-block " + (u.isBanned ? "btn-primary" : "btn-danger");
      btn.innerHTML = ctx.icon(u.isBanned ? "checkCircle" : "xCircle") +
        ctx.esc(u.isBanned ? ctx.t("users.unban") : ctx.t("users.ban"));
      btn.addEventListener("click", async function () {
        var ok = await ctx.confirmDialog(
          ctx.t("dialog.confirmTitle"),
          u.isBanned ? ctx.t("users.unbanConfirm") : ctx.t("users.banConfirm")
        );
        if (!ok) return;
        btn.disabled = true;
        try {
          await ctx.api(u.isBanned ? "users.unban" : "users.ban", u.isBanned ? { id: u.id } : { id: u.id, confirm: true });
          ctx.toast(ctx.t("toast.saved"), "ok");
          setView({ name: "list" });
        } catch (e) {
          ctx.toast(ctx.t("toast.failed"), "err");
          btn.disabled = false;
        }
      });
      el.appendChild(btn);
    }

    paint();
  }

  window.App.registerSection("users", {
    titleKey: "sec.users",
    icon: "users",
    render: render,
  });
})();
