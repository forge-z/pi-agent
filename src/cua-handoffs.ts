import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { McpGateway, McpNotSentError } from "./mcp.js";
import {
  CuaViewerClient,
  CuaViewerError,
  type CuaViewerTicket,
} from "./cua-viewer.js";

export class CuaHandoffError extends Error {}
export interface CuaHandoff {
  id: string;
  conversationId: string;
  server: string;
  state: "pending" | "creating" | "active" | "ended" | "uncertain";
  createdAt: number;
  expiresAt: number | null;
  url: string | null;
  clipboard: boolean;
}
interface Row extends Omit<CuaHandoff, "clipboard"> {
  clipboard: number;
  origin: string;
  binding: string;
  requestKey: string;
  endReason: "controlReturned" | "requestCancelled" | null;
  endedAt: number | null;
}
export type CuaViewerFactory = (options: {
  origin: string;
  token: string;
}) => Pick<CuaViewerClient, "createTicket">;
const held = "('pending','creating','active','uncertain')";
const busy = () =>
  new CuaHandoffError(
    "Aguarde a execução e resolva chamadas MCP pendentes ou incertas antes de abrir o viewer CUA.",
  );

/** Human-only ticket access. The durable row is also an origin-wide dispatch lease. */
export class CuaHandoffs {
  private inflight = new Set<Promise<CuaHandoff>>();
  private closed = false;
  constructor(
    private store: Store,
    private gateway: McpGateway,
    private ownerBusy: (conversationId: string) => Promise<boolean>,
    private factory: CuaViewerFactory = (options) =>
      new CuaViewerClient(options),
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS cua_handoffs(
      id TEXT PRIMARY KEY,conversationId TEXT NOT NULL,server TEXT NOT NULL,
      origin TEXT NOT NULL,binding TEXT NOT NULL,requestKey TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER,url TEXT,
      clipboard INTEGER NOT NULL DEFAULT 0 CHECK(clipboard IN (0,1)),
      endReason TEXT,endedAt INTEGER,feedbackSubmissionId INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS cua_origin_hold ON cua_handoffs(origin) WHERE state IN ${held};
      UPDATE cua_handoffs SET state='uncertain',url=NULL WHERE state='creating';`);
    if (
      !store
        .all<{ name: string }>("PRAGMA table_info(cua_handoffs)")
        .some((column) => column.name === "clipboard")
    )
      store.db.exec(
        "ALTER TABLE cua_handoffs ADD COLUMN clipboard INTEGER NOT NULL DEFAULT 0 CHECK(clipboard IN (0,1))",
      );
    const columns = store.all<{ name: string }>(
      "PRAGMA table_info(cua_handoffs)",
    );
    for (const [name, type] of [
      ["endReason", "TEXT"],
      ["endedAt", "INTEGER"],
      ["feedbackSubmissionId", "INTEGER"],
    ])
      if (!columns.some((column) => column.name === name))
        store.db.exec(`ALTER TABLE cua_handoffs ADD COLUMN ${name} ${type}`);
    gateway.setDispatchGuard((server) => {
      if (
        this.store.get(
          `SELECT 1 FROM cua_handoffs WHERE origin=? AND state IN ${held}`,
          gateway.serverOrigin(server),
        )
      )
        throw new McpNotSentError(
          "CUA pausado para intervenção humana. Nenhuma chamada MCP foi enviada.",
        );
    });
  }
  holds(conversationId: string) {
    return !!this.store.get(
      `SELECT 1 FROM cua_handoffs WHERE conversationId=? AND state IN ${held}`,
      conversationId,
    );
  }
  anyHeld() {
    return !!this.store.get(
      `SELECT 1 FROM cua_handoffs WHERE state IN ${held}`,
    );
  }
  list(conversationId: string): CuaHandoff[] {
    return this.store
      .all<Omit<CuaHandoff, "clipboard"> & { clipboard: number }>(
        "SELECT id,conversationId,server,state,createdAt,expiresAt,clipboard,CASE WHEN state='active' AND expiresAt>? THEN url ELSE NULL END AS url FROM cua_handoffs WHERE conversationId=? ORDER BY rowid",
        Date.now(),
        conversationId,
      )
      .map((row) => ({ ...row, clipboard: row.clipboard === 1 }));
  }
  private row(conversationId: string, id: string) {
    const row = this.store.get<Row>(
      "SELECT * FROM cua_handoffs WHERE id=? AND conversationId=?",
      id,
      conversationId,
    );
    if (!row)
      throw new CuaHandoffError(
        "Intervenção CUA não encontrada nesta conversa.",
      );
    return row;
  }
  private publicRow(row: Row): CuaHandoff {
    const { id, conversationId, server, state, createdAt, expiresAt, url } =
      row;
    return {
      id,
      conversationId,
      server,
      state,
      createdAt,
      expiresAt,
      clipboard: row.clipboard === 1,
      url: state === "active" && (expiresAt ?? 0) > Date.now() ? url : null,
    };
  }
  private originBusy(origin: string) {
    if (this.gateway.hasActiveOrigin(origin)) return true;
    const names = this.gateway.config
      .filter((item) => new URL(item.url).origin === origin)
      .map((item) => item.name);
    for (const server of names) {
      if (
        this.store.get(
          "SELECT 1 FROM actions WHERE server=? AND state IN ('pending','running','uncertain')",
          server,
        ) ||
        this.store.get(
          "SELECT 1 FROM mcp_calls WHERE server=? AND state IN ('running','paused','uncertain')",
          server,
        ) ||
        this.store.get(
          "SELECT 1 FROM mcp_interactions WHERE server=? AND state='pending'",
          server,
        )
      )
        return true;
    }
    return false;
  }
  private ownerEffects(conversationId: string) {
    return !!(
      this.store.get(
        "SELECT 1 FROM actions WHERE conversationId=? AND state IN ('pending','running','uncertain')",
        conversationId,
      ) ||
      this.store.get(
        "SELECT 1 FROM mcp_calls WHERE conversationId=? AND state IN ('running','paused','uncertain')",
        conversationId,
      ) ||
      this.store.get(
        "SELECT 1 FROM mcp_interactions WHERE conversationId=? AND state='pending'",
        conversationId,
      )
    );
  }
  request(conversationId: string, taskId: number, server: string) {
    if (this.closed)
      throw new CuaHandoffError(
        "Serviço encerrando; intervenção CUA indisponível.",
      );
    const requestKey = `${conversationId}:${taskId}`;
    const existing = this.store.get<Row>(
      "SELECT * FROM cua_handoffs WHERE requestKey=?",
      requestKey,
    );
    if (existing) {
      if (existing.server !== server)
        throw new CuaHandoffError(
          "Identidade de intervenção CUA usada com outro servidor.",
        );
      return this.toolResult(existing);
    }
    const credential = this.gateway.viewerCredential(server);
    if (
      this.holds(conversationId) ||
      this.store.get(
        `SELECT 1 FROM cua_handoffs WHERE origin=? AND state IN ${held}`,
        credential.origin,
      )
    )
      throw new CuaHandoffError(
        "Já existe uma intervenção CUA pendente para esta conversa ou origem.",
      );
    if (this.originBusy(credential.origin) || this.ownerEffects(conversationId))
      throw busy();
    const id = randomUUID();
    this.store.run(
      "INSERT INTO cua_handoffs(id,conversationId,server,origin,binding,requestKey,state,createdAt) VALUES (?,?,?,?,?,?,'pending',?)",
      id,
      conversationId,
      server,
      credential.origin,
      credential.binding,
      requestKey,
      Date.now(),
    );
    return this.toolResult(this.row(conversationId, id));
  }
  private toolResult(row: Row) {
    // Deliberately excludes the bearer URL, credential binding and viewer principal.
    return {
      id: row.id,
      server: row.server,
      state: row.state,
      message:
        row.state === "ended"
          ? row.endReason === "controlReturned"
            ? "Intervenção encerrada por atestação humana: controle devolvido ao Pi. Este pedido não está mais pausado. Isso não comprova revogação remota do viewer nem libera outra intervenção."
            : row.endReason === "requestCancelled"
              ? "Intervenção pendente cancelada pelo usuário antes da criação do viewer. Este pedido não está mais pausado; isso não libera outra intervenção nem confirma conclusão da tarefa."
              : "Intervenção encerrada. Este pedido não está mais pausado; isso não libera outra intervenção nem comprova revogação remota do viewer."
          : "Intervenção humana solicitada. A automação está pausada; o usuário deve abrir o viewer pela interface e devolver o controle explicitamente.",
    };
  }
  create(
    conversationId: string,
    id: string,
    input: unknown = {},
  ): Promise<CuaHandoff> {
    const operation = this.createOnce(conversationId, id, input);
    this.inflight.add(operation);
    void operation
      .finally(() => this.inflight.delete(operation))
      .catch(() => {});
    return operation;
  }
  private async createOnce(conversationId: string, id: string, input: unknown) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "clipboard")
    )
      throw new CuaHandoffError(
        "Permissões CUA inválidas: informe apenas clipboard como booleano.",
      );
    const clipboard = "clipboard" in input ? input.clipboard : false;
    if (typeof clipboard !== "boolean")
      throw new CuaHandoffError(
        "Permissões CUA inválidas: informe apenas clipboard como booleano.",
      );
    if (this.closed)
      throw new CuaHandoffError(
        "Serviço encerrando; intervenção CUA indisponível.",
      );
    const row = this.row(conversationId, id);
    if (row.state !== "pending")
      throw new CuaHandoffError(
        "Acesso CUA já criado ou incerto; não será emitido novamente.",
      );
    let credential;
    try {
      credential = this.gateway.viewerCredential(row.server);
    } catch {
      throw new CuaHandoffError(
        "Conexão CUA indisponível; a intervenção permanece pausada.",
      );
    }
    if (
      credential.binding !== row.binding ||
      credential.origin !== row.origin
    ) {
      this.store.run(
        "UPDATE cua_handoffs SET state='uncertain',url=NULL WHERE id=?",
        id,
      );
      throw new CuaHandoffError(
        "Conexão CUA mudou; a intervenção permanece incerta e pausada.",
      );
    }
    if (this.originBusy(row.origin) || this.ownerEffects(conversationId))
      throw busy();
    // Claim before the first await: duplicate clicks and prompt admission cannot race minting.
    if (
      !this.store.run(
        "UPDATE cua_handoffs SET state='creating',clipboard=? WHERE id=? AND state='pending'",
        clipboard ? 1 : 0,
        id,
      ).changes
    )
      throw new CuaHandoffError(
        "Acesso CUA já criado ou incerto; não será emitido novamente.",
      );
    let dispatched = false;
    try {
      if (await this.ownerBusy(conversationId)) {
        this.store.run(
          "UPDATE cua_handoffs SET state='pending' WHERE id=? AND state='creating'",
          id,
        );
        throw busy();
      }
      if (
        this.closed ||
        this.originBusy(row.origin) ||
        this.ownerEffects(conversationId)
      ) {
        this.store.run(
          "UPDATE cua_handoffs SET state='pending' WHERE id=? AND state='creating'",
          id,
        );
        throw busy();
      }
      if (this.gateway.credentialBinding(row.server) !== row.binding)
        throw new CuaHandoffError(
          "Conexão CUA mudou; a intervenção permanece incerta e pausada.",
        );
      dispatched = true;
      const ticket: CuaViewerTicket = await this.factory(
        credential,
      ).createTicket(`pi-handoff-${id}`, clipboard);
      if (this.gateway.credentialBinding(row.server) !== row.binding)
        throw new CuaHandoffError(
          "Conexão CUA mudou; a intervenção permanece incerta e pausada.",
        );
      this.store.run(
        "UPDATE cua_handoffs SET state='active',url=?,expiresAt=? WHERE id=? AND state='creating'",
        ticket.url,
        ticket.expiresAt,
        id,
      );
      return this.publicRow(this.row(conversationId, id));
    } catch (error) {
      // Local busy checks already restored pending. Every post-dispatch failure is held.
      if (this.row(conversationId, id).state === "creating")
        this.store.run(
          "UPDATE cua_handoffs SET state=?,url=NULL WHERE id=?",
          error instanceof CuaViewerError && !error.dispatched
            ? "pending"
            : "uncertain",
          id,
        );
      if (error instanceof CuaHandoffError && !dispatched) throw error;
      throw new CuaHandoffError(
        "Criação do acesso CUA falhou; verifique o estado da intervenção. Nenhum acesso será repetido automaticamente.",
      );
    }
  }
  end(conversationId: string, id: string, input: Record<string, unknown>) {
    if (this.closed)
      throw new CuaHandoffError(
        "Serviço encerrando; intervenção CUA indisponível.",
      );
    const row = this.row(conversationId, id);
    if (row.state === "ended") return this.publicRow(row);
    if (row.state === "pending") {
      if (input.cancel !== true)
        throw new CuaHandoffError(
          "Confirme o cancelamento da intervenção CUA pendente.",
        );
    } else {
      if (row.state !== "active")
        throw new CuaHandoffError(
          "Criação CUA incerta ou em andamento; o controle não pode ser liberado.",
        );
      if (input.allTabsClosed !== true || input.controlReturned !== true)
        throw new CuaHandoffError(
          "Confirme que todas as abas do viewer foram fechadas e que o controle foi devolvido.",
        );
      let matches = false;
      try {
        matches = this.gateway.credentialBinding(row.server) === row.binding;
      } catch {
        /* Hold on missing credentials. */
      }
      if (!matches) {
        this.store.run(
          "UPDATE cua_handoffs SET state='uncertain',url=NULL WHERE id=?",
          id,
        );
        throw new CuaHandoffError(
          "Conexão CUA mudou; a intervenção permanece incerta e pausada.",
        );
      }
    }
    this.store.run(
      "UPDATE cua_handoffs SET state='ended',url=NULL,endReason=?,endedAt=? WHERE id=? AND state=?",
      row.state === "active" ? "controlReturned" : "requestCancelled",
      Date.now(),
      id,
      row.state,
    );
    return this.publicRow(this.row(conversationId, id));
  }
  /** Passive context awaits the next valid human input; End never starts work. */
  feedback(conversationId: string) {
    return this.store
      .all<{
        id: string;
        server: string;
        endReason: "controlReturned" | "requestCancelled";
        endedAt: number;
      }>(
        "SELECT id,server,endReason,endedAt FROM cua_handoffs WHERE conversationId=? AND state='ended' AND endReason IN ('controlReturned','requestCancelled') AND feedbackSubmissionId IS NULL ORDER BY endedAt,rowid",
        conversationId,
      )
      .map((row) => ({
        id: row.id,
        requestId: `cua-control/${row.id}`,
        timestamp: row.endedAt,
        text:
          "CUA control update recorded by the application; supersedes the earlier pause result for this handoff only: " +
          JSON.stringify({
            id: row.id,
            server: row.server,
            state: "ended",
            disposition: row.endReason,
          }) +
          (row.endReason === "controlReturned"
            ? ". The human explicitly attested that every viewer tab was closed and control was returned to Pi. Do not ask them to return this handoff again. This is human attestation, not proof of remote viewer revocation."
            : ". The human cancelled this pending request before a viewer was created. This does not confirm completion of the task or login.") +
          " Other handoffs and permission guards remain independent. Ending did not run the model, repeat an MCP call, resume an uncertain effect, or authorize previously unsent work. Continue only within the current authenticated human request and existing permissions.",
      }));
  }
  feedbackSubmitted(conversationId: string, id: string, submissionId: number) {
    this.store.run(
      "UPDATE cua_handoffs SET feedbackSubmissionId=? WHERE id=? AND conversationId=? AND state='ended' AND feedbackSubmissionId IS NULL",
      submissionId,
      id,
      conversationId,
    );
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.inflight);
  }
}
