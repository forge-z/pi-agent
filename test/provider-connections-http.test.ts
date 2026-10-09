import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
import { SqlCredentials } from "../src/store.js";

const key = "mock-discovery-fresh-key";
const nativeKey = "mock-native-private-key";
const gateway = { call: async () => ({ content: [] }) };
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("optional catalog discovery uses only fresh supplied keys, filters reflected secrets, and preserves manual models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-catalog-"));
  const requests: { path: string; auth?: string; apiKey?: string }[] = [];
  let responseKind = "catalog";
  const service = createServer((request, response) => {
    requests.push({
      path: request.url!,
      auth: request.headers.authorization,
      apiKey: request.headers["x-api-key"] as string | undefined,
    });
    response.setHeader("content-type", "application/json");
    if (responseKind === "unsupported") {
      response.writeHead(404);
      response.end(JSON.stringify({ error: key }));
      return;
    }
    if (responseKind === "bytes") {
      response.end(JSON.stringify({ data: [], padding: "x".repeat(1048576) }));
      return;
    }
    if (responseKind === "count") {
      response.end(
        JSON.stringify({
          data: Array.from({ length: 1001 }, (_, n) => ({ id: `model-${n}` })),
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        data: [
          { id: "catalog-model", name: "Catalog model" },
          { id: "catalog-model", name: "duplicate" },
          { id: "unsafe\nmodel" },
          { id: `reflected-${key}` },
          { id: "reflecting-name", name: key },
          { id: "long-name", name: "x".repeat(257) },
          { id: "anthropic-model", display_name: "Display name" },
        ],
      }),
    );
  });
  const endpoint = await listen(service);
  const app = await Runtime.open({ dir, gateway, mode: "live" });
  try {
    await new SqlCredentials(app.store).modify("openai", async () => ({
      type: "api_key",
      key: nativeKey,
    }));
    const config = {
      protocol: "openai-compatible",
      endpoint,
      apiKey: key,
      allowLocal: true,
    };
    const manual = await app.providerConnections.create({
      ...config,
      modelId: "manual-model",
    });
    assert.equal(
      requests.length,
      0,
      "creation and startup must remain offline",
    );
    const result = await app.providerConnections.discover(config);
    assert.deepEqual(result.models, [
      { id: "catalog-model", name: "Catalog model" },
      { id: "anthropic-model", name: "Display name" },
    ]);
    assert.deepEqual(requests[0], {
      path: "/v1/models",
      auth: `Bearer ${key}`,
      apiKey: undefined,
    });
    await app.providerConnections.discover({
      ...config,
      protocol: "anthropic",
    });
    assert.deepEqual(requests[1], {
      path: "/v1/models",
      auth: undefined,
      apiKey: key,
    });
    await app.providerConnections.discover({ ...config, apiKey: "" });
    assert.equal(requests[2].auth, undefined);
    assert.equal(requests[2].apiKey, undefined);
    const count = requests.length;
    await assert.rejects(
      app.providerConnections.discover({ ...config, apiKey: undefined }),
    );
    assert.equal(requests.length, count);
    for (const kind of ["unsupported", "bytes", "count"]) {
      responseKind = kind;
      await assert.rejects(
        app.providerConnections.discover(config),
        (error: Error) =>
          !error.message.includes(key) && /manualmente/.test(error.message),
      );
      assert.equal(
        app.models.getModel(manual.id, "manual-model")?.id,
        "manual-model",
      );
    }
    assert.ok(!JSON.stringify(requests).includes(nativeKey));
    assert.ok(!JSON.stringify(app.settings.snapshot()).includes(key));
  } finally {
    await app.close();
    await close(service);
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom connection routes require a session and same origin, return metadata only, and rotate only with replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-http-"));
  let upstreamCalls = 0;
  const service = createServer(
    (_request: IncomingMessage, response: ServerResponse) => {
      upstreamCalls++;
      response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    },
  );
  const endpoint = await listen(service);
  const app = await Runtime.open({ dir, gateway, mode: "live" });
  const web = createAppServer(app, {
    password: "mock-password",
    origin: "http://localhost",
    secureCookie: false,
  });
  const server = web.server;
  const address = await listen(server);
  let cookie = "";
  const post = (
    path: string,
    value: unknown,
    origin = "http://localhost",
    method = "POST",
  ) =>
    fetch(address + path, {
      method,
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify(value),
    });
  const input = {
    protocol: "openai-compatible",
    endpoint,
    modelId: "local-model",
    apiKey: key,
    allowLocal: true,
  };
  try {
    assert.equal(
      (await fetch(address + "/api/provider/connections")).status,
      401,
    );
    assert.equal((await post("/api/provider/connections", input)).status, 401);
    const login = await post("/api/login", { password: "mock-password" });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await post(
          "/api/provider/connections",
          input,
          "https://evil.example.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/provider/connections/models",
          input,
          "https://evil.example.invalid",
        )
      ).status,
      403,
    );
    assert.equal(upstreamCalls, 0);
    const created = await post("/api/provider/connections", input);
    assert.equal(created.status, 201);
    const payload = await created.text();
    assert.ok(!payload.includes(key));
    const { connection } = JSON.parse(payload) as {
      connection: { id: string; hasApiKey: boolean };
    };
    assert.equal(connection.hasApiKey, true);
    assert.equal(upstreamCalls, 0);
    const catalog = await post("/api/provider/connections/models", input);
    assert.equal(catalog.status, 200);
    assert.deepEqual(await catalog.json(), {
      models: [{ id: "local-model", name: "local-model" }],
    });
    assert.equal(upstreamCalls, 1);
    const replacePath = `/api/provider/${connection.id}/api-key`;
    assert.equal(
      (await post(replacePath, { apiKey: key + "-rotated" }, undefined, "PUT"))
        .status,
      400,
    );
    assert.equal((await app.models.getAuth(connection.id))?.auth.apiKey, key);
    assert.equal(
      (
        await post(
          replacePath,
          { apiKey: key + "-rotated", replace: true },
          undefined,
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (await app.models.getAuth(connection.id))?.auth.apiKey,
      key + "-rotated",
    );
    const listed = await (
      await fetch(address + "/api/provider/connections", {
        headers: { cookie },
      })
    ).text();
    assert.ok(!listed.includes(key));
    assert.equal(JSON.parse(listed).length, 1);
  } finally {
    server.closeAllConnections();
    await web.close();
    await app.close();
    await close(service);
    await rm(dir, { recursive: true, force: true });
  }
});

test("demo mutation and discovery routes stay local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-demo-http-"));
  const app = await Runtime.open({ dir, gateway, mode: "demo" });
  const web = createAppServer(app, {
    password: "mock-password",
    origin: "http://localhost",
    secureCookie: false,
  });
  const server = web.server;
  const address = await listen(server);
  const login = await fetch(address + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ password: "mock-password" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  try {
    for (const path of [
      "/api/provider/connections",
      "/api/provider/connections/models",
    ]) {
      const response = await fetch(address + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          cookie,
        },
        body: JSON.stringify({
          protocol: "openai-compatible",
          endpoint: "https://never-call.example.invalid",
          apiKey: key,
          modelId: "local-model",
        }),
      });
      assert.equal(response.status, 409);
      assert.ok(!(await response.text()).includes(key));
    }
    assert.deepEqual(
      await (
        await fetch(address + "/api/provider/connections", {
          headers: { cookie },
        })
      ).json(),
      [],
    );
  } finally {
    server.closeAllConnections();
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
