import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Store, SqlCredentials } from "../src/store.js";
import { ProviderLogin } from "../src/provider-login.js";
test("provider-owned OAuth interaction stores issued credentials separately, blocks other sessions, handles manual prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-oauth-"));
  const store = new Store(dir);
  const credentials = new SqlCredentials(store);
  const models = createModels({ credentials });
  const base = fauxProvider({ provider: "openai" }).provider;
  models.setProvider({
    ...base,
    auth: {
      oauth: {
        name: "mock OAuth",
        login: async (interaction) => {
          interaction.notify({
            type: "auth_url",
            url: "https://example.invalid/mock-oauth",
          });
          const value = await interaction.prompt({
            type: "manual_code",
            message: "Paste mock callback",
          });
          assert.equal(value, "mock-callback");
          return {
            type: "oauth",
            access: "mock-access-not-a-real-token",
            refresh: "mock-refresh-not-a-real-token",
            expires: Date.now() + 3600000,
          };
        },
        refresh: async (credential) => credential,
        toAuth: async () => ({}),
      },
    },
  });
  const login = new ProviderLogin(models, store);
  try {
    const id = login.start("web-session-a");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.throws(() => login.get("web-session-b", id), /não encontrado/);
    const state = login.get("web-session-a", id);
    assert.equal(state.events[0].type, "auth_url");
    assert.equal(state.prompt?.type, "manual_code");
    login.answer("web-session-a", id, state.prompt!.id, "mock-callback");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(login.get("web-session-a", id).state, "done");
    assert.equal((await credentials.read("openai"))?.type, "oauth");
    assert.equal(store.all("SELECT * FROM sessions").length, 0);
    const credentialStore = new SqlCredentials(store);
    let parallel = 0,
      max = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        credentialStore.modify("openai", async (current) => {
          parallel++;
          max = Math.max(max, parallel);
          await new Promise((resolve) => setTimeout(resolve, 5));
          parallel--;
          return current;
        }),
      ),
    );
    assert.equal(max, 1);
  } finally {
    login.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
