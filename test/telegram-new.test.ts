import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime, ConversationBusyError } from "../src/runtime.js";
import { Telegram } from "../src/telegram.js";
import { telegramCommandCatalog } from "../src/telegram-commands.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

const update = (id: number, text: string, user = 42, chat = 100) => ({
  update_id: id,
  message: {
    message_id: id,
    text,
    from: { id: user },
    chat: { id: chat, type: "private" },
  },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-new-"));
  const options = { dir, gateway: { call: async () => ({ content: [] }) } };
  let app = await Runtime.open(options);
  const anchor = await app.create("Web original");
  app.store.consumeLink(app.store.link(anchor), "100", "42");
  app.store.run(
    "INSERT INTO meta VALUES ('telegram:connection',?)",
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
    JSON.stringify({ token: "123:fake-local-only", botId: 123 }),
  );
  const sent: string[] = [];
  const engine = () =>
    new Telegram(
      app,
      {
        send: async (_chat, text) => {
          sent.push(text);
          return { ok: true };
        },
      },
      ["42"],
      ["100"],
      "test_pi_bot",
      true,
      123,
    );
  return {
    get app() {
      return app;
    },
    anchor,
    engine,
    sent,
    async restart() {
      await app.close();
      app = await Runtime.open(options);
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const idOf = (value: unknown) =>
  (value as { conversationId: string }).conversationId;

async function holdSettings(app: Runtime, id: string) {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = app.withConversationSettings(id, async () => {
    entered();
    await gate;
  });
  await ready;
  return async () => {
    release();
    await work;
  };
}

test("a temporarily busy binding preserves message, new and start updates for retry", async (t) => {
  for (const text of [
    "Mensagem durante ajustes",
    "/new Após ajustes",
    "/start",
  ]) {
    await t.test(text, async () => {
      const f = await fixture();
      let unlock: (() => Promise<void>) | undefined;
      try {
        const engine = f.engine();
        unlock = await holdSettings(f.app, f.anchor);
        await assert.rejects(
          engine.receive(update(100, text)),
          ConversationBusyError,
        );
        assert.equal(
          f.app.store.get("SELECT 1 FROM meta WHERE key='telegram:update:100'"),
          undefined,
        );
        assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
        assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
        await unlock();
        unlock = undefined;
        const result = await engine.receive(update(100, text));
        assert.equal("control" in (result as object), false);
        if (text !== "/start") assert.ok(idOf(result));
        assert.deepEqual(await engine.receive(update(100, text)), result);
      } finally {
        await unlock?.();
        await f.close();
      }
    });
  }
});

test("a temporarily busy selected Telegram conversation does not produce deletion guidance", async () => {
  const f = await fixture();
  let unlock: (() => Promise<void>) | undefined;
  try {
    const engine = f.engine();
    const selected = idOf(
      await engine.receive(update(110, "/new Selecionada")),
    );
    unlock = await holdSettings(f.app, selected);
    await assert.rejects(
      engine.receive(update(111, "Preserve esta mensagem")),
      ConversationBusyError,
    );
    assert.equal(
      f.app.store.get("SELECT 1 FROM meta WHERE key='telegram:update:111'"),
      undefined,
    );
    await unlock();
    unlock = undefined;
    assert.equal(
      idOf(await engine.receive(update(111, "Preserve esta mensagem"))),
      selected,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:111'")
        .length,
      1,
    );
  } finally {
    await unlock?.();
    await f.close();
  }
});

test("busy bindings keep outbox pending until retry while real revocation still cancels", async () => {
  const f = await fixture();
  let unlock: (() => Promise<void>) | undefined;
  try {
    const engine = f.engine();
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text) VALUES ('busy-outbox','100','local pending reply')",
    );
    unlock = await holdSettings(f.app, f.anchor);
    await engine.flush();
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='busy-outbox'",
      )?.state,
      "pending",
    );
    assert.equal(f.sent.length, 0);
    await unlock();
    unlock = undefined;
    await engine.flush();
    await engine.flush();
    assert.deepEqual(f.sent, ["local pending reply"]);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='busy-outbox'",
      )?.state,
      "sent",
    );
    await f.app.deleteConversation(f.anchor);
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text) VALUES ('revoked-outbox','100','must never send')",
    );
    await engine.flush();
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='revoked-outbox'",
      )?.state,
      "cancelled",
    );
    assert.equal(f.sent.length, 1);
  } finally {
    await unlock?.();
    await f.close();
  }
});

