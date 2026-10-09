import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  Runtime,
  ConversationBusyError,
  type RuntimeOptions,
} from "../src/runtime.js";
import { McpGateway, type McpConfig } from "../src/mcp.js";
import type { Action } from "../src/store.js";
import type { McpCall } from "../src/mcp-calls.js";
import { Telegram } from "../src/telegram.js";
import { createAppServer } from "../src/server.js";

async function nativeFixture(steps: FauxResponseStep[] = []) {
  const counts = { writes: 0, resumes: 0, pauses: 0, tickets: 0 };
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers: McpServer[] = [];
  const http = createServer((request, response) => {
    void (async () => {
      let transport = transports.get(
        String(request.headers["mcp-session-id"] ?? ""),
      );
      if (!transport) {
        const server = new McpServer({
          name: "other-origin-mock",
          version: "1",
        });
        server.registerTool("read", { inputSchema: {} }, async () => ({
          content: [{ type: "text", text: "current mock context" }],
        }));
        server.registerTool("write", { inputSchema: {} }, async () => {
          counts.writes++;
          return { content: [{ type: "text", text: "saved mock effect" }] };
        });
        server.registerTool("pause", { inputSchema: {} }, async () => {
          counts.pauses++;
          return {
            content: [],
            structuredContent: {
              status: "paused",
              executionId: "local-paused-execution",
              resumePayload: { executionId: "local-paused-execution" },
              interaction: { message: "Explicit resume required" },
            },
          };
        });
        server.registerTool("resume", { inputSchema: {} }, async () => {
          counts.resumes++;
          return { content: [{ type: "text", text: "resumed mock effect" }] };
        });
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        servers.push(server);
        await server.connect(transport);
      }
      await transport.handleRequest(request, response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const config: McpConfig[] = [
    {
      name: "cua",
      url: "https://cua.example/mcp",
      mode: "direct",
      readTools: [],
      actionTools: [],
      token: "fake-local-cua-root",
      cuaViewer: true,
    },
    { name: "other", url, mode: "direct", readTools: [], actionTools: [] },
    {
      name: "legacy",
      url,
      mode: "legacy",
      readTools: ["read"],
      actionTools: ["write"],
    },
  ];
  const gateway = new McpGateway(config);
  // Discover the real SDK loopback mock only. No request is sent to the fictional CUA origin.
  Object.defineProperty(gateway, "catalog", {
    value: async () => [
      { server: "cua", mode: "direct", tools: [] },
      {
        server: "other",
        mode: "direct",
        tools: (await gateway.discover("other")).map((tool) => ({
          ...tool,
          operation: "direct",
        })),
      },
      { server: "legacy", mode: "legacy", tools: [] },
    ],
  });
  const faux = fauxProvider();
  faux.setResponses(
    steps.length
      ? steps
      : Array.from({ length: 20 }, () => fauxAssistantMessage("Mock answer.")),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-safety-"));
  const options: RuntimeOptions = {
    dir,
    gateway,
    models,
    cuaViewerFactory: () => ({
      createTicket: async (principal) => {
        counts.tickets++;
        return {
          url: "https://cua.example/viewer/#ticket=fake-local-ticket&clipboard=0",
          expiresAt: Date.now() + 1800000,
          principalId: `viewer:${principal}`,
        };
      },
    }),
  };
  let app = await Runtime.open(options);
  return {
    counts,
    gateway,
    dir,
    models,
    faux,
    options,
    get app() {
      return app;
    },
    async reopen() {
      await app.close();
      app = await Runtime.open(options);
      return app;
    },
    async close() {
      await app.close();
      await gateway.close();
      await Promise.allSettled(servers.map((server) => server.close()));
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function settle(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  for (let n = 0; n < 100; n++) {
    if (
      !app.store.get(
        "SELECT 1 FROM requests WHERE conversationId=? AND status IN ('pending','deferred') AND submissionId IS NOT NULL",
        id,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("settlement monitor did not finish");
}
const ledgerCall = (id: string, conversationId: string): McpCall => ({
  id,
  conversationId,
  server: "other",
  tool: "pause",
  args: "{}",
  state: "reconciled",
  result: JSON.stringify({ verified: "other-origin result" }),
  binding: "local",
  updatedAt: Date.now(),
});
async function nativeEntries(app: Runtime, id: string) {
  return (
    await (await app.conversation(id)).entries({}, 1000, undefined, context)
  ).items;
}

test("owner legacy pending effect and paused native call at another origin prevent both handoff request and mint", async () => {
  const f = await nativeFixture();
  try {
    const id = await f.app.create();
    await f.app.actions.read(id, "legacy", "read", {});
    const action = f.app.actions.propose(id, 100, "legacy", "write", {});
    assert.throws(() => f.app.cuaHandoffs!.request(id, 101, "cua"), /Aguarde/);
    assert.equal(f.app.cuaHandoffs!.list(id).length, 0);
    await f.app.actions.decide(id, action.id, "deny");
    await f.app.mcpCalls.execute(id, 102, "other", "pause", {});
    const paused = f.app.mcpCalls.interactions(id)[0];
    assert.throws(() => f.app.cuaHandoffs!.request(id, 103, "cua"), /Aguarde/);
    assert.equal(f.counts.resumes, 0);
    await f.app.mcpCalls.decide(id, paused.id, "cancel");
    const request = f.app.cuaHandoffs!.request(id, 104, "cua");
    // A legacy imported row added after request still prevents mint, at any owner origin.
    f.app.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES ('older-pending',?,'legacy','write','{}','pending')",
      id,
    );
    await assert.rejects(f.app.cuaHandoffs!.create(id, request.id), /Aguarde/);
    assert.equal(f.app.cuaHandoffs!.list(id)[0].state, "pending");
    assert.equal(f.counts.tickets, 0);
    assert.equal(f.counts.writes, 0);
  } finally {
    await f.close();
  }
});

test("held owner decisions are blocked before any row mutation through HTTP, Telegram and internal APIs; restart preserves them", async () => {
  const f = await nativeFixture();
  let web: ReturnType<typeof createAppServer> | undefined;
  try {
    const app = f.app,
      id = await app.create();
    const request = app.cuaHandoffs!.request(id, 200, "cua");
    // Simulate rows from the earlier release that allowed other-origin pending effects.
    const actionId = "a".repeat(24),
      callId = "b".repeat(24),
      interactionId = randomUUID();
    app.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES (?,?,'legacy','write','{}','pending')",
      actionId,
      id,
    );
    app.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,'other','pause','{}','paused',NULL,?,?)",
      callId,
      id,
      f.gateway.credentialBinding("other"),
      Date.now(),
    );
    app.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,'other','resume',?,'pending',NULL)",
      interactionId,
      callId,
      id,
      JSON.stringify({ executionId: "local-paused-execution" }),
    );
    const initialActions = app.store.actions(id),
      initialCalls = app.mcpCalls.list(id),
      initialInteractions = app.mcpCalls.interactions(id);
    for (const decision of ["approve", "deny"] as const)
      await assert.rejects(
        app.actions.decide(id, actionId, decision),
        ConversationBusyError,
      );
    assert.throws(
      () => app.actions.reconcile(id, actionId, "checked"),
      ConversationBusyError,
    );
    for (const decision of ["accept", "decline", "cancel"] as const)
      await assert.rejects(
        app.mcpCalls.decide(id, interactionId, decision),
        ConversationBusyError,
      );
    assert.throws(
      () => app.mcpCalls.reconcile(id, callId, "checked"),
      ConversationBusyError,
    );
    await assert.rejects(
      app.mcpCalls.execute(id, 201, "other", "write", {}),
      ConversationBusyError,
    );
    const telegram = new Telegram(
      app,
      { send: async () => ({ ok: true }) },
      ["7"],
      ["9"],
    );
    app.store.run("INSERT INTO telegram VALUES ('9',?,'7')", id);
    app.store.run("INSERT INTO telegram_grants VALUES ('9','7',?)", id);
    for (const [n, decision] of ["approve", "deny"].entries())
      await assert.rejects(
        telegram.receive({
          update_id: 400 + n,
          message: {
            message_id: 400 + n,
            text: `/${decision} ${actionId}`,
            from: { id: 7 },
            chat: { id: 9, type: "private" },
          },
        }),
        ConversationBusyError,
      );
    const origin = "http://127.0.0.1:3000";
    web = createAppServer(app, {
      password: "local-test-password",
      origin,
      secureCookie: false,
    });
    await new Promise<void>((resolve) =>
      web!.server.listen(0, "127.0.0.1", resolve),
    );
    const address = web.server.address();
    assert.ok(address && typeof address === "object");
    const post = (path: string, data: unknown, cookie = "") =>
      fetch(`http://127.0.0.1:${address.port}` + path, {
        method: "POST",
        headers: { origin, "content-type": "application/json", cookie },
        body: JSON.stringify(data),
      });
    const login = await post("/api/login", { password: "local-test-password" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const decision of ["approve", "deny", "reconcile"])
      assert.equal(
        (
          await post(
            `/api/conversations/${id}/actions/${actionId}`,
            { decision, note: "checked" },
            cookie,
          )
        ).status,
        409,
      );
    assert.equal(
      (
        await post(
          `/api/conversations/${id}/mcp-interactions/${interactionId}`,
          { action: "accept" },
          cookie,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await post(
          `/api/conversations/${id}/mcp-calls/${callId}/reconcile`,
          { note: "checked" },
          cookie,
        )
      ).status,
      409,
    );
    assert.deepEqual(app.store.actions(id), initialActions);
    assert.deepEqual(app.mcpCalls.list(id), initialCalls);
    assert.deepEqual(app.mcpCalls.interactions(id), initialInteractions);
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.resumes, 0);
    await web.close();
    web = undefined;
    await f.reopen();
    assert.deepEqual(f.app.store.actions(id), initialActions);
    assert.deepEqual(f.app.mcpCalls.list(id), initialCalls);
    assert.deepEqual(f.app.mcpCalls.interactions(id), initialInteractions);
    await assert.rejects(
      f.app.actions.decide(id, actionId, "approve"),
      ConversationBusyError,
    );
    await assert.rejects(
      f.app.mcpCalls.decide(id, interactionId, "accept"),
      ConversationBusyError,
    );
    f.app.cuaHandoffs!.end(id, request.id, { cancel: true });
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.resumes, 0);
    await f.app.actions.decide(id, actionId, "approve");
    await f.app.mcpCalls.decide(id, interactionId, "accept");
    assert.equal(f.counts.writes, 1);
    assert.equal(f.counts.resumes, 1);
  } finally {
    await web?.close();
    await f.close();
  }
});

test("deferred outcome callbacks survive end and restart without model runs; the next human prompt writes each outcome once and retains human-tool permission", async () => {
  const transcripts: string[] = [];
  const f = await nativeFixture([
    async (transcript) => {
      transcripts.push(JSON.stringify(transcript));
      return fauxAssistantMessage(
        {
          type: "toolCall",
          id: "human-agenda",
          name: "tasks_create",
          arguments: {
            title: "Explicit human task",
            prompt: "Summarize later",
            kind: "once",
            schedule: new Date(Date.now() + 3600000).toISOString(),
            timezone: "UTC",
          },
        },
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Human task created."),
  ]);
  try {
    let app = f.app;
    const id = await app.create(),
      request = app.cuaHandoffs!.request(id, 300, "cua");
    const action: Action = {
      id: "c".repeat(24),
      conversationId: id,
      server: "legacy",
      tool: "write",
      args: "{}",
      state: "denied",
      result: null,
      evidence: "{}",
    };
    app.store.run(
      "INSERT INTO actions(id,conversationId,server,tool,args,state) VALUES (?,?,'legacy','write','{}','denied')",
      action.id,
      id,
    );
    const call = ledgerCall("d".repeat(24), id);
    await Promise.all([
      app.recordAction(action),
      app.recordAction(action),
      app.recordMcpOutcome(call),
      app.recordMcpOutcome(call),
    ]);
    assert.equal(
      app.store.all("SELECT 1 FROM requests WHERE status='deferred'").length,
      2,
    );
    assert.equal(f.faux.state.callCount, 0);
    assert.equal((await nativeEntries(app, id)).length, 0);
    app.cuaHandoffs!.end(id, request.id, { cancel: true });
    assert.equal(f.faux.state.callCount, 0);
    app = await f.reopen();
    assert.equal(f.faux.state.callCount, 0);
    assert.equal((await nativeEntries(app, id)).length, 0);
    const rows = app.store.all<{ requestId: string }>(
      "SELECT requestId FROM requests WHERE source='system' AND status='deferred'",
    );
    await assert.rejects(app.submit(id, "invalid request id", "do it"));
    assert.equal((await nativeEntries(app, id)).length, 0);
    await app.submit(id, "human-agenda", "Please schedule the task now.");
    await settle(app, id);
    assert.equal(app.tasks.list().length, 1);
    assert.equal(app.tasks.list()[0].title, "Explicit human task");
    assert.equal(f.faux.state.callCount, 2);
    assert.ok(transcripts[0].includes("other-origin result"));
    assert.ok(transcripts[0].includes(action.id));
    const outcomes = (await nativeEntries(app, id)).filter(
      (entry) => entry.kind === "app.outcome",
    );
    assert.equal(outcomes.length, 2);
    for (const row of rows) {
      const receipt = await app.harness.commit(
        (tx) =>
          tx.submissionByRequest(
            Number(id) as Parameters<typeof tx.submissionByRequest>[0],
            row.requestId,
          ),
        context,
      );
      assert.equal(receipt!.type, "write");
      assert.equal(
        app.store.get<{ status: string }>(
          "SELECT status FROM requests WHERE conversationId=? AND requestId=?",
          id,
          row.requestId,
        )!.status,
        "done",
      );
    }
    await app.recordAction(action);
    await app.recordMcpOutcome(call);
    await settle(app, id);
    assert.equal(f.faux.state.callCount, 2);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      2,
    );
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.resumes, 0);
    assert.equal(f.counts.tickets, 0);
  } finally {
    await f.close();
  }
});

test("a pending callback race is deferred before restart; concurrent prompts deduplicate passive outcomes and bound oversized action context", async () => {
  const f = await nativeFixture();
  try {
    let app = f.app;
    const id = await app.create(),
      request = app.cuaHandoffs!.request(id, 400, "cua");
    const action: Action = {
      id: "e".repeat(24),
      conversationId: id,
      server: "legacy",
      tool: "write",
      args: "{}",
      state: "denied",
      result: JSON.stringify({ base64: "MOCK_OVERSIZED_" + "x".repeat(90000) }),
      evidence: "{}",
    };
    const actionRequest = `action:${action.id}:${action.state}`;
    app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,status) VALUES (?,?,?,'system','pending')",
      id,
      actionRequest,
      "Older persisted exact outcome text",
    );
    await app.recordAction(action);
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId=?",
        actionRequest,
      )!.status,
      "deferred",
    );
    const huge = { ...action, id: "f".repeat(24) };
    await app.recordAction(huge);
    const bounded = app.store.get<{ text: string }>(
      "SELECT text FROM requests WHERE requestId=?",
      `action:${huge.id}:denied`,
    )!.text;
    assert.ok(bounded.length < 28000);
    assert.match(bounded, /truncated/);
    app.cuaHandoffs!.end(id, request.id, { cancel: true });
    app = await f.reopen();
    assert.equal(f.faux.state.callCount, 0);
    await Promise.all([
      app.submit(id, "human-one", "continue one"),
      app.submit(id, "human-two", "continue two"),
    ]);
    await settle(app, id);
    const outcomes = (await nativeEntries(app, id)).filter(
      (entry) => entry.kind === "app.outcome",
    );
    assert.equal(outcomes.length, 2);
    const serialized = JSON.stringify(outcomes);
    assert.ok(serialized.length < 40000);
    assert.match(serialized, /Older persisted exact outcome text/);
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.resumes, 0);
  } finally {
    await f.close();
  }
});

test("deferred receipt recovery retains an already-admitted input type and only reattaches write settlement", async () => {
  const f = await nativeFixture();
  try {
    let app = f.app;
    const id = await app.create();
    const action: Action = {
      id: "9".repeat(24),
      conversationId: id,
      server: "legacy",
      tool: "write",
      args: "{}",
      state: "denied",
      result: null,
      evidence: "{}",
    };
    await app.recordAction(action);
    await settle(app, id);
    assert.equal(f.faux.state.callCount, 1);
    const requestId = `action:${action.id}:denied`;
    const before = await app.harness.commit(
      (tx) =>
        tx.submissionByRequest(
          Number(id) as Parameters<typeof tx.submissionByRequest>[0],
          requestId,
        ),
      context,
    );
    assert.equal(before!.type, "input");
    const request = app.cuaHandoffs!.request(id, 500, "cua");
    app.store.run(
      "UPDATE requests SET status='pending' WHERE requestId=?",
      requestId,
    );
    await app.recordAction(action);
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId=?",
        requestId,
      )!.status,
      "deferred",
    );
    app = await f.reopen();
    await settle(app, id);
    assert.equal(f.faux.state.callCount, 1);
    const after = await app.harness.commit(
      (tx) =>
        tx.submissionByRequest(
          Number(id) as Parameters<typeof tx.submissionByRequest>[0],
          requestId,
        ),
      context,
    );
    assert.equal(after!.type, "input");
    assert.equal(after!.id, before!.id);
    app.cuaHandoffs!.end(id, request.id, { cancel: true });
    await app.submit(id, "after-existing-input", "continue");
    await settle(app, id);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      0,
    );
    // Simulate a crash after passive write admission but before its settlement receipt reached app.sqlite.
    const noteId = "mcp:existing-write:reconciled:local";
    const note = "Already admitted passive outcome";
    app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,status) VALUES (?,?,?,'system','deferred')",
      id,
      noteId,
      note,
    );
    await (
      await app.conversation(id)
    ).submit(
      {
        type: "write",
        requestId: noteId,
        entry: {
          kind: "app.outcome",
          model: [{ role: "user", content: note, timestamp: Date.now() }],
        },
      },
      context,
    );
    const calls = f.faux.state.callCount;
    app = await f.reopen();
    await settle(app, id);
    assert.equal(f.faux.state.callCount, calls);
    assert.equal(
      app.store.get<{ status: string }>(
        "SELECT status FROM requests WHERE requestId=?",
        noteId,
      )!.status,
      "done",
    );
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("invalid, unauthenticated and non-human admissions cannot drain deferred outcomes", async () => {
  const f = await nativeFixture();
  try {
    const app = f.app,
      id = await app.create();
    const request = app.cuaHandoffs!.request(id, 600, "cua");
    const action: Action = {
      id: "8".repeat(24),
      conversationId: id,
      server: "legacy",
      tool: "write",
      args: "{}",
      state: "denied",
      result: null,
      evidence: "{}",
    };
    await app.recordAction(action);
    app.cuaHandoffs!.end(id, request.id, { cancel: true });
    await app.submit(id, "task-only", "non-human task", "task");
    await settle(app, id);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      0,
    );
    await assert.rejects(app.submit(id, "empty-human", ""));
    await assert.rejects(
      app.submit(id, "task-only", "different human content"),
    );
    const checkAuth = f.models.checkAuth;
    f.options.mode = "live";
    f.options.models = undefined;
    Object.defineProperty(f.models, "checkAuth", {
      value: async () => false,
      configurable: true,
    });
    await assert.rejects(
      app.submit(id, "missing-provider-auth", "continue"),
      /Conecte o provider/,
    );
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      0,
    );
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(
      app.store.all("SELECT 1 FROM requests WHERE status='deferred'").length,
      1,
    );
    f.options.models = f.models;
    Object.defineProperty(f.models, "checkAuth", {
      value: checkAuth,
      configurable: true,
    });
    await app.submit(id, "valid-human", "continue");
    await settle(app, id);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      1,
    );
    assert.equal(f.faux.state.callCount, 2);
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.resumes, 0);
  } finally {
    await f.close();
  }
});

