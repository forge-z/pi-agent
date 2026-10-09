import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversation-list-events-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const anchor = await app.create("Synthetic web anchor");
  app.store.consumeLink(app.store.link(anchor), "42", "42");
  const web = createAppServer(app, {
    password: "synthetic-list-password",
    origin: "http://localhost:3000",
    secureCookie: false,
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: "synthetic-list-password" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  async function open(selected?: string) {
    const path = selected
      ? `/api/conversations/${selected}/events`
      : "/api/conversations/events";
    const request = httpRequest(`${base}${path}`, {
      headers: { cookie },
    });
    const response = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        request.once("response", resolve);
        request.once("error", reject);
        request.end();
      },
    );
    const frames: string[] = [];
    let buffer = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        frames.push(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    });
    return {
      response,
      frames,
      changes: () =>
        frames.filter((frame) => frame.startsWith("event: conversations\n")),
      async wait(count: number) {
        const end = Date.now() + 4000;
        while (this.changes().length < count && Date.now() < end)
          await delay(10);
        assert.equal(this.changes().length, count);
      },
      close: () => {
        response.destroy();
        request.destroy();
      },
    };
  }
  return {
    app,
    anchor,
    web,
    base,
    cookie,
    open,
    async close() {
      await web.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("global list SSE observes Telegram creation and lifecycle changes while the web history remains idle", async () => {
  const f = await fixture();
  const stream = await f.open();
  try {
    assert.equal(stream.response.statusCode, 200);
    assert.equal(stream.response.headers["x-accel-buffering"], "no");
    await stream.wait(1);
    let historyReads = 0;
    const original = f.app.snapshot.bind(f.app);
    f.app.snapshot = async (...args) => {
      historyReads++;
      return original(...args);
    };
    const telegram = await f.app.create("Synthetic Telegram chat", {
      chat: "42",
      user: "42",
    });
    f.app.telegramChats.select(telegram, { chat: "42", user: "42" });
    await stream.wait(2);
    const rows = (await (
      await fetch(`${f.base}/api/conversations`, {
        headers: { cookie: f.cookie },
      })
    ).json()) as ReturnType<Runtime["listConversations"]>;
    assert.equal(rows.find((row) => row.id === telegram)?.channel, "telegram");
    assert.equal(rows.find((row) => row.id === f.anchor)?.channel, "web");
    assert.equal(rows.length, 2);
    await f.app.deleteConversation(telegram);
    await stream.wait(3);
    assert.equal(
      f.app.listConversations(true).find((row) => row.id === telegram)?.channel,
      "telegram",
    );
    f.app.restoreConversation(telegram);
    await stream.wait(4);
    f.app.renameConversation(telegram, "Synthetic renamed Telegram");
    await stream.wait(5);
    await delay(1200);
    assert.equal(
      stream.changes().length,
      5,
      "idle polls do not keep rebuilding the browser list",
    );
    assert.equal(
      historyReads,
      0,
      "global list events must never serialize transcript snapshots",
    );
    assert.ok(
      stream
        .changes()
        .every((frame) =>
          /^event: conversations\ndata: \{"version":"[a-f0-9]{64}"\}$/.test(
            frame,
          ),
        ),
      "only an opaque metadata version crosses this stream",
    );
  } finally {
    stream.close();
    await f.close();
  }
});

test("list SSE requires authentication, reconnects with current state and closes an expired session", async () => {
  const f = await fixture();
  const stream = await f.open();
  try {
    assert.equal(
      (await fetch(`${f.base}/api/conversations/events`)).status,
      401,
    );
    await stream.wait(1);
    stream.close();
    const reconnected = await f.open();
    try {
      await reconnected.wait(1);
      assert.equal(reconnected.changes()[0], stream.changes()[0]);
      const ended = new Promise<void>((resolve) =>
        reconnected.response.once("end", resolve),
      );
      f.app.store.run("UPDATE sessions SET expires=0");
      await Promise.race([
        ended,
        delay(2500).then(() => {
          throw new Error("expired list SSE remained open");
        }),
      ]);
      assert.equal(reconnected.changes().length, 1);
    } finally {
      reconnected.close();
    }
  } finally {
    stream.close();
    await f.close();
  }
});

test("the selected idle history stream also reports new Telegram chats without repeating its transcript", async () => {
  const f = await fixture();
  const snapshot = await f.app.snapshot(f.anchor);
  f.app.snapshot = async () => snapshot;
  const stream = await f.open(f.anchor);
  try {
    await stream.wait(1);
    const deadline = Date.now() + 3000;
    while (
      !stream.frames.some((frame) => frame.startsWith("event: snapshot\n")) &&
      Date.now() < deadline
    )
      await delay(10);
    assert.equal(
      stream.frames.filter((frame) => frame.startsWith("event: snapshot\n"))
        .length,
      1,
    );
    await delay(1100);
    assert.equal(stream.changes().length, 1);
    await f.app.create("Synthetic other-transport chat", {
      chat: "42",
      user: "42",
    });
    await stream.wait(2);
    assert.equal(
      stream.frames.filter((frame) => frame.startsWith("event: snapshot\n"))
        .length,
      1,
    );
    stream.close();
    const reconnected = await f.open(f.anchor);
    try {
      await reconnected.wait(1);
      assert.equal(reconnected.changes()[0], stream.changes()[1]);
    } finally {
      reconnected.close();
    }
  } finally {
    stream.close();
    await f.close();
  }
});
