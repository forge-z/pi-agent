import { attachCustomProviderConnectionsUI } from "./provider-connections.js";

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
const $ = (id) => document.getElementById(id);
const effortNames = {
  off: "Sem esforço",
  minimal: "Mínimo",
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  xhigh: "Muito alto",
  max: "Máximo",
};
const names = (value) => [
  ...new Set(
    value
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
const config = (server) => ({
  name: server.name,
  url: server.url,
  cuaViewer: server.cuaViewer === true,
  readTools: [...(server.readTools || [])],
  actionTools: [...(server.actionTools || [])],
  ...(server.mode ? { mode: server.mode } : {}),
  ...(Array.isArray(server.allowedTools)
    ? { allowedTools: [...server.allowedTools] }
    : {}),
  ...(Array.isArray(server.deniedTools)
    ? { deniedTools: [...server.deniedTools] }
    : {}),
  ...(server.tokenFile ? { tokenFile: server.tokenFile } : {}),
});

// datetime-local contains no offset. Resolve it in the explicitly chosen IANA zone.
function zonedSchedule(value, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Escolha uma data e um horário válidos.");
  const [, year, month, day, hour, minute] = match.map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const localTime = (timestamp) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(timestamp).map((p) => [p.type, p.value]),
    );
    return Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
    );
  };
  let timestamp = wanted;
  for (let i = 0; i < 4; i++) timestamp += wanted - localTime(timestamp);
  if (localTime(timestamp) !== wanted)
    throw new Error(
      "Esse horário não existe no fuso escolhido. Selecione outro horário.",
    );
  if (timestamp <= Date.now()) throw new Error("Escolha um horário no futuro.");
  return new Date(timestamp).toISOString();
}

