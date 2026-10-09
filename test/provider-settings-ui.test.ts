import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { interfaceLanguage } from "./interface-fixture.js";

type Request = { path: string; method: string; data?: unknown };
type FormEvent = { preventDefault(): void; submitter?: Element };
class Element {
  value = "";
  textContent = "";
  className = "";
  disabled = false;
  hidden = false;
  required = false;
  checked = false;
  open = false;
  children: Element[] = [];
  reports = 0;
  customValidity = "";
  onclick?: () => unknown;
  onchange?: () => unknown;
  onsubmit?: (event: FormEvent) => unknown;
  validity?: () => boolean;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => void>>();
  constructor(
    readonly id = "",
    readonly tag = "div",
  ) {}
  get options() {
    return this.children;
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
    if (this.tag === "select") this.value = children[0]?.value || "";
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }
  setCustomValidity(value: string) {
    this.customValidity = value;
  }
  checkValidity() {
    return (
      this.disabled ||
      (!this.customValidity &&
        (this.validity?.() ??
          (!this.required ||
            (this.id.endsWith("-replace")
              ? this.checked
              : Boolean(this.value)))))
    );
  }
  reportValidity() {
    this.reports++;
    return this.checkValidity();
  }
  closest() {
    return null;
  }
  querySelector() {
    return new Element("submit", "button");
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.emit("close");
  }
  emit(name: string) {
    for (const listener of this.listeners.get(name) || []) listener();
  }
  reset() {}
  focus() {}
  scrollIntoView() {}
}
function fixture({
  language = "pt-BR",
  credentialType = null,
  save = async () => {},
  oauthFailure = false,
}: {
  language?: string;
  credentialType?: "oauth" | "api_key" | null;
  save?: (request: Request) => Promise<void>;
  oauthFailure?: boolean;
} = {}) {
  const page = interfaceLanguage(language);
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) {
      const tag = /(?:provider|model|effort|auth-method)$/.test(id)
        ? "select"
        : "div";
      const element = new Element(id, tag);
      if (id.endsWith("-api-key")) element.required = true;
      elements.set(id, element);
    }
    return elements.get(id)!;
  };
  const method = get("openai-auth-method");
  method.append(
    ...["oauth", "api_key"].map((value) => {
      const option = new Element();
      option.value = value;
      return option;
    }),
  );
  for (const provider of ["openai", "anthropic", "deepseek"]) {
    get(`${provider}-api-form`).validity = () =>
      get(`${provider}-api-key`).checkValidity() &&
      get(`${provider}-replace`).checkValidity();
  }
  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      authTypes: ["oauth", "api_key"],
      credentialType,
      models: [
        {
          provider: "openai",
          id: "shared",
          name: "OpenAI shared",
          efforts: ["off", "low"],
        },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      authTypes: ["api_key"],
      credentialType: null as "api_key" | null,
      models: [
        {
          provider: "anthropic",
          id: "shared",
          name: "Claude shared",
          efforts: ["high"],
        },
      ],
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      authTypes: ["api_key"],
      credentialType: null as "api_key" | null,
      models: [
        {
          provider: "deepseek",
          id: "deepseek-flash",
          name: "DeepSeek Flash",
          efforts: ["off", "high"],
        },
      ],
    },
  ];
  const settings = {
    provider: "openai",
    modelId: "shared",
    effort: "low",
    providers,
    models: providers[0].models,
    mcp: [],
  };
  const requests: Request[] = [];
  const oauth: unknown[] = [];
  const api = async (path: string, method = "GET", data?: unknown) => {
    const request = { path, method, data };
    requests.push(request);
    if (method === "PUT" && path.endsWith("/api-key")) {
      await save(request);
      const provider = providers.find((entry) =>
        path.includes(`/${entry.id}/`),
      )!;
      provider.credentialType = "api_key";
      return { provider: provider.id, credentialType: "api_key" };
    }
    return settings;
  };
  const configure = runInNewContext(
    readFileSync(
      new URL("../public/settings.js", import.meta.url),
      "utf8",
    ).replaceAll("export ", "") + "\nconfigureUI",
    {
      PiI18n: page.i18n,
      document: {
        getElementById: get,
        querySelector: () => get("provider-label"),
      },
      URLSearchParams,
      URL,
      Intl,
      Date,
    },
  );
  const ui = configure(api, {
    node: (tag: string, value?: string) => {
      const element = new Element("", tag);
      element.textContent = value ?? "";
      return element;
    },
    icon: () => new Element(),
    closeSidebar() {},
    getConversationId: () => "conversation",
    refreshStatus: async () => {},
    refreshConversation: async () => {},
    connectProvider: async (payload: unknown) => {
      oauth.push(payload);
      if (oauthFailure) {
        await Promise.resolve();
        throw new Error("synthetic cancelled login");
      }
    },
  });
  return { ...page, get, ui, requests, oauth, providers };
}
const submit = (element: Element) =>
  element.onsubmit!({
    preventDefault() {},
    submitter: new Element("submit", "button"),
  });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("opening settings reads metadata without changing credentials; API replacement requires explicit acknowledgment", async () => {
  const f = fixture({ credentialType: "oauth" });
  await f.ui.load();
  assert.equal(f.get("openai-auth-method").value, "oauth");
  assert.equal(
    f.requests.some((entry) => entry.method !== "GET"),
    false,
  );
  f.get("openai-auth-method").value = "api_key";
  f.get("openai-auth-method").onchange!();
  f.get("openai-api-key").value = "synthetic-key";
  await submit(f.get("openai-api-form"));
  await flush();
  assert.equal(
    f.requests.some((entry) => entry.method === "PUT"),
    false,
  );
  assert.equal(f.get("openai-api-form").reports, 1);
  f.get("openai-replace").checked = true;
  await submit(f.get("openai-api-form"));
  await flush();
  const saved = f.requests.find((entry) => entry.method === "PUT")!;
  assert.equal(
    JSON.stringify(saved.data),
    JSON.stringify({ apiKey: "synthetic-key", replace: true }),
  );
  assert.equal(f.get("openai-api-key").value, "");
  assert.equal(f.get("provider-status").textContent, "Chave API configurada");
  assert.equal(f.get("openai-replace").checked, false);
});

