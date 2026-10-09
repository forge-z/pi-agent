import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { Store, SqlCredentials } from "../src/store.js";
import { Runtime } from "../src/runtime.js";
import { ProviderConnections } from "../src/provider-connections.js";
import { ProviderLogin } from "../src/provider-login.js";

const key = "mock-custom-key-not-a-real-secret";
const input = {
  protocol: "openai-compatible",
  endpoint: "https://custom.example.invalid",
  modelId: "manual-model",
  apiKey: key,
};
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-"));
  const store = new Store(dir);
  const models = createModels({
    credentials: new SqlCredentials(store),
    authContext: {
      env: async () => "ambient-secret",
      fileExists: async () => true,
    },
  });
  return {
    dir,
    store,
    models,
    close: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("custom IDs isolate stored auth from native secrets and request/ambient overrides", async () => {
  const s = await setup();
  try {
    const native =
      '{"type":"oauth","access":"mock-native-access","refresh":"mock-native-refresh","expires":9999999999999}';
    s.store.run("INSERT INTO credentials VALUES (?,?)", "openai", native);
    const manager = new ProviderConnections(s.models, s.store);
    const first = await manager.create(input);
    const second = await manager.create({
      ...input,
      apiKey: key + "-second",
      protocol: "anthropic",
      endpoint: "https://anthropic.example.invalid/v1",
    });
    assert.match(first.id, /^custom-[a-f0-9-]{36}$/);
    assert.notEqual(first.id, second.id);
    assert.equal(
      (
        await s.models.getAuth(first.id, {
          apiKey: "override",
          env: { OPENAI_API_KEY: "override-env" },
        })
      )?.auth.apiKey,
      key,
    );
    assert.equal(
      (await s.models.getAuth(second.id))?.auth.apiKey,
      key + "-second",
    );
    assert.equal(
      s.store.get<{ value: string }>(
        "SELECT value FROM credentials WHERE provider='openai'",
      )?.value,
      native,
    );
    assert.ok(!JSON.stringify(manager.list()).includes(key));
    assert.ok(
      !JSON.stringify(
        s.store.all(
          "SELECT value FROM meta WHERE key LIKE 'custom-connection:%'",
        ),
      ).includes(key),
    );
    s.store.run("DELETE FROM credentials WHERE provider=?", first.id);
    assert.equal(
      await s.models.getAuth(first.id, { apiKey: "override" }),
      undefined,
    );
  } finally {
    await s.close();
  }
});

test("fresh endpoint creation requires explicit valid fresh credentials and immutable target", async () => {
  const s = await setup();
  try {
    const manager = new ProviderConnections(s.models, s.store);
    const saved = await manager.create(input);
    for (const apiKey of [
      undefined,
      null,
      "",
      "space key",
      "key\nvalue",
      "x".repeat(16001),
    ])
      await assert.rejects(manager.create({ ...input, apiKey }));
    await assert.rejects(
      manager.create({
        ...input,
        id: saved.id,
        endpoint: "https://changed.example.invalid",
      }),
    );
    await assert.rejects(
      manager.create({
        ...input,
        protocol: "anthropic",
        apiKey: "sk-ant-oat-subscription",
      }),
    );
    await assert.rejects(manager.create({ ...input, modelId: key }));
    await assert.rejects(manager.create({ ...input, apiKey: "OpenAI" }));
    await assert.rejects(
      manager.create({ ...input, protocol: "anthropic", apiKey: "Anthropic" }),
    );
    await assert.rejects(
      manager.create({ ...input, endpoint: `https://${key}.example.invalid` }),
    );
    assert.equal(manager.list().length, 1);
  } finally {
    await s.close();
  }
});

test("manual models and saved defaults restore in live mode; demo does not restore custom providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-runtime-"));
  const gateway = { call: async () => ({ content: [] }) };
  let app = await Runtime.open({ dir, gateway, mode: "live" });
  try {
    const saved = await app.providerConnections.create(input);
    app.settings.saveDefaults({
      provider: saved.id,
      modelId: input.modelId,
      effort: "off",
    });
    await app.close();
    app = await Runtime.open({ dir, gateway, mode: "live" });
    assert.equal(app.settings.defaults().provider, saved.id);
    assert.equal(
      app.models.getModel(saved.id, input.modelId)?.contextWindow,
      32768,
    );
    assert.deepEqual(app.settings.catalog(saved.id)[0].efforts, ["off"]);
    assert.equal(app.settings.snapshot().customConnections[0].id, saved.id);
    await app.close();
    app = await Runtime.open({ dir, gateway, mode: "demo" });
    assert.equal(app.models.getProvider(saved.id), undefined);
    assert.deepEqual(app.providerConnections.list(), []);
    await assert.rejects(app.providerConnections.create(input));
    await assert.rejects(app.providerConnections.discover(input));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("credential reservations block races and failures roll back both registry and storage", async () => {
  const s = await setup();
  try {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new ProviderConnections(
      s.models,
      s.store,
      async () => waiting,
    );
    const pending = manager.create(input);
    assert.equal(s.store.credentialMutation, true);
    await assert.rejects(manager.create(input));
    release();
    await pending;
    assert.equal(s.store.credentialMutation, false);
    s.store.providerAdmissions++;
    await assert.rejects(manager.create(input));
    s.store.providerAdmissions--;
    const fail = new ProviderConnections(s.models, s.store, async () => {
      throw new Error(key);
    });
    await assert.rejects(
      fail.create(input),
      (error: Error) => !error.message.includes(key),
    );
    const original = s.models.setProvider.bind(s.models);
    s.models.setProvider = (provider) => {
      original(provider);
      throw new Error(key);
    };
    await assert.rejects(
      manager.create(input),
      (error: Error) => !error.message.includes(key),
    );
    assert.equal(s.models.getProviders().length, 1);
    assert.equal(s.store.all("SELECT * FROM credentials").length, 1);
    assert.equal(manager.list().length, 1);
    assert.equal(s.store.credentialMutation, false);
  } finally {
    await s.close();
  }
});

test("explicit custom key rotation preserves old key on invalid replacement", async () => {
  const s = await setup();
  try {
    const manager = new ProviderConnections(s.models, s.store);
    const saved = await manager.create({ ...input, protocol: "anthropic" });
    const login = new ProviderLogin(s.models, s.store);
    await assert.rejects(
      login.saveApiKey(saved.id, key + "-new"),
      /explicitamente/,
    );
    await assert.rejects(
      login.saveApiKey(saved.id, "sk-ant-oat-invalid", true),
    );
    assert.equal((await s.models.getAuth(saved.id))?.auth.apiKey, key);
    await login.saveApiKey(saved.id, key + "-new", true);
    assert.equal((await s.models.getAuth(saved.id))?.auth.apiKey, key + "-new");
    assert.ok(!JSON.stringify(manager.list()).includes(key));
  } finally {
    await s.close();
  }
});

test("malformed persisted custom configuration cannot register native IDs or break native credentials", async () => {
  const s = await setup();
  try {
    s.store.run(
      "INSERT INTO meta VALUES (?,?)",
      "custom-connection:openai",
      JSON.stringify({ ...input, id: "openai" }),
    );
    s.store.run(
      "INSERT INTO meta VALUES (?,?)",
      "custom-connection:custom-00000000-0000-4000-8000-000000000000",
      "broken",
    );
    const manager = new ProviderConnections(s.models, s.store);
    manager.restore();
    assert.deepEqual(manager.list(), []);
    assert.equal(s.models.getProviders().length, 0);
    assert.equal(
      s.store.all("SELECT * FROM meta WHERE key LIKE 'custom-connection:%'")
        .length,
      2,
    );
  } finally {
    await s.close();
  }
});

test("restart preserves canonical Anthropic gateway prefixes without normalizing them twice", async () => {
  const s = await setup();
  try {
    const manager = new ProviderConnections(s.models, s.store);
    const saved = await manager.create({
      ...input,
      protocol: "anthropic",
      endpoint: "https://custom.example.invalid/gateway/v1/v1",
    });
    assert.equal(saved.endpoint, "https://custom.example.invalid/gateway/v1");
    const restoredModels = createModels({
      credentials: new SqlCredentials(s.store),
    });
    const restored = new ProviderConnections(restoredModels, s.store);
    restored.restore();
    assert.equal(restored.list()[0].endpoint, saved.endpoint);
    assert.equal(
      restoredModels.getModel(saved.id, input.modelId)?.baseUrl,
      saved.endpoint,
    );
    assert.equal(
      (await restoredModels.getAuth(saved.id))?.auth.baseUrl,
      saved.endpoint,
    );
  } finally {
    await s.close();
  }
});
