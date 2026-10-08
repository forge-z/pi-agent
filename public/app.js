import { configureUI } from "/settings.js";

const $ = (id) => document.getElementById(id);
let conversationId = null;
let events = null;
let providerFlow = null;
let providerPoll = null;
let promptId = null;
let pendingMessage = null;
let conversationsCache = [];
const mobile = window.matchMedia("(max-width: 760px)");
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}
function readableResult(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const result = parsed?.result ?? parsed;
    if (Array.isArray(result?.content)) {
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");
      if (text) return text;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(raw);
  }
}
function piMark() {
  const img = document.createElement("img");
  img.src = "/pi-logo.svg";
  img.alt = "";
  return img;
}
function sidebar(open, returnFocus = true) {
  const isOpen = open && mobile.matches;
  $("workspace").classList.toggle("sidebar-open", isOpen);
  $("sidebar-backdrop").hidden = !isOpen;
  $("open-sidebar").setAttribute("aria-expanded", String(isOpen));
  $("sidebar").inert = mobile.matches && !isOpen;
  $("main").inert = isOpen;
  if (isOpen) {
    $("sidebar").setAttribute("role", "dialog");
    $("sidebar").setAttribute("aria-modal", "true");
    $("close-sidebar").focus();
  } else {
    $("sidebar").removeAttribute("role");
    $("sidebar").removeAttribute("aria-modal");
    if (returnFocus && mobile.matches) $("open-sidebar").focus();
  }
}
$("open-sidebar").onclick = () => sidebar(true);
$("close-sidebar").onclick = () => sidebar(false);
$("sidebar-backdrop").onclick = () => sidebar(false);
mobile.addEventListener("change", () => sidebar(false, false));
sidebar(false, false);
document.addEventListener("keydown", (event) => {
  if (!$("workspace").classList.contains("sidebar-open")) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.key === "Escape") sidebar(false);
  if (event.key === "Tab") {
    const controls = [
      ...$("sidebar").querySelectorAll("button:not(:disabled), input"),
    ].filter((element) => !element.hidden && element.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
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
  sidebar(false, false);
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("login").hidden = false;
  $("workspace").hidden = true;
  settingsUI.reset();
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
function renderConversations() {
  const query = $("search-conversations").value.toLocaleLowerCase("pt-BR");
  const filtered = conversationsCache.filter((conversation) =>
    conversation.title.toLocaleLowerCase("pt-BR").includes(query),
  );
  $("conversation-count").textContent = conversationsCache.length;
  $("search-empty").hidden = filtered.length > 0;
  $("conversations").replaceChildren();
  for (const conversation of filtered) {
    const button = node("button");
    button.append(
      icon("chat-circle"),
      node("span", conversation.title, "conversation-label"),
    );
    button.title = conversation.title;
    button.setAttribute(
      "aria-current",
      String(conversation.id === conversationId),
    );
    button.onclick = guard(async () => {
      sidebar(false, false);
      await select(conversation.id, conversation.title);
      if (mobile.matches) $("message").focus();
    });
    $("conversations").append(button);
  }
}
$("search-conversations").oninput = renderConversations;
async function loadConversations() {
  conversationsCache = await api("/api/conversations");
  const current = conversationsCache.find(
    (conversation) => conversation.id === conversationId,
  );
  if (current) $("conversation-title").textContent = current.title;
  renderConversations();
  return conversationsCache;
}
async function refreshStatus() {
  const status = await api("/api/status");
  $("banner").replaceChildren();
  if (status.mode === "demo") {
    $("banner").append(
      icon("circle-dashed"),
      node("strong", "Modo demonstração"),
      node("small", "Respostas locais, sem conexão com contas externas."),
    );
  }
  $("model-label").textContent =
    status.mode === "demo" ? "Demonstração" : status.model;
  $("provider-status").textContent = status.credentials
    ? "Conta conectada"
    : status.mode === "demo"
      ? "Modo demonstração"
      : "Use sua conta para começar";
  document.querySelector(".provider-label").textContent =
    status.mode === "demo"
      ? "ChatGPT"
      : status.credentials
        ? "ChatGPT conectado"
        : "Conectar ChatGPT";
  $("provider-button").disabled = status.mode === "demo";
  settingsUI.refreshLabel();
}
async function workspace() {
  $("login").hidden = true;
  $("workspace").hidden = false;
  await refreshStatus();
  await settingsUI.load();
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
  $("search-conversations").value = "";
  sidebar(false, false);
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
  settingsUI.updateConversation(null);
  rendered = "";
  renderedActions = "";
  $("connection").textContent = "Conectando";
  $("connection").dataset.state = "connecting";
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
    if (id !== conversationId) return;
    $("connection").textContent = "Sincronizado";
    $("connection").dataset.state = "connected";
  };
  events.onerror = () => {
    if (id !== conversationId) return;
    $("connection").textContent = "Reconectando…";
    $("connection").dataset.state = "reconnecting";
  };
}
let rendered = "";
let renderedActions = "";
function render(snapshot) {
  const encoded = JSON.stringify(snapshot);
  if (encoded === rendered) return;
  rendered = encoded;
  settingsUI.updateConversation(snapshot.settings);
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
      const isTool = message.role === "toolResult";
      const article = node(
        isTool ? "details" : "article",
        undefined,
        `message ${message.role}`,
      );
      const speaker = node(isTool ? "summary" : "span", undefined, "speaker");
      if (message.role === "assistant") speaker.append(piMark());
      if (isTool) speaker.append(icon("plug"));
      speaker.append(
        node(
          "span",
          message.role === "user"
            ? "Você"
            : message.role === "assistant"
              ? "Pi"
              : `Ferramenta · ${message.toolName}`,
        ),
      );
      article.append(speaker, node("div", blocks, "message-body"));
      messages.push(article);
    }
  const live = snapshot.view.docs["pi.live"];
  const partial = live?.generation?.message;
  if (partial?.content) {
    const article = node("article", undefined, "message assistant live");
    const speaker = node("span", undefined, "speaker");
    speaker.append(piMark(), node("span", "Pi está escrevendo"));
    article.append(
      speaker,
      node(
        "div",
        partial.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join(""),
        "message-body",
      ),
    );
    messages.push(article);
  }
  const empty = messages.length === 0 && snapshot.actions.length === 0;
  $("welcome").hidden = !empty;
  $("suggestions").hidden = !empty;
  $("main-content").classList.toggle("is-empty", empty);
  $("messages").replaceChildren(...messages);
  $("run-status").textContent = live?.run
    ? "Pi está trabalhando…"
    : "Conversa salva";
  const actionLabels = {
    pending: "Aguardando você",
    running: "Em andamento",
    done: "Concluída",
    denied: "Recusada",
    failed: "Não executada",
    uncertain: "Verificar resultado",
    reconciled: "Verificada",
  };
  const actionConversation = conversationId;
  const cards = snapshot.actions.map((action) => {
    const card = node("article", undefined, "action");
    card.dataset.state = action.state;
    const top = node("div", undefined, "action-top");
    const title = node("div");
    title.append(
      node(
        "h3",
        action.tool
          .replace(/[_-]/g, " ")
          .replace(/^./, (letter) => letter.toLocaleUpperCase("pt-BR")),
      ),
      node("p", action.server, "action-service"),
    );
    top.append(
      icon(
        action.state === "done"
          ? "check-circle"
          : action.state === "uncertain"
            ? "warning-circle"
            : "shield-check",
      ),
      title,
      node("span", actionLabels[action.state] || action.state, "action-status"),
    );
    card.append(top);
    if (action.state === "pending")
      card.append(
        node(
          "p",
          "Revise os detalhes. Esta ação só acontece com sua confirmação.",
          "action-note",
        ),
      );
    const details = (label, value, open = false) => {
      const section = node("details");
      section.open = open;
      section.append(node("summary", label), node("pre", value));
      return section;
    };
    card.append(
      details(
        "O que será enviado",
        JSON.stringify(JSON.parse(action.args), null, 2),
        action.state === "pending",
      ),
      details(
        "Contexto consultado antes da ação",
        readableResult(action.evidence),
      ),
      details("Identificador da ação", action.id),
    );
    if (action.result)
      card.append(details("Resultado", readableResult(action.result)));
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
        button.prepend(icon(decision === "approve" ? "check" : "x"));
        button.onclick = guard(async () => {
          button.disabled = true;
          try {
            await api(
              `/api/conversations/${actionConversation}/actions/${action.id}`,
              "POST",
              { decision },
            );
            const updated = await api(
              `/api/conversations/${actionConversation}`,
            );
            if (actionConversation === conversationId) render(updated);
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
          `/api/conversations/${actionConversation}/actions/${action.id}`,
          "POST",
          { decision: "reconcile", note: input.value },
        );
        const updated = await api(`/api/conversations/${actionConversation}`);
        if (actionConversation === conversationId) render(updated);
      });
      card.append(label, input, button);
    }
    return card;
  });
  const nativeInteractions = (snapshot.mcpInteractions || []).filter(
    (i) => i.state === "pending",
  );
  for (const interaction of nativeInteractions) {
    const interactionConversation = conversationId;
    const payload = JSON.parse(interaction.payload);
    const card = node("article", undefined, "action-card");
    const heading = node("div", undefined, "action-heading");
    heading.append(
      icon("shield-check"),
      node("strong", `Solicitação de ${interaction.server}`),
    );
    card.append(
      heading,
      node(
        "p",
        payload.message ||
          payload.interaction?.message ||
          "O servidor MCP aguarda sua decisão.",
        "action-note",
      ),
    );
    const detail = node("details");
    detail.append(
      node("summary", "Detalhes enviados pelo servidor"),
      node("pre", JSON.stringify(payload, null, 2)),
    );
    card.append(detail);
    if (interaction.kind === "url") {
      try {
        const url = new URL(payload.url);
        if (url.protocol === "https:" && !url.username && !url.password) {
          const link = node("a", "Abrir solicitação no serviço");
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          card.append(link);
        }
      } catch {
        /* display details without an unsafe link */
      }
    }
    const form = node("form", undefined, "management-form");
    const inputs = [];
    const schema = payload.requestedSchema;
    if (interaction.kind === "form" && schema?.properties) {
      for (const [name, property] of Object.entries(schema.properties)) {
        const field = node("div", undefined, "form-field");
        const label = node("label", property.title || name);
        let input;
        if (Array.isArray(property.enum)) {
          input = node("select");
          for (const value of property.enum) {
            const option = node("option", String(value));
            option.value = JSON.stringify(value);
            input.append(option);
          }
        } else {
          input = node("input");
          input.type =
            property.type === "boolean"
              ? "checkbox"
              : ["number", "integer"].includes(property.type)
                ? "number"
                : "text";
          if (property.type === "integer") input.step = "1";
          if (property.default !== undefined) {
            if (input.type === "checkbox") input.checked = property.default;
            else
              input.value = ["array", "object"].includes(property.type)
                ? JSON.stringify(property.default)
                : String(property.default);
          }
          if (schema.required?.includes(name) && input.type !== "checkbox")
            input.required = true;
        }
        input.id = `mcp-${interaction.id}-${name}`;
        label.htmlFor = input.id;
        field.append(label, input);
        if (property.description)
          field.append(node("small", property.description));
        form.append(field);
        inputs.push({ name, property, input });
      }
    }
    let customContent;
    if (interaction.kind === "resume") {
      const field = node("div", undefined, "form-field");
      const label = node(
        "label",
        "Resposta ao formulário, se solicitada (JSON)",
      );
      customContent = node("textarea");
      customContent.rows = 3;
      customContent.value = "{}";
      customContent.id = `mcp-content-${interaction.id}`;
      label.htmlFor = customContent.id;
      field.append(label, customContent);
      form.append(field);
    }
    const error = node("p", undefined, "error");
    error.setAttribute("role", "alert");
    const controls = node("div", undefined, "action-buttons");
    const accept = node("button", "Aceitar");
    accept.type = "submit";
    const decide = async (action) => {
      let content;
      if (action === "accept") {
        if (inputs.length) {
          content = {};
          for (const { name, property, input } of inputs) {
            if (input.type === "checkbox") content[name] = input.checked;
            else if (input.value !== "")
              content[name] = Array.isArray(property.enum)
                ? JSON.parse(input.value)
                : ["number", "integer"].includes(property.type)
                  ? Number(input.value)
                  : ["array", "object"].includes(property.type)
                    ? JSON.parse(input.value)
                    : input.value;
          }
        }
        if (customContent) content = JSON.parse(customContent.value || "{}");
      }
      error.textContent = "";
      controls
        .querySelectorAll("button")
        .forEach((button) => (button.disabled = true));
      try {
        await api(
          `/api/conversations/${interactionConversation}/mcp-interactions/${interaction.id}`,
          "POST",
          { action, ...(content ? { content } : {}) },
        );
        const updated = await api(
          `/api/conversations/${interactionConversation}`,
        );
        if (conversationId === interactionConversation) render(updated);
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        controls
          .querySelectorAll("button")
          .forEach((button) => (button.disabled = false));
      }
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      void decide("accept").catch(
        (failure) => (error.textContent = failure.message),
      );
    };
    controls.append(accept);
    for (const [action, title] of [
      ["decline", "Recusar"],
      ["cancel", "Cancelar"],
    ]) {
      const button = node("button", title);
      button.type = "button";
      button.className = "subtle";
      button.onclick = () => {
        void decide(action).catch(
          (failure) => (error.textContent = failure.message),
        );
      };
      controls.append(button);
    }
    form.append(error, controls);
    card.append(form);
    cards.push(card);
  }
  const uncertainCalls = (snapshot.mcpCalls || []).filter(
    (call) => call.state === "uncertain",
  );
  for (const call of uncertainCalls) {
    const callConversation = conversationId;
    const card = node("article", undefined, "action-card");
    card.append(
      node("strong", `${call.server} / ${call.tool}`),
      node(
        "p",
        "Resultado incerto. A chamada não foi reenviada. Verifique no serviço e registre o resultado.",
      ),
    );
    const form = node("form", undefined, "management-form");
    const input = node("input");
    input.required = true;
    input.id = `reconcile-${call.id}`;
    const label = node("label", "Resultado verificado");
    label.htmlFor = input.id;
    const button = node("button", "Registrar resultado");
    button.type = "submit";
    const error = node("p", undefined, "error");
    form.append(label, input, button, error);
    form.onsubmit = (event) => {
      event.preventDefault();
      button.disabled = true;
      void api(
        `/api/conversations/${callConversation}/mcp-calls/${call.id}/reconcile`,
        "POST",
        { note: input.value },
      )
        .then(() => api(`/api/conversations/${callConversation}`))
        .then((updated) => {
          if (conversationId === callConversation) render(updated);
        })
        .catch((failure) => (error.textContent = failure.message))
        .finally(() => (button.disabled = false));
    };
    card.append(form);
    cards.push(card);
  }
  const encodedActions = JSON.stringify([
    snapshot.actions,
    nativeInteractions,
    uncertainCalls,
  ]);
  if (encodedActions !== renderedActions) {
    const drafts = new Map(
      [...$("actions").querySelectorAll("input, textarea, select")]
        .filter((input) => input.id)
        .map((input) => [
          input.id,
          {
            value: input.value,
            checked: input.checked,
            start: input.selectionStart,
            end: input.selectionEnd,
          },
        ]),
    );
    const focused = document.activeElement?.id;
    $("actions").replaceChildren(...cards);
    for (const [id, draft] of drafts) {
      const input = document.getElementById(id);
      if (!input || !$("actions").contains(input)) continue;
      input.value = draft.value;
      if (input.type === "checkbox") input.checked = draft.checked;
      if (id === focused) {
        input.focus();
        if (
          typeof input.setSelectionRange === "function" &&
          draft.start !== null
        ) {
          try {
            input.setSelectionRange(draft.start, draft.end);
          } catch {
            /* select/number fields */
          }
        }
      }
    }
    renderedActions = encodedActions;
  }
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
  $("login-submit").disabled = true;
  try {
    await api("/api/login", "POST", { password: $("password").value });
    $("password").value = "";
    await workspace();
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    $("login-submit").disabled = false;
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
  const sentConversation = conversationId;
  if ($("send").disabled || !content.trim() || !conversationId) return;
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
      `/api/conversations/${sentConversation}/messages`,
      "POST",
      pendingMessage,
    );
    sessionStorage.removeItem(`pending:${sentConversation}`);
    if (sentConversation === conversationId) {
      if ($("message").value === content) $("message").value = "";
      pendingMessage = null;
      const snapshot = await api(`/api/conversations/${sentConversation}`);
      if (sentConversation === conversationId) render(snapshot);
    }
    await loadConversations();
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
  $("copy-link").querySelector("span").textContent = "Copiar comando";
  $("link-code").textContent = `/link ${link.code}`;
  $("link-dialog").showModal();
});
$("copy-link").onclick = guard(async () => {
  await navigator.clipboard.writeText($("link-code").textContent);
  $("copy-link").querySelector("span").textContent = "Comando copiado";
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
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.onclick = () => {
    $("message").value = button.dataset.prompt;
    $("message").focus();
  };
});
let messageComposing = false;
$("message").addEventListener("compositionstart", () => {
  messageComposing = true;
});
$("message").addEventListener("compositionend", () => {
  messageComposing = false;
});
$("message").addEventListener("keydown", (event) => {
  if (
    event.key !== "Enter" ||
    messageComposing ||
    event.isComposing ||
    event.keyCode === 229
  )
    return;
  if (event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const message = $("message");
    const length =
      message.value.length - (message.selectionEnd - message.selectionStart);
    if (message.maxLength >= 0 && length >= message.maxLength) return;
    message.setRangeText(
      "\n",
      message.selectionStart,
      message.selectionEnd,
      "end",
    );
    message.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  // Cmd+Enter keeps its existing send behavior; Shift/Alt+Enter stay native.
  if (event.metaKey || (!event.shiftKey && !event.altKey)) {
    event.preventDefault();
    if (!event.repeat && !$("send").disabled && $("message").value.trim())
      $("message-form").requestSubmit();
  }
});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
const settingsUI = configureUI(api, {
  icon,
  node,
  closeSidebar: () => sidebar(false, false),
  getConversationId: () => conversationId,
  getConversations: () => conversationsCache,
  loadConversations,
  refreshStatus,
  selectConversation: select,
  refreshConversation: async (id) => {
    await loadConversations();
    if (id !== conversationId) return;
    const snapshot = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (id === conversationId) render(snapshot);
  },
});
api("/api/status").then(workspace).catch(showLogin);
