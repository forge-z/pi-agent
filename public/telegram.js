const { errorText, t, text, plain, locale } = globalThis.PiI18n || {
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
    text($("telegram-form-error"), message);
  }

  function setStatusMessage(message = "") {
    text($("telegram-status-message"), message);
  }

  function botLabel(bot) {
    if (!bot) return t("Bot não identificado");
    const details = [];
    if (bot.username)
      details.push(`@${String(bot.username).replace(/^@/, "")}`);
    if (bot.firstName && !bot.username) details.push(bot.firstName);
    if (bot.id !== undefined && bot.id !== null) details.push(`ID ${bot.id}`);
    return details.join(" · ") || t("Bot não identificado");
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
    return t("Última atividade confirmada: {0}.", [
      date.toLocaleString(locale()),
    ]);
  }

  function updateConflict(status) {
    const canOfferSwitch =
      status.state === "webhook_conflict" &&
      !conflictDismissed &&
      !switchOutcomeUnknown &&
      !pendingConnectRetry;
    conflictPanel.hidden = !canOfferSwitch;
    if (!canOfferSwitch) return;
    text($("telegram-conflict-bot"), () =>
      t("Bot: {0}.", [botLabel(status.bot)]),
    );
    text(
      $("telegram-webhook-url"),
      () => status.webhookUrl || t("Endereço não informado"),
    );
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
    text(stateNode, () => t(labels[state] || state));
    text($("telegram-bot"), () => botLabel(status.bot));
    text($("telegram-last-success"), () =>
      formatLastSuccess(status.lastSuccessAt),
    );
    const awaitingFirstMessage =
      state === "connected" && status.awaitingFirstMessage === true;
    const firstMessage = $("telegram-first-message");
    firstMessage.hidden = !awaitingFirstMessage;
    text(firstMessage, () =>
      awaitingFirstMessage
        ? t(
            "Abra o bot e envie uma mensagem privada do ID autorizado para vincular esta conversa.",
          )
        : "",
    );
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
      text(commandMenuStatus, () => t(commandMenu.message));
    } else {
      delete commandMenuStatus.dataset.state;
      plain(commandMenuStatus, "");
    }
    setStatusMessage(() =>
      pendingConnectRetry
        ? t(
            "A conexão pode ter sido iniciada. Tente novamente para consultar o mesmo pedido sem duplicar a conexão.",
          )
        : switchOutcomeUnknown
          ? t(
              "Resultado da troca não confirmado. Status atual: {0}. Inicie uma nova conexão apenas se quiser tentar novamente.",
              [t(labels[state] || state)],
            )
          : errorText(status.error || "") || t(stateMessages[state] || ""),
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
    text(
      $("telegram-linked-title"),
      () => status.conversationTitle || t("Conversa sem título"),
    );
    text($("telegram-linked-id"), () =>
      status.conversationId ? t("ID {0}", [status.conversationId]) : "",
    );
    text(
      $("telegram-target-title"),
      () => currentConversationTitle || t("Conversa atual"),
    );
    text($("telegram-target-id"), () =>
      currentConversationId ? t("ID {0}", [currentConversationId]) : "",
    );

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
        setStatusMessage(() =>
          t(
            "O resultado da troca não pôde ser confirmado. O status foi atualizado; para tentar novamente, inicie uma nova conexão e confirme a troca somente se o conflito continuar.",
          ),
        );
    } catch (error) {
      if (current(id)) setFormError(() => errorText(error.message));
    }
  }

  function startPolling(id) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!current(id) || statusRequestSession === id || mutationInFlight)
        return;
      void loadStatus(id).catch((error) => {
        if (current(id)) setFormError(() => errorText(error.message));
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
      setFormError(() =>
        t("Selecione uma conversa antes de conectar o Telegram."),
      );
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
    setStatusMessage(() =>
      isRetry ? t("Repetindo a mesma solicitação…") : t("Conectando…"),
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
          () =>
            errorText(status.error || "") ||
            t(
              "Bot identificado. Um webhook existente impede o polling; revise os dados antes de confirmar a troca.",
            ),
        );
      } else {
        clearToken();
        setStatusMessage(
          () =>
            errorText(status.error || "") ||
            (status.state === "connected"
              ? t("Conexão com o Telegram concluída.")
              : t(stateMessages[status.state] || "Solicitação recebida.")),
        );
      }
    } catch (error) {
      if (!current(id)) return;
      if (error.status === undefined || error.status >= 500) {
        pendingConnectRetry = { payload };
        setStatusMessage(() =>
          t(
            "Não foi possível confirmar o resultado. Uma nova tentativa usará a mesma solicitação para evitar duplicar a conexão.",
          ),
        );
        retryActions.hidden = false;
        setFormError("");
        await refreshStatus(id);
      } else {
        pendingConnectRetry = null;
        clearToken();
        setFormError(() => errorText(error.message));
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
      setFormError(() =>
        t("Atualize o status para confirmar os dados do webhook."),
      );
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
    setStatusMessage(() => t("Trocando para polling…"));
    resetSubmitControls();
    try {
      const status = await api("/api/telegram/connect", "POST", payload);
      if (!current(id)) return;
      switchOutcomeUnknown = false;
      conflictDismissed = false;
      renderStatus(status);
      if (status.state !== "webhook_conflict") clearToken();
      setStatusMessage(
        () =>
          errorText(status.error || "") ||
          (status.state === "webhook_conflict"
            ? t(
                "Bot identificado. Um webhook ainda impede o polling; revise o conflito antes de confirmar outra troca.",
              )
            : status.state === "connected"
              ? t("Conexão com polling concluída.")
              : t(stateMessages[status.state] || "Solicitação recebida.")),
      );
    } catch (error) {
      if (!current(id)) return;
      clearToken();
      if (error.status === undefined || error.status >= 500) {
        switchOutcomeUnknown = true;
        conflictPanel.hidden = true;
        setStatusMessage(() =>
          t(
            "Não foi possível confirmar a troca. O status será atualizado; se ainda houver conflito, inicie uma nova conexão antes de confirmar outra troca.",
          ),
        );
        await refreshStatus(id);
      } else {
        setFormError(() => errorText(error.message));
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
    setStatusMessage(() => t("Desconectando…"));
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
      setStatusMessage(
        () => errorText(status.error || "") || t("Telegram desconectado."),
      );
    } catch (error) {
      if (!current(id)) return;
      clearToken();
      if (error.status === undefined || error.status >= 500) {
        setStatusMessage(() =>
          t(
            "Não foi possível confirmar a desconexão. O status será atualizado.",
          ),
        );
        await refreshStatus(id);
      } else {
        setFormError(() => errorText(error.message));
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
    setStatusMessage(() => t("Carregando o estado da conexão…"));
    $("telegram-state").dataset.state = "connecting";
    text($("telegram-state"), () => t("Verificando"));
    text($("telegram-bot"), () => t("Bot não identificado"));
    plain($("telegram-target-title"), currentConversationTitle);
    plain($("telegram-target-id"), currentConversationId || "");
    retryActions.hidden = true;
    conflictPanel.hidden = true;
    if (!dialog.open) dialog.showModal();
    resetSubmitControls();
    tokenInput.focus();
    void loadStatus(id, { initial: true })
      .catch((error) => {
        if (current(id)) setFormError(() => errorText(error.message));
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
    setStatusMessage(() => t("Troca cancelada. O webhook atual foi mantido."));
  });
  disconnectButton.addEventListener("click", () => void disconnect());
  userIdInput.addEventListener("input", () => {
    userIdTouched = true;
    userIdInput.setCustomValidity("");
  });
  tokenInput.addEventListener("input", () => tokenInput.setCustomValidity(""));
  dialog.addEventListener("close", closeDialog);
}
