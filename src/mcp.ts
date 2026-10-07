import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ElicitRequestSchema,
  CallToolResultSchema,
  type ElicitRequest,
  type ElicitResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface McpConfig {
  name: string;
  url: string;
  mode?: "direct" | "legacy";
  readTools: string[];
  actionTools: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  tokenFile?: string;
  token?: string;
}
export class PolicyError extends Error {}
export class McpError extends Error {}
export interface ToolGateway {
  assertAllowed?(server: string, tool: string, kind: "read" | "action"): void;
  catalog?(): Promise<unknown>;
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    kind: "read" | "action",
  ): Promise<unknown>;
}
export interface McpCallOptions {
  signal?: AbortSignal;
  binding?: string;
  onElicitation?: (
    params: ElicitRequest["params"],
    signal?: AbortSignal,
  ) => Promise<ElicitResult>;
}
export interface McpCatalog {
  server: string;
  mode: "direct" | "legacy";
  tools: (Tool & { operation: "direct" | "read" | "action" })[];
  error?: string;
}
export function mcpToolName(server: string, tool: string) {
  const hash = createHash("sha256")
    .update(`${server}:${tool}`)
    .digest("hex")
    .slice(0, 10);
  return (
    `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 52) +
    `_${hash}`
  );
}
// Never propagate upstream messages: they may echo credentials, URLs or response bodies.
function safeError(error: unknown): McpError {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (code === 401 || code === 403)
    return new McpError(
      `MCP recusou a autenticação (HTTP ${code}). Verifique o token ou o método de login exigido pelo servidor.`,
    );
  if (code === 404 || code === 405)
    return new McpError(
      `Endpoint MCP incompatível ou não encontrado (HTTP ${code}). Confira o endpoint MCP completo.`,
    );
  if (code === -32001)
    return new McpError(
      "Tempo de resposta MCP excedido. O resultado da chamada pode ser incerto.",
    );
  return new McpError(
    "Falha na conexão ou operação MCP. Confira endpoint, transporte e disponibilidade do servidor.",
  );
}
export class McpGateway implements ToolGateway {
  private clients = new Map<string, Promise<Client>>();
  private bindings = new WeakMap<Client, string>();
  private operations = 0;
  private tails = new Map<string, Promise<unknown>>();
  private active = new Map<string, McpCallOptions>();
  constructor(readonly config: McpConfig[]) {
    if (new Set(config.map((c) => c.name)).size !== config.length)
      throw new PolicyError("Nomes MCP duplicados");
    for (const item of config) {
      const lists = [
        item.readTools,
        item.actionTools,
        item.allowedTools ?? [],
        item.deniedTools ?? [],
      ];
      if (
        !/^[a-zA-Z0-9_-]+$/.test(item.name) ||
        item.name.length > 80 ||
        lists.some(
          (list) =>
            !Array.isArray(list) ||
            list.length > 200 ||
            list.some((t) => typeof t !== "string" || !t || t.length > 200),
        ) ||
        (item.mode !== undefined && !["direct", "legacy"].includes(item.mode))
      )
        throw new PolicyError(
          "Configuração MCP inválida: confira nome, modo e listas de ferramentas",
        );
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        throw new PolicyError("URL MCP inválida");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new PolicyError(
          "MCP exige URL HTTP(S) sem query, fragmento ou credenciais embutidas; use bearer token",
        );
      if (
        url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
        throw new PolicyError("MCP fora de loopback exige HTTPS");
      if (item.readTools.some((t) => item.actionTools.includes(t)))
        throw new PolicyError(
          "MCP tool não pode ser leitura e ação ao mesmo tempo",
        );
    }
  }
  credentialBinding(server: string) {
    const c = this.config.find((c) => c.name === server);
    if (!c) throw new PolicyError("Servidor MCP não autorizado");
    let token = c.token;
    if (!token && c.tokenFile) {
      try {
        token = readFileSync(c.tokenFile, "utf8").trim();
      } catch {
        throw new PolicyError("Arquivo de token MCP indisponível");
      }
    }
    return createHash("sha256")
      .update(JSON.stringify([c.url, token, c.tokenFile]))
      .digest("hex");
  }
  async connectionBinding(server: string) {
    return this.bindings.get(await this.client(server))!;
  }
  assertAllowed(server: string, tool: string, kind: "read" | "action") {
    const config = this.config.find((c) => c.name === server);
    // Direct connections cannot be reached through the legacy replay-safe read wrapper.
    if (
      !config ||
      config.mode === "direct" ||
      !(kind === "read" ? config.readTools : config.actionTools).includes(
        tool,
      ) ||
      config.deniedTools?.includes(tool)
    )
      throw new PolicyError("Ferramenta MCP não autorizada para esta operação");
  }
  assertDirect(server: string, tool: string) {
    const config = this.config.find((c) => c.name === server);
    if (
      !config ||
      config.mode !== "direct" ||
      config.deniedTools?.includes(tool) ||
      (config.allowedTools !== undefined && !config.allowedTools.includes(tool))
    )
      throw new PolicyError("Ferramenta MCP fora das restrições configuradas");
  }
  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    kind: "read" | "action",
  ) {
    this.assertAllowed(server, tool, kind);
    return this.invoke(server, tool, args);
  }
  async callDirect(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
  ) {
    this.assertDirect(server, tool);
    return this.invoke(server, tool, args, options);
  }
  private async invoke(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
  ) {
    this.operations++;
    const operation = (this.tails.get(server) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        options.signal?.throwIfAborted();
        const client = await this.client(server);
        if (options.binding && this.bindings.get(client) !== options.binding)
          throw new PolicyError(
            "Credenciais da conexão MCP mudaram; a chamada não será enviada",
          );
        this.active.set(server, options);
        try {
          const result = await client.callTool(
            { name: tool, arguments: args },
            undefined,
            { timeout: 300000, signal: options.signal },
          );
          return CallToolResultSchema.parse(
            "toolResult" in result ? result.toolResult : result,
          );
        } catch (error) {
          throw safeError(error);
        } finally {
          this.active.delete(server);
        }
      });
    this.tails.set(server, operation);
    try {
      return await operation;
    } finally {
      this.operations--;
      if (this.tails.get(server) === operation) this.tails.delete(server);
    }
  }
  private async client(server: string) {
    const config = this.config.find((c) => c.name === server);
    if (!config) throw new PolicyError("Servidor MCP não autorizado");
    let pending = this.clients.get(server);
    if (!pending) {
      pending = (async () => {
        const headers: Record<string, string> = {};
        if (config.token) headers.Authorization = `Bearer ${config.token}`;
        else if (config.tokenFile)
          headers.Authorization = `Bearer ${readFileSync(config.tokenFile, "utf8").trim()}`;
        const makeClient = () => {
          const client = new Client(
            { name: "pi-personal-agent", version: "0.1.0" },
            { capabilities: { elicitation: { form: {}, url: {} } } },
          );
          this.bindings.set(
            client,
            createHash("sha256")
              .update(
                JSON.stringify([
                  config.url,
                  headers.Authorization?.slice(7),
                  config.tokenFile,
                ]),
              )
              .digest("hex"),
          );
          client.setRequestHandler(
            ElicitRequestSchema,
            async (request, extra) =>
              this.active
                .get(server)
                ?.onElicitation?.(request.params, extra.signal) ?? {
                action: "cancel",
              },
          );
          return client;
        };
        let client = makeClient();
        const limitedFetch: typeof fetch = async (input, init) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30000);
          try {
            return await fetch(input, {
              ...init,
              signal: AbortSignal.any([
                controller.signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            });
          } finally {
            clearTimeout(timer);
          }
        };
        try {
          try {
            await client.connect(
              new StreamableHTTPClientTransport(new URL(config.url), {
                requestInit: { headers },
                fetch: limitedFetch,
              }),
              { timeout: 30000 },
            );
          } catch (error) {
            await client.close().catch(() => {});
            const code =
              error && typeof error === "object" && "code" in error
                ? error.code
                : undefined;
            if (code !== 404 && code !== 405) throw error;
            client = makeClient();
            await client.connect(
              new SSEClientTransport(new URL(config.url), {
                requestInit: { headers },
                fetch: limitedFetch,
              }),
              { timeout: 30000 },
            );
          }
          client.onclose = () => {
            if (this.clients.get(server) === pending)
              this.clients.delete(server);
          };
          return client;
        } catch (error) {
          await client.close().catch(() => {});
          throw safeError(error);
        }
      })();
      this.clients.set(server, pending);
      void pending.catch(() => {
        if (this.clients.get(server) === pending) this.clients.delete(server);
      });
    }
    return pending;
  }
  async catalog(onlyDirect = false): Promise<McpCatalog[]> {
    return Promise.all(
      this.config
        .filter((c) => !onlyDirect || c.mode === "direct")
        .map(async (config) => {
          try {
            const discovered = await this.discover(config.name);
            return {
              server: config.name,
              mode: config.mode ?? "legacy",
              tools: discovered
                .filter((tool) =>
                  config.mode === "direct"
                    ? !config.deniedTools?.includes(tool.name) &&
                      (config.allowedTools === undefined ||
                        config.allowedTools.includes(tool.name))
                    : !config.deniedTools?.includes(tool.name) &&
                      (config.readTools.includes(tool.name) ||
                        config.actionTools.includes(tool.name)),
                )
                .map((tool) => ({
                  ...tool,
                  operation:
                    config.mode === "direct"
                      ? ("direct" as const)
                      : config.readTools.includes(tool.name)
                        ? ("read" as const)
                        : ("action" as const),
                })),
            };
          } catch (error) {
            return {
              server: config.name,
              mode: config.mode ?? "legacy",
              tools: [],
              error:
                error instanceof McpError
                  ? error.message
                  : "Não foi possível descobrir ferramentas MCP",
            };
          }
        }),
    );
  }
  async discover(server: string): Promise<Tool[]> {
    this.operations++;
    try {
      const client = await this.client(server);
      const tools = new Map<string, Tool>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: 30000,
        });
        for (const tool of page.tools) tools.set(tool.name, tool);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new McpError("Servidor MCP repetiu o cursor de descoberta");
        if (cursor) cursors.add(cursor);
        if (tools.size > 2000 || cursors.size > 100)
          throw new McpError("Catálogo MCP excedeu o limite de descoberta");
      } while (cursor);
      return [...tools.values()];
    } catch (error) {
      throw error instanceof McpError || error instanceof PolicyError
        ? error
        : safeError(error);
    } finally {
      this.operations--;
    }
  }
  checkReplacement(config: McpConfig[]) {
    if (this.operations)
      throw new PolicyError("Aguarde as operações MCP em andamento");
    new McpGateway(config);
  }
  replace(config: McpConfig[]) {
    this.checkReplacement(config);
    const old = this.clients;
    this.clients = new Map();
    this.config.splice(0, this.config.length, ...config);
    return Promise.allSettled(
      [...old.values()].map(async (pending) => (await pending).close()),
    );
  }
  async close() {
    for (const client of this.clients.values())
      await client.then((c) => c.close()).catch(() => {});
    this.clients.clear();
  }
}
