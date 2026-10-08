import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canDispatchCommandResult,
  createSlashAutocomplete,
  refreshConversationSnapshot,
  slashPrefix,
} from "../public/commands.js";

class Element {
  id = "";
  value = "";
  type = "";
  className = "";
  textContent = "";
  hidden = false;
  children: Element[] = [];
  attributes = new Map<string, string>();
  onclick?: () => void;
  focused = false;
  selectionStart = 0;
  selectionEnd = 0;

  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = [...items];
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  focus() {
    this.focused = true;
  }
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  dispatchEvent() {}
}

const catalog = [
  "agents",
  "model",
  "thinking",
  "compact",
  "tasks",
  "crons",
  "stop",
  "help",
].map((name) => ({
  name,
  usage: `/${name}`,
  description: `${name} command`,
}));

function setup() {
  const input = new Element();
  const list = new Element();
  list.id = "command-suggestions";
  const requests: string[] = [];
  const document = { createElement: () => new Element() };
  const controller = createSlashAutocomplete({
    input,
    list,
    document,
    api: async (path: string) => {
      requests.push(path);
      return { commands: catalog };
    },
  });
  function key(
    values: Partial<{
      key: string;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      isComposing: boolean;
      keyCode: number;
      repeat: boolean;
    }>,
  ) {
    let prevented = false;
    const event = {
      key: "Enter",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      isComposing: false,
      keyCode: 13,
      repeat: false,
      preventDefault() {
        prevented = true;
      },
      ...values,
    };
    const handled = controller.handleKeydown(event);
    return { handled, prevented };
  }
  return { input, list, requests, controller, key };
}

test("slash autocomplete lists commands, moves selection, and Enter inserts an argument space", async () => {
  const ui = setup();
  ui.input.value = "/";
  await ui.controller.update();
  assert.deepEqual(ui.requests, ["/api/commands"]);
  assert.equal(ui.list.children.length, 8);
  assert.equal(ui.input.attributes.get("aria-expanded"), "true");
  assert.equal(ui.list.children[0].attributes.get("aria-selected"), "true");

  const down = ui.key({ key: "ArrowDown" });
  assert.equal(down.handled, true);
  assert.equal(down.prevented, true);
  assert.equal(ui.list.children[1].attributes.get("aria-selected"), "true");
  const enter = ui.key({ key: "Enter" });
  assert.equal(enter.handled, true);
  assert.equal(ui.input.value, "/model ");
  assert.equal(ui.input.selectionStart, ui.input.value.length);
  assert.equal(ui.list.hidden, true);
});

test("Escape closes suggestions without changing the draft; slash escapes and whitespace hide the list", async () => {
  const ui = setup();
  ui.input.value = "/tasks";
  await ui.controller.update();
  assert.equal(ui.list.children.length, 1);
  const escape = ui.key({ key: "Escape" });
  assert.equal(escape.handled, true);
  assert.equal(ui.input.value, "/tasks");
  assert.equal(ui.list.hidden, true);

  ui.input.value = "//literal";
  await ui.controller.update();
  assert.equal(ui.list.hidden, true);
  assert.equal(slashPrefix("/tasks with args"), null);
  assert.equal(slashPrefix("//literal"), null);
  assert.equal(slashPrefix("/tasks"), "tasks");
});

test("IME confirmation and Ctrl+Enter keep their native composer behavior", async () => {
  const ui = setup();
  ui.input.value = "/";
  await ui.controller.update();
  const ime = ui.key({ key: "Enter", isComposing: true });
  assert.equal(ime.handled, false);
  const processing = ui.key({ key: "Enter", keyCode: 229 });
  assert.equal(processing.handled, false);
  const newline = ui.key({ key: "Enter", ctrlKey: true });
  assert.equal(newline.handled, false);
  assert.equal(ui.input.value, "/");
  assert.equal(ui.list.hidden, false);
});

test("shift and alt Enter and Shift+Tab stay native; repeat Enter cannot select or submit", async () => {
  const ui = setup();
  ui.input.value = "/";
  await ui.controller.update();

  for (const keys of [
    { key: "Enter", shiftKey: true },
    { key: "Enter", altKey: true },
    { key: "Tab", shiftKey: true },
  ]) {
    const result = ui.key(keys);
    assert.equal(result.handled, false);
    assert.equal(ui.input.value, "/");
    assert.equal(ui.controller.open, true);
  }

  const repeated = ui.key({ key: "Enter", repeat: true });
  assert.equal(repeated.handled, true);
  assert.equal(repeated.prevented, true);
  assert.equal(ui.input.value, "/");
  assert.equal(ui.controller.open, true);

  ui.key({ key: "Enter" });
  assert.equal(ui.input.value, "/agents ");
});

test("mobile tap selects a command and leaves the composer ready for arguments", async () => {
  const ui = setup();
  ui.input.value = "/h";
  await ui.controller.update();
  assert.equal(ui.list.children.length, 1);
  ui.list.children[0].onclick?.();
  assert.equal(ui.input.value, "/help ");
  assert.equal(ui.input.focused, true);
  assert.equal(ui.list.hidden, true);
});

test("only current results dispatch, except an explicit agent choice from a still-valid source", () => {
  assert.equal(canDispatchCommandResult("model", true, "old", "new"), false);
  assert.equal(canDispatchCommandResult("help", false, "old", "new"), false);
  assert.equal(
    canDispatchCommandResult("agents", false, "old", "new", true),
    false,
  );
  assert.equal(
    canDispatchCommandResult("agents", true, "old", "new", true),
    true,
  );
  assert.equal(
    canDispatchCommandResult("agents", true, "old", "new", false),
    false,
  );
});

test("conversation snapshot refresh skips stale results before and after its fetch", async () => {
  let current = "2";
  let apiCalls = 0;
  let renders = 0;
  const dependencies = {
    getConversationId: () => current,
    loadConversations: async () => {
      current = "3";
    },
    api: async () => {
      apiCalls++;
      return {};
    },
    render: () => renders++,
  };
  assert.equal(await refreshConversationSnapshot("2", dependencies), false);
  assert.equal(apiCalls, 0);
  assert.equal(renders, 0);

  current = "2";
  let finishFetch!: (value: { conversationId: string }) => void;
  const pendingSnapshot = new Promise<{ conversationId: string }>((resolve) => {
    finishFetch = resolve;
  });
  const refresh = refreshConversationSnapshot("2", {
    ...dependencies,
    loadConversations: async () => {},
    api: () => pendingSnapshot,
  });
  current = "3";
  finishFetch({ conversationId: "2" });
  assert.equal(await refresh, false);
  assert.equal(renders, 0);
});
