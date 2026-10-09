import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import {
  parseProviderEndpoint,
  providerFetch,
  providerModelsUrl,
} from "../src/provider-endpoint.js";

async function localServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const endpoint = (
  url: string,
  allowLocal = false,
  protocol = "openai-compatible",
) => parseProviderEndpoint({ endpoint: url, protocol, allowLocal });

test("normalizes SDK base URLs while preserving gateway prefixes and ports", () => {
  assert.equal(
    endpoint("https://api.example:8443/").endpoint,
    "https://api.example:8443/v1",
  );
  assert.equal(
    endpoint("https://api.example/gateway/v2/").endpoint,
    "https://api.example/gateway/v2",
  );
  assert.equal(
    endpoint("https://api.example/", false, "anthropic").endpoint,
    "https://api.example",
  );
  const anthropic = endpoint(
    "https://api.example/gateway/v1/",
    false,
    "anthropic",
  );
  assert.equal(anthropic.endpoint, "https://api.example/gateway");
  assert.equal(
    providerModelsUrl(anthropic),
    "https://api.example/gateway/v1/models",
  );
  assert.equal(
    providerModelsUrl(endpoint("https://api.example")),
    "https://api.example/v1/models",
  );
});

test("transport preserves the already-normalized Anthropic prefix ending in v1", async () => {
  let path = "";
  const local = await localServer((req, res) => {
    path = req.url ?? "";
    res.end("{}");
  });
  try {
    const config = endpoint(local.origin + "/foo/v1/v1", true, "anthropic");
    assert.equal(config.endpoint, local.origin + "/foo/v1");
    await providerFetch(config)(`${config.endpoint}/v1/messages`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(path, "/foo/v1/v1/messages");
  } finally {
    await local.close();
  }
});

test("rejects malformed endpoints and opt-in cannot allow metadata or reserved literals", () => {
  const invalid = [
    "http://api.example",
    "https://user:fake-secret@api.example",
    "https://api.example/?key=fake",
    "https://api.example/#secret",
    "ftp://api.example",
    "https://api.example:65536",
    "https://api.example:0",
    "https://api.example/\nsecret",
    "https://api.example/" + "x".repeat(2048),
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://[fd00::1]",
  ];
  for (const url of invalid)
    assert.throws(() => endpoint(url), /Endpoint de API inválido/);
  for (const host of [
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "100.100.100.200",
    "168.63.129.16",
    "192.0.2.1",
    "[::]",
    "[fe80::1]",
    "[ff02::1]",
    "[2001:db8::1]",
    "[fd00:ec2::254]",
    "[fd20:ce::254]",
    "[::ffff:169.254.169.254]",
  ]) {
    assert.throws(
      () => endpoint(`http://${host}`, true),
      /Endpoint de API inválido/,
    );
  }
  assert.throws(() => endpoint("https://api.example", false, "other"));
});

test("URL canonicalization does not bypass private destination policy", () => {
  for (const host of [
    "2130706433",
    "0177.0.0.1",
    "0x7f000001",
    "127.1",
    "[::ffff:127.0.0.1]",
  ]) {
    assert.throws(() => endpoint(`https://${host}`));
    assert.doesNotThrow(() => endpoint(`http://${host}:8000`, true));
  }
});

test("HTTP opt-in reaches loopback and forwards SDK auth, body and actual Host", async () => {
  let observed: { host?: string; auth?: string; body?: string } = {};
  const local = await localServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      observed = {
        host: req.headers.host,
        auth: req.headers.authorization,
        body,
      };
      res.setHeader("content-type", "application/json");
      res.end('{"data":[]}');
    });
  });
  try {
    const config = endpoint(local.origin, true);
    const result = await providerFetch(config)(
      `${config.endpoint}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer fake-test-key",
          host: "attacker.invalid",
        },
        body: '{"model":"fake-model"}',
      },
    );
    assert.deepEqual(await result.json(), { data: [] });
    assert.deepEqual(observed, {
      host: `127.0.0.1:${local.port}`,
      auth: "Bearer fake-test-key",
      body: '{"model":"fake-model"}',
    });
  } finally {
    await local.close();
  }
});

test("DNS is resolved once per request and the checked address is pinned with hostname preserved", async () => {
  let host = "";
  const local = await localServer((req, res) => {
    host = req.headers.host ?? "";
    res.end("{}");
  });
  let calls = 0;
  const config = endpoint(`http://pin-test.invalid:${local.port}`, true);
  const guarded = providerFetch(config, {
    lookup: async () => {
      calls++;
      return [
        { address: calls === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 },
      ];
    },
  });
  try {
    assert.equal((await guarded(providerModelsUrl(config))).status, 200);
    assert.equal(host, `pin-test.invalid:${local.port}`);
    assert.equal(calls, 1);
    await assert.rejects(
      guarded(providerModelsUrl(config)),
      /Conexão de API bloqueada/,
    );
    assert.equal(calls, 2);
  } finally {
    await local.close();
  }
});

