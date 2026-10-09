import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runtime } from "../src/runtime.js";
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
