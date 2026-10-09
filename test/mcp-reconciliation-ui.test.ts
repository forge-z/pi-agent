import { interfaceLanguage } from "./interface-fixture.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

type Call = {
  id: string;
  server: string;
  tool: string;
  state: string;
  args: string;
  result: string | null;
};

class Element {
  tagName: string;
  textContent: string;
  className: string;
  children: Element[] = [];
  value = "";
  id = "";
  type = "";
  required = false;
  disabled = false;
  htmlFor = "";
  onclick?: () => void;
  onsubmit?: (event: { preventDefault(): void }) => void;

  constructor(tagName: string, textContent = "", className = "") {
    this.tagName = tagName;
    this.textContent = textContent;
    this.className = className;
  }

  append(...children: Element[]) {
    this.children.push(...children);
  }
}

const appSource = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const blockStart = appSource.indexOf(
  "  const uncertainCalls = (snapshot.mcpCalls || []).filter(",
);
const blockEnd = appSource.indexOf(
  "  const encodedActions = JSON.stringify([",
  blockStart,
);
assert.ok(blockStart >= 0, "MCP reconciliation renderer was not found");
assert.ok(
  blockEnd > blockStart,
  "MCP reconciliation renderer end was not found",
);
const reconciliationRenderer = appSource.slice(blockStart, blockEnd);

function renderMcpCalls(calls: Call[], conversationId = "conversation-a") {
  const cards: Element[] = [];
  const apiCalls: Array<{
    path: string;
    method?: string;
    data?: Record<string, unknown>;
  }> = [];
  let rendered = 0;
  const i18n = interfaceLanguage().i18n;
  const node = (tag: string, value?: unknown, className = "") =>
    new Element(tag, value === undefined ? "" : String(value), className);
  const context = {
    ...i18n,
    uiNode: (tag: string, render: () => string, className = "") =>
      i18n.text(node(tag, undefined, className), render),
    snapshot: { mcpCalls: calls },
    conversationId,
    cards,
    node: (tag: string, value?: unknown, className = "") =>
      new Element(tag, value === undefined ? "" : String(value), className),
    api: (path: string, method?: string, data?: Record<string, unknown>) => {
      apiCalls.push({ path, method, data });
      return Promise.resolve({ mcpCalls: [] });
    },
    render: () => {
      rendered += 1;
    },
  };
  runInNewContext(reconciliationRenderer, context);
  return {
    cards,
    apiCalls,
    context,
    get rendered() {
      return rendered;
    },
  };
}

function textContent(element: Element): string {
  return [
    element.textContent,
    ...element.children.map((child) => textContent(child)),
  ].join(" ");
}

function findElement(element: Element, tagName: string): Element | undefined {
  if (element.tagName === tagName) return element;
  for (const child of element.children) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return undefined;
}

const baseCall = (state: string, id = `call-${state}`): Call => ({
  id,
  server: "sample",
  tool: "write_file",
  state,
  args: '{"token":"raw-token-sentinel","url":"https://private.example"}',
  result: null,
});

test("done and failed MCP calls never render a reconciliation control", () => {
  for (const state of ["done", "failed"]) {
    const ui = renderMcpCalls([baseCall(state)]);
    assert.equal(ui.cards.length, 0, `${state} should not be reconciled`);
  }
});

test("uncertain MCP call explains dispatch, shows safe persisted error, and submits against its captured conversation", async () => {
  const call = baseCall("uncertain", "uncertain-call");
  call.result = JSON.stringify({
    isError: true,
    content: [
      {
        type: "text",
        text: "A sessão MCP expirou ou foi encerrada (HTTP 404). A chamada não foi reenviada; verifique o resultado no serviço. A próxima operação abrirá uma nova sessão.",
      },
    ],
  });
  const ui = renderMcpCalls([call], "conversation-at-render");
  assert.equal(ui.cards.length, 1);
  const card = ui.cards[0]!;
  const text = textContent(card);
  assert.match(text, /A chamada foi enviada/);
  assert.match(text, /não será reenviada automaticamente/i);
  assert.match(text, /A sessão MCP expirou ou foi encerrada/);
  assert.doesNotMatch(text, /raw-token-sentinel|private\.example/);

  const button = findElement(card, "button");
  const form = findElement(card, "form");
  const input = findElement(card, "input");
  assert.ok(button);
  assert.ok(form?.onsubmit);
  assert.ok(input);
  assert.equal(button.textContent, "Registrar resultado");
  input.value = "Verificado no sistema de teste";

  ui.context.conversationId = "conversation-switched-after-render";
  form.onsubmit({ preventDefault() {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    ui.apiCalls.map((request) => request.path),
    [
      "/api/conversations/conversation-at-render/mcp-calls/uncertain-call/reconcile",
      "/api/conversations/conversation-at-render",
    ],
  );
  assert.equal(ui.apiCalls[0]?.method, "POST");
  assert.equal(
    JSON.stringify(ui.apiCalls[0]?.data),
    JSON.stringify({ note: "Verificado no sistema de teste" }),
  );
  assert.equal(ui.rendered, 0);
});

test("uncertain card does not display an unrecognized MCP error or raw tool arguments", () => {
  const call = baseCall("uncertain", "unsafe-error-call");
  call.result = JSON.stringify({
    isError: true,
    content: [
      {
        type: "text",
        text: "upstream included raw-token-sentinel and https://private.example",
      },
    ],
  });
  const ui = renderMcpCalls([call]);
  const text = textContent(ui.cards[0]!);
  assert.match(text, /A chamada foi enviada/);
  assert.doesNotMatch(
    text,
    /raw-token-sentinel|private\.example|upstream included/,
  );
});
