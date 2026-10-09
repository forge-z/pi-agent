import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type Context } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../src/runtime.js";
import { ProviderLogin } from "../src/provider-login.js";
import { SqlCredentials, Store } from "../src/store.js";
import { createAppServer } from "../src/server.js";
import { Tasks } from "../src/tasks.js";

const gateway = { call: async () => ({ content: [] }) };
const key = "mock-private-api-key-not-a-real-credential";
const oauth = {
  type: "oauth" as const,
  access: "mock-private-access",
  refresh: "mock-private-refresh",
  expires: Date.now() + 3600000,
};
async function temp() {
  return mkdtemp(join(tmpdir(), "pi-provider-api-"));
}
async function idle(app: Runtime, id: string) {
  await (await app.conversation(id)).waitForIdle(context);
  for (
    let i = 0;
    i < 100 && app.store.get("SELECT 1 FROM requests WHERE status='pending'");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
}

test("native API-key saves preserve existing auth until explicit replacement, survive restart, and expose metadata only", async () => {
  const dir = await temp();
  let app = await Runtime.open({ dir, mode: "live", gateway });
  try {
    const credentials = new SqlCredentials(app.store);
    await credentials.modify("openai", async () => oauth);
    const login = new ProviderLogin(app.models, app.store);
    const first = await app.create();
    const anthropic = app.settings.catalog("anthropic")[0];
    assert.ok(anthropic);
    app.settings.saveDefaults({
      provider: "anthropic",
      modelId: anthropic.id,
      effort: anthropic.efforts[0],
    });
    assert.deepEqual(await credentials.read("openai"), oauth);
    assert.equal((await app.settings.conversation(first)).provider, "openai");
    await assert.rejects(login.saveApiKey("openai", key), /explicitamente/);
    assert.deepEqual(await credentials.read("openai"), oauth);
    await login.saveApiKey("openai", key, true);
    assert.equal((await app.models.getAuth("openai"))?.auth.apiKey, key);
    await login.saveApiKey("anthropic", key + "-anthropic");
    await login.saveApiKey("deepseek", key + "-deepseek");
    await assert.rejects(
      login.saveApiKey("deepseek", key + "-replacement"),
      /explicitamente/,
    );
    assert.equal(
      (await app.models.getAuth("deepseek"))?.auth.apiKey,
      key + "-deepseek",
    );
    await login.saveApiKey("deepseek", key + "-deepseek-replacement", true);
    assert.deepEqual(
      app.settings.providers().find((p) => p.id === "deepseek")?.authTypes,
      ["api_key"],
    );

    assert.equal(
      (await app.models.getAuth("anthropic"))?.auth.apiKey,
      key + "-anthropic",
    );
    assert.deepEqual(
      app.settings.providers().find((p) => p.id === "anthropic")?.authTypes,
      ["api_key"],
    );
    assert.throws(
      () => login.start("owner", "anthropic", "oauth", true),
      /não disponível/,
    );
    await assert.rejects(
      login.saveApiKey("anthropic", "mock-sk-ant-oat-subscription", true),
      /padrão/,
    );
    for (const invalid of [
      "",
      "\nprivate",
      "two words",
      "\u0000private",
      "a".repeat(16001),
    ])
      await assert.rejects(
        login.saveApiKey("openai", invalid, true),
        /inválida/,
      );
    assert.doesNotMatch(
      JSON.stringify(app.settings.snapshot()),
      /mock-private|sk-ant-oat/,
    );
    const selected = await app.create();
    await app.close();
    app = await Runtime.open({ dir, mode: "live", gateway });
    assert.equal((await app.settings.conversation(first)).provider, "openai");
    assert.equal(
      (await app.settings.conversation(selected)).provider,
      "anthropic",
    );
    assert.equal(app.settings.defaults().provider, "anthropic");
    assert.equal(
      (await app.models.getAuth("deepseek"))?.auth.apiKey,
      key + "-deepseek-replacement",
    );
    assert.equal(
      (await app.models.getAuth("anthropic"))?.auth.apiKey,
      key + "-anthropic",
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Anthropic standard API auth ignores subscription ambient variables and rejects token identity triggers", async () => {
  const names = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const previous = names.map((name) => process.env[name]);
  const dir = await temp();
  const app = await Runtime.open({ dir, mode: "live", gateway });
  try {
    delete process.env.ANTHROPIC_API_KEY;
    for (const name of names.slice(1))
      process.env[name] = "mock-sk-ant-oat-token";
    assert.equal(await app.models.checkAuth("anthropic"), undefined);
    process.env.ANTHROPIC_API_KEY = "mock-sk-ant-oat-token";
    assert.equal(await app.models.checkAuth("anthropic"), undefined);
    process.env.ANTHROPIC_API_KEY = key;
    assert.equal((await app.models.getAuth("anthropic"))?.auth.apiKey, key);
  } finally {
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mock dispatch resolves each conversation's native key and schedules retain their conversation across defaults and restart", async () => {
  const dir = await temp();
  let app = await Runtime.open({ dir, mode: "live", gateway });
  const seen: { provider: string; key: string | undefined }[] = [];
  function mockDispatch() {
    for (const provider of app.models.getProviders()) {
      const faux = fauxProvider({ provider: provider.id });
      faux.setResponses(
        Array.from({ length: 10 }, () => (_transcript, options) => {
          seen.push({ provider: provider.id, key: options?.apiKey });
          return fauxAssistantMessage("Local mock response");
        }),
      );
      app.models.setProvider({
        ...provider,
        streamSimple: faux.provider.streamSimple,
        stream: faux.provider.stream,
      });
    }
  }
  try {
    const login = new ProviderLogin(app.models, app.store);
    await login.saveApiKey("openai", key + "-openai");
    await login.saveApiKey("anthropic", key + "-anthropic");
    await login.saveApiKey("deepseek", key + "-deepseek");
    mockDispatch();
    const first = await app.create();
    const model = app.settings.catalog("anthropic")[0];
    app.settings.saveDefaults({
      provider: "anthropic",
      modelId: model.id,
      effort: model.efforts[0],
    });
    const second = await app.create();
    const deepseek = app.settings.catalog("deepseek")[0];
    app.settings.saveDefaults({
      provider: "deepseek",
      modelId: deepseek.id,
      effort: "high",
    });
    const third = await app.create();
    await app.submit(first, "first", "First local mock");
    await idle(app, first);
    await app.submit(second, "second", "Second local mock");
    await idle(app, second);
    await app.submit(third, "third", "DeepSeek local mock");
    await idle(app, third);
    assert.deepEqual(seen, [
      { provider: "openai", key: key + "-openai" },
      { provider: "anthropic", key: key + "-anthropic" },
      { provider: "deepseek", key: key + "-deepseek" },
    ]);
    const epoch = Date.parse("2026-10-09T12:00:00Z");
    let now = epoch;
    let tasks = new Tasks(app, () => now);
    await tasks.create({
      title: "Local scheduled mock",
      prompt: "Scheduled mock",
      kind: "once",
      schedule: "2026-10-09T12:00:01Z",
      conversationId: first,
      delivery: "web",
      timezone: "UTC",
    });
    await tasks.close();
    await app.close();
    app = await Runtime.open({ dir, mode: "live", gateway });
    mockDispatch();
    assert.equal((await app.settings.conversation(first)).provider, "openai");
    assert.equal(
      (await app.settings.conversation(second)).provider,
      "anthropic",
    );
    assert.equal((await app.settings.conversation(third)).provider, "deepseek");
    assert.equal(app.settings.defaults().provider, "deepseek");
    now += 2000;
    tasks = new Tasks(app, () => now);
    await tasks.tick();
    await idle(app, first);
    await tasks.tick();
    assert.deepEqual(seen.at(-1), { provider: "openai", key: key + "-openai" });
    assert.equal(seen.length, 4);
    const command = await app.admit(second, "anthropic-models", "/model", {
      source: "web",
    });
    assert.ok(command.kind === "command");
    assert.match(command.text, new RegExp(model.id));
    assert.doesNotMatch(command.text, /gpt-6/);
    await tasks.close();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("credential mutation reserves admission synchronously, failures preserve auth, and per-Store adapters serialize", async () => {
  const dir = await temp();
  const store = new Store(dir);
  const credentials = new SqlCredentials(store),
    other = new SqlCredentials(store);
  const models = createModels({ credentials });
  const faux = fauxProvider({ provider: "openai" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  models.setProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Local mock",
        login: async (interaction) => {
          await gate;
          const secret = await interaction.prompt({
            type: "secret",
            message: "API key",
          });
          throw new Error(secret);
        },
        resolve: async () => undefined,
      },
    },
  });
  try {
    await credentials.modify("openai", async () => oauth);
    const login = new ProviderLogin(models, store);
    const pending = login.saveApiKey("openai", key, true);
    assert.equal(store.credentialMutation, true);
    await assert.rejects(login.saveApiKey("openai", key, true), /andamento/);
    release();
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Error && !error.message.includes(key),
    );
    assert.equal(store.credentialMutation, false);
    assert.deepEqual(await credentials.read("openai"), oauth);
    let active = 0,
      maximum = 0;
    await Promise.all(
      [credentials, other, credentials].map((adapter) =>
        adapter.modify("openai", async (current) => {
          maximum = Math.max(maximum, ++active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          --active;
          return current;
        }),
      ),
    );
    assert.equal(maximum, 1);
    store.providerAdmissions = 1;
    await assert.rejects(login.saveApiKey("openai", key, true), /Aguarde/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("API-key endpoints require session and same origin and never reflect request secrets", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, mode: "live", gateway });
  const origin = "http://localhost:3000";
  const web = createAppServer(app, {
    password: "mock-password-only",
    origin,
    secureCookie: false,
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = "";
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    requestOrigin = origin,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        cookie,
        Origin: requestOrigin,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    assert.equal(
      (await request("/api/provider/openai/api-key", "PUT", { apiKey: key }))
        .status,
      401,
    );
    const session = await request("/api/login", "POST", {
      password: "mock-password-only",
    });
    cookie = session.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await request(
          "/api/provider/openai/api-key",
          "PUT",
          { apiKey: key },
          "https://evil.invalid",
        )
      ).status,
      403,
    );
    const saved = await request("/api/provider/openai/api-key", "PUT", {
      apiKey: key,
    });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(await saved.text(), /mock-private/);
    const refusal = await request("/api/provider/openai/api-key", "PUT", {
      apiKey: key + "-replacement",
    });
    assert.equal(refusal.status, 400);
    assert.doesNotMatch(await refusal.text(), /mock-private/);
    const bad = await request("/api/provider/anthropic/api-key", "PUT", {
      apiKey: "mock-sk-ant-oat-secret",
    });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(await bad.text(), /sk-ant-oat/);
    assert.doesNotMatch(
      await (await request("/api/settings")).text(),
      /mock-private/,
    );
    assert.doesNotMatch(
      await (await request("/api/status")).text(),
      /mock-private/,
    );
    const id = await app.create();
    app.store.credentialMutation = true;
    await assert.rejects(
      app.submit(id, "blocked", "Blocked local input"),
      /Aguarde/,
    );
    assert.equal(
      app.store.get("SELECT 1 FROM requests WHERE requestId='blocked'"),
      undefined,
    );
    app.store.credentialMutation = false;
    app.store.run(
      "INSERT INTO requests(conversationId,requestId,text) VALUES (?,'pending','mock')",
      id,
    );
    assert.equal(
      (
        await request("/api/provider/openai/api-key", "PUT", {
          apiKey: key,
          replace: true,
        })
      ).status,
      400,
    );
    app.store.run("DELETE FROM requests WHERE requestId='pending'");
  } finally {
    await web.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled OAuth keeps previous auth and finished flow retention does not block a later explicit connection", async () => {
  const dir = await temp();
  const store = new Store(dir);
  const credentials = new SqlCredentials(store);
  const models = createModels({ credentials });
  const base = fauxProvider({ provider: "openai" }).provider;
  models.setProvider({
    ...base,
    auth: {
      apiKey: {
        name: "Local API key",
        login: async (interaction) => ({
          type: "api_key",
          key: await interaction.prompt({ type: "secret", message: "API key" }),
        }),
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key } } : undefined,
      },
      oauth: {
        name: "Local OAuth",
        login: async (interaction) => {
          await interaction.prompt({
            type: "manual_code",
            message: "Local code",
          });
          return oauth;
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
  });
  const login = new ProviderLogin(models, store);
  try {
    await credentials.modify("openai", async () => ({ type: "api_key", key }));
    const cancelled = login.start("owner", "openai", "oauth", true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.credentialMutation, true);
    login.cancel("owner", cancelled);
    for (let i = 0; i < 100 && store.credentialMutation; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(await credentials.read("openai"), {
      type: "api_key",
      key,
    });
    const completed = login.start("owner", "openai", "oauth", true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const state = login.get("owner", completed);
    login.answer("owner", completed, state.prompt!.id, "local-code");
    for (let i = 0; i < 100 && store.credentialMutation; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(login.get("owner", completed).state, "done");
    assert.deepEqual(await credentials.read("openai"), oauth);
    await login.saveApiKey("openai", key, true);
    assert.deepEqual(await credentials.read("openai"), {
      type: "api_key",
      key,
    });
  } finally {
    login.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy defaults migrate without changing existing conversations through demo/live mode transitions", async () => {
  const dir = await temp();
  const store = new Store(dir);
  const legacy = { modelId: "gpt-5.6-sol", effort: "low" };
  store.run(
    "INSERT INTO meta VALUES ('model-defaults:openai',?)",
    JSON.stringify(legacy),
  );
  store.close();
  let app = await Runtime.open({ dir, mode: "live", gateway });
  try {
    assert.deepEqual(app.settings.defaults(), {
      provider: "openai",
      ...legacy,
    });
    const first = await app.create();
    const model = app.settings.catalog("anthropic")[0];
    app.settings.saveDefaults({
      provider: "anthropic",
      modelId: model.id,
      effort: model.efforts[0],
    });
    const second = await app.create();
    const original = await app.settings.conversation(second);
    await app.close();
    app = await Runtime.open({ dir, mode: "demo", gateway });
    assert.deepEqual(await app.settings.conversation(second), original);
    const demo = await app.create();
    await app.close();
    app = await Runtime.open({ dir, mode: "live", gateway });
    assert.deepEqual(await app.settings.conversation(first), {
      provider: "openai",
      ...legacy,
    });
    assert.deepEqual(await app.settings.conversation(second), original);
    assert.equal((await app.settings.conversation(demo)).provider, "faux");
    await assert.rejects(
      app.submit(demo, "demo-no-reroute", "Preserve demo provider"),
      /Conecte/,
    );
    assert.equal(
      app.store.get("SELECT 1 FROM requests WHERE requestId='demo-no-reroute'"),
      undefined,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("conversation provider changes reserve the conversation against raced messages and credential saves", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, mode: "live", gateway });
  const id = await app.create();
  const inspect = app.harness.inspect.bind(app.harness);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.harness.inspect = async (...args) => {
    enter();
    await gate;
    return inspect(...args);
  };
  try {
    const model = app.settings.catalog("anthropic")[0];
    const saving = app.settings.saveConversation(id, {
      provider: "anthropic",
      modelId: model.id,
      effort: model.efforts[0],
    });
    await entered;
    await assert.rejects(
      app.submit(id, "raced-setting", "Local raced request"),
      /atualização/,
    );
    await assert.rejects(
      new ProviderLogin(app.models, app.store).saveApiKey("anthropic", key),
      /Aguarde/,
    );
    assert.equal(
      app.store.get("SELECT 1 FROM requests WHERE requestId='raced-setting'"),
      undefined,
    );
    // A scheduler run blocked by this local reservation remains retryable.
    const epoch = Date.parse("2026-10-09T12:00:00Z");
    const tasks = new Tasks(app, () => epoch);
    app.store.run(
      "INSERT INTO tasks(id,title,prompt,kind,schedule,timezone,conversationId,enabled,nextRun) VALUES ('settings-gated-task','Gate','Local pending run','once','2026-10-09T12:00:00Z','UTC',?,1,?)",
      id,
      epoch,
    );
    await tasks.tick();
    assert.equal(tasks.runs("settings-gated-task")[0].state, "pending");
    release();
    await saving;
    const native = app.models.getProvider("anthropic")!;
    const faux = fauxProvider({ provider: "anthropic" });
    faux.setResponses([fauxAssistantMessage("Local gated task result")]);
    app.models.setProvider({
      ...native,
      stream: faux.provider.stream,
      streamSimple: faux.provider.streamSimple,
    });
    await new ProviderLogin(app.models, app.store).saveApiKey("anthropic", key);
    await tasks.tick();
    await idle(app, id);
    await tasks.tick();
    assert.equal(tasks.runs("settings-gated-task")[0].state, "done");
    assert.equal(faux.state.callCount, 1);
    await tasks.close();
    assert.equal((await app.settings.conversation(id)).provider, "anthropic");
  } finally {
    release();
    app.harness.inspect = inspect;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("held OAuth delays due once/cron and queued manual runs without consuming or failing occurrences", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, mode: "live", gateway });
  let now = Date.parse("2026-10-09T12:00:00Z");
  const tasks = new Tasks(app, () => now);
  const native = app.models.getProvider("openai")!;
  const faux = fauxProvider({ provider: "openai" });
  faux.setResponses(
    Array.from({ length: 10 }, () =>
      fauxAssistantMessage("Local scheduled result"),
    ),
  );
  app.models.setProvider({
    ...native,
    streamSimple: faux.provider.streamSimple,
    stream: faux.provider.stream,
    auth: {
      ...native.auth,
      oauth: {
        name: "Local gated OAuth",
        login: async (interaction) => {
          await interaction.prompt({
            type: "manual_code",
            message: "Local gate",
          });
          return oauth;
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
  });
  const login = new ProviderLogin(app.models, app.store);
  try {
    await login.saveApiKey("openai", key);
    const id = await app.create();
    const once = await tasks.create({
      title: "Once gate",
      prompt: "Once local mock",
      kind: "once",
      schedule: "2026-10-09T12:00:01Z",
      timezone: "UTC",
      conversationId: id,
    });
    const cron = await tasks.create({
      title: "Cron gate",
      prompt: "Cron local mock",
      kind: "cron",
      schedule: "* * * * *",
      timezone: "UTC",
      conversationId: id,
    });
    const manual = await tasks.create({
      title: "Manual gate",
      prompt: "Manual local mock",
      kind: "once",
      schedule: "2026-10-09T13:00:00Z",
      timezone: "UTC",
      conversationId: id,
    });
    const flow = login.start("owner", "openai", "oauth", true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(login.get("owner", flow).prompt);
    now += 62000;
    await tasks.tick();
    assert.equal(tasks.runs(once.id).length, 0);
    assert.equal(tasks.runs(cron.id).length, 0);
    assert.equal(
      tasks.list().find((task) => task.id === once.id)?.nextRun,
      once.nextRun,
    );
    assert.equal(
      tasks.list().find((task) => task.id === cron.id)?.nextRun,
      cron.nextRun,
    );
    const queued = await tasks.runNow(manual.id, "local-manual-gate");
    assert.equal(queued.state, "pending");
    await tasks.tick();
    assert.equal(tasks.runs(manual.id)[0].state, "pending");
    assert.equal(faux.state.callCount, 0);
    login.cancel("owner", flow);
    for (let i = 0; i < 100 && app.store.credentialMutation; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    await tasks.tick();
    await idle(app, id);
    await tasks.tick();
    assert.equal(faux.state.callCount, 3);
    for (const task of [once, cron, manual]) {
      assert.equal(tasks.runs(task.id).length, 1);
      assert.equal(tasks.runs(task.id)[0].state, "done");
    }
    assert.equal(
      tasks.list().find((task) => task.id === once.id)?.enabled,
      false,
    );
    assert.equal(
      tasks.list().find((task) => task.id === cron.id)?.enabled,
      true,
    );
    await tasks.tick();
    assert.equal(faux.state.callCount, 3);
  } finally {
    login.close();
    await tasks.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("native DeepSeek wire adapter streams reasoning and tools, retains tool-loop reasoning, and maps thinking modes", async () => {
  const dir = await temp();
  const app = await Runtime.open({ dir, mode: "live", gateway });
  const payloads: Record<string, unknown>[] = [];
  const messages: Context = {
    systemPrompt: "Local mock instruction",
    messages: [{ role: "user", content: "Use the local lookup", timestamp: 1 }],
    tools: [
      {
        name: "lookup",
        description: "Local mocked lookup",
        parameters: Type.Object({ query: Type.String() }),
      },
    ],
  };
  const mockFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${key}`,
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    payloads.push(body);
    const toolTurn = payloads.length === 1;
    const delta = toolTurn
      ? {
          role: "assistant",
          reasoning_content: "Local reasoning before tool",
          tool_calls: [
            {
              index: 0,
              id: "lookup-1",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"local"}' },
            },
          ],
        }
      : { role: "assistant", content: "Local final answer" };
    const chunk = {
      id: `mock-deepseek-${payloads.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-flash",
      choices: [
        { index: 0, delta, finish_reason: toolTurn ? "tool_calls" : "stop" },
      ],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    await new ProviderLogin(app.models, app.store).saveApiKey("deepseek", key);
    const model = app.models.getModel("deepseek", "deepseek-flash")!;
    assert.ok(model);
    const first = await app.models.completeSimple(model, messages, {
      reasoning: "high",
      maxTokens: 128,
      fetch: mockFetch,
    });
    assert.equal(first.stopReason, "toolUse");
    assert.deepEqual(
      first.content.find((block) => block.type === "thinking"),
      {
        type: "thinking",
        thinking: "Local reasoning before tool",
        thinkingSignature: "reasoning_content",
      },
    );
    assert.deepEqual(
      first.content.find((block) => block.type === "toolCall"),
      {
        type: "toolCall",
        id: "lookup-1",
        name: "lookup",
        arguments: { query: "local" },
      },
    );
    messages.messages.push(first, {
      role: "toolResult",
      toolCallId: "lookup-1",
      toolName: "lookup",
      content: [{ type: "text", text: "Local lookup result" }],
      isError: false,
      timestamp: 2,
    });
    const second = await app.models.completeSimple(model, messages, {
      reasoning: "max",
      maxTokens: 128,
      fetch: mockFetch,
    });
    assert.equal(second.stopReason, "stop");
    assert.ok(
      second.content.some(
        (block) => block.type === "text" && block.text === "Local final answer",
      ),
    );
    const followup = payloads[1].messages as Record<string, unknown>[];
    const assistant = followup.find((message) => message.role === "assistant")!;
    assert.equal(assistant.reasoning_content, "Local reasoning before tool");
    assert.deepEqual(assistant.tool_calls, [
      {
        id: "lookup-1",
        type: "function",
        function: { name: "lookup", arguments: '{"query":"local"}' },
      },
    ]);
    assert.ok(
      followup.some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "lookup-1" &&
          message.content === "Local lookup result",
      ),
    );
    assert.deepEqual(payloads[0].thinking, { type: "enabled" });
    assert.equal(payloads[0].reasoning_effort, "high");
    assert.equal(payloads[1].reasoning_effort, "max");
    assert.equal(payloads[0].max_tokens, 128);
    assert.equal(payloads[0].max_completion_tokens, undefined);
    assert.equal(payloads[0].store, undefined);
    assert.ok(
      (payloads[0].messages as Record<string, unknown>[]).some(
        (message) => message.role === "system",
      ),
    );
    assert.ok(
      !(payloads[0].messages as Record<string, unknown>[]).some(
        (message) => message.role === "developer",
      ),
    );
    await app.models.completeSimple(
      model,
      {
        messages: [
          { role: "user", content: "Local non-thinking input", timestamp: 3 },
        ],
      },
      { maxTokens: 128, fetch: mockFetch },
    );
    assert.deepEqual(payloads[2].thinking, { type: "disabled" });
    assert.equal(payloads[2].reasoning_effort, undefined);
    assert.equal(payloads.length, 3);
    assert.deepEqual(
      app.settings.catalog("deepseek").map((entry) => entry.id),
      ["deepseek-flash", "deepseek-v4-pro"],
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
