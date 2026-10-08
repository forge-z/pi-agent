import assert from "node:assert/strict";
import { test } from "node:test";
import { attachTelegramUI } from "../public/telegram.js";

type Snapshot = {
  state: string;
  configured: boolean;
  hasToken: boolean;
  userId: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  bot: { id: number; username?: string; firstName?: string } | null;
  lastSuccessAt: number | null;
  error: string | null;
  webhookUrl: string | null;
  webhookVersion: string | null;
  awaitingFirstMessage: boolean;
};

type ApiCall = {
  path: string;
  method: string;
  data?: Record<string, unknown>;
};

type Handler = (event: unknown) => unknown;

class FakeElement {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  required = false;
  pattern = "";
  href = "";
  open = false;
  focused = false;
  validityMessage = "";
  reported = false;
  dataset: Record<string, string> = {};
  listeners = new Map<string, Handler[]>();
  fields: FakeElement[] = [];

  addEventListener(name: string, handler: Handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  async emit(name: string, event: unknown = { preventDefault() {} }) {
    for (const handler of this.listeners.get(name) || []) await handler(event);
  }

  showModal() {
    this.open = true;
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    await this.emit("close");
  }

  focus() {
    this.focused = true;
  }

  checkValidity() {
    if (this.validityMessage) return false;
    if (this.required && !this.value) return false;
    if (
      this.pattern &&
      this.value &&
      !new RegExp(`^(?:${this.pattern})$`).test(this.value)
    )
      return false;
    return true;
  }

  reportValidity() {
    this.reported = true;
    return this.checkValidity();
  }

  setCustomValidity(message: string) {
    this.validityMessage = message;
  }

  removeAttribute(name: string) {
    if (name === "href") this.href = "";
  }
}

class FakeForm extends FakeElement {
  checkValidity() {
    return this.fields.every((field) => field.checkValidity());
  }

  reportValidity() {
    this.reported = true;
    return this.checkValidity();
  }
}

class FakeDialog extends FakeElement {}

type FakeTimer = {
  callback: () => void;
  delay: number;
  cleared: boolean;
  ref: ReturnType<typeof setInterval>;
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    state: "unconfigured",
    configured: false,
    hasToken: false,
    userId: null,
    conversationId: null,
    conversationTitle: null,
    bot: null,
    lastSuccessAt: null,
    error: null,
    webhookUrl: null,
    webhookVersion: null,
    awaitingFirstMessage: false,
    ...overrides,
  };
}

