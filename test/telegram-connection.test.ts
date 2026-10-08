import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import {
  TelegramConnection,
  TelegramApiError,
  type TelegramApi,
  type TelegramConnectionOptions,
} from "../src/telegram-connection.js";
import { hash, SqlCredentials } from "../src/store.js";
import type { TelegramUpdate } from "../src/telegram.js";
import type { ToolGateway } from "../src/mcp.js";

const token = "123456:fake_local_test_token";
const dm = (
  id: number,
  text: string,
  user = 42,
  type = "private",
  chat = user,
): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    text,
    from: { id: user },
    chat: { id: chat, type },
  },
});
async function until(predicate: () => boolean, label = "condition") {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
class FakeTelegram implements TelegramApi {
  calls: { method: string; payload: Record<string, unknown>; at: number }[] =
    [];
  updates: TelegramUpdate[] = [];
  sent: { chat: unknown; text: unknown }[] = [];
  webhook = "";
  botId = 123456;
  pollError: TelegramApiError | undefined;
  getMeError: TelegramApiError | undefined;
  deleteUncertain = false;
  sendUncertain = false;
  pending: (() => void) | undefined;
  activePolls = 0;
  maxActivePolls = 0;
  push(...updates: TelegramUpdate[]) {
    this.updates.push(...updates);
    this.pending?.();
  }
  async call(
    method: Parameters<TelegramApi["call"]>[0],
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    this.calls.push({ method, payload, at: Date.now() });
    if (method === "getMe") {
      if (this.getMeError) throw this.getMeError;
      return {
        id: this.botId,
        is_bot: true,
        username: "test_pi_bot",
        first_name: "Pi test",
      };
    }
    if (method === "getWebhookInfo") return { url: this.webhook };
    if (method === "deleteWebhook") {
      this.webhook = "";
      if (this.deleteUncertain)
        throw new Error(`fake secret network failure ${token}`);
      return true;
    }
    if (method === "sendMessage") {
      this.sent.push({ chat: payload.chat_id, text: payload.text });
      if (this.sendUncertain) throw new Error(`response lost ${token}`);
      return { message_id: this.sent.length };
    }
    if (this.pollError) {
      const error = this.pollError;
      this.pollError = undefined;
      throw error;
    }
    const batch = () =>
      this.updates.filter(
        (update) => update.update_id >= Number(payload.offset ?? 0),
      );
    if (!payload.timeout || batch().length) return batch();
    this.activePolls++;
    this.maxActivePolls = Math.max(this.activePolls, this.maxActivePolls);
    try {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          this.pending = undefined;
          resolve();
        };
        const abort = () => {
          this.pending = undefined;
          reject(signal?.reason);
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        this.pending = done;
      });
      return batch();
    } finally {
      this.activePolls--;
    }
  }
}
async function fixture(
  legacy?: TelegramConnectionOptions["legacy"],
  gateway: ToolGateway = { call: async () => ({}) },
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-polling-"));
  let app = await Runtime.open({
    dir,
    mode: "demo",
    gateway,
  });
  const fake = new FakeTelegram();
  let manager = new TelegramConnection(app, {
    apiFactory: () => fake,
    legacy,
    retryBaseMs: 10,
  });
  return {
    dir,
    fake,
    get app() {
      return app;
    },
    get manager() {
      return manager;
    },
    connect: (conversationId: string, extra: Record<string, unknown> = {}) =>
      manager.connect({
        requestId: randomUUID(),
        token,
        userId: "42",
        conversationId,
        ...extra,
      }),
    offset: () =>
      app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:offset:${fake.botId}`,
      )?.value,
    async restart() {
      await manager.close();
      await app.close();
      app = await Runtime.open({
        dir,
        mode: "demo",
        gateway,
      });
      manager = new TelegramConnection(app, {
        apiFactory: () => fake,
        legacy,
        retryBaseMs: 10,
      });
      await manager.restore();
    },
    async close() {
      await manager.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Telegram setup status is authenticated and available without environment credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-connection-"));
  const app = await Runtime.open({
    dir,
    mode: "demo",
    gateway: { call: async () => ({}) },
  });
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(app, {
    password: "telegram-test-password",
    origin,
    secureCookie: false,
    publicDir: resolve("public"),
  });
  await new Promise<void>((done) => web.server.listen(0, "127.0.0.1", done));
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/telegram`)).status, 401);
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ password: "telegram-test-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const status = await fetch(`${base}/api/telegram`, { headers: { cookie } });
    assert.equal(status.status, 200);
    const snapshot = (await status.json()) as {
      state: string;
      hasToken: boolean;
    };
    assert.equal(snapshot.state, "unconfigured");
    assert.equal(snapshot.hasToken, false);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("private polling binds only the explicit user and shares the selected conversation; duplicates and restart preserve the offset", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create("Web + Telegram");
    f.fake.push(
      dm(1, "/start", 7),
      dm(2, "/start", 42, "group"),
      dm(3, "/start"),
      dm(4, "Olá pelo Telegram"),
    );
    assert.equal((await f.connect(id)).state, "connected");
    await until(() => f.offset() === "5", "durable offset");
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 1);
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT * FROM telegram WHERE chat='42'",
      )?.conversationId,
      id,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:4'")
        .length,
      1,
    );
    await (await f.app.conversation(id)).waitForIdle(context);
    await until(
      () =>
        f.fake.sent.some((value) =>
          String(value.text).includes("Olá pelo Telegram"),
        ),
      "shared reply",
    );
    assert.equal(f.manager.snapshot().conversationTitle, "Web + Telegram");
    assert.equal(
      f.fake.calls.filter((call) => call.method === "deleteWebhook").length,
      0,
    );
    assert.equal(
      f.fake.calls.find((call) => call.method === "getUpdates")?.payload
        .timeout,
      0,
    );
    await f.restart();
    await until(
      () =>
        f.fake.calls.some(
          (call) => call.method === "getUpdates" && call.payload.offset === 5,
        ),
      "restored offset",
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:4'")
        .length,
      1,
    );
    assert.equal(f.fake.maxActivePolls, 1);
    assert.deepEqual(
      f.fake.calls.filter((call) => call.method === "getUpdates").at(-1)
        ?.payload.allowed_updates,
      ["message"],
    );
    assert.doesNotMatch(
      JSON.stringify(f.manager.snapshot()),
      new RegExp(token),
    );
    assert.ok(
      f.app.store.get(
        "SELECT * FROM credentials WHERE provider='telegram:bot'",
      ),
    );
    assert.deepEqual(await new SqlCredentials(f.app.store).list(), []);
    assert.ok(
      f.app.store
        .all<{ value: string }>("SELECT value FROM meta")
        .every((row) => !row.value.includes(token)),
    );
    assert.equal((await stat(join(f.dir, "app.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await stat(f.dir)).mode & 0o777, 0o700);
  } finally {
    await f.close();
  }
});

test("webhook switching verifies bot and full URL version; duplicate connect and disconnect never repeat deletion or reactivate", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    f.fake.webhook = "https://example.invalid/private/token-path?secret=hidden";
    const conflict = await f.connect(id);
    assert.equal(conflict.state, "webhook_conflict");
    assert.equal(conflict.webhookUrl, "https://example.invalid");
    assert.ok(!JSON.stringify(conflict).includes("token-path"));
    assert.equal(
      f.fake.calls.filter((call) => call.method === "deleteWebhook").length,
      0,
    );
    assert.equal(
      (
        await f.connect(id, {
          replaceWebhook: true,
          expectedBotId: 999,
          expectedWebhook: conflict.webhookVersion,
        })
      ).state,
      "webhook_conflict",
    );
    f.fake.webhook = "https://example.invalid/changed";
    assert.equal(
      (
        await f.connect(id, {
          replaceWebhook: true,
          expectedBotId: f.fake.botId,
          expectedWebhook: conflict.webhookVersion,
        })
      ).state,
      "webhook_conflict",
    );
    const request = {
      requestId: randomUUID(),
      token,
      userId: "42",
      conversationId: id,
      replaceWebhook: true,
      expectedBotId: f.fake.botId,
      expectedWebhook: hash(f.fake.webhook),
    };
    const duplicate = await Promise.all([
      f.manager.connect(request),
      f.manager.connect(request),
    ]);
    assert.ok(duplicate.every((snapshot) => snapshot.state === "connected"));
    assert.equal(
      f.fake.calls.filter((call) => call.method === "deleteWebhook").length,
      1,
    );
    const deleteCall = f.fake.calls.find(
      (call) => call.method === "deleteWebhook",
    );
    assert.equal(deleteCall?.payload.drop_pending_updates, false);
    await assert.rejects(
      f.manager.connect({ ...request, userId: "43" }),
      /requestId/,
    );
    await f.manager.disconnect({ requestId: randomUUID() });
    assert.equal((await f.manager.connect(request)).state, "disconnected");
    await f.restart();
    assert.equal(f.manager.snapshot().state, "disconnected");
    assert.equal((await f.manager.connect(request)).state, "disconnected");
    assert.equal(
      f.fake.calls.filter((call) => call.method === "deleteWebhook").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("unknown webhook deletion is durably uncertain and never blindly repeated", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    f.fake.webhook = "https://example.invalid/hook";
    f.fake.deleteUncertain = true;
    const conflict = await f.connect(id);
    const request = {
      requestId: randomUUID(),
      token,
      userId: "42",
      conversationId: id,
      replaceWebhook: true,
      expectedBotId: f.fake.botId,
      expectedWebhook: conflict.webhookVersion,
    };
    const result = await f.manager.connect(request);
    assert.equal(result.state, "blocked");
    assert.match(result.error!, /incerto/);
    assert.ok(!JSON.stringify(result).includes(token));
    await f.manager.connect(request);
    await f.restart();
    assert.equal(f.manager.snapshot().state, "blocked");
    assert.match(f.manager.snapshot().error!, /incerto/);
    await f.manager.connect(request);
    assert.equal(
      f.fake.calls.filter((call) => call.method === "deleteWebhook").length,
      1,
    );
    assert.equal(
      f.app.store
        .all<{ value: string }>(
          "SELECT value FROM meta WHERE key LIKE 'telegram:setup:%'",
        )
        .some((row) => JSON.parse(row.value).state === "uncertain"),
      true,
    );
    // A new explicit Connect may observe that the uncertain delete actually succeeded.
    assert.equal((await f.connect(id)).state, "connected");
    assert.equal(
      f.fake.calls.filter((call) => call.method === "deleteWebhook").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("admission survives checkpoint storage failure and restart without losing later updates or duplicating requests", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    f.app.store.db.exec(
      "CREATE TRIGGER fail_poll_receipt BEFORE INSERT ON telegram_poll_receipts BEGIN SELECT RAISE(ABORT,'mock checkpoint failure'); END",
    );
    f.fake.push(dm(10, "Mensagem durável"), dm(11, "Próxima mensagem"));
    await f.connect(id);
    await until(
      () => f.manager.snapshot().state === "retrying",
      "checkpoint error",
    );
    assert.equal(f.offset(), undefined);
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:10'")
        .length,
      1,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:11'")
        .length,
      0,
    );
    await f.manager.close();
    f.app.store.db.exec("DROP TRIGGER fail_poll_receipt");
    await f.restart();
    await until(() => f.offset() === "12", "restart replay");
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:10'")
        .length,
      1,
    );
    assert.equal(
      f.app.store.all("SELECT * FROM requests WHERE requestId='telegram:11'")
        .length,
      1,
    );
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 1);
  } finally {
    await f.close();
  }
});