test("API keys clear before the request resolves and generic translated errors never expose service details", async () => {
  let reject!: (error: Error) => void;
  const f = fixture({
    language: "en",
    save: () =>
      new Promise((_resolve, failure) => {
        reject = failure;
      }),
  });
  await f.ui.load();
  f.get("anthropic-api-key").value = "synthetic-anthropic-key";
  submit(f.get("anthropic-api-form"));
  assert.equal(f.get("anthropic-api-key").value, "");
  assert.equal(f.get("provider-connections").disabled, true);
  reject(new Error("remote diagnostic containing synthetic-anthropic-key"));
  await flush();
  assert.equal(
    f.get("anthropic-connection-error").textContent,
    "Could not save the connection. Please try again.",
  );
  assert.equal(f.get("provider-connections").disabled, false);
  assert.equal(
    JSON.stringify([...f.storage]),
    JSON.stringify([["pi:language", "en"]]),
  );
});

test("method changes, closing settings and logout reset clear keys; language changes preserve values", async () => {
  const f = fixture();
  await f.ui.load();
  f.get("openai-api-key").value = "temporary-key";
  f.i18n.setLanguage("en");
  assert.equal(f.get("openai-api-key").value, "temporary-key");
  f.get("openai-auth-method").value = "api_key";
  f.get("openai-auth-method").onchange!();
  assert.equal(f.get("openai-api-key").value, "");
  f.get("anthropic-api-key").value = "temporary-key";
  f.get("settings-dialog").close();
  assert.equal(f.get("anthropic-api-key").value, "");
  f.get("openai-api-key").value = "temporary-key";
  f.ui.reset();
  assert.equal(f.get("openai-api-key").value, "");
  assert.equal(f.get("provider-connections").disabled, true);
});

test("OAuth replacement requires acknowledgment for an existing API key and sends no secret input", async () => {
  const f = fixture({ credentialType: "api_key" });
  await f.ui.load();
  f.get("openai-auth-method").value = "oauth";
  f.get("openai-auth-method").onchange!();
  await f.get("provider-button").onclick!();
  assert.equal(f.oauth.length, 0);
  assert.equal(f.get("openai-replace").reports, 1);
  f.get("openai-replace").checked = true;
  f.get("anthropic-api-key").value = "temporary-key";
  await f.get("provider-button").onclick!();
  assert.equal(
    JSON.stringify(f.oauth),
    JSON.stringify([{ provider: "openai", type: "oauth", replace: true }]),
  );
  assert.equal(f.get("anthropic-api-key").value, "");
});

test("conversation model and effort use its own provider catalog even when IDs overlap the global default", async () => {
  const f = fixture();
  await f.ui.load();
  f.ui.updateConversation({
    provider: "anthropic",
    modelId: "shared",
    effort: "high",
  });
  assert.equal(f.get("model-label").textContent, "Claude shared · Alto");
  f.get("model-label").onclick!();
  await flush();
  assert.equal(f.get("conversation-provider").value, "anthropic");
  assert.equal(
    f.get("conversation-model").children[0].textContent,
    "Claude shared",
  );
  assert.equal(f.get("conversation-effort").value, "high");
  submit(f.get("conversation-settings-form"));
  await flush();
  const saved = f.requests.find(
    (entry) =>
      entry.path.endsWith("/conversation/settings") && entry.method === "PUT",
  )!;
  assert.equal(
    JSON.stringify(saved.data),
    JSON.stringify({
      provider: "anthropic",
      modelId: "shared",
      effort: "high",
    }),
  );
  f.get("settings-button").onclick!();
  await flush();
  f.get("default-provider").value = "anthropic";
  f.get("default-provider").onchange!();
  assert.equal(f.get("default-model").children[0].textContent, "Claude shared");
  assert.equal(f.get("default-effort").value, "high");
});