function fixture(
  makeApi: (
    elements: Map<string, FakeElement>,
    calls: ApiCall[],
    statusReads: Snapshot[],
  ) => (
    path: string,
    method?: string,
    data?: Record<string, unknown>,
  ) => Promise<Snapshot>,
) {
  const ids = [
    "telegram-dialog",
    "telegram-form",
    "telegram-token",
    "telegram-user-id",
    "telegram-connect",
    "telegram-disconnect",
    "telegram-retry-actions",
    "telegram-conflict",
    "telegram-replace-webhook",
    "telegram-retry",
    "telegram-refresh",
    "telegram-form-error",
    "telegram-status-message",
    "telegram-first-message",
    "telegram-state",
    "telegram-bot",
    "telegram-last-success",
    "telegram-open-bot",
    "telegram-linked",
    "telegram-linked-title",
    "telegram-linked-id",
    "telegram-target-title",
    "telegram-target-id",
    "telegram-conflict-bot",
    "telegram-webhook-url",
    "telegram-button",
    "telegram-cancel-conflict",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  elements.set("telegram-dialog", new FakeDialog());
  elements.set("telegram-form", new FakeForm());
  const form = elements.get("telegram-form") as FakeForm;
  form.fields = [
    elements.get("telegram-token")!,
    elements.get("telegram-user-id")!,
  ];
  elements.get("telegram-user-id")!.pattern = "[0-9]+";

  const calls: ApiCall[] = [];
  const statusReads: Snapshot[] = [];
  const previousDocument = Reflect.get(globalThis, "document") as
    Document | undefined;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const timers: FakeTimer[] = [];
  globalThis.document = {
    getElementById: (id: string) => elements.get(id) || null,
  } as unknown as Document;
  globalThis.setInterval = ((callback: () => void, delay = 0) => {
    const timer = {
      callback,
      delay,
      cleared: false,
      ref: undefined as unknown as ReturnType<typeof setInterval>,
    };
    timer.ref = timer as unknown as ReturnType<typeof setInterval>;
    timers.push(timer);
    return timer.ref;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((ref: ReturnType<typeof setInterval>) => {
    const timer = timers.find((entry) => entry.ref === ref);
    if (timer) timer.cleared = true;
  }) as typeof globalThis.clearInterval;

  attachTelegramUI(makeApi(elements, calls, statusReads), {
    getConversationId: () => "active-conversation",
    getConversationTitle: () => "Conversa ativa",
  });

  return {
    elements,
    calls,
    statusReads,
    timers,
    element(id: string) {
      return elements.get(id)!;
    },
    async open() {
      await elements.get("telegram-button")!.emit("click");
    },
    async submit() {
      await form.emit("submit");
    },
    async close() {
      await elements.get("telegram-dialog")!.close();
    },
    restore() {
      if (previousDocument)
        Reflect.set(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
      globalThis.setInterval = previousSetInterval;
      globalThis.clearInterval = previousClearInterval;
    },
  };
}

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("token is never returned by status, and successful connection clears the field", async () => {
  let currentStatus = snapshot();
  const ui = fixture(
    (_elements, calls, statusReads) =>
      async (path, method = "GET", data) => {
        if (path === "/api/telegram") {
          statusReads.push(structuredClone(currentStatus));
          return structuredClone(currentStatus);
        }
        calls.push({ path, method, data: structuredClone(data) });
        currentStatus = snapshot({
          state: "connected",
          configured: true,
          hasToken: true,
          userId: String(data?.userId),
          conversationId: String(data?.conversationId),
          conversationTitle: "Conversa ativa",
          bot: { id: 901, username: "sample_agent_bot" },
        });
        return structuredClone(currentStatus);
      },
  );

  try {
    await ui.open();
    await waitFor(
      () => ui.element("telegram-state").textContent === "Não configurado",
      "initial status did not load",
    );
    ui.element("telegram-token").value = "123456:token-secret-sentinel";
    ui.element("telegram-user-id").value = "42";
    await ui.submit();
    await waitFor(
      () => ui.element("telegram-state").textContent === "Conectado",
      "connected state did not render",
    );

    const connect = ui.calls.find(
      (call) => call.path === "/api/telegram/connect",
    );
    assert.ok(connect);
    assert.equal(connect.data?.token, "123456:token-secret-sentinel");
    assert.equal(connect.data?.userId, "42");
    assert.equal(connect.data?.conversationId, "active-conversation");
    assert.equal(connect.data?.replaceWebhook, undefined);
    assert.match(String(connect.data?.requestId), /^[0-9a-f-]{36}$/i);
    assert.equal(ui.element("telegram-token").value, "");
    assert.ok(ui.statusReads.every((status) => !("token" in status)));
    assert.doesNotMatch(
      JSON.stringify(ui.statusReads),
      /token-secret-sentinel/,
    );
  } finally {
    await ui.close();
    ui.restore();
  }
});

test("saved token stays blank, user edits survive polling, and active conversation is the target", async () => {
  const currentStatus = snapshot({
    state: "connected",
    configured: true,
    hasToken: true,
    userId: "42",
    conversationId: "old-conversation",
    conversationTitle: "Conversa anterior",
    bot: { id: 902, username: "sample_agent_bot" },
  });
  const ui = fixture(
    (_elements, calls, statusReads) =>
      async (path, method = "GET", data) => {
        if (path === "/api/telegram") {
          statusReads.push(structuredClone(currentStatus));
          return structuredClone(currentStatus);
        }
        calls.push({ path, method, data: structuredClone(data) });
        return snapshot({ ...currentStatus, userId: String(data?.userId) });
      },
  );

  try {
    await ui.open();
    await waitFor(
      () => ui.element("telegram-user-id").value === "42",
      "saved user ID did not load",
    );
    assert.equal(ui.element("telegram-token").value, "");
    assert.equal(ui.element("telegram-token").required, false);
    assert.equal(
      ui.element("telegram-target-title").textContent,
      "Conversa ativa",
    );
    assert.equal(
      ui.element("telegram-target-id").textContent,
      "ID active-conversation",
    );
    assert.equal(
      ui.element("telegram-linked-title").textContent,
      "Conversa anterior",
    );

    ui.element("telegram-user-id").value = "77";
    const timer = ui.timers.find((entry) => entry.delay === 3000);
    assert.ok(timer);
    timer.callback();
    await waitFor(() => ui.statusReads.length === 2, "status did not poll");
    assert.equal(ui.element("telegram-user-id").value, "77");
    await ui.submit();

    const connect = ui.calls.find(
      (call) => call.path === "/api/telegram/connect",
    );
    assert.ok(connect);
    assert.equal(connect.data?.token, undefined);
    assert.equal(connect.data?.userId, "77");
    assert.equal(connect.data?.conversationId, "active-conversation");
    assert.equal(
      ui.element("telegram-open-bot").href,
      "https://t.me/sample_agent_bot",
    );
  } finally {
    await ui.close();
    ui.restore();
  }
});

test("webhook conflict requires a fresh explicit switch with the snapshot version", async () => {
  let currentStatus = snapshot();
  let switchAttempt = 0;
  const ui = fixture(
    (_elements, calls, statusReads) =>
      async (path, method = "GET", data) => {
        if (path === "/api/telegram") {
          statusReads.push(structuredClone(currentStatus));
          return structuredClone(currentStatus);
        }
        calls.push({ path, method, data: structuredClone(data) });
        if (data?.replaceWebhook === true) {
          switchAttempt += 1;
          if (switchAttempt === 1) {
            currentStatus = snapshot({
              state: "webhook_conflict",
              configured: true,
              hasToken: false,
              userId: String(data.userId),
              conversationId: String(data.conversationId),
              conversationTitle: "Conversa ativa",
              bot: { id: 903, username: "sample_agent_bot" },
              webhookUrl: "https://new-hooks.example.test",
              webhookVersion: "new-webhook-version",
              error: "A versão do webhook mudou; a conexão foi preservada.",
            });
            return structuredClone(currentStatus);
          }
          currentStatus = snapshot({
            state: "connected",
            configured: true,
            hasToken: true,
            userId: String(data.userId),
            conversationId: String(data.conversationId),
            conversationTitle: "Conversa ativa",
            bot: { id: 903, username: "sample_agent_bot" },
          });
          return structuredClone(currentStatus);
        }
        currentStatus = snapshot({
          state: "webhook_conflict",
          configured: true,
          hasToken: true,
          userId: String(data?.userId),
          conversationId: String(data?.conversationId),
          conversationTitle: "Conversa ativa",
          bot: { id: 903, username: "sample_agent_bot" },
          webhookUrl: "https://hooks.example.test",
          webhookVersion: "opaque-webhook-version",
          error: "Bot identificado; o webhook atual impede polling.",
        });
        return structuredClone(currentStatus);
      },
  );

  try {
    await ui.open();
    await waitFor(
      () => ui.element("telegram-state").textContent === "Não configurado",
      "initial status did not load",
    );
    ui.element("telegram-token").value = "123456:conflict-secret";
    ui.element("telegram-user-id").value = "42";
    await ui.submit();
    await waitFor(
      () => ui.element("telegram-conflict").hidden === false,
      "webhook conflict panel did not render",
    );
    const first = ui.calls.find(
      (call) => call.path === "/api/telegram/connect",
    );
    assert.ok(first);
    assert.equal(first.data?.replaceWebhook, undefined);
    assert.equal(
      ui.element("telegram-webhook-url").textContent,
      "https://hooks.example.test",
    );
    assert.equal(
      ui.element("telegram-status-message").textContent,
      "Bot identificado; o webhook atual impede polling.",
    );
    assert.equal(ui.element("telegram-token").value, "123456:conflict-secret");

    ui.element("telegram-user-id").value = "43";
    await ui.element("telegram-replace-webhook").emit("click");
    await waitFor(
      () =>
        ui.element("telegram-state").textContent === "Webhook existente" &&
        ui.element("telegram-webhook-url").textContent ===
          "https://new-hooks.example.test",
      "updated webhook conflict did not render",
    );
    const firstSwitch = ui.calls.filter(
      (call) => call.path === "/api/telegram/connect",
    )[1];
    assert.ok(firstSwitch);
    assert.notEqual(firstSwitch.data?.requestId, first.data?.requestId);
    assert.equal(firstSwitch.data?.replaceWebhook, true);
    assert.equal(firstSwitch.data?.expectedWebhook, "opaque-webhook-version");
    assert.equal(firstSwitch.data?.expectedBotId, 903);
    assert.equal(firstSwitch.data?.webhookUrl, undefined);
    assert.equal(firstSwitch.data?.userId, "43");
    assert.equal(firstSwitch.data?.conversationId, "active-conversation");
    assert.equal(firstSwitch.data?.token, "123456:conflict-secret");
    assert.equal(ui.element("telegram-token").value, "123456:conflict-secret");
    assert.equal(
      ui.element("telegram-status-message").textContent,
      "A versão do webhook mudou; a conexão foi preservada.",
    );

    await ui.element("telegram-replace-webhook").emit("click");
    await waitFor(
      () => ui.element("telegram-state").textContent === "Conectado",
      "polling connection state did not render",
    );
    const secondSwitch = ui.calls.filter(
      (call) => call.path === "/api/telegram/connect",
    )[2];
    assert.ok(secondSwitch);
    assert.notEqual(secondSwitch.data?.requestId, firstSwitch.data?.requestId);
    assert.equal(secondSwitch.data?.expectedWebhook, "new-webhook-version");
    assert.equal(secondSwitch.data?.token, "123456:conflict-secret");
    assert.equal(ui.element("telegram-token").value, "");
  } finally {
    await ui.close();
    ui.restore();
  }
});

test("candidate conversation stays unlinked until configured", async () => {
  const candidate = snapshot({
    state: "webhook_conflict",
    configured: false,
    hasToken: false,
    userId: "42",
    conversationId: "candidate-conversation",
    conversationTitle: "Candidata",
    bot: { id: 905, username: "sample_agent_bot" },
    webhookUrl: "https://hooks.example.test",
    webhookVersion: "candidate-webhook-version",
  });
  const ui = fixture(() => async () => candidate);

  try {
    await ui.open();
    await waitFor(
      () => ui.element("telegram-state").textContent === "Webhook existente",
      "webhook conflict did not load",
    );
    assert.equal(ui.element("telegram-linked").hidden, true);
    assert.equal(
      ui.element("telegram-target-id").textContent,
      "ID active-conversation",
    );
  } finally {
    await ui.close();
    ui.restore();
  }
});

test("first-message guidance stays visible through connect and status polling", async () => {
  let currentStatus = snapshot();
  const ui = fixture(
    (_elements, calls, statusReads) =>
      async (path, method = "GET", data) => {
        if (path === "/api/telegram") {
          statusReads.push(structuredClone(currentStatus));
          return structuredClone(currentStatus);
        }
        calls.push({ path, method, data: structuredClone(data) });
        currentStatus = snapshot({
          state: "connected",
          configured: true,
          hasToken: true,
          userId: String(data?.userId),
          conversationId: String(data?.conversationId),
          conversationTitle: "Conversa ativa",
          bot: { id: 906, username: "sample_agent_bot" },
          awaitingFirstMessage: true,
        });
        return structuredClone(currentStatus);
      },
  );

  try {
    await ui.open();
    await waitFor(
      () => ui.element("telegram-state").textContent === "Não configurado",
      "initial status did not load",
    );
    ui.element("telegram-token").value = "123456:first-message-secret";
    ui.element("telegram-user-id").value = "42";
    await ui.submit();
    await waitFor(
      () => ui.element("telegram-first-message").hidden === false,
      "first-message guidance did not render after connect",
    );
    const guidance =
      "Abra o bot e envie uma mensagem privada do ID autorizado para vincular esta conversa.";
    assert.equal(ui.element("telegram-first-message").textContent, guidance);
    assert.equal(ui.element("telegram-token").value, "");

    const timer = ui.timers.find((entry) => entry.delay === 3000);
    assert.ok(timer);
    timer.callback();
    await waitFor(() => ui.statusReads.length === 2, "status did not poll");
    assert.equal(ui.element("telegram-first-message").hidden, false);
    assert.equal(ui.element("telegram-first-message").textContent, guidance);

    currentStatus = snapshot({
      ...currentStatus,
      awaitingFirstMessage: false,
    });
    timer.callback();
    await waitFor(
      () => ui.statusReads.length === 3,
      "updated status did not poll",
    );
    assert.equal(ui.element("telegram-first-message").hidden, true);
    assert.equal(ui.element("telegram-first-message").textContent, "");
  } finally {
    await ui.close();
    ui.restore();
  }
});

test("unknown connect outcome retries the identical request ID and payload", async () => {
  let attempt = 0;
  const ui = fixture(
    (_elements, calls, statusReads) =>
      async (path, method = "GET", data) => {
        if (path === "/api/telegram") {
          statusReads.push(snapshot());
          return snapshot();
        }
        calls.push({ path, method, data: structuredClone(data) });
        attempt += 1;
        if (attempt === 1) throw new Error("network unavailable");
        return snapshot({
          state: "connected",
          configured: true,
          hasToken: true,
          userId: String(data?.userId),
          conversationId: String(data?.conversationId),
          bot: { id: 904, username: "sample_agent_bot" },
        });
      },
  );

  try {
    await ui.open();
    await waitFor(
      () => ui.element("telegram-state").textContent === "Não configurado",
      "initial status did not load",
    );
    ui.element("telegram-token").value = "123456:retry-secret";
    ui.element("telegram-user-id").value = "42";
    await ui.submit();
    await waitFor(
      () => ui.element("telegram-retry-actions").hidden === false,
      "retry action did not appear",
    );
    const original = ui.calls[0]?.data;
    assert.ok(original);
    assert.equal(ui.element("telegram-token").disabled, true);
    await ui.element("telegram-retry").emit("click");
    await waitFor(
      () => ui.element("telegram-state").textContent === "Conectado",
      "retry did not complete",
    );
    const retry = ui.calls[1]?.data;
    assert.deepEqual(retry, original);
    assert.equal(ui.element("telegram-token").value, "");
  } finally {
    await ui.close();
    ui.restore();
  }
});

test("polling stops on close or unauthenticated status, and closing clears token", async () => {
  let unauthorized = false;
  const ui = fixture((elements, _calls, statusReads) => async () => {
    if (unauthorized) {
      await elements.get("telegram-dialog")!.close();
      const error = new Error("unauthorized") as Error & { status: number };
      error.status = 401;
      throw error;
    }
    const value = snapshot({ state: "disconnected" });
    statusReads.push(value);
    return value;
  });

  try {
    await ui.open();
    await waitFor(
      () => ui.element("telegram-state").textContent === "Desconectado",
      "initial status did not load",
    );
    const timer = ui.timers.find((entry) => entry.delay === 3000);
    assert.ok(timer);
    assert.equal(timer.cleared, false);
    ui.element("telegram-token").value = "123456:close-secret";
    await ui.close();
    assert.equal(ui.element("telegram-token").value, "");
    assert.equal(timer.cleared, true);
    const readCount = ui.statusReads.length;
    timer.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ui.statusReads.length, readCount);

    await ui.open();
    await waitFor(
      () => ui.element("telegram-state").textContent === "Desconectado",
      "second status did not load",
    );
    unauthorized = true;
    const secondTimer = ui.timers
      .filter((entry) => entry.delay === 3000)
      .at(-1);
    assert.ok(secondTimer);
    secondTimer.callback();
    await waitFor(
      () => ui.element("telegram-dialog").open === false,
      "unauthenticated polling did not close the dialog",
    );
    assert.equal(ui.element("telegram-token").value, "");
    assert.equal(secondTimer.cleared, true);
  } finally {
    await ui.close();
    ui.restore();
  }
});

test("a delayed status from a closed dialog cannot overwrite a newer session", async () => {
  const pending: Array<(value: Snapshot) => void> = [];
  let reads = 0;
  const ui = fixture(() => async (path) => {
    assert.equal(path, "/api/telegram");
    reads += 1;
    return await new Promise<Snapshot>((resolve) => pending.push(resolve));
  });

  try {
    await ui.open();
    await waitFor(() => reads === 1, "first status request did not start");
    await ui.close();
    await ui.open();
    await waitFor(() => reads === 2, "second status request did not start");
    pending[1]!(snapshot({ state: "disconnected", error: "new session" }));
    await waitFor(
      () => ui.element("telegram-state").textContent === "Desconectado",
      "newer status did not render",
    );
    pending[0]!(snapshot({ state: "connected", error: "stale session" }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ui.element("telegram-state").textContent, "Desconectado");
    assert.equal(
      ui.element("telegram-status-message").textContent,
      "new session",
    );
  } finally {
    await ui.close();
    ui.restore();
  }
});