test("invalid commands are terminal receipts; DM binding and grants roll back on storage failure", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    f.app.store.db.exec(
      "CREATE TRIGGER fail_grant BEFORE INSERT ON telegram_grants BEGIN SELECT RAISE(ABORT,'mock grant failure'); END",
    );
    f.fake.push(
      dm(1, "/link bad"),
      dm(2, "/approve aaaaaaaaaaaaaaaaaaaaaaaa"),
      dm(3, "/help"),
    );
    await f.connect(id);
    await until(() => f.manager.snapshot().state === "retrying");
    assert.equal(f.app.store.all("SELECT * FROM telegram").length, 0);
    assert.equal(f.offset(), undefined);
    f.app.store.db.exec("DROP TRIGGER fail_grant");
    await until(() => f.offset() === "4");
    assert.equal(
      f.app.store.all(
        "SELECT * FROM telegram_poll_receipts WHERE state='rejected'",
      ).length,
      2,
    );
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 1);
    assert.equal(f.app.store.all("SELECT * FROM requests").length, 0);
  } finally {
    await f.close();
  }
});

test("migration is paused, hints are narrow and legacy credentials are read only on explicit Connect", async () => {
  let reads = 0;
  const f = await fixture({
    hasToken: true,
    userIds: ["42"],
    readToken: () => {
      reads++;
      return token;
    },
  });
  try {
    const old = await f.app.create("Legacy"),
      target = await f.app.create("Selected");
    f.app.store.run("INSERT INTO telegram VALUES ('42',?,'42')", old);
    f.app.store.run("INSERT INTO telegram_grants VALUES ('42','42',?)", old);
    await f.manager.restore();
    assert.equal(f.manager.snapshot().state, "migration_required");
    assert.equal(reads, 0);
    assert.equal(f.fake.calls.length, 0);
    assert.equal((await f.connect(target, { token: "" })).state, "connected");
    assert.equal(reads, 1);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 1);
    f.fake.push(dm(1, "/start"));
    await until(() => f.offset() === "2");
    assert.equal(
      f.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='42'",
      )?.conversationId,
      target,
    );
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 2);
    await f.manager.disconnect({ requestId: randomUUID() });
    await f.restart();
    assert.equal(reads, 1);
    assert.equal(f.manager.snapshot().state, "disconnected");
  } finally {
    await f.close();
  }
});

