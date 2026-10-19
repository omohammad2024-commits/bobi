/* BOBI Mini App — Chat section.
 * Full-access fallback: any owner command can be typed here. Talks to the
 * `turn` endpoint with conversationId "miniapp".
 */
(function () {
  "use strict";

  const CONVERSATION_ID = "miniapp";

  function render(el, ctx) {
    const st = ctx.state;
    if (!st.messages) {
      try {
        st.messages = JSON.parse(sessionStorage.getItem("bobi-miniapp-chat") || "[]");
      } catch (_) {
        st.messages = [];
      }
    }
    st.sending = st.sending || false;

    el.innerHTML =
      '<div class="chat-wrap">' +
      '<div class="chat-hint">' + ctx.esc(ctx.t("chat.hint")) + "</div>" +
      '<div class="chat-list" id="chatList"></div>' +
      '<div class="chat-inputbar">' +
      '<textarea id="chatInput" rows="1" placeholder="' + ctx.esc(ctx.t("chat.placeholder")) + '"></textarea>' +
      '<button type="button" class="chat-send" id="chatSend" aria-label="' + ctx.esc(ctx.t("chat.send")) + '">➤</button>' +
      "</div></div>";

    const list = document.getElementById("chatList");
    const input = document.getElementById("chatInput");
    const sendBtn = document.getElementById("chatSend");

    function persist() {
      try {
        sessionStorage.setItem("bobi-miniapp-chat", JSON.stringify(st.messages.slice(-100)));
      } catch (_) {}
    }

    function bubble(role, text, isTyping) {
      const d = document.createElement("div");
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

    function paint() {
      list.innerHTML = "";
      for (const m of st.messages) bubble(m.role, m.text);
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
      const text = input.value.trim();
      if (!text || st.sending) return;
      input.value = "";
      st.messages.push({ role: "owner", text: text });
      persist();
      setSending(true);
      try {
        const res = await ctx.api("turn", { conversationId: CONVERSATION_ID, text: text });
        const reply = res && (res.reply !== undefined ? String(res.reply) : "");
        st.messages.push({ role: "bot", text: reply });
      } catch (e) {
        ctx.toast(ctx.t("chat.failed"));
        st.messages.push({ role: "bot", text: "⚠️ " + ctx.t("chat.failed") });
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
      input.style.height = Math.min(120, input.scrollHeight) + "px";
    });

    paint();
  }

  window.App.registerSection("chat", {
    titleKey: "sec.chat",
    icon: "💬",
    render: render,
  });
})();
