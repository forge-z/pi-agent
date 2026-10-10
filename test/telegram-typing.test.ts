import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import {
  TelegramConnection,
  TelegramApiError,
  type TelegramApi,
} from "../src/telegram-connection.js";
import {
  Telegram,
  TelegramHttp,
  type TelegramTransport,
} from "../src/telegram.js";

const update = (id: number, text = "mensagem", thread?: number) => ({
  update_id: id,
  message: {
    message_id: id,
    text,
    from: { id: 42 },
    chat: { id: 100, type: "private" },
    ...(thread ? { message_thread_id: thread } : {}),
  },
});
async function fixture(
  typing?: (
    chat: string,
    options?: { signal?: AbortSignal; messageThreadId?: number },
  ) => Promise<unknown>,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-typing-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 5 }, () => async () => {
      await gate;
      return fauxAssistantMessage("resposta");
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    gateway: { call: async () => ({}) },
  });
  const anchor = await app.create();
  app.store.consumeLink(app.store.link(anchor), "100", "42");
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    "telegram:connection",
    JSON.stringify({
      enabled: true,
      bot: { id: 123 },
      userId: "42",
      chatId: "100",
      conversationId: anchor,
    }),
  );
  app.store.run(
    "INSERT INTO credentials VALUES ('telegram:bot',?)",
    JSON.stringify({ token: "123:fake-local", botId: 123 }),
  );
  const calls: {
    chat: string;
    signal?: AbortSignal;
    messageThreadId?: number;
  }[] = [];
  const sent: string[] = [];
  const transport = {
    send: async (_chat: string, text: string) => {
      sent.push(text);
      return { ok: true };
    },
    typing:
      typing ??
      (async (
        chat: string,
        options?: { signal?: AbortSignal; messageThreadId?: number },
      ) => {
        calls.push({ chat, ...options });
        return true;
      }),
  } as TelegramTransport;
  const engine = new Telegram(
    app,
    transport,
    ["42"],
    ["100"],
    "test_pi_bot",
    true,
    123,
  );
  return {
    app,
    engine,
    calls,
    sent,
    release,
    async close() {
      release();
      await engine.drain();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Telegram starts typing before conversation creation and never waits for the typing HTTP response", async () => {
  let started = false;
  let typingSignal: AbortSignal | undefined;
  const f = await fixture(async (_chat, options) => {
    started = true;
    typingSignal = options?.signal;
    return new Promise(() => {});
  });
  const create = f.app.create.bind(f.app);
  f.app.create = async (...args) => {
    assert.equal(started, true);
    return create(...args);
  };
  try {
    const response = await f.engine.receive(update(1));
    assert.equal((response as { kind: string }).kind, "message");
    assert.equal(started, true);
    await f.engine.drain();
    assert.equal(typingSignal?.aborted, true);
  } finally {
    await f.close();
  }
});

