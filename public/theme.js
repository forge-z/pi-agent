(() => {
  const appearanceKey = "pi:appearance";
  const paletteKey = "pi:palette";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const validAppearance = (value) => ["light", "dark", "auto"].includes(value);
  const validPalette = (value) => ["blue", "gray", "pi"].includes(value);
  let choice = "auto";
  let palette = "blue";
  try {
    const savedAppearance = localStorage.getItem(appearanceKey);
    const savedPalette = localStorage.getItem(paletteKey);
    if (validAppearance(savedAppearance)) choice = savedAppearance;
    if (validPalette(savedPalette)) palette = savedPalette;
  } catch {
    /* Storage may be unavailable in private contexts. */
  }

  function apply() {
    const resolved =
      choice === "auto" ? (system.matches ? "dark" : "light") : choice;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = choice;
    document.documentElement.dataset.palette = palette;
    document.querySelectorAll("[data-theme-choice]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.themeChoice === choice),
      );
    });
    document.querySelectorAll("[data-palette-choice]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.paletteChoice === palette),
      );
    });
    const colors = {
      blue: { light: "#f5f8fc", dark: "#141e30" },
      gray: { light: "#f7f7f7", dark: "#202020" },
      pi: { light: "#ebe7e4", dark: "#161d27" },
    };
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", colors[palette][resolved]);
  }
  apply();
  document.addEventListener("DOMContentLoaded", apply);
  system.addEventListener("change", () => {
    if (choice === "auto") apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === appearanceKey || event.key === null)
      choice = validAppearance(event.newValue) ? event.newValue : "auto";
    if (event.key === paletteKey || event.key === null)
      palette = validPalette(event.newValue) ? event.newValue : "blue";
    apply();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.(
      "[data-theme-choice], [data-palette-choice]",
    );
    if (!button) return;
    let key, value;
    if (validAppearance(button.dataset.themeChoice)) {
      choice = button.dataset.themeChoice;
      key = appearanceKey;
      value = choice;
    } else if (validPalette(button.dataset.paletteChoice)) {
      palette = button.dataset.paletteChoice;
      key = paletteKey;
      value = palette;
    } else return;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Keep the in-memory choice. */
    }
    apply();
  });
})();
