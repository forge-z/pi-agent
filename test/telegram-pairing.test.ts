import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import { Telegram } from "../src/telegram.js";

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
  const dir = await mkdtemp(join(tmpdir(), "pi-pairing-"));
  const faux = fauxProvider({ models: [{ id: "one" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const open = () =>
    Runtime.open({
      dir,
      models,
      modelId: "one",
      gateway: { call: async () => ({}) },
    });
  let app = await open();
  const sent: string[] = [];
  const transport = {
    send: async (_chat: string, text: string) => {
      sent.push(text);
      return { ok: true };
    },
  };
  const telegram = () =>
    new Telegram(app, transport, ["42", "43"], ["100", "101"], "test_pi_bot");
  return {
    get app() {
      return app;
    },
    faux,
    sent,
    telegram,
    async restart() {
      await app.close();
      app = await open();
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("legacy authenticated link API -> explicitly injected webhook binds once without calling the model", async () => {
  const f = await fixture();
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(f.app, {
    password: "pairing-test-password",
    origin,
    secureCookie: false,
    publicDir: resolve("public"),
    telegram: f.telegram(),
    telegramSecret: "mock-webhook-secret",
  });
  await new Promise<void>((done) => web.server.listen(0, "127.0.0.1", done));
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  const request = (path: string, data: unknown, secret?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
      },
      body: JSON.stringify(data),
    });
  try {
    const login = await request("/api/login", {
      password: "pairing-test-password",
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    const id = await f.app.create("Conversa web");
    const pairing = await request(`/api/conversations/${id}/link`, {});
    assert.equal(pairing.status, 201);
    const payload = (await pairing.json()) as { command: string; url: string };
    const copied = payload.command;
    assert.match(copied, /^\/link [a-f0-9]{32}$/);
    const deepLink = new URL(payload.url);
    assert.equal(deepLink.hostname, "t.me");
    assert.equal(deepLink.pathname, "/test_pi_bot");
    assert.equal(deepLink.searchParams.get("start"), copied.slice(6));
    const denied = await request(
      "/api/telegram/webhook",
      update(1, copied),
      "wrong-secret",
    );
    assert.equal(denied.status, 403);
    assert.equal(f.app.store.all("SELECT * FROM telegram").length, 0);
    for (const [user, chat] of [
      [7, 100],
      [42, 200],
    ]) {
      assert.equal(
        (
          await request(
            "/api/telegram/webhook",
            update(1, copied, user, chat),
            "mock-webhook-secret",
          )
        ).status,
        200,
      );
      assert.equal(f.app.store.all("SELECT * FROM telegram").length, 0);
    }
    const copiedUpdate = update(1, `  ${copied}\n`);
    const duplicate = await Promise.all([
      request("/api/telegram/webhook", copiedUpdate, "mock-webhook-secret"),
      request("/api/telegram/webhook", copiedUpdate, "mock-webhook-secret"),
    ]);
    assert.deepEqual(
      duplicate.map((response) => response.status),
      [200, 200],
    );
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='100'",
      )?.conversationId,
      id,
    );
    assert.equal(f.app.store.all("SELECT * FROM links").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 1);
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 1);
    const wrongChannel = await request(`/api/conversations/${id}/messages`, {
      requestId: "web-pasted-link",
      text: copied,
    });
    assert.equal(wrongChannel.status, 400);
    const wrongChannelText = JSON.stringify(await wrongChannel.json());
    assert.match(wrongChannelText, /Telegram/);
    assert.doesNotMatch(wrongChannelText, /desconhecido|[a-f0-9]{32}/);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await web.close();
    await f.close();
  }
});

test("Telegram /start guides without auto-pairing; suffix and deep-link payload dispatch before slash commands", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    let tg = f.telegram();
    const intro = await tg.receive(update(1, "/start"));
    assert.match(JSON.stringify(intro), /web|interface/);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 0);
    const code = f.app.store.link(id);
    assert.deepEqual(await tg.receive(update(2, `/start@Other_bot ${code}`)), {
      ignored: true,
    });
    assert.deepEqual(
      await tg.receive(update(3, `/start@TEST_PI_BOT ${code}`)),
      { linked: id },
    );
    assert.equal(f.app.store.all("SELECT * FROM links").length, 0);
    assert.equal(
      (
        (await tg.receive(update(4, "/help@test_pi_bot"))) as {
          command: string;
        }
      ).command,
      "help",
    );
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    await tg.flush();
    assert.equal(f.sent.filter((text) => text.includes("vinculada")).length, 1);
    assert.ok(f.sent.every((text) => !text.includes(code)));
    await f.restart();
    tg = f.telegram();
    assert.deepEqual(
      await tg.receive(update(3, `/start@TEST_PI_BOT ${code}`)),
      { linked: id },
    );
    await tg.flush();
    assert.equal(f.sent.filter((text) => text.includes("vinculada")).length, 1);
    await assert.rejects(
      tg.receive(update(3, `/start@TEST_PI_BOT ${code}`, 43)),
      /utilizado/,
    );
    await assert.rejects(
      tg.receive(update(5, `/link@test_pi_bot ${code}`, 42, 101)),
      /inválido|expirado/,
    );
    const other = await f.app.create();
    const otherCode = f.app.store.link(other);
    await tg.receive(update(6, `\n/link@test_pi_bot\t${otherCode}  `));
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='100'",
      )?.conversationId,
      other,
    );
    assert.deepEqual(
      await tg.receive(update(3, `/start@TEST_PI_BOT ${code}`)),
      { linked: id },
    );
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='100'",
      )?.conversationId,
      other,
    );
    await assert.rejects(tg.receive(update(7, "/help", 43)), /vinculada/);
  } finally {
    await f.close();
  }
});

