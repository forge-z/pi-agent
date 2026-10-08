import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { McpGateway, type McpConfig } from "../src/mcp.js";
import { Runtime } from "../src/runtime.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), "mock operation did not reach the expected state");
}
async function fixture() {
  const counts = { execute: 0, writes: 0, resumes: 0, read: 0 };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const servers: McpServer[] = [];
  const http = createServer((req, res) => {
    void (async () => {
      let transport = sessions.get(String(req.headers["mcp-session-id"] ?? ""));
      if (!transport) {
        const mcp = new McpServer({ name: "executor-mock", version: "1" });
        mcp.registerTool(
          "execute",
          { inputSchema: { code: z.string() } },
          async ({ code }) => {
            counts.execute++;
            if (code === "unknownpause")
              return { content: [], structuredContent: { status: "paused" } };
            if (code === "withdraw") {
              const controller = new AbortController();
              setTimeout(() => controller.abort(), 50);
              await mcp.server
                .elicitInput(
                  {
                    message: "Temporary permission request",
                    requestedSchema: { type: "object", properties: {} },
                  },
                  { signal: controller.signal },
                )
                .catch(() => {});
              await new Promise((resolve) => setTimeout(resolve, 100));
              return {
                content: [{ type: "text", text: "permission withdrawn" }],
              };
            }
            if (code === "pause" || code === "pause-large")
              return {
                content: [],
                structuredContent: {
                  status: "paused",
                  executionId:
                    code === "pause-large" ? "large-execution" : "execution-1",
                  resumePayload: {
                    executionId:
                      code === "pause-large"
                        ? "large-execution"
                        : "execution-1",
                  },
                  interaction: { message: "Approve the mock operation" },
                },
              };
            if (code === "form" || code === "url") {
              const decision = await mcp.server.elicitInput(
                code === "url"
                  ? {
                      mode: "url",
                      url: "https://service.example/approve",
                      elicitationId: "mock-url",
                      message: "Complete the mock interaction",
                    }
                  : {
                      message: "Approve mock write",
                      requestedSchema: {
                        type: "object",
                        properties: { confirmed: { type: "boolean" } },
                        required: ["confirmed"],
                      },
                    },
                { timeout: 10000 },
              );
              if (
                decision.action !== "accept" ||
                (code === "form" && !decision.content?.confirmed)
              )
                return { content: [{ type: "text", text: "declined" }] };
            }
            if (code === "read") counts.read++;
            else counts.writes++;
            if (code === "crash") await new Promise(() => {});
            return {
              content: [
                {
                  type: "text",
                  text: code === "read" ? "context" : "completed",
                },
              ],
            };
          },
        );
        mcp.registerTool(
          "resume",
          {
            inputSchema: {
              executionId: z.string(),
              action: z.enum(["accept", "decline", "cancel"]),
              content: z.string().optional(),
            },
          },
          async ({ action, executionId }) => {
            counts.resumes++;
            if (action === "accept") counts.writes++;
            return {
              content: [
                {
                  type: "text",
                  text:
                    executionId === "large-execution"
                      ? "x".repeat(40000)
                      : action === "accept"
                        ? "completed"
                        : "declined",
                },
              ],
            };
          },
        );
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        servers.push(mcp);
        await mcp.connect(transport);
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const config: McpConfig = {
    name: "mock",
    url: `http://127.0.0.1:${address.port}/mcp`,
    mode: "direct",
    readTools: [],
    actionTools: [],
  };
  return {
    counts,
    config,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

test("native MCP permission requests wait for human input; accept once, deny and URL cancel are honored", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "pi-mcp-permissions-"));
  const gateway = new McpGateway([f.config]);
  const app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    const first = app.mcpCalls.execute(id, 100, "mock", "execute", {
      code: "form",
    });
    await until(() =>
      app.mcpCalls.interactions(id).some((i) => i.state === "pending"),
    );
    assert.equal(f.counts.writes, 0);
    const request = app.mcpCalls
      .interactions(id)
      .find((i) => i.state === "pending")!;
    await assert.rejects(
      app.mcpCalls.decide(id, request.id, "accept", { confirmed: "yes" }),
      /campos/,
    );
    await assert.rejects(
      app.mcpCalls.decide("999", request.id, "accept", { confirmed: true }),
      /não encontrada/,
    );
    await Promise.all([
      app.mcpCalls.decide(id, request.id, "accept", { confirmed: true }),
      app.mcpCalls.decide(id, request.id, "accept", { confirmed: true }),
    ]);
    await first;
    assert.equal(f.counts.writes, 1);
    assert.equal(app.mcpCalls.list(id)[0].state, "done");
    const denied = app.mcpCalls.execute(id, 101, "mock", "execute", {
      code: "form",
    });
    await until(() =>
      app.mcpCalls.interactions(id).some((i) => i.state === "pending"),
    );
    await app.mcpCalls.decide(
      id,
      app.mcpCalls.interactions(id).find((i) => i.state === "pending")!.id,
      "decline",
    );
    await denied;
    assert.equal(f.counts.writes, 1);
    const url = app.mcpCalls.execute(id, 102, "mock", "execute", {
      code: "url",
    });
    await until(() =>
      app.mcpCalls.interactions(id).some((i) => i.state === "pending"),
    );
    await app.mcpCalls.decide(
      id,
      app.mcpCalls.interactions(id).find((i) => i.state === "pending")!.id,
      "cancel",
    );
    await url;
    assert.equal(f.counts.writes, 1);
  } finally {
    await app.close();
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Executor pause survives restart; only an explicit human decision calls resume and duplicate acceptance is idempotent", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "pi-mcp-resume-"));
  let gateway = new McpGateway([f.config]),
    app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    await app.mcpCalls.execute(id, 200, "mock", "execute", { code: "pause" });
    assert.equal(app.mcpCalls.list(id)[0].state, "paused");
    assert.equal(f.counts.writes, 0);
    const pending = app.mcpCalls.interactions(id)[0];
    await assert.rejects(
      app.mcpCalls.execute(id, 199, "mock", "execute", { code: "pause" }),
      /pendente/,
    );
    assert.equal(
      f.counts.execute,
      1,
      "a pending handoff must block a second browser execution",
    );
    await assert.rejects(
      app.mcpCalls.execute(id, 201, "mock", "resume", {
        executionId: "execution-1",
        action: "accept",
      }),
      /pendente|Retomadas/,
    );
    await app.close();
    await gateway.close();
    gateway = new McpGateway([f.config]);
    app = await Runtime.open({ dir, gateway });
    assert.equal(app.mcpCalls.interactions(id)[0].state, "pending");
    assert.equal(f.counts.execute, 1);
    await Promise.all([
      app.mcpCalls.decide(id, pending.id, "accept"),
      app.mcpCalls.decide(id, pending.id, "accept"),
    ]);
    assert.equal(f.counts.writes, 1);
    assert.equal(f.counts.resumes, 1);
    assert.equal(app.mcpCalls.list(id)[0].state, "done");
    await app.mcpCalls.execute(id, 202, "mock", "execute", { code: "pause" });
    const declined = app.mcpCalls
      .interactions(id)
      .find((i) => i.state === "pending")!;
    await app.mcpCalls.decide(id, declined.id, "decline");
    assert.equal(f.counts.writes, 1);
    assert.equal(f.counts.resumes, 2);
    await assert.rejects(
      app.mcpCalls.execute(id, 203, "mock", "resume", {
        executionId: "execution-1",
        action: "accept",
      }),
      /Retomadas/,
    );
  } finally {
    await app.close();
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy settings require explicit migration and retain the original allowed tools", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "pi-mcp-migration-"));
  const legacy = {
    ...f.config,
    mode: "legacy" as const,
    readTools: ["execute"],
    actionTools: [],
  };
  const gateway = new McpGateway([legacy]);
  const app = await Runtime.open({ dir, gateway });
  try {
    await assert.rejects(
      app.settings.saveMcp([{ ...legacy, mode: "direct" }]),
      /explicitamente/,
    );
    assert.equal(gateway.config[0].mode, "legacy");
    await app.settings.saveMcp([
      { ...legacy, mode: "direct", migrateLegacy: true },
    ]);
    assert.deepEqual(gateway.config[0].allowedTools, ["execute"]);
    assert.equal(app.mcpStatus[0].tools.length, 1);
    await assert.rejects(
      gateway.callDirect("mock", "resume", {
        executionId: "x",
        action: "accept",
      }),
      /restrições/,
    );
  } finally {
    await app.close();
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "SIGKILL during a direct Durable MCP effect produces an uncertain trace and never replays the effect",
  { timeout: 45000 },
  async () => {
    const f = await fixture(),
      dir = await mkdtemp(join(tmpdir(), "pi-mcp-crash-"));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "test/mcp-crash-child.ts", dir, f.config.url],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let app: Runtime | undefined, gateway: McpGateway | undefined;
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += String(chunk)));
    try {
      await until(() => f.counts.writes === 1);
      assert.equal(errors, "");
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      // Same lock expiry as production. Existing crash suite covers owner contention.
      await new Promise((resolve) => setTimeout(resolve, 31000));
      gateway = new McpGateway([f.config]);
      app = await Runtime.open({ dir, gateway });
      const id = app.store.all<{ id: string }>(
        "SELECT id FROM conversations",
      )[0].id;
      await (await app.conversation(id)).waitForIdle(context);
      assert.equal(f.counts.writes, 1);
      assert.equal(f.counts.execute, 1);
      const call = app.mcpCalls.list(id)[0];
      assert.equal(call.state, "uncertain");
      await app.submit(id, "mcp-crash", "Run the mock effect");
      await (await app.conversation(id)).waitForIdle(context);
      assert.equal(f.counts.writes, 1);
      app.mcpCalls.reconcile(
        id,
        call.id,
        "Mock service confirms the effect was applied once",
      );
      assert.equal(app.mcpCalls.list(id)[0].state, "reconciled");
    } finally {
      child.kill("SIGKILL");
      await app?.close();
      await gateway?.close();
      await f.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a blocked resume can be abandoned locally without broadening the connection policy", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "pi-mcp-blocked-resume-"));
  const gateway = new McpGateway([{ ...f.config, allowedTools: ["execute"] }]);
  const app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    await app.mcpCalls.execute(id, 400, "mock", "execute", { code: "pause" });
    const pending = app.mcpCalls.interactions(id)[0];
    await assert.rejects(
      app.mcpCalls.decide(id, pending.id, "accept"),
      /restrições/,
    );
    await app.mcpCalls.decide(id, pending.id, "cancel");
    assert.equal(app.mcpCalls.list(id)[0].state, "abandoned");
    assert.equal(f.counts.resumes, 0);
    assert.match(app.mcpCalls.list(id)[0].result!, /permanece pausada/);
    await app.settings.saveMcp([
      { ...f.config, allowedTools: ["execute", "resume"] },
    ]);
  } finally {
    await app.close();
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume claim and running state roll back together on storage failure", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "pi-mcp-atomic-resume-"));
  const gateway = new McpGateway([f.config]);
  const app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    await app.mcpCalls.execute(id, 401, "mock", "execute", { code: "pause" });
    const pending = app.mcpCalls.interactions(id)[0];
    const run = app.store.run.bind(app.store);
    app.store.run = (sql, ...args) => {
      if (sql.startsWith("UPDATE mcp_calls SET state='running'"))
        throw new Error("mock disk failure");
      return run(sql, ...args);
    };
    try {
      await assert.rejects(
        app.mcpCalls.decide(id, pending.id, "accept"),
        /disk failure/,
      );
    } finally {
      app.store.run = run;
    }
    assert.equal(app.mcpCalls.interactions(id)[0].state, "pending");
    assert.equal(app.mcpCalls.list(id)[0].state, "paused");
    assert.equal(f.counts.resumes, 0);
    await app.mcpCalls.decide(id, pending.id, "decline");
  } finally {
    await app.close();
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotating a token file prevents acceptance under a different credential binding", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "pi-mcp-token-binding-"));
  const file = join(dir, "token");
  await writeFile(file, "first-mock-token");
  const gateway = new McpGateway([{ ...f.config, tokenFile: file }]);
  const app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    // Discovery cached a client using token A. The trace must follow that actual connection,
    // rather than pretend that a subsequently rotated token B was sent.
    await writeFile(file, "second-mock-token");
    await app.mcpCalls.execute(id, 402, "mock", "execute", { code: "pause" });
    const pending = app.mcpCalls.interactions(id)[0];
    assert.equal(
      app.mcpCalls.list(id)[0].binding,
      await gateway.connectionBinding("mock"),
    );
    assert.notEqual(
      app.mcpCalls.list(id)[0].binding,
      gateway.credentialBinding("mock"),
    );
    await assert.rejects(
      app.mcpCalls.decide(id, pending.id, "accept"),
      /credenciais/,
    );
    assert.equal(f.counts.resumes, 0);
    await app.mcpCalls.decide(id, pending.id, "cancel");
    assert.equal(app.mcpCalls.list(id)[0].state, "abandoned");
  } finally {
    await app.close();
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsupported pause and withdrawn native elicitation are never accepted as successful execution", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "pi-mcp-pause-shape-"));
  const gateway = new McpGateway([f.config]);
  const app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    const result = await app.mcpCalls.execute(id, 403, "mock", "execute", {
      code: "unknownpause",
    });
    assert.equal(result.isError, true);
    assert.equal(app.mcpCalls.list(id)[0].state, "uncertain");
    assert.equal(f.counts.writes, 0);
    await assert.rejects(
      app.mcpCalls.execute(id, 404, "mock", "execute", { code: "write" }),
      /incerto/,
    );
    assert.equal(f.counts.execute, 1);
    app.mcpCalls.reconcile(
      id,
      app.mcpCalls.list(id)[0].id,
      "Mock paused without effects",
    );
    const withdrawn = app.mcpCalls.execute(id, 405, "mock", "execute", {
      code: "withdraw",
    });
    await until(() =>
      app.mcpCalls.interactions(id).some((i) => i.state === "expired"),
    );
    const request = app.mcpCalls.interactions(id).at(-1)!;
    await app.mcpCalls.decide(id, request.id, "accept");
    await withdrawn;
    assert.equal(f.counts.writes, 0);
  } finally {
    await app.close();
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed resume results are delivered idempotently to the conversation after restart", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "pi-mcp-resume-outcome-"));
  let gateway = new McpGateway([f.config]),
    app = await Runtime.open({ dir, gateway });
  try {
    const id = await app.create();
    await app.mcpCalls.execute(id, 406, "mock", "execute", {
      code: "pause-large",
    });
    await app.mcpCalls.decide(
      id,
      app.mcpCalls.interactions(id)[0].id,
      "accept",
    );
    // Crash window simulation: external result persisted, no recordMcpOutcome yet.
    assert.equal(
      app.store.all("SELECT * FROM requests WHERE source='system'").length,
      0,
    );
    await app.close();
    await gateway.close();
    gateway = new McpGateway([f.config]);
    app = await Runtime.open({ dir, gateway });
    await (await app.conversation(id)).waitForIdle(context);
    assert.equal(
      app.store.all("SELECT * FROM requests WHERE source='system'").length,
      1,
    );
    const call = app.mcpCalls.list(id)[0];
    assert.ok(call.result!.length > 32000);
    const recorded = app.store.get<{ text: string }>(
      "SELECT text FROM requests WHERE source='system'",
    )!;
    assert.ok(recorded.text.length < 32000);
    assert.match(recorded.text, /Resultado limitado/);
    await app.recordMcpOutcome(call);
    assert.equal(
      app.store.all("SELECT * FROM requests WHERE source='system'").length,
      1,
    );
    assert.equal(f.counts.resumes, 1);
    assert.equal(f.counts.writes, 1);
  } finally {
    await app.close();
    await gateway.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
