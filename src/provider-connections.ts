import { randomUUID } from "node:crypto";
import {
  createProvider,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type ApiKeyCredential,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Api,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { SettingsError } from "./settings.js";
import type { Store } from "./store.js";
import {
  parseProviderEndpoint,
  providerFetch,
  providerModelsUrl,
  type ProviderEndpoint,
} from "./provider-endpoint.js";

interface Connection extends ProviderEndpoint {
  id: string;
  modelId: string;
}
export interface ConnectionMetadata extends Connection {
  name: string;
  hasApiKey: boolean;
  credentialType: "api_key";
}
const prefix = "custom-connection:";
const customId =
  /^custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const invalidKey = () =>
  new SettingsError("Chave de API inválida; informe uma chave de API padrão");
const validLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(value);
function reflects(value: string, key: string) {
  return !!key && value.toLowerCase().includes(key.toLowerCase());
}
function connectionName(config: ProviderEndpoint) {
  return `${config.protocol === "anthropic" ? "Anthropic" : "OpenAI compatible"} · ${new URL(config.endpoint).host}`;
}
function validateKey(
  value: unknown,
  config: ProviderEndpoint,
  modelId = "",
): string {
  if (
    typeof value !== "string" ||
    value.length > 16000 ||
    /[\s\u0000-\u001f\u007f-\u009f]/.test(value) ||
    (!value && !config.allowLocal) ||
    (config.protocol === "anthropic" && value.includes("sk-ant-oat")) ||
    reflects(
      JSON.stringify({
        ...config,
        modelId,
        name: connectionName(config),
        hasApiKey: !!value,
        credentialType: "api_key",
      }),
      value,
    )
  )
    throw invalidKey();
  return value;
}

/** Keep the SDK event/result contract while excluding untrusted error details. */
function safeStream(
  start: () => AssistantMessageEventStream,
  model: Model<Api>,
  key: string,
  signal?: AbortSignal,
) {
  const outer = createAssistantMessageEventStream();
  let partial: AssistantMessage | undefined;
  const failure = (
    reason: "error" | "aborted",
    source?: AssistantMessage,
  ): AssistantMessage => ({
    role: "assistant",
    content: source ? clean(source.content) : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: source
      ? clean(source.usage)
      : {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    stopReason: reason,
    errorMessage:
      reason === "aborted"
        ? "Solicitação de API cancelada"
        : "Falha na conexão de API customizada",
    timestamp: Date.now(),
  });
  // Clone before forwarding: SDK partials are live objects that can later gain
  // raw error details. Keep one separate live partial for consumers.
  const clean = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value, (name, item) => {
        if (name === "diagnostics" || name === "rawStopReason")
          return undefined;
        if (name === "errorMessage")
          return "Falha na conexão de API customizada";
        return key && typeof item === "string"
          ? item.split(key).join("[redacted]")
          : item;
      }),
    ) as T;
  const updatePartial = (message: AssistantMessage) => {
    if (!partial) partial = message;
    else {
      for (const name of Object.keys(partial))
        delete (partial as unknown as Record<string, unknown>)[name];
      Object.assign(partial, message);
    }
    return partial;
  };
  void (async () => {
    try {
      const inner = start();
      for await (const event of inner) {
        if (event.type === "error") {
          const message = updatePartial(failure(event.reason, event.error));
          outer.push({ type: "error", reason: event.reason, error: message });
          outer.end(message);
          return;
        }
        const forwarded: AssistantMessageEvent = clean(event);
        if ("partial" in forwarded)
          forwarded.partial = updatePartial(forwarded.partial);
        if (forwarded.type === "done") {
          forwarded.message = updatePartial(forwarded.message);
          outer.push(forwarded);
          outer.end(forwarded.message);
          return;
        }
        outer.push(forwarded);
      }
      // A truncated iterator must never turn a failed request into success.
      throw new Error();
    } catch {
      const reason = signal?.aborted ? "aborted" : "error";
      const message = updatePartial(failure(reason, partial));
      outer.push({ type: "error", reason, error: message });
      outer.end(message);
    }
  })();
  return outer;
}