export function configureUI(api, callbacks) {
  const { node, icon } = callbacks;
  function uiNode(tag, render, cls) {
    return text(node(tag, undefined, cls), render);
  }
  let settings = null;
  let currentSettings = null;
  let servers = [];
  let mcpStatus = [];
  let editingName = null;
  let originalMode;
  let editorMode = "direct";
  let allowedTools;
  let deniedTools = [];
  let deniedToolsPresent = false;
  let conversationTarget = null;
  let tools = [];
  let requestGeneration = 0;
  let mutationInFlight = false;
  const discovered = new Map();
  const taskRunRequests = new Map();

  function feedback(id, message = "") {
    text($(id), message);
  }
  async function act(errorId, controls, operation) {
    feedback(errorId);
    if (controls.some((control) => control.disabled)) return;
    const previous = controls.map((control) => control.disabled);
    controls.forEach((control) => {
      control.disabled = true;
    });
    const form = controls[0]?.closest("form");
    form?.setAttribute("aria-busy", "true");
    try {
      await operation();
    } catch (error) {
      text($(errorId), () => errorText(error.message));
      const feedbackId = {
        "settings-error": "settings-feedback",
        "mcp-editor-error": "mcp-editor-feedback",
        "tasks-error": "tasks-feedback",
      }[errorId];
      if (feedbackId) feedback(feedbackId);
      $(errorId).scrollIntoView({ block: "nearest" });
    } finally {
      controls.forEach((control, index) => {
        control.disabled = previous[index];
      });
      form?.removeAttribute("aria-busy");
    }
  }
  function option(value, label) {
    const element = node("option");
    if (typeof label === "function") text(element, label);
    else plain(element, label);
    element.value = value;
    return element;
  }
  let connectionProviders = [];
  let connectionBusy = false;
  let connectionGeneration = 0;
  const customConnectionsUI = attachCustomProviderConnectionsUI(api, {
    refresh: async () => {
      await loadSettings();
      await callbacks.refreshStatus();
    },
    setBusy: setConnectionBusy,
  });

  function availableProviders() {
    return (
      settings?.providers || [
        {
          id: settings?.provider || "openai",
          name: "OpenAI",
          models: settings?.models || [],
          authTypes: [],
          credentialType: null,
        },
      ]
    );
  }
  function modelsFor(provider) {
    return (
      availableProviders().find((entry) => entry.id === provider)?.models || []
    );
  }
  function providerControl(modelId) {
    return modelId === "default-model"
      ? "default-provider"
      : "conversation-provider";
  }
  function populateEfforts(modelId, effortId, preferred) {
    const select = $(effortId);
    const model = modelsFor($(providerControl(modelId)).value).find(
      (entry) => entry.id === $(modelId).value,
    );
    const efforts = model?.efforts || [];
    select.replaceChildren(
      ...efforts.map((effort) =>
        option(effort, () => t(effortNames[effort] || effort)),
      ),
    );
    if (efforts.includes(preferred)) select.value = preferred;
    else if (efforts.includes("medium")) select.value = "medium";
    select.disabled = efforts.length === 0;
  }
  function populateModels(modelId, effortId, preferred = settings) {
    const select = $(modelId);
    const models = modelsFor($(providerControl(modelId)).value);
    select.replaceChildren(
      ...models.map((model) => option(model.id, model.name || model.id)),
    );
    if (models.some((model) => model.id === preferred?.modelId))
      select.value = preferred.modelId;
    select.disabled = !models.length;
    populateEfforts(modelId, effortId, preferred?.effort);
  }
  function populateProviders(
    providerId,
    modelId,
    effortId,
    preferred = settings,
  ) {
    const select = $(providerId);
    const providers = availableProviders();
    const provider =
      preferred?.provider || settings?.provider || providers[0]?.id;
    select.replaceChildren(
      ...providers.map((entry) => option(entry.id, entry.name || entry.id)),
    );
    // A conversation may still use a provider that is unavailable in the current catalog.
    if (provider && !providers.some((entry) => entry.id === provider))
      select.append(option(provider, provider));
    if (provider) select.value = provider;
    select.disabled = !providers.length;
    populateModels(modelId, effortId, preferred);
  }
  function updateLabel() {
    if (!currentSettings) return;
    const provider = currentSettings.provider || settings?.provider || "openai";
    const model = modelsFor(provider).find(
      (entry) => entry.id === currentSettings.modelId,
    );
    const current = { ...currentSettings };
    text(
      $("model-label"),
      () =>
        `${model?.name || current.modelId} · ${t(effortNames[current.effort] || current.effort)}`,
    );
    attr($("model-label"), "aria-label", () =>
      t("Ajustar modelo desta conversa: {0}", [$("model-label").textContent]),
    );
  }
  function clearConnectionInputs() {
    for (const provider of ["openai", "anthropic", "deepseek"]) {
      $(`${provider}-api-key`).value = "";
      $(`${provider}-api-key`).setCustomValidity("");
      $(`${provider}-replace`).checked = false;
    }
  }
  function connectionProvider(provider) {
    return connectionProviders.find((entry) => entry.id === provider);
  }
  function updateOpenAIMethod() {
    const method = $("openai-auth-method").value;
    const provider = connectionProvider("openai");
    const available = provider?.authTypes?.includes(method) === true;
    $("provider-button").hidden = method !== "oauth";
    $("openai-api-form").hidden = method !== "api_key";
    $("provider-button").disabled = connectionBusy || !available;
    $("openai-api-key").disabled = connectionBusy || !available;
    $("openai-api-save").disabled = connectionBusy || !available;
    text($("openai-replace-label"), () => {
      if (provider?.credentialType === "oauth")
        return method === "api_key"
          ? t(
              "Confirmo substituir minha conexão ChatGPT por esta chave API OpenAI.",
            )
          : t("Confirmo substituir a conexão ChatGPT atual.");
      return method === "oauth"
        ? t(
            "Confirmo substituir a chave API OpenAI atual por uma conexão ChatGPT.",
          )
        : t("Confirmo substituir a chave API OpenAI atual.");
    });
  }
  function renderProviderConnections(providers = availableProviders()) {
    connectionProviders = providers;
    clearConnectionInputs();
    $("provider-connections").disabled = connectionBusy || !settings;
    for (const id of ["openai", "anthropic", "deepseek"]) {
      const provider = connectionProvider(id);
      const credentialType = provider?.credentialType;
      const statusId = id === "openai" ? "provider-status" : `${id}-status`;
      text($(statusId), () =>
        !provider || !provider.authTypes?.length
          ? t("Conexão indisponível neste ambiente.")
          : credentialType === "api_key"
            ? t("Chave API configurada")
            : credentialType === "oauth"
              ? t("Conta ChatGPT conectada")
              : t("Não configurado"),
      );
      $(`${id}-replace-row`).hidden = !credentialType;
      $(`${id}-replace`).required = Boolean(credentialType);
      $(`${id}-replace`).checked = false;
      $(`${id}-replace`).disabled = connectionBusy;
    }
    const openai = connectionProvider("openai");
    $("openai-auth-method").value = openai?.credentialType || "oauth";
    $("openai-auth-method").disabled =
      connectionBusy || !openai?.authTypes?.length;
    for (const entry of $("openai-auth-method").options)
      entry.disabled = !openai?.authTypes?.includes(entry.value);
    text(document.querySelector(".provider-label"), () =>
      openai?.credentialType === "oauth"
        ? t("Conectar novamente com ChatGPT")
        : t("Conectar ChatGPT"),
    );
    updateOpenAIMethod();
    for (const id of ["anthropic", "deepseek"]) {
      const available =
        connectionProvider(id)?.authTypes?.includes("api_key") === true;
      $(`${id}-api-key`).disabled = connectionBusy || !available;
      $(`${id}-api-save`).disabled = connectionBusy || !available;
    }
  }
  async function loadSettings() {
    settings = await api("/api/settings");
    servers = settings.mcp || (await api("/api/mcp"));
    mcpStatus = settings.mcpStatus || [];
    renderProviderConnections();
    customConnectionsUI.update(settings);
    if (
      $("settings-dialog").open &&
      !$("defaults-form").hidden &&
      $("default-provider").value
    )
      populateProviders("default-provider", "default-model", "default-effort", {
        provider: $("default-provider").value,
        modelId: $("default-model").value,
        effort: $("default-effort").value,
      });
    updateLabel();
  }
  function setConnectionBusy(value) {
    connectionBusy = value;
    $("provider-connections").disabled = value || !settings;
    customConnectionsUI.setBusy(value);
  }
  async function saveApiKey(id, event) {
    event.preventDefault();
    if (connectionBusy) return;
    const form = $(`${id}-api-form`);
    const input = $(`${id}-api-key`);
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const apiKey = input.value.trim();
    if (!apiKey) {
      input.setCustomValidity(t("Informe uma chave API."));
      input.reportValidity();
      return;
    }
    const replace = $(`${id}-replace`).required && $(`${id}-replace`).checked;
    input.value = "";
    const generation = connectionGeneration;
    feedback(`${id}-connection-error`);
    feedback(`${id}-connection-feedback`);
    setConnectionBusy(true);
    try {
      await api(`/api/provider/${id}/api-key`, "PUT", {
        apiKey,
        ...(replace ? { replace: true } : {}),
      });
      if (generation !== connectionGeneration) return;
      await loadSettings();
      await callbacks.refreshStatus();
      feedback(`${id}-connection-feedback`, () =>
        t("Chave API salva no servidor."),
      );
    } catch {
      if (generation === connectionGeneration)
        feedback(`${id}-connection-error`, () =>
          t("Não foi possível salvar a conexão. Tente novamente."),
        );
    } finally {
      input.value = "";
      setConnectionBusy(false);
      if (settings) renderProviderConnections();
    }
  }
  for (const provider of ["openai", "anthropic", "deepseek"]) {
    $(`${provider}-api-form`).onsubmit = (event) =>
      void saveApiKey(provider, event);
    $(`${provider}-api-key`).addEventListener("input", () =>
      $(`${provider}-api-key`).setCustomValidity(""),
    );
  }
  $("openai-auth-method").onchange = () => {
    clearConnectionInputs();
    feedback("openai-connection-error");
    feedback("openai-connection-feedback");
    updateOpenAIMethod();
  };
  $("provider-button").onclick = async () => {
    if (connectionBusy || $("provider-button").disabled) return;
    const replacement = $("openai-replace");
    if (!replacement.checkValidity()) {
      replacement.reportValidity();
      return;
    }
    const replace = replacement.required && replacement.checked;
    clearConnectionInputs();
    feedback("openai-connection-error");
    setConnectionBusy(true);
    try {
      await callbacks.connectProvider({
        provider: "openai",
        type: "oauth",
        ...(replace ? { replace: true } : {}),
      });
    } catch {
      feedback("openai-connection-error", () =>
        t("Não foi possível iniciar a conexão. Tente novamente."),
      );
    } finally {
      setConnectionBusy(false);
      renderProviderConnections(connectionProviders);
    }
  };
  $("settings-dialog").addEventListener("close", () => {
    connectionGeneration++;
    clearConnectionInputs();
    customConnectionsUI.clearSecrets();
  });
  function show(dialogId) {
    callbacks.closeSidebar();
    feedback("settings-error");
    feedback("tasks-error");
    $(dialogId).showModal();
  }
  $("settings-button").onclick = () => {
    clearConnectionInputs();
    show("settings-dialog");
    $("provider-connections").disabled = true;
    feedback("settings-feedback", () => t("Carregando suas configurações…"));
    $("defaults-form").hidden = true;
    $("mcp-add").disabled = true;
    void act("settings-error", [], async () => {
      await loadSettings();
      populateProviders("default-provider", "default-model", "default-effort");
      renderServers();
      $("defaults-form").hidden = false;
      $("mcp-add").disabled = false;
      feedback("settings-feedback");
    });
  };
  $("default-provider").onchange = () =>
    populateModels("default-model", "default-effort", {});
  $("conversation-provider").onchange = () =>
    populateModels("conversation-model", "conversation-effort", {});
  $("default-model").onchange = () =>
    populateEfforts(
      "default-model",
      "default-effort",
      $("default-effort").value,
    );
  $("conversation-model").onchange = () =>
    populateEfforts(
      "conversation-model",
      "conversation-effort",
      $("conversation-effort").value,
    );
  $("defaults-form").onsubmit = (event) => {
    event.preventDefault();
    void act("settings-error", [event.submitter], async () => {
      await api("/api/settings", "PUT", {
        provider: $("default-provider").value,
        modelId: $("default-model").value,
        effort: $("default-effort").value,
      });
      await callbacks.refreshStatus();
      await loadSettings();
      feedback("settings-feedback", () =>
        t("Padrão salvo. As novas conversas usarão estas escolhas."),
      );
    });
  };
  $("model-label").onclick = () => {
    conversationTarget = callbacks.getConversationId();
    if (!conversationTarget) return;
    show("conversation-settings-dialog");
    $("conversation-settings-form").hidden = true;
    feedback("conversation-settings-error");
    void act("conversation-settings-error", [], async () => {
      await loadSettings();
      populateProviders(
        "conversation-provider",
        "conversation-model",
        "conversation-effort",
        currentSettings || settings,
      );
      $("conversation-settings-form").hidden = false;
      $("conversation-model").focus();
    });
  };
  $("conversation-settings-form").onsubmit = (event) => {
    event.preventDefault();
    void act("conversation-settings-error", [event.submitter], async () => {
      await api(
        `/api/conversations/${encodeURIComponent(conversationTarget)}/settings`,
        "PUT",
        {
          provider: $("conversation-provider").value,
          modelId: $("conversation-model").value,
          effort: $("conversation-effort").value,
        },
      );
      await callbacks.refreshConversation(conversationTarget);
      $("conversation-settings-dialog").close();
    });
  };

  function button(label, action, cls = "subtle") {
    const element = text(node("button", undefined, cls), label);
    element.type = "button";
    element.onclick = action;
    return element;
  }
  function deletionButton(label, remove, errorId) {
    let armed = false;
    const element = button(label, () => {
      if (!armed) {
        armed = true;
        text(element, () => t("Confirmar exclusão"));
        element.classList.add("danger-button");
        return;
      }
      void act(errorId, [element], remove);
    });
    element.addEventListener("blur", () => {
      if (!element.disabled) {
        armed = false;
        text(element, label);
        element.classList.remove("danger-button");
      }
    });
    return element;
  }
  async function saveServers(next) {
    if (mutationInFlight)
      throw new Error("Aguarde a alteração de servidor em andamento.");
    mutationInFlight = true;
    try {
      await api("/api/mcp", "PUT", { servers: next });
      settings = await api("/api/settings");
      servers = settings.mcp || (await api("/api/mcp"));
      mcpStatus = settings.mcpStatus || [];
      renderServers();
    } finally {
      mutationInFlight = false;
    }
  }
  function renderServers() {
    const cards = servers.map((server) => {
      const mode = server.mode === "direct" ? "direct" : "legacy";
      const status = mcpStatus.find((entry) => entry.server === server.name);
      const card = node("article", undefined, "management-card");
      const heading = node("div", undefined, "management-card-heading");
      const title = node("div");
      title.append(
        node("h4", server.name),
        node("p", server.url, "endpoint-label"),
      );
      heading.append(icon("plug"), title);
      card.append(
        heading,
        uiNode(
          "p",
          () =>
            `${mode === "direct" ? t("Integração automática") : t("Modo de compatibilidade")} · ${mode === "legacy" ? t("{0} leituras · {1} ações · ", [server.readTools.length, server.actionTools.length]) : ""}${server.tokenFile ? t("Token em arquivo") : server.hasToken ? t("Token salvo") : t("Sem token")}`,
          "card-meta",
        ),
      );
      if (Array.isArray(status?.tools))
        card.append(
          uiNode(
            "p",
            () => t("{0} ferramentas registradas", [status.tools.length]),
            "card-meta",
          ),
        );
      if (status?.error)
        card.append(uiNode("p", () => errorText(status.error), "error"));
      const actions = node("div", undefined, "card-buttons");
      actions.append(
        button(
          () => t("Editar"),
          () => editServer(server),
        ),
        deletionButton(
          () => t("Excluir"),
          async () => {
            await saveServers(
              servers.filter((entry) => entry.name !== server.name).map(config),
            );
            if (editingName === server.name) closeEditor();
            discovered.delete(server.name);
            feedback("settings-feedback", () => t("Servidor excluído."));
          },
          "settings-error",
        ),
      );
      card.append(actions);
      return card;
    });
    $("mcp-list").replaceChildren(
      ...(cards.length
        ? cards
        : [
            uiNode(
              "p",
              () =>
                t(
                  "Nenhum servidor conectado. Adicione um endpoint para começar.",
                ),
              "management-empty",
            ),
          ]),
    );
  }
  function closeEditor() {
    requestGeneration++;
    $("mcp-form").hidden = true;
    $("mcp-form").reset();
    $("mcp-token").value = "";
    $("mcp-token").disabled = false;
    tools = [];
    editingName = null;
    originalMode = undefined;
    editorMode = "direct";
    allowedTools = undefined;
    deniedTools = [];
    deniedToolsPresent = false;
    $("mcp-add").hidden = false;
  }
  function updateModePresentation() {
    const direct = editorMode === "direct";
    const canMigrate = Boolean(editingName) && originalMode !== "direct";
    $("mcp-legacy-mode").hidden = !canMigrate;
    $("mcp-use-direct").checked = direct;
    text($("mcp-legacy-notice"), () =>
      direct
        ? t(
            "Ao salvar, as ferramentas existentes passam a ser chamadas diretamente pelo Pi, mantendo a lista permitida atual.",
          )
        : t(
            "Modo de compatibilidade. As listas de leitura e ação abaixo mantêm as permissões atuais.",
          ),
    );
    $("mcp-direct-mode").hidden = !direct;
    text($("mcp-direct-notice"), () =>
      t("Ferramentas permitidas são chamadas diretamente pelo Pi. {0}", [
        allowedTools === undefined
          ? t(
              "Todas ficam disponíveis por padrão; desmarque uma para bloqueá-la.",
            )
          : t(
              "Somente ferramentas na lista permitida ficam disponíveis; marque ou desmarque as ferramentas abaixo.",
            ),
      ]),
    );
    $("mcp-legacy-permissions").hidden = direct || !editingName;
    $("mcp-legacy-permissions").open = !direct && Boolean(editingName);
  }
  function editServer(server = null) {
    closeEditor();
    editingName = server?.name || null;
    originalMode = server?.mode;
    editorMode =
      server?.mode === "direct" ? "direct" : server ? "legacy" : "direct";
    allowedTools =
      server?.mode === "direct"
        ? Array.isArray(server.allowedTools)
          ? [...server.allowedTools]
          : undefined
        : server
          ? [
              ...new Set([
                ...(server.readTools || []),
                ...(server.actionTools || []),
              ]),
            ]
          : undefined;
    deniedTools = [...(server?.deniedTools || [])];
    deniedToolsPresent = Array.isArray(server?.deniedTools);
    text($("mcp-editor-title"), () =>
      server ? t("Editar {0}", [server.name]) : t("Novo servidor"),
    );
    $("mcp-name").value = server?.name || "";
    $("mcp-name").readOnly = Boolean(server);
    $("mcp-url").value = server?.url || "";
    $("mcp-cua-viewer").checked = server?.cuaViewer === true;
    $("mcp-token-file").value = server?.tokenFile || "";
    $("mcp-token-file-details").hidden = !server?.tokenFile;
    $("mcp-token").disabled = Boolean(server?.tokenFile);
    $("mcp-read-tools").value = server?.readTools?.join("\n") || "";
    $("mcp-action-tools").value = server?.actionTools?.join("\n") || "";
    $("mcp-remove-token-row").hidden =
      !server?.hasToken || Boolean(server?.tokenFile);
    text($("mcp-token-hint"), () =>
      server?.tokenFile
        ? t("Este servidor usa um arquivo de token provisionado pelo operador.")
        : server?.hasToken
          ? t(
              "Um token já está salvo. Deixe vazio para preservá-lo; preencha para substituí-lo.",
            )
          : t("Opcional. O token salvo nunca é exibido aqui."),
    );
    tools = discovered.get(editingName) || [];
    updateModePresentation();
    feedback("mcp-editor-error");
    feedback("mcp-editor-feedback");
    $("mcp-form").hidden = false;
    $("mcp-add").hidden = true;
    renderTools();
    $("mcp-name").focus();
  }
  $("mcp-add").onclick = () => editServer();
  $("mcp-cancel").onclick = closeEditor;
  $("mcp-remove-token").onchange = () => {
    $("mcp-token").disabled = $("mcp-remove-token").checked;
    if ($("mcp-remove-token").checked) $("mcp-token").value = "";
  };
  $("mcp-use-direct").onchange = () => {
    editorMode = $("mcp-use-direct").checked ? "direct" : "legacy";
    updateModePresentation();
    renderTools();
  };
  function readEditor() {
    const name = $("mcp-name").value.trim();
    const url = $("mcp-url").value.trim();
    if (!name || !url)
      throw new Error("Preencha o nome e o endpoint do servidor.");
    if (!/^[a-zA-Z0-9_-]+$/.test(name))
      throw new Error(
        "Use apenas letras sem acento, números, hífen ou sublinhado no nome.",
      );
    const parsed = new URL(url);
    const localHttp =
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !localHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        "Use HTTPS (HTTP somente em loopback), sem credenciais, query ou fragmento na URL.",
      );
    const readTools = names($("mcp-read-tools").value);
    const cuaViewer = $("mcp-cua-viewer").checked;
    if (
      cuaViewer &&
      (editorMode !== "direct" ||
        parsed.protocol !== "https:" ||
        parsed.pathname !== "/mcp")
    )
      throw new Error(
        "O acesso humano CUA exige integração automática e um endpoint HTTPS /mcp.",
      );
    const actionTools = names($("mcp-action-tools").value);
    if (
      editorMode === "legacy" &&
      readTools.some((tool) => actionTools.includes(tool))
    )
      throw new Error(
        "Uma ferramenta deve ser leitura ou ação. Remova os nomes repetidos entre as listas.",
      );
    if (
      servers.some(
        (server) => server.name === name && server.name !== editingName,
      )
    )
      throw new Error(
        "Já existe um servidor com esse nome. Escolha outro nome.",
      );
    const existing = servers.find((server) => server.name === editingName);
    const tokenFile = $("mcp-token-file").value.trim();
    if (tokenFile && $("mcp-token").value)
      throw new Error(
        "Escolha um token ou um arquivo de token para este servidor.",
      );
    return {
      name,
      url,
      cuaViewer,
      readTools,
      actionTools,
      ...(editorMode === "direct"
        ? {
            mode: "direct",
            ...(existing && existing.mode !== "direct"
              ? { migrateLegacy: true }
              : {}),
            ...(allowedTools === undefined
              ? {}
              : { allowedTools: [...allowedTools] }),
            ...(deniedToolsPresent ? { deniedTools: [...deniedTools] } : {}),
          }
        : {
            ...(originalMode ? { mode: originalMode } : {}),
            ...(Array.isArray(existing?.allowedTools)
              ? { allowedTools: [...existing.allowedTools] }
              : {}),
            ...(Array.isArray(existing?.deniedTools)
              ? { deniedTools: [...existing.deniedTools] }
              : {}),
          }),
      ...(tokenFile ? { tokenFile } : {}),
      ...($("mcp-remove-token").checked
        ? { token: "" }
        : $("mcp-token").value
          ? { token: $("mcp-token").value }
          : {}),
    };
  }
  $("mcp-form").onsubmit = (event) => {
    event.preventDefault();
    void act(
      "mcp-editor-error",
      [event.submitter, $("mcp-discover"), $("mcp-cancel")],
      async () => {
        const next = readEditor();
        const generation = requestGeneration;
        feedback("mcp-editor-feedback", () => t("Salvando servidor…"));
        // Tokens never enter the redacted config cache or the DOM after saving.
        await saveServers([
          ...servers
            .filter((server) => server.name !== editingName)
            .map(config),
          next,
        ]);
        if (generation !== requestGeneration) return;
        editingName = next.name;
        originalMode = next.mode;
        editorMode = next.mode === "direct" ? "direct" : "legacy";
        allowedTools = Array.isArray(next.allowedTools)
          ? [...next.allowedTools]
          : undefined;
        deniedTools = [...(next.deniedTools || [])];
        deniedToolsPresent = Array.isArray(next.deniedTools);
        updateModePresentation();
        $("mcp-name").readOnly = true;
        $("mcp-token").value = "";
        $("mcp-remove-token").checked = false;
        $("mcp-token").disabled = Boolean(next.tokenFile);
        $("mcp-remove-token-row").hidden =
          Boolean(next.tokenFile) ||
          !servers.find((server) => server.name === editingName)?.hasToken;
        text($("mcp-token-hint"), () =>
          t(
            "Deixe vazio para preservar o token salvo. Ele nunca é exibido aqui.",
          ),
        );
        text($("mcp-editor-title"), () => t("Editar {0}", [editingName]));
        try {
          await discoverSavedTools(editingName, generation);
          if (generation !== requestGeneration) return;
          feedback("mcp-editor-feedback", () =>
            tools.length
              ? t("Servidor salvo. {0} ferramentas atualizadas no catálogo.", [
                  tools.length,
                ])
              : t("Servidor salvo. O catálogo não retornou ferramentas."),
          );
        } catch (error) {
          if (generation !== requestGeneration) return;
          text($("mcp-editor-error"), () => errorText(error.message));
          feedback("mcp-editor-feedback", () =>
            t("Servidor salvo; não foi possível atualizar o catálogo."),
          );
        }
      },
    );
  };
  async function discoverSavedTools(name, generation = requestGeneration) {
    const result = await api(`/api/mcp/${encodeURIComponent(name)}/tools`);
    if (generation !== requestGeneration) return false;
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.tools))
      throw new Error(
        "A resposta do servidor não contém um catálogo de ferramentas válido.",
      );
    tools = result.tools;
    discovered.set(name, tools);
    mcpStatus = mcpStatus.filter((entry) => entry.server !== name);
    mcpStatus.push({ server: name, tools });
    renderServers();
    renderTools();
    return true;
  }
  $("mcp-discover").onclick = () => {
    void act(
      "mcp-editor-error",
      [$("mcp-discover"), $("mcp-form").querySelector('[type="submit"]')],
      async () => {
        const saved = servers.find((server) => server.name === editingName);
        if (
          !saved ||
          $("mcp-name").value.trim() !== saved.name ||
          $("mcp-url").value.trim() !== saved.url ||
          $("mcp-token").value ||
          $("mcp-remove-token").checked ||
          $("mcp-token-file").value.trim() !== (saved.tokenFile || "")
        )
          throw new Error(
            "Salve o servidor e as credenciais antes de descobrir as ferramentas.",
          );
        const generation = requestGeneration;
        feedback("mcp-editor-feedback", () =>
          t("Consultando as ferramentas deste servidor…"),
        );
        await discoverSavedTools(saved.name, generation);
        if (generation !== requestGeneration) return;
        feedback("mcp-editor-feedback", () =>
          tools.length
            ? t(
                "Catálogo atualizado. Ajuste a disponibilidade abaixo e salve para aplicar.",
              )
            : t("O servidor não retornou ferramentas."),
        );
      },
    );
  };
  function renderTools() {
    $("mcp-tools").replaceChildren(
      ...tools.map((tool, index) => {
        const row = node("div", undefined, "discovered-tool");
        const description = node("div", undefined, "tool-description");
        description.append(node("strong", tool.name));
        if (tool.description) description.append(node("p", tool.description));
        const schema = node("details", undefined, "tool-schema");
        schema.append(
          uiNode("summary", () => t("Parâmetros")),
          node("pre", JSON.stringify(tool.inputSchema || {}, null, 2)),
        );
        description.append(schema);
        const choices = node("div", undefined, "tool-choices");
        if (editorMode === "direct") {
          const choice = node("label", undefined, "checkbox-line");
          const checkbox = node("input");
          checkbox.type = "checkbox";
          checkbox.checked =
            (allowedTools === undefined || allowedTools.includes(tool.name)) &&
            !deniedTools.includes(tool.name);
          checkbox.id = `tool-${index}-available`;
          choice.htmlFor = checkbox.id;
          choice.append(
            checkbox,
            uiNode("span", () => t("Disponível")),
          );
          checkbox.onchange = () => {
            if (checkbox.checked) {
              if (
                allowedTools !== undefined &&
                !allowedTools.includes(tool.name)
              )
                allowedTools.push(tool.name);
              deniedTools = deniedTools.filter((name) => name !== tool.name);
            } else if (allowedTools === undefined) {
              deniedToolsPresent = true;
              if (!deniedTools.includes(tool.name)) deniedTools.push(tool.name);
            } else {
              allowedTools = allowedTools.filter((name) => name !== tool.name);
            }
            renderTools();
            $(checkbox.id)?.focus();
          };
          choices.append(choice);
        }
        row.append(description);
        if (editorMode === "direct") row.append(choices);
        return row;
      }),
    );
  }
  $("mcp-read-tools").oninput = renderTools;
  $("mcp-action-tools").oninput = renderTools;
  $("settings-dialog").addEventListener("close", closeEditor);

  function formatDate(timestamp, timezone) {
    if (timestamp == null) return t("Sem próxima execução");
    try {
      return new Intl.DateTimeFormat(locale(), {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: timezone,
      }).format(timestamp);
    } catch {
      return new Date(timestamp).toLocaleString(locale());
    }
  }
  async function loadTasks() {
    const tasks = await api("/api/tasks");
    renderTasks(tasks);
  }
  async function telegramAvailable(conversationId) {
    const query = new URLSearchParams({ conversationId });
    const result = await api(
      `/api/tasks/telegram-availability?${query.toString()}`,
    );
    return result.available === true;
  }
  const deliveryHintRequests = new WeakMap();
  async function updateTaskDeliveryHint(select, conversationId, hint) {
    const request = {};
    deliveryHintRequests.set(select, request);
    const selected = select.value;
    if (selected === "web") {
      text(hint, () =>
        t(
          "Todo resultado fica na conversa web. Nenhuma cópia será enviada ao Telegram.",
        ),
      );
      return true;
    }
    if (selected === "legacy") {
      text(hint, () =>
        t(
          "Este agendamento preserva o comportamento anterior: envia ao Telegram quando há um vínculo autorizado.",
        ),
      );
      return true;
    }
    if (!conversationId) {
      text(hint, () =>
        t(
          "Escolha uma conversa vinculada ao Telegram para habilitar essa cópia.",
        ),
      );
      return false;
    }
    text(hint, () => t("Verificando o vínculo desta conversa…"));
    try {
      const available = await telegramAvailable(conversationId);
      if (
        select.value !== selected ||
        deliveryHintRequests.get(select) !== request
      )
        return false;
      text(hint, () =>
        available
          ? t(
              "O resultado também será enviado ao Telegram desta conversa enquanto o vínculo autorizado permanecer ativo.",
            )
          : t(
              "Telegram não está conectado e autorizado para esta conversa. Conecte o bot e vincule a conversa escolhida; o resultado continuará disponível na web.",
            ),
      );
      return available;
    } catch {
      if (
        select.value === selected &&
        deliveryHintRequests.get(select) === request
      )
        text(hint, () =>
          t(
            "Não foi possível verificar o vínculo agora. A seleção será validada ao salvar; o resultado permanece na conversa web.",
          ),
        );
      return false;
    }
  }
  async function openTasks() {
    feedback("tasks-feedback", () => t("Carregando suas tarefas…"));
    await callbacks.loadConversations();
    const conversations = callbacks.getConversations();
    $("task-conversation").replaceChildren(
      ...conversations.map((conversation) =>
        option(conversation.id, conversation.title),
      ),
    );
    if (callbacks.getConversationId())
      $("task-conversation").value = callbacks.getConversationId();
    await updateTaskDeliveryHint(
      $("task-delivery"),
      $("task-conversation").value,
      $("task-delivery-hint"),
    );
    await loadTasks();
    feedback("tasks-feedback");
  }
  $("tasks-button").onclick = () => {
    show("tasks-dialog");
    void act(
      "tasks-error",
      [$("tasks-refresh"), $("task-form").querySelector('[type="submit"]')],
      openTasks,
    );
  };
  $("tasks-refresh").onclick = () => {
    void act("tasks-error", [$("tasks-refresh")], loadTasks);
  };
  $("task-delivery").onchange = () =>
    void updateTaskDeliveryHint(
      $("task-delivery"),
      $("task-conversation").value,
      $("task-delivery-hint"),
    );
  $("task-conversation").onchange = () =>
    void updateTaskDeliveryHint(
      $("task-delivery"),
      $("task-conversation").value,
      $("task-delivery-hint"),
    );
  function renderTasks(tasks) {
    const cards = tasks.map((task) => {
      const card = node("article", undefined, "management-card task-card");
      const heading = node("div", undefined, "management-card-heading");
      const title = node("div");
      title.append(
        node("h4", task.title),
        uiNode(
          "p",
          () =>
            task.kind === "once" ? t("Uma vez") : `Cron · ${task.schedule}`,
          "card-meta",
        ),
      );
      heading.append(
        icon("calendar-blank"),
        title,
        uiNode(
          "span",
          () => (task.enabled ? t("Ativa") : t("Pausada")),
          "task-state",
        ),
      );
      const conversation = callbacks
        .getConversations()
        .find((entry) => entry.id === task.conversationId);
      card.append(
        heading,
        node("p", task.prompt, "task-prompt"),
        uiNode(
          "p",
          () =>
            t("Conversa: {0}", [conversation?.title || task.conversationId]),
          "card-meta",
        ),
      );
      const deliveryLabel =
        {
          legacy:
            "Telegram quando houver vínculo autorizado (comportamento atual)",
          web: "Somente nesta conversa web",
          web_telegram: "Conversa web e Telegram",
        }[task.delivery] || "Destino desconhecido";
      card.append(
        uiNode("p", () => t("Destino: {0}", [t(deliveryLabel)]), "card-meta"),
      );
      card.append(
        uiNode(
          "p",
          () =>
            t("Próxima: {0} · {1}", [
              formatDate(task.nextRun, task.timezone),
              task.timezone,
            ]),
          "card-meta",
        ),
      );
      if (task.lastError)
        card.append(uiNode("p", () => errorText(task.lastError), "error"));
      const actions = node("div", undefined, "card-buttons");
      const editorId = `task-delivery-${task.id}`;
      const editor = node(
        "form",
        undefined,
        "management-form task-delivery-editor",
      );
      editor.hidden = true;
      const field = node("div", undefined, "form-field");
      const label = uiNode("label", () => t("Destino do resultado"));
      label.htmlFor = editorId;
      const editorSelect = node("select");
      editorSelect.id = editorId;
      editorSelect.replaceChildren(
        option("web", () => t("Somente nesta conversa web")),
        option("web_telegram", () => t("Conversa web e Telegram")),
        ...(task.delivery === "legacy"
          ? [
              option("legacy", () =>
                t("Telegram quando houver vínculo (comportamento atual)"),
              ),
            ]
          : []),
      );
      editorSelect.value = task.delivery;
      const editorHint = node("small");
      editorHint.setAttribute("aria-live", "polite");
      field.append(label, editorSelect, editorHint);
      const editorError = node("p", undefined, "error");
      editorError.id = `task-delivery-error-${task.id}`;
      editorError.setAttribute("role", "alert");
      const editorActions = node("div", undefined, "form-actions");
      const saveDelivery = uiNode("button", () => t("Salvar destino"));
      saveDelivery.type = "submit";
      const cancelDelivery = button(
        () => t("Cancelar"),
        () => {
          editor.hidden = true;
          editorSelect.value = task.delivery;
          plain(editorError, "");
        },
      );
      editorActions.append(saveDelivery, cancelDelivery);
      editor.append(field, editorError, editorActions);
      editorSelect.onchange = () =>
        void updateTaskDeliveryHint(
          editorSelect,
          task.conversationId,
          editorHint,
        );
      editor.onsubmit = (event) => {
        event.preventDefault();
        void act(editorError.id, [saveDelivery], async () => {
          if (
            editorSelect.value === "web_telegram" &&
            !(await telegramAvailable(task.conversationId))
          )
            throw new Error(
              "Telegram não está conectado e autorizado para esta conversa. Conecte o bot e vincule a conversa escolhida.",
            );
          await api(`/api/tasks/${encodeURIComponent(task.id)}`, "PUT", {
            delivery: editorSelect.value,
          });
          await loadTasks();
          feedback("tasks-feedback", () => t("Destino da tarefa atualizado."));
        });
      };
      const editDelivery = button(
        () => t("Editar destino"),
        () => {
          editor.hidden = !editor.hidden;
          if (editor.hidden) return;
          editorSelect.value = task.delivery;
          void updateTaskDeliveryHint(
            editorSelect,
            task.conversationId,
            editorHint,
          );
        },
      );
      const pause = button(
        () => (task.enabled ? t("Pausar") : t("Retomar")),
        () => {
          void act("tasks-error", [pause], async () => {
            await api(`/api/tasks/${encodeURIComponent(task.id)}`, "PUT", {
              enabled: !task.enabled,
            });
            await loadTasks();
            feedback("tasks-feedback", () =>
              task.enabled ? t("Tarefa pausada.") : t("Tarefa retomada."),
            );
          });
        },
      );
      const run = button(
        () => t("Executar agora"),
        () => {
          void act("tasks-error", [run, pause], async () => {
            if (!taskRunRequests.has(task.id))
              taskRunRequests.set(task.id, crypto.randomUUID());
            await api(`/api/tasks/${encodeURIComponent(task.id)}/run`, "POST", {
              requestId: taskRunRequests.get(task.id),
            });
            await loadTasks();
            await callbacks.refreshConversation(task.conversationId);
            taskRunRequests.delete(task.id);
            feedback("tasks-feedback", () =>
              t(
                "Execução solicitada. Acompanhe o resultado e eventuais aprovações na conversa.",
              ),
            );
          });
        },
      );
      const open = button(
        () => t("Abrir conversa"),
        async () => {
          void act("tasks-error", [open], async () => {
            await callbacks.selectConversation(
              task.conversationId,
              conversation?.title || "Conversa da tarefa",
            );
            $("tasks-dialog").close();
          });
        },
      );
      actions.append(
        open,
        editDelivery,
        pause,
        run,
        deletionButton(
          () => t("Excluir"),
          async () => {
            await api(`/api/tasks/${encodeURIComponent(task.id)}`, "DELETE");
            await loadTasks();
            feedback("tasks-feedback", () => t("Tarefa excluída."));
          },
          "tasks-error",
        ),
      );
      card.append(actions, editor);
      const history = node("details", undefined, "task-history");
      const log = node("div", undefined, "task-runs");
      const historyError = node("p", undefined, "error");
      historyError.setAttribute("role", "alert");
      history.append(
        uiNode("summary", () => t("Histórico de execuções")),
        log,
        historyError,
      );
      let loaded = false;
      history.ontoggle = async () => {
        if (!history.open || loaded) return;
        log.replaceChildren(
          uiNode("p", () => t("Carregando execuções…"), "card-meta"),
        );
        try {
          const runs = await api(
            `/api/tasks/${encodeURIComponent(task.id)}/runs`,
          );
          log.replaceChildren(
            ...(runs.length
              ? runs.map((entry) => {
                  const item = node("div", undefined, "task-run");
                  const state =
                    {
                      pending: "Pendente",
                      done: "Concluída",
                      failed: "Falhou",
                    }[entry.state] || entry.state;
                  item.append(
                    uiNode(
                      "p",
                      () =>
                        `${formatDate(entry.scheduledAt, task.timezone)} · ${t(state)}`,
                    ),
                  );
                  if (entry.error)
                    item.append(
                      uiNode("p", () => errorText(entry.error), "error"),
                    );
                  return item;
                })
              : [
                  uiNode(
                    "p",
                    () => t("Nenhuma execução registrada."),
                    "card-meta",
                  ),
                ]),
          );
          loaded = true;
        } catch (error) {
          log.replaceChildren();
          text(historyError, () => errorText(error.message));
        }
      };
      card.append(history);
      return card;
    });
    $("tasks-list").replaceChildren(
      ...(cards.length
        ? cards
        : [
            uiNode(
              "p",
              () =>
                t("Ainda não há tarefas. Combine o primeiro pedido abaixo."),
              "management-empty",
            ),
          ]),
    );
  }
  $("task-kind").onchange = () => {
    const once = $("task-kind").value === "once";
    $("task-once-field").hidden = !once;
    $("task-cron-field").hidden = once;
    $("task-once").required = once;
    $("task-cron").required = !once;
  };
  $("task-form").onsubmit = (event) => {
    event.preventDefault();
    void act("task-form-error", [event.submitter], async () => {
      const timezone = $("task-timezone").value.trim();
      try {
        new Intl.DateTimeFormat(locale(), { timeZone: timezone }).format();
      } catch {
        throw new Error(
          "Use um fuso horário IANA válido, como America/Sao_Paulo.",
        );
      }
      const kind = $("task-kind").value;
      const schedule =
        kind === "once"
          ? zonedSchedule($("task-once").value, timezone)
          : $("task-cron").value.trim();
      if (kind === "cron" && schedule.split(/\s+/).length !== 5)
        throw new Error("O agendamento cron precisa ter cinco campos.");
      await api("/api/tasks", "POST", {
        title: $("task-title").value.trim(),
        prompt: $("task-prompt").value.trim(),
        conversationId: $("task-conversation").value,
        kind,
        schedule,
        timezone,
        delivery: $("task-delivery").value,
      });
      $("task-title").value = "";
      $("task-prompt").value = "";
      $("task-once").value = "";
      $("task-cron").value = "";
      $("task-delivery").value = "web";
      await updateTaskDeliveryHint(
        $("task-delivery"),
        $("task-conversation").value,
        $("task-delivery-hint"),
      );
      await loadTasks();
      feedback("tasks-feedback", () =>
        t("Tarefa criada. O pedido será executado na conversa escolhida."),
      );
    });
  };
  return {
    load: loadSettings,
    refreshLabel: updateLabel,
    updateProviders: renderProviderConnections,
    updateConversation(value) {
      currentSettings = value;
      updateLabel();
    },
    reset() {
      connectionGeneration++;
      clearConnectionInputs();
      customConnectionsUI.reset();
      connectionProviders = [];
      $("provider-connections").disabled = true;
      settings = null;
      currentSettings = null;
      servers = [];
      discovered.clear();
      taskRunRequests.clear();
      closeEditor();
      $("task-prompt").value = "";
      $("tasks-list").replaceChildren();
      $("mcp-list").replaceChildren();
    },
  };
}
