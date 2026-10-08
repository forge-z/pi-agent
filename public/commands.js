function commandName(command) {
  return String(command?.name || "")
    .replace(/^\/+/, "")
    .split(/\s/, 1)[0];
}

export function slashPrefix(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /\s/.test(value)
  )
    return null;
  return value.slice(1).toLocaleLowerCase();
}

export function canDispatchCommandResult(
  command,
  hasArgs,
  sourceConversation,
  currentConversation,
  sourceStillAvailable = false,
) {
  if (command === "agents" && hasArgs) return sourceStillAvailable;
  return sourceConversation === currentConversation;
}

export async function refreshConversationSnapshot(
  conversationId,
  { getConversationId, loadConversations, api, render },
) {
  await loadConversations();
  if (getConversationId() !== conversationId) return false;
  const snapshot = await api(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
  );
  if (getConversationId() !== conversationId) return false;
  render(snapshot);
  return true;
}

export function createSlashAutocomplete({ api, document, input, list }) {
  let commands = null;
  let loading = null;
  let open = false;
  let activeIndex = 0;
  let visibleCommands = [];
  let generation = 0;

  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");

  function close() {
    generation++;
    open = false;
    activeIndex = 0;
    visibleCommands = [];
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function select(command) {
    const name = commandName(command);
    if (!name) return;
    input.value = `/${name} `;
    close();
    input.focus();
    if (typeof input.setSelectionRange === "function")
      input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function fitMenu() {
    const form = input.closest?.("form");
    const content = document.querySelector?.(".main-content");
    if (!form || !content || !list.style) return;
    const available =
      form.getBoundingClientRect().top -
      Math.max(0, content.getBoundingClientRect().top) -
      20;
    list.style.maxHeight = `${Math.max(48, Math.min(390, available))}px`;
  }

  function render(message) {
    fitMenu();
    list.replaceChildren();
    if (message) {
      const status = document.createElement("p");
      status.className = "command-suggestion-status";
      status.textContent = message;
      list.append(status);
      list.hidden = false;
      open = true;
      input.setAttribute("aria-expanded", "true");
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const prefix = slashPrefix(input.value);
    if (prefix === null) return close();
    visibleCommands = (commands || []).filter((command) =>
      commandName(command).toLocaleLowerCase().startsWith(prefix),
    );
    if (!visibleCommands.length) return close();
    activeIndex = Math.min(activeIndex, visibleCommands.length - 1);
    list.replaceChildren(
      ...visibleCommands.map((command, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "command-option";
        option.id = `command-option-${index}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === activeIndex));
        const heading = document.createElement("span");
        heading.className = "command-option-heading";
        const name = document.createElement("strong");
        name.textContent = `/${commandName(command)}`;
        const usage = document.createElement("small");
        usage.textContent = command.usage || `/${commandName(command)}`;
        heading.append(name, usage);
        const description = document.createElement("span");
        description.className = "command-option-description";
        description.textContent = command.description || "";
        option.append(heading, description);
        option.onclick = () => select(command);
        return option;
      }),
    );
    list.hidden = false;
    open = true;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute(
      "aria-activedescendant",
      `command-option-${activeIndex}`,
    );
  }

  async function ensureCommands() {
    if (commands) return commands;
    if (loading) return loading;
    loading = api("/api/commands")
      .then((response) => {
        commands = Array.isArray(response?.commands) ? response.commands : [];
        return commands;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  async function update() {
    if (slashPrefix(input.value) === null) {
      close();
      return;
    }
    const request = ++generation;
    if (commands) {
      render();
      return;
    }
    render("Carregando comandos…");
    try {
      await ensureCommands();
      if (request === generation) render();
    } catch (error) {
      if (request === generation)
        render(error.message || "Não foi possível carregar os comandos.");
    }
  }

  function handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return false;
    if (
      event.key === "Enter" &&
      event.repeat &&
      open &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      return true;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      return true;
    }
    if (!open) return false;
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
    )
      return false;
    if (!visibleCommands.length) {
      if (event.key === "Enter") {
        event.preventDefault();
        return true;
      }
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      activeIndex =
        (activeIndex + direction + visibleCommands.length) %
        visibleCommands.length;
      render();
      list.querySelector?.('[aria-selected="true"]')?.scrollIntoView?.({
        block: "nearest",
      });
      return true;
    }
    if (
      (event.key === "Tab" && !event.shiftKey) ||
      (event.key === "Enter" && !event.shiftKey && !event.altKey)
    ) {
      event.preventDefault();
      select(visibleCommands[activeIndex]);
      return true;
    }
    return false;
  }

  return {
    close,
    handleKeydown,
    update,
    getCommands: async () => {
      if (!commands) await ensureCommands();
      return commands || [];
    },
    get open() {
      return open;
    },
  };
}
