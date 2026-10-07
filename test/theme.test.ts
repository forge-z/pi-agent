import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../public/theme.js", import.meta.url),
  "utf8",
);
function appearance(
  saved: string | null = null,
  prefersDark = false,
  storageBlocked = false,
  savedPalette: string | null = null,
) {
  const documentEvents = new Map<string, (event?: unknown) => void>();
  const windowEvents = new Map<string, (event: unknown) => void>();
  let systemChanged = () => {};
  let themeColor = "";
  const buttons = ["light", "dark", "auto"].map((choice) => ({
    dataset: { themeChoice: choice },
    pressed: "",
    setAttribute(_key: string, value: string) {
      this.pressed = value;
    },
  }));
  const paletteButtons = ["blue", "gray"].map((palette) => ({
    dataset: { paletteChoice: palette },
    pressed: "",
    setAttribute(_key: string, value: string) {
      this.pressed = value;
    },
  }));
  const root = { dataset: {} as Record<string, string> };
  const system = {
    matches: prefersDark,
    addEventListener(_event: string, listener: () => void) {
      systemChanged = listener;
    },
  };
  const storage = new Map<string, string>();
  if (saved !== null) storage.set("pi:appearance", saved);
  if (savedPalette !== null) storage.set("pi:palette", savedPalette);
  runInNewContext(source, {
    window: {
      matchMedia: () => system,
      addEventListener: (event: string, listener: (event: unknown) => void) =>
        windowEvents.set(event, listener),
    },
    document: {
      documentElement: root,
      querySelectorAll: (selector: string) =>
        selector === "[data-theme-choice]" ? buttons : paletteButtons,
      querySelector: () => ({
        setAttribute: (_key: string, value: string) => {
          themeColor = value;
        },
      }),
      addEventListener: (event: string, listener: (event?: unknown) => void) =>
        documentEvents.set(event, listener),
    },
    localStorage: {
      getItem: (key: string) => {
        if (storageBlocked) throw Error("blocked");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageBlocked) throw Error("blocked");
        storage.set(key, value);
      },
    },
  });
  return {
    root,
    storage,
    buttons,
    get color() {
      return themeColor;
    },
    selectPalette(value: string) {
      documentEvents.get("click")!({
        target: { closest: () => ({ dataset: { paletteChoice: value } }) },
      });
    },
    select(choice: string) {
      documentEvents.get("click")!({
        target: { closest: () => ({ dataset: { themeChoice: choice } }) },
      });
    },
    changeSystem(dark: boolean) {
      system.matches = dark;
      systemChanged();
    },
    sync(value: string | null, key = "pi:appearance") {
      windowEvents.get("storage")!({ key, newValue: value });
    },
  };
}

test("automatic appearance follows OS changes; manual choices survive reload and ignore OS changes", () => {
  const ui = appearance(null, true);
  assert.equal(ui.root.dataset.theme, "dark");
  assert.equal(ui.root.dataset.themePreference, "auto");
  ui.changeSystem(false);
  assert.equal(ui.root.dataset.theme, "light");
  ui.select("dark");
  ui.changeSystem(false);
  assert.equal(ui.root.dataset.theme, "dark");
  assert.equal(ui.storage.get("pi:appearance"), "dark");
  assert.equal(
    ui.buttons.find((button) => button.pressed === "true")?.dataset.themeChoice,
    "dark",
  );
  const reload = appearance(ui.storage.get("pi:appearance")!, false);
  assert.equal(reload.root.dataset.theme, "dark");
  ui.select("auto");
  assert.equal(ui.root.dataset.theme, "light");
  assert.equal(ui.color, "#f5f8fc");
  ui.changeSystem(true);
  assert.equal(ui.root.dataset.theme, "dark");
  assert.equal(ui.color, "#141e30");
});

test("appearance synchronizes across tabs, handles invalid preferences and blocked storage", () => {
  const ui = appearance("unexpected", false);
  assert.equal(ui.root.dataset.themePreference, "auto");
  ui.sync("dark");
  assert.equal(ui.root.dataset.theme, "dark");
  ui.sync(null);
  assert.equal(ui.root.dataset.theme, "light");
  ui.select("unexpected");
  assert.equal(ui.root.dataset.themePreference, "auto");
  const privateContext = appearance(null, false, true);
  privateContext.select("dark");
  assert.equal(privateContext.root.dataset.theme, "dark");
});

test("blue and gray palettes persist independently from automatic, light and dark appearance", () => {
  const ui = appearance(null, false);
  assert.equal(ui.root.dataset.palette, "blue");
  ui.selectPalette("gray");
  assert.equal(ui.root.dataset.palette, "gray");
  assert.equal(ui.root.dataset.themePreference, "auto");
  assert.equal(ui.color, "#f7f7f7");
  ui.changeSystem(true);
  assert.equal(ui.color, "#202020");
  assert.equal(ui.storage.get("pi:palette"), "gray");
  const reload = appearance("light", true, false, "gray");
  assert.equal(reload.root.dataset.palette, "gray");
  assert.equal(reload.root.dataset.theme, "light");
  reload.sync("blue", "pi:palette");
  assert.equal(reload.root.dataset.palette, "blue");
  assert.equal(reload.root.dataset.theme, "light");
  reload.selectPalette("invalid");
  assert.equal(reload.root.dataset.palette, "blue");
});
