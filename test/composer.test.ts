import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";

interface KeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode: number;
  repeat: boolean;
  preventDefault(): void;
}
class Element {
  value = "";
  textContent = "";
  disabled = false;
  selectionStart = 0;
  selectionEnd = 0;
  maxLength = 32000;
  submissions = 0;
  inputs = 0;
  listeners = new Map<string, (event: KeyEvent) => void>();
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  classList = { toggle() {}, contains: () => false };
  setAttribute() {}
  removeAttribute() {}
  querySelectorAll() {
    return [];
  }
  addEventListener(name: string, listener: (event: KeyEvent) => void) {
    this.listeners.set(name, listener);
  }
  setRangeText(text: string, start: number, end: number) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
  dispatchEvent(event: Event) {
    if (event.type === "input") this.inputs++;
  }
  requestSubmit() {
    this.submissions++;
    void this.onsubmit?.({ preventDefault() {} });
  }
}

function composer() {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const requests: unknown[] = [];
  const storage = new Map<string, string>();
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const toolsSource = readFileSync(
    new URL("../public/tools.js", import.meta.url),
    "utf8",
  );
  const eventsSource = readFileSync(
    new URL("../public/conversation-events.js", import.meta.url),
    "utf8",
  );
  // Load the real application handlers, substituting only the browser environment.
  runInNewContext(
    "const { attachToolVisibility, attachToolBody, createToolCalls, toolResultNeedsAttention } = (() => {" +
      toolsSource.replace(/^export /gm, "") +
      "\nreturn { attachToolVisibility, attachToolBody, createToolCalls, toolResultNeedsAttention }; })();" +
      "\nconst { attachConversationEvents } = (() => {" +
      eventsSource.replace(/^export /gm, "") +
      "\nreturn { attachConversationEvents }; })();" +
      "\n" +
      source.replace(/^import[\s\S]*?;\s*/gm, "") +
      '\nconversationId = "2";',
    {
      document: {
        getElementById: element,
        querySelectorAll: () => [],
        addEventListener() {},
      },
      window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
      navigator: {},
      configureUI: () => ({ reset() {} }),
      attachTelegramUI: () => ({ reset() {} }),
      attachConversationManagementUI: () => ({ render() {} }),
      canDispatchCommandResult: () => true,
      createSlashAutocomplete: () => ({
        close() {},
        handleKeydown: () => false,
        update() {},
        getCommands: async () => [],
      }),
      refreshConversationSnapshot: async () => true,
      crypto: { randomUUID },
      Event,
      sessionStorage: {
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      fetch: (path: string, options?: { body?: string }) => {
        if (path.endsWith("/messages"))
          requests.push(JSON.parse(options!.body!));
        // Keep admission pending to verify the in-flight guard without invoking rendering.
        return new Promise(() => {});
      },
    },
  );
  const message = element("message");
  return {
    message,
    form: element("message-form"),
    send: element("send"),
    status: element("run-status"),
    requests,
    press(options: Partial<KeyEvent> = {}) {
      let prevented = false;
      const event: KeyEvent = {
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        isComposing: false,
        keyCode: 13,
        repeat: false,
        ...options,
        preventDefault: () => {
          prevented = true;
        },
      };
      message.listeners.get("keydown")!(event);
      return prevented;
    },
    composing(active: boolean) {
      message.listeners.get(active ? "compositionstart" : "compositionend")!(
        {} as KeyEvent,
      );
    },
  };
}

test("Enter admits one message and ignores empty, repeated and overlapping submissions", () => {
  const ui = composer();
  ui.message.value = "   ";
  assert.equal(ui.press(), true);
  assert.equal(ui.form.submissions, 0);
  ui.message.value = "Minha mensagem";
  assert.equal(ui.press({ repeat: true }), true);
  assert.equal(ui.form.submissions, 0);
  assert.equal(ui.press(), true);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.message.value, "Minha mensagem");
  ui.press();
  ui.message.value = "Outro rascunho";
  ui.form.requestSubmit();
  assert.equal(ui.requests.length, 1);
});