test("unexpected binding failures propagate without durable recovery or outbox cancellation", async () => {
  const f = await fixture();
  try {
    const engine = f.engine();
    const binding = f.app.telegramChats.binding.bind(f.app.telegramChats);
    f.app.telegramChats.binding = () => {
      throw new Error("synthetic storage unavailable");
    };
    for (const text of ["Mensagem", "/start"])
      await assert.rejects(
        engine.receive(update(text === "/start" ? 121 : 120, text)),
        /synthetic storage unavailable/,
      );
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text) VALUES ('storage-outbox','100','local pending reply')",
    );
    await assert.rejects(engine.flush(), /synthetic storage unavailable/);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='storage-outbox'",
      )?.state,
      "pending",
    );
    assert.equal(
      f.app.store.all("SELECT * FROM meta WHERE key LIKE 'telegram:update:%'")
        .length,
      0,
    );
    f.app.telegramChats.binding = binding;
  } finally {
    await f.close();
  }
});

test("deferred deliveries survive restart and recheck grant revocation before retry", async (t) => {
  for (const revoke of [false, true]) {
    await t.test(
      revoke ? "revoked before retry" : "authorized after restart",
      async () => {
        const f = await fixture();
        let unlock: (() => Promise<void>) | undefined;
        try {
          f.app.store.run(
            "INSERT INTO deliveries(id,chat,text) VALUES ('deferred-restart','100','local durable reply')",
          );
          unlock = await holdSettings(f.app, f.anchor);
          await f.engine().flush();
          assert.equal(
            f.app.store.get<{ state: string }>(
              "SELECT state FROM deliveries WHERE id='deferred-restart'",
            )?.state,
            "pending",
          );
          await unlock();
          unlock = undefined;
          if (revoke)
            f.app.store.run(
              "DELETE FROM telegram_grants WHERE conversationId=?",
              f.anchor,
            );
          await f.restart();
          await f.engine().flush();
          assert.equal(
            f.app.store.get<{ state: string }>(
              "SELECT state FROM deliveries WHERE id='deferred-restart'",
            )?.state,
            revoke ? "cancelled" : "sent",
          );
          assert.deepEqual(f.sent, revoke ? [] : ["local durable reply"]);
        } finally {
          await unlock?.();
          await f.close();
        }
      },
    );
  }
});

