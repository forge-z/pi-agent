import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models";
import type { Credential, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Runtime } from "./runtime.js";
import { McpGateway, type McpConfig } from "./mcp.js";

export interface ModelSettings {
  provider: string;
  modelId: string;
  effort: ModelThinkingLevel;
}
export class SettingsError extends Error {}
export class Settings {
  constructor(private app: Runtime) {}
  private get initialProvider() {
    return (
      this.app.options.provider ??
      (this.app.options.mode === "live" ? "openai" : "faux")
    );
  }
  private get defaultsKey() {
    return `model-defaults-selection:${this.app.options.mode ?? "demo"}`;
  }
  get provider() {
    return this.defaults().provider;
  }
  private credential(provider: string): Credential | undefined {
    const row = this.app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider=?",
      provider,
    );
    return row ? (JSON.parse(row.value) as Credential) : undefined;
  }
  defaults(): ModelSettings {
    const row =
      this.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        this.defaultsKey,
      ) ??
      this.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `model-defaults:${this.initialProvider}`,
      );
    if (row) {
      try {
        return this.validate(
          JSON.parse(row.value) as Record<string, unknown>,
          this.initialProvider,
        );
      } catch {
        /* A removed catalog entry must not break all new conversations. */
      }
    }
    const provider = this.initialProvider;
    const modelId =
      this.app.options.modelId ??
      (this.app.options.mode === "live" ? "gpt-6.1-sol" : "faux-1");
    const model = this.app.models.getModel(provider, modelId);
    return {
      provider,
      modelId,
      effort: model ? clampThinkingLevel(model, "high") : "high",
    };
  }
  catalog(provider = this.provider) {
    const registered = this.app.models.getProvider(provider);
    const models = this.app.models.getModels(provider);
    return (
      registered?.filterModels?.(models, this.credential(provider)) ?? models
    ).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      efforts: getSupportedThinkingLevels(model),
    }));
  }
  providers() {
    return this.app.models.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      authTypes: [
        ...(provider.auth.oauth?.login ? ["oauth"] : []),
        ...(provider.auth.apiKey?.login ? ["api_key"] : []),
      ],
      credentialType: this.credential(provider.id)?.type ?? null,
      models: this.catalog(provider.id),
    }));
  }
  validate(
    value: Record<string, unknown>,
    fallbackProvider = this.provider,
  ): ModelSettings {
    const provider = value.provider ?? fallbackProvider;
    if (
      typeof provider !== "string" ||
      typeof value.modelId !== "string" ||
      typeof value.effort !== "string"
    )
      throw new SettingsError("Escolha provider, modelo e esforço");
    const model = this.app.models.getModel(provider, value.modelId);
    if (
      !model ||
      !this.catalog(provider).some((entry) => entry.id === value.modelId)
    )
      throw new SettingsError("Modelo não disponível no catálogo do Pi");
    if (
      !getSupportedThinkingLevels(model).includes(
        value.effort as ModelThinkingLevel,
      )
    )
      throw new SettingsError("Esforço não suportado por este modelo");
    return {
      provider,
      modelId: value.modelId,
      effort: value.effort as ModelThinkingLevel,
    };
  }
  saveDefaults(value: Record<string, unknown>) {
    const settings = this.validate(value);
    this.app.store.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      this.defaultsKey,
      JSON.stringify(settings),
    );
    return settings;
  }
  async conversation(id: string): Promise<ModelSettings> {
    const agent = await (await this.app.conversation(id)).agent(context);
    return {
      provider: agent.model?.provider ?? this.defaults().provider,
      modelId: agent.model?.modelId ?? this.defaults().modelId,
      effort: agent.thinkingLevel,
    };
  }
  async saveConversation(id: string, value: Record<string, unknown>) {
    return this.app.withConversationSettings(id, async (conversation) => {
      const agent = await conversation.agent(context);
      const settings = this.validate(
        value,
        agent.model?.provider ?? this.provider,
      );
      const active = await this.app.harness.inspect(context);
      if (
        active.tasks.some(
          ({ record }) => String(record.conversationId) === id,
        ) ||
        this.app.store.get(
          "SELECT 1 FROM requests WHERE conversationId=? AND status='pending'",
          id,
        )
      )
        throw new SettingsError(
          "Aguarde a conversa concluir antes de mudar provider, modelo e esforço",
        );
      await conversation.configure(
        {
          model: { provider: settings.provider, modelId: settings.modelId },
          thinkingLevel: settings.effort,
        },
        context,
      );
      return settings;
    });
  }
  private gateway() {
    if (!(this.app.options.gateway instanceof McpGateway))
      throw new SettingsError("Gateway MCP não configurável neste ambiente");
    return this.app.options.gateway;
  }
  async restoreMcp() {
    const row = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='mcp-config'",
    );
    if (row) await this.gateway().replace(JSON.parse(row.value) as McpConfig[]);
  }
  mcp() {
    if (!(this.app.options.gateway instanceof McpGateway)) return [];
    return this.app.options.gateway.config.map(({ token, ...config }) => ({
      ...config,
      hasToken: !!token || !!config.tokenFile,
    }));
  }
  async saveMcp(value: unknown) {
    if (this.app.cuaHandoffs?.anyHeld())
      throw new SettingsError(
        "Resolva a intervenção humana CUA antes de alterar MCP.",
      );
    if (!Array.isArray(value) || value.length > 20)
      throw new SettingsError("Informe até 20 servidores MCP");
    const gateway = this.gateway();
    const config: McpConfig[] = value.map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.name !== "string" ||
        typeof item.url !== "string" ||
        item.name.length > 80 ||
        item.url.length > 2000 ||
        (item.mode !== "direct" &&
          (!Array.isArray(item.readTools) || !Array.isArray(item.actionTools)))
      )
        throw new SettingsError("Configuração MCP inválida");
      const old = gateway.config.find((c) => c.name === item.name);
      if (
        old &&
        old.mode !== "direct" &&
        item.mode === "direct" &&
        item.migrateLegacy !== true
      )
        throw new SettingsError(
          "Confirme explicitamente a migração para chamadas MCP diretas",
        );
      if (
        old?.url !== item.url &&
        (old?.tokenFile || (old?.token && item.token === undefined))
      )
        throw new SettingsError(
          "Para mudar o endpoint, crie outro servidor ou informe/remova explicitamente o token",
        );
      if (item.tokenFile !== undefined && item.tokenFile !== old?.tokenFile)
        throw new SettingsError(
          "Arquivos de tokens devem ser provisionados pelo operador; use token na interface",
        );
      if (
        item.token !== undefined &&
        (typeof item.token !== "string" ||
          item.token.length > 16000 ||
          /[\r\n]/.test(item.token))
      )
        throw new SettingsError("Token MCP inválido");
      return {
        name: item.name,
        url: item.url,
        mode: item.mode ?? old?.mode ?? "legacy",
        readTools: item.readTools ?? old?.readTools ?? [],
        actionTools: item.actionTools ?? old?.actionTools ?? [],
        cuaViewer:
          item.cuaViewer === undefined ? old?.cuaViewer : item.cuaViewer,
        ...(item.allowedTools !== undefined
          ? { allowedTools: item.allowedTools }
          : old && old.mode !== "direct" && item.mode === "direct"
            ? {
                allowedTools: [
                  ...new Set([...old.readTools, ...old.actionTools]),
                ],
              }
            : old?.allowedTools !== undefined
              ? { allowedTools: old.allowedTools }
              : {}),
        ...(item.deniedTools !== undefined
          ? { deniedTools: item.deniedTools }
          : old?.deniedTools !== undefined
            ? { deniedTools: old.deniedTools }
            : {}),
        ...(old?.tokenFile ? { tokenFile: old.tokenFile } : {}),
        token: item.token === undefined ? old?.token : item.token || undefined,
      };
    });
    new McpGateway(config);
    if (
      this.app.store.get("SELECT 1 FROM requests WHERE status='pending'") ||
      this.app.store.get(
        "SELECT 1 FROM actions WHERE state IN ('pending','running','uncertain')",
      ) ||
      this.app.store.get(
        "SELECT 1 FROM mcp_calls WHERE state IN ('running','paused','uncertain')",
      )
    )
      throw new SettingsError(
        "Aguarde as conversas e resolva aprovações pendentes/incertas antes de alterar MCP",
      );
    // Validate before committing. Persist/invalidate together; switch before the first await.
    gateway.checkReplacement(config);
    this.app.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.app.store.run(
        "INSERT INTO meta VALUES ('mcp-config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify(config),
      );
      this.app.store.run("DELETE FROM reads");
      this.app.store.db.exec("COMMIT");
    } catch (error) {
      this.app.store.db.exec("ROLLBACK");
      throw error;
    }
    const closeOld = gateway.replace(config);
    await closeOld;
    await this.app.refreshMcpTools();
    return this.mcp();
  }
  async discover(name: string) {
    const tools = await this.gateway().discover(name);
    await this.app.refreshMcpTools();
    return {
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description: description ?? "",
        inputSchema,
      })),
    };
  }
  snapshot() {
    return {
      mode: this.app.options.mode ?? "demo",
      ...this.defaults(),
      models: this.catalog(),
      providers: this.providers(),
      mcp: this.mcp(),
      mcpStatus: this.app.mcpStatus,
    };
  }
}
