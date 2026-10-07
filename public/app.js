const $ = (id) => document.getElementById(id);
let conversationId = null;
let events = null;
let providerFlow = null;
let providerPoll = null;
let promptId = null;
let pendingMessage = null;
async function api(path, method = "GET", data) {
  const response = await fetch(path, {
    method,
    headers: data ? { "content-type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (response.status === 401 && path !== "/api/login") {
    showLogin();
  }
  if (!response.ok)
    throw new Error(result.error || "Falha ao acessar o servidor");
  return result;
}
function showLogin() {
  events?.close();
  $("login").hidden = false;
  $("workspace").hidden = true;
}
function report(error) {
  $("error").textContent = error.message;
}
const guard =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      report(error);
    }
  };
function node(tag, value, cls) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (cls) element.className = cls;
  return element;
}
async function loadConversations() {
  const conversations = await api("/api/conversations");
  $("conversations").replaceChildren();
  for (const conversation of conversations) {
    if (conversation.id === conversationId)
      $("conversation-title").textContent = conversation.title;
    const button = node("button", conversation.title);
    button.setAttribute(
      "aria-current",
      String(conversation.id === conversationId),
    );
    button.onclick = guard(() => select(conversation.id, conversation.title));
    $("conversations").append(button);
  }
  return conversations;
}
async function refreshStatus() {
  const status = await api("/api/status");
  $("banner").textContent =
    status.mode === "demo"
      ? "Modo demonstração · respostas locais, sem conexão com contas externas."
      : `${status.provider} / ${status.model}`;
  $("provider-status").textContent = status.credentials
    ? "ChatGPT conectado"
    : status.mode === "demo"
      ? "Provider em demonstração"
      : "Provider ainda não conectado";
  $("provider-button").disabled = status.mode === "demo";
}
async function workspace() {
  $("login").hidden = true;
  $("workspace").hidden = false;
  await refreshStatus();
  const conversations = await loadConversations();
  const wanted = new URLSearchParams(location.search).get("c");
  const current =
    conversations.find((c) => c.id === wanted) || conversations[0];
  if (current) await select(current.id, current.title);
  else await create();
}
async function create() {
  const conversation = await api("/api/conversations", "POST", {
    title: "Nova conversa",
  });
  await select(conversation.id, "Nova conversa");
}
async function select(id, title) {
  events?.close();
  pendingMessage = JSON.parse(
    sessionStorage.getItem(`pending:${id}`) || "null",
  );
  if (pendingMessage) $("message").value = pendingMessage.text;
  else $("message").value = "";
  conversationId = id;
  rendered = "";
  $("conversation-title").textContent = title;
  history.replaceState(null, "", `?c=${encodeURIComponent(id)}`);
  await loadConversations();
  const snapshot = await api(`/api/conversations/${id}`);
  if (id !== conversationId) return;
  render(snapshot);
  events = new EventSource(`/api/conversations/${id}/events`);
  events.addEventListener("snapshot", (event) => {
    if (id === conversationId) render(JSON.parse(event.data));
  });
  events.onopen = () => {
    $("connection").textContent = "Sincronizado";
  };
  events.onerror = () => {
    $("connection").textContent = "Reconectando…";
  };
}
let rendered = "";
function render(snapshot) {
  const encoded = JSON.stringify(snapshot);
  if (encoded === rendered) return;
  rendered = encoded;
  const container = document.querySelector(".conversation-body");
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  const messages = [];
  for (const entry of snapshot.view.entries)
    for (const message of entry.model || []) {
      if (!["user", "assistant", "toolResult"].includes(message.role)) continue;
      const blocks =
        typeof message.content === "string"
          ? message.content
          : (message.content || [])
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      if (!blocks) continue;
      const article = node("article", undefined, `message ${message.role}`);
      article.append(
        node(
          "span",
          message.role === "user"
            ? "VOCÊ"
            : message.role === "assistant"
              ? "PI"
              : `FERRAMENTA · ${message.toolName}`,
          "speaker",
        ),
        node("div", blocks),
      );
      messages.push(article);
    }
  const live = snapshot.view.docs["pi.live"];
  const partial = live?.generation?.message;
  if (partial?.content) {
    const article = node("article", undefined, "message assistant live");
    article.append(
      node("span", "PI · ESCREVENDO", "speaker"),
      node(
        "div",
        partial.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(""),
      ),
    );
    messages.push(article);
  }
  if (!messages.length) {
    const welcome = node("div", undefined, "welcome");
    welcome.append(
      node("h2", "O que vamos resolver hoje?"),
      node(
        "p",
        "Comece uma conversa. Antes de agir em serviços externos, Pi pede sua confirmação.",
      ),
    );
    messages.push(welcome);
  }
  $("messages").replaceChildren(...messages);
  $("run-status").textContent = live?.run
    ? "Pi está trabalhando · a conversa continua salva"
    : "Histórico salvo no servidor";
  const cards = snapshot.actions.map((action) => {
    const card = node("article", undefined, "action");
    card.append(
      node("h3", `${action.server} / ${action.tool}`),
      node("p", `Ação ${action.id} · ${action.state}`),
      node("pre", JSON.stringify(JSON.parse(action.args), null, 2)),
      node("p", "Contexto lido para esta solicitação:"),
      node("pre", action.evidence),
    );
    if (action.result) card.append(node("pre", action.result));
    if (action.state === "pending") {
      const buttons = node("div", undefined, "action-buttons");
      for (const [decision, label] of [
        ["approve", "Confirmar ação"],
        ["deny", "Recusar"],
      ]) {
        const button = node(
          "button",
          label,
          decision === "deny" ? "subtle" : "",
        );
        button.onclick = guard(async () => {
          button.disabled = true;
          try {
            await api(
              `/api/conversations/${conversationId}/actions/${action.id}`,
              "POST",
              { decision },
            );
            render(await api(`/api/conversations/${conversationId}`));
          } finally {
            button.disabled = false;
          }
        });
        buttons.append(button);
      }
      card.append(buttons);
    } else if (action.state === "uncertain") {
      const label = node("label", "Resultado verificado no serviço externo");
      const input = node("textarea");
      input.id = `note-${action.id}`;
      label.htmlFor = input.id;
      const button = node("button", "Registrar resultado");
      button.onclick = guard(async () => {
        await api(
          `/api/conversations/${conversationId}/actions/${action.id}`,
          "POST",
          { decision: "reconcile", note: input.value },
        );
        render(await api(`/api/conversations/${conversationId}`));
      });
      card.append(label, input, button);
    }
    return card;
  });
  $("actions").replaceChildren(...cards);
  $("deliveries").replaceChildren(
    ...snapshot.deliveries
      .filter((d) => d.state === "uncertain")
      .map((d) =>
        node(
          "p",
          `Entrega ${d.id} incerta. Verifique o Telegram; não será reenviada automaticamente.`,
        ),
      ),
  );
  if (nearBottom) container.scrollTop = container.scrollHeight;
}
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", "POST", { password: $("password").value });
    $("password").value = "";
    await workspace();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
};
$("new-conversation").onclick = guard(create);
$("logout").onclick = guard(async () => {
  await api("/api/logout", "POST", {});
  showLogin();
});
$("message-form").onsubmit = guard(async (event) => {
  event.preventDefault();
  const content = $("message").value;
  if (!content.trim() || !conversationId) return;
  if (
    !pendingMessage ||
    pendingMessage.text !== content ||
    pendingMessage.conversationId !== conversationId
  )
    pendingMessage = {
      text: content,
      requestId: crypto.randomUUID(),
      conversationId,
    };
  sessionStorage.setItem(
    `pending:${conversationId}`,
    JSON.stringify(pendingMessage),
  );
  $("send").disabled = true;
  $("error").textContent = "";
  try {
    await api(
      `/api/conversations/${conversationId}/messages`,
      "POST",
      pendingMessage,
    );
    $("message").value = "";
    sessionStorage.removeItem(`pending:${conversationId}`);
    pendingMessage = null;
    await loadConversations();
    render(await api(`/api/conversations/${conversationId}`));
  } finally {
    $("send").disabled = false;
  }
});
$("link-button").onclick = guard(async () => {
  const link = await api(
    `/api/conversations/${conversationId}/link`,
    "POST",
    {},
  );
  $("link-code").textContent = `/link ${link.code}`;
  $("link-dialog").showModal();
});
$("copy-link").onclick = guard(async () => {
  await navigator.clipboard.writeText($("link-code").textContent);
  $("copy-link").textContent = "Copiado";
});
$("provider-button").onclick = guard(async () => {
  const flow = await api("/api/provider/login", "POST", {});
  providerFlow = flow.id;
  $("provider-dialog").showModal();
  const poll = async () => {
    const state = await api(`/api/provider/login/${providerFlow}`);
    $("auth-state").textContent =
      state.state === "done"
        ? "ChatGPT conectado."
        : state.state === "failed"
          ? "Login não concluído. Tente novamente."
          : "Continue o login no link do provider.";
    const notices = [];
    for (const event of state.events) {
      if (event.type === "auth_url" || event.type === "device_code") {
        const link = node(
          "a",
          event.type === "device_code"
            ? `Abrir provider · código ${event.userCode}`
            : "Abrir login OpenAI",
        );
        link.href = event.url || event.verificationUri;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        notices.push(link);
      } else if (event.message) notices.push(node("p", event.message));
    }
    $("auth-events").replaceChildren(...notices);
    $("auth-form").hidden = !state.prompt;
    promptId = state.prompt?.id;
    if (state.prompt) $("auth-label").textContent = state.prompt.message;
    if (["done", "failed"].includes(state.state)) {
      clearInterval(providerPoll);
      providerPoll = null;
      await refreshStatus();
    }
  };
  providerPoll = setInterval(() => guard(poll)(), 1000);
  await poll();
});
$("auth-form").onsubmit = guard(async (event) => {
  event.preventDefault();
  await api(`/api/provider/login/${providerFlow}`, "POST", {
    promptId,
    value: $("auth-value").value,
  });
  $("auth-value").value = "";
  $("auth-form").hidden = true;
});
async function cancelAuth() {
  clearInterval(providerPoll);
  providerPoll = null;
  if (providerFlow) await api(`/api/provider/login/${providerFlow}`, "DELETE");
  providerFlow = null;
}
$("cancel-auth").onclick = guard(async () => {
  await cancelAuth();
  $("provider-dialog").close();
});
$("provider-dialog").addEventListener("cancel", () => {
  void guard(cancelAuth)();
});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
api("/api/status").then(workspace).catch(showLogin);
