const labels = {
  unconfigured: "Não configurado",
  migration_required: "Reconexão necessária",
  disconnected: "Desconectado",
  connecting: "Conectando",
  connected: "Conectado",
  retrying: "Tentando reconectar",
  blocked: "Bloqueado",
  webhook_conflict: "Webhook existente",
};

const stateMessages = {
  unconfigured: "Informe os dados do bot para conectar.",
  migration_required: "Atualize a conexão do Telegram para continuar.",
  disconnected: "O Telegram está desconectado.",
  connecting: "A conexão está sendo iniciada.",
  connected: "O bot está conectado.",
  retrying: "O serviço está tentando restabelecer a conexão.",
  blocked: "A conexão precisa de atenção.",
  webhook_conflict: "O bot já recebe atualizações por um webhook.",
};
const commandMenuStates = new Set([
  "waiting",
  "syncing",
  "ready",
  "retrying",
  "conflict",
  "uncertain",
]);

const $ = (id) => document.getElementById(id);

export function attachTelegramUI(
  api,
  { getConversationId, getConversationTitle },
) {
  const dialog = $("telegram-dialog");
  const form = $("telegram-form");
  const tokenInput = $("telegram-token");
  const userIdInput = $("telegram-user-id");
  const connectButton = $("telegram-connect");
  const disconnectButton = $("telegram-disconnect");
  const retryActions = $("telegram-retry-actions");
  const conflictPanel = $("telegram-conflict");
  let session = 0;
  let pollTimer = null;
  let statusRequestSession = null;
  let mutationInFlight = false;
  let currentConversationId = null;
  let currentConversationTitle = "";
  let latestStatus = null;
  let pendingConnectRetry = null;
  let switchOutcomeUnknown = false;
  let conflictDismissed = false;
  let userIdTouched = false;

  function current(id) {
    return id === session && dialog.open;
  }

  function clearToken() {
    tokenInput.value = "";
  }

  function resetSubmitControls() {
    const locked = Boolean(pendingConnectRetry) || mutationInFlight;
    tokenInput.disabled = locked;
    userIdInput.disabled = locked;
    connectButton.disabled = locked || !currentConversationId;
    disconnectButton.disabled =
      mutationInFlight || Boolean(pendingConnectRetry);
    $("telegram-replace-webhook").disabled =
      mutationInFlight || Boolean(pendingConnectRetry);
    $("telegram-retry").disabled = mutationInFlight;
    $("telegram-refresh").disabled = statusRequestSession === session;
  }

  function setFormError(message = "") {
    $("telegram-form-error").textContent = message;
  }

  function setStatusMessage(message = "") {
    $("telegram-status-message").textContent = message;
  }

  function botLabel(bot) {
    if (!bot) return "Bot não identificado";
    const details = [];
    if (bot.username)
      details.push(`@${String(bot.username).replace(/^@/, "")}`);
    if (bot.firstName && !bot.username) details.push(bot.firstName);
    if (bot.id !== undefined && bot.id !== null) details.push(`ID ${bot.id}`);
    return details.join(" · ") || "Bot não identificado";
  }

  function safeBotUrl(bot) {
    const username = String(bot?.username || "").replace(/^@/, "");
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(username)) return null;
    return `https://t.me/${encodeURIComponent(username)}`;
  }

  function formatLastSuccess(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    const timestamp = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return `Última atividade confirmada: ${date.toLocaleString("pt-BR")}.`;
  }

  function updateConflict(status) {
    const canOfferSwitch =
      status.state === "webhook_conflict" &&
      !conflictDismissed &&
      !switchOutcomeUnknown &&
      !pendingConnectRetry;
    conflictPanel.hidden = !canOfferSwitch;
    if (!canOfferSwitch) return;
    $("telegram-conflict-bot").textContent = `Bot: ${botLabel(status.bot)}.`;
    $("telegram-webhook-url").textContent =
      status.webhookUrl || "Endereço não informado";
    $("telegram-replace-webhook").disabled =
      mutationInFlight ||
      !status.webhookVersion ||
      !Number.isSafeInteger(status.bot?.id);
  }

  function renderStatus(status, { initial = false } = {}) {
    if (!status || typeof status.state !== "string")
      throw new Error(
        "O servidor retornou um estado inválido para o Telegram.",
      );
    const state = status.state;
    if (
      switchOutcomeUnknown &&
      state !== "webhook_conflict" &&
      state !== "connecting" &&
      state !== "retrying"
    )
      switchOutcomeUnknown = false;
    latestStatus = status;
    const stateNode = $("telegram-state");
    stateNode.dataset.state = state;
    stateNode.textContent = labels[state] || state;
    $("telegram-bot").textContent = botLabel(status.bot);
    $("telegram-last-success").textContent = formatLastSuccess(
      status.lastSuccessAt,
    );
    const awaitingFirstMessage =
      state === "connected" && status.awaitingFirstMessage === true;
    const firstMessage = $("telegram-first-message");
    firstMessage.hidden = !awaitingFirstMessage;
    firstMessage.textContent = awaitingFirstMessage
      ? "Abra o bot e envie uma mensagem privada do ID autorizado para vincular esta conversa."
      : "";
    const commandMenu = status.commandMenu;
    const commandMenuStatus = $("telegram-command-menu-status");
    const hasCommandMenuStatus = Boolean(
      commandMenu &&
      commandMenuStates.has(commandMenu.state) &&
      typeof commandMenu.message === "string" &&
      commandMenu.message.trim(),
    );
    commandMenuStatus.hidden = !hasCommandMenuStatus;
    if (hasCommandMenuStatus) {
      commandMenuStatus.dataset.state = commandMenu.state;
      commandMenuStatus.textContent = commandMenu.message;
    } else {
      delete commandMenuStatus.dataset.state;
      commandMenuStatus.textContent = "";
    }
    setStatusMessage(
      pendingConnectRetry
        ? "A conexão pode ter sido iniciada. Tente novamente para consultar o mesmo pedido sem duplicar a conexão."
        : switchOutcomeUnknown
          ? `Resultado da troca não confirmado. Status atual: ${labels[state] || state}. Inicie uma nova conexão apenas se quiser tentar novamente.`
          : status.error || stateMessages[state] || "",
    );

    const botUrl = safeBotUrl(status.bot);
    const openBot = $("telegram-open-bot");
    openBot.hidden = !botUrl;
    if (botUrl) openBot.href = botUrl;
    else openBot.removeAttribute("href");

    const linked = Boolean(
      status.configured && (status.conversationId || status.conversationTitle),
    );
    $("telegram-linked").hidden = !linked;
    $("telegram-linked-title").textContent =
      status.conversationTitle || "Conversa sem título";
    $("telegram-linked-id").textContent = status.conversationId
      ? `ID ${status.conversationId}`
      : "";
    $("telegram-target-title").textContent =
      currentConversationTitle || "Conversa atual";
    $("telegram-target-id").textContent = currentConversationId
      ? `ID ${currentConversationId}`
      : "";

    if (initial && !userIdTouched)
      userIdInput.value = status.userId ? String(status.userId) : "";
    tokenInput.required = !status.hasToken;
    disconnectButton.hidden = !status.configured;
    updateConflict(status);
    resetSubmitControls();
  }

  async function loadStatus(id = session, { initial = false } = {}) {
    if (!current(id) || statusRequestSession === id) return null;
    statusRequestSession = id;
    resetSubmitControls();
    try {
      const status = await api("/api/telegram");
      if (!current(id)) return null;
      renderStatus(status, { initial });
      return status;
    } finally {
      if (statusRequestSession === id) statusRequestSession = null;
      resetSubmitControls();
    }
  }

  async function refreshStatus(id = session) {
    try {
      await loadStatus(id);
      if (current(id) && switchOutcomeUnknown)
        setStatusMessage(
          "O resultado da troca não pôde ser confirmado. O status foi atualizado; para tentar novamente, inicie uma nova conexão e confirme a troca somente se o conflito continuar.",
        );
    } catch (error) {
      if (current(id)) setFormError(error.message);
    }
  }

  function startPolling(id) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!current(id) || statusRequestSession === id || mutationInFlight)
        return;
      void loadStatus(id).catch((error) => {
        if (current(id)) setFormError(error.message);
      });
    }, 3000);
  }

  function connectionPayload(requestId) {
    const userId = userIdInput.value.trim();
    if (!userIdInput.checkValidity()) {
      userIdInput.reportValidity();
      return null;
    }
    if (!currentConversationId) {
      setFormError("Selecione uma conversa antes de conectar o Telegram.");
      return null;
    }
    const payload = {
      requestId,
      userId,
      conversationId: currentConversationId,
    };
    const token = tokenInput.value.trim();
    if (token) payload.token = token;
    if (!latestStatus?.hasToken && !token) {
      tokenInput.setCustomValidity("Informe o token do bot.");
      tokenInput.reportValidity();
      tokenInput.setCustomValidity("");
      return null;
    }
    return payload;
  }

  async function runConnect(payload, id, { isRetry = false } = {}) {
    mutationInFlight = true;
    setFormError("");
    setStatusMessage(
      isRetry ? "Repetindo a mesma solicitação…" : "Conectando…",
    );
    resetSubmitControls();
    try {
      const status = await api("/api/telegram/connect", "POST", payload);
      if (!current(id)) return;
      pendingConnectRetry = null;
      switchOutcomeUnknown = false;
      conflictDismissed = false;
      renderStatus(status);
      if (status.state === "webhook_conflict") {
        // Keep the token only so the user can explicitly confirm the switch.
        setStatusMessage(
          status.error ||
            "Bot identificado. Um webhook existente impede o polling; revise os dados antes de confirmar a troca.",
        );
      } else {
        clearToken();
        setStatusMessage(
          status.error ||
            (status.state === "connected"
              ? "Conexão com o Telegram concluída."
              : stateMessages[status.state] || "Solicitação recebida."),
        );
      }
    } catch (error) {
      if (!current(id)) return;
      if (error.status === undefined || error.status >= 500) {
        pendingConnectRetry = { payload };
        setStatusMessage(
          "Não foi possível confirmar o resultado. Uma nova tentativa usará a mesma solicitação para evitar duplicar a conexão.",
        );
        retryActions.hidden = false;
        setFormError("");
        await refreshStatus(id);
      } else {
        pendingConnectRetry = null;
        clearToken();
        setFormError(error.message);
      }
    } finally {
      if (current(id)) {
        mutationInFlight = false;
        retryActions.hidden = !pendingConnectRetry;
        resetSubmitControls();
      }
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (mutationInFlight || pendingConnectRetry) return;
    setFormError("");
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const payload = connectionPayload(crypto.randomUUID());
    if (payload) await runConnect(payload, session);
  }

  async function switchToPolling() {
    if (mutationInFlight || pendingConnectRetry || !latestStatus) return;
    const conflict = latestStatus;
    if (
      conflict.state !== "webhook_conflict" ||
      !conflict.webhookVersion ||
      !Number.isSafeInteger(conflict.bot?.id)
    ) {
      setFormError("Atualize o status para confirmar os dados do webhook.");
      return;
    }
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const payload = connectionPayload(crypto.randomUUID());
    if (!payload) return;
    payload.replaceWebhook = true;
    payload.expectedWebhook = conflict.webhookVersion;
    payload.expectedBotId = conflict.bot.id;

    const id = session;
    mutationInFlight = true;
    setFormError("");
    setStatusMessage("Trocando para polling…");
    resetSubmitControls();
    try {
      const status = await api("/api/telegram/connect", "POST", payload);
      if (!current(id)) return;
      switchOutcomeUnknown = false;
      conflictDismissed = false;
      renderStatus(status);
      if (status.state !== "webhook_conflict") clearToken();
      setStatusMessage(
        status.error ||
          (status.state === "webhook_conflict"
            ? "Bot identificado. Um webhook ainda impede o polling; revise o conflito antes de confirmar outra troca."
            : status.state === "connected"
              ? "Conexão com polling concluída."
              : stateMessages[status.state] || "Solicitação recebida."),
      );
    } catch (error) {
      if (!current(id)) return;
      clearToken();
      if (error.status === undefined || error.status >= 500) {
        switchOutcomeUnknown = true;
        conflictPanel.hidden = true;
        setStatusMessage(
          "Não foi possível confirmar a troca. O status será atualizado; se ainda houver conflito, inicie uma nova conexão antes de confirmar outra troca.",
        );
        await refreshStatus(id);
      } else {
        setFormError(error.message);
      }
    } finally {
      if (current(id)) {
        mutationInFlight = false;
        resetSubmitControls();
        if (latestStatus) updateConflict(latestStatus);
      }
    }
  }

  async function disconnect() {
    if (mutationInFlight || pendingConnectRetry) return;
    const id = session;
    mutationInFlight = true;
    setFormError("");
    setStatusMessage("Desconectando…");
    resetSubmitControls();
    try {
      const status = await api("/api/telegram/disconnect", "POST", {
        requestId: crypto.randomUUID(),
      });
      if (!current(id)) return;
      pendingConnectRetry = null;
      switchOutcomeUnknown = false;
      clearToken();
      renderStatus(status);
      setStatusMessage(status.error || "Telegram desconectado.");
    } catch (error) {
      if (!current(id)) return;
      clearToken();
      if (error.status === undefined || error.status >= 500) {
        setStatusMessage(
          "Não foi possível confirmar a desconexão. O status será atualizado.",
        );
        await refreshStatus(id);
      } else {
        setFormError(error.message);
      }
    } finally {
      if (current(id)) {
        mutationInFlight = false;
        resetSubmitControls();
      }
    }
  }

  function openDialog() {
    session += 1;
    const id = session;
    clearInterval(pollTimer);
    mutationInFlight = false;
    statusRequestSession = null;
    pendingConnectRetry = null;
    switchOutcomeUnknown = false;
    conflictDismissed = false;
    userIdTouched = false;
    latestStatus = null;
    currentConversationId = getConversationId() || null;
    currentConversationTitle = getConversationTitle() || "Nova conversa";
    clearToken();
    tokenInput.required = true;
    userIdInput.value = "";
    setFormError("");
    setStatusMessage("Carregando o estado da conexão…");
    $("telegram-state").dataset.state = "connecting";
    $("telegram-state").textContent = "Verificando";
    $("telegram-bot").textContent = "Bot não identificado";
    $("telegram-target-title").textContent = currentConversationTitle;
    $("telegram-target-id").textContent = currentConversationId || "";
    retryActions.hidden = true;
    conflictPanel.hidden = true;
    if (!dialog.open) dialog.showModal();
    resetSubmitControls();
    tokenInput.focus();
    void loadStatus(id, { initial: true })
      .catch((error) => {
        if (current(id)) setFormError(error.message);
      })
      .finally(() => {
        if (current(id)) startPolling(id);
      });
  }

  function closeDialog() {
    session += 1;
    clearInterval(pollTimer);
    pollTimer = null;
    pendingConnectRetry = null;
    switchOutcomeUnknown = false;
    mutationInFlight = false;
    statusRequestSession = null;
    clearToken();
    userIdInput.value = "";
    setFormError("");
    retryActions.hidden = true;
    conflictPanel.hidden = true;
  }

  $("telegram-button").addEventListener("click", openDialog);
  form.addEventListener("submit", (event) => void submit(event));
  $("telegram-retry").addEventListener("click", () => {
    if (pendingConnectRetry)
      void runConnect(pendingConnectRetry.payload, session, { isRetry: true });
  });
  $("telegram-refresh").addEventListener("click", () => void refreshStatus());
  $("telegram-replace-webhook").addEventListener(
    "click",
    () => void switchToPolling(),
  );
  $("telegram-cancel-conflict").addEventListener("click", () => {
    conflictDismissed = true;
    conflictPanel.hidden = true;
    clearToken();
    setStatusMessage("Troca cancelada. O webhook atual foi mantido.");
  });
  disconnectButton.addEventListener("click", () => void disconnect());
  userIdInput.addEventListener("input", () => {
    userIdTouched = true;
    userIdInput.setCustomValidity("");
  });
  tokenInput.addEventListener("input", () => tokenInput.setCustomValidity(""));
  dialog.addEventListener("close", closeDialog);
}
