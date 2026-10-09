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
import { Telegram } from "../src/telegram.js";
import {
  taskTelegramAvailable,
  taskTelegramAuthorized,
  queueTaskTelegram,
} from "../src/task-telegram.js";

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
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-chats-"));
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: 20 }, () => fauxAssistantMessage("mock answer")),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const options = {
    dir,
    models,
    gateway: { call: async () => ({ content: [] }) },
  };
  let app = await Runtime.open(options);
  const webId = await app.create("Histórico antigo");
  await app.admit(webId, "old", "contexto antigo da web", { source: "web" });
  await (await app.conversation(webId)).waitForIdle(context);
  app.store.consumeLink(app.store.link(webId), "100", "42");
  app.store.run(
    "INSERT INTO meta VALUES (?,?)",
    "telegram:connection",
    JSON.stringify({
      enabled: true,
      bot: { id: 123 },
      userId: "42",
      chatId: "100",
      conversationId: webId,
    }),
  );
  const engine = () =>
    new Telegram(
      app,
      { send: async () => ({ ok: true }) },
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
    webId,
    faux,
    engine,
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
function idOf(value: unknown) {
  return (value as { conversationId: string }).conversationId;
}

test("the next Telegram message automatically gets separate context without moving web history or cron binding", async () => {
  const f = await fixture();
  try {
    const webBefore = (await f.app.snapshot(f.webId)).view.entries;
    const [a, b] = await Promise.all([
      f.engine().receive(update(1, "somente Telegram")),
      f.engine().receive(update(2, "segunda mensagem")),
    ]);
    const id = idOf(a);
    assert.notEqual(id, f.webId);
    assert.equal(idOf(b), id);
    await (await f.app.conversation(id)).waitForIdle(context);
    assert.deepEqual((await f.app.snapshot(f.webId)).view.entries, webBefore);
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT * FROM telegram WHERE chat='100'",
      )?.conversationId,
      f.webId,
    );
    assert.deepEqual(
      f.app.listConversations().map((c) => c.id),
      [f.webId],
    );
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_conversations").length,
      1,
    );
    const texts = f.app.store
      .all<{ text: string }>(
        "SELECT text FROM requests WHERE conversationId=?",
        id,
      )
      .map((r) => r.text);
    assert.deepEqual(texts, ["somente Telegram", "segunda mensagem"]);
    assert.equal(taskTelegramAvailable(f.app.store, f.webId), true);
    assert.equal(taskTelegramAvailable(f.app.store, id), true);
    await assert.rejects(
      f.app.admit(id, "web-leak", "web input", { source: "web" }),
      /Telegram/,
    );
  } finally {
    await f.close();
  }
});

test("/chats creates, lists and switches scoped chats; retries and restart never reapply selection", async () => {
  const f = await fixture();
  try {
    const first = await f
      .engine()
      .receive(update(10, "/chats new Viagem pessoal"));
    const firstId = idOf(first);
    assert.notEqual(firstId, f.webId);
    const second = await f.engine().receive(update(11, "/chats new Trabalho"));
    const secondId = idOf(second);
    assert.notEqual(firstId, secondId);
    assert.deepEqual(
      await f.engine().receive(update(10, "/chats new Viagem pessoal")),
      first,
    );
    assert.equal(
      idOf(await f.engine().receive(update(12, "assunto trabalho"))),
      secondId,
    );
    const listing = (await f.engine().receive(update(13, "/chats"))) as {
      text: string;
    };
    assert.match(listing.text, /Viagem pessoal/);
    assert.match(listing.text, /Trabalho/);
    assert.match(listing.text, /web/);
    await f.engine().receive(update(14, `/chats ${firstId}`));
    await f.restart();
    assert.deepEqual(
      await f.engine().receive(update(11, "/chats new Trabalho")),
      second,
    );
    assert.equal(
      idOf(await f.engine().receive(update(15, "assunto viagem"))),
      firstId,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_conversations").length,
      2,
    );
    const duplicate = update(16, "/chats new Duplicada");
    const engine = f.engine();
    const both = await Promise.all([
      engine.receive(duplicate),
      engine.receive(duplicate),
    ]);
    assert.deepEqual(both[0], both[1]);
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_conversations").length,
      3,
    );
    assert.equal(
      f.app.commands.allowed({ source: "web" }).some((c) => c.id === firstId),
      false,
    );
  } finally {
    await f.close();
  }
});

