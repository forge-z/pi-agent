import {
  TelegramTyping,
  type TelegramTypingOptions,
} from "./telegram-typing.js";
import {
  ConversationBusyError,
  ConversationError,
  type Runtime,
} from "./runtime.js";
import { hash, type Delivery } from "./store.js";
import { CommandError } from "./commands.js";
import { SettingsError } from "./settings.js";
import { taskTelegramAuthorized } from "./task-telegram.js";
import {
  TELEGRAM_RELINK_GUIDANCE,
  TELEGRAM_SELECTION_GUIDANCE,
  type TelegramOwner,
} from "./telegram-chats.js";
interface ControlRoute extends TelegramOwner {
  botId: number;
  credentialBinding: string;
}
function unavailableConversation(error: unknown) {
  // Settings/deletion inspections are temporary; storage failures must retry too.
  return (
    error instanceof CommandError ||
    (error instanceof ConversationError &&
      !(error instanceof ConversationBusyError))
  );
}
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    message_thread_id?: number;
    text?: string;
    from?: { id: number; is_bot?: boolean; language_code?: string };
    chat: { id: number; type: string };
  };
}
export interface TelegramTransport {
  typing?(chat: string, options?: TelegramTypingOptions): Promise<unknown>;
  send(
    chat: string,
    text: string,
    options?: { parseMode?: "HTML" },
  ): Promise<unknown>;
}
export class TelegramInputError extends Error {}
export class TelegramHttp implements TelegramTransport {
  constructor(private token: string) {}
  async typing(chat: string, options: TelegramTypingOptions = {}) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.token}/sendChatAction`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            action: "typing",
            ...(options.messageThreadId === undefined
              ? {}
              : { message_thread_id: options.messageThreadId }),
          }),
          signal: AbortSignal.any([
            AbortSignal.timeout(2000),
            ...(options.signal ? [options.signal] : []),
          ]),
        },
      );
      const result = (await response.json()) as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error();
      return result;
    } catch {
      throw new Error("Falha no indicador Telegram");
    }
  }
  async send(chat: string, text: string, options?: { parseMode?: "HTML" }) {
    const response = await fetch(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text,
          ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
        }),
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
  private typing: TelegramTyping;
  private flushWork: Promise<void> | undefined;
  private receives = new Map<number, Promise<unknown>>();
  private credentialBinding: string;
  constructor(
    private app: Runtime,
    private transport: TelegramTransport,
    private users: string[],
    private chats: string[],
    readonly botUsername?: string,
    private privateDm = false,
    private botId?: number,
  ) {
    this.typing = new TelegramTyping(transport.typing?.bind(transport));
    const credential = this.app.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider='telegram:bot'",
    );
    this.credentialBinding = hash(credential?.value ?? "");
    this.botUsername = botUsername?.trim().replace(/^@/, "") || undefined;
    if (this.botUsername && !/^[a-zA-Z0-9_]{5,32}$/.test(this.botUsername))
      throw new Error("TELEGRAM_BOT_USERNAME deve ser o username do bot");
  }
  private commandText(raw: string) {
    const start = raw.trimStart();
    if (!start.startsWith("/") || start.startsWith("//")) return raw;
    const text = raw.trim();
    const addressed = /^\/[a-z]+@([a-z0-9_]+)(?=\s|$)/i.exec(text);
    if (!addressed) return this.newAlias(text);
    // Never execute a command intended for another bot or guess our identity.
    if (addressed[1].toLowerCase() !== this.botUsername?.toLowerCase())
      return undefined;
    return this.newAlias(text.replace(/^(\/[a-z]+)@[a-z0-9_]+/i, "$1"));
  }
  private newAlias(text: string) {
    const match = /^\/new(?:\s+([\s\S]*))?$/.exec(text);
    return match
      ? `/chats new${match[1]?.trim() ? ` ${match[1].trim()}` : ""}`
      : text;
  }
  /** Control replies identify the configured private owner, never grant history access. */
  private controlRoute(owner: TelegramOwner): ControlRoute | undefined {
    if (
      !this.privateDm ||
      !this.botId ||
      !this.users.includes(owner.user) ||
      !this.chats.includes(owner.chat)
    )
      return;
    const saved = this.app.store.get<{ value: string }>(
      "SELECT value FROM meta WHERE key='telegram:connection'",
    );
    if (!saved) return;
    try {
      const config = JSON.parse(saved.value);
      if (
        config.enabled !== true ||
        config.bot?.id !== this.botId ||
        config.userId !== owner.user ||
        config.chatId !== owner.chat
      )
        return;
      const credential = this.app.store.get<{ value: string }>(
        "SELECT value FROM credentials WHERE provider='telegram:bot'",
      );
      if (!credential) return;
      const identity = JSON.parse(credential.value);
      if (
        identity.botId !== this.botId ||
        typeof identity.token !== "string" ||
        !identity.token.trim()
      )
        return;
      if (hash(credential?.value ?? "") !== this.credentialBinding) return;
      return {
        ...owner,
        botId: this.botId,
        credentialBinding: hash(credential?.value ?? ""),
      };
    } catch {
      return;
    }
  }
  private recoveryReply(
    updateId: number,
    fingerprint: string,
    route: ControlRoute,
    text: string,
  ) {
    const current = this.controlRoute(route);
    if (!current || JSON.stringify(current) !== JSON.stringify(route))
      return { ignored: true };
    const result = { error: text, control: true };
    const prefix = `telegram:control:${updateId}`;
    this.app.store.db.exec("SAVEPOINT telegram_control_reply");
    try {
      this.app.store.queueTelegram(prefix, route.chat, text);
      for (const part of this.app.store.all<{ id: string }>(
        "SELECT id FROM deliveries WHERE substr(id,1,?)=?",
        prefix.length + 1,
        `${prefix}:`,
      ))
        this.app.store.run(
          "INSERT OR IGNORE INTO meta VALUES (?,?)",
          `telegram:control-route:${part.id}`,
          JSON.stringify(route),
        );
      this.app.store.run(
        "INSERT OR IGNORE INTO meta VALUES (?,?)",
        `telegram:update:${updateId}`,
        JSON.stringify(result),
      );
      this.app.store.run(
        "INSERT OR IGNORE INTO telegram_updates VALUES (?,?)",
        updateId,
        fingerprint,
      );
      this.app.store.db.exec("RELEASE SAVEPOINT telegram_control_reply");
      return result;
    } catch (error) {
      this.app.store.db.exec("ROLLBACK TO SAVEPOINT telegram_control_reply");
      this.app.store.db.exec("RELEASE SAVEPOINT telegram_control_reply");
      throw error;
    }
  }
  async receive(update: TelegramUpdate, signal?: AbortSignal) {
    if (this.closing || signal?.aborted) return { ignored: true };
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
    if (this.privateDm && !this.controlRoute({ chat, user }))
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
      (!linked || linked.user !== user) &&
      !this.controlRoute({ chat, user })
    )
      throw new TelegramInputError(
        "Conversa não vinculada a este usuário; use /link CODIGO pela web",
      );
    const inFlight = this.receives.get(update.update_id);
    if (inFlight) return inFlight;
    const tracked = {
      conversationId: undefined as string | undefined,
      accepting: true,
      normal: false,
    };
    const stopTyping = this.app.store.get(
      "SELECT 1 FROM meta WHERE key=?",
      `telegram:update:${update.update_id}`,
    )
      ? () => {}
      : this.typing.start(
          update.update_id,
          chat,
          () => {
            if (this.closing || signal?.aborted) return false;
            if (this.privateDm && !this.controlRoute({ chat, user }))
              return false;
            this.app.telegramChats.binding({ chat, user });
            const selected = this.app.telegramChats.selected({ chat, user });
            const id =
              tracked.conversationId ?? selected ?? linked?.conversationId;
            if (!id || (tracked.conversationId && selected && selected !== id))
              return false;
            this.app.commands.authorize(id, { source: "telegram", chat, user });
            this.app.assertHandoffAvailable(id);
            if (tracked.accepting) return true;
            return (
              tracked.normal &&
              this.app.store.get<{ status: string }>(
                "SELECT status FROM requests WHERE conversationId=? AND requestId=? AND source='telegram' AND chat=?",
                id,
                `telegram:${update.update_id}`,
                chat,
              )?.status === "pending"
            );
          },
          {
            signal,
            ...(Number.isSafeInteger(message.message_thread_id) &&
            message.message_thread_id! > 0
              ? { messageThreadId: message.message_thread_id }
              : {}),
          },
        );
    const operation = this.accept(
      update,
      user,
      chat,
      fingerprint,
      text,
      signal,
      tracked,
    ).then(
      (response) => {
        tracked.accepting = false;
        tracked.normal =
          !!response &&
          typeof response === "object" &&
          "kind" in response &&
          response.kind === "message";
        if (!tracked.normal) stopTyping();
        else this.typing.check();
        return response;
      },
      (error) => {
        stopTyping();
        throw error;
      },
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
    tracked?: { conversationId?: string },
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
    let conversationId = linked?.conversationId;
    let errorReply: string | undefined;
    const pairing = /^\/(link|start)(?:\s+([\s\S]*))?$/.exec(text);
    if (pairing?.[1] === "start" && !pairing[2]) {
      const control = this.controlRoute({ chat, user });
      try {
        this.app.telegramChats.binding({ chat, user });
      } catch (error) {
        if (!unavailableConversation(error)) throw error;
        if (control)
          return this.recoveryReply(
            update.update_id,
            fingerprint,
            control,
            TELEGRAM_RELINK_GUIDANCE,
          );
      }
      errorReply =
        linked?.user === user
          ? this.privateDm
            ? "Conectado. As mensagens usam conversas exclusivas do Telegram; o histórico antigo permanece na web. Use /chats para gerenciar as conversas."
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
      const control = this.controlRoute({ chat, user });
      if (!linked || linked.user !== user) {
        if (control)
          return this.recoveryReply(
            update.update_id,
            fingerprint,
            control,
            TELEGRAM_RELINK_GUIDANCE,
          );
        throw new TelegramInputError(
          "Vincule esta conversa na interface web com /link CODIGO",
        );
      }
      try {
        this.app.telegramChats.binding({ chat, user });
      } catch (error) {
        if (!unavailableConversation(error)) throw error;
        if (control)
          return this.recoveryReply(
            update.update_id,
            fingerprint,
            control,
            TELEGRAM_RELINK_GUIDANCE,
          );
        throw error;
      }
      const selected = this.app.store.get<{ conversationId: string }>(
        "SELECT conversationId FROM telegram_chat_selection WHERE chat=? AND user=?",
        chat,
        user,
      )?.conversationId;
      if (selected) this.app.assertHandoffAvailable(selected);
      const management = /^\/chats(?:\s|$)/.test(text);
      if (management) {
        // A revoked/archived selection may be replaced explicitly with /chats.
        conversationId =
          selected &&
          this.app.telegramChats.owns(selected, { chat, user }) &&
          !this.app.store.conversationDeleted(selected)
            ? selected
            : linked.conversationId;
      } else {
        const prior = this.app.store.get<{ conversationId: string }>(
          "SELECT conversationId FROM requests WHERE requestId=? AND source='telegram' AND chat=?",
          `telegram:${update.update_id}`,
          chat,
        );
        try {
          conversationId =
            prior?.conversationId ??
            this.app.telegramChats.selected({ chat, user });
        } catch (error) {
          if (!unavailableConversation(error)) throw error;
          if (control)
            return this.recoveryReply(
              update.update_id,
              fingerprint,
              control,
              TELEGRAM_SELECTION_GUIDANCE,
            );
          throw error;
        }
        if (!conversationId) {
          // Migrate normal messages on first use; command-only operations retain
          // access to the old binding until a dedicated conversation exists.
          conversationId =
            !text.trimStart().startsWith("/") ||
            text.trimStart().startsWith("//")
              ? await this.app.telegramChats.ensure({ chat, user })
              : linked.conversationId;
        }
        this.app.commands.authorize(conversationId, {
          source: "telegram",
          chat,
          user,
        });
      }
      if (tracked) tracked.conversationId = conversationId;
      const decision = /^\/(approve|deny)\s+([a-f0-9]{24})$/.exec(text);
      if (decision) {
        if (
          !this.app.store.get(
            "SELECT id FROM actions WHERE id=? AND conversationId=?",
            decision[2],
            conversationId!,
          )
        )
          throw new TelegramInputError("Ação não encontrada nesta conversa");
        const action = await this.app.actions.decide(
          conversationId!,
          decision[2],
          decision[1] === "approve" ? "approve" : "deny",
          signal,
        );
        if (action.state === "running") return { processing: true };
        await this.app.recordAction(action);
        this.app.store.db.exec("SAVEPOINT decision_delivery");
        try {
          this.app.store.run(
            "INSERT OR IGNORE INTO deliveries(id,chat,text) VALUES (?,?,?)",
            `decision:${update.update_id}`,
            chat,
            `Ação ${action.id}: ${action.state}. ${action.state === "uncertain" ? "Verifique o serviço externo; a ação não será repetida automaticamente." : ""}`,
          );
          this.app.store.run(
            "INSERT OR IGNORE INTO delivery_conversations VALUES (?,?)",
            `decision:${update.update_id}`,
            conversationId!,
          );
          this.app.store.db.exec("RELEASE SAVEPOINT decision_delivery");
        } catch (error) {
          this.app.store.db.exec("ROLLBACK TO SAVEPOINT decision_delivery");
          this.app.store.db.exec("RELEASE SAVEPOINT decision_delivery");
          throw error;
        }
        response = action;
      } else {
        try {
          response = await this.app.admit(
            conversationId!,
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
      if (errorReply) {
        this.app.store.run(
          "INSERT OR IGNORE INTO deliveries(id,chat,text) VALUES (?,?,?)",
          `command:telegram:${update.update_id}:0`,
          chat,
          errorReply,
        );
        if (linked)
          this.app.store.run(
            "INSERT OR IGNORE INTO delivery_conversations VALUES (?,?)",
            `command:telegram:${update.update_id}:0`,
            conversationId!,
          );
      }
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
    this.typing.close();
    await Promise.allSettled(this.receives.values());
    await this.flushWork;
  }
  setDmChat(chat: string) {
    if (this.privateDm) {
      if (!this.chats.includes(chat)) this.typing.close();
      this.chats = [chat];
    }
  }
  private async sendPending() {
    this.typing.check();
    for (const delivery of this.app.store.all<Delivery>(
      "SELECT * FROM deliveries WHERE state='pending' ORDER BY rowid",
    )) {
      if (this.closing) break;
      const control = this.app.store.get<{ value: string }>(
        "SELECT value FROM meta WHERE key=?",
        `telegram:control-route:${delivery.id}`,
      );
      let authorizedControl = false;
      if (control) {
        try {
          const route = JSON.parse(control.value) as ControlRoute;
          const current = this.controlRoute(route);
          authorizedControl =
            !!current &&
            current.chat === delivery.chat &&
            JSON.stringify(current) === JSON.stringify(route);
        } catch {
          /* Malformed control receipts never authorize a send. */
        }
      }
      // Revoked owned receipts are terminal even when this engine now serves
      // another chat. Unowned legacy rows outside its allowlist stay untouched.
      if (
        control
          ? !authorizedControl
          : !taskTelegramAuthorized(
              this.app.store,
              delivery.id,
              this.users,
              this.chats,
              this.botId,
            )
      ) {
        this.app.store.run(
          "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
          "Vínculo Telegram revogado antes do envio.",
          delivery.id,
        );
        continue;
      }
      if (this.privateDm && !this.chats.includes(delivery.chat)) continue;
      let bindingAvailable = !this.privateDm;
      let bindingBusy = false;
      if (this.privateDm) {
        for (const user of this.users) {
          if (!this.controlRoute({ chat: delivery.chat, user })) continue;
          try {
            this.app.telegramChats.binding({ chat: delivery.chat, user });
            bindingAvailable = true;
            break;
          } catch (error) {
            if (error instanceof ConversationBusyError) bindingBusy = true;
            else if (!unavailableConversation(error)) throw error;
            /* Only new, owner-scoped guidance can bypass a missing history binding. */
          }
        }
      }
      if (!control && !bindingAvailable) {
        // No authorization decision has completed yet. Leave this delivery
        // pending so the next flush rechecks grants and connection identity.
        if (bindingBusy) continue;
        this.app.store.run(
          "UPDATE deliveries SET state='cancelled',result=? WHERE id=? AND state='pending'",
          "Vínculo Telegram revogado antes do envio.",
          delivery.id,
        );
        continue;
      }
      const changed = this.app.store.run(
        "UPDATE deliveries SET state='sending' WHERE id=? AND state='pending'",
        delivery.id,
      ).changes;
      if (!changed) continue;
      try {
        const result = await this.transport.send(
          delivery.chat,
          delivery.text,
          delivery.parseMode === "HTML" ? { parseMode: "HTML" } : undefined,
        );
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