test("pairing validates code shape/expiry; literal slash escaping is not a pairing request", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    const tg = f.telegram();
    for (const [i, text] of [
      "/link",
      "/start not-a-code",
      "/link bad more",
      "/link <redacted>",
    ].entries())
      await assert.rejects(
        tg.receive(update(10 + i, text)),
        /Uso:|inválido|expirado/,
      );
    const expired = f.app.store.link(id);
    f.app.store.run("UPDATE links SET expires=0");
    await assert.rejects(
      tg.receive(update(20, `/start ${expired}`)),
      /inválido|expirado/,
    );
    await assert.rejects(
      tg.receive(update(21, `//link ${expired}`)),
      /vinculada/,
    );
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.close();
  }
});

test("bare pairing works without bot username; an uncertain pairing acknowledgement is never resent after restart", async () => {
  const f = await fixture();
  let sends = 0;
  const transport = {
    send: async () => {
      sends++;
      throw new Error("mock response lost");
    },
  };
  const telegram = () => new Telegram(f.app, transport, ["42"], ["100"]);
  try {
    const id = await f.app.create();
    const code = f.app.store.link(id);
    let tg = telegram();
    assert.deepEqual(await tg.receive(update(1, `/link@other_bot ${code}`)), {
      ignored: true,
    });
    assert.deepEqual(await tg.receive(update(2, `/link ${code}`)), {
      linked: id,
    });
    await tg.flush();
    assert.equal(sends, 1);
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='link:telegram:update:2'",
      )?.state,
      "uncertain",
    );
    await f.restart();
    tg = telegram();
    assert.deepEqual(await tg.receive(update(2, `/link ${code}`)), {
      linked: id,
    });
    await tg.flush();
    assert.equal(sends, 1);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 1);
  } finally {
    await f.close();
  }
});

test("pairing code consumption, grant, receipt and acknowledgement roll back atomically on storage failure", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    const code = f.app.store.link(id);
    f.app.store.db.exec(
      "CREATE TRIGGER fail_pairing_ack BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'mock storage failure'); END",
    );
    const tg = f.telegram();
    await assert.rejects(
      tg.receive(update(1, `/link ${code}`)),
      /mock storage failure/,
    );
    assert.equal(f.app.store.all("SELECT * FROM links").length, 1);
    assert.equal(f.app.store.all("SELECT * FROM telegram").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 0);
    assert.equal(
      f.app.store.get("SELECT * FROM meta WHERE key='telegram:update:1'"),
      undefined,
    );
    f.app.store.db.exec("DROP TRIGGER fail_pairing_ack");
    assert.deepEqual(await tg.receive(update(1, `/link ${code}`)), {
      linked: id,
    });
    assert.equal(f.app.store.all("SELECT * FROM links").length, 0);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 1);
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 1);
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.close();
  }
});

test("Telegram pairing normalization preserves the contents and whitespace of an explicitly escaped slash message", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    const tg = f.telegram();
    await tg.receive(update(1, `/link ${f.app.store.link(id)}`));
    f.faux.setResponses([fauxAssistantMessage("Literal recebido")]);
    const admitted = (await tg.receive(
      update(2, "  //help@test_pi_bot\n"),
    )) as { conversationId: string };
    assert.notEqual(admitted.conversationId, id);
    await (
      await f.app.conversation(admitted.conversationId)
    ).waitForIdle(context);
    assert.equal(
      f.app.store.get<{ text: string }>(
        "SELECT text FROM requests WHERE requestId='telegram:2'",
      )?.text,
      "  /help@test_pi_bot\n",
    );
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await f.close();
  }
});
