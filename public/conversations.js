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

export function attachConversationManagementUI(api, callbacks) {
  const list = $("conversations");
  const count = $("conversation-count");
  const search = $("search-conversations");
  const empty = $("search-empty");
  const heading = $("conversation-list-heading");
  const toggleView = $("toggle-deleted-conversations");
  const dialog = $("conversation-management-dialog");
  const form = $("conversation-management-form");
  const renameFields = $("conversation-management-rename-fields");
  const deleteFields = $("conversation-management-delete-fields");
  const deleteNotice = $("conversation-management-delete-notice");
  const deleteDeadline = $("conversation-management-deadline");
  const deleteAcknowledgement = $(
    "conversation-management-delete-acknowledgement",
  );
  const nameInput = $("conversation-management-name");
  const confirmDelete = $("conversation-management-confirm-delete");
  const submit = $("conversation-management-submit");
  const cancel = $("conversation-management-cancel");
  const closeDialog = $("conversation-management-close");
  const error = $("conversation-management-error");

  let showingDeleted = false;
  let deletedConversations = [];
  let deletedLoadVersion = 0;
  let target = null;
  let mode = null;
  let mutationInFlight = false;
  let openActionPanel = null;
  let openActionToggle = null;

  function button(label, className = "") {
    const element = document.createElement("button");
    element.type = "button";
    text(element, label);
    if (className) element.className = className;
    return element;
  }

  function telegramOriginIcon() {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "icon conversation-telegram-icon");
    icon.setAttribute("aria-hidden", "true");
    attr(icon, "title", () => t("Conversa Telegram"));
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "/icons.svg#telegram-logo");
    icon.append(use);
    return icon;
  }

  function report(error) {
    callbacks.report?.(error);
  }

  async function loadDeletedConversations() {
    const version = ++deletedLoadVersion;
    const conversations = await api("/api/conversations?deleted=1");
    if (version !== deletedLoadVersion) return false;
    deletedConversations = conversations;
    return true;
  }

  function deadline(conversation) {
    if (!Number.isFinite(conversation.purgeAt))
      return t(
        "Prazo de exclusão indisponível. Atualize a lista antes de continuar.",
      );
    return new Intl.DateTimeFormat(locale(), {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(conversation.purgeAt));
  }

  function handle(action, onError = report) {
    return async (...args) => {
      try {
        return await action(...args);
      } catch (error) {
        onError(error);
      }
    };
  }

  function closeActions() {
    if (openActionPanel) openActionPanel.hidden = true;
    openActionToggle?.setAttribute("aria-expanded", "false");
    openActionPanel = null;
    openActionToggle = null;
    list.setAttribute("data-actions-open", "false");
  }

  function render(items = callbacks.getConversations()) {
    const source = showingDeleted ? deletedConversations : items;
    const query = search.value.toLocaleLowerCase(locale());
    const filtered = source.filter((conversation) =>
      conversation.title.toLocaleLowerCase(locale()).includes(query),
    );
    plain(count, String(source.length));
    text(heading, () =>
      showingDeleted ? t("CONVERSAS EXCLUÍDAS") : t("SUAS CONVERSAS"),
    );
    text(toggleView, () =>
      showingDeleted ? t("Voltar às conversas") : t("Conversas excluídas"),
    );
    toggleView.setAttribute("aria-pressed", String(showingDeleted));
    empty.hidden = filtered.length > 0;
    text(empty, () =>
      showingDeleted
        ? t("Nenhuma conversa excluída encontrada.")
        : t("Nenhuma conversa encontrada."),
    );
    closeActions();
    list.replaceChildren();

    for (const conversation of filtered) {
      const row = document.createElement("div");
      row.className = showingDeleted
        ? "conversation-row deleted-conversation-row"
        : "conversation-row";
      row.setAttribute("data-conversation-id", conversation.id);

      if (showingDeleted) {
        if (conversation.channel === "telegram")
          row.append(telegramOriginIcon());
        const title = document.createElement("span");
        title.className = "conversation-label deleted-conversation-label";
        plain(title, conversation.title);
        row.append(title);
      } else {
        const select = button("", "conversation-select");
        select.setAttribute("data-conversation-id", conversation.id);
        select.setAttribute(
          "aria-current",
          String(conversation.id === callbacks.getConversationId()),
        );
        select.title = conversation.title;
        const label = document.createElement("span");
        label.className = "conversation-label";
        plain(label, conversation.title);
        if (conversation.channel === "telegram") {
          attr(select, "aria-description", () => t("Conversa Telegram"));
          select.append(telegramOriginIcon());
        }
        select.append(label);
        select.onclick = handle(async () => {
          callbacks.closeSidebar();
          await callbacks.selectConversation(
            conversation.id,
            conversation.title,
          );
        });
        row.append(select);
      }

      const actionToggle = button(
        "⋯",
        "icon-button conversation-actions-toggle",
      );
      attr(actionToggle, "aria-label", () =>
        t("Ações para {0}", [conversation.title]),
      );
      actionToggle.setAttribute("aria-expanded", "false");
      actionToggle.setAttribute("data-conversation-id", conversation.id);
      const actions = document.createElement("div");
      actions.className = "conversation-action-panel";
      actions.id = `conversation-actions-${encodeURIComponent(conversation.id)}`;
      actions.setAttribute("data-actions", "true");
      attr(actions, "aria-label", () =>
        t("Ações para {0}", [conversation.title]),
      );
      actions.hidden = true;
      actionToggle.setAttribute("aria-controls", actions.id);
      actionToggle.onclick = () => {
        if (openActionPanel === actions) {
          closeActions();
          return;
        }
        closeActions();
        actions.hidden = false;
        actionToggle.setAttribute("aria-expanded", "true");
        openActionPanel = actions;
        openActionToggle = actionToggle;
        list.setAttribute("data-actions-open", "true");
      };
      row.append(actionToggle, actions);

      if (showingDeleted) {
        const purgeDeadline = document.createElement("span");
        purgeDeadline.className = "conversation-purge-deadline";
        text(purgeDeadline, () =>
          Number.isFinite(conversation.purgeAt)
            ? t("Exclusão definitiva em {0}", [deadline(conversation)])
            : deadline(conversation),
        );
        row.append(purgeDeadline);
        const restore = button(
          () => t("Restaurar"),
          "subtle conversation-action",
        );
        restore.setAttribute("data-conversation-id", conversation.id);
        restore.onclick = handle(() => restoreConversation(conversation));
        const purge = button(
          () => t("Excluir agora"),
          "subtle conversation-action",
        );
        purge.disabled =
          !Number.isFinite(conversation.deletedAt) ||
          !Number.isFinite(conversation.purgeAt);
        purge.setAttribute("data-conversation-id", conversation.id);
        purge.onclick = () => {
          if (purge.disabled) return;
          closeActions();
          openDialog("purge", conversation);
        };
        actions.append(restore, purge);
      } else {
        const rename = button(
          () => t("Renomear"),
          "subtle conversation-action",
        );
        rename.setAttribute("data-conversation-id", conversation.id);
        rename.onclick = () => {
          closeActions();
          openDialog("rename", conversation);
        };
        const remove = button(() => t("Excluir"), "subtle conversation-action");
        remove.setAttribute("data-conversation-id", conversation.id);
        remove.onclick = () => {
          closeActions();
          openDialog("delete", conversation);
        };
        actions.append(rename, remove);
      }
      list.append(row);
    }
  }

  function focusActions(id) {
    const row = [...list.children].find(
      (item) => item.getAttribute("data-conversation-id") === id,
    );
    [...(row?.children || [])]
      .find((item) => item.className.includes("conversation-actions-toggle"))
      ?.focus();
  }

  function setMutationInFlight(inFlight) {
    mutationInFlight = inFlight;
    cancel.disabled = inFlight;
    closeDialog.disabled = inFlight;
  }

  function openDialog(nextMode, conversation) {
    callbacks.closeSidebar();
    target = conversation;
    mode = nextMode;
    plain(error, "");
    renameFields.hidden = mode !== "rename";
    deleteFields.hidden = mode === "rename";
    nameInput.required = mode === "rename";
    confirmDelete.required = mode !== "rename";
    confirmDelete.checked = false;
    submit.disabled = mode !== "rename";
    if (mode === "rename") {
      text($("conversation-management-title"), () => t("Renomear conversa"));
      text($("conversation-management-intro"), () =>
        t("Escolha um título de até 100 caracteres."),
      );
      nameInput.value = conversation.title;
      text(submit, () => t("Salvar título"));
    } else if (mode === "purge") {
      text(deleteDeadline, () =>
        t("Exclusão definitiva em {0}", [deadline(conversation)]),
      );
      text($("conversation-management-title"), () =>
        t("Excluir definitivamente?"),
      );
      text($("conversation-management-intro"), () =>
        t(
          "A conversa ‘{0}’ e seus dados serão excluídos definitivamente agora. Essa ação não pode ser desfeita.",
          [conversation.title],
        ),
      );
      text(deleteNotice, () =>
        t(
          "Esta conversa não poderá mais ser restaurada. O prazo previsto era {0}.",
          [deadline(conversation)],
        ),
      );
      text(deleteAcknowledgement, () =>
        t("Entendo que esta exclusão é definitiva e não poderá ser desfeita."),
      );
      text(submit, () => t("Excluir agora"));
    } else {
      const forecast = { purgeAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
      text(deleteDeadline, () =>
        t(
          "Exclusão definitiva prevista em {0}; o prazo de 7 dias começa ao confirmar.",
          [deadline(forecast)],
        ),
      );
      text($("conversation-management-title"), () => t("Excluir conversa?"));
      text($("conversation-management-intro"), () =>
        t(
          "A conversa será mantida por 7 dias e depois excluída definitivamente. As tarefas serão pausadas, e o Telegram precisará ser vinculado novamente antes de continuar usando o bot.",
        ),
      );
      text(submit, () => t("Excluir conversa"));
      text(deleteNotice, () =>
        t(
          "Você poderá restaurar a conversa durante 7 dias. Depois desse prazo, ela será excluída definitivamente. A restauração não reativa tarefas nem vincula o Telegram.",
        ),
      );
      text(deleteAcknowledgement, () =>
        t("Entendo as consequências e quero excluir esta conversa."),
      );
    }
    dialog.showModal();
    if (mode === "rename") nameInput.focus();
    else confirmDelete.focus();
  }

  function setDialogError(message) {
    text(error, message);
    if (message) error.focus?.();
  }

  async function renameConversation() {
    if (!target || mode !== "rename") return;
    const original = target;
    const id = original.id;
    const title = nameInput.value.trim();
    if (
      title.length < 1 ||
      title.length > 100 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(title)
    ) {
      setDialogError(() =>
        t("Use um título de 1 a 100 caracteres, sem caracteres de controle."),
      );
      return;
    }
    submit.disabled = true;
    setDialogError("");
    setMutationInFlight(true);
    let updated;
    try {
      updated = await api(
        `/api/conversations/${encodeURIComponent(id)}`,
        "PUT",
        { title },
      );
    } catch (caught) {
      setDialogError(
        () =>
          errorText(caught.message) ||
          t("Não foi possível renomear a conversa."),
      );
      submit.disabled = false;
      setMutationInFlight(false);
      return;
    }
    const conversation = {
      ...original,
      ...updated,
      id,
      title: updated?.title || title,
    };
    callbacks.onRenamed?.(conversation);
    dialog.close();
    setMutationInFlight(false);
    try {
      await callbacks.loadConversations();
      focusActions(id);
    } catch (caught) {
      report(caught);
    }
  }

  async function deleteConversation() {
    if (!target || mode !== "delete" || mutationInFlight) return;
    if (!confirmDelete.checked) {
      submit.disabled = true;
      return;
    }
    const id = target.id;
    submit.disabled = true;
    setDialogError("");
    setMutationInFlight(true);
    let wasActive;
    try {
      await api(`/api/conversations/${encodeURIComponent(id)}`, "DELETE", {
        confirm: true,
      });
    } catch (caught) {
      setDialogError(
        () =>
          errorText(caught.message) ||
          t("Não foi possível excluir a conversa."),
      );
      submit.disabled = false;
      setMutationInFlight(false);
      return;
    }
    wasActive = id === callbacks.getConversationId();
    dialog.close();
    setMutationInFlight(false);
    try {
      await callbacks.afterDelete(id, wasActive);
    } catch (caught) {
      report(caught);
    }
  }

  async function purgeConversation() {
    if (!target || mode !== "purge" || mutationInFlight) return;
    if (!confirmDelete.checked) {
      submit.disabled = true;
      return;
    }
    const original = target;
    submit.disabled = true;
    setDialogError("");
    setMutationInFlight(true);
    try {
      await api(
        `/api/conversations/${encodeURIComponent(original.id)}/purge`,
        "POST",
        {
          confirm: true,
          expectedDeletedAt: original.deletedAt,
        },
      );
    } catch (caught) {
      setDialogError(
        () =>
          errorText(caught.message) ||
          t("Não foi possível excluir definitivamente a conversa."),
      );
      submit.disabled = false;
      setMutationInFlight(false);
      return;
    }
    deletedLoadVersion++;
    deletedConversations = deletedConversations.filter(
      (item) => item.id !== original.id,
    );
    dialog.close();
    setMutationInFlight(false);
    render();
    toggleView.focus();
    try {
      if (await loadDeletedConversations()) render();
    } catch (caught) {
      report(caught);
    }
  }

  async function restoreConversation(conversation) {
    await api(
      `/api/conversations/${encodeURIComponent(conversation.id)}/restore`,
      "POST",
      {},
    );
    deletedLoadVersion++;
    deletedConversations = deletedConversations.filter(
      (item) => item.id !== conversation.id,
    );
    render();
    await callbacks.loadConversations();
    if (await loadDeletedConversations()) render();
    if (deletedConversations.some((item) => item.id === conversation.id))
      focusActions(conversation.id);
    else toggleView.focus();
  }

  async function toggleDeletedView() {
    if (showingDeleted) {
      deletedLoadVersion++;
      showingDeleted = false;
      render();
      return;
    }
    if (!(await loadDeletedConversations())) return;
    showingDeleted = true;
    render();
  }

  async function refreshDeletedView() {
    if (!showingDeleted) return false;
    if (!(await loadDeletedConversations()) || !showingDeleted) return false;
    render();
    return true;
  }

  function reset() {
    deletedLoadVersion++;
    showingDeleted = false;
    deletedConversations = [];
    closeActions();
  }

  function showActiveView() {
    deletedLoadVersion++;
    showingDeleted = false;
    render();
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    if (mode === "rename") return renameConversation();
    if (mode === "delete") return deleteConversation();
    if (mode === "purge") return purgeConversation();
  };
  confirmDelete.addEventListener("change", () => {
    submit.disabled = !confirmDelete.checked;
  });
  cancel.onclick = () => dialog.close();
  toggleView.onclick = handle(toggleDeletedView);
  search.oninput = () => render();
  dialog.addEventListener("close", () => {
    target = null;
    mode = null;
    setDialogError("");
  });
  dialog.addEventListener("cancel", (event) => {
    if (mutationInFlight) event.preventDefault();
  });

  return {
    render,
    showActiveView,
    isDeletedView: () => showingDeleted,
    getDeletedConversations: () => deletedConversations,
    refreshDeletedView,
    reset,
  };
}
