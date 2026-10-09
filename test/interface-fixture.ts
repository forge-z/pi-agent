import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type TextElement = {
  textContent: string;
  setAttribute?(name: string, value: string): void;
};
export function interfaceLanguage(
  saved: string | null = null,
  blocked = false,
) {
  const storage = new Map<string, string>();
  if (saved !== null) storage.set("pi:language", saved);
  const events = new Map<
    string,
    (event: { key: string | null; newValue: string | null }) => void
  >();
  const root = { lang: "pt-BR" };
  const context = {
    document: {
      documentElement: root,
      getElementById: () => null,
      createTreeWalker: () => ({ nextNode: () => false }),
      querySelectorAll: () => [],
    },
    NodeFilter: { SHOW_TEXT: 4 },
    window: {
      addEventListener: (
        name: string,
        handler: (event: {
          key: string | null;
          newValue: string | null;
        }) => void,
      ) => events.set(name, handler),
    },
    localStorage: {
      getItem(key: string) {
        if (blocked) throw new Error("blocked");
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (blocked) throw new Error("blocked");
        storage.set(key, value);
      },
    },
  };
  const i18n = runInNewContext(
    readFileSync(
      new URL("../public/i18n-catalog.js", import.meta.url),
      "utf8",
    ) +
      "\n" +
      readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8") +
      "\nglobalThis.PiI18n",
    context,
  ) as {
    t: (source: string, values?: unknown[]) => string;
    errorText: (source: string) => string;
    text: <T extends TextElement>(
      element: T,
      render: string | (() => string),
    ) => T;
    plain: (element: TextElement, value: string) => void;
    attr: (
      element: TextElement,
      name: string,
      render: string | (() => string),
    ) => void;
    locale: () => string;
    setLanguage: (value: string) => void;
    language: () => string;
  };
  return {
    i18n,
    root,
    storage,
    sync: (newValue: string | null, key: string | null = "pi:language") =>
      events.get("storage")!({ key, newValue }),
  };
}