test("startup skips deleted owners with deferred input and write receipts; restore retains native receipt identity", async () => {
  const f = await nativeFixture();
  try {
    let app = f.app;
    const inputId = await app.create(),
      writeId = await app.create();
    const action: Action = {
      id: "7".repeat(24),
      conversationId: inputId,
      server: "legacy",
      tool: "write",
      args: "{}",
      state: "denied",
      result: null,
      evidence: "{}",
    };
    await app.recordAction(action);
    await settle(app, inputId);
    const inputRequest = `action:${action.id}:denied`;
    app.store.run(
      "UPDATE requests SET status='deferred' WHERE conversationId=? AND requestId=?",
      inputId,
      inputRequest,
    );
    const writeRequest = "mcp:deleted-write:reconciled:local",
      note = "Previously written result for archived owner";
    app.store.run(
      "INSERT INTO requests(conversationId,requestId,text,source,status) VALUES (?,?,?,'system','deferred')",
      writeId,
      writeRequest,
      note,
    );
    await (
      await (
        await app.conversation(writeId)
      ).submit(
        {
          type: "write",
          requestId: writeRequest,
          entry: {
            kind: "app.outcome",
            model: [{ role: "user", content: note, timestamp: Date.now() }],
          },
        },
        context,
      )
    ).wait(context);
    const inputReceipt = await app.harness.commit(
      (tx) =>
        tx.submissionByRequest(
          Number(inputId) as Parameters<typeof tx.submissionByRequest>[0],
          inputRequest,
        ),
      context,
    );
    const writeReceipt = await app.harness.commit(
      (tx) =>
        tx.submissionByRequest(
          Number(writeId) as Parameters<typeof tx.submissionByRequest>[0],
          writeRequest,
        ),
      context,
    );
    await app.deleteConversation(inputId);
    await app.deleteConversation(writeId);
    const calls = f.faux.state.callCount;
    app = await f.reopen();
    assert.equal(f.faux.state.callCount, calls);
    assert.equal(app.store.conversationDeleted(inputId), true);
    assert.equal(app.store.conversationDeleted(writeId), true);
    assert.equal(
      app.store.all("SELECT 1 FROM requests WHERE status='deferred'").length,
      2,
    );
    app.restoreConversation(inputId);
    app.restoreConversation(writeId);
    await app.submit(inputId, "restored-input-owner", "continue explicitly");
    await settle(app, inputId);
    await app.submit(writeId, "restored-write-owner", "continue explicitly");
    await settle(app, writeId);
    for (const [id, requestId, before] of [
      [inputId, inputRequest, inputReceipt],
      [writeId, writeRequest, writeReceipt],
    ] as const) {
      const after = await app.harness.commit(
        (tx) =>
          tx.submissionByRequest(
            Number(id) as Parameters<typeof tx.submissionByRequest>[0],
            requestId,
          ),
        context,
      );
      assert.equal(after!.id, before!.id);
      assert.equal(after!.type, before!.type);
      assert.equal(
        app.store.get<{ status: string }>(
          "SELECT status FROM requests WHERE conversationId=? AND requestId=?",
          id,
          requestId,
        )!.status,
        "done",
      );
    }
    assert.equal(
      (await nativeEntries(app, inputId)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      0,
    );
    assert.equal(
      (await nativeEntries(app, writeId)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      1,
    );
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.resumes, 0);
  } finally {
    await f.close();
  }
});

test("outcomes arriving during a settings reservation defer without CUA and drain once on the next explicit human prompt", async () => {
  const f = await nativeFixture();
  let release!: () => void;
  try {
    let app = f.app;
    const id = await app.create();
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const change = app.withConversationSettings(id, async () => {
      entered();
      await gate;
    });
    await ready;
    const action: Action = {
      id: "6".repeat(24),
      conversationId: id,
      server: "legacy",
      tool: "write",
      args: "{}",
      state: "denied",
      result: null,
      evidence: "{}",
    };
    const call = ledgerCall("5".repeat(24), id);
    await Promise.all([app.recordAction(action), app.recordMcpOutcome(call)]);
    assert.equal(app.isConversationHeld(id), false);
    const deferred = app.store.all<{ requestId: string }>(
      "SELECT requestId FROM requests WHERE conversationId=? AND status='deferred'",
      id,
    );
    assert.equal(deferred.length, 2);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal((await app.harness.inspect(context)).submissions.length, 0);
    release();
    await change;
    assert.equal(f.faux.state.callCount, 0);
    await app.submit(id, "human-after-settings", "continue explicitly");
    await settle(app, id);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      2,
    );
    assert.equal(f.faux.state.callCount, 1);
    // Reacquiring missed passive settlement receipts remains read-only across restart.
    for (const row of deferred)
      app.store.run(
        "UPDATE requests SET status='deferred' WHERE conversationId=? AND requestId=?",
        id,
        row.requestId,
      );
    app = await f.reopen();
    await settle(app, id);
    assert.equal(f.faux.state.callCount, 1);
    for (const row of deferred)
      assert.equal(
        app.store.get<{ status: string }>(
          "SELECT status FROM requests WHERE conversationId=? AND requestId=?",
          id,
          row.requestId,
        )!.status,
        "done",
      );
    await app.submit(id, "human-after-settings", "continue explicitly");
    await settle(app, id);
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.outcome",
      ).length,
      2,
    );
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.resumes, 0);
  } finally {
    release?.();
    await f.close();
  }
});