test("Ctrl+Enter replaces the selection with a newline, preserves the caret and honors maxlength", () => {
  const ui = composer();
  ui.message.value = "Olá, mundo";
  ui.message.selectionStart = 3;
  ui.message.selectionEnd = 5;
  assert.equal(ui.press({ ctrlKey: true }), true);
  assert.equal(ui.message.value, "Olá\nmundo");
  assert.equal(ui.message.selectionStart, 4);
  assert.equal(ui.message.selectionEnd, 4);
  assert.equal(ui.message.inputs, 1);
  assert.equal(ui.requests.length, 0);
  ui.message.maxLength = ui.message.value.length;
  ui.message.selectionStart = ui.message.selectionEnd = ui.message.value.length;
  ui.press({ ctrlKey: true });
  assert.equal(ui.message.value, "Olá\nmundo");
  assert.equal(ui.message.inputs, 1);
});

test("IME confirmation and processing keys never submit, including unflagged composition events", () => {
  const ui = composer();
  ui.message.value = "日本語";
  assert.equal(ui.press({ isComposing: true }), false);
  assert.equal(ui.press({ isComposing: true, ctrlKey: true }), false);
  assert.equal(ui.press({ keyCode: 229 }), false);
  ui.composing(true);
  assert.equal(ui.press(), false);
  assert.equal(ui.requests.length, 0);
  ui.composing(false);
  assert.equal(ui.press(), true);
  assert.equal(ui.requests.length, 1);
});

test("Cmd+Enter still sends while Shift+Enter, Alt+Enter and other keys keep their native behavior", () => {
  const ui = composer();
  ui.message.value = "Mensagem no Mac";
  assert.equal(ui.press({ shiftKey: true }), false);
  assert.equal(ui.press({ altKey: true }), false);
  assert.equal(ui.press({ key: "a" }), false);
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.press({ metaKey: true }), true);
  assert.equal(ui.requests.length, 1);
  const combined = composer();
  combined.message.value = "Atalho anterior";
  combined.press({ metaKey: true, ctrlKey: true });
  assert.equal(combined.requests.length, 1);
});

test("pending HTTP admission shows immediate feedback without clearing the draft or retrying", () => {
  const ui = composer();
  ui.message.value = "Pending draft";
  ui.press();
  assert.equal(ui.status.textContent, "Enviando…");
  assert.equal(ui.message.value, "Pending draft");
  assert.equal(ui.send.disabled, true);
  ui.press();
  assert.equal(ui.requests.length, 1);
});

type SidebarConversation = {
  id: string;
  title: string;
  channel?: "web" | "telegram";
};

