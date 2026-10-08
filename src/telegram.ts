import type { Runtime } from "./runtime.js";
import { hash, type Delivery } from "./store.js";
import { CommandError } from "./commands.js";
import { SettingsError } from "./settings.js";
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
  };
}
export interface TelegramTransport {
  send(chat: string, text: string): Promise<unknown>;
}
export class TelegramInputError extends Error {}
export class TelegramHttp implements TelegramTransport {
  constructor(private token: string) {}
  async send(chat: string, text: string) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = (await response.json()) as { ok?: boolean };
    if (!response.ok || !result.ok)
      throw new Error("Falha na entrega Telegram");
    return result;
  }
}
export class Telegram {
  private closing = false;
  private flushWork: Promise<void> | undefined;
  private receives = new Map<number, Promise<unknown>>();
  constructor(
    private app: Runtime,
    private transport: TelegramTransport,
    private users: string[],
    private chats: string[],
    readonly botUsername?: string,
    private privateDm = false,
  ) {
    this.botUsername = botUsername?.trim().replace(/^@/, "") || undefined;
    if (this.botUsername && !/^[a-zA-Z0-9_]{5,32}$/.test(this.botUsername))
      throw new Error("TELEGRAM_BOT_USERNAME deve ser o username do bot");
  }
  private commandText(raw: string) {
    const start = raw.trimStart();
    if (!start.startsWith("/") || start.startsWith("//")) return raw;
    const text = raw.trim();
    const addressed = /^\/[a-z]+@([a-z0-9_]+)(?=\s|$)/i.exec(text);
    if (!addressed) return text;
    // Never execute a command intended for another bot or guess our identity.
    if (addressed[1].toLowerCase() !== this.botUsername?.toLowerCase())
      return undefined;
    return text.replace(/^(\/[a-z]+)@[a-z0-9_]+/i, "$1");
  }
  async receive(update: TelegramUpdate, signal?: AbortSignal) {
    const message = update.message;
    if (
      !Number.isSafeInteger(update.update_id) ||
      !message?.from ||
      message.from.is_bot ||
      typeof message.text !== "string" ||
      !message.text ||
      !message.chat
    )
      return { ignored: true };
    const user = String(message.from.id),
      chat = String(message.chat.id);
    if (
      !this.users.includes(user) ||
      !this.chats.includes(chat) ||
      (this.privateDm && message.chat.type !== "private")
    )
      return { ignored: true };
    const text = this.commandText(message.text);
    if (text === undefined) return { ignored: true };
    const fingerprint = hash(JSON.stringify([user, chat, message.text]));
    const previous = this.app.store.get<{ fingerprint: string }>(
      "SELECT fingerprint FROM telegram_updates WHERE id=?",
      update.update_id,
    );
    if (previous && previous.fingerprint !== fingerprint)
      throw new TelegramInputError(
        "update_id já utilizado com conteúdo diferente",
      );
    const linked = this.app.store.get<{ conversationId: string; user: string }>(
      "SELECT * FROM telegram WHERE chat=?",
      chat,
    );
    if (
      !/^\/(link|start)(?:\s|$)/.test(text) &&
      (!linked || linked.user !== user)
    )
      throw new TelegramInputError(
        "Conversa não vinculada a este usuário; use /link CODIGO pela web",
      );
    const inFlight = this.receives.get(update.update_id);
    if (inFlight) return inFlight;
    const operation = this.accept(
      update,
      user,
      chat,
      fingerprint,
      text,
      signal,
    );
    this.receives.set(update.update_id, operation);
    void operation
      .finally(() => this.receives.delete(update.update_id))
      .catch(() => {});
    return operation;
  }
  private async accept(
    update: TelegramUpdate,
    user: string,
    chat: string,
    fingerprint: string,
    text: string,
    signal?: AbortSignal,
  ) {
    // Re-delivered commands reuse the update key; never consume a link or approve twice.
    const commandKey = `telegram:update:${update.update_id}`;
    const existing = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key=?",
      commandKey,
    );
    if (existing) {
      const value = JSON.parse(existing.value) as {
        conversationId?: string;
        linked?: string;
      };
      const conversationId = value.conversationId ?? value.linked;
      if (conversationId)
        this.app.commands.authorize(conversationId, {
          source: "telegram",
          chat,
          user,
        });
      this.app.store.run(
        "INSERT OR IGNORE INTO telegram_updates VALUES (?,?)",
        update.update_id,
        fingerprint,
      );
      return value;
    }
    this.app.store.run(
      "INSERT OR IGNORE INTO telegram_updates VALUES (?,?)",
      update.update_id,
      fingerprint,
    );
    const linked = this.app.store.get<{ conversationId: string; user: string }>(
      "SELECT * FROM telegram WHERE chat=?",
      chat,
    );
    let response: unknown;
    let errorReply: string | undefined;
    const pairing = /^\/(link|start)(?:\s+([\s\S]*))?$/.exec(text);
    if (pairing?.[1] === "start" && !pairing[2]) {
      errorReply =
        linked?.user === user
          ? this.privateDm
            ? "Conectado. O histórico é compartilhado com a web. Use /help para consultar os comandos."
            : "Conversa vinculada. Use /help para consultar os comandos. Para vincular outra conversa, gere um código na interface web."
          : "Abra a conversa na interface web, escolha Vincular Telegram e envie /link CODIGO aqui. O código é de uso único e expira em 10 minutos.";
      response = { info: errorReply };
    } else if (pairing) {
      if (!/^[a-f0-9]{32}$/.test(pairing[2] ?? ""))
        throw new CommandError(
          "Uso: /link CODIGO ou /start CODIGO, com o código gerado na interface web.",
        );
      let conversationId: string;
      try {
        conversationId = this.app.store.consumeLink(
          pairing[2],
          chat,
          user,
          commandKey,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Código de vínculo inválido ou expirado"
        )
          throw new TelegramInputError(error.message);
        throw error;
      }
      response = { linked: conversationId };
      // Re-link command is durably marked in the same synchronous turn as code consumption.
    } else {
      if (!linked || linked.user !== user)
        throw new TelegramInputError(
          "Vincule esta conversa na interface web com /link CODIGO",
        );
      const decision = /^\/(approve|deny)\s+([a-f0-9]{24})$/.exec(text);
      if (decision) {
        if (
          !this.app.store.get(
            "SELECT id FROM actions WHERE id=? AND conversationId=?",
            decision[2],
            linked.conversationId,
          )
        )
          throw new TelegramInputError("Ação não encontrada nesta conversa");
        const action = await this.app.actions.decide(
          linked.conversationId,
          decision[2],
          decision[1] === "approve" ? "approve" : "deny",
          signal,
        );
        if (action.state === "running") return { processing: true };
        await this.app.recordAction(action);
        this.app.store.run(
          "INSERT OR IGNORE INTO deliveries(id,chat,text) VALUES (?,?,?)",
          `decision:${update.update_id}`,
          chat,
          `Ação ${action.id}: ${action.state}. ${action.state === "uncertain" ? "Verifique o serviço externo; a ação não será repetida automaticamente." : ""}`,
        );
        response = action;
      } else {
        try {
          response = await this.app.admit(
            linked.conversationId,
            `telegram:${update.update_id}`,
            text,
            { source: "telegram", chat, user },
          );
        } catch (error) {
          if (!(
            error instanceof SettingsError ||
            (error instanceof CommandError &&
              !error.message.includes("não autorizada"))
          ))
            throw error;
          errorReply = error.message;
          response = { error: errorReply };
        }
      }
    }
    this.app.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (errorReply)
        this.app.store.run(
          "INSERT OR IGNORE INTO deliveries(id,chat,text) VALUES (?,?,?)",
          `command:telegram:${update.update_id}:0`,
          chat,
          errorReply,
        );
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        commandKey,
        JSON.stringify(response),
      );
      this.app.store.db.exec("COMMIT");
    } catch (error) {
      this.app.store.db.exec("ROLLBACK");
      throw error;
    }
    return response;
  }
  flush() {
    if (this.closing) return Promise.resolve();
    if (this.flushWork) return this.flushWork;
    this.flushWork = this.sendPending().finally(() => {
      this.flushWork = undefined;
    });
    return this.flushWork;
  }
  async drain() {
    this.closing = true;
    await Promise.allSettled(this.receives.values());
    await this.flushWork;
  }
  setDmChat(chat: string) {
    if (this.privateDm) this.chats = [chat];
  }
  private async sendPending() {
    for (const delivery of this.app.store.all<Delivery>(
      "SELECT * FROM deliveries WHERE state='pending' ORDER BY rowid",
    )) {
      if (this.closing) break;
      if (this.privateDm && !this.chats.includes(delivery.chat)) continue;
      const changed = this.app.store.run(
        "UPDATE deliveries SET state='sending' WHERE id=? AND state='pending'",
        delivery.id,
      ).changes;
      if (!changed) continue;
      try {
        const result = await this.transport.send(delivery.chat, delivery.text);
        this.app.store.run(
          "UPDATE deliveries SET state='sent',result=? WHERE id=?",
          JSON.stringify(result),
          delivery.id,
        );
      } catch {
        this.app.store.run(
          "UPDATE deliveries SET state='uncertain',result=? WHERE id=?",
          "Verifique no Telegram. Não reenviado automaticamente.",
          delivery.id,
        );
      }
    }
  }
}