test("CUA release feedback waits for a valid human input and cannot release a newer hold or duplicate after a receipt crash", async () => {
  const f = await nativeFixture();
  try {
    let app = f.app;
    const id = await app.create();
    const first = app.cuaHandoffs!.request(id, 900, "cua");
    app.cuaHandoffs!.end(id, first.id, { cancel: true });
    assert.equal(f.faux.state.callCount, 0);
    await app.submit(
      id,
      "scheduled-after-cancel",
      "Previously authorized task",
      "task",
    );
    await settle(app, id);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.cua-control",
      ).length,
      0,
    );
    await assert.rejects(app.submit(id, "invalid input", "continue"));
    await assert.rejects(
      app.submit(id, "revoked-owner", "continue", "web", null, () => {
        throw new Error("mock revoked owner");
      }),
      /revoked owner/,
    );
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.cua-control",
      ).length,
      0,
    );
    const second = app.cuaHandoffs!.request(id, 901, "cua");
    app.cuaHandoffs!.end(id, first.id, {
      allTabsClosed: true,
      controlReturned: true,
    });
    await assert.rejects(
      app.admit(id, "newer-hold", "Continue", { source: "web" }),
      ConversationBusyError,
    );
    assert.equal(app.cuaHandoffs!.list(id)[1].state, "pending");
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.cua-control",
      ).length,
      0,
    );
    app.cuaHandoffs!.end(id, second.id, { cancel: true });
    await Promise.all([
      app.admit(id, "human-one", "Continue one", { source: "web" }),
      app.admit(id, "human-two", "Continue two", { source: "web" }),
    ]);
    await settle(app, id);
    const notes = (await nativeEntries(app, id)).filter(
      (entry) => entry.kind === "app.cua-control",
    );
    assert.equal(notes.length, 2);
    assert.match(JSON.stringify(notes), /requestCancelled/);
    assert.doesNotMatch(
      JSON.stringify(notes),
      /"disposition":"controlReturned"/,
    );
    for (const request of [first, second]) {
      const receipt = await app.harness.commit(
        (tx) =>
          tx.submissionByRequest(
            Number(id) as Parameters<typeof tx.submissionByRequest>[0],
            `cua-control/${request.id}`,
          ),
        context,
      );
      assert.equal(receipt!.type, "write");
      assert.equal(receipt!.status, "done");
    }
    const calls = f.faux.state.callCount;
    app.store.run(
      "UPDATE cua_handoffs SET feedbackSubmissionId=NULL WHERE conversationId=?",
      id,
    );
    app = await f.reopen();
    assert.equal(f.faux.state.callCount, calls);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.cua-control",
      ).length,
      2,
    );
    await app.admit(id, "human-after-receipt-crash", "Continue after restart", {
      source: "web",
    });
    await settle(app, id);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.cua-control",
      ).length,
      2,
    );
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.resumes, 0);
    assert.equal(f.counts.tickets, 0);
  } finally {
    await f.close();
  }
});

