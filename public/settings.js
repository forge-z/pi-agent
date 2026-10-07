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
  readTools: [...(server.readTools || [])],
  actionTools: [...(server.actionTools || [])],
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
  let settings = null;
  let currentSettings = null;
  let servers = [];
  let editingName = null;
  let conversationTarget = null;
  let tools = [];
  let requestGeneration = 0;
  let mutationInFlight = false;
  const discovered = new Map();
  const taskRunRequests = new Map();

  function feedback(id, message = "") {
    $(id).textContent = message;
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
      feedback(errorId, error.message);
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
    const element = node("option", label);
    element.value = value;
    return element;
  }
  function populateEfforts(modelId, effortId, preferred) {
    const select = $(effortId);
    const model = settings.models.find(
      (entry) => entry.id === $(modelId).value,
    );
    const efforts = model?.efforts || [];
    select.replaceChildren(
      ...efforts.map((effort) => option(effort, effortNames[effort] || effort)),
    );
    if (efforts.includes(preferred)) select.value = preferred;
    else if (efforts.includes("medium")) select.value = "medium";
    select.disabled = efforts.length === 0;
  }
  function populateModels(modelId, effortId, preferred = settings) {
    const select = $(modelId);
    select.replaceChildren(
      ...settings.models.map((model) =>
        option(model.id, model.name || model.id),
      ),
    );
    if (settings.models.some((model) => model.id === preferred?.modelId))
      select.value = preferred.modelId;
    select.disabled = !settings.models.length;
    populateEfforts(modelId, effortId, preferred?.effort);
  }
  function updateLabel() {
    if (!currentSettings) return;
    const model = settings?.models.find(
      (entry) => entry.id === currentSettings.modelId,
    );
    $("model-label").textContent =
      `${model?.name || currentSettings.modelId} · ${effortNames[currentSettings.effort] || currentSettings.effort}`;
    $("model-label").setAttribute(
      "aria-label",
      `Ajustar modelo desta conversa: ${$("model-label").textContent}`,
    );
  }
  async function loadSettings() {
    settings = await api("/api/settings");
    servers = settings.mcp || (await api("/api/mcp"));
    updateLabel();
  }
  function show(dialogId) {
    callbacks.closeSidebar();
    feedback("settings-error");
    feedback("tasks-error");
    $(dialogId).showModal();
  }
  $("settings-button").onclick = () => {
    show("settings-dialog");
    feedback("settings-feedback", "Carregando suas configurações…");
    $("defaults-form").hidden = true;
    $("mcp-add").disabled = true;
    void act("settings-error", [], async () => {
      await loadSettings();
      populateModels("default-model", "default-effort");
      renderServers();
      $("defaults-form").hidden = false;
      $("mcp-add").disabled = false;
      feedback("settings-feedback");
    });
  };
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
        modelId: $("default-model").value,
        effort: $("default-effort").value,
      });
      await callbacks.refreshStatus();
      await loadSettings();
      feedback(
        "settings-feedback",
        "Padrão salvo. As novas conversas usarão estas escolhas.",
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
      populateModels(
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
          modelId: $("conversation-model").value,
          effort: $("conversation-effort").value,
        },
      );
      await callbacks.refreshConversation(conversationTarget);
      $("conversation-settings-dialog").close();
    });
  };

  function button(label, action, cls = "subtle") {
    const element = node("button", label, cls);
    element.type = "button";
    element.onclick = action;
    return element;
  }
  function deletionButton(label, remove, errorId) {
    let armed = false;
    const element = button(label, () => {
      if (!armed) {
        armed = true;
        element.textContent = "Confirmar exclusão";
        element.classList.add("danger-button");
        return;
      }
      void act(errorId, [element], remove);
    });
    element.addEventListener("blur", () => {
      if (!element.disabled) {
        armed = false;
        element.textContent = label;
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
      servers = await api("/api/mcp");
      renderServers();
    } finally {
      mutationInFlight = false;
    }
  }
  function renderServers() {
    const cards = servers.map((server) => {
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
        node(
          "p",
          `${server.readTools.length} leituras · ${server.actionTools.length} ações · ${server.tokenFile ? "Token em arquivo" : server.hasToken ? "Token salvo" : "Sem token"}`,
          "card-meta",
        ),
      );
      const actions = node("div", undefined, "card-buttons");
      actions.append(
        button("Editar", () => editServer(server)),
        deletionButton(
          "Excluir",
          async () => {
            await saveServers(
              servers.filter((entry) => entry.name !== server.name).map(config),
            );
            if (editingName === server.name) closeEditor();
            discovered.delete(server.name);
            feedback("settings-feedback", "Servidor excluído.");
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
            node(
              "p",
              "Nenhum servidor conectado. Adicione um endpoint para começar.",
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
    $("mcp-add").hidden = false;
  }
  function editServer(server = null) {
    closeEditor();
    editingName = server?.name || null;
    $("mcp-editor-title").textContent = server
      ? `Editar ${server.name}`
      : "Novo servidor";
    $("mcp-name").value = server?.name || "";
    $("mcp-name").readOnly = Boolean(server);
    $("mcp-url").value = server?.url || "";
    $("mcp-token-file").value = server?.tokenFile || "";
    $("mcp-token-file-details").hidden = !server?.tokenFile;
    $("mcp-token").disabled = Boolean(server?.tokenFile);
    $("mcp-read-tools").value = server?.readTools.join("\n") || "";
    $("mcp-action-tools").value = server?.actionTools.join("\n") || "";
    $("mcp-remove-token-row").hidden =
      !server?.hasToken || Boolean(server?.tokenFile);
    $("mcp-token-hint").textContent = server?.tokenFile
      ? "Este servidor usa um arquivo de token provisionado pelo operador."
      : server?.hasToken
        ? "Um token já está salvo. Deixe vazio para preservá-lo; preencha para substituí-lo."
        : "Opcional. O token salvo nunca é exibido aqui.";
    tools = discovered.get(editingName) || [];
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
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw new Error(
        "Use um endpoint HTTPS sem credenciais na URL ou fragmento.",
      );
    const readTools = names($("mcp-read-tools").value);
    const actionTools = names($("mcp-action-tools").value);
    if (readTools.some((tool) => actionTools.includes(tool)))
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
    const tokenFile = $("mcp-token-file").value.trim();
    if (tokenFile && $("mcp-token").value)
      throw new Error(
        "Escolha um token ou um arquivo de token para este servidor.",
      );
    return {
      name,
      url,
      readTools,
      actionTools,
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
        feedback("mcp-editor-feedback", "Salvando servidor…");
        // Tokens never enter the redacted config cache or the DOM after saving.
        await saveServers([
          ...servers
            .filter((server) => server.name !== editingName)
            .map(config),
          next,
        ]);
        if (generation !== requestGeneration) return;
        editingName = next.name;
        $("mcp-name").readOnly = true;
        $("mcp-token").value = "";
        $("mcp-remove-token").checked = false;
        $("mcp-token").disabled = Boolean(next.tokenFile);
        $("mcp-remove-token-row").hidden =
          Boolean(next.tokenFile) ||
          !servers.find((server) => server.name === editingName)?.hasToken;
        $("mcp-token-hint").textContent =
          "Deixe vazio para preservar o token salvo. Ele nunca é exibido aqui.";
        $("mcp-editor-title").textContent = `Editar ${editingName}`;
        feedback(
          "mcp-editor-feedback",
          "Servidor salvo. Você pode descobrir ferramentas e escolher as permissões abaixo.",
        );
      },
    );
  };
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
        feedback(
          "mcp-editor-feedback",
          "Consultando as ferramentas deste servidor…",
        );
        const result = await api(
          `/api/mcp/${encodeURIComponent(saved.name)}/tools`,
        );
        if (generation !== requestGeneration) return;
        tools = result.tools;
        discovered.set(saved.name, tools);
        renderTools();
        feedback(
          "mcp-editor-feedback",
          tools.length
            ? "Ferramentas encontradas. Marque as permitidas e salve o servidor para aplicar."
            : "O servidor não retornou ferramentas.",
        );
      },
    );
  };
  function renderTools() {
    const readTools = names($("mcp-read-tools").value);
    const actionTools = names($("mcp-action-tools").value);
    $("mcp-tools").replaceChildren(
      ...tools.map((tool, index) => {
        const row = node("div", undefined, "discovered-tool");
        const description = node("div", undefined, "tool-description");
        description.append(node("strong", tool.name));
        if (tool.description) description.append(node("p", tool.description));
        const schema = node("details", undefined, "tool-schema");
        schema.append(
          node("summary", "Parâmetros"),
          node("pre", JSON.stringify(tool.inputSchema || {}, null, 2)),
        );
        description.append(schema);
        const choices = node("div", undefined, "tool-choices");
        for (const [kind, label, selected] of [
          ["read", "Leitura", readTools],
          ["action", "Ação", actionTools],
        ]) {
          const choice = node("label", undefined, "checkbox-line");
          const checkbox = node("input");
          checkbox.type = "checkbox";
          checkbox.checked = selected.includes(tool.name);
          checkbox.id = `tool-${index}-${kind}`;
          choice.htmlFor = checkbox.id;
          choice.append(checkbox, node("span", label));
          checkbox.onchange = () => {
            const field =
              kind === "read" ? "mcp-read-tools" : "mcp-action-tools";
            const other =
              kind === "read" ? "mcp-action-tools" : "mcp-read-tools";
            const selectedTools = names($(field).value).filter(
              (name) => name !== tool.name,
            );
            if (checkbox.checked) {
              selectedTools.push(tool.name);
              $(other).value = names($(other).value)
                .filter((name) => name !== tool.name)
                .join("\n");
            }
            $(field).value = selectedTools.join("\n");
            renderTools();
            $(checkbox.id)?.focus();
          };
          choices.append(choice);
        }
        row.append(description, choices);
        return row;
      }),
    );
  }
  $("mcp-read-tools").oninput = renderTools;
  $("mcp-action-tools").oninput = renderTools;
  $("settings-dialog").addEventListener("close", closeEditor);

  function formatDate(timestamp, timezone) {
    if (timestamp == null) return "Sem próxima execução";
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: timezone,
      }).format(timestamp);
    } catch {
      return new Date(timestamp).toLocaleString("pt-BR");
    }
  }
  async function loadTasks() {
    const tasks = await api("/api/tasks");
    renderTasks(tasks);
  }
  async function openTasks() {
    feedback("tasks-feedback", "Carregando suas tarefas…");
    await callbacks.loadConversations();
    const conversations = callbacks.getConversations();
    $("task-conversation").replaceChildren(
      ...conversations.map((conversation) =>
        option(conversation.id, conversation.title),
      ),
    );
    if (callbacks.getConversationId())
      $("task-conversation").value = callbacks.getConversationId();
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
  function renderTasks(tasks) {
    const cards = tasks.map((task) => {
      const card = node("article", undefined, "management-card task-card");
      const heading = node("div", undefined, "management-card-heading");
      const title = node("div");
      title.append(
        node("h4", task.title),
        node(
          "p",
          task.kind === "once" ? "Uma vez" : `Cron · ${task.schedule}`,
          "card-meta",
        ),
      );
      heading.append(
        icon("calendar-blank"),
        title,
        node("span", task.enabled ? "Ativa" : "Pausada", "task-state"),
      );
      const conversation = callbacks
        .getConversations()
        .find((entry) => entry.id === task.conversationId);
      card.append(
        heading,
        node("p", task.prompt, "task-prompt"),
        node(
          "p",
          `Conversa: ${conversation?.title || task.conversationId}`,
          "card-meta",
        ),
      );
      card.append(
        node(
          "p",
          `Próxima: ${formatDate(task.nextRun, task.timezone)} · ${task.timezone}`,
          "card-meta",
        ),
      );
      if (task.lastError) card.append(node("p", task.lastError, "error"));
      const actions = node("div", undefined, "card-buttons");
      const pause = button(task.enabled ? "Pausar" : "Retomar", () => {
        void act("tasks-error", [pause], async () => {
          await api(`/api/tasks/${encodeURIComponent(task.id)}`, "PUT", {
            enabled: !task.enabled,
          });
          await loadTasks();
          feedback(
            "tasks-feedback",
            task.enabled ? "Tarefa pausada." : "Tarefa retomada.",
          );
        });
      });
      const run = button("Executar agora", () => {
        void act("tasks-error", [run, pause], async () => {
          if (!taskRunRequests.has(task.id))
            taskRunRequests.set(task.id, crypto.randomUUID());
          await api(`/api/tasks/${encodeURIComponent(task.id)}/run`, "POST", {
            requestId: taskRunRequests.get(task.id),
          });
          await loadTasks();
          await callbacks.refreshConversation(task.conversationId);
          taskRunRequests.delete(task.id);
          feedback(
            "tasks-feedback",
            "Execução solicitada. Acompanhe o resultado e eventuais aprovações na conversa.",
          );
        });
      });
      const open = button("Abrir conversa", async () => {
        void act("tasks-error", [open], async () => {
          await callbacks.selectConversation(
            task.conversationId,
            conversation?.title || "Conversa da tarefa",
          );
          $("tasks-dialog").close();
        });
      });
      actions.append(
        open,
        pause,
        run,
        deletionButton(
          "Excluir",
          async () => {
            await api(`/api/tasks/${encodeURIComponent(task.id)}`, "DELETE");
            await loadTasks();
            feedback("tasks-feedback", "Tarefa excluída.");
          },
          "tasks-error",
        ),
      );
      const history = node("details", undefined, "task-history");
      const log = node("div", undefined, "task-runs");
      const historyError = node("p", undefined, "error");
      historyError.setAttribute("role", "alert");
      history.append(
        node("summary", "Histórico de execuções"),
        log,
        historyError,
      );
      let loaded = false;
      history.ontoggle = async () => {
        if (!history.open || loaded) return;
        log.replaceChildren(node("p", "Carregando execuções…", "card-meta"));
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
                    node(
                      "p",
                      `${formatDate(entry.scheduledAt, task.timezone)} · ${state}`,
                    ),
                  );
                  if (entry.error) item.append(node("p", entry.error, "error"));
                  return item;
                })
              : [node("p", "Nenhuma execução registrada.", "card-meta")]),
          );
          loaded = true;
        } catch (error) {
          log.replaceChildren();
          historyError.textContent = error.message;
        }
      };
      card.append(actions, history);
      return card;
    });
    $("tasks-list").replaceChildren(
      ...(cards.length
        ? cards
        : [
            node(
              "p",
              "Ainda não há tarefas. Combine o primeiro pedido abaixo.",
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
        new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }).format();
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
      });
      $("task-title").value = "";
      $("task-prompt").value = "";
      $("task-once").value = "";
      $("task-cron").value = "";
      await loadTasks();
      feedback(
        "tasks-feedback",
        "Tarefa criada. O pedido será executado na conversa escolhida.",
      );
    });
  };
  return {
    load: loadSettings,
    refreshLabel: updateLabel,
    updateConversation(value) {
      currentSettings = value;
      updateLabel();
    },
    reset() {
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
