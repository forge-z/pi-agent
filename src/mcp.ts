import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";

export interface McpConfig {
  name: string;
  url: string;
  readTools: string[];
  actionTools: string[];
  tokenFile?: string;
  token?: string;
}
export class PolicyError extends Error {}
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
export class McpGateway implements ToolGateway {
  private clients = new Map<string, Promise<Client>>();
  private operations = 0;
  constructor(readonly config: McpConfig[]) {
    if (new Set(config.map((c) => c.name)).size !== config.length)
      throw new Error("Nomes MCP duplicados");
    for (const item of config) {
      if (
        !/^[a-zA-Z0-9_-]+$/.test(item.name) ||
        !Array.isArray(item.readTools) ||
        !Array.isArray(item.actionTools) ||
        [...item.readTools, ...item.actionTools].some(
          (t) => typeof t !== "string" || !t || t.length > 200,
        )
      )
        throw new PolicyError(
          "Nome MCP deve usar letras sem acento, números, hífen ou sublinhado; informe listas de ferramentas válidas",
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
  assertAllowed(server: string, tool: string, kind: "read" | "action") {
    const config = this.config.find((c) => c.name === server);
    if (
      !config ||
      !(kind === "read" ? config.readTools : config.actionTools).includes(tool)
    )
      throw new PolicyError("Ferramenta MCP não autorizada para esta operação");
  }
  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    kind: "read" | "action",
  ) {
    this.operations++;
    try {
      this.assertAllowed(server, tool, kind);
      const client = await this.client(server);
      return await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: 30000,
      });
    } finally {
      this.operations--;
    }
  }
  private async client(server: string) {
    const config = this.config.find((c) => c.name === server);
    if (!config) throw new PolicyError("Servidor MCP não autorizado");
    let pending = this.clients.get(server);
    if (!pending) {
      pending = (async () => {
        const client = new Client({
          name: "pi-personal-agent",
          version: "0.1.0",
        });
        const headers: Record<string, string> = {};
        if (config.token) headers.Authorization = `Bearer ${config.token}`;
        else if (config.tokenFile)
          headers.Authorization = `Bearer ${readFileSync(config.tokenFile, "utf8").trim()}`;
        await client.connect(
          new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers },
          }),
        );
        const listed = await client.listTools();
        for (const allowed of [...config.readTools, ...config.actionTools])
          if (!listed.tools.some((t) => t.name === allowed)) {
            await client.close();
            throw new Error("Tool configurada ausente no servidor MCP");
          }
        return client;
      })();
      this.clients.set(server, pending);
      void pending.catch(() => {
        if (this.clients.get(server) === pending) this.clients.delete(server);
      });
    }
    return pending;
  }
  async catalog() {
    this.operations++;
    try {
      return await Promise.all(
        this.config.map(async (config) => {
          const client = await this.client(config.name);
          const tools = await client.listTools();
          return {
            server: config.name,
            tools: tools.tools
              .filter(
                (tool) =>
                  config.readTools.includes(tool.name) ||
                  config.actionTools.includes(tool.name),
              )
              .map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: tool.inputSchema,
                operation: config.readTools.includes(tool.name)
                  ? "read"
                  : "action",
              })),
          };
        }),
      );
    } finally {
      this.operations--;
    }
  }
  async discover(server: string) {
    this.operations++;
    try {
      return (await (await this.client(server)).listTools()).tools;
    } finally {
      this.operations--;
    }
  }
  checkReplacement(config: McpConfig[]) {
    if (this.operations)
      throw new PolicyError("Aguarde as operações MCP em andamento");
    new McpGateway(config); // Validate everything before switching endpoints/policies.
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
  }
}