test("/chats rejects web/foreign IDs and validates before committing uncertain receipts", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.app.admit(f.webId, "web-chats", "/chats", { source: "web" }),
      /Telegram/,
    );
    const invalid = (await f
      .engine()
      .receive(update(20, `/chats ${f.webId}`))) as { error: string };
    assert.match(invalid.error, /Telegram/);
    const tooLong = (await f
      .engine()
      .receive(update(21, `/chats new ${"x".repeat(101)}`))) as {
      error: string;
    };
    assert.match(tooLong.error, /100/);
    assert.equal(
      f.app.store.all(
        "SELECT * FROM command_receipts WHERE requestId IN ('telegram:20','telegram:21')",
      ).length,
      0,
    );
    const id = idOf(await f.engine().receive(update(22, "/chats new Privada")));
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "200",
      "99",
      id,
    );
    f.app.store.run(
      "INSERT INTO telegram VALUES (?,?,?)",
      "200",
      f.webId,
      "99",
    );
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "200",
      "99",
      f.webId,
    );
    const other = new Telegram(
      f.app,
      { send: async () => ({}) },
      ["99"],
      ["200"],
    );
    const denied = (await other.receive(
      update(23, `/chats ${id}`, 99, 200),
    )) as { error: string };
    assert.match(denied.error, /Telegram/);
    await assert.rejects(
      other.receive(update(24, `/agents ${id}`, 99, 200)),
      /não autorizada/,
    );
    const webHelp = await f.app.admit(f.webId, "web-help", "/help", {
      source: "web",
    });
    assert.equal(webHelp.kind, "command");
    assert.doesNotMatch(webHelp.text, /\/chats/);
  } finally {
    await f.close();
  }
});