test("same-bot token rotation is allowed; another bot is blocked and old recipients are not sent queued deliveries", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    await f.connect(id);
    f.fake.push(dm(1, "/start"));
    await until(() => f.offset() === "2");
    f.app.store.run(
      "INSERT INTO deliveries(id,chat,text) VALUES ('old-user-pending','42','old private response')",
    );
    await f.connect(id, { token: "123456:rotated_fake_token", userId: "43" });
    f.fake.push(dm(2, "/start", 43));
    await until(() => f.offset() === "3");
    assert.equal(
      f.fake.sent.some((row) => row.text === "old private response"),
      false,
    );
    assert.equal(
      f.app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='old-user-pending'",
      )?.state,
      "pending",
    );
    f.fake.botId = 999;
    assert.equal(
      (await f.connect(id, { token: "999:another_fake_bot" })).state,
      "blocked",
    );
    assert.match(f.manager.snapshot().error!, /outro bot/);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 2);
  } finally {
    await f.close();
  }
});

test("poll conflict blocks without deletes, transient failures retry and rate-limit waiting is abortable", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    f.fake.pollError = new TelegramApiError("unavailable");
    assert.equal((await f.connect(id)).state, "retrying");
    await until(() => f.manager.snapshot().state === "connected");
    await f.manager.disconnect({ requestId: randomUUID() });
    f.fake.pollError = new TelegramApiError("conflict");
    assert.equal((await f.connect(id)).state, "blocked");
    assert.match(f.manager.snapshot().error!, /Outro processo/);
    assert.equal(
      f.fake.calls.filter((call) => call.method === "deleteWebhook").length,
      0,
    );
    f.fake.pollError = new TelegramApiError("rate_limit", 120);
    assert.equal((await f.connect(id)).state, "retrying");
    const start = Date.now();
    await f.manager.disconnect({ requestId: randomUUID() });
    assert.ok(Date.now() - start < 1000);
    assert.equal(f.fake.activePolls, 0);
  } finally {
    await f.close();
  }
});