test("typing renews under five seconds, deduplicates updates, and stops after the answer", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    const result = await f.engine.receive(update(2));
    await f.engine.receive(update(2));
    assert.equal(f.calls.length, 1);
    t.mock.timers.tick(4000);
    await turn();
    assert.equal(f.calls.length, 2);
    t.mock.timers.reset();
    f.release();
    await (
      await f.app.conversation(
        (result as { conversationId: string }).conversationId,
      )
    ).waitForIdle(context);
    await turn();
    await f.engine.flush();
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    t.mock.timers.tick(8000);
    await turn();
    assert.equal(f.calls.length, 2);
    assert.equal(f.sent.length, 1);
    await f.engine.receive(update(2));
    assert.equal(f.calls.length, 2);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

for (const change of [
  "abort",
  "revoke",
  "select",
  "handoff",
  "failure",
  "credential",
  "disconnect",
] as const) {
  test(`typing stops and aborts its in-flight request on ${change}`, async (t) => {
    let count = 0;
    let signal: AbortSignal | undefined;
    const f = await fixture(async (_chat, options) => {
      count++;
      signal = options?.signal;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
    try {
      const result = await f.engine.receive(update(3), controller.signal);
      const id = (result as { conversationId: string }).conversationId;
      assert.equal(count, 1);
      if (change === "abort") controller.abort();
      if (change === "revoke")
        f.app.store.run(
          "DELETE FROM telegram_grants WHERE conversationId=?",
          id,
        );
      if (change === "select")
        f.app.store.run(
          "UPDATE telegram_chat_selection SET conversationId=?",
          "other",
        );
      if (change === "handoff")
        f.app.assertHandoffAvailable = () => {
          throw new Error("human intervention");
        };
      if (change === "failure")
        f.app.store.run(
          "UPDATE requests SET status='failed' WHERE conversationId=?",
          id,
        );
      if (change === "credential")
        f.app.store.run(
          "UPDATE credentials SET value='{}' WHERE provider='telegram:bot'",
        );
      if (change === "disconnect")
        f.app.store.run(
          "UPDATE meta SET value='{}' WHERE key='telegram:connection'",
        );
      t.mock.timers.tick(8000);
      await turn();
      assert.equal(count, 1);
      assert.equal(signal?.aborted, true);
    } finally {
      t.mock.timers.reset();
      await f.close();
    }
  });
}

test("typing errors do not reject admission, and commands, ignored users and web inputs leave no heartbeat", async (t) => {
  let count = 0;
  const f = await fixture(async () => {
    count++;
    throw new Error("secret fake URL");
  });
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    await f.engine.receive(update(5, "/help"));
    assert.equal(count, 1);
    t.mock.timers.tick(8000);
    await turn();
    assert.equal(count, 1);
    const ignored = update(6);
    ignored.message.from.id = 77;
    assert.deepEqual(await f.engine.receive(ignored), { ignored: true });
    const id = await f.app.create("web");
    await f.app.admit(id, "web-typing", "web message", { source: "web" });
    assert.equal(count, 1);
    await f.engine.receive(update(7));
    assert.equal(count, 2);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test("concurrent Telegram updates share one heartbeat and aborting one leaves the other active", async (t) => {
  const f = await fixture();
  const first = new AbortController();
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    await Promise.all([
      f.engine.receive(update(8), first.signal),
      f.engine.receive(update(9)),
    ]);
    assert.equal(f.calls.length, 1);
    first.abort();
    t.mock.timers.tick(4000);
    await turn();
    assert.equal(f.calls.length, 2);
    await f.engine.drain();
    assert.equal(f.calls.at(-1)?.signal?.aborted, true);
    t.mock.timers.tick(8000);
    await turn();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(await f.engine.receive(update(10)), { ignored: true });
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test("HTTP typing uses native sendChatAction with topic, abort and sanitized errors", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; body: unknown; signal?: AbortSignal | null }[] =
    [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
    });
    return new Response(JSON.stringify({ ok: true, result: true }));
  };
  try {
    const http = new TelegramHttp("fake-local-credential") as TelegramTransport;
    assert.equal(typeof http.typing, "function");
    const controller = new AbortController();
    await http.typing!("100", {
      messageThreadId: 22,
      signal: controller.signal,
    });
    assert.equal(calls[0].url.endsWith("/sendChatAction"), true);
    assert.deepEqual(calls[0].body, {
      chat_id: "100",
      action: "typing",
      message_thread_id: 22,
    });
    controller.abort();
    assert.equal(calls[0].signal?.aborted, true);
    globalThis.fetch = async () => {
      throw new Error("fake-local-credential");
    };
    await assert.rejects(
      http.typing!("100"),
      (error: Error) => !error.message.includes("fake-local-credential"),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("revoked grants and handoff pauses never send an initial typing action", async () => {
  for (const change of ["revoke", "handoff"]) {
    const f = await fixture();
    try {
      if (change === "revoke") f.app.store.run("DELETE FROM telegram_grants");
      else
        f.app.assertHandoffAvailable = () => {
          throw new Error("pause");
        };
      await f.engine.receive(update(20)).catch(() => {});
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("forum topics receive independent native typing actions", async () => {
  const f = await fixture();
  try {
    await Promise.all([
      f.engine.receive(update(21, "first topic", 11)),
      f.engine.receive(update(22, "second topic", 22)),
    ]);
    assert.deepEqual(
      f.calls.map((call) => [call.chat, call.messageThreadId]),
      [
        ["100", 11],
        ["100", 22],
      ],
    );
  } finally {
    await f.close();
  }
});

test("admission failure releases typing without retrying the message", async (t) => {
  let count = 0;
  let signal: AbortSignal | undefined;
  const f = await fixture(async (_chat, options) => {
    count++;
    signal = options?.signal;
    return new Promise(() => {});
  });
  f.app.admit = async () => {
    throw new Error("mock admission failure");
  };
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    await assert.rejects(
      f.engine.receive(update(23)),
      /mock admission failure/,
    );
    assert.equal(signal?.aborted, true);
    t.mock.timers.tick(8000);
    await turn();
    assert.equal(count, 1);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    assert.equal(f.sent.length, 0);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test("managed polling uses native typing and aborts it before reconnect backoff", async () => {
  const f = await fixture();
  let polled = false;
  let failPoll: (() => void) | undefined;
  const typing: { payload: Record<string, unknown>; signal?: AbortSignal }[] =
    [];
  const api: TelegramApi = {
    async call(method, payload = {}, signal) {
      if (method === "getMe")
        return { id: 123, is_bot: true, username: "test_pi_bot" };
      if (method === "getWebhookInfo") return { url: "" };
      if (method === "sendChatAction") {
        typing.push({ payload, signal });
        return new Promise(() => {});
      }
      if (method === "sendMessage") return { message_id: 1 };
      if (method === "getMyCommands") return [];
      if (method === "setMyCommands") return true;
      if (method === "getUpdates") {
        if (!polled) {
          polled = true;
          return [update(24, "managed topic", 33)];
        }
        return new Promise((_resolve, reject) => {
          failPoll = () => reject(new TelegramApiError("rate_limit", 3600));
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      throw new Error("unexpected API method");
    },
  };
  const manager = new TelegramConnection(f.app, {
    apiFactory: () => api,
    retryBaseMs: 10000,
  });
  try {
    await manager.restore();
    for (let tries = 0; !failPoll && tries < 100; tries++) await turn();
    assert.ok(failPoll);
    assert.equal(typing.length, 1);
    assert.deepEqual(typing[0].payload, {
      chat_id: "100",
      action: "typing",
      message_thread_id: 33,
    });
    assert.equal(typing[0].signal?.aborted, false);
    failPoll();
    for (
      let tries = 0;
      manager.snapshot().state !== "retrying" && tries < 100;
      tries++
    )
      await turn();
    assert.equal(manager.snapshot().state, "retrying");
    assert.equal(typing[0].signal?.aborted, true);
    assert.equal(
      JSON.stringify(manager.snapshot()).includes("123:fake-local"),
      false,
    );
    await manager.close();
    assert.equal(typing.length, 1);
  } finally {
    await manager.close();
    await f.close();
  }
});

test("a cancelled old command cannot remove a newer message's typing heartbeat", async (t) => {
  const f = await fixture();
  const controller = new AbortController();
  let releaseCommand!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  const admit = f.app.admit.bind(f.app);
  f.app.admit = async (...args) => {
    if (args[2] === "/help") await gate;
    return admit(...args);
  };
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    const command = f.engine.receive(update(30, "/help"), controller.signal);
    await turn();
    controller.abort();
    await f.engine.receive(update(31));
    assert.equal(f.calls.length, 2);
    releaseCommand();
    await command;
    t.mock.timers.tick(4000);
    await turn();
    assert.equal(f.calls.length, 3);
  } finally {
    releaseCommand();
    t.mock.timers.reset();
    await f.close();
  }
});
