import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpGateway, McpNotSentError } from "../src/mcp.js";
import { McpCalls } from "../src/mcp-calls.js";
import { Store } from "../src/store.js";
import { Actions } from "../src/actions.js";

async function fixture() {
  let session = "";
  let initializes = 0;
  let writes = 0;
  let reads = 0;
  let initial404 = false;
  let loseWrite = false;
  let loseRead = false;
  let rejectLists = false;
  let loseInitialization = false;
  let gets = 0;
  let paginate = false;
  let losePage = false;
  let waitWrite: Promise<void> | undefined;
  let releaseWrite: (() => void) | undefined;
  let startedWrite: (() => void) | undefined;
  const requests: { method: string; session: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      gets++;
      res.writeHead(initial404 ? 404 : 405).end("private upstream message");
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const sid = req.headers["mcp-session-id"] as string | undefined;
    requests.push({ method: body.method, session: sid });
    if (initial404 || (body.method !== "initialize" && sid !== session)) {
      res.writeHead(404).end("secret endpoint and token must never leak");
      return;
    }
    let result: unknown;
    if (body.method === "initialize") {
      assert.equal(sid, undefined);
      session = `session-${++initializes}`;
      res.setHeader("Mcp-Session-Id", session);
      result = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1" },
      };
    } else if (body.method.startsWith("notifications/")) {
      if (loseInitialization) {
        session = "expired";
        res.writeHead(404).end("expired initialized notification");
        return;
      }
      res.writeHead(202).end();
      return;
    } else if (body.method === "tools/list") {
      if (rejectLists) {
        session = "expired";
        res.writeHead(404).end("expired catalog");
        return;
      }
      if (paginate && body.params?.cursor && losePage) {
        losePage = false;
        session = "expired";
        res.writeHead(404).end("page session expired");
        return;
      }
      result = paginate
        ? {
            tools: [
              {
                name: `${body.params?.cursor ? "second" : "first"}-${initializes}`,
                inputSchema: { type: "object" },
              },
            ],
            ...(body.params?.cursor ? {} : { nextCursor: "next" }),
          }
        : {
            tools: ["lookup", "execute"].map((name) => ({
              name,
              inputSchema: { type: "object" },
            })),
          };
    } else if (body.method === "tools/call") {
      if (body.params.name === "execute") {
        writes++;
        startedWrite?.();
        await waitWrite;
        if (loseWrite) {
          loseWrite = false;
          session = "expired";
          res.writeHead(404).end("effect completed but response was lost");
          return;
        }
      } else {
        if (loseRead) {
          loseRead = false;
          session = "expired";
          res.writeHead(404).end("expired");
          return;
        }
        reads++;
      }
      result = { content: [{ type: "text", text: "done" }] };
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    get initializes() {
      return initializes;
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    expire() {
      session = "expired";
    },
    failEndpoint() {
      initial404 = true;
    },
    restoreEndpoint() {
      initial404 = false;
    },
    loseWrite() {
      loseWrite = true;
    },
    loseRead() {
      loseRead = true;
    },
    rejectLists() {
      rejectLists = true;
    },
    loseInitialization() {
      loseInitialization = true;
    },
    get gets() {
      return gets;
    },
    loseSecondPage() {
      paginate = true;
      losePage = true;
    },
    holdWrite() {
      waitWrite = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      return new Promise<void>((resolve) => {
        startedWrite = resolve;
      });
    },
    releaseWrite() {
      releaseWrite?.();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
function gateway(url: string, direct = false) {
  return new McpGateway([
    {
      name: "mock",
      url,
      mode: direct ? "direct" : "legacy",
      readTools: ["lookup"],
      actionTools: ["execute"],
    },
  ]);
}

test("expired MCP sessions recover once during concurrent discovery and keep the new session", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    mock.expire();
    const catalogs = await Promise.all(
      Array.from({ length: 6 }, () => mcp.discover("mock")),
    );
    assert.ok(catalogs.every((tools) => tools.length === 2));
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 0);
    assert.equal(
      mock.requests.filter((r) => r.method === "initialize").length,
      2,
    );
    await mcp.call("mock", "lookup", {}, "read");
    assert.equal(mock.initializes, 2);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("only explicitly classified reads retry after a lost session", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    mock.loseRead();
    assert.match(
      JSON.stringify(await mcp.call("mock", "lookup", {}, "read")),
      /done/,
    );
    assert.equal(mock.reads, 1);
    assert.equal(mock.initializes, 2);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("initial endpoint 404 is distinct from session expiry and does not loop initialization", async () => {
  const mock = await fixture();
  mock.failEndpoint();
  const mcp = gateway(mock.url);
  try {
    await assert.rejects(mcp.discover("mock"), /Endpoint MCP.*404/);
    assert.equal(
      mock.requests.filter((r) => r.method === "initialize").length,
      1,
    );
    assert.equal(mock.initializes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("direct tools are not resent after 404 and the durable call remains uncertain", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-session-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  try {
    await mcp.discover("mock");
    mock.loseWrite();
    await assert.rejects(
      calls.execute("conversation", 1, "mock", "execute", {}),
      /sessão MCP.*não.*reenviada/i,
    );
    assert.equal(mock.writes, 1);
    assert.equal(calls.list("conversation")[0].state, "uncertain");
    await assert.rejects(
      calls.execute("conversation", 1, "mock", "execute", {}),
      /não será reenviada/,
    );
    await mcp.discover("mock");
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 1);
    assert.doesNotMatch(
      JSON.stringify(calls.list("conversation")),
      /secret endpoint|session-/,
    );
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session recovery is bounded when the server expires every catalog request", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.rejectLists();
    await assert.rejects(mcp.discover("mock"), /sessão MCP expirou novamente/);
    assert.equal(mock.initializes, 2);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/list").length,
      2,
    );
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("discovery does not replace a client while a direct write is still running", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    await mcp.discover("mock");
    const started = mock.holdWrite();
    const write = mcp.callDirect("mock", "execute", {});
    await started;
    mock.expire();
    const catalog = mcp.discover("mock");
    // The old operation must complete before discovery notices the expired ID.
    mock.releaseWrite();
    assert.match(JSON.stringify(await write), /done/);
    assert.equal((await catalog).length, 2);
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 1);
  } finally {
    mock.releaseWrite();
    await mcp.close();
    await mock.close();
  }
});

test("a legacy action rejected with a session 404 is not automatically replayed", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    mock.loseWrite();
    await assert.rejects(
      mcp.call("mock", "execute", {}, "action"),
      /sessão MCP.*não foi reenviada/,
    );
    assert.equal(mock.writes, 1);
    await mcp.discover("mock");
    assert.equal(mock.initializes, 2);
    assert.equal(mock.writes, 1);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("404 after initialize is a lost session, not a reason to fall back to legacy SSE", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.loseInitialization();
    await assert.rejects(
      mcp.discover("mock"),
      /sessão MCP expirou durante a inicialização/,
    );
    assert.equal(mock.initializes, 1);
    assert.equal(mock.gets, 0);
    assert.equal(mock.writes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("discovery restarts pagination without keeping tools from the expired session", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    mock.loseSecondPage();
    const tools = await mcp.discover("mock");
    assert.deepEqual(
      tools.map((t) => t.name),
      ["first-2", "second-2"],
    );
    assert.equal(mock.initializes, 2);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("a reconnect failure before tools/call is failed, not uncertain, and an explicit retry can succeed", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-unsent-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  const binding = mcp.connectionBinding.bind(mcp);
  let interrupt = true;
  mcp.connectionBinding = async (server) => {
    const value = await binding(server);
    if (interrupt) {
      interrupt = false;
      // Reproduce a client going away after admission but before dispatch.
      await mcp.replace([...mcp.config]);
      mock.failEndpoint();
    }
    return value;
  };
  try {
    await assert.rejects(
      calls.execute("conversation", 1, "mock", "execute", {}),
      McpNotSentError,
    );
    assert.equal(mock.writes, 0);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/call").length,
      0,
    );
    assert.equal(calls.list("conversation")[0].state, "failed");
    assert.match(
      calls.list("conversation")[0].result!,
      /Nenhuma chamada de ferramenta foi enviada/,
    );
    // Distinct task identity is an explicit retry, never an automatic replay.
    mock.restoreEndpoint();
    const result = await calls.execute(
      "conversation",
      2,
      "mock",
      "execute",
      {},
    );
    assert.equal(result.isError, undefined);
    assert.equal(mock.writes, 1);
    assert.equal(calls.list("conversation")[1].state, "done");
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an initial initialize 404 creates no uncertain call or reconciliation requirement", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  const dir = await mkdtemp(join(tmpdir(), "mcp-init-failed-"));
  const store = new Store(dir);
  const calls = new McpCalls(store, mcp);
  try {
    mock.failEndpoint();
    await assert.rejects(
      calls.execute("conversation", 1, "mock", "execute", {}),
      /Endpoint MCP/,
    );
    assert.equal(mock.writes, 0);
    assert.equal(calls.list("conversation").length, 0);
    mock.restoreEndpoint();
    await calls.execute("conversation", 1, "mock", "execute", {});
    assert.equal(calls.list("conversation")[0].state, "done");
    assert.equal(mock.writes, 1);
  } finally {
    await calls.close();
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a direct call cancelled before dispatch sends no tool and is definitely unsent", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url, true);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      mcp.callDirect("mock", "execute", {}, { signal: controller.signal }),
      McpNotSentError,
    );
    assert.equal(mock.initializes, 0);
    assert.equal(mock.writes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("legacy action cancellation releases the caller without replaying an already dispatched effect", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    await mcp.discover("mock");
    const controller = new AbortController();
    const started = mock.holdWrite();
    const action = mcp.call("mock", "execute", {}, "action", controller.signal);
    await started;
    controller.abort();
    await assert.rejects(action, (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof McpNotSentError));
      return true;
    });
    assert.equal(mock.writes, 1);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/call").length,
      1,
    );
    mock.releaseWrite();
    await mcp.discover("mock");
    assert.equal(mock.writes, 1);
  } finally {
    mock.releaseWrite();
    await mcp.close();
    await mock.close();
  }
});

test("legacy action cancelled before dispatch performs no initialization or effect", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      mcp.call("mock", "execute", {}, "action", controller.signal),
      McpNotSentError,
    );
    assert.equal(mock.writes, 0);
    assert.equal(mock.initializes, 0);
  } finally {
    await mcp.close();
    await mock.close();
  }
});

test("a cancelled queued call settles promptly without interrupting the active MCP operation", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  let running: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await mcp.discover("mock");
    const started = mock.holdWrite();
    running = mcp.call("mock", "execute", {}, "action");
    await started;
    const controller = new AbortController();
    const queued = mcp.call("mock", "execute", {}, "action", controller.signal);
    controller.abort();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Queued cancellation did not settle promptly")),
        250,
      );
    });
    await assert.rejects(Promise.race([queued, deadline]), McpNotSentError);
    assert.equal(mock.writes, 1);
    assert.equal(mock.initializes, 1);
    // A following catalog is still queued behind the live operation.
    const catalog = mcp.discover("mock");
    assert.throws(() => mcp.checkReplacement([...mcp.config]), /Aguarde/);
    mock.releaseWrite();
    assert.match(JSON.stringify(await running), /done/);
    await catalog;
    assert.equal(mock.writes, 1);
    assert.equal(mock.initializes, 1);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/call").length,
      1,
    );
  } finally {
    clearTimeout(timer);
    mock.releaseWrite();
    await running?.catch(() => {});
    await mcp.close();
    await mock.close();
  }
});

