import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

class Element {
  hidden = false;
  open = false;
  className = "";
  textContent = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  classList = { toggle() {} };
  onclick?: () => void;
  ontoggle?: () => void;
  constructor(public tagName: string) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  querySelectorAll() {
    return this.children.filter((child) => "toolDetail" in child.dataset);
  }
}
type ToolMessage = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};
const source = readFileSync(
  new URL("../public/tools.js", import.meta.url),
  "utf8",
);
const {
  attachToolVisibility,
  attachToolBody,
  createToolCalls,
  toolResultNeedsAttention,
} = runInNewContext(
  `${source.replaceAll("export ", "")}\n({attachToolVisibility, attachToolBody, createToolCalls, toolResultNeedsAttention})`,
) as {
  attachToolVisibility(options: {
    button: Element;
    messages: Element;
    storage(): {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    };
  }): { apply(): void };
  attachToolBody(details: Element, body: Element, render: () => Element): void;
  createToolCalls(
    content: unknown,
    options: {
      document: { createElement(tag: string): Element };
      icon(name: string): Element;
      live?: boolean;
    },
  ): Element[];
  toolResultNeedsAttention(message: ToolMessage): boolean;
};

function fixture(initial?: string) {
  const values = new Map(initial ? [["pi:tool-details", initial]] : []);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const button = new Element("button"),
    messages = new Element("div");
  const normal = new Element("details"),
    important = new Element("details");
  const assistant = new Element("article"),
    approval = new Element("article");
  normal.dataset.toolDetail = "";
  important.dataset.toolDetail = "";
  important.dataset.toolImportant = "true";
  messages.append(normal, important, assistant, approval);
  const control = attachToolVisibility({
    button,
    messages,
    storage: () => storage,
  });
  return {
    button,
    messages,
    normal,
    important,
    assistant,
    approval,
    control,
    storage,
    values,
  };
}

test("toggle hides only tool details, persists and restores the preference", () => {
  const ui = fixture();
  assert.equal(ui.button.attributes.get("aria-pressed"), "true");
  assert.equal(
    ui.button.attributes.get("aria-label"),
    "Mostrar chamadas de ferramentas",
  );
  assert.ok(ui.button.onclick);
  ui.button.onclick();
  assert.equal(ui.normal.hidden, true);
  for (const element of [ui.important, ui.assistant, ui.approval])
    assert.equal(element.hidden, false);
  assert.equal(ui.button.attributes.get("aria-pressed"), "false");
  assert.equal(ui.values.get("pi:tool-details"), "hidden");
  const reopened = fixture(ui.values.get("pi:tool-details"));
  assert.equal(reopened.normal.hidden, true);
  reopened.button.onclick!();
  assert.equal(reopened.normal.hidden, false);
  assert.equal(reopened.values.get("pi:tool-details"), "shown");
});

test("hidden preference also applies to new history and streaming tool calls", () => {
  const ui = fixture("hidden");
  const document = { createElement: (tag: string) => new Element(tag) };
  for (const live of [false, true]) {
    const calls = createToolCalls(
      [
        { type: "text", text: "Resposta do Pi" },
        {
          type: "toolCall",
          name: "mock_execute",
          arguments: { request: "<script>fake</script>" },
        },
      ],
      { document, icon: () => new Element("svg"), live },
    );
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.tagName, "details");
    assert.equal(call.children[0]?.tagName, "summary");
    assert.match(
      call.children[0]?.children[1]?.textContent ?? "",
      /mock_execute/,
    );
    assert.equal(
      call.children[1]?.children.length,
      0,
      "closed arguments remain unrendered",
    );
    call.open = true;
    call.ontoggle!();
    assert.equal(call.children[1]?.children[0]?.tagName, "pre");
    assert.match(
      call.children[1]?.children[0]?.textContent ?? "",
      /<script>fake<\/script>/,
    );
    ui.messages.append(call);
    ui.control.apply();
    assert.equal(call.hidden, true);
  }
  assert.equal(
    createToolCalls(null, { document, icon: () => new Element("svg") }).length,
    0,
  );
});

test("unavailable storage never prevents toggling or interacting with the page", () => {
  const button = new Element("button"),
    messages = new Element("div"),
    details = new Element("details");
  details.dataset.toolDetail = "";
  messages.append(details);
  attachToolVisibility({
    button,
    messages,
    storage: () => {
      throw new Error("Storage denied");
    },
  });
  button.onclick!();
  assert.equal(details.hidden, true);
  button.onclick!();
  assert.equal(details.hidden, false);
});

test("errors, handoffs and uncertain results remain visible with tool details hidden", () => {
  assert.equal(toolResultNeedsAttention({ isError: true }), true);
  for (const payload of [
    { status: "paused" },
    { status: "uncertain" },
    { status: "pending" },
    { paused: true },
    { result: { isError: true } },
  ]) {
    assert.equal(
      toolResultNeedsAttention({
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }),
      true,
    );
  }
  for (const text of ["Regular output", '{"status":"completed"}']) {
    assert.equal(
      toolResultNeedsAttention({ content: [{ type: "text", text }] }),
      false,
    );
  }
});

