import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { Store, SqlCredentials } from "../src/store.js";
import { ProviderConnections } from "../src/provider-connections.js";
import { Runtime } from "../src/runtime.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
const key = "mock-stream-key-never-reflect-this";
const reflected = `raw upstream detail ${key}`;
const context = {
  messages: [{ role: "user" as const, content: "Local test", timestamp: 0 }],
};
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("reflected stream errors cannot enter persisted Runtime history, snapshots, or restarted history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-stream-runtime-"));
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      request.url?.includes("messages")
        ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "authentication_error", message: reflected } })}\n\n`
        : `data: ${JSON.stringify({ error: { type: "authentication_error", message: reflected } })}\n\n`,
    );
  });
  const endpoint = await listen(server);
  const gateway = { call: async () => ({ content: [] }) };
  let app = await Runtime.open({ dir, mode: "live", gateway });
  try {
    const conversations: string[] = [];
    for (const protocol of ["openai-compatible", "anthropic"]) {
      const connection = await app.providerConnections.create({
        protocol,
        endpoint,
        modelId: "manual-model",
        apiKey: key,
        allowLocal: true,
      });
      app.settings.saveDefaults({
        provider: connection.id,
        modelId: "manual-model",
        effort: "off",
      });
      const id = await app.create("Local error regression");
      conversations.push(id);
      await app.submit(id, `error-${protocol}`, "Local synthetic test");
      await (await app.conversation(id)).waitForIdle(BACKGROUND_CONTEXT);
      for (
        let i = 0;
        i < 100 &&
        app.store.get("SELECT 1 FROM requests WHERE status='pending'");
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      const snapshot = await app.snapshot(id);
      const serialized = JSON.stringify(snapshot);
      assert.ok(
        serialized.includes("Falha na conexão de API customizada"),
        "a real failed assistant result must persist",
      );
      assert.ok(!serialized.includes(key));
      assert.ok(!JSON.stringify(snapshot.view.entries).includes(reflected));
    }
    await app.close();
    app = await Runtime.open({ dir, mode: "live", gateway });
    for (const id of conversations) {
      const serialized = JSON.stringify(await app.snapshot(id));
      assert.ok(serialized.includes("Falha na conexão de API customizada"));
      assert.ok(!serialized.includes(key));
    }
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

for (const protocol of ["openai-compatible", "anthropic"]) {
  for (const simple of [false, true]) {
    test(`${protocol} ${simple ? "streamSimple" : "stream"} sanitizes HTTP 200 SSE error and SDK exception paths`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "pi-custom-stream-"));
      const store = new Store(dir);
      const models = createModels({ credentials: new SqlCredentials(store) });
      const manager = new ProviderConnections(models, store);
      let scenario = "sse";
      let hits = 0;
      const server = createServer((request, response) => {
        hits++;
        const auth =
          protocol === "anthropic"
            ? request.headers["x-api-key"]
            : request.headers.authorization;
        assert.equal(auth, protocol === "anthropic" ? key : `Bearer ${key}`);
        if (scenario === "sse") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            protocol === "anthropic"
              ? `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "authentication_error", message: reflected } })}\n\n`
              : `data: ${JSON.stringify({ error: { message: reflected, type: "authentication_error" } })}\n\n`,
          );
        } else {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            protocol === "anthropic"
              ? `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: reflected, model: reflected, usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "prefix" }] } })}\n\nevent: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: reflected } })}\n\n`
              : `data: ${JSON.stringify({ id: reflected, model: reflected, choices: [{ index: 0, delta: { role: "assistant", content: "prefix" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ error: { message: reflected, type: "api_error" } })}\n\n`,
          );
        }
      });
      const endpoint = await listen(server);
      try {
        const connection = await manager.create({
          protocol,
          endpoint,
          modelId: "manual-model",
          apiKey: key,
          allowLocal: true,
        });
        const model = models.getModel(connection.id, "manual-model")!;
        for (const value of [
          "sse",
          "partial-error",
          "hook-error",
          "response-hook-error",
        ]) {
          scenario = value.includes("hook-error") ? "sse" : value;
          const options = {
            maxRetries: 0,
            ...(value === "hook-error"
              ? {
                  onPayload: () => {
                    throw new Error(reflected);
                  },
                }
              : {}),
            ...(value === "response-hook-error"
              ? {
                  onResponse: () => {
                    throw new Error(reflected);
                  },
                }
              : {}),
          };
          const stream = simple
            ? models.streamSimple(model, context, options)
            : models.stream(model, context, options);
          const events = [];
          for await (const event of stream) {
            assert.ok(
              !JSON.stringify(event).includes(key),
              "live events must never expose the supplied key",
            );
            events.push(event);
          }
          const result = await stream.result();
          assert.equal(events.at(-1)?.type, "error");
          assert.equal(result.stopReason, "error");
          assert.ok(!JSON.stringify({ events, result }).includes(key));
          assert.ok(
            !JSON.stringify({ events, result }).includes("raw upstream detail"),
          );
          assert.equal(
            events.filter((event) => event.type === "error").length,
            1,
          );
        }
        assert.equal(hits, 3);
        assert.ok(!JSON.stringify(manager.list()).includes(key));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test("custom SDK wrappers preserve text, tool events, shared partials, completion, and abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-normal-stream-"));
  const store = new Store(dir);
  const models = createModels({ credentials: new SqlCredentials(store) });
  const manager = new ProviderConnections(models, store);
  let aborting = false;
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, data: unknown) =>
      `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    if (request.url?.includes("messages")) {
      response.write(
        event("message_start", {
          type: "message_start",
          message: {
            id: "local-id",
            type: "message",
            role: "assistant",
            model: "manual-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }) +
          event("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }) +
          event("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Local text" },
          }),
      );
      if (aborting) return;
      response.end(
        event("content_block_stop", { type: "content_block_stop", index: 0 }) +
          event("content_block_start", {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "local-tool-id",
              name: "local_tool",
              input: {},
            },
          }) +
          event("content_block_delta", {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: '{"value":"local-value"}',
            },
          }) +
          event("content_block_stop", {
            type: "content_block_stop",
            index: 1,
          }) +
          event("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 3 },
          }) +
          event("message_stop", { type: "message_stop" }),
      );
    } else {
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: "local-id", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      response.write(chunk({ role: "assistant", content: "Local text" }));
      if (aborting) return;
      response.end(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "local-tool-id",
              type: "function",
              function: {
                name: "local_tool",
                arguments: '{"value":"local-value"}',
              },
            },
          ],
        }) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
      );
    }
  });
  const endpoint = await listen(server);
  const toolContext = {
    ...context,
    tools: [
      {
        name: "local_tool",
        description: "Synthetic local tool",
        parameters: Type.Object({ value: Type.String() }),
      },
    ],
  };
  try {
    for (const protocol of ["openai-compatible", "anthropic"]) {
      const connection = await manager.create({
        protocol,
        endpoint,
        modelId: "manual-model",
        apiKey: key,
        allowLocal: true,
      });
      const model = models.getModel(connection.id, "manual-model")!;
      model.baseUrl = "https://must-not-call.example.invalid";
      model.headers = { authorization: "Bearer mock-other-provider-secret" };
      for (const simple of [false, true]) {
        aborting = false;
        const bypassOptions = {
          apiKey: "mock-request-override-key",
          headers: {
            authorization: "Bearer mock-header-override-key",
            "x-api-key": "mock-header-override-key",
          },
          env: {
            OPENAI_API_KEY: "mock-environment-key",
            ANTHROPIC_API_KEY: "mock-environment-key",
          },
          fetch: async () => {
            throw new Error("caller fetch must never execute");
          },
          transport: "websocket" as const,
        };
        const stream = simple
          ? models.streamSimple(model, toolContext, bypassOptions)
          : models.stream(model, toolContext, bypassOptions);
        let partial: AssistantMessage | undefined;
        const types: string[] = [];
        for await (const event of stream) {
          types.push(event.type);
          if ("partial" in event) {
            if (partial)
              assert.equal(
                event.partial,
                partial,
                "partial identity must remain shared",
              );
            partial = event.partial;
          }
        }
        const result = await stream.result();
        assert.equal(result, partial);
        assert.equal(result.stopReason, "toolUse");
        assert.ok(types.includes("text_delta"));
        assert.ok(types.includes("toolcall_end"));
        assert.equal(types.at(-1), "done");
        assert.equal(result.content[0].type, "text");
        assert.ok(JSON.stringify(result.content).includes("Local text"));
        assert.ok(JSON.stringify(result.content).includes("local-value"));
        aborting = true;
        const controller = new AbortController();
        const aborted = simple
          ? models.streamSimple(model, context, { signal: controller.signal })
          : models.stream(model, context, { signal: controller.signal });
        const abortedTypes: string[] = [];
        for await (const event of aborted) {
          abortedTypes.push(event.type);
          if (event.type === "text_delta")
            controller.abort(new Error(reflected));
        }
        const abortedResult = await aborted.result();
        assert.equal(abortedResult.stopReason, "aborted");
        assert.equal(abortedTypes.at(-1), "error");
        assert.ok(!JSON.stringify(abortedResult).includes(key));
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
