import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { interfaceLanguage } from "./interface-fixture.js";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  value = "";
  type = "";
  disabled = false;
  href = "";
  target = "";
  rel = "";
  onclick?: () => void;
  onsubmit?: (event: { preventDefault(): void }) => void;
  constructor(
    readonly tag: string,
    public textContent = "",
    readonly className = "",
  ) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
}
const source = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const start = source.indexOf("  const nativeInteractions = ");
const end = source.indexOf("  const uncertainCalls = ", start);
assert.ok(start >= 0 && end > start);
function fixture(url: string, external = true, language = "pt-BR") {
  const page = interfaceLanguage(language);
  const cards: Element[] = [];
  const requests: Array<{ path: string; method?: string; data?: unknown }> = [];
  const node = (tag: string, value?: unknown, className = "") =>
    new Element(tag, value === undefined ? "" : String(value), className);
  const context = {
    ...page.i18n,
    URL,
    conversationId: "original-conversation",
    snapshot: {
      mcpInteractions: [
        {
          id: "interaction",
          server: "sample",
          kind: "url",
          state: "pending",
          payload: JSON.stringify({
            url,
            message: "Mensagem externa preservada",
            ...(external ? { source: "url_required_error" } : {}),
          }),
        },
      ],
    },
    cards,
    node,
    icon: () => node("svg"),
    uiNode: (tag: string, render: () => string, className = "") =>
      page.i18n.text(node(tag, undefined, className), render),
    api: async (path: string, method?: string, data?: unknown) => {
      requests.push({ path, method, data });
      return {};
    },
    render: () => {},
  };
  runInNewContext(source.slice(start, end), context);
  return { cards, requests, context, page };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("URL error cards keep a safe private link and require explicit, conversation-bound external completion", async () => {
  const ui = fixture("https://service.example/viewer/#ticket=mock-ticket");
  const card = ui.cards[0];
  const link = card.querySelectorAll("a")[0];
  assert.equal(link.href, "https://service.example/viewer/#ticket=mock-ticket");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(ui.requests.length, 0);
  const form = card.querySelectorAll("form")[0];
  const accept = form.querySelectorAll("button")[0];
  assert.equal(accept.textContent, "Concluí a etapa externa");
  assert.ok(
    card.querySelectorAll("p").some((p) => /não confirma/.test(p.textContent)),
  );
  ui.page.i18n.setLanguage("en");
  assert.equal(accept.textContent, "I completed the external step");
  assert.ok(
    card
      .querySelectorAll("p")
      .some((p) => /does not confirm/.test(p.textContent)),
  );
  assert.ok(
    card
      .querySelectorAll("p")
      .some((p) => p.textContent === "Mensagem externa preservada"),
  );
  ui.context.conversationId = "switched-conversation";
  form.onsubmit!({ preventDefault() {} });
  await settle();
  assert.equal(
    JSON.stringify(ui.requests),
    JSON.stringify([
      {
        path: "/api/conversations/original-conversation/mcp-interactions/interaction",
        method: "POST",
        data: { action: "accept" },
      },
      {
        path: "/api/conversations/original-conversation",
        method: undefined,
        data: undefined,
      },
    ]),
  );
  assert.equal(accept.disabled, false);
});

test("normal URL elicitation retains its existing acceptance label; decline/cancel remain explicit", async () => {
  const normal = fixture("https://service.example/approve", false);
  assert.equal(
    normal.cards[0].querySelectorAll("button")[0].textContent,
    "Aceitar",
  );
  for (const [index, action] of [
    [1, "decline"],
    [2, "cancel"],
  ] as const) {
    const ui = fixture("https://service.example/viewer");
    assert.equal(ui.requests.length, 0);
    ui.cards[0].querySelectorAll("form")[0].querySelectorAll("button")[index]
      .onclick!();
    await settle();
    assert.equal(
      JSON.stringify(ui.requests[0].data),
      JSON.stringify({ action }),
    );
  }
});

test("the URL renderer never creates executable, insecure, malformed or embedded-credential links", () => {
  for (const url of [
    "javascript:alert(1)",
    "http://service.example",
    "https://user:password@service.example",
    "invalid",
  ]) {
    const ui = fixture(url);
    assert.equal(ui.cards[0].querySelectorAll("a").length, 0);
    assert.equal(ui.requests.length, 0);
  }
});
