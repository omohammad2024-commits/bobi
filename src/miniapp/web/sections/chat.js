/* BOBI Mini App — Chat section.
 * Full-access fallback: any owner command can be typed here. Talks to the
 * `turn` endpoint with conversationId "miniapp".
 */
(function () {
  "use strict";

  var CONVERSATION_ID = "miniapp";

  function render(el, ctx) {
    var st = ctx.state;
    if (!st.messages) {
      try {
        st.messages = JSON.parse(sessionStorage.getItem("bobi-miniapp-chat") || "[]");
      } catch (_) {
        st.messages = [];
      }
    }
    st.sending = st.sending || false;

    el.innerHTML =
      ctx.pageHead("chat", ctx.t("sec.chat"), ctx.t("chat.sub")) +
      '<div class="chat-wrap">' +
      '<div class="chat-hint">' + ctx.icon("info") + "<span>" + ctx.esc(ctx.t("chat.hint")) + "</span></div>" +
      '<div class="chat-list" id="chatList"></div>' +
      '<div class="chat-inputbar">' +
      '<textarea id="chatInput" rows="1" placeholder="' + ctx.esc(ctx.t("chat.placeholder")) + '"></textarea>' +
      '<button type="button" class="chat-send" id="chatSend" aria-label="' + ctx.esc(ctx.t("chat.send")) + '">' +
      ctx.icon("send") + "</button>" +
      "</div></div>";

    var list = document.getElementById("chatList");
    var input = document.getElementById("chatInput");
    var sendBtn = document.getElementById("chatSend");

    function persist() {
      try {
        sessionStorage.setItem("bobi-miniapp-chat", JSON.stringify(st.messages.slice(-100)));
      } catch (_) {}
    }

    function bubble(role, text, isTyping) {
      var d = document.createElement("div");
      d.className = "msg " + role + (isTyping ? " typing" : "");
      if (isTyping) {
        d.innerHTML = "<span></span><span></span><span></span>";
        d.setAttribute("aria-label", ctx.t("chat.typing"));
      } else {
        d.textContent = text;
      }
      list.appendChild(d);
      return d;
    }

    // ctx.t returns the key itself when a string is missing; fall back to
    // the inline English copy so the hero never renders a raw key.
    function tOr(key, fallback) {
      var v = ctx.t(key);
      return v === key ? fallback : v;
    }

    function hero() {
      var d = document.createElement("div");
      d.className = "chat-hero";
      d.innerHTML =
        '<div class="chat-hero-inner">' +
        '<span class="orb orb-lg"></span>' +
        '<h2 class="chat-hero-title">' + ctx.esc(tOr("chat.heroTitle", "What's on your mind today?")) + "</h2>" +
        '<p class="chat-hero-sub">' + ctx.esc(tOr("chat.heroSub", "Ask me anything — every command works here.")) + "</p>" +
        "</div>";
      list.appendChild(d);
    }

    function paint() {
      list.innerHTML = "";
      if (st.messages.length === 0 && !st.sending) hero();
      for (var i = 0; i < st.messages.length; i++) bubble(st.messages[i].role, st.messages[i].text);
      if (st.sending) bubble("bot", "", true);
      list.scrollTop = list.scrollHeight;
    }

    function setSending(v) {
      st.sending = v;
      paint();
      input.disabled = v;
      sendBtn.disabled = v;
    }

    async function send() {
      var text = input.value.trim();
      if (!text || st.sending) return;
      input.value = "";
      input.style.height = "auto";
      st.messages.push({ role: "owner", text: text });
      persist();
      setSending(true);
      try {
        var res = await ctx.api("turn", { conversationId: CONVERSATION_ID, text: text });
        var reply = res && (res.reply !== undefined ? String(res.reply) : "");
        st.messages.push({ role: "bot", text: reply });
      } catch (e) {
        ctx.toast(ctx.t("chat.failed"), "err");
        st.messages.push({ role: "bot", text: ctx.t("chat.failed") });
      }
      persist();
      setSending(false);
    }

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    // Auto-grow the textarea a little.
    input.addEventListener("input", function () {
      input.style.height = "auto";
      input.style.height = Math.min(130, input.scrollHeight) + "px";
    });

    paint();
  }

  if (typeof window !== "undefined" && typeof window.__registerSectionStrings === "function") {
    window.__registerSectionStrings({
      "chat.sub": "Talk to BOBI directly — every bot command works here.",
      "chat.heroTitle": "What's on your mind today?",
      "chat.heroSub": "Ask me anything — every command works here.",
    });
  }

  window.App.registerSection("chat", {
    titleKey: "sec.chat",
    icon: "chat",
    render: render,
  });
})();
