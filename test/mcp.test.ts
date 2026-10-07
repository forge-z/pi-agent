import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpGateway } from "../src/mcp.js";
test("real MCP SDK connects to local HTTP mock, exposes explicit allowlists, calls read/action tools", async () => {
  const mcp = new McpServer({ name: "mock", version: "1.0.0" });
  let reads = 0;
  let writes = 0;
  mcp.registerTool("lookup", { description: "Read mock" }, async () => {
    reads++;
    return { content: [{ type: "text", text: "preview" }] };
  });
  mcp.registerTool("create", { description: "Write mock" }, async () => {
    writes++;
    return { content: [{ type: "text", text: "saved" }] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });
  await mcp.connect(transport);
  const server = createServer(
    (req, res) => void transport.handleRequest(req, res),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const gateway = new McpGateway([
    {
      name: "mock",
      url: `http://127.0.0.1:${address.port}/mcp`,
      readTools: ["lookup"],
      actionTools: ["create"],
    },
  ]);
  try {
    const catalog = JSON.stringify(await gateway.catalog());
    assert.match(catalog, /lookup/);
    assert.match(catalog, /inputSchema/);
    assert.doesNotMatch(catalog, /http:/);
    assert.throws(
      () =>
        new McpGateway([
          {
            name: "unsafe",
            url: "http://remote.invalid/mcp",
            readTools: [],
            actionTools: [],
          },
        ]),
      /HTTPS/,
    );
    assert.match(
      JSON.stringify(await gateway.call("mock", "lookup", {}, "read")),
      /preview/,
    );
    await assert.rejects(
      gateway.call("mock", "create", {}, "read"),
      /não autorizada/,
    );
    await assert.rejects(
      gateway.call("unknown", "lookup", {}, "read"),
      /não autorizada/,
    );
    await gateway.call("mock", "create", {}, "action");
    assert.equal(reads, 1);
    assert.equal(writes, 1);
  } finally {
    await gateway.close();
    await mcp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
