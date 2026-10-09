import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { formatTelegramMessage } from "./telegram-format.js";
import type {
  Credential,
  CredentialStore,
  AuthOperationOptions,
} from "@earendil-works/pi-ai";

export interface Action {
  id: string;
  conversationId: string;
  server: string;
  tool: string;
  args: string;
  state: string;
  result: string | null;
  evidence: string;
}
export interface RequestRow {
  conversationId: string;
  requestId: string;
  text: string;
  submissionId: number | null;
  source: string;
  chat: string | null;
  status: string;
}
export interface Delivery {
  id: string;
  chat: string;
  text: string;
  state: string;
  parseMode: "HTML" | null;
}
export class Store {
  readonly db: DatabaseSync;
  credentialMutation = false;
  providerAdmissions = 0;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(`${dir}/app.sqlite`);
    const hadGrants = !!this.get(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telegram_grants'",
    );
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_lifecycle(conversationId TEXT PRIMARY KEY,deletedAt INTEGER);
      CREATE TABLE IF NOT EXISTS conversation_archive_versions(conversationId TEXT PRIMARY KEY,lastDeletedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_retention(conversationId TEXT PRIMARY KEY,purgeAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_purges(conversationId TEXT PRIMARY KEY,deletedAt INTEGER NOT NULL,claimedAt INTEGER NOT NULL,completedAt INTEGER);
      CREATE TABLE IF NOT EXISTS conversation_titles(conversationId TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS telegram_initial_revocations(conversationId TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS delivery_conversations(deliveryId TEXT PRIMARY KEY,conversationId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(conversationId TEXT, requestId TEXT, text TEXT, submissionId INTEGER, source TEXT, chat TEXT, status TEXT DEFAULT 'pending', PRIMARY KEY(conversationId,requestId));
      CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY, conversationId TEXT, server TEXT, tool TEXT, args TEXT, state TEXT DEFAULT 'pending', result TEXT, evidence TEXT DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS reads(conversationId TEXT PRIMARY KEY, result TEXT);
      CREATE TABLE IF NOT EXISTS links(code TEXT PRIMARY KEY, conversationId TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS telegram(chat TEXT PRIMARY KEY, conversationId TEXT, user TEXT);
      CREATE TABLE IF NOT EXISTS telegram_grants(chat TEXT, user TEXT, conversationId TEXT, PRIMARY KEY(chat,user,conversationId));
      CREATE TABLE IF NOT EXISTS telegram_conversations(conversationId TEXT PRIMARY KEY,chat TEXT NOT NULL,user TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_chat_selection(chat TEXT,user TEXT,conversationId TEXT NOT NULL,PRIMARY KEY(chat,user));
      CREATE TABLE IF NOT EXISTS telegram_updates(id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_receipts(key TEXT PRIMARY KEY, conversationId TEXT NOT NULL, requestId TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS command_request ON command_receipts(conversationId,requestId);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, chat TEXT, text TEXT, state TEXT DEFAULT 'pending', result TEXT, parseMode TEXT);
      CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires INTEGER);`);
    this.db.exec(
      "INSERT OR IGNORE INTO conversation_archive_versions SELECT conversationId,deletedAt FROM conversation_lifecycle WHERE deletedAt IS NOT NULL",
    );
    // Migrate old mappings once. An explicitly removed grant must stay removed
    // after restart rather than being silently recreated from a stale mapping.
    if (!hadGrants)
      this.db.exec(
        "INSERT OR IGNORE INTO telegram_grants SELECT chat,user,conversationId FROM telegram",
      );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_notifications(
        id TEXT PRIMARY KEY,conversationId TEXT NOT NULL,requestId TEXT NOT NULL,
        chat TEXT,user TEXT,botId TEXT,state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_notification_parts(deliveryId TEXT PRIMARY KEY,notificationId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_notification_route ON task_notifications(chat,user,conversationId);
      CREATE INDEX IF NOT EXISTS task_notification_part ON task_notification_parts(notificationId);
    `);
    // Revocation is terminal for already queued task parts, even if the same
    // mapping/grant/connection is re-established before the sender next runs.
    const cancel = (
      condition: string,
    ) => `UPDATE deliveries SET state='cancelled',result='Vínculo Telegram revogado antes do envio.'
      WHERE state='pending' AND id IN (
        SELECT p.deliveryId FROM task_notification_parts p JOIN task_notifications n ON n.id=p.notificationId WHERE ${condition}
      );`;
    const routeChanged = `n.chat=NEW.chat AND (n.user IS NOT NEW.user OR n.conversationId IS NOT NEW.conversationId)`;
    const mappingChanged = `n.chat=OLD.chat AND (n.chat IS NOT NEW.chat OR n.user IS NOT NEW.user OR n.conversationId IS NOT NEW.conversationId)`;
    const configChanged = `CASE WHEN json_valid(NEW.value) THEN
      json_extract(NEW.value,'$.enabled') IS NOT 1
      OR CAST(json_extract(NEW.value,'$.bot.id') AS TEXT) IS NOT n.botId
      OR json_extract(NEW.value,'$.userId') IS NOT n.user
      OR json_extract(NEW.value,'$.chatId') IS NOT n.chat
      ELSE 1 END`;
    const grantRevoked = `n.chat=OLD.chat AND n.user=OLD.user AND
      (n.conversationId=OLD.conversationId OR
       (n.conversationId IN (SELECT conversationId FROM telegram_conversations WHERE chat=OLD.chat AND user=OLD.user)
        AND EXISTS(SELECT 1 FROM telegram WHERE chat=OLD.chat AND user=OLD.user AND conversationId=OLD.conversationId)))`;
    this.db.exec(`
      DROP TRIGGER IF EXISTS task_telegram_revoke;
      DROP TRIGGER IF EXISTS task_telegram_regrant;
      CREATE TRIGGER IF NOT EXISTS task_telegram_unlink AFTER DELETE ON telegram BEGIN ${cancel("n.chat=OLD.chat")} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_remap AFTER UPDATE OF chat,user,conversationId ON telegram BEGIN ${cancel(mappingChanged)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_replace AFTER INSERT ON telegram BEGIN ${cancel(routeChanged)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_revoke AFTER DELETE ON telegram_grants BEGIN ${cancel(grantRevoked)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_regrant AFTER UPDATE ON telegram_grants
      WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user OR OLD.conversationId IS NOT NEW.conversationId
      BEGIN ${cancel(grantRevoked)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_connection_update AFTER UPDATE OF value ON meta WHEN NEW.key='telegram:connection' BEGIN ${cancel(configChanged)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_connection_insert AFTER INSERT ON meta WHEN NEW.key='telegram:connection' BEGIN ${cancel(configChanged)} END;
      CREATE TRIGGER IF NOT EXISTS task_telegram_connection_delete AFTER DELETE ON meta WHEN OLD.key='telegram:connection' BEGIN ${cancel("1")} END;
    `);
    if (
      !this.all<{ name: string }>("PRAGMA table_info(actions)").some(
        (c) => c.name === "evidence",
      )
    )
      this.db.exec("ALTER TABLE actions ADD COLUMN evidence TEXT DEFAULT '{}'");
    if (
      !this.all<{ name: string }>("PRAGMA table_info(deliveries)").some(
        (c) => c.name === "parseMode",
      )
    )
      this.db.exec("ALTER TABLE deliveries ADD COLUMN parseMode TEXT");
    this.db.exec(
      "UPDATE actions SET state='uncertain' WHERE state='running'; UPDATE deliveries SET state='uncertain' WHERE state='sending'; UPDATE command_receipts SET state='uncertain' WHERE state='pending';",
    );
  }
  all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }
  get<T>(sql: string, ...args: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...args) as unknown as T | undefined;
  }
  run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }
  queueTelegram(
    prefix: string,
    chat: string,
    text: string,
    legacyLimit = 3500,
    conversationId?: string,
  ) {
    conversationId ??= /^([1-9]\d*):/.exec(prefix)?.[1];
    if (conversationId && this.conversationDeleted(conversationId)) return;
    // A request partially queued by the previous version must retain its old
    // boundaries and plain-text payloads; changing them could repeat content.
    const prior = this.all<Delivery>(
      "SELECT * FROM deliveries WHERE substr(id,1,?)=? ORDER BY rowid",
      prefix.length + 1,
      `${prefix}:`,
    );
    const legacy = prior.some((row) => row.parseMode === null);
    const chunks: string[] = [];
    if (legacy) {
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + legacyLimit, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        chunks.push(text.slice(offset, end));
        offset = end;
      }
    } else chunks.push(...formatTelegramMessage(text));
    // Commands already commit their receipt and acknowledgement together.
    // A savepoint keeps this batch atomic both inside and outside that transaction.
    this.db.exec("SAVEPOINT telegram_delivery_batch");
    try {
      chunks.forEach((chunk, index) => {
        this.run(
          "INSERT OR IGNORE INTO deliveries(id,chat,text,parseMode) VALUES (?,?,?,?)",
          `${prefix}:${index}`,
          chat,
          chunk,
          legacy ? null : "HTML",
        );
        if (conversationId)
          this.run(
            "INSERT OR IGNORE INTO delivery_conversations VALUES (?,?)",
            `${prefix}:${index}`,
            conversationId,
          );
      });
      this.db.exec("RELEASE SAVEPOINT telegram_delivery_batch");
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT telegram_delivery_batch");
      this.db.exec("RELEASE SAVEPOINT telegram_delivery_batch");
      throw error;
    }
  }
  actions(conversationId: string) {
    return this.all<Action>(
      "SELECT * FROM actions WHERE conversationId=? ORDER BY rowid",
      conversationId,
    );
  }
  conversationDeleted(id: string) {
    return !!this.get(
      "SELECT 1 FROM conversation_lifecycle WHERE conversationId=? AND deletedAt IS NOT NULL UNION ALL SELECT 1 FROM conversation_purges WHERE conversationId=?",
      id,
      id,
    );
  }
  link(conversationId: string) {
    if (
      this.get(
        "SELECT 1 FROM telegram_conversations WHERE conversationId=?",
        conversationId,
      )
    )
      throw new Error(
        "Conversa exclusiva do Telegram. Selecione outra conversa na web para vincular.",
      );
    if (this.conversationDeleted(conversationId))
      throw new Error("Conversa excluída");
    const code = randomBytes(16).toString("hex");
    this.run(
      "INSERT INTO links VALUES (?,?,?)",
      hash(code),
      conversationId,
      Date.now() + 600000,
    );
    return code;
  }
  consumeLink(code: string, chat: string, user: string, updateKey?: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const link = this.get<{ conversationId: string }>(
        "SELECT conversationId FROM links WHERE code=? AND expires>? AND conversationId NOT IN (SELECT conversationId FROM telegram_conversations)",
        hash(code),
        Date.now(),
      );
      if (!link) throw new Error("Código de vínculo inválido ou expirado");
      if (this.conversationDeleted(link.conversationId))
        throw new Error("Código de vínculo inválido ou expirado");
      this.run(
        "INSERT INTO telegram VALUES (?,?,?) ON CONFLICT(chat) DO UPDATE SET conversationId=excluded.conversationId,user=excluded.user",
        chat,
        link.conversationId,
        user,
      );
      this.run("DELETE FROM links WHERE code=?", hash(code));
      this.run(
        "INSERT OR IGNORE INTO telegram_grants VALUES (?,?,?)",
        chat,
        user,
        link.conversationId,
      );
      if (updateKey) {
        this.run(
          "INSERT OR IGNORE INTO meta VALUES (?,?)",
          updateKey,
          JSON.stringify({ linked: link.conversationId }),
        );
        this.run(
          "INSERT OR IGNORE INTO deliveries(id,chat,text) VALUES (?,?,?)",
          `link:${updateKey}`,
          chat,
          "Conversa vinculada. As próximas mensagens usarão uma conversa exclusiva do Telegram; o histórico antigo permanece na web. Use /chats para gerenciar as conversas.",
        );
        this.run(
          "INSERT OR IGNORE INTO delivery_conversations VALUES (?,?)",
          `link:${updateKey}`,
          link.conversationId,
        );
      }
      this.db.exec("COMMIT");
      return link.conversationId;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Pi owns OAuth/login/refresh. Its adapter excludes the private Telegram credential. */
export class SqlCredentials implements CredentialStore {
  private static queues = new WeakMap<Store, Map<string, Promise<unknown>>>();
  private tails: Map<string, Promise<unknown>>;
  constructor(private store: Store) {
    let tails = SqlCredentials.queues.get(store);
    if (!tails) {
      tails = new Map();
      SqlCredentials.queues.set(store, tails);
    }
    this.tails = tails;
  }
  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const row = this.store.get<{ value: string }>(
      "SELECT value FROM credentials WHERE provider=?",
      providerId,
    );
    return row ? (JSON.parse(row.value) as Credential) : undefined;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return this.store
      .all<{ provider: string; value: string }>(
        "SELECT * FROM credentials WHERE provider <> 'telegram:bot'",
      )
      .map((row) => ({
        providerId: row.provider,
        type: (JSON.parse(row.value) as Credential).type,
      }));
  }
  async modify(
    providerId: string,
    fn: (value: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    const operation = (this.tails.get(providerId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        options?.signal?.throwIfAborted();
        const current = await this.read(providerId);
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next)
          this.store.run(
            "INSERT INTO credentials VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value",
            providerId,
            JSON.stringify(next),
          );
        return next ?? current;
      });
    this.tails.set(providerId, operation);
    return operation;
  }
  async delete(providerId: string, options?: AuthOperationOptions) {
    const operation = (this.tails.get(providerId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        options?.signal?.throwIfAborted();
        this.store.run("DELETE FROM credentials WHERE provider=?", providerId);
      });
    this.tails.set(providerId, operation);
    return operation;
  }
}
