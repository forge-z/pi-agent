const { t, text, plain } = globalThis.PiI18n || {
  t: (source, values = []) =>
    source.replace(/\{(\d+)\}/g, (match, index) =>
      index < values.length ? String(values[index]) : match,
    ),
  text: (element, render) => {
    element.textContent = typeof render === "function" ? render() : render;
    return element;
  },
  plain: (element, value) => {
    element.textContent = value;
  },
};

const $ = (id) => document.getElementById(id);
const PROTOCOLS = new Set(["openai-compatible", "anthropic"]);

export function attachCustomProviderConnectionsUI(api, callbacks = {}) {
  const protocol = $("custom-provider-protocol");
  const endpoint = $("custom-provider-endpoint");
  const model = $("custom-provider-model");
  const apiKey = $("custom-provider-api-key");
  const allowLocal = $("custom-provider-allow-local");
  const fields = $("custom-provider-fields");
  const form = $("custom-provider-form");
  const status = $("custom-provider-status");
  const list = $("custom-provider-list");
  const models = $("custom-provider-models");
  let settings = null;
  let connections = [];
  let sharedBusy = false;
  let catalogGeneration = 0;
  let sessionGeneration = 0;
  const busyTokens = new Set();
  const secretPayloads = new Set();

  function setStatus(message, values = []) {
    text(status, () => t(message, values));
  }

  function updateBusy() {
    fields.disabled =
      sharedBusy || busyTokens.size > 0 || settings?.mode !== "live";
  }

  function addBusyToken() {
    const token = {};
    busyTokens.add(token);
    updateBusy();
    try {
      callbacks.setBusy?.(true);
    } catch {
      // A UI callback must not interrupt the connection request.
    }
    return token;
  }

  function removeBusyToken(token) {
    if (!busyTokens.delete(token)) return;
    updateBusy();
    try {
      callbacks.setBusy?.(busyTokens.size > 0);
    } catch {
      // A UI callback must not interrupt cleanup.
    }
  }

  function clearModelSuggestions() {
    catalogGeneration++;
    models.replaceChildren();
  }

  function clearSecrets() {
    apiKey.value = "";
    for (const payload of secretPayloads) payload.apiKey = "";
    clearModelSuggestions();
  }

  function clearDraft() {
    protocol.value = "openai-compatible";
    endpoint.value = "";
    model.value = "";
    allowLocal.checked = false;
    clearSecrets();
  }

  function renderConnections(entries = []) {
    connections = Array.isArray(entries) ? entries : [];
    if (!connections.length) {
      const empty = document.createElement("p");
      empty.className = "management-empty";
      text(empty, () => t("Nenhuma conexão personalizada salva."));
      list.replaceChildren(empty);
      return;
    }

    list.replaceChildren(
      ...connections.map((connection) => {
        const card = document.createElement("article");
        card.className = "custom-provider-saved";
        const heading = document.createElement("div");
        heading.className = "custom-provider-saved-heading";
        const title = document.createElement("h5");
        plain(
          title,
          String(
            connection.name ||
              connection.modelId ||
              connection.id ||
              "API personalizada",
          ),
        );
        const credential = document.createElement("span");
        credential.className = "connection-status";
        text(credential, () =>
          connection.hasApiKey
            ? t("Chave API configurada")
            : t("Sem chave API · endpoint local"),
        );
        heading.append(title, credential);
        const detail = document.createElement("p");
        detail.className = "custom-provider-saved-detail";
        text(detail, () => {
          const protocolName =
            connection.protocol === "anthropic"
              ? t("Anthropic Messages")
              : t("OpenAI compatível");
          return `${protocolName} · ${String(connection.modelId || "")} · ${String(connection.endpoint || "")}`;
        });
        card.append(heading, detail);
        return card;
      }),
    );
  }

  function isCurrent(generation) {
    return generation === sessionGeneration && settings?.mode === "live";
  }

  function draftValues(requireModel = false) {
    const protocolValue = protocol.value;
    const endpointValue = endpoint.value.trim();
    const modelValue = model.value.trim();
    const keyValue = apiKey.value.trim();
    const localValue = allowLocal.checked === true;
    let parsedEndpoint;
    if (!PROTOCOLS.has(protocolValue)) {
      setStatus("Escolha um protocolo válido.");
      return null;
    }
    try {
      parsedEndpoint = new URL(endpointValue);
    } catch {
      setStatus("Informe um endpoint válido.");
      return null;
    }
    if (
      parsedEndpoint.protocol !== "https:" &&
      !(parsedEndpoint.protocol === "http:" && localValue)
    ) {
      setStatus(
        "Use HTTPS. Para um endpoint HTTP local, habilite a opção de rede local.",
      );
      return null;
    }
    if (!endpointValue) {
      setStatus("Informe um endpoint válido.");
      return null;
    }
    if (requireModel && !modelValue) {
      setStatus("Informe o identificador do modelo.");
      return null;
    }
    if (!keyValue && !localValue) {
      setStatus(
        "Informe uma chave API. Ela será salva no servidor e não será exibida novamente.",
      );
      return null;
    }
    return {
      protocol: protocolValue,
      endpoint: endpointValue,
      modelId: modelValue,
      apiKey: keyValue,
      allowLocal: localValue,
    };
  }

  async function fetchModels(event) {
    event?.preventDefault?.();
    if (fields.disabled) return;
    const values = draftValues();
    if (!values) return;
    const generation = sessionGeneration;
    const requestGeneration = ++catalogGeneration;
    const payload = {
      protocol: values.protocol,
      endpoint: values.endpoint,
      apiKey: values.apiKey,
      allowLocal: values.allowLocal,
    };
    values.apiKey = "";
    secretPayloads.add(payload);
    const token = addBusyToken();
    setStatus("Buscando modelos…");
    try {
      const result = await api(
        "/api/provider/connections/models",
        "POST",
        payload,
      );
      if (!isCurrent(generation) || requestGeneration !== catalogGeneration)
        return;
      const entries = Array.isArray(result?.models) ? result.models : [];
      models.replaceChildren(
        ...entries
          .filter((entry) => entry && typeof entry.id === "string")
          .map((entry) => {
            const option = document.createElement("option");
            option.value = entry.id;
            plain(option, String(entry.name || entry.id));
            return option;
          }),
      );
      setStatus(
        entries.length
          ? "Lista de modelos atualizada. Você também pode digitar um modelo."
          : "Nenhum modelo encontrado. Você ainda pode digitar um modelo.",
      );
    } catch {
      if (isCurrent(generation) && requestGeneration === catalogGeneration)
        setStatus(
          "Não foi possível buscar modelos. Você ainda pode informar o modelo manualmente.",
        );
    } finally {
      payload.apiKey = "";
      secretPayloads.delete(payload);
      removeBusyToken(token);
    }
  }

  async function saveConnection(event) {
    event.preventDefault();
    if (fields.disabled) return;
    const values = draftValues(true);
    if (!values) return;
    const generation = sessionGeneration;
    const payload = { ...values };
    values.apiKey = "";
    secretPayloads.add(payload);
    apiKey.value = "";
    clearModelSuggestions();
    const token = addBusyToken();
    setStatus("Salvando conexão…");
    try {
      const result = await api("/api/provider/connections", "POST", payload);
      if (!isCurrent(generation)) return;
      const connection = result?.connection;
      if (connection && typeof connection === "object")
        renderConnections([...connections, connection]);
      setStatus("Conexão salva. Escolha-a nas configurações de modelo.");
      try {
        await callbacks.refresh?.();
      } catch {
        // Saving succeeded; a settings refresh can be retried by reopening Settings.
      }
    } catch {
      if (isCurrent(generation))
        setStatus("Não foi possível salvar a conexão. Tente novamente.");
    } finally {
      payload.apiKey = "";
      secretPayloads.delete(payload);
      if (generation === sessionGeneration) apiKey.value = "";
      removeBusyToken(token);
    }
  }

  function invalidateForTargetChange(clearKey) {
    clearModelSuggestions();
    if (clearKey) apiKey.value = "";
    setStatus("");
  }

  protocol.addEventListener("change", () => invalidateForTargetChange(true));
  endpoint.addEventListener("input", () => invalidateForTargetChange(true));
  endpoint.addEventListener("change", () => invalidateForTargetChange(true));
  allowLocal.addEventListener("change", () => invalidateForTargetChange(false));
  apiKey.addEventListener("input", () => {
    clearModelSuggestions();
    setStatus("");
  });
  form.addEventListener("submit", saveConnection);
  $("custom-provider-fetch-models").addEventListener("click", fetchModels);
  $("settings-dialog")?.addEventListener("close", () => {
    sessionGeneration++;
    clearSecrets();
    updateBusy();
    setStatus("");
  });

  return {
    update(snapshot) {
      settings = snapshot || null;
      renderConnections(settings?.customConnections || []);
      updateBusy();
    },
    reset() {
      sessionGeneration++;
      settings = null;
      clearDraft();
      renderConnections([]);
      updateBusy();
      setStatus("");
    },
    setBusy(value) {
      sharedBusy = value === true;
      updateBusy();
    },
    clearSecrets,
  };
}
