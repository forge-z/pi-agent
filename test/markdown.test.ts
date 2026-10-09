import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { lexer } from "marked";

class TestNode {
  children: TestNode[] = [];
  attributes = new Map<string, string>();
  constructor(
    readonly nodeName: string,
    readonly text = "",
  ) {}
  append(...nodes: TestNode[]) {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
}

const rendererSource = readFileSync(
  new URL("../public/markdown.js", import.meta.url),
  "utf8",
)
  .replace(/^import \{ lexer \} from "\/marked\.js";\s*/m, "")
  .replaceAll("export function ", "function ");
const renderMarkdown = runInNewContext(`${rendererSource}\nrenderMarkdown`, {
  lexer,
  URL,
}) as (source: string, doc: typeof testDocument) => TestNode;

const testDocument = {
  createDocumentFragment: () => new TestNode("#document-fragment"),
  createElement: (tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode("#text", text),
};

test("handoff links preserve the chat tab and isolate the external viewer", () => {
  const fragment = renderMarkdown(
    "Acesse [Abrir acesso seguro](https://example.invalid/handoff).",
    testDocument,
  );
  const link = find(fragment, "a");
  assert.ok(link);
  assert.equal(link.attributes.get("target"), "_blank");
  assert.equal(link.attributes.get("rel"), "noopener noreferrer");
});

test("renders paragraphs, headings, emphasis, inline and fenced code", () => {
  const fragment = renderMarkdown(
    "# Heading\n\nFirst **bold** and *italic* with `code` and \\* escaped.\n\n```js\nconst x = 1;\n```",
    testDocument,
  );
  assert.deepEqual(tags(fragment), [
    "#document-fragment",
    "h1",
    "p",
    "strong",
    "em",
    "code",
    "pre",
    "code",
  ]);
  assert.equal(
    find(fragment, "code")?.textContent,
    "code",
    "inline code is present before the fenced block",
  );
  assert.equal(
    fragment.textContent,
    "HeadingFirst bold and italic with code and * escaped.const x = 1;",
  );
});

test("renders nested lists and links with balanced parentheses", () => {
  const fragment = renderMarkdown(
    "- one\n  - child\n  - [Docs](https://example.com/a_(b))\n\n1. first\n2. second",
    testDocument,
  );
  assert.deepEqual(
    tags(fragment).filter((tag) => ["ul", "ol", "li"].includes(tag)),
    ["ul", "li", "ul", "li", "li", "ol", "li", "li"],
  );
  assert.equal(
    find(fragment, "a")?.attributes.get("href"),
    "https://example.com/a_(b)",
  );
});

test("keeps partial syntax readable between streaming updates", () => {
  const partial = renderMarkdown(
    "still **typing and `unfinished",
    testDocument,
  );
  assert.equal(partial.textContent, "still **typing and `unfinished");
  assert.equal(find(partial, "strong"), undefined);
  assert.equal(find(partial, "code"), undefined);

  const complete = renderMarkdown(
    "still **typing** and `finished`",
    testDocument,
  );
  assert.equal(complete.textContent, "still typing and finished");
  assert.ok(find(complete, "strong"));
  assert.ok(find(complete, "code"));
});

test("renders raw HTML inertly and blocks executable, credentialed, and remote image URLs", () => {
  const fragment = renderMarkdown(
    "<img src=x onerror=alert(1)> [js](javascript:alert(1)) [data](data:text/html,x) [auth](https://user:pass@example.com/) ![remote](https://example.com/image.png)",
    testDocument,
  );
  assert.equal(
    fragment.textContent,
    "<img src=x onerror=alert(1)> [js](javascript:alert(1)) [data](data:text/html,x) [auth](https://user:pass@example.com/) remote",
  );
  assert.equal(find(fragment, "img"), undefined);
  assert.equal(find(fragment, "a"), undefined);
  assert.equal(find(fragment, "script"), undefined);
});

test("allows safe HTTP, HTTPS, and mailto links", () => {
  const fragment = renderMarkdown(
    "[site](https://example.com) [local](http://example.com) [mail](mailto:test@example.com)",
    testDocument,
  );
  const anchors = findAll(fragment, "a");
  assert.deepEqual(
    anchors.map((anchor) => anchor.attributes.get("href")),
    ["https://example.com/", "http://example.com/", "mailto:test@example.com"],
  );
});

function tags(root: TestNode): string[] {
  return [root.nodeName, ...root.children.flatMap(tags)].filter(
    (tag) => tag !== "#text",
  );
}

function find(root: TestNode, tag: string): TestNode | undefined {
  if (root.nodeName === tag) return root;
  for (const child of root.children) {
    const found = find(child, tag);
    if (found) return found;
  }
  return undefined;
}

function findAll(root: TestNode, tag: string): TestNode[] {
  return [
    ...(root.nodeName === tag ? [root] : []),
    ...root.children.flatMap((child) => findAll(child, tag)),
  ];
}

test("large base64 results bypass Markdown without overflowing the parser stack", () => {
  const source = JSON.stringify({
    result: { content: [{ type: "image", data: "A".repeat(4 * 1024 * 1024) }] },
  });
  const fragment = renderMarkdown(source, testDocument);
  const pre = find(fragment, "pre");
  assert.ok(pre);
  assert.equal(pre.textContent.length, 32768);
  assert.ok(find(fragment, "button"));
  assert.match(fragment.textContent, /conteúdo completo permanece salvo/);
});

test("parser failure falls back to inert bounded text without losing following messages", () => {
  const safeRender = runInNewContext(`${rendererSource}\nrenderMarkdown`, {
    lexer: () => {
      throw new RangeError("Synthetic parser stack overflow");
    },
    URL,
  }) as typeof renderMarkdown;
  const source = "<script>private()</script> **partial";
  const fragment = safeRender(source, testDocument);
  assert.equal(find(fragment, "pre")?.textContent, source);
  assert.equal(find(fragment, "script"), undefined);
});

test("dense Markdown below the byte limit cannot build an unbounded token DOM", () => {
  const source = "**word** ".repeat(3000);
  const fragment = renderMarkdown(source, testDocument);
  assert.equal(find(fragment, "pre")?.textContent, source);
  assert.ok(tags(fragment).length < 5);
});

test("unbalanced emphasis below the text limit cannot block input before token limits run", () => {
  const source = "**a ".repeat(8190);
  // This exact sub-32KB input takes over ten seconds in the installed lexer.
  // The VM deadline interrupts synchronous parsing and makes the regression
  // fail promptly; the renderer must preserve the entire input as inert text.
  const fragment = runInNewContext(
    `${rendererSource}\nrenderMarkdown(source, testDocument)`,
    { lexer, URL, source, testDocument },
    { timeout: 1000 },
  ) as TestNode;
  assert.equal(find(fragment, "pre")?.textContent, source);
  assert.ok(tags(fragment).length < 5);
});

test("dense list markers also bypass parsing before nested list work blocks input", () => {
  for (const source of [
    "- ".repeat(16375) + "x",
    "+ ".repeat(16000) + "x",
    "1. ".repeat(10000) + "x",
  ]) {
    const fragment = runInNewContext(
      `${rendererSource}\nrenderMarkdown(source, testDocument)`,
      { lexer, URL, source, testDocument },
      { timeout: 250 },
    ) as TestNode;
    assert.equal(find(fragment, "pre")?.textContent, source);
  }
});