test("the chat renderer applies the preference to history and live updates while preserving assistant text and errors", () => {
  const appSource = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = appSource.indexOf(
    "  const messages = [];",
    appSource.indexOf("function render(snapshot)"),
  );
  const end = appSource.indexOf("  const actionLabels = {", start);
  assert.ok(start >= 0 && end > start);
  const ui = fixture("hidden");
  const fields = new Map<string, Element>([["messages", ui.messages]]);
  const get = (id: string) => {
    if (!fields.has(id)) fields.set(id, new Element("div"));
    return fields.get(id)!;
  };
  const textBlock = (text: string) => ({ type: "text", text });
  const snapshot = {
    actions: [],
    view: {
      entries: [
        {
          model: [
            {
              role: "assistant",
              content: [
                textBlock("Resposta salva"),
                { type: "toolCall", name: "saved_call", arguments: {} },
              ],
            },
            {
              role: "toolResult",
              toolName: "saved_call",
              content: [textBlock("Resultado normal")],
            },
            {
              role: "toolResult",
              toolName: "failed_call",
              isError: true,
              content: [textBlock("Erro: precisa de ação")],
            },
            {
              role: "toolResult",
              toolName: "pending_call",
              content: [textBlock('{"status":"paused"}')],
            },
          ],
        },
      ],
      docs: {
        "pi.live": {
          generation: {
            message: {
              content: [
                textBlock("Resposta parcial"),
                { type: "toolCall", name: "live_call", arguments: {} },
              ],
            },
          },
        },
      },
    },
  };
  const node = (tag: string, value?: string, className = "") => {
    const element = new Element(tag);
    element.textContent = value ?? "";
    element.className = className;
    return element;
  };
  runInNewContext(appSource.slice(start, end), {
    snapshot,
    historyWindow: runInNewContext(
      readFileSync(
        new URL("../public/history.js", import.meta.url),
        "utf8",
      ).replaceAll("export ", "") + "\nhistoryWindow",
    ),
    historyPage: 0,
    historyNodes: new Map(),
    $: get,
    document: { createElement: (tag: string) => node(tag) },
    node,
    icon: () => node("svg"),
    piMark: () => node("img"),
    renderMarkdown: (text: string) => node("div", text),
    renderTextPreview: (text: string) => node("pre", text.slice(0, 32768)),
    attachToolBody,
    createToolCalls,
    toolResultNeedsAttention,
    toolVisibility: ui.control,
  });
  const tools = ui.messages.querySelectorAll();
  assert.equal(tools.length, 5);
  assert.equal(tools.filter((element) => element.hidden).length, 3);
  assert.equal(
    tools.filter(
      (element) => element.dataset.toolImportant === "true" && !element.hidden,
    ).length,
    2,
  );
  const assistants = ui.messages.children.filter(
    (element) => element.tagName === "article",
  );
  assert.equal(assistants.length, 2);
  assert.equal(
    assistants[0]?.children[1]?.children[0]?.textContent,
    "Resposta salva",
  );
  assert.equal(
    assistants[1]?.children[1]?.children[0]?.textContent,
    "Resposta parcial",
  );
  assert.ok(assistants.every((element) => !element.hidden));
  ui.button.onclick!();
  assert.ok(tools.every((element) => !element.hidden));
});

test("closed tool bodies do no parser/DOM work and release expanded output on collapse", () => {
  const detail = new Element("details"),
    body = new Element("div");
  let renders = 0;
  attachToolBody(detail, body, () => {
    renders++;
    const pre = new Element("pre");
    pre.textContent = "x".repeat(32768);
    return pre;
  });
  assert.equal(renders, 0);
  assert.equal(body.children.length, 0);
  detail.open = true;
  detail.ontoggle!();
  detail.ontoggle!();
  assert.equal(renders, 1);
  assert.equal(body.children.length, 1);
  detail.open = false;
  detail.ontoggle!();
  assert.equal(body.children.length, 0);
  detail.open = true;
  detail.ontoggle!();
  assert.equal(renders, 2);
});

test("large tool arguments stay lazy and cannot create an unbounded text node", () => {
  const calls = createToolCalls(
    [
      {
        type: "toolCall",
        name: "synthetic",
        arguments: { image: "A".repeat(4 * 1024 * 1024) },
      },
    ],
    {
      document: { createElement: (tag) => new Element(tag) },
      icon: () => new Element("svg"),
    },
  );
  const call = calls[0]!;
  const body = call.children[1]!;
  assert.equal(body.children.length, 0);
  call.open = true;
  call.ontoggle!();
  assert.equal(body.children[0]!.textContent.length, 32768);
});
