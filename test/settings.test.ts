import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { McpGateway } from "../src/mcp.js";
import { createAppServer } from "../src/server.js";

test("Pi catalog validates effort, defaults affect only new conversations and per-conversation settings survive restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-"));
  const open = () =>
    Runtime.open({ dir, mode: "live", gateway: new McpGateway([]) });
  let app = await open();
  try {
    const first = await app.create();
    const initial = await app.settings.conversation(first);
    const choice = {
      provider: "openai",
      modelId: "gpt-5.6-sol",
      effort: "low",
    };
    assert.ok(
      app.settings
        .catalog()
        .some(
          (model) =>
            model.id === choice.modelId && model.efforts.includes("low"),
        ),
    );
    assert.throws(
      () => app.settings.saveDefaults({ modelId: "made-up", effort: "high" }),
      /catálogo/,
    );
    assert.throws(
      () =>
        app.settings.saveDefaults({ modelId: choice.modelId, effort: "ultra" }),
      /suportado/,
    );
    app.settings.saveDefaults(choice);
    assert.deepEqual(await app.settings.conversation(first), initial);
    const second = await app.create();
    assert.deepEqual(await app.settings.conversation(second), choice);
    await app.close();
    app = await Runtime.open({
      dir,
      mode: "demo",
      gateway: new McpGateway([]),
    });
    assert.equal(app.settings.defaults().modelId, "faux-1");
    app.settings.saveDefaults({ modelId: "faux-1", effort: "off" });
    await app.close();
    app = await open();
    assert.deepEqual(app.settings.defaults(), choice);
    await assert.rejects(
      app.submit(first, "no-auth", "test-without-account"),
      /Conecte/,
    );
    assert.equal(
      app.store.get("SELECT 1 FROM requests WHERE requestId='no-auth'"),
      undefined,
    );
    await app.settings.saveConversation(first, {
      modelId: "gpt-6.1-sol",
      effort: "xhigh",
    });
    await app.close();
    app = await open();
    assert.deepEqual(app.settings.defaults(), choice);
    assert.deepEqual(await app.settings.conversation(first), {
      provider: "openai",
      modelId: "gpt-6.1-sol",
      effort: "xhigh",
    });
    assert.deepEqual(await app.settings.conversation(second), choice);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP settings persist without returning secrets, protect pending actions and invalidate endpoint evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-settings-"));
  let gateway = new McpGateway([]);
  let app = await Runtime.open({ dir, gateway });
  const config = {
    name: "calendar",
    url: "https://calendar.example/mcp",
    readTools: ["lookup"],
    actionTools: ["create"],
    token: "mock-private-token",
  };
  try {
    await app.settings.saveMcp([config]);
    assert.equal(app.settings.mcp()[0].hasToken, true);
    assert.doesNotMatch(
      JSON.stringify(app.settings.snapshot()),
      /mock-private-token/,
    );
    const { token: _token, ...withoutToken } = config;
    void _token;
    await app.settings.saveMcp([withoutToken]);
    assert.equal(gateway.config[0].token, config.token);
    await assert.rejects(
      app.settings.saveMcp([
        { ...withoutToken, url: "https://other.example/mcp" },
      ]),
      /token/,
    );
    await assert.rejects(
      app.settings.saveMcp([
        { ...config, url: "https://calendar.example/mcp?access_token=private" },
      ]),
      /bearer/,
    );
    await assert.rejects(
      app.settings.saveMcp([{ ...config, tokenFile: "/app/data/app.sqlite" }]),
      /operador/,
    );
    const id = await app.create();
    app.store.run("INSERT INTO reads VALUES (?,?)", id, "mock-evidence");
    app.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,state) VALUES ('pending-action',?,'calendar','create','pending')",
      id,
    );
    await assert.rejects(app.settings.saveMcp([]), /aprovações/);
    assert.equal(gateway.config.length, 1);
    app.store.run("UPDATE actions SET state='denied'");
    await app.settings.saveMcp([config]);
    assert.equal(app.store.all("SELECT * FROM reads").length, 0);
    const originalRun = app.store.run.bind(app.store);
    app.store.run = (sql, ...args) => {
      if (sql.startsWith("INSERT INTO meta"))
        throw new Error("mock-storage-full");
      return originalRun(sql, ...args);
    };
    try {
      await assert.rejects(app.settings.saveMcp([]), /mock-storage-full/);
      assert.equal(gateway.config[0].name, "calendar");
    } finally {
      app.store.run = originalRun;
    }
    await app.close();
    await gateway.close();
    gateway = new McpGateway([]);
    app = await Runtime.open({ dir, gateway });
    assert.equal(gateway.config[0].token, config.token);
    assert.doesNotMatch(
      JSON.stringify(app.settings.mcp()),
      /mock-private-token/,
    );
    // Reopening also queues the persisted denied-action outcome through Pi.
    for (
      let i = 0;
      i < 100 && app.store.get("SELECT 1 FROM requests WHERE status='pending'");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      app.store.get("SELECT 1 FROM requests WHERE status='pending'"),
      undefined,
    );
    await app.settings.saveMcp([{ ...withoutToken, token: "" }]);
    assert.equal(app.settings.mcp()[0].hasToken, false);
  } finally {
    await app.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings endpoints require web session and same origin; MCP discovery exposes tools without permitting execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-settings-http-"));
  const gateway = new McpGateway([]),
    app = await Runtime.open({ dir, gateway });
  const origin = "http://localhost:3000",
    web = createAppServer(app, {
      password: "mock-password-only",
      origin,
      secureCookie: false,
    });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const addr = web.server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  let cookie = "";
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    requestOrigin = origin,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        cookie,
        "content-type": "application/json",
        Origin: requestOrigin,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    assert.equal((await request("/api/settings")).status, 401);
    assert.equal((await request("/api/mcp")).status, 401);
    assert.equal((await request("/api/tasks")).status, 401);
    const login = await request("/api/login", "POST", {
      password: "mock-password-only",
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await request(
          "/api/settings",
          "PUT",
          { modelId: "faux-1", effort: "off" },
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal((await request("/api/settings")).status, 200);
    assert.equal(
      (await request("/api/mcp", "PUT", { servers: [] })).status,
      200,
    );
    assert.equal(
      (
        await request("/api/mcp", "PUT", {
          servers: [
            {
              name: "bad",
              url: "http://remote.example/mcp",
              readTools: [],
              actionTools: [],
            },
          ],
        })
      ).status,
      400,
    );
    assert.equal((await request("/settings.js")).status, 200);
    const conversationId = await app.create("Tarefa HTTP");
    const created = await request("/api/tasks", "POST", {
      title: "Revisar plano",
      prompt: "Organize minhas prioridades",
      conversationId,
      kind: "cron",
      schedule: "0 8 * * 1-5",
      timezone: "America/Sao_Paulo",
      enabled: false,
    });
    assert.equal(created.status, 201);
    const task = (await created.json()) as {
      id: string;
      delivery: string;
      nextRun: number | null;
    };
    assert.equal(task.delivery, "web");
    assert.deepEqual(
      await (
        await request(
          `/api/tasks/telegram-availability?conversationId=${encodeURIComponent(conversationId)}`,
        )
      ).json(),
      { available: false },
    );
    assert.equal(
      (
        await request(`/api/tasks/${task.id}`, "PUT", {
          delivery: "web_telegram",
        })
      ).status,
      400,
    );
    const binding = {
      enabled: true,
      bot: { id: 123456 },
      userId: "42",
      chatId: "42",
      conversationId,
    };
    app.store.run(
      "INSERT INTO telegram VALUES (?,?,?)",
      "42",
      conversationId,
      "42",
    );
    app.store.run(
      "INSERT INTO telegram_grants VALUES (?,?,?)",
      "42",
      "42",
      conversationId,
    );
    app.store.run(
      "INSERT INTO meta VALUES (?,?)",
      "telegram:connection",
      JSON.stringify(binding),
    );
    assert.deepEqual(
      await (
        await request(
          `/api/tasks/telegram-availability?conversationId=${encodeURIComponent(conversationId)}`,
        )
      ).json(),
      { available: true },
    );
    const deliveryUpdate = await request(`/api/tasks/${task.id}`, "PUT", {
      delivery: "web_telegram",
    });
    assert.equal(deliveryUpdate.status, 200);
    assert.equal((await deliveryUpdate.json()).delivery, "web_telegram");
    const webUpdate = await request(`/api/tasks/${task.id}`, "PUT", {
      delivery: "web",
    });
    assert.equal(webUpdate.status, 200);
    assert.equal((await webUpdate.json()).delivery, "web");
    const first = await request(`/api/tasks/${task.id}/run`, "POST", {
      requestId: "manual-click-one",
    });
    assert.equal(first.status, 202);
    const run = (await first.json()) as { id: string; requestId: string };
    for (
      let i = 0;
      i < 100 &&
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId=?",
        run.requestId,
      )?.status !== "done";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId=?",
        run.requestId,
      )?.status,
      "done",
    );
    const retry = await request(`/api/tasks/${task.id}/run`, "POST", {
      requestId: "manual-click-one",
    });
    assert.equal(((await retry.json()) as { id: string }).id, run.id);
    assert.equal(
      app.store.all("SELECT * FROM task_runs WHERE taskId=?", task.id).length,
      1,
    );
    assert.equal(
      (await request(`/api/tasks/${task.id}/run`, "POST", {})).status,
      400,
    );
    assert.equal((await request(`/api/tasks/${task.id}/runs`)).status, 200);
    assert.equal(
      (
        await request(
          `/api/tasks/${task.id}`,
          "PUT",
          { enabled: true },
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (await request(`/api/tasks/${task.id}`, "PUT", { enabled: true })).status,
      200,
    );
    assert.equal(
      (await request(`/api/tasks/${task.id}`, "DELETE")).status,
      200,
    );
    assert.equal((await request(`/api/tasks/${task.id}/runs`)).status, 404);
  } finally {
    await web.close();
    await app.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});
