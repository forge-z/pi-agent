import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import { taskTelegramAuthorized } from "../src/task-telegram.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";

test("rename validates title; archive retains history, pauses tasks, revokes Telegram, restores safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversations-"));
  let app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  try {
    const id = await app.create("Original");
    assert.equal(app.renameConversation(id, "  Trabalho  ").title, "Trabalho");
    for (const title of ["  ", "x".repeat(101), "a\nb", 123])
      assert.throws(() => app.renameConversation(id, title), /Título/);
    const task = await app.tasks.create({
      title: "Cron",
      prompt: "teste",
      conversationId: id,
      kind: "cron",
      schedule: "0 8 * * *",
      timezone: "Etc/UTC",
    });
    app.store.run("INSERT INTO telegram VALUES ('42',?,'7')", id);
    app.store.run("INSERT INTO telegram_grants VALUES ('42','7',?)", id);
    const code = app.store.link(id);
    app.store.queueTelegram(`${id}:reply`, "42", "resposta");
    app.store.queueTelegram("command:old-request", "42", "ack", 4000, id);
    app.store.run(
      "INSERT INTO deliveries(id,chat,text) VALUES ('decision:99','84','old ack')",
    );
    app.store.run(
      "INSERT INTO meta VALUES ('telegram:update:99',?)",
      JSON.stringify({ conversationId: id, state: "done" }),
    );
    app.store.run(
      "INSERT INTO actions(id,conversationId,state,result) VALUES ('completed',?,'done','{}')",
      id,
    );
    await app.deleteConversation(id);
    assert.equal(app.listConversations().length, 0);
    assert.equal(app.listConversations(true)[0].title, "Trabalho");
    await assert.rejects(app.conversation(id), /excluída/);
    await assert.rejects(app.submit(id, "after-delete", "teste"), /excluída/);
    assert.throws(
      () => app.commands.authorize(id, { source: "web" }),
      /não autorizada/,
    );
    assert.throws(() => app.store.consumeLink(code, "42", "7"), /inválido/);
    assert.equal(app.store.all("SELECT * FROM telegram").length, 0);
    assert.equal(
      app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        `${id}:reply:0`,
      )!.state,
      "cancelled",
    );
    assert.equal(
      taskTelegramAuthorized(app.store, "command:old-request:0", ["7"], ["42"]),
      false,
    );
    assert.equal(
      app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='decision:99'",
      )?.state,
      "cancelled",
    );
    app.store.queueTelegram(`${id}:late`, "42", "late");
    assert.equal(
      app.store.get("SELECT 1 FROM deliveries WHERE id=?", `${id}:late:0`),
      undefined,
    );
    assert.equal(app.tasks.list()[0].enabled, false);
    assert.throws(
      () => app.tasks.update(task.id, { enabled: true }),
      /excluída/,
    );
    await assert.rejects(app.tasks.runNow(task.id), /excluída/);
    await app.close();
    app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
    assert.equal(app.listConversations().length, 0);
    app.restoreConversation(id);
    assert.equal(app.listConversations()[0].title, "Trabalho");
    await app.snapshot(id);
    assert.equal(app.tasks.list()[0].enabled, false);
    assert.equal(app.store.all("SELECT * FROM telegram_grants").length, 0);
    assert.equal(app.store.actions(id)[0].state, "done");
    app.renameConversation(id, "Nova conversa");
    await app.submit(
      id,
      "manual-default-title",
      "Este texto não deve substituir o nome escolhido",
    );
    assert.equal(app.listConversations()[0].title, "Nova conversa");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive reservation rejects raced message admissions until commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversations-race-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  try {
    const id = await app.create("Raced");
    const inspect = app.harness.inspect.bind(app.harness);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.harness.inspect = async (...args) => {
      await gate;
      return inspect(...args);
    };
    const deletion = app.deleteConversation(id);
    await assert.rejects(app.submit(id, "raced", "input"), /atualização/);
    await assert.rejects(
      app.admit(id, "raced-command", "/help", { source: "web" }),
      /atualização/,
    );
    release();
    await deletion;
    assert.equal(app.store.all("SELECT * FROM requests").length, 0);
    assert.equal(app.listConversations(true).length, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a raced agents command cannot remap Telegram to an archived conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversations-agents-race-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  let release!: () => void;
  try {
    const source = await app.create("Origem");
    const target = await app.create("Destino");
    app.store.run("INSERT INTO telegram VALUES ('42',?,'7')", source);
    app.store.run("INSERT INTO telegram_grants VALUES ('42','7',?)", source);
    app.store.run("INSERT INTO telegram_grants VALUES ('42','7',?)", target);
    const lookup = app.harness.conversation.bind(app.harness);
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.harness.conversation = async (...args) => {
      if (String(args[0]) === target) {
        entered();
        await gate;
      }
      return lookup(...args);
    };
    const command = app.admit(source, "raced-agents", `/agents ${target}`, {
      source: "telegram",
      chat: "42",
      user: "7",
    });
    await waiting;
    await app.deleteConversation(target);
    release();
    await assert.rejects(command, /não autorizada/);
    assert.equal(
      app.store.get(
        "SELECT 1 FROM command_receipts WHERE requestId='raced-agents'",
      ),
      undefined,
    );
    assert.equal(
      app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='42'",
      )?.conversationId,
      source,
    );
    app.restoreConversation(target);
    assert.equal(
      app.store.get(
        "SELECT 1 FROM telegram_grants WHERE conversationId=?",
        target,
      ),
      undefined,
    );
    assert.equal(
      app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram WHERE chat='42'",
      )?.conversationId,
      source,
    );
  } finally {
    release?.();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive never interrupts an executing assistant or cancels another conversation's deliveries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversations-execution-"));
  const models = createModels();
  const faux = fauxProvider();
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  faux.setResponses([
    async () => {
      await response;
      return fauxAssistantMessage("Concluída");
    },
  ]);
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    gateway: { call: async () => ({}) },
    models,
  });
  try {
    const id = await app.create("Em execução");
    const other = await app.create("Outra");
    await app.submit(id, "live-input", "Execute");
    await assert.rejects(app.deleteConversation(id), /execução|pendente/);
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE conversationId=?",
        id,
      )?.status,
      "pending",
    );
    release();
    await (await app.conversation(id)).waitForIdle(context);
    for (
      let n = 0;
      n < 50 && app.store.get("SELECT 1 FROM requests WHERE status='pending'");
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE conversationId=?",
        id,
      )?.status,
      "done",
    );
    app.store.run("INSERT INTO telegram VALUES ('42',?,'7')", id);
    app.store.queueTelegram(
      "command:other",
      "42",
      "Outro resultado",
      4000,
      other,
    );
    await app.deleteConversation(id);
    assert.equal(
      app.store.get<{ state: string }>(
        "SELECT state FROM deliveries WHERE id='command:other:0'",
      )?.state,
      "pending",
    );
    app.restoreConversation(id);
    assert.ok(
      (await app.snapshot(id)).view.entries.some(
        (entry) => entry.kind === "pi.assistant",
      ),
    );
  } finally {
    release();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rename transaction rolls back the title if saving the manual-title marker fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversations-title-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  try {
    const id = await app.create("Antes");
    app.store.db.exec(
      "CREATE TRIGGER reject_title BEFORE INSERT ON conversation_titles BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;",
    );
    assert.throws(
      () => app.renameConversation(id, "Depois"),
      /simulated storage failure/,
    );
    assert.equal(app.listConversations()[0].title, "Antes");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("conversation HTTP mutations require authentication, origin and explicit delete confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversations-http-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(app, {
    password: "test-password-123",
    origin,
    secureCookie: false,
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    requestOrigin = origin,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        cookie,
        origin: requestOrigin,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    const id = await app.create("HTTP");
    assert.equal(
      (await request(`/api/conversations/${id}`, "DELETE", { confirm: true }))
        .status,
      401,
    );
    const login = await request("/api/login", "POST", {
      password: "test-password-123",
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await request(`/api/conversations/${id}`, "PUT", { title: "Renomeada" }))
        .status,
      200,
    );
    assert.equal(
      (
        await request(
          `/api/conversations/${id}`,
          "DELETE",
          { confirm: true },
          "https://evil.test",
        )
      ).status,
      403,
    );
    assert.equal(
      (await request(`/api/conversations/${id}`, "DELETE", {})).status,
      400,
    );
    assert.equal(app.listConversations().length, 1);
    assert.equal(
      (await request(`/api/conversations/${id}`, "DELETE", { confirm: true }))
        .status,
      200,
    );
    assert.equal((await request(`/api/conversations/${id}`)).status, 409);
    assert.equal(
      (
        (await (
          await request("/api/conversations?deleted=1")
        ).json()) as unknown[]
      ).length,
      1,
    );
    assert.equal(
      (await request(`/api/conversations/${id}/restore`, "POST", {})).status,
      200,
    );
    assert.equal((await request(`/api/conversations/${id}`)).status, 200);
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("archive blocks unresolved work without modifying any records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conversations-busy-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  try {
    const id = await app.create("Preservada");
    for (const state of ["pending", "running", "uncertain"]) {
      app.store.run(
        "INSERT INTO actions(id,conversationId,state) VALUES ('blocked',?,?)",
        id,
        state,
      );
      await assert.rejects(
        app.deleteConversation(id),
        /pendente|execução|resol/,
      );
      assert.equal(app.listConversations().length, 1);
      app.store.run("DELETE FROM actions WHERE id='blocked'");
    }
    app.store.db.exec(
      "CREATE TABLE mcp_calls(conversationId TEXT,state TEXT); CREATE TABLE mcp_interactions(conversationId TEXT,state TEXT);",
    );
    for (const state of ["running", "paused", "uncertain"]) {
      app.store.run("INSERT INTO mcp_calls VALUES (?,?)", id, state);
      await assert.rejects(app.deleteConversation(id), /pendente|resolução/);
      app.store.run("DELETE FROM mcp_calls");
    }
    app.store.run("INSERT INTO mcp_interactions VALUES (?,'pending')", id);
    await assert.rejects(app.deleteConversation(id), /pendente|resolução/);
    app.store.run("DELETE FROM mcp_interactions");
    app.store.run(
      "INSERT INTO requests(conversationId,requestId,status) VALUES (?,'busy','pending')",
      id,
    );
    await assert.rejects(app.deleteConversation(id), /pendente|execução/);
    app.store.run("DELETE FROM requests");
    app.store.run(
      "INSERT INTO deliveries(id,chat,text,state) VALUES (?,'42','hello','sending')",
      `${id}:x`,
    );
    await assert.rejects(app.deleteConversation(id), /pendente|execução/);
    assert.equal(app.listConversations().length, 1);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
