import assert from "node:assert/strict";
import { test } from "node:test";
import { attachCustomProviderConnectionsUI } from "../public/provider-connections.js";

type Handler = (event?: { preventDefault(): void }) => unknown;

class FakeElement {
  value = "";
  private ownText = "";
  disabled = false;
  hidden = false;
  required = false;
  checked = false;
  open = true;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  listeners = new Map<string, Handler[]>();
  onsubmit?: Handler;
  onclick?: Handler;
  onchange?: Handler;

  get textContent() {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }

  set textContent(value: string) {
    this.ownText = value;
  }

  addEventListener(name: string, handler: Handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  async emit(name: string, event = { preventDefault() {} }) {
    const propertyHandler =
      name === "submit"
        ? this.onsubmit
        : name === "click"
          ? this.onclick
          : name === "change"
            ? this.onchange
            : undefined;
    const handlers = [
      ...(propertyHandler ? [propertyHandler] : []),
      ...(this.listeners.get(name) || []),
    ];
    for (const handler of handlers) await handler(event);
  }

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = [...children];
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

class FakeDocument {
  elements = new Map<string, FakeElement>();
  getElementById(id: string) {
    let element = this.elements.get(id);
    if (!element) {
      element = new FakeElement();
      this.elements.set(id, element);
    }
    return element;
  }

  createElement() {
    return new FakeElement();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createUI(
  api: (
    path: string,
    method?: string,
    data?: Record<string, unknown>,
  ) => Promise<unknown>,
) {
  const document = new FakeDocument();
  Object.assign(globalThis, { document });
  const refreshed: boolean[] = [];
  const busy: boolean[] = [];
  const ui = attachCustomProviderConnectionsUI(api, {
    refresh: async () => {
      refreshed.push(true);
    },
    setBusy: (value: boolean) => busy.push(value),
  });
  ui.update({ mode: "live", customConnections: [] });
  return {
    ui,
    document,
    refreshed,
    busy,
    $: (id: string) => document.getElementById(id),
  };
}

function fillDraft(
  $: (id: string) => FakeElement,
  overrides: Record<string, string | boolean> = {},
) {
  $("custom-provider-protocol").value = "openai-compatible";
  $("custom-provider-endpoint").value = "https://api.example.test/v1";
  $("custom-provider-model").value = "model-manual";
  $("custom-provider-api-key").value = "secret-key-value";
  for (const [id, value] of Object.entries(overrides)) {
    const element = $(id);
    if (typeof value === "boolean") element.checked = value;
    else element.value = value;
  }
}

test("save sends the draft once, clears the secret before awaiting, and refreshes settings", async () => {
  const save = deferred<{ connection: Record<string, unknown> }>();
  const calls: Array<{
    path: string;
    method: string;
    data?: Record<string, unknown>;
  }> = [];
  const { $, refreshed, busy } = createUI((path, method = "GET", data) => {
    calls.push({ path, method, data });
    return save.promise;
  });
  fillDraft($);

  const pending = $("custom-provider-form").emit("submit");

  assert.equal($("custom-provider-api-key").value, "");
  assert.deepEqual(calls[0], {
    path: "/api/provider/connections",
    method: "POST",
    data: {
      protocol: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      modelId: "model-manual",
      apiKey: "secret-key-value",
      allowLocal: false,
    },
  });
  save.resolve({
    connection: {
      id: "custom-1",
      name: "Example",
      protocol: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      modelId: "model-manual",
      allowLocal: false,
      hasApiKey: true,
      credentialType: "api_key",
    },
  });
  await pending;

  assert.deepEqual(refreshed, [true]);
  assert.deepEqual(busy, [true, false]);
  assert.equal(
    $("custom-provider-status").textContent,
    "Conexão salva. Escolha-a nas configurações de modelo.",
  );
});

test("model discovery keeps manual input and ignores a response after endpoint changes", async () => {
  const models = deferred<{ models: Array<{ id: string; name: string }> }>();
  const calls: Array<{
    path: string;
    method: string;
    data?: Record<string, unknown>;
  }> = [];
  const { $, ui } = createUI((path, method = "GET", data) => {
    calls.push({ path, method, data });
    return models.promise;
  });
  fillDraft($);

  const pending = $("custom-provider-fetch-models").emit("click");
  assert.equal(calls[0].path, "/api/provider/connections/models");
  assert.deepEqual(calls[0].data, {
    protocol: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    apiKey: "secret-key-value",
    allowLocal: false,
  });
  $("custom-provider-endpoint").value = "https://other.example.test/v1";
  await $("custom-provider-endpoint").emit("input");
  assert.equal($("custom-provider-api-key").value, "");
  models.resolve({ models: [{ id: "stale-model", name: "Stale model" }] });
  await pending;

  assert.equal($("custom-provider-model").value, "model-manual");
  assert.deepEqual($("custom-provider-models").children, []);
  ui.reset();
});

test("model discovery ignores results after the key or local permission changes", async () => {
  const first = deferred<{ models: Array<{ id: string; name: string }> }>();
  const second = deferred<{ models: Array<{ id: string; name: string }> }>();
  let request = 0;
  const { $, ui } = createUI(() =>
    request++ === 0 ? first.promise : second.promise,
  );
  fillDraft($);

  const firstPending = $("custom-provider-fetch-models").emit("click");
  $("custom-provider-api-key").value = "rotated-key";
  await $("custom-provider-api-key").emit("input");
  first.resolve({ models: [{ id: "old-key-model", name: "Old key model" }] });
  await firstPending;
  assert.deepEqual($("custom-provider-models").children, []);

  const secondPending = $("custom-provider-fetch-models").emit("click");
  $("custom-provider-allow-local").checked = true;
  await $("custom-provider-allow-local").emit("change");
  second.resolve({
    models: [{ id: "old-policy-model", name: "Old policy model" }],
  });
  await secondPending;

  assert.deepEqual($("custom-provider-models").children, []);
  assert.equal($("custom-provider-model").value, "model-manual");
  ui.reset();
});

test("protocol changes clear the draft secret and stale model suggestions", async () => {
  const { $, ui } = createUI(async () => ({
    models: [{ id: "m", name: "Model" }],
  }));
  fillDraft($);
  const list = $("custom-provider-models");
  list.append(Object.assign(new FakeElement(), { value: "existing" }));

  $("custom-provider-protocol").value = "anthropic";
  await $("custom-provider-protocol").emit("change");

  assert.equal($("custom-provider-api-key").value, "");
  assert.deepEqual(list.children, []);
  ui.reset();
});

test("reset invalidates a pending catalog response and clears transient secrets", async () => {
  const models = deferred<{ models: Array<{ id: string; name: string }> }>();
  const { $, ui, busy } = createUI(() => models.promise);
  fillDraft($);
  const pending = $("custom-provider-fetch-models").emit("click");

  ui.reset();
  assert.deepEqual(busy, [true]);
  models.resolve({ models: [{ id: "late-model", name: "Late model" }] });
  await pending;

  assert.equal($("custom-provider-api-key").value, "");
  assert.deepEqual($("custom-provider-models").children, []);
  assert.equal($("custom-provider-status").textContent, "");
  assert.deepEqual(busy, [true, false]);
});

test("closing Settings clears the key and invalidates pending model discovery", async () => {
  const models = deferred<{ models: Array<{ id: string; name: string }> }>();
  const { $, ui, busy } = createUI(() => models.promise);
  fillDraft($);
  const pending = $("custom-provider-fetch-models").emit("click");
  assert.deepEqual(busy, [true]);

  await $("settings-dialog").emit("close");
  assert.deepEqual(busy, [true]);
  assert.equal($("custom-provider-fields").disabled, true);
  models.resolve({ models: [{ id: "late-model", name: "Late model" }] });
  await pending;

  assert.equal($("custom-provider-api-key").value, "");
  assert.deepEqual($("custom-provider-models").children, []);
  assert.equal($("custom-provider-status").textContent, "");
  assert.deepEqual(busy, [true, false]);
  ui.reset();
});

test("public endpoints require a key while an explicitly allowed local endpoint may omit it", async () => {
  const calls: string[] = [];
  const { $, ui } = createUI(async (path) => {
    calls.push(path);
    return { connection: { id: "local-1" } };
  });
  fillDraft($, { "custom-provider-api-key": "" });

  await $("custom-provider-form").emit("submit");

  assert.deepEqual(calls, []);
  assert.match($("custom-provider-status").textContent, /chave API/i);
  $("custom-provider-protocol").value = "anthropic";
  $("custom-provider-endpoint").value = "http://192.168.1.20:8000/v1";
  $("custom-provider-allow-local").checked = true;
  await $("custom-provider-allow-local").emit("change");
  await $("custom-provider-form").emit("submit");

  assert.deepEqual(calls, ["/api/provider/connections"]);
  ui.reset();
});

test("stored metadata is rendered as plain text and demo mode disables the form", () => {
  const { $, ui } = createUI(async () => ({}));
  ui.update({
    mode: "demo",
    customConnections: [
      {
        id: "custom-xss",
        name: "<img src=x onerror=alert(1)>",
        protocol: "anthropic",
        endpoint: "https://api.example.test",
        modelId: "claude-custom",
        allowLocal: false,
        hasApiKey: true,
        credentialType: "api_key",
      },
    ],
  });

  assert.equal($("custom-provider-fields").disabled, true);
  assert.equal(
    $("custom-provider-list").children[0].children[0].children[0].textContent,
    "<img src=x onerror=alert(1)>",
  );
  assert.equal(
    Object.hasOwn($("custom-provider-list").children[0], "innerHTML"),
    false,
  );
});

test("a failed optional catalog request leaves the manually entered model and draft usable", async () => {
  const { $, ui } = createUI(async () => {
    throw new Error("provider response contained secret-key-value");
  });
  fillDraft($);

  await $("custom-provider-fetch-models").emit("click");

  assert.equal($("custom-provider-model").value, "model-manual");
  assert.equal($("custom-provider-api-key").value, "secret-key-value");
  assert.doesNotMatch(
    $("custom-provider-status").textContent,
    /secret-key-value|provider response/i,
  );
  ui.reset();
});
