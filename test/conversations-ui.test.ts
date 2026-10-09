import { interfaceLanguage } from "./interface-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Conversation = { id: string; title: string; deletedAt?: number | null };
type Api = (path: string, method?: string, data?: unknown) => Promise<unknown>;
type AttachConversationManagementUI = (
  api: Api,
  callbacks: {
    getConversationId: () => string | null;
    getConversations: () => Conversation[];
    loadConversations: () => Promise<Conversation[]>;
    selectConversation: (id: string, title: string) => Promise<void>;
    closeSidebar: () => void;
    afterDelete: (id: string, wasActive: boolean) => Promise<void>;
    onRenamed: (conversation: Conversation) => void;
    report: (error: Error) => void;
  },
) => {
  render: (items?: Conversation[]) => void;
  isDeletedView: () => boolean;
  getDeletedConversations: () => Conversation[];
};

type Handler = (event: { preventDefault(): void }) => unknown;

class Element {
  id = "";
  value = "";
  textContent = "";
  className = "";
  type = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  attributes = new Map<string, string>();
  children: Element[] = [];
  onclick?: () => unknown;
  oninput?: () => unknown;
  onsubmit?: Handler;
  listeners = new Map<string, Array<() => unknown>>();
  focused = false;

  append(...children: Element[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: Element[]) {
    this.children = children;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) || null;
  }

  addEventListener(name: string, handler: () => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), handler]);
  }

  async emit(name: string) {
    for (const handler of this.listeners.get(name) || []) await handler();
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {
    this.focused = true;
  }
}

class FakeDocument {
  readonly elements = new Map<string, Element>();

  getElementById(id: string) {
    return this.elements.get(id) || null;
  }

  createElement() {
    return new Element();
  }
}

function fixture({
  conversations = [
    { id: "active", title: "Conversa ativa" },
    { id: "other", title: "Outra conversa" },
  ],
  deleted = [{ id: "deleted", title: "Conversa removida", deletedAt: 123 }],
  failDelete = false,
  language = "pt-BR",
}: {
  conversations?: Array<{ id: string; title: string }>;
  deleted?: Array<{ id: string; title: string; deletedAt: number }>;
  failDelete?: boolean;
  language?: string;
} = {}) {
  const document = new FakeDocument();
  const ids = [
    "conversations",
    "conversation-count",
    "search-conversations",
    "search-empty",
    "conversation-list-heading",
    "toggle-deleted-conversations",
    "conversation-management-dialog",
    "conversation-management-title",
    "conversation-management-intro",
    "conversation-management-form",
    "conversation-management-rename-fields",
    "conversation-management-delete-fields",
    "conversation-management-name",
    "conversation-management-confirm-delete",
    "conversation-management-error",
    "conversation-management-submit",
    "conversation-management-cancel",
    "conversation-management-close",
  ];
  for (const id of ids) {
    const element = new Element();
    element.id = id;
    document.elements.set(id, element);
  }
  const source = readFileSync(
    new URL("../public/conversations.js", import.meta.url),
    "utf8",
  ).replace(
    "export function attachConversationManagementUI",
    "function attachConversationManagementUI",
  );
  const i18n = interfaceLanguage(language).i18n;
  const attachConversationManagementUI = runInNewContext(
    `${source}\nattachConversationManagementUI`,
    { document, PiI18n: i18n },
  ) as AttachConversationManagementUI;

  let active = [...conversations];
  const requests: Array<{ path: string; method: string; data?: unknown }> = [];
  const operations: string[] = [];
  const api = async (path: string, method = "GET", data?: unknown) => {
    requests.push({ path, method, data });
    if (path === "/api/conversations?deleted=1") return [...deleted];
    if (method === "PUT")
      return {
        id: path.split("/").at(-1),
        title: (data as { title: string }).title,
        deletedAt: null,
      };
    if (method === "DELETE") {
      if (failDelete) throw new Error("Há operações pendentes.");
      return {
        id: path.split("/").at(-1),
        title: "Conversa ativa",
        deletedAt: 456,
      };
    }
    if (method === "POST") return { id: "deleted", title: "Conversa removida" };
    return active;
  };
  const manager = attachConversationManagementUI(api, {
    getConversationId: () => "active",
    getConversations: () => active,
    loadConversations: async () => {
      active = (await api("/api/conversations")) as typeof active;
      manager.render(active);
      return active;
    },
    selectConversation: async () => {
      operations.push("select");
    },
    closeSidebar: () => operations.push("close-sidebar"),
    afterDelete: async (id: string, wasActive: boolean) => {
      operations.push(`deleted:${id}:${wasActive}`);
    },
    onRenamed: (conversation: Conversation) =>
      operations.push(`renamed:${conversation.id}:${conversation.title}`),
    report: (error: Error) => operations.push(`error:${error.message}`),
  });
  manager.render(active);

  return {
    document,
    manager,
    i18n,
    requests,
    operations,
    get active() {
      return active;
    },
    restoreDocument() {
      // The VM has an isolated document for every fixture.
    },
  };
}

