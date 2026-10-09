// Interface language is a local browser preference; it never changes agent input.
(() => {
  const key = "pi:language";
  const valid = (value) => value === "pt-BR" || value === "en";
  let language = "pt-BR";
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) language = saved;
  } catch {
    // Keep the default when storage is unavailable.
  }
  const catalog = globalThis.PiEnglish || {};
  const bindings = new WeakMap();
  const references = new Set();
  const errors = new Set(globalThis.PiInterfaceErrors || []);
  const listeners = new Set();
  function t(source, values = []) {
    const template =
      language === "en" && Object.hasOwn(catalog, source)
        ? catalog[source]
        : source;
    const result = template.replace(/\{(\d+)\}/g, (match, index) =>
      index < values.length ? String(values[index]) : match,
    );
    return result;
  }
  function bind(element, property, render) {
    let entries = bindings.get(element);
    if (!entries) {
      entries = new Map();
      bindings.set(element, entries);
      references.add(new WeakRef(element));
    }
    const update = () => {
      const value = typeof render === "function" ? render() : t(render);
      if (property.startsWith("@"))
        element.setAttribute(property.slice(1), value);
      else element[property] = value;
    };
    entries.set(property, update);
    update();
    return element;
  }
  const text = (element, render) => bind(element, "textContent", render);
  const attr = (element, name, render) => bind(element, `@${name}`, render);
  function plain(element, value) {
    bindings.get(element)?.delete("textContent");
    element.textContent = value;
  }
  function apply() {
    document.documentElement.lang = language;
    const select = document.getElementById("interface-language");
    if (select) select.value = language;
    for (const reference of references) {
      const element = reference.deref();
      if (!element) references.delete(reference);
      else for (const update of bindings.get(element)?.values() || []) update();
    }
    for (const listener of listeners) listener();
  }
  function setLanguage(value, persist = true) {
    language = valid(value) ? value : "pt-BR";
    if (persist) {
      try {
        localStorage.setItem(key, language);
      } catch {
        // The selector still works for this page.
      }
    }
    apply();
  }
  globalThis.PiI18n = {
    t,
    errorText: (source) => (errors.has(source) ? t(source) : source),
    text,
    attr,
    plain,
    locale: () => (language === "en" ? "en-US" : "pt-BR"),
    language: () => language,
    setLanguage,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  // Capture only the original HTML. Later conversation and tool content is never scanned.
  const walker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("script, style")) continue;
    const source = node.textContent.replace(/\s+/g, " ").trim();
    if (source && Object.hasOwn(catalog, source)) {
      const leading = node.textContent.match(/^\s*/)[0];
      const trailing = node.textContent.match(/\s*$/)[0];
      text(node, () => leading + t(source) + trailing);
    }
  }
  for (const element of document.querySelectorAll(
    "[aria-label], [title], [placeholder]",
  )) {
    for (const name of ["aria-label", "title", "placeholder"]) {
      const source = element.getAttribute(name);
      if (source && Object.hasOwn(catalog, source)) attr(element, name, source);
    }
  }
  document
    .getElementById("interface-language")
    ?.addEventListener("change", (event) => setLanguage(event.target.value));
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null)
      setLanguage(event.newValue, false);
  });
  apply();
})();
