const { t, text, attr, plain } = globalThis.PiI18n || {
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
    attr(button, "aria-label", () => t("Mostrar chamadas de ferramentas"));
    button.setAttribute("aria-pressed", String(shown));
    button.setAttribute("aria-controls", messages.id || "messages");
    attr(button, "title", () =>
      t("{0} chamadas de ferramentas. Aprovações e erros continuam visíveis.", [
        shown ? t("Ocultar") : t("Exibir"),
      ]),
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

export function attachToolBody(details, body, render) {
  let hydrated = false;
  details.ontoggle = () => {
    if (details.open && !hydrated) {
      body.append(render());
      hydrated = true;
    } else if (!details.open && hydrated) {
      body.replaceChildren();
      hydrated = false;
    }
  };
  if (details.open) details.ontoggle();
}

export function createToolCalls(
  content,
  { document, icon, live = false, renderText },
) {
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
      text(label, () =>
        t("Chamada · {0}{1}", [
          block.name || t("Ferramenta"),
          live ? t(" · Em andamento") : "",
        ]),
      );
      summary.append(icon("plug"), label);
      const body = document.createElement("div");
      body.className = "message-body";
      attachToolBody(details, body, () => {
        const text = JSON.stringify(block.arguments ?? {}, null, 2);
        if (renderText) return renderText(text);
        const args = document.createElement("pre");
        plain(args, text.slice(0, 32768));
        return args;
      });
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
