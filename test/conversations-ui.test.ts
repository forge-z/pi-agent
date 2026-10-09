import { interfaceLanguage } from "./interface-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Conversation = {
  id: string;
  title: string;
  deletedAt?: number | null;
  purgeAt?: number | null;
  channel?: "web" | "telegram";
  telegramLinked?: boolean;
};
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
  showActiveView: () => void;
  isDeletedView: () => boolean;
  getDeletedConversations: () => Conversation[];
  refreshDeletedView: () => Promise<boolean>;
  reset: () => void;
};

type Handler = (event: { preventDefault(): void }) => unknown;

class Element {
  title = "";
  tagName = "";
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

  createElement(tagName = "") {
    const element = new Element();
    element.tagName = tagName;
    return element;
  }

  createElementNS(_namespace: string, tagName: string) {
    const element = new Element();
    element.tagName = tagName;
    return element;
  }
}

function fixture({
  conversations = [
    { id: "active", title: "Conversa ativa" },
    { id: "other", title: "Outra conversa" },
  ],
  deleted = [{ id: "deleted", title: "Conversa removida", deletedAt: 123 }],
  failDelete = false,
  deletedReader,
  language = "pt-BR",
}: {
  conversations?: Array<Conversation>;
  deleted?: Array<{
    id: string;
    title: string;
    deletedAt: number;
    purgeAt?: number | null;
    channel?: "web" | "telegram";
    telegramLinked?: boolean;
  }>;
  failDelete?: boolean;
  deletedReader?: () => Promise<Conversation[]>;
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
    "conversation-management-delete-notice",
    "conversation-management-deadline",
    "conversation-management-delete-acknowledgement",
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
    if (path === "/api/conversations?deleted=1")
      return deletedReader ? deletedReader() : [...deleted];
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
    if (method === "POST") {
      if (path.endsWith("/purge") && failDelete)
        throw new Error("Há operações pendentes.");
      return { id: "deleted", title: "Conversa removida" };
    }
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

test("only Telegram-origin conversations show the translated icon, never legacy linked web rows", () => {
  const f = fixture({
    language: "en",
    conversations: [
      {
        id: "telegram-origin",
        title: "Telegram-origin history",
        channel: "telegram",
        telegramLinked: true,
      },
      {
        id: "web-linked",
        title: "Linked web history",
        channel: "web",
        telegramLinked: true,
      },
      { id: "lookalike", title: "Telegram in title only", channel: "web" },
    ],
  });
  const rows = f.document.getElementById("conversations")!.children;
  const telegram = rows[0]!.children[0]!;
  const linkedWeb = rows[1]!.children[0]!;
  const lookalike = rows[2]!.children[0]!;
  const icon = telegram.children[0]!;

  assert.equal(icon.tagName, "svg");
  assert.equal(icon.attributes.get("class"), "icon conversation-telegram-icon");
  assert.equal(icon.attributes.get("aria-hidden"), "true");
  assert.equal(icon.attributes.get("title"), "Telegram conversation");
  assert.equal(
    icon.children[0]!.attributes.get("href"),
    "/icons.svg#telegram-logo",
  );
  assert.equal(
    telegram.attributes.get("aria-description"),
    "Telegram conversation",
  );
  assert.equal(telegram.title, "Telegram-origin history");
  assert.equal(telegram.children[1]!.textContent, "Telegram-origin history");
  f.i18n.setLanguage("pt-BR");
  assert.equal(icon.attributes.get("title"), "Conversa Telegram");
  assert.equal(
    telegram.attributes.get("aria-description"),
    "Conversa Telegram",
  );
  assert.equal(linkedWeb.children.length, 1);
  assert.equal(linkedWeb.children[0]!.textContent, "Linked web history");
  assert.equal(lookalike.children.length, 1);
  assert.equal(lookalike.children[0]!.textContent, "Telegram in title only");
});

test("Telegram-origin marker stays icon-only in trash and after restoration", async () => {
  const f = fixture({
    conversations: [
      {
        id: "deleted-telegram",
        title: "Telegram-origin history",
        channel: "telegram",
      },
    ],
    deleted: [
      {
        id: "deleted-telegram",
        title: "Telegram-origin history",
        deletedAt: 123,
        channel: "telegram",
      },
      {
        id: "deleted-web",
        title: "Linked web history",
        deletedAt: 124,
        channel: "web",
        telegramLinked: true,
      },
    ],
  });
  await f.document.getElementById("toggle-deleted-conversations")!.onclick?.();

  const rows = f.document.getElementById("conversations")!.children;
  const telegramRow = rows[0]!;
  assert.equal(telegramRow.children[0]!.tagName, "svg");
  assert.equal(
    telegramRow.children[0]!.attributes.get("title"),
    "Conversa Telegram",
  );
  assert.equal(telegramRow.children[1]!.tagName, "span");
  assert.equal(telegramRow.children[1]!.textContent, "Telegram-origin history");
  const webRow = rows[1]!;
  assert.equal(webRow.children[0]!.tagName, "span");
  assert.equal(webRow.children[0]!.textContent, "Linked web history");

  const panel = await openActions(f, "deleted-telegram");
  await buttonWithText(panel, "Restaurar").onclick?.();
  f.manager.showActiveView();
  const restored =
    f.document.getElementById("conversations")!.children[0]!.children[0]!;
  assert.equal(
    restored.children[0]!.children[0]!.attributes.get("href"),
    "/icons.svg#telegram-logo",
  );
});

test("deleted sidebar refresh ignores a stale result when the user switches views", async () => {
  let resolveRefresh!: (rows: Conversation[]) => void;
  let reads = 0;
  const f = fixture({
    deleted: [{ id: "deleted", title: "Current trash row", deletedAt: 123 }],
    deletedReader: () => {
      reads++;
      if (reads === 1)
        return Promise.resolve([
          { id: "deleted", title: "Current trash row", deletedAt: 123 },
        ]);
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    },
  });
  await f.document.getElementById("toggle-deleted-conversations")!.onclick?.();
  const refresh = f.manager.refreshDeletedView();
  f.manager.showActiveView();
  resolveRefresh([{ id: "newer", title: "New trash row", deletedAt: 456 }]);

  assert.equal(await refresh, false);
  assert.equal(f.manager.isDeletedView(), false);
  assert.equal(
    f.manager.getDeletedConversations()[0]!.title,
    "Current trash row",
  );
  assert.equal(
    f.document.getElementById("conversations")!.children[0]!.children[0]!
      .children[0]!.textContent,
    "Conversa ativa",
  );
});

test("reset invalidates an in-flight trash view toggle", async () => {
  let resolveLoad!: (rows: Conversation[]) => void;
  const f = fixture({
    deletedReader: () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
  });
  const toggle = f.document.getElementById("toggle-deleted-conversations")!
    .onclick!();
  f.manager.reset();
  resolveLoad([{ id: "deleted", title: "Stale trash row", deletedAt: 123 }]);
  await toggle;

  assert.equal(f.manager.isDeletedView(), false);
  assert.equal(
    f.document.getElementById("conversations")!.children[0]!.children[0]!
      .children[0]!.textContent,
    "Conversa ativa",
  );
});

test("archive warns about seven-day irreversible deletion before confirmation", async () => {
  const f = fixture();
  await buttonWithText(await openActions(f), "Excluir").onclick?.();
  assert.match(
    f.document.getElementById("conversation-management-intro")!.textContent,
    /7 dias.*definitivamente/,
  );
  assert.match(
    f.document.getElementById("conversation-management-delete-notice")!
      .textContent,
    /restaurar.*7 dias/,
  );
  assert.equal(
    f.requests.some((request) => request.method === "DELETE"),
    false,
  );
  const forecast = f.document.getElementById(
    "conversation-management-deadline",
  )!;
  assert.match(forecast.textContent, /prevista em.*7 dias.*confirmar/);
  f.i18n.setLanguage("en");
  assert.match(forecast.textContent, /estimated for.*7-day.*confirm/);
});

test("deleted row shows localized deadline; immediate purge requires acknowledgement and captured archive version", async () => {
  const purgeAt = Date.UTC(2026, 9, 16, 12);
  const f = fixture({
    deleted: [
      { id: "deleted", title: "Meu histórico", deletedAt: 123, purgeAt },
    ],
  });
  await f.document.getElementById("toggle-deleted-conversations")!.onclick?.();
  const row = f.document.getElementById("conversations")!.children[0]!;
  const deadline = row.children.find(
    (child) => child.className === "conversation-purge-deadline",
  )!;
  assert.ok(deadline);
  assert.match(deadline.textContent, /Exclusão definitiva em/);
  const panel = await openActions(f, "deleted");
  await buttonWithText(panel, "Excluir agora").onclick?.();
  assert.equal(
    f.document.getElementById("conversation-management-submit")!.disabled,
    true,
  );
  assert.match(
    f.document.getElementById("conversation-management-intro")!.textContent,
    /Meu histórico.*definitivamente agora.*não pode ser desfeita/,
  );
  await f.document.getElementById("conversation-management-form")!.onsubmit!({
    preventDefault() {},
  });
  assert.equal(
    f.requests.some((request) => request.path.endsWith("/purge")),
    false,
  );
  f.i18n.setLanguage("en");
  assert.match(deadline.textContent, /Permanent deletion on/);
  assert.match(
    f.document.getElementById("conversation-management-intro")!.textContent,
    /cannot be undone/,
  );
  assert.match(
    f.document.getElementById("conversation-management-delete-acknowledgement")!
      .textContent,
    /permanent/,
  );
  const confirm = f.document.getElementById(
    "conversation-management-confirm-delete",
  )!;
  confirm.checked = true;
  await confirm.emit("change");
  await f.document.getElementById("conversation-management-form")!.onsubmit!({
    preventDefault() {},
  });
  const request = f.requests.find((request) => request.path.endsWith("/purge"));
  assert.equal(
    JSON.stringify(request),
    JSON.stringify({
      path: "/api/conversations/deleted/purge",
      method: "POST",
      data: { confirm: true, expectedDeletedAt: 123 },
    }),
  );
  assert.equal(f.operations.includes("select"), false);
  assert.equal(
    f.operations.some((operation) => operation.startsWith("deleted:")),
    false,
  );
  assert.equal(
    f.document.getElementById("conversation-management-dialog")!.open,
    false,
  );
});

test("failed permanent deletion preserves dialog, confirmation and retained row", async () => {
  const f = fixture({
    deleted: [
      {
        id: "deleted",
        title: "Retido",
        deletedAt: 123,
        purgeAt: Date.UTC(2026, 9, 16),
      },
    ],
    failDelete: true,
  });
  await f.document.getElementById("toggle-deleted-conversations")!.onclick?.();
  await buttonWithText(
    await openActions(f, "deleted"),
    "Excluir agora",
  ).onclick?.();
  const confirm = f.document.getElementById(
    "conversation-management-confirm-delete",
  )!;
  confirm.checked = true;
  await confirm.emit("change");
  await f.document.getElementById("conversation-management-form")!.onsubmit!({
    preventDefault() {},
  });
  assert.equal(
    f.document.getElementById("conversation-management-dialog")!.open,
    true,
  );
  assert.equal(confirm.checked, true);
  assert.equal(f.manager.getDeletedConversations().length, 1);
  assert.match(
    f.document.getElementById("conversation-management-error")!.textContent,
    /pendentes/,
  );
});

test("a delayed trash refresh cannot repopulate a permanently purged row", async () => {
  const rows = [
    { id: "a", title: "A", deletedAt: 1, purgeAt: 1000 },
    { id: "b", title: "B", deletedAt: 2, purgeAt: 1000 },
  ];
  let call = 0;
  const reads: Array<(rows: Conversation[]) => void> = [];
  const f = fixture({
    deletedReader: () =>
      ++call === 1
        ? Promise.resolve(rows)
        : new Promise((resolve) => reads.push(resolve)),
  });
  await f.document.getElementById("toggle-deleted-conversations")!.onclick?.();
  async function purge(id: string) {
    await buttonWithText(await openActions(f, id), "Excluir agora").onclick?.();
    f.document.getElementById(
      "conversation-management-confirm-delete",
    )!.checked = true;
    return f.document.getElementById("conversation-management-form")!.onsubmit!(
      { preventDefault() {} },
    );
  }
  const first = purge("a");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 1);
  const second = purge("b");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 2);
  reads[1]([]);
  await second;
  reads[0]([rows[1]]);
  await first;
  assert.equal(f.manager.getDeletedConversations().length, 0);
  assert.equal(f.document.getElementById("conversations")!.children.length, 0);
});
