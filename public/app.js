const { errorText, t, text, attr, plain, locale } = globalThis.PiI18n || {
  errorText: (source) => source,
  t: (source, values = []) =>
    source.replace(/\{(\d+)\}/g, (match, index) =>
      index < values.length ? String(values[index]) : match,
    ),
  text: (element, render) => {
    element.textContent = typeof render === "function" ? render() : render;
    return element;
  },
  attr: (element, name, render) =>
    element.setAttribute(
      name,
      typeof render === "function" ? render() : render,
    ),
  plain: (element, value) => {
    element.textContent = value;
  },
  locale: () => "pt-BR",
};
import { configureUI } from "/settings.js";
import { renderMarkdown, renderTextPreview } from "/markdown.js";
import { historyWindow } from "/history.js";
import { attachConversationManagementUI } from "/conversations.js";
import {
  canDispatchCommandResult,
  createSlashAutocomplete,
  refreshConversationSnapshot,
} from "/commands.js";
import { attachTelegramUI } from "/telegram.js";
import {
  attachToolVisibility,
  attachToolBody,
  createToolCalls,
  toolResultNeedsAttention,
} from "/tools.js";

const $ = (id) => document.getElementById(id);
const toolVisibility = attachToolVisibility({
  button: $("tool-visibility-button"),
  messages: $("messages"),
});
let conversationId = null;
let events = null;
let providerFlow = null;
let providerPoll = null;
let promptId = null;
let pendingMessage = null;
let conversationsCache = [];
let conversationManagementUI = null;
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
  if (!response.ok) {
    const error = new Error(result.error || "Falha ao acessar o servidor");
    error.status = response.status;
    throw error;
  }
  return result;
}
function showLogin() {
  events?.close();
  rendered = null;
  lastSnapshot = null;
  historyNodes.clear();
  historyNavigation = null;
  $("messages").replaceChildren();
  slashAutocomplete.close();
  clearCommandPolls();
  sidebar(false, false);
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("login").hidden = false;
  $("workspace").hidden = true;
  settingsUI.reset();
}
function report(error) {
  text($("error"), () => errorText(error.message));
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
  if (value !== undefined) plain(element, value);
  if (cls) element.className = cls;
  return element;
}
function uiNode(tag, render, cls) {
  return text(node(tag, undefined, cls), render);
}
const slashAutocomplete = createSlashAutocomplete({
  api,
  document,
  input: $("message"),
  list: $("command-suggestions"),
});
$("message").addEventListener("input", () => slashAutocomplete.update());
function refreshCurrentConversation(id) {
  return refreshConversationSnapshot(id, {
    getConversationId: () => conversationId,
    loadConversations,
    api,
    render,
  });
}
let compactCommandPoll = null;
let commandTasksPoll = null;
let activeCompactRequest = null;
function clearCommandPolls() {
  clearInterval(compactCommandPoll);
  clearInterval(commandTasksPoll);
  compactCommandPoll = null;
  commandTasksPoll = null;
  activeCompactRequest = null;
}
const commandStatusLabels = {
  accepted: "Aceito",
  pending: "Pendente",
  running: "Em execução",
  waiting: "Aguardando",
  completing: "Finalizando",
  completed: "Concluído",
  aborted: "Interrompido",
  faulted: "Com falha",
  orphaned: "Sem processo",
  uncertain: "Incerto",
  noop: "Sem alterações",
};
function commandStatusRaw(status) {
  if (status === undefined || status === null || status === "") return "";
  if (typeof status === "string" || typeof status === "number")
    return String(status);
  return status.state || status.status || JSON.stringify(status);
}
function commandStatusText(status) {
  const value = commandStatusRaw(status);
  if (!value) return t("Status não informado");
  return t(commandStatusLabels[value.toLocaleLowerCase()] || value);
}
function localizeCommandText(text, status) {
  if (typeof text !== "string" || !text) return "";
  const raw = commandStatusRaw(status);
  const label = raw && t(commandStatusLabels[raw.toLocaleLowerCase()] || "");
  if (!label) return text;
  return text.replace(new RegExp(`\\b${raw}\\b`, "gi"), label);
}
function isUncertainCommandResult(result) {
  return commandStatusRaw(result.status).toLocaleLowerCase() === "uncertain";
}
function showUncertainCommandResult(result) {
  const command = String(result.command || "comando").replace(/^\/+/, "");
  const content = [];
  if (result.taskId) content.push(commandResultCard("Tarefa", result.taskId));
  if (result.data !== undefined)
    content.push(commandResultCard("Detalhes", result.data));
  showCommandResults({
    iconName: "warning-circle",
    eyebrow: "RESULTADO INCERTO",
    title: "Não foi possível confirmar o resultado.",
    intro: () =>
      localizeCommandText(result.text, result.status) ||
      t("O comando /{0} não será repetido automaticamente.", [command]),
    content: [
      commandResultCard("Status", () => commandStatusText(result.status)),
      ...content,
    ],
  });
}
function prettyCommandData(data) {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
function showCommandResults({
  iconName,
  eyebrow,
  title,
  intro,
  content = [],
  preserveCompactPoll = false,
  titleIsData = false,
}) {
  slashAutocomplete.close();
  sidebar(false, false);
  if (!preserveCompactPoll) {
    clearInterval(compactCommandPoll);
    compactCommandPoll = null;
    activeCompactRequest = null;
  }
  $("command-results-icon").replaceChildren(icon(iconName || "asterisk"));
  text($("command-results-eyebrow"), () => t(eyebrow || "COMANDO DO PI"));
  if (titleIsData) plain($("command-results-title"), title || "");
  else text($("command-results-title"), () => t(title || "Resultado"));
  text(
    $("command-results-intro"),
    typeof intro === "function" ? intro : () => t(intro || ""),
  );
  $("command-results-body").replaceChildren(...content);
  if (!$("command-results-dialog").open)
    $("command-results-dialog").showModal();
}
function commandResultCard(label, value) {
  const card = node("section", undefined, "command-result-card");
  card.append(uiNode("strong", () => t(label)));
  if (typeof value === "function")
    card.append(uiNode("p", value, "command-result-value"));
  else if (typeof value === "string" || typeof value === "number")
    card.append(node("p", String(value), "command-result-value"));
  else card.append(node("pre", prettyCommandData(value)));
  return card;
}
async function showHelpResult(result, sourceConversation) {
  const commands = await slashAutocomplete.getCommands();
  if (sourceConversation !== conversationId) return;
  const body = commands.map((command) => {
    const item = node("article", undefined, "command-help-item");
    const heading = node("div", undefined, "command-help-heading");
    heading.append(
      node("strong", `/${String(command.name).replace(/^\/+/, "")}`),
      node("code", command.usage || `/${command.name}`),
    );
    item.append(heading);
    item.append(uiNode("p", () => t(command.description || "")));
    return item;
  });
  if (!body.length && result.data !== undefined)
    body.push(commandResultCard("Ajuda", result.data));
  showCommandResults({
    iconName: "lightbulb",
    eyebrow: "AJUDA RÁPIDA",
    title: "Comandos do Pi.",
    intro:
      "Digite / no início da mensagem para encontrar e escolher um comando. //texto envia /texto literalmente. /agents lista conversas existentes e não cria agentes; /stop preserva as próximas rotinas agendadas.",
    content: body,
  });
}
async function openAgentConversation(agent) {
  const sourceConversation = conversationId;
  if (!sourceConversation) return;
  const requestId = crypto.randomUUID();
  const response = await api(
    `/api/conversations/${encodeURIComponent(sourceConversation)}/messages`,
    "POST",
    {
      text: `/agents ${agent.id}`,
      requestId,
      conversationId: sourceConversation,
    },
  );
  if (response?.kind !== "command") return;
  await loadConversations();
  const sourceStillAvailable = conversationsCache.some(
    (item) => item.id === sourceConversation,
  );
  if (
    !canDispatchCommandResult(
      "agents",
      true,
      sourceConversation,
      conversationId,
      sourceStillAvailable,
    )
  )
    return;
  if (isUncertainCommandResult(response)) {
    showUncertainCommandResult(response);
    return;
  }
  const targetId = response.conversationId;
  const target = conversationsCache.find((item) => item.id === targetId);
  if (target && targetId !== conversationId) {
    await select(targetId, target.title || agent.title || "Agente");
  } else if (response.text) {
    showCommandResults({
      iconName: "check-circle",
      eyebrow: "CONVERSA",
      title: agent.title || agent.id,
      titleIsData: true,
      intro: response.text,
    });
  }
}
function showAgentPicker(result) {
  const agents = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.agents)
      ? result.agents
      : [];
  const body = agents.map((agent) => {
    const button = node("button", undefined, "command-agent-choice");
    button.type = "button";
    const label = node("span");
    label.append(
      node("strong", agent.title || agent.id),
      node("small", agent.id),
    );
    button.append(label, icon("arrow-right"));
    button.onclick = guard(async () => {
      button.disabled = true;
      $("command-results-dialog").close();
      await openAgentConversation(agent);
    });
    return button;
  });
  if (!body.length)
    body.push(
      uiNode("p", () => t("Nenhum agente está disponível para esta conta.")),
    );
  showCommandResults({
    iconName: "asterisk",
    eyebrow: "CONVERSAS DISPONÍVEIS",
    title: "Escolha uma conversa.",
    intro: "Abra uma conversa existente para continuar por aqui.",
    content: body,
  });
}
function compactStatusIsTerminal(status) {
  const value =
    typeof status === "string"
      ? status.toLocaleLowerCase()
      : String(status?.state || status?.status || "").toLocaleLowerCase();
  return [
    "completed",
    "aborted",
    "faulted",
    "orphaned",
    "noop",
    "uncertain",
  ].includes(value);
}
function renderCompactResult(result, preserveCompactPoll = false) {
  const content = [
    commandResultCard("Status recebido", () =>
      commandStatusText(result.status),
    ),
  ];
  if (result.taskId) content.push(commandResultCard("Tarefa", result.taskId));
  if (result.data !== undefined)
    content.push(commandResultCard("Resultado aceito", result.data));
  showCommandResults({
    iconName: "check-circle",
    eyebrow: "COMPACTAÇÃO",
    title: "Pedido de compactação.",
    intro:
      localizeCommandText(result.text, result.status) ||
      "Status informado pelo servidor; esta tela atualiza pela consulta de status.",
    content,
    preserveCompactPoll,
  });
}
function pollCompactStatus(conversation, requestId, initial) {
  const dialog = $("command-results-dialog");
  if (compactStatusIsTerminal(initial.status)) return;
  activeCompactRequest = `${conversation}:${requestId}`;
  const refresh = guard(async () => {
    if (!dialog.open || activeCompactRequest !== `${conversation}:${requestId}`)
      return;
    const latest = await api(
      `/api/conversations/${encodeURIComponent(conversation)}/commands/${encodeURIComponent(requestId)}`,
    );
    if (!dialog.open || activeCompactRequest !== `${conversation}:${requestId}`)
      return;
    const updated = { ...initial, ...latest };
    renderCompactResult(updated, true);
    if (compactStatusIsTerminal(updated.status)) {
      clearInterval(compactCommandPoll);
      compactCommandPoll = null;
    }
  });
  compactCommandPoll = setInterval(refresh, 1800);
}
function renderCommandTasks(tasks) {
  const list = $("command-tasks-list");
  if (!tasks.length) {
    list.replaceChildren(
      uiNode(
        "p",
        () => t("Nenhuma execução ativa no Pi."),
        "command-task-empty",
      ),
    );
    return;
  }
  list.replaceChildren(
    ...tasks.map((task) => {
      const item = node("article", undefined, "command-task-item");
      item.append(node("strong", task.title || task.kind || task.id));
      const meta = node("div", undefined, "command-task-meta");
      const values = [
        task.status ? () => commandStatusText(task.status) : null,
        task.phase ? () => commandStatusText(task.phase) : null,
        task.conversationId
          ? () => t("Conversa {0}", [task.conversationId])
          : null,
        () => t(task.background ? "Em segundo plano" : "Em conversa"),
        task.abortRequested ? () => t("Cancelamento solicitado") : null,
      ];
      for (const value of values) if (value) meta.append(uiNode("span", value));
      item.append(meta);
      if (task.id) item.append(uiNode("p", () => t("ID {0}", [task.id])));
      return item;
    }),
  );
}
async function refreshCommandTasks() {
  const dialog = $("command-tasks-dialog");
  if (!dialog.open) return;
  plain($("command-tasks-error"), "");
  const response = await api("/api/commands/tasks");
  if (!dialog.open) return;
  const tasks = Array.isArray(response) ? response : response.tasks || [];
  renderCommandTasks(tasks);
  const updatedAt = new Date();
  text($("command-tasks-updated"), () =>
    t("Atualizado às {0}", [
      updatedAt.toLocaleTimeString(locale(), {
        hour: "2-digit",
        minute: "2-digit",
      }),
    ]),
  );
}
async function openCommandTasks() {
  clearInterval(commandTasksPoll);
  commandTasksPoll = null;
  sidebar(false, false);
  const dialog = $("command-tasks-dialog");
  dialog.showModal();
  try {
    await refreshCommandTasks();
  } catch (error) {
    text($("command-tasks-error"), () => errorText(error.message));
  }
  if (dialog.open)
    commandTasksPoll = setInterval(() => {
      void refreshCommandTasks().catch((error) => {
        if (dialog.open)
          text($("command-tasks-error"), () => errorText(error.message));
      });
    }, 3500);
}
$("command-results-dialog").addEventListener("close", () => {
  clearInterval(compactCommandPoll);
  compactCommandPoll = null;
  activeCompactRequest = null;
});
$("command-tasks-dialog").addEventListener("close", () => {
  clearInterval(commandTasksPoll);
  commandTasksPoll = null;
});
$("command-tasks-refresh").onclick = () => {
  void refreshCommandTasks().catch((error) => {
    text($("command-tasks-error"), () => errorText(error.message));
  });
};
async function handleCommandResult(
  result,
  requestId,
  sourceConversation,
  submittedText,
) {
  const command = String(result.command || "").replace(/^\/+/, "");
  const args = String(submittedText || "")
    .trim()
    .split(/\s+/)
    .slice(1);
  const hasArgs = args.some(Boolean);
  if (command === "agents" && hasArgs) {
    await loadConversations();
    const sourceStillAvailable = conversationsCache.some(
      (item) => item.id === sourceConversation,
    );
    if (
      !canDispatchCommandResult(
        command,
        hasArgs,
        sourceConversation,
        conversationId,
        sourceStillAvailable,
      )
    )
      return;
    if (isUncertainCommandResult(result)) {
      showUncertainCommandResult(result);
      return;
    }
    const targetId = result.conversationId;
    const target = conversationsCache.find((item) => item.id === targetId);
    if (target && targetId !== conversationId)
      await select(targetId, target.title || "Agente");
    return;
  }
  if (
    !canDispatchCommandResult(
      command,
      hasArgs,
      sourceConversation,
      conversationId,
    )
  )
    return;
  if (isUncertainCommandResult(result)) {
    showUncertainCommandResult(result);
    return;
  }
  if (command === "agents" && !hasArgs) {
    showAgentPicker(result);
    return;
  }
  if ((command === "model" || command === "thinking") && !hasArgs) {
    $("model-label").click();
    return;
  }
  if (command === "model" || command === "thinking") {
    await refreshCurrentConversation(
      result.conversationId || sourceConversation,
    );
    return;
  }
  if (command === "crons") {
    $("tasks-button").click();
    return;
  }
  if (command === "tasks") {
    await openCommandTasks();
    return;
  }
  if (command === "help") {
    await showHelpResult(result, sourceConversation);
    return;
  }
  if (command === "compact") {
    renderCompactResult(result);
    pollCompactStatus(sourceConversation, requestId, result);
    return;
  }
  const commandStatus = result.status;
  showCommandResults({
    iconName: command === "stop" ? "check-circle" : "asterisk",
    eyebrow: `/${command || "comando"}`,
    title: command === "stop" ? "Solicitação recebida." : "Comando concluído.",
    intro:
      localizeCommandText(result.text, commandStatus) ||
      (commandStatus === undefined
        ? ""
        : `Status: ${commandStatusText(commandStatus)}`),
    content: [
      ...(result.taskId ? [commandResultCard("Tarefa", result.taskId)] : []),
      ...(result.data === undefined
        ? []
        : [commandResultCard("Resultado", result.data)]),
    ],
  });
}
function renderConversations() {
  conversationManagementUI?.render(conversationsCache);
}
async function loadConversations() {
  conversationsCache = await api("/api/conversations");
  const current = conversationsCache.find(
    (conversation) => conversation.id === conversationId,
  );
  if (current) plain($("conversation-title"), current.title);
  renderConversations();
  return conversationsCache;
}
async function refreshStatus() {
  const status = await api("/api/status");
  $("banner").replaceChildren();
  if (status.mode === "demo") {
    $("banner").append(
      icon("circle-dashed"),
      uiNode("strong", () => t("Modo demonstração")),
      uiNode("small", () =>
        t("Respostas locais, sem conexão com contas externas."),
      ),
    );
  }
  text($("model-label"), () =>
    status.mode === "demo" ? t("Demonstração") : status.model,
  );
  text($("provider-status"), () =>
    status.credentials
      ? t("Conta conectada")
      : status.mode === "demo"
        ? t("Modo demonstração")
        : t("Use sua conta para começar"),
  );
  text(document.querySelector(".provider-label"), () =>
    status.mode === "demo"
      ? "ChatGPT"
      : status.credentials
        ? t("ChatGPT conectado")
        : t("Conectar ChatGPT"),
  );
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
  conversationManagementUI?.showActiveView();
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
  rendered = null;
  renderedActions = "";
  historyNodes.clear();
  historyNavigation = null;
  historyPage = 0;
  lastSnapshot = null;
  text($("connection"), () => t("Conectando"));
  $("connection").dataset.state = "connecting";
  plain($("conversation-title"), title);
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
    text($("connection"), () => t("Sincronizado"));
    $("connection").dataset.state = "connected";
  };
  events.onerror = () => {
    if (id !== conversationId) return;
    text($("connection"), () => t("Reconectando…"));
    $("connection").dataset.state = "reconnecting";
  };
}
let rendered = null;
let renderedActions = "";
let historyPage = 0;
let lastSnapshot = null;
// Durable transcript entries are immutable; cache only the visible page.
const historyNodes = new Map();
let historyNavigation = null;
function render(snapshot) {
  if (snapshot === rendered) return;
  rendered = snapshot;
  lastSnapshot = snapshot;
  settingsUI.updateConversation(snapshot.settings);
  const container = document.querySelector(".conversation-body");
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  const messages = [];
  const page = historyWindow(snapshot.view.entries, historyPage);
  historyPage = page.page;
  if (page.pages > 1) {
    if (!historyNavigation) {
      const navigation = node("nav", undefined, "history-navigation");
      attr(navigation, "aria-label", () => t("Histórico da conversa"));
      const older = uiNode("button", () => t("Ver anteriores"));
      const newer = uiNode("button", () => t("Ver mais recentes"));
      const label = node("span");
      const change = (next) => {
        historyPage = next;
        rendered = null;
        render(lastSnapshot);
        container.scrollTop = 0;
      };
      older.onclick = () => change(historyPage + 1);
      newer.onclick = () => change(historyPage - 1);
      navigation.append(older, label, newer);
      historyNavigation = { navigation, older, newer, label };
    }
    historyNavigation.older.disabled = page.page >= page.pages - 1;
    historyNavigation.newer.disabled = page.page === 0;
    plain(historyNavigation.label, `${page.page + 1} / ${page.pages}`);
    messages.push(historyNavigation.navigation);
  }
  for (const key of historyNodes.keys())
    if (!page.keys.includes(key)) historyNodes.delete(key);
  for (const [index, message] of page.messages.entries()) {
    const key = page.keys[index];
    if (key && historyNodes.has(key)) {
      messages.push(...historyNodes.get(key));
      continue;
    }
    const start = messages.length;
    if (!["user", "assistant", "toolResult"].includes(message.role)) continue;
    if (message.role === "assistant")
      messages.push(
        ...createToolCalls(message.content, {
          document,
          icon,
          renderText: renderTextPreview,
        }),
      );
    const blocks =
      typeof message.content === "string"
        ? message.content
        : (message.content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    if (!blocks) {
      if (key) historyNodes.set(key, messages.slice(start));
      continue;
    }
    const isTool = message.role === "toolResult";
    const article = node(
      isTool ? "details" : "article",
      undefined,
      `message ${message.role}`,
    );
    if (isTool) {
      article.dataset.toolDetail = "";
      if (toolResultNeedsAttention(message)) {
        article.dataset.toolImportant = "true";
        article.open = !!message.isError;
      }
    }
    const speaker = node(isTool ? "summary" : "span", undefined, "speaker");
    if (message.role === "assistant") speaker.append(piMark());
    if (isTool) speaker.append(icon("plug"));
    speaker.append(
      uiNode("span", () =>
        message.role === "user"
          ? t("Você")
          : message.role === "assistant"
            ? "Pi"
            : t("Ferramenta · {0}", [message.toolName]),
      ),
    );
    const body = node("div", undefined, "message-body");
    if (isTool) attachToolBody(article, body, () => renderTextPreview(blocks));
    else if (message.role === "user" && blocks.length <= 32768)
      plain(body, blocks);
    else body.append(renderMarkdown(blocks));
    article.append(speaker, body);
    messages.push(article);
    if (key) historyNodes.set(key, messages.slice(start));
  }
  const live = snapshot.view.docs["pi.live"];
  const partial = live?.generation?.message;
  if (partial?.content && historyPage === 0) {
    messages.push(
      ...createToolCalls(partial.content, {
        document,
        icon,
        live: true,
        renderText: renderTextPreview,
      }),
    );
    const partialText = partial.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (partialText) {
      const article = node("article", undefined, "message assistant live");
      const speaker = node("span", undefined, "speaker");
      speaker.append(
        piMark(),
        uiNode("span", () => t("Pi está escrevendo")),
      );
      const body = node("div", undefined, "message-body");
      body.append(renderMarkdown(partialText));
      article.append(speaker, body);
      messages.push(article);
    }
  }
  const empty =
    page.total === 0 && !partial?.content && snapshot.actions.length === 0;
  $("welcome").hidden = !empty;
  $("suggestions").hidden = !empty;
  $("main-content").classList.toggle("is-empty", empty);
  $("messages").replaceChildren(...messages);
  toolVisibility.apply();
  text($("run-status"), () =>
    live?.run ? t("Pi está trabalhando…") : t("Conversa salva"),
  );
  const actionLabels = {
    pending: "Aguardando você",
    running: "Em andamento",
    done: "Concluída",
    denied: "Recusada",
    failed: "Não executada",
    uncertain: "Verificar resultado",
    reconciled: "Verificada",
  };
  const actionSource = JSON.stringify([
    snapshot.actions,
    (snapshot.mcpInteractions || []).filter((i) => i.state === "pending"),
    (snapshot.mcpCalls || []).filter((call) => call.state === "uncertain"),
  ]);
  if (actionSource !== renderedActions) {
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
        uiNode(
          "span",
          () => t(actionLabels[action.state] || action.state),
          "action-status",
        ),
      );
      card.append(top);
      if (action.state === "pending")
        card.append(
          uiNode(
            "p",
            () =>
              t(
                "Revise os detalhes. Esta ação só acontece com sua confirmação.",
              ),
            "action-note",
          ),
        );
      const details = (label, value, open = false) => {
        const section = node("details");
        section.open = open;
        const body = node("div", undefined, "message-body");
        section.append(
          uiNode("summary", () => t(label)),
          body,
        );
        attachToolBody(section, body, () =>
          renderTextPreview(typeof value === "function" ? value() : value),
        );
        return section;
      };
      card.append(
        details(
          "O que será enviado",
          () => JSON.stringify(JSON.parse(action.args), null, 2),
          action.state === "pending",
        ),
        details("Contexto consultado antes da ação", () =>
          readableResult(action.evidence),
        ),
        details("Identificador da ação", action.id),
      );
      if (action.result)
        card.append(details("Resultado", () => readableResult(action.result)));
      if (action.state === "pending") {
        const buttons = node("div", undefined, "action-buttons");
        for (const [decision, label] of [
          ["approve", "Confirmar ação"],
          ["deny", "Recusar"],
        ]) {
          const button = uiNode(
            "button",
            () => t(label),
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
        const label = uiNode("label", () =>
          t("Resultado verificado no serviço externo"),
        );
        const input = node("textarea");
        input.id = `note-${action.id}`;
        label.htmlFor = input.id;
        const button = uiNode("button", () => t("Registrar resultado"));
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
        uiNode("strong", () => t("Solicitação de {0}", [interaction.server])),
      );
      card.append(
        heading,
        uiNode(
          "p",
          () =>
            payload.message ||
            payload.interaction?.message ||
            t("O servidor MCP aguarda sua decisão."),
          "action-note",
        ),
      );
      const detail = node("details");
      detail.append(
        uiNode("summary", () => t("Detalhes enviados pelo servidor")),
        node("pre", JSON.stringify(payload, null, 2)),
      );
      card.append(detail);
      if (interaction.kind === "url") {
        try {
          const url = new URL(payload.url);
          if (url.protocol === "https:" && !url.username && !url.password) {
            const link = uiNode("a", () => t("Abrir solicitação no serviço"));
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
        const label = uiNode("label", () =>
          t("Resposta ao formulário, se solicitada (JSON)"),
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
      const accept = uiNode("button", () => t("Aceitar"));
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
        plain(error, "");
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
          text(error, () => errorText(failure.message));
        } finally {
          controls
            .querySelectorAll("button")
            .forEach((button) => (button.disabled = false));
        }
      };
      form.onsubmit = (event) => {
        event.preventDefault();
        void decide("accept").catch((failure) =>
          text(error, () => errorText(failure.message)),
        );
      };
      controls.append(accept);
      for (const [action, title] of [
        ["decline", "Recusar"],
        ["cancel", "Cancelar"],
      ]) {
        const button = uiNode("button", () => t(title));
        button.type = "button";
        button.className = "subtle";
        button.onclick = () => {
          void decide(action).catch((failure) =>
            text(error, () => errorText(failure.message)),
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
    const safeMcpErrors = new Set([
      "MCP recusou a autenticação (HTTP 401). Verifique o token ou o método de login exigido pelo servidor.",
      "MCP recusou a autenticação (HTTP 403). Verifique o token ou o método de login exigido pelo servidor.",
      "Endpoint MCP incompatível ou não encontrado (HTTP 404). Confira o endpoint MCP completo.",
      "Endpoint MCP incompatível ou não encontrado (HTTP 405). Confira o endpoint MCP completo.",
      "Tempo de resposta MCP excedido. O resultado da chamada pode ser incerto.",
      "Falha na conexão ou operação MCP. Confira endpoint, transporte e disponibilidade do servidor.",
      "A sessão MCP expirou ou foi encerrada (HTTP 404). A chamada não foi reenviada; verifique o resultado no serviço. A próxima operação abrirá uma nova sessão.",
      "Resultado MCP incerto. Verifique o serviço antes de tentar outra execução.",
    ]);
    const safeMcpErrorMessage = (result) => {
      if (typeof result !== "string") return "";
      try {
        const parsed = JSON.parse(result);
        if (parsed?.isError !== true || !Array.isArray(parsed.content))
          return "";
        const text = parsed.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return safeMcpErrors.has(text) ? text : "";
      } catch {
        return "";
      }
    };
    for (const call of uncertainCalls) {
      const callConversation = conversationId;
      const card = node("article", undefined, "action-card");
      card.append(
        node("strong", `${call.server} / ${call.tool}`),
        uiNode("p", () =>
          t(
            "A chamada foi enviada, mas o efeito e o resultado não foram confirmados. Ela não será reenviada automaticamente. Verifique no serviço externo antes de registrar o resultado.",
          ),
        ),
      );
      const safeError = safeMcpErrorMessage(call.result);
      if (safeError)
        card.append(uiNode("p", () => t(safeError), "action-note"));
      const form = node("form", undefined, "management-form");
      const input = node("input");
      input.required = true;
      input.id = `reconcile-${call.id}`;
      const label = uiNode("label", () => t("Resultado verificado"));
      label.htmlFor = input.id;
      const button = uiNode("button", () => t("Registrar resultado"));
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
          .catch((failure) => text(error, () => errorText(failure.message)))
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
  }
  $("deliveries").replaceChildren(
    ...snapshot.deliveries
      .filter((d) => d.state === "uncertain")
      .map((d) =>
        uiNode("p", () =>
          t(
            "Entrega {0} incerta. Verifique o Telegram; não será reenviada automaticamente.",
            [d.id],
          ),
        ),
      ),
  );
  if (nearBottom) container.scrollTop = container.scrollHeight;
}
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  plain($("login-error"), "");
  $("login-submit").disabled = true;
  try {
    await api("/api/login", "POST", { password: $("password").value });
    $("password").value = "";
    await workspace();
  } catch (error) {
    text($("login-error"), () => errorText(error.message));
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
  const outgoingMessage = { ...pendingMessage };
  $("send").disabled = true;
  plain($("error"), "");
  try {
    const result = await api(
      `/api/conversations/${sentConversation}/messages`,
      "POST",
      outgoingMessage,
    );
    if (result?.kind === "command") {
      sessionStorage.removeItem(`pending:${sentConversation}`);
      await handleCommandResult(
        result,
        outgoingMessage.requestId,
        sentConversation,
        content,
      );
      if (sentConversation === conversationId) {
        if ($("message").value === content) $("message").value = "";
        if (pendingMessage?.requestId === outgoingMessage.requestId)
          pendingMessage = null;
      }
      await loadConversations();
      return;
    }
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
$("provider-button").onclick = guard(async () => {
  const flow = await api("/api/provider/login", "POST", {});
  providerFlow = flow.id;
  $("provider-dialog").showModal();
  const poll = async () => {
    const state = await api(`/api/provider/login/${providerFlow}`);
    text($("auth-state"), () =>
      state.state === "done"
        ? t("ChatGPT conectado.")
        : state.state === "failed"
          ? t("Login não concluído. Tente novamente.")
          : t("Continue o login no link do provider."),
    );
    const notices = [];
    for (const event of state.events) {
      if (event.type === "auth_url" || event.type === "device_code") {
        const link = uiNode("a", () =>
          event.type === "device_code"
            ? t("Abrir provider · código {0}", [event.userCode])
            : t("Abrir login OpenAI"),
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
    if (state.prompt) plain($("auth-label"), state.prompt.message);
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
  if (!messageComposing && slashAutocomplete.handleKeydown(event)) return;
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
  refreshConversation: refreshCurrentConversation,
});
attachTelegramUI(api, {
  getConversationId: () => conversationId,
  getConversationTitle: () => $("conversation-title").textContent,
});
conversationManagementUI = attachConversationManagementUI(api, {
  getConversationId: () => conversationId,
  getConversations: () => conversationsCache,
  loadConversations,
  closeSidebar: () => sidebar(false, false),
  selectConversation: async (id, title) => {
    await select(id, title);
    if (mobile.matches) $("message").focus();
  },
  report,
  onRenamed: (conversation) => {
    conversationsCache = conversationsCache.map((current) =>
      current.id === conversation.id
        ? { ...current, ...conversation }
        : current,
    );
    if (conversation.id === conversationId)
      plain($("conversation-title"), conversation.title);
    renderConversations();
  },
  afterDelete: async (id, wasActive) => {
    sessionStorage.removeItem(`pending:${id}`);
    if (!wasActive) {
      await loadConversations();
      return;
    }
    events?.close();
    events = null;
    conversationId = null;
    pendingMessage = null;
    clearCommandPolls();
    rendered = null;
    renderedActions = "";
    historyNodes.clear();
    historyNavigation = null;
    historyPage = 0;
    lastSnapshot = null;
    settingsUI.updateConversation(null);
    $("message").value = "";
    text($("conversation-title"), () => t("Nova conversa"));
    history.replaceState(null, "", location.pathname);
    const available = await loadConversations();
    if (available.length) await select(available[0].id, available[0].title);
    else await create();
  },
});
api("/api/status").then(workspace).catch(showLogin);