test("uncertain outbound messages are never resent after restart", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    f.fake.sendUncertain = true;
    f.fake.push(dm(1, "/start"));
    await f.connect(id);
    await until(
      () =>
        f.app.store.all("SELECT * FROM deliveries WHERE state='uncertain'")
          .length === 1,
    );
    assert.equal(f.fake.sent.length, 1);
    await f.restart();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(f.fake.sent.length, 1);
    assert.ok(!JSON.stringify(f.manager.snapshot()).includes(token));
  } finally {
    await f.close();
  }
});

test("disconnect cancels an in-flight approval, persists uncertainty and never re-executes its effect", async () => {
  let writes = 0;
  const f = await fixture(undefined, {
    call: async (_server, _tool, _args, kind, signal) => {
      if (kind === "read") return {};
      writes++;
      return new Promise((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      });
    },
  });
  try {
    const id = await f.app.create();
    await f.app.actions.read(id, "mock", "read", {});
    const action = f.app.actions.propose(id, 1, "mock", "write", {});
    f.fake.push(dm(1, `/approve ${action.id}`));
    await f.connect(id);
    await until(() => writes === 1);
    const start = Date.now();
    await f.manager.disconnect({ requestId: randomUUID() });
    assert.ok(Date.now() - start < 1000);
    assert.equal(f.app.store.actions(id)[0].state, "uncertain");
    await f.restart();
    await f.connect(id);
    f.fake.push(dm(2, `/approve ${action.id}`));
    await until(() => f.offset() === "3");
    assert.equal(writes, 1);
  } finally {
    await f.close();
  }
});