function selectionPolicyFixture(
  conversations: SidebarConversation[],
  search = "",
) {
  const source = readFileSync(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const workspaceStart = source.indexOf("async function workspace()");
  const workspaceCode = source.slice(
    workspaceStart,
    source.indexOf("async function select(id, title)", workspaceStart),
  );
  const deleteStart = source.indexOf("afterDelete: async (id, wasActive) => {");
  const deleteCallback = source.slice(
    deleteStart + "afterDelete: ".length,
    source.indexOf("\n  },\n});", deleteStart) + "\n  }".length,
  );
  const selected: string[] = [];
  const created: unknown[] = [];
  const elements = new Map<string, { hidden: boolean; value: string }>();
  let listReads = 0;
  const controller = runInNewContext(
    `let conversationId="deleted", conversationSelectionVersion=0, events=null,
      pendingMessage=null, rendered=null, renderedActions="", historyNavigation=null,
      historyPage=0, lastSnapshot=null;
     async function select(id) { conversationId=id; recordSelection(id); }
     ${workspaceCode}
     ({ workspace, afterDelete: ${deleteCallback}, current: () => conversationId });`,
    {
      $: (id: string) => {
        if (!elements.has(id)) elements.set(id, { hidden: false, value: "" });
        return elements.get(id)!;
      },
      URLSearchParams,
      location: { search, pathname: "/" },
      refreshStatus: async () => {},
      settingsUI: { load: async () => {}, updateConversation() {} },
      loadConversations: async () => {
        listReads++;
        return conversations;
      },
      api: async (path: string, method: string, data: unknown) => {
        assert.equal(path, "/api/conversations");
        assert.equal(method, "POST");
        created.push(data);
        return { id: "fresh-web", title: "Nova conversa", channel: "web" };
      },
      recordSelection: (id: string) => selected.push(id),
      conversationManagementUI: { showActiveView() {} },
      conversationEvents: { stop() {} },
      sessionStorage: { removeItem() {} },
      clearCommandPolls() {},
      historyNodes: { clear() {} },
      history: { replaceState() {} },
      sidebar() {},
      text() {},
      t: (value: string) => value,
    },
  ) as {
    workspace(): Promise<void>;
    afterDelete(id: string, wasActive: boolean): Promise<void>;
    current(): string | null;
  };
  return {
    controller,
    selected,
    created,
    get listReads() {
      return listReads;
    },
  };
}

const telegramFirst: SidebarConversation[] = [
  { id: "telegram-newest", title: "Telegram", channel: "telegram" },
  { id: "web-newest", title: "Web", channel: "web" },
  { id: "legacy-web", title: "Legacy web" },
];

test("workspace without a usable URL selects the newest web conversation after Telegram creation", async () => {
  for (const search of ["", "?c=deleted-id"]) {
    const f = selectionPolicyFixture(telegramFirst, search);
    await f.controller.workspace();
    assert.deepEqual(f.selected, ["web-newest"]);
    assert.equal(f.created.length, 0);
  }
});

test("workspace preserves an explicit valid web or Telegram history URL", async () => {
  for (const id of ["web-newest", "legacy-web", "telegram-newest"]) {
    const f = selectionPolicyFixture(telegramFirst, `?c=${id}`);
    await f.controller.workspace();
    assert.deepEqual(f.selected, [id]);
    assert.equal(f.created.length, 0);
  }
});

test("workspace with only Telegram histories creates a fresh web conversation by default", async () => {
  for (const search of ["", "?c=deleted-web"]) {
    const f = selectionPolicyFixture(telegramFirst.slice(0, 1), search);
    await f.controller.workspace();
    assert.deepEqual(f.selected, ["fresh-web"]);
    assert.equal(f.created.length, 1);
    assert.equal(
      JSON.stringify(f.created[0]),
      JSON.stringify({ title: "Nova conversa" }),
    );
  }
});

test("workspace still treats a legacy conversation without origin metadata as web", async () => {
  const f = selectionPolicyFixture([telegramFirst[0], telegramFirst[2]]);
  await f.controller.workspace();
  assert.deepEqual(f.selected, ["legacy-web"]);
  assert.equal(f.created.length, 0);
});

test("deleting the selected conversation falls back to web, preserving Telegram read-only histories", async () => {
  const f = selectionPolicyFixture(telegramFirst);
  await f.controller.afterDelete("deleted", true);
  assert.deepEqual(f.selected, ["web-newest"]);
  assert.equal(f.created.length, 0);
});

test("deleting the selected conversation creates fresh web when only Telegram histories survive", async () => {
  const f = selectionPolicyFixture(telegramFirst.slice(0, 1));
  await f.controller.afterDelete("deleted", true);
  assert.deepEqual(f.selected, ["fresh-web"]);
  assert.equal(f.created.length, 1);
});

test("deleting a different conversation refreshes the list without replacing selection", async () => {
  const f = selectionPolicyFixture(telegramFirst);
  await f.controller.afterDelete("other", false);
  assert.equal(f.controller.current(), "deleted");
  assert.deepEqual(f.selected, []);
  assert.equal(f.created.length, 0);
  assert.equal(f.listReads, 1);
});
