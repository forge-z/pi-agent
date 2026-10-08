import { createHash, randomUUID } from "node:crypto";
import type {
  ElicitRequest,
  ElicitResult,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { McpGateway, McpError, McpNotSentError, PolicyError } from "./mcp.js";
import type { Store } from "./store.js";

export interface McpCall {
  id: string;
  conversationId: string;
  server: string;
  tool: string;
  args: string;
  state: string;
  result: string | null;
  binding: string;
  updatedAt: number;
}
export interface McpInteraction {
  id: string;
  callId: string;
  conversationId: string;
  server: string;
  kind: "form" | "url" | "resume";
  payload: string;
  state: string;
  response: string | null;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export class McpCalls {
  private waiters = new Map<string, (value: ElicitResult) => void>();
  private controllers = new Set<AbortController>();
  private inflight = new Set<Promise<CallToolResult>>();
  private closed = false;
  constructor(
    private store: Store,
    private gateway: McpGateway,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS mcp_calls(id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, server TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL, result TEXT, binding TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_interactions(id TEXT PRIMARY KEY, callId TEXT NOT NULL, conversationId TEXT NOT NULL, server TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', response TEXT);
      UPDATE mcp_interactions SET state='expired' WHERE state='pending' AND kind!='resume';
      UPDATE mcp_calls SET state='uncertain' WHERE state='running';`);
  }
  list(conversationId: string) {
    return this.store.all<McpCall>(
      "SELECT * FROM mcp_calls WHERE conversationId=? ORDER BY rowid",
      conversationId,
    );
  }
  interactions(conversationId: string) {
    return this.store.all<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE conversationId=? ORDER BY rowid",
      conversationId,
    );
  }
  private binding(server: string) {
    return this.gateway.credentialBinding(server);
  }
  private pending(conversationId: string) {
    return this.store.get(
      "SELECT 1 FROM mcp_interactions WHERE conversationId=? AND state='pending'",
      conversationId,
    );
  }
  async execute(
    conversationId: string,
    taskId: number,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.closed) throw new PolicyError("Aplicação encerrando");
    this.gateway.assertDirect(server, tool);
    const id = createHash("sha256")
      .update(`mcp:${conversationId}:${taskId}`)
      .digest("hex")
      .slice(0, 24);
    const existing = this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=?",
      id,
    );
    if (existing) {
      if (
        existing.server !== server ||
        existing.tool !== tool ||
        existing.args !== JSON.stringify(args)
      )
        throw new PolicyError("Identidade MCP usada com outro conteúdo");
      if (
        ["done", "failed", "paused"].includes(existing.state) &&
        existing.result
      )
        return JSON.parse(existing.result) as CallToolResult;
      throw new PolicyError(
        "Resultado MCP incerto ou em andamento; a chamada não será reenviada automaticamente",
      );
    }
    if (this.pending(conversationId))
      throw new PolicyError(
        "Responda à solicitação pendente do servidor MCP antes de continuar",
      );
    if (
      this.store.get(
        "SELECT 1 FROM mcp_calls WHERE conversationId=? AND server=? AND state='uncertain'",
        conversationId,
        server,
      )
    )
      throw new PolicyError(
        "Verifique e registre o resultado MCP incerto antes de executar outra chamada neste servidor",
      );
    // Executor's resume tool is deliberately not an agent-side approval bypass.
    if (tool === "resume" && typeof args.executionId === "string")
      throw new PolicyError(
        "Retomadas com decisão de permissão devem usar a solicitação do servidor exibida na conversa",
      );
    const binding = await this.gateway.connectionBinding(server);
    this.store.run(
      "INSERT INTO mcp_calls VALUES (?,?,?,?,?,'running',NULL,?,?)",
      id,
      conversationId,
      server,
      tool,
      JSON.stringify(args),
      binding,
      Date.now(),
    );
    return this.run(id, tool, args, signal);
  }
  private run(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const pending = this.performRun(id, tool, args, signal);
    this.inflight.add(pending);
    void pending.finally(() => this.inflight.delete(pending)).catch(() => {});
    return pending;
  }
  private async performRun(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const call = this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=?",
      id,
    )!;
    const controller = new AbortController();
    this.controllers.add(controller);
    const combined = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    try {
      const result = await this.gateway.callDirect(call.server, tool, args, {
        signal: combined,
        binding: call.binding,
        onElicitation: (params, elicitationSignal) =>
          this.elicit(
            call,
            params,
            elicitationSignal
              ? AbortSignal.any([combined, elicitationSignal])
              : combined,
          ),
      });
      const paused = !result.isError ? this.pause(result) : undefined;
      const unsupportedPause =
        !result.isError && !paused && this.hasPauseMarker(result);
      if (unsupportedPause) {
        result.isError = true;
        result.content.push({
          type: "text",
          text: "Servidor informou uma pausa em formato incompatível. A execução não foi considerada concluída e não será repetida automaticamente.",
        });
      }
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        if (paused) {
          this.store.run(
            "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,'pending',NULL)",
            randomUUID(),
            id,
            call.conversationId,
            call.server,
            "resume",
            JSON.stringify(paused),
          );
        }
        this.store.run(
          "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=?",
          paused
            ? "paused"
            : unsupportedPause
              ? "uncertain"
              : result.isError
                ? "failed"
                : "done",
          JSON.stringify(result),
          Date.now(),
          id,
        );
        this.store.db.exec("COMMIT");
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
      return result;
    } catch (error) {
      const result: CallToolResult = {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof PolicyError || error instanceof McpError
                ? error.message
                : "Resultado MCP incerto. Verifique o serviço antes de tentar outra execução.",
          },
        ],
      };
      this.store.run(
        "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE id=?",
        error instanceof PolicyError || error instanceof McpNotSentError
          ? "failed"
          : "uncertain",
        JSON.stringify(result),
        Date.now(),
        id,
      );
      throw error;
    } finally {
      // SDK may finish a tools/call while a withdrawn elicitation handler is still pending.
      // Settle every local waiter before closing SQLite or accepting another invocation.
      controller.abort();
      this.controllers.delete(controller);
      this.store.run(
        "UPDATE mcp_interactions SET state='expired' WHERE callId=? AND kind!='resume' AND state='pending'",
        id,
      );
    }
  }
  // Only structured, explicitly identified paused executions are resumable. No code inspection.
  private pause(result: CallToolResult): Record<string, unknown> | undefined {
    const candidates: unknown[] = [result.structuredContent];
    for (const content of result.content)
      if (content.type === "text") {
        try {
          candidates.push(JSON.parse(content.text));
        } catch {
          /* ordinary text */
        }
      }
    for (const value of candidates) {
      if (
        !object(value) ||
        (value.status !== "paused" && value.paused !== true)
      )
        continue;
      const payload = object(value.resumePayload)
        ? value.resumePayload
        : undefined;
      const executionId = value.executionId ?? payload?.executionId;
      if (
        typeof executionId === "string" &&
        executionId.length > 0 &&
        executionId.length <= 200 &&
        (payload || object(value.interaction))
      ) {
        return {
          executionId,
          interaction: value.interaction ?? null,
          resumePayload: payload ?? { executionId },
        };
      }
    }
  }
  private hasPauseMarker(result: CallToolResult) {
    const candidates: unknown[] = [result.structuredContent];
    for (const item of result.content)
      if (item.type === "text") {
        try {
          candidates.push(JSON.parse(item.text));
        } catch {
          /* ordinary text */
        }
      }
    return candidates.some(
      (value) =>
        object(value) && (value.status === "paused" || value.paused === true),
    );
  }
  private async elicit(
    call: McpCall,
    params: ElicitRequest["params"],
    signal: AbortSignal,
  ): Promise<ElicitResult> {
    signal.throwIfAborted();
    const kind = params.mode === "url" ? "url" : "form";
    if (kind === "url") {
      const url = new URL("url" in params ? params.url : "");
      if (url.protocol !== "https:" || url.username || url.password)
        throw new PolicyError(
          "Servidor MCP solicitou um endereço de interação inválido",
        );
    }
    const id = randomUUID();
    this.store.run(
      "INSERT INTO mcp_interactions VALUES (?,?,?,?,?,?,'pending',NULL)",
      id,
      call.id,
      call.conversationId,
      call.server,
      kind,
      JSON.stringify(params),
    );
    return new Promise<ElicitResult>((resolve) => {
      const finish = (value: ElicitResult) => {
        signal.removeEventListener("abort", cancel);
        this.waiters.delete(id);
        resolve(value);
      };
      const cancel = () => {
        this.store.run(
          "UPDATE mcp_interactions SET state='expired' WHERE id=? AND state='pending'",
          id,
        );
        finish({ action: "cancel" });
      };
      this.waiters.set(id, finish);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  async decide(
    conversationId: string,
    id: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) {
    if (!["accept", "decline", "cancel"].includes(action))
      throw new PolicyError("Decisão MCP inválida");
    const interaction = this.store.get<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE id=? AND conversationId=?",
      id,
      conversationId,
    );
    if (!interaction) throw new PolicyError("Solicitação MCP não encontrada");
    if (interaction.state !== "pending") return interaction;
    const payload = JSON.parse(interaction.payload) as Record<string, unknown>;
    if (interaction.kind === "form" && action === "accept") {
      if (!object(payload.requestedSchema))
        throw new PolicyError("Formulário MCP inválido");
      const validation = new AjvJsonSchemaValidator().getValidator(
        payload.requestedSchema,
      )(content ?? {});
      if (!validation.valid)
        throw new PolicyError("Preencha os campos exigidos pelo servidor MCP");
    }
    const waiter = this.waiters.get(id);
    if (interaction.kind !== "resume" && !waiter)
      throw new PolicyError(
        "Esta solicitação MCP expirou; ela não pode ser aceita após reinício",
      );
    const call = this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=?",
      interaction.callId,
    )!;
    let sameBinding = false;
    try {
      sameBinding = this.binding(call.server) === call.binding;
    } catch {
      /* unavailable credential is a changed binding */
    }
    if (!sameBinding && action === "accept")
      throw new PolicyError(
        "Endpoint ou credenciais MCP mudaram; a chamada não será retomada",
      );
    if (!sameBinding && interaction.kind === "resume")
      return this.abandon(interaction, call, action);
    if (interaction.kind === "resume") {
      try {
        this.gateway.assertDirect(call.server, "resume");
      } catch {
        if (action === "accept")
          throw new PolicyError(
            "Retomada bloqueada pelas restrições MCP. Recuse ou cancele esta espera para ajustar a conexão.",
          );
        return this.abandon(interaction, call, action);
      }
    }
    const response: ElicitResult = {
      action,
      ...(content ? { content: content as ElicitResult["content"] } : {}),
    };
    this.store.db.exec("BEGIN IMMEDIATE");
    let claimed: number | bigint;
    try {
      claimed = this.store.run(
        "UPDATE mcp_interactions SET state='responded',response=? WHERE id=? AND state='pending'",
        JSON.stringify(response),
        id,
      ).changes;
      if (claimed && interaction.kind === "resume")
        this.store.run(
          "UPDATE mcp_calls SET state='running',updatedAt=? WHERE id=?",
          Date.now(),
          call.id,
        );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    if (!claimed)
      return this.store.get<McpInteraction>(
        "SELECT * FROM mcp_interactions WHERE id=?",
        id,
      )!;
    if (waiter) waiter(response);
    else {
      // Store the claim before I/O. A crash after resume is uncertain, never another accept.
      await this.run(call.id, "resume", {
        executionId: payload.executionId,
        action,
        ...(content ? { content: JSON.stringify(content) } : {}),
      });
    }
    return this.store.get<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE id=?",
      id,
    )!;
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.inflight]);
  }
  private abandon(interaction: McpInteraction, call: McpCall, action: string) {
    // Local cancellation never bypasses a deny or changes the service's paused execution.
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = this.store.run(
        "UPDATE mcp_interactions SET state='responded',response=? WHERE id=? AND state='pending'",
        JSON.stringify({ action }),
        interaction.id,
      ).changes;
      if (claimed)
        this.store.run(
          "UPDATE mcp_calls SET state='abandoned',result=?,updatedAt=? WHERE id=?",
          JSON.stringify({
            content: [
              {
                type: "text",
                text: "A espera local foi encerrada. A execução permanece pausada no serviço; nenhuma chamada resume foi enviada.",
              },
            ],
          }),
          Date.now(),
          call.id,
        );
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.store.get<McpInteraction>(
      "SELECT * FROM mcp_interactions WHERE id=?",
      interaction.id,
    )!;
  }
  reconcile(conversationId: string, id: string, note: string) {
    if (!note.trim())
      throw new PolicyError(
        "Informe o resultado verificado no serviço externo",
      );
    this.store.run(
      "UPDATE mcp_calls SET state='reconciled',result=?,updatedAt=? WHERE id=? AND conversationId=? AND state='uncertain'",
      JSON.stringify({ note }),
      Date.now(),
      id,
      conversationId,
    );
    return this.store.get<McpCall>(
      "SELECT * FROM mcp_calls WHERE id=? AND conversationId=?",
      id,
      conversationId,
    );
  }
}
