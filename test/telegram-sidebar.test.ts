import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Runtime } from "../src/runtime.js";

test("sidebar Telegram markers follow only the active authorized chat mapping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-sidebar-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  try {
    const linkedId = await app.create("Legacy web history");
    const otherId = await app.create("Telegram in the title only");
    const dedicatedId = await app.create("Dedicated Telegram conversation");
    app.store.run(
      "INSERT INTO telegram_conversations VALUES (?,?,?)",
      dedicatedId,
      "42",
      "7",
    );

    app.store.run(
      "INSERT INTO meta VALUES ('telegram:connection',?)",
      JSON.stringify({
        enabled: true,
        bot: { id: 123 },
        userId: "7",
        chatId: "42",
        conversationId: linkedId,
      }),
    );
    app.store.run(
      "INSERT INTO credentials VALUES ('telegram:bot',?)",
      JSON.stringify({ token: "123:fixture-token", botId: 123 }),
    );
    app.store.run("INSERT INTO telegram VALUES (?,?,?)", "42", linkedId, "7");
    app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "7",
      linkedId,
    );

    const rows = app.listConversations();
    assert.equal(rows.find((row) => row.id === linkedId)?.telegramLinked, true);
    assert.equal(rows.find((row) => row.id === otherId)?.telegramLinked, false);
    assert.equal(
      rows.some((row) => row.id === dedicatedId),
      false,
    );

    app.store.run(
      "DELETE FROM telegram_grants WHERE chat=? AND user=? AND conversationId=?",
      "42",
      "7",
      linkedId,
    );
    assert.equal(
      app.listConversations().find((row) => row.id === linkedId)
        ?.telegramLinked,
      false,
    );

    app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "7",
      linkedId,
    );
    app.store.run(
      "UPDATE telegram SET conversationId=? WHERE chat=?",
      otherId,
      "42",
    );
    app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "7",
      otherId,
    );
    const remapped = app.listConversations();
    assert.equal(
      remapped.find((row) => row.id === linkedId)?.telegramLinked,
      false,
    );
    assert.equal(
      remapped.find((row) => row.id === otherId)?.telegramLinked,
      true,
    );

    app.store.run(
      "UPDATE meta SET value=? WHERE key='telegram:connection'",
      JSON.stringify({
        enabled: false,
        bot: { id: 123 },
        userId: "7",
        chatId: "42",
        conversationId: otherId,
      }),
    );
    const disconnected = app.listConversations();
    assert.equal(
      disconnected.find((row) => row.id === otherId)?.telegramLinked,
      false,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