function buttonWithText(element: Element, label: string): Element {
  const found = element.children.find((child) => child.textContent === label);
  assert.ok(found, `expected button ${label}`);
  return found;
}

async function openActions(f: ReturnType<typeof fixture>, id = "active") {
  const row = f.document
    .getElementById("conversations")!
    .children.find((item) => item.getAttribute("data-conversation-id") === id);
  assert.ok(row);
  const toggle = row.children.find((child) =>
    child.attributes.get("aria-label")?.startsWith("Ações para "),
  );
  assert.ok(toggle);
  await toggle.onclick?.();
  assert.equal(
    f.document
      .getElementById("conversations")!
      .getAttribute("data-actions-open"),
    "true",
  );
  const panel = row.children.find(
    (child) => child.attributes.get("data-actions") === "true",
  );
  assert.ok(panel, `action panel for ${id}`);
  return panel;
}

test("active conversations expose rename and delete actions; rename trims and refreshes the title", async () => {
  const f = fixture();
  try {
    const panel = await openActions(f);
    await buttonWithText(panel, "Renomear").onclick?.();
    const name = f.document.getElementById("conversation-management-name")!;
    assert.equal(name.value, "Conversa ativa");
    name.value = "  Título atualizado  ";
    await f.document.getElementById("conversation-management-form")!.onsubmit!({
      preventDefault() {},
    });

    assert.equal(
      JSON.stringify(f.requests.find((request) => request.method === "PUT")),
      JSON.stringify({
        path: "/api/conversations/active",
        method: "PUT",
        data: { title: "Título atualizado" },
      }),
    );
    assert.ok(f.operations.includes("renamed:active:Título atualizado"));
    assert.equal(
      f.document.getElementById("conversation-management-dialog")!.open,
      false,
    );
    assert.ok(
      f.requests.some((request) => request.path === "/api/conversations"),
    );
  } finally {
    f.restoreDocument();
  }
});

test("rename rejects blank or control-character titles without sending a request", async () => {
  const f = fixture();
  try {
    const panel = await openActions(f);
    await buttonWithText(panel, "Renomear").onclick?.();
    f.document.getElementById("conversation-management-name")!.value =
      "  título\u0007inválido  ";
    await f.document.getElementById("conversation-management-form")!.onsubmit!({
      preventDefault() {},
    });

    assert.equal(
      f.requests.some((request) => request.method === "PUT"),
      false,
    );
    assert.match(
      f.document.getElementById("conversation-management-error")!.textContent,
      /caracteres de controle/,
    );
    assert.equal(
      f.document.getElementById("conversation-management-dialog")!.open,
      true,
    );
  } finally {
    f.restoreDocument();
  }
});

test("delete requires acknowledgement and only runs after explicit confirmation", async () => {
  const f = fixture();
  try {
    const panel = await openActions(f);
    await buttonWithText(panel, "Excluir").onclick?.();
    const dialog = f.document.getElementById("conversation-management-dialog")!;
    assert.equal(dialog.open, true);
    assert.match(
      f.document.getElementById("conversation-management-intro")!.textContent,
      /tarefas.*pausadas.*Telegram.*vinculado novamente/i,
    );
    const submit = f.document.getElementById("conversation-management-submit")!;
    assert.equal(submit.disabled, true);
    await f.document
      .getElementById("conversation-management-cancel")!
      .onclick?.();
    assert.equal(
      f.requests.some((request) => request.method === "DELETE"),
      false,
    );
    assert.equal(
      f.operations.some((operation) => operation.startsWith("deleted:")),
      false,
    );

    await openActions(f).then((next) =>
      buttonWithText(next, "Excluir").onclick?.(),
    );
    f.document.getElementById(
      "conversation-management-confirm-delete",
    )!.checked = true;
    await f.document
      .getElementById("conversation-management-confirm-delete")!
      .emit("change");
    assert.equal(submit.disabled, false);
    await f.document.getElementById("conversation-management-form")!.onsubmit!({
      preventDefault() {},
    });

    assert.equal(
      JSON.stringify(f.requests.find((request) => request.method === "DELETE")),
      JSON.stringify({
        path: "/api/conversations/active",
        method: "DELETE",
        data: { confirm: true },
      }),
    );
    assert.ok(f.operations.includes("deleted:active:true"));
  } finally {
    f.restoreDocument();
  }
});