test("rejects all unsafe DNS answers and public HTTP without making a request", async () => {
  const addresses = [
    ["127.0.0.1", "169.254.169.254"],
    ["127.0.0.1", "1.1.1.1"],
    ["1.1.1.1"],
    ["::ffff:169.254.169.254"],
    [],
  ];
  for (const answers of addresses) {
    const config = endpoint("http://dns-test.invalid", true);
    const guarded = providerFetch(config, {
      lookup: async () =>
        answers.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
    });
    await assert.rejects(
      guarded(providerModelsUrl(config)),
      /Conexão de API bloqueada/,
    );
  }
  const config = endpoint("https://dns-test.invalid");
  await assert.rejects(
    providerFetch(config, {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    })(providerModelsUrl(config)),
    /Conexão de API bloqueada/,
  );
});

test("guards exact operation, method, origin and approved Anthropic query", async () => {
  let hits = 0;
  const local = await localServer((_req, res) => {
    hits++;
    res.end("{}");
  });
  try {
    const config = endpoint(local.origin + "/gateway/v1", true, "anthropic");
    const guarded = providerFetch(config);
    for (const [url, method] of [
      [`${config.endpoint}/v1/messages`, "GET"],
      [`${config.endpoint}/v1/models`, "POST"],
      [`${local.origin}/v1/messages`, "POST"],
      [`${config.endpoint}/v1/messages?other=true`, "POST"],
      [`${config.endpoint}/v1/messages?beta=false`, "POST"],
      [`${config.endpoint}/v1/messages#fragment`, "POST"],
      [`http://localhost:${local.port}/gateway/v1/messages`, "POST"],
    ])
      await assert.rejects(
        guarded(url, { method, body: method === "POST" ? "{}" : undefined }),
      );
    assert.equal(hits, 0);
    assert.equal(
      (
        await guarded(`${config.endpoint}/v1/messages?beta=true`, {
          method: "POST",
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(hits, 1);
  } finally {
    await local.close();
  }
});

test("redirects never make a second request or forward authorization", async () => {
  let targetHits = 0;
  const target = await localServer((_req, res) => {
    targetHits++;
    res.end("{}");
  });
  const local = await localServer((_req, res) => {
    res.writeHead(302, { location: target.origin + "/v1/models" });
    res.end("fake-reflected-key");
  });
  try {
    const config = endpoint(local.origin, true);
    const response = await providerFetch(config)(providerModelsUrl(config), {
      headers: { authorization: "Bearer fake-reflected-key" },
      redirect: "follow",
    });
    assert.equal(response.status, 502);
    assert.doesNotMatch(
      await response.text(),
      /fake-reflected-key|127\.0\.0\.1/,
    );
    assert.equal(response.headers.get("location"), null);
    assert.equal(targetHits, 0);
  } finally {
    await local.close();
    await target.close();
  }
});

test("status error bodies and headers cannot reflect the credential", async () => {
  const local = await localServer((req, res) => {
    res.writeHead(401, { "x-reflected": req.headers.authorization ?? "" });
    res.end(req.headers.authorization);
  });
  try {
    const config = endpoint(local.origin, true);
    const response = await providerFetch(config)(providerModelsUrl(config), {
      headers: { authorization: "Bearer obvious-fake-secret" },
    });
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /obvious-fake-secret/);
    assert.equal(response.headers.get("x-reflected"), null);
  } finally {
    await local.close();
  }
});

test("invalid native HTTP header values cannot expose header names in errors", async () => {
  const config = endpoint("http://127.0.0.1:65534", true);
  await assert.rejects(
    providerFetch(config)(providerModelsUrl(config), {
      headers: { "x-obvious-fake-secret": "\u0001" },
    }),
    (error: Error) =>
      !error.message.includes("obvious-fake-secret") &&
      /API/.test(error.message),
  );
});

test("keyless local requests strip both SDK auth headers and require private DNS every time", async () => {
  const local = await localServer((req, res) => {
    res.end(
      JSON.stringify({
        authorization: req.headers.authorization ?? null,
        apiKey: req.headers["x-api-key"] ?? null,
      }),
    );
  });
  try {
    const config = endpoint(local.origin, true);
    const response = await providerFetch(config, { keyless: true })(
      providerModelsUrl(config),
      {
        headers: {
          authorization: "Bearer pi-local-keyless",
          "x-api-key": "pi-local-keyless",
        },
      },
    );
    assert.deepEqual(await response.json(), {
      authorization: null,
      apiKey: null,
    });
    const publicConfig = endpoint("https://public-test.invalid", true);
    await assert.rejects(
      providerFetch(publicConfig, {
        keyless: true,
        lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      })(providerModelsUrl(publicConfig)),
    );
    assert.throws(() =>
      providerFetch(endpoint("https://public-test.invalid"), { keyless: true }),
    );
  } finally {
    await local.close();
  }
});

test("streaming yields SSE before end and abort closes the socket", async () => {
  let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const local = await localServer((req, res) => {
    req.socket.on("close", closed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: fake-first\n\n");
  });
  try {
    const config = endpoint(local.origin, true);
    const controller = new AbortController();
    const response = await providerFetch(config)(
      `${config.endpoint}/chat/completions`,
      { method: "POST", body: "{}", signal: controller.signal },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "data: fake-first\n\n");
    controller.abort("fake-sensitive-abort-reason");
    await assert.rejects(
      reader.read(),
      (error: Error) =>
        error.name === "AbortError" &&
        !error.message.includes("fake-sensitive"),
    );
    await connectionClosed;
  } finally {
    await local.close();
  }
});

test("abort cancels a pending DNS lookup promptly with a sanitized AbortError", async () => {
  const config = endpoint("https://dns-test.invalid");
  const controller = new AbortController();
  const request = providerFetch(config, {
    lookup: async () => new Promise(() => {}),
  })(providerModelsUrl(config), { signal: controller.signal });
  controller.abort("fake-secret");
  await assert.rejects(
    request,
    (error: Error) =>
      error.name === "AbortError" && !error.message.includes("fake-secret"),
  );
});

test("abort before asynchronous body preparation finishes prevents DNS resolution", async () => {
  const config = endpoint("https://dns-test.invalid");
  const controller = new AbortController();
  let lookups = 0;
  const pending = providerFetch(config, {
    lookup: async () => {
      lookups++;
      return [{ address: "1.1.1.1", family: 4 }];
    },
  })(providerModelsUrl(config), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  assert.equal(lookups, 0);
});

test("abort before response headers closes the request connection", async () => {
  let received!: () => void;
  let closed!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const connectionClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const local = await localServer((req) => {
    req.socket.on("close", closed);
    received();
  });
  try {
    const config = endpoint(local.origin, true);
    const controller = new AbortController();
    const pending = providerFetch(config)(providerModelsUrl(config), {
      signal: controller.signal,
    });
    await requestReceived;
    controller.abort();
    await assert.rejects(
      pending,
      (error: Error) => error.name === "AbortError",
    );
    await connectionClosed;
  } finally {
    await local.close();
  }
});

test("cancelling the response stream closes the upstream socket", async () => {
  let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const local = await localServer((req, res) => {
    req.socket.on("close", closed);
    res.write("data: fake-first\n\n");
  });
  try {
    const config = endpoint(local.origin, true);
    const response = await providerFetch(config)(providerModelsUrl(config));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("obvious-fake-cancel-reason");
    await connectionClosed;
  } finally {
    await local.close();
  }
});

test("an unread response applies byte-bounded backpressure to upstream streaming", async () => {
  const chunk = Buffer.alloc(64 * 1024, "x");
  const totalChunks = 512;
  let chunksWritten = 0;
  const local = await localServer((_req, res) => {
    const write = () => {
      while (chunksWritten < totalChunks && !res.destroyed) {
        chunksWritten++;
        if (!res.write(chunk)) {
          res.once("drain", write);
          return;
        }
      }
      if (chunksWritten === totalChunks) res.end();
    };
    write();
  });
  try {
    const config = endpoint(local.origin, true);
    const response = await providerFetch(config)(providerModelsUrl(config));
    await delay(300);
    assert.ok(
      chunksWritten < totalChunks,
      "The transport must pause the socket instead of buffering the full 32 MiB response",
    );
    await response.body!.cancel();
  } finally {
    await local.close();
  }
});

test("compressed responses are safely refused after requesting identity encoding", async () => {
  let encoding = "";
  const local = await localServer((req, res) => {
    encoding = req.headers["accept-encoding"] ?? "";
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end("obvious-fake-upstream-error");
  });
  try {
    const config = endpoint(local.origin, true);
    const response = await providerFetch(config)(providerModelsUrl(config), {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(encoding, "identity");
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /obvious-fake/);
  } finally {
    await local.close();
  }
});

test("streaming uploads and oversized request bodies are explicitly rejected", async () => {
  const config = endpoint("http://127.0.0.1:65534", true);
  const guarded = providerFetch(config);
  await assert.rejects(
    guarded(`${config.endpoint}/chat/completions`, {
      method: "POST",
      body: new ReadableStream(),
    }),
    /Upload de API não suportado/,
  );
  await assert.rejects(
    guarded(`${config.endpoint}/chat/completions`, {
      method: "POST",
      body: "x".repeat(32 * 1024 * 1024 + 1),
    }),
    /Requisição de API muito grande/,
  );
});

test("ambient Node proxy settings cannot replace the pinned direct destination", async () => {
  let upstreamHits = 0;
  let proxyHits = 0;
  const local = await localServer((_req, res) => {
    upstreamHits++;
    res.end('{"direct":true}');
  });
  const proxy = await localServer((_req, res) => {
    proxyHits++;
    res.end('{"proxy":true}');
  });
  try {
    const code = `
      import { parseProviderEndpoint, providerFetch, providerModelsUrl } from './src/provider-endpoint.ts';
      const config = parseProviderEndpoint({ protocol: 'openai-compatible', endpoint: 'http://pin-test.invalid:${local.port}', allowLocal: true });
      const response = await providerFetch(config, { lookup: async () => [{address: '127.0.0.1', family: 4}] })(providerModelsUrl(config));
      if (!(await response.json()).direct) throw new Error('Expected direct transport');
    `;
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: "1",
          HTTP_PROXY: proxy.origin,
          http_proxy: proxy.origin,
          HTTPS_PROXY: proxy.origin,
          https_proxy: proxy.origin,
          NO_PROXY: "",
          no_proxy: "",
        },
        timeout: 10_000,
      },
    );
    assert.equal(upstreamHits, 1);
    assert.equal(proxyHits, 0);
  } finally {
    await local.close();
    await proxy.close();
  }
});

test("real SDK adapters consume guarded OpenAI and Anthropic SSE with synthetic credentials", async () => {
  for (const protocol of ["openai-compatible", "anthropic"] as const) {
    let observedAuth: string | undefined;
    let observedPath: string | undefined;
    const local = await localServer((req, res) => {
      observedAuth =
        protocol === "anthropic"
          ? (req.headers["x-api-key"] as string)
          : req.headers.authorization;
      observedPath = req.url;
      res.setHeader("content-type", "text/event-stream");
      const event = (type: string, data: unknown) =>
        `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      if (protocol === "openai-compatible") {
        res.end(
          `data: ${JSON.stringify({ id: "fake-completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic SDK reply" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fake-completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        res.end(
          event("message_start", {
            type: "message_start",
            message: {
              id: "fake-message",
              type: "message",
              role: "assistant",
              model: "fake-model",
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
              delta: { type: "text_delta", text: "Synthetic SDK reply" },
            }) +
            event("content_block_stop", {
              type: "content_block_stop",
              index: 0,
            }) +
            event("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 3 },
            }) +
            event("message_stop", { type: "message_stop" }),
        );
      }
    });
    try {
      const config = endpoint(local.origin + "/gateway", true, protocol);
      const api =
        protocol === "anthropic"
          ? anthropicMessagesApi()
          : openAICompletionsApi();
      const model: Model<Api> = {
        id: "fake-model",
        name: "Fake model",
        provider: "custom-fake-provider",
        api:
          protocol === "anthropic"
            ? "anthropic-messages"
            : "openai-completions",
        baseUrl: config.endpoint,
        input: ["text"],
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const context = normalizeContext({
        messages: [{ role: "user", content: "Synthetic input", timestamp: 1 }],
      });
      const stream = api.streamSimple(model, context, {
        apiKey: "obvious-fake-sdk-key",
        fetch: providerFetch(config),
        maxRetries: 0,
      });
      const message = await stream.result();
      assert.equal(message.stopReason, "stop", message.errorMessage);
      assert.deepEqual(message.content, [
        { type: "text", text: "Synthetic SDK reply" },
      ]);
      assert.equal(
        observedPath,
        protocol === "anthropic"
          ? "/gateway/v1/messages?beta=true"
          : "/gateway/chat/completions",
      );
      assert.equal(
        observedAuth,
        protocol === "anthropic"
          ? "obvious-fake-sdk-key"
          : "Bearer obvious-fake-sdk-key",
      );
    } finally {
      await local.close();
    }
  }
});
