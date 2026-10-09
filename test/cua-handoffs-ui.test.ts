import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { interfaceLanguage } from "./interface-fixture.js";

class Element {
  textContent = "";
  id = "";
  type = "";
  checked = false;
  disabled = false;
  href = "";
  target = "";
  rel = "";
  htmlFor = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  onclick?: () => Promise<void>;
  constructor(readonly tag: string) {}
  append(...items: Element[]) {
    this.children.push(...items);
  }
  prepend(...items: Element[]) {
    this.children.unshift(...items);
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((item) => item.all())];
  }
}
type Row = {
  id: string;
  server: string;
  state: string;
  url?: string | null;
  expiresAt?: number;
};
function fixture(
  rows: Row[],
  options: { language?: string; api?: () => Promise<void> } = {},
) {
  const { i18n } = interfaceLanguage(options.language);
  const calls: { path: string; method: string; body: unknown }[] = [];
  const refreshed: string[] = [];
  const render = runInNewContext(
    readFileSync(
      new URL("../public/cua-handoffs.js", import.meta.url),
      "utf8",
    ).replace("export function", "function") + "\nrenderCuaHandoffs",
    { URL, URLSearchParams, Date },
  );
  const cards: Element[] = render(rows, "17", {
    ...i18n,
    node: (tag: string, content?: string) => {
      const element = new Element(tag);
      element.textContent = content || "";
      return element;
    },
    api: async (path: string, method: string, body: unknown) => {
      calls.push({ path, method, body: JSON.parse(JSON.stringify(body)) });
      await options.api?.();
    },
    refresh: async (target: string) => {
      refreshed.push(target);
    },
  });
  const all = cards.flatMap((card) => card.all());
  return {
    cards,
    all,
    calls,
    refreshed,
    button: (label: string) =>
      all.find((item) => item.tag === "button" && item.textContent === label)!,
  };
}
const active = {
  id: "handoff",
  server: "desktop",
  state: "active",
  expiresAt: Date.now() + 1800000,
  url: "https://desktop.example/viewer/#ticket=mock-ticket&clipboard=0",
};
test("a pending handoff creates only on explicit click, binds to its original conversation and does not repeat uncertain requests", async () => {
  let resolve!: () => void;
  const view = fixture(
    [{ id: "request", server: "desktop", state: "pending" }],
    {
      api: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    },
  );
  assert.equal(view.calls.length, 0);
  const button = view.button("Criar acesso privado");
  const pending = button.onclick!();
  await button.onclick!();
  assert.equal(view.calls.length, 1);
  assert.equal(button.disabled, true);
  assert.deepEqual(view.calls[0], {
    path: "/api/conversations/17/cua-handoffs/request/create",
    method: "POST",
    body: {},
  });
  resolve();
  await pending;
  assert.deepEqual(view.refreshed, ["17"]);
  const failed = fixture(
    [{ id: "request", server: "desktop", state: "pending" }],
    {
      api: async () => {
        throw new Error("creation uncertain");
      },
    },
  );
  await failed.button("Criar acesso privado").onclick!();
  assert.equal(failed.calls.length, 1);
  assert.deepEqual(failed.refreshed, ["17"]);
});
test("active handoff requires both human acknowledgments and clearly states the connection and revocation limits", async () => {
  const view = fixture([active]);
  const resume = view.button("Retomar o Pi");
  await resume.onclick!();
  assert.equal(view.calls.length, 0);
  const checks = view.all.filter((item) => item.type === "checkbox");
  checks[0].checked = true;
  await resume.onclick!();
  assert.equal(view.calls.length, 0);
  checks[1].checked = true;
  await resume.onclick!();
  assert.deepEqual(view.calls[0], {
    path: "/api/conversations/17/cua-handoffs/handoff/end",
    method: "POST",
    body: { allTabsClosed: true, controlReturned: true },
  });
  assert.match(
    view.all.map((item) => item.textContent).join(" "),
    /conexão aberta pode continuar.*não revoga o ticket/,
  );
  const link = view.all.find((item) => item.tag === "a")!;
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
});
test("expired, unsafe and uncertain tickets remain paused without exposing an actionable link or allowing automatic recovery", () => {
  for (const row of [
    { ...active, expiresAt: Date.now() - 1 },
    { ...active, url: "http://desktop.example/viewer/#ticket=x&clipboard=0" },
    {
      ...active,
      url: "https://user:secret@desktop.example/viewer/#ticket=x&clipboard=0",
    },
    {
      ...active,
      url: "https://desktop.example/viewer/?token=secret#ticket=x&clipboard=0",
    },
    {
      ...active,
      url: "https://desktop.example/viewer/#ticket=x&clipboard=0&files=x",
    },
    { ...active, state: "uncertain" },
    { ...active, state: "creating" },
  ]) {
    const view = fixture([row]);
    assert.equal(
      view.all.some((item) => item.tag === "a"),
      false,
    );
    assert.equal(view.calls.length, 0);
    if (row.state !== "active")
      assert.equal(
        view.all.some((item) => item.tag === "button"),
        false,
      );
  }
  assert.equal(fixture([{ ...active, state: "ended" }]).cards.length, 0);
});