test("revoked binding/selection fails closed rather than returning to mixed history", async () => {
  const f = await fixture();
  try {
    const id = idOf(await f.engine().receive(update(30, "Telegram context")));
    await (await f.app.conversation(id)).waitForIdle(context);
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      f.webId,
    );
    await assert.rejects(
      f.engine().receive(update(31, "must fail")),
      /não autorizada/,
    );
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "100",
      "42",
      f.webId,
    );
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", id);
    await assert.rejects(
      f.engine().receive(update(32, "must also fail")),
      /não autorizada/,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE text LIKE 'must%'").length,
      0,
    );
    await f.restart();
    await assert.rejects(
      f.engine().receive(update(33, "still revoked")),
      /não autorizada/,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_conversations").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("paused handoff prevents automatic migration and selection without resuming any work", async () => {
  const f = await fixture();
  try {
    const held = new Set([f.webId]);
    f.app.isConversationHeld = (id) => held.has(id);
    await assert.rejects(f.engine().receive(update(40, "blocked")), /pausada/);
    await assert.rejects(
      f.engine().receive(update(41, "/chats new Blocked")),
      /pausada/,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_conversations").length,
      0,
    );
    held.clear();
    const first = idOf(
      await f.engine().receive(update(42, "/chats new First")),
    );
    const second = idOf(
      await f.engine().receive(update(43, "/chats new Second")),
    );
    held.add(second);
    await assert.rejects(
      f.engine().receive(update(44, `/chats ${first}`)),
      /pausada/,
    );
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT * FROM telegram_chat_selection",
      )?.conversationId,
      second,
    );
    held.clear();
    held.add(first);
    await f.engine().receive(update(45, `/chats ${first}`));
    await assert.rejects(
      f.engine().receive(update(46, "paused target")),
      /pausada/,
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM requests WHERE text IN ('blocked','paused target')",
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a binding revoked while Durable creates a chat cannot grant or select it", async () => {
  const f = await fixture();
  try {
    const create = f.app.harness.createConversation.bind(f.app.harness);
    f.app.harness.createConversation = async (...args) => {
      const result = await create(...args);
      f.app.store.run(
        "DELETE FROM telegram_grants WHERE conversationId=?",
        f.webId,
      );
      return result;
    };
    await assert.rejects(
      f.engine().receive(update(50, "revocation race")),
      /não autorizada/,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM telegram_chat_selection").length,
      0,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE text='revocation race'")
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("revocation during admission awaits prevents a new request, and a forged cross-owner anchor cannot deliver a task", async () => {
  const f = await fixture();
  try {
    const id = idOf(await f.engine().receive(update(60, "/chats new Scoped")));
    const conversation = f.app.conversation.bind(f.app);
    f.app.conversation = async (target) => {
      const result = await conversation(target);
      if (target === id)
        f.app.store.run(
          "DELETE FROM telegram_grants WHERE conversationId=?",
          id,
        );
      return result;
    };
    await assert.rejects(
      f.engine().receive(update(61, "race must not be admitted")),
      /não autorizada/,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:61'")
        .length,
      0,
    );
    assert.throws(() => f.app.store.link(id), /exclusiva.*Telegram/);
    f.app.store.run("INSERT INTO telegram VALUES (?,?,?)", "200", id, "99");
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "200",
      "99",
      id,
    );
    f.app.store.run(
      "UPDATE meta SET value=? WHERE key='telegram:connection'",
      JSON.stringify({
        enabled: true,
        bot: { id: 123 },
        userId: "99",
        chatId: "200",
        conversationId: id,
      }),
    );
    assert.equal(taskTelegramAvailable(f.app.store, id), false);
  } finally {
    await f.close();
  }
});

test("revocation during deferred outcomes leaves no pending input for restart to submit", async () => {
  const f = await fixture();
  try {
    const id = idOf(await f.engine().receive(update(70, "/chats new Scoped")));
    Reflect.set(f.app, "drainDeferredOutcomes", async () => {
      f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", id);
    });
    await assert.rejects(
      f.engine().receive(update(71, "rejected input")),
      /não autorizada/,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:71'")
        .length,
      0,
    );
    // Simulate an old admission ledger persisted before a process crash.
    f.app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,chat) VALUES (?,?,?,'telegram','100')",
      id,
      "telegram:72",
      "unsent revoked input",
    );
    const calls = f.faux.state.callCount;
    await f.restart();
    assert.equal(f.faux.state.callCount, calls);
    assert.equal(
      f.app.store.get<{ status: string; submissionId: number | null }>(
        "SELECT * FROM requests WHERE requestId='telegram:72'",
      )?.status,
      "revoked",
    );
    assert.equal((await f.app.snapshot(id)).view.entries.length, 0);
  } finally {
    await f.close();
  }
});

test("chat selection preserves old and dedicated cron parts; revocation is terminal even after regrant", async () => {
  const f = await fixture();
  try {
    const id = idOf(
      await f.engine().receive(update(80, "/chats new Cron Telegram")),
    );
    await f.engine().receive(update(81, "/chats new Outra"));
    for (const target of [f.webId, id]) {
      const task = await f.app.tasks.create({
        title: "Mock cron",
        prompt: "local prompt",
        kind: "cron",
        schedule: "* * * * *",
        timezone: "UTC",
        conversationId: target,
        delivery: "web_telegram",
      });
      const request = `cron-${target}`;
      f.app.store.run(
        "INSERT INTO task_runs(id,taskId,scheduledAt,requestId,state) VALUES (?,?,?,?,'done')",
        `run-${target}`,
        task.id,
        Date.now(),
        request,
      );
      queueTaskTelegram(f.app.store, target, request, "x".repeat(12000));
    }
    const parts = () =>
      f.app.store.all<{ id: string; state: string }>(
        "SELECT id,state FROM deliveries WHERE id LIKE '%task-notification:%'",
      );
    const before = parts();
    assert.equal(before.length, 8);
    await f.engine().receive(update(82, `/chats ${id}`));
    assert.deepEqual(parts(), before);
    assert.equal(
      parts().every((p) =>
        taskTelegramAuthorized(f.app.store, p.id, ["42"], ["100"], 123),
      ),
      true,
    );
    f.app.store.run(
      "DELETE FROM telegram_grants WHERE conversationId=?",
      f.webId,
    );
    assert.equal(
      parts().every((p) => p.state === "cancelled"),
      true,
    );
    f.app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "100",
      "42",
      f.webId,
    );
    assert.equal(
      parts().every((p) => p.state === "cancelled"),
      true,
    );
  } finally {
    await f.close();
  }
});
