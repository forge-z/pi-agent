import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Runtime } from "../src/runtime.js";
import { createAppServer } from "../src/server.js";
test("web auth separate from provider, origin gate, idempotent admission, SSE snapshot reconnect and static PWA", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-http-"));
  const app = await Runtime.open({ dir, gateway: { call: async () => ({}) } });
  const origin = "http://127.0.0.1:3000";
  const web = createAppServer(app, {
    password: "test-password-123",
    origin,
    secureCookie: false,
    publicDir: resolve("public"),
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
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
        ...(data
          ? { "content-type": "application/json", origin: requestOrigin }
          : {}),
        cookie,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  try {
    assert.equal((await request("/healthz")).status, 200);
    assert.equal((await request("/manifest.webmanifest")).status, 200);
    for (const asset of ["/markdown.js", "/marked.js"]) {
      const response = await request(asset);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /javascript/);
      assert.ok((await response.text()).length > 100);
    }
    assert.equal(
      (await request("/node_modules/marked/package.json")).status,
      404,
    );
    assert.equal((await request("/api/conversations")).status, 401);
    assert.equal(
      (
        await request(
          "/api/login",
          "POST",
          { password: "test-password-123" },
          "",
          "https://evil.test",
        )
      ).status,
      403,
    );
    const login = await request("/api/login", "POST", {
      password: "test-password-123",
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0];
    const status = (await (
      await request("/api/status", "GET", undefined, cookie)
    ).json()) as { credentials: unknown };
    assert.equal(status.credentials, null);
    const conversation = (await (
      await request(
        "/api/conversations",
        "POST",
        { title: "HTTP test" },
        cookie,
      )
    ).json()) as { id: string };
    const first = await (
      await request(
        `/api/conversations/${conversation.id}/messages`,
        "POST",
        { requestId: "http-one", text: "hello" },
        cookie,
      )
    ).json();
    const second = await (
      await request(
        `/api/conversations/${conversation.id}/messages`,
        "POST",
        { requestId: "http-one", text: "hello" },
        cookie,
      )
    ).json();
    assert.deepEqual(first, second);
    for (let i = 0; i < 2; i++) {
      const abort = new AbortController();
      const sse = await fetch(
        `${base}/api/conversations/${conversation.id}/events`,
        { headers: { cookie }, signal: abort.signal },
      );
      assert.equal(sse.headers.get("x-accel-buffering"), "no");
      const reader = sse.body!.getReader();
      let output = "";
      while (!output.includes("event: snapshot")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      assert.match(output, /event: snapshot/);
      abort.abort();
      await reader.cancel().catch(() => {});
    }
    assert.equal(
      (await request("/api/logout", "POST", {}, cookie)).status,
      200,
    );
    assert.equal(
      (await request("/api/conversations", "GET", undefined, cookie)).status,
      401,
    );
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
