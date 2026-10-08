import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Element {
  value = "";
  textContent = "";
  disabled = false;
  hidden = false;
  children: Element[] = [];
  onchange?: () => void;
  onsubmit?: (event: { preventDefault(): void; submitter: Element }) => void;
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  closest() {
    return null;
  }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  scrollIntoView() {}
  querySelector() {
    return new Element();
  }
}

function fixture(
  api: (path: string, method?: string, data?: unknown) => Promise<unknown>,
) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const source = readFileSync(
    new URL("../public/settings.js", import.meta.url),
    "utf8",
  ).replaceAll("export ", "");
  const configure = runInNewContext(`${source}\nconfigureUI`, {
    document: { getElementById: get },
    URLSearchParams,
    URL,
    Intl,
    Date,
  });
  configure(api, {
    node: (_tag: string, text?: string) => {
      const element = new Element();
      element.textContent = text ?? "";
      return element;
    },
    icon: () => new Element(),
  });
  get("task-delivery").value = "web_telegram";
  get("task-conversation").value = "linked";
  return get;
}

test("a stale conversation availability response cannot overwrite the current delivery hint", async () => {
  const responses: Array<(value: unknown) => void> = [];
  const get = fixture(
    async () => new Promise((resolve) => responses.push(resolve)),
  );
  get("task-conversation").onchange!();
  get("task-conversation").value = "unlinked";
  get("task-conversation").onchange!();
  responses[1]!({ available: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(get("task-delivery-hint").textContent, /não está conectado/);
  responses[0]!({ available: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(get("task-delivery-hint").textContent, /não está conectado/);
});

test("creating a Telegram task resets both the selected destination and its hint to web", async () => {
  const requests: Array<{ path: string; method?: string; data?: unknown }> = [];
  const get = fixture(async (path, method, data) => {
    requests.push({ path, method, data });
    if (path.includes("telegram-availability")) return { available: true };
    return [];
  });
  get("task-delivery").onchange!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(get("task-delivery-hint").textContent, /também será enviado/);
  get("task-timezone").value = "UTC";
  get("task-kind").value = "cron";
  get("task-cron").value = "0 8 * * *";
  get("task-title").value = "Synthetic task";
  get("task-prompt").value = "Synthetic prompt";
  get("task-form").onsubmit!({ preventDefault() {}, submitter: new Element() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(get("task-delivery").value, "web");
  assert.match(get("task-delivery-hint").textContent, /Nenhuma cópia/);
  assert.equal(
    (
      requests.find((request) => request.method === "POST")?.data as {
        delivery: string;
      }
    ).delivery,
    "web_telegram",
  );
});
