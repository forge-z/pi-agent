import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { McpGateway, mcpToolName } from "../src/mcp.js";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";

test("HTTP slash catalogue, command admission, and receipt reads require a session and protect origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slash-http-"));
  const faux = fauxProvider({ models: [{ id: "one", reasoning: true }] });
  faux.setResponses([
    fauxAssistantMessage("The model must not receive slash commands"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await Runtime.open({
    dir,
    models,
    modelId: "one",
    gateway: { call: async () => ({}) },
  });
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(app, {
    password: "slash-test-password",
    origin,
    secureCookie: false,
    publicDir: resolve("public"),
  });
  await new Promise<void>((resolveListen) =>
    web.server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    cookie = "",
    requestOrigin = origin,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" || method === "HEAD"
          ? {}
          : { origin: requestOrigin }),
        ...(cookie ? { cookie } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });

  try {
    const reads = [
      "/api/commands",
      "/api/commands/tasks",
      "/api/conversations/1/commands/help-request",
    ];
    for (const path of reads)
      assert.equal((await request(path)).status, 401, path);

    const login = await request("/api/login", "POST", {
      password: "slash-test-password",
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const catalogue = await request("/api/commands", "GET", undefined, cookie);
    assert.equal(catalogue.status, 200);
    const definitions = (
      (await catalogue.json()) as { commands: Array<{ name: string }> }
    ).commands;
    assert.deepEqual(
      definitions.map(({ name }) => name),
      [
        "agents",
        "model",
        "thinking",
        "compact",
        "tasks",
        "crons",
        "stop",
        "help",
      ],
    );

    const created = await request(
      "/api/conversations",
      "POST",
      { title: "Slash HTTP" },
      cookie,
    );
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };

    const denied = await request(
      `/api/conversations/${id}/messages`,
      "POST",
      { requestId: "wrong-origin", text: "/help" },
      cookie,
      "https://evil.test",
    );
    assert.equal(denied.status, 403);
    assert.equal(app.store.all("SELECT * FROM command_receipts").length, 0);

    const admittedResponse = await request(
      `/api/conversations/${id}/messages`,
      "POST",
      { requestId: "help-request", text: "/help" },
      cookie,
    );
    assert.equal(admittedResponse.status, 202);
    const admitted = (await admittedResponse.json()) as {
      kind: string;
      command: string;
      text: string;
    };
    assert.equal(admitted.kind, "command");
    assert.equal(admitted.command, "help");

    const receiptResponse = await request(
      `/api/conversations/${id}/commands/help-request`,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(receiptResponse.status, 200);
    const receipt = (await receiptResponse.json()) as typeof admitted;
    assert.equal(receipt.kind, "command");
    assert.equal(receipt.command, "help");
    assert.equal(receipt.text, admitted.text);
    assert.equal(
      (
        await request(
          `/api/conversations/${id}/commands/missing`,
          "GET",
          undefined,
          cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      Array.isArray(
        await (
          await request("/api/commands/tasks", "GET", undefined, cookie)
        ).json(),
      ),
      true,
    );

    const unknown = await request(
      `/api/conversations/${id}/messages`,
      "POST",
      { requestId: "unknown-request", text: "/not-a-command" },
      cookie,
    );
    assert.equal(unknown.status, 400);
    assert.equal(app.store.all("SELECT * FROM requests").length, 0);
    assert.equal(faux.state.callCount, 0);
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "/stop marks an aborted direct MCP effect uncertain and it is not replayed after restart",
  { timeout: 15000 },
  async () => {
    let effects = 0;
    let started!: () => void;
    const effectStarted = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    let release!: () => void;
    const pendingEffect = new Promise<void>((resolveEffect) => {
      release = resolveEffect;
    });
    const mcp = new McpServer({ name: "slash-stop", version: "1.0.0" });
    mcp.registerTool(
      "execute",
      { inputSchema: { code: z.string() } },
      async ({ code }) => {
        effects++;
        started();
        await pendingEffect;
        return { content: [{ type: "text", text: `executed ${code}` }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
    });
    await mcp.connect(transport);
    const server = createServer(
      (request, response) => void transport.handleRequest(request, response),
    );
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = {
      name: "mock",
      url: `http://127.0.0.1:${address.port}/mcp`,
      readTools: [],
      actionTools: [],
      mode: "direct" as const,
    };
    const dir = await mkdtemp(join(tmpdir(), "pi-slash-stop-"));
    const firstFaux = fauxProvider({
      models: [{ id: "one", reasoning: true }],
    });
    firstFaux.setResponses([
      fauxAssistantMessage(
        {
          type: "toolCall",
          id: "pending-effect",
          name: mcpToolName("mock", "execute"),
          arguments: { code: "write once" },
        },
        { stopReason: "toolUse" },
      ),
    ]);
    const firstModels = createModels();
    firstModels.setProvider(firstFaux.provider);
    let gateway: McpGateway | undefined = new McpGateway([config]);
    let reopenedGateway: McpGateway | undefined;
    let app: Runtime | undefined;

    try {
      app = await Runtime.open({
        dir,
        gateway,
        models: firstModels,
        modelId: "one",
      });
      const id = await app.create("Stop MCP fixture");
      await app.submit(id, "effect-request", "Run the requested operation");
      await effectStarted;

      const stopped = await app.admit(id, "stop-request", "/stop", {
        source: "web",
      });
      assert.equal(stopped.kind, "command");
      assert.equal(stopped.status, "completed");
      await (await app.conversation(id)).waitForIdle(context);
      const call = app.mcpCalls.list(id)[0];
      assert.equal(call?.state, "uncertain");
      assert.equal(effects, 1);

      await app.close();
      app = undefined;
      await gateway.close();
      gateway = undefined;

      const nextFaux = fauxProvider({
        models: [{ id: "one", reasoning: true }],
      });
      nextFaux.setResponses([
        fauxAssistantMessage("The interrupted effect needs verification"),
      ]);
      const nextModels = createModels();
      nextModels.setProvider(nextFaux.provider);
      reopenedGateway = new McpGateway([config]);
      app = await Runtime.open({
        dir,
        gateway: reopenedGateway,
        models: nextModels,
        modelId: "one",
      });
      await (await app.conversation(id)).waitForIdle(context);
      assert.equal(app.mcpCalls.list(id)[0]?.state, "uncertain");
      await assert.rejects(
        app.mcpCalls.execute(id, 999, "mock", "execute", { code: "retry" }),
        /incerto|registre/i,
      );
      assert.equal(effects, 1);
    } finally {
      release();
      await app?.close();
      await gateway?.close();
      await reopenedGateway?.close();
      await mcp.close();
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await rm(dir, { recursive: true, force: true });
    }
  },
);