test("a queued CUA feedback receipt remains recoverable until its passive history write finishes", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await nativeFixture([
    async () => {
      entered();
      await gate;
      return fauxAssistantMessage("Original request finished.");
    },
    fauxAssistantMessage("Next human request finished."),
  ]);
  try {
    const app = f.app;
    const id = await app.create();
    await app.admit(id, "initial-human", "Start explicitly", { source: "web" });
    await started;
    const request = app.cuaHandoffs!.request(id, 902, "cua");
    app.cuaHandoffs!.end(id, request.id, { cancel: true });
    await app.admit(id, "queued-human", "Continue explicitly", {
      source: "web",
    });
    const receipt = await app.harness.commit(
      (tx) =>
        tx.submissionByRequest(
          Number(id) as Parameters<typeof tx.submissionByRequest>[0],
          `cua-control/${request.id}`,
        ),
      context,
    );
    assert.equal(receipt!.status, "queued");
    assert.equal(
      app.store.get<{ feedbackSubmissionId: number | null }>(
        "SELECT feedbackSubmissionId FROM cua_handoffs WHERE id=?",
        request.id,
      )!.feedbackSubmissionId,
      null,
      "queued is not proof the context has been written",
    );
    release();
    await settle(app, id);
    assert.equal(
      (await nativeEntries(app, id)).filter(
        (entry) => entry.kind === "app.cua-control",
      ).length,
      1,
    );
  } finally {
    release();
    await f.close();
  }
});
