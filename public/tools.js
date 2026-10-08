const PREFERENCE_KEY = "pi:tool-details";

export function attachToolVisibility({
  button,
  messages,
  storage = () => localStorage,
}) {
  let shown = true;
  try {
    shown = storage().getItem(PREFERENCE_KEY) !== "hidden";
  } catch {
    // The control remains usable when browser storage is unavailable.
  }
  function apply() {
    button.setAttribute("aria-label", "Mostrar chamadas de ferramentas");
    button.setAttribute("aria-pressed", String(shown));
    button.setAttribute("aria-controls", messages.id || "messages");
    button.setAttribute(
      "title",
      `${shown ? "Ocultar" : "Exibir"} chamadas de ferramentas. Aprovações e erros continuam visíveis.`,
    );
    for (const detail of messages.querySelectorAll("[data-tool-detail]")) {
      detail.hidden = !shown && detail.dataset.toolImportant !== "true";
    }
  }
  button.onclick = () => {
    shown = !shown;
    try {
      storage().setItem(PREFERENCE_KEY, shown ? "shown" : "hidden");
    } catch {
      // Keep the current preference for this page even if it cannot be saved.
    }
    apply();
  };
  apply();
  return { apply };
}

export function createToolCalls(content, { document, icon, live = false }) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block.type === "toolCall")
    .map((block) => {
      const details = document.createElement("details");
      details.className = "message toolResult tool-call";
      details.dataset.toolDetail = "";
      const summary = document.createElement("summary");
      summary.className = "speaker";
      const label = document.createElement("span");
      label.textContent = `Chamada · ${block.name || "Ferramenta"}${live ? " · Em andamento" : ""}`;
      summary.append(icon("plug"), label);
      const body = document.createElement("div");
      body.className = "message-body";
      const args = document.createElement("pre");
      args.textContent = JSON.stringify(block.arguments ?? {}, null, 2);
      body.append(args);
      details.append(summary, body);
      return details;
    });
}

export function toolResultNeedsAttention(message) {
  if (message.isError) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (block.type !== "text") return false;
    try {
      const payload = JSON.parse(block.text);
      const result = payload?.result ?? payload;
      return (
        !!result &&
        (result.isError === true ||
          result.paused === true ||
          ["paused", "pending", "uncertain"].includes(result.status))
      );
    } catch {
      return false;
    }
  });
}
