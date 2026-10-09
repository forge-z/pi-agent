import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-web-"));
  const faux = fauxProvider({
    models: [
      { id: "one", reasoning: true },
      { id: "two", reasoning: false },
    ],
  });
  faux.setResponses(
    Array.from({ length: 20 }, () => fauxAssistantMessage("Synthetic answer")),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const options = {
    dir,
    models,
    modelId: "one",
    gateway: {
      call: async () => {
        throw new Error("External tools forbidden");
      },
    },
  };
  let app = await Runtime.open(options);
  const anchor = await app.create("Existing web history");
  await app.admit(anchor, "web-original", "Original web input", {
    source: "web",
  });
  await (await app.conversation(anchor)).waitForIdle(context);
  app.store.consumeLink(app.store.link(anchor), "100", "42");
  const id = await app.create("Started on Telegram", {
    chat: "100",
    user: "42",
  });
  app.telegramChats.select(id, { chat: "100", user: "42" });
  const origin = "http://localhost:3000";
  const web = createAppServer(app, {
    origin,
    password: "synthetic-password-only",
    secureCookie: false,
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: "synthetic-password-only" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  let serverClosed = false;
  return {
    get app() {
      return app;
    },
    id,
    anchor,
    async request(
      path: string,
      method = "GET",
      data?: unknown,
      authenticated = true,
      requestOrigin = origin,
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(authenticated ? { cookie } : {}),
          origin: requestOrigin,
          "content-type": "application/json",
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: response.status, body: await response.json() };
    },
    async restart() {
      await web.close();
      serverClosed = true;
      await app.close();
      app = await Runtime.open(options);
    },
    async close() {
      if (!serverClosed) await web.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const webAccess = { source: "web" as const };
const telegramAccess = { source: "telegram" as const, chat: "100", user: "42" };
async function settled(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  const deadline = Date.now() + 5000;
  while (
    app.store.get(
      "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
      id,
    )
  ) {
    assert.ok(
      Date.now() < deadline,
      "Request completion must settle before checking delivery",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const routing = (app: Runtime) => ({
  origins: app.store.all(
    "SELECT * FROM telegram_conversations ORDER BY conversationId",
  ),
  bindings: app.store.all("SELECT * FROM telegram ORDER BY chat"),
  grants: app.store.all(
    "SELECT * FROM telegram_grants ORDER BY chat,user,conversationId",
  ),
  selection: app.store.all(
    "SELECT * FROM telegram_chat_selection ORDER BY chat,user",
  ),
});

test("HTTP web continuation keeps Telegram origin and the same history before and after model changes", async () => {
  const f = await fixture();
  try {
    const first = await f.app.admit(
      f.id,
      "telegram-first",
      "Telegram original",
      telegramAccess,
    );
    assert.equal(first.conversationId, f.id);
    await settled(f.app, f.id);
    const original = (await f.app.snapshot(f.id)).view.entries;
    const anchorHistory = (await f.app.snapshot(f.anchor)).view.entries;
    const before = routing(f.app);
    for (const requestId of ["web-before-model", "web-after-model"]) {
      if (requestId === "web-after-model") {
        const settings = await f.request(
          `/api/conversations/${f.id}/settings`,
          "PUT",
          { provider: "faux", modelId: "two", effort: "off" },
        );
        assert.equal(settings.status, 200);
      }
      const response = await f.request(
        `/api/conversations/${f.id}/messages`,
        "POST",
        { requestId, text: requestId },
      );
      assert.equal(response.status, 202, JSON.stringify(response.body));
      assert.equal(response.body.conversationId, f.id);
      await settled(f.app, f.id);
      const row = f.app.store.get<{ source: string; chat: string | null }>(
        "SELECT source,chat FROM requests WHERE conversationId=? AND requestId=?",
        f.id,
        requestId,
      );
      assert.ok(row);
      assert.deepEqual({ ...row }, { source: "web", chat: null });
      assert.equal(
        f.app.store.all(
          "SELECT * FROM deliveries WHERE id LIKE ?",
          `${f.id}:${requestId}:%`,
        ).length,
        0,
      );
      assert.deepEqual(routing(f.app), before);
    }
    assert.deepEqual(
      (await f.app.snapshot(f.anchor)).view.entries,
      anchorHistory,
    );
    const history = (await f.app.snapshot(f.id)).view.entries;
    assert.deepEqual(history.slice(0, original.length), original);
    assert.equal(
      f.app.listConversations().find((c) => c.id === f.id)?.channel,
      "telegram",
    );
    const agents = await f.app.admit(f.id, "web-agents", "/agents", webAccess);
    assert.ok(agents.kind === "command");
    assert.ok(
      agents.data &&
        Array.isArray(agents.data) &&
        agents.data.some((c) => c.id === f.id),
    );
    const invalidAuth = await f.request(
      `/api/conversations/${f.id}/messages`,
      "POST",
      { requestId: "no-auth", text: "blocked" },
      false,
    );
    assert.equal(invalidAuth.status, 401);
    const invalidOrigin = await f.request(
      `/api/conversations/${f.id}/messages`,
      "POST",
      { requestId: "wrong-origin", text: "blocked" },
      true,
      "http://wrong.local",
    );
    assert.equal(invalidOrigin.status, 403);
  } finally {
    await f.close();
  }
});

test("web continuation does not restore revoked Telegram grants, including restart and direct submission", async () => {
  const f = await fixture();
  try {
    f.app.store.run("DELETE FROM telegram_grants WHERE conversationId=?", f.id);
    const revoked = routing(f.app);
    await f.app.submit(f.id, "direct-web", "Continue on web", "web");
    await settled(f.app, f.id);
    assert.deepEqual(routing(f.app), revoked);
    await assert.rejects(
      f.app.admit(f.id, "revoked-telegram", "blocked Telegram", telegramAccess),
      /não autorizada/,
    );
    await f.restart();
    const result = await f.app.admit(
      f.id,
      "web-after-restart",
      "Still continue on web",
      webAccess,
    );
    assert.equal(result.conversationId, f.id);
    await settled(f.app, f.id);
    assert.deepEqual(routing(f.app), revoked);
    assert.equal(
      f.app.listConversations().find((c) => c.id === f.id)?.channel,
      "telegram",
    );
    assert.equal(f.app.store.all("SELECT * FROM deliveries").length, 0);
    await assert.rejects(
      f.app.admit(
        f.id,
        "revoked-after-restart",
        "blocked Telegram",
        telegramAccess,
      ),
      /não autorizada/,
    );
  } finally {
    await f.close();
  }
});

test("concurrent web and Telegram inputs preserve request source and Telegram selection", async () => {
  const f = await fixture();
  try {
    const before = routing(f.app);
    const results = await Promise.all([
      f.app.admit(f.id, "concurrent-web", "Web follow-up", webAccess),
      f.app.admit(
        f.id,
        "concurrent-telegram",
        "Telegram follow-up",
        telegramAccess,
      ),
    ]);
    assert.ok(results.every((result) => result.conversationId === f.id));
    await settled(f.app, f.id);
    assert.deepEqual(routing(f.app), before);
    assert.deepEqual(
      f.app.store
        .all<{ requestId: string; source: string; chat: string | null }>(
          "SELECT requestId,source,chat FROM requests WHERE conversationId=? ORDER BY requestId",
          f.id,
        )
        .map((row) => ({ ...row })),
      [
        { requestId: "concurrent-telegram", source: "telegram", chat: "100" },
        { requestId: "concurrent-web", source: "web", chat: null },
      ],
    );
    assert.equal(
      f.app.store.all(
        "SELECT * FROM deliveries WHERE id LIKE ?",
        `${f.id}:concurrent-web:%`,
      ).length,
      0,
    );
    assert.ok(
      f.app.store.all(
        "SELECT * FROM deliveries WHERE id LIKE ?",
        `${f.id}:concurrent-telegram:%`,
      ).length > 0,
      JSON.stringify({
        requests: f.app.store.all(
          "SELECT * FROM requests WHERE conversationId=?",
          f.id,
        ),
        deliveries: f.app.store.all("SELECT * FROM deliveries"),
      }),
    );
  } finally {
    await f.close();
  }
});