test("legacy approval with predispatch initialize 404 is failed and a duplicate approval never resends", async () => {
  const mock = await fixture();
  const mcp = gateway(mock.url);
  const dir = await mkdtemp(join(tmpdir(), "mcp-action-unsent-"));
  const store = new Store(dir);
  const actions = new Actions(store, mcp);
  try {
    await actions.read("conversation", "mock", "lookup", {});
    const proposed = actions.propose("conversation", 1, "mock", "execute", {});
    await mcp.replace([...mcp.config]);
    mock.failEndpoint();
    const result = await actions.decide("conversation", proposed.id, "approve");
    assert.equal(result.state, "failed");
    assert.match(result.result!, /não foi enviada/);
    assert.equal(mock.writes, 0);
    assert.equal(
      mock.requests.filter((r) => r.method === "tools/call").length,
      1,
    ); // evidence read only
    mock.restoreEndpoint();
    const duplicate = await actions.decide(
      "conversation",
      proposed.id,
      "approve",
    );
    assert.equal(duplicate.state, "failed");
    assert.equal(mock.writes, 0);
    const retry = actions.propose("conversation", 2, "mock", "execute", {});
    assert.equal(
      (await actions.decide("conversation", retry.id, "approve")).state,
      "done",
    );
    assert.equal(mock.writes, 1);
  } finally {
    await mcp.close();
    store.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
