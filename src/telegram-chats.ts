import type { Runtime } from "./runtime.js";
import { CommandError } from "./commands.js";

export interface TelegramOwner {
  chat: string;
  user: string;
}

/** A dedicated selection is independent of the legacy web/cron binding. */
export class TelegramChats {
  private creating = new Map<string, Promise<string>>();
  constructor(private app: Runtime) {}
  binding(owner: TelegramOwner) {
    const row = this.app.store.get<{ conversationId: string }>(
      `SELECT t.conversationId FROM telegram t JOIN telegram_grants g
       ON g.chat=t.chat AND g.user=t.user AND g.conversationId=t.conversationId
       WHERE t.chat=? AND t.user=?`,
      owner.chat,
      owner.user,
    );
    if (!row)
      throw new CommandError(
        "Conversa não autorizada. Vincule novamente pela web.",
      );
    if (
      this.dedicated(row.conversationId) &&
      !this.owns(row.conversationId, owner)
    )
      throw new CommandError(
        "Conversa não autorizada. Vincule novamente pela web.",
      );
    this.app.assertConversationAvailable(row.conversationId);
    return row.conversationId;
  }
  owns(id: string, owner: TelegramOwner) {
    return !!this.app.store.get(
      `SELECT 1 FROM telegram_conversations d JOIN telegram_grants g
       ON g.conversationId=d.conversationId AND g.chat=d.chat AND g.user=d.user
       WHERE d.conversationId=? AND d.chat=? AND d.user=?`,
      id,
      owner.chat,
      owner.user,
    );
  }
  dedicated(id: string) {
    return !!this.app.store.get(
      "SELECT 1 FROM telegram_conversations WHERE conversationId=?",
      id,
    );
  }
  authorize(id: string, owner: TelegramOwner) {
    this.binding(owner);
    if (!this.owns(id, owner))
      throw new CommandError(
        "Conversa Telegram indisponível para este usuário. Use /chats para listar suas conversas.",
      );
    this.app.assertConversationAvailable(id);
  }
  list(owner: TelegramOwner) {
    this.binding(owner);
    return this.app.store
      .all<{ id: string; title: string }>(
        `SELECT c.id,c.title FROM conversations c JOIN telegram_conversations d ON d.conversationId=c.id
       JOIN telegram_grants g ON g.conversationId=c.id AND g.chat=d.chat AND g.user=d.user
       WHERE d.chat=? AND d.user=? AND c.id NOT IN
       (SELECT conversationId FROM conversation_lifecycle WHERE deletedAt IS NOT NULL) ORDER BY c.rowid DESC`,
        owner.chat,
        owner.user,
      )
      .map((row) => ({ id: row.id, title: row.title }));
  }
  selected(owner: TelegramOwner) {
    this.binding(owner);
    const row = this.app.store.get<{ conversationId: string }>(
      "SELECT conversationId FROM telegram_chat_selection WHERE chat=? AND user=?",
      owner.chat,
      owner.user,
    );
    if (!row) return;
    // Revocation cannot silently send the next input back to the shared web history.
    if (!this.owns(row.conversationId, owner))
      throw new CommandError(
        "Conversa não autorizada. Use /chats new TÍTULO para criar outra conversa Telegram.",
      );
    this.app.assertConversationAvailable(row.conversationId);
    return row.conversationId;
  }
  select(id: string, owner: TelegramOwner) {
    this.authorize(id, owner);
    this.app.store.run(
      `INSERT INTO telegram_chat_selection VALUES (?,?,?) ON CONFLICT(chat,user)
       DO UPDATE SET conversationId=excluded.conversationId`,
      owner.chat,
      owner.user,
      id,
    );
  }
  async ensure(owner: TelegramOwner) {
    const selected = this.selected(owner);
    if (selected) return selected;
    const key = JSON.stringify([owner.chat, owner.user]);
    const running = this.creating.get(key);
    if (running) return running;
    const binding = this.binding(owner);
    this.app.assertHandoffAvailable(binding);
    const work = this.app.create("Conversa Telegram", owner).then((id) => {
      // An explicit /chats selection made during creation takes precedence.
      const current = this.selected(owner);
      if (current) return current;
      this.app.assertHandoffAvailable(binding);
      this.select(id, owner);
      return id;
    });
    this.creating.set(key, work);
    void work.finally(() => this.creating.delete(key)).catch(() => {});
    return work;
  }
}
