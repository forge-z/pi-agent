import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";

export interface McpConfig {
  name: string;
  url: string;
  readTools: string[];
  actionTools: string[];
  tokenFile?: string;
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
  constructor(readonly config: McpConfig[]) {
    if (new Set(config.map((c) => c.name)).size !== config.length)
      throw new Error("Nomes MCP duplicados");
    for (const item of config) {
      if (
        !/^[a-zA-Z0-9_-]+$/.test(item.name) ||
        !Array.isArray(item.readTools) ||
        !Array.isArray(item.actionTools)
      )
        throw new Error("Configuração MCP inválida");
      const url = new URL(item.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("MCP exige URL HTTP(S) sem credenciais embutidas");
      if (
        url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
        throw new Error("MCP fora de loopback exige HTTPS");
      if (item.readTools.some((t) => item.actionTools.includes(t)))
        throw new Error("MCP tool não pode ser leitura e ação ao mesmo tempo");
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
    this.assertAllowed(server, tool, kind);
    const client = await this.client(server);
    return client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: 30000,
    });
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
        if (config.tokenFile)
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
      void pending.catch(() => this.clients.delete(server));
    }
    return pending;
  }
  async catalog() {
    return Promise.all(
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
  }
  async close() {
    for (const client of this.clients.values())
      await client.then((c) => c.close()).catch(() => {});
  }
}