test("new is a Telegram menu command and creates a selected dedicated chat with optional title", async () => {
  const f = await fixture();
  try {
    assert.ok(telegramCommandCatalog.some((entry) => entry.command === "new"));
    const first = idOf(await f.engine().receive(update(1, "/new")));
    assert.notEqual(first, f.anchor);
    assert.equal(
      f.app.listConversations().find((row) => row.id === first)?.title,
      "Conversa Telegram",
    );
    const second = idOf(
      await f.engine().receive(update(2, "/new@test_pi_bot Viagem")),
    );
    assert.equal(
      f.app.listConversations().find((row) => row.id === second)?.title,
      "Viagem",
    );
    assert.equal(
      idOf(await f.engine().receive(update(3, "Mensagem seguinte"))),
      second,
    );
    await (await f.app.conversation(second)).waitForIdle(context);
    await f.restart();
    assert.equal(
      idOf(await f.engine().receive(update(4, "Depois do reinício"))),
      second,
    );
    await f.engine().receive(update(5, "/new@different_bot Ignorar"));
    assert.equal(
      f.app.listConversations().filter((row) => row.channel === "telegram")
        .length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("relinking a new web chat with history preserves its web origin and creates a separate new Telegram chat", async () => {
  const f = await fixture();
  try {
    await f.app.deleteConversation(f.anchor);
    const web = await f.app.create("Web antes do pareamento");
    await f.app.admit(web, "web-before-link", "Mensagem web antes do vínculo", {
      source: "web",
    });
    await (await f.app.conversation(web)).waitForIdle(context);
    const before = (await f.app.snapshot(web)).view.entries;
    const engine = f.engine();
    assert.deepEqual(
      await engine.receive(update(130, `/link ${f.app.store.link(web)}`)),
      { linked: web },
    );
    assert.equal(f.app.telegramChats.dedicated(web), false);
    assert.equal(
      f.app.listConversations().find((c) => c.id === web)?.channel,
      "web",
    );
    const telegram = idOf(
      await engine.receive(update(131, "/new Contexto Telegram")),
    );
    assert.notEqual(telegram, web);
    assert.deepEqual((await f.app.snapshot(web)).view.entries, before);
    assert.equal(
      f.app.listConversations().find((c) => c.id === telegram)?.channel,
      "telegram",
    );
    await engine.receive(update(132, "Mensagem somente Telegram"));
    await (await f.app.conversation(telegram)).waitForIdle(context);
    assert.deepEqual((await f.app.snapshot(web)).view.entries, before);
    await f.app.admit(web, "web-after-link", "Continuar enviando pela web", {
      source: "web",
    });
    await (await f.app.conversation(web)).waitForIdle(context);
    await f.restart();
    assert.equal(
      f.app.listConversations().find((c) => c.id === web)?.channel,
      "web",
    );
    assert.equal(
      f.app.listConversations().find((c) => c.id === telegram)?.channel,
      "telegram",
    );
    f.app.commands.authorize(web, { source: "web" });
    assert.throws(
      () => f.app.commands.authorize(telegram, { source: "web" }),
      /exclusiva do Telegram/,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM requests WHERE conversationId=? AND source='web'",
        web,
      ).length,
      2,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM requests WHERE conversationId=? AND source='telegram'",
        web,
      ).length,
      0,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM requests WHERE conversationId=? AND source='telegram'",
        telegram,
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("new replaces a deleted or purged selection using an active binding and deduplicates concurrent updates", async () => {
  const f = await fixture();
  try {
    const old = idOf(await f.engine().receive(update(10, "/chats new Antiga")));
    const archived = await f.app.deleteConversation(old);
    const engine = f.engine();
    const stale = (await engine.receive(update(11, "Seleção excluída"))) as {
      error: string;
    };
    assert.match(stale.error, /\/new/);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    await f.app.purgeConversation(old, true, archived.deletedAt);
    const [a, b] = await Promise.all([
      engine.receive(update(12, "/new Nova")),
      engine.receive(update(12, "/new Nova")),
    ]);
    assert.deepEqual(a, b);
    assert.notEqual(idOf(a), old);
    assert.equal(
      idOf(await engine.receive(update(13, "Nova mensagem"))),
      idOf(a),
    );
    assert.equal(
      f.app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        old,
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("after all chats are deleted new and normal messages explain relinking without reviving grants, including purge and restart", async () => {
  const f = await fixture();
  try {
    const selected = idOf(
      await f.engine().receive(update(20, "/chats new Telegram")),
    );
    await f.app.deleteConversation(selected);
    const archived = await f.app.deleteConversation(f.anchor);
    const engine = f.engine();
    const result = (await engine.receive(update(21, "/new"))) as {
      error: string;
    };
    assert.match(result.error, /Vincular Telegram/);
    assert.match(result.error, /\/link/);
    await engine.flush();
    assert.match(f.sent.at(-1)!, /Vincular Telegram/);
    await engine.receive(update(21, "/new"));
    await engine.flush();
    assert.equal(f.sent.length, 1);
    await engine.receive(update(22, "/start"));
    await engine.flush();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent.at(-1)!, /Vincular Telegram/);
    await f.app.purgeConversation(f.anchor, true, archived.deletedAt);
    await f.restart();
    const after = f.engine();
    await after.receive(update(23, "Sem silêncio"));
    await after.flush();
    assert.equal(f.sent.length, 3);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM telegram").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    assert.equal(f.app.listConversations().length, 0);
  } finally {
    await f.close();
  }
});

test("configured metadata without a valid current credential cannot authorize control replies", async () => {
  for (const value of [
    undefined,
    "{}",
    JSON.stringify({ token: "", botId: 123 }),
    JSON.stringify({ token: "123:fake", botId: 999 }),
  ]) {
    const f = await fixture();
    try {
      await f.app.deleteConversation(f.anchor);
      f.app.store.run("DELETE FROM credentials WHERE provider='telegram:bot'");
      if (value !== undefined)
        f.app.store.run(
          "INSERT INTO credentials VALUES ('telegram:bot',?)",
          value,
        );
      const engine = f.engine();
      assert.deepEqual(await engine.receive(update(40, "/new")), {
        ignored: true,
      });
      await engine.flush();
      assert.equal(f.sent.length, 0);
      assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 0);
    } finally {
      await f.close();
    }
  }
});

test("recovery guidance is cancelled after disconnect, owner change or credential rotation and cannot drain old outbox", async () => {
  for (const change of ["disconnect", "owner", "credential"]) {
    const f = await fixture();
    try {
      await f.app.deleteConversation(f.anchor);
      const engine = f.engine();
      await engine.receive(update(30, "/new"));
      f.app.store.run(
        "INSERT INTO deliveries(id,chat,text) VALUES ('legacy-secret','100','old secret')",
      );
      if (change === "credential")
        f.app.store.run(
          "UPDATE credentials SET value=? WHERE provider='telegram:bot'",
          JSON.stringify({ token: "123:rotated-fake", botId: 123 }),
        );
      else {
        const row = f.app.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='telegram:connection'",
        )!;
        const config = JSON.parse(row.value);
        if (change === "disconnect") config.enabled = false;
        else config.userId = "77";
        f.app.store.run(
          "UPDATE meta SET value=? WHERE key='telegram:connection'",
          JSON.stringify(config),
        );
      }
      await engine.flush();
      assert.equal(f.sent.length, 0);
      assert.equal(
        f.app.store.all("SELECT * FROM deliveries WHERE state='pending'")
          .length,
        0,
      );
      assert.deepEqual(await engine.receive(update(31, "/new", 77)), {
        ignored: true,
      });
      assert.deepEqual(await engine.receive(update(32, "/new")), {
        ignored: true,
      });
    } finally {
      await f.close();
    }
  }
});
