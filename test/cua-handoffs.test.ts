import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Store } from "../src/store.js";
import { McpGateway, McpNotSentError, type McpConfig } from "../src/mcp.js";
import { McpCalls } from "../src/mcp-calls.js";
import { CuaHandoffs, type CuaViewerFactory } from "../src/cua-handoffs.js";
import { CuaViewerError } from "../src/cua-viewer.js";
import { Runtime, ConversationBusyError } from "../src/runtime.js";
import { Tasks } from "../src/tasks.js";
import { createAppServer } from "../src/server.js";

const rootToken = "local-root-token-never-provider-visible";
const ticketSecret = "private-human-viewer-ticket";
const config = (extra: Partial<McpConfig> = {}): McpConfig => ({
  name: "cua",
  url: "https://cua.example/mcp",
  mode: "direct",
  readTools: [],
  actionTools: [],
  token: rootToken,
  cuaViewer: true,
  ...extra,
});
function gatewayFixture() {
  const gateway = new McpGateway([
    config(),
    config({
      name: "legacy",
      mode: "legacy",
      readTools: ["read"],
      actionTools: ["write"],
      cuaViewer: false,
    }),
  ]);
  let tools = 0;
  let probe: (() => Promise<void>) | undefined;
  let dispatch: (() => Promise<void>) | undefined;
  const client = {
    callTool: async () => {
      tools++;
      await dispatch?.();
      return { content: [{ type: "text", text: "mock tool result" }] };
    },
  };
  Object.defineProperty(gateway, "client", { value: async () => client });
  Object.defineProperty(gateway, "liveClient", {
    value: async () => {
      await probe?.();
      return client;
    },
  });
  (gateway as unknown as { bindings: WeakMap<object, string> }).bindings.set(
    client,
    gateway.credentialBinding("cua"),
  );
  Object.defineProperty(gateway, "catalog", {
    value: async () => [{ server: "cua", mode: "direct", tools: [] }],
  });
  return {
    gateway,
    get tools() {
      return tools;
    },
    set probe(value: () => Promise<void>) {
      probe = value;
    },
    set dispatch(value: () => Promise<void>) {
      dispatch = value;
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function ticket(principal: string) {
  return {
    url: `https://cua.example/viewer/#ticket=${ticketSecret}&clipboard=0`,
    expiresAt: Date.now() + 1800000,
    principalId: `viewer:${principal}`,
  };
}
async function fixture(
  factory: CuaViewerFactory = () => ({
    createTicket: async (principal) => ticket(principal),
  }),
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-handoff-"));
  const store = new Store(dir);
  const mock = gatewayFixture();
  const calls = new McpCalls(store, mock.gateway);
  let busy = false;
  const handoffs = new CuaHandoffs(
    store,
    mock.gateway,
    async () => busy,
    factory,
  );
  return {
    dir,
    store,
    mock,
    calls,
    handoffs,
    set busy(value: boolean) {
      busy = value;
    },
    async close() {
      await handoffs.close();
      await calls.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("CUA opt-in is explicit, HTTPS /mcp only, and privately pins one tokenFile read", async () => {
  for (const url of [
    "http://localhost/mcp",
    "https://cua.example/other",
    "https://cua.example/mcp?secret=x",
    "https://user:pw@cua.example/mcp",
  ])
    assert.throws(() => new McpGateway([config({ url })]));
  assert.throws(
    () => new McpGateway([config({ cuaViewer: "yes" as unknown as boolean })]),
  );
  assert.throws(
    () => new McpGateway([config({ mode: "legacy", cuaViewer: true })]),
  );
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-token-"));
  try {
    const path = join(dir, "token");
    await writeFile(path, rootToken);
    const gateway = new McpGateway([
      config({ token: undefined, tokenFile: path }),
    ]);
    const value = gateway.viewerCredential("cua");
    assert.equal(value.token, rootToken);
    assert.equal(value.binding, gateway.credentialBinding("cua"));
    assert.throws(() =>
      new McpGateway([config({ token: undefined })]).viewerCredential("cua"),
    );
    assert.throws(() =>
      new McpGateway([config({ cuaViewer: false })]).viewerCredential("cua"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idempotent handoff result contains no viewer access; persistent origin hold covers direct and legacy aliases", async () => {
  const f = await fixture();
  try {
    const request = f.handoffs.request("1", 10, "cua");
    assert.deepEqual(f.handoffs.request("1", 10, "cua"), request);
    assert.throws(() => f.handoffs.request("2", 11, "cua"), /Já existe/);
    await assert.rejects(
      f.mock.gateway.callDirect("cua", "write", {}),
      McpNotSentError,
    );
    await assert.rejects(
      f.mock.gateway.call("legacy", "read", {}, "read"),
      McpNotSentError,
    );
    await assert.rejects(
      f.mock.gateway.call("legacy", "write", {}, "action"),
      McpNotSentError,
    );
    const active = await f.handoffs.create("1", request.id);
    assert.equal(active.state, "active");
    assert.match(active.url!, /private-human/);
    const serialized = JSON.stringify(f.handoffs.request("1", 10, "cua"));
    assert.ok(!serialized.includes(ticketSecret));
    assert.ok(!serialized.includes(rootToken));
    assert.ok(!serialized.includes("https:"));
    await assert.rejects(
      f.handoffs.create("1", request.id),
      /não será emitido novamente/,
    );
    assert.throws(
      () =>
        f.handoffs.end("2", request.id, {
          allTabsClosed: true,
          controlReturned: true,
        }),
      /não encontrada/,
    );
    assert.throws(
      () => f.handoffs.end("1", request.id, { allTabsClosed: true }),
      /Confirme/,
    );
    // Expiry does not release control or remove the explicit acknowledgments.
    f.store.run("UPDATE cua_handoffs SET expiresAt=1 WHERE id=?", request.id);
    assert.equal(f.handoffs.holds("1"), true);
    assert.equal(f.handoffs.list("1")[0].url, null);
    const ended = f.handoffs.end("1", request.id, {
      allTabsClosed: true,
      controlReturned: true,
    });
    assert.equal(ended.state, "ended");
    assert.equal(ended.url, null);
    assert.equal(
      f.store.get<{ url: string | null }>(
        "SELECT url FROM cua_handoffs WHERE id=?",
        request.id,
      )!.url,
      null,
    );
    await f.mock.gateway.call("legacy", "write", {}, "action");
    assert.equal(f.mock.tools, 1);
  } finally {
    await f.close();
  }
});

test("inside-queue gate prevents a call admitted before handoff from dispatching after its probe", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  f.mock.probe = async () => {
    entered.resolve();
    await release.promise;
  };
  try {
    const send = f.mock.gateway.callDirect("cua", "write", {});
    const rejected = assert.rejects(send, McpNotSentError);
    await entered.promise;
    const request = f.handoffs.request("1", 21, "cua");
    release.resolve();
    await rejected;
    assert.equal(f.mock.tools, 0);
    f.handoffs.end("1", request.id, { cancel: true });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("inflight tools and pending/uncertain effects prevent handoff and mint without any viewer RPC", async () => {
  let creates = 0;
  const f = await fixture(() => ({
    createTicket: async (principal) => {
      creates++;
      return ticket(principal);
    },
  }));
  const entered = deferred(),
    release = deferred();
  try {
    f.mock.dispatch = async () => {
      entered.resolve();
      await release.promise;
    };
    const send = f.mock.gateway.call("legacy", "write", {}, "action");
    await entered.promise;
    assert.throws(() => f.handoffs.request("1", 31, "cua"), /Aguarde/);
    release.resolve();
    await send;
    f.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES ('action','2','legacy','write','{}','uncertain')",
    );
    assert.throws(() => f.handoffs.request("1", 32, "cua"), /Aguarde/);
    f.store.run("DELETE FROM actions");
    const request = f.handoffs.request("1", 33, "cua");
    f.busy = true;
    await assert.rejects(f.handoffs.create("1", request.id), /Aguarde/);
    assert.equal(f.handoffs.list("1")[0].state, "pending");
    f.busy = false;
    f.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES ('action','2','legacy','write','{}','pending')",
    );
    await assert.rejects(f.handoffs.create("1", request.id), /Aguarde/);
    assert.equal(creates, 0);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("concurrent mint is single-dispatch; dispatched failures, binding changes and restart remain held without retry", async () => {
  const entered = deferred(),
    release = deferred();
  let creates = 0;
  const f = await fixture(() => ({
    createTicket: async () => {
      creates++;
      entered.resolve();
      await release.promise;
      throw new CuaViewerError("upstream secret: " + rootToken, true);
    },
  }));
  try {
    const request = f.handoffs.request("1", 40, "cua");
    const create = f.handoffs.create("1", request.id);
    const rejected = assert.rejects(
      create,
      (error) => error instanceof Error && !error.message.includes(rootToken),
    );
    await entered.promise;
    await assert.rejects(
      f.handoffs.create("1", request.id),
      /não será emitido novamente/,
    );
    assert.throws(
      () =>
        f.handoffs.end("1", request.id, {
          allTabsClosed: true,
          controlReturned: true,
        }),
      /não pode ser liberado/,
    );
    release.resolve();
    await rejected;
    assert.equal(creates, 1);
    assert.equal(f.handoffs.list("1")[0].state, "uncertain");
    const reopened = new CuaHandoffs(
      f.store,
      f.mock.gateway,
      async () => false,
      () => ({
        createTicket: async () => {
          creates++;
          throw new Error("should never run");
        },
      }),
    );
    await assert.rejects(
      reopened.create("1", request.id),
      /não será emitido novamente/,
    );
    assert.equal(reopened.holds("1"), true);
    assert.equal(creates, 1);
    await reopened.close();
  } finally {
    release.resolve();
    await f.close();
  }
});

test("creating crash, postmint storage error and token rotation all fail closed", async () => {
  const f = await fixture();
  try {
    const request = f.handoffs.request("1", 50, "cua");
    f.store.run(
      "UPDATE cua_handoffs SET state='creating' WHERE id=?",
      request.id,
    );
    const reopened = new CuaHandoffs(
      f.store,
      f.mock.gateway,
      async () => false,
    );
    assert.equal(reopened.list("1")[0].state, "uncertain");
    assert.throws(
      () => reopened.end("1", request.id, { cancel: true }),
      /não pode ser liberado/,
    );
    await reopened.close();
  } finally {
    await f.close();
  }
  const storage = await fixture();
  try {
    const request = storage.handoffs.request("1", 51, "cua");
    storage.store.db.exec(
      "CREATE TRIGGER reject_active BEFORE UPDATE ON cua_handoffs WHEN NEW.state='active' BEGIN SELECT RAISE(ABORT,'mock disk write failure'); END",
    );
    await assert.rejects(
      storage.handoffs.create("1", request.id),
      /Criação do acesso CUA falhou/,
    );
    assert.equal(storage.handoffs.list("1")[0].state, "uncertain");
    assert.equal(storage.handoffs.list("1")[0].url, null);
  } finally {
    await storage.close();
  }
  const rotated = await fixture();
  try {
    const request = rotated.handoffs.request("1", 52, "cua");
    await rotated.handoffs.create("1", request.id);
    rotated.mock.gateway.config[0].token = "different-local-token";
    assert.throws(
      () =>
        rotated.handoffs.end("1", request.id, {
          allTabsClosed: true,
          controlReturned: true,
        }),
      /Conexão CUA mudou/,
    );
    assert.equal(rotated.handoffs.list("1")[0].state, "uncertain");
    assert.equal(rotated.handoffs.list("1")[0].url, null);
  } finally {
    await rotated.close();
  }
});

async function settle(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  for (let n = 0; n < 100; n++) {
    if (
      !app.store.get(
        "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
        id,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("runtime monitor did not settle");
}

test("native tool creates private human request, blocks later ALL owner tools, admissions and calendar claims across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-runtime-"));
  const mock = gatewayFixture();
  const faux = fauxProvider();
  const transcripts: string[] = [];
  faux.setResponses([
    async (transcript) => {
      transcripts.push(JSON.stringify(transcript));
      assert.ok(
        getCurrentTools(transcript.messages).some(
          (tool) => tool.name === "cua_request_handoff",
        ),
      );
      return fauxAssistantMessage(
        {
          type: "toolCall",
          id: "handoff-request",
          name: "cua_request_handoff",
          arguments: { server: "cua" },
        },
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage(
      {
        type: "toolCall",
        id: "blocked-task-list",
        name: "tasks_list",
        arguments: {},
      },
      { stopReason: "toolUse" },
    ),
    async (transcript) => {
      transcripts.push(JSON.stringify(transcript));
      return fauxAssistantMessage("Awaiting the human interface.");
    },
    fauxAssistantMessage("Control returned."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let creates = 0;
  const factory: CuaViewerFactory = () => ({
    createTicket: async (principal) => {
      creates++;
      return ticket(principal);
    },
  });
  let app = await Runtime.open({
    dir,
    gateway: mock.gateway,
    models,
    cuaViewerFactory: factory,
  });
  try {
    const id = await app.create();
    await app.submit(
      id,
      "human-handoff",
      "I need to enter private information in CUA myself.",
    );
    await settle(app, id);
    const request = app.cuaHandoffs!.list(id)[0];
    assert.equal(request.state, "pending");
    assert.ok(transcripts.some((text) => text.includes("Conversa pausada")));
    await assert.rejects(
      app.submit(id, "blocked", "continue"),
      ConversationBusyError,
    );
    await assert.rejects(
      app.admit(id, "blocked-command", "/help", { source: "web" }),
      ConversationBusyError,
    );
    const epoch = Date.now();
    let now = epoch;
    const tasks = new Tasks(app, () => now);
    const task = await tasks.create({
      conversationId: id,
      title: "Held once",
      prompt: "do the task",
      kind: "once",
      schedule: new Date(epoch + 1000).toISOString(),
      timezone: "UTC",
    });
    now = epoch + 2000;
    await tasks.tick();
    assert.equal(tasks.get(task.id)!.nextRun, epoch + 1000);
    assert.equal(
      app.store.get("SELECT 1 FROM task_runs WHERE taskId=?", task.id),
      undefined,
    );
    await tasks.close();
    await assert.rejects(
      app.settings.saveMcp([config()]),
      /intervenção humana CUA/,
    );
    const active = await app.cuaHandoffs!.create(id, request.id);
    assert.equal(creates, 1);
    assert.match(active.url!, /private-human/);
    assert.ok(!JSON.stringify(transcripts).includes(ticketSecret));
    assert.ok(!JSON.stringify(transcripts).includes(rootToken));
    await app.close();
    app = await Runtime.open({
      dir,
      gateway: mock.gateway,
      models,
      cuaViewerFactory: factory,
    });
    assert.equal(app.cuaHandoffs!.list(id)[0].state, "active");
    await assert.rejects(
      app.submit(id, "blocked-restart", "continue"),
      ConversationBusyError,
    );
    await assert.rejects(
      mock.gateway.call("legacy", "write", {}, "action"),
      McpNotSentError,
    );
    assert.equal(creates, 1);
    app.cuaHandoffs!.end(id, request.id, {
      allTabsClosed: true,
      controlReturned: true,
    });
    await app.submit(id, "returned", "continue");
    await settle(app, id);
    assert.equal(mock.tools, 0);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP mint/end require authenticated same-origin human and exact conversation ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-http-"));
  const mock = gatewayFixture();
  let creates = 0;
  const app = await Runtime.open({
    dir,
    gateway: mock.gateway,
    cuaViewerFactory: () => ({
      createTicket: async (principal) => {
        creates++;
        return ticket(principal);
      },
    }),
  });
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
  const post = (
    path: string,
    input: unknown,
    cookie = "",
    requestOrigin = origin,
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: requestOrigin,
        cookie,
      },
      body: JSON.stringify(input),
    });
  try {
    const id = await app.create(),
      other = await app.create();
    const request = app.cuaHandoffs!.request(id, 60, "cua");
    const path = `/api/conversations/${id}/cua-handoffs/${request.id}`;
    assert.equal((await post(path + "/create", {})).status, 401);
    const login = await post("/api/login", { password: "test-password-123" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await post(path + "/create", {}, cookie, "https://evil.example")).status,
      403,
    );
    assert.equal(
      (
        await post(
          `/api/conversations/${other}/cua-handoffs/${request.id}/create`,
          {},
          cookie,
        )
      ).status,
      400,
    );
    assert.equal(creates, 0);
    const created = await post(path + "/create", {}, cookie);
    assert.equal(created.status, 200);
    assert.match(
      JSON.stringify(await created.json()),
      /private-human-viewer-ticket/,
    );
    assert.equal(creates, 1);
    assert.equal((await post(path + "/create", {}, cookie)).status, 400);
    assert.equal(
      (await post(path + "/end", { allTabsClosed: true }, cookie)).status,
      400,
    );
    assert.equal(
      (
        await post(
          path + "/end",
          { allTabsClosed: true, controlReturned: true },
          cookie,
        )
      ).status,
      200,
    );
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("proven local RPC rejection keeps pending; close drains a mint preflight and never dispatches it", async () => {
  const local = await fixture(() => ({
    createTicket: async () => {
      throw new CuaViewerError("local validation", false);
    },
  }));
  try {
    const request = local.handoffs.request("1", 70, "cua");
    await assert.rejects(
      local.handoffs.create("1", request.id),
      /Criação do acesso CUA falhou/,
    );
    assert.equal(local.handoffs.list("1")[0].state, "pending");
    local.handoffs.end("1", request.id, { cancel: true });
    assert.equal(local.handoffs.holds("1"), false);
  } finally {
    await local.close();
  }
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let creates = 0;
  const handoffs = new CuaHandoffs(
    f.store,
    f.mock.gateway,
    async () => {
      entered.resolve();
      await release.promise;
      return false;
    },
    () => ({
      createTicket: async (principal) => {
        creates++;
        return ticket(principal);
      },
    }),
  );
  try {
    const request = handoffs.request("1", 71, "cua");
    const creation = handoffs.create("1", request.id);
    const rejected = assert.rejects(creation, /Aguarde/);
    await entered.promise;
    let drained = false;
    const close = handoffs.close().then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    release.resolve();
    await close;
    await rejected;
    assert.equal(creates, 0);
    assert.equal(handoffs.list("1")[0].state, "pending");
    await assert.rejects(
      handoffs.create("1", request.id),
      /Serviço encerrando/,
    );
    assert.equal(handoffs.holds("1"), true);
  } finally {
    release.resolve();
    await handoffs.close();
    await f.close();
  }
});

test("startup reattaches existing held request settlement but does not admit an unsent pending request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-recovery-"));
  const mock = gatewayFixture();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("Original finished."),
    fauxAssistantMessage("Explicit retry finished."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const factory: CuaViewerFactory = () => ({
    createTicket: async (principal) => ticket(principal),
  });
  let app = await Runtime.open({
    dir,
    gateway: mock.gateway,
    models,
    cuaViewerFactory: factory,
  });
  try {
    const settledId = await app.create();
    await app.submit(
      settledId,
      "settled-before-crash",
      "original accepted request",
    );
    await settle(app, settledId);
    const request = app.cuaHandoffs!.request(settledId, 80, "cua");
    app.store.run(
      "UPDATE requests SET status='pending',submissionId=NULL WHERE conversationId=?",
      settledId,
    );
    await app.close();
    app = await Runtime.open({
      dir,
      gateway: mock.gateway,
      models,
      cuaViewerFactory: factory,
    });
    await settle(app, settledId);
    assert.equal(faux.state.callCount, 1);
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE conversationId=?",
        settledId,
      )!.status,
      "done",
    );
    await app.cuaHandoffs!.create(settledId, request.id);
    app.cuaHandoffs!.end(settledId, request.id, {
      allTabsClosed: true,
      controlReturned: true,
    });
    const unsentId = await app.create();
    const unsent = app.cuaHandoffs!.request(unsentId, 81, "cua");
    app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,status) VALUES (?,'unsent-before-crash','prior accepted input','web','pending')",
      unsentId,
    );
    await app.close();
    app = await Runtime.open({
      dir,
      gateway: mock.gateway,
      models,
      cuaViewerFactory: factory,
    });
    assert.equal(faux.state.callCount, 1);
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE conversationId=?",
        unsentId,
      )!.status,
      "pending",
    );
    app.cuaHandoffs!.end(unsentId, unsent.id, { cancel: true });
    assert.equal(faux.state.callCount, 1); // End itself only releases the hold.
    await app.submit(unsentId, "unsent-before-crash", "prior accepted input");
    await settle(app, unsentId);
    assert.equal(faux.state.callCount, 2);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("held calendars preserve both cron and once occurrence timestamps and pending manual run receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-calendar-"));
  const mock = gatewayFixture();
  const app = await Runtime.open({ dir, gateway: mock.gateway });
  let tasks: Tasks | undefined;
  try {
    const id = await app.create();
    const epoch = Date.now();
    let now = epoch;
    tasks = new Tasks(app, () => now);
    const once = await tasks.create({
      conversationId: id,
      title: "Once",
      prompt: "once",
      kind: "once",
      schedule: new Date(epoch + 1000).toISOString(),
      timezone: "UTC",
    });
    const cron = await tasks.create({
      conversationId: id,
      title: "Cron",
      prompt: "cron",
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
    });
    const request = app.cuaHandoffs!.request(id, 90, "cua");
    now = epoch + 120000;
    await tasks.tick();
    assert.equal(tasks.get(once.id)!.nextRun, once.nextRun);
    assert.equal(tasks.get(cron.id)!.nextRun, cron.nextRun);
    assert.equal(app.store.get("SELECT 1 FROM task_runs"), undefined);
    const manual = await tasks.runNow(once.id, "human-manual");
    assert.equal(manual.state, "pending");
    assert.equal(
      app.store.get(
        "SELECT 1 FROM requests WHERE requestId=?",
        manual.requestId,
      ),
      undefined,
    );
    app.cuaHandoffs!.end(id, request.id, { cancel: true });
    await tasks.tick();
    await settle(app, id);
    await tasks.tick();
    assert.equal(
      app.store.get<{ state: string }>(
        "SELECT state FROM task_runs WHERE id=?",
        manual.id,
      )!.state,
      "done",
    );
    assert.ok(
      app.store.get(
        "SELECT 1 FROM requests WHERE requestId=?",
        manual.requestId,
      ),
    );
    assert.equal(tasks.get(once.id)!.nextRun, null);
    assert.ok(tasks.get(cron.id)!.nextRun! > now);
  } finally {
    await tasks?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