/** Custom targets are immutable, namespaced, and never borrow native credentials. */
export class ProviderConnections {
  private connections = new Map<string, Connection>();
  constructor(
    private models: MutableModels,
    private store: Store,
    private checkIdle: () => Promise<void> = async () => {},
    private mode: "live" | "demo" = "live",
  ) {}
  private assertLive() {
    if (this.mode !== "live")
      throw new SettingsError("Ative APP_MODE=live para conectar o provider");
  }
  private readCredential(config: Connection): ApiKeyCredential | undefined {
    try {
      const row = this.store.get<{ value: string }>(
        "SELECT value FROM credentials WHERE provider=?",
        config.id,
      );
      if (!row) return undefined;
      const value: unknown = JSON.parse(row.value);
      if (
        !value ||
        typeof value !== "object" ||
        !("type" in value) ||
        value.type !== "api_key" ||
        !("key" in value)
      )
        return undefined;
      const key = validateKey(value.key, config, config.modelId);
      return { type: "api_key", key };
    } catch {
      return undefined;
    }
  }
  private metadata(config: Connection): ConnectionMetadata {
    return {
      ...config,
      name: connectionName(config),
      hasApiKey: !!this.readCredential(config)?.key,
      credentialType: "api_key",
    };
  }
  list() {
    return [...this.connections.values()].map((config) =>
      this.metadata(config),
    );
  }
  private provider(config: Connection) {
    const adapter =
      config.protocol === "anthropic"
        ? anthropicMessagesApi()
        : openAICompletionsApi();
    const authenticated = providerFetch(config);
    const keyless = config.allowLocal
      ? providerFetch(config, { keyless: true })
      : undefined;
    const model = {
      id: config.modelId,
      name: config.modelId,
      api:
        config.protocol === "anthropic"
          ? ("anthropic-messages" as const)
          : ("openai-completions" as const),
      provider: config.id,
      baseUrl: config.endpoint,
      input: ["text" as const],
      reasoning: false,
      // Conservative manual defaults; upstream limits and pricing are unknown.
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const guardedOptions = <T extends object>(options?: T) => {
      const credential = this.readCredential(config);
      if (!credential)
        throw new SettingsError(
          "Conecte este provider antes de enviar mensagens",
        );
      return {
        ...options,
        apiKey: credential.key || "pi-local-keyless",
        fetch: credential.key ? authenticated : keyless!,
        env: {},
        headers: undefined,
        // SDK extension points must not bypass the guarded HTTP client.
        client: undefined,
        transport: "sse" as const,
      };
    };
    const api: ProviderStreams = {
      stream: (_model, context, options) =>
        safeStream(
          () => adapter.stream({ ...model }, context, guardedOptions(options)),
          model,
          this.readCredential(config)?.key ?? "",
          options?.signal,
        ),
      streamSimple: (_model, context, options) =>
        safeStream(
          () =>
            adapter.streamSimple(
              { ...model },
              context,
              guardedOptions(options),
            ),
          model,
          this.readCredential(config)?.key ?? "",
          options?.signal,
        ),
    };
    return createProvider({
      id: config.id,
      name: this.metadata(config).name,
      baseUrl: config.endpoint,
      models: [structuredClone(model)],
      auth: {
        apiKey: {
          name: "Custom API key",
          login: async (interaction) => ({
            type: "api_key",
            key: validateKey(
              await interaction.prompt({
                type: "secret",
                message: "Chave de API",
              }),
              config,
              config.modelId,
            ),
          }),
          resolve: async ({ signal }) => {
            signal.throwIfAborted();
            const credential = this.readCredential(config);
            return credential
              ? {
                  auth: {
                    apiKey: credential.key || "pi-local-keyless",
                    baseUrl: config.endpoint,
                  },
                  source: "Custom API key",
                }
              : undefined;
          },
        },
      },
      api,
    });
  }
  restore() {
    if (this.mode !== "live") return;
    for (const row of this.store.all<{ key: string; value: string }>(
      "SELECT key,value FROM meta WHERE key LIKE 'custom-connection:%'",
    )) {
      try {
        const value: unknown = JSON.parse(row.value);
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        const input = value as Record<string, unknown>;
        if (
          Object.keys(input).some(
            (key) =>
              !["id", "modelId", "protocol", "endpoint", "allowLocal"].includes(
                key,
              ),
          )
        )
          continue;
        if (
          typeof input.id !== "string" ||
          !customId.test(input.id) ||
          row.key !== prefix + input.id ||
          !validLabel(input.modelId) ||
          typeof input.endpoint !== "string" ||
          (input.protocol !== "anthropic" &&
            input.protocol !== "openai-compatible") ||
          typeof input.allowLocal !== "boolean" ||
          this.models.getProvider(input.id)
        )
          continue;
        const config: Connection = {
          protocol: input.protocol,
          endpoint: input.endpoint,
          allowLocal: input.allowLocal,
          id: input.id,
          modelId: input.modelId,
        };
        // Stored endpoints are already SDK bases. Validate the transport without
        // repeating input normalization, which could change a gateway's /v1 path.
        providerFetch(config);
        if (!this.readCredential(config)) continue;
        this.models.setProvider(this.provider(config));
        this.connections.set(config.id, config);
      } catch {
        /* Preserve malformed rows and native registrations; fail closed. */
      }
    }
  }
  async create(input: Record<string, unknown>) {
    this.assertLive();
    if (input.id !== undefined || !validLabel(input.modelId))
      throw new SettingsError(
        "Informe um modelo manual válido para uma nova conexão",
      );
    const endpoint = parseProviderEndpoint(input);
    const key = validateKey(input.apiKey, endpoint, input.modelId);
    if (this.store.credentialMutation)
      throw new SettingsError("Já existe uma conexão em andamento");
    if (
      this.store.providerAdmissions ||
      this.store.get("SELECT 1 FROM requests WHERE status='pending'")
    )
      throw new SettingsError(
        "Aguarde as conversas e tarefas concluírem antes de alterar credenciais",
      );
    this.store.credentialMutation = true;
    const config = {
      ...endpoint,
      id: `custom-${randomUUID()}`,
      modelId: input.modelId,
    };
    let transaction = false;
    let attemptedRegistration = false;
    try {
      validateKey(key, config, config.modelId);
      await this.checkIdle();
      if (
        this.store.providerAdmissions ||
        this.store.get("SELECT 1 FROM requests WHERE status='pending'")
      )
        throw new Error();
      if (
        this.models.getProvider(config.id) ||
        this.store.get("SELECT 1 FROM credentials WHERE provider=?", config.id)
      )
        throw new Error();
      this.store.db.exec("BEGIN IMMEDIATE");
      transaction = true;
      this.store.run(
        "INSERT INTO credentials VALUES (?,?)",
        config.id,
        JSON.stringify({ type: "api_key", key }),
      );
      this.store.run(
        "INSERT INTO meta VALUES (?,?)",
        prefix + config.id,
        JSON.stringify(config),
      );
      attemptedRegistration = true;
      this.models.setProvider(this.provider(config));
      this.store.db.exec("COMMIT");
      transaction = false;
      this.connections.set(config.id, config);
      return this.metadata(config);
    } catch {
      if (transaction) this.store.db.exec("ROLLBACK");
      if (attemptedRegistration) this.models.deleteProvider(config.id);
      throw new SettingsError("Não foi possível salvar a conexão customizada");
    } finally {
      this.store.credentialMutation = false;
    }
  }
  async discover(input: Record<string, unknown>) {
    this.assertLive();
    const config = parseProviderEndpoint(input);
    const key = validateKey(input.apiKey, config);
    try {
      const response = await providerFetch(config, { keyless: !key })(
        providerModelsUrl(config),
        {
          method: "GET",
          headers:
            config.protocol === "anthropic"
              ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
              : { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 1048576) throw new Error();
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        !("data" in value) ||
        !Array.isArray(value.data) ||
        value.data.length > 1000
      )
        throw new Error();
      const models: { id: string; name: string }[] = [];
      const seen = new Set<string>();
      for (const item of value.data) {
        if (
          !item ||
          typeof item !== "object" ||
          !validLabel(item.id) ||
          reflects(item.id, key) ||
          seen.has(item.id)
        )
          continue;
        const name = item.name ?? item.display_name ?? item.id;
        if (!validLabel(name) || reflects(name, key)) continue;
        seen.add(item.id);
        models.push({ id: item.id, name });
      }
      return { models };
    } catch {
      throw new SettingsError(
        "Não foi possível listar modelos; informe o ID do modelo manualmente",
      );
    }
  }
}