test("closing or logging out during a pending key save keeps secrets cleared and prevents stale UI updates", async () => {
  let resolve!: () => void;
  const f = fixture({
    save: () =>
      new Promise<void>((success) => {
        resolve = success;
      }),
  });
  await f.ui.load();
  f.get("anthropic-api-key").value = "synthetic-pending-key";
  submit(f.get("anthropic-api-form"));
  f.ui.reset();
  resolve();
  await flush();
  assert.equal(f.get("anthropic-api-key").value, "");
  assert.equal(f.get("anthropic-connection-feedback").textContent, "");
  assert.equal(f.get("provider-connections").disabled, true);
});

for (const outcome of ["completed", "cancelled"]) {
  test(`OAuth ${outcome} restores authentication controls without reopening Settings`, async () => {
    const f = fixture({
      credentialType: "oauth",
      oauthFailure: outcome === "cancelled",
    });
    await f.ui.load();
    f.get("openai-replace").checked = true;
    const original = f.get("provider-button").onclick!;
    // An OAuth poll can refresh provider metadata while the initial request is still busy.
    const pending = original();
    f.ui.updateProviders(f.providers);
    assert.equal(f.get("provider-button").disabled, true);
    await pending;
    assert.equal(f.get("provider-button").disabled, false);
    assert.equal(f.get("openai-auth-method").disabled, false);
    assert.equal(f.get("provider-connections").disabled, false);
    if (outcome === "cancelled")
      assert.equal(
        f.get("openai-connection-error").textContent,
        "Não foi possível iniciar a conexão. Tente novamente.",
      );
  });
}

test("reopening Settings during a pending API save restores controls when that request completes", async () => {
  let resolve!: () => void;
  const f = fixture({
    save: () =>
      new Promise<void>((success) => {
        resolve = success;
      }),
  });
  await f.ui.load();
  f.get("anthropic-api-key").value = "synthetic-pending-key";
  submit(f.get("anthropic-api-form"));
  f.get("settings-dialog").close();
  f.get("settings-button").onclick!();
  await flush();
  assert.equal(f.get("anthropic-api-save").disabled, true);
  resolve();
  await flush();
  assert.equal(f.get("anthropic-api-key").value, "");
  assert.equal(f.get("anthropic-api-save").disabled, false);
  assert.equal(f.get("openai-auth-method").disabled, false);
});

test("DeepSeek uses the same write-only save and explicit replacement lifecycle", async () => {
  const f = fixture({ language: "en" });
  await f.ui.load();
  assert.equal(f.get("deepseek-api-save").disabled, false);
  f.get("deepseek-api-key").value = "synthetic-deepseek-key";
  submit(f.get("deepseek-api-form"));
  await flush();
  assert.equal(f.get("deepseek-api-key").value, "");
  assert.equal(f.get("deepseek-status").textContent, "API key configured");
  assert.equal(f.get("deepseek-replace").required, true);
  const first = f.requests.find(
    (entry) =>
      entry.path === "/api/provider/deepseek/api-key" && entry.method === "PUT",
  )!;
  assert.equal(
    JSON.stringify(first.data),
    JSON.stringify({ apiKey: "synthetic-deepseek-key" }),
  );
  f.get("deepseek-api-key").value = "synthetic-deepseek-replacement";
  submit(f.get("deepseek-api-form"));
  await flush();
  assert.equal(
    f.requests.filter(
      (entry) => entry.path === first.path && entry.method === "PUT",
    ).length,
    1,
  );
  f.get("deepseek-replace").checked = true;
  submit(f.get("deepseek-api-form"));
  await flush();
  const replacement = f.requests
    .filter((entry) => entry.path === first.path && entry.method === "PUT")
    .at(-1)!;
  assert.equal(
    JSON.stringify(replacement.data),
    JSON.stringify({ apiKey: "synthetic-deepseek-replacement", replace: true }),
  );
  f.get("deepseek-api-key").value = "temporary-key";
  f.get("settings-dialog").close();
  assert.equal(f.get("deepseek-api-key").value, "");
  f.get("settings-button").onclick!();
  await flush();
  f.get("default-provider").value = "deepseek";
  f.get("default-provider").onchange!();
  assert.equal(
    f.get("default-model").children[0].textContent,
    "DeepSeek Flash",
  );
});