test("persistent storage errors back off exponentially without advancing the offset", async () => {
  const f = await fixture();
  try {
    const id = await f.app.create();
    f.app.store.db.exec(
      "CREATE TRIGGER fail_poll_always BEFORE INSERT ON telegram_poll_receipts BEGIN SELECT RAISE(ABORT,'mock persist failure'); END",
    );
    f.fake.push(dm(1, "/help"));
    await f.connect(id);
    await until(
      () =>
        f.fake.calls.filter((call) => call.method === "getUpdates").length >= 4,
    );
    await f.manager.disconnect({ requestId: randomUUID() });
    const polls = f.fake.calls.filter((call) => call.method === "getUpdates");
    assert.ok(polls[2].at - polls[1].at >= 15);
    assert.ok(polls[3].at - polls[2].at >= 35);
    assert.equal(f.offset(), undefined);
    assert.equal(f.app.store.all("SELECT * FROM telegram_grants").length, 1);
  } finally {
    await f.close();
  }
});

test("connect and disconnect require web session and exact origin; legacy webhook stays disabled and token errors leave web healthy", async () => {
  const f = await fixture();
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(f.app, {
    password: "fake-web-password",
    origin,
    secureCookie: false,
    telegramConnection: f.manager,
    publicDir: resolve("public"),
  });
  await new Promise<void>((done) => web.server.listen(0, "127.0.0.1", done));
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, data: unknown, cookie = "", source = origin) =>
    fetch(base + path, {
      method: "POST",
      headers: { origin: source, cookie, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    const id = await f.app.create();
    const input = {
      requestId: randomUUID(),
      token,
      userId: "42",
      conversationId: id,
    };
    assert.equal((await post("/api/telegram/connect", input)).status, 401);
    const login = await post("/api/login", { password: "fake-web-password" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await post(
          "/api/telegram/connect",
          input,
          cookie,
          "https://evil.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/telegram/disconnect",
          { requestId: randomUUID() },
          cookie,
          "https://evil.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (await post("/api/telegram/webhook", dm(1, "/start"), cookie)).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/telegram/connect",
          { ...input, userId: "42,43" },
          cookie,
        )
      ).status,
      400,
    );
    f.fake.getMeError = new TelegramApiError("invalid_token");
    const invalid = await post("/api/telegram/connect", input, cookie);
    assert.equal(invalid.status, 200);
    assert.equal((await invalid.json()).state, "blocked");
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal((await fetch(base + "/telegram.js")).status, 200);
    f.fake.getMeError = undefined;
    const connected = await post(
      "/api/telegram/connect",
      { ...input, requestId: randomUUID() },
      cookie,
    );
    assert.equal((await connected.json()).state, "connected");
    assert.equal(
      (
        await post(
          "/api/telegram/disconnect",
          { requestId: randomUUID() },
          cookie,
        )
      ).status,
      200,
    );
    assert.equal(f.manager.snapshot().state, "disconnected");
  } finally {
    await web.close();
    await f.close();
  }
});

test("main starts with incomplete old Telegram environment and an unreadable legacy secret without making Telegram requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-main-"));
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: resolve("."),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      APP_MODE: "demo",
      APP_ORIGIN: origin,
      DATA_DIR: dir,
      PORT: String(port),
      WEB_PASSWORD: "main-fake-password",
      TELEGRAM_BOT_TOKEN_FILE: join(dir, "missing-secret"),
      TELEGRAM_ALLOWED_USERS: "42",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  try {
    const deadline = Date.now() + 5000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      try {
        healthy = (await fetch(origin + "/healthz")).status === 200;
      } catch {
        /* startup */
      }
      if (!healthy) await new Promise((done) => setTimeout(done, 25));
    }
    assert.ok(healthy, logs);
    const login = await fetch(origin + "/api/login", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ password: "main-fake-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const response = await fetch(origin + "/api/telegram", {
      headers: { cookie },
    });
    const state = await response.json();
    assert.equal(state.state, "migration_required");
    assert.equal(state.hasToken, true);
    assert.equal(state.userId, "42");
    assert.equal(state.bot, null);
    assert.equal(state.lastSuccessAt, null);
    assert.doesNotMatch(logs, /ENOENT|api\.telegram\.org|Token Telegram/);
  } finally {
    const exited = new Promise<void>((done) =>
      child.once("exit", () => done()),
    );
    child.kill("SIGTERM");
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});