test("a rejected delete leaves the active conversation untouched", async () => {
  const f = fixture({ failDelete: true });
  try {
    const panel = await openActions(f);
    await buttonWithText(panel, "Excluir").onclick?.();
    f.document.getElementById(
      "conversation-management-confirm-delete",
    )!.checked = true;
    await f.document
      .getElementById("conversation-management-confirm-delete")!
      .emit("change");
    await f.document.getElementById("conversation-management-form")!.onsubmit!({
      preventDefault() {},
    });

    assert.equal(
      f.operations.some((operation) => operation.startsWith("deleted:")),
      false,
    );
    assert.equal(
      f.document.getElementById("conversation-management-error")!.textContent,
      "Há operações pendentes.",
    );
    assert.equal(
      f.document.getElementById("conversation-management-dialog")!.open,
      true,
    );
    assert.equal(f.manager.isDeletedView(), false);
  } finally {
    f.restoreDocument();
  }
});

test("non-active conversations expose actions without changing the active conversation", async () => {
  const f = fixture();
  try {
    const panel = await openActions(f, "other");
    await buttonWithText(panel, "Excluir").onclick?.();
    f.document.getElementById(
      "conversation-management-confirm-delete",
    )!.checked = true;
    await f.document
      .getElementById("conversation-management-confirm-delete")!
      .emit("change");
    await f.document.getElementById("conversation-management-form")!.onsubmit!({
      preventDefault() {},
    });

    assert.ok(f.operations.includes("deleted:other:false"));
    assert.equal(f.operations.includes("select"), false);
  } finally {
    f.restoreDocument();
  }
});

test("deleted conversations are discoverable and can be restored without selecting them", async () => {
  const f = fixture();
  try {
    await f.document
      .getElementById("toggle-deleted-conversations")!
      .onclick?.();
    assert.equal(f.manager.isDeletedView(), true);
    assert.ok(
      f.requests.some(
        (request) => request.path === "/api/conversations?deleted=1",
      ),
    );
    const row = f.document.getElementById("conversations")!.children[0]!;
    assert.equal(row.children[0]!.textContent, "Conversa removida");
    const panel = await openActions(f, "deleted");
    await buttonWithText(panel, "Restaurar").onclick?.();

    assert.equal(
      JSON.stringify(f.requests.find((request) => request.method === "POST")),
      JSON.stringify({
        path: "/api/conversations/deleted/restore",
        method: "POST",
        data: {},
      }),
    );
    assert.equal(f.operations.includes("select"), false);
    assert.ok(
      f.requests.filter(
        (request) => request.path === "/api/conversations?deleted=1",
      ).length >= 2,
    );
  } finally {
    f.restoreDocument();
  }
});

test("language changes relabel open conversation menus and dialogs without changing drafts or title data", async () => {
  const f = fixture({
    conversations: [{ id: "active", title: "Nova conversa" }],
  });
  const panel = await openActions(f);
  const rename = buttonWithText(panel, "Renomear");
  f.i18n.setLanguage("en");
  assert.equal(rename.textContent, "Rename");
  assert.equal(panel.hidden, false);
  assert.equal(
    f.document.getElementById("conversations")!.children[0]!.children[0]!
      .children[0]!.textContent,
    "Nova conversa",
  );
  await rename.onclick?.();
  assert.equal(
    f.document.getElementById("conversation-management-title")!.textContent,
    "Rename conversation",
  );
  const input = f.document.getElementById("conversation-management-name")!;
  input.value = "Excluir conversa";
  f.i18n.setLanguage("pt-BR");
  assert.equal(input.value, "Excluir conversa");
  assert.equal(
    f.document.getElementById("conversation-management-title")!.textContent,
    "Renomear conversa",
  );
  f.i18n.setLanguage("en");
  await f.document.getElementById("conversation-management-form")!.onsubmit!({
    preventDefault() {},
  });
  assert.equal(
    (
      f.requests.find((request) => request.method === "PUT")!.data as {
        title: string;
      }
    ).title,
    "Excluir conversa",
  );
});
